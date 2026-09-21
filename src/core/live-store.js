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
import { insertMessage, upsertThread, upsertReaction, markMessageRecalled } from "./db.js";
import { classifyLiveMessage } from "./sync-v2/message-types.js";

/** zca-js ThreadType.User */
const THREAD_USER = 0;

/**
 * Store one live message event.
 *
 * @param {object} msg - the zca-js message event (`{threadId, type, data, isSelf}`)
 * @param {object} [opts]
 * @param {(info: object, msg: object) => void} [opts.onStored] - called after a successful write
 * @returns {{stored: boolean, info?: object, reason?: string}}
 */
export function storeLiveMessage(msg, opts = {}) {
    const data = msg?.data;
    if (!data || data.msgId === undefined || data.msgId === null) return { stored: false, reason: "no msgId" };

    const info = classifyLiveMessage(data);
    try {
        upsertThread({
            threadId: String(msg.threadId),
            type: msg.type === THREAD_USER ? "dm" : "group",
            name: String(data.dName || ""),
            lastUpdate: data.ts ? Number(data.ts) : Date.now(),
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
            msgStatus: data.status ?? data.msgStatus,
        });
    } catch (e) {
        return { stored: false, reason: e.message };
    }
    if (typeof opts.onStored === "function") opts.onStored(info, msg);
    return { stored: true, info };
}

/**
 * Store one reaction.
 *
 * Reactions exist only on this path: the Sync2 protobuf has no reaction field,
 * so a reaction not captured live is never recoverable from the phone.
 *
 * @param {object} reaction - the zca-js reaction event
 * @returns {{stored: boolean, reason?: string}}
 */
export function storeLiveReaction(reaction) {
    const d = reaction?.data || {};
    const msgId = d.msgId ?? d.globalMsgId;
    const userId = d.uidFrom ?? reaction?.uidFrom;
    if (msgId === undefined || msgId === null || userId === undefined || userId === null) {
        return { stored: false, reason: "missing msgId or userId" };
    }
    try {
        upsertReaction({
            msgId: String(msgId),
            threadId: reaction?.threadId === undefined ? null : String(reaction.threadId),
            userId: String(userId),
            // An empty icon is how a removal is signalled; upsertReaction
            // deletes rather than storing a blank.
            icon: d.content?.rIcon ?? d.rIcon ?? d.icon ?? "",
            rType: d.content?.rType ?? d.rType,
            timestamp: Number(d.ts) || Date.now(),
        });
    } catch (e) {
        return { stored: false, reason: e.message };
    }
    return { stored: true };
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
    const target = d.globalMsgId ?? d.msgId;
    if (target === undefined || target === null || target === "") return { stored: false, reason: "no target msgId" };
    try {
        markMessageRecalled(String(target), Number(d.ts) || Date.now());
    } catch (e) {
        return { stored: false, reason: e.message };
    }
    return { stored: true, msgId: String(target) };
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
