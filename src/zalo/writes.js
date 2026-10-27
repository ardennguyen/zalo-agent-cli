/**
 * The state-changing endpoints Zalo Web calls and this client did not (plan track S, 6.2), built on the same request
 * path as the reads (./web-call.js, ./reads.js).
 *
 * Every entry is one request of the web client's API module (`fBUP`, 2026-10-23 bundle), with the host, path, command
 * id and body written out from the method of the same purpose. Unlike the reads, **each of these changes something**:
 * who sees a pin or a reminder, what is on a todo list, who is in a group, what a friend list or a block list says.
 * So:
 *
 * - `verified` means a live success was seen (P7a, 2026-10-27, on a disposable group); an entry without it says why in
 *   its `note`. A failure of an unverified one says "not accepted", not "broken".
 * - `risk` says what a call touches: `private` (this account's own data), `visible` (other people see it) or
 *   `destructive` (it removes something that cannot be put back from here).
 * - {@link callWrite} sends nothing under `dryRun`: it returns the request it would have sent, with the body decrypted.
 *   The command and the MCP tool both make a person or an agent say yes (`--yes`, `confirm: true`) before a real call.
 *
 * Not here, on purpose, and why: the message-sending endpoints that upload or re-send content (`photo_url`, `sendpt`,
 * `sharefile`, `sendmp3`/`voicemp3`, the GIF and video chunk uploads, `upthumb`) are multi-step flows whose requests
 * carry parameters the web client adds in a helper this pass did not trace, and zca-js already sends images, files and
 * videos by its own flows; `convlabel/manage/*` and `blocksharing/*` are driven from lazily loaded modules whose request
 * bodies are not in the bundle files read; `voice2text` has no client method in the build; the receipts
 * (`seen`, `delivered` legacy forms, `subtab/seen`) change what other people see and are already sent in their v2 forms.
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
    /** A todo's status. */
    todoStatus: { waiting: -1, inProcess: 0, done: 1 },
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

    // ── personal todos (boards host) ───────────────────────────────────────
    "todo-create": {
        host: "boards",
        path: "/api/board/personal/todo/create",
        cmd: 12413,
        method: "post",
        risk: "private",
        what: "Create a todo",
        args: [
            arg("todo", "json", "the todo object, as the client builds it (title, due time, …)", true),
            arg("src", "number", "where it was created from (-1)"),
        ],
        body: (a, ctx) => ({ ...a.todo, src: num(a.src, -1), imei: ctx.imei }),
        verified: false,
        note: "answers -69 (stop retry) on the test account: the todos feature is off for it, so the request shape is untested",
    },
    "todo-update": {
        host: "boards",
        path: "/api/board/personal/todo/update",
        cmd: 12414,
        method: "post",
        risk: "private",
        what: "Change a todo",
        args: [arg("todo", "json", "the todo object with its id, as the client builds it", true)],
        body: (a) => ({ ...a.todo }),
        verified: false,
        note: "answers -69 (stop retry) on the test account: the todos feature is off for it, so the request shape is untested",
    },
    "todo-status": {
        host: "boards",
        path: "/api/board/personal/todo/status",
        cmd: 12418,
        risk: "private",
        what: "Set a todo's status (open, finished)",
        args: [
            arg("id", "string", "todo id", true),
            arg("status", "number", `the status: ${named(ENUMS.todoStatus)}`, true, ENUMS.todoStatus),
        ],
        body: (a, ctx) => ({ id: String(a.id), status: enumNum(a.status, ENUMS.todoStatus), imei: ctx.imei }),
        verified: false,
        note: "answers -69 (stop retry) on the test account: the todos feature is off for it, so the request shape is untested",
    },
    "todo-ding": {
        host: "boards",
        path: "/api/board/personal/todo/ding",
        cmd: 12426,
        risk: "visible",
        what: "Ping (ding) the people on todos",
        args: [arg("taskIds", "json", "todo ids (array)", true)],
        body: (a) => ({ taskIds: list(a.taskIds).map(String) }),
        verified: false,
        note: "answers -69 (stop retry) on the test account: the todos feature is off for it, so the request shape is untested",
    },
    "todo-ding-ack": {
        host: "boards",
        path: "/api/board/personal/todo/dingack",
        cmd: 12427,
        risk: "visible",
        what: "Acknowledge a todo ping",
        args: [arg("taskIds", "json", "todo ids (array)", true)],
        body: (a) => ({ taskIds: list(a.taskIds).map(String) }),
        verified: false,
        note: "answers -69 (stop retry) on the test account: the todos feature is off for it, so the request shape is untested",
    },
    "todo-delete": {
        host: "boards",
        path: "/api/board/personal/delete",
        cmd: 12415,
        risk: "destructive",
        what: "Delete a todo",
        args: [arg("id", "string", "todo id", true)],
        body: (a) => ({ id: String(a.id) }),
        verified: false,
        note: "answers -69 (stop retry) on the test account: the todos feature is off for it, so the request shape is untested",
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
        verified: false,
        note: "alive: rejects an unknown id with 114; a success was not seen (it needs a real suggestion or Official Account)",
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
        verified: false,
        note: "alive: rejects an unknown id with 114; a success was not seen (it needs a real suggestion or Official Account)",
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
        verified: false,
        note: "alive: rejects an unknown id with 114; a success was not seen (it needs a real suggestion or Official Account)",
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
        verified: false,
        note: "alive: rejects an unknown id with 114; a success was not seen (it needs a real suggestion or Official Account)",
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
