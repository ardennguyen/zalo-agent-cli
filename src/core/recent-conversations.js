/**
 * The conversations this account was most recently active in, from the local
 * cache — what `conv recent` lists, and what the MCP tool
 * `zalo_list_conversations` returns. Both call this, so they order and limit
 * the same way. Read-only.
 */

import { getRecentThreads } from "./db.js";
import { dmTitle } from "./contact-names.js";
import { goneFields, goneGroupMap } from "./group-exit.js";

/**
 * The most recently active cached conversations, newest first.
 *
 * The limit is per kind, as `conv recent -n` documents it ("max results per
 * type"). The kinds are filtered in SQL rather than after the fact: the
 * groups among the n newest threads of any kind are usually fewer than n,
 * often none, which is not what asking for n groups means. With both kinds,
 * that is up to `limit` DMs and up to `limit` groups, merged newest first.
 *
 * No limit means every cached conversation: nothing is capped unless the
 * caller asked for a cap.
 *
 * Throws "Database not initialized" when no db is open, as db.js does.
 *
 * @param {number|null} [limit] - max conversations of each kind; omitted, null or <= 0 = all
 * @param {"dm"|"group"|"all"} [kind="all"]
 * @param {{excludeThreadIds?: Iterable<string>}} [opts] - conversations left out (hidden chats); `limit` still holds
 * @returns {object[]} `threads` rows (`threadId`, `type`, `name`, `lastUpdate`, …)
 */
export function recentConversations(limit, kind = "all", { excludeThreadIds } = {}) {
    // A gone group (src/core/group-exit.js): flagged while its history is kept, left out once it was purged.
    const gone = goneGroupMap();
    const excluded = new Set([...(excludeThreadIds ?? [])].map(String));
    for (const [id, g] of gone) if (!g.messages) excluded.add(id);
    const capped = Number(limit) > 0;
    const of = (k) => {
        if (!capped) return getRecentThreads(null, k).filter((t) => !excluded.has(String(t.threadId)));
        if (!excluded.size) return getRecentThreads(limit, k);
        return getRecentThreads(limit + excluded.size, k)
            .filter((t) => !excluded.has(String(t.threadId)))
            .slice(0, limit);
    };
    // A 1-1 is titled by the owner's alias, as it is now (the stored title can be from before an alias change).
    const titled = (rows) =>
        rows.map((t) => ({
            ...(t.type === "dm" ? { ...t, name: dmTitle(t.threadId, t.name) } : t),
            ...goneFields(gone.get(String(t.threadId)) ?? null),
        }));
    if (kind === "dm" || kind === "group") return titled(of(kind));
    return titled([...of("dm"), ...of("group")].sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0)));
}
