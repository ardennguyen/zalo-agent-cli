/**
 * Telling Zalo which queue items this client has safely stored (plan item Y10, decision D7).
 *
 * Zalo keeps a message queue per conversation kind (`510_1` for 1-1 chats, `511_1` for groups). Every push and every
 * offline page names the queue items it carries in `queueStatus[queue].ids`. The Web client collects those ids and
 * sends them back in a `532` frame, once `max_msg_verify + 2` are pending or `interval_verify` has passed; the
 * server answers `{reqId, error}`: 0 done, 1 some of them were never delivered (they follow as `534` pushes), -1
 * stop verifying. Without these acks the server never learns what a client received, so its repair path never
 * runs, and a client that stored a message and crashed before the ack simply gets it again.
 *
 * The rule that makes this safe is the order: **an id is acknowledged only after the row it names has been
 * committed to zalo.db.** An ack for something that was not stored reports "nothing missing", and the loss is
 * never repaired. So callers hand ids to {@link confirm} only after the write; this module never decides that.
 *
 * What is not known: the exact element shape of `ids` and of the ack (`[{actionId}]` is what the Web bundle
 * builds), and the server's own `max_msg_verify` and `interval_verify` for this identity. Both settings are read
 * from `settings.features.socket` when present, and a captured session shows the first ack 30 s after a message.
 * The first live message to a test account is what confirms the rest.
 */
import { nextReqId as sharedNextReqId } from "../zalo/req-id.js";

/** The command of the ack, in both directions. */
export const CMD_VERIFY = 532;

/** Used when the server's settings do not say. */
export const VERIFY_DEFAULTS = Object.freeze({
    /** Pending ids that trigger an ack at once are this plus two. */
    maxMsgVerify: 10,
    /** An ack goes out this long after the first pending id. */
    intervalMs: 30_000,
    /** How long an ack waits for its answer. */
    replyTimeoutMs: 10_000,
    /** How many times an unanswered ack is sent again. */
    retries: 2,
    /** Ids per frame. */
    perFrame: 50,
    /** Ids held at most; the oldest are dropped past it (the server redelivers what it never saw acked). */
    maxPending: 5_000,
});

/**
 * The ids a `queueStatus` entry names, as strings.
 *
 * @param {object} queueStatus - `data.queueStatus` of a frame
 * @param {string} queueName
 * @returns {string[]}
 */
export function idsOf(queueStatus, queueName) {
    const ids = queueStatus?.[queueName]?.ids;
    if (!Array.isArray(ids)) return [];
    return ids
        .map((e) => (e && typeof e === "object" ? (e.actionId ?? e.id) : e))
        .filter((v) => v !== undefined && v !== null && String(v) !== "")
        .map(String);
}

/**
 * The verifier of one connection.
 *
 * @param {object} p
 * @param {() => object|null} p.getListener - the zca-js listener to send on
 * @param {() => {max_msg_verify?: number, interval_verify?: number}} [p.settings] - the server's socket settings
 * @param {{setTimeout: Function, clearTimeout: Function}} [p.timers]
 * @param {(line: string) => void} [p.log]
 * @param {() => string} [p.nextReqId]
 * @returns {{
 *   confirm: (queueName: string, ids: Array<string|number>) => void,
 *   handleReply: (frame: {data?: object}) => boolean,
 *   flush: () => number,
 *   reset: () => void,
 *   stop: () => void,
 *   stats: () => {pending: number, inFlight: number, sent: number, acked: number, missed: number, stopped: boolean},
 * }}
 */
export function createQueueVerifier({
    getListener,
    settings = () => ({}),
    timers = { setTimeout, clearTimeout },
    log = () => {},
    nextReqId = sharedNextReqId,
}) {
    /** queueName -> ids waiting to be acknowledged, in the order they were confirmed */
    const pending = new Map();
    /** reqId -> {queueName, ids, nretry, timer} */
    const inFlight = new Map();
    let flushTimer = null;
    let stopped = false; // the server said -1: stop verifying until the next connection
    const counts = { sent: 0, acked: 0, missed: 0 };

    const cfg = () => {
        const s = settings() ?? {};
        const max = Number(s.max_msg_verify);
        const every = Number(s.interval_verify);
        return {
            threshold: (Number.isFinite(max) && max > 0 ? max : VERIFY_DEFAULTS.maxMsgVerify) + 2,
            intervalMs: Number.isFinite(every) && every > 0 ? every : VERIFY_DEFAULTS.intervalMs,
        };
    };

    const total = () => [...pending.values()].reduce((n, set) => n + set.size, 0);

    const disarm = () => {
        if (flushTimer !== null) timers.clearTimeout(flushTimer);
        flushTimer = null;
    };

    const arm = () => {
        if (flushTimer !== null || stopped) return;
        flushTimer = timers.setTimeout(() => {
            flushTimer = null;
            verifier.flush();
        }, cfg().intervalMs);
        flushTimer?.unref?.();
    };

    const socketOpen = () => {
        const ws = getListener()?.ws;
        return Boolean(ws) && ws.readyState === 1;
    };

    function transmit(entry) {
        const frame = {
            version: 1,
            cmd: CMD_VERIFY,
            subCmd: 0,
            data: {
                queueName: entry.queueName,
                ids: entry.ids.map((actionId) => ({ actionId })),
                nretry: entry.nretry,
                reqId: entry.reqId,
            },
        };
        getListener().sendWs(frame, false);
        counts.sent++;
        entry.timer = timers.setTimeout(() => onSilence(entry), VERIFY_DEFAULTS.replyTimeoutMs);
        entry.timer?.unref?.();
    }

    function onSilence(entry) {
        inFlight.delete(entry.reqId);
        if (stopped) return;
        if (entry.nretry >= VERIFY_DEFAULTS.retries) {
            log(
                `queue ack for ${entry.queueName} (${entry.ids.length} id(s)) got no answer after ${entry.nretry + 1} tries; dropped`,
            );
            return;
        }
        const again = { ...entry, nretry: entry.nretry + 1, reqId: nextReqId(), timer: null };
        inFlight.set(again.reqId, again);
        try {
            transmit(again);
        } catch {
            inFlight.delete(again.reqId);
        }
    }

    const verifier = {
        /**
         * These ids are in zalo.db: they may be acknowledged. Call this only after the commit.
         *
         * @param {string} queueName
         * @param {Array<string|number>} ids
         */
        confirm(queueName, ids) {
            if (stopped || !queueName) return;
            const clean = (ids ?? []).map(String).filter(Boolean);
            if (!clean.length) return;
            const set = pending.get(queueName) ?? new Set();
            for (const id of clean) set.add(id);
            // The oldest go first when the cap is hit: the server redelivers what it never saw acknowledged.
            while (set.size > VERIFY_DEFAULTS.maxPending) set.delete(set.values().next().value);
            pending.set(queueName, set);
            if (total() >= cfg().threshold) verifier.flush();
            else arm();
        },

        /**
         * Send everything pending now.
         *
         * @returns {number} how many frames went out
         */
        flush() {
            disarm();
            if (stopped || !socketOpen()) {
                // Nothing can be sent on a closed socket; the ids stay for the next try, which the interval re-arms.
                if (total() && !stopped) arm();
                return 0;
            }
            let frames = 0;
            for (const [queueName, set] of pending) {
                const all = [...set];
                for (let i = 0; i < all.length; i += VERIFY_DEFAULTS.perFrame) {
                    const entry = {
                        queueName,
                        ids: all.slice(i, i + VERIFY_DEFAULTS.perFrame),
                        nretry: 0,
                        reqId: nextReqId(),
                        timer: null,
                    };
                    inFlight.set(entry.reqId, entry);
                    try {
                        transmit(entry);
                        frames++;
                    } catch {
                        inFlight.delete(entry.reqId);
                        return frames;
                    }
                }
                set.clear();
            }
            pending.clear();
            return frames;
        },

        /**
         * The server's answer to an ack.
         *
         * @param {{data?: {reqId?: string, error?: number}}} frame
         * @returns {boolean} true when it answered one of ours
         */
        handleReply(frame) {
            const d = frame?.data;
            const entry = d ? inFlight.get(String(d.reqId ?? "")) : null;
            if (!entry) return false;
            inFlight.delete(entry.reqId);
            if (entry.timer) timers.clearTimeout(entry.timer);
            const error = Number(d.error ?? 0);
            if (error === 0) {
                counts.acked += entry.ids.length;
            } else if (error === 1) {
                // Some of them were never delivered here: the server re-sends them as 534 pushes.
                counts.acked += entry.ids.length;
                counts.missed++;
                log(`Zalo says some items of ${entry.queueName} never reached this client; they will follow`);
            } else if (error === -1) {
                stopped = true;
                disarm();
                pending.clear();
                log("Zalo asked this client to stop verifying queue items; it will not again on this connection");
            } else {
                log(`queue ack for ${entry.queueName} answered with an unknown code ${error}`);
            }
            return true;
        },

        /** A new connection: whatever was pending belonged to the old one, and a "stop" was about it. */
        reset() {
            disarm();
            for (const e of inFlight.values()) if (e.timer) timers.clearTimeout(e.timer);
            inFlight.clear();
            pending.clear();
            stopped = false;
        },

        /** End for good. */
        stop() {
            verifier.reset();
            stopped = true;
        },

        stats: () => ({
            pending: total(),
            inFlight: inFlight.size,
            sent: counts.sent,
            acked: counts.acked,
            missed: counts.missed,
            stopped,
        }),
    };

    return verifier;
}
