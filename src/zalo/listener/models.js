/**
 * The objects the listener emits for chat socket events, and that the engine also builds itself from stored rows
 * (src/core/self-heal.js, src/core/group-history.js).
 *
 * Every object is `{type, data, threadId, isSelf}`, where `type` is the thread type, 0 for a 1-1 conversation and 1
 * for a group. Undo adds `isGroup`; Reaction has `isGroup` instead of `type`. `data` is the wire object itself, not
 * a copy.
 *
 * On the wire the server writes the own account as "0": `uidFrom: "0"` on a message this account sent, and
 * `idTo: "0"` on a 1-1 message sent to it. The message, undo and reaction objects rewrite those "0"s in `data` to
 * the own uid, in place, after reading `isSelf` and `threadId` from them. Code downstream relies on both: on the
 * rewrite already being done, and on `isSelf` to put the "0" back when it echoes a message to the wire. A caller
 * that must keep its row untouched passes a copy.
 *
 * Differences from the classes these replace: `Undo` has a `type` (they left it out, so every recall looked
 * like a group recall to `normalizeUndo` in src/commands/mcp.js); a quote without an `ownerId` is left without one
 * (they wrote the text "undefined"); a receipt without its uid list is treated as not this account's instead of
 * throwing; and uids are compared as strings, so an id parsed as a number still matches.
 */

/** Thread types (the engine's THREAD_TYPE has the same numbers). */
const USER = 0;
const GROUP = 1;

/** The own account as the server writes it. */
const isOwnMark = (v) => v === "0" || v === 0;

/** A wire id compared with the own uid, whatever JSON type it was parsed as. */
const sameId = (v, uid) => v !== null && v !== undefined && String(v) === String(uid);

/** `quote.ownerId` as a string, in place (the engine reads it as one). */
function stringifyQuoteOwner(data) {
    const q = data.quote;
    if (q && typeof q === "object" && q.ownerId !== null && q.ownerId !== undefined) q.ownerId = String(q.ownerId);
}

/**
 * Read `threadId` and `isSelf` from a 1-1-or-group item, then write the own uid over the "0"s in place.
 *
 * @returns {{threadId: any, isSelf: boolean}}
 */
function settle(uid, data, isGroup) {
    const isSelf = isOwnMark(data.uidFrom);
    const threadId = isGroup || isSelf ? data.idTo : data.uidFrom;
    if (isOwnMark(data.idTo)) data.idTo = uid;
    if (isSelf) data.uidFrom = uid;
    return { threadId, isSelf };
}

/** A 1-1 message (cmd 501 `msgs`, cmd 510 pages). */
export class UserMessage {
    /**
     * @param {string} uid - the own uid
     * @param {object} data - the wire message; rewritten in place
     */
    constructor(uid, data) {
        const { threadId, isSelf } = settle(uid, data, false);
        this.type = USER;
        this.data = data;
        this.threadId = threadId;
        this.isSelf = isSelf;
        stringifyQuoteOwner(data);
    }
}

/** A group message (cmd 521 `groupMsgs`, cmd 511 pages). */
export class GroupMessage {
    /**
     * @param {string} uid - the own uid
     * @param {object} data - the wire message; rewritten in place
     */
    constructor(uid, data) {
        const isSelf = isOwnMark(data.uidFrom);
        if (isSelf) data.uidFrom = uid;
        this.type = GROUP;
        this.data = data;
        this.threadId = data.idTo;
        this.isSelf = isSelf;
        stringifyQuoteOwner(data);
    }
}

/** A recall: a pushed message whose `content` is an object with a `deleteMsg` key (see {@link isRecall}). */
export class Undo {
    /**
     * @param {string} uid - the own uid
     * @param {object} data - the wire message; rewritten in place
     * @param {boolean} isGroup - whether it came from a group list
     */
    constructor(uid, data, isGroup) {
        const { threadId, isSelf } = settle(uid, data, isGroup);
        this.type = isGroup ? GROUP : USER;
        this.data = data;
        this.threadId = threadId;
        this.isSelf = isSelf;
        this.isGroup = isGroup;
    }
}

/**
 * A reaction (cmd 612 pushes, 610 and 611 pages). `data.content` is whatever the caller passes: the listener parses
 * it for pushes and leaves it a JSON string for pages. It has no `type`; readers use `isGroup`.
 */
export class Reaction {
    /**
     * @param {string} uid - the own uid
     * @param {object} data - the wire reaction; rewritten in place
     * @param {boolean} isGroup - whether it came from a group list
     */
    constructor(uid, data, isGroup) {
        const { threadId, isSelf } = settle(uid, data, isGroup);
        this.data = data;
        this.threadId = threadId;
        this.isSelf = isSelf;
        this.isGroup = isGroup;
    }
}

/** Someone typing in a 1-1 conversation (cmd 602, act `typing`; `data` is `{uid, ts, isPC}`). */
export class UserTyping {
    /** @param {{uid: string, ts?: any, isPC?: any}} data */
    constructor(data) {
        this.type = USER;
        this.data = data;
        this.threadId = data.uid;
        this.isSelf = false;
    }
}

/** Someone typing in a group (cmd 602, act `gtyping`; `data` is `{uid, gid, ts, isPC}`). */
export class GroupTyping {
    /** @param {{uid: string, gid: string, ts?: any, isPC?: any}} data */
    constructor(data) {
        this.type = GROUP;
        this.data = data;
        this.threadId = data.gid;
        this.isSelf = false;
    }
}

/** The peer read a 1-1 message (cmd 502 `seens`; `data` is `{idTo, msgId, realMsgId}`). */
export class UserSeenMessage {
    /** @param {{idTo: string, msgId: string, realMsgId?: string}} data */
    constructor(data) {
        this.type = USER;
        this.data = data;
        this.threadId = data.idTo;
        this.isSelf = false;
    }
}

/** Members read a group message (cmd 522 `groupSeens`; `data` is `{msgId, groupId, seenUids}`). */
export class GroupSeenMessage {
    /**
     * @param {string} uid - the own uid
     * @param {{msgId: string, groupId: string, seenUids: string[]}} data
     */
    constructor(uid, data) {
        this.type = GROUP;
        this.data = data;
        this.threadId = data.groupId;
        this.isSelf = Array.isArray(data.seenUids) && data.seenUids.some((id) => sameId(id, uid));
    }
}

/** A 1-1 message reached the peer (cmd 502 `delivereds`). */
export class UserDeliveredMessage {
    /** @param {{msgId: string, deliveredUids: string[], seenUids?: string[], realMsgId?: string, mSTs?: any}} data */
    constructor(data) {
        this.type = USER;
        this.data = data;
        this.threadId = Array.isArray(data.deliveredUids) ? data.deliveredUids[0] : undefined;
        this.isSelf = false;
    }
}

/** A group message reached members (cmd 522 `delivereds`; as the 1-1 form plus `groupId`). */
export class GroupDeliveredMessage {
    /**
     * @param {string} uid - the own uid
     * @param {{msgId: string, groupId: string, deliveredUids: string[]}} data
     */
    constructor(uid, data) {
        this.type = GROUP;
        this.data = data;
        this.threadId = data.groupId;
        this.isSelf = Array.isArray(data.deliveredUids) && data.deliveredUids.some((id) => sameId(id, uid));
    }
}

/**
 * Is this pushed message a recall? It is when its `content` is an object (not a string, not an array) with its own
 * `deleteMsg` key; such a message becomes an {@link Undo}, every other one a message object.
 *
 * @param {object} data - the wire message
 * @returns {boolean}
 */
export function isRecall(data) {
    const c = data?.content;
    return c !== null && typeof c === "object" && !Array.isArray(c) && Object.hasOwn(c, "deleteMsg");
}
