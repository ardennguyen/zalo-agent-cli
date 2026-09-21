/**
 * Persist live socket events — shared by `listen` and by a running mobile sync.
 *
 * Zalo Web does not freeze while a transfer sync runs: the same WebSocket keeps
 * delivering new messages, reactions and recalls, and the app writes them to its
 * local store alongside the batches arriving from the phone. Our sync used to
 * subscribe only to cmd 601 and ignore everything else on that socket, so any
 * message that landed during a run — and a full-history run takes many minutes —
 * was simply lost, leaving a hole exactly where the sync was meant to guarantee
 * completeness.
 *
 * Both paths now funnel through here, so a message stored during a sync is
 * byte-for-byte the same row the listener would have written.
 */
import fs from "node:fs";
import {
    insertMessage,
    upsertThread,
    upsertReaction,
    markMessageRecalled,
    markThreadGone,
    setSyncState,
    setMessageStatus,
    findMessageByClientId,
} from "./db.js";
import { classifyLiveMessage } from "./sync-v2/message-types.js";

/** zca-js ThreadType.User */
const THREAD_USER = 0;

/**
 * What a live message can honestly tell us about its conversation's name.
 *
 * `dName` on a message is the SENDER's display name, not the conversation's
 * title. The two only coincide in one case: a 1-1 message written by the
 * contact the 1-1 is with, where the thread id IS that contact's id.
 *
 * A group has exactly one name and no message carries it, so a group message
 * contributes nothing here -- it must come from `getGroupInfo` (the sync) or
 * the MCP thread-name cache. Returning "" lets {@link upsertThread} keep
 * whatever is already known instead of renaming the group after its sender.
 *
 * @param {object} msg - the zca-js message event
 * @returns {string} a usable conversation name, or ""
 */
function nameFromLiveMessage(msg) {
    if (msg?.type !== THREAD_USER) return "";
    const from = msg?.data?.uidFrom;
    if (from === undefined || from === null) return "";
    // Our own outgoing 1-1 message carries OUR name, not the contact's.
    if (String(from) !== String(msg.threadId)) return "";
    return String(msg.data.dName || "");
}

/**
 * Live msgTypes that are not messages at all but instructions to remove one.
 *
 * Zalo delivers the two kinds of removal on two different channels:
 *
 *   "Thu hoi" (recall for everyone)  -> the `undo` event, because its content
 *                                        is an OBJECT carrying `deleteMsg`.
 *   "Xoa o phia toi" (delete for me) -> an ordinary `message` event with
 *                                        msgType "chat.delete", because its
 *                                        content is an ARRAY, so zca-js's
 *                                        `deleteMsg` check cannot match it.
 *
 * The second one therefore arrives here, in the message path, and must never
 * be stored as a message: it is keyed by its own notification id, so inserting
 * it created a phantom row that exists nowhere in Zalo while the message it
 * removes stayed fully readable.
 */
const REMOVAL_MSG_TYPES = new Set(["chat.delete", "chat.undo"]);

/**
 * Is this `message` event actually an instruction to remove a message?
 *
 * Exported so a consumer can branch BEFORE rendering it: emitting a `message`
 * webhook event for a deletion frame is the same category of mistake as
 * storing one, and a receiver routing on `event` would act on a message that
 * does not exist.
 *
 * @param {object} data - the event's `data` payload
 * @returns {boolean}
 */
export function isRemovalMessage(data) {
    return REMOVAL_MSG_TYPES.has(data?.msgType);
}

/**
 * Delete a media file a removed message had already pulled down.
 *
 * The file only exists because we fetched it, and the phone strips every CDN
 * reference from a removed message (its attachments survive as `kind: "meta"`
 * with no url), so Zalo itself keeps no way to serve it again. Keeping our copy
 * would mean holding the one thing the sender withdrew.
 *
 * @param {string|null} localPath
 * @returns {boolean} true when a file was removed
 */
function dropMediaFile(localPath) {
    if (!localPath) return false;
    try {
        fs.rmSync(localPath, { force: true });
        return true;
    } catch (e) {
        console.error(`[live-store] could not remove media of a deleted message: ${e.message}`);
        return false;
    }
}

/**
 * Apply a removal to the message it names, wherever the id came from.
 *
 * @param {object} target - {msgId} or {cliMsgId}; msgId wins when both are given
 * @param {"recall"|"delete-for-me"} reason
 * @param {number} at - epoch ms
 * @returns {{stored: boolean, msgId?: string, reason?: string, mediaRemoved?: boolean}}
 */
function applyRemoval(target, reason, at) {
    let msgId = target.msgId === undefined || target.msgId === null ? null : String(target.msgId);
    // A zero globalMsgId means "not supplied", not "message zero".
    if (msgId === "0" || msgId === "") msgId = null;

    if (!msgId && target.cliMsgId) {
        const row = findMessageByClientId(target.cliMsgId);
        if (row) msgId = String(row.msgId);
    }
    if (!msgId) return { stored: false, reason: "removal names no message we hold" };

    const res = markMessageRecalled(msgId, at, { reason });
    if (!res.changes) {
        // Not an error worth failing on: Zalo can name a message older than
        // anything this cache ever saw.
        return { stored: false, msgId, reason: `no cached message ${msgId}` };
    }
    return { stored: true, msgId, reason, mediaRemoved: dropMediaFile(res.localPath) };
}

/**
 * Store one live message event.
 *
 * @param {object} msg - the zca-js message event (`{threadId, type, data, isSelf}`)
 * @param {object} [opts]
 * @param {string} [opts.threadName] - authoritative conversation name, when the
 *   caller has one (the MCP server's thread-name cache does). Supplying it
 *   replaces a weaker stored name; without it the write can only fill a blank.
 * @param {(info: object, msg: object) => void} [opts.onStored] - called after a successful write
 * @returns {{stored: boolean, info?: object, reason?: string}}
 */
export function storeLiveMessage(msg, opts = {}) {
    const data = msg?.data;
    if (!data || data.msgId === undefined || data.msgId === null) return { stored: false, reason: "no msgId" };

    // A "delete for me" frame rides the message channel but is not a message.
    if (REMOVAL_MSG_TYPES.has(data.msgType)) {
        const removal = storeLiveDelete(msg);
        return { stored: removal.stored, removal, info: null };
    }

    const info = classifyLiveMessage(data);
    const authoritative = typeof opts.threadName === "string" && opts.threadName !== "";
    try {
        upsertThread({
            threadId: String(msg.threadId),
            type: msg.type === THREAD_USER ? "dm" : "group",
            name: authoritative ? opts.threadName : nameFromLiveMessage(msg),
            lastUpdate: data.ts ? Number(data.ts) : Date.now(),
            nameHint: !authoritative,
        });
        insertMessage({
            msgId: String(data.msgId),
            threadId: String(msg.threadId),
            senderId: String(data.uidFrom || ""),
            senderName: String(data.dName || ""),
            text: info.text || "",
            timestamp: data.ts ? Number(data.ts) : Date.now(),
            type: info.type,
            raw_data: info.raw,
            has_attachment: info.hasAttachment,
            // NOT data.status. The live `status` field is an undocumented
            // enum (zca-js declares only `status: number`) and is not Sync2's
            // MessageStatus, which this column holds: four of the owner's own
            // successfully-sent messages arrived carrying 1, which that column
            // defines as "failed". Delivery state comes from the mobile sync
            // and from the delivered/seen receipt events instead.
        });
    } catch (e) {
        return { stored: false, reason: e.message };
    }
    if (typeof opts.onStored === "function") opts.onStored(info, msg);
    return { stored: true, info };
}

/**
 * A reaction event's content, whichever form it arrives in.
 *
 * @param {object|string|undefined} content
 * @returns {object}
 */
function parseContent(content) {
    if (typeof content !== "string") return content || {};
    try {
        return JSON.parse(content) || {};
    } catch {
        return {};
    }
}

/**
 * Store one reaction.
 *
 * The Sync2 protobuf has no reaction field, so a transfer sync never restores
 * one. That does not make them unrecoverable: Zalo serves the reaction backlog
 * over the socket on cmd 610/611, which `sync-reactions` drains through this
 * same writer.
 *
 * @param {object} reaction - the zca-js reaction event
 * @returns {{stored: boolean, reason?: string}}
 */
export function storeLiveReaction(reaction) {
    const d = reaction?.data || {};
    // zca-js parses `content` for a LIVE reaction (cmd 612) but hands it over
    // as a raw JSON string for a retrieved one (cmd 610/611 -> old_reactions).
    // Reading `.rMsg` off the string finds nothing and silently stores no
    // reaction, so one writer has to accept both.
    const c = parseContent(d.content);
    const userId = d.uidFrom ?? reaction?.uidFrom;
    if (userId === undefined || userId === null) return { stored: false, reason: "reaction names no user" };

    // The reacted-to message is named inside content, in `rMsg`, exactly as the
    // recall target is: `gMsgID` is the server id and `cMsgID` the client one.
    // Reading the event's own top-level `msgId` stored the REACTION
    // notification's id instead, so every reaction landed on a row that does
    // not exist and getReactions({msgId}) for the real message found nothing.
    // Measured on six live reactions: six rows under six notification ids,
    // where the correct result is one row per (message, person, icon) -- Zalo
    // accumulates, so three icons on one message are three reactions, all
    // displayed.
    const targets = Array.isArray(c.rMsg) ? c.rMsg : [];
    if (!targets.length) return { stored: false, reason: "reaction names no message" };

    const icon = c.rIcon ?? d.rIcon ?? d.icon ?? "";
    // 0 is a real reaction type (HAHA), so it must not be coerced away -- and a
    // missing type must not become 0, which `Number(null)` would make it.
    const rTypeRaw = c.rType ?? d.rType;
    const rType =
        rTypeRaw === null || rTypeRaw === undefined || rTypeRaw === "" || !Number.isFinite(Number(rTypeRaw))
            ? null
            : Number(rTypeRaw);
    const ts = Number(d.ts) || Date.now();

    // Report what actually CHANGED, not merely that we tried. Three bugs in
    // this family hid behind a success flag that was set unconditionally: a
    // removal that deleted nothing and an add that wrote to a non-existent id
    // both looked identical to a working one in the logs.
    let stored = 0;
    let changed = 0;
    const removing = !icon;
    for (const t of targets) {
        let msgId = t?.gMsgID === undefined || t?.gMsgID === null ? null : String(t.gMsgID);
        if (msgId === "0" || msgId === "") msgId = null;
        if (!msgId && t?.cMsgID) {
            const row = findMessageByClientId(t.cMsgID);
            if (row) msgId = String(row.msgId);
        }
        if (!msgId) continue;
        try {
            const res = upsertReaction({
                msgId,
                threadId: reaction?.threadId === undefined ? null : String(reaction.threadId),
                userId: String(userId),
                // An empty icon is how a removal is signalled; upsertReaction
                // deletes rather than storing a blank.
                icon,
                rType,
                timestamp: ts,
            });
            stored++;
            changed += res?.changes ?? 0;
        } catch (e) {
            return { stored: false, reason: e.message };
        }
    }
    if (!stored) return { stored: false, reason: "reaction target not resolvable" };
    return { stored: true, count: stored, changed, removing, icon, msgIds: targets.map((t) => t?.gMsgID) };
}

/**
 * Apply a recall to the message it withdraws.
 *
 * "Thu hồi" removes a message for everyone. Keeping its text readable in a
 * local cache retains something the sender took back, so the row is marked
 * rather than left intact — and rather than deleted, so the conversation still
 * shows that something was said and when.
 *
 * @param {object} undo - the zca-js undo event
 * @returns {{stored: boolean, msgId?: string, reason?: string}}
 */
export function storeLiveUndo(undo) {
    const d = undo?.data || {};
    // The recalled message is named INSIDE content. The event's own top-level
    // msgId identifies the notification (zca-js models/Undo.d.ts: TUndo has no
    // globalMsgId, TUndoContent does), so reading it from there tombstoned the
    // notification's id -- a row that does not exist -- and every live recall
    // silently updated nothing while reporting success.
    const c = d.content || {};
    try {
        return applyRemoval({ msgId: c.globalMsgId, cliMsgId: c.cliMsgId }, "recall", Number(d.ts) || Date.now());
    } catch (e) {
        return { stored: false, reason: e.message };
    }
}

/**
 * Apply a "delete for me" (Xoa o phia toi) to the message it removes.
 *
 * Zalo names the target twice: `globalDelMsgId` when the deleting client knew
 * the server id, and `clientDelMsgId` always. Both shapes were captured live
 * (one frame carried globalDelMsgId 0 with only the client id, the next carried
 * a real global id), so both have to be handled.
 *
 * The phone ships no flag distinguishing this from a recall -- every removal
 * reaches the sync as msgType 36 -- so the distinction is recorded locally in
 * the tombstone's `removedAs`.
 *
 * @param {object} msg - the zca-js message event with msgType "chat.delete"
 * @returns {{stored: boolean, msgId?: string, reason?: string, mediaRemoved?: boolean}}
 */
export function storeLiveDelete(msg) {
    const d = msg?.data || {};
    const entry = Array.isArray(d.content) ? d.content[0] : d.content;
    if (!entry || typeof entry !== "object") return { stored: false, reason: "delete frame carried no target" };
    try {
        return applyRemoval(
            { msgId: entry.globalDelMsgId, cliMsgId: entry.clientDelMsgId },
            "delete-for-me",
            Number(d.ts) || Date.now(),
        );
    } catch (e) {
        return { stored: false, reason: e.message };
    }
}

/**
 * Subscribe a zca-js listener so live traffic keeps being stored.
 *
 * Used by the mobile sync, which holds the socket for minutes at a time and
 * would otherwise drop everything arriving on it.
 *
 * @param {object} listener - `api.listener`
 * @param {(what: string, detail: object) => void} [onEvent]
 * @returns {() => void} detach
 */
export function attachLiveStore(listener, onEvent = () => {}) {
    const onMessage = (msg) => {
        const r = storeLiveMessage(msg);
        if (r.stored) onEvent("message", { threadId: msg.threadId, type: r.info.type });
    };
    const onReaction = (re) => {
        if (storeLiveReaction(re).stored) onEvent("reaction", { threadId: re?.threadId });
    };
    const onUndo = (u) => {
        const r = storeLiveUndo(u);
        if (r.stored) onEvent("undo", { msgId: r.msgId });
    };

    listener.on("message", onMessage);
    listener.on("reaction", onReaction);
    listener.on("undo", onUndo);

    return () => {
        for (const [ev, fn] of [
            ["message", onMessage],
            ["reaction", onReaction],
            ["undo", onUndo],
        ]) {
            try {
                listener.removeListener(ev, fn);
            } catch {
                /* an already-torn-down listener is fine */
            }
        }
    };
}

/**
 * Group events that mean the conversation stopped being ours.
 *
 * Only `isSelf` matters: someone else leaving a group changes nothing about our
 * copy of it. zca-js has no distinct "dispersed" event -- a disperse surfaces as
 * the members leaving -- so LEAVE and REMOVE_MEMBER are the signals available.
 */
const GONE_EVENTS = new Set(["leave", "remove_member", "block_member"]);

/**
 * Note a group event, marking the thread gone when it says we are out.
 *
 * Nothing is deleted here. Being removed from a group is not permission to
 * destroy the local copy of it — the thread is flagged so it shows up as an
 * orphan, and removing it stays an explicit decision (`conv forget`).
 *
 * @param {object} event - the zca-js group event
 * @returns {{gone: boolean, threadId?: string}}
 */
export function storeGroupEvent(event) {
    const type = String(event?.type || "").toLowerCase();
    if (!event?.isSelf || !GONE_EVENTS.has(type)) return { gone: false };
    const threadId = event?.threadId;
    if (threadId === undefined || threadId === null) return { gone: false };
    try {
        markThreadGone(String(threadId), Date.now());
    } catch {
        return { gone: false };
    }
    return { gone: true, threadId: String(threadId) };
}

/**
 * Group events that change a board: notes, pinned messages, polls, reminders.
 *
 * These carry only a delta, and applying one correctly means knowing the board
 * item's full current shape — which the event does not supply. Rather than
 * guess and write a half-populated row, the thread is flagged as having a stale
 * board so the next `sync-boards` refetches it authoritatively. Recording the
 * need is cheap; inventing the data is not.
 */
const BOARD_EVENTS = new Set([
    "new_pin_topic",
    "update_pin_topic",
    "reorder_pin_topic",
    "unpin_topic",
    "update_board",
    "remove_board",
    "update_topic",
    "remove_topic",
    "remind_topic",
    "accept_remind",
    "reject_remind",
]);

/**
 * Note that a conversation's board changed.
 *
 * @param {object} event - the zca-js group event
 * @returns {{stale: boolean, threadId?: string}}
 */
export function noteBoardChange(event) {
    const type = String(event?.type || "").toLowerCase();
    if (!BOARD_EVENTS.has(type)) return { stale: false };
    const threadId = event?.threadId;
    if (threadId === undefined || threadId === null) return { stale: false };
    try {
        // A key per thread, so `sync-boards` can refresh only what moved rather
        // than walking every conversation again.
        setSyncState(`boardStale:${threadId}`, String(Date.now()));
    } catch {
        return { stale: false };
    }
    return { stale: true, threadId: String(threadId) };
}

/**
 * Apply a seen/delivered receipt to the messages it covers.
 *
 * The mobile sync carries msgStatus per message, so a restore establishes
 * delivery state — but it then goes stale, because nothing was tracking the
 * receipts that arrive afterwards. These events are the live half of the same
 * field, not UI noise.
 *
 * @param {Array<object>|object} payload - zca-js seen/delivered event
 * @param {number} status - Sync2 MessageStatus (4 received, 5 seen)
 * @returns {{updated: number}}
 */
export function storeReceipts(payload, status) {
    const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
    let updated = 0;
    for (const entry of list) {
        const d = entry?.data || entry || {};
        const msgId = d.msgId ?? d.globalMsgId;
        if (msgId === undefined || msgId === null) continue;
        try {
            updated += setMessageStatus(String(msgId), status).changes || 0;
        } catch {
            /* one bad receipt must not stop the rest */
        }
    }
    return { updated };
}
