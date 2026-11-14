/**
 * `oa group`: the OA's GMF group chats (Zalo's OA docs "Nhóm chat GMF"). Needs a verified OA on the Advanced or
 * Premium package and an app granted group management.
 */

import {
    acceptPendingMembers,
    addAdmins,
    createGroup,
    deleteGroup,
    getGroup,
    getGroupConversation,
    getGroupQuota,
    inviteMembers,
    listGroups,
    listMembers,
    listPendingMembers,
    listRecentChats,
    parseIdList,
    rejectPendingMembers,
    removeAdmins,
    removeMembers,
    sendGroupFile,
    sendGroupImage,
    sendGroupMention,
    sendGroupSticker,
    sendGroupText,
    updateGroup,
    updateGroupAsset,
    walkPages,
} from "../../core/oa/gmf.js";
import { guardSubcommand } from "../../core/confirm-guard.js";
import { error, info, output, success } from "../../utils/output.js";

/** `--lock-send-msg on|off` and the like → boolean (undefined when not given). */
function onOff(value, flag) {
    if (value === undefined) return undefined;
    const v = String(value).toLowerCase();
    if (["on", "true", "yes", "1"].includes(v)) return true;
    if (["off", "false", "no", "0"].includes(v)) return false;
    throw new Error(`${flag} takes on or off (got "${value}")`);
}

function page(opts) {
    return {
        offset: opts.offset === undefined ? undefined : Number(opts.offset),
        count: opts.count === undefined ? undefined : Number(opts.count),
    };
}

function describeGroup(d = {}) {
    const g = d.group_info || d;
    const lines = [`${g.name ?? "N/A"} (ID: ${g.group_id ?? "N/A"})`];
    if (g.status) lines.push(`Status: ${g.status}`);
    if (g.total_member !== undefined) {
        lines.push(`Members: ${g.total_member}${g.max_member !== undefined ? ` / ${g.max_member}` : ""}`);
    }
    if (g.group_link) lines.push(`Link: ${g.group_link}`);
    if (g.group_description) lines.push(`Description: ${g.group_description}`);
    if (g.auto_delete_date) lines.push(`Auto-dissolves: ${g.auto_delete_date}`);
    const a = d.asset_info;
    if (a) {
        lines.push(
            `Package: ${a.asset_type ?? "?"} (asset ${a.asset_id ?? "?"}), valid through ${a.valid_through ?? "?"}` +
                `, auto-renew ${a.auto_renew ?? "?"}`,
        );
    }
    const s = d.group_setting;
    if (s) {
        const yn = (b) => (b ? "on" : "off");
        lines.push(
            `Settings: lock-send-msg ${yn(s.lock_send_msg)}, join-approval ${yn(s.join_appr)}, ` +
                `msg-history ${yn(s.enable_msg_history)}, link-join ${yn(s.enable_link_join)}`,
        );
    }
    return lines;
}

function describeMessage(m) {
    const who = m.src === 0 ? "OA" : m.from_display_name || m.from_id || "?";
    const when = m.time ? new Date(Number(m.time)).toISOString() : "";
    const body = m.message ?? m.url ?? m.links ?? m.location ?? "";
    return `[${when}] ${m.group_id ? `${m.group_id} ` : ""}${who} (${m.type ?? "?"}): ${body}`;
}

/**
 * Register `oa group` on the `oa` command.
 * @param {import("commander").Command} oa
 */
export function registerGmfCommands(oa) {
    const json = () => oa.parent?.opts().json;
    const run =
        (fn) =>
        async (...args) => {
            try {
                await fn(...args);
            } catch (e) {
                error(e.message);
            }
        };

    const group = oa
        .command("group")
        .description("The OA's GMF group chats (verified OA on the Advanced or Premium package)");

    group
        .command("create <name>")
        .description("Create a group chat with the OA (asset id from `oa group quota`)")
        .requiredOption("--asset-id <id>", "An available GMF asset_id (see `oa group quota`)")
        .requiredOption(
            "--members <user-ids>",
            "Comma-separated user ids, 1-99, at least one an admin of the OA",
            (v, prev) => [...(prev || []), v],
        )
        .option("--description <text>", "Group description")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (name, opts) => {
                const r = await createGroup(
                    {
                        name,
                        description: opts.description,
                        assetId: opts.assetId,
                        memberUserIds: parseIdList(opts.members),
                    },
                    opts.oaId,
                );
                output(r, json(), () => {
                    success(`Group created: ${r.data?.group_id ?? "?"}`);
                    if (r.data?.group_link) info(`Link: ${r.data.group_link}`);
                });
            }),
        );

    group
        .command("info <group-id>")
        .description("A group's info, package and settings")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (groupId, opts) => {
                const r = await getGroup(groupId, opts.oaId);
                output(r, json(), () => describeGroup(r.data).forEach((l) => info(l)));
            }),
        );

    group
        .command("update <group-id>")
        .description("Change a group's name, avatar, description or settings (only the fields given)")
        .option("--name <name>", "Group name")
        .option("--avatar <url>", "Avatar image URL")
        .option("--description <text>", "Group description")
        .option("--lock-send-msg <on|off>", "on: only admins can send messages")
        .option("--join-approval <on|off>", "on: new members need approval")
        .option("--msg-history <on|off>", "on: new members can read recent messages")
        .option("--link-join <on|off>", "on: people can join by the group link")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (groupId, opts) => {
                const r = await updateGroup(
                    groupId,
                    {
                        name: opts.name,
                        avatar: opts.avatar,
                        description: opts.description,
                        lockSendMsg: onOff(opts.lockSendMsg, "--lock-send-msg"),
                        joinAppr: onOff(opts.joinApproval, "--join-approval"),
                        enableMsgHistory: onOff(opts.msgHistory, "--msg-history"),
                        enableLinkJoin: onOff(opts.linkJoin, "--link-join"),
                    },
                    opts.oaId,
                );
                output(r, json(), () => {
                    success(`Group ${groupId} updated`);
                    if (r.data) describeGroup(r.data).forEach((l) => info(l));
                });
            }),
        );

    group
        .command("avatar <group-id> <image-url>")
        .description("Change a group's avatar (an image URL)")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (groupId, url, opts) => {
                const r = await updateGroup(groupId, { avatar: url }, opts.oaId);
                output(r, json(), () => success(`Avatar of group ${groupId} updated`));
            }),
        );

    group
        .command("update-asset <group-id> <asset-id>")
        .description("Attach a GMF asset to a group: renew it or raise its member limit (asset ids: `oa group quota`)")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (groupId, assetId, opts) => {
                const r = await updateGroupAsset(groupId, assetId, opts.oaId);
                output(r, json(), () => {
                    success(`Group ${groupId} now uses asset ${assetId}`);
                    if (r.data) describeGroup(r.data).forEach((l) => info(l));
                });
            }),
        );

    const memberCommand = (name, description, fn, done) =>
        group
            .command(`${name} <group-id> <user-ids...>`)
            .description(description)
            .option("--oa-id <id>", "OA identifier", "default")
            .action(
                run(async (groupId, userIds, opts) => {
                    const ids = parseIdList(userIds);
                    const r = await fn(groupId, ids, opts.oaId);
                    output(r, json(), () => success(done(ids.length, groupId)));
                }),
            );

    memberCommand(
        "invite",
        "Invite users (followers, or who interacted with the OA in the past 7 days)",
        inviteMembers,
        (n, g) => `Invited ${n} user(s) to group ${g}`,
    );

    const pagedList = (cmd, key, fetchPage, describeItem, label) =>
        cmd
            .option("--offset <n>", "Start at this offset (default 0)")
            .option("--count <n>", "How many (default 5, Zalo's default)")
            .option("--all", "Fetch every page")
            .option("--oa-id <id>", "OA identifier", "default")
            .action(
                run(async (...args) => {
                    const opts = args.at(-2);
                    const pos = args.slice(0, -2);
                    const r = opts.all
                        ? await walkPages((p) => fetchPage(...pos, p, opts.oaId), key, {
                              offset: Number(opts.offset ?? 0),
                              ...(opts.count !== undefined && { count: Number(opts.count) }),
                          })
                        : await fetchPage(...pos, page(opts), opts.oaId);
                    output(r, json(), () => {
                        const items = r.data?.[key] || [];
                        info(`${label}: ${items.length}${r.data?.total !== undefined ? ` of ${r.data.total}` : ""}`);
                        for (const it of items) info(`  ${describeItem(it)}`);
                    });
                }),
            );

    pagedList(
        group.command("pending <group-id>").description("Users waiting for approval to join"),
        "members",
        listPendingMembers,
        (m) => `${m.user_id ?? "?"}  ${m.name ?? ""}`,
        "Pending",
    );

    memberCommand(
        "accept",
        "Approve pending users",
        acceptPendingMembers,
        (n, g) => `Approved ${n} user(s) into group ${g}`,
    );
    memberCommand(
        "reject",
        "Refuse pending users",
        rejectPendingMembers,
        (n, g) => `Refused ${n} user(s) for group ${g}`,
    );

    pagedList(
        group.command("members <group-id>").description("A group's members (the OA is listed by oa_id)"),
        "members",
        listMembers,
        (m) => `${m.user_id ?? `OA ${m.oa_id ?? "?"}`}  ${m.name ?? ""}`,
        "Members",
    );

    memberCommand(
        "add-admins",
        "Make members deputy admins",
        addAdmins,
        (n, g) => `${n} deputy admin(s) added in ${g}`,
    );
    memberCommand(
        "remove-admins",
        "Take deputy admin from members",
        removeAdmins,
        (n, g) => `${n} deputy admin(s) removed in ${g}`,
    );
    memberCommand(
        "remove-members",
        "Remove members from a group",
        removeMembers,
        (n, g) => `Removed ${n} member(s) from group ${g}`,
    );

    group
        .command("delete <group-id>")
        .description("Dissolve a group for every member")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (groupId, opts) => {
                const r = await deleteGroup(groupId, opts.oaId);
                output(r, json(), () => success(`Group ${groupId} dissolved`));
            }),
        );

    pagedList(
        group.command("list").description("The groups the OA manages"),
        "groups",
        listGroups,
        (g) => `${g.group_id ?? "?"}  ${g.name ?? ""}  (${g.total_member ?? "?"} members, ${g.status ?? "?"})`,
        "Groups",
    );

    const messageList = (cmd, fetchPage) =>
        cmd
            .option("--offset <n>", "Start at this offset (default 0)")
            .option("--count <n>", "How many (default 5, Zalo's default)")
            .option("--oa-id <id>", "OA identifier", "default")
            .action(
                run(async (...args) => {
                    const opts = args.at(-2);
                    const pos = args.slice(0, -2);
                    const r = await fetchPage(...pos, page(opts), opts.oaId);
                    output(r, json(), () => {
                        const items = Array.isArray(r.data) ? r.data : [];
                        if (!items.length) info("No messages");
                        for (const m of items) info(describeMessage(m));
                    });
                }),
            );

    messageList(group.command("recent").description("The OA's latest group messages, across groups"), listRecentChats);
    messageList(
        group.command("history <group-id>").description("One group's messages, newest first"),
        getGroupConversation,
    );

    group
        .command("send <group-id> [text]")
        .description(
            "Send to a group: text (default), --mention, --image-url/--attachment-id (text is the caption, " +
                "required), --file-token, or --sticker",
        )
        .option("--mention <user-ids>", "Mention these members (comma-separated); or put [@user_id] in the text")
        .option("--mention-all", "Mention the whole group")
        .option("--image-url <url>", "Image by URL (jpg/png, up to 1 MB)")
        .option("--attachment-id <id>", "Image by attachment_id (from `oa upload image`/`gif`)")
        .option("--gif", "The image is a GIF (needs --width and --height)")
        .option("--width <px>", "GIF width")
        .option("--height <px>", "GIF height")
        .option("--file-token <token>", "File by the token from `oa upload file`")
        .option("--sticker <sticker-id>", "Sticker by its id (stickers.zaloapp.com)")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (groupId, text, opts) => {
                const image = opts.imageUrl || opts.attachmentId;
                const kinds = [image, opts.fileToken, opts.sticker].filter(Boolean).length;
                if (kinds > 1) throw new Error("Send one kind at a time: an image, a file or a sticker");
                const mentions = opts.mention !== undefined || opts.mentionAll;
                if (mentions && kinds) throw new Error("--mention goes with a text message only");
                if ((opts.fileToken || opts.sticker) && text) {
                    throw new Error("A file or sticker message carries no text; send the text separately");
                }
                let r;
                if (image) {
                    r = await sendGroupImage(
                        groupId,
                        {
                            text,
                            url: opts.imageUrl,
                            attachmentId: opts.attachmentId,
                            gif: Boolean(opts.gif),
                            width: opts.width,
                            height: opts.height,
                        },
                        opts.oaId,
                    );
                } else if (opts.fileToken) {
                    r = await sendGroupFile(groupId, opts.fileToken, opts.oaId);
                } else if (opts.sticker) {
                    r = await sendGroupSticker(groupId, opts.sticker, opts.oaId);
                } else if (mentions) {
                    r = await sendGroupMention(
                        groupId,
                        text,
                        { userIds: parseIdList(opts.mention), all: Boolean(opts.mentionAll) },
                        opts.oaId,
                    );
                } else {
                    r = await sendGroupText(groupId, text, opts.oaId);
                }
                output(r, json(), () => success(`Sent to group ${groupId} (message ${r.data?.message_id ?? "?"})`));
            }),
        );

    group
        .command("quota")
        .description("The OA's GMF assets (asset ids for `create` and `update-asset`) and which are available")
        .option("--owner <OA|APP>", "Whose quota: the OA (default) or the app", "OA")
        .option("--product <type>", "gmf10, gmf50 or gmf100")
        .option("--quota-type <type>", "sub_quota, purchase_quota or reward_quota")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(
            run(async (opts) => {
                const r = await getGroupQuota(
                    { quotaOwner: opts.owner, productType: opts.product, quotaType: opts.quotaType },
                    opts.oaId,
                );
                output(r, json(), () => {
                    const items = Array.isArray(r.data) ? r.data : [];
                    if (!items.length) info("No GMF assets");
                    for (const a of items) {
                        info(
                            `${a.asset_id ?? "?"}  ${a.product_type ?? "?"}  ${a.quota_type ?? "?"}  ${a.status ?? "?"}` +
                                `  valid through ${a.valid_through ?? "?"}${a.used_id ? `  used by ${a.used_id}` : ""}`,
                        );
                    }
                });
            }),
        );

    guardSubcommand(group, "remove-members", "oa.group.removeMembers", {
        target: (groupId, userIds, opts) => ({ groupId, userIds: parseIdList(userIds), oaId: opts?.oaId }),
    });
    guardSubcommand(group, "delete", "oa.group.delete", {
        target: (groupId, opts) => ({ groupId, oaId: opts?.oaId }),
    });
}
