/**
 * `conv read`, `msg seen` and `conv unread` over the local cache: which cached messages a seen receipt names, where
 * an unread mark is anchored, and marking a conversation read as Zalo's "Mark as read" does. The CLI commands and
 * the zalo_conversation actions call the same functions here and answer the same JSON.
 *
 * The receipts themselves (seenv2, deliveredv2, the listener's automatic delivered queue) are the protocol layer's:
 * src/zalo/receipts.js.
 */
import { THREAD_TYPE } from "../zalo/enums.js";
import { LIVE_MSG_TYPES } from "../zalo/transfer-sync/message-types.js";
import {
    MAX_RECEIPTS_PER_CALL,
    RECEIPT_CMD,
    SEEN_FALLBACK,
    isId,
    sendReactionSeen,
    sendSeenReceipt,
    threadOf,
} from "../zalo/receipts.js";
import { getConvState, getMessageById, getMessages } from "./db.js";

const THREAD_USER = THREAD_TYPE.USER;
const THREAD_GROUP = THREAD_TYPE.GROUP;

/** Our type vocabulary -> the live msgType Zalo names it by (first mapping wins). */
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
 * Zalo marks a conversation unread at its newest message that has a client id, naming that message's
 * `cliMsgId` and sender (`fromUid`, `"0"` for this account's own). A tombstone and a system-line placeholder are
 * passed over, as for the seen anchor. A row restored by sync under a noised sender id names no real sender, so
 * the search stops there and answers null: an older message would mark the wrong place, and the caller then sends
 * Zalo's "unknown" (`"-1"`) instead.
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

/** How many of a thread's newest cached rows `conv read` and `msg seen` look through. */
export const READ_SCAN_DEPTH = 200;

/** Whether a cached row is an end-to-end encrypted message (those are marked seen the E2EE way, not seenv2). */
function isE2ee(row, raw) {
    return /^chat\.e2ee/.test(String(raw.msgType ?? "")) || raw.undecryptable === true;
}

/** a > b for two numeric message ids, compared as integers. */
function newer(a, b) {
    return BigInt(String(a)) > BigInt(String(b));
}

/**
 * The cached incoming messages `conv read` marks seen, as Zalo's "Mark as read" does: every incoming message
 * newer than the read watermark (all cached ones when no watermark is known), the newest 50, oldest first.
 *
 * Passed over: our own messages, tombstones, rows Zalo cannot identify (no numeric msgId or no cliMsgId), and
 * counted as skipped: end-to-end encrypted messages (`e2ee`) and sync-restored rows whose sender id is noised
 * (`noisedSender`: a seenv2 built on one would name the wrong sender, possibly this account).
 *
 * @param {object[]} rows - `messages` rows, newest first (db.getMessages)
 * @param {{ownId: string, watermark?: string|null}} opts
 * @returns {{targets: Array<{row: object, raw: object}>, incoming: number, skipped: {e2ee: number, noisedSender: number}}}
 *   `incoming` counts every identifiable incoming row seen, watermark or not
 */
export function unreadIncoming(rows, { ownId, watermark = null }) {
    const known = /^\d+$/.test(String(watermark ?? "")) ? String(watermark) : null;
    const picked = [];
    const skipped = { e2ee: 0, noisedSender: 0 };
    let incoming = 0;
    for (const row of rows || []) {
        if (!row || String(row.senderId ?? "") === String(ownId)) continue;
        if (row.type === "deleted") continue;
        if (!/^\d+$/.test(String(row.msgId ?? ""))) continue;
        const raw = parseRaw(row.raw_data);
        if (!isId(raw.cliMsgId)) continue;
        if (String(raw.uidFrom ?? "") === "0") continue;
        incoming++;
        if (known && !newer(row.msgId, known)) continue;
        if (isE2ee(row, raw)) {
            skipped.e2ee++;
            continue;
        }
        if (!/^\d+$/.test(String(row.senderId))) {
            skipped.noisedSender++;
            continue;
        }
        picked.push({ row, raw });
    }
    picked.sort((a, b) => (newer(a.row.msgId, b.row.msgId) ? 1 : newer(b.row.msgId, a.row.msgId) ? -1 : 0));
    return { targets: picked.slice(-MAX_RECEIPTS_PER_CALL), incoming, skipped };
}

/**
 * What the sender is shown when this account marks their messages seen: "visible" when this account's
 * `display_seen_status` is on (they see "Seen"), "hidden" when it is off (Zalo should show them "Received" only;
 * unverified), null when the setting could not be read. One `getSettings` request.
 *
 * @param {object} api
 * @returns {Promise<"visible"|"hidden"|null>}
 */
export async function senderReceiptOf(api) {
    try {
        const v = (await api.getSettings())?.display_seen_status;
        if (v === true || Number(v) === 1) return "visible";
        if (v === false || (v !== null && v !== undefined && Number(v) === 0)) return "hidden";
        return null;
    } catch {
        return null;
    }
}

/** The plain sentence about what the sender sees. */
function senderNote(senderReceipt) {
    if (senderReceipt === "visible") {
        return (
            'The sender sees "Seen" on these messages: your seen status is visible. To read without that, turn it ' +
            "off first (profile set seen-status 0)."
        );
    }
    if (senderReceipt === "hidden") {
        return (
            'Your seen status is hidden (seen-status 0), so the sender should see "Received", not "Seen" ' +
            "(unverified: Zalo decides this on its side)."
        );
    }
    return 'The sender sees "Seen" on these messages unless your seen status is hidden (profile set seen-status 0).';
}

/** One seenv2 call for the picked rows. */
async function sendSeenFor(api, { threadId, type, targets }) {
    const messages = [];
    const guessed = new Set();
    for (const { row, raw } of targets) {
        const t = seenTargetFromCachedRow(row, raw, { threadId, type });
        messages.push(t.message);
        for (const g of t.guessed) guessed.add(g);
    }
    const msgIds = messages.map((m) => m.msgId);
    try {
        await sendSeenReceipt(api, { threadId, type, messages });
        return { ok: true, msgIds, guessed: [...guessed] };
    } catch (e) {
        return { ok: false, msgIds, guessed: [...guessed], error: e.message };
    }
}

/**
 * A conversation's read state as the listener stored it (src/core/read-state.js), or all-unknown without a cache.
 *
 * @param {string} threadId
 * @param {{read?: typeof getConvState}} [deps]
 * @returns {{lastReadMsgId: string|null, unreadMarked: boolean|null, reactUnreadId: string|null,
 *   reactSeenId: string|null}}
 */
export function conversationReadState(threadId, { read = getConvState } = {}) {
    let row = null;
    try {
        row = read(String(threadId));
    } catch {
        // No cache open in this process.
    }
    const numericId = (v) => (/^\d+$/.test(String(v ?? "")) ? String(v) : null);
    return {
        lastReadMsgId: numericId(row?.lastReadMsgId),
        unreadMarked: row?.unreadMarked === null || row?.unreadMarked === undefined ? null : Boolean(row.unreadMarked),
        reactUnreadId: numericId(row?.reactUnreadId),
        reactSeenId: numericId(row?.reactSeenId),
    };
}

/** A thread's newest cached rows, or none without a cache. */
function cachedRowsOf(threadId, read = getMessages) {
    try {
        return read(String(threadId), READ_SCAN_DEPTH);
    } catch {
        return [];
    }
}

/**
 * Mark a conversation read the way Zalo's "Mark as read" (and opening the chat) does: `conv read` and
 * zalo_conversation `read`, one function and one reply.
 *
 * 1. seenv2 for every cached incoming message newer than the read watermark, the newest 50, oldest first; end-to-end
 *    encrypted ones are left out (counted under `seen.skipped.e2ee`).
 * 2. react_seen when the conversation has an unread reaction (the listener's reaction marks; unverified).
 * 3. removeUnreadMark only when the manual unread mark is set, or not known to be clear.
 *
 * With `markOnly`, only step 3, always sent: the red dot goes, Zalo's real unread count stays, and nothing is marked
 * seen. There is no "dot only" path that clears the count without the sender seeing "Seen"; hiding the seen status
 * (`profile set seen-status 0`) is the way to read without it.
 *
 * Reply: `{success, threadId, threadType, markOnly, seen, reactions, unreadMark, senderReceipt, note, error?}`.
 * `seen` is null with `markOnly`, else `{sent, msgIds, watermark, skipped, guessed, refused?, error?}`; `reactions`
 * is null with `markOnly`, else `{unreadId, sent, error?}`; `unreadMark` is `{wasSet, removed, error?}` (`wasSet`
 * null: not known). `success` is false, with `error`, when a request failed or nothing could be marked seen.
 *
 * @param {object} api - logged-in session
 * @param {object} opts
 * @param {string} opts.threadId
 * @param {0|1} opts.type
 * @param {string} opts.ownId - this account's uid, to tell incoming from ours
 * @param {boolean} [opts.markOnly]
 * @param {object[]} [opts.rows] - the thread's newest cached rows, newest first (read from the cache when absent)
 * @param {object} [opts.state] - {@link conversationReadState} (read from the cache when absent)
 * @returns {Promise<object>}
 */
export async function markConversationRead(api, { threadId, type, ownId, markOnly = false, rows, state }) {
    const [id, isGroup] = threadOf(threadId, type);
    const t = isGroup ? THREAD_GROUP : THREAD_USER;
    const st = state ?? conversationReadState(id);
    const out = {
        success: true,
        threadId: id,
        threadType: isGroup ? "group" : "dm",
        markOnly: Boolean(markOnly),
        seen: null,
        reactions: null,
        unreadMark: { wasSet: st.unreadMarked, removed: false },
        senderReceipt: null,
        note: "",
    };
    const failures = [];

    if (!markOnly) {
        const { targets, incoming, skipped } = unreadIncoming(rows ?? cachedRowsOf(id), {
            ownId,
            watermark: st.lastReadMsgId,
        });
        out.seen = { sent: 0, msgIds: [], watermark: st.lastReadMsgId, skipped, guessed: [] };
        if (targets.length) {
            const r = await sendSeenFor(api, { threadId: id, type: t, targets });
            out.seen.msgIds = r.msgIds;
            out.seen.guessed = r.guessed;
            if (r.ok) out.seen.sent = r.msgIds.length;
            else {
                out.seen.error = r.error;
                failures.push(`Seen receipt failed: ${r.error}`);
            }
        } else if (incoming === 0 && !st.lastReadMsgId) {
            out.seen.refused = "no-cache";
            out.seen.error =
                "No incoming message of this conversation is in the local cache, so nothing was marked seen. The " +
                "cache is written by `listen`, `mcp start` and `sync`.";
            failures.push(out.seen.error);
        } else if (skipped.noisedSender > 0 && skipped.e2ee === 0) {
            out.seen.refused = "noised-sender";
            out.seen.error =
                "The unread cached messages were restored by sync and carry noised sender ids, so a seen receipt " +
                "built on them would name the wrong sender. Nothing was marked seen; a message the listener " +
                "receives carries its real sender.";
            failures.push(out.seen.error);
        }

        const unreadId = st.reactUnreadId;
        const reactionUnread = Boolean(unreadId) && (!st.reactSeenId || newer(unreadId, st.reactSeenId));
        out.reactions = { unreadId: reactionUnread ? unreadId : null, sent: false };
        if (reactionUnread) {
            try {
                await sendReactionSeen(api, { threadId: id, type: t, reactionId: unreadId });
                out.reactions.sent = true;
            } catch (e) {
                out.reactions.error = e.message;
                failures.push(`Reaction-seen receipt failed: ${e.message}`);
            }
        }
    }

    if (markOnly || st.unreadMarked !== false) {
        try {
            await api.removeUnreadMark(id, t);
            out.unreadMark.removed = true;
        } catch (e) {
            out.unreadMark.error = e.message;
            failures.push(`Could not clear the manual unread mark: ${e.message}`);
        }
    }

    if (markOnly) {
        out.note =
            "Only the manual unread mark was removed: Zalo's real unread count stays, and nothing was marked seen.";
    } else {
        out.senderReceipt = await senderReceiptOf(api);
        out.note = out.seen.sent ? senderNote(out.senderReceipt) : "No unread incoming message was marked seen.";
    }
    if (failures.length) {
        out.success = false;
        out.error = failures.join(" ");
    }
    return out;
}

/**
 * Mark chosen messages seen (`msg seen`, zalo_conversation `seen`): one seenv2 for the named cached messages, or,
 * with none named, the newest cached incoming one. It does not touch the manual unread mark. Zalo takes a seen
 * message as read up to there, so it also moves this account's own read position; the sender sees "Seen" unless
 * this account's seen status is hidden.
 *
 * Reply: `{success, threadId, threadType, sent, msgIds, notSent, guessed, senderReceipt, note, error?}`; `notSent`
 * names each id not sent and why.
 *
 * @param {object} api - logged-in session
 * @param {object} opts
 * @param {string} opts.threadId
 * @param {0|1} opts.type
 * @param {string} opts.ownId
 * @param {string[]} [opts.msgIds] - at most 50
 * @param {{byId?: typeof getMessageById, rows?: typeof getMessages}} [deps] - test seams
 * @returns {Promise<object>}
 */
export async function seenMessages(api, { threadId, type, ownId, msgIds = [] }, deps = {}) {
    const [id, isGroup] = threadOf(threadId, type);
    const t = isGroup ? THREAD_GROUP : THREAD_USER;
    const ids = [...new Set((msgIds || []).map(String))];
    if (ids.length > MAX_RECEIPTS_PER_CALL) {
        throw new Error(`Name at most ${MAX_RECEIPTS_PER_CALL} messages: Zalo takes that many per seen receipt.`);
    }
    const byId = deps.byId ?? getMessageById;
    const notSent = [];
    const targets = [];
    if (ids.length) {
        for (const msgId of ids) {
            let row = null;
            try {
                row = byId(msgId);
            } catch {
                // No cache open.
            }
            const why = !row
                ? "not in the local cache"
                : String(row.threadId) !== id
                  ? "belongs to another conversation"
                  : String(row.senderId ?? "") === String(ownId)
                    ? "is this account's own message"
                    : null;
            if (why) {
                notSent.push({ msgId, reason: why });
                continue;
            }
            const raw = parseRaw(row.raw_data);
            const reason = !isId(raw.cliMsgId)
                ? "has no cliMsgId Zalo can name it by"
                : isE2ee(row, raw)
                  ? "is end-to-end encrypted"
                  : !/^\d+$/.test(String(row.senderId))
                    ? "was restored by sync under a noised sender id"
                    : null;
            if (reason) notSent.push({ msgId, reason });
            else targets.push({ row, raw });
        }
    } else {
        const newest = unreadIncoming(cachedRowsOf(id, deps.rows), { ownId }).targets.at(-1);
        if (newest) targets.push(newest);
    }

    const out = {
        success: false,
        threadId: id,
        threadType: isGroup ? "group" : "dm",
        sent: 0,
        msgIds: [],
        notSent,
        guessed: [],
        senderReceipt: null,
        note: "",
    };
    if (!targets.length) {
        out.error = ids.length
            ? "None of the named messages can be marked seen (see notSent)."
            : "No incoming message of this conversation is in the local cache to mark seen.";
        return out;
    }
    targets.sort((a, b) => (newer(a.row.msgId, b.row.msgId) ? 1 : newer(b.row.msgId, a.row.msgId) ? -1 : 0));
    const r = await sendSeenFor(api, { threadId: id, type: t, targets });
    out.msgIds = r.msgIds;
    out.guessed = r.guessed;
    if (!r.ok) {
        out.error = `Seen receipt failed: ${r.error}`;
        return out;
    }
    out.success = true;
    out.sent = r.msgIds.length;
    out.senderReceipt = await senderReceiptOf(api);
    out.note =
        `${senderNote(out.senderReceipt)} Zalo also takes this as read up to these messages, so it moves your own ` +
        "read position.";
    return out;
}
