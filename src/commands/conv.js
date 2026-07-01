/**
 * Conversation commands — pinned, archived, mute, unmute, read, unread, delete.
 */

import { getApi } from "../core/zalo-client.js";
import { success, error, info, output } from "../utils/output.js";
import { getActive } from "../core/accounts.js";
import { getCachedChats, upsertChat, upsertContact, upsertGroup, dbExists } from "../core/db.js";

export function registerConvCommands(program) {
    const conv = program.command("conv").description("Manage conversations");

    conv.command("recent")
        .description("List recent conversations with thread_id (friends + groups)")
        .option("-n, --limit <n>", "Max results per type", "20")
        .option("--friend-only, --friends-only", "Show only friend conversations")
        .option("--group-only, --groups-only", "Show only group conversations")
        .option("--no-cache", "Bypass local cache and always fetch from Zalo")
        .option("--reverse", "Show oldest activity first instead of newest first")
        .action(async (opts) => {
            try {
                const api = getApi();
                const limit = Number(opts.limit);
                const ownId = getActive()?.ownId ?? null;
                const conversations = [];

                // --- Try local cache first (if db has been seeded) ---
                if (ownId && dbExists(ownId) && opts.cache !== false) {
                    const groupsOnlyOpt = opts.groupsOnly || opts.groupOnly;
                    const friendsOnlyOpt = opts.friendsOnly || opts.friendOnly;
                    let cached = [];
                    if (friendsOnlyOpt) {
                        cached = getCachedChats(ownId, { limit, friendsOnly: true });
                    } else if (groupsOnlyOpt) {
                        cached = getCachedChats(ownId, { limit, groupsOnly: true });
                    } else {
                        const cachedUsers = getCachedChats(ownId, { limit, friendsOnly: true });
                        const cachedGroups = getCachedChats(ownId, { limit, groupsOnly: true });
                        cached = [...cachedUsers, ...cachedGroups];
                    }
                    if (cached.length > 0) {
                        for (const c of cached) {
                            conversations.push({
                                threadId:    c.thread_id,
                                name:        c.name || "?",
                                type:        c.thread_type === 1 ? "Group" : "User",
                                typeFlag:    c.thread_type,
                                lastActive:  c.last_active > 0 ? new Date(c.last_active).toLocaleString() : "",
                                source:      "cache",
                                _ts:         c.last_active,
                            });
                        }
                        // Sort: newest-first (default); --reverse = oldest-first
                        conversations.sort((a, b) => {
                            return opts.reverse 
                                ? (a._ts || 0) - (b._ts || 0)
                                : (b._ts || 0) - (a._ts || 0);
                        });
                        output(conversations, program.opts().json, () => _printConversations(conversations, info, error, console));
                        return;
                    }
                }

                // --- Fallback: fetch live from Zalo API + upsert into cache ---
                const groupsOnlyOptFallback = opts.groupsOnly || opts.groupOnly;
                const friendsOnlyOptFallback = opts.friendsOnly || opts.friendOnly;
                
                if (!groupsOnlyOptFallback) {
                    const friends = await api.getAllFriends();
                    const list = Array.isArray(friends) ? friends : [];
                    const sorted = list
                        .filter((f) => f.lastActionTime > 0)
                        .sort((a, b) => b.lastActionTime - a.lastActionTime)
                        .slice(0, limit);
                    for (const f of sorted) {
                        const lastActiveMs = f.lastActionTime * 1000;
                        conversations.push({
                            threadId:   f.userId,
                            name:       f.displayName || f.zaloName || "?",
                            type:       "User",
                            typeFlag:   0,
                            lastActive: new Date(lastActiveMs).toLocaleString(),
                            _ts:        lastActiveMs,
                        });
                        if (ownId) {
                            upsertContact(ownId, f);
                            upsertChat(ownId, { threadId: f.userId, threadType: 0, name: f.displayName || f.zaloName, lastActive: lastActiveMs });
                        }
                    }
                }

                if (!friendsOnlyOptFallback) {
                    const groupsResult = await api.getAllGroups();
                    const groupIds = Object.keys(groupsResult?.gridVerMap || {});
                    if (groupIds.length > 0) {
                        const batchSize = 50;
                        const batches = [];
                        for (let i = 0; i < Math.min(groupIds.length, limit); i += batchSize) {
                            batches.push(groupIds.slice(i, i + batchSize));
                        }
                        for (const batch of batches) {
                            try {
                                const groupInfo = await api.getGroupInfo(batch);
                                const map = groupInfo?.gridInfoMap || {};
                                for (const [gid, g] of Object.entries(map)) {
                                    // Groups from getAllGroups() have no lastActionTime — use lastMsgId timestamp
                                    // if available, otherwise use now so they appear above stale cached entries
                                    const groupTs = g.lastMsgTimestamp || g.updateTime || Date.now();
                                    conversations.push({
                                        threadId:    gid,
                                        name:        g.name || "?",
                                        type:        "Group",
                                        typeFlag:    1,
                                        memberCount: g.totalMember || 0,
                                        _ts:         groupTs,
                                    });
                                    if (ownId) {
                                        upsertGroup(ownId, { gid, name: g.name, memberCount: g.totalMember });
                                        upsertChat(ownId, { threadId: gid, threadType: 1, name: g.name, lastActive: groupTs });
                                    }
                                }
                            } catch {
                                // Skip failed batch
                            }
                        }
                    }
                }

                // Sort combined list: newest-first (default) or oldest-first (--reverse)
                conversations.sort((a, b) =>
                    opts.reverse
                        ? (a._ts || 0) - (b._ts || 0)
                        : (b._ts || 0) - (a._ts || 0)
                );
                // Trim to limit after combined sort
                conversations.splice(limit);

                output(conversations, program.opts().json, () => _printConversations(conversations, info, error, console));
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("pinned")
        .description("List pinned conversations")
        .action(async () => {
            try {
                const result = await getApi().getPinnedConversations();
                output(result, program.opts().json);
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("archived")
        .description("List archived conversations")
        .action(async () => {
            try {
                const result = await getApi().getArchivedConversations();
                output(result, program.opts().json);
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("mute <threadId>")
        .description("Mute a conversation")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-d, --duration <secs>", "Duration in seconds (-1 = forever)", "-1")
        .action(async (threadId, opts) => {
            try {
                const result = await getApi().setMute(threadId, Number(opts.type), Number(opts.duration));
                output(result, program.opts().json, () => success("Conversation muted"));
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("unmute <threadId>")
        .description("Unmute a conversation")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, opts) => {
            try {
                const result = await getApi().setMute(threadId, Number(opts.type), 0);
                output(result, program.opts().json, () => success("Conversation unmuted"));
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("read <threadId>")
        .description("Mark conversation as read")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, opts) => {
            try {
                const result = await getApi().sendSeenEvent(threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Marked as read"));
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("unread <threadId>")
        .description("Mark conversation as unread")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, opts) => {
            try {
                const result = await getApi().markAsUnread(threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Marked as unread"));
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("hidden")
        .description("List hidden conversations")
        .action(async () => {
            try {
                const result = await getApi().getHiddenConversations();
                output(result, program.opts().json);
            } catch (e) {
                error(`Get hidden conversations failed: ${e.message}`);
            }
        });

    conv.command("hide <threadIds...>")
        .description("Hide conversation(s)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadIds, opts) => {
            try {
                const result = await getApi().setHiddenConversations(true, threadIds, Number(opts.type));
                output(result, program.opts().json, () => success(`Hidden ${threadIds.length} conversation(s)`));
            } catch (e) {
                error(`Hide failed: ${e.message}`);
            }
        });

    conv.command("unhide <threadIds...>")
        .description("Unhide conversation(s)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadIds, opts) => {
            try {
                const result = await getApi().setHiddenConversations(false, threadIds, Number(opts.type));
                output(result, program.opts().json, () => success(`Unhidden ${threadIds.length} conversation(s)`));
            } catch (e) {
                error(`Unhide failed: ${e.message}`);
            }
        });

    conv.command("hidden-pin <pin>")
        .description("Set or update PIN for hidden conversations (4 digits)")
        .action(async (pin) => {
            try {
                const result = await getApi().updateHiddenConversPin(pin);
                output(result, program.opts().json, () => success("Hidden conversation PIN updated"));
            } catch (e) {
                error(`Update PIN failed: ${e.message}`);
            }
        });

    conv.command("hidden-pin-reset")
        .description("Reset hidden conversations PIN")
        .action(async () => {
            try {
                const result = await getApi().resetHiddenConversPin();
                output(result, program.opts().json, () => success("Hidden conversation PIN reset"));
            } catch (e) {
                error(`Reset PIN failed: ${e.message}`);
            }
        });

    conv.command("auto-delete-status")
        .description("View auto-delete chat settings")
        .action(async () => {
            try {
                const result = await getApi().getAutoDeleteChat();
                output(result, program.opts().json);
            } catch (e) {
                error(`Get auto-delete status failed: ${e.message}`);
            }
        });

    conv.command("auto-delete <threadId> <ttl>")
        .description("Set auto-delete for a conversation (off, 1d, 7d, 14d)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, ttl, opts) => {
            try {
                const ttlMap = { off: 0, "1d": 86400000, "7d": 604800000, "14d": 1209600000 };
                const ttlValue = ttlMap[ttl];
                if (ttlValue === undefined) {
                    error(`Invalid TTL "${ttl}". Valid: off, 1d, 7d, 14d`);
                    return;
                }
                const result = await getApi().updateAutoDeleteChat(ttlValue, threadId, Number(opts.type));
                output(result, program.opts().json, () => success(`Auto-delete set to ${ttl} for ${threadId}`));
            } catch (e) {
                error(`Set auto-delete failed: ${e.message}`);
            }
        });

    conv.command("delete <threadId>")
        .description("Clear conversation history for yourself (Xóa lịch sử). Removes recalled placeholders and all messages up to the anchor from your view.")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("--last-msg-id <id>", "Global message ID to delete up to (anchor). Fetched automatically if omitted.")
        .option("--last-cli-msg-id <id>", "Client message ID of anchor message.")
        .option("--last-owner-id <id>", "Sender user ID of anchor message. Defaults to own account.")
        .action(async (threadId, opts) => {
            try {
                const api = getApi();
                const threadType = Number(opts.type);
                let globalMsgId  = opts.lastMsgId;
                let cliMsgId     = opts.lastCliMsgId;
                let ownerId      = opts.lastOwnerId;

                // Auto-fetch the newest message to use as anchor if not provided
                if (!globalMsgId || !cliMsgId) {
                    info("Fetching latest message as anchor...");
                    const { requestOldMessages } = api.listener;
                    // Use the msg history WS flow: start listener, get 1 page, take first message
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(new Error("Listener timeout")), 10000);
                        api.listener.on("connected", () => { clearTimeout(timer); resolve(); });
                        api.listener.on("error", (e) => { clearTimeout(timer); reject(e); });
                        api.listener.start({ retryOnClose: false });
                    });
                    const msgs = await new Promise((resolve) => {
                        const t = setTimeout(() => resolve([]), 8000);
                        api.listener.once("old_messages", (m) => { clearTimeout(t); resolve(m); });
                        api.listener.requestOldMessages(threadType, "0");
                    });
                    api.listener.stop?.();
                    // Find newest message in thread
                    const match = msgs.find(m => String(m.threadId) === String(threadId));
                    if (!match) {
                        error("Could not auto-fetch last message. Use --last-msg-id, --last-cli-msg-id, --last-owner-id.");
                        return;
                    }
                    globalMsgId = match.data?.msgId   ?? globalMsgId;
                    cliMsgId    = match.data?.cliMsgId ?? cliMsgId;
                    ownerId     = ownerId ?? match.data?.uidFrom;
                    info(`Anchor: msgId=${globalMsgId} cliMsgId=${cliMsgId} ownerId=${ownerId}`);
                }

                const lastMessage = { ownerId: String(ownerId || ""), cliMsgId: String(cliMsgId), globalMsgId: String(globalMsgId) };
                const result = await api.deleteChat(lastMessage, threadId, threadType);
                output(result, program.opts().json, () => success("Conversation history cleared for yourself"));
            } catch (e) {
                error(e.message);
            }
        });
}

// ---------------------------------------------------------------------------
// Shared display helper
// ---------------------------------------------------------------------------

function _printConversations(conversations, info, error, console) {
    if (conversations.length === 0) {
        error("No conversations found.");
        return;
    }
    const fromCache = conversations.some((c) => c.source === "cache");
    info(`${conversations.length} conversation(s):${fromCache ? " (from local cache)" : ""}`);
    console.log();
    console.log("  THREAD_ID               TYPE    NAME");
    console.log("  " + "-".repeat(60));
    for (const c of conversations) {
        const typeLabel = c.type === "Group" ? `Group(${c.memberCount ?? ""})` : "User";
        const id = c.threadId.padEnd(22);
        console.log(`  ${id}  ${typeLabel.padEnd(12)}  ${c.name}`);
    }
    console.log();
    info("Use thread_id with messaging commands:");
    info('  zalo-agent msg send <thread_id> "Hello"           (User)');
    info('  zalo-agent msg send <thread_id> "Hello" -t 1      (Group)');
    if (fromCache) info("Tip: run with --no-cache to force a live fetch from Zalo.");
}
