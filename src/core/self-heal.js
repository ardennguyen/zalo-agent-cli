/**
 * Self-heal: after a reconnect or a restart, the daemon pulls what its socket
 * missed from Zalo's offline queue -- on its own socket, with no phone -- and
 * resolves a coverage gap only for the window that pull actually covered.
 *
 * This is what a client does on every authenticated connect (../zalo/queues/offline-queue.js): each message queue is
 * asked for everything after its saved cursor, page by page until the server says there
 * is no more. It never involves the phone. The phone-backed restore
 * (transfer-sync-v2, cmd 590) is a different thing -- the full history, and the
 * one step that needs the owner's tap -- and nothing here ever starts it; only a
 * `zalo-agent sync` a person typed does.
 *
 * The rules, and why:
 *
 * - **Runs on every handshake.** The trigger is the cmd 1 handshake frame, read
 *   by ../zalo/listener/socket-tap.js, not the listener's `connected`: the handshake is what makes a
 *   socket usable, it carries the queue list (`qCmds`), and the listener sets the
 *   cipher key from it synchronously just before. A daemon start is simply the
 *   first handshake.
 * - **One queue at a time, one deadline.** The message queues in the handshake's `qCmds` order, then the control
 *   queues, each drained from its own cursor once the one before it is done. Asking every queue in the same moment, as
 *   this once did (5c99017), fails: live, Zalo then answered only the first queue
 *   and never 511_1 or 603_1, at start or on a wake, reproduced both ways on the same cursors (2026-11-12). The whole
 *   catch-up has one deadline (`offline_timeout`, 480 s), and one page is waited for at most 30 s inside it. A
 *   queue unanswered then, or whose socket closed, is not finished: its gaps stay pending and the next connect or
 *   wake asks again. The socket supervisor owns every reconnect, so at its deadline the run only says it did not
 *   finish.
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
 *   message, then from the other queue's cursor (one shared `lastActionId`
 *   serves queues that have no id of their own).
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
 * - **Coverage never spans a device change.** Zalo keeps the offline queue per
 *   device (imei): a new device's queue starts at its login, and a cursor from an
 *   earlier device is answered with what the new queue holds -- often nothing,
 *   `more: 0`, no `evict`. So coverage never starts before the time this device id
 *   came into use (`deviceSince`, ./device-since.js), unless a phone-backed restore
 *   finished after it and reached back past it. What lies before stays pending as
 *   `new-device`, with the `zalo-agent sync --from` advice.
 * - **Overflow repairs groups, and reports the rest.** A queue that reports
 *   `evict` (or a reset) dropped messages. For the group queue the groups' cloud
 *   store is read back to the loss (./overflow-repair.js, bounded) and, when that
 *   reached every group, the group loss is closed without a tap. A 1-1 loss stays
 *   pending. Either way a `queue_overflow` notice goes out (`onNotice`). A drain of
 *   0 rows with no `evict` is a quiet queue, never an overflow.
 *
 * - **Items are acknowledged after the write, never before** (Y10, D7). Zalo wants to be told which queue
 *   items a client holds (a `532`, see ../zalo/queues/queue-verify.js), and repairs what it was not told about. A live push
 *   is acknowledged once every message in it is committed; a message the server re-sends as a `534` is stored first
 *   and acknowledged after. An item whose row did not commit is not acknowledged, so the server delivers it again.
 * - **Offline pages are never acknowledged, and nothing is while they drain.** Offline batches are not verified
 *   (`skip_offline_verify`), and the verifier starts only once the offline catch-up is done
 *   (`verify_on_done_offline`). So a connect holds the verifier until its catch-up
 *   run is over, finished or not; live and `534` acks confirmed meanwhile go out then. Offline rows are still
 *   stored and still move the cursor.
 * - **A re-sent message is announced once** (design 6.1, FX 11). Our listener announces a `534` as `message` too,
 *   after the tap stored it here and handed it on through `onRecovered`. `isRepeatedRepush` tells `listen` and
 *   `mcp start` that such a message is already stored, so neither prints, buffers nor posts it a second time. The
 *   `534` ids are noted even with self-heal off (read only: nothing sent, nothing written), so a re-push of a
 *   message the daemon already got live stays one event there too.
 *
 * Out of scope here, on purpose: the 533/570 resend path (the server asking us for ids it says we hold). It
 * repairs a push lost in transit on a live socket; the catch-up above is a cursor pull and does not depend on
 * it.
 */
import { GroupMessage, UserMessage, Undo } from "../zalo/listener/models.js";
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
import { IDLE_EVICTED_REASON, IDLE_GAP_REASON } from "./listener-lifecycle.js";
import {
    DEFAULT_DRAIN_TIMEOUT_MS,
    DEFAULT_MAX_PAGES,
    controlQueuesFrom,
    drainOfflineQueue,
    messageQueuesFrom,
} from "../zalo/queues/offline-queue.js";
import { replayControlQueues } from "./control-replay.js";
import { CMD_AUTHEN } from "../zalo/listener/socket-tap.js";
import { CMD_VERIFY, createQueueVerifier, idsOf } from "../zalo/queues/queue-verify.js";
import { controlCursorsOf, readControls } from "../zalo/queues/control-queue.js";
import { describeGap } from "./sync-v2/gap-advice.js";
import { queueOverflowEvent, repairGroupsFromCloud } from "./overflow-repair.js";

/** THREAD_TYPE.Group; anything else is a 1-1. */
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

/** At most this many re-pushed (534) message ids are remembered until their `message` event; the oldest go first. */
const REPUSH_MAX = 2000;

/** How long a live push waits for its rows to be stored before it is forgotten (never acknowledged). */
const AWAIT_MS = 10 * 60 * 1000;
const AWAIT_MAX = 500;

/** recordGap's own floor: shorter than this is not a gap worth naming. */
const MIN_GAP_MS = 1000;

/** The reason of a window before this device's login, which the device's queue cannot reach (./device-since.js). */
export const NEW_DEVICE_REASON = "new-device";

/** The message queue of 1-1 messages and of group messages, by the cmd their name starts with. */
const isGroupQueue = (queueName) => String(queueName).startsWith("511");

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
 * What an uncovered part of a gap is called. A planned idle window (on-demand presence) that the queue no longer
 * covers becomes `idle-evicted`: a real gap, alarmed on, closed by `sync --from`.
 */
const uncoveredReason = (reason, cause = null) =>
    baseReason(reason) === IDLE_GAP_REASON || baseReason(reason) === IDLE_EVICTED_REASON
        ? IDLE_EVICTED_REASON
        : cause || `uncovered:${baseReason(reason)}`;

/**
 * Build a daemon's self-heal. `listen` and `mcp start` each build exactly one.
 *
 * @param {object} args
 * @param {() => object} args.getApi - the daemon's CURRENT api; re-login replaces it
 * @param {ReturnType<import("../zalo/listener/socket-tap.js").createSocketTap>} args.tap - the daemon's socket tap
 * @param {ReturnType<import("./daemon-channel.js").createStageLock>} [args.lock] - the
 *   stage lock the daemon channel holds; without one the catch-up runs unguarded
 * @param {boolean} [args.enabled=true] - false (`--no-self-heal`): send nothing,
 *   write nothing, and subscribe to nothing but the read-only note of `534` ids
 *   that `isRepeatedRepush` answers from
 * @param {(line: string) => void} [args.log] - one line per run; stderr only
 * @param {(items: Array<{msg: object, info: object}>) => void} [args.onRecovered] -
 *   the messages a run stored that the cache never had, oldest first, for the
 *   daemon's bot-facing output (the MCP buffer, `listen`'s events and webhook)
 * @param {() => number} [args.now]
 * @param {number} [args.timeoutMs] - the whole catch-up's deadline, every queue and page included
 *   (`offline_timeout`); there is no per-page wait
 * @param {number} [args.maxPages] - pages per queue
 * @param {boolean} [args.acks=true] - acknowledge stored queue items to Zalo (`532`); false sends nothing of the kind
 * @param {(undo: Undo) => {stored: boolean}} [args.storeUndo] - writes a recall found on a queue page; the live
 *   store's by default. A seam for tests: the recall's thread type does not reach zalo.db.
 * @param {() => (number|{ts: number, source?: string}|null)} [args.deviceSince] - since when this account's device id
 *   is in use (./device-since.js `deviceSinceOf`); coverage never starts before it. Null or absent: no floor.
 * @param {(event: object) => void} [args.onNotice] - a `queue_overflow` event (./overflow-repair.js) for the daemon's
 *   log, webhook and MCP buffer
 * @param {object} [args.groupRepair] - options for ./overflow-repair.js `repairGroupsFromCloud` (tests: its seams);
 *   `false` turns the group repair off
 * @param {(done: {reason: string, ms: number, result: object|null}) => void} [args.onRun] - a catch-up (one run, with
 *   the runs folded into it) finished: on-demand presence ends its start-up and pulse holds here
 * @returns {{attach: (listener: object) => void, run: (reason?: string) => Promise<object>,
 *   settled: () => Promise<void>, noteDelivered: (msg: object) => void,
 *   isRepeatedRepush: (msg: object) => boolean,
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
    timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    maxPages = DEFAULT_MAX_PAGES,
    acks = true,
    storeUndo = storeLiveUndo,
    deviceSince = null,
    onNotice = () => {},
    groupRepair = {},
    onRun = () => {},
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
    /** The message ids of `534` frames whose `message` events have not come yet, oldest first. */
    const repushed = new Set();
    /** Live pushes whose rows are not all stored yet: {queueName, ids, msgIds: Set, at}. */
    const awaiting = [];
    const attached = new WeakSet();
    let running = null;
    let again = false;
    let lastResult = null;
    /** The repair a live overflow started, so they run one at a time. */
    let overflowRun = Promise.resolve();

    const say = (line) => {
        try {
            log(`self-heal: ${line}`);
        } catch {
            /* a broken logger must not break the daemon */
        }
    };

    /**
     * The coverage floor: this device's login, lowered to where a phone-backed restore reached back when that restore
     * finished after it (the restore then covers the window the device's queue cannot).
     */
    function coverageFloor() {
        let floor = null;
        let source = null;
        try {
            const v = typeof deviceSince === "function" ? deviceSince() : deviceSince;
            const ts = typeof v === "object" && v !== null ? Number(v.ts) : Number(v);
            if (Number.isFinite(ts) && ts > 0) {
                floor = ts;
                source = typeof v === "object" && v !== null ? v.source || null : null;
            }
        } catch (e) {
            say(`could not read when this device logged in: ${e?.message || e}`);
            return { ts: now(), source: "unknown" };
        }
        if (floor === null) return null;
        try {
            const okAt = Number(getSyncState("lastSyncOkAt"));
            const okFrom = Number(getSyncState("lastSyncOkFrom"));
            if (
                getSyncState("lastSyncOkKind") === "transfer" &&
                Number.isFinite(okAt) &&
                Number.isFinite(okFrom) &&
                okAt >= floor &&
                okFrom <= floor
            ) {
                return { ts: okFrom, source: "restore", deviceTs: floor };
            }
        } catch {
            /* no restore on record: the device's login stays the floor */
        }
        return { ts: floor, source, deviceTs: floor };
    }

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
            const lost = [];
            if (evicted && cur && recordLoss(cur.ts, oldest, `queue-evicted:${push.queueName}`)) {
                lost.push({ queueName: push.queueName, fromTs: cur.ts });
            }
            const reset = d.resetLastActionId;
            if (isId(reset) && String(reset) !== "0") {
                if (cur && recordLoss(cur.ts, now(), `queue-reset:${push.queueName}`)) {
                    lost.push({ queueName: push.queueName, fromTs: cur.ts });
                }
                writeCursor(push.queueName, { id: String(reset), ts: now() });
            }
            if (lost.length) scheduleOverflow(lost);
            trackPush(push.queueName, d, push.rows);
        } catch (e) {
            say(`could not read a live queue status: ${e?.message || e}`);
        }
    }

    /** A live push reported a loss: repair and report it under the stage lock, after whatever runs now. */
    function scheduleOverflow(lost) {
        overflowRun = overflowRun
            .then(async () => {
                const release = lock ? await lock.acquire("self-heal") : () => {};
                try {
                    await handleOverflow(getApi?.(), lost);
                } finally {
                    release();
                }
            })
            .catch((e) => say(`overflow repair failed: ${e?.message || e}`));
    }

    /** Write one page's rows as the listener would have, had it seen them live. */
    function storeRows(queue, rows, ownId, cursorId) {
        const isGroup = queue.threadType === THREAD_GROUP;
        const out = { added: [], untouched: 0, removals: 0, newest: null, oldestTs: null, older: 0, failed: 0 };
        for (const raw of rows) {
            if (!raw || typeof raw !== "object") continue;
            const row = { ...raw }; // the message models rewrite their data in place
            const ts = Number(row.ts);
            if (Number.isFinite(ts) && ts > 0) out.oldestTs = out.oldestTs === null ? ts : Math.min(out.oldestTs, ts);
            // lastId means "after this" in every use Zalo makes of it; a
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
                    // A recall: the listener turns exactly this shape into its `undo` event.
                    if (storeUndo(new Undo(ownId, row, isGroup)).stored) out.removals++;
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
                    reason: uncoveredReason(g.reason, coverage.cause),
                });
            }
            if (t - coverage.to >= MIN_GAP_MS) {
                left.push({ fromTs: coverage.to, toTs: t, reason: uncoveredReason(g.reason) });
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

        // One queue at a time, the message queues in `qCmds` order and then the control queues, all under one deadline
        // from this moment. Not all at once: asked in the same moment, Zalo
        // answered only the first (510_1) for this client and never 511_1 or 603_1, so group messages and group events
        // missed while parked never came back (2026-11-12, reproduced both ways on the same cursors).
        const deadline = now() + timeoutMs;
        const left = () => Math.max(0, deadline - now());

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
                timeoutMs: left(),
                maxPages,
                log: say,
            });
            const s = storeRows(p.queue, r.rows, ownId, p.cursor.id);
            if (s.newest) advance(p.queue.queueName, s.newest);
            // Not acknowledged: an offline batch is never verified (`skip_offline_verify`, see the file header).
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
        const controlsDone = replayControls(listener, left());

        const added = results.flatMap((r) => r.added || []);
        if (added.length) {
            try {
                onRecovered(added);
            } catch (e) {
                say(`handing recovered messages on failed: ${e?.message || e}`);
            }
        }

        // Coverage: every queue drained, each from a known point -- and never from before this device's login.
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
            const floor = from !== null && Number.isFinite(from) ? coverageFloor() : null;
            if (floor && floor.ts > from) {
                say(
                    `this device logged in at ${iso(floor.deviceTs ?? floor.ts)}, after the queue position ` +
                        `(${iso(from)}): Zalo keeps the offline queue per device, so nothing before that can come ` +
                        "from it, however empty its answer was",
                );
                from = floor.ts;
                cause = NEW_DEVICE_REASON;
            }
            if (from !== null && Number.isFinite(from)) coverage = { from, to: now(), cause };
        }

        const done = coverage ? resolveCovered(coverage) : { resolved: 0, remainders: [] };

        // What the server says it lost is a gap even with nothing pending over it.
        const losses = [];
        const overflowed = [];
        for (const r of results) {
            if (!r.cursor) continue;
            if (r.evicted) {
                const l = recordLoss(r.cursor.ts, r.oldestTs ?? now(), `queue-evicted:${r.queue.queueName}`);
                if (l) losses.push(l);
                overflowed.push({ queueName: r.queue.queueName, fromTs: r.cursor.ts });
            }
            if (r.resetTo) {
                const l = recordLoss(r.cursor.ts, now(), `queue-reset:${r.queue.queueName}`);
                if (l) losses.push(l);
                overflowed.push({ queueName: r.queue.queueName, fromTs: r.cursor.ts });
            }
        }
        const overflow = overflowed.length ? await handleOverflow(api, overflowed) : null;

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
            // A planned idle window this run could not cover (a timeout, the page cap) is no longer planned.
            const idle = getPendingSyncGaps().filter((g) => g.reason === IDLE_GAP_REASON);
            if (idle.length) {
                runInTransaction(() => {
                    for (const g of idle) {
                        resolveSyncGap(g.id);
                        recordSyncGap(Number(g.fromTs), Number(g.toTs), IDLE_EVICTED_REASON);
                    }
                });
            }
            const pendingGaps = getPendingSyncGaps();
            let hint = "";
            if (pendingGaps.length) {
                // Oldest first, so its command reaches back far enough for all of them.
                const advice = describeGap({ ...pendingGaps[0], pendingGaps });
                hint = ` — ${pendingGaps.length} gap(s) stay pending; close them with: ${advice.command}`;
            }
            say(`${summary}; not finished: ${failed.join(", ")}, so no window is marked covered${hint}`);
        }

        const controls = await controlsDone;

        return {
            ran: true,
            reason,
            controls,
            recovered: added.length,
            untouched,
            removals,
            coverage,
            resolved: done.resolved,
            remainders: done.remainders,
            losses,
            overflow,
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

    /**
     * Zalo dropped (evict) or reset message queues. Groups: read back from the groups' cloud store, and the group loss
     * closed when every group was reached. 1-1: stays pending. Then one `queue_overflow` notice.
     *
     * @param {object} api
     * @param {Array<{queueName: string, fromTs: number}>} overflowed
     */
    async function handleOverflow(api, overflowed) {
        const fromTs = Math.min(...overflowed.map((o) => o.fromTs));
        const toTs = now();
        const queues = [...new Set(overflowed.map((o) => o.queueName))];
        const direct = queues.some((q) => !isGroupQueue(q));
        let groups = null;
        if (queues.some(isGroupQueue) && groupRepair !== false) {
            say(`the group queue overflowed: reading the groups' cloud store back to ${iso(fromTs)} (no phone)`);
            let repair;
            try {
                repair = await repairGroupsFromCloud({ api, fromTs, ...(groupRepair || {}) });
            } catch (e) {
                repair = { checked: 0, active: 0, added: [], complete: false, incomplete: [String(e?.message || e)] };
            }
            groups = { checked: repair.checked, active: repair.active, added: repair.added.length };
            groups.complete = repair.complete;
            if (repair.added.length) {
                try {
                    onRecovered(repair.added);
                } catch (e) {
                    say(`handing recovered messages on failed: ${e?.message || e}`);
                }
            }
            if (repair.complete) {
                // Every group was read back to the loss: the group queue's loss is covered.
                const closing = getPendingSyncGaps().filter(
                    (g) => /^queue-(evicted|reset):511/.test(String(g.reason)) && Number(g.fromTs) >= fromTs,
                );
                runInTransaction(() => {
                    for (const g of closing) resolveSyncGap(g.id);
                });
                say(
                    `groups repaired from the cloud store: ${repair.added.length} message(s) added from ` +
                        `${repair.active} active group(s) of ${repair.checked}; closed ${closing.length} group gap(s)`,
                );
            } else {
                say(
                    `groups partly repaired from the cloud store (${repair.added.length} message(s) added, ` +
                        `${repair.checked} group(s) read): ${repair.incomplete.join("; ")}; the group gap stays pending`,
                );
            }
        }
        const pending = getPendingSyncGaps().some((g) => Number(g.toTs) > fromTs && Number(g.fromTs) < toTs);
        const ownId = String(api?.getOwnId?.() ?? api?.getContext?.()?.uid ?? "") || null;
        const event = queueOverflowEvent({ accountId: ownId, fromTs, toTs, queues, direct, groups, pending });
        try {
            onNotice(event);
        } catch (e) {
            say(`the overflow notice failed: ${e?.message || e}`);
        }
        return event;
    }

    /**
     * After the message queues: the control queues, replayed from their saved cursors (./control-replay.js), one at a
     * time, in what is left of the same deadline. Each page reaches the same handlers as a live control push, which
     * move the cursors; a queue with no saved cursor is not asked. Never rejects.
     *
     * @param {object} listener
     * @param {number} budgetMs - what is left of the catch-up's deadline
     */
    async function replayControls(listener, budgetMs) {
        const queues = controlQueuesFrom(tap?.auth()?.ctrl_qCmds);
        let results;
        try {
            results = await replayControlQueues({
                listener,
                tap,
                queues,
                cursorOf: readCursor,
                timeoutMs: budgetMs,
                maxPages,
                log: say,
            });
        } catch (e) {
            say(`control replay failed: ${e?.message || e}`);
            return [];
        }
        for (const r of results) {
            const name = r.queue.queueName;
            if (r.reason === "no-cursor") {
                say(`${name}: no saved control cursor yet, nothing to replay (the next live control sets one)`);
                continue;
            }
            if (r.resetTo) writeCursor(name, { id: r.resetTo, ts: now() });
            say(
                `${name}: replayed ${r.replayed} control(s) after ${r.cursor.id}` +
                    (r.complete ? "" : `; not finished (${r.reason})`),
            );
            if (r.evicted) {
                say(
                    `${name}: Zalo dropped control events while this client was away; group, friend and read-state ` +
                        "changes among them may be missing, and a `sync` restores what the phone holds",
                );
            }
        }
        return results.map((r) => ({
            queueName: r.queue.queueName,
            replayed: r.replayed,
            complete: r.complete,
            reason: r.reason,
            evicted: r.evicted,
        }));
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
        const startedAt = now();
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
                // The catch-up is over, finished or not: what was confirmed meanwhile may be acknowledged now.
                verifier?.release();
                try {
                    onRun({ reason, ms: now() - startedAt, result: lastResult ?? null });
                } catch {
                    /* a hook failure is not the catch-up's */
                }
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

    /** A 534 frame: note its message ids before the listener announces them (the tap sees a frame first). */
    function noteRepushIds(frame) {
        const d = frame.data;
        if (!d) return;
        for (const key of ["msgs", "groupMsgs", "pageMsgs"]) {
            for (const row of Array.isArray(d[key]) ? d[key] : []) {
                if (!isId(row?.msgId)) continue;
                const id = String(row.msgId);
                repushed.delete(id);
                repushed.add(id);
                if (repushed.size > REPUSH_MAX) repushed.delete(repushed.values().next().value);
            }
        }
    }

    /**
     * True for the `message` event of a message the server re-sent (534) that zalo.db already holds: it was stored
     * and announced already (live, or by the re-push handling above), so the daemon must not announce it again. A
     * re-sent message that is not stored yet is false: the daemon announces and stores it as a live one. Each id
     * answers true once.
     */
    function isRepeatedRepush(msg) {
        const id = msg?.data?.msgId;
        if (!isId(id) || !repushed.has(String(id))) return false;
        repushed.delete(String(id));
        try {
            return !!getMessageById(String(id));
        } catch {
            return false;
        }
    }

    if (tap) tap.on(CMD_PUSH_MISS, noteRepushIds);
    if (enabled && tap) {
        tap.on(CMD_AUTHEN, () => {
            // A new connection: what was waiting to be acknowledged belonged to the old one. Nothing is acknowledged
            // until this connection's catch-up is over (`verify_on_done_offline`).
            verifier?.reset();
            verifier?.hold();
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
            return Promise.all([running ?? Promise.resolve(), overflowRun]).then(() => {});
        },
        noteDelivered,
        isRepeatedRepush,
        cursor: (queueName) => readCursor(queueName),
        /** The queue acknowledgements so far, or null when they are off. */
        queueAcks: () => verifier?.stats() ?? null,
        /** Send the pending acknowledgements now (a test and shutdown seam). */
        flushAcks: () => verifier?.flush() ?? 0,
    };
}
