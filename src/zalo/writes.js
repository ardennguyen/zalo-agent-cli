/**
 * The state-changing endpoints Zalo Web calls and this client did not (plan track S, 6.2), built on the same request
 * path as the reads (./web-call.js, ./reads.js).
 *
 * Every entry is one request of the web client's API module (`fBUP`, 2026-10-23 bundle), with the host, path, command
 * id and body written out from the method of the same purpose. Unlike the reads, **each of these changes something**:
 * who sees a pin or a reminder, what is on a todo list, who is in a group, what a friend list or a block list says.
 * So:
 *
 * - none is `verified`: no live account has answered any of them, and the first run of each should be on something
 *   disposable. A failure says "not accepted", not "broken".
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
import { CallUsageError, arg, buildCall, list, num, runCall } from "./web-call.js";

/** Strip the web's `g` prefix from a group conversation id. */
const bareGroupId = (id) => (String(id).startsWith("g") ? String(id).slice(1) : String(id));

/** What a topic (note, reminder) body carries, as the web client's revamp builder writes it. */
function topicBody(a, ctx, { update }) {
    const body = {
        grid: bareGroupId(a.groupId),
        type: num(a.type),
        color: a.color ? Number(a.color) : -16777216,
        emoji: a.emoji || "",
        startTime: a.startTime ? Number(a.startTime) : -1,
        duration: a.duration ? Number(a.duration) : -1,
        // The client sends an empty object, not an empty string, when there are no params.
        params: a.params ? JSON.stringify(a.params) : {},
        repeat: num(a.repeat, 0),
        imei: ctx.imei,
    };
    if (update) {
        body.topicId = String(a.topicId);
        body.pinAct = num(a.pinAct, 2);
    } else {
        if (a.src !== undefined) body.src = Number(a.src);
        body.pinAct = a.pinAct === undefined ? undefined : Number(a.pinAct);
    }
    if (a.repeatRule !== undefined) body.repeatRule = a.repeatRule;
    if (a.onlyMe !== undefined) body.onlyMe = a.onlyMe;
    return body;
}

const TOPIC_ARGS = [
    arg("groupId", "string", "group id", true),
    arg("type", "number", "topic type, as the client sends it (note, reminder, …)", true),
    arg("params", "json", "the topic's content object, as the client builds it (title, …)"),
    arg("color", "number", "colour (default: black)"),
    arg("emoji", "string", "emoji"),
    arg("startTime", "number", "start, epoch ms (default: none)"),
    arg("duration", "number", "duration (default: none)"),
    arg("repeat", "number", "repeat code (0: none)"),
    arg("repeatRule", "json", "repeat rule object (new in this build)"),
    arg("onlyMe", "boolean", "visible to this account only (new in this build)"),
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
        verified: false,
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
        verified: false,
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
        verified: false,
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
            arg("type", "number", "the answer code, as the client sends it", true),
        ],
        body: (a, ctx) => ({
            grid: bareGroupId(a.groupId),
            type: num(a.type),
            eventId: String(a.eventId),
            imei: ctx.imei,
        }),
        verified: false,
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
        verified: false,
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
        verified: false,
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
        verified: false,
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
            arg("type", "number", "the item's type, as the client sends it", true),
        ],
        body: (a) => ({ grid: bareGroupId(a.groupId), topicId: String(a.topicId), type: num(a.type) }),
        verified: false,
    },
    unpin: {
        host: "group_board",
        path: "/api/board/unpinv2",
        cmd: 12005,
        risk: "visible",
        what: "Unpin a board item in a group",
        args: [
            arg("groupId", "string", "group id", true),
            arg("topic", "string", "the pinned item to unpin", true),
            arg("boardVersion", "number", "the board version the client holds", true),
        ],
        body: (a, ctx) => ({
            grid: bareGroupId(a.groupId),
            imei: ctx.imei,
            topic: String(a.topic),
            boardVersion: num(a.boardVersion),
        }),
        verified: false,
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
            arg("topics", "json", "the pinned item ids in their new order (array)", true),
            arg("boardVersion", "number", "the board version the client holds", true),
        ],
        body: (a) => ({ groupId: bareGroupId(a.groupId), topics: list(a.topics), boardVersion: num(a.boardVersion) }),
        verified: false,
    },
    "unpin-many": {
        host: "group_board",
        path: "/api/board/multi_unpin",
        cmd: 12010,
        risk: "visible",
        what: "Unpin several of a group's pinned items at once",
        args: [
            arg("groupId", "string", "group id", true),
            arg("topics", "json", "the pinned item ids to unpin (array)", true),
            arg("boardVersion", "number", "the board version the client holds", true),
        ],
        body: (a) => ({ grid: bareGroupId(a.groupId), topics: list(a.topics), boardVersion: num(a.boardVersion) }),
        verified: false,
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
    },
    "todo-status": {
        host: "boards",
        path: "/api/board/personal/todo/status",
        cmd: 12418,
        risk: "private",
        what: "Set a todo's status (open, finished)",
        args: [
            arg("id", "string", "todo id", true),
            arg("status", "number", "the status code, as the client sends it", true),
        ],
        body: (a, ctx) => ({ id: String(a.id), status: num(a.status), imei: ctx.imei }),
        verified: false,
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
    },

    // ── friends and profile ────────────────────────────────────────────────
    "close-friend": {
        host: "friend",
        path: "/api/friend/closefr/update",
        cmd: 11421,
        method: "post",
        risk: "private",
        what: "Mark or unmark a friend as a close friend",
        args: [
            arg("userId", "string", "friend's user id", true),
            arg("action", "number", "the action code, as the client sends it (mark, unmark)", true),
        ],
        body: (a) => ({ fids: [String(a.userId)], action: num(a.action) }),
        verified: false,
    },
    "contact-tab-read": {
        host: "friend",
        path: "/api/friend/read-contact-tab",
        cmd: 12231,
        method: "post",
        risk: "private",
        what: "Mark the contact tab as read up to a time",
        args: [arg("ts", "number", "epoch ms", true)],
        body: (a) => ({ ts: num(a.ts) }),
        verified: false,
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
    },
    "profile-mode": {
        host: "profile",
        path: "/api/social/profile/mode",
        cmd: 11865,
        risk: "visible",
        what: "Set the account's presence mode (available, away, invisible …)",
        args: [arg("mode", "number", "the mode code, as the client sends it", true)],
        body: (a) => ({ mode: num(a.mode) }),
        verified: false,
    },
    "recent-search-update": {
        host: "recent_search",
        path: "/api/recentsearch/update",
        cmd: 12126,
        method: "post",
        risk: "private",
        what: "Replace the search history Zalo keeps for the account",
        args: [
            arg("listRecent", "json", "the recent items (array), as `recent-searches` returns them", true),
            arg("version", "number", "the history version", true),
            arg("listKeyword", "json", "the recent keywords (array)"),
        ],
        body: (a, ctx) => ({
            list_recent: list(a.listRecent),
            version: num(a.version),
            list_keyword: list(a.listKeyword),
            imei: ctx.imei,
        }),
        verified: false,
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
            arg("srcInteraction", "number", "where the action was taken from, as the client sends it", true),
        ],
        body: (a) => ({
            grids: list(a.groupIds).map(bareGroupId),
            member: String(a.userId),
            srcInteraction: num(a.srcInteraction),
        }),
        verified: false,
    },
};

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
            args: d.args.map((a) => ({ name: a.name, type: a.type, required: !!a.required, desc: a.desc })),
        };
    });
}
