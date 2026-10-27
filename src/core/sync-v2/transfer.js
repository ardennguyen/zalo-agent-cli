/**
 * The control side of a phone-backed transfer sync: what the phone's status
 * frames mean, and how one session reads the frames that arrive for it (plan
 * items Y1a-d, Y2a, Y2c, Y2d, X3).
 *
 * These are pure functions over a session record, so the rules can be tested
 * without a phone, a socket or the decryption assets `restore()` needs.
 *
 * **What a status means** (the phone's `transfer_status`, as the official
 * client reads it):
 *
 * | status | meaning | what to do |
 * |---|---|---|
 * | 3 | waiting for the person to tap | show the prompt, keep waiting |
 * | 4, 5 | confirmed (5: by the saved authorization, no tap) | go on |
 * | 6 | the person rejected it | fatal; release the session with reason 2 |
 * | 7 | the person cancelled | fatal; release with reason 0 |
 * | 8, 9, 10 | the phone is busy, low on storage, or signed out | fatal; reason 2 |
 * | 1, 2 | the phone is idle | fatal only if it stays so for ten minutes |
 *
 * Until now anything from 4 up counted as "confirmed", so a rejection (6) read
 * as an empty window that was settled: the run recorded success and closed the
 * coverage gap it was meant to repair. Only 4 and 5 are confirmation.
 *
 * Statuses 6 to 10 are fatal in the official worker's code; their numbers and
 * meanings come from reading it, and the one decline captured on the wire
 * (a request, two status frames, then an immediate release, and no downloads)
 * fits it.
 */
/** How long the phone may take to confirm. The official client waits ten minutes. */
export const CONFIRM_WAIT_MS = 600_000;

/** How long the phone may stay idle (status 1 or 2) while a sync runs. */
export const IDLE_TIMEOUT_MS = 600_000;

/** A run that has had this many failed batches is stopped. */
export const MAX_FAILED_BATCHES = 10;

/** A run in which more than this share of batches failed is stopped, once enough batches have been seen. */
export const MAX_FAILED_RATIO = 0.5;

/**
 * The phone's error code for "I no longer have this partition" (the conversation was deleted there). Read from the
 * Web sync worker's error table (`PartitionNotFound: 502`); seen on the wire 2026-10-28. Such a range is dropped, not retried.
 */
export const PARTITION_NOT_FOUND = 502;

/** Release reasons for a sync session (cmd 591): cancelled by the person, finished, failed, outdated. */
export const DISPOSE_REASON = Object.freeze({ CANCELLED: 0, SUCCESS: 1, ERROR: 2, OUTDATED: 3 });

const STATUS = new Map([
    [1, { kind: "idle" }],
    [2, { kind: "idle" }],
    [3, { kind: "waiting" }],
    [4, { kind: "confirmed" }],
    [5, { kind: "confirmed" }],
    [
        6,
        {
            kind: "rejected",
            reason: "phone-rejected",
            dispose: DISPOSE_REASON.ERROR,
            message: "you rejected the sync request on your phone",
        },
    ],
    [
        7,
        {
            kind: "cancelled",
            reason: "phone-cancelled",
            dispose: DISPOSE_REASON.CANCELLED,
            message: "the sync request was cancelled on your phone",
        },
    ],
    [
        8,
        {
            kind: "busy",
            reason: "phone-busy",
            dispose: DISPOSE_REASON.ERROR,
            message: "your phone is busy with another sync; try again in a few minutes",
        },
    ],
    [
        9,
        {
            kind: "low-storage",
            reason: "phone-low-storage",
            dispose: DISPOSE_REASON.ERROR,
            message: "your phone is low on storage and cannot prepare the sync",
        },
    ],
    [
        10,
        {
            kind: "logged-out",
            reason: "phone-logged-out",
            dispose: DISPOSE_REASON.ERROR,
            message: "your phone is signed out of Zalo",
        },
    ],
]);

/**
 * What a `transfer_status` value means.
 *
 * @param {number|string} status
 * @returns {{status: number, kind: string, confirmed: boolean, fatal: boolean, reason: string|null,
 *   disposeReason: number|null, message: string|null}}
 *   `kind` is "unknown" for a number not in the table, and an unknown status is neither confirmation nor failure
 */
export function classifyTransferStatus(status) {
    const n = Number(status);
    const known = STATUS.get(n);
    if (!known) {
        return {
            status: n,
            kind: "unknown",
            confirmed: false,
            fatal: false,
            reason: null,
            disposeReason: null,
            message: null,
        };
    }
    return {
        status: n,
        kind: known.kind,
        confirmed: known.kind === "confirmed",
        fatal: known.reason !== undefined,
        reason: known.reason ?? null,
        disposeReason: known.dispose ?? null,
        message: known.message ?? null,
    };
}

/**
 * Has the phone confirmed? Only statuses 4 and 5 say so.
 *
 * @param {Array<number|string>} statuses
 * @returns {boolean}
 */
export function isConfirmed(statuses) {
    return (statuses ?? []).some((s) => classifyTransferStatus(s).confirmed);
}

/**
 * The first status in a list that ends the sync, or null.
 *
 * @param {Array<number|string>} statuses
 * @returns {ReturnType<typeof classifyTransferStatus>|null}
 */
export function firstFatalStatus(statuses) {
    for (const s of statuses ?? []) {
        const c = classifyTransferStatus(s);
        if (c.fatal) return c;
    }
    return null;
}

/**
 * The error to raise when the phone ended the sync.
 *
 * @param {ReturnType<typeof classifyTransferStatus>} cls - a fatal classification
 * @returns {Error} with `.reason` (the result reason) and `.phone` (the status classification)
 */
export function declineError(cls) {
    const err = new Error(`${cls.message} — nothing was restored and nothing was recorded as synced`);
    err.reason = cls.reason;
    err.phone = cls;
    return err;
}

/**
 * A fresh record of one sync session (one cmd 590 request and what comes back for it).
 *
 * @param {object} [opts]
 * @param {string} [opts.kind] - "conv" or "msg"
 * @param {string[]} [opts.want] - the partitions the request asked for
 * @returns {object}
 */
export function createTransferSession({ kind = "msg", want = [] } = {}) {
    return {
        kind,
        batches: [],
        statuses: [],
        done: false,
        sawLast: false,
        err: null,
        disposed: false,
        want: new Set(want.filter(Boolean)),
        covered: new Set(),
        // Y2: what arrived, and what failed, per scope.
        idxSeen: new Set(),
        lastIdx: null,
        failures: [],
        failed: new Set(),
        duplicates: 0,
        // Y1: what the phone said about itself.
        fatal: null,
        idleSince: null,
        disposeReason: null,
    };
}

/** The partitions a control names, from `scopes` (objects with a `partition`) or a single `partition`. */
function partitionsOf(data) {
    const out = [];
    for (const sc of data?.scopes ?? []) if (sc?.partition) out.push(sc.partition);
    if (typeof data?.partition === "string" && data.partition) out.push(data.partition);
    return out;
}

/**
 * Apply one `transfer_sync2` control to its session.
 *
 * @param {object} session - from {@link createTransferSession}
 * @param {{act: string, data: object}} control - the control's `content`, with `data` already parsed
 * @param {{now?: number}} [opts]
 * @returns {{type: "status", cls: object}|{type: "batch", batch: object}|{type: "duplicate", idx: number}
 *   |{type: "failure", partitions: string[], code: number|null}|{type: "error"}|{type: "ignored", why: string}}
 */
export function applyControl(session, control, { now = Date.now() } = {}) {
    const act = control?.act;
    const dj = control?.data ?? {};

    if (act === "transfer_status") {
        // Only the phone's own statuses count: a status about another device is not this sync's.
        if (dj.fromDevice !== undefined && Number(dj.fromDevice) !== 0) return { type: "ignored", why: "other-device" };
        session.statuses.push(dj.status);
        const cls = classifyTransferStatus(dj.status);
        if (cls.fatal && !session.fatal) {
            session.fatal = cls;
            session.disposeReason = cls.disposeReason;
        }
        if (cls.kind === "idle") session.idleSince ??= now;
        else session.idleSince = null;
        return { type: "status", cls };
    }

    if (act === "upload_batch") {
        const code = Number(dj.err ?? 0);
        if (code !== 0) return recordFailure(session, dj, code);
        const idx = Number(dj.idx);
        if (Number.isFinite(idx)) {
            // A batch the phone sent twice is one batch.
            if (session.idxSeen.has(idx)) {
                session.duplicates += 1;
                return { type: "duplicate", idx };
            }
            session.idxSeen.add(idx);
        }
        session.batches.push(dj);
        for (const p of partitionsOf(dj)) session.covered.add(p);
        if (dj.isLast) {
            session.sawLast = true;
            if (Number.isFinite(idx)) session.lastIdx = idx;
        }
        session.done = isTransferSessionComplete(session);
        return { type: "batch", batch: dj };
    }

    if (typeof act === "string" && /error/i.test(act)) {
        const code = Number(dj.errorCode ?? dj.err ?? dj.error_code ?? NaN);
        return recordFailure(session, dj, Number.isFinite(code) ? code : null);
    }

    return { type: "ignored", why: "unhandled-act" };
}

/** A failure that names its scopes fails those scopes; one that does not fails the session. */
function recordFailure(session, data, code) {
    const partitions = partitionsOf(data);
    if (!partitions.length) {
        session.err = data;
        return { type: "error" };
    }
    for (const p of partitions) {
        session.failures.push({ partition: p, code, idx: Number(data.idx) });
        session.failed.add(p);
    }
    session.done = isTransferSessionComplete(session);
    return { type: "failure", partitions, code };
}

/**
 * Record that a batch could not be downloaded: the scopes it carried fail, as if the phone had reported the failure
 * itself (Y3). A batch that names no scope fails the session.
 *
 * @param {object} session
 * @param {{scopes?: Array<{partition?: string}>, partition?: string, idx?: number}} batch
 * @param {{kind?: string, message?: string}} error - a BatchDownloadError
 * @returns {string[]} the partitions that failed
 */
export function recordDownloadFailure(session, batch, error) {
    const partitions = partitionsOf(batch);
    if (!partitions.length) {
        session.err ??= { download: error?.kind ?? "error", message: error?.message ?? "" };
        return [];
    }
    for (const p of partitions) {
        session.failures.push({ partition: p, code: null, idx: Number(batch?.idx), download: error?.kind ?? "error" });
        session.failed.add(p);
    }
    return partitions;
}

/**
 * Is this session finished?
 *
 * A session with an `isLast` batch is finished once every index up to it has
 * arrived. Without one (the captured Zalo Web run ends its last message session
 * with `isLast` 0) it is finished when every partition it asked for has either
 * come back or failed. The conversation round asks for no partitions, so only
 * its last batch ends it.
 *
 * @param {object} session
 * @returns {boolean}
 */
export function isTransferSessionComplete(session) {
    if (!session) return false;
    if (session.sawLast) {
        const idxComplete =
            !(session.idxSeen instanceof Set) ||
            session.lastIdx === null ||
            session.idxSeen.size >= session.lastIdx + 1;
        if (idxComplete) return true;
    }
    const want = session.want?.size ?? 0;
    if (!want) return false;
    let accounted = 0;
    for (const p of session.want) if (session.covered?.has(p) || session.failed?.has(p)) accounted += 1;
    // A session counts extra coverage as it always did: more than asked for is not less than asked for.
    return accounted >= want || (session.covered?.size ?? 0) >= want;
}

/**
 * Should the run stop because too many batches have failed?
 *
 * The count limit is exact. The ratio limit applies only once a few batches
 * have been seen, so that one failure among the first one or two does not read
 * as "half of everything failed".
 *
 * @param {{failed: number, total: number}} stats
 * @returns {boolean}
 */
export function shouldAbortOnFailures({ failed, total }) {
    if (failed >= MAX_FAILED_BATCHES) return true;
    return total >= MAX_FAILED_BATCHES && failed / total > MAX_FAILED_RATIO;
}

/**
 * Has the phone been idle for too long?
 *
 * @param {object} session
 * @param {number} [now]
 * @returns {boolean}
 */
export function isIdleTooLong(session, now = Date.now()) {
    return session?.idleSince !== null && session?.idleSince !== undefined && now - session.idleSince > IDLE_TIMEOUT_MS;
}

/**
 * The `transfer_sync2` controls inside one inbound frame, if it is a `601`.
 *
 * @param {Buffer} buf - one binary message from the socket
 * @param {(parsed: object) => object} decode - decodes an encrypted frame body (`decodeFrame` with the cipher key)
 * @returns {Array<{act: string, data: object, syncId: string|undefined}>} empty for any other frame or one that cannot be read
 */
export function readTransferControls(buf, decode) {
    if (!(buf instanceof Buffer) || buf.length < 4 || buf.readUInt16LE(1) !== 601) return [];
    let parsed;
    try {
        parsed = JSON.parse(buf.subarray(4).toString("utf8"));
    } catch {
        return [];
    }
    let body;
    try {
        body = typeof parsed.data === "string" && typeof parsed.encrypt === "number" ? decode(parsed) : parsed;
    } catch {
        return [];
    }
    const out = [];
    for (const c of body?.data?.controls || []) {
        if (c?.content?.act_type !== "transfer_sync2") continue;
        let data = c.content.data;
        try {
            data = JSON.parse(data);
        } catch {
            /* already an object */
        }
        out.push({ act: c.content.act, data, syncId: data?.syncId });
    }
    return out;
}

/**
 * What the conversation round ended in. The conversation list only ever arrives on the socket that asked
 * for it and after the phone has answered, so every way it can end without a list needs its own words.
 *
 * @param {object} p
 * @param {"done"|"declined"|"idle-timeout"|"error"|"socket-closed"|"timeout"} p.why - how the wait ended
 * @param {object} p.session - the conversation session
 * @param {number} p.waitMs - the confirmation budget, for the wording
 * @param {boolean} [p.confirmed] - whether the phone confirmed on ANY attempt of this run; read from the session when omitted
 * @returns {{confirmed: boolean, error: Error|null}} `error` is what to throw, or null to go on
 */
export function judgeConversationRound({ why, session, waitMs, confirmed: seen }) {
    const confirmed = seen ?? isConfirmed(session.statuses);
    if (why === "declined") return { confirmed, error: declineError(session.fatal) };
    if (why === "idle-timeout") {
        return {
            confirmed,
            error: Object.assign(
                new Error(
                    "your phone went idle and stopped answering the sync — nothing was restored; try again with the phone awake",
                ),
                { reason: "phone-idle-timeout" },
            ),
        };
    }
    if (session.err) {
        return { confirmed, error: new Error(`conversation round failed: ${JSON.stringify(session.err)}`) };
    }
    if (why === "socket-closed") {
        return {
            confirmed,
            error: new Error(
                confirmed
                    ? "the connection dropped after your phone confirmed, before the conversation list arrived"
                    : "the connection dropped while waiting for your phone to confirm — re-run and you will be prompted again",
            ),
        };
    }
    if (why === "timeout" && !confirmed) {
        return {
            confirmed,
            error: new Error(
                `your phone did not answer the sync prompt within ${Math.round(waitMs / 1000)}s — the connection stayed up, so nothing was lost; re-run and confirm the prompt`,
            ),
        };
    }
    return { confirmed, error: null };
}
