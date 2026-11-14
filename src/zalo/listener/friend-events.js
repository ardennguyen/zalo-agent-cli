/**
 * Friend controls (cmd 601/603 `controls[]` with `content.act_type === "fr"`) -> the `friend_event` object.
 *
 * `{type, data, threadId, isSelf}` with `type` a number. The numbers are the ones the engine has always read
 * (`listen` labels 0-7), so they stay as they are in 3.0.0.
 *
 * Pure functions. Ids are compared as strings, so an id the parser left as a number still matches.
 */

/** The `type` numbers. */
export const FRIEND_EVENT_TYPE = Object.freeze({
    ADD: 0,
    REMOVE: 1,
    REQUEST: 2,
    UNDO_REQUEST: 3,
    REJECT_REQUEST: 4,
    SEEN_FRIEND_REQUEST: 5,
    BLOCK: 6,
    UNBLOCK: 7,
    BLOCK_CALL: 8,
    UNBLOCK_CALL: 9,
    PIN_UNPIN: 10,
    PIN_CREATE: 11,
    UNKNOWN: 12,
});

const T = FRIEND_EVENT_TYPE;

/** Server act -> type. */
const BY_ACT = new Map([
    ["add", T.ADD],
    ["remove", T.REMOVE],
    ["block", T.BLOCK],
    ["unblock", T.UNBLOCK],
    ["block_call", T.BLOCK_CALL],
    ["unblock_call", T.UNBLOCK_CALL],
    ["req_v2", T.REQUEST],
    ["reject", T.REJECT_REQUEST],
    ["undo_req", T.UNDO_REQUEST],
    ["seen_fr_req", T.SEEN_FRIEND_REQUEST],
    ["pin_unpin", T.PIN_UNPIN],
    ["pin_create", T.PIN_CREATE],
]);

/**
 * Acts the listener drops. A friend request arrives twice, as `req` and as `req_v2`
 * (agent/docs/zca-replace/spec-listener.md 2.5, the `fr` row); only `req_v2` becomes an event, so one request is
 * announced once.
 */
export const SKIPPED_FRIEND_ACTS = Object.freeze(["req"]);

/** Types whose `data` is the other account's uid itself. */
const UID_DATA = new Set([T.ADD, T.REMOVE, T.BLOCK, T.UNBLOCK, T.BLOCK_CALL, T.UNBLOCK_CALL]);
/** Types whose `data` is a request `{fromUid, toUid, ...}`. */
const REQUEST_DATA = new Set([T.REQUEST, T.UNDO_REQUEST, T.REJECT_REQUEST]);
/** Types whose `data` is a pinned topic change `{actorId, conversationId, topic, ...}`. */
const PIN_DATA = new Set([T.PIN_UNPIN, T.PIN_CREATE]);

const sameId = (v, uid) => v !== null && v !== undefined && String(v) === String(uid);

/**
 * The `type` number of a friend act.
 *
 * @param {string} act
 * @returns {number} a {@link FRIEND_EVENT_TYPE} value; UNKNOWN (12) for an act not listed
 */
export function friendEventType(act) {
    return BY_ACT.get(act) ?? T.UNKNOWN;
}

/**
 * Build the `friend_event` object for one act.
 *
 * @param {string} uid - the own uid
 * @param {string} act - `content.act`
 * @param {any} data - `content.data`, already parsed (a uid for add/remove/block/unblock and their call forms)
 * @returns {{type: number, data: any, threadId: any, isSelf: boolean}} for an unknown act, `data` is the JSON text
 *   of what came, `threadId` is "" and `isSelf` false
 */
export function toFriendEvent(uid, act, data) {
    const type = friendEventType(act);
    if (UID_DATA.has(type)) {
        // The server sends add and remove about the other account; the others are this account's own doing.
        return { type, data, threadId: data, isSelf: type !== T.ADD && type !== T.REMOVE };
    }
    if (REQUEST_DATA.has(type)) return { type, data, threadId: data.toUid, isSelf: sameId(data.fromUid, uid) };
    if (type === T.SEEN_FRIEND_REQUEST) return { type, data, threadId: uid, isSelf: true };
    if (PIN_DATA.has(type)) return { type, data, threadId: data.conversationId, isSelf: sameId(data.actorId, uid) };
    return { type: T.UNKNOWN, data: JSON.stringify(data), threadId: "", isSelf: false };
}

/**
 * Turn one friend control's `content` into its `friend_event`, or null for a skipped act.
 *
 * A string `data` is JSON and is parsed, except that a string holding a bare number (a uid) is kept as the string,
 * so a uid past 2^53 keeps its digits. A `topic.params` held as a JSON string (pin events) is parsed too.
 *
 * @param {string} uid - the own uid
 * @param {{act: string, data: any}} content - the control's `content` (`act_type` "fr")
 * @returns {{type: number, data: any, threadId: any, isSelf: boolean}|null}
 * @throws {SyntaxError} when a string `data` or `topic.params` is not JSON
 */
export function friendControlEvent(uid, content) {
    if (SKIPPED_FRIEND_ACTS.includes(content.act)) return null;
    let data = content.data;
    if (typeof data === "string") {
        const parsed = JSON.parse(data);
        if (typeof parsed !== "number") data = parsed;
    }
    const topic = data && typeof data === "object" ? data.topic : undefined;
    if (topic && typeof topic === "object" && typeof topic.params === "string") topic.params = JSON.parse(topic.params);
    return toFriendEvent(uid, content.act, data);
}
