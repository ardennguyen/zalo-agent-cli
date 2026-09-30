/**
 * Who is in a group, and what Zalo calls them.
 *
 * `group members` and the MCP tool `zalo_get_group_members` list members
 * through the same function, and `msg send` and that tool name uncached
 * members through the same lookup, so the CLI and an agent see one answer.
 * Nothing here writes zalo.db: its only writers are the listener, sync and
 * `msg history`'s fetch (AGENTS.md §13), so a name looked up here is used for
 * the call that looked it up and then forgotten.
 */

/**
 * A group's member uids, the way `group members` lists them.
 *
 * `getGroupInfo` takes an array, not a bare id. Its `memberIds` field is
 * always empty; the uids ride in `memVerList` as `"<uid>_<version>"` strings
 * (e.g. `"1000000000000000001_0"`).
 *
 * @param {object} api - logged-in zca-js api
 * @param {string} groupId
 * @returns {Promise<{found: boolean, name: string|null, uids: string[], totalMember: number}>}
 *   `found` is false when Zalo's answer does not include the group at all;
 *   `totalMember` is Zalo's own count, which can exceed `uids.length`
 */
export async function groupMemberUids(api, groupId) {
    const result = await api.getGroupInfo([groupId]);
    const groupData = result?.gridInfoMap?.[groupId];
    const memVerList = groupData?.memVerList || [];
    const uids = memVerList.map((mv) => mv.split("_")[0]).filter(Boolean);
    const totalMember = groupData?.totalMember ?? uids.length;
    return { found: Boolean(groupData), name: groupData?.name ?? null, uids, totalMember };
}

/**
 * Ask Zalo for the display names of some users (`getGroupMembersInfo`).
 *
 * Zalo Web fetches member profiles the same way when it shows a member list:
 * one request at a time, a bounded number of ids per request. zca-js sends
 * the ids in the request URL, so `batchSize` keeps a large group's lookup from
 * outgrowing one URL. Keys come back as the uid, sometimes with zca-js's
 * `_0` version suffix; the name is `displayName`, else `zaloName`.
 *
 * Never throws. A batch that fails leaves its uids unnamed and is reported in
 * `errors`, and the batches after it still run.
 *
 * @param {object} api - logged-in zca-js api
 * @param {string[]} uids
 * @param {{batchSize?: number}} [opts] - ids per request; all of them in one request by default
 * @returns {Promise<{names: Map<string, string>, errors: string[]}>} uid → display name, for those found
 */
export async function fetchMemberNames(api, uids, { batchSize = Infinity } = {}) {
    const names = new Map();
    const errors = [];
    const size = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : uids.length;
    for (let i = 0; i < uids.length; i += size) {
        try {
            const profiles = (await api.getGroupMembersInfo(uids.slice(i, i + size)))?.profiles || {};
            for (const [key, profile] of Object.entries(profiles)) {
                const uid = String(key).replace(/_0$/, "");
                const name = profile?.displayName || profile?.zaloName;
                if (name) names.set(uid, name);
            }
        } catch (e) {
            errors.push(e?.message || String(e));
        }
    }
    return { names, errors };
}
