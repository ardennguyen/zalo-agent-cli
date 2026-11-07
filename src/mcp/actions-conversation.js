/**
 * `zalo_conversation`: the `conv` commands (and `msg typing`, `msg report`) as MCP actions. Each action makes the
 * call its command makes: pinning and archiving through src/core/conversation-actions.js, marking read through
 * src/core/receipts.js, the rest through the session's own methods.
 */

import { z } from "zod";
import { MUTE_ACTION } from "../zalo/enums.js";
import { getMessages, getOrphanThreads, markThreadGone } from "../core/db.js";
import { markConversationRead, unreadMarkAnchor } from "../core/receipts.js";
import { pinnedConversations } from "../core/sync-v2/conv-state.js";
import { parseReportReason, REPORT_REASONS } from "../utils/cli-args.js";
import {
    AUTO_DELETE_TTLS,
    SEEN_ANCHOR_SCAN_DEPTH,
    forgetConversation,
    newestMessageAnchor,
    setConversationArchived,
    setConversationPinned,
} from "../core/conversation-actions.js";
import { confirmInput, dryRunInput } from "./action-tool.js";

/** Cached rows of a thread, or none when this process has no cache open. */
function cachedRows(threadId, depth) {
    try {
        return getMessages(String(threadId), depth);
    } catch {
        return [];
    }
}

/**
 * The one thread type of several conversations: the caller's, else each one's cached type. Zalo takes one type for
 * the whole list (as `conv hide -t` does), so a list that mixes DMs and groups is refused.
 *
 * @param {object} ctx
 * @param {string[]} threadIds
 * @param {"dm"|"group"} [explicit]
 * @returns {number|{error: string}}
 */
function oneType(ctx, threadIds, explicit) {
    const types = new Set(threadIds.map((id) => ctx.threadType(id, explicit)));
    if (types.size > 1) {
        return { error: "threadIds mixes DMs and groups; Zalo takes one type per call, so send each kind separately." };
    }
    return [...types][0];
}

/** The action table; see src/mcp/action-tool.js for what a row holds. */
export const CONVERSATION_ACTIONS = {
    pinned: {
        async run(_a, { api }) {
            const res = await api.getPinConversations();
            // Zalo's `m1` entry is not a conversation; Web skips it (spec-actions 7.3), as the pin sync does.
            const conversations = pinnedConversations(res?.conversations).map(String);
            return { count: conversations.length, conversations };
        },
    },
    pin: {
        needs: ["threadId"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            await setConversationPinned(ctx.api, { threadId: a.threadId, type, pinned: true });
            return { success: true, threadId: a.threadId, threadType: ctx.threadTypeName(type), pinned: true };
        },
    },
    unpin: {
        needs: ["threadId"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            await setConversationPinned(ctx.api, { threadId: a.threadId, type, pinned: false });
            return { success: true, threadId: a.threadId, threadType: ctx.threadTypeName(type), pinned: false };
        },
    },
    archived: {
        async run(_a, { api }) {
            return { data: (await api.getArchivedChatList()) ?? null };
        },
    },
    archive: {
        needs: ["threadId"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            const r = await setConversationArchived(ctx.api, { threadId: a.threadId, type, archived: true });
            return {
                success: true,
                threadId: a.threadId,
                threadType: ctx.threadTypeName(type),
                archived: true,
                needResync: r.needResync,
            };
        },
    },
    unarchive: {
        needs: ["threadId"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            const r = await setConversationArchived(ctx.api, { threadId: a.threadId, type, archived: false });
            return {
                success: true,
                threadId: a.threadId,
                threadType: ctx.threadTypeName(type),
                archived: false,
                needResync: r.needResync,
            };
        },
    },
    muted: {
        async run(_a, { api }) {
            const res = await api.getMute();
            const entries = (list, threadType) =>
                (Array.isArray(list) ? list : []).map((m) => ({
                    threadId: String(m.id),
                    threadType,
                    muteMode: m.muteMode ?? null,
                    duration: m.duration ?? null,
                }));
            return {
                conversations: [...entries(res?.chatEntries, "dm"), ...entries(res?.groupChatEntries, "group")],
            };
        },
    },
    mute: {
        needs: ["threadId"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            const duration = a.durationSeconds ?? -1;
            // setMute takes the options FIRST (see `conv mute`).
            await ctx.api.setMute({ duration, action: MUTE_ACTION.MUTE }, a.threadId, type);
            return {
                success: true,
                threadId: a.threadId,
                threadType: ctx.threadTypeName(type),
                durationSeconds: duration,
            };
        },
    },
    unmute: {
        needs: ["threadId"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            await ctx.api.setMute({ action: MUTE_ACTION.UNMUTE }, a.threadId, type);
            return { success: true, threadId: a.threadId, threadType: ctx.threadTypeName(type) };
        },
    },
    read: {
        needs: ["threadId"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            const rows = cachedRows(a.threadId, SEEN_ANCHOR_SCAN_DEPTH);
            const r = await markConversationRead(ctx.api, { threadId: a.threadId, type, ownId: ctx.ownId(), rows });
            // Zalo marks a MESSAGE seen, not a thread: without a usable cached message there is nothing to anchor on.
            if (r.seen?.refused) throw new Error(r.seen.error);
            return {
                success: Boolean(r.unreadMark?.ok && r.seen?.ok),
                threadId: a.threadId,
                threadType: ctx.threadTypeName(type),
                unreadMarkCleared: Boolean(r.unreadMark?.ok),
                ...(r.unreadMark?.error && { unreadMarkError: r.unreadMark.error }),
                seenMsgId: r.seen?.msgId ?? null,
                ...(r.seen?.error && { seenError: r.seen.error }),
            };
        },
    },
    unread: {
        needs: ["threadId"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            // Zalo Web pins the mark to the newest cached message; with none cached its "-1" goes out instead.
            const last = unreadMarkAnchor(cachedRows(a.threadId, SEEN_ANCHOR_SCAN_DEPTH), { ownId: ctx.ownId() });
            await ctx.api.addUnreadMark(a.threadId, type, last);
            return { success: true, threadId: a.threadId, threadType: ctx.threadTypeName(type) };
        },
    },
    hidden: {
        async run(_a, { api }) {
            return { data: (await api.getHiddenConversations()) ?? null };
        },
    },
    hide: {
        needs: ["threadIds"],
        async run(a, ctx) {
            const type = oneType(ctx, a.threadIds, a.threadType);
            if (type?.error) throw new Error(type.error);
            await ctx.api.setHiddenConversations(true, a.threadIds, type);
            return { success: true, threadIds: a.threadIds, threadType: ctx.threadTypeName(type) };
        },
    },
    unhide: {
        needs: ["threadIds"],
        guard: (a) => ({ key: "conv.unhide", target: { threadIds: a.threadIds } }),
        async run(a, ctx) {
            const type = oneType(ctx, a.threadIds, a.threadType);
            if (type?.error) throw new Error(type.error);
            await ctx.api.setHiddenConversations(false, a.threadIds, type);
            return { success: true, threadIds: a.threadIds, threadType: ctx.threadTypeName(type) };
        },
    },
    hidden_pin: {
        needs: ["pin"],
        check: (a) => (/^\d{4}$/.test(String(a.pin)) ? undefined : "pin must be 4 digits."),
        async run(a, { api }) {
            // The PIN itself is never echoed back or logged.
            await api.updateHiddenConversPin(String(a.pin));
            return { success: true };
        },
    },
    hidden_pin_reset: {
        guard: () => ({ key: "conv.hiddenPinReset", target: {} }),
        async run(_a, { api }) {
            await api.resetHiddenConversPin();
            return { success: true };
        },
    },
    auto_delete_status: {
        async run(_a, { api }) {
            return { data: (await api.getAutoDeleteChat()) ?? null };
        },
    },
    auto_delete: {
        needs: ["threadId", "ttl"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            await ctx.api.updateAutoDeleteChat(AUTO_DELETE_TTLS[a.ttl], a.threadId, type);
            return { success: true, threadId: a.threadId, threadType: ctx.threadTypeName(type), ttl: a.ttl };
        },
    },
    delete: {
        needs: ["threadId"],
        check: (a) => {
            const given = [a.senderId, a.cliMsgId, a.msgId].filter((v) => v !== undefined).length;
            return given === 0 || given === 3
                ? undefined
                : "Give all three of senderId, cliMsgId and msgId (the newest message to delete back from), or none.";
        },
        guard: (a) => ({ key: "conv.delete", target: { threadId: a.threadId } }),
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            // deleteChat works BACKWARDS from an anchor message (see `conv delete`): the caller's, else the newest
            // the group store or the cache knows, which may lag the newest message by a little.
            const anchor =
                a.msgId !== undefined
                    ? { ownerId: String(a.senderId), cliMsgId: String(a.cliMsgId), globalMsgId: String(a.msgId) }
                    : await newestMessageAnchor(ctx.api, a.threadId, type);
            if (!anchor) {
                throw new Error(
                    "Could not find the newest message to delete backwards from: no cached message of this " +
                        "conversation carries a cliMsgId. Fetch it with zalo_get_history first, or give senderId, " +
                        "cliMsgId and msgId of its newest message.",
                );
            }
            await ctx.api.deleteChat(anchor, a.threadId, type);
            // Zalo forgets it; the cache flags it, so its leftovers surface as orphaned (see `conv delete`).
            try {
                markThreadGone(String(a.threadId));
            } catch {
                /* no local cache for this thread is fine */
            }
            return {
                success: true,
                threadId: a.threadId,
                threadType: ctx.threadTypeName(type),
                fromMsgId: anchor.globalMsgId,
            };
        },
    },
    forget: {
        check: (a) =>
            Boolean(a.threadId) === Boolean(a.orphans)
                ? "Give threadId, or orphans: true for every conversation the account no longer has (not both)."
                : undefined,
        guard: (a) => ({ key: "conv.forget", target: { threadId: a.threadId ?? null, orphans: Boolean(a.orphans) } }),
        // Like `conv forget --dry-run`: the preview lists what would go.
        preview: (a) => ({ conversations: forgetTargets(a) }),
        async run(a) {
            const targets = forgetTargets(a);
            let messages = 0;
            let files = 0;
            const errors = [];
            for (const t of targets) {
                const gone = await forgetConversation(t.threadId);
                messages += gone.messages;
                files += gone.files;
                for (const e of gone.errors) errors.push({ threadId: t.threadId, ...e });
            }
            return {
                success: errors.length === 0,
                forgotten: targets.length,
                messages,
                files,
                ...(errors.length > 0 && { errors }),
                note: "Nothing was sent to Zalo; only this machine's copy was removed.",
            };
        },
    },
    typing: {
        needs: ["threadId"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            await ctx.api.sendTypingEvent(a.threadId, type);
            return { success: true, threadId: a.threadId, threadType: ctx.threadTypeName(type) };
        },
    },
    report: {
        needs: ["threadId", "reason"],
        check: (a) => {
            try {
                parseReportReason(a.reason, a.content);
                return undefined;
            } catch (e) {
                return e.message.replace("--reason", "reason").replace("--content", "content");
            }
        },
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            const res = await ctx.api.sendReport(parseReportReason(a.reason, a.content), a.threadId, type);
            return {
                success: true,
                threadId: a.threadId,
                threadType: ctx.threadTypeName(type),
                reportId: res?.reportId === undefined ? null : String(res.reportId),
            };
        },
    },
};

/** The conversations `forget` removes: the one named, or every orphan in the cache. */
function forgetTargets(a) {
    if (!a.orphans) return [{ threadId: String(a.threadId) }];
    return getOrphanThreads().map((t) => ({
        threadId: String(t.threadId),
        name: t.name || null,
        messages: t.messages || 0,
        files: t.files || 0,
    }));
}

/** zalo_conversation's metadata. */
export const CONVERSATION_META = {
    title: "Manage Zalo Conversations",
    description:
        "Change how a conversation sits in this account's list, as the `conv` commands do. Actions: " +
        "'pinned', 'archived', 'muted', 'hidden' and 'auto_delete_status' list them; " +
        "'pin' / 'unpin', 'archive' / 'unarchive' (Zalo's Other tab), 'mute' (for `durationSeconds`, default " +
        "forever) / 'unmute', 'read' (clear the unread mark and send a seen receipt for the newest cached " +
        "incoming message; zalo_mark_read only moves this server's own cursor) / 'unread', 'hide' / 'unhide' " +
        "(threadIds, all DMs or all groups), 'hidden_pin' (set the 4-digit PIN of hidden conversations), " +
        "'hidden_pin_reset', 'auto_delete' (`ttl`), 'delete' (delete the conversation's history on Zalo for this " +
        "account), 'forget' (delete this machine's copy: messages, board items and media; Zalo is not contacted), " +
        "'typing' (show the typing indicator) and 'report' (report the user or group to Zalo). " +
        "'unhide', 'hidden_pin_reset', 'delete' and 'forget' are asked about first: `confirm`, `dryRun`.",
    inputSchema: z
        .object({
            action: z
                .enum(Object.keys(CONVERSATION_ACTIONS))
                .describe("Conversation operation to perform (the `conv` subcommand, with _ for -)"),
            threadId: z
                .string()
                .min(1)
                .optional()
                .describe(
                    "The conversation: a user id for a DM, a group id for a group (zalo_list_conversations lists them)",
                ),
            threadIds: z
                .array(z.string().min(1))
                .min(1)
                .max(100)
                .optional()
                .describe("Several conversations, all DMs or all groups (required for 'hide' and 'unhide')"),
            threadType: z
                .enum(["dm", "group"])
                .optional()
                .describe('"dm" or "group". Leave it out: the type stored for the thread is used.'),
            durationSeconds: z
                .number()
                .int()
                .min(-1)
                .optional()
                .describe("Only for 'mute': how long, in seconds; -1 (the default) mutes until unmuted"),
            ttl: z
                .enum(Object.keys(AUTO_DELETE_TTLS))
                .optional()
                .describe("Only for 'auto_delete': delete messages after 1d, 7d or 14d, or 'off'"),
            pin: z.string().optional().describe("Only for 'hidden_pin': the new 4-digit PIN of hidden conversations"),
            orphans: z
                .boolean()
                .optional()
                .describe("Only for 'forget': every conversation the account no longer has, instead of threadId"),
            senderId: z
                .string()
                .optional()
                .describe(
                    "Only for 'delete': the sender of the newest message to delete back from (with cliMsgId, msgId)",
                ),
            cliMsgId: z
                .string()
                .optional()
                .describe(
                    "Only for 'delete': that message's cliMsgId; leave all three out to use the newest cached one",
                ),
            msgId: z.string().optional().describe("Only for 'delete': that message's msgId (from zalo_get_history)"),
            reason: z
                .enum(Object.keys(REPORT_REASONS))
                .optional()
                .describe("Only for 'report': why (sensitive, annoy, fraud, or other with `content`)"),
            content: z
                .string()
                .optional()
                .describe("Only for 'report': what happened; required with reason 'other' and refused otherwise"),
            confirm: confirmInput("'unhide', 'hidden_pin_reset', 'delete' and 'forget'"),
            dryRun: dryRunInput("'unhide', 'hidden_pin_reset', 'delete' and 'forget'"),
        })
        .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
