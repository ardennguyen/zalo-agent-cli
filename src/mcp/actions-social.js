/**
 * The `friend` and `group` commands zalo_friend and zalo_group did not cover, as action-table rows (see
 * src/mcp/action-tool.js). The two tools keep their own handlers for their first actions and hand these to the
 * action runner; each row makes the call its CLI command makes.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getInviteBoxInfo } from "../zalo/custom/group-invite.js";
import { applyGroupSettingChanges } from "../zalo/custom/group-settings.js";
import { SETTING_FLAGS } from "../core/group-settings.js";

/** What Zalo answers for an endpoint it has retired, and what to use instead (as `friend online` / `close` say). */
const RETIRED_404 = {
    online: "Zalo answers 404 for the online-friends list on this build; 'last_online' works for one user.",
    close: "Zalo has retired close friends: the web client has no caller for it, and the request answers 404.",
};

/** A 404 from a retired endpoint, said plainly. */
const retired = (which) => (e) => (/404/.test(e.message) ? `${e.message}. ${RETIRED_404[which]}` : undefined);

// --- zalo_friend ---

/** zalo_friend's further actions. */
export const FRIEND_EXTRA_ACTIONS = {
    online: {
        async run(_a, { api }) {
            return { data: (await api.getFriendOnlines()) ?? null };
        },
        fail: retired("online"),
    },
    remove: {
        needs: ["userId"],
        guard: (a) => ({ key: "friend.remove", target: { userId: a.userId } }),
        async run(a, { api }) {
            await api.removeFriend(a.userId);
            return { success: true, userId: a.userId };
        },
    },
    block: {
        needs: ["userId"],
        guard: (a) => ({ key: "friend.block", target: { userId: a.userId } }),
        async run(a, { api }) {
            await api.blockUser(a.userId);
            return { success: true, userId: a.userId };
        },
    },
    unblock: {
        needs: ["userId"],
        async run(a, { api }) {
            await api.unblockUser(a.userId);
            return { success: true, userId: a.userId };
        },
    },
    last_online: {
        needs: ["userId"],
        async run(a, { api }) {
            return { userId: a.userId, data: (await api.lastOnline(a.userId)) ?? null };
        },
    },
    close: {
        async run(_a, { api }) {
            const res = await api.getCloseFriends();
            const friends = (Array.isArray(res) ? res : []).map((f) => ({
                userId: String(f.userId || f.uid || ""),
                displayName: f.displayName || f.zaloName || null,
            }));
            return { count: friends.length, friends };
        },
        fail: retired("close"),
    },
    find_phones: {
        needs: ["phones"],
        async run(a, { api }) {
            const res = (await api.getMultiUsersByPhones(a.phones)) || {};
            const users = Object.entries(res).map(([phone, u]) => ({
                phone,
                userId: u?.uid ? String(u.uid) : null,
                displayName: u?.displayName || u?.zaloName || null,
            }));
            return { count: users.length, users };
        },
    },
    qr: {
        needs: ["userIds"],
        async run(a, { api }) {
            const res = (await api.getQR(a.userIds)) ?? {};
            return { codes: Object.entries(res).map(([userId, url]) => ({ userId, url })) };
        },
    },
    common_groups: {
        needs: ["userIds"],
        async run(a, { api }) {
            const res = await api.getRelatedFriendGroup(a.userIds);
            const shared = Object.entries(res?.groupRelateds ?? {}).map(([userId, groups]) => ({
                userId,
                groupIds: (Array.isArray(groups) ? groups : []).map(String),
            }));
            return { shared };
        },
    },
    biz: {
        needs: ["userId"],
        async run(a, { api }) {
            return { userId: a.userId, data: (await api.getBizAccount(a.userId)) ?? null };
        },
    },
    block_feed: {
        needs: ["userId"],
        async run(a, { api }) {
            const hide = a.unblock !== true;
            await api.blockViewFeed(hide, a.userId);
            return { success: true, userId: a.userId, feedHidden: hide };
        },
    },
};

/** zalo_friend's inputs for the actions above. */
export const FRIEND_EXTRA_INPUTS = {
    userIds: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .optional()
        .describe("Several Zalo user ids (required for 'qr' and 'common_groups')"),
    phones: z
        .array(z.string().min(3))
        .min(1)
        .max(50)
        .optional()
        .describe("Phone numbers to look up (required for 'find_phones'), e.g. '0901234567'"),
    unblock: z
        .boolean()
        .optional()
        .describe("Only for 'block_feed': true shows the user's posts in the feed again instead of hiding them"),
};

// --- zalo_group ---

/** A local file the server can read, or the refusal that names it. */
function localFile(path) {
    const abs = resolve(String(path).trim());
    return existsSync(abs) ? { abs } : { error: `File not found on the machine this server runs on: ${abs}` };
}

/** `settings` as the GroupSetting changes Zalo takes (1 on, 0 off), only for the settings given. */
function settingChanges(settings) {
    const changes = {};
    for (const key of Object.values(SETTING_FLAGS)) {
        if (settings?.[key] !== undefined) changes[key] = settings[key] ? 1 : 0;
    }
    return changes;
}

/** zalo_group's further actions. */
export const GROUP_EXTRA_ACTIONS = {
    avatar: {
        needs: ["groupId", "filePath"],
        check: (a) => localFile(a.filePath).error,
        async run(a, { api }) {
            await api.changeGroupAvatar(localFile(a.filePath).abs, a.groupId);
            return { success: true, groupId: a.groupId };
        },
    },
    add_admin: {
        needs: ["groupId", "userIds"],
        async run(a, { api }) {
            await api.addGroupDeputy(a.userIds, a.groupId);
            return { success: true, groupId: a.groupId, userIds: a.userIds };
        },
    },
    remove_admin: {
        needs: ["groupId", "userIds"],
        guard: (a) => ({ key: "group.removeAdmin", target: { groupId: a.groupId, userIds: a.userIds } }),
        async run(a, { api }) {
            await api.removeGroupDeputy(a.userIds, a.groupId);
            return { success: true, groupId: a.groupId, userIds: a.userIds };
        },
    },
    transfer_owner: {
        needs: ["groupId", "userId"],
        guard: (a) => ({ key: "group.transferOwner", target: { groupId: a.groupId, userId: a.userId } }),
        async run(a, { api }) {
            await api.changeGroupOwner(a.userId, a.groupId);
            return { success: true, groupId: a.groupId, userId: a.userId };
        },
    },
    block_member: {
        needs: ["groupId", "userIds"],
        guard: (a) => ({ key: "group.blockMember", target: { groupId: a.groupId, userIds: a.userIds } }),
        async run(a, { api }) {
            await api.addGroupBlockedMember(a.userIds, a.groupId);
            return { success: true, groupId: a.groupId, userIds: a.userIds };
        },
    },
    unblock_member: {
        needs: ["groupId", "userIds"],
        async run(a, { api }) {
            await api.removeGroupBlockedMember(a.userIds, a.groupId);
            return { success: true, groupId: a.groupId, userIds: a.userIds };
        },
    },
    blocked: {
        needs: ["groupId"],
        async run(a, { api }) {
            const res = await api.getGroupBlockedMember({ page: a.page ?? 1, count: a.limit ?? 50 }, a.groupId);
            const members = (res?.blocked_members ?? []).map((m) => ({
                userId: String(m.id),
                displayName: m.dName || m.zaloName || null,
            }));
            return { groupId: a.groupId, count: members.length, members, hasMore: Boolean(res?.has_more) };
        },
    },
    upgrade_community: {
        needs: ["groupId"],
        async run(a, { api }) {
            await api.upgradeGroupToCommunity(a.groupId);
            return { success: true, groupId: a.groupId };
        },
    },
    settings: {
        needs: ["groupId", "settings"],
        check: (a) =>
            Object.keys(settingChanges(a.settings)).length === 0
                ? "settings names nothing to change: give at least one setting, true or false."
                : undefined,
        // Only turning membership approval off is asked about, as `group settings --no-join-appr`.
        guard: (a) => ({
            key: "group.settings",
            target: { groupId: a.groupId, approvalOff: a.settings.joinAppr === false },
            applies: a.settings.joinAppr === false,
        }),
        async run(a, { api }) {
            // Zalo stores the whole setting object on every update: this reads it and sends back everything not
            // named, unchanged (src/zalo/custom/group-settings.js), as `group settings` does.
            const outcome = await applyGroupSettingChanges(api, a.groupId, settingChanges(a.settings));
            const notApplied = Object.keys(outcome.notApplied ?? {}).length > 0;
            return { success: !notApplied, groupId: a.groupId, ...outcome };
        },
    },
    disperse: {
        needs: ["groupId"],
        guard: (a) => ({ key: "group.disperse", target: { groupId: a.groupId } }),
        async run(a, { api }) {
            await api.disperseGroup(a.groupId);
            return { success: true, groupId: a.groupId };
        },
    },
    pending: {
        needs: ["groupId"],
        async run(a, { api }) {
            const res = await api.getPendingGroupMembers(a.groupId);
            const users = (res?.users ?? []).map((u) => ({ userId: String(u.uid), displayName: u.dpn || null }));
            return { groupId: a.groupId, count: users.length, users };
        },
    },
    approve: {
        needs: ["groupId", "userIds"],
        async run(a, { api }) {
            await api.reviewPendingMemberRequest({ members: a.userIds, isApprove: true }, a.groupId);
            return { success: true, groupId: a.groupId, userIds: a.userIds };
        },
    },
    reject_member: {
        needs: ["groupId", "userIds"],
        async run(a, { api }) {
            await api.reviewPendingMemberRequest({ members: a.userIds, isApprove: false }, a.groupId);
            return { success: true, groupId: a.groupId, userIds: a.userIds };
        },
    },
    enable_link: {
        needs: ["groupId"],
        async run(a, { api }) {
            const res = await api.enableGroupLink(a.groupId);
            return { success: true, groupId: a.groupId, link: res?.link ?? null };
        },
    },
    disable_link: {
        needs: ["groupId"],
        guard: (a) => ({ key: "group.disableLink", target: { groupId: a.groupId } }),
        async run(a, { api }) {
            await api.disableGroupLink(a.groupId);
            return { success: true, groupId: a.groupId };
        },
    },
    link_info: {
        needs: ["groupId"],
        async run(a, { api }) {
            const res = await api.getGroupLinkDetail(a.groupId);
            return {
                groupId: a.groupId,
                enabled: res?.enabled === 1,
                link: res?.link ?? null,
                expiresAt: res?.expiration_date ?? null,
            };
        },
    },
    link_preview: {
        needs: ["link"],
        async run(a, { api }) {
            return {
                link: a.link,
                data: (await api.getGroupLinkInfo({ link: a.link, memberPage: a.page ?? 1 })) ?? null,
            };
        },
    },
    join: {
        needs: ["link"],
        async run(a, { api }) {
            return { success: true, link: a.link, data: (await api.joinGroupLink(a.link)) ?? null };
        },
    },
    invite_boxes: {
        async run(_a, { api }) {
            const res = await api.getGroupInviteBoxList();
            const invitations = (res?.invitations ?? []).map((inv) => ({
                groupId: inv.groupInfo?.groupId ? String(inv.groupInfo.groupId) : null,
                name: inv.groupInfo?.name ?? null,
                inviterName: inv.inviterInfo?.dName ?? null,
            }));
            return { count: invitations.length, total: res?.total ?? invitations.length, invitations };
        },
    },
    invite_info: {
        needs: ["groupId"],
        async run(a, { api }) {
            const res = await getInviteBoxInfo(api, { groupId: a.groupId, mpage: a.page ?? 1, mcount: a.limit ?? 10 });
            return { groupId: a.groupId, data: res ?? null };
        },
    },
    join_invite: {
        needs: ["groupId"],
        async run(a, { api }) {
            await api.joinGroupInviteBox(a.groupId);
            return { success: true, groupId: a.groupId };
        },
    },
    delete_invite: {
        needs: ["groupIds"],
        async run(a, { api }) {
            const block = a.blockFutureInvites === true;
            await api.deleteGroupInviteBox(a.groupIds, block);
            return { success: true, groupIds: a.groupIds, blockFutureInvites: block };
        },
    },
    invite_to: {
        needs: ["userId", "groupIds"],
        async run(a, { api }) {
            const res = await api.inviteUserToGroups(a.userId, a.groupIds);
            return { success: true, userId: a.userId, groupIds: a.groupIds, data: res ?? null };
        },
    },
    members_info: {
        needs: ["userIds"],
        async run(a, { api }) {
            const res = await api.getGroupMembersInfo(a.userIds);
            const members = Object.entries(res?.profiles ?? {}).map(([userId, p]) => ({
                userId,
                displayName: p?.displayName || p?.zaloName || null,
                zaloName: p?.zaloName ?? null,
                avatar: p?.avatar ?? null,
            }));
            return { count: members.length, members };
        },
    },
};

/** zalo_group's inputs for the actions above. */
export const GROUP_EXTRA_INPUTS = {
    groupIds: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .optional()
        .describe("Several group ids (required for 'delete_invite' and 'invite_to')"),
    filePath: z
        .string()
        .min(1)
        .optional()
        .describe("Only for 'avatar': a local image path on the machine this server runs on"),
    link: z
        .string()
        .url()
        .optional()
        .describe("A group invite link, https://zalo.me/g/... (required for 'join' and 'link_preview')"),
    settings: z
        .object(
            Object.fromEntries(
                Object.entries(SETTING_FLAGS).map(([flag, key]) => [
                    key,
                    z.boolean().optional().describe(`true or false, as \`group settings --${flag}\` / --no-${flag}`),
                ]),
            ),
        )
        .strict()
        .optional()
        .describe(
            "Only for 'settings': the settings to change, each true or false; the rest keep their values. blockName " +
                "(members cannot rename or change the avatar), signAdminMsg (highlight admins' messages), " +
                "enableMsgHistory (new members read recent messages), joinAppr (joining needs approval; turning it " +
                "off is asked about first), lockCreatePost (members cannot create notes or reminders), " +
                "lockCreatePoll, lockSendMsg (members cannot send messages), lockViewMember (hide the member list, " +
                "communities only), setTopicOnly (only admins pin to the top of the chat)",
        ),
    page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number for 'blocked', and the member page for 'link_preview' and 'invite_info' (default 1)"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Page size for 'blocked' (default 50), and members per page for 'invite_info' (default 10)"),
    blockFutureInvites: z
        .boolean()
        .optional()
        .describe("Only for 'delete_invite': also refuse future invitations from these groups"),
};
