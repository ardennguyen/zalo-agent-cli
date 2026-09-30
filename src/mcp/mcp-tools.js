/**
 * MCP tool registrations for Zalo message access and sending.
 * Registers 7 tools: zalo_get_messages, zalo_get_history, zalo_send_message, zalo_list_threads, zalo_search_threads, zalo_mark_read, zalo_view_media.
 */

import { z } from "zod";
import { openFile } from "../utils/open-file.js";
import { getMessages, getMessageById, getDisplayName, getThreadType } from "../core/db.js";
import { downloadSyncedMedia } from "../core/sync-v2/media.js";
import { fetchAndCacheHistory } from "../core/history-fetch.js";
import { extractMessageText } from "../utils/extract-message-text.js";
import { expandMentions, ALL_MENTION_UID } from "../utils/mentions.js";
import { buildQuote, resolveQuoteSender } from "../utils/quote.js";

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
 * Display name for a `@[uid]` mention token, read from the local cache only.
 *
 * **This deliberately does not do what the CLI does.** `msg send` falls back
 * to a batched `getGroupMembersInfo` call for uids the cache cannot name
 * (`fetchMentionNames` in `src/commands/msg.js`); the MCP tool does not, and
 * stays purely local:
 *
 * - The CLI's fallback exists for a human typing a uid for someone who has
 *   never posted in the group. An MCP client has no such uid to type — the
 *   only place it learns one is `zalo_get_messages` / `zalo_get_history`,
 *   whose rows carry `senderName` alongside `senderId`, so the cache can
 *   already name anyone the agent could plausibly tag.
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
function mentionName(uid) {
    try {
        return getDisplayName(uid);
    } catch {
        return null; // no db in this process
    }
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
 */
export function registerTools(server, api, buffer, filter, config, nameCache, accountDir, stageLock) {
    const maxPerPoll = config.limits?.maxMessagesPerPoll ?? 20;

    // --- zalo_get_messages ---
    server.registerTool(
        "zalo_get_messages",
        {
            title: "Get Zalo Messages",
            description:
                "Get messages from Zalo threads (DMs and groups). Returns buffered messages since last read. Use 'since' cursor from previous response for incremental polling.",
            inputSchema: z.object({
                threadId: z.string().optional().describe("Thread ID to read from. Omit for all watched threads."),
                since: z.number().int().min(0).default(0).describe("Cursor from previous read for incremental polling"),
                limit: z.number().int().min(1).max(100).default(maxPerPoll).describe("Max messages to return"),
            }),
        },
        async ({ threadId, since, limit }) => {
            try {
                const result = buffer.read(threadId, since, limit);
                // Enrich messages with thread name from cache
                if (nameCache) {
                    for (const msg of result.messages) {
                        const info = nameCache.get(msg.threadId);
                        if (info) msg.threadName = info.name;
                    }
                }
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
                "Send a text message to a Zalo thread (DM or group). threadType: 0=DM(User), 1=Group. " +
                "To @-mention someone in a group, put `@[uid]` in the text where the tag belongs — " +
                "`@[123456]` becomes `@Their Name` and notifies them, and `@[-1]` is @All. " +
                "Use the `senderId` from zalo_get_messages or zalo_get_history as the uid; the display name " +
                "is read from the local cache, and a uid it cannot name is tagged as the bare uid " +
                "(reported back as `unresolvedMentions`). Mentions only deliver in groups (threadType 1). " +
                "To reply to a specific message, pass its msgId as `quoteMsgId` — Zalo supports quote-replies " +
                "to text messages only, and the quoted message must already be in the local cache.",
            inputSchema: z.object({
                threadId: z.string().describe("Thread ID to send message to"),
                text: z
                    .string()
                    .min(1)
                    .describe("Message text to send. `@[uid]` tokens expand to @-mentions; `@[-1]` is @All."),
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
            }),
        },
        async ({ threadId, text, threadType: threadTypeIn, quoteMsgId }) => {
            const threadType = resolveThreadType(threadId, threadTypeIn);
            try {
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
                    const name = mentionName(uid);
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

                // A plain send stays a plain string: the object form is only
                // built when there is something to put in it.
                const hasExtras = mentions.length > 0 || Boolean(quote);
                const content = hasExtras
                    ? {
                          msg: expanded.text,
                          ...(mentions.length > 0 && { mentions }),
                          ...(quote && { quote }),
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
                "List all Zalo threads currently buffered with unread message counts. Useful for discovering active conversations.",
            inputSchema: z.object({
                type: z
                    .enum(["group", "dm", "all"])
                    .default("all")
                    .describe("Filter by thread type: 'dm', 'group', or 'all'"),
            }),
        },
        async ({ type }) => {
            try {
                const stats = buffer.getStats(0);
                // Enrich each stat entry with threadType and thread name
                const enriched = stats.map((t) => {
                    const threadType = buffer.getThreadType(t.threadId) ?? "unknown";
                    const cached = nameCache?.get(t.threadId);
                    return {
                        ...t,
                        threadType,
                        name: cached?.name ?? null,
                        ...(cached?.memberCount !== undefined && { memberCount: cached.memberCount }),
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
                "Discard buffered messages up to and including the given cursor. Use the cursor returned by zalo_get_messages.",
            inputSchema: z.object({
                cursor: z
                    .number()
                    .int()
                    .min(0)
                    .describe("Cursor value returned from a previous zalo_get_messages call"),
            }),
        },
        async ({ cursor }) => {
            try {
                const discarded = buffer.markRead(cursor);
                return ok({ success: true, discarded });
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
                if (cached) return ok(cached);

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
                    messages: allMessages,
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
                        mediaRoot: mediaConfig.downloadDir || undefined,
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
}
