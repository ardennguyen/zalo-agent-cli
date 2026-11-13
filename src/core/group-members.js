/**
 * Who is in a group, and what Zalo calls them.
 *
 * `group members` and the MCP tool `zalo_get_group_members` list members
 * through the same function, and `msg send` and that tool name uncached
 * members through the same lookup, so the CLI and an agent see one answer.
 * No name is written to zalo.db: its only writers are the listener, sync and
 * `msg history`'s fetch (AGENTS.md §13), so a name looked up here is used for
 * the call that looked it up and then forgotten. The one write is a group's
 * exit, when Zalo answers it as disbanded or not ours (src/core/group-exit.js).
 */

import { getGroupInfoWatched } from "./group-exit.js";

/**
 * A group's member uids, the way `group members` lists them.
 *
 * `getGroupInfo` takes an array, not a bare id. Its `memberIds` field is
 * always empty; the uids ride in `memVerList` as `"<uid>_<version>"` strings
 * (e.g. `"1000000000000000001_0"`).
 *
 * A group Zalo answers as disbanded (`removedsGroup`, 161) or not ours (not-a-member) is recorded as gone with the
 * open cache (src/core/group-exit.js), as Zalo does on the same answers.
 *
 * @param {object} api - logged-in session
 * @param {string} groupId
 * @returns {Promise<{found: boolean, name: string|null, uids: string[], totalMember: number}>}
 *   `found` is false when Zalo's answer does not include the group at all;
 *   `totalMember` is Zalo's own count, which can exceed `uids.length`
 */
export async function groupMemberUids(api, groupId) {
    let ownId = null;
    try {
        ownId = api.getOwnId?.() ?? null;
    } catch {
        /* no session id: nothing watched */
    }
    const result = await getGroupInfoWatched(api, ownId === null ? null : String(ownId), [String(groupId)]);
    const groupData = result?.gridInfoMap?.[groupId];
    const memVerList = groupData?.memVerList || [];
    const uids = memVerList.map((mv) => mv.split("_")[0]).filter(Boolean);
    const totalMember = groupData?.totalMember ?? uids.length;
    return { found: Boolean(groupData), name: groupData?.name ?? null, uids, totalMember };
}

/**
 * Ask Zalo for the display names of some users (`getGroupMembersInfo`).
 *
 * Member profiles are fetched the way Zalo shows a member list:
 * one request at a time, a bounded number of ids per request. The ids go
 * in the request URL, so `batchSize` keeps a large group's lookup from
 * outgrowing one URL. Keys come back as the uid, sometimes with the
 * `_0` version suffix; the name is `displayName`, else `zaloName`.
 *
 * Never throws. A batch that fails leaves its uids unnamed and is reported in
 * `errors`, and the batches after it still run.
 *
 * @param {object} api - logged-in session
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
