/**
 * Conversation commands — pinned, archived, mute, unmute, read, unread, delete.
 */

import { join } from "path";
import { getApi } from "../core/zalo-client.js";
import { success, error, info, output, warning } from "../utils/output.js";
import { getActive } from "../core/accounts.js";
import { CONFIG_DIR } from "../core/credentials.js";
import { initDb, getRecentThreads, getMessages } from "../core/db.js";

/**
 * Find the newest message in a thread and return the anchor triple
 * `deleteChat` needs.
 *
 * Groups expose a REST history endpoint; DMs do not, so the caller has to
 * supply the ids by hand there. Both paths are best-effort: Zalo's history
 * APIs lag live traffic, so the "newest" message found may not be the true
 * newest (see agent/work/transfer-sync-v2/NOTES.md § Ordering).
 *
 * @param {object} api
 * @param {string} threadId
 * @param {number} type - 0=User, 1=Group
 * @returns {Promise<{ownerId: string, cliMsgId: string, globalMsgId: string}|null>}
 */
async function newestMessageAnchor(api, threadId, type) {
    // Source 1: the REST group-history endpoint. Kept because it is the
    // cheapest when it works, but note that Zalo currently answers
    // getGroupChatHistory with HTTP 404 — it appears retired, which is also
    // why `msg history` silently falls back to the WebSocket backfill.
    if (type === 1) {
        try {
            const history = await api.getGroupChatHistory(threadId, 1);
            const last = Array.isArray(history) ? history[0] : null;
            const anchor = toAnchor(last?.uidFrom ?? last?.ownerId, last?.cliMsgId, last?.msgId ?? last?.globalMsgId);
            if (anchor) return anchor;
        } catch {
            // 404 or transient — fall through to the local cache.
        }
    }

    // Source 2: the local SQLite cache. Anything `listen`, `sync` or a prior
    // `msg history` wrote is here, and rows carry the raw payload, which is
    // where cliMsgId lives.
    try {
        const activeAcc = getActive();
        if (!activeAcc) return null;
        initDb(join(CONFIG_DIR, "accounts", activeAcc.ownId, "zalo.db"));
        const [row] = getMessages(threadId, 1);
        if (!row) return null;

        let raw = {};
        try {
            raw = JSON.parse(row.raw_data || "{}");
        } catch {
            /* raw_data is optional */
        }
        const data = raw.data ?? raw;
        return toAnchor(row.senderId ?? data.uidFrom, data.cliMsgId, row.msgId ?? data.msgId);
    } catch {
        return null;
    }
}

/** Build the deleteChat anchor triple, or null when any part is missing. */
function toAnchor(ownerId, cliMsgId, globalMsgId) {
    if (!ownerId || !cliMsgId || !globalMsgId) return null;
    return { ownerId: String(ownerId), cliMsgId: String(cliMsgId), globalMsgId: String(globalMsgId) };
}

export function registerConvCommands(program) {
    const conv = program.command("conv").description("Manage conversations");

    conv.command("recent")
        .description("List recent conversations with thread_id (friends + groups)")
        .option("-n, --limit <n>", "Max results per type", "20")
        .option("--friends-only", "Show only friend conversations")
        .option("--groups-only", "Show only group conversations")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            const limit = Number(opts.limit);

            const activeAcc = getActive();
            if (!activeAcc) {
                error("No active account. Please login first.");
                process.exit(1);
            }

            try {
                const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);
                initDb(join(accountDir, "zalo.db"));
                // `-n` is documented as "max results per type", and the live
                // path below honors that (up to `limit` friends AND up to
                // `limit` groups). The cache path used to apply `limit`
                // globally and only then filter by type in JS, so
                // `--groups-only -n 5` returned the groups that happened to
                // fall within the 5 newest threads of any kind — usually
                // fewer than 5, often zero. Filter in SQL so the limit
                // applies to the set actually being asked for.
                let localThreads;
                if (opts.friendsOnly) {
                    localThreads = getRecentThreads(limit, "dm");
                } else if (opts.groupsOnly) {
                    localThreads = getRecentThreads(limit, "group");
                } else {
                    // Neither flag: `limit` of each, merged newest-first.
                    localThreads = [...getRecentThreads(limit, "dm"), ...getRecentThreads(limit, "group")].sort(
                        (a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0),
                    );
                }

                if (localThreads && localThreads.length > 0) {
                    if (!jsonMode) info(`Found ${localThreads.length} recent conversations in local cache.`);

                    const conversations = localThreads.map((t) => ({
                        threadId: t.threadId,
                        name: t.name,
                        type: t.type === "group" ? "Group" : "User",
                        typeFlag: t.type === "group" ? 1 : 0,
                        lastActive: t.lastUpdate ? new Date(t.lastUpdate).toLocaleString() : "?",
                    }));

                    output(conversations, jsonMode, () => {
                        info(`${conversations.length} conversation(s) (Local Cache):`);
                        console.log();
                        console.log("  THREAD_ID               TYPE    NAME");
                        console.log("  " + "-".repeat(60));
                        for (const c of conversations) {
                            const id = c.threadId.padEnd(22);
                            console.log(`  ${id}  ${c.type.padEnd(12)}  ${c.name}`);
                        }
                        console.log();
                        info("Use thread_id with messaging commands:");
                        info('  zalo-agent msg send <thread_id> "Hello"           (User)');
                        info('  zalo-agent msg send <thread_id> "Hello" -t 1      (Group)');
                    });
                    return;
                }
            } catch (err) {
                if (!jsonMode && err.message !== "Database not initialized") {
                    warning(`Local DB query failed: ${err.message}. Falling back to network.`);
                }
            }

            try {
                const api = getApi();
                const conversations = [];

                // Fetch friends (sorted by lastActionTime = most recent interaction)
                if (!opts.groupsOnly) {
                    const friends = await api.getAllFriends();
                    const list = Array.isArray(friends) ? friends : [];
                    const sorted = list
                        .filter((f) => f.lastActionTime > 0)
                        .sort((a, b) => b.lastActionTime - a.lastActionTime)
                        .slice(0, limit);
                    for (const f of sorted) {
                        conversations.push({
                            threadId: f.userId,
                            name: f.displayName || f.zaloName || "?",
                            type: "User",
                            typeFlag: 0,
                            // lastActionTime is epoch MILLISECONDS (13 digits). The old x1000
                            // rendered every row as year 58687.
                            lastActive: new Date(f.lastActionTime).toLocaleString(),
                        });
                    }
                }

                // Fetch groups
                if (!opts.friendsOnly) {
                    const groupsResult = await api.getAllGroups();
                    const groupIds = Object.keys(groupsResult?.gridVerMap || {});
                    if (groupIds.length > 0) {
                        const batchSize = 50;
                        const batches = [];
                        const limitedIds = groupIds.slice(0, limit); // cap to limit BEFORE batching
                        for (let i = 0; i < limitedIds.length; i += batchSize) {
                            batches.push(limitedIds.slice(i, i + batchSize));
                        }
                        for (const batch of batches) {
                            try {
                                const groupInfo = await api.getGroupInfo(batch);
                                const map = groupInfo?.gridInfoMap || {};
                                for (const [gid, g] of Object.entries(map)) {
                                    conversations.push({
                                        threadId: gid,
                                        name: g.name || "?",
                                        type: "Group",
                                        typeFlag: 1,
                                        memberCount: g.totalMember || 0,
                                    });
                                }
                            } catch {
                                // Skip failed batch
                            }
                        }
                    }
                }

                output(conversations, program.opts().json, () => {
                    if (conversations.length === 0) {
                        error("No conversations found.");
                        return;
                    }
                    info(`${conversations.length} conversation(s):`);
                    console.log();
                    console.log("  THREAD_ID               TYPE    NAME");
                    console.log("  " + "-".repeat(60));
                    for (const c of conversations) {
                        const typeLabel = c.type === "Group" ? `Group(${c.memberCount})` : "User";
                        const id = c.threadId.padEnd(22);
                        console.log(`  ${id}  ${typeLabel.padEnd(12)}  ${c.name}`);
                    }
                    console.log();
                    info("Use thread_id with messaging commands:");
                    info('  zalo-agent msg send <thread_id> "Hello"           (User)');
                    info('  zalo-agent msg send <thread_id> "Hello" -t 1      (Group)');
                });
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("pinned")
        .description("List pinned conversations")
        .action(async () => {
            try {
                const result = await getApi().getPinConversations();
                output(result, program.opts().json);
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("archived")
        .description("List archived conversations")
        .action(async () => {
            try {
                const result = await getApi().getArchivedChatList();
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
        .description("Delete conversation history, backwards from the newest message this account can see")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("--owner-id <id>", "Last message's sender id (skip auto-detection)")
        .option("--cli-msg-id <id>", "Last message's cliMsgId (skip auto-detection)")
        .option("--global-msg-id <id>", "Last message's global msgId (skip auto-detection)")
        .action(async (threadId, opts) => {
            try {
                const api = getApi();
                const type = Number(opts.type);

                // zca-js exposes deleteChat(lastMessage, threadId, type) — NOT
                // deleteConversation(), which this used to call and which does
                // not exist, so `conv delete` failed on every invocation with
                // "getApi(...).deleteConversation is not a function".
                //
                // deleteChat works BACKWARDS from an anchor message, so it
                // needs {ownerId, cliMsgId, globalMsgId} rather than just a
                // thread id. When not supplied, the newest message the history
                // API reports is used as the anchor.
                //
                // Caveat worth knowing: that history API lags live traffic (see
                // agent/work/transfer-sync-v2/NOTES.md § Ordering), so messages newer than the anchor
                // can survive. Pass the three ids explicitly for an exact
                // boundary.
                let { ownerId, cliMsgId, globalMsgId } = opts;

                if (!ownerId || !cliMsgId || !globalMsgId) {
                    const anchor = await newestMessageAnchor(api, threadId, type);
                    if (!anchor) {
                        error(
                            "Could not determine the last message to delete backwards from. " +
                                "Pass --owner-id, --cli-msg-id and --global-msg-id explicitly.",
                        );
                        return;
                    }
                    ownerId = ownerId || anchor.ownerId;
                    cliMsgId = cliMsgId || anchor.cliMsgId;
                    globalMsgId = globalMsgId || anchor.globalMsgId;
                }

                const result = await api.deleteChat({ ownerId, cliMsgId, globalMsgId }, threadId, type);
                output(result, program.opts().json, () =>
                    success(`Conversation ${threadId} deleted (backwards from message ${globalMsgId})`),
                );
            } catch (e) {
                error(e.message);
            }
        });
}
