/**
 * MCP server command — starts a Model Context Protocol server over stdio transport.
 * Allows Claude Code and other MCP clients to read/send Zalo messages via tool calls.
 *
 * IMPORTANT: All diagnostic output uses console.error() — stdout is the MCP transport channel.
 */

import { join } from "path";
import { getApi, autoLogin, clearSession } from "../core/zalo-client.js";
import { getActive } from "../core/accounts.js";
import { CONFIG_DIR } from "../core/credentials.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { createStageLock, startDaemonChannel } from "../core/daemon-channel.js";
import { createSyncRunners } from "../core/daemon-sync.js";
import { createSocketTap } from "../core/socket-tap.js";
import { createSelfHeal } from "../core/self-heal.js";
import { initDb, getPendingSyncGaps } from "../core/db.js";
import { SyncManager } from "../core/sync.js";
import { createGapTracker, HEARTBEAT_MS } from "../core/listener-lifecycle.js";
import {
    storeLiveMessage,
    storeLiveReaction,
    storeLiveUndo,
    storeGroupEvent,
    storeGroupEventRow,
    noteBoardChange,
    storeReceipts,
} from "../core/live-store.js";
import { downloadSyncedMedia } from "../core/sync-v2/media.js";
import { classifyLiveMessage } from "../core/sync-v2/message-types.js";
import { createDeliveredReceipts } from "../core/receipts.js";
import { MessageBuffer } from "../mcp/message-buffer.js";
import { ThreadFilter } from "../mcp/thread-filter.js";
import { loadMCPConfig, parseDuration } from "../mcp/mcp-config.js";
import { createMCPServer } from "../mcp/mcp-server.js";
import { registerTools } from "../mcp/mcp-tools.js";
import { createHTTPServer } from "../mcp/mcp-http-transport.js";
import { ZaloNotifier } from "../mcp/notifier.js";
import { ThreadNameCache } from "../mcp/thread-name-cache.js";

/** Zalo close code for duplicate web session — fatal, do not retry */
const CLOSE_DUPLICATE = 3000;

/** Sync2.Message.MessageStatus values carried by live receipts. */
const STATUS_RECEIVED = 4;
const STATUS_SEEN = 5;

/**
 * Normalize a raw zca-js message event into the buffer's message shape.
 *
 * Classification comes from the shared `classifyLiveMessage`, the same
 * function the listener and the mobile sync use, so an agent reading
 * `zalo_get_messages` sees the same `type` vocabulary (`photo`, `video`,
 * `file`) as `msg history` and the same attachment fields — rather than the
 * raw `chat.photo` strings this used to emit, which never matched anything
 * else in the tool.
 *
 * @param {object} msg - Raw zca-js message event
 * @param {object} [info] - Pre-computed classification, when the caller has one
 * @returns {object} Normalized message
 */
export function normalizeMessage(msg, info = null) {
    const data = msg.data || {};
    const cls = info || classifyLiveMessage(data);
    const media = cls.attachments.find((a) => a.url || a.thumbUrl) || null;
    return {
        id: data.msgId,
        threadId: msg.threadId,
        threadType: msg.type === 0 ? "dm" : "group",
        senderId: data.uidFrom || null,
        senderName: data.dName || null,
        text: cls.text,
        // The message's own timestamp, not the moment we happened to process
        // it: buffer eviction is age-based, and Date.now() made every message
        // look brand new.
        timestamp: data.ts ? Number(data.ts) : Date.now(),
        type: cls.type,
        attachment: media
            ? {
                  type: cls.type,
                  url: media.url || media.thumbUrl || null,
                  description: media.title || null,
                  localPath: null,
              }
            : null,
        replyTo: null,
    };
}

export function registerMCPCommands(program) {
    const mcp = program.command("mcp").description("MCP server for AI agent integration");

    mcp.command("start")
        .description("Start MCP server (stdio or HTTP transport)")
        .option("--config <path>", "Config file path (default: ~/.zalo-agent-cli/mcp-config.json)")
        .option("--http <port>", "Use HTTP transport on specified port (default: stdio)")
        .option("--auth <token>", "Bearer token for HTTP auth (only with --http)")
        .option("--host <address>", "HTTP bind address (default: 127.0.0.1, only with --http)")
        .option(
            "--no-delivered-receipts",
            "Do not acknowledge received messages as delivered (every Zalo client does; seen receipts are never sent)",
        )
        .option(
            "--no-self-heal",
            "Do not pull what a dropped socket missed from Zalo's offline queue on reconnect (the default does, as Zalo Web does, on this socket and with no phone tap)",
        )
        .action(async (opts) => {
            // Safety net: redirect ALL console.log to stderr for the entire MCP process.
            // Stdout is the MCP JSON-RPC transport — any non-JSON output corrupts the stream.
            // This catches rogue prints from dependencies (zca-js, chalk, etc.) that we can't control.
            console.log = (...args) => console.error(...args);

            // Perform login explicitly here — preAction hook skips "mcp"
            // Pass jsonMode=true to suppress info() output — stdout is the MCP transport channel
            try {
                await autoLogin(true);
            } catch (e) {
                console.error("[mcp] Auto-login failed:", e.message);
                process.exit(1);
            }

            const activeAcc = getActive();
            if (!activeAcc) {
                console.error("[mcp] No active account. Run `zalo-agent login` first.");
                process.exit(1);
            }
            const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);

            // This server now opens the account's WebSocket *and* writes to
            // zalo.db, which is exactly what the `listen` daemon does. Zalo
            // allows one web session per account and the cache allows one
            // writer, so the lock that used to guard only `listen` has to guard
            // this too — previously both could start, and Zalo silently killed
            // one of the two sockets.
            if (!acquireLock(accountDir)) {
                console.error(
                    `[mcp] Another listener (listen daemon or MCP server) is already running for account ${activeAcc.ownId}.`,
                );
                console.error("[mcp] Stop it first — Zalo permits one web session per account.");
                process.exit(1);
            }
            let lockHeld = true;
            // Torn down with the lock, and from the same single place, so no
            // exit path can leave a channel descriptor pointing at a dead port.
            let channel = null;
            const dropLock = () => {
                if (!lockHeld) return;
                lockHeld = false;
                try {
                    channel?.stop();
                } catch (e) {
                    console.error(`[mcp] Failed to close upload channel: ${e.message}`);
                }
                try {
                    releaseLock(accountDir);
                } catch (e) {
                    console.error(`[mcp] Failed to release lock: ${e.message}`);
                }
            };

            try {
                initDb(join(accountDir, "zalo.db"));
                console.error(`[mcp] Local cache: ${join(accountDir, "zalo.db")}`);
            } catch (e) {
                dropLock();
                console.error(`[mcp] Failed to initialize local DB: ${e.message}`);
                process.exit(1);
            }

            // Load MCP config (config path option reserved for future use)
            const config = loadMCPConfig(opts.config);
            console.error("[mcp] Config loaded:", JSON.stringify(config.limits));

            // Build buffer + filter from config
            const maxAge = parseDuration(config.limits?.bufferMaxAge ?? "2h");
            const maxSize = config.limits?.bufferMaxSize ?? 500;
            const buffer = new MessageBuffer(maxSize, maxAge);
            const filter = new ThreadFilter(config);

            // Build thread name cache (groups + friends → in-memory index)
            const nameCache = new ThreadNameCache();
            try {
                await nameCache.init(getApi());
            } catch (e) {
                console.error("[mcp] Thread name cache init failed (non-fatal):", e.message);
            }

            // One stage at a time on this socket, shared by the sync routes, the
            // self-heal catch-up and the tools' own history fetch. Created before
            // the server so the tools can hold it too.
            const stageLock = createStageLock();

            // Start MCP server — stdio (default) or HTTP
            let httpServer = null;
            try {
                if (opts.http) {
                    const port = Number(opts.http);
                    if (!Number.isInteger(port) || port < 1 || port > 65535) {
                        dropLock();
                        console.error(`[mcp] Invalid port: ${opts.http}. Must be 1-65535.`);
                        process.exit(1);
                    }
                    const deps = { api: getApi(), buffer, filter, config, nameCache, accountDir, stageLock };
                    const authToken = opts.auth?.trim() || null;
                    httpServer = createHTTPServer(registerTools, deps, port, authToken, opts.host || "127.0.0.1");
                    console.error(`[mcp] HTTP server started on port ${port}`);
                } else {
                    await createMCPServer(getApi(), buffer, filter, config, nameCache, accountDir, stageLock);
                }
            } catch (e) {
                dropLock();
                console.error("[mcp] Failed to start MCP server:", e.message);
                process.exit(1);
            }

            // Setup notifier (sends to Zalo group when agent is offline)
            const notifier = new ZaloNotifier(getApi(), config);

            // Delivered receipts: the same shared implementation `listen` uses
            // (AGENTS.md §13 -- the two listeners must not differ). Diagnostics
            // go to stderr only; stdout is the JSON-RPC stream. Seen receipts
            // are never sent from here: zalo_mark_read moves a local cursor only.
            const deliveredReceipts = createDeliveredReceipts({
                getApi,
                enabled: opts.deliveredReceipts !== false,
                log: (line) => console.error(`[mcp] ${line}`),
            });
            console.error(
                opts.deliveredReceipts !== false
                    ? "[mcp] Delivered receipts: ON (opt out with --no-delivered-receipts). Seen receipts: never sent."
                    : "[mcp] Delivered receipts: OFF. Seen receipts: never sent.",
            );

            let reconnectCount = 0;

            // `listen` and `mcp start` are two entry points to the SAME socket,
            // so `mcp start` gets the same coverage bookkeeping. Without it an
            // agent-driven install that only ever runs this command had zero
            // loss detection, and because it never wrote lastConnectedAt a later
            // `listen` filed a bogus 14-day gap over a covered window.
            const syncManager = new SyncManager(getApi(), activeAcc.ownId);
            const reportGap = (fromTs, reason) => {
                if (!fromTs) return false;
                // recordGap(from, to, reason) -- it has a 1-second floor and
                // returns null under it, which is not a gap worth announcing.
                const gapId = syncManager.recordGap(fromTs, Date.now(), reason);
                if (!gapId) return false;
                const since = new Date(fromTs).toISOString();
                console.error(
                    opts.selfHeal !== false
                        ? `[mcp] Coverage gap (${reason}) since ${since}: recovering it now from Zalo's offline ` +
                              "queue on this socket (no phone tap); whatever that cannot reach stays pending for: " +
                              `zalo-agent sync --from ${since.slice(0, 10)}`
                        : `[mcp] Coverage gap (${reason}): messages between ${since} and now are not in the local ` +
                              `cache. Close it with: zalo-agent sync --from ${since.slice(0, 10)}`,
                );
                return true;
            };
            const lifecycle = createGapTracker({ syncManager, reportGap });

            // Same startup check `listen` does: a window between the last
            // recorded connection and now is unobserved until something says so.
            if (!reportGap(syncManager.getLastConnectedAt(), "startup-gap")) {
                syncManager.markConnected();
            }
            const pending = getPendingSyncGaps();
            if (pending.length > 0) {
                console.error(
                    opts.selfHeal !== false
                        ? `[mcp] ${pending.length} coverage gap(s) pending — the self-heal closes what Zalo's offline ` +
                              "queue still holds once connected; `zalo-agent sync` closes the rest."
                        : `[mcp] ${pending.length} coverage gap(s) pending — run \`zalo-agent sync\` to close them.`,
                );
            }
            const mcpHeartbeatTimer = setInterval(() => lifecycle.heartbeat(), HEARTBEAT_MS);

            // The same catch-up `listen` runs (AGENTS.md §13): one stage at a
            // time on this socket, a raw reader for the fields zca-js drops, and
            // the offline-queue pull on every handshake (src/core/self-heal.js).
            // `stageLock` is the one created before the server above.
            const socketTap = createSocketTap({ log: (line) => console.error(`[mcp] ${line}`) });
            const selfHeal = createSelfHeal({
                getApi,
                tap: socketTap,
                lock: stageLock,
                enabled: opts.selfHeal !== false,
                log: (line) => console.error(`[mcp] ${line}`),
                // A bot must see what arrived while the socket was down, as it
                // would have seen it live -- same filters, flagged as catch-up.
                onRecovered: (items) => {
                    for (const { msg, info } of items) {
                        if (info?.hasAttachment) fetchMedia(String(msg.threadId));
                        if (msg.isSelf) continue;
                        const normalized = { ...normalizeMessage(msg, info), catchUp: true };
                        if (!filter.shouldWatch(normalized.threadId, normalized.threadType)) continue;
                        if (!filter.shouldKeep(normalized)) continue;
                        buffer.push(normalized.threadId, normalized);
                        notifier.onMessage(normalized);
                    }
                },
            });
            console.error(
                opts.selfHeal !== false
                    ? "[mcp] Self-heal: ON — after a drop or restart, missed messages come back from Zalo's offline queue on this socket, no phone tap (opt out with --no-self-heal)."
                    : "[mcp] Self-heal: OFF — a coverage gap stays pending until `zalo-agent sync` closes it.",
            );

            /**
             * Fetch a message's attachments into the same per-conversation
             * folders every other command uses. Fire-and-forget.
             * @param {string} threadId
             */
            function fetchMedia(threadId) {
                downloadSyncedMedia({
                    api: getApi(),
                    accountDir,
                    threadId,
                    limit: 5,
                    concurrency: 2,
                    mediaRoot: config.media?.downloadDir || undefined,
                }).catch((e) => console.error(`[mcp] media download failed: ${e.message}`));
            }

            /**
             * Attach Zalo listener handlers to the current API instance.
             * Must be called again after each re-login with the new API instance.
             * @param {object} api - zca-js API instance
             */
            function attachListenerHandlers(api) {
                api.listener.on("message", (msg) => {
                    // Persist FIRST and unconditionally. The buffer is what an
                    // agent polls; the cache is the durable record, and it must
                    // not depend on whether a thread happens to be watched or
                    // whether a message survives the noise filter. This server
                    // used to hold everything in memory only, so a restart lost
                    // every message it had ever seen.
                    const threadName = nameCache?.get(String(msg.threadId))?.name || undefined;
                    const stored = storeLiveMessage(msg, { threadName });
                    // A "delete for me" frame removes a message; it must not be
                    // buffered as one for an agent to read.
                    if (stored.removal) {
                        const r = stored.removal;
                        if (r.stored) console.error(`[mcp] deleted for me: ${r.msgId}`);
                        else console.error(`[mcp] delete-for-me not applied: ${r.reason}`);
                        return;
                    }
                    if (!stored.stored) {
                        console.error(`[mcp] message not stored: ${stored.reason}`);
                        return;
                    }
                    if (stored.info.hasAttachment) fetchMedia(String(msg.threadId));

                    // Skip self-sent messages for the agent-facing buffer
                    if (msg.isSelf) return;

                    const normalized = normalizeMessage(msg, stored.info);

                    // Apply thread watch filter
                    if (!filter.shouldWatch(normalized.threadId, normalized.threadType)) return;

                    // Apply noise filter (stickers, system msgs, short emoji)
                    if (!filter.shouldKeep(normalized)) return;

                    buffer.push(normalized.threadId, normalized);
                    notifier.onMessage(normalized);
                    console.error(`[mcp] Buffered ${normalized.threadType} msg from ${normalized.threadId}`);
                });

                // After the storing handler, exactly as in `listen`: the write
                // always runs first, and the receipt handler only queues. Here
                // because re-login calls this function again with a new listener.
                deliveredReceipts.attach(api.listener);

                // Likewise, and for the same two reasons: the self-heal moves its
                // cursor only past a row already written, and a tap left on the
                // old listener after a re-login would go deaf.
                socketTap.attach(api.listener);
                selfHeal.attach(api.listener);

                // Everything below is durable state that exists only on this
                // socket, so it is stored regardless of the watch filter — the
                // filter decides what an agent is shown, not what is kept.
                api.listener.on("reaction", (reaction) => {
                    const r = storeLiveReaction(reaction);
                    if (!r.stored && r.reason) console.error(`[mcp] reaction not stored: ${r.reason}`);
                });

                api.listener.on("undo", (u) => {
                    const r = storeLiveUndo(u);
                    if (!r.stored && r.reason) console.error(`[mcp] recall not applied: ${r.reason}`);
                });

                api.listener.on("delivered_messages", (m) => storeReceipts(m, STATUS_RECEIVED));
                api.listener.on("seen_messages", (m) => storeReceipts(m, STATUS_SEEN));

                api.listener.on("group_event", (event) => {
                    noteBoardChange(event);
                    storeGroupEventRow(event);
                    // Same call as `listen`: our uid tells being removed from
                    // removing someone else, and a later event clears the flag.
                    const gone = storeGroupEvent(event, { ownId: activeAcc.ownId });
                    if (gone.gone) console.error(`[mcp] no longer in ${gone.threadId} — local history orphaned`);
                });

                api.listener.on("connected", () => {
                    if (reconnectCount > 0) {
                        console.error(`[mcp] Reconnected (#${reconnectCount})`);
                    }
                    lifecycle.noteUp();
                });

                api.listener.on("disconnected", (code) => {
                    if (lifecycle.isStopping()) return;
                    console.error(`[mcp] Disconnected (code: ${code}). Auto-retrying...`);
                    lifecycle.noteDown();
                });

                api.listener.on("closed", async (code) => {
                    if (lifecycle.isStopping()) return;
                    lifecycle.noteDown();
                    if (code === CLOSE_DUPLICATE) {
                        dropLock();
                        console.error("[mcp] Duplicate Zalo Web session detected. Exiting.");
                        process.exit(1);
                    }
                    reconnectCount++;
                    console.error(
                        `[mcp] Connection closed (code: ${code}). Re-login in 5s... (reconnect #${reconnectCount})`,
                    );
                    await new Promise((r) => setTimeout(r, 5000));
                    try {
                        clearSession();
                        await autoLogin(true);
                        console.error("[mcp] Re-login successful. Restarting listener...");
                        const newApi = getApi();
                        attachListenerHandlers(newApi);
                        newApi.listener.start({ retryOnClose: true });
                    } catch (e) {
                        console.error(`[mcp] Re-login failed: ${e.message}. Retrying in 30s...`);
                        await new Promise((r) => setTimeout(r, 30000));
                        try {
                            clearSession();
                            await autoLogin(true);
                            const retryApi = getApi();
                            attachListenerHandlers(retryApi);
                            retryApi.listener.start({ retryOnClose: true });
                            console.error("[mcp] Re-login successful on retry.");
                        } catch (e2) {
                            dropLock();
                            console.error(`[mcp] Re-login retry failed: ${e2.message}. Exiting.`);
                            process.exit(1);
                        }
                    }
                });

                api.listener.on("error", () => {
                    // WS errors are followed by close/disconnect — suppress to avoid noise
                });
            }

            // Wire listener and start
            try {
                const api = getApi();
                attachListenerHandlers(api);
                api.listener.start({ retryOnClose: true });
                console.error("[mcp] Zalo listener started. MCP server ready.");
                // This process holds the account's one permitted socket, so it
                // performs the work that needs one on behalf of the CLI:
                // attachment uploads, and the socket stages of `zalo-agent
                // sync`. Otherwise `msg send-file` opens a second session and
                // Zalo kills this one, and a sync cannot run at all while this
                // server is up. Best-effort: a failed channel only costs the
                // fallback. `getApi` rather than an api, because a
                // duplicate-session close rebuilds it under us.
                try {
                    channel = await startDaemonChannel({
                        getApi,
                        accountDir,
                        onLog: (m) => console.error(`[mcp] ${m}`),
                        runners: createSyncRunners({ getApi, accountName: activeAcc.ownId }),
                        // The self-heal's lock: a stage and a catch-up never share the socket.
                        lock: stageLock,
                    });
                    console.error(`[mcp] Sync & upload channel ready on 127.0.0.1:${channel.port}`);
                } catch (e) {
                    console.error(`[mcp] Daemon channel unavailable: ${e.message}`);
                    console.error("[mcp] Attachment sends open their own session, and `zalo-agent sync` will refuse.");
                }
            } catch (e) {
                dropLock();
                console.error("[mcp] Failed to start listener:", e.message);
                process.exit(1);
            }

            // Graceful shutdown on SIGINT
            process.on("SIGINT", () => {
                // First, before listener.stop() emits closed(1000) -- otherwise
                // the shutdown is indistinguishable from a drop and files a gap
                // for a window nothing was missed in.
                lifecycle.setStopping();
                clearInterval(mcpHeartbeatTimer);
                deliveredReceipts.stop();
                const receipts = deliveredReceipts.stats();
                if (receipts.calls) {
                    console.error(`[mcp] Delivered receipts: ${receipts.sent} acknowledged, ${receipts.failed} failed`);
                }
                try {
                    syncManager.markConnected();
                } catch (e) {
                    console.error(`[mcp] Failed to stamp shutdown state: ${e.message}`);
                }
                try {
                    getApi().listener.stop();
                } catch {
                    /* already stopped */
                }
                notifier?.destroy();
                httpServer?.close();
                dropLock();
                process.exit(0);
            });
            // A lock outliving its process blocks the next launch until the
            // stale-PID check reclaims it, so release it on any exit path.
            process.on("exit", dropLock);

            // Keep process alive (MCP server runs on stdio — process must not exit)
            await new Promise(() => {});
        });
}
