/**
 * MCP tool registrations for Zalo message access, sending, user lookup, and group productivity.
 * Registers 36 tools: zalo_get_messages, zalo_get_history, zalo_send_message, zalo_list_threads,
 * zalo_search_threads, zalo_mark_read, zalo_view_media, zalo_react, zalo_undo, zalo_get_group_members,
 * zalo_list_conversations, zalo_coverage, zalo_sync, zalo_sync_status, zalo_search_messages,
 * zalo_lookup_user, zalo_forward_message, zalo_delete_message, zalo_reminder, zalo_note, zalo_poll,
 * zalo_wait_for_message, zalo_label, zalo_friend, zalo_group, zalo_read, zalo_write, and the action tools
 * zalo_conversation, zalo_profile, zalo_auto_reply, zalo_quick_message, zalo_catalog, zalo_bank, zalo_cloud,
 * zalo_sticker and zalo_link (their action tables are src/mcp/actions-*.js, run by src/mcp/action-tool.js).
 * Every personal CLI command has an action here; tests/unit/mcp-cli-parity.test.js holds the map.
 *
 * A tool that mirrors a CLI command calls the same code the command does (src/core/cached-message.js,
 * forward.js, pin.js, group-members.js, recent-conversations.js, src/utils/my-documents.js, urgency.js),
 * so the two cannot drift apart.
 */

import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { openFile } from "../utils/open-file.js";
import {
    getMessages,
    getMessagesInRange,
    getMessageById,
    getMessageForAction,
    getDisplayName,
    getStoredName,
    setContactName,
    getThreadType,
    getThreadNames,
    getConvState,
    getReadStates,
} from "../core/db.js";
import { searchPage } from "../core/search.js";
import { parsePeriod } from "../utils/date-range.js";
import { downloadSyncedMedia, DOWNLOADABLE_KINDS } from "../core/sync-v2/media.js";
import { mediaPlainSize } from "../core/keystore/media-seal.js";
import { scopeOfDir } from "../core/keystore/keyring.js";
import { getAccountDir } from "../core/credentials.js";
import {
    chooseDelivery,
    decryptToTempfile,
    deliverCachedMedia,
    inlineContent,
    mediaInfo,
    removeMediaTemp,
} from "../core/media-deliver.js";
import { ensureMediaServed } from "../core/media-route.js";
import { describeZaloError } from "../core/sync-v2/board.js";
import { boardPage, groupReminderPage } from "../zalo/api/boards.js";
import { allAliases, allBoardItems, allReminders } from "../core/list-all.js";
import { fetchAndCacheHistory } from "../core/history-fetch.js";
import {
    cachedCliMsgId,
    cachedText,
    resolveSenderUid,
    cachedMessageById,
    reactionCliMsgId,
    recallCliMsgId,
    quotedReply,
    cachedReplyTo,
    resolveReplyTo,
} from "../core/cached-message.js";
import {
    buildForwardReference,
    sendForward,
    LOG_SRC_TYPE,
    videoResendOptions,
    voiceResendOptions,
} from "../zalo/custom/forward.js";
import { undoPayload } from "../zalo/custom/group-visibility.js";
import { pinMessage, unpinMessage, textPinParams } from "../zalo/custom/pin.js";
import { coverageReport } from "../core/coverage.js";
import { groupMemberUids, fetchMemberNames } from "../core/group-members.js";
import { getGroupInfoWatched, recordOwnExit, goneFields, goneGroupMap, sendRefusal } from "../core/group-exit.js";
import { recentConversations } from "../core/recent-conversations.js";
import { callReadAll, describeReads, READ_NAMES, ReadUsageError } from "../zalo/reads.js";
import "../core/local-reads.js";
import { buildWrite, callWrite, describeWrites, WRITE_NAMES, WRITES } from "../zalo/writes.js";
import { describeReadState, readOnZalo } from "../core/read-state.js";
import { extractMessageText } from "../zalo/format/extract-message-text.js";
import { expandMentions, shiftStyles, ALL_MENTION_UID } from "../zalo/format/mentions.js";
import { resolveSelfThread } from "../utils/my-documents.js";
import { buildQuote, resolveQuoteSender } from "../utils/quote.js";
import { urgencyLevel } from "../zalo/format/urgency.js";
import { splitMessage, sendParts } from "../zalo/format/split-message.js";
import { hasLiteralNewline, LITERAL_NEWLINE_WARNING } from "../utils/literal-newline.js";
import { markdownToZalo, resolveSendFormat } from "../zalo/format/markdown.js";
import { MAX_SETTLE_MS, batchParams, waitResult } from "./wait-result.js";
import { SYNC_STAGES } from "./sync-jobs.js";
import {
    describeFriendAddError,
    describeFriendUndoError,
    extractErrorCode,
    friendStatusFrom,
    friendsFrom,
    readSentRequests,
    receivedRequestsFrom,
    sentRequestsFrom,
} from "../core/friend-requests.js";
import { errorCodeOf } from "../zalo/errors.js";
import {
    NOT_A_MEMBER_CODES,
    REMOVE_NOT_IN_GROUP,
    createdGroupFrom,
    groupInfoFrom,
    memberChangeFrom,
} from "../core/group-admin.js";
import { gateMcp, removedLabels } from "../core/confirm-guard.js";
import { getSecurePage } from "../core/secure-page.js";
import { hiddenChatsFor, hiddenEventView, readThreadIds, withoutHidden } from "../core/hidden-chats.js";

/** The conversation ids a raw read names (moved to src/core/hidden-chats.js; `read run` uses it too). */
export { readThreadIds } from "../core/hidden-chats.js";
import { resolveHiddenChats, resolveMediaDelivery } from "../core/deploy-policy.js";
import { resolveCurrentUserNames, withCurrentSenderNames } from "../core/current-user-names.js";
import { aliasFor, noteAliasSet, personNameFields, senderNameFields } from "../core/contact-names.js";
import { actionTool, confirmInput, dryRunInput, ticketInput } from "./action-tool.js";
import { gateToolsByPresence } from "./tool-presence.js";
import { BIN_TO_DISPLAY, generateQrTransferImage, qrTransferCaption, resolveBankBin } from "../utils/bank-helpers.js";
import { CONVERSATION_ACTIONS, CONVERSATION_META } from "./actions-conversation.js";
import { PROFILE_ACTIONS, PROFILE_META } from "./actions-profile.js";
import {
    AUTO_REPLY_ACTIONS,
    AUTO_REPLY_META,
    BANK_ACTIONS,
    BANK_META,
    CATALOG_ACTIONS,
    CATALOG_META,
    QUICK_MESSAGE_ACTIONS,
    QUICK_MESSAGE_META,
} from "./actions-business.js";
import { CLOUD_ACTIONS, CLOUD_META, LINK_ACTIONS, LINK_META, STICKER_ACTIONS, STICKER_META } from "./actions-media.js";
import {
    FRIEND_EXTRA_ACTIONS,
    FRIEND_EXTRA_INPUTS,
    GROUP_EXTRA_ACTIONS,
    GROUP_EXTRA_INPUTS,
} from "./actions-social.js";

/** Repeat mode codes matching Zalo's reminder repeat modes and src/commands/reminder.js. */
const REMINDER_REPEAT_MODES = { none: 0, daily: 1, weekly: 2, monthly: 3 };
const REMINDER_REPEAT_LABELS = { 0: "none", 1: "daily", 2: "weekly", 3: "monthly" };

/**
 * Parse a reminder time value (epoch-ms number, "YYYY-MM-DD HH:mm", or ISO string) into epoch ms.
 *
 * @param {number|string} val
 * @returns {number|null}
 */
function parseReminderTime(val) {
    if (typeof val === "number") return Number.isFinite(val) && val > 0 ? Math.trunc(val) : null;
    const str = String(val ?? "").trim();
    if (/^\d+$/.test(str)) {
        const n = Number(str);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    const match = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
    if (match) {
        const [, y, mo, d, h, mi] = match;
        return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime();
    }
    const ts = Date.parse(str);
    return Number.isNaN(ts) ? null : ts;
}

/**
 * Build the source descriptor `buildForwardReference` expects from a cached message row.
 *
 * @param {object} api - logged-in session
 * @param {object} row - cached message row from zalo.db
 * @returns {Promise<object>}
 */
async function forwardSourceForMcp(api, row) {
    const cliMsgId = cachedCliMsgId(row);
    if (!cliMsgId) {
        return {
            error:
                "its cliMsgId was never cached, and the forward reference is derived from it " +
                "(`listen`/`mcp` caches messages as they arrive, `sync` restores older ones)",
        };
    }
    const threadId = String(row.threadId || "");
    let send2meId = null;
    try {
        send2meId = api.getContext?.()?.loginInfo?.send2me_id ? String(api.getContext().loginInfo.send2me_id) : null;
    } catch {
        /* ignore */
    }
    const isMyDocuments = Boolean(threadId) && threadId === send2meId;
    let kind = null;
    try {
        kind = threadId ? getThreadType(threadId) : null;
    } catch {
        /* reported below */
    }
    if (!kind && !isMyDocuments) {
        return {
            error:
                `the local cache does not say whether its conversation (${threadId || "unknown"}) is a group ` +
                "or a 1-1, and the forward reference depends on it",
        };
    }
    const sender = await resolveSenderUid(api, row.senderId, ownIdOf(api));
    if (sender.error) return { error: sender.error };
    return {
        cliMsgId,
        senderUid: sender.uid,
        threadId,
        isGroup: kind === "group" && !isMyDocuments,
        ts: Number(row.timestamp) || Number(cliMsgId),
        ...(isMyDocuments && { logSrcType: LOG_SRC_TYPE.MY_CLOUD }),
    };
}

/**
 * Resolve a thread's type the way the CLI does.
 *
 * The CLI rewrites a defaulted `--type` to 1 when the cache knows the id is a
 * group (`applyCachedThreadType`, wired in src/index.js). The MCP tools had no
 * equivalent: `threadType` carried a zod `.default(0)`, which is
 * indistinguishable from the caller explicitly choosing DM, so a group send
 * through MCP went out as type 0. It reports success, but the self-echo comes
 * back on cmd 501 instead of 521, the listener re-types the conversation, and
 * mentions are dropped silently. The MCP server IS the db writer, so the
 * agent's own mistake corrupts the cache that quoting and history then read.
 *
 * Omitted means "work it out"; an explicit 0 or 1 is always obeyed.
 *
 * @param {string} threadId
 * @param {"dm"|"group"} [explicit] - the caller's threadType, if they gave one
 * @returns {number} THREAD_USER or THREAD_GROUP
 */
function resolveThreadType(threadId, explicit) {
    if (explicit === "group") return THREAD_GROUP;
    if (explicit === "dm") return THREAD_USER;
    try {
        return getThreadType(String(threadId)) === "group" ? THREAD_GROUP : THREAD_USER;
    } catch {
        // No cache yet: fall back to the old assumption rather than failing.
        return THREAD_USER;
    }
}

/** A group's conversation id in a label: `g` and the group id. */
const LABEL_GROUP_ID = /^g\d+$/;

/**
 * A thread as a conversation label names it: `g<groupId>` for a group, the bare id for a user (Zalo Web's
 * conversation ids). An id already given as `g<digits>` is kept.
 *
 * @param {string} threadId
 * @param {"dm"|"group"} [explicit] - the caller's threadType, if they gave one
 * @returns {string}
 */
function labelConversationId(threadId, explicit) {
    const id = String(threadId);
    if (LABEL_GROUP_ID.test(id)) return id;
    return resolveThreadType(id, explicit) === THREAD_GROUP ? `g${id}` : id;
}

/** Thread type constants matching the engine's THREAD_TYPE (src/zalo/enums.js) */
const THREAD_USER = 0;

/** Thread type for groups — the only kind Zalo delivers mentions in. */
const THREAD_GROUP = 1;

/** What a reply calls a thread type: the same words an input takes. */
const threadTypeName = (type) => (Number(type) === THREAD_GROUP ? "group" : "dm");

/**
 * How many member ids `zalo_get_group_members` asks Zalo to name per request.
 * The session puts them in the request URL, and Zalo Web asks in bounded batches
 * too; 50 is the batch the group commands already use for `getGroupInfo`.
 */
const MEMBER_NAME_BATCH = 50;

/** The kinds of content zalo_send_message sends besides text; one per call. */
const SEND_MODES = ["filePath/files", "link", "cardUserId", "sticker", "voiceUrl", "video", "bankCard", "qrTransfer"];

/**
 * Which of SEND_MODES a zalo_send_message call gives, by its input names.
 *
 * @param {object} val - the call's input
 * @returns {string[]}
 */
function sendModes(val) {
    const hasFile = Boolean(val.filePath || (Array.isArray(val.files) && val.files.length > 0));
    return [
        hasFile && "files",
        val.link && "link",
        val.cardUserId && "cardUserId",
        val.sticker && "sticker",
        val.voiceUrl && "voiceUrl",
        val.video && "video",
        val.bankCard && "bankCard",
        val.qrTransfer && "qrTransfer",
    ].filter(Boolean);
}

/** How a refusal tells an agent to supply a message's cliMsgId itself. */
const CLI_MSG_ID_HINT = "the `cliMsgId` parameter (zalo_send_message returns it for a message you sent)";

/**
 * A user's display name, read from the local cache only.
 *
 * Names a `@[uid]` mention token in `zalo_send_message`, and a member in
 * `zalo_get_group_members` before that tool asks Zalo for the rest.
 *
 * **For mentions this deliberately does not do what the CLI does.** `msg
 * send` falls back to a batched `getGroupMembersInfo` call for uids the cache
 * cannot name (`fetchMentionNames` in `src/commands/msg.js`); the MCP send
 * does not, and stays purely local:
 *
 * - The CLI's fallback exists for a human typing a uid for someone who has
 *   never posted in the group. An agent mostly learns uids from
 *   `zalo_get_messages` / `zalo_get_history`, whose rows carry `senderName`
 *   alongside `senderId`, so the cache can already name them. The exception
 *   is `zalo_get_group_members`, which hands out every member's uid and asks
 *   Zalo for the names the cache lacks — but writes none of them back (zalo.db
 *   has exactly three writers, AGENTS.md §13), so such a member is still
 *   tagged here under the bare uid.
 * - `mcp start` opens the db before it serves a request and exits if it
 *   cannot, so unlike the CLI the cache is never merely absent here.
 * - A network lookup in the hot path of every send would add an unofficial-API
 *   round trip, its latency, and its failure modes to a tool agents call in
 *   loops. The unofficial API is what gets accounts banned.
 *
 * The cost of staying local is a bare uid as the visible label when the cache
 * has no name. The mention still tags the right person — `uid` is what Zalo
 * notifies on — and `zalo_send_message` reports the fallback back to the
 * caller as `unresolvedMentions` rather than hiding it.
 *
 * Never throws: a cache miss must not fail a send.
 *
 * @param {string} uid
 * @returns {string|null}
 */
/**
 * Record the name this account shows for a user (the nickname just set, or the profile name after a nickname was
 * removed) in `contacts`, where `getDisplayName` reads first. Best effort, like cachedDisplayName: the MCP tests run
 * without a db, and a name that fails to persist only costs the next lookup.
 * @param {string} uid
 * @param {string} name
 */
function rememberContactName(uid, name) {
    try {
        setContactName(uid, name);
    } catch {
        /* no db open in this process */
    }
}

function cachedDisplayName(uid) {
    try {
        return getDisplayName(uid);
    } catch {
        return aliasFor(uid); // no db in this process: the owner's alias, when the daemon holds one
    }
}

/**
 * The name the cache holds for a user without the owner's alias (`db.getStoredName`), or null.
 * @param {string} uid
 * @returns {string|null}
 */
function cachedStoredName(uid) {
    try {
        return getStoredName(uid);
    } catch {
        return null; // no db in this process
    }
}

/**
 * This account's own uid, or "" when the session cannot say.
 *
 * @param {object} api - session object
 * @returns {string}
 */
function ownIdOf(api) {
    try {
        const id = api.getOwnId?.();
        return id === undefined || id === null ? "" : String(id);
    } catch {
        return "";
    }
}

/**
 * Each conversation's read state on Zalo -- the account's own reading, on any
 * device -- for the tools that list conversations. Empty when the cache
 * cannot answer, so a listing never fails for want of it.
 *
 * @param {object} api - session object
 * @param {string[]} threadIds
 * @returns {Map<string, object>} threadId -> an entry of db.js getReadStates
 */
function readStatesOf(api, threadIds) {
    try {
        return getReadStates(threadIds, ownIdOf(api));
    } catch {
        return new Map();
    }
}

/**
 * Resolve a `threadId` that names the self-chat to My Documents, as every
 * `msg` subcommand does.
 *
 * `me`, or this account's own uid, means My Documents: a 1-1 conversation of
 * its own whose id is the session's `loginInfo.send2me_id`, never the own uid
 * (src/utils/my-documents.js, the same function `msg send me` calls). An
 * explicit `threadType: "group"` is refused, as `msg send me -t 1` is.
 *
 * @param {object} api - session object
 * @param {string} threadId - as the caller gave it
 * @param {"dm"|"group"} [threadTypeIn] - the caller's threadType, if they gave one
 * @returns {null|{threadId: string, notice: string}|{error: string}} null when it is not a self reference
 */
function selfThread(api, threadId, threadTypeIn) {
    let ownId = null;
    try {
        ownId = api.getOwnId?.() ?? null;
    } catch {
        /* no session context: only the `me` alias can match, and it says why it cannot resolve */
    }
    return resolveSelfThread(threadId, {
        ownId: ownId === null ? null : String(ownId),
        send2meId: () => api.getContext().loginInfo?.send2me_id,
        groupRequested: threadTypeIn === "group",
    });
}

/**
 * The conversation a send or a message action names, and its type.
 *
 * My Documents (see {@link selfThread}) is always a 1-1; anything else is
 * typed by {@link resolveThreadType}: the caller's explicit threadType, else
 * the cache's.
 *
 * @param {object} api - session object
 * @param {string} threadIdIn - as the caller gave it
 * @param {"dm"|"group"} [threadTypeIn] - the caller's threadType, if they gave one
 * @returns {{threadId: string, threadType: number, notice?: string}|{error: string}} `notice` only for My Documents
 */
function actionThread(api, threadIdIn, threadTypeIn) {
    const self = selfThread(api, threadIdIn, threadTypeIn);
    if (self?.error) return { error: self.error };
    if (self) return { threadId: self.threadId, threadType: THREAD_USER, notice: self.notice };
    return { threadId: threadIdIn, threadType: resolveThreadType(threadIdIn, threadTypeIn) };
}

/**
 * Wrap a result object into MCP tool content format.
 * @param {object} result
 * @returns {{ content: Array }}
 */
function ok(result) {
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

/**
 * Wrap an error message into MCP tool error content format.
 * @param {string} message
 * @returns {{ content: Array, isError: true }}
 */
function err(message) {
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * One cached message as zalo_get_history returns it.
 * @param {object} m - a `messages` row
 * @returns {object}
 */
function cachedHistoryRow(m) {
    return {
        msgId: m.msgId,
        cliMsgId: cachedCliMsgId(m) ?? undefined,
        threadId: m.threadId,
        senderId: m.senderId || null,
        senderName: m.senderName || null,
        text: m.text,
        timestamp: m.timestamp,
        type: m.type,
        mediaCached: m.localPath ? true : undefined,
        hasAttachment: m.has_attachment ? true : undefined,
        msgStatus: m.msgStatus ?? undefined,
        replyTo: cachedReplyTo(m),
    };
}

/** The largest sticker picture zalo_view_media fetches. */
const STICKER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * A sticker's picture, fetched for zalo_view_media and not kept: stickers are not downloaded with the messages. The
 * URL comes from the live message, else from Zalo's sticker detail for the id the cached message names.
 *
 * @param {object} api
 * @param {object|null} row - the cached message
 * @param {object|null} buffered - the live message
 * @param {(url: string, init: object) => Promise<Response>} [fetchImpl]
 * @returns {Promise<{bytes: Buffer, mime: string} | {error: string}>}
 */
export async function stickerPicture(api, row, buffered, fetchImpl = (...a) => fetch(...a)) {
    let url = buffered?.attachment?.url || null;
    if (!url) {
        let content = null;
        try {
            content = JSON.parse(row?.raw_data || "{}")?.content ?? null;
        } catch {
            /* no stored content */
        }
        const id = Number(content?.id);
        if (!Number.isFinite(id) || id <= 0) return { error: "This sticker message does not say which sticker it is." };
        try {
            const [detail] = (await api.getStickersDetail([id])) ?? [];
            url = detail?.stickerWebpUrl || detail?.stickerUrl || null;
        } catch (e) {
            return { error: `Zalo did not describe the sticker: ${e.message}` };
        }
        if (!url) return { error: "Zalo did not give a picture for this sticker." };
    }
    try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
        const mime = String(res.headers.get("content-type") || "")
            .split(";")[0]
            .trim()
            .toLowerCase();
        if (!res.ok || !mime.startsWith("image/")) {
            return { error: `The sticker's picture could not be fetched (HTTP ${res.status}).` };
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > STICKER_MAX_BYTES) return { error: "The sticker's picture is too large to show." };
        return { bytes, mime };
    } catch (e) {
        return { error: `The sticker's picture could not be fetched: ${e.message}` };
    }
}

/** The most one page of zalo_get_history holds: without a date range, and with one. */
export const HISTORY_PAGE_MAX = 200;
export const HISTORY_RANGE_PAGE_MAX = 1000;

/**
 * A thread's cached messages between two times, oldest first, one page of them (bug-reports #5).
 *
 * Cache only: Zalo's server serves nothing older than this login, so a date range is the cache's question.
 *
 * @param {string} threadId
 * @param {{since: number|null, until: number|null, limit: number}} range
 * @param {object} [nameCache]
 * @returns {object} tool payload
 */
function cacheHistoryRange(threadId, { since, until, limit }, nameCache) {
    const { rows, nextSince } = getMessagesInRange(String(threadId), { since, until, limit });
    const messages = rows.map(cachedHistoryRow);
    const info = nameCache?.get(String(threadId));
    if (info) for (const m of messages) m.threadName = info.name;
    return {
        threadId: String(threadId),
        source: "cache",
        since,
        until,
        count: messages.length,
        messages,
        // Pass `nextSince` back as `since` (same `until`) for the next page.
        hasMore: nextSince !== null,
        nextSince,
        ...(messages.length === 0 && {
            note:
                "Nothing cached for this conversation in this period. Zalo's server serves only messages since this " +
                "login; older ones are restored with `zalo-agent sync` (the owner's phone confirms it).",
        }),
    };
}

/**
 * Read a thread's history out of the local cache.
 *
 * Returns null when the cache has nothing for the thread, which is the signal
 * to fall back to asking Zalo.
 *
 * @param {string} threadId
 * @param {number} limit
 * @param {number} [before] - epoch ms; return messages older than this
 * @param {object} [nameCache]
 * @returns {object|null} tool payload, or null when the cache is empty/unopened
 */
function cacheHistory(threadId, limit, before, nameCache) {
    let rows;
    try {
        rows = getMessages(String(threadId), limit, before);
    } catch {
        return null; // no db open in this process — server path it is
    }
    if (!rows || rows.length === 0) return null;

    const messages = rows.map(cachedHistoryRow).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const info = nameCache?.get(String(threadId));
    if (info) for (const m of messages) m.threadName = info.name;

    return {
        threadId: String(threadId),
        source: "cache",
        count: messages.length,
        messages,
        // Oldest returned timestamp: pass it back as `before` for the next page.
        cursor: messages.length ? messages[0].timestamp : (before ?? null),
        hasMore: rows.length >= limit,
    };
}

/** What zalo_get_messages and zalo_wait_for_message say about the system events in their list. */
const SYSTEM_EVENTS_NOTE =
    "A system event arrives in the same list with `system: true` and `msgId` null, only to a read or wait that names no `threadId`; each has a `type` and a `text` to show a person. " +
    "`account_state`: the account's connection state changed (`state` idle, connecting, connected, kicked, yielded, login_needed, signed_out or maintenance, `previous`, `detail`); yielded and signed_out refuse every call until a person acts, as `text` says; a park and the wake that ends it are not in the buffer. " +
    "`group_gone`: the account left, was removed or blocked from, or saw the disbanding of the group in `threadId` (`reason`, `leftAt`, `mode` purge or keep, `purged` counts). " +
    "`queue_overflow`: Zalo's offline queue overflowed and messages from `fromTs` to `toTs` were dropped (`queues`, `groups` repair counts, `pending`; when pending, `command` is the sync the owner runs, which taps the phone). " +
    "`storage_quota`: this account's storage on the server is near or over its quota, or was purged, or is back within it (`level` warn, over, grace_ending, purged or ok; `usedBytes`, `limitBytes`, `purgeAt`); zalo_profile 'usage' reads the current usage. ";

/**
 * Register all Zalo MCP tools on the server.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {object} api - session object
 * @param {import("./message-buffer.js").MessageBuffer} buffer
 * @param {import("./thread-filter.js").ThreadFilter} filter
 * @param {object} config - MCP config
 * @param {import("./thread-name-cache.js").ThreadNameCache} [nameCache] - Thread name cache
 * @param {string} [accountDir] - account data dir; media is fetched into <accountDir>/media
 * @param {ReturnType<import("../core/daemon-channel.js").createStageLock>} [stageLock] - the
 *   daemon's one-stage-at-a-time lock; a server-side history fetch takes it, as `listen`'s does
 * @param {object} [syncJobs] - the daemon's account-local sync job tracker
 * @param {{presence?: object|null}} [extras] - `presence`: the daemon's on-demand presence
 *   (src/core/daemon-presence.js); every tool goes through it by its class (./tool-presence.js)
 */
export function registerTools(
    server,
    api,
    buffer,
    filter,
    config,
    nameCache,
    accountDir,
    stageLock,
    syncJobs,
    extras = {},
) {
    // On-demand presence: refused while yielded or signed out, a hold per call, warming by the tool's class.
    gateToolsByPresence(server, extras?.presence ?? null);

    // Several bots can share one listener, each with its own read cursor
    // (triage M7). A bot that names none reads as "default", as before.
    const consumerSchema = z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9._:@-]+$/)
        .optional()
        .describe(
            "Your bot's name, when several bots share this server: each name has its own read cursor, " +
                "so one bot's zalo_mark_read does not hide messages from another. Omit it for a single bot.",
        );

    // Every tool with an action Zalo Web asks about first takes `confirm` and `dryRun` (confirmInput, dryRunInput
    // in action-tool.js), and settles it through gate() (src/core/confirm-guard.js) after its arguments are checked
    // and before anything is sent.
    // Over the stateless HTTP transport this server lives for one request (mcp-http-transport.js marks it), so
    // "human" mode cannot ask there; the guard hands out a one-time approve page and the call is repeated with
    // `ticket` (src/core/secure-page.js).
    const gate = (key, target, { confirm, dryRun, ticket } = {}, extra, more = {}) =>
        gateMcp(key, target, {
            confirm,
            dryRun,
            ticket,
            config,
            accountId: ownIdOf(api),
            server,
            extra,
            stateless: server?.statelessHttp === true,
            // approval.secret: the approver password lives in the account folder, the PIN's hash in the hidden set.
            accountDir: accountDir ?? null,
            hidden: () => hiddenSet(),
            ...more,
        });

    // Hidden chats (src/core/hidden-chats.js), shown by the deployment's hiddenChats policy (src/core/deploy-policy.js):
    // `exclude` (default) leaves them out of every list, search, history and event; `contentless` turns an event in
    // one into `{event, hidden: true}`; `include` shows them.
    const hiddenSet = () => hiddenChatsFor(ownIdOf(api) ?? "", { stateDir: accountDir ?? null });
    const hiddenMode = () => resolveHiddenChats({ config, accountId: ownIdOf(api) ?? undefined }).mode;
    const hiddenIds = () => (hiddenMode() === "include" ? [] : [...hiddenSet().ids]);
    const isHiddenThread = (id) =>
        id !== undefined && id !== null && hiddenMode() !== "include" && hiddenSet().isHidden(id);
    const eventsView = (list) => {
        const set = hiddenSet();
        const mode = hiddenMode();
        return list
            .map((m) => hiddenEventView(m, set, mode, { name: m?.type === "undo" ? "undo" : "message" }))
            .filter(Boolean);
    };
    const HIDDEN_THREAD =
        "That conversation is one of the account's hidden chats, which this server leaves out (hiddenChats policy). " +
        "The account owner can unhide it, or the deployment can set hiddenChats to include.";

    // What an action table's rows read (src/mcp/action-tool.js): the session, the guard, and the helpers that type
    // a thread and name this account, so a row resolves a thread the way every other tool here does.
    const toolCtx = {
        api,
        ok,
        err,
        gate,
        ownId: () => ownIdOf(api),
        threadType: resolveThreadType,
        threadTypeName,
        onSelfName: (name) => syncJobs?.onSelfName?.(name),
        // The hidden-chat actions: the deployment's policy, the PIN page, and a live elicitation where there is one.
        config,
        server,
        stateless: server?.statelessHttp === true,
        hidden: () => hiddenSet(),
        hiddenMode: () => hiddenMode(),
        securePage: () => getSecurePage(),
        threadName: (id) => nameCache?.get?.(String(id))?.name ?? null,
        // zalo_profile 'usage': the media folder this server downloads into.
        mediaRoot: config.media?.downloadDir ?? null,
        // zalo_profile 'presence_resume': the daemon's presence (null under a server that runs none).
        presence: extras?.presence ?? null,
    };
    const friendExtra = actionTool("zalo_friend", FRIEND_EXTRA_ACTIONS, toolCtx);
    const groupExtra = actionTool("zalo_group", GROUP_EXTRA_ACTIONS, toolCtx);

    // --- zalo_get_messages ---
    server.registerTool(
        "zalo_get_messages",
        {
            title: "Get Zalo Messages",
            description:
                "Read the new incoming Zalo messages (DMs and groups) from the live buffer, in order. It returns the messages this consumer has not yet marked read; when you have handled them, call zalo_mark_read with the reply's `cursor`. " +
                "To continue exactly after the last reply, pass its `cursor` as `since`. To wait for the next message instead of polling, use zalo_wait_for_message. " +
                "Each message has `msgId` (pass it as `msgId` or `quoteMsgId` to other tools), `threadId`, `threadType` (dm or group), `senderId`, `senderName` (the name to show: your alias for the sender when you set one, else the name the message carried), `senderAlias` (your alias, or null), `senderZaloName` (the name the message carried), `senderDisplayName` (the current name: your alias, else the phonebook name, else the Zalo name, else the display name, else the uid; `senderDisplayNameSource` says which: alias, phonebook, zalo, display or uid), `text`, `timestamp` (epoch ms), `type`, `threadName` and `readOnZalo`. " +
                "`readOnZalo` is true or false when the account owner has or has not read the message on Zalo (phone or Zalo Web), and null when that is unknown; zalo_mark_read does not change it. " +
                'A recall arrives in the same list with `type` "undo": its `msgId` is the recalled message (null when only its `cliMsgId` is known), its `text` is empty, and the earlier message is gone from the cache. ' +
                SYSTEM_EVENTS_NOTE +
                "Returns `{ messages, cursor, hasMore }`.",
            inputSchema: z.object({
                threadId: z
                    .string()
                    .optional()
                    .describe("Only this conversation (its threadId). Omit for all conversations the server watches."),
                since: z
                    .number()
                    .int()
                    .min(0)
                    .default(0)
                    .describe(
                        "The `cursor` of your last reply, to continue after it. 0 (default) continues after what you marked read with zalo_mark_read.",
                    ),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe("Most messages to return in one call. Omit it for every unread message buffered."),
                consumer: consumerSchema,
            }),
        },
        async ({ threadId, since, limit, consumer }) => {
            try {
                if (isHiddenThread(threadId)) return err(HIDDEN_THREAD);
                // An explicit cursor is honored as given; 0 starts after what this consumer marked read.
                const from = since > 0 ? since : buffer.readCursor(consumer);
                const result = buffer.read(threadId, from, limit);
                // A system event (account_state, group_gone, queue_overflow, storage_quota) is passed on as it is.
                const order = result.messages;
                const system = new Map(order.filter((m) => m?.system).map((m) => [m._cursor, m]));
                result.messages = order.filter((m) => !m?.system);
                // Enrich messages with thread name from cache
                if (nameCache) {
                    for (const msg of result.messages) {
                        const info = nameCache.get(msg.threadId);
                        if (info) msg.threadName = info.name;
                    }
                }
                const dmIds = result.messages
                    .filter((m) => (nameCache?.get(m.threadId)?.type || buffer.getThreadType?.(m.threadId)) === "dm")
                    .map((m) => m.threadId);
                result.messages = await withCurrentSenderNames(api, result.messages, dmIds);
                // Whether the human already read each one, from its
                // conversation's read watermark (src/core/read-state.js).
                const watermarks = new Map();
                const watermarkOf = (id) => {
                    if (!watermarks.has(id)) {
                        let st = null;
                        try {
                            st = getConvState(id);
                        } catch {
                            /* no cache: unknown */
                        }
                        watermarks.set(id, st?.lastReadMsgId ?? null);
                    }
                    return watermarks.get(id);
                };
                result.messages = result.messages.map((msg) => ({
                    ...msg,
                    readOnZalo: readOnZalo(msg.msgId, watermarkOf(String(msg.threadId))),
                }));
                if (system.size) {
                    const byCursor = new Map(result.messages.map((m) => [m._cursor, m]));
                    result.messages = order.map((m) => system.get(m._cursor) ?? byCursor.get(m._cursor));
                }
                result.messages = eventsView(result.messages);
                return ok(result);
            } catch (e) {
                console.error("[mcp-tools] zalo_get_messages error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_send_message ---
    server.registerTool(
        "zalo_send_message",
        {
            title: "Send Zalo Message",
            description:
                "Send a message to a Zalo conversation: text, files or images, a link preview card, a contact card, a sticker, a voice message or a video from a URL, a bank account card, or a VietQR transfer image. Give `threadId` and one kind of content: `text`, `filePath` or `files`, `link`, `cardUserId`, `sticker`, `voiceUrl`, `video`, `bankCard` or `qrTransfer`. With files, a link, a video or a QR transfer, `text` is an optional caption. " +
                'Text: use real line breaks, never the two characters backslash and n (Zalo shows those as typed). Markdown is converted to Zalo formatting by default; `format: "plain"` sends the text exactly as written. A text over 3000 bytes (a Chinese, Japanese, Korean, Thai or Hindi character is 3, a Cyrillic or Arabic one 2) is split into several messages at paragraph or sentence ends, as Zalo Web does, and the reply then lists every part (`splitInto`, `parts`). ' +
                "Mention in a group: put `@[userId]` in the text where the tag belongs (`@[-1]` is @All). Take the user id from a message's `senderId` (zalo_get_messages, zalo_get_history) or from zalo_get_group_members. It is sent as `@Their Name` and notifies that person; a user id the cache cannot name is tagged as the bare id and listed in `unresolvedMentions`. Mentions only work in groups. " +
                "Reply to a message: pass its msgId as `quoteMsgId` (text messages only, and the message must be in the local cache). " +
                '`urgency` marks the message Important or Urgent, as the apps do. `threadId: "me"` sends to the owner\'s My Documents. ' +
                "Returns `{ success, msgId, cliMsgId, threadType }` and, when they apply, `parts` and `warnings`. Keep `msgId` and `cliMsgId` if you may need to react to or recall this message (zalo_react, zalo_undo).",
            inputSchema: z
                .object({
                    threadId: z
                        .string()
                        .describe(
                            "The conversation: the other person's user id for a DM, the group id for a group (find one with zalo_search_threads, zalo_list_conversations or zalo_lookup_user). `me` (or your own uid) is My Documents.",
                        ),
                    text: z
                        .string()
                        .min(1)
                        .optional()
                        .describe(
                            "The message. Real line breaks only: never the two characters backslash and n. Markdown is converted unless `format` is 'plain'. Required unless another kind of content is given; with files, a link, a video or a QR transfer it is the caption. `@[userId]` tokens become @-mentions (`@[-1]` is @All).",
                        ),
                    filePath: z
                        .string()
                        .min(1)
                        .optional()
                        .describe(
                            "Local path of ONE file or image to send, on the machine this server runs on. `text` becomes its caption.",
                        ),
                    files: z
                        .array(z.string().min(1))
                        .min(1)
                        .optional()
                        .describe(
                            "Local paths of several files or images to send in one call, on the machine this server runs on. `text` is the caption.",
                        ),
                    link: z
                        .string()
                        .url()
                        .optional()
                        .describe("A URL to send as a link preview card. `text` is the caption."),
                    cardUserId: z
                        .string()
                        .min(1)
                        .optional()
                        .describe("The user id whose contact card to share in this conversation."),
                    sticker: z
                        .string()
                        .min(1)
                        .max(100)
                        .optional()
                        .describe(
                            "A keyword: sends the first sticker Zalo finds for it (zalo_sticker 'search' lists them).",
                        ),
                    voiceUrl: z
                        .string()
                        .url()
                        .optional()
                        .describe("The URL of an audio file to send as a voice message (Zalo fetches it from there)."),
                    video: z
                        .object({
                            source: z
                                .string()
                                .min(1)
                                .describe(
                                    "The video: an http(s) URL Zalo fetches, or a local file path on the machine this server runs on (uploaded)",
                                ),
                            thumbnail: z
                                .string()
                                .min(1)
                                .describe("Its thumbnail: an image URL, or a local jpg/png/webp path (uploaded)"),
                            durationMs: z.number().int().min(0).optional().describe("Its length in milliseconds"),
                            width: z.number().int().min(1).optional().describe("Its width in pixels (default 1280)"),
                            height: z.number().int().min(1).optional().describe("Its height in pixels (default 720)"),
                        })
                        .strict()
                        .optional()
                        .describe(
                            "A video to send, from a URL or a local file, with its thumbnail. `text` is the caption.",
                        ),
                    bankCard: z
                        .object({
                            bank: z
                                .string()
                                .min(1)
                                .describe("The bank: a short name such as vcb, ocb or bidv, or its BIN"),
                            accountNumber: z.string().min(1).max(40).describe("The account number"),
                            holderName: z.string().min(1).max(100).optional().describe("The account holder's name"),
                        })
                        .strict()
                        .optional()
                        .describe("A bank account card (số tài khoản) to send; zalo_bank 'banks' lists the banks."),
                    qrTransfer: z
                        .object({
                            bank: z
                                .string()
                                .min(1)
                                .describe("The bank: a short name such as vcb, ocb or bidv, or its BIN"),
                            accountNumber: z.string().min(1).max(40).describe("The account number to pay into"),
                            amount: z.number().int().min(1).optional().describe("The amount in VND"),
                            content: z.string().max(50).optional().describe("The transfer note, at most 50 characters"),
                            template: z
                                .enum(["compact", "print", "qronly"])
                                .optional()
                                .describe("The QR image's style (default compact)"),
                        })
                        .strict()
                        .optional()
                        .describe(
                            "A VietQR transfer image to generate and send. `text` replaces its default caption " +
                                "(bank, account, amount and note).",
                        ),
                    threadType: z
                        .enum(["dm", "group"])
                        .optional()
                        .describe(
                            'The conversation type: "dm" or "group". Leave it out: the type stored for this thread is used. Pass it only to override that.',
                        ),
                    quoteMsgId: z
                        .string()
                        .optional()
                        .describe(
                            "msgId of a TEXT message in this conversation to quote in your reply (from zalo_get_messages or zalo_get_history; it must be in the local cache). Photos, stickers and other non-text messages cannot be quoted.",
                        ),
                    format: z
                        .enum(["markdown", "plain"])
                        .optional()
                        .describe(
                            "How `text` is sent. `markdown` (the default) turns Markdown into Zalo's own formatting, because Zalo " +
                                "shows `**bold**` and `- item` as typed: **bold**, *italic*, ~~strike~~, # headings (bold), " +
                                "- bullets (real bullets), 1. lists (numbers kept), > quotes, `code`, [text](url) (the URL stays in " +
                                "the text), and {red:text}/{green:text}/{big:text} colors. `plain` sends the text exactly as written. " +
                                "Text that is not Markdown (snake_case, 2 * 3 * 4) is left alone either way.",
                        ),
                    urgency: z
                        .enum(["normal", "important", "urgent"])
                        .optional()
                        .describe(
                            "Mark the message the way the apps' Important/Urgent option does. Omit it, or 'normal', " +
                                "for an ordinary message",
                        ),
                })
                .strict()
                .refine(
                    (val) => Boolean(val.text) || sendModes(val).length > 0,
                    `Provide text, or one of ${SEND_MODES.join(", ")}`,
                )
                .refine(
                    (val) => sendModes(val).length <= 1,
                    `Send one kind of content per call: ${SEND_MODES.join(", ")} cannot be combined`,
                )
                .refine(
                    (val) => !(val.text && ["sticker", "voiceUrl", "bankCard"].includes(sendModes(val)[0])),
                    "A sticker, a voice message or a bank card carries no text: send the text as its own message",
                ),
        },
        async ({
            threadId: threadIdIn,
            text,
            filePath,
            files,
            link,
            cardUserId,
            sticker,
            voiceUrl,
            video,
            bankCard,
            qrTransfer,
            threadType: threadTypeIn,
            quoteMsgId,
            urgency: urgencyIn,
            format: formatIn,
        }) => {
            // `me` (or the own uid) is My Documents, always a 1-1 -- resolved
            // before anything else reads the thread id, as `msg send me` is.
            const thread = actionThread(api, threadIdIn, threadTypeIn);
            if (thread.error) {
                console.error("[mcp-tools] zalo_send_message refused:", thread.error);
                return err(thread.error);
            }
            const { threadId, threadType } = thread;
            // A group this account left or lost (src/core/group-exit.js): refused here, not at the server.
            const goneRefusal = sendRefusal(threadId);
            if (goneRefusal) return err(goneRefusal);
            // The reply every non-text send shares: the new message's ids, as a text send reports them.
            const sentReply = (kind, result, more = {}) => {
                const msgId = result?.msgId ?? result?.message?.msgId ?? null;
                const cliMsgId = result?.cliMsgId ?? result?.message?.cliMsgId ?? null;
                return ok({
                    success: true,
                    kind,
                    ...more,
                    msgId: msgId === null ? null : String(msgId),
                    ...(cliMsgId !== null && { cliMsgId: String(cliMsgId) }),
                    threadType: threadTypeName(threadType),
                    ...(thread.notice && { threadId, notice: thread.notice }),
                });
            };
            try {
                // The kinds `msg sticker`, `send-voice`, `send-video`, `send-bank` and `send-qr-transfer` send,
                // through the same session calls.
                if (sticker) {
                    const found = (await api.searchSticker(sticker))?.[0];
                    if (!found) return err(`No sticker found for "${sticker}".`);
                    const stickerObj = {
                        id: found.sticker_id || found.stickerId || found.id,
                        cateId: found.cate_id || found.cateId,
                        type: found.type || 7,
                    };
                    return sentReply("sticker", await api.sendSticker(stickerObj, threadId, Number(threadType)), {
                        stickerId: String(stickerObj.id),
                    });
                }
                if (voiceUrl) {
                    return sentReply("voice", await api.sendVoice({ voiceUrl, ttl: 0 }, threadId, Number(threadType)));
                }
                if (video) {
                    // As `msg send-video`: a URL Zalo fetches, or a local file uploaded on this server's socket; a
                    // thumbnail likewise.
                    const isUrl = (v) => /^https?:\/\//i.test(v);
                    const size = {
                        duration: video.durationMs,
                        width: video.width ?? 1280,
                        height: video.height ?? 720,
                    };
                    if (isUrl(video.source) && isUrl(video.thumbnail)) {
                        const result = await api.sendVideo(
                            { videoUrl: video.source, thumbnailUrl: video.thumbnail, msg: text ?? "", ...size },
                            threadId,
                            Number(threadType),
                        );
                        return sentReply("video", result);
                    }
                    if (isUrl(video.source)) {
                        return err(
                            "A video sent from a URL takes a thumbnail URL too; a local thumbnail goes with a local video.",
                        );
                    }
                    const file = resolve(video.source.trim());
                    const thumb = isUrl(video.thumbnail) ? null : resolve(video.thumbnail.trim());
                    const missing = [file, thumb].filter((p) => p && !existsSync(p));
                    if (missing.length > 0) return err(`File not found: ${missing.join(", ")}`);
                    const result = await api.sendVideoFile(
                        {
                            file,
                            msg: text ?? "",
                            ...(thumb ? { thumbnailFile: thumb } : { thumbnailUrl: video.thumbnail }),
                            ...size,
                        },
                        threadId,
                        Number(threadType),
                    );
                    return sentReply("video", result);
                }
                if (bankCard || qrTransfer) {
                    const spec = bankCard || qrTransfer;
                    const bin = resolveBankBin(spec.bank);
                    if (!bin)
                        return err(`Unknown bank: '${spec.bank}'. zalo_bank 'banks' lists the banks Zalo supports.`);
                    if (bankCard) {
                        const payload = { binBank: bin, numAccBank: bankCard.accountNumber };
                        if (bankCard.holderName) payload.nameAccBank = bankCard.holderName;
                        const result = await api.sendBankCard(payload, threadId, Number(threadType));
                        return sentReply("bank_card", result, { bank: BIN_TO_DISPLAY[bin] || String(bin) });
                    }
                    const qrPath = await generateQrTransferImage(
                        bin,
                        qrTransfer.accountNumber,
                        qrTransfer.amount,
                        qrTransfer.content,
                        qrTransfer.template ?? "compact",
                    );
                    if (!qrPath) return err("Could not generate the VietQR image; nothing was sent.");
                    try {
                        const caption = text || qrTransferCaption(bin, qrTransfer);
                        const result = await api.sendMessage(
                            { msg: caption, attachments: [qrPath] },
                            threadId,
                            Number(threadType),
                        );
                        const att = Array.isArray(result?.attachment) ? result.attachment[0] : result?.attachment;
                        return sentReply("qr_transfer", result?.message ?? att ?? result, {
                            bank: BIN_TO_DISPLAY[bin] || String(bin),
                        });
                    } finally {
                        try {
                            unlinkSync(qrPath);
                        } catch {
                            /* a temp file left behind is harmless */
                        }
                    }
                }

                if (cardUserId) {
                    const result = await api.sendCard({ userId: cardUserId }, threadId, Number(threadType));
                    const messageId = result?.msgId ?? result?.message?.msgId ?? null;
                    const cliMsgId = result?.cliMsgId ?? result?.message?.cliMsgId ?? null;
                    return ok({
                        success: true,
                        kind: "card",
                        cardUserId,
                        msgId: messageId,
                        ...(cliMsgId !== null && { cliMsgId: String(cliMsgId) }),
                        threadType: threadTypeName(threadType),
                        ...(thread.notice && { threadId, notice: thread.notice }),
                    });
                }

                if (link) {
                    const linkOpts = text ? { link, msg: text } : { link };
                    const result = await api.sendLink(linkOpts, threadId, Number(threadType));
                    const messageId = result?.msgId ?? result?.message?.msgId ?? null;
                    const cliMsgId = result?.cliMsgId ?? result?.message?.cliMsgId ?? null;
                    return ok({
                        success: true,
                        kind: "link",
                        link,
                        msgId: messageId,
                        ...(cliMsgId !== null && { cliMsgId: String(cliMsgId) }),
                        threadType: threadTypeName(threadType),
                        ...(thread.notice && { threadId, notice: thread.notice }),
                    });
                }

                const rawFiles = [...(filePath ? [filePath] : []), ...(Array.isArray(files) ? files : [])];
                if (rawFiles.length > 0) {
                    const absPaths = rawFiles.map((p) => resolve(String(p).trim()));
                    const missing = absPaths.filter((p) => !existsSync(p));
                    if (missing.length > 0) {
                        return err(`File not found: ${missing.join(", ")}`);
                    }
                    // A caption is text too: Markdown in it is converted the same way.
                    const caption =
                        text && resolveSendFormat({ explicit: formatIn, fallback: "markdown" }) === "markdown"
                            ? markdownToZalo(text)
                            : { text: text || "", styles: [] };
                    const result = await api.sendMessage(
                        {
                            msg: caption.text,
                            attachments: absPaths,
                            ...(caption.styles.length > 0 && { styles: caption.styles }),
                        },
                        threadId,
                        Number(threadType),
                    );
                    const rawAtt = result?.attachment;
                    const attRows = rawAtt ? (Array.isArray(rawAtt) ? rawAtt : [rawAtt]) : [];
                    const sent = attRows
                        .filter((r) => (r?.msgId ?? null) !== null)
                        .map((r) => ({
                            msgId: String(r.msgId),
                            cliMsgId: (r.cliMsgId ?? null) === null ? null : String(r.cliMsgId),
                        }));
                    const messageId =
                        result?.message?.msgId ?? result?.msgId ?? (sent.length > 0 ? sent[0].msgId : null);
                    const cliMsgId =
                        result?.message?.cliMsgId ?? result?.cliMsgId ?? (sent.length > 0 ? sent[0].cliMsgId : null);
                    return ok({
                        success: true,
                        kind: "attachment",
                        files: absPaths,
                        sent,
                        msgId: messageId,
                        ...(cliMsgId !== null && { cliMsgId: String(cliMsgId) }),
                        threadType: threadTypeName(threadType),
                        ...(thread.notice && { threadId, notice: thread.notice }),
                    });
                }

                if (!text) {
                    return err(`Provide text, or one of ${SEND_MODES.join(", ")}.`);
                }

                const warnings = [];

                // `@[uid]` -> `@Display Name`, with the mention offsets measured
                // on the string that comes out. The CLI runs this last, after
                // markdown, because a display name may itself contain `*` or `_`;
                // there is no markdown or style pass here, so there is nothing to
                // order against and nothing to move — if styles are ever added to
                // this tool, they must be run through `shiftStyles(styles,
                // expanded.edits)` the way `msg send` does.
                // Markdown first, then mentions: a display name may itself contain `*` or `_`, whereas an
                // `@[uid]` token contains no Markdown (the converter passes it through). The style ranges
                // are counted before the names go in, so they move across the substitutions (`shiftStyles`).
                const format = resolveSendFormat({ explicit: formatIn, fallback: "markdown" });
                const converted = format === "markdown" ? markdownToZalo(text) : { text, styles: [] };
                const unresolved = [];
                const expanded = expandMentions(converted.text, (uid) => {
                    const name = cachedDisplayName(uid);
                    if (!name && uid !== ALL_MENTION_UID) unresolved.push(uid);
                    return name;
                });
                const mentions = expanded.mentions;
                const styles = shiftStyles(converted.styles, expanded.edits);

                // The session drops mentions outside a group, so a DM send would
                // quietly arrive with the names as plain text and nobody tagged.
                if (mentions.length > 0 && Number(threadType) !== THREAD_GROUP) {
                    warnings.push(
                        "Mentions only apply to group messages. This was sent with threadType " +
                            `${threadTypeName(threadType)}, so the names went out as plain text and nobody was tagged.`,
                    );
                }

                let quote;
                if (quoteMsgId) {
                    // buildQuote needs `cliMsgId` and the `property` blob, which
                    // live only in the cached row's raw_data. A db that is not
                    // open reads as "not cached", whose message names the fix.
                    let row = null;
                    try {
                        row = getMessageForAction(quoteMsgId);
                    } catch (e) {
                        if (e?.code === "ROW_MAC") return err(e.message);
                        console.error("[mcp-tools] cache unavailable for quote:", e.message);
                    }
                    const built = buildQuote(row, { msgId: quoteMsgId, threadId });
                    // Reported through err() rather than letting the session raise a
                    // raw ZaloApiError: "stickers can't be quoted" and "not
                    // cached, fetch the thread" are different problems and the
                    // agent can act on both.
                    if (built.error) {
                        console.error("[mcp-tools] zalo_send_message quote error:", built.error);
                        return err(built.error);
                    }
                    if (built.warning) warnings.push(built.warning);
                    quote = built.quote;
                    // A sync-restored row's sender is a noised id that Zalo
                    // rejects with code 114, so resolve it rather than hand the
                    // caller a send that cannot land.
                    if (built.opaqueSender) {
                        const fixed = await resolveQuoteSender(quote, api);
                        if (fixed.error) {
                            console.error("[mcp-tools] zalo_send_message quote sender:", fixed.error);
                            return err(fixed.error);
                        }
                        if (fixed.resolved) warnings.push(`Resolved the quoted message's sender: ${fixed.resolved}`);
                    }
                }

                // Never changes the text: it only tells the agent, in this reply, what it sent.
                if (hasLiteralNewline(text)) warnings.push(LITERAL_NEWLINE_WARNING);

                // 1 (important) or 2 (urgent), mapped exactly as `msg send
                // --urgency` maps it; the session turns it into the `metaData:
                // {urgency}` Zalo Web sends. "normal" is no urgency at all.
                const urgency = urgencyIn ? urgencyLevel(urgencyIn) : null;

                // Zalo refuses one oversized message (114 plain, 112 styled), so a long text goes out as Web sends
                // it: split at 3000 bytes of text plus styles, in order, 300 ms apart. The quote and the urgency
                // belong to the first part only.
                const parts = splitMessage({ text: expanded.text, styles, mentions });
                const contentOf = (part, index) => {
                    const first = index === 0;
                    const extras = part.mentions.length > 0 || part.styles.length > 0 || (first && (quote || urgency));
                    return extras
                        ? {
                              msg: part.text,
                              ...(part.mentions.length > 0 && { mentions: part.mentions }),
                              ...(part.styles.length > 0 && { styles: part.styles }),
                              ...(first && quote && { quote }),
                              ...(first && urgency && { urgency }),
                          }
                        : part.text;
                };

                for (const w of warnings) console.error("[mcp-tools] zalo_send_message warning:", w);

                const results = await sendParts(parts, (part, index) =>
                    api.sendMessage(contentOf(part, index), threadId, Number(threadType)),
                );
                const result = results[0];
                const messageId = result?.message?.msgId ?? result?.msgId ?? null;
                // `msg react`, `msg undo` and a later quote all key off cliMsgId,
                // and it appears in no other output. Without it an agent cannot
                // act on the message it just sent -- not even by shelling out.
                const cliMsgId = result?.message?.cliMsgId ?? result?.cliMsgId ?? null;
                return ok({
                    success: true,
                    msgId: messageId,
                    ...(cliMsgId !== null && { cliMsgId: String(cliMsgId) }),
                    threadType: threadTypeName(threadType),
                    // Only for `me`: the thread it really went to, which is
                    // what a later zalo_get_history names.
                    ...(thread.notice && { threadId, notice: thread.notice }),
                    // Only when it differs, so the common send keeps its shape:
                    // the agent wrote `@[123]` and needs to know what was sent.
                    ...(expanded.text !== text && { text: expanded.text }),
                    ...(styles.length > 0 && { formatted: styles.length }),
                    ...(unresolved.length > 0 && { unresolvedMentions: unresolved }),
                    // Only when it was split: every part's ids, in order (msgId/cliMsgId above are the first).
                    ...(parts.length > 1 && {
                        splitInto: parts.length,
                        parts: results.map((r) => {
                            const partId = r?.message?.msgId ?? r?.msgId ?? null;
                            const partCli = r?.message?.cliMsgId ?? r?.cliMsgId ?? null;
                            return {
                                msgId: partId,
                                ...(partCli !== null && { cliMsgId: String(partCli) }),
                            };
                        }),
                    }),
                    ...(warnings.length > 0 && { warnings }),
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_send_message error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_list_threads ---
    server.registerTool(
        "zalo_list_threads",
        {
            title: "List Zalo Threads",
            description:
                "List the conversations that have received a message since this server started (the live buffer), each with this consumer's unread count. Use it to see what is active right now; use zalo_list_conversations for recent conversations whenever they last had a message, and zalo_search_threads to find one by name. " +
                "Returns `{ threads, total }`; each thread has `threadId`, `name`, `threadType`, `unread` (this consumer's own count), `total`, `lastActivity` and `readState` (how far the account owner has read it on Zalo, on any device; null when unknown).",
            inputSchema: z.object({
                type: z
                    .enum(["group", "dm", "all"])
                    .default("all")
                    .describe("Filter by thread type: 'dm', 'group', or 'all'"),
                consumer: consumerSchema,
            }),
        },
        async ({ type, consumer }) => {
            try {
                // Unread is per consumer: after what this consumer marked read.
                const stats = withoutHidden(buffer.getStats(buffer.readCursor(consumer)), hiddenSet(), hiddenMode());
                const dmNames = await resolveCurrentUserNames(
                    api,
                    stats.filter((t) => buffer.getThreadType(t.threadId) === "dm").map((t) => t.threadId),
                );
                const reads = readStatesOf(
                    api,
                    stats.map((t) => String(t.threadId)),
                );
                // Enrich each stat entry with threadType, thread name and read state
                const gone = goneGroupMap();
                const enriched = stats.map((t) => {
                    const threadType = buffer.getThreadType(t.threadId) ?? "unknown";
                    const cached = nameCache?.get(t.threadId);
                    return {
                        ...t,
                        threadType,
                        name: dmNames.get(String(t.threadId))?.name ?? cached?.name ?? null,
                        ...(cached?.memberCount !== undefined && { memberCount: cached.memberCount }),
                        readState: describeReadState(reads.get(String(t.threadId))),
                        // Left, removed, blocked or disbanded (src/core/group-exit.js); sends to it are refused.
                        ...goneFields(gone.get(String(t.threadId)) ?? null),
                    };
                });
                const filtered = type === "all" ? enriched : enriched.filter((t) => t.threadType === type);
                return ok({ threads: filtered, total: filtered.length });
            } catch (e) {
                console.error("[mcp-tools] zalo_list_threads error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_search_threads ---
    server.registerTool(
        "zalo_search_threads",
        {
            title: "Search Zalo Threads",
            description:
                "Find a conversation by name, to get its `threadId`. It is a fuzzy search that ignores case and Vietnamese accents, over the names this server knows (cached contacts and groups); every match is returned unless you pass `limit`. To find a person by phone number or username instead, use zalo_lookup_user. " +
                "Returns `{ results, total }`; use a result's `threadId` in zalo_send_message, zalo_get_history and the other tools.",
            inputSchema: z.object({
                query: z.string().min(1).describe("Search keyword (fuzzy match, case-insensitive, accent-insensitive)"),
                type: z
                    .enum(["group", "dm", "all"])
                    .default("all")
                    .describe("Filter by thread type: 'dm', 'group', or 'all'"),
                limit: z.number().int().min(1).optional().describe("Max results to return (omit for every match)"),
            }),
        },
        async ({ query, type, limit }) => {
            try {
                if (!nameCache?.ready) {
                    return err("Thread name cache not initialized yet. Try again shortly.");
                }
                await nameCache.refreshUsers?.(api);
                // Over-fetch by the hidden count, so a left-out conversation does not shorten the list.
                const all = withoutHidden(
                    nameCache.search(query, type, limit ? limit + hiddenIds().length : null),
                    hiddenSet(),
                    hiddenMode(),
                );
                const results = limit ? all.slice(0, limit) : all;
                return ok({ results, total: results.length });
            } catch (e) {
                console.error("[mcp-tools] zalo_search_threads error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_mark_read ---
    server.registerTool(
        "zalo_mark_read",
        {
            title: "Mark Zalo Messages Read",
            description:
                "Mark messages as read for this consumer, up to and including `cursor` (the `cursor` of the last zalo_get_messages or zalo_wait_for_message reply). Call it once a batch is handled, or the same messages come back. " +
                "It only moves this consumer's read cursor: other bots keep their own, nothing is deleted (messages leave the buffer by age or size), and nothing is marked read on Zalo, so the owner's own unread state is unchanged. " +
                "Returns `{ success, marked, readCursor }`.",
            inputSchema: z.object({
                cursor: z
                    .number()
                    .int()
                    .min(0)
                    .describe("Cursor value returned from a previous zalo_get_messages call"),
                consumer: consumerSchema,
            }),
        },
        async ({ cursor, consumer }) => {
            try {
                const marked = buffer.markRead(cursor, consumer);
                return ok({ success: true, marked, readCursor: buffer.readCursor(consumer) });
            } catch (e) {
                console.error("[mcp-tools] zalo_mark_read error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_get_history ---
    server.registerTool(
        "zalo_get_history",
        {
            title: "Get Zalo Message History",
            description:
                "Get the stored messages of one conversation (DM or group), for context older than the live buffer. It reads the local cache first (everything the listener and `zalo-agent sync` have saved, which can be the full history) and asks the Zalo server only when the cache has nothing for the thread. " +
                "Page back with `before` (epoch ms: the `cursor` of the previous reply) or, on the server path, `lastMsgId` (the previous reply's `cursor`). Zalo's server serves only messages since this login: `filtered: true` in the reply means older ones exist that only `zalo-agent sync` can restore, and that needs the owner's phone. " +
                "Each message has `msgId`, `senderId`, `senderName` (your alias for the sender when you set one, else the name the message carried), `senderAlias`, `senderZaloName` (the name the message carried), `senderDisplayName` (the current name: your alias, else the phonebook name, else the Zalo name, else the display name, else the uid; `senderDisplayNameSource` says which), `text`, `timestamp` and `type`. Reply: `{ threadId, threadType, count, messages, cursor, hasMore }`. " +
                "For one period, pass `since` and/or `until` (epoch ms) or `last` (7d, 2w, 3m, 1y): the cached messages in it come oldest first, up to `limit` (here up to 1000) per page, with `hasMore` and `nextSince` (pass it back as `since`, same `until`) for the rest. Reply: `{ threadId, since, until, count, messages, hasMore, nextSince }`. It reads only the cache. " +
                "Start with a small `limit` and page; a large one costs memory and time. To find messages by their text, use zalo_search_messages.",
            inputSchema: z.object({
                threadId: z
                    .string()
                    .describe("The conversation: the other person's user id for a DM, the group id for a group."),
                threadType: z
                    .enum(["dm", "group"])
                    .optional()
                    .describe(
                        'The conversation type: "dm" or "group". Leave it out: the type stored for this thread is used. Pass it only to override that.',
                    ),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(HISTORY_RANGE_PAGE_MAX)
                    .default(50)
                    .describe(
                        "Most messages to return (default 50): up to 200, or up to 1000 with `since`, `until` or `last`.",
                    ),
                lastMsgId: z
                    .string()
                    .optional()
                    .nullable()
                    .describe("Server path only: the `cursor` of the previous reply, to page further back."),
                before: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe(
                        "Cache path: only messages older than this epoch-ms timestamp (the `cursor` of the previous reply), to page back.",
                    ),
                since: z
                    .number()
                    .int()
                    .nonnegative()
                    .optional()
                    .describe(
                        "Only messages at or after this time (epoch ms), oldest first; or the `nextSince` of the previous reply.",
                    ),
                until: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Only messages at or before this time (epoch ms)."),
                last: z
                    .string()
                    .optional()
                    .describe("Only the last period, ending now: 7d, 2w, 3m, 1y or 12h (replaces `since`)."),
            }),
        },
        async ({ threadId, threadType: threadTypeIn, limit, lastMsgId, before, since, until, last }) => {
            if (isHiddenThread(threadId)) return err(HIDDEN_THREAD);
            const threadType = resolveThreadType(threadId, threadTypeIn);
            if (since !== undefined || until !== undefined || last !== undefined) {
                if (before !== undefined || lastMsgId) {
                    return err("Use either a period (`since`, `until`, `last`) or `before`/`lastMsgId`, not both.");
                }
                let from;
                try {
                    from = last !== undefined ? parsePeriod(last) : (since ?? null);
                } catch (e) {
                    return err(e.message);
                }
                const to = until ?? null;
                if (from !== null && to !== null && from > to) return err("`since` is after `until`.");
                try {
                    const page = cacheHistoryRange(threadId, { since: from, until: to, limit }, nameCache);
                    page.threadType = threadType === THREAD_USER ? "dm" : "group";
                    page.messages = await withCurrentSenderNames(
                        api,
                        page.messages,
                        threadType === THREAD_USER ? [threadId] : [],
                    );
                    return ok(page);
                } catch (e) {
                    return err(`The local cache could not be read: ${e.message}`);
                }
            }
            // Without a period a page stays at 200, as it always was.
            limit = Math.min(limit, HISTORY_PAGE_MAX);
            try {
                // The cache is the better source and usually the only one that
                // answers: Zalo returns an empty set for the socket history
                // request on current accounts, while the cache holds whatever
                // the listener saw and whatever a transfer sync restored.
                const cached = cacheHistory(threadId, limit, before, nameCache);
                if (cached) {
                    cached.messages = await withCurrentSenderNames(
                        api,
                        cached.messages,
                        threadType === THREAD_USER ? [threadId] : [],
                    );
                    return ok(cached);
                }

                // Nothing cached: ask Zalo through the one shared fetch `listen`'s
                // daemon uses for `msg history` (src/core/history-fetch.js): a
                // group's cloud-message store first, then the socket stream, and
                // what comes back is cached insert-if-absent — this server is the
                // account's db writer. It used to be a hand-rolled socket loop that
                // never asked a group's store and cached nothing (triage M6).
                // One stage at a time on this socket: a sync stage beside a scan
                // lost the socket once, and an AI client should hear "busy" now
                // rather than wait minutes behind a restore.
                const release = stageLock ? stageLock.tryAcquire("history") : () => {};
                if (!release) {
                    const busy = stageLock.current();
                    return err(
                        `A ${busy?.stage || "sync"} stage is running on this socket. Try again when it finishes.`,
                    );
                }
                let fetched;
                try {
                    fetched = await fetchAndCacheHistory(api, threadId, threadType, {
                        limit,
                        fromMsgId: lastMsgId || null,
                    });
                } finally {
                    release();
                }

                const allMessages = fetched.frames.map((f) => {
                    const d = f.data || {};
                    const rawContent = d.content;
                    const isText = typeof rawContent === "string";
                    return {
                        msgId: d.msgId,
                        cliMsgId: d.cliMsgId ? String(d.cliMsgId) : undefined,
                        threadId: f.threadId,
                        senderId: d.uidFrom || null,
                        ...senderNameFields(d.uidFrom, d.dName),
                        text: isText ? rawContent : extractMessageText(rawContent, d.msgType),
                        timestamp: d.ts ? Number(d.ts) : null,
                        type: isText ? "text" : d.msgType || "attachment",
                        replyTo: resolveReplyTo(quotedReply(d.quote), f.threadId),
                    };
                });

                // Sort oldest first; the oldest message is where the next page starts.
                allMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                const cursor = allMessages.length ? String(allMessages[0].msgId) : lastMsgId || null;

                // Enrich with thread name
                if (nameCache) {
                    const info = nameCache.get(threadId);
                    if (info) {
                        for (const msg of allMessages) msg.threadName = info.name;
                    }
                }

                return ok({
                    threadId,
                    threadType: threadType === 0 ? "dm" : "group",
                    source: "server",
                    // Which Zalo path answered: a group's cloud-message store, or the socket stream.
                    via: fetched.source,
                    count: allMessages.length,
                    messages: await withCurrentSenderNames(
                        api,
                        allMessages,
                        threadType === THREAD_USER ? [threadId] : [],
                    ),
                    cursor,
                    hasMore: Boolean(fetched.more) || (fetched.source === "socket" && allMessages.length >= limit),
                    filtered: fetched.filtered === true,
                    ...(fetched.filtered || allMessages.length === 0
                        ? {
                              note:
                                  "Zalo serves a conversation's messages only since this login; older ones are " +
                                  "withheld. `zalo-agent sync` restores them from the owner's phone (it asks for a " +
                                  "tap), and zalo_get_history then reads them from the cache.",
                          }
                        : {}),
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_get_history error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_view_media ---
    const mediaConfig = config.media || {};
    /** The account the cached media is sealed for (its folder holds the keyring). */
    const mediaScope = () => scopeOfDir(accountDir || getAccountDir(String(ownIdOf(api) ?? "")));
    server.registerTool(
        "zalo_view_media",
        {
            title: "View Zalo Media",
            description:
                "Get a received photo, sticker, voice message, video or file. The cached file is encrypted; it reaches you one of three ways (`deliver`): " +
                '"inline" (the picture or voice itself, as image or audio content, up to about 5 MB), "link" (`url`, a link to this server that works for 10 minutes; ' +
                'it may need the same Authorization as this server), or "tempfile" (`path`, a private decrypted copy on the machine this server runs on, deleted at `expiresAt`; only for a client on that machine). ' +
                "By default pictures and voice come inline and videos and files as a link, as the server is configured. Media not downloaded yet is downloaded first. " +
                "Returns `{ success, msgId, mediaType, delivery, mimeType, size }` plus `url`/`path` and `expiresAt`, and `notes` when the delivery differs from the one asked for.",
            inputSchema: z.object({
                msgId: z
                    .string()
                    .describe(
                        "msgId of a message that has a photo, sticker, voice message, video or file (from zalo_get_messages, zalo_wait_for_message or zalo_get_history).",
                    ),
                threadId: z.string().optional().describe("Only look in this conversation. Omit to search all of them."),
                deliver: z
                    .enum(["inline", "link", "tempfile"])
                    .optional()
                    .describe(
                        'How to get it: "inline", "link" or "tempfile". Omit for the server\'s default for this kind of media. The server may forbid a mode (media.allowDeliver).',
                    ),
                open: z
                    .boolean()
                    .optional()
                    .describe(
                        "Also open it with the viewer of the machine this server runs on (a local stdio server only; it delivers a tempfile). Omit for the server's default (media.autoOpen).",
                    ),
            }),
        },
        async ({ msgId, threadId, deliver, open }) => {
            try {
                // The cached row is authoritative: it records where a fetched
                // file actually landed, so a message that arrived before this
                // process started is still openable. The buffer is only a
                // fallback for a thread id.
                let row = null;
                try {
                    row = getMessageForAction(msgId);
                } catch (e) {
                    if (e?.code === "ROW_MAC") return err(e.message);
                    console.error("[mcp-tools] cache unavailable:", e.message);
                }
                const buffered = buffer.read(threadId, 0).messages.find((m) => m.msgId === msgId) || null;
                if (!row && !buffered) return err(`Message ${msgId} not found in cache or buffer`);
                const kind = String(row?.type || buffered?.type || "");
                const msgThread = row?.threadId ?? buffered?.threadId ?? threadId ?? null;
                // A hidden chat's media is left out like its messages: no inline content, no link, no copy.
                if (isHiddenThread(msgThread)) return err(HIDDEN_THREAD);

                const accountId = String(ownIdOf(api) ?? "");
                const policy = resolveMediaDelivery({ config, accountId: accountId || undefined });
                const stdio = server?.statelessHttp !== true;
                const choose = (size, mime) =>
                    chooseDelivery({
                        kind,
                        size,
                        mime,
                        requested: deliver ?? null,
                        open,
                        policy,
                        stdio,
                        clientLoopback: server?.clientLoopback === true,
                    });

                // A sticker is not downloaded with the messages: its picture is fetched now, shown inline and not kept.
                if (kind === "sticker" && !row?.localPath) {
                    const sticker = await stickerPicture(api, row, buffered);
                    if (sticker.error) return err(sticker.error);
                    const pick = choose(sticker.bytes.length, sticker.mime);
                    if (pick.error) return err(pick.error);
                    if (pick.mode !== "inline") {
                        return err(
                            "A sticker is not stored on this server, so it can only be sent inline" +
                                (pick.notes.length ? ` (${pick.notes.join("; ")})` : "") +
                                ".",
                        );
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    success: true,
                                    msgId,
                                    mediaType: kind,
                                    delivery: "inline",
                                    mimeType: sticker.mime,
                                    size: sticker.bytes.length,
                                }),
                            },
                            inlineContent(sticker.bytes, kind, sticker.mime),
                        ],
                    };
                }

                if (row && !row.has_attachment && !buffered?.attachment?.url) {
                    return err(`Message ${msgId} has no media attachment`);
                }

                let localPath = row?.localPath || null;
                if (!localPath) {
                    // Same downloader as the CLI, so the file lands in the one
                    // per-conversation folder every other command reads from. It is asked for this message by
                    // id: a scan of the thread's newest pending attachments could leave an older one out.
                    const stats = await downloadSyncedMedia({
                        api,
                        accountDir,
                        threadId: String(msgThread || ""),
                        msgIds: [String(row?.msgId ?? msgId)],
                        limit: 1,
                        concurrency: 1,
                        mediaRoot: process.env.ZALO_MEDIA_DIR || mediaConfig.downloadDir || undefined,
                    });
                    localPath = getMessageById(msgId)?.localPath || null;
                    if (!localPath) {
                        return err(
                            `Could not fetch media for ${msgId} (${stats.expired} expired, ` +
                                `${stats.throttled} rate limited, ${stats.unknown} unexplained, ` +
                                `${stats.failed} failed). Rate limiting clears on a retry; an unexplained ` +
                                `failure is usually a 403, which Zalo returns for a lapsed signature and ` +
                                `under load alike. Try zalo-agent sync-media, then zalo-agent sync.`,
                        );
                    }
                }

                // The cached file stays sealed (keystore/media-seal.js): it is delivered inline, as a link served from
                // the sealed file, or as a private decrypted copy (src/core/media-deliver.js).
                const info = mediaInfo(localPath);
                const pick = choose(info.size, info.mime);
                if (pick.error) return err(pick.error);
                const out = await deliverCachedMedia({
                    mode: pick.mode,
                    file: localPath,
                    scope: mediaScope(),
                    msgId: row?.msgId ?? msgId,
                    threadId: msgThread,
                    accountId,
                    info,
                    policy,
                    ensureServed: ensureMediaServed,
                });
                if (pick.open && out.path) openFile(out.path);
                const reply = {
                    success: true,
                    msgId,
                    mediaType: kind || null,
                    delivery: out.mode,
                    mimeType: out.mimeType,
                    size: out.size,
                    ...(out.url ? { url: out.url, auth: out.auth } : {}),
                    ...(out.path ? { path: out.path, opened: pick.open } : {}),
                    ...(out.expiresAt ? { expiresAt: new Date(out.expiresAt).toISOString() } : {}),
                    ...(pick.notes.length ? { notes: pick.notes } : {}),
                };
                if (out.mode !== "inline") return ok(reply);
                return {
                    content: [
                        { type: "text", text: JSON.stringify(reply) },
                        inlineContent(out.bytes, kind, out.mimeType),
                    ],
                };
            } catch (e) {
                console.error("[mcp-tools] zalo_view_media error:", e.message);
                return err(e.message);
            }
        },
    );

    // The threadType parameter of the message actions, worded as the send's is.
    const threadTypeSchema = z
        .enum(["dm", "group"])
        .optional()
        .describe(
            'The conversation type: "dm" or "group". Leave it out: the type stored for this thread is used. Pass it only to override that.',
        );
    const cliMsgIdSchema = z
        .string()
        .min(1)
        .optional()
        .describe(
            "The message's cliMsgId. zalo_send_message returns it for a message you sent; omit it and it is " +
                "read from the local cache",
        );

    // --- zalo_react ---
    server.registerTool(
        "zalo_react",
        {
            title: "React to a Zalo Message",
            description:
                "React to a message with a Zalo reaction. `reaction` is a reaction code, not an emoji character: `/-strong` like, `/-heart` heart, `:>` haha, `:o` wow, `:-((` cry, `:-h` angry, `:-*` kiss, `:')` tears of joy, `/-weak` dislike. " +
                "Give the message's `msgId` (the `msgId` of a message from zalo_get_messages, zalo_wait_for_message, zalo_get_history or zalo_search_messages, or of a zalo_send_message reply). Zalo also keys a reaction on the message's `cliMsgId`, which is read from the local cache unless you pass it (zalo_send_message returns it for your own messages); when neither has it the call is refused and nothing is sent, because Zalo accepts a reaction without it and never shows it. " +
                "`threadId` may be `me` for My Documents. Returns `{ success, reaction, msgId, cliMsgId, threadId, threadType }`.",
            inputSchema: z.object({
                msgId: z
                    .string()
                    .min(1)
                    .describe(
                        "msgId of the message to react to: the `msgId` of a message from zalo_get_messages, zalo_wait_for_message, zalo_get_history or zalo_search_messages, or of a zalo_send_message reply.",
                    ),
                threadId: z
                    .string()
                    .min(1)
                    .describe(
                        "The conversation the message is in: the user id for a DM, the group id for a group. `me` is My Documents.",
                    ),
                reaction: z
                    .string()
                    .min(1)
                    .describe(
                        "A Zalo reaction code, not an emoji character: `/-strong` like, `/-heart` heart, `:>` haha, `:o` wow, `:-((` cry, `:-h` angry, `:-*` kiss, `:')` tears of joy, `/-weak` dislike.",
                    ),
                threadType: threadTypeSchema,
                cliMsgId: cliMsgIdSchema,
            }),
        },
        async ({ msgId, threadId: threadIdIn, reaction, threadType: threadTypeIn, cliMsgId }) => {
            const thread = actionThread(api, threadIdIn, threadTypeIn);
            if (thread.error) {
                console.error("[mcp-tools] zalo_react refused:", thread.error);
                return err(thread.error);
            }
            const { threadId, threadType } = thread;
            try {
                // `msg react`'s own resolution (src/core/cached-message.js),
                // and like it, settled before the api is touched: a message
                // with no known cliMsgId is refused without a request.
                const target = reactionCliMsgId({ msgId, threadId, cliMsgId }, { passItAs: CLI_MSG_ID_HINT });
                if (target.error) {
                    console.error("[mcp-tools] zalo_react refused:", target.error);
                    return err(target.error);
                }
                const dest = { data: { msgId, cliMsgId: target.cliMsgId }, threadId, type: Number(threadType) };
                await api.addReaction(reaction, dest);
                return ok({
                    success: true,
                    reaction,
                    msgId,
                    cliMsgId: target.cliMsgId,
                    threadId,
                    threadType: threadTypeName(threadType),
                    ...(thread.notice && { notice: thread.notice }),
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_react error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_undo ---
    server.registerTool(
        "zalo_undo",
        {
            title: "Recall a Zalo Message",
            description:
                'Recall (unsend) one of your own messages for everyone in the conversation, as the apps\' "Thu hồi" does. Zalo accepts a recall only for a while after the message was sent. It cannot be undone, so it is asked about first (`confirm`, `dryRun`). ' +
                "Give the message's `msgId` (from the zalo_send_message reply, or from zalo_get_history) and its `cliMsgId` (also in the send reply; read from the local cache when you leave it out); with neither, nothing is sent. To remove a message from your own view only, or someone else's message in a group as an admin, use zalo_delete_message. `threadId` may be `me` for My Documents.",
            inputSchema: z.object({
                msgId: z
                    .string()
                    .min(1)
                    .describe(
                        "msgId of your own message to recall (from the zalo_send_message reply, or from zalo_get_history).",
                    ),
                threadId: z
                    .string()
                    .min(1)
                    .describe(
                        "The conversation the message is in: the user id for a DM, the group id for a group. `me` is My Documents.",
                    ),
                threadType: threadTypeSchema,
                cliMsgId: cliMsgIdSchema,
                confirm: confirmInput("the recall"),
                ticket: ticketInput(),
                dryRun: dryRunInput("the recall"),
            }),
        },
        async ({ msgId, threadId: threadIdIn, threadType: threadTypeIn, cliMsgId, confirm, dryRun, ticket }, extra) => {
            const thread = actionThread(api, threadIdIn, threadTypeIn);
            if (thread.error) {
                console.error("[mcp-tools] zalo_undo refused:", thread.error);
                return err(thread.error);
            }
            const { threadId, threadType } = thread;
            try {
                // `msg undo`'s own resolution: the caller's id, else the cache's.
                const target = recallCliMsgId({ msgId, threadId, cliMsgId }, { passItAs: CLI_MSG_ID_HINT });
                if (target.error) {
                    console.error("[mcp-tools] zalo_undo refused:", target.error);
                    return err(target.error);
                }
                const held = await gate(
                    "msg.undo",
                    { msgId, threadId, cliMsgId: target.cliMsgId },
                    { confirm, dryRun, ticket },
                    extra,
                );
                if (held) return held;
                // A group recall carries the group's own visibility, from the thread cache or Zalo, as `msg undo`.
                const payload = await undoPayload(
                    api,
                    { msgId, cliMsgId: target.cliMsgId },
                    threadId,
                    Number(threadType),
                    {
                        cache: nameCache,
                    },
                );
                await api.undo(payload, threadId, Number(threadType));
                return ok({
                    success: true,
                    msgId,
                    cliMsgId: target.cliMsgId,
                    threadId,
                    threadType: threadTypeName(threadType),
                    ...(thread.notice && { notice: thread.notice }),
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_undo error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_get_group_members ---
    server.registerTool(
        "zalo_get_group_members",
        {
            title: "List Zalo Group Members",
            description:
                "List the members of a group: each member's `userId`, `displayName` (your alias for them when you set one, else their name from the cache, or from Zalo for members the cache cannot name), `alias` and `zaloName`, and `totalMember`, Zalo's own count (it can be larger than the members listed). Use a `userId` as `@[userId]` in zalo_send_message to mention that member.",
            inputSchema: z.object({
                groupId: z
                    .string()
                    .min(1)
                    .describe("The group's thread id (from zalo_search_threads or zalo_list_conversations)"),
            }),
        },
        async ({ groupId }) => {
            try {
                const group = await groupMemberUids(api, groupId);
                if (!group.found) {
                    return err(
                        `Zalo's answer does not include group ${groupId}: this account is not in it, or it is not ` +
                            "a group id (a 1-1 conversation's id is the other person's uid).",
                    );
                }

                // The cache first, as a mention is named; one batched lookup
                // (the one `msg send` uses) for the members it cannot name.
                // Nothing is written back: zalo.db has three writers.
                // `names` holds the name each member goes by on Zalo; the owner's alias is applied below.
                const names = new Map();
                const unnamed = [];
                for (const uid of group.uids) {
                    const name = cachedStoredName(uid);
                    if (name) names.set(uid, name);
                    else if (!aliasFor(uid)) unnamed.push(uid);
                }
                const warnings = [];
                if (unnamed.length > 0) {
                    const fetched = await fetchMemberNames(api, unnamed, { batchSize: MEMBER_NAME_BATCH });
                    for (const [uid, name] of fetched.names) names.set(uid, name);
                    const still = unnamed.filter((uid) => !names.has(uid)).length;
                    if (fetched.errors.length > 0 && still > 0) {
                        warnings.push(`Zalo did not name ${still} member(s): ${fetched.errors[0]}`);
                    }
                }
                for (const w of warnings) console.error("[mcp-tools] zalo_get_group_members warning:", w);

                // `displayName` alias first, as Zalo's member list shows them; `alias` and `zaloName` beside it.
                const members = group.uids.map((uid) => {
                    const alias = aliasFor(uid);
                    const zaloName = names.get(uid) ?? null;
                    return { userId: uid, displayName: alias ?? zaloName, alias, zaloName };
                });
                return ok({
                    groupId,
                    name: group.name,
                    totalMember: group.totalMember,
                    count: members.length,
                    members,
                    ...(warnings.length > 0 && { warnings }),
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_get_group_members error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_list_conversations ---
    server.registerTool(
        "zalo_list_conversations",
        {
            title: "List Recent Zalo Conversations",
            description:
                "List the conversations this account was most recently active in, newest first, from the local cache, to get a `threadId` or to see what is current. Unlike zalo_list_threads it is not limited to messages that arrived since this server started. " +
                "Each has its `threadId`, `threadType`, `name` and last activity, plus `readState`: how far the account owner has read it on Zalo (on any device), meaning the newest message read, how many cached messages from others came after it, and whether it is marked unread (null when unknown). Every cached conversation is returned unless you pass `limit`, which is per type: with `type` 'all' that is up to `limit` DMs and `limit` groups.",
            inputSchema: z.object({
                type: z
                    .enum(["group", "dm", "all"])
                    .default("all")
                    .describe("Filter by thread type: 'dm', 'group', or 'all'"),
                limit: z.number().int().min(1).optional().describe("Max conversations of each type (omit for all)"),
            }),
        },
        async ({ type, limit }) => {
            try {
                const threads = recentConversations(limit, type, { excludeThreadIds: hiddenIds() });
                const dmNames = await resolveCurrentUserNames(
                    api,
                    threads.filter((t) => t.type !== "group").map((t) => String(t.threadId)),
                );
                const reads = readStatesOf(
                    api,
                    threads.map((t) => String(t.threadId)),
                );
                const conversations = threads.map((t) => {
                    const isGroup = t.type === "group";
                    const ts = Number(t.lastUpdate) || null;
                    return {
                        threadId: String(t.threadId),
                        threadType: isGroup ? "group" : "dm",
                        name:
                            dmNames.get(String(t.threadId))?.name ||
                            t.name ||
                            nameCache?.get(String(t.threadId))?.name ||
                            null,
                        lastActivity: ts,
                        lastActivityAt: ts ? new Date(ts).toISOString() : null,
                        readState: describeReadState(reads.get(String(t.threadId))),
                        // A group this account left or lost, kept by groups.onLeave "keep" (src/core/group-exit.js).
                        ...(t.gone && { gone: true, leftAt: t.leftAt, goneReason: t.goneReason }),
                    };
                });
                return ok({
                    conversations,
                    total: conversations.length,
                    source: "cache",
                    ...(conversations.length === 0 && {
                        note:
                            "The local cache holds no conversations yet. This server records them as messages " +
                            "arrive, and `zalo-agent sync` restores older ones from the owner's phone.",
                    }),
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_list_conversations error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_coverage ---
    server.registerTool(
        "zalo_coverage",
        {
            title: "Zalo Cache Coverage",
            description:
                "Check how complete the local message cache is. Lists the coverage gaps still pending (windows in which this account's connection to Zalo was down, so messages from them may be missing), each with its from/to and reason, counts the gaps already resolved, and names the `zalo-agent sync --from <date>` run that restores the pending ones from the owner's phone. That run needs a tap on the phone, so the owner must approve it; call zalo_sync only when the owner asks. Read-only: nothing is sent to Zalo.",
            inputSchema: z.object({}),
        },
        async () => {
            try {
                return ok(coverageReport());
            } catch (e) {
                console.error("[mcp-tools] zalo_coverage error:", e.message);
                return err(e.message);
            }
        },
    );

    // An explicit start returns immediately; phone-backed restores can take minutes.
    server.registerTool(
        "zalo_sync",
        {
            title: "Request Zalo Sync",
            description:
                "OWNER ONLY: call it only when the owner explicitly asks. Start a restore of messages, or another sync stage (the reaction backlog, the zCloud index, attachment downloads, group boards), on this server's existing Zalo connection. The `messages` stage makes the owner's phone ask for a confirmation, which the owner must tap; the other stages do not. " +
                "It returns a job at once: poll zalo_sync_status every few seconds. Reuse the same `requestId` and arguments when retrying, so a retry does not start a second sync. It updates the local cache, not Zalo itself. `messages` restores every conversation in the window; it is not per conversation, and it downloads no media, boards, cloud index or conversation state.",
            inputSchema: z
                .object({
                    requestId: z
                        .string()
                        .min(1)
                        .max(64)
                        .regex(/^[A-Za-z0-9._:-]+$/)
                        .describe(
                            "Unique request key; reuse the same key and arguments after a timeout to avoid duplicate sync.",
                        ),
                    stage: z
                        .enum(SYNC_STAGES)
                        .default("messages")
                        .describe(
                            "`messages` restores chat history from the owner's phone (the phone asks for a confirmation); `reactions` drains Zalo's backlog of reactions; `cloud` walks the zCloud index (zalo_cloud reads it); `media` downloads the attachments a restore recorded; `boards` stores notes, pinned messages, polls and reminders. Only `messages` taps the phone.",
                        ),
                    days: z
                        .number()
                        .int()
                        .min(1)
                        .max(36500)
                        .optional()
                        .describe(
                            "Messages: restore the last N days (omit both days and from for full phone history). Media: only attachments from the last N days (default: the window the last restore covered).",
                        ),
                    threadId: z
                        .string()
                        .min(1)
                        .optional()
                        .describe("Media and boards only: just this conversation (default: all cached ones)."),
                    kinds: z
                        .array(z.enum([...DOWNLOADABLE_KINDS]))
                        .min(1)
                        .optional()
                        .describe("Media only: just these kinds of attachment (default: all)."),
                    limit: z
                        .number()
                        .int()
                        .min(1)
                        .max(10000)
                        .optional()
                        .describe(
                            "Media: download at most this many files (the rest wait for the next run). Boards: visit at most this many threads, most recent first (default 200).",
                        ),
                    full: z
                        .boolean()
                        .optional()
                        .describe(
                            "Cloud only: walk from the top and drop every indexed item no page lists (corrects a stale index).",
                        ),
                    from: z
                        .string()
                        .regex(/^\d{4}-\d{2}-\d{2}$/)
                        .refine((value) => {
                            const time = Date.parse(value + "T00:00:00Z");
                            return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
                        }, "Use a valid YYYY-MM-DD date")
                        .optional()
                        .describe("Restore since this UTC date, e.g. the date from zalo_coverage."),
                    waitMs: z
                        .number()
                        .int()
                        .min(30000)
                        .max(600000)
                        .optional()
                        .describe("Per-phase wait budget in milliseconds."),
                    applyRemovals: z
                        .boolean()
                        .optional()
                        .describe("Reactions only: apply observed removals; defaults to true."),
                    fullResync: z
                        .boolean()
                        .optional()
                        .describe(
                            "Messages only: ask the phone for every conversation in full, ignoring what earlier runs " +
                                "settled. A long run; use it when the cache looks incomplete, not by default.",
                        ),
                    shardSize: z
                        .number()
                        .int()
                        .min(1)
                        .max(30)
                        .optional()
                        .describe(
                            "Messages only: conversations per batch (1 to 30, default 30). Fewer means more, smaller " +
                                "batches: the first comes back sooner and less is lost if the connection drops.",
                        ),
                })
                .strict()
                .refine(
                    (value) => !(value.days !== undefined && value.from !== undefined),
                    "Choose days or from, not both",
                )
                .refine((value) => {
                    // Each option belongs to the stages named in its description; any other stage refuses it.
                    const only = {
                        days: ["messages", "media"],
                        from: ["messages"],
                        waitMs: ["messages", "reactions"],
                        applyRemovals: ["reactions"],
                        fullResync: ["messages"],
                        shardSize: ["messages"],
                        threadId: ["media", "boards"],
                        kinds: ["media"],
                        limit: ["media", "boards"],
                        full: ["cloud"],
                    };
                    const stage = value.stage ?? "messages";
                    return Object.entries(only).every(
                        ([k, stages]) => value[k] === undefined || stages.includes(stage),
                    );
                }, "An option was given for a stage it does not apply to: each option's description names its stages"),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (args) => {
            try {
                if (!syncJobs) throw new Error("Sync is unavailable in this server; restart with a compatible engine.");
                return ok(syncJobs.start(args));
            } catch (e) {
                return err(e.message);
            }
        },
    );

    server.registerTool(
        "zalo_sync_status",
        {
            title: "Zalo Sync Status",
            description:
                "Read the progress and final result of a zalo_sync job without starting or repeating anything. Omit `jobId` for the latest job (or idle). `completed` only means the runner returned: read `result.reason` for partial, timeout or socket loss; it is not proof that all history was restored. The last ten jobs are kept in memory until the server restarts.",
            inputSchema: z
                .object({
                    jobId: z
                        .string()
                        .uuid()
                        .optional()
                        .describe("The job to read: the `jobId` that zalo_sync returned. Omit for the latest job."),
                })
                .strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async ({ jobId }) => {
            try {
                if (!syncJobs) throw new Error("Sync is unavailable in this server; restart with a compatible engine.");
                return ok(syncJobs.status(jobId));
            } catch (e) {
                return err(e.message);
            }
        },
    );

    // --- zalo_search_messages ---
    server.registerTool(
        "zalo_search_messages",
        {
            title: "Search Zalo Messages",
            description:
                "Search the text of messages in the local cache, across all conversations or one. No network call. Accents and case are ignored, as in Zalo's own search ('duoc' finds 'được'; set `accents` to 'exact' to require them). " +
                "Narrow it with `threadId`, `senderId`, `since` / `until` (epoch ms) or `last` (7d, 2w, 3m, 1y), and `types` (text, photo, video, file, link, sticker...; files and links match on their titles). Results are newest first, every hit unless you pass `limit`; with a `limit`, pass the reply's `nextCursor` back as `cursor` for the next page. " +
                "Each message carries a `snippet` (70 characters before the match, 30 after, with its position); `context` adds that many messages around each hit. `counts` gives the matches by type, and `coverage` says how far back the cache reaches and which `sync` command extends it.",
            inputSchema: z.object({
                query: z
                    .string()
                    .min(1)
                    .describe(
                        "Text to search for in cached messages (cut to 100 characters; accents and case ignored)",
                    ),
                threadId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Only this conversation (its threadId). Omit to search all of them."),
                senderId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Only messages from this user (the `senderId` of a message)"),
                since: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Only messages with timestamp >= this epoch-ms value"),
                until: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Only messages with timestamp <= this epoch-ms value"),
                last: z
                    .string()
                    .regex(/^\d{1,4}\s*[hdwmyHDWMY]$/)
                    .optional()
                    .describe("Only the last period: 7d, 2w, 3m, 1y (replaces `since`)"),
                types: z
                    .array(z.string().min(1))
                    .max(12)
                    .optional()
                    .describe("Only these message types, e.g. ['file','link']; 'media' means photo and video"),
                accents: z
                    .enum(["fold", "exact"])
                    .default("fold")
                    .describe(
                        "fold (default): accents and case ignored; exact: accents must match, case still does not",
                    ),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe("Max matching messages per page (omit for every hit, in one page)"),
                cursor: z.string().min(1).optional().describe("The nextCursor of the previous page, unchanged"),
                context: z
                    .number()
                    .int()
                    .min(0)
                    .max(10)
                    .default(0)
                    .describe("Messages to show before and after each hit (default 0, max 10)"),
            }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async ({ query, threadId, senderId, since, until, last, types, accents, limit, cursor, context }) => {
            try {
                const page = searchPage({
                    query,
                    accents,
                    threadId,
                    senderId,
                    since: last ? parsePeriod(last) : since,
                    until,
                    types,
                    limit,
                    cursor,
                    context,
                    excludeThreadIds: hiddenIds(),
                });
                const threadNames = getThreadNames();
                const lite = (m) => ({
                    msgId: m.msgId,
                    senderId: m.senderId,
                    ...senderNameFields(m.senderId, m.senderName),
                    text: m.text,
                    timestamp: m.timestamp,
                    type: m.type,
                });
                const messages = page.hits.map(({ row: r, snippet, context: around }) => {
                    let cliMsgId = null;
                    try {
                        cliMsgId = cachedCliMsgId(r);
                    } catch {
                        /* ignore */
                    }
                    return {
                        msgId: r.msgId,
                        ...(cliMsgId && { cliMsgId: String(cliMsgId) }),
                        threadId: r.threadId,
                        threadName:
                            threadNames.get(String(r.threadId))?.name ?? nameCache?.get(r.threadId)?.name ?? null,
                        senderId: r.senderId,
                        // Alias first (src/core/contact-names.js); `senderZaloName` is the name the message carried.
                        ...senderNameFields(r.senderId, r.senderName),
                        text: r.text,
                        snippet,
                        timestamp: r.timestamp,
                        type: r.type,
                        hasAttachment: Boolean(r.has_attachment),
                        mediaCached: Boolean(r.localPath),
                        replyTo: cachedReplyTo(r),
                        ...(around && { context: { before: around.before.map(lite), after: around.after.map(lite) } }),
                    };
                });
                return ok({
                    query: page.query,
                    accents: page.accents,
                    ...(page.truncatedKeyword && { truncatedKeyword: true }),
                    count: messages.length,
                    hasMore: page.hasMore,
                    nextCursor: page.nextCursor,
                    ...(page.counts && { counts: page.counts }),
                    coverage: page.coverage,
                    messages,
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_search_messages error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_lookup_user ---
    server.registerTool(
        "zalo_lookup_user",
        {
            title: "Lookup Zalo User",
            description:
                "Look up a Zalo user by phone number (`phone`), username (`username`) or user id (`userId`), or read this logged-in account's own profile (`self: true`). Use it to find someone's `userId`, which is also the `threadId` of your 1-1 conversation with them, before sending a message or a contact card.",
            inputSchema: z
                .object({
                    self: z
                        .boolean()
                        .optional()
                        .describe("Set true to fetch the currently logged-in account's own profile (`whoami`)"),
                    phone: z
                        .string()
                        .min(3)
                        .optional()
                        .describe("Phone number to search for on Zalo (e.g. '0901234567' or '+84901234567')"),
                    username: z.string().min(1).optional().describe("Zalo username to search for"),
                    userId: z.string().min(1).optional().describe("A Zalo user id, to fetch that user's full profile."),
                })
                .refine(
                    (v) =>
                        [v.self === true, Boolean(v.phone), Boolean(v.username), Boolean(v.userId)].filter(Boolean)
                            .length === 1,
                    "Specify exactly one of self: true, phone, username, or userId",
                ),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async ({ self, phone, username, userId }) => {
            try {
                if (self) {
                    const info = await api.fetchAccountInfo();
                    const p = info?.profile || info || {};
                    const ownId = ownIdOf(api) || p.userId || null;
                    if (p.displayName || p.zaloName) syncJobs?.onSelfName?.(p.displayName || p.zaloName);
                    return ok({
                        mode: "self",
                        ownId,
                        displayName: p.displayName || p.zaloName || null,
                        zaloName: p.zaloName || null,
                        phoneNumber: p.phoneNumber || null,
                        avatar: p.avatar || null,
                        profile: p,
                    });
                }
                if (phone) {
                    const phoneNumber = phone;
                    const user = await api.findUser(phoneNumber);
                    return ok({
                        mode: "phone",
                        query: phoneNumber,
                        userId: user?.uid || user?.userId || null,
                        // Alias first, as Zalo shows the person to this account (src/core/contact-names.js).
                        ...personNameFields(user?.uid || user?.userId, user),
                        avatar: user?.avatar || null,
                        user: user || null,
                    });
                }
                if (username) {
                    const user = await api.findUserByUsername(username);
                    return ok({
                        mode: "username",
                        query: username,
                        userId: user?.uid || user?.userId || null,
                        // Alias first, as Zalo shows the person to this account (src/core/contact-names.js).
                        ...personNameFields(user?.uid || user?.userId, user),
                        avatar: user?.avatar || null,
                        user: user || null,
                    });
                }
                const info = await api.getUserInfo(userId);
                const changed = info?.changed_profiles?.[userId] || info?.unchanged_profiles?.[userId] || null;
                return ok({
                    mode: "userId",
                    userId,
                    // Alias first, as Zalo shows the person to this account (src/core/contact-names.js).
                    ...personNameFields(userId, changed),
                    displayName: personNameFields(userId, changed).displayName ?? (cachedDisplayName(userId) || null),
                    avatar: changed?.avatar || null,
                    profile: changed || info || null,
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_lookup_user error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_forward_message ---
    server.registerTool(
        "zalo_forward_message",
        {
            title: "Forward Zalo Message",
            description:
                "Forward a message from the local cache (`msgId`) to another conversation (`threadId`). Text goes through Zalo's forward API with the 'forwarded' badge; cards, stickers, links, videos, voice messages and downloaded media are re-sent as a message of their own kind, as `msg forward` does.",
            inputSchema: z.object({
                msgId: z
                    .string()
                    .min(1)
                    .describe("msgId of the cached message to forward (from zalo_get_messages or zalo_get_history)"),
                threadId: z
                    .string()
                    .min(1)
                    .describe("Destination thread ID (`me` or your own uid resolves to My Documents)"),
                threadType: z
                    .enum(["dm", "group"])
                    .optional()
                    .describe(
                        'The destination conversation type: "dm" or "group". Inferred from the cache when omitted.',
                    ),
            }),
        },
        async ({ msgId, threadId: threadIdIn, threadType: threadTypeIn }) => {
            const thread = actionThread(api, threadIdIn, threadTypeIn);
            if (thread.error) {
                console.error("[mcp-tools] zalo_forward_message refused:", thread.error);
                return err(thread.error);
            }
            const { threadId, threadType } = thread;
            try {
                let row = null;
                try {
                    row = getMessageForAction(msgId);
                } catch (e) {
                    return err(e?.code === "ROW_MAC" ? e.message : `Local cache unavailable (${e.message}).`);
                }
                if (!row) {
                    return err(
                        `Message ${msgId} is not in the local cache. Call zalo_get_history on its conversation first.`,
                    );
                }

                let raw = {};
                try {
                    raw = JSON.parse(row.raw_data || "{}");
                } catch {
                    /* fall back to text forward */
                }
                const c = raw.content && typeof raw.content === "object" ? raw.content : null;

                const resendLocal = async () => {
                    if (!row.localPath || !existsSync(row.localPath)) {
                        throw new Error(
                            `Message ${msgId} is "${row.type}" but its media is not downloaded locally. Call zalo_view_media with msgId="${msgId}" first.`,
                        );
                    }
                    // Sealed on disk: the upload gets a private decrypted copy for the send only (media-deliver.js).
                    const copy = decryptToTempfile(resolve(row.localPath), mediaScope(), {
                        msgId: row.msgId,
                        ttlMs: 0,
                    });
                    try {
                        return await api.sendMessage(
                            { msg: "", attachments: [copy.path] },
                            threadId,
                            Number(threadType),
                        );
                    } finally {
                        removeMediaTemp(copy);
                    }
                };

                const forwarders = {
                    card: async () =>
                        api.sendCard({ userId: String(c?.params ?? "").trim() }, threadId, Number(threadType)),
                    sticker: async () =>
                        api.sendSticker(
                            { id: c?.id, cateId: c?.catId, type: c?.type ?? 3 },
                            threadId,
                            Number(threadType),
                        ),
                    link: async () => api.sendLink({ link: c?.href }, threadId, Number(threadType)),
                    // As `msg forward`: a size the cache knows spares the HEAD, and one still needed is bounded.
                    video: async () =>
                        api.sendVideo(
                            videoResendOptions(c, mediaPlainSize(row.localPath)),
                            threadId,
                            Number(threadType),
                        ),
                    voice: async () => api.sendVoice(voiceResendOptions(c), threadId, Number(threadType)),
                    photo: resendLocal,
                    file: resendLocal,
                    gif: resendLocal,
                    doodle: resendLocal,
                };

                const kind = c?.action === "recommened.user" ? "card" : row.type;
                if (kind !== "text") {
                    const send = forwarders[kind];
                    if (!send) {
                        return err(`Cannot forward a "${row.type}" message — no send path reproduces it.`);
                    }
                    const res = await send();
                    return ok({
                        success: true,
                        kind,
                        threadId,
                        threadType: threadTypeName(threadType),
                        ...(thread.notice && { notice: thread.notice }),
                        result: res,
                    });
                }

                const text = cachedText(row);
                if (!text) {
                    return err(`Message ${msgId} has no text to forward.`);
                }
                const source = await forwardSourceForMcp(api, row);
                if (source.error) {
                    return err(`Cannot forward message ${msgId}: ${source.error}.`);
                }
                const { reference, decorLog } = buildForwardReference(source);
                const result = await sendForward(
                    api,
                    { message: text, reference, decorLog },
                    [threadId],
                    Number(threadType),
                );
                const rejected = result?.failed ?? result?.fail ?? [];
                if (rejected.length > 0) {
                    return err(`Forward rejected for ${rejected.length} target(s): ${JSON.stringify(rejected)}`);
                }
                const shared = (result?.cliMsgId ?? null) === null ? null : String(result.cliMsgId);
                const sent = (Array.isArray(result?.success) ? result.success : [])
                    .filter((x) => (x?.msgId ?? null) !== null)
                    .map((x) => ({
                        msgId: String(x.msgId),
                        cliMsgId: (x.clientId ?? shared ?? null) === null ? null : String(x.clientId ?? shared),
                    }));
                return ok({
                    success: true,
                    kind: "text",
                    threadId,
                    threadType: threadTypeName(threadType),
                    ...(thread.notice && { notice: thread.notice }),
                    sent,
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_forward_message error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_delete_message ---
    server.registerTool(
        "zalo_delete_message",
        {
            title: "Delete Zalo Message",
            description:
                "Delete a message from your own view only (`everyone: false`, the default), or, as a group admin, delete someone else's message for everyone in the group (`everyone: true`). To recall your own message for both sides, use zalo_undo. `cliMsgId` and `uidFrom` are read from the local cache when you leave them out. A delete cannot be undone, so it is asked about first (`confirm`, `dryRun`).",
            inputSchema: z.object({
                msgId: z
                    .string()
                    .min(1)
                    .describe("msgId of the message to delete (from zalo_get_messages or zalo_get_history)."),
                threadId: z
                    .string()
                    .min(1)
                    .describe("The conversation the message is in: the user id for a DM, the group id for a group."),
                threadType: z
                    .enum(["dm", "group"])
                    .optional()
                    .describe('The conversation type: "dm" or "group". Inferred from the cache when omitted.'),
                cliMsgId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Client message ID (`cliMsgId`). Looked up in the local cache when omitted."),
                senderId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        "The `senderId` of the message: its author's user id. Looked up in the local cache, or your own user id when omitted.",
                    ),
                everyone: z
                    .boolean()
                    .default(false)
                    .describe("Set true to delete someone else's message for everyone in a group (admin/owner)"),
                confirm: confirmInput("the delete"),
                ticket: ticketInput(),
                dryRun: dryRunInput("the delete"),
            }),
        },
        async (
            {
                msgId,
                threadId: threadIdIn,
                threadType: threadTypeIn,
                cliMsgId: cliMsgIdIn,
                senderId: senderIdIn,
                everyone,
                confirm,
                dryRun,
                ticket,
            },
            extra,
        ) => {
            const thread = actionThread(api, threadIdIn, threadTypeIn);
            if (thread.error) {
                console.error("[mcp-tools] zalo_delete_message refused:", thread.error);
                return err(thread.error);
            }
            const { threadId, threadType } = thread;
            try {
                let cliMsgId = cliMsgIdIn;
                let uidFrom = senderIdIn;
                if (!cliMsgId || !uidFrom) {
                    const cached = cachedMessageById(threadId, msgId);
                    cliMsgId = cliMsgId || cached?.cliMsgId;
                    uidFrom = uidFrom || cached?.uidFrom;
                }
                uidFrom = uidFrom || ownIdOf(api);
                if (!cliMsgId) {
                    return err(
                        `Message ${msgId} is not in the local cache and cliMsgId was not provided. Pass ${CLI_MSG_ID_HINT}.`,
                    );
                }
                const dest = {
                    data: { cliMsgId: String(cliMsgId), msgId: String(msgId), uidFrom: String(uidFrom) },
                    threadId,
                    type: Number(threadType),
                };
                const onlyMe = Boolean(everyone) === false;
                const held = await gate(
                    "msg.delete",
                    { msgId, threadId, cliMsgId: String(cliMsgId), senderId: String(uidFrom), everyone: !onlyMe },
                    { confirm, dryRun, ticket },
                    extra,
                );
                if (held) return held;
                const result = await api.deleteMessage(dest, onlyMe);
                return ok({
                    success: true,
                    msgId,
                    cliMsgId: String(cliMsgId),
                    threadId,
                    threadType: threadTypeName(threadType),
                    everyone: Boolean(everyone),
                    ...(thread.notice && { notice: thread.notice }),
                    result,
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_delete_message error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_reminder ---
    server.registerTool(
        "zalo_reminder",
        {
            title: "Manage Zalo Reminders",
            description:
                "Create, list, inspect, view responses, edit, or remove reminders in a Zalo DM or group thread. " +
                "Actions: 'create' (requires threadId, title), 'list' (requires threadId), 'info' (requires reminderId, group only), " +
                "'responses' (requires reminderId, group only), 'edit' (requires reminderId, threadId, title), " +
                "'remove' (requires reminderId, threadId; it cannot be undone, so it is asked about first: `confirm`, `dryRun`).",
            inputSchema: z.object({
                action: z
                    .enum(["create", "list", "info", "responses", "edit", "remove"])
                    .describe("Reminder operation to perform"),
                threadId: z.string().min(1).optional().describe("Thread ID (required for create, list, edit, remove)"),
                threadType: z
                    .enum(["dm", "group"])
                    .optional()
                    .describe('The conversation type: "dm" or "group". Inferred from the cache when omitted.'),
                reminderId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Reminder ID (required for info, responses, edit, remove)"),
                title: z.string().min(1).optional().describe("Reminder title (required for create and edit)"),
                time: z
                    .union([z.number().int().positive(), z.string().min(1)])
                    .optional()
                    .describe(
                        'Reminder start time as epoch-ms, "YYYY-MM-DD HH:mm", or ISO-8601 string (defaults to now on create)',
                    ),
                emoji: z.string().min(1).optional().describe("Emoji icon for the reminder (default '⏰' on create)"),
                repeat: z
                    .enum(["none", "daily", "weekly", "monthly"])
                    .optional()
                    .describe("Repeat schedule: 'none', 'daily', 'weekly', or 'monthly'"),
                page: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe("Only this page for 'list' (omit both page and count for every reminder)"),
                count: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .optional()
                    .describe(
                        "Reminders per page for 'list' (one page is read when page or count is given; 20 a page)",
                    ),
                confirm: confirmInput("'remove'"),
                ticket: ticketInput(),
                dryRun: dryRunInput("'remove'"),
            }),
        },
        async (
            {
                action,
                threadId: threadIdIn,
                threadType: threadTypeIn,
                reminderId,
                title,
                time,
                emoji,
                repeat,
                page,
                count,
                confirm,
                dryRun,
                ticket,
            },
            extra,
        ) => {
            try {
                if (action === "info") {
                    if (!reminderId) return err("reminderId is required for action='info'.");
                    const result = await api.getReminder(reminderId);
                    return ok({ action, reminderId, reminder: result });
                }
                if (action === "responses") {
                    if (!reminderId) return err("reminderId is required for action='responses'.");
                    const result = await api.getReminderResponses(reminderId);
                    return ok({ action, reminderId, responses: result });
                }
                if (!threadIdIn) {
                    return err(`threadId is required for action='${action}'.`);
                }
                const thread = actionThread(api, threadIdIn, threadTypeIn);
                if (thread.error) return err(thread.error);
                const { threadId, threadType } = thread;

                if (action === "create") {
                    if (!title) return err("title is required for action='create'.");
                    const repeatMode = REMINDER_REPEAT_MODES[repeat ?? "none"];
                    const startTime = time !== undefined ? parseReminderTime(time) : Date.now();
                    if (!startTime) {
                        return err(`Invalid time format: "${time}". Use epoch-ms, "YYYY-MM-DD HH:mm", or ISO-8601.`);
                    }
                    const result = await api.createReminder(
                        { title, emoji: emoji || "⏰", startTime, repeat: repeatMode },
                        threadId,
                        Number(threadType),
                    );
                    return ok({
                        action,
                        success: true,
                        threadId,
                        threadType: threadTypeName(threadType),
                        reminderId: result?.reminderId ?? result?.id ?? null,
                        startTime,
                        repeat: REMINDER_REPEAT_LABELS[repeatMode],
                        result,
                    });
                }

                if (action === "list") {
                    let result = null;
                    let note = null;
                    try {
                        if (page === undefined && count === undefined) {
                            // No page asked: every page, one request at a time (src/core/list-all.js).
                            const all = await allReminders(api, threadId, Number(threadType));
                            result = all.reminders;
                            note = all.paging.note;
                        } else {
                            // A group's page 2 and later carry the cursor of the page before, as Zalo Web pages them;
                            // a DM's have none (the Web always sends 0 there) and go by page number.
                            result =
                                Number(threadType) === THREAD_GROUP
                                    ? await groupReminderPage(api, threadId, page ?? 1, count ?? 20)
                                    : await api.getListReminder(
                                          { page: page ?? 1, count: count ?? 20 },
                                          threadId,
                                          Number(threadType),
                                      );
                        }
                    } catch {
                        result = null;
                    }
                    const reminders = Array.isArray(result) ? result : [];
                    return ok({
                        action,
                        threadId,
                        threadType: threadTypeName(threadType),
                        count: reminders.length,
                        reminders,
                        ...(note && { note }),
                    });
                }

                if (action === "edit") {
                    if (!reminderId) return err("reminderId is required for action='edit'.");
                    if (!title) return err("title is required for action='edit'.");
                    const editOpts = { title, topicId: reminderId };
                    if (emoji) editOpts.emoji = emoji;
                    if (time !== undefined) {
                        const ts = parseReminderTime(time);
                        if (!ts) {
                            return err(
                                `Invalid time format: "${time}". Use epoch-ms, "YYYY-MM-DD HH:mm", or ISO-8601.`,
                            );
                        }
                        editOpts.startTime = ts;
                    }
                    if (repeat !== undefined) {
                        editOpts.repeat = REMINDER_REPEAT_MODES[repeat];
                    }
                    const result = await api.editReminder(editOpts, threadId, Number(threadType));
                    return ok({
                        action,
                        success: true,
                        reminderId,
                        threadId,
                        threadType: threadTypeName(threadType),
                        result,
                    });
                }

                if (action === "remove") {
                    if (!reminderId) return err("reminderId is required for action='remove'.");
                    const held = await gate(
                        "reminder.remove",
                        { reminderId, threadId },
                        { confirm, dryRun, ticket },
                        extra,
                    );
                    if (held) return held;
                    const result = await api.removeReminder(reminderId, threadId, Number(threadType));
                    return ok({
                        action,
                        success: true,
                        reminderId,
                        threadId,
                        threadType: threadTypeName(threadType),
                        result,
                    });
                }

                return err(`Unsupported reminder action: ${action}`);
            } catch (e) {
                console.error("[mcp-tools] zalo_reminder error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_note ---
    server.registerTool(
        "zalo_note",
        {
            title: "Manage Zalo Group Notes & Pins",
            description:
                "Create or edit group notes, list group board items (notes, pinned messages, polls), or pin/unpin " +
                "a cached text message at the top of a conversation. " +
                "Actions: 'create' (requires groupId, title), 'edit' (requires groupId, noteId, title), " +
                "'list' (requires groupId; every board item unless page or count is given), 'pin_message' (requires msgId; threadId optional if cached), " +
                "'unpin_message' (requires msgId; threadId optional if cached).",
            inputSchema: z.object({
                action: z
                    .enum(["create", "edit", "list", "pin_message", "unpin_message"])
                    .describe("Note or pin operation to perform"),
                groupId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Group ID (required for 'create', 'edit', 'list'; alias for threadId on pin/unpin)"),
                threadId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        "Thread ID for 'pin_message' / 'unpin_message' (defaults to the message's cached threadId)",
                    ),
                threadType: z
                    .enum(["dm", "group"])
                    .optional()
                    .describe(
                        "The conversation type for 'pin_message' / 'unpin_message': \"dm\" or \"group\". Inferred from the cache when omitted.",
                    ),
                noteId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("The note's `topicId`, as listed by action 'list' (required for 'edit')."),
                title: z.string().min(1).optional().describe("Note text/title (required for 'create' and 'edit')"),
                pin: z
                    .boolean()
                    .default(false)
                    .describe("Whether to pin the note to the group board on 'create' or 'edit'"),
                msgId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        "msgId of a cached text message to pin or unpin (required for 'pin_message' and 'unpin_message').",
                    ),
                page: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe("Only this page for 'list' (omit both page and count for every board item)"),
                count: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .optional()
                    .describe("Items per page for 'list' (one page is read when page or count is given; 20 a page)"),
            }),
        },
        async ({
            action,
            groupId,
            threadId: threadIdIn,
            threadType: threadTypeIn,
            noteId,
            title,
            pin,
            msgId,
            page,
            count,
        }) => {
            try {
                if (action === "create") {
                    if (!groupId) return err("groupId is required for action='create'.");
                    if (!title) return err("title is required for action='create'.");
                    const pinAct = Boolean(pin);
                    const result = await api.createNote({ title, pinAct }, groupId);
                    return ok({ action, success: true, groupId, pinned: pinAct, result });
                }

                if (action === "edit") {
                    if (!groupId) return err("groupId is required for action='edit'.");
                    if (!noteId) return err("noteId is required for action='edit'.");
                    if (!title) return err("title is required for action='edit'.");
                    const pinAct = Boolean(pin);
                    const topicId = noteId;
                    const result = await api.editNote({ title, topicId, pinAct }, groupId);
                    return ok({ action, success: true, groupId, noteId, pinned: pinAct, result });
                }

                if (action === "list") {
                    if (!groupId) return err("groupId is required for action='list'.");
                    if (page === undefined && count === undefined) {
                        // No page asked: every page, one request at a time (src/core/list-all.js).
                        const all = await allBoardItems(api, groupId);
                        return ok({
                            action,
                            groupId,
                            items: all.items,
                            count: all.items.length,
                            ...(all.paging.note && { note: all.paging.note }),
                        });
                    }
                    // Page 2 and later carry the cursor of the page before, as Zalo Web pages the board.
                    const result = await boardPage(api, groupId, page ?? 1, count ?? 20);
                    return ok({
                        action,
                        groupId,
                        items: result?.items ?? [],
                        count: Array.isArray(result?.items) ? result.items.length : 0,
                    });
                }

                if (action === "pin_message") {
                    if (!msgId) return err("msgId is required for action='pin_message'.");
                    let row = null;
                    try {
                        row = getMessageForAction(msgId);
                    } catch (e) {
                        if (e?.code === "ROW_MAC") return err(e.message);
                        row = null;
                    }
                    if (!row) {
                        return err(
                            `Message ${msgId} is not in the local cache, so it cannot be pinned (pinning requires cached cliMsgId, sender, and text).`,
                        );
                    }
                    const targetThread = threadIdIn || groupId;
                    if (targetThread && row.threadId && String(row.threadId) !== String(targetThread)) {
                        return err(`Message ${msgId} belongs to thread ${row.threadId}, not ${targetThread}.`);
                    }
                    if (row.type !== "text") {
                        return err(`Only text messages can be pinned; message ${msgId} is "${row.type || "unknown"}".`);
                    }
                    const cliMsgId = cachedCliMsgId(row);
                    if (!cliMsgId) {
                        return err(`Message ${msgId}'s cliMsgId was never cached, and a pin must name it.`);
                    }
                    const conversation = String(targetThread || row.threadId);
                    const resolvedType = resolveThreadType(conversation, threadTypeIn);
                    const isGroup = Number(resolvedType) === THREAD_GROUP;
                    const sender = await resolveSenderUid(api, row.senderId, ownIdOf(api));
                    if (sender.error) {
                        return err(`Cannot pin message ${msgId}: ${sender.error}.`);
                    }
                    const params = textPinParams({
                        cliMsgId,
                        msgId,
                        senderUid: sender.uid,
                        senderName: row.senderName,
                        text: cachedText(row),
                    });
                    const result = await pinMessage(api, { threadId: conversation, isGroup, params });
                    return ok({ action, success: true, msgId, threadId: conversation, isGroup, result });
                }

                if (action === "unpin_message") {
                    if (!msgId) return err("msgId is required for action='unpin_message'.");
                    let row = null;
                    try {
                        row = getMessageForAction(msgId);
                    } catch (e) {
                        if (e?.code === "ROW_MAC") return err(e.message);
                        row = null;
                    }
                    const targetThread = threadIdIn || groupId;
                    if (targetThread && row?.threadId && String(row.threadId) !== String(targetThread)) {
                        return err(`Message ${msgId} belongs to thread ${row.threadId}, not ${targetThread}.`);
                    }
                    const conversation = targetThread || row?.threadId;
                    if (!conversation) {
                        return err(
                            `Message ${msgId} is not in the local cache, so its thread is unknown. Pass threadId (or groupId).`,
                        );
                    }
                    const resolvedType = resolveThreadType(String(conversation), threadTypeIn);
                    const isGroup = Number(resolvedType) === THREAD_GROUP;
                    const result = await unpinMessage(api, { threadId: String(conversation), isGroup, msgId });
                    if (result.notPinned) {
                        return err(`Message ${msgId} is not pinned in ${conversation}.`);
                    }
                    return ok({ action, success: true, msgId, threadId: String(conversation), isGroup, result });
                }

                return err(`Unsupported note action: ${action}`);
            } catch (e) {
                console.error("[mcp-tools] zalo_note error:", describeZaloError(e));
                return err(describeZaloError(e));
            }
        },
    );

    // --- zalo_poll ---
    server.registerTool(
        "zalo_poll",
        {
            title: "Manage Zalo Group Polls",
            description:
                "Create, inspect, vote, unvote, add options, lock, or share a poll in a Zalo group. " +
                "Actions: 'create' (requires groupId, question, options with >=2 items), 'info' (requires pollId), " +
                "'vote' (requires pollId, optionIds), 'unvote' (requires pollId), " +
                "'add_options' (requires pollId, options), 'lock' (requires pollId; closing a poll cannot be undone, so it is " +
                "asked about first: `confirm`, `dryRun`), 'share' (requires pollId).",
            inputSchema: z.object({
                action: z
                    .enum(["create", "info", "vote", "unvote", "add_options", "lock", "share"])
                    .describe("Poll operation to perform"),
                groupId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("The group's id, which is its threadId (required for 'create')."),
                pollId: z
                    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
                    .optional()
                    .describe(
                        "Numeric poll ID (required for 'info', 'vote', 'unvote', 'add_options', 'lock', 'share')",
                    ),
                question: z.string().min(1).optional().describe("Poll question text (required for 'create')"),
                options: z
                    .array(z.string().min(1))
                    .optional()
                    .describe("Poll option strings (at least 2 required for 'create'; at least 1 for 'add_options')"),
                optionIds: z
                    .array(z.number().int())
                    .optional()
                    .describe("Option IDs to vote for on 'vote' (get option_id values from action='info')"),
                multi: z.boolean().default(false).describe("Allow voters to pick multiple options ('create' only)"),
                allowAddOptions: z
                    .boolean()
                    .default(false)
                    .describe("Allow group members to add new options ('create' only)"),
                anonymous: z.boolean().default(false).describe("Hide voter identities ('create' only)"),
                hidePreview: z.boolean().default(false).describe("Hide vote counts until voted ('create' only)"),
                expireMinutes: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Auto-close the poll after N minutes ('create' only; omit for no expiration)"),
                voteNewOptions: z
                    .boolean()
                    .default(false)
                    .describe("Also cast your vote for the newly added options ('add_options' only)"),
                confirm: confirmInput("'lock'"),
                ticket: ticketInput(),
                dryRun: dryRunInput("'lock'"),
            }),
        },
        async (
            {
                action,
                groupId,
                pollId,
                question,
                options,
                optionIds,
                multi,
                allowAddOptions,
                anonymous,
                hidePreview,
                expireMinutes,
                voteNewOptions,
                confirm,
                dryRun,
                ticket,
            },
            extra,
        ) => {
            try {
                if (action === "create") {
                    if (!groupId) return err("groupId is required for action='create'.");
                    if (!question) return err("question is required for action='create'.");
                    if (!Array.isArray(options) || options.length < 2) {
                        return err("A poll requires at least 2 options in `options`.");
                    }
                    const expiredTime = expireMinutes ? Date.now() + expireMinutes * 60 * 1000 : 0;
                    const pollOpts = {
                        question,
                        options,
                        allowMultiChoices: Boolean(multi),
                        allowAddNewOption: Boolean(allowAddOptions),
                        isAnonymous: Boolean(anonymous),
                        hideVotePreview: Boolean(hidePreview),
                        expiredTime,
                    };
                    const result = await api.createPoll(pollOpts, groupId);
                    return ok({
                        action,
                        success: true,
                        groupId,
                        pollId: result?.poll_id ?? null,
                        result,
                    });
                }

                if (pollId === undefined || pollId === null || String(pollId).trim() === "") {
                    return err(`pollId is required for action='${action}'.`);
                }
                const numericPollId = Number(pollId);

                if (action === "info") {
                    const result = await api.getPollDetail(numericPollId);
                    return ok({ action, pollId: numericPollId, poll: result });
                }

                if (action === "vote") {
                    if (!Array.isArray(optionIds) || optionIds.length === 0) {
                        return err("optionIds (non-empty array of numeric option IDs) is required for action='vote'.");
                    }
                    const result = await api.votePoll(numericPollId, optionIds.map(Number));
                    return ok({ action, success: true, pollId: numericPollId, optionIds, result });
                }

                if (action === "unvote") {
                    const result = await api.votePoll(numericPollId, []);
                    return ok({ action, success: true, pollId: numericPollId, result });
                }

                if (action === "add_options") {
                    if (!Array.isArray(options) || options.length === 0) {
                        return err("options (non-empty array of strings) is required for action='add_options'.");
                    }
                    const newOptions = options.map((content) => ({
                        content,
                        voted: Boolean(voteNewOptions),
                    }));
                    const result = await api.addPollOptions({
                        pollId: numericPollId,
                        options: newOptions,
                        votedOptionIds: [],
                    });
                    return ok({ action, success: true, pollId: numericPollId, added: options.length, result });
                }

                if (action === "lock") {
                    const held = await gate("poll.lock", { pollId: numericPollId }, { confirm, dryRun, ticket }, extra);
                    if (held) return held;
                    const result = await api.lockPoll(numericPollId);
                    return ok({ action, success: true, pollId: numericPollId, result });
                }

                if (action === "share") {
                    const result = await api.sharePoll(numericPollId);
                    return ok({ action, success: true, pollId: numericPollId, result });
                }

                return err(`Unsupported poll action: ${action}`);
            } catch (e) {
                console.error("[mcp-tools] zalo_poll error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_wait_for_message ---
    server.registerTool(
        "zalo_wait_for_message",
        {
            title: "Wait for Incoming Zalo Message",
            description:
                'Wait for the next incoming message, without polling. It returns at once when a buffered message newer than `since` is already waiting; otherwise it waits up to `timeoutSec` seconds (default 55, max 300) and then returns `status: "timeout"` with no message. Call it in a loop to listen, and call zalo_mark_read with the `cursor` when a message is handled. ' +
                "It returns every message already waiting, in order, in `messages` (`message` is the first, `cursor` is the last, so `since: cursor` continues where the batch ended); `limit` caps how many (then `hasMore` says more are already waiting); `settleMs` waits that long after the first message for the rest of a burst. A message's `id` is its msgId. " +
                SYSTEM_EVENTS_NOTE +
                "Mirrors GET /events/wait for remote HTTPS/OAuth2 MCP clients.",
            inputSchema: z.object({
                threadId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Optional thread ID to wait on (omit to wait for a message in any watched thread)"),
                since: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe(
                        "Optional buffer cursor (`_cursor` from a prior message or `cursor` from a prior wait). " +
                            "If a buffered message with `_cursor > since` already exists, returns immediately.",
                    ),
                timeoutSec: z
                    .number()
                    .int()
                    .min(1)
                    .max(300)
                    .default(55)
                    .describe("Maximum seconds to wait before returning `status: 'timeout'` (default 55, max 300)"),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe("Most messages to return in one call (omit for every message already waiting)"),
                settleMs: z
                    .number()
                    .int()
                    .min(0)
                    .max(MAX_SETTLE_MS)
                    .default(0)
                    .describe(
                        `After the first message arrives, wait this many ms for the rest of a burst (default 0, max ${MAX_SETTLE_MS})`,
                    ),
            }),
        },
        async ({ threadId, since, timeoutSec = 55, limit, settleMs = 0 }) => {
            try {
                if (typeof buffer?.waitForMessages !== "function") {
                    return err("Live message buffer does not support waitForMessages in this context.");
                }
                const cleanThreadId = typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
                const clampedSec = Math.max(1, Math.min(300, Number(timeoutSec) || 55));
                const batch = batchParams({ limit, settleMs });
                if (isHiddenThread(cleanThreadId)) return err(HIDDEN_THREAD);
                const waited = await buffer.waitForMessages({
                    threadId: cleanThreadId,
                    since: typeof since === "number" && Number.isFinite(since) ? since : undefined,
                    timeoutMs: clampedSec * 1000,
                    ...batch,
                });
                const messages = eventsView(waited.messages);
                const hasMore = waited.hasMore;
                return ok(
                    waitResult({
                        messages,
                        hasMore,
                        cursorWhenEmpty: Math.max(
                            Number(waited.messages.at(-1)?._cursor) || 0,
                            typeof since === "number" && Number.isFinite(since) ? since : 0,
                            Number(buffer._globalCursor) || 0,
                            typeof buffer.readCursor === "function" ? buffer.readCursor() : 0,
                        ),
                        decorate: (msg) => {
                            if (msg.hidden || msg.system) return msg;
                            const tid = String(msg.threadId || "");
                            let threadName = nameCache?.get(tid)?.name || null;
                            if (!threadName && tid) {
                                try {
                                    threadName = getDisplayName(tid) || null;
                                } catch {
                                    threadName = null;
                                }
                            }
                            return { ...msg, ...(threadName ? { threadName } : {}) };
                        },
                    }),
                );
            } catch (e) {
                console.error("[mcp-tools] zalo_wait_for_message error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_label ---
    server.registerTool(
        "zalo_label",
        {
            title: "Manage Zalo Conversation Labels",
            description:
                "List, assign, unassign, or update Zalo conversation/contact labels (tags such as 'Nội bộ', 'Khách hàng', 'Đối tác'). " +
                "Actions: 'list' (returns all labels with their IDs, text, colors, conversations array, and version), " +
                "'assign' (adds threadId or threadIds to a label identified by labelId or labelText), " +
                "'unassign' (removes threadId or threadIds from a label identified by labelId or labelText), " +
                "'update' (raw update with full labelData array and version, matching 'label update'; the list " +
                "replaces the current one, so a label left out of it is deleted: that is asked about first, " +
                "`confirm`, `dryRun`).",
            inputSchema: z.object({
                action: z
                    .enum(["list", "assign", "unassign", "update"])
                    .describe("Label operation to perform: 'list', 'assign', 'unassign', or 'update'"),
                labelId: z
                    .number()
                    .int()
                    .optional()
                    .describe("Numeric label ID (for 'assign' or 'unassign'; optional if labelText is provided)"),
                labelText: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        "Label name/text, e.g. 'Nội bộ', 'Khách hàng', 'Đối tác' (case-insensitive match for 'assign' or 'unassign')",
                    ),
                threadId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("One conversation (its threadId) to assign to or remove from the label."),
                threadIds: z
                    .array(z.string().min(1))
                    .optional()
                    .describe("Multiple thread IDs to assign or unassign in one call"),
                threadType: z
                    .enum(["dm", "group"])
                    .optional()
                    .describe(
                        'The type of every threadId/threadIds given: "dm" or "group". Leave it out: the type stored for each thread is used. A label stores a group as "g<groupId>".',
                    ),
                labelData: z
                    .array(z.any())
                    .optional()
                    .describe("Full labelData array from action='list' (required for raw action='update')"),
                version: z
                    .number()
                    .int()
                    .optional()
                    .describe("Label version integer from action='list' (required for raw action='update')"),
                confirm: confirmInput("an 'update' that removes labels"),
                ticket: ticketInput(),
                dryRun: dryRunInput("'update'"),
            }),
        },
        async (
            {
                action,
                labelId,
                labelText,
                threadId,
                threadIds,
                threadType: threadTypeIn,
                labelData,
                version,
                confirm,
                dryRun,
                ticket,
            },
            extra,
        ) => {
            try {
                if (action === "list") {
                    const res = await api.getLabels();
                    return ok({
                        action: "list",
                        labelData: Array.isArray(res?.labelData) ? res.labelData : [],
                        version: res?.version ?? 0,
                        lastUpdateTime: res?.lastUpdateTime ?? null,
                    });
                }

                if (action === "update") {
                    if (!Array.isArray(labelData) || typeof version !== "number" || !Number.isFinite(version)) {
                        return err("labelData (array) and version (number) are required for action='update'.");
                    }
                    // Only a label dropped from the list is asked about; knowing which takes the current list.
                    const removed = removedLabels((await api.getLabels())?.labelData, labelData);
                    const held = await gate(
                        "label.update",
                        { removedLabels: removed, version: Number(version) },
                        { confirm, dryRun, ticket },
                        extra,
                        { applies: removed.length > 0 },
                    );
                    if (held) return held;
                    const updated = await api.updateLabels({
                        labelData,
                        version: Number(version),
                    });
                    return ok({
                        action: "update",
                        success: true,
                        version: updated?.version ?? version,
                        labelData: updated?.labelData ?? labelData,
                        result: updated,
                    });
                }

                if (action === "assign" || action === "unassign") {
                    const targets = [
                        ...new Set(
                            [
                                ...(threadId ? [String(threadId).trim()] : []),
                                ...(Array.isArray(threadIds) ? threadIds.map((t) => String(t).trim()) : []),
                            ].filter(Boolean),
                        ),
                    ];
                    if (targets.length === 0) {
                        return err(`threadId (or threadIds) is required for action='${action}'.`);
                    }
                    if (labelId === undefined && (!labelText || !labelText.trim())) {
                        return err(`labelId or labelText is required for action='${action}'.`);
                    }

                    const current = await api.getLabels();
                    const list = Array.isArray(current?.labelData) ? current.labelData : [];
                    const needle = labelText ? labelText.trim().toLowerCase() : null;
                    const matched =
                        labelId !== undefined
                            ? list.find((l) => Number(l.id) === Number(labelId))
                            : list.find(
                                  (l) =>
                                      String(l.text ?? "")
                                          .trim()
                                          .toLowerCase() === needle ||
                                      String(l.textKey ?? "")
                                          .trim()
                                          .toLowerCase() === needle,
                              );
                    if (!matched) {
                        const available = list.map((l) => `${l.id}:${l.text}`).join(", ") || "none";
                        return err(
                            `Label not found (${labelId !== undefined ? `labelId=${labelId}` : `labelText="${labelText}"`}). Available labels: ${available}`,
                        );
                    }

                    // A label names a group as "g<groupId>" and a user by the bare id (spec-actions 9): a bare
                    // group id would be stored as a user conversation. Unassign drops both forms, so it also
                    // clears a bare group id an earlier version stored (a user id is never a group's).
                    const convIds = targets.map((t) => labelConversationId(t, threadTypeIn));
                    const dropped = new Set(
                        convIds.flatMap((c) => {
                            const bare = LABEL_GROUP_ID.test(c) ? c.slice(1) : c;
                            return [bare, `g${bare}`];
                        }),
                    );
                    let updatedConvList = [];
                    const nextLabelData = list.map((lbl) => {
                        if (Number(lbl.id) !== Number(matched.id)) return lbl;
                        const existing = Array.isArray(lbl.conversations) ? lbl.conversations.map(String) : [];
                        const nextConvs =
                            action === "assign"
                                ? [...new Set([...existing, ...convIds])]
                                : existing.filter((c) => !dropped.has(String(c)));
                        updatedConvList = nextConvs;
                        return { ...lbl, conversations: nextConvs };
                    });
                    const nextVersion = Number(current?.version ?? 0);
                    const updated = await api.updateLabels({
                        labelData: nextLabelData,
                        version: nextVersion,
                    });
                    return ok({
                        action,
                        success: true,
                        labelId: matched.id,
                        labelText: matched.text,
                        threadIds: targets,
                        conversations: updatedConvList,
                        version: updated?.version ?? nextVersion,
                        result: updated,
                    });
                }

                return err(`Unsupported label action: ${action}`);
            } catch (e) {
                console.error("[mcp-tools] zalo_label error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_friend ---
    server.registerTool(
        "zalo_friend",
        {
            title: "Manage Zalo Friends and Friend Requests",
            description:
                "Friends and friend requests: check, list and answer requests, list, remove and block friends. Actions: " +
                "'status' (the relationship with userId: is_friend, and is_requested / is_requesting, Zalo's two flags " +
                "for a request pending between you and them; to tell which direction a request goes, use the two lists), " +
                "'sent_requests' (requests you sent that are still pending), " +
                "'received_requests' (requests others sent you, newest first, with their message), " +
                "'send' (friend request to userId, with an optional message), " +
                "'accept' / 'reject' (the request from userId; 'reject' is asked about first), " +
                "'undo' (cancel the request you sent to userId; asked about first: `confirm`, `dryRun`), " +
                "'list' (your friends, most recently active first: all of them unless limit is given), " +
                "'alias' (set the nickname this account shows for userId to `alias`; an empty alias removes it; " +
                "the nickname is what `senderDisplayName` and `@[userId]` mentions then use), " +
                "'alias_list' (the nicknames set on this account: all of them unless limit is given), " +
                "'online' (friends online now: dead in practice, Zalo answers 404 and Zalo Web discards it too), " +
                "'close' (close friends), 'last_online' (when userId was last seen, with hiddenBy \"you\" or \"them\" " +
                "when hidden; nothing is asked when this account hides its own status, unless `askAnyway`; " +
                "`cached` reads the listener's presence cache instead), " +
                "'remove' (unfriend userId), 'block' / 'unblock' (userId), 'block_feed' (hide userId's posts from the " +
                "feed; `unblock: true` shows them again), 'find_phones' (users by `phones`), 'qr' (the QR code URL of " +
                "each of userIds), 'common_groups' (the groups you share with each of userIds), 'biz' (userId's " +
                "business account details). 'reject', 'undo', 'remove' and 'block' are asked about first: " +
                "`confirm`, `dryRun`. " +
                "userId is the numeric Zalo id (zalo_lookup_user finds one from a phone number). " +
                "Zalo restricts accounts that send many friend requests, so send sparingly.",
            inputSchema: z
                .object({
                    action: z
                        .enum([
                            "status",
                            "sent_requests",
                            "received_requests",
                            "send",
                            "accept",
                            "reject",
                            "undo",
                            "list",
                            "alias",
                            "alias_list",
                            ...Object.keys(FRIEND_EXTRA_ACTIONS),
                        ])
                        .describe("Friend operation to perform"),
                    userId: z
                        .string()
                        .min(1)
                        .optional()
                        .describe(
                            "Numeric Zalo user id (required for status, send, accept, reject, undo, alias, remove, block, " +
                                "unblock, last_online, biz and block_feed)",
                        ),
                    message: z
                        .string()
                        .optional()
                        .describe("Message sent with the friend request (only for 'send'; default: none)"),
                    alias: z
                        .string()
                        .max(200)
                        .optional()
                        .describe(
                            "Only for 'alias': the nickname to show for userId; an empty string removes the nickname",
                        ),
                    limit: z
                        .number()
                        .int()
                        .min(1)
                        .optional()
                        .describe(
                            "Most entries to return for 'list' and 'alias_list' (omit for all); 'list' says how many there are in all",
                        ),
                    ...FRIEND_EXTRA_INPUTS,
                    confirm: confirmInput("'reject', 'undo', 'remove' and 'block'"),
                    ticket: ticketInput(),
                    dryRun: dryRunInput("'reject', 'undo', 'remove' and 'block'"),
                })
                .strict(),
        },
        async (args, extra) => {
            // The actions added with the action tools run through the shared runner (src/mcp/action-tool.js).
            if (Object.hasOwn(FRIEND_EXTRA_ACTIONS, args.action)) return friendExtra(args, extra);
            const { action, userId, message, limit, alias, confirm, dryRun, ticket } = args;
            const needsUser = ["status", "send", "accept", "reject", "undo", "alias"].includes(action);
            const target = userId === undefined ? "" : String(userId).trim();
            if (needsUser) {
                if (!target) return err(`userId is required for action='${action}'.`);
                if (!/^\d{1,30}$/.test(target)) {
                    return err(
                        `userId must be a numeric Zalo id (got "${target}"). zalo_lookup_user finds one from a phone number.`,
                    );
                }
            }
            if (action === "reject" || action === "undo") {
                const key = action === "reject" ? "friend.reject" : "friend.undoRequest";
                const held = await gate(key, { userId: target }, { confirm, dryRun, ticket }, extra);
                if (held) return held;
            }
            try {
                switch (action) {
                    case "status":
                        return ok({ action, ...friendStatusFrom(await api.getFriendRequestStatus(target), target) });
                    case "sent_requests": {
                        // Zalo's "none sent" (112) is an empty list, not a failure.
                        const requests = sentRequestsFrom(await readSentRequests(api));
                        return ok({ action, count: requests.length, requests });
                    }
                    case "received_requests": {
                        const requests = receivedRequestsFrom(await api.getFriendRecommendations());
                        return ok({ action, count: requests.length, requests });
                    }
                    case "send":
                        await api.sendFriendRequest(message ?? "", target);
                        return ok({ action, success: true, userId: target });
                    case "accept":
                        await api.acceptFriendRequest(target);
                        return ok({ action, success: true, userId: target });
                    case "reject":
                        await api.rejectFriendRequest(target);
                        return ok({ action, success: true, userId: target });
                    case "undo":
                        await api.undoFriendRequest(target);
                        return ok({ action, success: true, userId: target });
                    case "list": {
                        const { total, friends } = friendsFrom(await api.getAllFriends(), limit);
                        return ok({ action, total, count: friends.length, truncated: friends.length < total, friends });
                    }
                    case "alias": {
                        const nick = alias === undefined ? "" : String(alias).trim();
                        if (nick) {
                            // The same call as the CLI's `friend alias` (the session takes the alias first).
                            await api.changeFriendAlias(nick, target);
                            // `contacts.name` is what senderDisplayName and mentions read (db.getDisplayName);
                            // the nickname is the name Zalo will show from now on, so it is written there at once.
                            rememberContactName(target, nick);
                            noteAliasSet(target, nick);
                            return ok({ action, success: true, userId: target, alias: nick });
                        }
                        await api.removeFriendAlias(target);
                        noteAliasSet(target, null);
                        // Without the nickname the contact is shown by their profile name again; fetch it so the
                        // cached name does not stay the removed nickname. Best effort: the removal already stuck.
                        try {
                            const info = await api.getUserInfo(target);
                            const p = info?.changed_profiles?.[target] || info?.unchanged_profiles?.[target] || null;
                            const shown = p?.displayName || p?.zaloName || null;
                            if (shown) rememberContactName(target, shown);
                        } catch (e) {
                            console.error(`[mcp-tools] zalo_friend alias: profile name not refreshed: ${e.message}`);
                        }
                        return ok({ action, success: true, userId: target, alias: null });
                    }
                    case "alias_list": {
                        // No limit: every page, as Zalo Web pages its alias list (src/core/list-all.js); a limit is
                        // one page of that size.
                        let items;
                        let note = null;
                        if (limit === undefined) {
                            const all = await allAliases(api);
                            items = all.items;
                            note = all.paging.note;
                        } else {
                            const res = await api.getAliasList(limit, 1);
                            items = Array.isArray(res?.items) ? res.items : [];
                        }
                        const aliases = items
                            .filter((i) => i && i.userId !== undefined && i.userId !== null)
                            .map((i) => ({ userId: String(i.userId), alias: i.alias ?? null }));
                        return ok({ action, count: aliases.length, aliases, ...(note && { note }) });
                    }
                    default:
                        return err(`Unsupported friend action: ${action}`);
                }
            } catch (e) {
                console.error("[mcp-tools] zalo_friend error:", e.message);
                // 'send' and 'undo' keep the CLI's wording for Zalo's refusal codes (already friends, blocked,
                // too many requests taken back, ...), read from the error's code.
                const code = errorCodeOf(e);
                const known =
                    action === "send"
                        ? describeFriendAddError(code, target)
                        : action === "undo"
                          ? describeFriendUndoError(code, target)
                          : null;
                return err(known || e.message);
            }
        },
    );

    // --- zalo_group ---
    server.registerTool(
        "zalo_group",
        {
            title: "Manage Zalo Groups",
            description:
                "Leave, inspect, create and change the membership of a group (zalo_get_group_members lists who is " +
                "in one). Actions: " +
                "'info' (the group's name, description, creator, admins, member count and limit, creation time and " +
                "settings), " +
                "'create' (a new group named `name` with the members in userIds), " +
                "'add_members' (add userIds to the group), " +
                "'remove_member' (remove the one member userId from the group), " +
                "'leave' (leave the group; `silent` hides the usual notice from ordinary members; the owner still sees it), " +
                "'rename' (set the group's name to `name`; every member sees the change), " +
                "'avatar' (set the group's avatar from a local image, `filePath`), " +
                "'add_admin' / 'remove_admin' (userIds), 'transfer_owner' (to userId), " +
                "'block_member' / 'unblock_member' (userIds; a blocked member cannot rejoin), 'blocked' (the blocked " +
                "members), 'settings' (change `settings`; the rest keep their values), 'upgrade_community', " +
                "'disperse' (disband the group for everyone), 'pending' / 'approve' / 'reject_member' (join requests, " +
                "admins only), 'enable_link' / 'disable_link' / 'link_info' (the invite link), 'link_preview' / " +
                "'join' (a group by its invite `link`), 'invite_boxes' (invitations you received), 'invite_info' / " +
                "'join_invite' (one of them, by groupId), 'delete_invite' (groupIds), 'invite_to' (invite userId to " +
                "groupIds), 'members_info' (profiles of userIds). " +
                "groupId is the group's thread id (zalo_search_threads or zalo_list_conversations finds it); " +
                "user ids are numeric Zalo ids (zalo_lookup_user finds one from a phone number). " +
                "'leave', 'remove_member', 'remove_admin', 'transfer_owner', 'block_member', 'disperse', " +
                "'disable_link', and 'settings' when it turns join approval off, are asked about first: " +
                "`confirm` and `dryRun`, as the deployment's confirmMode decides. Zalo can refuse some members " +
                "of a create or add_members: the reply lists the members it did and did not take.",
            inputSchema: z
                .object({
                    action: z
                        .enum([
                            "leave",
                            "info",
                            "create",
                            "add_members",
                            "remove_member",
                            "rename",
                            ...Object.keys(GROUP_EXTRA_ACTIONS),
                        ])
                        .describe("Group operation to perform"),
                    groupId: z
                        .string()
                        .min(1)
                        .optional()
                        .describe(
                            "The group's id (required for every action except create, link_preview, join, invite_boxes, " +
                                "delete_invite, invite_to and members_info)",
                        ),
                    name: z
                        .string()
                        .optional()
                        .describe("The group's name: the new group's for 'create', the name to set for 'rename'"),
                    userIds: z
                        .array(z.string().min(1))
                        .min(1)
                        .max(100)
                        .optional()
                        .describe(
                            "Numeric Zalo user ids (required for 'create', 'add_members', 'add_admin', 'remove_admin', " +
                                "'block_member', 'unblock_member', 'approve', 'reject_member' and 'members_info')",
                        ),
                    userId: z
                        .string()
                        .min(1)
                        .optional()
                        .describe(
                            "Numeric Zalo user id (required for 'remove_member', 'transfer_owner' and 'invite_to')",
                        ),
                    silent: z
                        .boolean()
                        .optional()
                        .describe(
                            "Only for 'leave': hide the usual notice from ordinary members; the owner still sees it (default false)",
                        ),
                    ...GROUP_EXTRA_INPUTS,
                    confirm: confirmInput("the actions asked about first (listed above)"),
                    ticket: ticketInput(),
                    dryRun: dryRunInput("the actions asked about first (listed above)"),
                })
                .strict(),
        },
        async (args, extra) => {
            // The actions added with the action tools run through the shared runner (src/mcp/action-tool.js).
            if (Object.hasOwn(GROUP_EXTRA_ACTIONS, args.action)) return groupExtra(args, extra);
            const { action, groupId, name, userIds, userId, silent, confirm, dryRun, ticket } = args;
            const gid = groupId === undefined ? "" : String(groupId).trim();
            if (["leave", "info", "add_members", "remove_member", "rename"].includes(action)) {
                if (!gid) return err(`groupId is required for action='${action}'.`);
                if (!/^\d{1,30}$/.test(gid)) {
                    return err(
                        `groupId must be a numeric Zalo group id (got "${gid}"). zalo_search_threads finds one by name.`,
                    );
                }
            }
            const badId = (id) => !/^\d{1,30}$/.test(id);
            let members = [];
            if (action === "create" || action === "add_members") {
                members = [...new Set((userIds ?? []).map((u) => String(u).trim()))];
                if (members.length === 0) return err(`userIds is required for action='${action}'.`);
                const bad = members.find(badId);
                if (bad !== undefined) {
                    return err(
                        `userIds must be numeric Zalo ids (got "${bad}"). zalo_lookup_user finds one from a phone number.`,
                    );
                }
            }
            const target = userId === undefined ? "" : String(userId).trim();
            if (action === "remove_member") {
                if (!target) return err("userId is required for action='remove_member'.");
                if (badId(target)) {
                    return err(
                        `userId must be a numeric Zalo id (got "${target}"). zalo_get_group_members lists a group's members.`,
                    );
                }
            }
            const groupName = name === undefined ? "" : String(name).trim();
            if ((action === "create" || action === "rename") && !groupName) {
                return err(`name is required for action='${action}'.`);
            }

            // After validation, before Zalo: a refused call changes nothing and says exactly how to retry.
            if (action === "leave" || action === "remove_member") {
                const held = await gate(
                    action === "leave" ? "group.leave" : "group.removeMember",
                    action === "leave"
                        ? { groupId: gid, silent: silent === true }
                        : { groupId: gid, userIds: [target] },
                    { confirm, dryRun, ticket },
                    extra,
                );
                if (held) return held;
            }

            try {
                switch (action) {
                    case "info": {
                        const info = groupInfoFrom(
                            await getGroupInfoWatched(api, ownIdOf(api) || null, [String(gid)]),
                            gid,
                        );
                        if (!info) {
                            return err(
                                `Zalo's answer does not include group ${gid}: this account is not in it, or it is not ` +
                                    "a group id (a 1-1 conversation's id is the other person's uid).",
                            );
                        }
                        return ok({ action, ...info });
                    }
                    case "create": {
                        const made = createdGroupFrom(await api.createGroup({ name: groupName, members }), members);
                        if (!made.groupId)
                            return err("Zalo did not return a group id; the group may not have been created.");
                        return ok({
                            action,
                            groupId: made.groupId,
                            name: groupName,
                            added: made.added,
                            failed: made.failed,
                        });
                    }
                    case "add_members": {
                        const change = memberChangeFrom(await api.addUserToGroup(members, gid), members);
                        if (change.done.length === 0) {
                            const why = change.errorData
                                ? ` (Zalo's error codes: ${JSON.stringify(change.errorData)})`
                                : "";
                            return err(
                                `Zalo did not add any of the ${members.length} member(s) to group ${gid}${why}.`,
                            );
                        }
                        return ok({
                            action,
                            groupId: gid,
                            added: change.done,
                            failed: change.failed,
                            ...(change.errorData && { errorData: change.errorData }),
                        });
                    }
                    case "remove_member": {
                        const change = memberChangeFrom(await api.removeUserFromGroup([target], gid), [target]);
                        if (change.failed.length > 0) {
                            return err(
                                `Zalo did not remove ${target} from group ${gid}: not a member, or this account is not ` +
                                    "allowed to remove members (a group's owner or an admin can).",
                            );
                        }
                        return ok({ action, success: true, groupId: gid, userId: target });
                    }
                    case "rename": {
                        // The same call as the CLI's `group rename` (the session takes the name first).
                        await api.changeGroupName(groupName, gid);
                        return ok({ action, success: true, groupId: gid, name: groupName });
                    }
                    case "leave": {
                        const quiet = silent === true;
                        const res = await api.leaveGroup(gid, quiet);
                        const memberError = Array.isArray(res?.memberError) ? res.memberError : [];
                        // As Zalo Web on the API's success: the group's local history goes now (or is kept flagged,
                        // groups.onLeave), whether or not a listener sees the echo.
                        const exit = await recordOwnExit({ ownId: ownIdOf(api), groupId: gid, reason: "leave" });
                        return ok({
                            action,
                            success: true,
                            groupId: gid,
                            silent: quiet,
                            ...(memberError.length > 0 && { memberError }),
                            ...exit,
                        });
                    }
                    default:
                        return err(`Unsupported group action: ${action}`);
                }
            } catch (e) {
                console.error("[mcp-tools] zalo_group error:", e.message);
                if (action === "leave" && NOT_A_MEMBER_CODES.includes(Number(e.code ?? extractErrorCode(e.message)))) {
                    return err(
                        `This account is not in group ${gid} (already left, or never joined), so there is nothing to leave.`,
                    );
                }
                if (
                    action === "remove_member" &&
                    Number(e.code ?? extractErrorCode(e.message)) === REMOVE_NOT_IN_GROUP
                ) {
                    return err(
                        `Zalo says ${target} is not in group ${gid} ("${e.message}", code ${REMOVE_NOT_IN_GROUP}).`,
                    );
                }
                return err(e.message);
            }
        },
    );

    // --- The action tools: one per area, each action the call its CLI command makes (src/mcp/actions-*.js) ---
    server.registerTool(
        "zalo_conversation",
        CONVERSATION_META,
        actionTool("zalo_conversation", CONVERSATION_ACTIONS, toolCtx),
    );
    server.registerTool("zalo_profile", PROFILE_META, actionTool("zalo_profile", PROFILE_ACTIONS, toolCtx));
    server.registerTool("zalo_auto_reply", AUTO_REPLY_META, actionTool("zalo_auto_reply", AUTO_REPLY_ACTIONS, toolCtx));
    server.registerTool(
        "zalo_quick_message",
        QUICK_MESSAGE_META,
        actionTool("zalo_quick_message", QUICK_MESSAGE_ACTIONS, toolCtx),
    );
    server.registerTool("zalo_catalog", CATALOG_META, actionTool("zalo_catalog", CATALOG_ACTIONS, toolCtx));
    server.registerTool("zalo_bank", BANK_META, actionTool("zalo_bank", BANK_ACTIONS, toolCtx));
    server.registerTool("zalo_cloud", CLOUD_META, actionTool("zalo_cloud", CLOUD_ACTIONS, toolCtx));
    server.registerTool("zalo_sticker", STICKER_META, actionTool("zalo_sticker", STICKER_ACTIONS, toolCtx));
    server.registerTool("zalo_link", LINK_META, actionTool("zalo_link", LINK_ACTIONS, toolCtx));

    // --- zalo_read ---
    server.registerTool(
        "zalo_read",
        {
            title: "Read From Zalo's Web API",
            description:
                "Ask Zalo one of the read-only endpoints Zalo Web calls that no other tool covers: the sticker and GIF " +
                "catalogs and GIF search, a profile's rank and extra fields, the block list, the nickname list, the " +
                "search history Zalo keeps, delivery and seen status, the group quota and the account's role in a " +
                "group, friend profile checks, the emoji statuses of friends, the server's client settings, and " +
                "more. Omit `name` to list every read with what it takes and whether a live account has answered it; " +
                "give `name` and `args` to run one. It only reads: nothing here sends, marks, changes or removes " +
                "anything. `args` is an object named by the read's own argument list (ids are strings).",
            inputSchema: z.object({
                name: z
                    .enum(READ_NAMES)
                    .optional()
                    .describe("The read to run (omit to list them all, with their arguments)"),
                args: z
                    .record(z.string(), z.any())
                    .optional()
                    .describe('The read\'s arguments by name, e.g. {"id": "123"} for profile-rank'),
            }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async ({ name, args }) => {
            if (!name) return ok({ reads: describeReads() });
            // A read about one conversation names it in its args; a hidden one is left out like everywhere else.
            if (readThreadIds(args).some(isHiddenThread)) return err(HIDDEN_THREAD);
            try {
                // A paged read with no page chosen is read to its end (READ_PAGERS in src/zalo/reads.js).
                const { data, paging } = await callReadAll(api, name, args || {});
                return ok({ name, data: data ?? null, ...(paging?.note && { note: paging.note }) });
            } catch (e) {
                if (!(e instanceof ReadUsageError)) console.error("[mcp-tools] zalo_read error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_write ---
    server.registerTool(
        "zalo_write",
        {
            title: "Change Something Through Zalo's Web API",
            description:
                "Make one of the state-changing calls Zalo Web makes that no other tool covers: reminder RSVP, creating " +
                "or changing a group note or reminder with a repeat rule, pinning and unpinning board items, removing a " +
                "topic, recalling several messages at once, suggested-friend cleanup, blocking an " +
                "Official Account, removing one account from several groups, the search history. Omit `name` to list " +
                "every write with what it touches (`risk`: private, visible to others, or destructive), what it takes, " +
                "whether a live success was seen (`verified`) and, if not, why (`note`). EVERY write changes " +
                'something, so a real call is asked about first, even where the deployment\'s confirmMode is "off" ' +
                '(`confirm: true`; in "human" mode the server asks the user), and `dryRun: true` ' +
                "returns the request that would be sent without sending anything: use it first, and try an unverified " +
                "write on something disposable. Enum-like arguments take the web client's names or numbers (`list` " +
                "shows them). `args` is an object named by the write's own argument list (ids are strings).",
            inputSchema: z.object({
                name: z
                    .enum(WRITE_NAMES)
                    .optional()
                    .describe("The write to make (omit to list them all, with their arguments and risk)"),
                args: z
                    .record(z.string(), z.any())
                    .optional()
                    .describe('The write\'s arguments by name, e.g. {"groupId": "123", "topicId": "45"}'),
                dryRun: z
                    .boolean()
                    .optional()
                    .describe("Return the request that would be sent, with its body decrypted, and send nothing"),
                confirm: confirmInput("a real call (not needed with dryRun)"),
                ticket: ticketInput(),
            }),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
        async ({ name, args, dryRun, confirm, ticket }, extra) => {
            if (!name) return ok({ writes: describeWrites() });
            // Arguments first, as for every guarded action: a call missing one is refused as the typo it is, before
            // anyone is asked to confirm a request that could not be sent. Building the request sends nothing; a
            // failure that is not about the arguments is left to the call itself.
            try {
                buildWrite(api, name, args || {});
            } catch (e) {
                if (e instanceof ReadUsageError) return err(e.message);
            }
            // dryRun is the write's own: it returns the request itself, so only a real call is gated. A raw
            // endpoint runner stays gated even in confirmMode "off".
            if (!dryRun) {
                const def = WRITES[name];
                const held = await gate(
                    "write.run",
                    { name, risk: def?.risk, verified: def?.verified, args: args || {} },
                    { confirm, ticket },
                    extra,
                    { always: true },
                );
                if (held) return held;
            }
            try {
                const data = await callWrite(api, name, args || {}, { dryRun: dryRun === true });
                return ok(dryRun ? data : { name, data: data ?? null });
            } catch (e) {
                if (!(e instanceof ReadUsageError)) console.error("[mcp-tools] zalo_write error:", e.message);
                return err(e.message);
            }
        },
    );
}
