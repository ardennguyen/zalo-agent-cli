/**
 * Conversation commands — pinned, pin, unpin, archived, archive, unarchive,
 * mute, unmute, read, unread, delete.
 */

import { join } from "path";
import { MuteAction } from "zca-js";
import { getApi } from "../core/zalo-client.js";
import { success, error, info, output, warning } from "../utils/output.js";
import { getActive } from "../core/accounts.js";
import { CONFIG_DIR } from "../core/credentials.js";
import { initDb, getMessages, markThreadGone, getOrphanThreads, forgetThread } from "../core/db.js";
import { recentConversations } from "../core/recent-conversations.js";
import { pruneDownloadedMedia } from "../core/sync-v2/media.js";
import { markConversationRead, zaloPost } from "../core/receipts.js";

/**
 * Find the newest message in a thread and return the anchor triple
 * `deleteChat` needs.
 *
 * Groups expose a REST history endpoint; DMs do not, so the caller has to
 * supply the ids by hand there. Both paths are best-effort: Zalo's history
 * APIs lag live traffic, so the "newest" message found may not be the true
 * newest (see agent/work/transfer-sync-v2/NOTES.md § Ordering).
 *
 * Opens the account's zalo.db whichever source answers, because the caller
 * writes to it next.
 *
 * @param {object} api
 * @param {string} threadId
 * @param {number} type - 0=User, 1=Group
 * @returns {Promise<{ownerId: string, cliMsgId: string, globalMsgId: string}|null>}
 */
async function newestMessageAnchor(api, threadId, type) {
    // Open the cache before either source runs. Source 2 reads it, and
    // `conv delete` flags the thread in it (markThreadGone) straight after --
    // which only ever worked because source 1 always failed and source 2
    // opened the cache on the way.
    let cacheOpen = false;
    try {
        const activeAcc = getActive();
        if (activeAcc) {
            initDb(join(CONFIG_DIR, "accounts", activeAcc.ownId, "zalo.db"));
            cacheOpen = true;
        }
    } catch {
        // No cache on this machine; source 1 can still answer.
    }

    // Source 1: Zalo's cloud-message store, the group history Zalo Web reads
    // (src/core/group-history.js). zca-js's getGroupChatHistory asked
    // /api/group/history, which Zalo answers with 404 -- and this used to read
    // its answer as an array, a shape it never had.
    if (type === 1) {
        try {
            // Loaded on demand: only the group path needs it.
            const { getGroupHistory } = await import("../core/group-history.js");
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
    if (!cacheOpen) return null;
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
        return null;
    }
}

/**
 * How many cached rows to inspect before giving up on finding an anchor.
 * Deep enough to see past a run of sync-v2 rows, shallow enough that the
 * lookup stays a single cheap query.
 */
/** How far back to look for an incoming message to anchor a seen event on. */
const SEEN_ANCHOR_SCAN_DEPTH = 50;

const ANCHOR_SCAN_DEPTH = 200;

/** Build the deleteChat anchor triple, or null when any part is missing. */
function toAnchor(ownerId, cliMsgId, globalMsgId) {
    if (!ownerId || !cliMsgId || !globalMsgId) return null;
    return { ownerId: String(ownerId), cliMsgId: String(cliMsgId), globalMsgId: String(globalMsgId) };
}

/** `-t` as 0 (user) or 1 (group), or null for anything else. */
function threadTypeOf(value) {
    const t = Number(value);
    return t === 0 || t === 1 ? t : null;
}

/**
 * Pin or unpin one conversation, exactly as Zalo Web does.
 *
 * `POST {conversation}/api/pinconvers/updatev2` with
 * `{actionType: 1 pin | 2 unpin, conversations: ["g<id>" | "u<id>"], tab: 0}`
 * -- captured for a group and a DM, both directions. zca-js's
 * setPinnedConversations sends the same minus `tab`, so it is not used.
 *
 * @param {object} api - logged-in zca-js api
 * @param {{threadId: string, type: 0|1, pinned: boolean}} opts
 * @returns {Promise<object>}
 */
async function setConversationPinned(api, { threadId, type, pinned }) {
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
 * `version` is the one decision here. zca-js's updateArchivedChatList sends
 * `Date.now()`. Zalo Web sends the SERVER's version: each captured update
 * carried exactly the `version` the previous response returned, and the first
 * carried the one the web had stored from the server -- 25 days older than the
 * clock. Its archived-chat manager (module FEfs in the web API bundle) keeps
 * that value, refreshes it from `archivedchat/list` at start-up and from every
 * update response, and refetches the list when an answer flags it stale. A CLI
 * run is a fresh client every time, so it does what the web does at start-up:
 * read the list (zca-js's getArchivedChatList, the same GET a fresh web
 * session makes) and send the version found there. With no version, nothing
 * is sent.
 *
 * @param {object} api - logged-in zca-js api
 * @param {{threadId: string, type: 0|1, archived: boolean}} opts
 * @returns {Promise<object>}
 */
async function setConversationArchived(api, { threadId, type, archived }) {
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
 * Register the `conv` command group.
 *
 * @param {import("commander").Command} program
 * @param {{getApi?: () => object}} [deps] - test seam: the commands that talk to
 *   Zalo through src/core/receipts.js resolve their api here, so a unit test
 *   can hand them a stub transport and assert the request that goes out.
 *   Production passes nothing.
 */
export function registerConvCommands(program, deps = {}) {
    const zaloApi = () => (deps.getApi || getApi)();
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
                // fewer than 5, often zero. recentConversations() filters in
                // SQL -- with neither flag, `limit` of each kind, merged
                // newest-first -- and is what zalo_list_conversations calls too.
                const localThreads = recentConversations(
                    limit,
                    opts.friendsOnly ? "dm" : opts.groupsOnly ? "group" : "all",
                );

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

    /** `conv pin` / `conv unpin`. */
    async function pinAction(threadId, opts, pinned) {
        const type = threadTypeOf(opts.type);
        if (type === null) {
            error(`Invalid --type "${opts.type}": use 0 (user) or 1 (group).`);
            return;
        }
        try {
            const result = await setConversationPinned(zaloApi(), { threadId, type, pinned });
            output(result, program.opts().json, () =>
                success(pinned ? `Pinned conversation ${threadId}` : `Unpinned conversation ${threadId}`),
            );
        } catch (e) {
            error(`${pinned ? "Pin" : "Unpin"} failed: ${e.message}`);
        }
    }

    conv.command("pin <threadId>")
        .description("Pin a conversation to the top of the conversation list")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action((threadId, opts) => pinAction(threadId, opts, true));

    conv.command("unpin <threadId>")
        .description("Unpin a conversation")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action((threadId, opts) => pinAction(threadId, opts, false));

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

    /** `conv archive` / `conv unarchive`. */
    async function archiveAction(threadId, opts, archived) {
        const type = threadTypeOf(opts.type);
        if (type === null) {
            error(`Invalid --type "${opts.type}": use 0 (user) or 1 (group).`);
            return;
        }
        try {
            const result = await setConversationArchived(zaloApi(), { threadId, type, archived });
            output(result, program.opts().json, () => {
                success(
                    archived
                        ? `Moved conversation ${threadId} to Other (archived)`
                        : `Moved conversation ${threadId} back to Focused`,
                );
                if (result.needResync) {
                    warning(
                        "Zalo answered needResync: its archived list had moved on since it was read. " +
                            "Check the result with `zalo-agent conv archived`.",
                    );
                }
            });
        } catch (e) {
            error(`${archived ? "Archive" : "Unarchive"} failed: ${e.message}`);
        }
    }

    conv.command("archive <threadId>")
        .description("Move a conversation to the Other tab, Zalo's archive (list them with `conv archived`)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action((threadId, opts) => archiveAction(threadId, opts, true));

    conv.command("unarchive <threadId>")
        .description("Move a conversation from the Other tab back to Focused")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action((threadId, opts) => archiveAction(threadId, opts, false));

    conv.command("mute <threadId>")
        .description("Mute a conversation")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option("-d, --duration <secs>", "Duration in seconds (-1 = forever)", "-1")
        .action(async (threadId, opts) => {
            try {
                // zca-js is setMute(params, threadID, type) -- the options
                // object comes FIRST. This used to pass (threadId, type,
                // duration) positionally, so `params` got the thread id
                // string, `threadID` got 0 or 1, and the request went out
                // with `toid: 0`. Zalo answered "Tham so khong hop le" every
                // time: `conv mute` had never once worked. Same defect, and
                // the same shape, as the `msg delete` arity bug.
                const result = await getApi().setMute(
                    { duration: Number(opts.duration), action: MuteAction.MUTE },
                    threadId,
                    Number(opts.type),
                );
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
                // Same arity bug as `mute` above. Unmute is an ACTION, not a
                // duration of 0 -- zca-js derives the duration itself once
                // action is UNMUTE.
                const result = await getApi().setMute({ action: MuteAction.UNMUTE }, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Conversation unmuted"));
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("read <threadId>")
        .description(
            "Mark a conversation as read, both ways Zalo Web does: clear its manual unread mark (undoing " +
                "`conv unread`), and send a seen receipt for the newest incoming message in the local cache — " +
                "Zalo marks a MESSAGE seen, not a thread.",
        )
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, opts) => {
            // History, so it is not repeated: this used to hand zca-js's
            // sendSeenEvent the bare threadId -- the request reached Zalo with no
            // thread id in it -- and, once that was fixed, still went out with
            // st/at/cmd/ts all -1 (zca-js cannot send real values), no imei on a
            // DM, and no removeUnreadMark at all, so it could not undo
            // `conv unread`. Both requests are now built in src/core/receipts.js
            // to match a capture of the real Zalo Web client.
            //
            // process.exit stays outside the try blocks: inside one, a throwing
            // exit would be caught and reported as an API error.
            const activeAcc = getActive();
            if (!activeAcc) {
                error("No active account. Please login first.");
                process.exit(1);
            }
            const type = threadTypeOf(opts.type);
            if (type === null) {
                error(`Invalid --type "${opts.type}": use 0 (user) or 1 (group).`);
                return;
            }

            let result;
            try {
                initDb(join(CONFIG_DIR, "accounts", activeAcc.ownId, "zalo.db"));
                const rows = getMessages(String(threadId), SEEN_ANCHOR_SCAN_DEPTH);
                result = await markConversationRead(zaloApi(), { threadId, type, ownId: activeAcc.ownId, rows });
            } catch (e) {
                error(e.message);
                return;
            }

            output(result, program.opts().json, () => {
                if (result.unreadMark.ok) success("Cleared the manual unread mark");
                else error(`Could not clear the manual unread mark: ${result.unreadMark.error}`);

                const seen = result.seen;
                if (seen.ok) {
                    success(`Sent a seen receipt for message ${seen.msgId}`);
                    if (seen.guessed.length) {
                        warning(
                            `${seen.guessed.join(", ")} came from a fallback, not the message's own frame: the ` +
                                "listener cached it before it kept those fields (cmd follows the thread type; " +
                                "st=3 and at=5 are a guess).",
                        );
                    }
                } else if (seen.refused === "no-anchor") {
                    error(seen.error);
                    info("Zalo marks a MESSAGE as seen, not a thread, so there is nothing to anchor the event to.");
                    info("The cache is written by `listen` and by `sync` only. Run one of them first:");
                    info(`  zalo-agent sync --from ${new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)}`);
                } else if (seen.refused === "noised-sender") {
                    error(seen.error);
                    info("A message the listener receives carries its real sender id. Keep `listen` or `mcp start`");
                    info("running, and run `conv read` again once a new message has arrived in this conversation.");
                } else {
                    error(`Seen receipt for message ${seen.msgId} failed: ${seen.error}`);
                }
            });
            // A refused seen receipt is the command not doing what it says, so it
            // keeps the exit code the cold-cache refusal always had.
            if (result.seen.refused) process.exit(1);
        });

    conv.command("unread <threadId>")
        .description("Mark conversation as unread")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, opts) => {
            try {
                // zca-js names this addUnreadMark (paired with removeUnreadMark
                // and getUnreadMark). There has never been a markAsUnread, so
                // every invocation died on "is not a function" before reaching
                // the network -- which no test caught, because reaching the
                // network is exactly what the offline suite cannot do.
                const result = await getApi().addUnreadMark(threadId, Number(opts.type));
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
                        // Reached when nothing in the local cache carries a
                        // cliMsgId — typically a thread that has only ever
                        // been touched by the sync-v2 restore. One history
                        // fetch populates the full frames and fixes it, so
                        // name that rather than only the manual escape hatch.
                        error(
                            "Could not determine the last message to delete backwards from — no cached message " +
                                `for this thread carries a cliMsgId. Run \`zalo-agent msg history -t ${type} ${threadId}\` ` +
                                "first, or pass --owner-id, --cli-msg-id and --global-msg-id explicitly.",
                        );
                        return;
                    }
                    ownerId = ownerId || anchor.ownerId;
                    cliMsgId = cliMsgId || anchor.cliMsgId;
                    globalMsgId = globalMsgId || anchor.globalMsgId;
                }

                const result = await api.deleteChat({ ownerId, cliMsgId, globalMsgId }, threadId, type);
                // Zalo forgets it; we were not. Flag the thread so its leftover
                // rows and downloaded media surface as orphaned rather than
                // sitting there with nothing that would ever revisit them.
                try {
                    markThreadGone(String(threadId));
                } catch {
                    /* no local cache for this thread is fine */
                }
                output(result, program.opts().json, () =>
                    success(`Conversation ${threadId} deleted (backwards from message ${globalMsgId})`),
                );
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("forget [threadId]")
        .description(
            "Delete this machine's local copy of a conversation: its messages, reactions, board items, " +
                "reminders, cloud index and downloaded media. Zalo is not contacted — this only removes " +
                "what is cached here. Use --orphans for every conversation the account no longer has",
        )
        .option("--orphans", "Forget every orphaned conversation instead of a named one")
        .option("--dry-run", "Report what would be removed without removing it")
        .action(async (threadId, opts) => {
            const activeAcc = getActive();
            if (!activeAcc) {
                error("No active account. Please login first.");
                process.exit(1);
            }
            if (!threadId && !opts.orphans) {
                error("Give a threadId, or --orphans to forget every conversation the account no longer has.");
                process.exit(1);
            }
            const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);
            initDb(join(accountDir, "zalo.db"));

            const targets = opts.orphans
                ? getOrphanThreads().map((t) => ({ threadId: String(t.threadId), name: t.name, ...t }))
                : [{ threadId: String(threadId), name: "" }];

            if (!targets.length) {
                success("No orphaned conversations — nothing to forget.");
                process.exit(0);
            }

            if (opts.dryRun) {
                info(`Would forget ${targets.length} conversation(s):`);
                // Every one of them: a preview that stops at a page does not
                // show what the real run is about to remove.
                for (const t of targets) {
                    info(
                        `  ${t.threadId}${t.name ? ` (${t.name})` : ""}${t.messages ? ` — ${t.messages} message(s), ${t.files || 0} file(s)` : ""}`,
                    );
                }
                info("Re-run without --dry-run to remove them. This does not contact Zalo.");
                process.exit(0);
            }

            let removed = 0;
            let files = 0;
            for (const t of targets) {
                // Files first: forgetThread drops the rows that point at them,
                // and a deleted row would leave its media stranded on disk.
                try {
                    const pruned = await pruneDownloadedMedia({ all: true, threadId: t.threadId });
                    files += pruned.deleted;
                } catch (e) {
                    warning(`Media cleanup failed for ${t.threadId}: ${e.message}`);
                }
                try {
                    const counts = forgetThread(t.threadId);
                    removed += counts.messages || 0;
                } catch (e) {
                    error(`Failed to forget ${t.threadId}: ${e.message}`);
                }
            }
            success(
                `Forgot ${targets.length} conversation(s): ${removed} message(s) and ${files} file(s) removed locally.`,
            );
            info("Nothing was sent to Zalo; this only cleared the local cache.");
            process.exit(0);
        });
}
