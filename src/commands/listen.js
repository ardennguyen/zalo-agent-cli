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
import { createStageLock, startDaemonChannel } from "../core/daemon-channel.js";
import { createSyncRunners } from "../core/daemon-sync.js";
import { createSocketTap } from "../core/socket-tap.js";
import { createSelfHeal } from "../core/self-heal.js";
import { createReadStateSync, readStateEvent } from "../core/read-state.js";
import { initDb, getPendingSyncGaps } from "../core/db.js";
import {
    storeLiveMessage,
    storeLiveDelete,
    storeLiveReaction,
    storeLiveUndo,
    storeGroupEvent,
    storeGroupEventRow,
    noteBoardChange,
    storeReceipts,
    isRemovalMessage,
} from "../core/live-store.js";
import { downloadSyncedMedia } from "../core/sync-v2/media.js";
import { SyncManager } from "../core/sync.js";
import { describeGap } from "../core/sync-v2/gap-advice.js";
import { createDeliveredReceipts } from "../core/receipts.js";

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
            "Comma-separated event types: message,friend,group,reaction,read (default: message,friend)",
            "message,friend",
        )
        .option("-f, --filter <type>", "Message filter: user (DM only), group (groups only), all", "all")
        .option("-w, --webhook <url>", "POST each event as JSON to this URL (for n8n, Make, etc.)")
        .option("--no-self", "Exclude self-sent messages")
        .option("--auto-accept", "Auto-accept incoming friend requests")
        .option("--save <dir>", "Save messages locally as JSONL files (one file per thread, e.g. --save ./zalo-logs)")
        .option(
            "--no-delivered-receipts",
            "Do not acknowledge received messages as delivered (every Zalo client does; seen receipts are never sent)",
        )
        .option(
            "--no-self-heal",
            "Do not pull what a dropped socket missed from Zalo's offline queue on reconnect (the default does, as Zalo Web does, on this socket and with no phone tap)",
        )
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
            /**
             * Stop the daemon channel and release the lock before an exit that
             * skips the SIGINT path, as `mcp start`'s dropLock() does -- so no
             * channel file or lock is left for the next start to reclaim.
             */
            const dropLock = () => {
                try {
                    channel?.stop();
                } catch {
                    /* not started yet: the socket closed during start-up */
                }
                try {
                    releaseLock(accountDir);
                } catch (e) {
                    console.error(`[listen] Failed to release lock: ${e.message}`);
                }
            };
            try {
                initDb(join(accountDir, "zalo.db"));
                info(`Local database initialized at ${accountDir}/zalo.db`);
            } catch (err) {
                releaseLock(accountDir);
                error(`Failed to initialize local DB: ${err.message}`);
                process.exit(1);
            }

            // Gap tracking: a small per-account SyncManager shares zalo.db with
            // this listener so a crash, manual close, or WS drop gets its window
            // recorded, and the owner is told which `sync` run closes it —
            // instead of silently losing whatever arrived while we weren't
            // connected. See reportGap() for why the daemon reports rather than
            // backfilling on its own.
            const syncManager = new SyncManager(getApi(), activeAcc.ownId);
            const HEARTBEAT_MS = 60 * 1000;
            let lastHeartbeatAt = 0;
            // The one place that knows whether the socket is actually up. The
            // `connected`/`disconnected` handlers below own it; everything else
            // reads it. Starts null: nothing is claimed before the first connect.
            let downSince = null;
            // Set by SIGINT before anything is torn down. listener.stop() emits
            // closed(1000), which is indistinguishable from a real drop, so
            // without this the shutdown path runs the RECOVERY path: five
            // seconds after the user sees "Stopped", the process re-logged in
            // and opened a fresh socket -- with daemon.lock already released and
            // daemon-channel.json already deleted. The next listen/mcp/sync then
            // took the free lock and the two sessions flapped over code 3000.
            let stopping = false;
            function heartbeat() {
                const now = Date.now();
                if (now - lastHeartbeatAt < HEARTBEAT_MS) return;
                lastHeartbeatAt = now;
                // markConnected() means "coverage is good up to now". Stamping
                // that on a timer with no liveness check kept advancing
                // lastConnectedAt while the socket was down -- through zca-js's
                // internal retry, the 5s re-login wait and the 30s retry wait --
                // so a crash mid-outage made the NEXT launch compute its
                // startup-gap from a moment we were not actually connected, and
                // the outage vanished.
                if (downSince !== null) return;
                syncManager.markConnected();
            }

            /**
             * Record a window we were not connected for, and tell the owner how
             * to close it.
             *
             * How the daemon self-heals
             * -------------------------
             * A window the socket was down for is first RECORDED here, then
             * closed from Zalo's offline queue -- the way Zalo Web closes it on
             * every connect. After each handshake the daemon asks each message
             * queue (510_1, 511_1) for everything after the last message it
             * stored, pages until the server says there is no more, and writes
             * what comes back insert-if-absent (src/core/self-heal.js). The gap
             * is resolved only for the window that pull covered; whatever it
             * could not reach stays pending, named with the `sync` command that
             * closes it.
             *
             * Three facts shape it:
             *
             *  - The socket is shared fine. The catch-up runs on this daemon's
             *    own socket while live traffic keeps arriving and being stored;
             *    nothing is stopped or reopened.
             *  - One of OUR stages at a time. It holds the daemon channel's
             *    stage lock, so it waits behind a running `zalo-agent sync`
             *    stage or `msg history` fetch, and a stage arriving meanwhile is
             *    refused (409) rather than run beside it. Two stages sharing the
             *    socket is what is measured to break the restore (the ordering
             *    note in src/commands/sync.js).
             *  - The phone tap is only for the full restore. The offline queue
             *    is served by Zalo's servers; `transfer-sync-v2` (cmd 590) is
             *    the one step that needs "ĐỒNG BỘ NGAY" on the owner's phone,
             *    and the daemon never starts it on its own -- only a
             *    `zalo-agent sync` someone typed does. (The self-heal this
             *    replaces called the retired pullMobileMsg/getCrossDB pair,
             *    MEASURED 2026-09-20 to have zero call sites in Zalo Web: it
             *    announced an attempt, said nothing more, and the gap stayed
             *    pending forever.)
             *
             * With `--no-self-heal` a gap is recorded and reported as before,
             * and closes only when a `sync` run does, via
             * `recordRestoreSuccess(win, {resolveGaps: true})`.
             */
            /** @returns {number|null} the recorded gap's id, or null when none was filed. */
            function reportGap(fromTs, reason) {
                if (!fromTs) return null;
                const toTs = Date.now();
                const gapId = syncManager.recordGap(fromTs, toTs, reason);
                if (!gapId) return null; // under recordGap's 1-second floor
                let pendingGaps = [];
                try {
                    pendingGaps = getPendingSyncGaps();
                } catch {
                    // Advice degrades to this gap alone — never worth crashing a listener.
                }
                // recordGap() clamps to MAX_GAP_MS, so re-read the stored row
                // rather than trusting fromTs: a 30-day-old lastConnectedAt is
                // filed as a 14-day gap, and `--from` must match what was filed.
                const stored = pendingGaps.find((g) => String(g.id) === String(gapId));
                const advice = describeGap({
                    fromTs: stored ? Number(stored.fromTs) : fromTs,
                    toTs: stored ? Number(stored.toTs) : toTs,
                    reason,
                    pendingGaps,
                });

                warning(`Coverage gap (${advice.reason}, ${advice.span}): ${advice.from} → ${advice.to}`);
                if (opts.selfHeal !== false) {
                    // The self-heal runs on the next handshake and reports what
                    // it recovered, and what it could not, on its own.
                    info("  Recovering it now from Zalo's offline queue on this socket (no phone tap needed).");
                    info(`  Whatever that cannot reach stays pending for:  ${advice.command}`);
                    return gapId;
                }
                info("  Messages that arrived in that window are not in the local cache.");
                info(`  To restore them:  ${advice.command}`);
                // No longer "stop this daemon first". That run asks this daemon
                // to perform the restore on the socket it already holds, so
                // nothing is torn down -- which matters here more than anywhere,
                // because the stop/start recipe opened a fresh gap of its own
                // while closing this one. The phone tap is NOT removed by that;
                // only the second WebSocket is.
                info("  That run uses this daemon's own socket while it keeps listening, so nothing");
                info('  needs stopping. It does need a tap on "ĐỒNG BỘ NGAY" on your phone.');
                // Load-bearing: recordRestoreSuccess() only clears a gap lying
                // wholly inside the restored window, so a run started from a
                // later date succeeds and leaves this gap pending anyway.
                info("  The gap stays pending until such a run completes.");
                if (advice.allCommand) {
                    info(
                        `  ${advice.otherPending} other gap(s) are also pending — ` +
                            `${advice.allCommand} covers all ${advice.pendingCount}.`,
                    );
                }
                return gapId;
            }

            // On startup, report whatever window we were not connected for.
            //
            // This used to fire only when the process had been down longer than
            // ~30s, on the theory that a quick restart is not worth reporting.
            // That theory is wrong in the one case that matters: a crash under a
            // supervisor restarts in seconds, lands inside the old threshold,
            // and the listener then called markConnected() -- asserting it was
            // caught up over a window it never saw. Messages lost to a 5-second
            // restart are just as lost as messages lost to a 5-minute one, and
            // nothing else would ever have flagged them.
            //
            // The reconnect path never had this gate. recordGap's own 1-second
            // floor is the only threshold worth keeping, so use it here too.
            // Deliberate restarts stay quiet on their own merits: SIGINT stamps
            // markConnected() on the way out, so a clean stop/start reports the
            // true downtime rather than a heartbeat-rounded guess.
            const lastConnectedAt = syncManager.getLastConnectedAt();
            if (!reportGap(lastConnectedAt, "startup-gap")) {
                // Nothing filed -- no prior connection on record, or a gap under
                // the floor. Either way we are caught up as of now.
                syncManager.markConnected();
            }
            const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);

            const jsonMode = program.opts().json;
            const startTime = Date.now();
            let reconnectCount = 0;
            let eventCount = 0;
            const enabledEvents = new Set(opts.events.split(",").map((e) => e.trim()));

            // Delivered receipts (deliveredv2): what every Zalo client sends when a
            // message arrives -- Zalo Web included, for our own echoes too. Built
            // once and shared with `mcp start` through src/core/receipts.js, so the
            // two listeners cannot drift apart (AGENTS.md §13). `getApi`, not an
            // api: a re-login replaces it. Seen receipts are never sent from here.
            const deliveredReceipts = createDeliveredReceipts({
                getApi,
                enabled: opts.deliveredReceipts !== false,
                log: (line) => console.error(`[listen] ${line}`),
            });

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

            /** Whether --events, --filter or --no-self keep a message off stdout, the webhook and the JSONL. */
            function isMuted(msg) {
                const filteredOut =
                    (opts.filter === "user" && msg.type !== THREAD_USER) ||
                    (opts.filter === "group" && msg.type !== THREAD_GROUP);
                // --no-self hides our own messages from stdout, the
                // webhook and the JSONL -- it does not delete them from
                // the cache. They are half of every conversation.
                return !enabledEvents.has("message") || filteredOut || (!opts.self && msg.isSelf);
            }

            /**
             * A message as `listen` reports it: the event object, and its one-line human form.
             *
             * @param {object} msg - the zca-js message event
             * @param {object} [extra] - fields to add, e.g. `{catchUp: true}`
             * @returns {{data: object, human: string}}
             */
            function messageEvent(msg, extra = {}) {
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
                    ...extra,
                };
                const dir = msg.isSelf ? "→" : "←";
                const typeLabel = msg.type === THREAD_USER ? "DM" : "GR";
                const tag = extra.catchUp ? " [catch-up]" : "";
                return {
                    data,
                    human: `${dir} [${typeLabel}]${tag} [${msg.threadId}] ${displayContent}  (msgId: ${msg.data.msgId})`,
                };
            }

            // One stage at a time on this socket -- the lock the daemon
            // channel's routes hold, shared with this daemon's own catch-up --
            // and one raw reader on the socket for the fields zca-js drops.
            // Built once, like the receipter: they outlive every re-login.
            const stageLock = createStageLock();
            const socketTap = createSocketTap({ log: (line) => console.error(`[listen] ${line}`) });
            // Read state other devices report -- a conversation read on the
            // phone, an unread mark set or cleared there -- which zca-js
            // drops. Stored always, like reactions; printed only with
            // `--events read`. It rides the tap, which re-arms on every socket.
            createReadStateSync({
                tap: socketTap,
                log: (line) => console.error(`[listen] ${line}`),
                onChange: (change) => {
                    if (!enabledEvents.has("read")) return;
                    const { data, human } = readStateEvent(change);
                    emitEvent(data, human);
                },
            });
            const selfHeal = createSelfHeal({
                getApi,
                tap: socketTap,
                lock: stageLock,
                enabled: opts.selfHeal !== false,
                log: (line) => console.error(`[listen] ${line}`),
                // A message recovered after a drop reaches stdout, the JSONL and
                // the webhook as a live one would, marked so a consumer can tell.
                onRecovered: (items) => {
                    for (const { msg } of items) {
                        if (isMuted(msg)) continue;
                        const { data, human } = messageEvent(msg, { catchUp: true });
                        emitEvent(data, human);
                    }
                },
            });

            /** Attach ALL handlers (data + lifecycle) to current API listener */
            function attachAllHandlers(api) {
                // --- Message events ---
                // Registered unconditionally. --events, --filter and --no-self
                // decide what is PRINTED, forwarded and saved as JSONL -- never
                // what is stored. They used to gate the handler itself, so
                // `listen --filter group` silently kept every DM out of the
                // cache and `listen --events group` stored no messages at all,
                // while the docs promised the flags only shaped the output.
                // A message missed live has no reliable way back: the phone
                // hands a transfer sync only what a web session was NOT
                // connected for.
                {
                    api.listener.on("message", async (msg) => {
                        const mute = isMuted(msg);

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

                        if (!mute) {
                            const { data, human } = messageEvent(msg);
                            emitEvent(data, human);
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

                // Subscribed AFTER the storing handler above, so the write has
                // always happened first; the receipt handler only queues, and
                // can neither throw into the socket loop nor hold the write up.
                // Here rather than at start-up because re-login calls this
                // function again with a new listener.
                deliveredReceipts.attach(api.listener);

                // Also after the storing handler, and here for the same reason:
                // the tap reads the envelope fields zca-js drops, and the
                // self-heal moves its cursor only past a row already written,
                // then catches up on every handshake this listener makes.
                socketTap.attach(api.listener);
                selfHeal.attach(api.listener);

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
                    // deleting the local copy stays an explicit decision. Any
                    // later event about it (a rejoin) clears the flag. Our uid
                    // is what tells being removed from removing someone else
                    // -- mcp.js passes it too.
                    const gone = storeGroupEvent(event, { ownId: activeAcc.ownId });
                    // The system line itself, as the row a sync would restore.
                    // Stored whatever --events says: output flags never gate storage.
                    const row = storeGroupEventRow(event);
                    if (!row.stored && row.reason && row.reason !== "not a system-line event") {
                        console.error(`[listen] group event not stored: ${row.reason}`);
                    }
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
                    }
                    // Driven by observed socket state, NOT by reconnectCount.
                    // reconnectCount is incremented only in the `closed` handler,
                    // and `closed` never fires for a code on the server's
                    // close_and_retry_codes list -- zca-js emits `disconnected`,
                    // retries internally, then emits `connected`. Those codes ARE
                    // the recoverable ones, so on the common drop path the old
                    // guard was always false: no gap was filed, and markConnected()
                    // below then asserted coverage over the whole outage. Messages
                    // lost to an ordinary reconnect were lost silently and for
                    // good, because `sync` is driven off exactly this advice.
                    if (downSince !== null) {
                        reportGap(downSince, "reconnect-gap");
                        downSince = null;
                    }
                    syncManager.markConnected();
                });

                api.listener.on("disconnected", (code, _reason) => {
                    if (stopping) return;
                    warning(`Disconnected (code: ${code}). Auto-retrying...`);
                    // First drop wins: a flapping socket that emits several
                    // `disconnected` before one `connected` is ONE outage, and the
                    // gap must span from the start of it.
                    if (downSince === null) downSince = Date.now();
                    syncManager.markDisconnected();
                });

                api.listener.on("closed", async (code, _reason) => {
                    // A deliberate stop closes with 1000 and must not be treated
                    // as a failure to recover from.
                    if (stopping) return;
                    if (code === CLOSE_DUPLICATE) {
                        error("Another Zalo Web session opened. Listener stopped.");
                        dropLock();
                        process.exit(1);
                    }
                    reconnectCount++;
                    if (downSince === null) downSince = Date.now();
                    syncManager.markDisconnected();
                    warning(`Connection closed (code: ${code}). Re-login in 5s... (uptime: ${uptime()})`);
                    await new Promise((r) => setTimeout(r, 5000));
                    try {
                        clearSession();
                        await autoLogin(jsonMode);
                        info("Re-login successful. Restarting listener...");
                        // Attach ALL handlers to the NEW api (including lifecycle),
                        // and repoint the SyncManager at it so its bookkeeping
                        // runs against a live, authenticated client.
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
                info(
                    opts.deliveredReceipts !== false
                        ? "Delivered receipts: ON (opt out with --no-delivered-receipts). Seen receipts: never sent."
                        : "Delivered receipts: OFF. Seen receipts: never sent.",
                );
                info(
                    opts.selfHeal !== false
                        ? "Self-heal: ON — after a drop or restart, missed messages come back from Zalo's offline queue on this socket, no phone tap (opt out with --no-self-heal)."
                        : "Self-heal: OFF — a coverage gap stays pending until `zalo-agent sync` closes it.",
                );
            } catch (e) {
                error(`Listen failed: ${e.message}`);
                process.exit(1);
            }

            // This daemon owns the account's one permitted WebSocket, so it
            // also does the work that needs one: a `msg send-file` in another
            // terminal, or the socket stages of `zalo-agent sync`, would
            // otherwise open a second session and Zalo would evict this one
            // mid-conversation. The sync stages are the reason the gap advice
            // above no longer says "stop this daemon first".
            //
            // Failing to open the channel is not fatal, but it is not free
            // either: senders fall back to their own socket as before, and a
            // sync goes back to refusing to run while this daemon is up.
            //
            // `createSyncRunners` is handed `getApi`, not an api: this daemon
            // rebuilds one on a duplicate-session close, and a stage bound to
            // the old object would tap a socket zca-js has already nulled.
            let channel = null;
            try {
                channel = await startDaemonChannel({
                    getApi,
                    accountDir,
                    onLog: (m) => info(m),
                    runners: createSyncRunners({ getApi, accountName: activeAcc.ownId }),
                    // The self-heal's lock: a stage and a catch-up never share the socket.
                    lock: stageLock,
                });
                info(`Sync & upload channel ready on 127.0.0.1:${channel.port} — this socket is reused for both.`);
                info("`zalo-agent sync` will run its socket stages here; it still needs your phone tap.");
            } catch (e) {
                warning(`Daemon channel unavailable (${e.message}).`);
                warning("Attachment sends will open their own session, and `zalo-agent sync` will refuse to run.");
            }

            // Keep alive until Ctrl+C
            await new Promise((resolve) => {
                process.on("SIGINT", () => {
                    // First, before anything can emit a close event.
                    stopping = true;
                    channel?.stop();
                    deliveredReceipts.stop();
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
                    const receipts = deliveredReceipts.stats();
                    if (receipts.calls) {
                        info(`Delivered receipts: ${receipts.sent} acknowledged, ${receipts.failed} failed`);
                    }
                    if (saveDir) info(`Messages saved to: ${saveDir}`);
                    resolve();
                    // Resolving the keep-alive promise is not enough: an async
                    // `closed` handler already in flight resumes after the action
                    // function has returned and keeps the process alive. mcp.js
                    // already exits explicitly here for the same reason.
                    process.exit(0);
                });
            });
        });
}
