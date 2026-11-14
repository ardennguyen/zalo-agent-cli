/**
 * Notes, polls and reminders: the board objects of a conversation (agent/docs/zca-replace/spec-boards.md).
 *
 * Every call is one session request on the ordinary envelope (kernel/endpoint.js), shaped the way the server
 * expects it. Where that differs from what the engine sent before:
 *
 * - Polls go to the `group_poll` host, falling back to `group` when the service map has no `group_poll`. Their
 *   replies keep `creator` and `voters` as strings.
 * - `getPollDetail` is a GET.
 * - `getListBoard` and the group `getListReminder` take a cursor (`lastId`, `lastType`) for page 2 and later, as the
 *   server expects; `boardCursor()` reads it off a page. A reply that is a JSON string of a
 *   bare array is read as a list of notes. The group reminder list's `last_id` goes out as a
 *   parsed Number, rounded past 2^53: the exact id brings page 1 back again (live, 2026-11-07). A page with the
 *   cursor can come back short while more follow, so the pagers stop at an empty page.
 * - A group id loses Zalo's conversation prefix `g` before it goes out.
 * - Reminders are created and edited in Zalo's default colour (-16777216, opaque black) and in the expected key
 *   order. The caller's emoji is kept (design 6.1 item 12; Zalo's own apps always send "⏰").
 * - `editReminder` loads the reminder first and sends its current values for every field the caller did not change
 *   (a group one through `getReminder`, a DM one from the DM list), as Zalo edits a loaded reminder. Before, an
 *   edit without a time moved the reminder to the moment of the edit, and one without a repeat reset it.
 * - `addPollOptions` sends the caller's current votes as `voted_option_ids` (read from the poll first) unless the
 *   caller names them: the list is the full selection after the change, so an empty one cleared them. On a
 *   single-choice poll, voting a new option drops the old vote, as Zalo does.
 * - Reminder replies keep `topicId`, `reminderId`, `id` and `eventId` as strings; a `params` that arrives as a JSON
 *   string is opened into an object.
 * - `lockPoll` takes a success with no `data` as done (only the outer code of `/api/poll/end` is read).
 * - A list call answered with an error whose `data` is the string `"[]"` is an empty page: that answer means
 *   "no more".
 * - A DM's reminder replies keep `creatorUid`, `creatorId` and `toUid` as strings too (ours, not Zalo's key list:
 *   `editReminder` sends the loaded creator back, and a rounded uid would name somebody else).
 *
 * `listOneOneBoard` (moved here from src/core/sync-v2/board.js) asks a DM's board for every kind of item.
 *
 * Every id stays as the caller gave it, or a string. Nothing here writes to stdout or logs.
 */
import { THREAD_TYPE } from "../enums.js";
import { ZaloApiError } from "../errors.js";
import { openSession } from "../kernel/cipher.js";
import { callEndpoint } from "../kernel/endpoint.js";
import { preParse } from "../kernel/json-ids.js";

// ── Constants (spec-boards 0) ───────────────

/** The board host of notes, board lists and reminders. */
export const BOARD_HOST = "group_board";

/** The poll host, and the fallback when the service map has no `group_poll`. */
export const POLL_HOST = Object.freeze(["group_poll", "group"]);

/** A topic's default colour: opaque black, `0xFF000000` as an int32. */
export const TOPIC_COLOR = -16777216;

/** A reminder's default emoji. */
export const REMINDER_EMOJI = "⏰";

/** The `src` of a create: the chat bar, as the engine has always sent. */
export const CREATE_SRC = 1;

/** What a board list item is (`boardType`): a note or reminder, a pinned message, a poll. */
export const BOARD_TYPE = Object.freeze({ ALL: 0, TOPIC: 1, MESSAGE: 2, POLL: 3 });

/** The page size asked for. */
export const PAGE_SIZE = 20;

/** The keys quoted in a poll reply, so a 19-digit uid keeps every digit. */
export const POLL_ID_KEYS = Object.freeze(["creator", "voters"]);

/** The keys quoted in a reminder reply. */
export const REMINDER_ID_KEYS = Object.freeze(["topicId", "reminderId", "id", "eventId"]);

/**
 * The keys kept as strings in a DM reminder reply: the reminder ids, and the uids a DM reminder carries, because
 * `editReminder` sends the loaded creator back.
 */
export const DM_REMINDER_ID_KEYS = Object.freeze([...REMINDER_ID_KEYS, "creatorUid", "creatorId", "toUid"]);

/** The uid lists of a reminder's responses: kept as strings too. */
export const RESPONSE_ID_KEYS = Object.freeze(["acceptMember", "rejectMember"]);

/** How many pages of a DM's reminder list `editReminder` reads to find the one it edits. */
export const EDIT_LOOKUP_PAGES = 10;

/** The message for a thread type that is neither user (0) nor group (1). */
export const INVALID_THREAD_TYPE = "Thread type is invalid";

// ── Small helpers ───────────────────────────────────────────────────────

/**
 * A group id as the wire carries it: Zalo's conversation prefix `g` taken off, always a string.
 *
 * @param {string|number} id - `"g<digits>"` or `"<digits>"`
 * @returns {string}
 */
export function bareGroupId(id) {
    const s = String(id ?? "");
    return /^g\d+$/.test(s) ? s.slice(1) : s;
}

/**
 * A thread type as 0 (user) or 1 (group); none means user, as before. Anything else is refused before a request.
 *
 * @param {unknown} type
 * @returns {0|1}
 * @throws {ZaloApiError} "Thread type is invalid"
 */
export function threadTypeOf(type) {
    if (type === undefined || type === null) return THREAD_TYPE.USER;
    const n = Number(type);
    if (type !== "" && (n === THREAD_TYPE.USER || n === THREAD_TYPE.GROUP)) return n;
    throw new ZaloApiError(INVALID_THREAD_TYPE);
}

/**
 * A board object's `params` as an object: a JSON string is opened, an object kept, anything else is `{}`.
 *
 * @param {unknown} params
 * @returns {object}
 */
export function paramsObject(params) {
    if (params && typeof params === "object") return params;
    if (typeof params === "string" && params) {
        try {
            const v = JSON.parse(params);
            return v && typeof v === "object" ? v : {};
        } catch {
            return {};
        }
    }
    return {};
}

/**
 * Open a JSON-string `params` of one board object in place (what the CLI's `params.title` and MCP's results read).
 * A string that is not JSON is left as it came.
 *
 * @param {any} item
 * @returns {any} the same item
 */
export function openParams(item) {
    if (item && typeof item === "object" && typeof item.params === "string") {
        try {
            item.params = JSON.parse(item.params);
        } catch {
            /* not JSON: kept as it came */
        }
    }
    return item;
}

/** A JSON string opened, anything else returned as it came. */
function maybeJson(data) {
    if (typeof data !== "string") return data;
    try {
        return JSON.parse(data);
    } catch {
        return data;
    }
}

/**
 * The cursor of the page after `items`: the id and board type of the last item with a positive id (a poll's id is
 * its `poll_id`). `{lastId: 0, lastType: 0}` when there is none.
 *
 * @param {Array<{boardType?: number, data?: object}>} items
 * @returns {{lastId: number|string, lastType: number}}
 */
export function boardCursor(items) {
    let lastId = 0;
    let lastType = 0;
    for (const item of Array.isArray(items) ? items : []) {
        const d = item?.data;
        if (!d) continue;
        const type = Number(item.boardType);
        const id = type === BOARD_TYPE.POLL ? (d.poll_id ?? d.pollId) : d.id;
        if (id !== undefined && id !== null && Number(id) > 0) {
            lastId = id;
            lastType = type;
        }
    }
    return { lastId, lastType };
}

/**
 * Open the sealed `data` of a reply whose outer envelope said success, for a call where only the outer code
 * matters: no data at all is a success with nothing to return.
 *
 * @param {object} ctx - the session (`secretKey`)
 * @param {unknown} data - the outer envelope's `data`
 * @param {readonly string[]} keys - id keys to keep as strings
 * @returns {any} the inner `data`, or null
 * @throws {ZaloApiError} for data the session key cannot open, or an inner error (its code on `.code`)
 */
export function openOptionalReply(ctx, data, keys) {
    if (data === undefined || data === null || data === "") return null;
    const opened = openSession(ctx?.secretKey, data);
    let inner;
    try {
        if (opened === null) throw new Error("does not open");
        inner = JSON.parse(preParse(opened, keys));
    } catch {
        throw new ZaloApiError("Failed to parse response data");
    }
    const code = inner?.error_code;
    if (code !== undefined && code !== null && Number(code) !== 0) {
        const n = Number(code);
        throw new ZaloApiError(
            inner?.error_message ?? `Zalo answered error ${code}`,
            Number.isFinite(n) ? n : null,
            inner?.data ?? undefined,
        );
    }
    return inner?.data ?? null;
}

/**
 * Whether an error is Zalo's "no more" answer to a list: an error whose `data` is the string `"[]"`, which marks
 * the end of the list.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export function isEndOfList(e) {
    return e instanceof ZaloApiError && e.data === "[]";
}

/**
 * Run a list endpoint. Zalo's "no more" answer ({@link isEndOfList}) is the empty list the endpoint's own reader
 * makes of `"[]"`; every other error is thrown as it came.
 *
 * @param {object} target - a session handle `s`, or the api object
 * @param {object} def - a list definition (its `transform` reads `"[]"` as an empty list)
 * @param {object} args
 * @returns {Promise<any>}
 * @throws {ZaloApiError} Zalo's own error, other than the end of the list
 */
export async function callList(target, def, args) {
    try {
        return await callEndpoint(target, def, args);
    } catch (e) {
        if (isEndOfList(e)) return def.transform("[]", args);
        throw e;
    }
}

// ── Reply readers ───────────────────────────────────────────────────────

/**
 * A topic reply (a note or a group reminder): its `params` opened.
 *
 * @param {any} data
 * @returns {any}
 */
export function topicReply(data) {
    return openParams(data);
}

/**
 * A board list reply as `{items: [{boardType, data}], ...}`. An object with `items` keeps every other key; a JSON
 * string of a bare array is a list of notes. Every item but a poll has its `params` opened.
 *
 * @param {any} data
 * @returns {{items: Array<{boardType: number, data: object}>}}
 */
export function boardListReply(data) {
    const v = maybeJson(data);
    let out;
    if (Array.isArray(v)) out = { items: v.map((d) => ({ boardType: BOARD_TYPE.TOPIC, data: d })) };
    else if (v && typeof v === "object") out = Array.isArray(v.items) ? v : { ...v, items: [] };
    else out = { items: [] };
    for (const item of out.items) {
        if (Number(item?.boardType) !== BOARD_TYPE.POLL) openParams(item?.data);
    }
    return out;
}

/**
 * A group reminder list read from `/api/board/listReminder`: the reply (a JSON string) is a bare array or
 * `{items: [{boardType, data}]}`; the reminders are the topic items whose `startTime` is a positive number.
 *
 * The page's cursor is read before that filter:
 * the array carries it as a non-enumerable `page` property, `{lastId, size}`, the id (`reminderId`, else `id`) of
 * the page's last topic and how many topics the page held. {@link groupReminderPage} pages with it.
 *
 * @param {any} data
 * @returns {object[]} the reminders, `params` opened
 */
export function groupReminderListReply(data) {
    const v = maybeJson(data);
    let entries = [];
    if (Array.isArray(v)) entries = v.map((d) => ({ boardType: BOARD_TYPE.TOPIC, data: d }));
    else if (Array.isArray(v?.items)) entries = v.items;
    const topics = entries.filter((e) => Number(e?.boardType) === BOARD_TYPE.TOPIC && e.data).map((e) => e.data);
    const reminders = topics.filter((d) => typeof d.startTime === "number" && d.startTime > 0).map(openParams);
    const last = topics.at(-1);
    const lastId = last ? (last.reminderId ?? last.id ?? 0) : 0;
    Object.defineProperty(reminders, "page", { value: { lastId, size: topics.length } });
    return reminders;
}

/**
 * A DM reminder list (`/api/board/oneone/list`, board type 1): the reply (a JSON string) is an array of reminders,
 * each with its `reminderId`. An object with `items` is read too.
 *
 * @param {any} data
 * @returns {object[]} the reminders, `params` opened
 */
export function dmReminderListReply(data) {
    const v = maybeJson(data);
    let list = [];
    if (Array.isArray(v)) list = v;
    else if (Array.isArray(v?.items)) list = v.items.map((e) => (e && e.data && "boardType" in e ? e.data : e));
    return list.filter((r) => r && typeof r === "object").map(openParams);
}

/**
 * A DM's whole board (`/api/board/oneone/list`, board type 0) as `{items: [{boardType, data}]}`. An item that comes
 * without its board type is a reminder: Zalo files each one as a topic (board type 1) whose `id` is its
 * `reminderId`. Here the item keeps its `reminderId` too.
 *
 * @param {any} data
 * @returns {{items: Array<{boardType: number, data: object}>}}
 */
export function dmBoardReply(data) {
    const v = maybeJson(data);
    let list = [];
    if (Array.isArray(v)) list = v;
    else if (Array.isArray(v?.items)) list = v.items;
    else if (Array.isArray(v?.data?.items)) list = v.data.items;
    const items = list
        .filter((e) => e && typeof e === "object")
        .map((e) => {
            if ("boardType" in e && e.data) return e;
            return { boardType: BOARD_TYPE.TOPIC, data: { ...e, id: e.reminderId ?? e.id } };
        });
    for (const item of items) {
        if (Number(item.boardType) !== BOARD_TYPE.POLL) openParams(item.data);
    }
    return { items };
}

// ── Endpoint definitions ────────────────────────────────────────────────

/** A note's body: `grid, type, color, emoji, startTime, duration, params, ...` with the note's fixed values. */
const noteHead = (a) => ({
    grid: bareGroupId(a.groupId),
    type: 0,
    color: TOPIC_COLOR,
    emoji: "",
    startTime: -1,
    duration: -1,
    params: JSON.stringify({ title: a.title }),
});

/** `POST {group_board}/api/board/topic/createv2`, a note. */
export const NOTE_CREATE = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/topic/createv2",
    cmd: 12007,
    method: "post",
    body: (a, ctx) => ({ ...noteHead(a), repeat: 0, src: CREATE_SRC, imei: ctx.imei, pinAct: a.pin ? 1 : 0 }),
    reply: "session",
    transform: topicReply,
});

/** `POST {group_board}/api/board/topic/updatev2`, a note; `pinAct` 2 leaves the pin as it is. */
export const NOTE_UPDATE = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/topic/updatev2",
    cmd: 12008,
    method: "post",
    body: (a, ctx) => ({ ...noteHead(a), topicId: a.topicId, repeat: 0, imei: ctx.imei, pinAct: a.pin ? 1 : 2 }),
    reply: "session",
    transform: topicReply,
});

/** `GET {group_board}/api/board/list`: a group's notes, pinned messages and polls. */
export const BOARD_LIST = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/list",
    cmd: 12140,
    method: "get",
    body: (a, ctx) => ({
        group_id: bareGroupId(a.groupId),
        board_type: BOARD_TYPE.ALL,
        page: a.page,
        count: a.count,
        last_id: a.lastId,
        last_type: a.lastType,
        imei: ctx.imei,
    }),
    reply: "session",
    transform: boardListReply,
});

/** `POST {group_poll}/api/poll/create`. */
export const POLL_CREATE = Object.freeze({
    host: POLL_HOST,
    path: "/api/poll/create",
    cmd: 12080,
    method: "post",
    body: (a, ctx) => ({
        group_id: bareGroupId(a.groupId),
        question: a.question,
        options: a.options,
        expired_time: a.expiredTime,
        pinAct: false,
        allow_multi_choices: a.allowMultiChoices,
        allow_add_new_option: a.allowAddNewOption,
        is_hide_vote_preview: a.hideVotePreview,
        is_anonymous: a.isAnonymous,
        poll_type: 0,
        src: CREATE_SRC,
        imei: ctx.imei,
    }),
    reply: "session",
    bigIdKeys: POLL_ID_KEYS,
});

/** `GET {group_poll}/api/poll/detail`. */
export const POLL_DETAIL = Object.freeze({
    host: POLL_HOST,
    path: "/api/poll/detail",
    cmd: 12081,
    method: "get",
    body: (a, ctx) => ({ poll_id: a.pollId, imei: ctx.imei }),
    reply: "session",
    bigIdKeys: POLL_ID_KEYS,
});

/** `GET {group_poll}/api/poll/vote`: `option_ids` is the whole selection after the vote; empty removes it. */
export const POLL_VOTE = Object.freeze({
    host: POLL_HOST,
    path: "/api/poll/vote",
    cmd: 12084,
    method: "get",
    body: (a, ctx) => ({ poll_id: a.pollId, option_ids: a.optionIds, imei: ctx.imei }),
    reply: "session",
    bigIdKeys: POLL_ID_KEYS,
});

/** `POST {group_poll}/api/poll/end`: the reply is read by its outer code; `data` may be absent. */
export const POLL_LOCK = Object.freeze({
    host: POLL_HOST,
    path: "/api/poll/end",
    cmd: 12089,
    method: "post",
    body: (a, ctx) => ({ poll_id: a.pollId, imei: ctx.imei }),
    reply: "plain",
});

/** `POST {group_poll}/api/poll/share`. */
export const POLL_SHARE = Object.freeze({
    host: POLL_HOST,
    path: "/api/poll/share",
    cmd: 12085,
    method: "post",
    body: (a, ctx) => ({ poll_id: a.pollId, imei: ctx.imei }),
    reply: "session",
    bigIdKeys: POLL_ID_KEYS,
});

/** `GET {group_poll}/api/poll/option/add`, no imei. */
export const POLL_ADD_OPTIONS = Object.freeze({
    host: POLL_HOST,
    path: "/api/poll/option/add",
    cmd: 12083,
    method: "get",
    body: (a) => ({ poll_id: a.pollId, new_options: a.newOptions, voted_option_ids: a.votedOptionIds }),
    reply: "session",
    bigIdKeys: POLL_ID_KEYS,
});

/**
 * A group reminder's topic body, in the expected order:
 * `grid, type, color, emoji, startTime, duration, params, [topicId,] repeat, [src,] imei, pinAct`.
 */
function groupReminderBody(a, ctx, { update }) {
    const body = {
        grid: bareGroupId(a.threadId),
        type: 0,
        color: a.color,
        emoji: a.emoji,
        startTime: a.startTime,
        duration: -1,
        params: JSON.stringify(a.params),
    };
    if (update) body.topicId = a.topicId;
    body.repeat = a.repeat;
    if (!update) body.src = CREATE_SRC;
    body.imei = ctx.imei;
    body.pinAct = update ? 2 : 0;
    return body;
}

/**
 * A DM reminder's `objectData`, in the expected order: `toUid, creatorUid, type,
 * color, emoji, startTime, duration, params, needPin, repeat`, then `src` on a create or `reminderId` on an edit.
 */
function dmReminderObject(a, { update }) {
    const o = {
        toUid: String(a.threadId),
        creatorUid: a.creatorUid,
        type: 0,
        color: a.color,
        emoji: a.emoji,
        startTime: a.startTime,
        duration: -1,
        params: a.params,
        needPin: false,
        repeat: a.repeat,
    };
    if (update) o.reminderId = a.topicId;
    else o.src = CREATE_SRC;
    return JSON.stringify(o);
}

/** `POST {group_board}/api/board/topic/createv2`, a group reminder (a topic with a start time). */
export const REMINDER_CREATE_GROUP = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/topic/createv2",
    cmd: 12007,
    method: "post",
    body: (a, ctx) => groupReminderBody(a, ctx, { update: false }),
    reply: "session",
    bigIdKeys: REMINDER_ID_KEYS,
    transform: topicReply,
});

/** `POST {group_board}/api/board/topic/updatev2`, a group reminder, pin left as it is. */
export const REMINDER_UPDATE_GROUP = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/topic/updatev2",
    cmd: 12008,
    method: "post",
    body: (a, ctx) => groupReminderBody(a, ctx, { update: true }),
    reply: "session",
    bigIdKeys: REMINDER_ID_KEYS,
    transform: topicReply,
});

/** `POST {group_board}/api/board/oneone/create`: `{objectData, imei}`. */
export const REMINDER_CREATE_DM = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/oneone/create",
    cmd: 12429,
    method: "post",
    body: (a, ctx) => ({ objectData: dmReminderObject(a, { update: false }), imei: ctx.imei }),
    reply: "session",
    bigIdKeys: DM_REMINDER_ID_KEYS,
    transform: topicReply,
});

/** `POST {group_board}/api/board/oneone/update`: `{objectData}`, no imei. */
export const REMINDER_UPDATE_DM = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/oneone/update",
    cmd: 12430,
    method: "post",
    body: (a) => ({ objectData: dmReminderObject(a, { update: true }) }),
    reply: "session",
    bigIdKeys: DM_REMINDER_ID_KEYS,
    transform: topicReply,
});

/** `POST {group_board}/api/board/topic/remove`. */
export const REMINDER_REMOVE_GROUP = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/topic/remove",
    cmd: 12143,
    method: "post",
    body: (a, ctx) => ({ grid: bareGroupId(a.threadId), topicId: a.reminderId, imei: ctx.imei }),
    reply: "session",
});

/** `POST {group_board}/api/board/oneone/remove`: `{uid, reminderId}`, no imei. */
export const REMINDER_REMOVE_DM = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/oneone/remove",
    cmd: 12431,
    method: "post",
    body: (a) => ({ uid: a.threadId, reminderId: a.reminderId }),
    reply: "session",
});

/** `GET {group_board}/api/board/topic/getReminder`. */
export const REMINDER_GET = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/topic/getReminder",
    cmd: 12088,
    method: "get",
    body: (a, ctx) => ({ eventId: a.reminderId, imei: ctx.imei }),
    reply: "session",
    bigIdKeys: REMINDER_ID_KEYS,
    transform: topicReply,
});

/**
 * The group reminder list's `last_id` as the server expects it: a JSON number, a parsed Number (the board
 * reply has no big-id pass), so past 2^53 it goes out rounded. Live (2026-11-07), that is what pages correctly: Zalo
 * answers a value that is no reminder's id by page number, while the exact id of the page's last reminder, quoted or
 * bare, brings page 1 back again.
 *
 * @param {number|string} id - the cursor, 0 on page 1
 * @returns {number}
 */
function webLastId(id) {
    return typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
}

/** `GET {group_board}/api/board/listReminder`. */
export const REMINDER_LIST_GROUP = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/listReminder",
    cmd: 12425,
    method: "get",
    body: (a, ctx) => ({
        objectData: JSON.stringify({
            group_id: bareGroupId(a.threadId),
            board_type: BOARD_TYPE.TOPIC,
            page: a.page,
            count: a.count,
            last_id: webLastId(a.lastId),
            last_type: 0,
        }),
        imei: ctx.imei,
    }),
    reply: "session",
    bigIdKeys: REMINDER_ID_KEYS,
    transform: groupReminderListReply,
});

/**
 * `GET {group_board}/api/board/oneone/list`: `{objectData}`, no imei.
 * Board type 1 is the reminders, 0 every kind of item.
 */
export const ONEONE_LIST = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/oneone/list",
    cmd: 12432,
    method: "get",
    body: (a) => ({
        objectData: JSON.stringify({
            uid: String(a.threadId),
            board_type: a.boardType,
            page: a.page,
            count: a.count,
            last_id: 0,
            last_type: 0,
        }),
    }),
    reply: "session",
    bigIdKeys: DM_REMINDER_ID_KEYS,
    transform: (data, a) => (a.boardType === BOARD_TYPE.ALL ? dmBoardReply(data) : dmReminderListReply(data)),
});

/** `GET {group_board}/api/board/topic/listResponseEvent`: `{eventId}`, no imei. */
export const REMINDER_RESPONSES = Object.freeze({
    host: BOARD_HOST,
    path: "/api/board/topic/listResponseEvent",
    cmd: 12086,
    method: "get",
    body: (a) => ({ eventId: a.reminderId }),
    reply: "session",
    bigIdKeys: RESPONSE_ID_KEYS,
});

// ── Calls that are more than one request ────────────────────────────────

/**
 * List a 1-1 conversation's whole board (notes, pinned messages, reminders): `/api/board/oneone/list` with board
 * type 0, which is what Zalo asks. Usable with a session handle or a logged-in api object.
 *
 * @param {object} target - a session handle `s`, or the api object (`getContext()`, `zpwServiceMap`)
 * @param {string} threadId - the other user's id
 * @param {number} [page] - from 1
 * @param {number} [pageSize] - items per page
 * @returns {Promise<{items: Array<{boardType: number, data: object}>}>}
 * @throws {ZaloApiError} Zalo's own error
 */
export function listOneOneBoard(target, threadId, page = 1, pageSize = PAGE_SIZE) {
    return callList(target, ONEONE_LIST, { threadId, boardType: BOARD_TYPE.ALL, page, count: pageSize });
}

/**
 * The reminder an edit starts from: a group one by `getReminder`, a DM one found in the DM list.
 *
 * @param {import("../api.js").Session} s
 * @param {string|number} reminderId
 * @param {string} threadId
 * @param {0|1} type
 * @returns {Promise<object>}
 * @throws {ZaloApiError} when a DM list has no reminder with that id
 */
async function currentReminder(s, reminderId, threadId, type) {
    if (type === THREAD_TYPE.GROUP) return (await s.call(REMINDER_GET, { reminderId })) ?? {};
    const want = String(reminderId);
    for (let page = 1; page <= EDIT_LOOKUP_PAGES; page++) {
        const list = await callList(s, ONEONE_LIST, { threadId, boardType: BOARD_TYPE.TOPIC, page, count: PAGE_SIZE });
        const found = list.find((r) => String(r.reminderId ?? r.id) === want);
        if (found) return found;
        if (list.length < PAGE_SIZE) break;
    }
    throw new ZaloApiError("The reminder to edit was not found in this conversation");
}

/**
 * The creator a DM reminder edit sends back: the loaded reminder's (`creatorUid`, else `creatorId`), else this
 * account, which is the only one that can have made a reminder it finds with no creator.
 *
 * @param {object} reminder - the loaded reminder
 * @param {string|number} ownId
 * @returns {string}
 */
export function creatorOf(reminder, ownId) {
    for (const v of [reminder?.creatorUid, reminder?.creatorId]) {
        if (v !== undefined && v !== null && v !== "") return String(v);
    }
    return String(ownId);
}

/**
 * The option ids the caller has voted for on a poll (the options whose voters
 * include this account, or that say `voted`).
 *
 * @param {any} poll - a poll detail
 * @param {string} ownId
 * @returns {Array<number|string>}
 */
export function votedOptionIds(poll, ownId) {
    const out = [];
    for (const o of Array.isArray(poll?.options) ? poll.options : []) {
        const id = o?.option_id;
        if (id === undefined || id === null || !(Number(id) > 0)) continue;
        const voters = Array.isArray(o.voters) ? o.voters.map(String) : [];
        if (o.voted === true || voters.includes(String(ownId))) out.push(id);
    }
    return out;
}

/**
 * One page of a group's board, reached the way Zalo pages it: page 2 and later carry the cursor of the page
 * before (`boardCursor`), so the pages before the one asked are read first. An empty page on the way means there is
 * nothing after it, and `{items: []}` is the answer without asking further. A short page does not: with the cursor,
 * Zalo can answer fewer items than asked while more follow (live, 2026-11-07), so paging stops only when empty.
 *
 * @param {{getListBoard: Function}} api - a logged-in api
 * @param {string} groupId
 * @param {number} [page] - from 1
 * @param {number} [count] - items per page
 * @returns {Promise<{items: Array<{boardType: number, data: object}>}>}
 * @throws {ZaloApiError} Zalo's own error, from any page on the way
 */
export async function boardPage(api, groupId, page = 1, count = PAGE_SIZE) {
    let cursor = { lastId: 0, lastType: 0 };
    for (let p = 1; p < page; p++) {
        const items = (await api.getListBoard({ page: p, count, ...cursor }, groupId))?.items ?? [];
        if (items.length === 0) return { items: [] };
        cursor = boardCursor(items);
    }
    return api.getListBoard({ page, count, ...cursor }, groupId);
}

/**
 * One page of a group's reminders, reached the way Zalo pages them: page 2 and later carry `lastId`, the id of
 * the last topic of the page before (read off the reply, {@link groupReminderListReply}), so the pages before the one
 * asked are read first. An empty page means there is nothing after it; a short one does not, since a page asked
 * with the cursor can hold fewer than asked while more follow (paging stops only at an empty page). A DM's reminders
 * have no cursor (`last_id` is always 0 there) and are asked for by page number alone.
 *
 * @param {{getListReminder: Function}} api - a logged-in api
 * @param {string} groupId
 * @param {number} [page] - from 1
 * @param {number} [count] - reminders per page
 * @returns {Promise<object[]>} the reminders
 * @throws {ZaloApiError} Zalo's own error, from any page on the way
 */
export async function groupReminderPage(api, groupId, page = 1, count = PAGE_SIZE) {
    let lastId = 0;
    for (let p = 1; p < page; p++) {
        const list = await api.getListReminder({ page: p, count, lastId }, groupId, THREAD_TYPE.GROUP);
        const got = Array.isArray(list) ? list : [];
        const size = got.page?.size ?? got.length;
        if (size === 0) return [];
        const last = got.at(-1);
        lastId = got.page?.lastId ?? last?.reminderId ?? last?.id ?? 0;
    }
    return api.getListReminder({ page, count, lastId }, groupId, THREAD_TYPE.GROUP);
}

/**
 * The board calls, bound to one session handle.
 *
 * @param {import("../api.js").Session} s
 * @returns {Record<string, Function>}
 */
export function boardMethods(s) {
    return {
        /**
         * Create a note in a group.
         *
         * @param {{title: string, pinAct?: boolean}} options - `pinAct` pins it
         * @param {string} groupId
         * @returns {Promise<object>} the note, `params` opened
         */
        createNote: (options, groupId) =>
            s.call(NOTE_CREATE, { groupId, title: options?.title, pin: Boolean(options?.pinAct) }),

        /**
         * Change a group note's title. `pinAct` true pins it; false leaves the pin as it is (never unpins).
         *
         * @param {{title: string, topicId: string|number, pinAct?: boolean}} options
         * @param {string} groupId
         * @returns {Promise<object>} the note, `params` opened
         */
        editNote: (options, groupId) =>
            s.call(NOTE_UPDATE, {
                groupId,
                title: options?.title,
                topicId: options?.topicId,
                pin: Boolean(options?.pinAct),
            }),

        /**
         * One page of a group's board: notes, pinned messages and polls. Page 2 and later take the cursor of the
         * page before (`boardCursor(items)`).
         *
         * @param {{page?: number, count?: number, lastId?: number|string, lastType?: number}} options
         * @param {string} groupId
         * @returns {Promise<{items: Array<{boardType: number, data: object}>}>}
         */
        getListBoard: (options, groupId) =>
            callList(s, BOARD_LIST, {
                groupId,
                page: options?.page ?? 1,
                count: options?.count ?? PAGE_SIZE,
                lastId: options?.lastId ?? 0,
                lastType: options?.lastType ?? 0,
            }),

        /**
         * Create a poll in a group.
         *
         * @param {{question: string, options: string[], expiredTime?: number, allowMultiChoices?: boolean,
         *   allowAddNewOption?: boolean, hideVotePreview?: boolean, isAnonymous?: boolean}} options -
         *   `expiredTime` in epoch ms, 0 for never
         * @param {string} groupId
         * @returns {Promise<object>} the poll
         */
        createPoll: (options, groupId) =>
            s.call(POLL_CREATE, {
                groupId,
                question: options?.question,
                options: options?.options,
                expiredTime: options?.expiredTime ?? 0,
                allowMultiChoices: Boolean(options?.allowMultiChoices),
                allowAddNewOption: Boolean(options?.allowAddNewOption),
                hideVotePreview: Boolean(options?.hideVotePreview),
                isAnonymous: Boolean(options?.isAnonymous),
            }),

        /**
         * A poll's detail.
         *
         * @param {number|string} pollId
         * @returns {Promise<object>}
         * @throws {ZaloApiError} "Missing poll id" before any request when there is none
         */
        getPollDetail: async (pollId) => {
            if (!pollId) throw new ZaloApiError("Missing poll id");
            return s.call(POLL_DETAIL, { pollId });
        },

        /**
         * Vote on a poll. The ids are the whole selection after the vote; an empty list removes this account's vote.
         *
         * @param {number|string} pollId
         * @param {Array<number|string>|number|string} optionIds
         * @returns {Promise<object>} the poll after the vote
         */
        votePoll: (pollId, optionIds) =>
            s.call(POLL_VOTE, { pollId, optionIds: Array.isArray(optionIds) ? optionIds : [optionIds] }),

        /**
         * Close a poll to further votes.
         *
         * @param {number|string} pollId
         * @returns {Promise<any>} what Zalo answered, null when nothing
         */
        lockPoll: async (pollId) => openOptionalReply(s.ctx, await s.call(POLL_LOCK, { pollId }), POLL_ID_KEYS),

        /**
         * Share a poll into its group's chat.
         *
         * @param {number|string} pollId
         * @returns {Promise<any>}
         */
        sharePoll: (pollId) => s.call(POLL_SHARE, { pollId }),

        /**
         * Add options to a poll. `votedOptionIds` is this account's whole selection afterwards; when it is empty or
         * absent, the poll is read first and the current votes are kept (Zalo expects them, and an empty list
         * would clear them), except on a single-choice poll where a new option is voted: that vote replaces the
         * old one, so none is kept (Zalo unchecks the others).
         *
         * @param {{pollId: number|string, options: Array<{content: string, voted?: boolean}>,
         *   votedOptionIds?: Array<number|string>}} payload
         * @returns {Promise<object>} the poll after the change
         */
        addPollOptions: async (payload) => {
            const pollId = payload?.pollId;
            const fresh = (Array.isArray(payload?.options) ? payload.options : []).map((o) => ({
                content: o?.content,
                voted: Boolean(o?.voted),
            }));
            let voted = Array.isArray(payload?.votedOptionIds) ? payload.votedOptionIds : [];
            if (voted.length === 0) {
                const poll = await s.call(POLL_DETAIL, { pollId });
                const replaced = !poll?.allow_multi_choices && fresh.some((o) => o.voted);
                voted = replaced ? [] : votedOptionIds(poll, s.ctx.uid);
            }
            return s.call(POLL_ADD_OPTIONS, { pollId, newOptions: JSON.stringify(fresh), votedOptionIds: voted });
        },

        /**
         * Create a reminder in a DM (type 0) or a group (type 1).
         *
         * @param {{title: string, emoji?: string, startTime?: number, repeat?: number}} options - `startTime` in
         *   epoch ms (now by default); `repeat` 0 none, 1 daily, 2 weekly, 3 monthly
         * @param {string} threadId
         * @param {number} [type] - 0 user (default), 1 group
         * @returns {Promise<object>} the reminder (a DM one has `reminderId`, a group one `id`)
         */
        createReminder: async (options, threadId, type) => {
            const kind = threadTypeOf(type);
            const a = {
                threadId,
                creatorUid: String(s.ctx.uid),
                color: TOPIC_COLOR,
                emoji: options?.emoji ?? REMINDER_EMOJI,
                startTime: options?.startTime ?? s.now(),
                params: { title: options?.title },
                repeat: options?.repeat ?? 0,
            };
            return s.call(kind === THREAD_TYPE.GROUP ? REMINDER_CREATE_GROUP : REMINDER_CREATE_DM, a);
        },

        /**
         * Change a reminder. The reminder is read first, and every field not given keeps its current value.
         *
         * @param {{topicId: string|number, title?: string, emoji?: string, startTime?: number, repeat?: number}}
         *   options - `topicId` is the reminder's id
         * @param {string} threadId
         * @param {number} [type] - 0 user (default), 1 group
         * @returns {Promise<object>}
         * @throws {ZaloApiError} when a DM reminder with that id is not in the conversation's list
         */
        editReminder: async (options, threadId, type) => {
            const kind = threadTypeOf(type);
            const topicId = options?.topicId;
            const cur = await currentReminder(s, topicId, threadId, kind);
            const curParams = paramsObject(cur.params);
            const a = {
                threadId,
                topicId,
                creatorUid: creatorOf(cur, s.ctx.uid),
                color: typeof cur.color === "number" ? cur.color : TOPIC_COLOR,
                emoji: options?.emoji ?? cur.emoji ?? REMINDER_EMOJI,
                startTime: options?.startTime ?? cur.startTime ?? s.now(),
                params: { ...curParams, title: options?.title ?? curParams.title },
                repeat: options?.repeat ?? cur.repeat ?? 0,
            };
            return s.call(kind === THREAD_TYPE.GROUP ? REMINDER_UPDATE_GROUP : REMINDER_UPDATE_DM, a);
        },

        /**
         * Remove a reminder.
         *
         * @param {string|number} reminderId
         * @param {string} threadId
         * @param {number} [type] - 0 user (default), 1 group
         * @returns {Promise<any>}
         */
        removeReminder: async (reminderId, threadId, type) => {
            const kind = threadTypeOf(type);
            return s.call(kind === THREAD_TYPE.GROUP ? REMINDER_REMOVE_GROUP : REMINDER_REMOVE_DM, {
                reminderId,
                threadId,
            });
        },

        /**
         * A group reminder's detail, its `params` opened.
         *
         * @param {string|number} reminderId
         * @returns {Promise<object>}
         */
        getReminder: (reminderId) => s.call(REMINDER_GET, { reminderId }),

        /**
         * One page of a conversation's reminders. A group's page 2 and later take `lastId`, the id of the last
         * reminder of the page before.
         *
         * @param {{page?: number, count?: number, lastId?: number|string}} options
         * @param {string} threadId
         * @param {number} [type] - 0 user (default), 1 group
         * @returns {Promise<object[]>} the reminders, `params` opened
         */
        getListReminder: async (options, threadId, type) => {
            const kind = threadTypeOf(type);
            const page = options?.page ?? 1;
            const count = options?.count ?? PAGE_SIZE;
            if (kind === THREAD_TYPE.GROUP) {
                return callList(s, REMINDER_LIST_GROUP, { threadId, page, count, lastId: options?.lastId ?? 0 });
            }
            return callList(s, ONEONE_LIST, { threadId, boardType: BOARD_TYPE.TOPIC, page, count });
        },

        /**
         * Who accepted and who declined a group reminder.
         *
         * @param {string|number} reminderId
         * @returns {Promise<{acceptMember?: string[], rejectMember?: string[]}>}
         */
        getReminderResponses: (reminderId) => s.call(REMINDER_RESPONSES, { reminderId }),

        /**
         * A 1-1 conversation's whole board: notes, pinned messages and reminders.
         *
         * @param {string} threadId - the other user's id
         * @param {number} [page] - from 1
         * @param {number} [pageSize] - items per page
         * @returns {Promise<{items: Array<{boardType: number, data: object}>}>}
         */
        listOneOneBoard: (threadId, page, pageSize) => listOneOneBoard(s, threadId, page, pageSize),
    };
}
