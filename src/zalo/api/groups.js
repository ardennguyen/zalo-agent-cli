/**
 * Groups: reading groups and their members, creating and leaving them, membership, admins, blocked members, invite
 * links, the invitation box, communities, and the group avatar (agent/docs/zca-replace/spec-groups.md and
 * spec-sweep.md 1.2/1.3).
 *
 * Every call is one session request (kernel/endpoint.js) shaped as Zalo Web 26.11.10 sends it: the group domain
 * (`group` service key) unless noted, the encrypted `params` in the query of a GET or in the form body of a POST,
 * and the body keys in the Web's order. Where the Web differs from what this engine sent before 3.0.0, the Web wins:
 *
 * - `getAllGroups` asks the `group` host (Web `getGroupListV4`), not `group_poll`.
 * - `getGroupMembersInfo` is a form POST (Web `getMemberInGroup`), in batches of at most 300 ids.
 * - `getGroupInfo` asks in batches of at most 100 groups (Web `num_max_group_a_req`) and merges the answers.
 * - `createGroup` is a GET with `memberTypes` and `groupType` 1 (a normal group), without `zsource`, and leaves the
 *   own account out of `members` (Web `createGroupV2` and its compose dialog).
 * - `changeGroupOwner` is a form POST (Web 10063).
 * - `disperseGroup` sends `{imei, grid}` in that order (Web 11832).
 * - `changeGroupAvatar` sends `avatarSize` 160 and a `clientId` of the own uid plus the local time, keys in the
 *   Web's order (Web `updateAvatar`, 11195).
 * - `getGroupLinkInfo` and `getGroupInviteBoxList` ask for 160 px avatars (the Web's avatar size).
 * - An empty group name is refused before any request (`createGroup`, `changeGroupName`) instead of being replaced
 *   by a timestamp.
 *
 * Replies are returned as Zalo sends them (the inner `data`), so `--json` output keeps its shape. Zalo's errors keep
 * their numeric `.code` (165 not in the group, 166/167 not a member, ...), which the MCP tools map to messages.
 * Ids stay strings.
 */
import { readFile } from "node:fs/promises";
import { ZaloApiError } from "../errors.js";
import { CallUsageError } from "../kernel/endpoint.js";

/** Groups per `getmg-v2` request (Web `group_config.num_max_group_a_req`). */
export const GROUP_INFO_BATCH = 100;

/** Member ids per `social/group/members` request (Web `group_config.num_max_member_a_req`). */
export const MEMBER_INFO_BATCH = 300;

/** The avatar size the Web asks for and uploads with. */
export const GROUP_AVATAR_SIZE = 160;

/** `memberTypes` entry of a member added from the friend list (Web `MEMBERS_TRACKING_SOURCE.friend`). */
export const MEMBER_TYPE_FRIEND = -1;

/** `groupType` of a normal group, as the Web's compose dialog creates it (a community is 2). */
export const GROUP_TYPE_NORMAL = 1;

/** `srcInteraction` of an invitation made from a contact's context menu (Web `MULTI_GROUP_INTERACTION_SRC`). */
export const INTERACTION_CONTEXT_MENU = 2;

/** Width and height sent for an avatar whose size could not be read. */
const DEFAULT_AVATAR_EDGE = 1080;

/** A value or a list of values, as a list. */
const listOf = (v) => (Array.isArray(v) ? v : [v]);

/** The list split into runs of at most `size`. */
function chunks(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

/** A sealed GET on the group domain. */
const groupGet = (path, cmd, body) => Object.freeze({ host: "group", path, cmd, method: "get", body });

/** A sealed form POST on the group domain. */
const groupPost = (path, cmd, body) => Object.freeze({ host: "group", path, cmd, method: "post", body });

/** `POST {group}/api/group/getmg-v2`: groups by id, each at version 0 ("send me everything"). */
export const GROUP_INFO = groupPost("/api/group/getmg-v2", 12028, ({ groupIds }) => ({
    gridVerMap: JSON.stringify(Object.fromEntries(groupIds.map((id) => [id, 0]))),
}));

/** `GET {group}/api/group/getlg/v4`: every group of the account, with its version. No params. */
export const GROUP_LIST = Object.freeze({ host: "group", path: "/api/group/getlg/v4", cmd: 12027, method: "get" });

/** `POST {profile}/api/social/group/members`: member profiles by `<uid>_0`. */
export const GROUP_MEMBERS = Object.freeze({
    host: "profile",
    path: "/api/social/group/members",
    cmd: 12030,
    method: "post",
    body: ({ keys }) => ({ friend_pversion_map: keys }),
});

/** `GET {group}/api/group/create/v2`. */
export const GROUP_CREATE = groupGet("/api/group/create/v2", 12443, (a, ctx) => ({
    clientId: a.clientId,
    gname: a.name,
    gdesc: null,
    members: a.members,
    memberTypes: a.members.map(() => MEMBER_TYPE_FRIEND),
    nameChanged: 1,
    createLink: 1,
    clientLang: ctx.language,
    imei: ctx.imei,
    groupType: GROUP_TYPE_NORMAL,
}));

/** `POST {group}/api/group/invite/v2`. */
export const GROUP_INVITE = groupPost("/api/group/invite/v2", 12444, (a, ctx) => ({
    grid: a.groupId,
    members: a.members,
    memberTypes: a.members.map(() => MEMBER_TYPE_FRIEND),
    imei: ctx.imei,
    clientLang: ctx.language,
}));

/** `POST {group}/api/group/kickout`. */
export const GROUP_KICKOUT = groupPost("/api/group/kickout", 11187, (a, ctx) => ({
    grid: a.groupId,
    members: a.members,
    imei: ctx.imei,
}));

/** `POST {group}/api/group/leave`: one group per call. */
export const GROUP_LEAVE = groupPost("/api/group/leave", 11189, (a, ctx) => ({
    grids: [a.groupId],
    imei: ctx.imei,
    silent: a.silent ? 1 : 0,
    language: ctx.language,
}));

/** `POST {group}/api/group/updateinfo`: the group's name. */
export const GROUP_RENAME = groupPost("/api/group/updateinfo", 11188, (a, ctx) => ({
    grid: a.groupId,
    gname: a.name,
    imei: ctx.imei,
}));

/** `GET {group}/api/group/admins/add`. */
export const GROUP_ADMINS_ADD = groupGet("/api/group/admins/add", 11814, (a, ctx) => ({
    grid: a.groupId,
    members: a.members,
    imei: ctx.imei,
}));

/** `GET {group}/api/group/admins/remove`. */
export const GROUP_ADMINS_REMOVE = groupGet("/api/group/admins/remove", 11815, (a, ctx) => ({
    grid: a.groupId,
    members: a.members,
    imei: ctx.imei,
}));

/** `POST {group}/api/group/change-owner` (a POST on the Web, spec-sweep 1.3). */
export const GROUP_CHANGE_OWNER = groupPost("/api/group/change-owner", 10063, (a, ctx) => ({
    grid: a.groupId,
    newAdminId: a.memberId,
    imei: ctx.imei,
    language: ctx.language,
}));

/** `GET {group}/api/group/blockedmems/add`. */
export const GROUP_BLOCK = groupGet("/api/group/blockedmems/add", 11812, (a) => ({
    grid: a.groupId,
    members: a.members,
}));

/** `GET {group}/api/group/blockedmems/remove`. */
export const GROUP_UNBLOCK = groupGet("/api/group/blockedmems/remove", 11813, (a) => ({
    grid: a.groupId,
    members: a.members,
}));

/** `GET {group}/api/group/blockedmems/list`. */
export const GROUP_BLOCKED_LIST = groupGet("/api/group/blockedmems/list", 11811, (a, ctx) => ({
    grid: a.groupId,
    page: a.page,
    count: a.count,
    imei: ctx.imei,
}));

/** `GET {group}/api/group/upgrade/community`: `grId`, with a capital I, is Zalo's spelling. */
export const GROUP_UPGRADE_COMMUNITY = groupGet("/api/group/upgrade/community", 12180, (a, ctx) => ({
    grId: a.groupId,
    language: ctx.language,
}));

/** `GET {group}/api/group/link/join`. */
export const GROUP_LINK_JOIN = groupGet("/api/group/link/join", 11825, (a, ctx) => ({
    link: a.link,
    clientLang: ctx.language,
}));

/** `GET {group}/api/group/pending-mems/list`. */
export const GROUP_PENDING_LIST = groupGet("/api/group/pending-mems/list", 10064, (a, ctx) => ({
    grid: a.groupId,
    imei: ctx.imei,
}));

/** `GET {group}/api/group/pending-mems/review`: `isApprove` 1 approves, 0 rejects. */
export const GROUP_PENDING_REVIEW = groupGet("/api/group/pending-mems/review", 10065, (a) => ({
    grid: a.groupId,
    members: a.members,
    isApprove: a.approve ? 1 : 0,
}));

/** `GET {group}/api/group/link/new`: a new invite link (Web `renewGroupLink`). */
export const GROUP_LINK_NEW = groupGet("/api/group/link/new", 11822, (a, ctx) => ({
    grid: a.groupId,
    imei: ctx.imei,
}));

/** `GET {group}/api/group/link/disable`. */
export const GROUP_LINK_DISABLE = groupGet("/api/group/link/disable", 11823, (a) => ({ grid: a.groupId }));

/** `GET {group}/api/group/link/detail`. */
export const GROUP_LINK_DETAIL = groupGet("/api/group/link/detail", 11821, (a, ctx) => ({
    grid: a.groupId,
    imei: ctx.imei,
}));

/** `GET {group}/api/group/link/ginfo`: a group seen through its invite link, before joining. */
export const GROUP_LINK_INFO = groupGet("/api/group/link/ginfo", 11824, (a) => ({
    link: a.link,
    avatar_size: GROUP_AVATAR_SIZE,
    member_avatar_size: GROUP_AVATAR_SIZE,
    mpage: a.memberPage,
}));

/** `GET {group}/api/group/inv-box/list`: the invitations the account has received. */
export const GROUP_INVITE_BOX_LIST = groupGet("/api/group/inv-box/list", 12170, (a) => ({
    mpage: a.mpage,
    page: a.page,
    invPerPage: a.invPerPage,
    mcount: a.mcount,
    lastGroupId: a.lastGroupId,
    avatar_size: GROUP_AVATAR_SIZE,
    member_avatar_size: GROUP_AVATAR_SIZE,
}));

/** `GET {group}/api/group/inv-box/join`. */
export const GROUP_INVITE_BOX_JOIN = groupGet("/api/group/inv-box/join", 12172, (a, ctx) => ({
    grid: a.groupId,
    lang: ctx.language,
}));

/** `GET {group}/api/group/inv-box/mdel-inv`: `invitations` is a JSON string of `[{grid}]`. */
export const GROUP_INVITE_BOX_DELETE = groupGet("/api/group/inv-box/mdel-inv", 12171, (a) => ({
    invitations: JSON.stringify(a.groupIds.map((grid) => ({ grid }))),
    block: a.block ? 1 : 0,
}));

/** `GET {group}/api/group/invite/multi`: one user into several groups. */
export const GROUP_INVITE_MULTI = groupGet("/api/group/invite/multi", 12605, (a, ctx) => ({
    grids: a.groupIds,
    member: a.memberId,
    memberType: MEMBER_TYPE_FRIEND,
    srcInteraction: INTERACTION_CONTEXT_MENU,
    clientLang: ctx.language,
}));

/** `POST {group}/api/group/disperse`: `imei` first, as the Web writes it. */
export const GROUP_DISPERSE = groupPost("/api/group/disperse", 11832, (a, ctx) => ({
    imei: ctx.imei,
    grid: a.groupId,
}));

/** `POST {file}/api/group/upavatar`: sealed params in the query, the image as the multipart part `fileContent`. */
export const GROUP_AVATAR = Object.freeze({
    host: "file",
    path: "/api/group/upavatar",
    cmd: 11195,
    method: "multipart",
    body: (a, ctx) => ({
        grid: a.groupId,
        avatarSize: GROUP_AVATAR_SIZE,
        clientId: a.clientId,
        originWidth: a.width,
        originHeight: a.height,
        imei: ctx.imei,
    }),
    file: (a) => ({ field: "fileContent", filename: "blob", type: "image/jpeg", bytes: a.bytes }),
});

/**
 * A local time as the Web stamps an avatar's `clientId`: `HH:MM DD/MM/YYYY`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function avatarTimeText(ms) {
    const t = new Date(ms);
    const two = (n) => String(n).padStart(2, "0");
    return `${two(t.getHours())}:${two(t.getMinutes())} ${two(t.getDate())}/${two(t.getMonth() + 1)}/${t.getFullYear()}`;
}

/**
 * Refuse an empty group name before any request.
 *
 * @param {unknown} name
 * @returns {string}
 * @throws {CallUsageError}
 */
function requireName(name) {
    if (typeof name !== "string" || name.trim() === "") throw new CallUsageError("A group name must not be empty");
    return name;
}

/**
 * The bytes and the dimensions of an avatar given as a file path or as `{data, metadata: {width, height}}`.
 *
 * @param {object} ctx - the session (`options.imageMetadataGetter` reads a file's dimensions)
 * @param {string|{data: Uint8Array, metadata?: {width?: number, height?: number}}} source
 * @returns {Promise<{bytes: Uint8Array, width: number, height: number}>}
 * @throws {ZaloApiError} when a path is given and the session cannot read image dimensions
 */
async function avatarOf(ctx, source) {
    let bytes;
    let meta;
    if (typeof source === "string") {
        const getter = ctx.options?.imageMetadataGetter;
        if (typeof getter !== "function") {
            throw new ZaloApiError("Cannot read the image's dimensions: the session has no imageMetadataGetter");
        }
        meta = await getter(source);
        if (!meta) throw new ZaloApiError("Failed to get image metadata");
        bytes = await readFile(source);
    } else if (source && typeof source === "object" && source.data) {
        bytes = source.data;
        meta = source.metadata ?? {};
    } else {
        throw new CallUsageError("changeGroupAvatar needs a file path or {data, metadata}");
    }
    return {
        bytes,
        width: meta.width || DEFAULT_AVATAR_EDGE,
        height: meta.height || DEFAULT_AVATAR_EDGE,
    };
}

/**
 * The group calls, bound to one session handle.
 *
 * @param {import("../api.js").Session} s
 * @returns {Record<string, Function>}
 */
export function groupMethods(s) {
    return {
        /**
         * Groups by id, at version 0 (everything). Asked in batches of 100; the answers are merged.
         *
         * @param {string|string[]} groupId - one group id or a list
         * @returns {Promise<{removedsGroup?: string[], unchangedsGroup?: string[], gridInfoMap: object}>}
         */
        getGroupInfo: async (groupId) => {
            const groupIds = listOf(groupId);
            const batches = chunks(groupIds, GROUP_INFO_BATCH);
            if (batches.length <= 1) return s.call(GROUP_INFO, { groupIds });
            const merged = { removedsGroup: [], unchangedsGroup: [], gridInfoMap: {} };
            for (const batch of batches) {
                const part = (await s.call(GROUP_INFO, { groupIds: batch })) ?? {};
                merged.removedsGroup.push(...(part.removedsGroup ?? []));
                merged.unchangedsGroup.push(...(part.unchangedsGroup ?? []));
                Object.assign(merged.gridInfoMap, part.gridInfoMap ?? {});
            }
            return merged;
        },

        /**
         * Every group the account is in.
         *
         * @returns {Promise<{version: string, gridVerMap: Record<string, string>}>}
         */
        getAllGroups: () => s.call(GROUP_LIST, {}),

        /**
         * Member profiles. Each id is asked as `<uid>_0` (an id already ending in `_0` is kept as it is), in
         * batches of 300; the answers are merged.
         *
         * @param {string|string[]} memberId - one user id or a list
         * @returns {Promise<{profiles: Record<string, object>, unchangeds_profile?: string[]}>}
         */
        getGroupMembersInfo: async (memberId) => {
            const keys = listOf(memberId).map((id) => (String(id).endsWith("_0") ? id : `${id}_0`));
            const batches = chunks(keys, MEMBER_INFO_BATCH);
            if (batches.length <= 1) return s.call(GROUP_MEMBERS, { keys });
            const merged = { profiles: {}, unchangeds_profile: [] };
            for (const batch of batches) {
                const part = (await s.call(GROUP_MEMBERS, { keys: batch })) ?? {};
                Object.assign(merged.profiles, part.profiles ?? {});
                merged.unchangeds_profile.push(...(part.unchangeds_profile ?? []));
            }
            return merged;
        },

        /**
         * Create a normal group. The own account is not listed as a member (Zalo adds the creator).
         *
         * @param {{name: string, members: string[]}} options - a non-empty name, at least one other member
         * @returns {Promise<{groupId: string, sucessMembers?: string[], errorMembers?: string[], error_data?: object}>}
         *   `sucessMembers` is Zalo's own spelling
         * @throws {CallUsageError} for an empty name or no member, before any request
         */
        createGroup: async (options) => {
            const own = String(s.ctx.uid ?? "");
            const members = listOf(options?.members ?? []).filter((id) => String(id) !== own);
            if (members.length === 0) throw new CallUsageError("Group must have at least one member");
            const name = requireName(options?.name);
            return s.call(GROUP_CREATE, { clientId: s.nextClientId(), name, members });
        },

        /**
         * Add members to a group.
         *
         * @param {string|string[]} memberId - one user id or a list
         * @param {string} groupId
         * @returns {Promise<{errorMembers: string[], error_data: object}>}
         */
        addUserToGroup: (memberId, groupId) => s.call(GROUP_INVITE, { groupId, members: listOf(memberId) }),

        /**
         * Remove members from a group. Zalo answers 165 for a user not in the group, 166 without the right.
         *
         * @param {string|string[]} memberId - one user id or a list
         * @param {string} groupId
         * @returns {Promise<{errorMembers: string[]}>}
         */
        removeUserFromGroup: (memberId, groupId) => s.call(GROUP_KICKOUT, { groupId, members: listOf(memberId) }),

        /**
         * Leave a group. Zalo answers 166 or 167 when the account is not a member.
         *
         * @param {string} groupId
         * @param {boolean} [silent] - leave without telling the group
         * @returns {Promise<{memberError: string[]}>}
         */
        leaveGroup: (groupId, silent = false) => s.call(GROUP_LEAVE, { groupId, silent }),

        /**
         * Rename a group.
         *
         * @param {string} name - the new name, not empty
         * @param {string} groupId
         * @returns {Promise<unknown>}
         * @throws {CallUsageError} for an empty name, before any request
         */
        changeGroupName: async (name, groupId) => s.call(GROUP_RENAME, { groupId, name: requireName(name) }),

        /**
         * Change a group's avatar.
         *
         * @param {string|{data: Uint8Array, metadata?: {width?: number, height?: number}}} avatarSource - an image
         *   file path (its dimensions read by the session's `imageMetadataGetter`), or the bytes and dimensions
         * @param {string} groupId
         * @returns {Promise<unknown>}
         */
        changeGroupAvatar: async (avatarSource, groupId) => {
            const { bytes, width, height } = await avatarOf(s.ctx, avatarSource);
            const clientId = `${s.ctx.uid ?? ""}${avatarTimeText(s.now())}`;
            return s.call(GROUP_AVATAR, { groupId, bytes, width, height, clientId });
        },

        /**
         * Make members deputies (admins) of a group.
         *
         * @param {string|string[]} memberId - one user id or a list
         * @param {string} groupId
         * @returns {Promise<unknown>}
         */
        addGroupDeputy: (memberId, groupId) => s.call(GROUP_ADMINS_ADD, { groupId, members: listOf(memberId) }),

        /**
         * Take deputy (admin) rights away from members.
         *
         * @param {string|string[]} memberId - one user id or a list
         * @param {string} groupId
         * @returns {Promise<unknown>}
         */
        removeGroupDeputy: (memberId, groupId) => s.call(GROUP_ADMINS_REMOVE, { groupId, members: listOf(memberId) }),

        /**
         * Hand the group's ownership to a member.
         *
         * @param {string} memberId - the new owner
         * @param {string} groupId
         * @returns {Promise<unknown>}
         */
        changeGroupOwner: (memberId, groupId) => s.call(GROUP_CHANGE_OWNER, { groupId, memberId }),

        /**
         * Block members from a group.
         *
         * @param {string|string[]} memberId - one user id or a list
         * @param {string} groupId
         * @returns {Promise<unknown>}
         */
        addGroupBlockedMember: (memberId, groupId) => s.call(GROUP_BLOCK, { groupId, members: listOf(memberId) }),

        /**
         * Unblock members of a group.
         *
         * @param {string|string[]} memberId - one user id or a list
         * @param {string} groupId
         * @returns {Promise<unknown>}
         */
        removeGroupBlockedMember: (memberId, groupId) => s.call(GROUP_UNBLOCK, { groupId, members: listOf(memberId) }),

        /**
         * One page of a group's blocked members.
         *
         * @param {{page?: number, count?: number}} payload - page 1 and 50 a page by default
         * @param {string} groupId
         * @returns {Promise<{blocked_members: object[], has_more: number}>}
         */
        getGroupBlockedMember: (payload, groupId) =>
            s.call(GROUP_BLOCKED_LIST, { groupId, page: payload?.page ?? 1, count: payload?.count ?? 50 }),

        /**
         * Turn a group into a community.
         *
         * @param {string} groupId
         * @returns {Promise<unknown>}
         */
        upgradeGroupToCommunity: (groupId) => s.call(GROUP_UPGRADE_COMMUNITY, { groupId }),

        /**
         * Join a group by its invite link.
         *
         * @param {string} link
         * @returns {Promise<unknown>}
         */
        joinGroupLink: (link) => s.call(GROUP_LINK_JOIN, { link }),

        /**
         * The requests waiting for an admin's approval.
         *
         * @param {string} groupId
         * @returns {Promise<{users: object[]}>}
         */
        getPendingGroupMembers: (groupId) => s.call(GROUP_PENDING_LIST, { groupId }),

        /**
         * Approve or reject pending requests.
         *
         * @param {{members: string|string[], isApprove: boolean}} payload
         * @param {string} groupId
         * @returns {Promise<Record<string, number>>}
         */
        reviewPendingMemberRequest: (payload, groupId) =>
            s.call(GROUP_PENDING_REVIEW, {
                groupId,
                members: listOf(payload?.members ?? []),
                approve: Boolean(payload?.isApprove),
            }),

        /**
         * Make a new invite link for a group (the old one stops working).
         *
         * @param {string} groupId
         * @returns {Promise<{link: string, expiration_date: number, enabled: number}>}
         */
        enableGroupLink: (groupId) => s.call(GROUP_LINK_NEW, { groupId }),

        /**
         * Turn a group's invite link off.
         *
         * @param {string} groupId
         * @returns {Promise<unknown>}
         */
        disableGroupLink: (groupId) => s.call(GROUP_LINK_DISABLE, { groupId }),

        /**
         * A group's invite link and whether it is on.
         *
         * @param {string} groupId
         * @returns {Promise<{link?: string, expiration_date?: number, enabled: number}>}
         */
        getGroupLinkDetail: (groupId) => s.call(GROUP_LINK_DETAIL, { groupId }),

        /**
         * A group seen through its invite link, without joining.
         *
         * @param {{link: string, memberPage?: number}} payload - the member page is 1 by default
         * @returns {Promise<object>}
         */
        getGroupLinkInfo: (payload) =>
            s.call(GROUP_LINK_INFO, { link: payload?.link, memberPage: payload?.memberPage ?? 1 }),

        /**
         * The group invitations the account has received.
         *
         * @param {{mpage?: number, page?: number, invPerPage?: number, mcount?: number, lastGroupId?: string|null}}
         *   [payload] - member page 1, page 0, 12 a page and 10 members each by default (the Web's config defaults)
         * @returns {Promise<{invitations: object[], total: number, hasMore: boolean}>}
         */
        getGroupInviteBoxList: (payload) =>
            s.call(GROUP_INVITE_BOX_LIST, {
                mpage: payload?.mpage ?? 1,
                page: payload?.page ?? 0,
                invPerPage: payload?.invPerPage ?? 12,
                mcount: payload?.mcount ?? 10,
                lastGroupId: payload?.lastGroupId ?? null,
            }),

        /**
         * Accept an invitation from the invitation box.
         *
         * @param {string} groupId
         * @returns {Promise<unknown>}
         */
        joinGroupInviteBox: (groupId) => s.call(GROUP_INVITE_BOX_JOIN, { groupId }),

        /**
         * Delete invitations from the invitation box.
         *
         * @param {string|string[]} groupId - one group id or a list
         * @param {boolean} [blockFutureInvite] - also refuse later invitations from these groups
         * @returns {Promise<unknown>}
         */
        deleteGroupInviteBox: (groupId, blockFutureInvite = false) =>
            s.call(GROUP_INVITE_BOX_DELETE, { groupIds: listOf(groupId), block: blockFutureInvite }),

        /**
         * Invite one user into several groups.
         *
         * @param {string} userId
         * @param {string|string[]} groupId - one group id or a list
         * @returns {Promise<{grid_message_map: object}>}
         */
        inviteUserToGroups: (userId, groupId) =>
            s.call(GROUP_INVITE_MULTI, { memberId: userId, groupIds: listOf(groupId) }),

        /**
         * Disband a group for everyone. Irreversible.
         *
         * @param {string} groupId
         * @returns {Promise<unknown>}
         */
        disperseGroup: (groupId) => s.call(GROUP_DISPERSE, { groupId }),
    };
}

/** Methods whose wire-groups.test.js comparison passes (all 28): the switch answers these from our code. */
export const OWN_READY = new Set([
    "getGroupInfo",
    "getAllGroups",
    "getGroupMembersInfo",
    "createGroup",
    "addUserToGroup",
    "removeUserFromGroup",
    "leaveGroup",
    "changeGroupName",
    "changeGroupAvatar",
    "addGroupDeputy",
    "removeGroupDeputy",
    "changeGroupOwner",
    "addGroupBlockedMember",
    "removeGroupBlockedMember",
    "getGroupBlockedMember",
    "upgradeGroupToCommunity",
    "joinGroupLink",
    "getPendingGroupMembers",
    "reviewPendingMemberRequest",
    "enableGroupLink",
    "disableGroupLink",
    "getGroupLinkDetail",
    "getGroupLinkInfo",
    "getGroupInviteBoxList",
    "joinGroupInviteBox",
    "deleteGroupInviteBox",
    "inviteUserToGroups",
    "disperseGroup",
]);
