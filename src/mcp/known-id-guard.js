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
