/**
 * MCP tool registrations for Zalo message access, sending, user lookup, and group productivity.
 * Registers 25 tools: zalo_get_messages, zalo_get_history, zalo_send_message, zalo_list_threads,
 * zalo_search_threads, zalo_mark_read, zalo_view_media, zalo_react, zalo_undo, zalo_get_group_members,
 * zalo_list_conversations, zalo_coverage, zalo_sync, zalo_sync_status, zalo_search_messages,
 * zalo_lookup_user, zalo_forward_message, zalo_delete_message, zalo_reminder, zalo_note, zalo_poll,
 * zalo_wait_for_message, zalo_label, zalo_friend, zalo_group.
 *
 * A tool that mirrors a CLI command calls the same code the command does (src/core/cached-message.js,
 * forward.js, pin.js, group-members.js, recent-conversations.js, src/utils/my-documents.js, urgency.js),
 * so the two cannot drift apart.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { openFile } from "../utils/open-file.js";
import {
    getMessages,
    getMessageById,
    searchMessages,
    getDisplayName,
    getThreadType,
    getThreadNames,
    getConvState,
    getReadStates,
} from "../core/db.js";
import { downloadSyncedMedia } from "../core/sync-v2/media.js";
import { describeZaloError } from "../core/sync-v2/board.js";
import { fetchAndCacheHistory } from "../core/history-fetch.js";
import {
    cachedCliMsgId,
    cachedText,
    resolveSenderUid,
    cachedMessageById,
    reactionCliMsgId,
    recallCliMsgId,
} from "../core/cached-message.js";
import { buildForwardReference, sendForward, LOG_SRC_TYPE } from "../core/forward.js";
import { pinMessage, unpinMessage, textPinParams } from "../core/pin.js";
import { coverageReport } from "../core/coverage.js";
import { groupMemberUids, fetchMemberNames } from "../core/group-members.js";
import { recentConversations } from "../core/recent-conversations.js";
import { describeReadState, readOnZalo } from "../core/read-state.js";
import { extractMessageText } from "../utils/extract-message-text.js";
import { expandMentions, shiftStyles, ALL_MENTION_UID } from "../utils/mentions.js";
import { resolveSelfThread } from "../utils/my-documents.js";
import { buildQuote, resolveQuoteSender } from "../utils/quote.js";
import { urgencyLevel } from "../utils/urgency.js";
import { splitMessage, sendParts } from "../utils/split-message.js";
import { hasLiteralNewline, LITERAL_NEWLINE_WARNING } from "../utils/literal-newline.js";
import { markdownToZalo, resolveSendFormat } from "../utils/markdown.js";
import { MAX_BATCH, MAX_SETTLE_MS, batchParams, waitResult } from "./wait-result.js";
import {
    describeFriendAddError,
    extractErrorCode,
    friendStatusFrom,
    friendsFrom,
    receivedRequestsFrom,
    sentRequestsFrom,
} from "../core/friend-requests.js";
import {
    CONFIRMED_ACTIONS,
    NOT_A_MEMBER_CODES,
    REMOVE_NOT_IN_GROUP,
    createdGroupFrom,
    groupConfirmRequired,
    groupInfoFrom,
    memberChangeFrom,
} from "../core/group-admin.js";
import { resolveCurrentUserNames, withCurrentSenderNames } from "../core/current-user-names.js";

/** Repeat mode codes matching zca-js ReminderRepeatMode enum and src/commands/reminder.js. */
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
 * @param {object} api - logged-in zca-js API instance
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
 * @param {number} [explicit] - the caller's threadType, if they gave one
 * @returns {number} THREAD_USER or THREAD_GROUP
 */
function resolveThreadType(threadId, explicit) {
    if (explicit !== undefined && explicit !== null) return Number(explicit);
    try {
        return getThreadType(String(threadId)) === "group" ? THREAD_GROUP : THREAD_USER;
    } catch {
        // No cache yet: fall back to the old assumption rather than failing.
        return THREAD_USER;
    }
}

/** Thread type constants matching zca-js ThreadType enum */
const THREAD_USER = 0;

/** Thread type for groups — the only kind Zalo delivers mentions in. */
const THREAD_GROUP = 1;

/**
 * How many member ids `zalo_get_group_members` asks Zalo to name per request.
 * zca-js puts them in the request URL, and Zalo Web asks in bounded batches
 * too; 50 is the batch the group commands already use for `getGroupInfo`.
 */
const MEMBER_NAME_BATCH = 50;

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
function cachedDisplayName(uid) {
    try {
        return getDisplayName(uid);
    } catch {
        return null; // no db in this process
    }
}

/**
 * This account's own uid, or "" when the session cannot say.
 *
 * @param {object} api - zca-js API instance
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
 * @param {object} api - zca-js API instance
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
 * explicit `threadType: 1` is refused, as `msg send me -t 1` is.
 *
 * @param {object} api - zca-js API instance
 * @param {string} threadId - as the caller gave it
 * @param {number} [threadTypeIn] - the caller's threadType, if they gave one
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
        groupRequested: Number(threadTypeIn) === THREAD_GROUP,
    });
}

/**
 * The conversation a send or a message action names, and its type.
 *
 * My Documents (see {@link selfThread}) is always a 1-1; anything else is
 * typed by {@link resolveThreadType}: the caller's explicit threadType, else
 * the cache's.
 *
 * @param {object} api - zca-js API instance
 * @param {string} threadIdIn - as the caller gave it
 * @param {number} [threadTypeIn] - the caller's threadType, if they gave one
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

    const messages = rows
        .map((m) => ({
            msgId: m.msgId,
            threadId: m.threadId,
            senderId: m.senderId || null,
            senderName: m.senderName || null,
            text: m.text,
            timestamp: m.timestamp,
            type: m.type,
            localPath: m.localPath || undefined,
            hasAttachment: m.has_attachment ? true : undefined,
            msgStatus: m.msgStatus ?? undefined,
        }))
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

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

/**
 * Register all Zalo MCP tools on the server.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {object} api - zca-js API instance
 * @param {import("./message-buffer.js").MessageBuffer} buffer
 * @param {import("./thread-filter.js").ThreadFilter} filter
 * @param {object} config - MCP config
 * @param {import("./thread-name-cache.js").ThreadNameCache} [nameCache] - Thread name cache
 * @param {string} [accountDir] - account data dir; media is fetched into <accountDir>/media
 * @param {ReturnType<import("../core/daemon-channel.js").createStageLock>} [stageLock] - the
 *   daemon's one-stage-at-a-time lock; a server-side history fetch takes it, as `listen`'s does
 * @param {object} [syncJobs] - the daemon's account-local sync job tracker
 */
export function registerTools(server, api, buffer, filter, config, nameCache, accountDir, stageLock, syncJobs) {
    const maxPerPoll = config.limits?.maxMessagesPerPoll ?? 20;

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

    // --- zalo_get_messages ---
    server.registerTool(
        "zalo_get_messages",
        {
            title: "Get Zalo Messages",
            description:
                "Read the new incoming Zalo messages (DMs and groups) from the live buffer, in order. It returns the messages this consumer has not yet marked read; when you have handled them, call zalo_mark_read with the reply's `cursor`. " +
                "To continue exactly after the last reply, pass its `cursor` as `since`. To wait for the next message instead of polling, use zalo_wait_for_message. " +
                "Each message has `msgId` (pass it as `msgId` or `quoteMsgId` to other tools; `id` is the same value, kept for older clients), `threadId`, `threadType` (dm or group), `senderId`, `senderDisplayName` (the current name: your alias, else the Zalo profile name, else the uid; `senderDisplayNameSource` says which), `senderName` (the name when the message was first seen), `text`, `timestamp` (epoch ms), `type`, `threadName` and `readOnZalo`. " +
                "`readOnZalo` is true or false when the account owner has or has not read the message on Zalo (phone or Zalo Web), and null when that is unknown; zalo_mark_read does not change it. " +
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
                    .max(100)
                    .default(maxPerPoll)
                    .describe("Most messages to return in one call (1 to 100)."),
                consumer: consumerSchema,
            }),
        },
        async ({ threadId, since, limit, consumer }) => {
            try {
                // An explicit cursor is honored as given; 0 starts after what this consumer marked read.
                const from = since > 0 ? since : buffer.readCursor(consumer);
                const result = buffer.read(threadId, from, limit);
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
                    readOnZalo: readOnZalo(msg.id, watermarkOf(String(msg.threadId))),
                }));
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
                "Send a message to a Zalo conversation: text, files or images, a link preview card, or a contact card. Give `threadId` and one kind of content: `text`, `filePath` or `files`, `link`, or `cardUserId`. With files or a link, `text` is an optional caption. " +
                'Text: use real line breaks, never the two characters backslash and n (Zalo shows those as typed). Markdown is converted to Zalo formatting by default; `format: "plain"` sends the text exactly as written. A text over 3000 bytes (a Chinese, Japanese, Korean, Thai or Hindi character is 3, a Cyrillic or Arabic one 2) is split into several messages at paragraph or sentence ends, as Zalo Web does, and the reply then lists every part (`splitInto`, `parts`). ' +
                "Mention in a group: put `@[userId]` in the text where the tag belongs (`@[-1]` is @All). Take the user id from a message's `senderId` (zalo_get_messages, zalo_get_history) or from zalo_get_group_members. It is sent as `@Their Name` and notifies that person; a user id the cache cannot name is tagged as the bare id and listed in `unresolvedMentions`. Mentions only work in groups. " +
                "Reply to a message: pass its msgId as `quoteMsgId` (text messages only, and the message must be in the local cache). " +
                '`urgency` marks the message Important or Urgent, as the apps do. `threadId: "me"` sends to the owner\'s My Documents. ' +
                "Returns `{ success, msgId, cliMsgId, threadType }` (`messageId` is the same value as `msgId`, kept for older clients) and, when they apply, `parts` and `warnings`. Keep `msgId` and `cliMsgId` if you may need to react to or recall this message (zalo_react, zalo_undo).",
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
                            "The message. Real line breaks only: never the two characters backslash and n. Markdown is converted unless `format` is 'plain'. Required unless `filePath`, `files`, `link` or `cardUserId` is given; with those it is the caption. `@[userId]` tokens become @-mentions (`@[-1]` is @All).",
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
                    threadType: z
                        .number()
                        .int()
                        .min(0)
                        .max(1)
                        .optional()
                        .describe(
                            "0 = DM, 1 = group. Leave it out: the type stored for this thread is used. Pass it only to override that.",
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
                .refine(
                    (val) =>
                        Boolean(
                            val.text ||
                            val.link ||
                            val.cardUserId ||
                            val.filePath ||
                            (Array.isArray(val.files) && val.files.length > 0),
                        ),
                    "Provide at least one of text, filePath, files, link, or cardUserId",
                )
                .refine((val) => {
                    const hasFile = Boolean(val.filePath || (Array.isArray(val.files) && val.files.length > 0));
                    const modes = [Boolean(val.link), Boolean(val.cardUserId), hasFile].filter(Boolean).length;
                    return modes <= 1;
                }, "Cannot combine link, cardUserId, and file attachments in a single call"),
        },
        async ({
            threadId: threadIdIn,
            text,
            filePath,
            files,
            link,
            cardUserId,
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
            try {
                if (cardUserId) {
                    const result = await api.sendCard({ userId: cardUserId }, threadId, Number(threadType));
                    const messageId = result?.msgId ?? result?.message?.msgId ?? null;
                    const cliMsgId = result?.cliMsgId ?? result?.message?.cliMsgId ?? null;
                    return ok({
                        success: true,
                        kind: "card",
                        cardUserId,
                        messageId,
                        msgId: messageId,
                        ...(cliMsgId !== null && { cliMsgId: String(cliMsgId) }),
                        threadType,
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
                        messageId,
                        msgId: messageId,
                        ...(cliMsgId !== null && { cliMsgId: String(cliMsgId) }),
                        threadType,
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
                        messageId,
                        msgId: messageId,
                        ...(cliMsgId !== null && { cliMsgId: String(cliMsgId) }),
                        threadType,
                        ...(thread.notice && { threadId, notice: thread.notice }),
                    });
                }

                if (!text) {
                    return err("Provide text, filePath, files, link, or cardUserId.");
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

                // zca-js drops mentions outside a group, so a DM send would
                // quietly arrive with the names as plain text and nobody tagged.
                if (mentions.length > 0 && Number(threadType) !== THREAD_GROUP) {
                    warnings.push(
                        "Mentions only apply to group messages. This was sent with threadType " +
                            `${Number(threadType)}, so the names went out as plain text and nobody was tagged.`,
                    );
                }

                let quote;
                if (quoteMsgId) {
                    // buildQuote needs `cliMsgId` and the `property` blob, which
                    // live only in the cached row's raw_data. A db that is not
                    // open reads as "not cached", whose message names the fix.
                    let row = null;
                    try {
                        row = getMessageById(quoteMsgId);
                    } catch (e) {
                        console.error("[mcp-tools] cache unavailable for quote:", e.message);
                    }
                    const built = buildQuote(row, { msgId: quoteMsgId, threadId });
                    // Reported through err() rather than letting zca-js raise a
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
                // --urgency` maps it; zca-js turns it into the `metaData:
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
                    messageId,
                    msgId: messageId,
                    ...(cliMsgId !== null && { cliMsgId: String(cliMsgId) }),
                    threadType,
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
                                messageId: partId,
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
                const stats = buffer.getStats(buffer.readCursor(consumer));
                const dmNames = await resolveCurrentUserNames(
                    api,
                    stats.filter((t) => buffer.getThreadType(t.threadId) === "dm").map((t) => t.threadId),
                );
                const reads = readStatesOf(
                    api,
                    stats.map((t) => String(t.threadId)),
                );
                // Enrich each stat entry with threadType, thread name and read state
                const enriched = stats.map((t) => {
                    const threadType = buffer.getThreadType(t.threadId) ?? "unknown";
                    const cached = nameCache?.get(t.threadId);
                    return {
                        ...t,
                        threadType,
                        name: dmNames.get(String(t.threadId))?.name ?? cached?.name ?? null,
                        ...(cached?.memberCount !== undefined && { memberCount: cached.memberCount }),
                        readState: describeReadState(reads.get(String(t.threadId))),
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
                "Find a conversation by name, to get its `threadId`. It is a fuzzy search that ignores case and Vietnamese accents, over the names this server knows (cached contacts and groups). To find a person by phone number or username instead, use zalo_lookup_user. " +
                "Returns `{ results, total }`; use a result's `threadId` in zalo_send_message, zalo_get_history and the other tools.",
            inputSchema: z.object({
                query: z.string().min(1).describe("Search keyword (fuzzy match, case-insensitive, accent-insensitive)"),
                type: z
                    .enum(["group", "dm", "all"])
                    .default("all")
                    .describe("Filter by thread type: 'dm', 'group', or 'all'"),
                limit: z.number().int().min(1).max(50).default(10).describe("Max results to return"),
            }),
        },
        async ({ query, type, limit }) => {
            try {
                if (!nameCache?.ready) {
                    return err("Thread name cache not initialized yet. Try again shortly.");
                }
                await nameCache.refreshUsers?.(api);
                const results = nameCache.search(query, type, limit);
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
                "Each message has `msgId`, `senderId`, `senderDisplayName` (the current name: your alias, else the Zalo profile name, else the uid; `senderDisplayNameSource` says which), `senderName` (the name when first seen), `text`, `timestamp` and `type`. Reply: `{ threadId, threadType, count, messages, cursor, hasMore }`. " +
                "Start with a small `limit` and page; a large one costs memory and time. To find messages by their text, use zalo_search_messages.",
            inputSchema: z.object({
                threadId: z
                    .string()
                    .describe("The conversation: the other person's user id for a DM, the group id for a group."),
                threadType: z
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .optional()
                    .describe(
                        "0 = DM, 1 = group. Leave it out: the type stored for this thread is used. " +
                            "Pass it only to override that.",
                    ),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(200)
                    .default(50)
                    .describe("Most messages to return (1 to 200; default 50)."),
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
            }),
        },
        async ({ threadId, threadType: threadTypeIn, limit, lastMsgId, before }) => {
            const threadType = resolveThreadType(threadId, threadTypeIn);
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
                        threadId: f.threadId,
                        senderId: d.uidFrom || null,
                        senderName: d.dName || null,
                        text: isText ? rawContent : extractMessageText(rawContent, d.msgType),
                        timestamp: d.ts ? Number(d.ts) : null,
                        type: isText ? "text" : d.msgType || "attachment",
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
    server.registerTool(
        "zalo_view_media",
        {
            title: "View Zalo Media",
            description:
                "Get a received photo, voice message, video or file as a local file, and by default open it with the viewer of the machine this server runs on. Media is downloaded when a message arrives; if the file is not on disk yet it is downloaded first. " +
                "Give the message's `msgId`. Returns `{ success, path, mediaType }`: `path` is where the file is on the server's machine. Pass `open: false` when you only need the path (for example on a remote or headless server).",
            inputSchema: z.object({
                msgId: z
                    .string()
                    .describe(
                        "msgId of a message that has a photo, voice message, video or file (from zalo_get_messages, zalo_wait_for_message or zalo_get_history).",
                    ),
                threadId: z.string().optional().describe("Only look in this conversation. Omit to search all of them."),
                open: z
                    .boolean()
                    .default(mediaConfig.autoOpen ?? true)
                    .describe(
                        "Also open the file with the viewer of the machine this server runs on. Pass false when you only need the path.",
                    ),
            }),
        },
        async ({ msgId, threadId, open }) => {
            try {
                // The cached row is authoritative: it records where a fetched
                // file actually landed, so a message that arrived before this
                // process started is still openable. The buffer is only a
                // fallback for a thread id.
                let row = null;
                try {
                    row = getMessageById(msgId);
                } catch (e) {
                    console.error("[mcp-tools] cache unavailable:", e.message);
                }
                const buffered = buffer.read(threadId, 0, 9999).messages.find((m) => m.id === msgId) || null;
                if (!row && !buffered) return err(`Message ${msgId} not found in cache or buffer`);
                if (row && !row.has_attachment && !buffered?.attachment?.url) {
                    return err(`Message ${msgId} has no media attachment`);
                }

                let localPath = row?.localPath || null;
                if (!localPath) {
                    // Same downloader as the CLI, so the file lands in the one
                    // per-conversation folder every other command reads from.
                    const stats = await downloadSyncedMedia({
                        api,
                        accountDir,
                        threadId: String(row?.threadId || buffered?.threadId || threadId || ""),
                        limit: 50,
                        concurrency: 2,
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

                if (open) openFile(localPath);

                return ok({ success: true, path: localPath, mediaType: row?.type || buffered?.type || null });
            } catch (e) {
                console.error("[mcp-tools] zalo_view_media error:", e.message);
                return err(e.message);
            }
        },
    );

    // The threadType parameter of the message actions, worded as the send's is.
    const threadTypeSchema = z
        .number()
        .int()
        .min(0)
        .max(1)
        .optional()
        .describe(
            "0 = DM, 1 = group. Leave it out: the type stored for this thread is used. " +
                "Pass it only to override that.",
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
                    threadType,
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
                'Recall (unsend) one of your own messages for everyone in the conversation, as the apps\' "Thu hồi" does. Zalo accepts a recall only for a while after the message was sent. ' +
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
            }),
        },
        async ({ msgId, threadId: threadIdIn, threadType: threadTypeIn, cliMsgId }) => {
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
                await api.undo({ msgId, cliMsgId: target.cliMsgId }, threadId, Number(threadType));
                return ok({
                    success: true,
                    msgId,
                    cliMsgId: target.cliMsgId,
                    threadId,
                    threadType,
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
                "List the members of a group: each member's `userId` (`uid` is the same value, kept for older clients) and `displayName` (from the cache, or from Zalo for members the cache cannot name), and `totalMember`, Zalo's own count (it can be larger than the members listed). Use a `userId` as `@[userId]` in zalo_send_message to mention that member.",
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
                const names = new Map();
                const unnamed = [];
                for (const uid of group.uids) {
                    const name = cachedDisplayName(uid);
                    if (name) names.set(uid, name);
                    else unnamed.push(uid);
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

                const members = group.uids.map((uid) => ({ userId: uid, uid, displayName: names.get(uid) ?? null }));
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
                "Each has its thread id, type, name and last activity, plus `readState`: how far the account owner has read it on Zalo (on any device), meaning the newest message read, how many cached messages from others came after it, and whether it is marked unread (null when unknown). `limit` is per type: with `type` 'all' that is up to `limit` DMs and `limit` groups.",
            inputSchema: z.object({
                type: z
                    .enum(["group", "dm", "all"])
                    .default("all")
                    .describe("Filter by thread type: 'dm', 'group', or 'all'"),
                limit: z.number().int().min(1).max(200).default(20).describe("Max conversations of each type"),
            }),
        },
        async ({ type, limit }) => {
            try {
                const threads = recentConversations(limit, type);
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
                        type: isGroup ? "group" : "dm",
                        threadType: isGroup ? THREAD_GROUP : THREAD_USER,
                        name:
                            dmNames.get(String(t.threadId))?.name ||
                            t.name ||
                            nameCache?.get(String(t.threadId))?.name ||
                            null,
                        lastActivity: ts,
                        lastActivityAt: ts ? new Date(ts).toISOString() : null,
                        readState: describeReadState(reads.get(String(t.threadId))),
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
                "OWNER ONLY: call it only when the owner explicitly asks. Start a restore of messages (or of the reaction backlog) on this server's existing Zalo connection. The `messages` stage makes the owner's phone ask for a confirmation, which the owner must tap. " +
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
                        .enum(["messages", "reactions"])
                        .default("messages")
                        .describe(
                            "`messages` restores chat history from the owner's phone (the phone asks for a confirmation); `reactions` drains Zalo's backlog of reactions (no phone tap).",
                        ),
                    days: z
                        .number()
                        .int()
                        .min(1)
                        .max(36500)
                        .optional()
                        .describe("Restore the last N days; omit both days and from for full phone history."),
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
                })
                .strict()
                .refine(
                    (value) => !(value.days !== undefined && value.from !== undefined),
                    "Choose days or from, not both",
                )
                .refine(
                    (value) => value.stage !== "reactions" || (value.days === undefined && value.from === undefined),
                    "Reactions sync has no date window",
                )
                .refine(
                    (value) => value.stage !== "messages" || value.applyRemovals === undefined,
                    "applyRemovals is reactions-only",
                ),
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
                "Search the text of messages in the local cache (`zalo.db`), across all conversations or one. No network call. It is a case-insensitive substring match. " +
                "Narrow it with `threadId`, `senderId`, `since` or `until` (epoch ms). Results are newest first.",
            inputSchema: z.object({
                query: z.string().min(1).describe("Case-insensitive text substring to search for in cached messages"),
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
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(200)
                    .default(50)
                    .describe("Max matching messages to return (default 50, max 200)"),
            }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async ({ query, threadId, senderId, since, until, limit }) => {
            try {
                const rows = searchMessages({ query, threadId, senderId, since, until, limit });
                const threadNames = getThreadNames();
                const messages = rows.map((r) => {
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
                        senderName: r.senderDisplayName || r.senderName || null,
                        text: r.text,
                        timestamp: r.timestamp,
                        type: r.type,
                        hasAttachment: Boolean(r.has_attachment),
                        localPath: r.localPath || null,
                    };
                });
                return ok({ query, count: messages.length, messages });
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
                        displayName: user?.display_name || user?.zalo_name || null,
                        zaloName: user?.zalo_name || null,
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
                        displayName: user?.display_name || user?.zalo_name || null,
                        zaloName: user?.zalo_name || null,
                        avatar: user?.avatar || null,
                        user: user || null,
                    });
                }
                const info = await api.getUserInfo(userId);
                const changed = info?.changed_profiles?.[userId] || info?.unchanged_profiles?.[userId] || null;
                return ok({
                    mode: "userId",
                    userId,
                    displayName: changed?.displayName || changed?.zaloName || cachedDisplayName(userId) || null,
                    zaloName: changed?.zaloName || null,
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
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .optional()
                    .describe("Destination thread type: 0=DM(User), 1=Group. Inferred from cache when omitted."),
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
                    row = getMessageById(msgId);
                } catch (e) {
                    return err(`Local cache unavailable (${e.message}).`);
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
                    return api.sendMessage(
                        { msg: "", attachments: [resolve(row.localPath)] },
                        threadId,
                        Number(threadType),
                    );
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
                    video: async () => {
                        let p = {};
                        try {
                            p = typeof c?.params === "string" ? JSON.parse(c.params) : (c?.params ?? {});
                        } catch {
                            /* default geometry */
                        }
                        return api.sendVideo(
                            {
                                videoUrl: c?.href,
                                thumbnailUrl: c?.thumb || "",
                                duration: Number(p.duration) || 0,
                                width: Number(p.video_width || p.video_original_width) || 1280,
                                height: Number(p.video_height || p.video_original_height) || 720,
                            },
                            threadId,
                            Number(threadType),
                        );
                    },
                    voice: async () => api.sendVoice({ voiceUrl: c?.href }, threadId, Number(threadType)),
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
                        threadType,
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
                    threadType,
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
                "Delete a message from your own view only (`everyone: false`, the default), or, as a group admin, delete someone else's message for everyone in the group (`everyone: true`). To recall your own message for both sides, use zalo_undo. `cliMsgId` and `uidFrom` are read from the local cache when you leave them out.",
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
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .optional()
                    .describe("Thread type: 0=DM(User), 1=Group. Inferred from cache when omitted."),
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
            }),
        },
        async ({
            msgId,
            threadId: threadIdIn,
            threadType: threadTypeIn,
            cliMsgId: cliMsgIdIn,
            senderId: senderIdIn,
            everyone,
        }) => {
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
                const result = await api.deleteMessage(dest, onlyMe);
                return ok({
                    success: true,
                    msgId,
                    cliMsgId: String(cliMsgId),
                    threadId,
                    threadType,
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
                "'remove' (requires reminderId, threadId).",
            inputSchema: z.object({
                action: z
                    .enum(["create", "list", "info", "responses", "edit", "remove"])
                    .describe("Reminder operation to perform"),
                threadId: z.string().min(1).optional().describe("Thread ID (required for create, list, edit, remove)"),
                threadType: z
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .optional()
                    .describe("Thread type: 0=DM(User), 1=Group. Inferred from cache when omitted."),
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
                page: z.number().int().min(1).default(1).describe("Page number for 'list' (default 1)"),
                count: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .default(20)
                    .describe("Max items per page for 'list' (default 20)"),
            }),
        },
        async ({
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
        }) => {
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
                        threadType,
                        reminderId: result?.reminderId ?? result?.id ?? null,
                        startTime,
                        repeat: REMINDER_REPEAT_LABELS[repeatMode],
                        result,
                    });
                }

                if (action === "list") {
                    let result = null;
                    try {
                        result = await api.getListReminder({ page, count }, threadId, Number(threadType));
                    } catch {
                        result = null;
                    }
                    const reminders = Array.isArray(result) ? result : [];
                    return ok({ action, threadId, threadType, count: reminders.length, reminders });
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
                    return ok({ action, success: true, reminderId, threadId, threadType, result });
                }

                if (action === "remove") {
                    if (!reminderId) return err("reminderId is required for action='remove'.");
                    const result = await api.removeReminder(reminderId, threadId, Number(threadType));
                    return ok({ action, success: true, reminderId, threadId, threadType, result });
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
                "'list' (requires groupId), 'pin_message' (requires msgId; threadId optional if cached), " +
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
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .optional()
                    .describe(
                        "Thread type for 'pin_message' / 'unpin_message': 0=DM(User), 1=Group. Inferred from cache when omitted.",
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
                page: z.number().int().min(1).default(1).describe("Page number for 'list' (default 1)"),
                count: z.number().int().min(1).max(100).default(20).describe("Items per page for 'list' (default 20)"),
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
                    const result = await api.getListBoard({ page, count }, groupId);
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
                        row = getMessageById(msgId);
                    } catch {
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
                        row = getMessageById(msgId);
                    } catch {
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
                "'add_options' (requires pollId, options), 'lock' (requires pollId), 'share' (requires pollId).",
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
            }),
        },
        async ({
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
        }) => {
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
                "`limit` (default 1, max 100) returns up to that many buffered messages in one call, in order, in `messages` (`message` is the first, `cursor` is the last, so `since: cursor` continues where the batch ended; `hasMore` says more are already waiting); `settleMs` waits that long after the first message for the rest of a burst. A message's `id` is its msgId. Mirrors GET /events/wait for remote HTTPS/OAuth2 MCP clients.",
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
                    .max(MAX_BATCH)
                    .default(1)
                    .describe(`Most messages to return in one call (default 1, max ${MAX_BATCH})`),
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
        async ({ threadId, since, timeoutSec = 55, limit = 1, settleMs = 0 }) => {
            try {
                if (typeof buffer?.waitForMessages !== "function") {
                    return err("Live message buffer does not support waitForMessages in this context.");
                }
                const cleanThreadId = typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
                const clampedSec = Math.max(1, Math.min(300, Number(timeoutSec) || 55));
                const batch = batchParams({ limit, settleMs });
                const { messages, hasMore } = await buffer.waitForMessages({
                    threadId: cleanThreadId,
                    since: typeof since === "number" && Number.isFinite(since) ? since : undefined,
                    timeoutMs: clampedSec * 1000,
                    ...batch,
                });
                return ok(
                    waitResult({
                        messages,
                        hasMore,
                        cursorWhenEmpty: Math.max(
                            typeof since === "number" && Number.isFinite(since) ? since : 0,
                            Number(buffer._globalCursor) || 0,
                            typeof buffer.readCursor === "function" ? buffer.readCursor() : 0,
                        ),
                        decorate: (msg) => {
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
                "'update' (raw update with full labelData array and version, matching 'label update').",
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
                labelData: z
                    .array(z.any())
                    .optional()
                    .describe("Full labelData array from action='list' (required for raw action='update')"),
                version: z
                    .number()
                    .int()
                    .optional()
                    .describe("Label version integer from action='list' (required for raw action='update')"),
            }),
        },
        async ({ action, labelId, labelText, threadId, threadIds, labelData, version }) => {
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

                    const targetSet = new Set(targets);
                    let updatedConvList = [];
                    const nextLabelData = list.map((lbl) => {
                        if (Number(lbl.id) !== Number(matched.id)) return lbl;
                        const existing = Array.isArray(lbl.conversations) ? lbl.conversations.map(String) : [];
                        const nextConvs =
                            action === "assign"
                                ? [...new Set([...existing, ...targets])]
                                : existing.filter((c) => !targetSet.has(String(c)));
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
                "Check, list and answer friend requests, and list friends. Actions: " +
                "'status' (the relationship with userId: is_friend, and is_requested / is_requesting, Zalo's two flags " +
                "for a request pending between you and them; to tell which direction a request goes, use the two lists), " +
                "'sent_requests' (requests you sent that are still pending), " +
                "'received_requests' (requests others sent you, newest first, with their message), " +
                "'send' (friend request to userId, with an optional message), " +
                "'accept' / 'reject' (the request from userId), " +
                "'undo' (cancel the request you sent to userId), " +
                "'list' (your friends, most recently active first, capped by limit). " +
                "userId is the numeric Zalo id (zalo_lookup_user finds one from a phone number). " +
                "Zalo restricts accounts that send many friend requests, so send sparingly.",
            inputSchema: z.object({
                action: z
                    .enum(["status", "sent_requests", "received_requests", "send", "accept", "reject", "undo", "list"])
                    .describe("Friend operation to perform"),
                userId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Numeric Zalo user id (required for status, send, accept, reject and undo)"),
                message: z
                    .string()
                    .optional()
                    .describe("Message sent with the friend request (only for 'send'; default: none)"),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(1000)
                    .optional()
                    .describe(
                        "Most friends to return for 'list' (default 200; the reply says how many there are in all)",
                    ),
            }),
        },
        async ({ action, userId, message, limit }) => {
            const needsUser = ["status", "send", "accept", "reject", "undo"].includes(action);
            const target = userId === undefined ? "" : String(userId).trim();
            if (needsUser) {
                if (!target) return err(`userId is required for action='${action}'.`);
                if (!/^\d{1,30}$/.test(target)) {
                    return err(
                        `userId must be a numeric Zalo id (got "${target}"). zalo_lookup_user finds one from a phone number.`,
                    );
                }
            }
            try {
                switch (action) {
                    case "status":
                        return ok({ action, ...friendStatusFrom(await api.getFriendRequestStatus(target), target) });
                    case "sent_requests": {
                        let res = null;
                        try {
                            res = await api.getSentFriendRequest();
                        } catch (e) {
                            // Zalo answers code 112 when there are none, which is an empty list, not a failure.
                            if (!/\b112\b/.test(String(e?.message))) throw e;
                        }
                        const requests = sentRequestsFrom(res);
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
                        const { total, friends } = friendsFrom(await api.getAllFriends(), limit ?? 200);
                        return ok({ action, total, count: friends.length, truncated: friends.length < total, friends });
                    }
                    default:
                        return err(`Unsupported friend action: ${action}`);
                }
            } catch (e) {
                console.error("[mcp-tools] zalo_friend error:", e.message);
                // 'send' keeps the CLI's wording for Zalo's refusal codes (already friends, blocked, ...).
                const known =
                    action === "send" ? describeFriendAddError(e.code ?? extractErrorCode(e.message), target) : null;
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
                "'leave' (leave the group; `silent` hides the usual notice from ordinary members; the owner still sees it). " +
                "groupId is the group's thread id (zalo_search_threads or zalo_list_conversations finds it); " +
                "user ids are numeric Zalo ids (zalo_lookup_user finds one from a phone number). " +
                "'leave' and 'remove_member' cannot be undone from here, so they need confirm: true (a plain " +
                "parameter, no prompt; a deployment can turn the check off with groupConfirm: false in " +
                "mcp-config.json or ZALO_MCP_GROUP_CONFIRM=0). Zalo can refuse some members " +
                "of a create or add_members: the reply lists the members it did and did not take.",
            inputSchema: z.object({
                action: z
                    .enum(["leave", "info", "create", "add_members", "remove_member"])
                    .describe("Group operation to perform"),
                groupId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("The group's id (required for leave, info, add_members and remove_member)"),
                name: z.string().optional().describe("The new group's name (required for 'create')"),
                userIds: z
                    .array(z.string().min(1))
                    .min(1)
                    .max(100)
                    .optional()
                    .describe("Numeric Zalo user ids (required for 'create' and 'add_members')"),
                userId: z.string().min(1).optional().describe("Numeric Zalo user id (required for 'remove_member')"),
                silent: z
                    .boolean()
                    .optional()
                    .describe(
                        "Only for 'leave': hide the usual notice from ordinary members; the owner still sees it (default false)",
                    ),
                confirm: z
                    .boolean()
                    .optional()
                    .describe(
                        "Must be true for 'leave' and 'remove_member', which cannot be undone from here " +
                            "(ignored when the deployment has switched the check off)",
                    ),
            }),
        },
        async ({ action, groupId, name, userIds, userId, silent, confirm }) => {
            const gid = groupId === undefined ? "" : String(groupId).trim();
            if (["leave", "info", "add_members", "remove_member"].includes(action)) {
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
            if (action === "create" && !groupName) return err("name is required for action='create'.");

            // After validation, before Zalo: a refused call changes nothing and says exactly how to retry.
            if (CONFIRMED_ACTIONS.includes(action) && confirm !== true && groupConfirmRequired({ config })) {
                const what = action === "leave" ? `leave group ${gid}` : `remove ${target} from group ${gid}`;
                return err(
                    `Not done: this would ${what}, which cannot be undone from here. Repeat the call with ` +
                        "confirm: true to proceed. (An automatic or headless deployment can turn this check off " +
                        "with groupConfirm: false in mcp-config.json, or ZALO_MCP_GROUP_CONFIRM=0 in the environment.)",
                );
            }

            try {
                switch (action) {
                    case "info": {
                        const info = groupInfoFrom(await api.getGroupInfo([gid]), gid);
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
                    case "leave": {
                        const quiet = silent === true;
                        const res = await api.leaveGroup(gid, quiet);
                        const memberError = Array.isArray(res?.memberError) ? res.memberError : [];
                        return ok({
                            action,
                            success: true,
                            groupId: gid,
                            silent: quiet,
                            ...(memberError.length > 0 && { memberError }),
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
}
