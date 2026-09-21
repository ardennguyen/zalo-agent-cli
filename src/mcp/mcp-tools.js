/**
 * MCP tool registrations for Zalo message access and sending.
 * Registers 7 tools: zalo_get_messages, zalo_get_history, zalo_send_message, zalo_list_threads, zalo_search_threads, zalo_mark_read, zalo_view_media.
 */

import { z } from "zod";
import { openFile } from "../utils/open-file.js";
import { getMessages, getMessageById } from "../core/db.js";
import { downloadSyncedMedia } from "../core/sync-v2/media.js";
import { extractMessageText } from "../utils/extract-message-text.js";

/** Thread type constants matching zca-js ThreadType enum */
const THREAD_USER = 0;

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
 */
export function registerTools(server, api, buffer, filter, config, nameCache, accountDir) {
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
            description: "Send a text message to a Zalo thread (DM or group). threadType: 0=DM(User), 1=Group.",
            inputSchema: z.object({
                threadId: z.string().describe("Thread ID to send message to"),
                text: z.string().min(1).describe("Message text to send"),
                threadType: z
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .default(THREAD_USER)
                    .describe("Thread type: 0=DM(User), 1=Group"),
            }),
        },
        async ({ threadId, text, threadType }) => {
            try {
                const result = await api.sendMessage(text, threadId, Number(threadType));
                const messageId = result?.message?.msgId ?? result?.msgId ?? null;
                return ok({ success: true, messageId });
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
                "Reads the local cache first (everything the listener and `zalo-agent sync-mobile --transfer` " +
                "have stored, which can be the full history), and falls back to asking the Zalo server " +
                "when the cache has nothing for the thread. Page the cache with 'before' (epoch ms, from the " +
                "previous response's cursor) and the server path with 'lastMsgId'. " +
                "WARNING: Large limits may consume significant memory/bandwidth. Start with a small limit and paginate.",
            inputSchema: z.object({
                threadId: z.string().describe("Thread ID to fetch history from"),
                threadType: z
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .default(THREAD_USER)
                    .describe("Thread type: 0=DM(User), 1=Group"),
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
        async ({ threadId, threadType, limit, lastMsgId, before }) => {
            try {
                // The cache is the better source and usually the only one that
                // answers: Zalo returns an empty set for the socket history
                // request on current accounts, while the cache holds whatever
                // the listener saw and whatever a transfer sync restored.
                const cached = cacheHistory(threadId, limit, before, nameCache);
                if (cached) return ok(cached);

                const allMessages = [];
                let cursor = lastMsgId || null;
                let done = false;
                const maxPages = Math.ceil(limit / 20);
                let page = 0;

                while (!done && allMessages.length < limit && page < maxPages) {
                    page++;
                    const pageMessages = await new Promise((resolve) => {
                        const handler = (messages) => {
                            clearTimeout(timer);
                            api.listener.removeListener("old_messages", handler);
                            resolve(messages);
                        };
                        const timer = setTimeout(() => {
                            api.listener.removeListener("old_messages", handler);
                            resolve([]);
                        }, 10000);

                        api.listener.on("old_messages", handler);
                        api.listener.requestOldMessages(threadType, cursor);
                    });

                    if (!pageMessages || pageMessages.length === 0) {
                        done = true;
                        break;
                    }

                    for (const msg of pageMessages) {
                        if (allMessages.length >= limit) break;
                        // API returns messages globally — filter to requested thread
                        const msgThread = String(msg.threadId || "");
                        const msgSender = String(msg.data?.uidFrom || "");
                        const target = String(threadId);
                        if (msgThread !== target && msgSender !== target) continue;
                        const rawContent = msg.data?.content;
                        const isText = typeof rawContent === "string";
                        allMessages.push({
                            msgId: msg.data?.msgId,
                            threadId: msg.threadId,
                            senderId: msg.data?.uidFrom || null,
                            senderName: msg.data?.dName || null,
                            text: isText ? rawContent : extractMessageText(rawContent, msg.data?.msgType),
                            timestamp: msg.data?.ts ? Number(msg.data.ts) : null,
                            type: isText ? "text" : msg.data?.msgType || "attachment",
                        });
                    }

                    const lastMsg = pageMessages[pageMessages.length - 1];
                    const nextId = lastMsg?.data?.actionId || lastMsg?.data?.msgId;
                    if (!nextId || nextId === cursor) done = true;
                    cursor = nextId;
                }

                // Sort oldest first
                allMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

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
                    count: allMessages.length,
                    messages: allMessages,
                    cursor: cursor,
                    hasMore: !done,
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
                            `Could not fetch media for ${messageId} ` +
                                `(${stats.expired} expired, ${stats.throttled} throttled, ${stats.failed} failed). ` +
                                `Zalo media links expire; try zalo-agent sync-media.`,
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
