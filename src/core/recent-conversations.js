/**
 * The conversations this account was most recently active in, from the local
 * cache — what `conv recent` lists, and what the MCP tool
 * `zalo_list_conversations` returns. Both call this, so they order and limit
 * the same way. Read-only.
 */

import { getRecentThreads } from "./db.js";

/**
 * The most recently active cached conversations, newest first.
 *
 * The limit is per kind, as `conv recent -n` documents it ("max results per
 * type"). The kinds are filtered in SQL rather than after the fact: the
 * groups among the n newest threads of any kind are usually fewer than n,
 * often none, which is not what asking for n groups means. With both kinds,
 * that is up to `limit` DMs and up to `limit` groups, merged newest first.
 *
 * Throws "Database not initialized" when no db is open, as db.js does.
 *
 * @param {number} limit - max conversations of each kind
 * @param {"dm"|"group"|"all"} [kind="all"]
 * @returns {object[]} `threads` rows (`threadId`, `type`, `name`, `lastUpdate`, …)
 */
export function recentConversations(limit, kind = "all") {
    if (kind === "dm" || kind === "group") return getRecentThreads(limit, kind);
    return [...getRecentThreads(limit, "dm"), ...getRecentThreads(limit, "group")].sort(
        (a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0),
    );
}
