/**
 * Scripted server behavior for the fake Zalo socket: the connect-time queue
 * pulls and the phone-backed transfer sync (cmd 590 / 591 / 601).
 *
 * The shapes follow what the official Web client's socket carries: the pulls
 * answer with `queueStatus` entries `{ids, lastId, evict}`; a sync request
 * (590) is acknowledged with `{reqId, err, ts}`, then the progress comes as
 * `601` control frames (`act_type: "transfer_sync2"`, `act` `transfer_status`
 * with status 3 waiting, 4 confirmed on the phone, 5 finished, or
 * `upload_batch`), and a dispose (591) is acknowledged the same way as 590.
 * Statuses above 5 are fatal in the official worker (6 = rejected); that value
 * comes from reading its code, not from the wire.
 *
 * The downloads themselves are not played: an `upload_batch` frame carries a
 * placeholder URL on a reserved `.invalid` host.
 */
import { ok } from "./frames.js";

/** The queue keys every 601 reply carries. */
const CONTROL_QUEUES = ["603_1", "603_0", "604_0"];

/**
 * A queueStatus object: one empty queue per key.
 *
 * @param {string[]} keys - e.g. ["603_1", "604_0"]
 * @param {object} [over] - per-key overrides, e.g. `{"603_1": {ids: ["1"], lastId: "1"}}`
 * @param {boolean} [withEvict] - add the `evict` flag. The connect-time pulls carry it; the
 *   control queues of a 601 reply carry only `ids` and `lastId`.
 * @returns {object}
 */
export function queueStatus(keys, over = {}, withEvict = false) {
    return Object.fromEntries(
        keys.map((k) => [k, { ids: [], lastId: "0", ...(withEvict ? { evict: false } : {}), ...(over[k] ?? {}) }]),
    );
}

/**
 * The body of one `601` reply.
 *
 * @param {object[]} controls - entries of {@link transferStatus} / {@link uploadBatch}
 * @returns {object} an envelope for `sock.push(601, 0, body)`
 */
export function controlBody(controls) {
    return ok({
        lastActionId: "0",
        more: 0,
        controls,
        reacts: [],
        reactGroups: [],
        queueStatus: queueStatus(CONTROL_QUEUES),
    });
}

let nextAction = 1;
const actionIds = () => {
    const id = String(nextAction++);
    return { actionId: id, controlId: id };
};

/**
 * A `transfer_status` control.
 *
 * @param {string} syncId
 * @param {number} status - 3 waiting, 4 confirmed, 5 finished, 6 rejected
 * @returns {object}
 */
export function transferStatus(syncId, status) {
    return {
        ...actionIds(),
        content: { act: "transfer_status", data: { syncId, fromDevice: 0, status }, act_type: "transfer_sync2" },
    };
}

/**
 * An `upload_batch` control: one slice of a sync request's data.
 *
 * @param {object} p
 * @param {string} p.syncId
 * @param {string} p.reqId - the request being served
 * @param {number} p.idx - this batch's index, from 0
 * @param {boolean} p.isLast
 * @param {string} [p.batchType]
 * @returns {object}
 */
export function uploadBatch({ syncId, reqId, idx, isLast, batchType = "message" }) {
    return {
        ...actionIds(),
        content: {
            act: "upload_batch",
            data: {
                err: 0,
                reqId,
                ts: Date.now(),
                fromDevice: 0,
                msgUrl: `https://transfersync.zalo.invalid/${syncId}/${idx}`,
                syncId,
                ik: "fake-ik",
                batchType,
                idx,
                isLast,
                scopes: [],
            },
            act_type: "transfer_sync2",
        },
    };
}

/** What each connect-time pull answers with, besides `queueStatus`. */
const PULL_BODIES = {
    "510/1": { msgs: [], more: 0 },
    "511/1": { groupMsgs: [], more: 0 },
    "515/0": {},
    "517/0": {},
    "518/0": {},
    "603/1": { controls: [], more: 0 },
    "610/1": { reacts: [], more: 0 },
    "611/1": { reactGroups: [], more: 0 },
};

/**
 * Answer the connect-time pulls the official client sends (510, 511, 515,
 * 517, 518, 603, 610, 611) plus 537, 564 and 577, with the verified reply
 * shapes and empty queues.
 *
 * @param {object} sock - from startFakeSocket
 * @param {object} [content] - per-pull extra reply fields, keyed `"<cmd>/<sub>"`
 */
export function installQueuePulls(sock, content = {}) {
    for (const [key, body] of Object.entries(PULL_BODIES)) {
        const [cmd, sub] = key.split("/").map(Number);
        sock.respond(cmd, sub, () =>
            ok({ ...body, ...(content[key] ?? {}), queueStatus: queueStatus([`${cmd}_${sub}`], {}, true) }),
        );
    }
    sock.respond(537, 0, () => ok({ hasMore: false, actions: [], ...(content["537/0"] ?? {}) }));
    sock.respond(564, 0, () => ok({ keyId: "fake-key-id", ...(content["564/0"] ?? {}) }));
    sock.respond(577, 0, () => ok({ ...(content["577/0"] ?? {}) }));
}

/**
 * Play the phone side of a transfer sync.
 *
 * @param {object} sock - from startFakeSocket
 * @param {object} [opts]
 * @param {"complete"|"declined"|"waiting"} [opts.outcome] - `complete`: statuses 3 then 4, a few
 *   batches per request, then status 5; `declined`: statuses 3 then 6 and nothing else (the phone
 *   said no); `waiting`: status 3 only (the phone never answers)
 * @param {number} [opts.batchesPerRequest] - upload batches per 590 on `complete` (default 2)
 * @param {number} [opts.expectedRequests] - how many 590s make a whole run before status 5 (default 5)
 * @param {number} [opts.ackError] - the `err` in every 590/591 ack (default 0)
 * @returns {{requests: object[], disposals: object[], finish: () => void}}
 *   `finish()` sends status 5 now (for a run with fewer requests than expected)
 */
export function installTransferSync(
    sock,
    { outcome = "complete", batchesPerRequest = 2, expectedRequests = 5, ackError = 0 } = {},
) {
    const requests = [];
    const disposals = [];
    let started = false;
    let lastSyncId = "none";

    const push601 = (controls) => sock.push(601, 0, controlBody(controls));

    sock.respond(590, 0, (frame) => {
        const inner = frame.data?.data ?? {};
        const reqId = frame.data?.reqId;
        requests.push({
            syncId: inner.syncId,
            reqId,
            type: inner.req?.type,
            priority: inner.req?.priority,
            raw: inner,
        });
        const position = requests.length; // the microtask below runs after every 590 sent in the same tick
        lastSyncId = inner.syncId;
        const ack = ok({ reqId, err: ackError, ts: Date.now() });
        queueMicrotask(() => {
            if (ackError !== 0) return;
            if (!started) {
                started = true;
                if (outcome === "complete") {
                    push601([transferStatus(inner.syncId, 3)]);
                    push601([transferStatus(inner.syncId, 4)]);
                } else if (outcome === "declined") {
                    push601([transferStatus(inner.syncId, 3)]);
                    push601([transferStatus(inner.syncId, 6)]);
                    return;
                } else {
                    push601([transferStatus(inner.syncId, 3)]);
                    return;
                }
            }
            if (outcome !== "complete") return;
            for (let idx = 0; idx < batchesPerRequest; idx++) {
                push601([
                    uploadBatch({
                        syncId: inner.syncId,
                        reqId,
                        idx,
                        isLast: idx === batchesPerRequest - 1,
                        batchType: inner.req?.type === "conversation" ? "conversation" : "message",
                    }),
                ]);
            }
            if (position === expectedRequests) push601([transferStatus(inner.syncId, 5)]);
        });
        return ack;
    });

    sock.respond(591, 0, (frame) => {
        const inner = frame.data?.data ?? {};
        disposals.push({ syncId: inner.syncId, reason: inner.reason, reqId: frame.data?.reqId });
        return ok({ reqId: frame.data?.reqId, err: ackError, ts: Date.now() });
    });

    return {
        requests,
        disposals,
        finish: () => push601([transferStatus(lastSyncId, 5)]),
    };
}
