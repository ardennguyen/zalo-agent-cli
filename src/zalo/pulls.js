/**
 * The requests the Web client sends when a socket connects and when it pulls a queue (plan items X5 and X6).
 *
 * Every pull has the same shape, `{first, reqId, lastId, preIds}`; zca-js's own `requestOldMessages` sent
 * `{first, lastId, preIds}` and let `sendWs` add `req_id`, a key the Web client never sends. Here:
 *
 *  - {@link installOfficialPulls} makes a listener send its two old-message pulls (510, 511) and its two
 *    old-reaction pulls (610, 611) the Web way;
 *  - the builders produce the connect-time requests the captured client sends and this client does not yet:
 *    the pulls of queues 515, 517, 518 and 603, the key-id request (564), the conversation-state request (577)
 *    and the paged action list (537).
 *
 * Of these builders, 603 is now sent: on every connect a daemon pulls its control queues from their saved cursors
 * and replays what they held (./../core/control-replay.js). The others are not sent, and the Web client's own code
 * says why that is right for a client without end-to-end encryption: 515 and 517 are the Signal queues (1-1 messages
 * encrypted for the Web device, and session-control items), unreadable without a Signal stack; 518 is deleted by an
 * acknowledgement (557), so asking for it without handling it only loses it; 564 is the Signal key id; 577 only
 * reconciles unread badges of a local store that counts unread messages (this client keeps a read watermark, which
 * the offline pages' `clearUnreads` already move); 537 lists media already downloaded on another device, a prefetch
 * hint. Answers seen live (2026-10-25): 515, 517 and 518 in the shape of the old-message queues (empty on the test
 * account), 564 `{err, keyId}`, 537 `{hasMore, actions[]}`, 603 pages of 50 controls.
 */
import { nextReqId } from "./req-id.js";

/** zca-js ThreadType.User; anything else is a group. */
const THREAD_USER = 0;

/** The queue pulls the captured client sends on connect, in its order, as `[cmd, subCmd]`. */
export const CONNECT_PULLS = Object.freeze([
    [510, 1],
    [511, 1],
    [610, 1],
    [611, 1],
    [603, 1],
    [515, 0],
    [517, 0],
    [518, 0],
]);

/**
 * One queue pull.
 *
 * @param {number} cmd
 * @param {number} subCmd
 * @param {object} [opts]
 * @param {string|null} [opts.lastId] - the queue's saved cursor
 * @param {boolean} [opts.first] - false for the next page of an answer that said `more`
 * @param {() => string} [opts.reqId] - a test seam
 * @returns {{version: number, cmd: number, subCmd: number, data: {first: boolean, reqId: string, lastId: string|null, preIds: never[]}}}
 */
export function buildPull(cmd, subCmd, { lastId = null, first = true, reqId = nextReqId } = {}) {
    return { version: 1, cmd, subCmd, data: { first, reqId: reqId(), lastId, preIds: [] } };
}

/** The key-id request (564): `{data: {platformType: 1}}`, 1 meaning the Web platform. */
export function buildKeyIdRequest() {
    return { version: 1, cmd: 564, subCmd: 0, data: { data: { platformType: 1 } } };
}

/**
 * The conversation-state request (577).
 *
 * @param {{oneone?: unknown[], group?: unknown[]}} [lists]
 */
export function buildConversationStateRequest({ oneone = [], group = [] } = {}) {
    return { version: 1, cmd: 577, subCmd: 0, data: { oneone, group } };
}

/**
 * One page request of the action list (537).
 *
 * @param {{lastId?: string|number, maxItem?: number}} [p]
 */
export function buildActionListRequest({ lastId = 0, maxItem = 50 } = {}) {
    return { version: 1, cmd: 537, subCmd: 0, data: { lastId, maxItem } };
}

/**
 * Page an action list the way the client does: ask again while the answer says `hasMore`, from the id of the last
 * action it returned.
 *
 * @param {(request: object) => Promise<{hasMore?: boolean, actions?: Array<{id?: string|number, actionId?: string|number}>}|null>} ask -
 *   sends one request and resolves the answer's `data`, or null when none came
 * @param {object} [opts]
 * @param {number} [opts.maxItem]
 * @param {number} [opts.maxPages] - a stop against a server that never says it is done
 * @returns {Promise<{actions: object[], pages: number, complete: boolean, reason: "drained"|"no-answer"|"stalled"|"page-cap"}>}
 */
export async function pageActionList(ask, { maxItem = 50, maxPages = 20 } = {}) {
    const out = { actions: [], pages: 0, complete: false, reason: "page-cap" };
    let lastId = 0;
    while (out.pages < maxPages) {
        const answer = await ask(buildActionListRequest({ lastId, maxItem }));
        if (!answer) return { ...out, reason: "no-answer" };
        out.pages++;
        const actions = Array.isArray(answer.actions) ? answer.actions : [];
        out.actions.push(...actions);
        if (!answer.hasMore) return { ...out, complete: true, reason: "drained" };
        // The web client reads the cursor from `id`; `actionId` is accepted too.
        const last = actions.at(-1);
        const next = last?.id ?? last?.actionId;
        // A cursor that does not move would ask for the same page forever.
        if (next === undefined || next === null || String(next) === String(lastId))
            return { ...out, reason: "stalled" };
        lastId = next;
    }
    return out;
}

/**
 * Make a listener send its old-message and old-reaction pulls the Web way: with `reqId`, not zca-js's `req_id`.
 * Safe to call twice.
 *
 * @param {object} listener - a zca-js Listener (needs `sendWs`)
 * @returns {object} the same listener
 */
export function installOfficialPulls(listener) {
    if (!listener || listener.__officialPulls) return listener;
    listener.__officialPulls = true;
    const pull = (users, groups) =>
        function pullQueue(threadType, lastMsgId = null) {
            const cmd = threadType === THREAD_USER ? users : groups;
            this.sendWs(buildPull(cmd, 1, { lastId: lastMsgId }), false);
        };
    listener.requestOldMessages = pull(510, 511);
    listener.requestOldReactions = pull(610, 611);
    return listener;
}
