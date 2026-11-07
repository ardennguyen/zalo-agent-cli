/**
 * Conversation actions shared by `conv` (src/commands/conv.js) and the MCP tool `zalo_conversation`: pinning,
 * archiving, the anchor `conv delete` deletes backwards from, the auto-delete periods, and forgetting a conversation's
 * local copy. Each call is the one the CLI makes, so the two surfaces cannot drift apart.
 */

import { zaloPost } from "../zalo/receipts.js";
import { getMessages, forgetThread } from "./db.js";
import { pruneDownloadedMedia } from "./sync-v2/media.js";

/**
 * How many cached rows to inspect before giving up on finding an anchor.
 * Deep enough to see past a run of sync-v2 rows, shallow enough that the
 * lookup stays a single cheap query.
 */
export const ANCHOR_SCAN_DEPTH = 200;

/** How far back to look for an incoming message to anchor a seen event (or an unread mark) on. */
export const SEEN_ANCHOR_SCAN_DEPTH = 50;

/** `conv auto-delete`'s periods, in milliseconds, as Zalo Web offers them. */
export const AUTO_DELETE_TTLS = Object.freeze({ off: 0, "1d": 86400000, "7d": 604800000, "14d": 1209600000 });

/** Build the deleteChat anchor triple, or null when any part is missing. */
function toAnchor(ownerId, cliMsgId, globalMsgId) {
    if (!ownerId || !cliMsgId || !globalMsgId) return null;
    return { ownerId: String(ownerId), cliMsgId: String(cliMsgId), globalMsgId: String(globalMsgId) };
}

/**
 * Find the newest message in a thread and return the anchor triple `deleteChat` needs.
 *
 * Groups expose a REST history endpoint; DMs do not, so the caller has to
 * supply the ids by hand there. Both paths are best-effort: Zalo's history
 * APIs lag live traffic, so the "newest" message found may not be the true
 * newest (see agent/work/transfer-sync-v2/NOTES.md § Ordering).
 *
 * The local cache must already be open (the caller opens it: `conv delete` writes to it next). With no cache open,
 * only the group store can answer.
 *
 * @param {object} api
 * @param {string} threadId
 * @param {number} type - 0=User, 1=Group
 * @returns {Promise<{ownerId: string, cliMsgId: string, globalMsgId: string}|null>}
 */
export async function newestMessageAnchor(api, threadId, type) {
    // Source 1: Zalo's cloud-message store, the group history Zalo Web reads
    // (src/zalo/custom/group-history.js). The previous engine's getGroupChatHistory asked
    // /api/group/history, which Zalo answers with 404 -- and this used to read
    // its answer as an array, a shape it never had.
    if (type === 1) {
        try {
            // Loaded on demand: only the group path needs it.
            const { getGroupHistory } = await import("../zalo/custom/group-history.js");
            const history = await getGroupHistory(api, threadId, 1);
            const last = history.groupMsgs[0]?.data;
            const anchor = toAnchor(last?.uidFrom ?? last?.ownerId, last?.cliMsgId, last?.msgId ?? last?.globalMsgId);
            if (anchor) return anchor;
        } catch {
            // Store unreachable, or no group_cloud_message host — fall through to the local cache.
        }
    }

    // Source 2: the local SQLite cache. Anything `listen`, `sync` or a prior
    // `msg history` wrote is here, and rows carry the raw payload, which is
    // where cliMsgId lives.
    //
    // Scan BACKWARDS rather than trusting the newest row, because not every
    // writer stores a usable payload. `listen` and the `msg history` socket
    // backfill persist the full frame (cliMsgId, uidFrom, …); the sync-v2
    // restore persists a minimal shape with no cliMsgId at all. A thread
    // whose newest rows came from sync-v2 therefore has a newest row that
    // cannot anchor anything, while older rows can — measured on a live
    // account as 10 usable rows out of 294 for a group, and 0 out of 43 for
    // a DM that had never been history-fetched. Reading only row 1 turned
    // that into "Could not determine the last message", and made the group
    // path succeed or fail on the luck of which writer touched it last.
    //
    // Deleting backwards from a slightly older anchor leaves the newest few
    // messages in place, which is the same staleness `msg history` already
    // has (see agent/work/transfer-sync-v2/NOTES.md § Ordering) and is far
    // better than refusing outright.
    try {
        for (const row of getMessages(threadId, ANCHOR_SCAN_DEPTH)) {
            let raw = {};
            try {
                raw = JSON.parse(row.raw_data || "{}");
            } catch {
                continue; // unparseable payload — try an older row
            }
            const data = raw.data ?? raw;
            const anchor = toAnchor(row.senderId ?? data.uidFrom, data.cliMsgId, row.msgId ?? data.msgId);
            if (anchor) return anchor;
        }
        return null;
    } catch {
        return null; // no cache open in this process
    }
}

/**
 * Pin or unpin one conversation, exactly as Zalo Web does.
 *
 * `POST {conversation}/api/pinconvers/updatev2` with
 * `{actionType: 1 pin | 2 unpin, conversations: ["g<id>" | "u<id>"], tab: 0}`
 * -- captured for a group and a DM, both directions. The previous engine's
 * setPinnedConversations sent the same minus `tab`, so it is not used.
 *
 * @param {object} api - logged-in session
 * @param {{threadId: string, type: 0|1, pinned: boolean}} opts
 * @returns {Promise<object>}
 */
export async function setConversationPinned(api, { threadId, type, pinned }) {
    const conversation = `${type === 1 ? "g" : "u"}${threadId}`;
    const response = await zaloPost(api, {
        url: `${api.zpwServiceMap.conversation[0]}/api/pinconvers/updatev2`,
        params: () => ({ actionType: pinned ? 1 : 2, conversations: [conversation], tab: 0 }),
    });
    return { threadId: String(threadId), type, pinned, conversation, response };
}

/**
 * Move one conversation to Zalo's "Other" tab (archive) or back to Focused.
 *
 * `POST {label}/api/archivedchat/update` with
 * `{ids: [{id, type: 1 group | 0 user}], version, actionType: 0 to Other | 1 back, imei}`.
 *
 * `version` is the one decision here. The previous engine's updateArchivedChatList
 * sent `Date.now()`. Zalo Web sends the SERVER's version: each captured update
 * carried exactly the `version` the previous response returned, and the first
 * carried the one the web had stored from the server -- 25 days older than the
 * clock. Its archived-chat manager (module FEfs in the web API bundle) keeps
 * that value, refreshes it from `archivedchat/list` at start-up and from every
 * update response, and refetches the list when an answer flags it stale. A CLI
 * run is a fresh client every time, so it does what the web does at start-up:
 * read the list (getArchivedChatList, the same GET a fresh web
 * session makes) and send the version found there. With no version, nothing
 * is sent.
 *
 * @param {object} api - logged-in session
 * @param {{threadId: string, type: 0|1, archived: boolean}} opts
 * @returns {Promise<object>}
 */
export async function setConversationArchived(api, { threadId, type, archived }) {
    let listed;
    try {
        listed = await api.getArchivedChatList();
    } catch (e) {
        throw new Error(`Could not read Zalo's archived-chat version, so nothing was sent: ${e.message}`);
    }
    const v = listed?.version;
    const version = typeof v === "number" ? v : /^\d+$/.test(String(v ?? "")) ? Number(v) : NaN;
    if (!Number.isFinite(version)) {
        throw new Error(
            `Zalo's archived-chat list carried no usable version (${JSON.stringify(v)}), so nothing was sent.`,
        );
    }
    const response = await zaloPost(api, {
        url: `${api.zpwServiceMap.label[0]}/api/archivedchat/update`,
        params: (ctx) => ({
            ids: [{ id: String(threadId), type: type === 1 ? 1 : 0 }],
            version,
            actionType: archived ? 0 : 1,
            imei: ctx.imei,
        }),
    });
    return {
        threadId: String(threadId),
        type,
        archived,
        previousVersion: version,
        version: response?.version ?? null,
        needResync: Boolean(response?.needResync),
        response,
    };
}

/**
 * Delete this machine's copy of one conversation: its downloaded media first, then its rows. Zalo is not contacted.
 *
 * Files first: forgetThread drops the rows that point at them, and a deleted row would leave its media stranded on
 * disk. Each half is best effort, and what failed is reported rather than thrown.
 *
 * @param {string} threadId
 * @returns {Promise<{threadId: string, messages: number, files: number, errors: Array<{what: "media"|"rows", message: string}>}>}
 */
export async function forgetConversation(threadId) {
    const id = String(threadId);
    const out = { threadId: id, messages: 0, files: 0, errors: [] };
    try {
        out.files = (await pruneDownloadedMedia({ all: true, threadId: id })).deleted || 0;
    } catch (e) {
        out.errors.push({ what: "media", message: e.message });
    }
    try {
        out.messages = forgetThread(id).messages || 0;
    } catch (e) {
        out.errors.push({ what: "rows", message: e.message });
    }
    return out;
}
