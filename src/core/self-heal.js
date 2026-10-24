/**
 * Self-heal: after a reconnect or a restart, the daemon pulls what its socket
 * missed from Zalo's offline queue -- on its own socket, with no phone -- and
 * resolves a coverage gap only for the window that pull actually covered.
 *
 * This is what Zalo Web does on every authenticated connect (./offline-queue.js
 * has the bundle offsets and the capture): each message queue is asked for
 * everything after its saved cursor, page by page until the server says there
 * is no more. It never involves the phone. The phone-backed restore
 * (transfer-sync-v2, cmd 590) is a different thing -- the full history, and the
 * one step that needs the owner's tap -- and nothing here ever starts it; only a
 * `zalo-agent sync` a person typed does.
 *
 * The rules, and why:
 *
 * - **Runs on every handshake.** The trigger is the cmd 1 handshake frame, read
 *   by ./socket-tap.js, not zca-js's `connected`: the handshake is what makes a
 *   socket usable, it carries the queue list (`qCmds`), and zca-js sets the
 *   cipher key from it synchronously just before. A daemon start is simply the
 *   first handshake.
 * - **One of our stages at a time.** It takes the daemon's stage lock
 *   (daemon-channel.js `createStageLock`), so it waits behind a running `sync`
 *   stage or `msg history` fetch and never shares the socket with one. Live
 *   traffic keeps flowing and keeps being stored meanwhile; that sharing is fine.
 * - **The cursor only moves past a committed row.** Per queue, the id of the
 *   last message this daemon actually has in zalo.db -- advanced from live
 *   messages after the listener stored them, and from recovered pages after
 *   they were written. For the 510_1/511_1 queues that id IS the queue's
 *   `lastId` (live pushes carry `queueStatus["511_1"].lastId` = the pushed
 *   msgId). Moving it before the write would let a crash skip a message
 *   forever; a cursor that lags only re-fetches what insert-if-absent then
 *   ignores. With no saved cursor, a queue starts from its newest stored
 *   message, then from the other queue's cursor (the web keeps one shared
 *   `lastActionId` for queues it has no id of its own for).
 * - **Written insert-if-absent, removals applied.** New messages go through
 *   the history writer (`storeHistoryMessage`, `raw_data.src` "offline"), so a
 *   row the cache already holds is never modified. A recall or a
 *   delete-for-me in the queue is applied like the listener applies it: it is
 *   an event this daemon missed live, not an old history row, and skipping it
 *   would keep readable something its sender withdrew.
 * - **Coverage is claimed, never assumed.** Only when every message queue was
 *   drained to `more: 0` is the window from the (latest) cursor to now
 *   covered. A queue that times out, stalls, hits the page cap or is reset
 *   covers nothing. A queue reporting `evict` covers only from the oldest
 *   message it still returned -- the server dropped the rest (M2).
 * - **A gap resolves only where it was covered.** A pending gap overlapping the
 *   covered window is resolved, and its uncovered remainder is recorded again
 *   as a pending gap, named with the `zalo-agent sync` command that closes it.
 *
 * - **Items are acknowledged after the write, never before** (Y10, D7). Zalo wants to be told which queue
 *   items a client holds (a `532`, see ./queue-verify.js), and repairs what it was not told about. A live push
 *   is acknowledged once every message in it is committed; an offline page once its rows were written without a
 *   failure; a message the server re-sends as a `534` is stored first and acknowledged after. An item whose row
 *   did not commit is not acknowledged, so the server delivers it again.
 *
 * Out of scope here, on purpose: the 533/570 resend path (the server asking us for ids it says we hold). It
 * repairs a push lost in transit on a live socket; the catch-up above is a cursor pull and does not depend on
 * it. Zalo Web does not verify offline batches either (`skip_offline_verify`, bundle @~13896600): acknowledging
 * them is this client's own choice, so the server can drop what it delivered.
 */
import { GroupMessage, UserMessage, Undo } from "zca-js";
import {
    getMessageById,
    getMessages,
    getPendingSyncGaps,
    getRecentThreads,
    getSyncState,
    recordSyncGap,
    resolveSyncGap,
    runInTransaction,
    setSyncState,
} from "./db.js";
import { isRemovalMessage, storeHistoryMessage, storeLiveDelete, storeLiveUndo } from "./live-store.js";
import { DEFAULT_MAX_PAGES, DEFAULT_PAGE_TIMEOUT_MS, drainOfflineQueue, messageQueuesFrom } from "./offline-queue.js";
import { CMD_AUTHEN } from "./socket-tap.js";
import { CMD_VERIFY, createQueueVerifier, idsOf } from "./queue-verify.js";
import { controlCursorsOf, readControls } from "./control-queue.js";
import { describeGap } from "./sync-v2/gap-advice.js";

/** zca-js ThreadType.Group; anything else is a 1-1. */
const THREAD_GROUP = 1;

/** Live pushes, and the queue whose cursor each one's envelope carries. */
const PUSH_QUEUE = new Map([
    [501, { queueName: "510_1", rows: "msgs" }],
    [521, { queueName: "511_1", rows: "groupMsgs" }],
]);

/** The control frame: transfer-sync statuses and batches, unread marks, group and friend events. */
const CMD_CONTROL = 601;

/** A server re-push of a message it noticed we never confirmed (534), in the envelope of 501/521. */
const CMD_PUSH_MISS = 534;

/** How long a live push waits for its rows to be stored before it is forgotten (never acknowledged). */
const AWAIT_MS = 10 * 60 * 1000;
const AWAIT_MAX = 500;

/** recordGap's own floor: shorter than this is not a gap worth naming. */
const MIN_GAP_MS = 1000;

/**
 * The sync_state key holding one queue's cursor, `{id, ts}` as JSON.
 *
 * @param {string} queueName - e.g. "511_1"
 * @returns {string}
 */
export function cursorKey(queueName) {
    return `offlineCursor:${queueName}`;
}

const isId = (v) => /^\d+$/.test(String(v ?? ""));

/** a > b for decimal id strings, without losing digits past 2^53. */
function idGreater(a, b) {
    if (!isId(a)) return false;
    if (!isId(b)) return true;
    return BigInt(a) > BigInt(b);
}

const iso = (ts) => new Date(ts).toISOString();

/** "uncovered:uncovered:startup-gap" helps nobody; keep the original cause. */
const baseReason = (reason) => String(reason || "gap").replace(/^(uncovered:)+/, "");

/**
 * Build a daemon's self-heal. `listen` and `mcp start` each build exactly one.
 *
 * @param {object} args
 * @param {() => object} args.getApi - the daemon's CURRENT api; re-login replaces it
 * @param {ReturnType<import("./socket-tap.js").createSocketTap>} args.tap - the daemon's socket tap
 * @param {ReturnType<import("./daemon-channel.js").createStageLock>} [args.lock] - the
 *   stage lock the daemon channel holds; without one the catch-up runs unguarded
 * @param {boolean} [args.enabled=true] - false (`--no-self-heal`): subscribe to
 *   nothing, send nothing, write nothing
 * @param {(line: string) => void} [args.log] - one line per run; stderr only
 * @param {(items: Array<{msg: object, info: object}>) => void} [args.onRecovered] -
 *   the messages a run stored that the cache never had, oldest first, for the
 *   daemon's bot-facing output (the MCP buffer, `listen`'s events and webhook)
 * @param {() => number} [args.now]
 * @param {number} [args.timeoutMs] - wait per page
 * @param {number} [args.maxPages] - pages per queue
 * @param {boolean} [args.acks=true] - acknowledge stored queue items to Zalo (`532`); false sends nothing of the kind
 * @returns {{attach: (listener: object) => void, run: (reason?: string) => Promise<object>,
 *   settled: () => Promise<void>, noteDelivered: (msg: object) => void,
 *   cursor: (queueName: string) => {id: string, ts: number}|null}}
 */
export function createSelfHeal({
    getApi,
    tap,
    lock = null,
    enabled = true,
    log = (line) => console.error(line),
    onRecovered = () => {},
    now = () => Date.now(),
    timeoutMs = DEFAULT_PAGE_TIMEOUT_MS,
    maxPages = DEFAULT_MAX_PAGES,
    acks = true,
} = {}) {
    const cursors = new Map();
    // Tells Zalo which queue items are safely stored (Y10). Nothing is handed to it before the commit.
    const verifier =
        enabled && acks
            ? createQueueVerifier({
                  getListener: () => getApi?.()?.listener ?? null,
                  settings: () => getApi?.()?.getContext?.()?.settings?.features?.socket ?? {},
                  log: (line) => say(line),
              })
            : null;
    /** Live pushes whose rows are not all stored yet: {queueName, ids, msgIds: Set, at}. */
    const awaiting = [];
    const attached = new WeakSet();
    let running = null;
    let again = false;
    let lastResult = null;

    const say = (line) => {
        try {
            log(`self-heal: ${line}`);
        } catch {
            /* a broken logger must not break the daemon */
        }
    };

    function readCursor(queueName) {
        if (cursors.has(queueName)) return cursors.get(queueName);
        let c = null;
        try {
            const v = getSyncState(cursorKey(queueName));
            const parsed = v ? JSON.parse(v) : null;
            if (parsed && isId(parsed.id)) c = { id: String(parsed.id), ts: Number(parsed.ts) || 0 };
        } catch {
            /* an unreadable cursor is no cursor */
        }
        cursors.set(queueName, c);
        return c;
    }

    function writeCursor(queueName, c) {
        cursors.set(queueName, c);
        setSyncState(cursorKey(queueName), JSON.stringify({ id: c.id, ts: c.ts }));
    }

    /** Move a queue's cursor forward -- never back. */
    function advance(queueName, c) {
        const cur = readCursor(queueName);
        if (!cur || idGreater(c.id, cur.id)) writeCursor(queueName, c);
    }

    /** The newest message already stored for one thread type, as a starting cursor. */
    function newestStored(threadType) {
        const [thread] = getRecentThreads(1, threadType === THREAD_GROUP ? "group" : "dm");
        if (!thread) return null;
        const [m] = getMessages(thread.threadId, 1);
        if (!m || !isId(m.msgId)) return null;
        return { id: String(m.msgId), ts: Number(m.timestamp) || 0 };
    }

    /** A live message, after the listener's own handler stored it. */
    function noteDelivered(msg) {
        const id = msg?.data?.msgId;
        if (!isId(id)) return;
        try {
            // Only a committed row may move the cursor: see the file header.
            if (!getMessageById(String(id))) return;
            const queueName = msg.type === THREAD_GROUP ? "511_1" : "510_1";
            advance(queueName, { id: String(id), ts: Number(msg.data.ts) || now() });
            settle(String(id));
        } catch (e) {
            say(`could not record the queue position: ${e?.message || e}`);
        }
    }

    /** A row is committed: acknowledge every live push whose rows are now all committed. */
    function settle(msgId) {
        if (!verifier) return;
        for (let i = awaiting.length - 1; i >= 0; i--) {
            const entry = awaiting[i];
            if (!entry.msgIds.delete(msgId) || entry.msgIds.size > 0) continue;
            awaiting.splice(i, 1);
            verifier.confirm(entry.queueName, entry.ids);
        }
    }

    /** A live push named queue items: acknowledge them once its rows are committed. */
    function trackPush(queueName, d, rowsKey) {
        if (!verifier) return;
        const ids = idsOf(d.queueStatus, queueName);
        if (!ids.length) return;
        const cutoff = now() - AWAIT_MS;
        while (awaiting.length && (awaiting[0].at < cutoff || awaiting.length >= AWAIT_MAX)) awaiting.shift();
        const rows = Array.isArray(d[rowsKey]) ? d[rowsKey] : [];
        // Rows the storing handler committed before this frame was read are already safe.
        const msgIds = new Set(rows.map((r) => String(r?.msgId ?? "")).filter((id) => isId(id) && !getMessageById(id)));
        if (msgIds.size === 0) verifier.confirm(queueName, ids);
        else awaiting.push({ queueName, ids, msgIds, at: now() });
    }

    /** True when some pending gap already spans part of [fromTs, toTs]. */
    function overlapsPending(fromTs, toTs) {
        return getPendingSyncGaps().some((g) => Number(g.toTs) > fromTs && Number(g.fromTs) < toTs);
    }

    /** M2: the server dropped (evict) or reset a queue -- record the window, once. */
    function recordLoss(fromTs, toTs, reason) {
        if (!(toTs - fromTs >= MIN_GAP_MS) || overlapsPending(fromTs, toTs)) return null;
        recordSyncGap(fromTs, toTs, reason);
        const advice = describeGap({ fromTs, toTs, reason, pendingGaps: getPendingSyncGaps() });
        say(
            `Zalo reports it dropped part of ${reason.split(":")[1] || "a queue"} ` +
                `(${reason.split(":")[0]}): ${advice.span} from ${advice.from} is recorded as a gap — close it with: ${advice.command}`,
        );
        return { fromTs, toTs, reason };
    }

    /** A live 501/521 envelope that says the server dropped or reset the queue. */
    function noteEnvelope(frame) {
        const push = PUSH_QUEUE.get(frame.cmd);
        const d = frame.data;
        if (!push || !d) return;
        try {
            const rows = Array.isArray(d[push.rows]) ? d[push.rows] : [];
            const times = rows.map((r) => Number(r?.ts)).filter((t) => Number.isFinite(t) && t > 0);
            const oldest = times.length ? Math.min(...times) : now();
            const cur = readCursor(push.queueName);
            const evicted = Object.entries(d.queueStatus || {}).some(
                ([q, st]) => q.startsWith(push.queueName.slice(0, 4)) && Number(st?.evict) === 1,
            );
            if (evicted && cur) recordLoss(cur.ts, oldest, `queue-evicted:${push.queueName}`);
            const reset = d.resetLastActionId;
            if (isId(reset) && String(reset) !== "0") {
                if (cur) recordLoss(cur.ts, now(), `queue-reset:${push.queueName}`);
                writeCursor(push.queueName, { id: String(reset), ts: now() });
            }
            trackPush(push.queueName, d, push.rows);
        } catch (e) {
            say(`could not read a live queue status: ${e?.message || e}`);
        }
    }

    /** Write one page's rows as the listener would have, had it seen them live. */
    function storeRows(queue, rows, ownId, cursorId) {
        const isGroup = queue.threadType === THREAD_GROUP;
        const out = { added: [], untouched: 0, removals: 0, newest: null, oldestTs: null, older: 0, failed: 0 };
        for (const raw of rows) {
            if (!raw || typeof raw !== "object") continue;
            const row = { ...raw }; // zca-js's models rewrite their data in place
            const ts = Number(row.ts);
            if (Number.isFinite(ts) && ts > 0) out.oldestTs = out.oldestTs === null ? ts : Math.min(out.oldestTs, ts);
            // lastId means "after this" in every use Zalo Web makes of it; a
            // row from before the cursor says the server read it differently.
            if (isId(row.msgId) && idGreater(cursorId, row.msgId)) out.older++;
            try {
                const content = row.content;
                if (
                    content &&
                    typeof content === "object" &&
                    !Array.isArray(content) &&
                    Object.hasOwn(content, "deleteMsg")
                ) {
                    // A recall: zca-js turns exactly this shape into its `undo` event.
                    if (storeLiveUndo(new Undo(ownId, row, isGroup)).stored) out.removals++;
                    continue;
                }
                const msg = isGroup ? new GroupMessage(ownId, row) : new UserMessage(ownId, row);
                if (isRemovalMessage(msg.data)) {
                    if (storeLiveDelete(msg).stored) out.removals++;
                    continue;
                }
                const r = storeHistoryMessage(msg, { src: "offline" });
                if (r.stored) out.added.push({ msg, info: r.info });
                else {
                    out.untouched++;
                    // A row deliberately not written is handled; one whose write failed is not.
                    if (r.failed) out.failed++;
                }
                // The cursor may pass this row only because it is in zalo.db now.
                const id = String(row.msgId ?? "");
                if (isId(id) && getMessageById(id) && (!out.newest || idGreater(id, out.newest.id))) {
                    out.newest = { id, ts: Number.isFinite(ts) && ts > 0 ? ts : now() };
                }
            } catch (e) {
                out.untouched++;
                out.failed++;
                say(`a recovered row was not stored: ${e?.message || e}`);
            }
        }
        return out;
    }

    /** Resolve what the covered window covers; re-record what it does not. */
    function resolveCovered(coverage) {
        let resolved = 0;
        const remainders = [];
        for (const g of getPendingSyncGaps()) {
            const f = Number(g.fromTs);
            const t = Number(g.toTs);
            if (!(t > coverage.from && f < coverage.to)) continue;
            const left = [];
            if (coverage.from - f >= MIN_GAP_MS) {
                left.push({
                    fromTs: f,
                    toTs: coverage.from,
                    reason: coverage.cause || `uncovered:${baseReason(g.reason)}`,
                });
            }
            if (t - coverage.to >= MIN_GAP_MS) {
                left.push({ fromTs: coverage.to, toTs: t, reason: `uncovered:${baseReason(g.reason)}` });
            }
            runInTransaction(() => {
                resolveSyncGap(g.id);
                for (const r of left) recordSyncGap(r.fromTs, r.toTs, r.reason);
            });
            resolved++;
            remainders.push(...left);
        }
        return { resolved, remainders };
    }

    async function healOnce(reason) {
        const api = getApi?.();
        const listener = api?.listener;
        if (!listener?.ws || listener.ws.readyState > 1 || !listener.cipherKey) {
            say(`skipped (${reason}): the socket is not up and authenticated`);
            return { ran: false, skipped: "socket-not-ready" };
        }
        const ownId = String(api.getOwnId?.() ?? api.getContext?.()?.uid ?? "");
        const queues = messageQueuesFrom(tap?.auth()?.qCmds);
        if (!queues.length) {
            say(`skipped (${reason}): the handshake lists no message queue`);
            return { ran: false, skipped: "no-message-queues" };
        }

        const plan = queues.map((queue) => ({
            queue,
            cursor: readCursor(queue.queueName) || newestStored(queue.threadType),
        }));
        const shared = plan.reduce(
            (best, p) => (p.cursor && (!best || idGreater(p.cursor.id, best.id)) ? p.cursor : best),
            null,
        );
        for (const p of plan) if (!p.cursor && shared) p.cursor = shared;

        const asked = plan.map((p) => `${p.queue.queueName} after ${p.cursor ? p.cursor.id : "(nothing stored yet)"}`);
        say(
            `asking Zalo's offline queue on this socket what it missed (${reason}; no phone involved): ${asked.join(", ")}`,
        );

        const results = [];
        for (const p of plan) {
            if (!p.cursor) {
                results.push({ queue: p.queue, cursor: null, complete: false, reason: "no-cursor", added: [] });
                continue;
            }
            const r = await drainOfflineQueue({
                listener,
                tap,
                queue: p.queue,
                lastId: p.cursor.id,
                timeoutMs,
                maxPages,
            });
            const s = storeRows(p.queue, r.rows, ownId, p.cursor.id);
            if (s.newest) advance(p.queue.queueName, s.newest);
            // The rows are written: the items they came in may be acknowledged. A page with a row that failed
            // is not, so the server delivers its items again.
            if (verifier && r.ids?.length && s.failed === 0) verifier.confirm(p.queue.queueName, r.ids);
            if (r.resetTo) writeCursor(p.queue.queueName, { id: r.resetTo, ts: now() });
            if (s.older) {
                say(
                    `${p.queue.queueName} answered with ${s.older} message(s) from before the cursor; ` +
                        "stored insert-if-absent, but not taken as coverage",
                );
            }
            // Not a full answer, whatever `more` said.
            const complete = r.complete && !s.older;
            const reason = r.complete && s.older ? "out-of-order" : r.reason;
            results.push({ queue: p.queue, cursor: p.cursor, ...r, ...s, complete, reason });
        }

        const added = results.flatMap((r) => r.added || []);
        if (added.length) {
            try {
                onRecovered(added);
            } catch (e) {
                say(`handing recovered messages on failed: ${e?.message || e}`);
            }
        }

        // Coverage: every queue drained, each from a known point.
        let coverage = null;
        if (results.every((r) => r.complete)) {
            let from = -Infinity;
            let cause = null;
            for (const r of results) {
                const start = r.evicted ? r.oldestTs : r.cursor.ts;
                if (!Number.isFinite(start)) {
                    from = null;
                    break;
                }
                if (start > from) {
                    from = start;
                    cause = r.evicted ? `queue-evicted:${r.queue.queueName}` : null;
                }
            }
            if (from !== null && Number.isFinite(from)) coverage = { from, to: now(), cause };
        }

        const done = coverage ? resolveCovered(coverage) : { resolved: 0, remainders: [] };

        // What the server says it lost is a gap even with nothing pending over it.
        const losses = [];
        for (const r of results) {
            if (!r.cursor) continue;
            if (r.evicted) {
                const l = recordLoss(r.cursor.ts, r.oldestTs ?? now(), `queue-evicted:${r.queue.queueName}`);
                if (l) losses.push(l);
            }
            if (r.resetTo) {
                const l = recordLoss(r.cursor.ts, now(), `queue-reset:${r.queue.queueName}`);
                if (l) losses.push(l);
            }
        }

        const untouched = results.reduce((n, r) => n + (r.untouched || 0), 0);
        const removals = results.reduce((n, r) => n + (r.removals || 0), 0);
        const summary = `recovered ${added.length} message(s) (${untouched} already cached, ${removals} removal(s) applied)`;
        if (coverage) {
            say(`${summary}; covered since ${iso(coverage.from)}; closed ${done.resolved} gap(s).`);
            const pendingGaps = getPendingSyncGaps();
            for (const rem of done.remainders) {
                const advice = describeGap({ ...rem, pendingGaps });
                say(
                    `${advice.span} before that stays pending (${rem.reason}): ${advice.from} → ${advice.to} — ` +
                        `close it with: ${advice.command}`,
                );
            }
        } else {
            const failed = results.filter((r) => !r.complete).map((r) => `${r.queue.queueName} (${r.reason})`);
            const pendingGaps = getPendingSyncGaps();
            let hint = "";
            if (pendingGaps.length) {
                // Oldest first, so its command reaches back far enough for all of them.
                const advice = describeGap({ ...pendingGaps[0], pendingGaps });
                hint = ` — ${pendingGaps.length} gap(s) stay pending; close them with: ${advice.command}`;
            }
            say(`${summary}; not finished: ${failed.join(", ")}, so no window is marked covered${hint}`);
        }

        return {
            ran: true,
            reason,
            recovered: added.length,
            untouched,
            removals,
            coverage,
            resolved: done.resolved,
            remainders: done.remainders,
            losses,
            queues: results.map((r) => ({
                queueName: r.queue.queueName,
                lastId: r.cursor?.id ?? null,
                complete: r.complete,
                reason: r.reason,
                pages: r.pages ?? 0,
                evicted: Boolean(r.evicted),
                added: r.added?.length ?? 0,
            })),
        };
    }

    async function healUnderLock(reason) {
        const release = lock ? await lock.acquire("self-heal") : () => {};
        try {
            return await healOnce(reason);
        } finally {
            release();
        }
    }

    /** Start a run, or fold into the running one and go once more after it. */
    function trigger(reason) {
        if (!enabled) return;
        if (running) {
            again = true;
            return;
        }
        running = (async () => {
            try {
                let why = reason;
                do {
                    again = false;
                    lastResult = await healUnderLock(why);
                    why = "reconnected during the last run";
                } while (again);
            } catch (e) {
                say(`failed: ${e?.message || e}`);
            } finally {
                running = null;
            }
        })();
    }

    /** Control kinds already reported as unhandled, so each is named once. */
    const unhandled = new Set();

    /**
     * A 601: keep the control queues' cursors (forward only) for the pull that will use them, and name any
     * control this client has no handler for, once, instead of letting it pass unseen (X4).
     */
    function noteControls(frame) {
        const d = frame.data;
        if (!d) return;
        try {
            for (const { queueName, id } of controlCursorsOf(d)) advance(queueName, { id, ts: now() });
            for (const c of readControls(d)) {
                if (c.handled) continue;
                const key = `${c.actType}/${c.act}`;
                if (unhandled.has(key)) continue;
                unhandled.add(key);
                say(`a control this client has no handler for: act_type "${c.actType}", act "${c.act}"`);
            }
        } catch (e) {
            say(`could not read a control frame: ${e?.message || e}`);
        }
    }

    /** The server re-sends a message it noticed we never confirmed: store it, then acknowledge it. */
    function noteMissedPush(frame) {
        const d = frame.data;
        if (!d) return;
        try {
            const api = getApi?.();
            const ownId = String(api?.getOwnId?.() ?? api?.getContext?.()?.uid ?? "");
            const kinds = [
                { queueName: "510_1", rows: "msgs", threadType: 0 },
                { queueName: "511_1", rows: "groupMsgs", threadType: THREAD_GROUP },
            ];
            const added = [];
            for (const kind of kinds) {
                const rows = Array.isArray(d[kind.rows]) ? d[kind.rows] : [];
                if (!rows.length) continue;
                const s = storeRows(kind, rows, ownId, "0");
                added.push(...s.added);
                if (s.newest) advance(kind.queueName, s.newest);
                const ids = idsOf(d.queueStatus, kind.queueName);
                if (verifier && s.failed === 0 && ids.length) verifier.confirm(kind.queueName, ids);
            }
            if (added.length) {
                say(`Zalo re-sent ${added.length} message(s) it noticed this client never confirmed; stored`);
                onRecovered(added);
            }
        } catch (e) {
            say(`could not store a re-sent message: ${e?.message || e}`);
        }
    }

    if (enabled && tap) {
        tap.on(CMD_AUTHEN, () => {
            // A new connection: what was waiting to be acknowledged belonged to the old one.
            verifier?.reset();
            awaiting.length = 0;
            trigger("connect");
        });
        for (const cmd of PUSH_QUEUE.keys()) tap.on(cmd, noteEnvelope);
        tap.on(CMD_CONTROL, noteControls);
        if (verifier) {
            tap.on(CMD_VERIFY, (frame) => verifier.handleReply(frame));
            tap.on(CMD_PUSH_MISS, noteMissedPush);
        }
    }

    return {
        attach(listener) {
            if (!enabled || !listener || attached.has(listener)) return;
            attached.add(listener);
            // Registered after the daemon's storing handler (the wiring test
            // holds both daemons to that), so the row exists when this runs.
            listener.on("message", noteDelivered);
        },
        async run(reason = "manual") {
            trigger(reason);
            await (running || Promise.resolve());
            return lastResult;
        },
        settled() {
            return running ? running.then(() => {}) : Promise.resolve();
        },
        noteDelivered,
        cursor: (queueName) => readCursor(queueName),
        /** The queue acknowledgements so far, or null when they are off. */
        queueAcks: () => verifier?.stats() ?? null,
        /** Send the pending acknowledgements now (a test and shutdown seam). */
        flushAcks: () => verifier?.flush() ?? 0,
    };
}
