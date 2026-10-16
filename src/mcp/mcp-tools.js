/**
 * MCP tool registrations for Zalo message access, sending, user lookup, and group productivity.
 * Registers 21 tools: zalo_get_messages, zalo_get_history, zalo_send_message, zalo_list_threads,
 * zalo_search_threads, zalo_mark_read, zalo_view_media, zalo_react, zalo_undo, zalo_get_group_members,
 * zalo_list_conversations, zalo_coverage, zalo_sync, zalo_sync_status, zalo_search_messages,
 * zalo_lookup_user, zalo_forward_message, zalo_delete_message, zalo_reminder, zalo_note, zalo_poll.
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
import { expandMentions, ALL_MENTION_UID } from "../utils/mentions.js";
import { resolveSelfThread } from "../utils/my-documents.js";
import { buildQuote, resolveQuoteSender } from "../utils/quote.js";
import { urgencyLevel } from "../utils/urgency.js";
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
                "Get messages from Zalo threads (DMs and groups). Returns buffered messages this consumer has " +
                "not marked read (see zalo_mark_read). Use 'since' cursor from previous response for incremental polling. " +
                "Each message's `readOnZalo` says whether the account itself has already read it on Zalo -- the " +
                "human, on the phone or Zalo Web -- and is null when the listener has not heard; zalo_mark_read " +
                "does not change it. Use senderDisplayName for the current label (your alias, then Zalo profile name, " +
                "then UID); senderDisplayNameSource reports alias/zalo/uid. senderName remains the historical snapshot.",
            inputSchema: z.object({
                threadId: z.string().optional().describe("Thread ID to read from. Omit for all watched threads."),
                since: z
                    .number()
                    .int()
                    .min(0)
                    .default(0)
                    .describe("Cursor from previous read for incremental polling; 0 means from your read cursor"),
                limit: z.number().int().min(1).max(100).default(maxPerPoll).describe("Max messages to return"),
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
                "Send a text message, link preview card (`link`), or contact card (`cardUserId`) to a Zalo thread " +
                "(DM or group). threadType: 0=DM(User), 1=Group. " +
                "To @-mention someone in a group, put `@[uid]` in the text where the tag belongs — " +
                "`@[123456]` becomes `@Their Name` and notifies them, and `@[-1]` is @All. " +
                "Use the `senderId` from zalo_get_messages or zalo_get_history as the uid; the display name " +
                "is read from the local cache, and a uid it cannot name is tagged as the bare uid " +
                "(reported back as `unresolvedMentions`). Mentions only deliver in groups (threadType 1). " +
                "To reply to a specific message, pass its msgId as `quoteMsgId` — Zalo supports quote-replies " +
                "to text messages only, and the quoted message must already be in the local cache. " +
                '`urgency` marks the message Important or Urgent, as the apps do. `threadId: "me"` sends to ' +
                "My Documents (your own cloud chat); the reply carries its real thread id.",
            inputSchema: z
                .object({
                    threadId: z
                        .string()
                        .describe("Thread ID to send message to. `me` (or your own uid) is My Documents, a 1-1 thread"),
                    text: z
                        .string()
                        .min(1)
                        .optional()
                        .describe(
                            "Message text to send (required unless `link` or `cardUserId` is set; optional caption when `link` is set). " +
                                "`@[uid]` tokens expand to @-mentions; `@[-1]` is @All.",
                        ),
                    link: z
                        .string()
                        .url()
                        .optional()
                        .describe("Optional URL to send as a rich link preview card (uses `text` as optional caption)"),
                    cardUserId: z
                        .string()
                        .min(1)
                        .optional()
                        .describe("Optional Zalo user ID to share as a contact card in this thread"),
                    threadType: z
                        .number()
                        .int()
                        .min(0)
                        .max(1)
                        .optional()
                        .describe(
                            "Thread type: 0=DM(User), 1=Group. Omit it and the cached thread type is " +
                                "used, which is what the CLI does — pass a value only to override that.",
                        ),
                    quoteMsgId: z
                        .string()
                        .optional()
                        .describe(
                            "msgId of a cached TEXT message in this thread to quote-reply to. " +
                                "Get it from zalo_get_messages or zalo_get_history.",
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
                    (val) => Boolean(val.text || val.link || val.cardUserId),
                    "Provide at least one of text, link, or cardUserId",
                )
                .refine(
                    (val) => !(val.link && val.cardUserId),
                    "Cannot send both link and cardUserId in a single call",
                ),
        },
        async ({
            threadId: threadIdIn,
            text,
            link,
            cardUserId,
            threadType: threadTypeIn,
            quoteMsgId,
            urgency: urgencyIn,
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
                        ...(cliMsgId !== null && { cliMsgId: String(cliMsgId) }),
                        threadType,
                        ...(thread.notice && { threadId, notice: thread.notice }),
                    });
                }

                if (!text) {
                    return err("Provide text, link, or cardUserId.");
                }

                const warnings = [];

                // `@[uid]` -> `@Display Name`, with the mention offsets measured
                // on the string that comes out. The CLI runs this last, after
                // markdown, because a display name may itself contain `*` or `_`;
                // there is no markdown or style pass here, so there is nothing to
                // order against and nothing to move — if styles are ever added to
                // this tool, they must be run through `shiftStyles(styles,
                // expanded.edits)` the way `msg send` does.
                const unresolved = [];
                const expanded = expandMentions(text, (uid) => {
                    const name = cachedDisplayName(uid);
                    if (!name && uid !== ALL_MENTION_UID) unresolved.push(uid);
                    return name;
                });
                const mentions = expanded.mentions;

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

                // 1 (important) or 2 (urgent), mapped exactly as `msg send
                // --urgency` maps it; zca-js turns it into the `metaData:
                // {urgency}` Zalo Web sends. "normal" is no urgency at all.
                const urgency = urgencyIn ? urgencyLevel(urgencyIn) : null;

                // A plain send stays a plain string: the object form is only
                // built when there is something to put in it.
                const hasExtras = mentions.length > 0 || Boolean(quote) || Boolean(urgency);
                const content = hasExtras
                    ? {
                          msg: expanded.text,
                          ...(mentions.length > 0 && { mentions }),
                          ...(quote && { quote }),
                          ...(urgency && { urgency }),
                      }
                    : expanded.text;

                for (const w of warnings) console.error("[mcp-tools] zalo_send_message warning:", w);

                const result = await api.sendMessage(content, threadId, Number(threadType));
                const messageId = result?.message?.msgId ?? result?.msgId ?? null;
                // `msg react`, `msg undo` and a later quote all key off cliMsgId,
                // and it appears in no other output. Without it an agent cannot
                // act on the message it just sent -- not even by shelling out.
                const cliMsgId = result?.message?.cliMsgId ?? result?.cliMsgId ?? null;
                return ok({
                    success: true,
                    messageId,
                    ...(cliMsgId !== null && { cliMsgId: String(cliMsgId) }),
                    threadType,
                    // Only for `me`: the thread it really went to, which is
                    // what a later zalo_get_history names.
                    ...(thread.notice && { threadId, notice: thread.notice }),
                    // Only when it differs, so the common send keeps its shape:
                    // the agent wrote `@[123]` and needs to know what was sent.
                    ...(expanded.text !== text && { text: expanded.text }),
                    ...(unresolved.length > 0 && { unresolvedMentions: unresolved }),
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
                "List all Zalo threads currently buffered with unread message counts. Useful for discovering active " +
                "conversations. `unread` is this consumer's own count; `readState` is how far the account itself " +
                "has read the conversation on Zalo (the human, on any device), null when the listener has not heard.",
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
                "Search threads (groups/DMs) by name. Uses fuzzy Vietnamese-aware matching. Useful for finding a thread ID by name.",
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
                "Mark buffered messages up to and including the given cursor as read for this consumer. Use the " +
                "cursor returned by zalo_get_messages. Other consumers keep their own cursor, and nothing is " +
                "deleted: messages leave the buffer only by age or size.",
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
                "Fetch historical messages from a Zalo DM or group conversation. " +
                "senderName preserves the historical snapshot; senderDisplayName resolves the current label by UID " +
                "(your alias, then Zalo profile name, then UID), with senderDisplayNameSource alias/zalo/uid. " +
                "Reads the local cache first (everything the listener and `zalo-agent sync` " +
                "have stored, which can be the full history), and falls back to asking the Zalo server " +
                "when the cache has nothing for the thread: a group's cloud-message store first, then the " +
                "socket stream, caching what comes back. Zalo serves only messages since this login that " +
                "way; `filtered: true` means it withheld older ones, which only `zalo-agent sync` restores. " +
                "Page the cache with 'before' (epoch ms, from the previous response's cursor) and the server " +
                "path with 'lastMsgId'. " +
                "WARNING: Large limits may consume significant memory/bandwidth. Start with a small limit and paginate.",
            inputSchema: z.object({
                threadId: z.string().describe("Thread ID to fetch history from"),
                threadType: z
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .optional()
                    .describe(
                        "Thread type: 0=DM(User), 1=Group. Omit it and the cached thread type is " +
                            "used, which is what the CLI does — pass a value only to override that.",
                    ),
                limit: z.number().int().min(1).max(200).default(50).describe("Max messages to fetch"),
                lastMsgId: z
                    .string()
                    .optional()
                    .nullable()
                    .describe("Cursor: last message ID from previous fetch, for the server-side path"),
                before: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Cursor: return cached messages older than this epoch-ms timestamp"),
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
                "Open a Zalo media file (image, audio, video) with the system viewer. " +
                "Media is auto-downloaded when received, organized by thread folder with date/sender metadata filenames. " +
                "If not yet downloaded, downloads first then opens.",
            inputSchema: z.object({
                messageId: z.string().describe("Message ID from zalo_get_messages that has a media attachment"),
                threadId: z.string().optional().describe("Thread ID to search in. Omit to search all threads."),
                open: z
                    .boolean()
                    .default(mediaConfig.autoOpen ?? true)
                    .describe("Open media with system viewer"),
            }),
        },
        async ({ messageId, threadId, open }) => {
            try {
                // The cached row is authoritative: it records where a fetched
                // file actually landed, so a message that arrived before this
                // process started is still openable. The buffer is only a
                // fallback for a thread id.
                let row = null;
                try {
                    row = getMessageById(messageId);
                } catch (e) {
                    console.error("[mcp-tools] cache unavailable:", e.message);
                }
                const buffered = buffer.read(threadId, 0, 9999).messages.find((m) => m.id === messageId) || null;
                if (!row && !buffered) return err(`Message ${messageId} not found in cache or buffer`);
                if (row && !row.has_attachment && !buffered?.attachment?.url) {
                    return err(`Message ${messageId} has no media attachment`);
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
                    localPath = getMessageById(messageId)?.localPath || null;
                    if (!localPath) {
                        return err(
                            `Could not fetch media for ${messageId} (${stats.expired} expired, ` +
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
            "Thread type: 0=DM(User), 1=Group. Omit it and the cached thread type is " +
                "used, which is what the CLI does — pass a value only to override that.",
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
                "Add a reaction to a message, as `msg react` does. `reaction` is a Zalo reaction code: " +
                "`/-strong` (like), `/-heart` (heart), `:>` (haha), `:o` (wow), `:-((` (cry), `:-h` (angry), " +
                "`:-*` (kiss), `:')` (tears of joy), `/-weak` (dislike). Zalo keys a reaction on the message's " +
                "cliMsgId as well as its msgId, so the cliMsgId comes from `cliMsgId` or the local cache; when " +
                "neither has it the reaction is refused and nothing is sent — Zalo accepts a reaction keyed on the " +
                "msgId alone and never shows it. `threadId` may be `me` for My Documents.",
            inputSchema: z.object({
                msgId: z
                    .string()
                    .min(1)
                    .describe("msgId of the message to react to (from zalo_get_messages or zalo_get_history)"),
                threadId: z.string().min(1).describe("The conversation the message is in. `me` is My Documents"),
                reaction: z.string().min(1).describe("Reaction code, e.g. `/-strong`, `/-heart`, `:>`"),
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
                "Recall one of your own messages for everyone in the conversation, as `msg undo` does (the apps' " +
                "Thu hồi). Zalo names the message by msgId and cliMsgId, so the cliMsgId comes from `cliMsgId` or " +
                "the local cache; when neither has it nothing is sent. Zalo accepts a recall only for a while after " +
                "the message was sent. `threadId` may be `me` for My Documents.",
            inputSchema: z.object({
                msgId: z.string().min(1).describe("msgId of your message to recall"),
                threadId: z.string().min(1).describe("The conversation the message is in. `me` is My Documents"),
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
                "List a group's members, as `group members` does: each member's uid, with a display name — from " +
                "the local cache, or from Zalo for members the cache cannot name. `totalMember` is Zalo's own " +
                "count. A member's uid can be @-mentioned in zalo_send_message as `@[uid]`.",
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

                const members = group.uids.map((uid) => ({ uid, displayName: names.get(uid) ?? null }));
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
                "List the conversations this account was most recently active in, newest first, from the local " +
                "cache — what `conv recent` lists: thread id, type, name and last activity. Unlike " +
                "zalo_list_threads it is not limited to what arrived since this server started. `limit` is per " +
                "type, as `conv recent -n` is: with type 'all' that is up to `limit` DMs and `limit` groups. " +
                "`readState` is how far the account itself has read each conversation on Zalo (the human, on any " +
                "device): the newest message read, how many cached messages from others came after it, and whether " +
                "it is marked unread; null when the listener has not heard.",
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
                "How complete the local message cache is. Lists the coverage gaps still pending — windows in which " +
                "this account's connection to Zalo was down, so messages from them may be missing — with each " +
                "gap's from/to and reason, counts the gaps already resolved, and names the `zalo-agent sync --from " +
                "<date>` run that restores the pending ones from the owner's phone (it needs a tap on the phone, " +
                "so the owner must approve it). Use zalo_sync only when the owner asks to restore. " +
                "Read-only: nothing is sent to Zalo.",
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
                "Start a messages restore or reaction-backlog sync on this MCP account's existing socket. " +
                "Only call when the owner explicitly requests sync; messages sends a confirmation to their phone. " +
                "Returns a job immediately: poll zalo_sync_status every few seconds. Reuse requestId for retries. " +
                "This updates the local cache, not Zalo messages. Messages restores all conversations in the window; " +
                "it is not a per-thread sync. No media download, boards, cloud index or conversation-state sync.",
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
                    stage: z.enum(["messages", "reactions"]).default("messages"),
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
                "Read sync progress and the final result without starting or repeating sync. Omit jobId for the latest " +
                "job (or idle). Completed means the runner returned: inspect result.reason for partial/timeout/socket loss, " +
                "not proof that all history was restored. Last ten jobs are kept in memory until daemon restart.",
            inputSchema: z.object({ jobId: z.string().uuid().optional() }).strict(),
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
                "Search message text across the local SQLite cache (`zalo.db`). Zero network calls. " +
                "Filter optionally by `threadId`, `senderId`, `since` (epoch ms), and `until` (epoch ms). " +
                "Results are ordered newest-first.",
            inputSchema: z.object({
                query: z.string().min(1).describe("Case-insensitive text substring to search for in cached messages"),
                threadId: z.string().min(1).optional().describe("Restrict search to a single thread ID"),
                senderId: z.string().min(1).optional().describe("Restrict search to a specific sender UID"),
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
                "Look up a Zalo user by phone number (`phone`), username (`username`), user ID (`userId`), or inspect " +
                "this logged-in account's own profile (`self: true`). Useful for finding a contact's `userId` (which is " +
                "also their 1-1 DM `threadId`) before sending a message or contact card.",
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
                    userId: z.string().min(1).optional().describe("Zalo user ID to fetch full profile info for"),
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
                "Forward a cached message (`msgId`) to another Zalo conversation (`threadId`). Text messages are sent " +
                "through Zalo's forward API with the 'forwarded' badge; cards, stickers, links, videos, voices, and " +
                "locally downloaded media attachments are re-sent as a message of their own kind, matching `msg forward`.",
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
                            `Message ${msgId} is "${row.type}" but its media is not downloaded locally. Call zalo_view_media with messageId="${msgId}" first.`,
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
                "Delete a message from your own view (`everyone: false`, the default) or for everyone in a group " +
                "(`everyone: true`, only valid for someone else's message in a group — to recall your own sent " +
                "message for both sides, use `zalo_undo`). Resolves `cliMsgId` and `uidFrom` from the local cache when omitted.",
            inputSchema: z.object({
                msgId: z.string().min(1).describe("Message ID (`msgId`) to delete"),
                threadId: z.string().min(1).describe("Thread ID the message belongs to"),
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
                uidFrom: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        "Sender UID (`uidFrom`). Looked up in the local cache or defaults to own UID when omitted.",
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
            uidFrom: uidFromIn,
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
                let uidFrom = uidFromIn;
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
                noteId: z.string().min(1).optional().describe("Note topicId to update (required for 'edit')"),
                title: z.string().min(1).optional().describe("Note text/title (required for 'create' and 'edit')"),
                pin: z
                    .boolean()
                    .default(false)
                    .describe("Whether to pin the note to the group board on 'create' or 'edit'"),
                msgId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Message ID (`msgId`) to pin or unpin (required for 'pin_message' and 'unpin_message')"),
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
                groupId: z.string().min(1).optional().describe("Group ID (required for 'create')"),
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
}
