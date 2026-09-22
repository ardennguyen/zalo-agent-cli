/**
 * Unified listener — combines message, friend, and group events in one WebSocket connection.
 * Production-ready with auto-reconnect and re-login.
 */

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";
import { getApi, autoLogin, clearSession } from "../core/zalo-client.js";
import { success, error, info, warning } from "../utils/output.js";
import { getActive } from "../core/accounts.js";
import { CONFIG_DIR } from "../core/credentials.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { startDaemonChannel } from "../core/daemon-channel.js";
import { initDb } from "../core/db.js";
import {
    storeLiveMessage,
    storeLiveDelete,
    storeLiveReaction,
    storeLiveUndo,
    storeGroupEvent,
    noteBoardChange,
    storeReceipts,
    isRemovalMessage,
} from "../core/live-store.js";
import { downloadSyncedMedia } from "../core/sync-v2/media.js";
import { SyncManager } from "../core/sync.js";

/** Thread types matching zca-js ThreadType enum */
const THREAD_USER = 0;
const THREAD_GROUP = 1;

/** Friend event type → readable label (matches zca-js FriendEventType enum order) */
const FRIEND_EVENT_LABELS = {
    0: "friend_added",
    1: "friend_removed",
    2: "friend_request",
    3: "undo_request",
    4: "reject_request",
    5: "seen_request",
    6: "blocked",
    7: "unblocked",
};
const FRIEND_REQUEST_TYPE = 2;

/** Zalo close code for duplicate web session */
const CLOSE_DUPLICATE = 3000;

export function registerListenCommand(program) {
    program
        .command("listen")
        .description(
            "Listen for all Zalo events (messages, friend requests, group events) via one WebSocket. Auto-reconnect enabled.",
        )
        .option(
            "-e, --events <types>",
            "Comma-separated event types: message,friend,group,reaction (default: message,friend)",
            "message,friend",
        )
        .option("-f, --filter <type>", "Message filter: user (DM only), group (groups only), all", "all")
        .option("-w, --webhook <url>", "POST each event as JSON to this URL (for n8n, Make, etc.)")
        .option("--no-self", "Exclude self-sent messages")
        .option("--auto-accept", "Auto-accept incoming friend requests")
        .option("--save <dir>", "Save messages locally as JSONL files (one file per thread, e.g. --save ./zalo-logs)")
        .action(async (opts) => {
            const activeAcc = getActive();
            if (!activeAcc) {
                error("No active account. Please login first.");
                process.exit(1);
            }
            const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);
            if (!acquireLock(accountDir)) {
                error(`Another listen daemon is already running for account ${activeAcc.ownId}.`);
                process.exit(1);
            }
            try {
                initDb(join(accountDir, "zalo.db"));
                info(`Local database initialized at ${accountDir}/zalo.db`);
            } catch (err) {
                releaseLock(accountDir);
                error(`Failed to initialize local DB: ${err.message}`);
                process.exit(1);
            }

            // Gap tracking / auto-backfill (task #4): a small per-account
            // SyncManager shares zalo.db with this listener so a crash,
            // manual close, or brief WS drop gets its window recorded and
            // automatically retried via mobile sync, instead of silently
            // losing whatever arrived while we weren't connected.
            const syncManager = new SyncManager(getApi(), activeAcc.ownId);
            const HEARTBEAT_MS = 60 * 1000;
            let lastHeartbeatAt = 0;
            function heartbeat() {
                const now = Date.now();
                if (now - lastHeartbeatAt < HEARTBEAT_MS) return;
                lastHeartbeatAt = now;
                syncManager.markConnected();
            }

            function attemptBackfill(fromTs, reason) {
                if (!fromTs) return;
                const gapId = syncManager.recordGap(fromTs, Date.now(), reason);
                if (!gapId) return; // gap too small to bother with
                const mins = Math.round((Date.now() - fromTs) / 60000);
                info(`Coverage gap detected (${reason}, ~${mins}m). Attempting mobile-sync backfill...`);
                syncManager
                    .pollSync(0, 0, { force: true })
                    .then((result) => {
                        if (result.status === "saved") {
                            success(`Backfilled ${result.saved} message(s) from the missed window.`);
                        } else if (result.status === "crossdb-error" || result.status === "no-token") {
                            warning(
                                `Could not confirm the missed window (${reason}) was backfilled (${result.status}). ` +
                                    `It stays pending and will be retried on next launch or "zalo-agent sync-mobile".`,
                            );
                        }
                    })
                    .catch((e) => {
                        warning(`Backfill attempt failed (non-fatal): ${e.message}`);
                    });
            }

            // On startup, check how long it's been since we were last known
            // connected. A short gap (e.g. a quick restart) isn't worth
            // bothering the phone about; anything longer than ~30s (crash,
            // reboot, listener closed for a while) gets a real backfill
            // attempt, clamped to MAX_GAP_MS inside recordGap().
            const lastConnectedAt = syncManager.getLastConnectedAt();
            if (lastConnectedAt && Date.now() - lastConnectedAt > 30 * 1000) {
                attemptBackfill(lastConnectedAt, "startup-gap");
            } else {
                syncManager.markConnected();
            }
            const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);

            const jsonMode = program.opts().json;
            const startTime = Date.now();
            let reconnectCount = 0;
            let eventCount = 0;
            const enabledEvents = new Set(opts.events.split(",").map((e) => e.trim()));

            function uptime() {
                const s = Math.floor((Date.now() - startTime) / 1000);
                const h = Math.floor(s / 3600);
                const m = Math.floor((s % 3600) / 60);
                return h > 0 ? `${h}h${m}m` : `${m}m${s % 60}s`;
            }

            /** Fire-and-forget webhook POST — never blocks event processing */
            function postWebhook(data) {
                if (!opts.webhook) return;
                fetch(opts.webhook, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(data),
                    signal: AbortSignal.timeout(5000),
                }).catch((e) => {
                    console.error(`[listen] Webhook failed: ${e.message}`);
                });
            }

            // Setup save directory if --save flag provided
            let saveDir = null;
            if (opts.save) {
                saveDir = resolve(opts.save);
                if (!existsSync(saveDir)) mkdirSync(saveDir, { recursive: true });
                info(`Saving messages to: ${saveDir}`);
            }

            /** Append event to JSONL file (one file per threadId) */
            function saveEvent(data) {
                if (!saveDir || !data.threadId) return;
                const filename = `${data.threadId}.jsonl`;
                const filepath = join(saveDir, filename);
                const line = JSON.stringify({ ...data, savedAt: new Date().toISOString() }) + "\n";
                try {
                    appendFileSync(filepath, line, "utf-8");
                } catch (e) {
                    console.error(`[listen] Save failed: ${e.message}`);
                }
            }

            /** Output event as JSON or human-readable, save locally, then post to webhook */
            function emitEvent(data, humanMsg) {
                eventCount++;
                if (jsonMode) {
                    console.log(JSON.stringify(data));
                } else {
                    info(humanMsg);
                }
                saveEvent(data);
                postWebhook(data);
            }

            /** Attach ALL handlers (data + lifecycle) to current API listener */
            function attachAllHandlers(api) {
                // --- Message events ---
                if (enabledEvents.has("message")) {
                    api.listener.on("message", async (msg) => {
                        if (opts.filter === "user" && msg.type !== THREAD_USER) return;
                        if (opts.filter === "group" && msg.type !== THREAD_GROUP) return;
                        // --no-self hides our own messages from stdout, the
                        // webhook and the JSONL -- it does not delete them from
                        // the cache. They are half of every conversation.
                        const mute = !opts.self && msg.isSelf;

                        // A "delete for me" frame rides the message channel but
                        // removes a message rather than adding one, so it is
                        // reported as the removal it is -- never as an incoming
                        // message, which would have a webhook receiver acting on
                        // a msgId that names only the notification.
                        if (isRemovalMessage(msg.data)) {
                            const r = storeLiveDelete(msg);
                            if (!mute) {
                                emitEvent(
                                    {
                                        event: "deleted_for_me",
                                        threadId: msg.threadId,
                                        msgId: r.msgId ?? null,
                                        applied: r.stored,
                                    },
                                    r.stored
                                        ? `Deleted for me: ${r.msgId} in ${msg.threadId}` +
                                              (r.mediaRemoved ? " (media removed)" : "")
                                        : `Delete for me could not be applied: ${r.reason}`,
                                );
                            }
                            if (!r.stored) console.error(`[listen] delete-for-me not applied: ${r.reason}`);
                            heartbeat();
                            return;
                        }

                        const rawContent = msg.data.content;
                        const isText = typeof rawContent === "string";
                        const msgType = msg.data.msgType || null;
                        // Build readable display: show type + title/href for non-text
                        let displayContent;
                        if (isText) {
                            displayContent = rawContent;
                        } else if (rawContent && typeof rawContent === "object") {
                            const parts = [msgType || "attachment"];
                            if (rawContent.title) parts.push(`"${rawContent.title}"`);
                            if (rawContent.href) parts.push(rawContent.href);
                            displayContent = `[${parts.join(" | ")}]`;
                        } else {
                            displayContent = `[${msgType || "non-text"}]`;
                        }
                        const data = {
                            event: "message",
                            msgId: msg.data.msgId,
                            cliMsgId: msg.data.cliMsgId,
                            threadId: msg.threadId,
                            type: msg.type,
                            isSelf: msg.isSelf,
                            uidFrom: msg.data.uidFrom || null,
                            dName: msg.data.dName || null,
                            msgType,
                            content: rawContent,
                        };
                        const dir = msg.isSelf ? "→" : "←";
                        const typeLabel = msg.type === THREAD_USER ? "DM" : "GR";
                        if (!mute) {
                            emitEvent(
                                data,
                                `${dir} [${typeLabel}] [${msg.threadId}] ${displayContent}  (msgId: ${msg.data.msgId})`,
                            );
                        }
                        heartbeat();

                        // One writer for live traffic: storeLiveMessage is the
                        // same function a running mobile sync uses, so a row
                        // written here is indistinguishable from a restored one,
                        // and the type vocabulary (photo, not chat.photo) is
                        // shared with it.
                        const stored = storeLiveMessage(msg);
                        if (!stored.stored) {
                            console.error(`[listen] message not stored: ${stored.reason}`);
                            return;
                        }
                        // Fetch through the SAME downloader the mobile sync
                        // uses: it brings the request deadline, the
                        // expiry-vs-throttling classification and the shared
                        // per-conversation folders. The row is already stored
                        // with has_attachment, so the downloader finds it by
                        // query. Fire and forget -- a slow CDN must never stall
                        // event processing.
                        if (stored.info.hasAttachment) {
                            downloadSyncedMedia({
                                api,
                                accountDir,
                                threadId: String(msg.threadId),
                                limit: 5,
                                concurrency: 2,
                            }).catch((err) => console.error(`[listen] media download failed: ${err.message}`));
                        }
                    });
                }

                // --- Friend events ---
                if (enabledEvents.has("friend")) {
                    api.listener.on("friend_event", async (event) => {
                        const label = FRIEND_EVENT_LABELS[event.type] || "friend_unknown";
                        const data = {
                            event: label,
                            threadId: event.threadId,
                            isSelf: event.isSelf,
                            data: event.data,
                        };
                        const humanMsg =
                            event.type === FRIEND_REQUEST_TYPE
                                ? `Friend request from ${event.data.fromUid}: "${event.data.message || ""}"`
                                : `${label} — ${event.threadId}`;
                        emitEvent(data, humanMsg);

                        // Auto-accept incoming friend requests
                        if (opts.autoAccept && event.type === FRIEND_REQUEST_TYPE && !event.isSelf) {
                            try {
                                await api.acceptFriendRequest(event.data.fromUid);
                                success(`Auto-accepted friend request from ${event.data.fromUid}`);
                            } catch (e) {
                                error(`Auto-accept failed: ${e.message}`);
                            }
                        }
                    });
                }

                // --- Group events ---
                // Also ungated for storage, for the same reason: with the
                // default --events, being removed from a group was never
                // recorded, so its local copy stayed invisible to `conv forget
                // --orphans`, and a pin or note change never marked its board
                // stale. Both are durable state; only the printing is optional.
                api.listener.on("group_event", (event) => {
                    // Pin, unpin, note, poll and reminder changes: flag the
                    // board stale so the next sync-boards refetches it. The
                    // event carries a delta, not the item's full shape.
                    const board = noteBoardChange(event);
                    // Leaving or being removed means this conversation is no
                    // longer ours. Flag it so it surfaces as an orphan;
                    // deleting the local copy stays an explicit decision.
                    const gone = storeGroupEvent(event);
                    if (!enabledEvents.has("group")) return;
                    emitEvent(
                        {
                            event: `group_${event.type}`,
                            threadId: event.threadId,
                            isSelf: event.isSelf,
                            data: event.data,
                        },
                        `Group: ${event.type} — ${event.threadId}`,
                    );
                    if (board.stale) {
                        emitEvent(
                            { event: "board_changed", threadId: board.threadId, type: event.type },
                            `Board changed in ${board.threadId} (${event.type}) — run sync-boards to refresh`,
                        );
                    }
                    if (gone.gone) {
                        emitEvent(
                            { event: "thread_gone", threadId: gone.threadId },
                            `No longer in ${gone.threadId} — its local history is now orphaned (see \`conv forget\`)`,
                        );
                    }
                });

                // --- Reaction events ---
                // Storage is NOT gated on --events. Reactions exist only on
                // this socket -- the mobile sync payload has no reaction field
                // -- and the default
                // --events value does not include them, so gating the write
                // meant a plain `zalo-agent listen` permanently lost every
                // reaction it watched go past. --events decides what you SEE.
                api.listener.on("reaction", (reaction) => {
                    const r = storeLiveReaction(reaction);
                    if (!r.stored && r.reason) console.error(`[listen] reaction not stored: ${r.reason}`);
                    if (!enabledEvents.has("reaction")) return;
                    if (!opts.self && reaction.isSelf) return;
                    // Name the icon and the message. "Reaction in <thread>" was
                    // true of a reaction stored against the wrong message, a
                    // removal that deleted nothing, and a working one alike.
                    const on = r.msgIds?.filter(Boolean).join(",") || "?";
                    const what = r.removing
                        ? `Reactions cleared on ${on} (${r.changed} removed)`
                        : `Reaction ${r.icon} on ${on}`;
                    emitEvent(
                        {
                            event: "reaction",
                            threadId: reaction.threadId,
                            isSelf: reaction.isSelf,
                            isGroup: reaction.isGroup,
                            removing: r.removing ?? null,
                            changed: r.changed ?? null,
                            data: reaction.data,
                        },
                        `${what} in ${reaction.threadId}`,
                    );
                });

                // --- Delivery receipts ---
                // The sync establishes msgStatus per message; without these it
                // goes stale the moment the restore finishes. Always on: this is
                // durable state, not the typing/presence noise it resembles.
                api.listener.on("delivered_messages", (m) => storeReceipts(m, 4));
                api.listener.on("seen_messages", (m) => storeReceipts(m, 5));

                // --- Undo / recall ---
                // Always on, regardless of --events. A recall is the sender
                // withdrawing a message; a cache that keeps the text readable
                // afterwards is retaining something they took back. This is the
                // one event that must never be opt-in.
                api.listener.on("undo", (u) => {
                    const r = storeLiveUndo(u);
                    // The recalled id comes from content, not from the
                    // notification's own msgId -- printing the latter named a
                    // message nobody had ever seen.
                    const target = r.msgId ?? String(u?.data?.content?.globalMsgId ?? "");
                    emitEvent(
                        { event: "undo", threadId: u?.threadId, isSelf: u?.isSelf, msgId: target, applied: r.stored },
                        `Recalled message ${target} in ${u?.threadId}${r.mediaRemoved ? " (media removed)" : ""}`,
                    );
                    if (!r.stored && r.reason) console.error(`[listen] recall not applied: ${r.reason}`);
                });

                // --- Lifecycle events (MUST be on same listener for reconnect to work) ---
                api.listener.on("connected", () => {
                    if (reconnectCount > 0) {
                        info(`Reconnected (#${reconnectCount}, uptime: ${uptime()}, events: ${eventCount})`);
                        // The socket was down for some window (task #4) — try
                        // to backfill whatever arrived while we were dropped,
                        // same as the startup-gap check above.
                        const disconnectedAt = syncManager.getLastDisconnectedAt();
                        attemptBackfill(disconnectedAt, "reconnect-gap");
                    }
                    syncManager.markConnected();
                });

                api.listener.on("disconnected", (code, _reason) => {
                    warning(`Disconnected (code: ${code}). Auto-retrying...`);
                    syncManager.markDisconnected();
                });

                api.listener.on("closed", async (code, _reason) => {
                    if (code === CLOSE_DUPLICATE) {
                        error("Another Zalo Web session opened. Listener stopped.");
                        process.exit(1);
                    }
                    reconnectCount++;
                    syncManager.markDisconnected();
                    warning(`Connection closed (code: ${code}). Re-login in 5s... (uptime: ${uptime()})`);
                    await new Promise((r) => setTimeout(r, 5000));
                    try {
                        clearSession();
                        await autoLogin(jsonMode);
                        info("Re-login successful. Restarting listener...");
                        // Attach ALL handlers to the NEW api (including lifecycle),
                        // and repoint the SyncManager at it so pollSync() calls
                        // during the next gap use a live, authenticated client.
                        const newApi = getApi();
                        syncManager.api = newApi;
                        attachAllHandlers(newApi);
                        newApi.listener.start({ retryOnClose: true });
                    } catch (e) {
                        error(`Re-login failed: ${e.message}. Retrying in 30s...`);
                        await new Promise((r) => setTimeout(r, 30000));
                        try {
                            clearSession();
                            await autoLogin(jsonMode);
                            const retryApi = getApi();
                            syncManager.api = retryApi;
                            attachAllHandlers(retryApi);
                            retryApi.listener.start({ retryOnClose: true });
                            info("Re-login successful on retry.");
                        } catch (e2) {
                            error(`Re-login retry failed: ${e2.message}. Exiting.`);
                            process.exit(1);
                        }
                    }
                });

                api.listener.on("error", (_err) => {
                    // WS errors are followed by close/disconnect — don't crash
                });
            }

            // --- Initial start ---
            try {
                const api = getApi();
                attachAllHandlers(api);
                api.listener.start({ retryOnClose: true });

                info("Listening for Zalo events... Press Ctrl+C to stop.");
                info(`Events: ${opts.events}`);
                info("Auto-reconnect enabled.");
                if (opts.filter !== "all") info(`Message filter: ${opts.filter}`);
                if (opts.webhook) info(`Webhook: ${opts.webhook}`);
                if (saveDir) info(`Save dir: ${saveDir} (JSONL per thread)`);
                if (opts.autoAccept) info("Auto-accept friend requests: ON");
            } catch (e) {
                error(`Listen failed: ${e.message}`);
                process.exit(1);
            }

            // This daemon owns the account's one permitted WebSocket, so it
            // also does the uploads: a `msg send-file` in another terminal
            // would otherwise open a second session, and Zalo would evict this
            // one mid-conversation. Failing to open the channel is not fatal --
            // senders just fall back to their own socket, as before.
            let channel = null;
            try {
                channel = await startDaemonChannel({
                    getApi,
                    accountDir,
                    onLog: (m) => info(m),
                });
                info(`Upload channel ready on 127.0.0.1:${channel.port} — attachment sends will reuse this socket.`);
            } catch (e) {
                warning(`Upload channel unavailable (${e.message}). Attachment sends will open their own session.`);
            }

            // Keep alive until Ctrl+C
            await new Promise((resolve) => {
                process.on("SIGINT", () => {
                    channel?.stop();
                    try {
                        getApi().listener.stop();
                    } catch (e) {
                        console.error(`[listen] Stop failed: ${e.message}`);
                    }
                    clearInterval(heartbeatTimer);
                    // Stamp "last known connected" at the moment we stop, so a
                    // deliberate close (or the process simply exiting) gives
                    // the NEXT launch an accurate window to backfill from,
                    // rather than treating this whole downtime as unknown.
                    try {
                        syncManager.markConnected();
                    } catch (e) {
                        console.error(`[listen] Failed to stamp shutdown state: ${e.message}`);
                    }
                    releaseLock(accountDir);
                    info(`Stopped. Uptime: ${uptime()}, events: ${eventCount}, reconnects: ${reconnectCount}`);
                    if (saveDir) info(`Messages saved to: ${saveDir}`);
                    resolve();
                });
            });
        });
}
