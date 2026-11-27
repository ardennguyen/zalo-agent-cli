/**
 * The MCP half of src/core/known-ids.js: the tools that take a person or a conversation refuse an id this account has
 * never seen (`UNKNOWN_TO_ACCOUNT`) before their handler runs, and the tools that hand out this account's ids
 * (a phone or username lookup, a group's members, the friend requests listed) record them, so the call that follows
 * with one is not refused.
 *
 * One table per direction ({@link ID_GUARDS}, {@link ID_RECORDS}), applied by wrapping `server.registerTool` once
 * ({@link guardKnownIds}), so a tool's own handler is unchanged. Every guarded tool takes `allowUnknown`
 * ({@link allowUnknownInput}) in its schema.
 */
import { z } from "zod";
import { findUnknownIds, mentionUids, recordKnownIds, unknownIdRefusal } from "../core/known-ids.js";

/**
 * The `allowUnknown` input of a guarded tool.
 *
 * @returns {import("zod").ZodOptional<import("zod").ZodBoolean>}
 */
export function allowUnknownInput() {
    return z
        .boolean()
        .optional()
        .describe(
            "Skip the check that every user, conversation or group id here is known to this account (a friend, a " +
                "conversation, a contact, a member of one of its groups, a sender it has seen, or found with " +
                "zalo_lookup_user). User ids differ per account: an id read on another account is refused with " +
                "UNKNOWN_TO_ACCOUNT. Set it only when you are sure the id is this account's.",
        );
}

/** A conversation id: a person when the type says dm, a group when it says group, either when it says nothing. */
const thread = (id, type, field = "threadId") => ({
    id,
    as: type === "group" ? "group" : type === "dm" ? "user" : "thread",
    field,
});
const user = (id, field = "userId") => ({ id, as: "user", field });

/** zalo_friend's actions that name a person to act on (accept and reject answer a request Zalo delivered here). */
export const FRIEND_GUARDED = new Set([
    "status",
    "send",
    "undo",
    "alias",
    "remove",
    "block",
    "unblock",
    "last_online",
    "biz",
    "block_feed",
    "qr",
    "common_groups",
]);

/**
 * zalo_conversation's actions not checked: the lists (they take no conversation) and 'forget', which deletes only this
 * machine's copy and asks Zalo nothing. Every other one acts on threadId / threadIds at Zalo.
 */
export const CONVERSATION_UNCHECKED = new Set([
    "forget",
    "pinned",
    "archived",
    "muted",
    "hidden",
    "auto_delete_status",
    "hidden_pin",
    "hidden_pin_reset",
]);

/**
 * zalo_group's actions whose groupId is not one of this account's groups yet (an invite link, an invitation
 * received, a new group) or that take none.
 */
export const GROUP_NOT_OURS = new Set([
    "create",
    "link_preview",
    "join",
    "invite_boxes",
    "invite_info",
    "join_invite",
    "delete_invite",
    "invite_to",
    "members_info",
]);

/** zalo_group's actions whose userIds / userId name people already in the group (its member list also proves them). */
export const GROUP_MEMBER_ACTIONS = new Set([
    "remove_member",
    "transfer_owner",
    "add_admin",
    "remove_admin",
    "block_member",
]);

/**
 * zalo_group's actions whose people are not checked: a join request Zalo delivered to this account (approve,
 * reject_member), and a member blocked out of the group (unblock_member), whom no member list names any more.
 */
export const GROUP_PEOPLE_UNCHECKED = new Set(["approve", "reject_member", "unblock_member"]);

/** The ids a zalo_group call names. */
function groupIds(a) {
    const out = [];
    const gid = a.groupId;
    if (gid && !GROUP_NOT_OURS.has(a.action)) out.push({ id: gid, as: "group", field: "groupId" });
    if (a.action === "invite_to" && Array.isArray(a.groupIds))
        for (const g of a.groupIds) out.push({ id: g, as: "group", field: "groupIds" });
    if (GROUP_PEOPLE_UNCHECKED.has(a.action)) return out;
    // A member the action names may be proved by the group's own member list (src/core/known-ids.js).
    const inGroup = GROUP_MEMBER_ACTIONS.has(a.action) && gid ? { group: String(gid) } : {};
    if (Array.isArray(a.userIds)) for (const u of a.userIds) out.push({ ...user(u, "userIds"), ...inGroup });
    if (a.userId) out.push({ ...user(a.userId), ...inGroup });
    if (a.action === "leave" && a.newOwner) out.push({ ...user(a.newOwner, "newOwner"), ...(gid && { group: gid }) });
    return out;
}

/** Per guarded tool: the ids its arguments name. */
export const ID_GUARDS = {
    zalo_send_message: (a) => [
        thread(a.threadId, a.threadType),
        ...(a.cardUserId ? [user(a.cardUserId, "cardUserId")] : []),
        ...mentionUids(a.text).map((u) => user(u, "text @[userId]")),
    ],
    zalo_forward_message: (a) => [thread(a.threadId, a.threadType)],
    zalo_react: (a) => [thread(a.threadId, a.threadType)],
    zalo_get_history: (a) => [thread(a.threadId, a.threadType)],
    zalo_get_messages: (a) => (a.threadId ? [thread(a.threadId)] : []),
    zalo_wait_for_message: (a) => (a.threadId ? [thread(a.threadId)] : []),
    zalo_lookup_user: (a) => (a.userId ? [user(a.userId)] : []),
    zalo_get_group_members: (a) => [{ id: a.groupId, as: "group", field: "groupId" }],
    zalo_search_messages: (a) => [
        ...(a.threadId ? [thread(a.threadId)] : []),
        ...(a.senderId ? [user(a.senderId, "senderId")] : []),
    ],
    zalo_view_media: (a) => (a.threadId ? [thread(a.threadId)] : []),
    zalo_conversation: (a) =>
        CONVERSATION_UNCHECKED.has(a.action)
            ? []
            : [
                  ...(a.threadId ? [thread(a.threadId, a.threadType)] : []),
                  ...(Array.isArray(a.threadIds) ? a.threadIds.map((t) => thread(t, a.threadType, "threadIds")) : []),
              ],
    zalo_group: groupIds,
    zalo_friend: (a) =>
        FRIEND_GUARDED.has(a.action)
            ? [
                  ...(a.userId ? [user(a.userId)] : []),
                  ...(Array.isArray(a.userIds) ? a.userIds.map((u) => user(u, "userIds")) : []),
              ]
            : [],
};

const idsOf = (list) => (Array.isArray(list) ? list.map((x) => x?.userId) : []);

/** Per tool that hands out this account's ids: the ids its successful reply names. */
export const ID_RECORDS = {
    zalo_lookup_user: (a, r) => (a.phone || a.username ? [r?.userId] : []),
    zalo_get_group_members: (_a, r) => idsOf(r?.members),
    zalo_friend: (a, r) => {
        if (a.action === "find_phones") return idsOf(r?.users);
        if (a.action === "received_requests" || a.action === "sent_requests") return idsOf(r?.requests);
        return [];
    },
};

/** The JSON reply of a tool result, or null. */
function replyOf(result) {
    if (!result || result.isError) return null;
    const text = result.content?.find?.((c) => c?.type === "text")?.text;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * The refusal reply of ids this account does not know: the JSON fields first, then the line a person reads.
 *
 * @param {import("../core/known-ids.js").IdTarget[]} unknown
 * @returns {{content: Array<{type: "text", text: string}>, isError: true}}
 */
export function unknownIdReply(unknown) {
    const r = unknownIdRefusal(unknown, { surface: "mcp" });
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({ success: false, code: r.code, error: r.message, unknownIds: r.unknownIds }),
            },
            { type: "text", text: `Error: ${r.message}` },
        ],
        isError: true,
    };
}

/**
 * Wrap `server.registerTool` so every tool registered after this call is checked against ID_GUARDS before its handler
 * runs and recorded through ID_RECORDS after it succeeds.
 *
 * @param {object} server - the McpServer (or a stand-in with registerTool)
 * @param {object} ctx
 * @param {object} ctx.api - the session
 * @param {() => string|null} ctx.ownId
 * @param {() => string[]} [ctx.selfIds] - more ids of the account's own (My Documents)
 * @param {() => string|null} ctx.accountDir
 * @param {(id: string, as: string) => boolean} [ctx.extraKnown] - the server's own index (friends and groups)
 */
export function guardKnownIds(server, ctx) {
    if (typeof server?.registerTool !== "function") return;
    const raw = server.registerTool.bind(server);
    server.registerTool = (name, meta, handler) => {
        const guard = ID_GUARDS[name];
        const record = ID_RECORDS[name];
        if (!guard && !record) return raw(name, meta, handler);
        return raw(name, meta, async (...args) => {
            const a = args[0] ?? {};
            if (guard && a.allowUnknown !== true) {
                const unknown = await findUnknownIds(guard(a), {
                    api: ctx.api,
                    ownId: ctx.ownId?.() ?? null,
                    selfIds: ctx.selfIds?.() ?? [],
                    accountDir: ctx.accountDir?.() ?? null,
                    extraKnown: ctx.extraKnown,
                });
                if (unknown.length) {
                    console.error(`[known-ids] ${name} refused: ${unknown.length} id(s) unknown to this account`);
                    return unknownIdReply(unknown);
                }
            }
            const result = await handler(...args);
            if (record) {
                const reply = replyOf(result);
                if (reply) recordKnownIds(ctx.accountDir?.() ?? null, ctx.ownId?.() ?? null, record(a, reply));
            }
            return result;
        });
    };
}
