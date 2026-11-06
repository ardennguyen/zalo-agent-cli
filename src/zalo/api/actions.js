/**
 * Message actions and conversation-list reads: recall, delete, react, delete a conversation, unread marks, pinned and
 * archived conversations, and conversation labels (agent/docs/zca-replace/spec-actions.md).
 *
 * Every call is one session request on the ordinary envelope (kernel/endpoint.js), shaped the way Zalo Web 26.11.10
 * shapes it. Where the Web differs from what the engine sent before, the Web wins:
 *
 * - `undo`: the Web's key order (`msgId, toid|grid, clientId, ...`); a group's `visibility` from the caller when it
 *   knows it, else 0; error 211 read as "the recall window has passed".
 * - `deleteMessage`: in a DM, `destId` is this account's own uid when the peer sent the message (the Web's rule).
 * - `addReaction`: `gMsgID` is the message id as a string (no rounding past 2^53); a thread type other than user (0)
 *   or group (1) is refused before any request.
 * - `deleteChat`: no `nretry` in the query.
 * - `getUnreadMark`, `removeUnreadMark`: ids are parsed losslessly (`id`, `fromUid`, `cliMsgId`), the Web's
 *   `preParse` keys; `removeUnreadMark` writes the Web's fixed key order.
 * - `getPinConversations`: error 212 ("no pinned conversation") is an empty list, as the Web reads it.
 * - `updateLabels`: the server's `chat_label.api.update_label_version` picks the flow, as the Web's does. 1 (the
 *   default): the full-array `/api/convlabel/update`. 2: the per-label `/api/convlabel/manage/*` calls, planned from
 *   the difference between the list on the server and the one asked for. Error 230 (the list changed since the
 *   caller read it) is said plainly in both.
 *
 * Every id stays a string. Nothing here writes to stdout or logs.
 */
import { ZaloApiError } from "../errors.js";
import { THREAD_TYPE } from "../enums.js";

// ── Shared pieces (conversations.js uses them too) ─────────────────────

/** The message every method throws for a thread type that is neither user (0) nor group (1). */
export const INVALID_THREAD_TYPE = "Thread type is invalid";

/**
 * A thread type as 0 (user) or 1 (group), refusing anything else before a request is built.
 *
 * @param {unknown} type - 0, 1, or their string forms; `undefined`/`null` take `fallback`
 * @param {number|null} [fallback] - the type when none is given; null refuses a missing type too
 * @returns {0|1}
 * @throws {ZaloApiError} "Thread type is invalid"
 */
export function threadTypeOf(type, fallback = THREAD_TYPE.USER) {
    const given = type === undefined || type === null ? fallback : type;
    if (given === null || given === "") throw new ZaloApiError(INVALID_THREAD_TYPE);
    const n = Number(given);
    if (n === THREAD_TYPE.USER || n === THREAD_TYPE.GROUP) return n;
    throw new ZaloApiError(INVALID_THREAD_TYPE);
}

/**
 * A group id as the wire carries it: the Web's conversation prefix `g` taken off, always a string.
 *
 * @param {string|number} id - `"g<digits>"` or `"<digits>"`
 * @returns {string}
 */
export function bareGroupId(id) {
    const s = String(id ?? "");
    return /^g\d+$/.test(s) ? s.slice(1) : s;
}

/** The keys the Web's `preParse` quotes in an unread-mark answer, so a 19-digit id keeps every digit. */
export const UNREAD_ID_KEYS = Object.freeze(["id", "fromUid", "cliMsgId"]);

/**
 * The answer of the three unread-mark calls: `data.data` is JSON held in a string, opened here into
 * `{data, status}`; any other answer is returned as it came.
 *
 * @param {any} data - the reply's inner data (already parsed losslessly for {@link UNREAD_ID_KEYS})
 * @returns {any}
 */
export function unreadMarkReply(data) {
    if (data && typeof data.data === "string") {
        return { data: JSON.parse(data.data), status: data.status };
    }
    return data;
}

/**
 * Run a call and give some of Zalo's error codes a plainer message; the code is kept.
 *
 * @template T
 * @param {Promise<T>} call
 * @param {Record<number, string>} messages - code -> message
 * @returns {Promise<T>}
 */
export async function withMessages(call, messages) {
    try {
        return await call;
    } catch (e) {
        const code = e?.code;
        if (code !== null && code !== undefined && Object.hasOwn(messages, String(code))) {
            throw new ZaloApiError(messages[String(code)], Number(code));
        }
        throw e;
    }
}

// ── Reactions ──────────────────────────────────────────────────────────

/**
 * The reaction type Zalo files each icon code under (`rType`); `source` is 6 for all of them. An icon not listed
 * goes out with rType -1, and the empty icon with -1 clears this account's reaction.
 */
export const REACTION_TYPES = Object.freeze(
    new Map([
        [":>", 0],
        ["--b", 1],
        [":-((", 2],
        ["/-strong", 3],
        ["/-weak", 4],
        ["/-heart", 5],
        [":')", 7],
        [":-*", 8],
        [":((", 16],
        [":-h", 20],
        ["x-)", 21],
        ["8-)", 22],
        [";-d", 23],
        ["b-)", 26],
        [";xx", 29],
        [":--|", 30],
        [":o", 32],
        ["p-(", 35],
        [":-bye", 36],
        ["|-)", 38],
        [":wipe", 39],
        [":-dig", 42],
        ["&-(", 44],
        [";-)", 45],
        [":handclap", 46],
        [">-|", 47],
        [":-f", 48],
        [":-l", 49],
        [":-r", 50],
        [";-/", 51],
        [";-x", 52],
        [":-o", 53],
        [";-s", 54],
        [";-a", 60],
        [":-<", 61],
        [":))", 62],
        ["$-)", 63],
        ["/-break", 65],
        ["/-shit", 66],
        ["/-li", 67],
        ["/-ok", 68],
        ["/-v", 69],
        ["/-thanks", 70],
        ["/-punch", 71],
        ["/-share", 72],
        ["_()_", 73],
        ["/-beer", 99],
        ["/-rose", 120],
        ["/-fade", 121],
        ["/-bd", 126],
        ["/-bome", 127],
        ["/-no", 131],
        ["/-bad", 132],
        ["/-loveu", 133],
    ]),
);

/** The `source` of a reaction picked from the reaction bar. */
export const REACTION_SOURCE = 6;

/**
 * `{rIcon, rType, source}` of a reaction given as an icon code or as `{icon, rType, source}`.
 *
 * @param {string|{icon: string, rType: number, source?: number}} icon
 * @returns {{rIcon: string, rType: number, source: number}}
 * @throws {ZaloApiError} "Invalid reaction" for anything else
 */
export function reactionOf(icon) {
    if (icon && typeof icon === "object") {
        if (typeof icon.icon !== "string" || !Number.isFinite(Number(icon.rType))) {
            throw new ZaloApiError("Invalid reaction");
        }
        return { rIcon: icon.icon, rType: Number(icon.rType), source: Number(icon.source ?? REACTION_SOURCE) };
    }
    if (typeof icon !== "string") throw new ZaloApiError("Invalid reaction");
    return { rIcon: icon, rType: REACTION_TYPES.get(icon) ?? -1, source: REACTION_SOURCE };
}

/**
 * The message ids a reaction answer lists, as strings: the answer holds them as a JSON array in a string, and a
 * plain parse would round every id past 2^53.
 *
 * @param {string} text - e.g. `"[1234,5678]"`
 * @returns {unknown}
 */
function idsFromText(text) {
    return JSON.parse(text.replace(/(^|[[,]\s*)(\d+)(?=\s*[\],])/g, '$1"$2"'));
}

// ── Endpoints ──────────────────────────────────────────────────────────

/** `POST {chat}/api/message/undo` (Web undoMessage, 11281). */
export const UNDO_USER = Object.freeze({
    host: "chat",
    path: "/api/message/undo",
    cmd: 11281,
    method: "post",
    body: (a) => ({ msgId: a.msgId, toid: a.threadId, clientId: a.clientId, cliMsgIdUndo: a.cliMsgId }),
});

/** `POST {group}/api/group/undomsg` (Web undoMessage, 11192). */
export const UNDO_GROUP = Object.freeze({
    host: "group",
    path: "/api/group/undomsg",
    cmd: 11192,
    method: "post",
    body: (a, ctx) => ({
        msgId: a.msgId,
        grid: a.threadId,
        clientId: a.clientId,
        visibility: a.visibility,
        cliMsgIdUndo: a.cliMsgId,
        imei: ctx.imei,
    }),
});

/** `POST {chat}/api/message/delete` (Web deleteOneOneMessageV2, 11779). */
export const DELETE_USER = Object.freeze({
    host: "chat",
    path: "/api/message/delete",
    cmd: 11779,
    method: "post",
    body: (a, ctx) => ({ toid: a.threadId, cliMsgId: a.clientId, msgs: a.msgs, onlyMe: a.onlyMe, imei: ctx.imei }),
});

/** `POST {group}/api/group/deletemsg` (Web deleteGroupMessageV2, 11834): no imei. */
export const DELETE_GROUP = Object.freeze({
    host: "group",
    path: "/api/group/deletemsg",
    cmd: 11834,
    method: "post",
    body: (a) => ({ grid: a.threadId, cliMsgId: a.clientId, msgs: a.msgs, onlyMe: a.onlyMe }),
});

/** A reaction's answer: `msgIds` held as a JSON string is opened, ids as strings. */
const reactionReply = (data) => (data && typeof data.msgIds === "string" ? { msgIds: idsFromText(data.msgIds) } : data);

/** `POST {reaction}/api/message/reaction` (Web sendReactionMessage, 12410). */
export const REACT_USER = Object.freeze({
    host: "reaction",
    path: "/api/message/reaction",
    cmd: 12410,
    method: "post",
    body: (a) => ({ react_list: a.reactList, toid: a.threadId }),
    transform: reactionReply,
});

/** `POST {reaction}/api/group/reaction` (Web sendReactionMessage, 12411). */
export const REACT_GROUP = Object.freeze({
    host: "reaction",
    path: "/api/group/reaction",
    cmd: 12411,
    method: "post",
    body: (a, ctx) => ({ react_list: a.reactList, grid: a.threadId, imei: ctx.imei }),
    transform: reactionReply,
});

/** `POST {chat}/api/message/deleteconver` (Web deleteOneOneConversationV2, 11778): no nretry. */
export const DELETE_CHAT_USER = Object.freeze({
    host: "chat",
    path: "/api/message/deleteconver",
    cmd: 11778,
    method: "post",
    body: (a, ctx) => ({ toid: a.threadId, cliMsgId: a.clientId, conver: a.conver, onlyMe: 1, imei: ctx.imei }),
});

/** `POST {group}/api/group/deleteconver` (Web deleteGroupConversationV2, 11835): no nretry. */
export const DELETE_CHAT_GROUP = Object.freeze({
    host: "group",
    path: "/api/group/deleteconver",
    cmd: 11835,
    method: "post",
    body: (a, ctx) => ({ grid: a.threadId, cliMsgId: a.clientId, conver: a.conver, onlyMe: 1, imei: ctx.imei }),
});

/** `GET {conversation}/api/conv/getUnreadMark` (Web getMarkAsUnread, 12011): ids kept whole. */
export const UNREAD_GET = Object.freeze({
    host: "conversation",
    path: "/api/conv/getUnreadMark",
    cmd: 12011,
    method: "get",
    body: () => ({}),
    bigIdKeys: UNREAD_ID_KEYS,
    transform: unreadMarkReply,
});

/** `POST {conversation}/api/conv/removeUnreadMark` (Web removeMarkAsUnread, 12014). */
export const UNREAD_REMOVE = Object.freeze({
    host: "conversation",
    path: "/api/conv/removeUnreadMark",
    cmd: 12014,
    method: "post",
    body: (a) => ({ param: JSON.stringify(a.param) }),
    bigIdKeys: UNREAD_ID_KEYS,
    transform: unreadMarkReply,
});

/** What the Web reads error 212 of the pinned list as: nothing is pinned, version 0. */
export const NO_PINS = Object.freeze({ conversations: [], version: 0 });

/** `GET {conversation}/api/pinconvers/list` (Web getPinnedConversations, 12120). */
export const PINS_GET = Object.freeze({
    host: "conversation",
    path: "/api/pinconvers/list",
    cmd: 12120,
    method: "get",
    body: (_a, ctx) => ({ imei: ctx.imei }),
    emptyOn: { 212: NO_PINS },
});

/** `GET {label}/api/archivedchat/list` (Web getListArchivedChat, 12076): version 1, a fresh client's. */
export const ARCHIVED_GET = Object.freeze({
    host: "label",
    path: "/api/archivedchat/list",
    cmd: 12076,
    method: "get",
    body: (_a, ctx) => ({ version: 1, imei: ctx.imei }),
});

/**
 * A label list answer: `labelData` held as a JSON string is opened (already an array, or empty, is taken as it is).
 *
 * @param {any} data
 * @returns {{labelData: any[], version: unknown, lastUpdateTime: unknown}}
 */
export function labelReply(data) {
    const raw = data?.labelData;
    let labelData;
    if (Array.isArray(raw)) labelData = raw;
    else if (typeof raw === "string" && raw.trim()) labelData = JSON.parse(raw);
    else labelData = [];
    return { labelData, version: data?.version, lastUpdateTime: data?.lastUpdateTime };
}

/** `GET {label}/api/convlabel/get` (Web getConversationLabel, 12161). */
export const LABELS_GET = Object.freeze({
    host: "label",
    path: "/api/convlabel/get",
    cmd: 12161,
    method: "get",
    body: (_a, ctx) => ({ imei: ctx.imei }),
    transform: labelReply,
});

/** `POST {label}/api/convlabel/update` (Web updateConversationLabel, 12160): the whole list at once. */
export const LABELS_UPDATE = Object.freeze({
    host: "label",
    path: "/api/convlabel/update",
    cmd: 12160,
    method: "post",
    body: (a, ctx) => ({ labelData: JSON.stringify(a.labelData), version: a.version, imei: ctx.imei }),
    transform: labelReply,
});

/** `POST {label}/api/convlabel/manage/add` (12163): a new label, and the conversations it tags. */
export const LABEL_ADD = Object.freeze({
    host: "label",
    path: "/api/convlabel/manage/add",
    cmd: 12163,
    method: "post",
    body: (a) => ({ labelInfo: JSON.stringify(a.labelInfo), add: a.add }),
    transform: labelReply,
});

/** `POST {label}/api/convlabel/manage/update` (12164): rename, recolor, move, tag and untag. */
export const LABEL_UPDATE = Object.freeze({
    host: "label",
    path: "/api/convlabel/manage/update",
    cmd: 12164,
    method: "post",
    body: (a) => ({ labelInfo: JSON.stringify(a.labelInfo), add: a.add, remove: a.remove }),
    transform: labelReply,
});

/** `POST {label}/api/convlabel/manage/delete` (12165). */
export const LABEL_DELETE = Object.freeze({
    host: "label",
    path: "/api/convlabel/manage/delete",
    cmd: 12165,
    method: "post",
    body: (a) => ({ labelIds: a.labelIds }),
    transform: labelReply,
});

/** Zalo's code for "the label list changed since the version you sent". */
export const LABEL_CONFLICT = 230;

/** What error 230 says, in either label flow. */
export const LABEL_CONFLICT_MESSAGE =
    "The label list changed since it was read (version conflict): read it again and retry";

/** Zalo's code for a recall after the recall window. */
export const UNDO_TOO_LATE = 211;

/** What error 211 says. */
export const UNDO_TOO_LATE_MESSAGE = "The recall window for this message has passed";

/**
 * Which label flow the server asks for: `chat_label.api.update_label_version` of the login's settings (under
 * `features`, or at the top level), 1 when absent.
 *
 * @param {object} ctx
 * @returns {number}
 */
export function labelApiVersion(ctx) {
    const s = ctx?.settings;
    const v = s?.features?.chat_label?.api?.update_label_version ?? s?.chat_label?.api?.update_label_version;
    return Number(v) === 2 ? 2 : 1;
}

/**
 * The per-label calls that turn the server's label list into the one asked for: deletes first (they free room under
 * the label limit), then changes to labels that stay, then new labels. A label that stays is matched by `id`; its
 * conversations are diffed into `add`/`remove`.
 *
 * @param {any[]} current - the list on the server
 * @param {any[]} wanted - the list asked for
 * @returns {Array<{def: object, args: object}>}
 */
export function planLabelCalls(current, wanted) {
    const ids = (list) => (Array.isArray(list) ? list.map(String) : []);
    const byId = new Map(current.filter((l) => l && l.id !== undefined && l.id !== null).map((l) => [String(l.id), l]));
    const kept = new Set();
    const updates = [];
    const adds = [];
    for (const label of wanted) {
        if (!label || typeof label !== "object") continue;
        const was = label.id !== undefined && label.id !== null ? byId.get(String(label.id)) : undefined;
        if (!was) {
            const labelInfo = { text: String(label.text ?? ""), color: String(label.color ?? "") };
            if (label.emoji) labelInfo.emoji = label.emoji;
            adds.push({ def: LABEL_ADD, args: { labelInfo, add: ids(label.conversations) } });
            continue;
        }
        kept.add(String(was.id));
        const before = new Set(ids(was.conversations));
        const after = new Set(ids(label.conversations ?? was.conversations));
        const add = [...after].filter((c) => !before.has(c));
        const remove = [...before].filter((c) => !after.has(c));
        const labelInfo = {
            id: was.id,
            text: String(label.text ?? was.text ?? ""),
            color: String(label.color ?? was.color ?? ""),
            offset: label.offset ?? was.offset,
        };
        const changed =
            labelInfo.text !== String(was.text ?? "") ||
            labelInfo.color !== String(was.color ?? "") ||
            String(labelInfo.offset) !== String(was.offset);
        if (changed || add.length || remove.length) {
            updates.push({ def: LABEL_UPDATE, args: { labelInfo, add, remove } });
        }
    }
    const gone = [...byId.values()].filter((l) => !kept.has(String(l.id))).map((l) => l.id);
    const deletes = gone.length ? [{ def: LABEL_DELETE, args: { labelIds: gone } }] : [];
    return [...deletes, ...updates, ...adds];
}

// ── The methods ────────────────────────────────────────────────────────

/**
 * Message actions and conversation-list reads, bound to one session handle.
 *
 * @param {import("../api.js").Session} s
 * @returns {Record<string, Function>}
 */
export function actionMethods(s) {
    /**
     * Recall a message for everyone.
     *
     * @param {{msgId: string, cliMsgId: string, visibility?: number}} payload - the message's global id and client id;
     *   `visibility` the group's own value when the caller knows it (0 otherwise)
     * @param {string} threadId - the user or group id
     * @param {0|1} [threadType] - 0 user (default), 1 group
     * @returns {Promise<any>} Zalo's answer
     */
    const undo = async (payload, threadId, threadType = THREAD_TYPE.USER) => {
        const type = threadTypeOf(threadType);
        const args = {
            msgId: payload?.msgId,
            cliMsgId: payload?.cliMsgId,
            threadId: type === THREAD_TYPE.GROUP ? bareGroupId(threadId) : String(threadId),
            clientId: s.nextClientId(),
            visibility: Number.isFinite(Number(payload?.visibility)) ? Number(payload.visibility) : 0,
        };
        return withMessages(s.call(type === THREAD_TYPE.GROUP ? UNDO_GROUP : UNDO_USER, args), {
            [UNDO_TOO_LATE]: UNDO_TOO_LATE_MESSAGE,
        });
    };

    /**
     * Delete a message for this account only, or (a group admin, someone else's message) for everyone.
     *
     * @param {{data: {cliMsgId: string, msgId: string, uidFrom: string}, threadId: string, type?: 0|1}} target - the
     *   message (its client id, global id and sender) and its thread
     * @param {boolean} [onlyMe] - true: only for this account; false: for everyone
     * @returns {Promise<any>} Zalo's answer
     * @throws {ZaloApiError} before any request, for "everyone" on one's own message or in a DM
     */
    const deleteMessage = async (target, onlyMe = false) => {
        const type = threadTypeOf(target?.type);
        const data = target?.data ?? {};
        const me = String(s.ctx.uid);
        const owner = String(data.uidFrom === "0" ? me : data.uidFrom);
        if (owner === me && onlyMe === false) {
            throw new ZaloApiError("To delete your message for everyone, use undo api instead");
        }
        if (type === THREAD_TYPE.USER && onlyMe === false) {
            throw new ZaloApiError("Can't delete message for everyone in a private chat");
        }
        const threadId = type === THREAD_TYPE.GROUP ? bareGroupId(target.threadId) : String(target.threadId);
        // A DM message lives in the thread of whoever received it: the peer's id when this account sent it, this
        // account's own id when the peer did. A group message lives in the group.
        const destId = type === THREAD_TYPE.GROUP || owner === me ? threadId : me;
        const msgs = [{ cliMsgId: data.cliMsgId, globalMsgId: data.msgId, ownerId: owner, destId }];
        const args = { threadId, clientId: s.nextClientId(), msgs, onlyMe: onlyMe ? 1 : 0 };
        return s.call(type === THREAD_TYPE.GROUP ? DELETE_GROUP : DELETE_USER, args);
    };

    /**
     * React to a message (an empty icon clears this account's reaction).
     *
     * @param {string|{icon: string, rType: number, source?: number}} icon - an icon code such as `/-heart`
     * @param {{data: {msgId: string, cliMsgId: string}, threadId: string, type: 0|1}} target - the message and its
     *   thread; a thread type other than 0 or 1 is refused before any request
     * @returns {Promise<any>} Zalo's answer, `msgIds` as strings when it lists them
     */
    const addReaction = async (icon, target) => {
        const type = threadTypeOf(target?.type, null);
        const { rIcon, rType, source } = reactionOf(icon);
        const data = target?.data ?? {};
        const message = JSON.stringify({
            rMsg: [{ gMsgID: String(data.msgId ?? ""), cMsgID: parseInt(data.cliMsgId), msgType: 1 }],
            rIcon,
            rType,
            source,
        });
        const threadId = type === THREAD_TYPE.GROUP ? bareGroupId(target.threadId) : String(target.threadId);
        const args = { reactList: [{ message, clientId: s.nextClientId() }], threadId };
        return s.call(type === THREAD_TYPE.GROUP ? REACT_GROUP : REACT_USER, args);
    };

    /**
     * Delete a conversation's history for this account, back from an anchor message.
     *
     * @param {{ownerId: string, cliMsgId: string, globalMsgId: string}} anchor - the newest message to delete
     * @param {string} threadId - the user or group id
     * @param {0|1} [threadType] - 0 user (default), 1 group
     * @returns {Promise<any>} Zalo's answer
     */
    const deleteChat = async (anchor, threadId, threadType = THREAD_TYPE.USER) => {
        const type = threadTypeOf(threadType);
        const me = String(s.ctx.uid);
        const conver = {
            ownerId: anchor?.ownerId === "0" ? me : String(anchor?.ownerId),
            cliMsgId: String(anchor?.cliMsgId),
            globalMsgId: String(anchor?.globalMsgId),
        };
        const args = {
            threadId: type === THREAD_TYPE.GROUP ? bareGroupId(threadId) : String(threadId),
            clientId: String(s.nextClientId()),
            conver,
        };
        return s.call(type === THREAD_TYPE.GROUP ? DELETE_CHAT_GROUP : DELETE_CHAT_USER, args);
    };

    /**
     * The conversations marked unread, with every id exact.
     *
     * @returns {Promise<{data: {convsGroup: object[], convsUser: object[]}, status: number}|any>}
     */
    const getUnreadMark = () => s.call(UNREAD_GET, {});

    /**
     * Clear a conversation's unread mark.
     *
     * @param {string} threadId - the user or group id
     * @param {0|1} [threadType] - 0 user (default), 1 group
     * @returns {Promise<any>} Zalo's answer
     */
    const removeUnreadMark = async (threadId, threadType = THREAD_TYPE.USER) => {
        const type = threadTypeOf(threadType);
        const ts = s.now();
        const group = type === THREAD_TYPE.GROUP;
        const id = group ? bareGroupId(threadId) : String(threadId);
        const param = {
            convsGroup: group ? [id] : [],
            convsUser: group ? [] : [id],
            convsGroupData: group ? [{ id, ts }] : [],
            convsUserData: group ? [] : [{ id, ts }],
        };
        return s.call(UNREAD_REMOVE, { param });
    };

    /**
     * The pinned conversations (`g<id>` groups, `u<id>` users); nothing pinned is an empty list.
     *
     * @returns {Promise<{conversations: string[], version: number}>}
     */
    const getPinConversations = () => s.call(PINS_GET, {});

    /**
     * The archived conversations.
     *
     * @returns {Promise<{version: number|string, items: Array<{id: string, type: number}>}|any>}
     */
    const getArchivedChatList = () => s.call(ARCHIVED_GET, {});

    /**
     * The account's conversation labels.
     *
     * @returns {Promise<{labelData: any[], version: number, lastUpdateTime: number}>}
     */
    const getLabels = () => s.call(LABELS_GET, {});

    /**
     * Make the account's labels the given list, in the flow the server asks for.
     *
     * @param {{labelData: any[], version: number}} labels - the whole list as it should be, and the version it was
     *   read at
     * @returns {Promise<{labelData: any[], version: number, lastUpdateTime: number}>} the list after the change
     * @throws {ZaloApiError} code 230 when the list changed since that version
     */
    const updateLabels = async (labels) => {
        const wanted = Array.isArray(labels?.labelData) ? labels.labelData : [];
        const conflict = { [LABEL_CONFLICT]: LABEL_CONFLICT_MESSAGE };
        if (labelApiVersion(s.ctx) !== 2) {
            return withMessages(s.call(LABELS_UPDATE, { labelData: wanted, version: labels?.version }), conflict);
        }
        const current = await s.call(LABELS_GET, {});
        if (
            labels?.version !== undefined &&
            labels?.version !== null &&
            String(labels.version) !== String(current.version)
        ) {
            throw new ZaloApiError(LABEL_CONFLICT_MESSAGE, LABEL_CONFLICT);
        }
        let last = current;
        for (const { def, args } of planLabelCalls(current.labelData, wanted)) {
            last = await withMessages(s.call(def, args), conflict);
        }
        return last;
    };

    return {
        undo,
        deleteMessage,
        addReaction,
        deleteChat,
        getUnreadMark,
        removeUnreadMark,
        getPinConversations,
        getArchivedChatList,
        getLabels,
        updateLabels,
    };
}

/** Methods whose wire-actions.test.js differential passes: the switch answers these from our code. */
export const OWN_READY = new Set([
    "undo",
    "deleteMessage",
    "addReaction",
    "deleteChat",
    "getUnreadMark",
    "removeUnreadMark",
    "getPinConversations",
    "getArchivedChatList",
    "getLabels",
    "updateLabels",
]);
