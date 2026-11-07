/**
 * `conv read` and `conv unread` over the local cache: which cached message a seen receipt or an unread mark is
 * anchored on, and marking a conversation read both ways Zalo Web does.
 *
 * The receipts themselves (seenv2, deliveredv2, the listener's automatic delivered queue) are the protocol layer's:
 * src/zalo/receipts.js.
 */
import { THREAD_TYPE } from "../zalo/enums.js";
import { LIVE_MSG_TYPES } from "../zalo/transfer-sync/message-types.js";
import { RECEIPT_CMD, SEEN_FALLBACK, isId, receiptEntry, sendSeenReceipt, threadOf } from "../zalo/receipts.js";

const THREAD_USER = THREAD_TYPE.USER;
const THREAD_GROUP = THREAD_TYPE.GROUP;

/** Our type vocabulary -> the live msgType the web would name it by (first mapping wins). */
const WEB_MSG_TYPE = Object.freeze(
    Object.entries(LIVE_MSG_TYPES).reduce((acc, [live, ours]) => {
        if (!(ours in acc)) acc[ours] = live;
        return acc;
    }, {}),
);

/** `raw_data` as an object, whatever shape its writer used. */
function parseRaw(rawData) {
    try {
        const parsed = JSON.parse(rawData || "{}");
        if (!parsed || typeof parsed !== "object") return {};
        return parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    } catch {
        return {};
    }
}

/**
 * The newest cached message a seen receipt can be anchored on.
 *
 * Zalo marks a MESSAGE seen, not a thread, and must be able to identify it: an
 * incoming message (never one of ours), with a real msgId and a cliMsgId, that
 * is not a tombstone. A system-line placeholder (`ge:` id, no cliMsgId) and a
 * recalled row are passed over rather than ending the search.
 *
 * @param {object[]} rows - `messages` rows, newest first (db.getMessages)
 * @param {{ownId: string}} opts
 * @returns {{row: object, raw: object}|null}
 */
export function pickSeenAnchor(rows, { ownId }) {
    for (const row of rows || []) {
        if (!row || String(row.senderId ?? "") === String(ownId)) continue;
        if (row.type === "deleted") continue;
        if (!/^\d+$/.test(String(row.msgId ?? ""))) continue;
        const raw = parseRaw(row.raw_data);
        if (!isId(raw.cliMsgId)) continue;
        return { row, raw };
    }
    return null;
}

/**
 * The message `conv unread` pins the unread mark to: the newest cached message Zalo can identify, sent by anyone.
 *
 * Zalo Web marks a conversation unread at its newest message that has a client id, naming that message's
 * `cliMsgId` and sender (`fromUid`, `"0"` for this account's own). A tombstone and a system-line placeholder are
 * passed over, as for the seen anchor. A row restored by sync under a noised sender id names no real sender, so
 * the search stops there and answers null: an older message would mark the wrong place, and the caller then sends
 * the Web's "unknown" (`"-1"`) instead.
 *
 * @param {object[]} rows - `messages` rows, newest first (db.getMessages)
 * @param {{ownId: string}} opts
 * @returns {{cliMsgId: string, fromUid: string}|null}
 */
export function unreadMarkAnchor(rows, { ownId }) {
    for (const row of rows || []) {
        if (!row || row.type === "deleted") continue;
        if (!/^\d+$/.test(String(row.msgId ?? ""))) continue;
        const raw = parseRaw(row.raw_data);
        if (!isId(raw.cliMsgId)) continue;
        const sender = String(row.senderId ?? "");
        if (sender === String(ownId) || String(raw.uidFrom ?? "") === "0") {
            return { cliMsgId: String(raw.cliMsgId), fromUid: "0" };
        }
        if (!/^\d+$/.test(sender)) return null;
        return { cliMsgId: String(raw.cliMsgId), fromUid: sender };
    }
    return null;
}

/**
 * The seenv2 message for a cached row, and which of its fields are guessed.
 *
 * `st`/`at`/`cmd` come from raw_data, where the listener keeps the frame's
 * values. A row written before it did falls back: `cmd` from the thread type --
 * deterministic, it is the command the message arrived on, 501 or 521 -- and
 * `st`/`at` from {@link SEEN_FALLBACK}, which ARE guesses and are reported in
 * `guessed`.
 *
 * @param {object} row - the anchor row
 * @param {object} raw - its parsed raw_data
 * @param {{threadId: string, type: 0|1}} opts
 * @returns {{message: object, guessed: string[]}}
 */
export function seenTargetFromCachedRow(row, raw, { threadId, type }) {
    const isGroup = Number(type) === THREAD_GROUP;
    const has = (v) => v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v));
    const guessed = [];
    const pick = (key, fallback, isGuess = true) => {
        if (has(raw[key])) return Number(raw[key]);
        if (isGuess) guessed.push(key);
        return fallback;
    };
    return {
        message: {
            msgId: String(row.msgId),
            cliMsgId: String(raw.cliMsgId),
            uidFrom: String(row.senderId),
            // Incoming by construction: in a DM the recipient is us ("0"), in a group the group.
            idTo: isGroup ? String(threadId) : "0",
            msgType: typeof raw.msgType === "string" && raw.msgType ? raw.msgType : WEB_MSG_TYPE[row.type] || "webchat",
            st: pick("st", SEEN_FALLBACK.st),
            at: pick("at", SEEN_FALLBACK.at),
            cmd: pick("cmd", RECEIPT_CMD[isGroup ? THREAD_GROUP : THREAD_USER], false),
            ts: row.timestamp ?? raw.ts,
        },
        guessed,
    };
}

/**
 * Mark a conversation read both ways Zalo Web does.
 *
 * The web has two different "read" operations and `conv read` performs both:
 *
 *   - `conv/removeUnreadMark` clears the MANUAL unread flag -- the one
 *     `conv unread` (addUnreadMark) sets and the conversation menu's "mark as
 *     read" clears. It needs only the thread id, so it is always sent.
 *   - `seenv2` marks messages seen, which is what clears the unread count on
 *     the account's other devices. It names a message, so it needs one cached
 *     incoming message to anchor on; without one it is refused, and said so.
 *
 * Neither call can hide the other's failure: each gets its own result.
 *
 * @param {object} api - logged-in session
 * @param {object} opts
 * @param {string} opts.threadId
 * @param {0|1} opts.type
 * @param {string} opts.ownId - this account's uid, to tell incoming from ours
 * @param {object[]} opts.rows - the thread's newest cached rows, newest first
 * @returns {Promise<{threadId: string, type: number, unreadMark: object, seen: object}>}
 */
export async function markConversationRead(api, { threadId, type, ownId, rows }) {
    const [id, isGroup] = threadOf(threadId, type);
    const t = isGroup ? THREAD_GROUP : THREAD_USER;
    const out = { threadId: id, type: t, unreadMark: null, seen: null };

    try {
        out.unreadMark = { ok: true, response: await api.removeUnreadMark(id, t) };
    } catch (e) {
        out.unreadMark = { ok: false, error: e.message };
    }

    const anchor = pickSeenAnchor(rows, { ownId });
    if (!anchor) {
        out.seen = {
            ok: false,
            refused: "no-anchor",
            error: "No incoming message for this conversation is in the local cache, so no seen receipt was sent.",
        };
        return out;
    }
    const { row, raw } = anchor;
    // transfer-sync-v2 restores rows under the protobuf's NOISED sender id. It
    // is not a uid Zalo accepts as `si`, and the row may even be one of ours:
    // our own noised id does not equal our uid, so it passed the check above.
    if (!/^\d+$/.test(String(row.senderId))) {
        out.seen = {
            ok: false,
            refused: "noised-sender",
            msgId: String(row.msgId),
            error:
                `The newest cached message not sent from this account (${row.msgId}) was restored by sync and ` +
                "carries a noised sender id, so a seen receipt built on it would name the wrong sender -- " +
                "possibly this account. No seen receipt was sent.",
        };
        return out;
    }

    const { message, guessed } = seenTargetFromCachedRow(row, raw, { threadId: id, type: t });
    const entry = receiptEntry(message);
    try {
        const response = await sendSeenReceipt(api, { threadId: id, type: t, messages: [message] });
        out.seen = { ok: true, msgId: message.msgId, guessed, entry, response };
    } catch (e) {
        out.seen = { ok: false, msgId: message.msgId, guessed, entry, error: e.message };
    }
    return out;
}
