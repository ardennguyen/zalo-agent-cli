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
import { initDb } from "../core/db.js";
import {
    storeLiveMessage,
    storeLiveReaction,
    storeLiveUndo,
    storeGroupEvent,
    noteBoardChange,
    storeReceipts,
} from "../core/live-store.js";
import { downloadSyncedMedia } from "../core/sync-v2/media.js";
import { classifyLiveMessage } from "../core/sync-v2/message-types.js";
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
            const dropLock = () => {
                if (!lockHeld) return;
                lockHeld = false;
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
            const config = loadMCPConfig();
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
                    const deps = { api: getApi(), buffer, filter, config, nameCache, accountDir };
                    const authToken = opts.auth?.trim() || null;
                    httpServer = createHTTPServer(registerTools, deps, port, authToken, opts.host || "127.0.0.1");
                    console.error(`[mcp] HTTP server started on port ${port}`);
                } else {
                    await createMCPServer(getApi(), buffer, filter, config, nameCache, accountDir);
                }
            } catch (e) {
                dropLock();
                console.error("[mcp] Failed to start MCP server:", e.message);
                process.exit(1);
            }

            // Setup notifier (sends to Zalo group when agent is offline)
            const notifier = new ZaloNotifier(getApi(), config);

            let reconnectCount = 0;

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
                    const gone = storeGroupEvent(event);
                    if (gone.gone) console.error(`[mcp] no longer in ${gone.threadId} — local history orphaned`);
                });

                api.listener.on("connected", () => {
                    if (reconnectCount > 0) {
                        console.error(`[mcp] Reconnected (#${reconnectCount})`);
                    }
                });

                api.listener.on("disconnected", (code) => {
                    console.error(`[mcp] Disconnected (code: ${code}). Auto-retrying...`);
                });

                api.listener.on("closed", async (code) => {
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
            } catch (e) {
                dropLock();
                console.error("[mcp] Failed to start listener:", e.message);
                process.exit(1);
            }

            // Graceful shutdown on SIGINT
            process.on("SIGINT", () => {
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
