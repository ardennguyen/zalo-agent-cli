/**
 * Group controls (cmd 601/603 `controls[]` with `content.act_type === "group"`) -> the `group_event` object.
 *
 * `{type, act, data, threadId, isSelf}`: `act` is the server's name for the change, `type` the name the engine
 * prints and gates on (`group_${type}` in `listen`). For 3.0.0 `type` keeps the 22-name vocabulary the engine has
 * always seen, which equals `act` for every name in it, and is "unknown" for any other act (Web also knows
 * `join_accept`, `group_type`, `new_group_invitation`, `update_group_invitation`, `remove_group_invitation`,
 * `update_status`); `act` always carries the real name.
 *
 * Pure functions. Ids are compared as strings, so an id the parser left as a number still matches.
 */

/**
 * The `type` names, in the order agent/docs/zca-replace/spec-listener.md 2.6 lists them (the vocabulary the engine
 * has always read; `listen` prints `group_${type}` and gates on these names).
 */
export const GROUP_EVENT_TYPES = Object.freeze([
    "join_request",
    "join",
    "leave",
    "remove_member",
    "block_member",
    "update_setting",
    "update_avatar",
    "update",
    "new_link",
    "add_admin",
    "remove_admin",
    "new_pin_topic",
    "update_pin_topic",
    "update_topic",
    "update_board",
    "remove_board",
    "reorder_pin_topic",
    "unpin_topic",
    "remove_topic",
    "accept_remind",
    "reject_remind",
    "remind_topic",
]);

/** The `type` of an act outside {@link GROUP_EVENT_TYPES}. */
export const GROUP_EVENT_UNKNOWN = "unknown";

/**
 * Acts the listener drops. When an admin approves a join request the server sends `join_reject` beside
 * `join_accept`; Zalo Web's group act enum (bundle 26.11.10 @~1521167) handles the two as one "approval update"
 * and never announces a rejection from it (agent/docs/zca-replace/spec-listener.md 2.5 and 3, "Group acts"), so
 * emitting it would report a rejection that did not happen.
 */
export const SKIPPED_GROUP_ACTS = Object.freeze(["join_reject"]);

const KNOWN = new Set(GROUP_EVENT_TYPES);
const PIN_ACTS = new Set(["new_pin_topic", "unpin_topic", "update_pin_topic", "reorder_pin_topic"]);
const BOARD_ACTS = new Set(["update_board", "remove_board"]);
const REMIND_ANSWER_ACTS = new Set(["accept_remind", "reject_remind"]);

const sameId = (v, uid) => v !== null && v !== undefined && String(v) === String(uid);

/**
 * The `type` of a group act.
 *
 * @param {string} act
 * @returns {string} the act itself when it is one of {@link GROUP_EVENT_TYPES}, else "unknown"
 */
export function groupEventType(act) {
    return KNOWN.has(act) ? act : GROUP_EVENT_UNKNOWN;
}

/**
 * Whether the own account caused or is the subject of the change, by the field each kind of act names it in.
 *
 * @param {string} type - from {@link groupEventType}
 * @param {object} data
 * @param {string} uid - the own uid
 * @returns {boolean}
 */
function isSelfIn(type, data, uid) {
    if (type === "join_request") return false;
    if (PIN_ACTS.has(type)) return sameId(data.actorId, uid);
    if (BOARD_ACTS.has(type)) return sameId(data.sourceId, uid);
    if (REMIND_ANSWER_ACTS.has(type)) {
        return Array.isArray(data.updateMembers) && data.updateMembers.some((id) => sameId(id, uid));
    }
    if (type === "remind_topic") return sameId(data.creatorId, uid);
    const members = Array.isArray(data.updateMembers) ? data.updateMembers : [];
    return members.some((m) => sameId(m?.id, uid)) || sameId(data.sourceId, uid);
}

/**
 * Build the `group_event` object for one act.
 *
 * @param {string} uid - the own uid
 * @param {string} act - `content.act`
 * @param {object} data - `content.data`, already parsed
 * @returns {{type: string, act: string, data: object, threadId: string, isSelf: boolean}}
 */
export function toGroupEvent(uid, act, data) {
    const type = groupEventType(act);
    const threadId = data.group_id ?? data.groupId;
    return { type, act, data, threadId, isSelf: isSelfIn(type, data, uid) };
}

/**
 * Turn one group control's `content` into its `group_event`, or null for a skipped act.
 *
 * @param {string} uid - the own uid
 * @param {{act: string, data: object|string}} content - the control's `content` (`act_type` "group"); a string
 *   `data` is JSON and is parsed
 * @returns {{type: string, act: string, data: object, threadId: string, isSelf: boolean}|null}
 * @throws {SyntaxError} when a string `data` is not JSON
 */
export function groupControlEvent(uid, content) {
    if (SKIPPED_GROUP_ACTS.includes(content.act)) return null;
    const data = typeof content.data === "string" ? JSON.parse(content.data) : content.data;
    return toGroupEvent(uid, content.act, data);
}
