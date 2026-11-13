/**
 * Leaving a group, and disbanding one for everyone, the way Zalo does it. `group leave` / `group disperse`
 * and `zalo_group` leave / disperse share it.
 *
 * - **Leave** removes only this account. A member or deputy just leaves. The **owner** of a group that still has
 *   other members must say who owns it next: Zalo asks "Chọn trưởng nhóm mới trước khi rời" and, on a choice, calls
 *   `changeGroupOwner` and then `leaveGroup`. An older dialog still offered a plain leave, after which "Quyền trưởng
 *   nhóm sẽ được trao ngẫu nhiên cho thành viên khác" (Zalo picks a random member). Here that is `newOwner` or
 *   `randomOwner`; with neither, the leave is refused before anything is sent. An owner alone in the group just
 *   leaves.
 * - **Disperse** (disband) deletes the group for every member ("Mời tất cả mọi người rời nhóm và xóa tin nhắn? Nhóm đã
 *   giải tán sẽ KHÔNG THỂ khôi phục"). Only the owner can; anyone else is refused before anything is sent.
 *
 * Each is two halves so a caller can ask its confirmation in between: `plan…` reads the group and refuses what
 * cannot go ahead (nothing sent), `run…` sends. Neither writes zalo.db; the caller records the exit
 * (`recordOwnExit`, src/core/group-exit.js).
 */
import { getGroupInfoWatched } from "./group-exit.js";

/** Why a leave or disperse was refused before anything was sent (`code` on {@link GroupDepartureError}). */
export const DEPARTURE_CODES = Object.freeze({
    NOT_A_MEMBER: "not_a_member",
    OWNER_MUST_CHOOSE: "owner_must_choose",
    NOT_OWNER: "not_owner",
    BAD_NEW_OWNER: "bad_new_owner",
    CONFLICT: "conflicting_options",
});

/**
 * How to retry an owner's refused leave, in the caller's own words.
 *
 * @param {Error} e
 * @param {"cli"|"mcp"} surface
 * @returns {string} the error's message, with the options named for that surface
 */
export function departureMessage(e, surface) {
    if (e?.code !== DEPARTURE_CODES.OWNER_MUST_CHOOSE) return e?.message ?? String(e);
    return surface === "mcp"
        ? `${e.message} Call leave again with newOwner (a member's userId) or randomOwner: true, or use disperse.`
        : `${e.message} Run it again with --new-owner <userId> or --random-owner, or use \`group disperse\`.`;
}

/** A leave or disperse refused before anything was sent. */
export class GroupDepartureError extends Error {
    /**
     * @param {string} code - one of {@link DEPARTURE_CODES}
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = "GroupDepartureError";
        this.code = code;
    }
}

/**
 * This account's place in a group, from Zalo's group info.
 *
 * @param {object} api - logged-in session
 * @param {string} groupId
 * @param {string|null} ownId
 * @returns {Promise<{found: boolean, name: string|null, role: "owner"|"deputy"|"member"|null, creatorId: string|null,
 *   memberIds: string[], totalMember: number, others: number}>} `memberIds` is what Zalo listed (it can be fewer than
 *   `totalMember` in a big group); `others` counts the members besides this account
 */
export async function groupRole(api, groupId, ownId) {
    const gid = String(groupId);
    const result = await getGroupInfoWatched(api, ownId ? String(ownId) : null, [gid]);
    const g = result?.gridInfoMap?.[gid];
    if (!g) {
        return { found: false, name: null, role: null, creatorId: null, memberIds: [], totalMember: 0, others: 0 };
    }
    const memberIds = (Array.isArray(g.memVerList) ? g.memVerList : [])
        .map((mv) => String(mv).split("_")[0])
        .filter(Boolean);
    const totalMember = Number.isFinite(Number(g.totalMember)) ? Number(g.totalMember) : memberIds.length;
    const me = ownId ? String(ownId) : null;
    const creatorId = g.creatorId === undefined || g.creatorId === null ? null : String(g.creatorId);
    const adminIds = Array.isArray(g.adminIds) ? g.adminIds.map(String) : [];
    const role = !me ? null : creatorId === me ? "owner" : adminIds.includes(me) ? "deputy" : "member";
    const others = Math.max(0, totalMember - 1);
    return { found: true, name: g.name ?? null, role, creatorId, memberIds, totalMember, others };
}

/** "group <id>" or "group "Name" (<id>)". */
function label(groupId, name) {
    return name ? `group "${name}" (${groupId})` : `group ${groupId}`;
}

/**
 * Read the group and decide how this account leaves it; refuse, before anything is sent, what Zalo would not let
 * through.
 *
 * @param {object} api
 * @param {{groupId: string, ownId: string|null, newOwner?: string|null, randomOwner?: boolean}} opts
 * @returns {Promise<{groupId: string, name: string|null, role: string|null, others: number,
 *   handOver: "chosen"|"random"|null, newOwner: string|null}>}
 * @throws {GroupDepartureError}
 */
export async function planLeave(api, { groupId, ownId, newOwner = null, randomOwner = false }) {
    const gid = String(groupId);
    const next = newOwner === undefined || newOwner === null || newOwner === "" ? null : String(newOwner).trim();
    if (next && randomOwner) {
        throw new GroupDepartureError(DEPARTURE_CODES.CONFLICT, "Give a new owner or ask for a random one, not both.");
    }
    const info = await groupRole(api, gid, ownId);
    const where = label(gid, info.name);
    if (!info.found) {
        throw new GroupDepartureError(
            DEPARTURE_CODES.NOT_A_MEMBER,
            `This account is not in ${where} (already left, removed, or it was disbanded), so there is nothing to leave.`,
        );
    }
    const base = { groupId: gid, name: info.name, role: info.role, others: info.others };
    if (info.role !== "owner") {
        if (next || randomOwner) {
            throw new GroupDepartureError(
                DEPARTURE_CODES.NOT_OWNER,
                `Only the owner of ${where} chooses who owns it next; this account is ${info.role === "deputy" ? "a deputy" : "a member"}. Leave without a new owner.`,
            );
        }
        return { ...base, handOver: null, newOwner: null };
    }
    if (info.others === 0) {
        if (next) {
            throw new GroupDepartureError(
                DEPARTURE_CODES.BAD_NEW_OWNER,
                `This account is the only member of ${where}: there is nobody to hand it to.`,
            );
        }
        return { ...base, handOver: null, newOwner: null };
    }
    if (next) {
        if (!/^\d{1,30}$/.test(next)) {
            throw new GroupDepartureError(
                DEPARTURE_CODES.BAD_NEW_OWNER,
                `The new owner must be a numeric Zalo user id (got "${next}").`,
            );
        }
        if (ownId && next === String(ownId)) {
            throw new GroupDepartureError(
                DEPARTURE_CODES.BAD_NEW_OWNER,
                "The new owner must be another member, not this account.",
            );
        }
        // Zalo lists every member of a small group; in a big one the list can be partial, and Zalo decides.
        const complete = info.memberIds.length >= info.totalMember;
        if (complete && !info.memberIds.includes(next)) {
            throw new GroupDepartureError(
                DEPARTURE_CODES.BAD_NEW_OWNER,
                `${next} is not a member of ${where} (they may have just left). Choose a current member.`,
            );
        }
        return { ...base, handOver: "chosen", newOwner: next };
    }
    if (randomOwner) return { ...base, handOver: "random", newOwner: null };
    throw new GroupDepartureError(
        DEPARTURE_CODES.OWNER_MUST_CHOOSE,
        `This account owns ${where}, which has ${info.others} other member(s). Say who owns it after you leave: a new ` +
            "owner (a member's user id), or let Zalo give it to a random member. To delete the group for everyone " +
            "instead, disband it (disperse).",
    );
}

/**
 * Leave as planned: hand ownership over first when a new owner was chosen (`changeGroupOwner`, then
 * `leaveGroup`), else leave.
 *
 * @param {object} api
 * @param {Awaited<ReturnType<typeof planLeave>>} plan
 * @param {{silent?: boolean}} [opts]
 * @returns {Promise<{left: true, handOver: string|null, newOwner: string|null, memberError?: unknown[]}>}
 * @throws the Zalo error; when the hand-over went through and the leave did not, it carries `ownershipTransferred`
 */
export async function runLeave(api, plan, { silent = false } = {}) {
    if (plan.handOver === "chosen") await api.changeGroupOwner(plan.newOwner, plan.groupId);
    let res;
    try {
        res = await api.leaveGroup(plan.groupId, Boolean(silent));
    } catch (e) {
        if (plan.handOver === "chosen") {
            e.ownershipTransferred = plan.newOwner;
            e.message = `${plan.newOwner} now owns group ${plan.groupId}, but leaving it failed: ${e.message}`;
        }
        throw e;
    }
    const memberError = Array.isArray(res?.memberError) ? res.memberError : [];
    return {
        left: true,
        handOver: plan.handOver,
        newOwner: plan.newOwner,
        ...(memberError.length > 0 && { memberError }),
    };
}

/**
 * Read the group and refuse, before anything is sent, a disband this account cannot do: only the owner can.
 *
 * @param {object} api
 * @param {{groupId: string, ownId: string|null}} opts
 * @returns {Promise<{groupId: string, name: string|null, others: number}>}
 * @throws {GroupDepartureError}
 */
export async function planDisperse(api, { groupId, ownId }) {
    const gid = String(groupId);
    const info = await groupRole(api, gid, ownId);
    const where = label(gid, info.name);
    if (!info.found) {
        throw new GroupDepartureError(
            DEPARTURE_CODES.NOT_A_MEMBER,
            `This account is not in ${where} (already left, removed, or it was disbanded), so there is nothing to disband.`,
        );
    }
    if (info.role !== "owner") {
        throw new GroupDepartureError(
            DEPARTURE_CODES.NOT_OWNER,
            `Only the owner of ${where} can disband it for everyone; this account is ${info.role === "deputy" ? "a deputy" : info.role === "member" ? "a member" : "not known to be the owner"}. To leave it yourself, use leave.`,
        );
    }
    return { groupId: gid, name: info.name, others: info.others };
}

/**
 * Disband as planned: the group is deleted for every member.
 *
 * @param {object} api
 * @param {Awaited<ReturnType<typeof planDisperse>>} plan
 * @returns {Promise<{dispersed: true}>}
 */
export async function runDisperse(api, plan) {
    await api.disperseGroup(plan.groupId);
    return { dispersed: true };
}
