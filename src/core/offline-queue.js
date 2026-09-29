/**
 * Zalo's offline message queues: ask what this session missed since a cursor.
 *
 * What Zalo Web does on every authenticated connect (bundle
 * 1.e0ef5e98f8f9d8970e2c.js, character offsets):
 *
 *   `_doAfterAuth` hands the handshake to each handler (@~2698600); the chat
 *   handler's `onAuthenticated` (@~11118700) takes the queue list from the
 *   handshake's `data.qCmds` and calls `signalGetOffline` (@~3209700), which
 *   sends `doGetOffline(cmd, subCmd, first=true)` for every queue (@~3210267):
 *
 *     {cmd, subCmd, data: {first, reqId, lastId, preIds}}
 *
 *   `lastId` is that queue's saved cursor (`queueIds.getLastActionIdsForSocket`
 *   @~1391535; "1" when it has none). `onGotOffline` (@~3210990) pages while
 *   the answer says `data.more`, asking again with `first:false` from the
 *   answer's `lastActionId`, and `checkQueueOverflow` reads
 *   `queueStatus[q].evict` -- the server's word that it dropped queued items.
 *
 * Captured on the wire (agent/work/transfer-sync-v2/zalo-cap-sync.decoded.jsonl):
 * the handshake lists `510_1` (1-1) and `511_1` (group) among its `qCmds`; the
 * web asks both within a millisecond of each other with `first:true`, a
 * msgId-shaped `lastId` and `preIds:[]`; each answer arrives in ~100 ms as
 * `{lastActionId, more, msgs|groupMsgs, queueStatus: {"511_1": {ids, lastId,
 * evict}}, reqId}`. Live pushes carry the same `queueStatus`, and for these
 * two queues its `lastId` is the pushed message's msgId
 * (live/socket.L1_group_echo.json, socket.L4_dm_echo.json).
 *
 * zca-js already sends this request shape (`listener.requestOldMessages`) but
 * only ever with `first:true`, and its `old_messages` event drops `more`,
 * `lastActionId` and `queueStatus` -- so a queue longer than one page could
 * never be finished. This module sends through `listener.sendWs` and reads
 * the answers off the raw socket (./socket-tap.js).
 */

/** zca-js ThreadType values. */
const THREAD_USER = 0;
const THREAD_GROUP = 1;

/**
 * The offline queues this module can drain, keyed by cmd: the two that carry
 * plaintext messages. The handshake also lists 515/517/518 -- the E2EE
 * session and ack queues in Zalo Web's SignalCommands (516 SESSION_OFFLINE,
 * 517 SESSION_OFFLINE_WEB, 518 OFFLINE_ACK_ONE_ONE) -- which we do not decode.
 */
const MESSAGE_QUEUES = new Map([
    [510, { threadType: THREAD_USER, rows: "msgs" }],
    [511, { threadType: THREAD_GROUP, rows: "groupMsgs" }],
]);

/** What the captured handshake lists for them, used until a handshake has been read. */
export const DEFAULT_MESSAGE_QUEUES = Object.freeze([
    Object.freeze({ cmd: 510, subCmd: 1, queueName: "510_1", threadType: THREAD_USER }),
    Object.freeze({ cmd: 511, subCmd: 1, queueName: "511_1", threadType: THREAD_GROUP }),
]);

/** Answer wait per page. The web's came back in ~100 ms. */
export const DEFAULT_PAGE_TIMEOUT_MS = 10_000;

/** Pages per queue: the runaway stop, as in the reaction drain. */
export const DEFAULT_MAX_PAGES = 20;

let reqSeq = 0;
/** Zalo Web's `reqId` shape, `req_<n>`; answers echo it. */
const nextReqId = () => `req_${1_000_000 + ++reqSeq}`;

/**
 * The message queues a handshake names, in its order.
 *
 * Follows `qCmds` rather than assuming 510/511, as the web does, and keeps only
 * the queues whose answers this module can store. With no handshake to go on,
 * the captured pair.
 *
 * @param {Array<{cmd: number, subCmd: number, queueName?: string}>} [qCmds]
 * @returns {Array<{cmd: number, subCmd: number, queueName: string, threadType: number}>}
 */
export function messageQueuesFrom(qCmds) {
    if (!Array.isArray(qCmds) || qCmds.length === 0) return [...DEFAULT_MESSAGE_QUEUES];
    const out = [];
    for (const q of qCmds) {
        const cmd = Number(q?.cmd);
        const kind = MESSAGE_QUEUES.get(cmd);
        if (!kind) continue;
        const subCmd = Number(q?.subCmd) || 0;
        out.push({ cmd, subCmd, queueName: String(q?.queueName || `${cmd}_${subCmd}`), threadType: kind.threadType });
    }
    return out;
}

/**
 * Ask once and wait for the answer to THIS request.
 *
 * @returns {Promise<object|null>} the decoded answer body, or null on timeout
 */
function request({ listener, tap, queue, data, timeoutMs }) {
    return new Promise((resolve) => {
        let off = () => {};
        const timer = setTimeout(() => {
            off();
            resolve(null);
        }, timeoutMs);
        off = tap.on(queue.cmd, (frame, from) => {
            if (from && from !== listener) return;
            if (frame.subCmd !== queue.subCmd) return;
            // Only the answer to THIS request. The server echoes reqId (every
            // captured 510/511 answer does), while another reader of the same
            // stream -- zalo_get_history, or `msg history`'s scan, which page it
            // through zca-js outside this request -- gets answers without ours.
            // Taking one of those would store the wrong page and claim coverage
            // from it; an answer we cannot match is a timeout instead.
            if (String(frame.data?.reqId ?? "") !== data.reqId) return;
            clearTimeout(timer);
            off();
            resolve(frame.body || {});
        });
        try {
            // requireId false: the web's request carries `reqId`, not zca-js's `req_id`.
            listener.sendWs({ version: 1, cmd: queue.cmd, subCmd: queue.subCmd, data }, false);
        } catch {
            clearTimeout(timer);
            off();
            resolve(null);
        }
    });
}

/**
 * Drain one offline queue from a cursor, as `doGetOffline` / `onGotOffline` do.
 *
 * @param {object} args
 * @param {object} args.listener - a zca-js Listener whose socket is open and authenticated
 * @param {ReturnType<import("./socket-tap.js").createSocketTap>} args.tap - attached to that listener
 * @param {{cmd: number, subCmd: number, queueName: string}} args.queue
 * @param {string} args.lastId - the cursor: the last queue id this session holds
 * @param {number} [args.timeoutMs]
 * @param {number} [args.maxPages]
 * @returns {Promise<{rows: object[], pages: number, complete: boolean,
 *   reason: "drained"|"timeout"|"stalled"|"page-cap"|"reset"|"error",
 *   evicted: boolean, resetTo: string|null, lastActionId: string|null}>}
 *   `rows` are the server's raw message rows, oldest page first. `complete`
 *   is true only when the server said there is nothing more; `evicted` is
 *   its word that it dropped queued items, `resetTo` a cursor it told us to
 *   start over from (`resetLastActionId`).
 */
export async function drainOfflineQueue({
    listener,
    tap,
    queue,
    lastId,
    timeoutMs = DEFAULT_PAGE_TIMEOUT_MS,
    maxPages = DEFAULT_MAX_PAGES,
}) {
    const kind = MESSAGE_QUEUES.get(Number(queue.cmd));
    const rowsKey = kind?.rows || "msgs";
    const out = {
        rows: [],
        pages: 0,
        complete: false,
        reason: "page-cap",
        evicted: false,
        resetTo: null,
        lastActionId: null,
    };
    let cursor = String(lastId);
    let first = true;

    while (out.pages < maxPages) {
        const data = { first, reqId: nextReqId(), lastId: cursor, preIds: [] };
        const body = await request({ listener, tap, queue, data, timeoutMs });
        if (!body) return { ...out, reason: "timeout" };
        out.pages++;
        if (Number(body.error_code) && Number(body.error_code) !== 0) return { ...out, reason: "error" };
        const d = body.data || {};

        // `processSuccessData` resets its cursors and processes nothing else
        // when the server sends this (@~11109800).
        const reset = d.resetLastActionId;
        if (reset !== undefined && reset !== null && reset !== "" && reset !== 0 && reset !== "0") {
            return { ...out, reason: "reset", resetTo: String(reset) };
        }

        if (Array.isArray(d[rowsKey])) out.rows.push(...d[rowsKey]);
        if (Number(d.queueStatus?.[queue.queueName]?.evict) === 1) out.evicted = true;
        if (d.lastActionId !== undefined && d.lastActionId !== null) out.lastActionId = String(d.lastActionId);

        if (!Number(d.more)) return { ...out, complete: true, reason: "drained" };
        const next = d.lastActionId;
        // A cursor that does not move would ask for the same page forever.
        if (next === undefined || next === null || String(next) === cursor) return { ...out, reason: "stalled" };
        cursor = String(next);
        first = false;
    }
    return out;
}
