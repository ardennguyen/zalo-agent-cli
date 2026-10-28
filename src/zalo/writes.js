/**
 * The state-changing endpoints Zalo Web calls and this client did not (plan track S, 6.2), built on the same request
 * path as the reads (./web-call.js, ./reads.js).
 *
 * Every entry is one request of the web client's API module (`fBUP`, 2026-10-23 bundle), with the host, path, command
 * id and body written out from the method of the same purpose. Unlike the reads, **each of these changes something**:
 * who sees a pin or a reminder, who is in a group, what a friend list or a block list says.
 * So:
 *
 * - `verified` means a live success was seen (P7a, 2026-10-27, on a disposable group); an entry without it says why in
 *   its `note`. A failure of an unverified one says "not accepted", not "broken".
 * - `risk` says what a call touches: `private` (this account's own data), `visible` (other people see it) or
 *   `destructive` (it removes something that cannot be put back from here).
 * - {@link callWrite} sends nothing under `dryRun`: it returns the request it would have sent, with the body decrypted.
 *   The command and the MCP tool both make a person or an agent say yes (`--yes`, `confirm: true`) before a real call.
 *
 * Not here, on purpose, and why (traced in the 2026-10-23 bundles during the closing sweep):
 * - `sendpt`, `sharefile`, `sendmp3`/`voicemp3`, `upthumb` and the local-GIF chunk send: the web client never calls them
 *   (dead code) or zca-js already makes the same request (`asyncfile/*`, `photo_original/*`, the `upthumb` + `gif` chunks);
 * - `photo_url`: it only lets a forward skip the download and re-upload; `msg forward` reaches the same result;
 * - the video chunk uploads: the web composer sends a local video as a file (`msg send-file`); only its forward-with-
 *   reupload flow uses them;
 * - the receipts (`seen`, `delivered` legacy forms, reaction receipts, `subtab/seen`): they change what other people
 *   see, and the v2 forms are already sent;
 * - `closefr/update` and `profile/mode`: Zalo answers 404, and the web client's own toggle is an empty function;
 * - `mediastore/remove` and `media/oneone/remove` (they need ids only the media store's own list gives),
 *   `sticker/personalized/update` (an ordering of the sticker packs), the v1 variants the web client has replaced
 *   (`pin`, `topic/create`, `group/create`, `group/invite`), `action/query` (an analytics hook): no use for them here;
 * - credential and account flows (password, 2FA, `exta/rnw`, login), the zBusiness and eKYC calls, LAN friends (off by
 *   default), voice and video calls, the E2EE message stack, and the zCloud calls that spend money or acknowledge the
 *   onboarding (plan S10, Z3): not implemented on purpose;
 * - AI translate: dropped until it has its own capture (D5).
 */
import { CallUsageError, arg, buildCall, enumNum, list, num, runCall } from "./web-call.js";

/**
 * The enums behind the numbers the web client sends, read from its constant modules (2026-10-23 bundle). A name or the
 * number is accepted for each.
 */
export const ENUMS = {
    /** A board item's type (a topic's `type`, and what a pin names). */
    topic: { text: 0, link: 1, message: 2, poll: 3, reminder: 4 },
    /** A reminder invitation's answer. */
    rsvp: { none: 0, accept: 1, reject: 2 },
    /** Where a multi-group removal was started from. */
    interaction: { unknown: -1, profile: 0, mediaStore: 1, contextMenu: 2, operate: 3, reviewRetry: 4, suggestion: 5 },
};

const named = (values) =>
    Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");

/** Strip the web's `g` prefix from a group conversation id. */
const bareGroupId = (id) => (String(id).startsWith("g") ? String(id).slice(1) : String(id));

/** The repeat frequencies of a reminder, and the legacy `repeat` code the client sends beside the rule. */
const REPEAT_CODES = { DAILY: 1, WEEKLY: 2, MONTHLY: 3, YEARLY: 4 };
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** The frequency of a repeat rule given as `{freq}` or as a bare frequency name. */
function repeatFreq(rule) {
    const freq = String(typeof rule === "object" ? rule.freq : rule).toUpperCase();
    if (!REPEAT_CODES[freq])
        throw new CallUsageError(`repeat frequency "${freq}" is not one of: ${Object.keys(REPEAT_CODES).join(", ")}`);
    return freq;
}

/** A repeat rule as the web client serializes it: a JSON array of one RRULE string (the interval is always 1). */
function serializeRepeatRule(rule) {
    const freq = repeatFreq(rule);
    const days =
        freq === "WEEKLY" && typeof rule === "object" && rule.byDay
            ? list(rule.byDay).map((d) => String(d).toUpperCase())
            : [];
    for (const d of days)
        if (!WEEKDAYS.includes(d)) throw new CallUsageError(`weekday "${d}" is not one of: ${WEEKDAYS.join(", ")}`);
    const ordered = WEEKDAYS.filter((d) => days.includes(d));
    return JSON.stringify([`RRULE:FREQ=${freq};INTERVAL=1;${ordered.length ? `BYDAY=${ordered.join(",")};` : ""}`]);
}

/** What a topic (note, reminder) body carries, as the web client's revamp builder writes it. */
function topicBody(a, ctx, { update }) {
    const body = {
        grid: bareGroupId(a.groupId),
        type: enumNum(a.type, ENUMS.topic),
        color: a.color ? Number(a.color) : -16777216,
        emoji: a.emoji || "",
        startTime: a.startTime ? Number(a.startTime) : -1,
        duration: a.duration ? Number(a.duration) : -1,
        // The client sends an empty object, not an empty string, when there are no params.
        params: a.params || a.onlyMe ? JSON.stringify({ ...a.params, ...(a.onlyMe && { onlyMe: 1 }) }) : {},
        repeat: a.repeatRule ? REPEAT_CODES[repeatFreq(a.repeatRule)] : num(a.repeat, 0),
        imei: ctx.imei,
    };
    if (update) {
        body.topicId = String(a.topicId);
        body.pinAct = num(a.pinAct, 2);
    } else {
        if (a.src !== undefined) body.src = Number(a.src);
        body.pinAct = a.pinAct === undefined ? undefined : Number(a.pinAct);
    }
    // The two fields of this build: the client sends both together, the rule serialized, onlyMe as 0 or 1.
    if (a.repeatRule !== undefined || a.onlyMe !== undefined) {
        body.repeatRule = a.repeatRule ? serializeRepeatRule(a.repeatRule) : "";
        body.onlyMe = a.onlyMe ? 1 : 0;
    }
    return body;
}

/** The arguments of a GIF send: what the picker's result carries (its `original`, `normal` thumbnail and id). */
const GIF_ARGS = (group) => [
    group ? arg("groupId", "string", "group id", true) : arg("toId", "string", "the other user's id", true),
    arg("href", "string", "the GIF's address (the result's `original.url`)", true),
    arg("thumb", "string", "the thumbnail's address (the result's `normal.url`)", true),
    arg("width", "number", "width of the original", true),
    arg("height", "number", "height of the original", true),
    arg("contentId", "string", "the GIF's id (the result's `id`)"),
    arg("src", "number", "where it was picked (the client's own source code; left out when not given)"),
];

/** What a GIF send carries, as the web client's sender writes it. */
function gifBody(a, group) {
    const body = {
        thumb: String(a.thumb),
        width: num(a.width),
        height: num(a.height),
        msg: "",
        type: 0,
        href: String(a.href),
        ...(a.contentId !== undefined && { contentId: String(a.contentId) }),
        ...(group && { visibility: 0 }),
        ...(a.src !== undefined && { src: Number(a.src) }),
    };
    if (group) body.grid = bareGroupId(a.groupId);
    else body.toid = String(a.toId);
    body.clientId = JSON.stringify(Date.now());
    return body;
}

const TOPIC_ARGS = [
    arg("groupId", "string", "group id", true),
    arg("type", "number", `topic type: ${named(ENUMS.topic)}`, true, ENUMS.topic),
    arg("params", "json", "the topic's content object, as the client builds it (title, …)"),
    arg("color", "number", "colour (default: black)"),
    arg("emoji", "string", "emoji"),
    arg("startTime", "number", "start, epoch ms (default: none)"),
    arg("duration", "number", "duration (default: none)"),
    arg("repeat", "number", "repeat code (0: none)"),
    arg("repeatRule", "json", "repeat rule: `{freq: DAILY|WEEKLY|MONTHLY|YEARLY[, byDay: [MO, TU, …]]}` (weekly only)"),
    arg("onlyMe", "boolean", "visible to this account only (a feature of this build; the server may ignore it)"),
    arg("pinAct", "number", "pin action: 1 pin, 2 do not"),
];

/**
 * @typedef {import("./reads.js").ReadDef & {risk: "private"|"visible"|"destructive"}} WriteDef
 */

/** @type {Record<string, WriteDef>} */
export const WRITES = {
    // ── messages ───────────────────────────────────────────────────────────
    "multi-undo": {
        host: "chat",
        path: "/api/message/multi_undo",
        cmd: 12115,
        method: "post",
        risk: "visible",
        what: "Recall several of your messages in a one-to-one conversation at once",
        args: [
            arg("toId", "string", "the other user's id", true),
            arg(
                "msgs",
                "json",
                "array of `{cliMsgIdUndo, globalMsgId[, cliMsgId]}`: the client id and global id of each message to recall",
                true,
            ),
        ],
        body: (a) => ({ toid: String(a.toId), msgs: multiUndoMsgs(a.msgs) }),
        verified: true,
    },
    "multi-undo-group": {
        host: "group",
        path: "/api/group/multi_undomsg",
        cmd: 12116,
        method: "post",
        risk: "visible",
        what: "Recall several of your messages in a group at once",
        args: [
            arg("groupId", "string", "group id", true),
            arg("msgs", "json", "array of `{cliMsgIdUndo, globalMsgId[, cliMsgId]}`, as for multi-undo", true),
        ],
        body: (a) => ({ grid: bareGroupId(a.groupId), msgs: multiUndoMsgs(a.msgs) }),
        verified: true,
    },
    "sync-action-media": {
        host: "sync_action",
        path: "/api/sync_action/media",
        cmd: 16213,
        method: "post",
        risk: "private",
        what: "Tell Zalo about media actions taken on this device (the client's own media sync list)",
        args: [arg("actions", "json", "the sync list, as the client builds it (array)", true)],
        body: (a, ctx) => ({ syncList: JSON.stringify(list(a.actions)), imei: ctx.imei }),
        verified: true,
        note: "answered with an empty list; what a non-empty list does is not known",
    },

    "voice-to-text": {
        host: "ai_features",
        path: "/api/aifeatures/voice2text",
        cmd: 13394,
        method: "post",
        risk: "private",
        what: "Ask Zalo to turn a voice message into text; the answer is a request id, and the text arrives later as a push on the socket (the listener records it: `read run voice-transcript`)",
        args: [arg("url", "string", "the voice message's file address (from its cached message)", true)],
        body: (a) => ({ url: String(a.url) }),
        verified: true,
    },
    "gif-send": {
        host: "file",
        path: "/api/message/gif",
        cmd: 11292,
        method: "post",
        risk: "visible",
        what: "Send a GIF to a user by reference, the way the GIF picker does (a result of `read run gif-search` or `gif-trending`)",
        args: GIF_ARGS(false),
        body: (a) => gifBody(a, false),
        verified: true,
    },
    "gif-send-group": {
        host: "file",
        path: "/api/group/gif",
        cmd: 11194,
        method: "post",
        risk: "visible",
        what: "Send a GIF to a group by reference, the way the GIF picker does",
        args: GIF_ARGS(true),
        body: (a) => gifBody(a, true),
        verified: true,
    },

    // ── boards: reminders, notes, pins (group_board host) ──────────────────
    "topic-response": {
        host: "group_board",
        path: "/api/board/topic/updateEventResponse",
        cmd: 12087,
        method: "post",
        risk: "visible",
        what: "Answer a group reminder's invitation (RSVP): going, not going, …",
        args: [
            arg("groupId", "string", "group id", true),
            arg("eventId", "string", "the reminder's event id", true),
            arg("type", "number", `the answer: ${named(ENUMS.rsvp)}`, true, ENUMS.rsvp),
        ],
        body: (a, ctx) => ({
            grid: bareGroupId(a.groupId),
            type: enumNum(a.type, ENUMS.rsvp),
            eventId: String(a.eventId),
            imei: ctx.imei,
        }),
        verified: true,
    },
    "topic-create": {
        host: "group_board",
        path: "/api/board/topic/createv2",
        cmd: 12007,
        method: "post",
        risk: "visible",
        what: "Create a group note or reminder, with the repeat rule and only-me options of this build",
        args: TOPIC_ARGS,
        body: (a, ctx) => topicBody(a, ctx, { update: false }),
        verified: true,
    },
    "topic-update": {
        host: "group_board",
        path: "/api/board/topic/updatev2",
        cmd: 12008,
        method: "post",
        risk: "visible",
        what: "Change a group note or reminder, with the repeat rule and only-me options of this build",
        args: [...TOPIC_ARGS, arg("topicId", "string", "the topic to change", true)],
        body: (a, ctx) => topicBody(a, ctx, { update: true }),
        verified: true,
    },
    "topic-remove": {
        host: "group_board",
        path: "/api/board/topic/remove",
        cmd: 12143,
        method: "post",
        risk: "destructive",
        what: "Remove a group note or reminder",
        args: [arg("groupId", "string", "group id", true), arg("topicId", "string", "the topic to remove", true)],
        body: (a, ctx) => ({ grid: bareGroupId(a.groupId), topicId: String(a.topicId), imei: ctx.imei }),
        verified: true,
    },
    pin: {
        host: "group_board",
        path: "/api/board/pinv2",
        cmd: 12004,
        risk: "visible",
        what: "Pin a board item (a note, a poll, a message) in a group",
        args: [
            arg("groupId", "string", "group id", true),
            arg("topicId", "string", "the item to pin", true),
            arg("type", "number", `the item's type: ${named(ENUMS.topic)}`, true, ENUMS.topic),
        ],
        body: (a) => ({ grid: bareGroupId(a.groupId), topicId: String(a.topicId), type: enumNum(a.type, ENUMS.topic) }),
        verified: true,
    },
    unpin: {
        host: "group_board",
        path: "/api/board/unpinv2",
        cmd: 12005,
        risk: "visible",
        what: "Unpin a board item in a group",
        args: [
            arg("groupId", "string", "group id", true),
            arg("topic", "string", "the pinned item to unpin (its id)", true),
            arg("topicType", "number", `its type: ${named(ENUMS.topic)} (default text)`, false, ENUMS.topic),
            arg("boardVersion", "number", "the pin board's version, from `read run pin-list`", true),
        ],
        body: (a, ctx) => ({
            grid: bareGroupId(a.groupId),
            imei: ctx.imei,
            topic: topicRef(a.topic, a.topicType),
            boardVersion: num(a.boardVersion),
        }),
        verified: true,
    },
    "pin-reorder": {
        host: "group_board",
        path: "/api/board/pin/update",
        cmd: 12002,
        method: "post",
        risk: "visible",
        what: "Reorder a group's pinned items",
        args: [
            arg("groupId", "string", "group id", true),
            arg("topics", "json", "the pinned items in their new order: ids, or `{topicId, topicType}` objects", true),
            arg("topicType", "number", `the type of items given as bare ids (default text)`, false, ENUMS.topic),
            arg("boardVersion", "number", "the pin board's version, from `read run pin-list`", true),
        ],
        body: (a) => ({
            groupId: bareGroupId(a.groupId),
            topics: list(a.topics).map((x) => topicRef(x, a.topicType)),
            boardVersion: num(a.boardVersion),
        }),
        verified: true,
    },
    "pin-reorder-1on1": {
        host: "friend_board",
        path: "/api/friendboard/reorder",
        cmd: 12068,
        method: "get",
        risk: "visible",
        what: "Reorder the pinned items of a one-to-one conversation (the one-to-one pin board of this build)",
        args: [
            arg("userId", "string", "the other user's id", true),
            arg("topics", "json", "the pinned items in their new order: ids, or `{topicId, topicType}` objects", true),
            arg("topicType", "number", `the type of items given as bare ids (default text)`, false, ENUMS.topic),
            arg("version", "number", "the board's version", true),
            arg("lang", "string", "client language, vi or en (default vi)"),
        ],
        body: (a, ctx) => ({
            conversationId: String(a.userId),
            topics: list(a.topics).map((x) => topicRef(x, a.topicType)),
            version: num(a.version),
            lang: a.lang === "en" ? "en" : "vi",
            imei: ctx.imei,
        }),
        verified: true,
    },
    "unpin-many": {
        host: "group_board",
        path: "/api/board/multi_unpin",
        cmd: 12010,
        risk: "visible",
        what: "Unpin several of a group's pinned items at once",
        args: [
            arg("groupId", "string", "group id", true),
            arg("topics", "json", "the pinned items to unpin: ids, or `{topicId, topicType}` objects", true),
            arg("topicType", "number", `the type of items given as bare ids (default text)`, false, ENUMS.topic),
            arg("boardVersion", "number", "the pin board's version, from `read run pin-list`", true),
        ],
        body: (a) => ({
            grid: bareGroupId(a.groupId),
            topics: list(a.topics).map((x) => topicRef(x, a.topicType)),
            boardVersion: num(a.boardVersion),
        }),
        verified: true,
    },

    // ── friends and profile ────────────────────────────────────────────────
    "contact-tab-read": {
        host: "friend",
        path: "/api/friend/read-contact-tab",
        cmd: 12231,
        method: "post",
        risk: "private",
        what: "Mark the contact tab as read up to a time",
        args: [arg("ts", "number", "epoch ms", true)],
        body: (a) => ({ ts: num(a.ts) }),
        verified: true,
    },
    "recommend-remove": {
        host: "friend",
        path: "/api/friend/recommendsv2/remove",
        cmd: 11438,
        method: "post",
        risk: "private",
        what: "Remove an account from the suggested-friends list",
        args: [
            arg("userId", "string", "the suggested account", true),
            arg("src", "number", "where it was suggested from, as the client sends it", true),
            arg("type", "number", "the suggestion type, as the client sends it", true),
        ],
        body: (a) => ({ uid: String(a.userId), src: num(a.src), type: num(a.type) }),
        verified: true,
        note: "seen working (2026-10-28): one suggestion removed from a list of 199, which then held 198 without it; src and type are the item's recommSrc and recommType from `friend recommendations --json` (1 and 1 for every suggestion seen); an unknown id is rejected with 114",
    },
    "recommend-seen": {
        host: "friend",
        path: "/api/friend/recommendsv2/read-requests",
        cmd: 12232,
        method: "post",
        risk: "visible",
        what: "Mark friend requests as seen (clears their unread badge)",
        args: [arg("userIds", "json", "the requesters' ids (array)", true)],
        body: (a) => ({ uids_seen: list(a.userIds).map(String) }),
        verified: true,
        note: "seen working (2026-10-28): the request's isSeenFriendReq went from false to true; the id is the requester's as the one who answers sees it (the request item's dataInfo.userId, which for someone who is not yet a friend is not his own id); request items have recommType 2; an unknown id is rejected with 114",
    },
    "oa-block": {
        host: "profile",
        path: "/api/social/oa/block",
        cmd: 12681,
        method: "post",
        risk: "private",
        what: "Block an Official Account",
        args: [arg("oaId", "string", "the OA's id", true)],
        body: (a) => ({ oaid: String(a.oaId) }),
        verified: true,
        note: 'seen to take effect (2026-10-27, Zalo Web as the witness): the block makes Zalo Web show "unblock to send messages to this OA" after a reload and mark a later message "cannot send, you blocked this OA"; the unblock lifts a block made in the web. No profile, mini-profile or block-list read shows the state, and the server still answers the send with success, so only Zalo Web shows it',
    },
    "oa-unblock": {
        host: "profile",
        path: "/api/social/oa/unblock",
        cmd: 12682,
        method: "post",
        risk: "private",
        what: "Unblock an Official Account",
        args: [arg("oaId", "string", "the OA's id", true)],
        body: (a) => ({ oaid: String(a.oaId) }),
        verified: true,
        note: 'seen to take effect (2026-10-27, Zalo Web as the witness): the block makes Zalo Web show "unblock to send messages to this OA" after a reload and mark a later message "cannot send, you blocked this OA"; the unblock lifts a block made in the web. No profile, mini-profile or block-list read shows the state, and the server still answers the send with success, so only Zalo Web shows it',
    },
    "blocksharing-update": {
        host: "conversation",
        path: "/api/conv/blocksharing/updateConvers",
        cmd: 12179,
        method: "post",
        risk: "visible",
        what: "Turn block sharing on or off for one conversation (see which have it with `read run blocksharing-list`)",
        args: [
            arg("threadId", "string", "the user's id, or the group's id (a `g` prefix is dropped)", true),
            arg("isGroup", "boolean", "true for a group", true),
            arg("enabled", "boolean", "true to turn it on, false to turn it off", true),
            arg("lang", "string", "client language, vi or en (default vi)"),
        ],
        body: (a) => ({
            threadId: bareGroupId(a.threadId),
            isGroup: a.isGroup ? 1 : 0,
            isEnabled: a.enabled ? 1 : 0,
            clientLang: a.lang === "en" ? "en" : "vi",
        }),
        note: "answers 829 (this feature is for zBusiness accounts only) on a personal account, so no success was seen; the list read answers",
    },
    "label-add": {
        host: "label",
        path: "/api/convlabel/manage/add",
        cmd: 12163,
        method: "post",
        risk: "private",
        what: "Create a conversation label, and tag conversations with it (the granular label calls of this build)",
        args: [
            arg("text", "string", "the label's name (1 to 30 characters)", true),
            arg("color", "string", "colour, a palette hex such as #0068FF", true),
            arg("emoji", "string", "emoji (the web client never sends one)"),
            arg("conversations", "json", "conversation ids to tag (a group's id as the web names it, `g` + id)"),
        ],
        body: (a) => ({
            labelInfo: JSON.stringify({
                text: String(a.text),
                color: String(a.color),
                ...(a.emoji && { emoji: a.emoji }),
            }),
            add: list(a.conversations).map(String),
        }),
        verified: true,
    },
    "label-update": {
        host: "label",
        path: "/api/convlabel/manage/update",
        cmd: 12164,
        method: "post",
        risk: "private",
        what: "Rename or recolor a label and tag or untag conversations",
        args: [
            arg("id", "number", "the label's id (from `label list`)", true),
            arg("text", "string", "the label's name", true),
            arg("color", "string", "colour, a palette hex", true),
            arg("offset", "number", "its position in the list", true),
            arg("add", "json", "conversation ids newly tagged"),
            arg("remove", "json", "conversation ids untagged"),
        ],
        body: (a) => ({
            labelInfo: JSON.stringify({
                id: num(a.id),
                text: String(a.text),
                color: String(a.color),
                offset: num(a.offset),
            }),
            add: list(a.add).map(String),
            remove: list(a.remove).map(String),
        }),
        verified: true,
    },
    "label-delete": {
        host: "label",
        path: "/api/convlabel/manage/delete",
        cmd: 12165,
        method: "post",
        risk: "destructive",
        what: "Delete labels (the conversations keep existing; the label and its tags are gone)",
        args: [arg("ids", "json", "label ids to delete (array of numbers)", true)],
        body: (a) => ({ labelIds: list(a.ids).map(Number) }),
        verified: true,
    },
    "label-reorder": {
        host: "label",
        path: "/api/convlabel/manage/reorder",
        cmd: 12166,
        method: "post",
        risk: "private",
        what: "Set the order of the labels",
        args: [arg("order", "json", "array of `{id, offset}`, one per label", true)],
        body: (a) => ({
            lsLabelInfo: JSON.stringify(list(a.order).map((x) => ({ id: num(x.id), offset: num(x.offset) }))),
        }),
        verified: true,
    },
    "recent-search-update": {
        host: "recent_search",
        path: "/api/recentsearch/update",
        cmd: 12126,
        method: "post",
        risk: "private",
        what: "Replace the search history Zalo keeps for the account",
        args: [
            arg(
                "listRecent",
                "json",
                "the recent items (array): as `recent-searches` returns them, or `{id, type[, last_update_time]}`",
                true,
            ),
            arg("version", "number", "the history version", true),
            arg("listKeyword", "json", "the recent keywords (array)"),
        ],
        body: (a, ctx) => ({
            list_recent: list(a.listRecent).map(recentItem),
            version: num(a.version),
            list_keyword: list(a.listKeyword),
            imei: ctx.imei,
        }),
        verified: true,
    },

    // ── groups ─────────────────────────────────────────────────────────────
    "group-kickout-multi": {
        host: "group",
        path: "/api/group/kickout/multi",
        cmd: 12606,
        risk: "destructive",
        what: "Remove one account from several groups at once (the groups it is in with this account)",
        args: [
            arg("groupIds", "json", "group ids (array)", true),
            arg("userId", "string", "the account to remove from each", true),
            arg(
                "srcInteraction",
                "number",
                `where it was started: ${named(ENUMS.interaction)}`,
                true,
                ENUMS.interaction,
            ),
        ],
        body: (a) => ({
            grids: list(a.groupIds).map(bareGroupId),
            member: String(a.userId),
            srcInteraction: enumNum(a.srcInteraction, ENUMS.interaction),
        }),
        verified: true,
    },
};

/** A search-history item as the web client submits it: `{id, type[, last_update_time]}`, a group without its `g`. */
function recentItem(x) {
    const raw = String(x.id ?? x.userId);
    const id = raw.startsWith("g") ? raw.slice(1) : raw;
    const type = x.type >= 0 ? Number(x.type) : x.isGroup ? 1 : 0;
    return x.last_update_time ? { id, type, last_update_time: x.last_update_time } : { id, type };
}

/** A pinned item as the web client names it to the pin endpoints: its id and its type. */
function topicRef(topic, type) {
    if (topic && typeof topic === "object") {
        return {
            topicId: String(topic.topicId ?? topic.id),
            topicType: enumNum(topic.topicType ?? topic.type ?? type, ENUMS.topic, 0),
        };
    }
    return { topicId: String(topic), topicType: enumNum(type, ENUMS.topic, 0) };
}

/** What a multi-recall sends per message: a fresh client id of its own, the original's client id, its global id. */
function multiUndoMsgs(msgs) {
    const now = Date.now();
    return list(msgs).map((m, i) => ({
        cliMsgId: String(m.cliMsgId ?? now + i),
        cliMsgIdUndo: String(m.cliMsgIdUndo),
        globalMsgId: String(m.globalMsgId),
    }));
}

/** Names of every write, sorted. */
export const WRITE_NAMES = Object.keys(WRITES).sort();

/**
 * Build the request of a write without sending it.
 *
 * @param {object} api - logged-in zca-js api
 * @param {string} name - a key of {@link WRITES}
 * @param {object} [args]
 * @returns {ReturnType<typeof buildCall>}
 * @throws {CallUsageError} for an unknown name or a missing argument
 */
export function buildWrite(api, name, args = {}) {
    const def = WRITES[name];
    if (!def) throw new CallUsageError(`unknown write "${name}"; known: ${WRITE_NAMES.join(", ")}`);
    return buildCall(api, def, name, args);
}

/**
 * Make a state-changing call, or, with `dryRun`, show the call without making it.
 *
 * @param {object} api - logged-in zca-js api
 * @param {string} name - a key of {@link WRITES}
 * @param {object} [args]
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{dryRun: true, request: {method: string, host: string, path: string, body: any}} | any>} Zalo's
 *   reply data; or, for a dry run, the request that would have been sent (body decrypted, nothing sent)
 * @throws {CallUsageError} for an unknown name or a missing argument, before any request
 */
export async function callWrite(api, name, args = {}, { dryRun = false } = {}) {
    const req = buildWrite(api, name, args);
    if (dryRun) {
        return {
            dryRun: true,
            request: { method: req.method, host: req.def.host, path: req.def.path, body: req.json ?? null },
        };
    }
    return runCall(api, req);
}

/**
 * The writes, for a person or an agent to choose from.
 *
 * @returns {Array<{name: string, what: string, risk: string, host: string, path: string, verified: boolean,
 *   args: Array<{name: string, type: string, required: boolean, desc: string}>}>}
 */
export function describeWrites() {
    return WRITE_NAMES.map((name) => {
        const d = WRITES[name];
        return {
            name,
            what: d.what,
            risk: d.risk,
            host: d.host,
            path: d.path,
            verified: d.verified,
            ...(d.note && { note: d.note }),
            args: d.args.map((a) => ({
                name: a.name,
                type: a.type,
                required: !!a.required,
                desc: a.desc,
                ...(a.values && { values: a.values }),
            })),
        };
    });
}
