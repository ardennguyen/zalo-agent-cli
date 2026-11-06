/**
 * Conversation settings: mute, the unread mark, hidden chats and their PIN, and auto-delete
 * (agent/docs/zca-replace/spec-sweep.md 1.2, "Conversations").
 *
 * Every call is one session request on the ordinary envelope (kernel/endpoint.js), shaped the way Zalo Web 26.11.10
 * shapes it. Where the Web differs from what the engine sent before, the Web wins:
 *
 * - `addUnreadMark`: the inner `param` JSON keeps the Web's fixed order `{convsGroup, convsUser, imei}`.
 * - `setHiddenConversations`: the Web's fixed order `{del_threads, add_threads, imei}`.
 * - `resetHiddenConversPin`: a GET with the common query only, no `params`.
 * - `updateAutoDeleteChat`: a POST whose sealed `params` ride in the query, with no body.
 *
 * Every id stays a string. Nothing here writes to stdout or logs.
 */
import { createHash } from "node:crypto";
import { ZaloApiError } from "../errors.js";
import { MUTE_ACTION, THREAD_TYPE } from "../enums.js";
import { sealParams } from "../kernel/http.js";
import { UNREAD_ID_KEYS, bareGroupId, threadTypeOf, unreadMarkReply } from "./actions.js";

/** `setMute`'s `duration` for "until I unmute it". */
export const MUTE_FOREVER = -1;

/** `setMute`'s `duration` for "until 8 AM" (local time), turned into seconds when sent. */
export const MUTE_UNTIL_8AM = "until8AM";

/**
 * The seconds from `now` to the next 08:00 local time (today's when it is still before 8, else tomorrow's).
 *
 * @param {number} now - milliseconds since the epoch
 * @returns {number}
 */
export function secondsUntil8am(now) {
    const at = new Date(now);
    const next = new Date(now);
    next.setHours(8, 0, 0, 0);
    if (at.getHours() >= 8) next.setDate(next.getDate() + 1);
    return Math.floor((next.getTime() - at.getTime()) / 1000);
}

/**
 * The `duration` a mute request carries: -1 for an unmute and for "forever", the seconds to the next 08:00 for
 * "until 8 AM", else the seconds given.
 *
 * @param {{duration?: number|string, action?: number}} opts
 * @param {number} now - milliseconds since the epoch
 * @returns {number|string}
 */
export function muteDurationOf({ duration = MUTE_FOREVER, action = MUTE_ACTION.MUTE } = {}, now) {
    if (action === MUTE_ACTION.UNMUTE) return MUTE_FOREVER;
    if (duration === MUTE_FOREVER) return MUTE_FOREVER;
    if (duration === MUTE_UNTIL_8AM) return secondsUntil8am(now);
    return duration;
}

/** The PIN of hidden chats: four digits. */
const PIN = /^\d{4}$/;

/**
 * A hidden-chats PIN as Zalo takes it: the MD5 of the four digits, as hex.
 *
 * @param {string} pin - four digits
 * @returns {string}
 * @throws {ZaloApiError} before any request, for anything but four digits
 */
export function hiddenPinHash(pin) {
    const text = String(pin ?? "");
    if (!PIN.test(text)) throw new ZaloApiError("Pin must be a 4-digit number between 0000-9999");
    return createHash("md5").update(text).digest("hex");
}

// ── Endpoints ──────────────────────────────────────────────────────────

/** `POST {profile}/api/social/profile/setmute` (Web setMuteConversation, 11288). */
export const MUTE_SET = Object.freeze({
    host: "profile",
    path: "/api/social/profile/setmute",
    cmd: 11288,
    method: "post",
    body: (a, ctx) => ({
        toid: a.threadId,
        duration: a.duration,
        action: a.action,
        startTime: a.startTime,
        muteType: a.muteType,
        imei: ctx.imei,
    }),
});

/** `GET {profile}/api/social/profile/getmute` (Web getMuteConversations, 11280). */
export const MUTE_GET = Object.freeze({
    host: "profile",
    path: "/api/social/profile/getmute",
    cmd: 11280,
    method: "get",
    body: (_a, ctx) => ({ imei: ctx.imei }),
});

/** `POST {conversation}/api/conv/addUnreadMark` (Web addMarkAsUnread, 12013): JSON held in a `param` string. */
export const UNREAD_ADD = Object.freeze({
    host: "conversation",
    path: "/api/conv/addUnreadMark",
    cmd: 12013,
    method: "post",
    body: (a, ctx) => ({ param: JSON.stringify({ convsGroup: a.convsGroup, convsUser: a.convsUser, imei: ctx.imei }) }),
    bigIdKeys: UNREAD_ID_KEYS,
    transform: unreadMarkReply,
});

/** `GET {conversation}/api/hiddenconvers/get-all` (Web getAllListHiddenChat, 10048). */
export const HIDDEN_GET = Object.freeze({
    host: "conversation",
    path: "/api/hiddenconvers/get-all",
    cmd: 10048,
    method: "get",
    body: (_a, ctx) => ({ imei: ctx.imei }),
});

/** `POST {conversation}/api/hiddenconvers/add-remove` (Web updateItemHiddenChat, 10049). */
export const HIDDEN_SET = Object.freeze({
    host: "conversation",
    path: "/api/hiddenconvers/add-remove",
    cmd: 10049,
    method: "post",
    body: (a, ctx) => ({ del_threads: JSON.stringify(a.del), add_threads: JSON.stringify(a.add), imei: ctx.imei }),
});

/** `GET {conversation}/api/hiddenconvers/update-pin` (Web updatePINCodeHiddenChat, 10050). */
export const HIDDEN_PIN_SET = Object.freeze({
    host: "conversation",
    path: "/api/hiddenconvers/update-pin",
    cmd: 10050,
    method: "get",
    body: (a, ctx) => ({ new_pin: a.pinHash, imei: ctx.imei }),
});

/** `GET {conversation}/api/hiddenconvers/reset` (Web resetPIN, 10051): the common query only. */
export const HIDDEN_PIN_RESET = Object.freeze({
    host: "conversation",
    path: "/api/hiddenconvers/reset",
    cmd: 10051,
    method: "get",
    body: () => null,
});

/** `GET {conversation}/api/conv/autodelete/getConvers` (Web getAutoDeleteConvers, 12022). */
export const AUTO_DELETE_GET = Object.freeze({
    host: "conversation",
    path: "/api/conv/autodelete/getConvers",
    cmd: 12022,
    method: "get",
    body: () => ({}),
});

/**
 * `POST {conversation}/api/conv/autodelete/updateConvers` (Web updateAutoDeleteConvers, 12023): the Web seals the
 * params into the query and posts no body.
 */
export const AUTO_DELETE_SET = Object.freeze({
    host: "conversation",
    path: "/api/conv/autodelete/updateConvers",
    cmd: 12023,
    method: "post",
    body: () => null,
    query: (a, ctx) => ({
        params: sealParams(ctx, { threadId: a.threadId, isGroup: a.isGroup, ttl: a.ttl, clientLang: ctx.language }),
    }),
});

// ── The methods ────────────────────────────────────────────────────────

/**
 * Conversation settings, bound to one session handle.
 *
 * @param {import("../api.js").Session} s
 * @returns {Record<string, Function>}
 */
export function conversationMethods(s) {
    /**
     * Mute or unmute a conversation.
     *
     * @param {{duration?: number|string, action?: number}} options - `action` 1 mute (default) or 3 unmute;
     *   `duration` in seconds, -1 forever (default), or "until8AM"
     * @param {string} threadId - the user or group id
     * @param {0|1} [threadType] - 0 user (default), 1 group
     * @returns {Promise<any>} Zalo's answer
     */
    const setMute = async (options = {}, threadId, threadType = THREAD_TYPE.USER) => {
        const type = threadTypeOf(threadType);
        const now = s.now();
        const action = options?.action ?? MUTE_ACTION.MUTE;
        const args = {
            threadId: type === THREAD_TYPE.GROUP ? bareGroupId(threadId) : String(threadId),
            duration: muteDurationOf({ duration: options?.duration ?? MUTE_FOREVER, action }, now),
            action,
            startTime: Math.floor(now / 1000),
            muteType: type === THREAD_TYPE.USER ? 1 : 2,
        };
        return s.call(MUTE_SET, args);
    };

    /**
     * The muted conversations.
     *
     * @returns {Promise<any>}
     */
    const getMute = () => s.call(MUTE_GET, {});

    /**
     * Mark a conversation unread.
     *
     * @param {string} threadId - the user or group id
     * @param {0|1} [threadType] - 0 user (default), 1 group
     * @returns {Promise<any>} Zalo's answer, `{data, status}` when it holds JSON in a string
     */
    const addUnreadMark = async (threadId, threadType = THREAD_TYPE.USER) => {
        const type = threadTypeOf(threadType);
        const ts = s.now();
        const group = type === THREAD_TYPE.GROUP;
        const entry = { id: group ? bareGroupId(threadId) : String(threadId), cliMsgId: String(ts), fromUid: "0", ts };
        return s.call(UNREAD_ADD, { convsGroup: group ? [entry] : [], convsUser: group ? [] : [entry] });
    };

    /**
     * The hidden conversations.
     *
     * @returns {Promise<any>}
     */
    const getHiddenConversations = () => s.call(HIDDEN_GET, {});

    /**
     * Hide or unhide conversations.
     *
     * @param {boolean} hidden - true hides, false unhides
     * @param {string|string[]} threadIds - one id or several, all of one type
     * @param {0|1} [threadType] - 0 user (default), 1 group
     * @returns {Promise<any>} Zalo's answer
     * @throws {ZaloApiError} before any request, for an empty list
     */
    const setHiddenConversations = async (hidden, threadIds, threadType = THREAD_TYPE.USER) => {
        const type = threadTypeOf(threadType);
        const ids = Array.isArray(threadIds) ? threadIds : [threadIds];
        if (ids.length === 0) throw new ZaloApiError("threadId is required");
        const group = type === THREAD_TYPE.GROUP;
        const entries = ids.map((id) => ({
            thread_id: group ? bareGroupId(id) : String(id),
            is_group: group ? 1 : 0,
        }));
        return s.call(HIDDEN_SET, hidden ? { add: entries, del: [] } : { add: [], del: entries });
    };

    /**
     * Set the PIN that guards hidden conversations.
     *
     * @param {string} pin - four digits; sent as their MD5 hex
     * @returns {Promise<any>} Zalo's answer
     * @throws {ZaloApiError} before any request, for anything but four digits
     */
    const updateHiddenConversPin = async (pin) => s.call(HIDDEN_PIN_SET, { pinHash: hiddenPinHash(pin) });

    /**
     * Remove the hidden-conversation PIN (Zalo unhides every hidden conversation with it).
     *
     * @returns {Promise<any>}
     */
    const resetHiddenConversPin = () => s.call(HIDDEN_PIN_RESET, {});

    /**
     * The conversations with auto-delete on.
     *
     * @returns {Promise<any>}
     */
    const getAutoDeleteChat = () => s.call(AUTO_DELETE_GET, {});

    /**
     * Turn a conversation's auto-delete on (for a time to live) or off (0).
     *
     * @param {number} ttl - milliseconds: 0 off, 86400000 one day, 604800000 seven, 1209600000 fourteen
     * @param {string} threadId - the user or group id
     * @param {0|1} [threadType] - 0 user (default), 1 group
     * @returns {Promise<any>} Zalo's answer
     */
    const updateAutoDeleteChat = async (ttl, threadId, threadType = THREAD_TYPE.USER) => {
        const type = threadTypeOf(threadType);
        const group = type === THREAD_TYPE.GROUP;
        return s.call(AUTO_DELETE_SET, {
            threadId: group ? bareGroupId(threadId) : String(threadId),
            isGroup: group ? 1 : 0,
            ttl,
        });
    };

    return {
        setMute,
        getMute,
        addUnreadMark,
        getHiddenConversations,
        setHiddenConversations,
        updateHiddenConversPin,
        resetHiddenConversPin,
        getAutoDeleteChat,
        updateAutoDeleteChat,
    };
}

/** Methods whose wire-conversations.test.js differential passes: the switch answers these from our code. */
export const OWN_READY = new Set([
    "setMute",
    "getMute",
    "addUnreadMark",
    "getHiddenConversations",
    "setHiddenConversations",
    "updateHiddenConversPin",
    "resetHiddenConversPin",
    "getAutoDeleteChat",
    "updateAutoDeleteChat",
]);
