/**
 * The chat socket's decoded payloads -> the typed events the engine subscribes to.
 *
 * Routing follows Zalo Web's socket handlers (agent/docs/zca-replace/spec-listener.md 3, "Routing"): one chat path
 * for the message pushes, one control path for the controls and reactions, one action path for typing. Each
 * function here takes one frame's decoded `data` and returns the steps the listener carries out, in order:
 *
 *   {emit: name, args: [...]}                       emit one event
 *   {settle: {fileId, url, kind, fileUrl, control}}   an upload the server finished (a 601 control)
 *   {error: Error}                                  one item of the frame could not be read
 *
 * An item that cannot be read costs that item only: the rest of the frame is still read (Web parses each reaction
 * and each control on its own; zca-js lost every item after a bad one).
 *
 * Pure functions apart from the documented in-place rewrites of the message objects (./models.js): no socket, no
 * output, nothing logged.
 */
import { friendControlEvent } from "./friend-events.js";
import { groupControlEvent } from "./group-events.js";
import {
    GroupDeliveredMessage,
    GroupMessage,
    GroupSeenMessage,
    GroupTyping,
    Reaction,
    Undo,
    UserDeliveredMessage,
    UserMessage,
    UserSeenMessage,
    UserTyping,
    isRecall,
} from "./models.js";

/** Thread types, as the engine reads them (0 a 1-1 conversation, 1 a group). */
const USER = 0;
const GROUP = 1;

/**
 * Chat pushes Web reads through one path, any of which may carry messages, receipts and read state: the live
 * pushes 501 (1-1), 521 (group), 502/522 (receipts), the mixed offline push 504 and 524, 570, the server re-push
 * 534, and the Signal pushes 551 (1-1), 552 (group) and 535 (missed), which Web decrypts first and then reads the
 * same way.
 */
export const CHAT_PUSH_CMDS = Object.freeze([501, 521, 502, 522, 504, 524, 570, 534, 551, 552, 535]);

/** The two old-message queue answers (subCmd 1): `old_messages`, with no recall split. */
export const OLD_MESSAGE_CMDS = Object.freeze({ 510: USER, 511: GROUP });

/** The control push this listener reads controls from. 603 pages reach it replayed as 601 (src/core/control-replay.js). */
export const CMD_CONTROL = 601;

/** The live reaction push. */
export const CMD_REACTIONS = 612;

/** The old-reaction queue answers: 610 for 1-1 conversations, 611 for groups. */
export const OLD_REACTION_CMDS = Object.freeze({ 610: false, 611: true });

/** The action push (typing). */
export const CMD_ACTIONS = 602;

/** Control kinds that settle an upload: the file, video and photo forms of "the server has the file". */
export const UPLOAD_ACT_TYPES = Object.freeze(["file_done", "video_done", "photo_success"]);

/**
 * Every cmd this module turns into events. Anything else reaches the raw taps only.
 *
 * @param {number} cmd
 * @param {number} subCmd
 * @returns {boolean}
 */
export function isDispatched(cmd, subCmd) {
    if (CHAT_PUSH_CMDS.includes(cmd)) return true;
    if (Object.hasOwn(OLD_MESSAGE_CMDS, cmd)) return subCmd === 1;
    return cmd === CMD_CONTROL || cmd === CMD_REACTIONS || cmd === CMD_ACTIONS || Object.hasOwn(OLD_REACTION_CMDS, cmd);
}

/** An array field of a payload, or an empty list. */
const listOf = (data, key) => (Array.isArray(data?.[key]) ? data[key] : []);

/**
 * True for a message of an end-to-end encrypted type (`chat.e2ee.*`): its content is ciphertext this client, which
 * has no Signal stack, cannot open.
 *
 * @param {object} msg
 * @returns {boolean}
 */
export function isE2eeMessage(msg) {
    return typeof msg?.msgType === "string" && /(^|\.)e2ee(\.|$)/i.test(msg.msgType);
}

/**
 * Keep an unreadable end-to-end encrypted message out of every text store (design 6.1 item 7): it is still
 * announced, marked `undecryptable`, with its ciphertext removed from `content`.
 *
 * @param {object} msg - rewritten in place
 */
function markUndecryptable(msg) {
    msg.undecryptable = true;
    msg.content = "";
}

/**
 * One pushed message (or recall) as its event step.
 *
 * @param {string} uid
 * @param {object} msg
 * @param {boolean} isGroup
 * @returns {{emit: string, args: unknown[]}}
 */
function pushedMessage(uid, msg, isGroup) {
    if (isE2eeMessage(msg)) markUndecryptable(msg);
    if (isRecall(msg)) return { emit: "undo", args: [new Undo(uid, msg, isGroup)] };
    return { emit: "message", args: [isGroup ? new GroupMessage(uid, msg) : new UserMessage(uid, msg)] };
}

/**
 * Run `make` for one item; a throw becomes an error step naming what was being read and the kind of failure. The
 * failure itself rides along as `cause` (its text varies by Node version and can quote the payload, so it is not
 * part of the message).
 */
function guarded(out, what, make) {
    try {
        const step = make();
        if (step) out.push(step);
    } catch (e) {
        out.push({ error: new Error(`${what}: one item not readable (${e?.name ?? "Error"})`, { cause: e }) });
    }
}

/**
 * A chat push: every message list, then the receipts (zca-js order: messages in array order, delivered before
 * seen). `pageMsgs` (page and official-account conversations) are 1-1 conversations to the engine.
 *
 * @param {string} uid - the own uid
 * @param {number} cmd
 * @param {object} data - the decoded payload's `data`
 * @returns {object[]} steps
 */
export function dispatchChat(uid, cmd, data) {
    const out = [];
    const lists = [
        ["msgs", false],
        ["groupMsgs", true],
        ["pageMsgs", false],
    ];
    for (const [key, isGroup] of lists) {
        for (const msg of listOf(data, key)) guarded(out, `cmd ${cmd} ${key}`, () => pushedMessage(uid, msg, isGroup));
    }

    // 502 is the 1-1 receipt push and 522 the group one; in a mixed push an entry with a group id is a group's.
    const groupDelivered = (d) => (cmd === 522 ? true : cmd === 502 ? false : d?.groupId !== undefined);
    const delivered = [];
    for (const d of listOf(data, "delivereds")) {
        guarded(delivered, `cmd ${cmd} delivereds`, () =>
            groupDelivered(d) ? new GroupDeliveredMessage(uid, d) : new UserDeliveredMessage(d),
        );
    }
    const seen = [];
    for (const d of listOf(data, "seens")) guarded(seen, `cmd ${cmd} seens`, () => new UserSeenMessage(d));
    for (const d of listOf(data, "groupSeens")) {
        guarded(seen, `cmd ${cmd} groupSeens`, () => new GroupSeenMessage(uid, d));
    }
    for (const [name, items] of [
        ["delivered_messages", delivered],
        ["seen_messages", seen],
    ]) {
        const objects = items.filter((s) => !s.error);
        out.push(...items.filter((s) => s.error));
        if (objects.length) out.push({ emit: name, args: [objects] });
    }
    return out;
}

/**
 * An old-message queue answer (510/1, 511/1): `old_messages(list, threadType)`, recalls left in the list as
 * messages (the history writers drop them as removals). Nothing is emitted when the answer has no message list.
 *
 * @param {string} uid
 * @param {number} cmd - 510 or 511
 * @param {object} data
 * @returns {object[]} steps
 */
export function dispatchOldMessages(uid, cmd, data) {
    const type = OLD_MESSAGE_CMDS[cmd];
    const key = type === GROUP ? "groupMsgs" : "msgs";
    if (!Array.isArray(data?.[key])) return [];
    const out = [];
    const objects = [];
    for (const msg of data[key]) {
        guarded(out, `cmd ${cmd} ${key}`, () => {
            objects.push(type === GROUP ? new GroupMessage(uid, msg) : new UserMessage(uid, msg));
            return null;
        });
    }
    out.push({ emit: "old_messages", args: [objects, type] });
    return out;
}

/**
 * Reactions of a control frame: each `content` parsed from JSON on its own, a reaction whose content does not parse
 * skipped with an error step.
 *
 * @param {string} uid
 * @param {number} cmd
 * @param {object} data
 * @returns {object[]} steps
 */
function reactionSteps(uid, cmd, data) {
    const out = [];
    for (const [key, isGroup] of [
        ["reacts", false],
        ["reactGroups", true],
    ]) {
        for (const r of listOf(data, key)) {
            guarded(out, `cmd ${cmd} ${key}`, () => {
                if (typeof r.content === "string") r.content = JSON.parse(r.content);
                return { emit: "reaction", args: [new Reaction(uid, r, isGroup)] };
            });
        }
    }
    return out;
}

/** A control's `data` as an object, parsing JSON text; anything else as it is. */
function controlData(data) {
    if (typeof data !== "string") return data;
    try {
        return JSON.parse(data);
    } catch {
        return data;
    }
}

/**
 * The URL a finished upload is reachable at: `data.url` for files and videos; for a photo, its original, then its
 * HD, then its thumbnail form (the photo control fills missing sizes from each other).
 */
function uploadUrl(kind, data) {
    if (!data || typeof data !== "object") return null;
    if (kind === "photo_success") return data.org ?? data.hd ?? data.normal ?? data.thumb ?? data.url ?? null;
    return data.url ?? null;
}

/**
 * One control (`controls[]` entry) as its steps.
 *
 * @param {string} uid
 * @param {object} control
 * @returns {object[]}
 */
function controlSteps(uid, control) {
    const content = control?.content;
    if (!content || typeof content !== "object") return [];
    const actType = content.act_type;
    if (UPLOAD_ACT_TYPES.includes(actType)) {
        const data = controlData(content.data);
        const url = uploadUrl(actType, data);
        const fileId = content.fileId;
        return [
            { settle: { fileId, url, kind: actType, control } },
            { emit: "upload_attachment", args: [{ fileUrl: url, fileId }] },
        ];
    }
    if (actType === "group") {
        const ev = groupControlEvent(uid, content);
        return ev ? [{ emit: "group_event", args: [ev] }] : [];
    }
    if (actType === "fr") {
        const ev = friendControlEvent(uid, content);
        return ev ? [{ emit: "friend_event", args: [ev] }] : [];
    }
    return [];
}

/**
 * A control push (601) or a reaction push (612): every control in order, then every reaction (Web's
 * `processControl` reads `controls`, `reacts` and `reactGroups` from either).
 *
 * @param {string} uid
 * @param {number} cmd - 601 or 612
 * @param {object} data
 * @returns {object[]} steps
 */
export function dispatchCtrl(uid, cmd, data) {
    const out = [];
    for (const control of listOf(data, "controls")) {
        const act = control?.content?.act_type;
        try {
            out.push(...controlSteps(uid, control));
        } catch (e) {
            const why = `cmd ${cmd} control ${act ?? "?"}: one item not readable (${e?.name ?? "Error"})`;
            out.push({ error: new Error(why, { cause: e }) });
        }
    }
    out.push(...reactionSteps(uid, cmd, data));
    return out;
}

/**
 * An old-reaction queue answer (610 1-1, 611 group): `old_reactions(list, isGroup)` once per frame, each `content`
 * left as the server sent it (the reaction drain and the store read a string or an object alike).
 *
 * @param {string} uid
 * @param {number} cmd - 610 or 611
 * @param {object} data
 * @returns {object[]} steps
 */
export function dispatchOldReactions(uid, cmd, data) {
    const isGroup = OLD_REACTION_CMDS[cmd];
    const key = isGroup ? "reactGroups" : "reacts";
    if (!Array.isArray(data?.[key])) return [];
    const out = [];
    const objects = [];
    for (const r of data[key]) {
        guarded(out, `cmd ${cmd} ${key}`, () => {
            objects.push(new Reaction(uid, r, isGroup));
            return null;
        });
    }
    out.push({ emit: "old_reactions", args: [objects, isGroup] });
    return out;
}

/**
 * An action push (602): the typing actions. `action.data` is a JSON fragment without its braces. Other action kinds
 * reach the raw taps only.
 *
 * @param {object} data
 * @returns {object[]} steps
 */
export function dispatchAction(data) {
    const out = [];
    for (const action of listOf(data, "actions")) {
        if (action?.act_type !== "typing") continue;
        guarded(out, "cmd 602 typing", () => {
            if (action.act !== "typing" && action.act !== "gtyping") return null;
            const d = JSON.parse(`{${action.data}}`);
            return { emit: "typing", args: [action.act === "gtyping" ? new GroupTyping(d) : new UserTyping(d)] };
        });
    }
    return out;
}

/**
 * The steps of one decoded frame, by cmd.
 *
 * @param {string} uid - the own uid
 * @param {{cmd: number, subCmd: number}} head
 * @param {object} data - the decoded payload's `data`
 * @returns {object[]} steps; none for a cmd {@link isDispatched} does not name
 */
export function dispatchFrame(uid, { cmd, subCmd }, data) {
    if (!data || typeof data !== "object") return [];
    if (CHAT_PUSH_CMDS.includes(cmd)) return dispatchChat(uid, cmd, data);
    if (Object.hasOwn(OLD_MESSAGE_CMDS, cmd)) return subCmd === 1 ? dispatchOldMessages(uid, cmd, data) : [];
    if (cmd === CMD_CONTROL || cmd === CMD_REACTIONS) return dispatchCtrl(uid, cmd, data);
    if (Object.hasOwn(OLD_REACTION_CMDS, cmd)) return dispatchOldReactions(uid, cmd, data);
    if (cmd === CMD_ACTIONS) return dispatchAction(data);
    return [];
}
