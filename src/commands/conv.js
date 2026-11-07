/**
 * Conversation commands — pinned, pin, unpin, archived, archive, unarchive,
 * mute, unmute, read, unread, delete.
 */

import { MUTE_ACTION } from "../zalo/enums.js";
import { getApi } from "../core/zalo-client.js";
import { success, error, info, output, warning } from "../utils/output.js";
import { getActive } from "../core/accounts.js";
import { getAccountDbPath } from "../core/credentials.js";
import { initDb, getMessages, getReadStates, markThreadGone, getOrphanThreads, getThreadNames } from "../core/db.js";
import { recentConversations } from "../core/recent-conversations.js";
import { describeReadState, readStateLabel } from "../core/read-state.js";
import { pinnedConversations } from "../core/sync-v2/conv-state.js";
import { markConversationRead, unreadMarkAnchor } from "../core/receipts.js";
import {
    AUTO_DELETE_TTLS,
    SEEN_ANCHOR_SCAN_DEPTH,
    forgetConversation,
    newestMessageAnchor as newestAnchorFromSources,
    setConversationArchived,
    setConversationPinned,
} from "../core/conversation-actions.js";
import { readUserAliases, currentUserName } from "../core/current-user-names.js";
import { guardSubcommand } from "../core/confirm-guard.js";
import { setBlockSharing } from "../core/block-sharing.js";
import { parseOnOff } from "../utils/cli-args.js";
import { withoutHidden } from "../core/hidden-chats.js";
import { changeHiddenPin, readHidden, resetHiddenPinAndDelete } from "../core/hidden-chat-actions.js";
import {
    addHiddenOptions,
    exitPinRequired,
    hiddenAccess,
    hiddenSetForCli,
    readPin,
    readPinLines,
    unlockOrExit,
} from "../utils/hidden-access.js";

/**
 * The anchor `conv delete` deletes backwards from (src/core/conversation-actions.js), with this account's cache
 * opened first: the group store may not answer, and `conv delete` flags the thread in the cache (markThreadGone)
 * straight after.
 *
 * @param {object} api
 * @param {string} threadId
 * @param {number} type - 0=User, 1=Group
 * @returns {Promise<{ownerId: string, cliMsgId: string, globalMsgId: string}|null>}
 */
async function newestMessageAnchor(api, threadId, type) {
    try {
        const activeAcc = getActive();
        if (activeAcc) initDb(getAccountDbPath(activeAcc.ownId));
    } catch {
        // No cache on this machine; the group store can still answer.
    }
    return newestAnchorFromSources(api, threadId, type);
}

/**
 * The newest cached message of a thread, as `addUnreadMark` names it, or null when the cache has none (or there is
 * no cache on this machine). Never throws: the mark is still sent without it.
 *
 * @param {string} threadId
 * @returns {{cliMsgId: string, fromUid: string}|null}
 */
function newestMessageForUnreadMark(threadId) {
    try {
        const activeAcc = getActive();
        if (!activeAcc) return null;
        initDb(getAccountDbPath(activeAcc.ownId));
        return unreadMarkAnchor(getMessages(String(threadId), SEEN_ANCHOR_SCAN_DEPTH), { ownId: activeAcc.ownId });
    } catch {
        return null;
    }
}

/** `-t` as 0 (user) or 1 (group), or null for anything else. */
function threadTypeOf(value) {
    const t = Number(value);
    return t === 0 || t === 1 ? t : null;
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
        .option(
            "--include-hidden",
            "Show hidden conversations too: asks for the hidden-chat PIN (never pass it on the command line)",
        )
        .option("--pin-stdin", "Read the hidden-chat PIN from standard input instead of a prompt")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            const limit = Number(opts.limit);

            const activeAcc = getActive();
            if (!activeAcc) {
                error("No active account. Please login first.");
                process.exit(1);
            }
            // Hidden chats are left out, as Zalo Web lists them, unless --include-hidden and the PIN.
            let liveApi = null;
            try {
                liveApi = getApi();
            } catch {
                /* cache only: the hidden-id mirror still applies */
            }
            const hidden = await hiddenAccess(opts, { ownId: activeAcc.ownId, api: liveApi, json: jsonMode });

            try {
                initDb(getAccountDbPath(activeAcc.ownId));
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
                    { excludeThreadIds: hidden.ids },
                );

                if (localThreads && localThreads.length > 0) {
                    if (!jsonMode) info(`Found ${localThreads.length} recent conversations in local cache.`);

                    // How far the account has read each one on Zalo, on any
                    // device, as the listener last heard (src/core/read-state.js).
                    const reads = getReadStates(
                        localThreads.map((t) => String(t.threadId)),
                        activeAcc.ownId,
                    );
                    const conversations = localThreads.map((t) => ({
                        threadId: t.threadId,
                        name: t.name,
                        type: t.type === "group" ? "Group" : "User",
                        typeFlag: t.type === "group" ? 1 : 0,
                        lastActive: t.lastUpdate ? new Date(t.lastUpdate).toLocaleString() : "?",
                        readState: describeReadState(reads.get(String(t.threadId))),
                    }));

                    output(conversations, jsonMode, () => {
                        info(`${conversations.length} conversation(s) (Local Cache):`);
                        console.log();
                        console.log(`  ${"THREAD_ID".padEnd(22)}  ${"TYPE".padEnd(12)}  ${"READ".padEnd(18)}  NAME`);
                        console.log("  " + "-".repeat(80));
                        for (const c of conversations) {
                            const id = c.threadId.padEnd(22);
                            const read = readStateLabel(c.readState).padEnd(18);
                            console.log(`  ${id}  ${c.type.padEnd(12)}  ${read}  ${c.name}`);
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
                    const aliases = sorted.length > 0 ? await readUserAliases(api) : new Map();
                    for (const f of sorted) {
                        const resolved = currentUserName(f.userId, f, aliases);
                        conversations.push({
                            threadId: f.userId,
                            name:
                                (resolved.source !== "uid" ? resolved.name : null) ||
                                f.displayName ||
                                f.zaloName ||
                                "?",
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

                const shown = withoutHidden(conversations, hidden.set, hidden.mode);
                conversations.length = 0;
                conversations.push(...shown);
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
                const result = await zaloApi().getPinConversations();
                // Zalo's `m1` entry is not a conversation; Web skips it (spec-actions 7.3), as the pin sync does.
                // A hidden chat is left out, as Web's list leaves it out (`u<id>`/`g<id>` entries).
                const active = getActive();
                const hidden = active ? await hiddenSetForCli(active.ownId, zaloApi(), { preferMirror: true }) : null;
                const conversations = withoutHidden(
                    pinnedConversations(result?.conversations),
                    hidden,
                    "exclude",
                    (c) => c,
                );
                output({ ...result, conversations }, program.opts().json);
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
                // The session's signature is setMute(params, threadID, type) -- the options
                // object comes FIRST. This used to pass (threadId, type,
                // duration) positionally, so `params` got the thread id
                // string, `threadID` got 0 or 1, and the request went out
                // with `toid: 0`. Zalo answered "Tham so khong hop le" every
                // time: `conv mute` had never once worked. Same defect, and
                // the same shape, as the `msg delete` arity bug.
                const result = await getApi().setMute(
                    { duration: Number(opts.duration), action: MUTE_ACTION.MUTE },
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
                // duration of 0 -- the session derives the duration itself once
                // action is UNMUTE.
                const result = await getApi().setMute({ action: MUTE_ACTION.UNMUTE }, threadId, Number(opts.type));
                output(result, program.opts().json, () => success("Conversation unmuted"));
            } catch (e) {
                error(e.message);
            }
        });

    conv.command("read <threadId>")
        .description(
            'Mark a conversation as read, as Zalo Web\'s "Mark as read" does: a seen receipt for every cached ' +
                "incoming message newer than your read position (up to 50), a reaction-seen receipt when a reaction " +
                'is unread (unverified), and removing the manual unread mark when it is set. The sender sees "Seen" unless your ' +
                "seen status is hidden (profile set seen-status 0)",
        )
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .option(
            "--mark-only",
            "Only remove the manual unread mark (the red dot): Zalo's real unread count stays and nothing is marked seen",
        )
        .action(async (threadId, opts) => {
            // Both surfaces call src/core/receipts.js markConversationRead and answer its JSON (zalo_conversation
            // `read`). The requests are built to match a capture of the real Zalo Web client.
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
                initDb(getAccountDbPath(activeAcc.ownId));
                result = await markConversationRead(zaloApi(), {
                    threadId,
                    type,
                    ownId: activeAcc.ownId,
                    markOnly: Boolean(opts.markOnly),
                });
            } catch (e) {
                error(e.message);
                return;
            }

            if (!result.success && program.opts().json) process.exitCode = 1;
            output(result, program.opts().json, () => {
                const mark = result.unreadMark;
                if (mark.removed) success("Removed the manual unread mark");
                else if (mark.error) error(`Could not clear the manual unread mark: ${mark.error}`);
                else if (mark.wasSet === false) info("No manual unread mark was set");

                const seen = result.seen;
                if (seen?.sent) {
                    success(`Marked ${seen.sent} message(s) seen (${seen.msgIds.join(", ")})`);
                    if (seen.guessed.length) {
                        warning(
                            `${seen.guessed.join(", ")} came from a fallback, not the message's own frame: the ` +
                                "listener cached it before it kept those fields (cmd follows the thread type; " +
                                "st=3 and at=5 are a guess).",
                        );
                    }
                } else if (seen?.refused === "no-cache") {
                    error(seen.error);
                    info("Zalo marks a MESSAGE as seen, not a thread. Run one of these first:");
                    info(`  zalo-agent sync --from ${new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)}`);
                    info("  zalo-agent listen");
                } else if (seen?.refused === "noised-sender") {
                    error(seen.error);
                    info("Keep `listen` or `mcp start` running, and run `conv read` again once a new message arrives.");
                } else if (seen?.error) {
                    error(seen.error);
                }
                if (seen?.skipped?.e2ee) {
                    info(
                        `${seen.skipped.e2ee} end-to-end encrypted message(s) left out: this client cannot mark those.`,
                    );
                }
                if (result.reactions?.sent) success("Marked the conversation's reactions seen");
                else if (result.reactions?.error) error(`Reaction-seen receipt failed: ${result.reactions.error}`);
                if (result.note) info(result.note);
            });
            // A refused seen receipt is the command not doing what it says, so it
            // keeps the exit code the cold-cache refusal always had.
            if (result.seen?.refused) process.exit(1);
        });

    conv.command("unread <threadId>")
        .description("Mark conversation as unread")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, opts) => {
            try {
                // The session names this addUnreadMark (paired with removeUnreadMark
                // and getUnreadMark). There has never been a markAsUnread, so
                // every invocation died on "is not a function" before reaching
                // the network -- which no test caught, because reaching the
                // network is exactly what the offline suite cannot do.
                //
                // Zalo Web pins the mark to the conversation's newest message
                // (its cliMsgId and sender), so the cache is read for it; with
                // none cached the Web's "-1" goes out instead.
                const last = newestMessageForUnreadMark(threadId);
                const result = await zaloApi().addUnreadMark(threadId, Number(opts.type), last);
                output(result, program.opts().json, () => success("Marked as unread"));
            } catch (e) {
                error(e.message);
            }
        });

    /** The active account, or exit 1. */
    const activeOrExit = () => {
        const acc = getActive();
        if (!acc) {
            error("No active account. Please login first.");
            process.exit(1);
        }
        return acc;
    };

    addHiddenOptions(
        conv
            .command("hidden")
            .description(
                "List hidden conversations: asks for the hidden-chat PIN first, as Zalo Web does (without it, " +
                    "only how many there are and whether a PIN is set)",
            ),
        { include: false },
    ).action(async (opts) => {
        const json = program.opts().json;
        const acc = activeOrExit();
        let listed;
        const set = await hiddenSetForCli(acc.ownId, null);
        try {
            listed = await readHidden(zaloApi(), set);
        } catch (e) {
            error(`Get hidden conversations failed: ${e.message}`);
            return;
        }
        if (!listed.hasPin || listed.count === 0) {
            output({ count: listed.count, hasPin: listed.hasPin, threads: [] }, json, () =>
                info(listed.hasPin ? "No hidden conversations." : "No hidden-chat PIN is set; nothing is hidden."),
            );
            return;
        }
        await unlockOrExit(set, {
            pinStdin: Boolean(opts.pinStdin),
            json,
            extra: { count: listed.count, hasPin: true },
        });
        let names = new Map();
        try {
            initDb(getAccountDbPath(acc.ownId));
            names = getThreadNames();
        } catch {
            /* no cache: ids only */
        }
        const threads = listed.threads.map((t) => ({
            threadId: t.threadId,
            threadType: t.isGroup === null ? null : t.isGroup ? "group" : "dm",
            name: names.get(String(t.threadId))?.name ?? null,
        }));
        output({ count: threads.length, hasPin: true, threads }, json, () => {
            info(`${threads.length} hidden conversation(s):`);
            for (const t of threads)
                console.log(`  ${t.threadId.padEnd(22)}  ${(t.threadType ?? "?").padEnd(6)}  ${t.name ?? ""}`);
        });
    });

    conv.command("hide <threadIds...>")
        .description("Hide conversation(s) behind the hidden-chat PIN (a PIN must be set first: `conv hidden-pin`)")
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadIds, opts) => {
            const acc = activeOrExit();
            try {
                const set = await hiddenSetForCli(acc.ownId, null);
                await set.refresh(zaloApi());
                // Zalo Web asks for a PIN before the first hide: a hidden chat with no PIN is hidden from nobody.
                if (!set.hasPin) {
                    error("No hidden-chat PIN is set: set one with `zalo-agent conv hidden-pin` first, then hide.");
                    process.exit(1);
                }
                const result = await zaloApi().setHiddenConversations(true, threadIds, Number(opts.type));
                for (const id of threadIds) set.ids.add(String(id));
                output(result, program.opts().json, () => success(`Hidden ${threadIds.length} conversation(s)`));
            } catch (e) {
                error(`Hide failed: ${e.message}`);
            }
        });

    addHiddenOptions(
        conv
            .command("unhide <threadIds...>")
            .description("Unhide conversation(s): asks for the hidden-chat PIN, as opening a hidden chat does")
            .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0"),
        { include: false },
    ).action(async (threadIds, opts) => {
        const json = program.opts().json;
        const acc = activeOrExit();
        const set = await hiddenSetForCli(acc.ownId, null);
        try {
            await set.refresh(zaloApi());
        } catch (e) {
            error(`Unhide failed: ${e.message}`);
            return;
        }
        await unlockOrExit(set, { pinStdin: Boolean(opts.pinStdin), json });
        try {
            const result = await zaloApi().setHiddenConversations(false, threadIds, Number(opts.type));
            for (const id of threadIds) set.ids.delete(String(id));
            output(result, json, () => success(`Unhidden ${threadIds.length} conversation(s)`));
        } catch (e) {
            error(`Unhide failed: ${e.message}`);
        }
    });

    const hiddenPin = conv
        .command("hidden-pin [removed]")
        .description(
            "Set or change the hidden-chat PIN: asks for the current PIN (when one is set), then the new one twice. " +
                "The PIN is never a command-line argument; --pin-stdin reads the same answers, one per line",
        )
        .option("--pin-stdin", "Read the PINs from standard input, one per line (current, if set; new; new again)");
    // The 2.x form `conv hidden-pin 1234` put the PIN in the shell history and the process list: refused before any
    // login (src/index.js runs this preflight), with how to do it now.
    hiddenPin.zaloPreflight = (command, { json }) => {
        if (command.args.length === 0) return;
        const why =
            "Not done: `conv hidden-pin` no longer takes the PIN as an argument (it would land in your shell " +
            "history and the process list). Run `zalo-agent conv hidden-pin` and type it at the prompt, or pipe " +
            "it with --pin-stdin.";
        if (json) console.log(JSON.stringify({ error: why, pinArgumentRemoved: true }, null, 2));
        else error(why);
        process.exit(1);
    };
    hiddenPin.action(async (_removed, opts) => {
        const json = program.opts().json;
        const acc = activeOrExit();
        const set = await hiddenSetForCli(acc.ownId, null);
        try {
            await set.refresh(zaloApi());
        } catch (e) {
            error(`Update PIN failed: ${e.message}`);
            return;
        }
        const lines = opts.pinStdin ? await readPinLines() : null;
        const ask = async (prompt) => {
            const v = await readPin({ pinStdin: Boolean(opts.pinStdin), prompt, lines });
            if (v === null) exitPinRequired(json, { hasPin: set.hasPin });
            return v;
        };
        let typed;
        try {
            typed = {
                pin: set.hasPin ? await ask("Current hidden-chat PIN: ") : undefined,
                newPin: await ask("New PIN (4 digits): "),
                newPin2: await ask("New PIN again: "),
            };
        } catch (e) {
            error(`Could not read the PIN: ${e.message}`);
            process.exit(1);
        }
        let r;
        try {
            r = await changeHiddenPin(zaloApi(), set, typed);
        } catch (e) {
            error(`Update PIN failed: ${e.message}`);
            return;
        } finally {
            typed = null;
        }
        if (!r.ok) {
            error(r.message);
            process.exit(1);
        }
        output({ success: true, changed: true, hadPin: r.hadPin }, json, () =>
            success(r.hadPin ? "Hidden-chat PIN changed" : "Hidden-chat PIN set"),
        );
    });

    conv.command("hidden-pin-reset")
        .description(
            "Remove the hidden-chat PIN (no PIN needed) and, as Zalo Web does, delete every hidden conversation's " +
                "history for this account; each deletion is reported",
        )
        .action(async () => {
            const acc = activeOrExit();
            try {
                initDb(getAccountDbPath(acc.ownId));
            } catch {
                /* no cache: the group store can still anchor a group's delete */
            }
            try {
                const set = await hiddenSetForCli(acc.ownId, null);
                const r = await resetHiddenPinAndDelete(zaloApi(), set);
                const failed = r.conversations.filter((c) => !c.deleted);
                if (failed.length && program.opts().json) process.exitCode = 1;
                output(
                    {
                        ...(failed.length && { error: `${failed.length} hidden conversation(s) could not be deleted` }),
                        success: failed.length === 0,
                        ...r,
                    },
                    program.opts().json,
                    () => {
                        success("Hidden-chat PIN removed");
                        for (const c of r.conversations) {
                            if (c.deleted) success(`Deleted hidden conversation ${c.threadId} (${c.threadType})`);
                            else error(`Could not delete hidden conversation ${c.threadId}: ${c.error}`);
                        }
                        if (!r.conversations.length) info("There were no hidden conversations to delete.");
                    },
                );
            } catch (e) {
                error(`Reset PIN failed: ${e.message}`);
            }
        });

    conv.command("block-sharing <threadId> <state>")
        .description(
            "Turn block sharing on or off for one conversation (on|off): Zalo Web's setting that stops its messages " +
                "being forwarded or saved. Needs a zBusiness Max account; unverified (never seen to succeed). " +
                "`read run blocksharing-list` lists the conversations that have it",
        )
        .option("-t, --type <n>", "Thread type: 0=User, 1=Group", "0")
        .action(async (threadId, state, opts) => {
            try {
                const type = threadTypeOf(opts.type);
                if (type === null) throw new Error(`Invalid --type "${opts.type}": use 0 (user) or 1 (group).`);
                // The same reply as zalo_conversation `block_sharing` (src/core/block-sharing.js).
                const result = await setBlockSharing(zaloApi(), {
                    threadId,
                    type,
                    enabled: parseOnOff(state, "block-sharing"),
                });
                output(result, program.opts().json, () =>
                    success(`Block sharing ${result.blockSharing ? "on" : "off"} for ${threadId} (unverified)`),
                );
            } catch (e) {
                error(`Block sharing failed: ${e.message}`);
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
                const ttlValue = AUTO_DELETE_TTLS[ttl];
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

                // The session exposes deleteChat(lastMessage, threadId, type) — NOT
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
            initDb(getAccountDbPath(activeAcc.ownId));

            const targets = opts.orphans
                ? getOrphanThreads().map((t) => ({ threadId: String(t.threadId), name: t.name, ...t }))
                : [{ threadId: String(threadId), name: "" }];

            const jsonMode = program.opts().json;
            const note = "Nothing was sent to Zalo; only this machine's copy was removed.";
            if (!targets.length) {
                output({ success: true, forgotten: 0, messages: 0, files: 0, note }, jsonMode, () =>
                    success("No orphaned conversations — nothing to forget."),
                );
                process.exit(0);
            }

            if (opts.dryRun) {
                // The same preview `zalo_conversation forget` gives with dryRun.
                if (jsonMode) {
                    output({ dryRun: true, conversations: targets }, jsonMode);
                    process.exit(0);
                }
                info(`Would forget ${targets.length} conversation(s):`);
                // Every one of them: a preview that stops at a page does not
                // show what the real run is about to remove.
                for (const t of targets) {
                    info(
                        `  ${t.threadId}${t.name ? ` (${t.name})` : ""}${t.messages ? ` — ${t.messages} message(s), ${t.files || 0} file(s)` : ""}`,
                    );
                }
                info("Re-run with --yes instead of --dry-run to remove them. This does not contact Zalo.");
                process.exit(0);
            }

            let removed = 0;
            let files = 0;
            const errors = [];
            for (const t of targets) {
                // Media first, then rows (src/core/conversation-actions.js); each failure is reported, not fatal.
                const gone = await forgetConversation(t.threadId);
                files += gone.files;
                removed += gone.messages;
                for (const e of gone.errors) errors.push({ threadId: t.threadId, ...e });
            }
            // The reply `zalo_conversation forget` gives (src/mcp/actions-conversation.js).
            const result = {
                success: errors.length === 0,
                forgotten: targets.length,
                messages: removed,
                files,
                ...(errors.length > 0 && { errors }),
                note,
            };
            // A media cleanup failure is a warning; a conversation whose rows stayed is a failure.
            const failed = errors.find((e) => e.what !== "media");
            if (jsonMode) {
                if (failed) process.exitCode = 1;
                output(
                    failed ? { error: `Failed to forget ${failed.threadId}: ${failed.message}`, ...result } : result,
                    jsonMode,
                );
                process.exit();
            }
            for (const e of errors) {
                if (e.what === "media") warning(`Media cleanup failed for ${e.threadId}: ${e.message}`);
                else error(`Failed to forget ${e.threadId}: ${e.message}`);
            }
            success(
                `Forgot ${targets.length} conversation(s): ${removed} message(s) and ${files} file(s) removed locally.`,
            );
            info("Nothing was sent to Zalo; this only cleared the local cache.");
            // 1 when any conversation failed to forget (error() set it), else 0.
            process.exit();
        });

    conv.command("muted")
        .description("List the conversations and groups you have muted")
        .action(async () => {
            try {
                const result = await getApi().getMute();
                output(result, program.opts().json, () => {
                    for (const [label, entries] of [
                        ["chat", result?.chatEntries ?? []],
                        ["group", result?.groupChatEntries ?? []],
                    ]) {
                        info(`${entries.length} muted ${label}(s)`);
                        for (const m of entries) console.log(`  ${m.id}  mode=${m.muteMode}  duration=${m.duration}`);
                    }
                });
            } catch (e) {
                error(`Get muted conversations failed: ${e.message}`);
            }
        });
    // Asked about first, as Zalo Web does: --yes to act, --dry-run to preview (src/core/confirm-guard.js).
    guardSubcommand(conv, "delete", "conv.delete", { target: (threadId) => ({ threadId }) });
    guardSubcommand(conv, "hidden-pin-reset", "conv.hiddenPinReset", { target: () => ({}) });
    guardSubcommand(conv, "unhide", "conv.unhide", { target: (threadIds) => ({ threadIds }) });
    // `forget` keeps its own --dry-run, which lists what would go.
    guardSubcommand(conv, "forget", "conv.forget", {
        target: (threadId, opts) => ({ threadId: threadId ?? null, orphans: Boolean(opts.orphans) }),
        ownDryRun: true,
    });
}
