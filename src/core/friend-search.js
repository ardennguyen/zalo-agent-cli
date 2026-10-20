/**
 * Friend search, as `friend search` reads it.
 *
 * A friend can be known by three names: the profile name Zalo shows
 * (`displayName`), the name they gave themselves (`zaloName`), and the alias
 * the account owner set for them. The alias lives in a separate list
 * (`getAliasList`), so `getAllFriends` alone never contains it, and a search
 * on the first two names cannot find a friend the owner saved as "Arden AI".
 * `zalo_search_threads` already honors aliases through the thread-name cache;
 * this gives the CLI the same reach.
 *
 * Pure: nothing here talks to Zalo.
 */

/**
 * The friends whose display name, Zalo name or alias contains `query`
 * (case-insensitive substring, as before).
 *
 * Each match is a copy of the friend with an `alias` field added when the
 * owner has set one, so callers can show why it matched.
 *
 * @param {object[]} friends - `getAllFriends` entries
 * @param {Map<string, string>} aliases - uid → the owner's alias for that friend
 * @param {string} query
 * @returns {object[]}
 */
export function searchFriends(friends, aliases, query) {
    const q = String(query).toLowerCase();
    const hit = (s) =>
        String(s || "")
            .toLowerCase()
            .includes(q);
    const matches = [];
    for (const f of Array.isArray(friends) ? friends : []) {
        const alias = aliases?.get(String(f.userId)) ?? "";
        if (hit(f.displayName) || hit(f.zaloName) || hit(alias)) {
            matches.push(alias ? { ...f, alias } : f);
        }
    }
    return matches;
}
