/**
 * Group administration, as the MCP tool `zalo_group` reads Zalo's answers.
 *
 * Pure reshapers: nothing here talks to Zalo or writes zalo.db. Members are
 * listed by `src/core/group-members.js`; this file covers what that one does
 * not: a group's own details, and the outcome of creating a group or changing
 * its membership.
 */
import { toIso } from "./friend-requests.js";

/** Zalo's error code for leaving a group the account is not in (zca-js documents it on `leaveGroup`). */
export const NOT_A_MEMBER = 166;

/** `zalo_group` actions that cannot be undone from the tool, and so ask for `confirm: true`. */
export const CONFIRMED_ACTIONS = Object.freeze(["leave", "remove_member"]);

/**
 * Whether `zalo_group` asks for `confirm: true` before an irreversible action.
 *
 * The check is a parameter, never a prompt: an automatic or headless caller
 * either sends `confirm: true` or switches the check off, and nothing waits for
 * a person. `ZALO_MCP_GROUP_CONFIRM` (`0`/`false`/`off`/`no` to disable,
 * `1`/`true`/`on`/`yes` to enable) wins over `groupConfirm` in mcp-config.json,
 * so a backend deployment can turn it off without editing the file. On by
 * default; anything unrecognized leaves it on.
 *
 * @param {object} [sources]
 * @param {{groupConfirm?: unknown}|null} [sources.config] - the loaded MCP config
 * @param {NodeJS.ProcessEnv} [sources.env] - environment, process.env by default
 * @returns {boolean}
 */
export function groupConfirmRequired({ config, env = process.env } = {}) {
    const fromEnv = String(env?.ZALO_MCP_GROUP_CONFIRM ?? "")
        .trim()
        .toLowerCase();
    if (["0", "false", "off", "no"].includes(fromEnv)) return false;
    if (["1", "true", "on", "yes"].includes(fromEnv)) return true;
    return config?.groupConfirm !== false;
}

/**
 * The details of one group out of `getGroupInfo`'s answer.
 *
 * Zalo answers `getGroupInfo([id])` with `gridInfoMap` keyed by group id; a
 * group the account is not in is simply absent. The member list is left out
 * on purpose (`zalo_get_group_members` owns it, with names); only its size is
 * reported.
 *
 * @param {object|null|undefined} result - what `api.getGroupInfo([groupId])` returned
 * @param {string} groupId
 * @returns {object|null} null when Zalo's answer does not include the group
 */
export function groupInfoFrom(result, groupId) {
    const g = result?.gridInfoMap?.[groupId];
    if (!g) return null;
    return {
        groupId: String(g.groupId ?? groupId),
        name: g.name ?? null,
        description: g.desc || null,
        type: g.type ?? null,
        creatorId: g.creatorId ?? null,
        adminIds: Array.isArray(g.adminIds) ? g.adminIds.map(String) : [],
        totalMember: g.totalMember ?? null,
        maxMember: g.maxMember ?? null,
        createdAt: toIso(g.createdTime),
        avatar: g.fullAvt || g.avt || null,
        visibility: g.visibility ?? null,
        pendingApproval: Array.isArray(g.pendingApprove?.uids) ? g.pendingApprove.uids.length : 0,
        settings: g.setting ?? null,
    };
}

/**
 * The outcome of `createGroup`.
 *
 * zca-js spells the success list `sucessMembers`; both spellings are read so a
 * fixed typo upstream does not empty it.
 *
 * @param {object|null|undefined} result
 * @param {string[]} requested - the member ids that were asked for
 * @returns {{groupId: string|null, added: string[], failed: string[]}}
 */
export function createdGroupFrom(result, requested) {
    const failed = (result?.errorMembers ?? []).map(String);
    const given = result?.sucessMembers ?? result?.successMembers;
    const added = Array.isArray(given) ? given.map(String) : requested.filter((id) => !failed.includes(id));
    return { groupId: result?.groupId ? String(result.groupId) : null, added, failed };
}

/**
 * The outcome of `addUserToGroup` / `removeUserFromGroup`: which of the
 * requested members Zalo refused, and why.
 *
 * `error_data` (add only) maps an error code to the ids it applies to.
 *
 * @param {object|null|undefined} result
 * @param {string[]} requested - the member ids that were asked for
 * @returns {{done: string[], failed: string[], errorData: Record<string, string[]>|null}}
 */
export function memberChangeFrom(result, requested) {
    const failed = (result?.errorMembers ?? []).map(String);
    const data = result?.error_data;
    const errorData = data && typeof data === "object" && Object.keys(data).length > 0 ? data : null;
    return { done: requested.filter((id) => !failed.includes(id)), failed, errorData };
}
