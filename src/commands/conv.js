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
        .option("--friends-only", "Show only friend conversations")
        .option("--groups-only", "Show only group conversations")
        .option("--no-cache", "Bypass local cache and always fetch from Zalo")
        .action(async (opts) => {
            try {
                const api = getApi();
                const limit = Number(opts.limit);
                const ownId = getActive()?.ownId ?? null;
                const conversations = [];

                // --- Try local cache first (if db has been seeded) ---
                if (ownId && dbExists(ownId) && opts.cache !== false) {
                    const cached = getCachedChats(ownId, {
                        limit: limit * 2, // fetch more to allow combined sort
                        friendsOnly: opts.friendsOnly,
                        groupsOnly:  opts.groupsOnly,
                    });
                    if (cached.length > 0) {
                        for (const c of cached) {
                            conversations.push({
                                threadId:    c.thread_id,
                                name:        c.name || "?",
                                type:        c.thread_type === 1 ? "Group" : "User",
                                typeFlag:    c.thread_type,
                                lastActive:  c.last_active > 0 ? new Date(c.last_active).toLocaleString() : "",
                                source:      "cache",
                            });
                        }
                        output(conversations, program.opts().json, () => _printConversations(conversations, info, error, console));
                        return;
                    }
                }

                // --- Fallback: fetch live from Zalo API + upsert into cache ---
                if (!opts.groupsOnly) {
                    const friends = await api.getAllFriends();
                    const list = Array.isArray(friends) ? friends : [];
                    const sorted = list
                        .filter((f) => f.lastActionTime > 0)
                        .sort((a, b) => b.lastActionTime - a.lastActionTime)
                        .slice(0, limit);
                    for (const f of sorted) {
                        conversations.push({
                            threadId:   f.userId,
                            name:       f.displayName || f.zaloName || "?",
                            type:       "User",
                            typeFlag:   0,
                            lastActive: new Date(f.lastActionTime * 1000).toLocaleString(),
                        });
                        if (ownId) {
                            upsertContact(ownId, f);
                            upsertChat(ownId, { threadId: f.userId, threadType: 0, name: f.displayName || f.zaloName, lastActive: f.lastActionTime * 1000 });
                        }
                    }
                }

                if (!opts.friendsOnly) {
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
                                    conversations.push({
                                        threadId:    gid,
                                        name:        g.name || "?",
                                        type:        "Group",
                                        typeFlag:    1,
                                        memberCount: g.totalMember || 0,
                                    });
                                    if (ownId) {
                                        upsertGroup(ownId, { gid, name: g.name, memberCount: g.totalMember });
                                        upsertChat(ownId, { threadId: gid, threadType: 1, name: g.name, lastActive: 0 });
                                    }
                                }
                            } catch {
                                // Skip failed batch
                            }
                        }
                    }
                }

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
        .description("Delete conversation history")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, opts) => {
            try {
                const result = await getApi().deleteConversation(threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Conversation deleted"));
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
