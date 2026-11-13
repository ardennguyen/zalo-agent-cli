/**
 * The groups this account shares with one user, as Zalo PC shows them: "Nhóm chung (N)" on a profile and in a new
 * chat, for friends and strangers alike.
 *
 * PC reads them from the profile's extra fields (`/api/social/profile/extra`, cmd 11864: `groupIds`), the read
 * `profile-extra` here (src/zalo/reads.js), and leaves out a group that is a hidden chat
 * (`checkHiddenChatByPureGroupId`). Names come from the groups' own info. Nothing here writes zalo.db.
 */
import { callRead } from "../zalo/reads.js";
import { getGroupInfoWatched } from "./group-exit.js";

/** Group ids per group-info request when naming them. */
const NAME_BATCH = 50;

/**
 * The names of some groups, from their info; a group whose name could not be read is absent. Never throws.
 *
 * @param {object} api
 * @param {string[]} groupIds
 * @param {{ownId?: string|null}} [opts]
 * @returns {Promise<Map<string, string>>}
 */
export async function groupNames(api, groupIds, { ownId = null } = {}) {
    const nameOf = new Map();
    const ids = [...new Set(groupIds.map(String))];
    for (let i = 0; i < ids.length; i += NAME_BATCH) {
        const batch = ids.slice(i, i + NAME_BATCH);
        try {
            const res = await getGroupInfoWatched(api, ownId ? String(ownId) : null, batch);
            for (const id of batch) {
                const name = res?.gridInfoMap?.[id]?.name;
                if (name) nameOf.set(id, String(name));
            }
        } catch {
            /* names are a courtesy: the ids and the count stand without them */
        }
    }
    return nameOf;
}

/**
 * The groups shared with `userId`.
 *
 * @param {object} api - logged-in session
 * @param {string} userId
 * @param {object} [opts]
 * @param {string|null} [opts.ownId] - for the group-info watch (a group answered as gone is recorded)
 * @param {{isHidden: (id: string) => boolean}|null} [opts.hidden] - hidden chats to leave out, as PC does; null keeps all
 * @param {boolean} [opts.names] - also read the groups' names (default true)
 * @returns {Promise<{count: number, groups: {groupId: string, name: string|null}[], hiddenLeftOut: number}>}
 * @throws Zalo's error when the profile read fails
 */
export async function mutualGroupsOf(api, userId, { ownId = null, hidden = null, names = true } = {}) {
    const data = await callRead(api, "profile-extra", { id: String(userId) });
    const all = [...new Set((Array.isArray(data?.groupIds) ? data.groupIds : []).map(String).filter(Boolean))];
    const shown = hidden ? all.filter((id) => !hidden.isHidden(id)) : all;
    const nameOf = names ? await groupNames(api, shown, { ownId }) : new Map();
    return {
        count: shown.length,
        groups: shown.map((groupId) => ({ groupId, name: nameOf.get(groupId) ?? null })),
        hiddenLeftOut: all.length - shown.length,
    };
}

/**
 * {@link mutualGroupsOf} for a reply that must not fail because of it: the result, or `{error}`.
 *
 * @param {object} api
 * @param {string|null|undefined} userId
 * @param {Parameters<typeof mutualGroupsOf>[2]} [opts]
 * @returns {Promise<Awaited<ReturnType<typeof mutualGroupsOf>>|{error: string}|null>} null without a user id
 */
export async function mutualGroupsOrError(api, userId, opts) {
    if (userId === undefined || userId === null || userId === "") return null;
    try {
        return await mutualGroupsOf(api, userId, opts);
    } catch (e) {
        return { error: `could not read the shared groups: ${e.message}` };
    }
}

/**
 * The line a person reads: "2 mutual groups: A, B" / "No mutual groups".
 *
 * @param {Awaited<ReturnType<typeof mutualGroupsOrError>>} m
 * @returns {string}
 */
export function mutualGroupsLine(m) {
    if (!m) return "Mutual groups: ?";
    if (m.error) return `Mutual groups: ? (${m.error})`;
    if (m.count === 0) return "No mutual groups";
    const list = m.groups.map((g) => (g.name ? `${g.name} (${g.groupId})` : g.groupId)).join(", ");
    return `${m.count} mutual group${m.count === 1 ? "" : "s"}: ${list}`;
}
