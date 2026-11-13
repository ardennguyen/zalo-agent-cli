/**
 * Friend commands — list, find, info, add, accept, remove, block, unblock, last-online, online.
 */

import { getApi } from "../core/zalo-client.js";
import { success, error, info, output, warning } from "../utils/output.js";
import { parseIntOption } from "../utils/parse-options.js";
import { describeFriendUndoError, friendAddFailure, readSentRequests } from "../core/friend-requests.js";
import { errorCodeOf } from "../zalo/errors.js";
import { readUserAliases } from "../core/current-user-names.js";
import { allAliases } from "../core/list-all.js";
import { aliasFirst, ensureAliases } from "../core/contact-names.js";
import { searchFriends } from "../core/friend-search.js";
import { guardSubcommand } from "../core/confirm-guard.js";
import { lastOnlineStatus } from "../core/last-online.js";
import { getActive } from "../core/accounts.js";
import { getAccountDbPath } from "../core/credentials.js";
import { initDb } from "../core/db.js";
import { groupNames, mutualGroupsLine, mutualGroupsOrError } from "../core/mutual-groups.js";
import { hiddenSetForCli } from "../utils/hidden-access.js";

/**
 * The groups shared with one user for a CLI reply (src/core/mutual-groups.js), groups in hidden chats left out as
 * Zalo PC does. Never throws: a failed read is `{error}`.
 *
 * @param {object} api
 * @param {string|null|undefined} userId
 */
async function cliMutualGroups(api, userId) {
    const ownId = api.getOwnId?.() ?? null;
    let hidden = null;
    try {
        hidden = ownId ? await hiddenSetForCli(String(ownId), api, { preferMirror: true }) : null;
    } catch (e) {
        // Showing them without the hidden set could show a hidden chat's group: say so instead.
        return { error: `could not read the hidden chats, so the shared groups are not shown: ${e.message}` };
    }
    return mutualGroupsOrError(api, userId, { ownId, hidden });
}

export function registerFriendCommands(program) {
    const friend = program.command("friend").description("Manage friends and contacts");

    friend
        .command("list")
        .description("List all friends")
        .action(async () => {
            try {
                // Names alias first, as Zalo shows them (src/core/contact-names.js): one alias-list read.
                const raw = await getApi().getAllFriends();
                await ensureAliases(getApi());
                const result = Array.isArray(raw) ? raw.map((f) => aliasFirst(f)) : raw;
                output(result, program.opts().json, () => {
                    const friends = Array.isArray(result) ? result : [];

                    // Sort by lastActionTime (most recent interaction first)
                    const sorted = [...friends].sort((a, b) => {
                        const tA = a.lastActionTime || 0;
                        const tB = b.lastActionTime || 0;
                        return tB - tA;
                    });

                    info(`${sorted.length} friend(s)`);
                    for (const p of sorted) {
                        // epoch MILLISECONDS — the old x1000 printed year 58687
                        const dateStr = p.lastActionTime ? new Date(p.lastActionTime).toLocaleString() : "Never";
                        console.log(
                            `  ${p.userId.padEnd(20)}  ${(p.displayName || p.zaloName || "?").padEnd(25)} [Last Activity: ${dateStr}]`,
                        );
                    }
                });
            } catch (e) {
                error(e.message);
            }
        });

    friend
        .command("online")
        .description(
            "List currently online friends (unverified, dead in practice: Zalo answers 404, and Zalo Web discards " +
                "this answer too). Use `friend last-online <userId>` or `listen --events online` instead",
        )
        .action(async () => {
            try {
                const result = await getApi().getFriendOnlines();
                output(result, program.opts().json);
            } catch (e) {
                error(
                    /404/.test(e.message)
                        ? `${e.message}. Zalo answered 404 for the online-friends list on every profile host of this account's service map. Zalo Web's contact list asks the same thing and discards the answer. \`friend last-online <userId>\` works, and \`listen --events online\` reports presence as Zalo pushes it.`
                        : e.message,
                );
            }
        });

    friend
        .command("search <name>")
        .description("Search friends by name or alias (returns thread_id for messaging)")
        .action(async (name) => {
            try {
                const result = await getApi().getAllFriends();
                const friends = Array.isArray(result) ? result : [];
                // The alias you set for a friend is not in the friend list; it comes from the alias list.
                const aliases = await readUserAliases(getApi(), (m) => info(`${m}; matching names only`));
                const matches = searchFriends(friends, aliases, name).map((f) => aliasFirst(f));
                output(matches, program.opts().json, () => {
                    if (matches.length === 0) {
                        error(`No friends matching "${name}". Use "friend list" to see all.`);
                        return;
                    }
                    info(`${matches.length} friend(s) matching "${name}":`);
                    console.log();
                    for (const f of matches) {
                        // Alias first; the Zalo name beside it when the owner renamed them.
                        const display = f.displayName || f.zaloName || "?";
                        const aka =
                            f.alias && f.zaloName && f.zaloName !== display ? `  (Zalo name: ${f.zaloName})` : "";
                        console.log(`  ${f.userId}  ${display}${aka}`);
                    }
                    console.log();
                    info("Use the ID above as thread_id for messaging commands.");
                    info('Example: zalo-agent msg send <thread_id> "Hello"');
                });
            } catch (e) {
                error(e.message);
            }
        });

    friend
        .command("find <query>")
        .description("Find user by phone number or Zalo ID")
        .action(async (query) => {
            try {
                const found = await getApi().findUser(query);
                if (!found || (!found.uid && !found?.data?.uid)) {
                    error(
                        `No Zalo user found for "${query}". User may not exist, has disabled phone search, or phone is not registered on Zalo.`,
                    );
                    return;
                }
                await ensureAliases(getApi());
                const result = found?.uid ? aliasFirst(found) : { ...found, data: aliasFirst(found.data) };
                const u0 = result?.uid ? result : result?.data || result;
                const mutualGroups = await cliMutualGroups(getApi(), u0?.uid);
                output({ ...result, mutualGroups }, program.opts().json, () => {
                    const u = u0;
                    info(`User ID: ${u.uid || "?"}`);
                    info(`Name: ${u.displayName || u.zaloName || u.display_name || u.zalo_name || "?"}`);
                    info(mutualGroupsLine(mutualGroups));
                });
            } catch (e) {
                error(`Find user failed: ${e.message}`);
            }
        });

    friend
        .command("info <userId>")
        .description("Get user profile information")
        .action(async (userId) => {
            try {
                const raw = await getApi().getUserInfo(userId);
                await ensureAliases(getApi());
                const result = withProfileNames(raw);
                const mutualGroups = await cliMutualGroups(getApi(), userId);
                output({ ...result, mutualGroups }, program.opts().json, () => {
                    const profiles = result?.changed_profiles || {};
                    const p = profiles[userId] || {};
                    info(`Name: ${p.displayName || p.zaloName || "?"}`);
                    info(`Phone: ${p.phoneNumber || "?"}`);
                    info(`Avatar: ${p.avatar || "?"}`);
                    info(mutualGroupsLine(mutualGroups));
                });
            } catch (e) {
                error(e.message);
            }
        });

    friend
        .command("add <userId>")
        .description("Send a friend request")
        .option("-m, --msg <text>", "Message to include", "")
        .action(async (userId, opts) => {
            try {
                // Session signature: sendFriendRequest(msg, userId)
                const result = await getApi().sendFriendRequest(opts.msg, userId);
                output(result, program.opts().json, () => success(`Friend request sent to ${userId}`));
            } catch (e) {
                // Zalo's error codes as actionable messages; no "(code null)" for an error without one.
                error(friendAddFailure(e, userId));
            }
        });

    friend
        .command("accept <userId>")
        .description("Accept a friend request")
        .action(async (userId) => {
            try {
                const result = await getApi().acceptFriendRequest(userId);
                output(result, program.opts().json, () => success(`Accepted friend request from ${userId}`));
            } catch (e) {
                error(`Accept friend request failed for ${userId}: ${e.message}`);
            }
        });

    friend
        .command("remove <userId>")
        .description("Remove a friend")
        .action(async (userId) => {
            try {
                const result = await getApi().removeFriend(userId);
                output(result, program.opts().json, () => success(`Removed friend ${userId}`));
            } catch (e) {
                error(`Remove friend failed for ${userId}: ${e.message}`);
            }
        });

    friend
        .command("block <userId>")
        .description("Block a user")
        .action(async (userId) => {
            try {
                const result = await getApi().blockUser(userId);
                output(result, program.opts().json, () => success(`Blocked user ${userId}`));
            } catch (e) {
                error(`Block user failed for ${userId}: ${e.message}`);
            }
        });

    friend
        .command("unblock <userId>")
        .description("Unblock a user")
        .action(async (userId) => {
            try {
                const result = await getApi().unblockUser(userId);
                output(result, program.opts().json, () => success(`Unblocked user ${userId}`));
            } catch (e) {
                error(`Unblock user failed for ${userId}: ${e.message}`);
            }
        });

    friend
        .command("last-online <userId>")
        .description(
            "When a user was last online, as Zalo Web reads it: when your own online status is hidden " +
                '(profile set online-status 0) nothing is asked and hiddenBy is "you"; hiddenBy "them" means ' +
                "they hide theirs (unverified live)",
        )
        .option("--ask-anyway", "Ask Zalo even when your own online status is hidden (diagnostics)")
        .option(
            "--cached",
            "Answer from the listener's cache of Zalo's presence pushes (`listen`/`mcp start`); send nothing",
        )
        .option("--oa", "The user is an Official Account (skips the profile lookup that tells)")
        .action(async (userId, opts) => {
            try {
                if (opts.cached) {
                    // The cache is the account's db, written by the daemon; this only reads it.
                    const acc = getActive();
                    if (acc) initDb(getAccountDbPath(acc.ownId));
                }
                // The same reply as zalo_friend `last_online` (src/core/last-online.js).
                const result = await lastOnlineStatus(opts.cached ? null : getApi(), userId, {
                    askAnyway: Boolean(opts.askAnyway),
                    cached: Boolean(opts.cached),
                    ...(opts.oa ? { isOA: true } : {}),
                });
                output(result, program.opts().json, () => {
                    const when = result.lastOnline ? new Date(result.lastOnline).toLocaleString() : null;
                    if (result.hiddenBy === "you") info("Hidden: your own online status is hidden, so none is shown.");
                    else if (result.hiddenBy === "them") info("Hidden: this user hides their online status.");
                    else info(`Last online: ${when ?? "unknown"}`);
                    if (result.note) info(result.note);
                });
            } catch (e) {
                error(e.message);
            }
        });

    friend
        .command("find-username <username>")
        .description("Find a user by their Zalo username")
        .action(async (username) => {
            try {
                const found = await getApi().findUserByUsername(username);
                if (found) await ensureAliases(getApi());
                const result = found ? aliasFirst(found) : found;
                output(result, program.opts().json, () => {
                    if (!result) {
                        error(`No user found for username "${username}"`);
                        return;
                    }
                    // Zalo answers a username lookup in snake_case (`display_name`, `zalo_name`), as a phone
                    // lookup; the camelCase names are read too, as `friend find` reads them.
                    const name = result.display_name || result.displayName || result.zalo_name || result.zaloName;
                    info(`User ID: ${result.uid || result.userId || "?"}`);
                    info(`Name: ${name || "?"}`);
                });
            } catch (e) {
                error(`Find username failed: ${e.message}`);
            }
        });

    friend
        .command("alias <friendId> <alias>")
        .description("Set a nickname (alias) for a friend")
        .action(async (friendId, alias) => {
            try {
                const result = await getApi().changeFriendAlias(alias, friendId);
                output(result, program.opts().json, () => success(`Alias set to "${alias}" for ${friendId}`));
            } catch (e) {
                error(`Set alias failed: ${e.message}`);
            }
        });

    friend
        .command("alias-list")
        .description("List all friend aliases")
        .option("-c, --count <n>", "Page size (with -c or -p one page is read, 100 a page by default)", parseIntOption)
        .option("-p, --page <n>", "Read only this page (default: every page)", parseIntOption)
        .action(async (opts) => {
            try {
                let result;
                if (opts.count === undefined && opts.page === undefined) {
                    // No page asked: every page, as Zalo Web pages its alias list (src/core/list-all.js).
                    const all = await allAliases(getApi());
                    result = { items: all.items };
                    if (all.paging.note) warning(all.paging.note);
                } else {
                    result = await getApi().getAliasList(opts.count ?? 100, opts.page ?? 1);
                }
                output(result, program.opts().json, () => {
                    const items = result?.items || [];
                    info(`${items.length} alias(es)`);
                    for (const item of items) {
                        console.log(`  ${item.userId}  ${item.alias}`);
                    }
                });
            } catch (e) {
                error(`Get alias list failed: ${e.message}`);
            }
        });

    friend
        .command("alias-remove <friendId>")
        .description("Remove a friend's alias")
        .action(async (friendId) => {
            try {
                const result = await getApi().removeFriendAlias(friendId);
                output(result, program.opts().json, () => success(`Alias removed for ${friendId}`));
            } catch (e) {
                error(`Remove alias failed: ${e.message}`);
            }
        });

    friend
        .command("reject <userId>")
        .description("Reject a friend request")
        .action(async (userId) => {
            try {
                const result = await getApi().rejectFriendRequest(userId);
                output(result, program.opts().json, () => success(`Rejected friend request from ${userId}`));
            } catch (e) {
                error(`Reject friend request failed: ${e.message}`);
            }
        });

    friend
        .command("undo-request <userId>")
        .description("Cancel a sent friend request")
        .action(async (userId) => {
            try {
                const result = await getApi().undoFriendRequest(userId);
                output(result, program.opts().json, () => success(`Friend request to ${userId} cancelled`));
            } catch (e) {
                error(describeFriendUndoError(errorCodeOf(e), userId) || `Undo friend request failed: ${e.message}`);
            }
        });

    friend
        .command("sent-requests")
        .description("List all sent friend requests")
        .action(async () => {
            try {
                // Zalo's "none sent" (112) arrives as `{}`.
                const sent = await readSentRequests(getApi());
                if (Object.keys(sent || {}).length) await ensureAliases(getApi());
                const result = Object.fromEntries(
                    Object.entries(sent || {}).map(([uid, r]) => [uid, aliasFirst(r, uid)]),
                );
                output(result, program.opts().json, () => {
                    const entries = Object.entries(result);
                    if (!entries.length) {
                        info("No sent friend requests");
                        return;
                    }
                    info(`${entries.length} sent request(s)`);
                    for (const [uid, req] of entries) {
                        console.log(`  ${uid}  ${req.displayName || req.zaloName || "?"}`);
                    }
                });
            } catch (e) {
                error(`Get sent requests failed: ${e.message}`);
            }
        });

    friend
        .command("request-status <userId>")
        .description("Check friend request status with a user")
        .action(async (userId) => {
            try {
                const result = await getApi().getFriendRequestStatus(userId);
                output(result, program.opts().json, () => {
                    info(`is_friend: ${result.is_friend}`);
                    info(`is_requested: ${result.is_requested}`);
                    info(`is_requesting: ${result.is_requesting}`);
                });
            } catch (e) {
                error(`Get request status failed: ${e.message}`);
            }
        });

    friend
        .command("close")
        .description("List close friends")
        .action(async () => {
            try {
                const raw = await getApi().getCloseFriends();
                if (Array.isArray(raw) && raw.length) await ensureAliases(getApi());
                const result = Array.isArray(raw) ? raw.map((f) => aliasFirst(f)) : raw;
                output(result, program.opts().json, () => {
                    const friends = Array.isArray(result) ? result : [];
                    info(`${friends.length} close friend(s)`);
                    for (const f of friends) {
                        console.log(`  ${f.userId || f.uid || "?"}  ${f.displayName || f.zaloName || "?"}`);
                    }
                });
            } catch (e) {
                error(
                    `Get close friends failed: ${e.message}` +
                        (/404/.test(e.message)
                            ? ". Zalo has retired close friends: this build's web client has no menu and no caller for it, and the request answers 404."
                            : ""),
                );
            }
        });

    friend
        .command("recommendations")
        .description("Get friend recommendations and received requests")
        .action(async () => {
            try {
                const raw = await getApi().getFriendRecommendations();
                if (raw?.recommItems?.length) await ensureAliases(getApi());
                const result = Array.isArray(raw?.recommItems)
                    ? {
                          ...raw,
                          recommItems: raw.recommItems.map((i) =>
                              i?.dataInfo ? { ...i, dataInfo: aliasFirst(i.dataInfo) } : i,
                          ),
                      }
                    : raw;
                output(result, program.opts().json, () => {
                    const items = result?.recommItems || [];
                    info(`${items.length} recommendation(s)`);
                    for (const item of items) {
                        const d = item.dataInfo || {};
                        const type = d.recommType === 2 ? "[request]" : "[suggest]";
                        console.log(`  ${d.userId}  ${d.displayName || d.zaloName || "?"}  ${type}`);
                    }
                });
            } catch (e) {
                error(`Get recommendations failed: ${e.message}`);
            }
        });

    friend
        .command("find-phones <phones...>")
        .description("Find users by phone numbers")
        .action(async (phones) => {
            try {
                const raw = await getApi().getMultiUsersByPhones(phones);
                if (Object.keys(raw || {}).length) await ensureAliases(getApi());
                const result = Object.fromEntries(
                    Object.entries(raw || {}).map(([phone, u]) => [phone, aliasFirst(u)]),
                );
                output(result, program.opts().json, () => {
                    const entries = Object.entries(result || {});
                    info(`${entries.length} user(s) found`);
                    for (const [phone, user] of entries) {
                        console.log(`  ${phone}  ${user.uid || "?"}  ${user.displayName || user.zaloName || "?"}`);
                    }
                });
            } catch (e) {
                error(`Find by phone failed: ${e.message}`);
            }
        });

    friend
        .command("qr <userIds...>")
        .description("Get the QR code image URL of one or more users")
        .action(async (userIds) => {
            try {
                const result = await getApi().getQR(userIds);
                output(result, program.opts().json, () => {
                    for (const [uid, url] of Object.entries(result ?? {})) console.log(`  ${uid}  ${url}`);
                });
            } catch (e) {
                error(`Get QR failed: ${e.message}`);
            }
        });

    friend
        .command("common-groups <friendIds...>")
        .description("List the groups you share with one or more friends")
        .action(async (friendIds) => {
            try {
                const api = getApi();
                const result = await api.getRelatedFriendGroup(friendIds);
                // Groups in hidden chats are left out, as Zalo PC leaves them out of "Nhóm chung".
                const ownId = api.getOwnId?.() ?? null;
                const hidden = ownId ? await hiddenSetForCli(String(ownId), api, { preferMirror: true }) : null;
                const lists = Object.entries(result?.groupRelateds ?? {}).map(([fid, groups]) => [
                    fid,
                    (Array.isArray(groups) ? groups : []).map(String).filter((id) => !hidden?.isHidden(id)),
                ]);
                const names = await groupNames(
                    api,
                    lists.flatMap(([, ids]) => ids),
                    { ownId },
                );
                const shared = lists.map(([userId, groupIds]) => ({
                    userId,
                    count: groupIds.length,
                    groups: groupIds.map((groupId) => ({ groupId, name: names.get(groupId) ?? null })),
                }));
                // groupRelateds is Zalo's own shape (hidden-chat groups left out); shared adds the count and names.
                output({ groupRelateds: Object.fromEntries(lists), shared }, program.opts().json, () => {
                    for (const s of shared) {
                        info(`${s.userId}: ${s.count} mutual group${s.count === 1 ? "" : "s"}`);
                        for (const g of s.groups) console.log(`  ${g.groupId}${g.name ? `  ${g.name}` : ""}`);
                    }
                });
            } catch (e) {
                error(`Get shared groups failed: ${e.message}`);
            }
        });

    friend
        .command("biz <friendId>")
        .description("Show the business account details of a user (category, address, website, email)")
        .action(async (friendId) => {
            try {
                const result = await getApi().getBizAccount(friendId);
                output(result, program.opts().json);
            } catch (e) {
                error(`Get business account failed: ${e.message}`);
            }
        });

    friend
        .command("block-feed <userId>")
        .description("Hide a user's posts from your feed (or show them again with --unblock)")
        .option("--unblock", "Show this user's feed again")
        .action(async (userId, opts) => {
            try {
                const result = await getApi().blockViewFeed(!opts.unblock, userId);
                output(result, program.opts().json, () => success(opts.unblock ? "Feed shown again" : "Feed hidden"));
            } catch (e) {
                error(`Block feed failed: ${e.message}`);
            }
        });
    // Asked about first, as Zalo Web does: --yes to act, --dry-run to preview (src/core/confirm-guard.js).
    guardSubcommand(friend, "remove", "friend.remove", { target: (userId) => ({ userId }) });
    guardSubcommand(friend, "block", "friend.block", { target: (userId) => ({ userId }) });
    guardSubcommand(friend, "reject", "friend.reject", { target: (userId) => ({ userId }) });
    guardSubcommand(friend, "undo-request", "friend.undoRequest", { target: (userId) => ({ userId }) });
}

/**
 * A `getUserInfo` answer with each profile named alias first (src/core/contact-names.js `aliasFirst`).
 *
 * @param {object} res
 * @returns {object}
 */
function withProfileNames(res) {
    if (!res || typeof res !== "object") return res;
    const out = { ...res };
    for (const key of ["changed_profiles", "unchanged_profiles"]) {
        if (res[key] && typeof res[key] === "object") {
            out[key] = Object.fromEntries(Object.entries(res[key]).map(([uid, p]) => [uid, aliasFirst(p, uid)]));
        }
    }
    return out;
}
