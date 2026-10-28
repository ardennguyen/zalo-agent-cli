/**
 * The request side of a phone-backed transfer sync: sending the `590` request and the `591` release, reading
 * their acknowledgements, and keeping track of which sessions are open (plan items Y4a, Y6a, Y6b, Y7).
 *
 * What the official client does, and this module now does:
 *
 *  - **Every request is acknowledged**, with `{reqId, err, ts}` on the same command. The ack is awaited for 10 s;
 *    a refused request (`err` not 0) is sent again after 1 s and 2 s, up to three attempts. A timeout is not
 *    retried (the answer may simply be late and the phone may already be preparing), nor is error 211 ("this
 *    client is not supported"). A timeout on a socket that has since closed is reported as such.
 *  - **Counters.** `reqId` is `req_<n>` from one counter for every sync frame; `ussidx` counts the sessions of
 *    one run from 0.
 *  - **A release names its reason** (0 cancelled, 1 finished, 2 failed, 3 outdated) and is acknowledged too, 3 s
 *    and three attempts. A session released before its request was acknowledged is released the moment the ack
 *    lands, so the phone never keeps a banner for a session this client has walked away from.
 *  - **Open sessions are written down.** A session is recorded when its request goes out and forgotten when its
 *    release is acknowledged. A run that died leaves its sessions in the file, and the next run releases them
 *    with reason 3 before it starts anything.
 *
 * Nothing here knows about decryption or the database: it only moves frames. The socket is reached through
 * `getListener()` so a reconnect that replaces the listener is followed.
 */
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../../utils/atomic-file.js";
import { nextReqId as sharedNextReqId } from "../../zalo/req-id.js";
import { DISPOSE_REASON } from "./transfer.js";

/** How long a request waits for its ack. */
export const ACK_TIMEOUT_MS = 10_000;

/** How many times a refused request is sent. */
export const REQUEST_ATTEMPTS = 3;

/** The pauses before the second and third attempt. */
export const RETRY_DELAYS_MS = Object.freeze([1_000, 2_000]);

/** How long a release waits for its ack. */
export const DISPOSE_ACK_MS = 3_000;
/** Releases sent at once: one, each after the previous ack. Bursts were answered only in part (see sync-v2/index.js). */
const RELEASE_BURST = 1;

/** The server's "this client is not supported". Not retried. */
export const CLIENT_NOT_SUPPORTED = 211;

/** Why a request failed, for the caller to word. */
export const REQUEST_FAILURE = Object.freeze({
    TIMEOUT: "request-timeout",
    SOCKET_CLOSED: "request-socket-closed",
    REFUSED: "request-refused",
    NOT_SUPPORTED: "client-not-supported",
});

/** What a release reason is called in a log line. */
const REASON_WORDS = Object.freeze({
    [DISPOSE_REASON.CANCELLED]: "cancelled",
    [DISPOSE_REASON.SUCCESS]: "finished",
    [DISPOSE_REASON.ERROR]: "failed",
    [DISPOSE_REASON.OUTDATED]: "outdated",
});

/** The commands this module sends and hears the acks of. */
const SYNC_CMD = 590;
const DISPOSE_CMD = 591;

/**
 * An ack frame read out of an inbound socket message.
 *
 * @param {Buffer} buf - one binary message from the socket
 * @param {(parsed: object) => object} decode - decodes an encrypted frame body
 * @returns {{cmd: number, reqId: string, err: number, ts: number|null}|null} null for anything that is not a `590`
 *   or `591` answer carrying a `reqId`
 */
export function readAck(buf, decode) {
    if (!(buf instanceof Buffer) || buf.length < 4) return null;
    const cmd = buf.readUInt16LE(1);
    if (cmd !== SYNC_CMD && cmd !== DISPOSE_CMD) return null;
    let parsed;
    try {
        parsed = JSON.parse(buf.subarray(4).toString("utf8"));
    } catch {
        return null;
    }
    let body;
    try {
        body = typeof parsed.data === "string" && typeof parsed.encrypt === "number" ? decode(parsed) : parsed;
    } catch {
        return null;
    }
    const reqId = body?.data?.reqId;
    if (typeof reqId !== "string" || !reqId) return null;
    const topError = Number(body?.error_code ?? 0);
    const err = Number(body.data.err ?? 0) || (Number.isFinite(topError) ? topError : 0);
    return { cmd, reqId, err, ts: Number.isFinite(Number(body.data.ts)) ? Number(body.data.ts) : null };
}

/**
 * A small file of the sessions this client has open on the phone.
 *
 * @param {string} file
 * @returns {{load: () => Array<{syncId: string, toDevice: number}>, save: (sessions: Array<object>) => boolean}}
 */
export function createSessionStore(file) {
    return {
        load() {
            try {
                const list = JSON.parse(readFileSync(file, "utf8"));
                return (Array.isArray(list) ? list : []).filter((s) => typeof s?.syncId === "string" && s.syncId);
            } catch {
                return [];
            }
        },
        save(sessions) {
            try {
                writeFileAtomic(file, JSON.stringify(sessions), { mode: 0o600 });
                return true;
            } catch {
                return false;
            }
        },
    };
}

/** Raised for a request that did not go through. */
export class SyncRequestError extends Error {
    /**
     * @param {string} failure - one of {@link REQUEST_FAILURE}
     * @param {string} message
     * @param {number|null} [code] - the server's `err`, when it gave one
     */
    constructor(failure, message, code = null) {
        super(message);
        this.name = "SyncRequestError";
        this.failure = failure;
        this.code = code;
    }
}

/**
 * The channel for one run.
 *
 * @param {object} p
 * @param {() => object} p.getListener - the zca-js listener to send on; asked on every send
 * @param {(parsed: object) => object} p.decode - decodes an encrypted frame body
 * @param {{load: Function, save: Function}} [p.store] - where open sessions are written down
 * @param {(ms: number) => Promise<void>} [p.sleep]
 * @param {number} [p.ackTimeoutMs]
 * @param {number} [p.disposeAckMs]
 * @param {readonly number[]} [p.retryDelaysMs]
 * @param {(message: string) => void} [p.log]
 * @param {() => string} [p.nextReqId] - the request id source; the process-wide counter by default
 * @returns {{
 *   handleFrame: (buf: Buffer) => boolean,
 *   nextUssidx: () => number,
 *   request: (r: {kind: string, syncId: string, ek: string, ik: string, req: object, deviceName: string}) => Promise<{attempts: number, ts: number|null}>,
 *   release: (syncId: string, reason?: number) => Promise<{acked: boolean, late?: boolean}>,
 *   releaseAll: (reasonOf?: (syncId: string) => number|undefined) => Promise<number>,
 *   cleanLeftovers: () => Promise<number>,
 *   open: () => string[],
 * }}
 */
export function createSyncChannel({
    getListener,
    decode,
    store = null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    ackTimeoutMs = ACK_TIMEOUT_MS,
    disposeAckMs = DISPOSE_ACK_MS,
    retryDelaysMs = RETRY_DELAYS_MS,
    log = () => {},
    nextReqId = sharedNextReqId,
}) {
    let ussidx = 0;
    /** reqId -> resolver of the ack */
    const waiting = new Map();
    /** syncId -> {state: "requested"|"started", late: number|null} */
    const sessions = new Map();
    /** syncIds whose request has gone out and whose ack is still awaited */
    const inFlight = new Set();

    const persist = () => {
        if (!store) return;
        store.save([...sessions.keys()].map((syncId) => ({ syncId, toDevice: 0 })));
    };

    const socketOpen = () => {
        const ws = getListener()?.ws;
        return Boolean(ws) && ws.readyState === 1;
    };

    /** Wait for the ack of `reqId`: resolves `{ack}` or `{timeout: true, closed}`. */
    function waitAck(reqId, ms) {
        return new Promise((resolve) => {
            const watch = setInterval(() => {
                if (!socketOpen()) finish({ timeout: true, closed: true });
            }, 100);
            const timer = setTimeout(() => finish({ timeout: true, closed: !socketOpen() }), ms);
            const finish = (result) => {
                clearInterval(watch);
                clearTimeout(timer);
                waiting.delete(reqId);
                resolve(result);
            };
            waiting.set(reqId, (ack) => finish({ ack }));
        });
    }

    function send(frame) {
        getListener().sendWs(frame, false);
    }

    /** One send and its ack, retried per the official rules. */
    async function exchange({ build, ackMs, label }) {
        let last = null;
        for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
            const reqId = nextReqId();
            const pending = waitAck(reqId, ackMs);
            try {
                send(build(reqId));
            } catch (e) {
                waiting.delete(reqId);
                throw new SyncRequestError(REQUEST_FAILURE.SOCKET_CLOSED, `${label}: could not send (${e.message})`);
            }
            const result = await pending;
            if (result.timeout) {
                throw result.closed
                    ? new SyncRequestError(
                          REQUEST_FAILURE.SOCKET_CLOSED,
                          `${label}: the socket closed before Zalo answered`,
                      )
                    : new SyncRequestError(
                          REQUEST_FAILURE.TIMEOUT,
                          `${label}: no answer within ${Math.round(ackMs / 1000)} s`,
                      );
            }
            const { err, ts } = result.ack;
            if (err === 0) return { attempts: attempt, ts };
            if (err === CLIENT_NOT_SUPPORTED) {
                throw new SyncRequestError(
                    REQUEST_FAILURE.NOT_SUPPORTED,
                    `${label}: Zalo says this client is not supported (error ${err})`,
                    err,
                );
            }
            last = err;
            log(`${label}: refused with error ${err}, attempt ${attempt} of ${REQUEST_ATTEMPTS}`);
            if (attempt < REQUEST_ATTEMPTS) await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 1000);
        }
        throw new SyncRequestError(
            REQUEST_FAILURE.REFUSED,
            `${label}: refused ${REQUEST_ATTEMPTS} times (error ${last})`,
            last,
        );
    }

    const channel = {
        /**
         * Hand an inbound socket message to the channel. Returns true when it was an ack for a request or a release
         * that is waiting for one.
         */
        handleFrame(buf) {
            const ack = readAck(buf, decode);
            if (!ack) return false;
            const resolve = waiting.get(ack.reqId);
            if (!resolve) return false;
            resolve(ack);
            return true;
        },

        /** The `ussidx` for the next session of this run: 0, 1, 2, ... */
        nextUssidx: () => ussidx++,

        /**
         * Send one `590` and wait for it to be acknowledged.
         *
         * @returns {Promise<{attempts: number, ts: number|null}>}
         * @throws {SyncRequestError}
         */
        async request({ kind, syncId, ek, ik, req, deviceName, tempKey = "" }) {
            const idx = ussidx++;
            sessions.set(syncId, { state: "requested", late: null });
            inFlight.add(syncId);
            persist();
            try {
                const out = await exchange({
                    label: `sync request (${kind})`,
                    ackMs: ackTimeoutMs,
                    build: (reqId) => ({
                        version: 1,
                        cmd: SYNC_CMD,
                        subCmd: 0,
                        data: {
                            data: {
                                syncId,
                                syncType: 0,
                                ek,
                                ik,
                                toDevice: 0,
                                tempKey,
                                deviceName,
                                req,
                                ver: 1,
                                ussidx: idx,
                            },
                            reqId,
                        },
                    }),
                });
                inFlight.delete(syncId);
                const s = sessions.get(syncId);
                if (s) {
                    s.state = "started";
                    // Released while its request was still unanswered: release it now.
                    if (s.late !== null) {
                        const reason = s.late;
                        s.late = null;
                        await channel.release(syncId, reason);
                    }
                }
                return out;
            } finally {
                // A failed request leaves its session written down: it may or may not exist on the phone, and
                // the release at the end of the run (or the next run's cleanup) clears it.
                inFlight.delete(syncId);
            }
        },

        /**
         * Release one session with a reason and wait for the ack.
         *
         * @param {string} syncId
         * @param {number} [reason] - see DISPOSE_REASON (default: finished)
         * @returns {Promise<{acked: boolean, late?: boolean}>} `late`: the request was not answered yet, so the
         *   release will go out the moment it is
         */
        async release(syncId, reason = DISPOSE_REASON.SUCCESS) {
            const s = sessions.get(syncId);
            if (!s) return { acked: false };
            if (s.state === "requested" && inFlight.has(syncId)) {
                s.late = reason;
                return { acked: false, late: true };
            }
            // A release already on its way (a session let go of as soon as it finished) is the release: the end
            // of the run must not send a second one for the same session.
            if (s.releasing) return s.releasing;
            const going = channel.releaseNow(syncId, reason);
            s.releasing = going;
            const result = await going;
            // One that was not acknowledged may be tried again (by the end of the run).
            if (!result.acked) s.releasing = null;
            return result;
        },

        /** Send the release and wait for its ack. Use {@link release}, which does not send one twice. */
        async releaseNow(syncId, reason) {
            try {
                await exchange({
                    label: `sync release (reason ${reason})`,
                    ackMs: disposeAckMs,
                    build: (reqId) => ({
                        version: 1,
                        cmd: DISPOSE_CMD,
                        subCmd: 0,
                        data: { data: { syncId, toDevice: 0, reason }, reqId },
                    }),
                });
            } catch (e) {
                log(`could not release ${syncId.slice(0, 6)}: ${e.message}`);
                return { acked: false };
            }
            sessions.delete(syncId);
            persist();
            // One line per decision (Y13): which session, and why it was released.
            log(`released sync session ${syncId.slice(0, 6)} (${REASON_WORDS[reason] ?? `reason ${reason}`})`);
            return { acked: true };
        },

        /**
         * Release every open session.
         *
         * @param {(syncId: string) => number|undefined} [reasonOf] - a session's own reason (the phone's "no" has one)
         * @returns {Promise<number>} how many releases were acknowledged
         */
        async releaseAll(reasonOf = () => undefined) {
            let acked = 0;
            for (const syncId of [...sessions.keys()]) {
                const r = await channel.release(syncId, reasonOf(syncId));
                if (r.acked) acked++;
            }
            return acked;
        },

        /**
         * Release, with reason 3 (outdated), the sessions an earlier run left open.
         *
         * @returns {Promise<number>} how many were left over
         */
        async cleanLeftovers() {
            const left = store ? store.load() : [];
            let n = 0;
            for (const { syncId } of left) {
                if (sessions.has(syncId)) continue;
                sessions.set(syncId, { state: "started", late: null });
                n++;
                await channel.release(syncId, DISPOSE_REASON.OUTDATED);
                // Whatever could not be released is not retried forever: a session that old is gone on the
                // phone's side anyway, and keeping it would repeat this at every start.
                sessions.delete(syncId);
            }
            if (store && left.length) persist();
            return n;
        },

        /**
         * Release, with reason 3 (outdated), every session this channel still holds: those of a socket that
         * died. Web does this first on every socket it opens (`cleanOldSyncSession`, sent back to back and
         * before any 590). The sessions are not kept afterwards, acknowledged or not: they belong to a socket
         * that is gone.
         *
         * @returns {Promise<number>} how many were released
         */
        async releaseAbandoned() {
            const old = [...sessions.keys()];
            for (const syncId of old) {
                inFlight.delete(syncId);
                const s = sessions.get(syncId);
                if (s) {
                    s.late = null;
                    s.releasing = null;
                }
            }
            // Each after the previous one's ack: bursts were answered only in part (see RELEASE_BURST).
            for (let i = 0; i < old.length; i += RELEASE_BURST) {
                await Promise.allSettled(
                    old
                        .slice(i, i + RELEASE_BURST)
                        .map((syncId) => channel.releaseNow(syncId, DISPOSE_REASON.OUTDATED)),
                );
            }
            for (const syncId of old) sessions.delete(syncId);
            if (old.length) persist();
            return old.length;
        },

        /**
         * Count sessions again from `start`: a new socket starts a new sync, as it does in Web, where the
         * conversation round is 0 and the message sessions follow from 1.
         */
        resetUssidx(start = 0) {
            ussidx = start;
        },

        /** The syncIds currently written down as open. */
        open: () => [...sessions.keys()],
    };

    return channel;
}
