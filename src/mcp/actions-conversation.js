/**
 * `zalo_conversation`: the `conv` commands (and `msg typing`, `msg report`) as MCP actions. Each action makes the
 * call its command makes: pinning and archiving through src/core/conversation-actions.js, marking read through
 * src/core/receipts.js, the rest through the session's own methods.
 */

import { z } from "zod";
import { MUTE_ACTION } from "../zalo/enums.js";
import { getMessages, getOrphanThreads, markThreadGone } from "../core/db.js";
import { markConversationRead, seenMessages, unreadMarkAnchor } from "../core/receipts.js";
import { sendTyping } from "../core/typing.js";
import { setBlockSharing } from "../core/block-sharing.js";
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
import { confirmInput, dryRunInput, ticketInput } from "./action-tool.js";
import { pinFailureLine, withoutHidden } from "../core/hidden-chats.js";
import { changeHiddenPin, readHidden, resetHiddenPinAndDelete } from "../core/hidden-chat-actions.js";
import { askOnSecurePage } from "../core/secure-page.js";
import { resolveAllowPinArgument, resolveApproval } from "../core/deploy-policy.js";

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

/** A "needs X" reply (src/mcp/action-tool.js turns it into the error reply with these fields). */
const needs = (reply) => ({ needsReply: reply });

/** The refusal of a `pin`/`newPin` input on a server that does not take one. */
const PIN_INPUT_OFF =
    "The pin and newPin inputs are off on this server (allowPinArgument is false): a PIN passed as an input lands " +
    "in the MCP client's logs and the model's context. Leave them out: the reply gives a one-time page where the " +
    "account owner types it.";

/**
 * The PIN for one hidden-chat action, without the agent ever seeing it: an approved `ticket` from the secure page, the
 * `pin` input where the deployment allows it (allowPinArgument), or else a one-time page (URL elicitation on a live
 * connection, a link in the reply otherwise).
 *
 * @returns {Promise<{ok: true} | {error: string} | {needsReply: object}>}
 */
async function pinGate(a, ctx, extra, { action, target, description }) {
    const set = ctx.hidden();
    await set.refresh(ctx.api);
    if (!set.hasPin) return { error: pinFailureLine({ reason: "no-pin" }) };
    const page = ctx.securePage();
    const expect = { accountId: ctx.ownId(), action, target };
    if (a.ticket) {
        const used = page.store.consume(String(a.ticket), expect);
        return used.ok ? { ok: true } : { error: used.message };
    }
    if (a.pin !== undefined) {
        if (!resolveAllowPinArgument({ config: ctx.config, accountId: ctx.ownId() }).allowed) {
            return { error: PIN_INPUT_OFF };
        }
        const r = set.verifyPin(a.pin);
        return r.ok ? { ok: true } : { error: pinFailureLine(r) };
    }
    const asked = await askOnSecurePage({
        page,
        server: ctx.server,
        extra,
        stateless: ctx.stateless,
        needs: "pinRequired",
        deliver: resolveApproval({ config: ctx.config, accountId: ctx.ownId() }).deliver,
        spec: {
            ...expect,
            kind: "pin",
            title: "Zalo hidden chats",
            description,
            onSubmit: ({ pin }) => {
                const r = set.verifyPin(pin);
                if (r.ok) return { status: "approved", message: "Unlocked. The agent can go on now." };
                return { status: r.reason === "locked" ? "failed" : "retry", message: pinFailureLine(r) };
            },
        },
    });
    if (asked.token) {
        const used = page.store.consume(asked.token, expect);
        return used.ok ? { ok: true } : { error: used.message };
    }
    if (asked.error) return { error: asked.error };
    if (asked.declined) return { error: `The account owner did not complete the PIN page (${asked.declined}).` };
    return needs(asked.reply);
}

/**
 * A list of conversations with the hidden ones left out, as the deployment's hiddenChats policy says (every policy but
 * `include`: a list never shows a contentless row).
 *
 * @param {object} ctx
 * @param {object[]} list
 * @param {(item: object) => unknown} idOf
 * @returns {Promise<object[]>}
 */
async function visible(ctx, list, idOf) {
    if (!Array.isArray(list) || !ctx.hidden || ctx.hiddenMode?.() === "include") return list;
    const set = ctx.hidden();
    await set.ensure(ctx.api);
    return withoutHidden(list, set, ctx.hiddenMode?.() ?? "exclude", idOf);
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
        async run(_a, ctx) {
            const data = (await ctx.api.getArchivedChatList()) ?? null;
            // Zalo's answer is `{items: [{id, type}], version}`; a hidden chat is left out as `conv archived` does.
            if (!Array.isArray(data?.items)) return { data };
            return { data: { ...data, items: await visible(ctx, data.items, (i) => i?.id) } };
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
        async run(_a, ctx) {
            const res = await ctx.api.getMute();
            const entries = (list, threadType) =>
                (Array.isArray(list) ? list : []).map((m) => ({
                    threadId: String(m.id),
                    threadType,
                    muteMode: m.muteMode ?? null,
                    duration: m.duration ?? null,
                }));
            const all = [...entries(res?.chatEntries, "dm"), ...entries(res?.groupChatEntries, "group")];
            return { conversations: await visible(ctx, all, (m) => m.threadId) };
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
            // The same reply as `conv read` (src/core/receipts.js); a failure is an error reply with its fields.
            const r = await markConversationRead(ctx.api, {
                threadId: a.threadId,
                type,
                ownId: ctx.ownId(),
                markOnly: a.markOnly === true,
            });
            return r.success ? r : { needsReply: r };
        },
    },
    seen: {
        needs: ["threadId"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            // The same reply as `msg seen` (src/core/receipts.js).
            const r = await seenMessages(ctx.api, {
                threadId: a.threadId,
                type,
                ownId: ctx.ownId(),
                msgIds: a.msgIds ?? [],
            });
            return r.success ? r : { needsReply: r };
        },
    },
    block_sharing: {
        needs: ["threadId", "enabled"],
        async run(a, ctx) {
            const type = ctx.threadType(a.threadId, a.threadType);
            // The same reply as `conv block-sharing` (src/core/block-sharing.js).
            return setBlockSharing(ctx.api, { threadId: a.threadId, type, enabled: a.enabled });
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
        async run(a, ctx, extra) {
            const set = ctx.hidden();
            const listed = await readHidden(ctx.api, set);
            // With a PIN set, the PIN is checked even when nothing is hidden: a wrong one is refused (and counted)
            // whatever the list holds, as Web asks it before showing the (possibly empty) list.
            if (!listed.hasPin) return { count: listed.count, hasPin: false, threads: [] };
            const held = await pinGate(a, ctx, extra, {
                action: "conv.hidden",
                target: {},
                description:
                    "An agent asks to list this account's hidden conversations. Type the PIN to allow it once.",
            });
            if (held.needsReply) return needs({ ...held.needsReply, count: listed.count, hasPin: true });
            if (held.error) throw new Error(held.error);
            return {
                count: listed.count,
                hasPin: true,
                threads: listed.threads.map((t) => ({
                    threadId: t.threadId,
                    threadType: t.isGroup === null ? null : t.isGroup ? "group" : "dm",
                    name: ctx.threadName?.(t.threadId) ?? null,
                })),
            };
        },
    },
    hide: {
        needs: ["threadIds"],
        async run(a, ctx) {
            const type = oneType(ctx, a.threadIds, a.threadType);
            if (type?.error) throw new Error(type.error);
            const set = ctx.hidden();
            await set.refresh(ctx.api);
            // Zalo Web asks for a PIN before the first hide: a hidden chat with no PIN would be hidden from nobody.
            if (!set.hasPin) throw new Error(`${pinFailureLine({ reason: "no-pin" })} Then hide them.`);
            await ctx.api.setHiddenConversations(true, a.threadIds, type);
            for (const id of a.threadIds) set.ids.add(String(id));
            return { success: true, threadIds: a.threadIds, threadType: ctx.threadTypeName(type) };
        },
    },
    unhide: {
        needs: ["threadIds"],
        guard: (a) => ({ key: "conv.unhide", target: { threadIds: a.threadIds } }),
        async run(a, ctx, extra) {
            const type = oneType(ctx, a.threadIds, a.threadType);
            if (type?.error) throw new Error(type.error);
            // Opening a hidden chat asks the PIN on Web; unhiding one here does too.
            const held = await pinGate(a, ctx, extra, {
                action: "conv.unhide",
                target: { threadIds: a.threadIds },
                description: `An agent asks to unhide ${a.threadIds.length} hidden conversation(s). Type the PIN to allow it.`,
            });
            if (held.needsReply) return held;
            if (held.error) throw new Error(held.error);
            await ctx.api.setHiddenConversations(false, a.threadIds, type);
            for (const id of a.threadIds) ctx.hidden().ids.delete(String(id));
            return { success: true, threadIds: a.threadIds, threadType: ctx.threadTypeName(type) };
        },
    },
    hidden_pin: {
        check: (a) =>
            a.newPin !== undefined && !/^\d{4}$/.test(String(a.newPin)) ? "newPin must be 4 digits." : undefined,
        async run(a, ctx, extra) {
            const set = ctx.hidden();
            await set.refresh(ctx.api);
            const page = ctx.securePage();
            const expect = { accountId: ctx.ownId(), action: "conv.hiddenPin", target: {} };
            if (a.ticket) {
                // The page changed the PIN itself when the owner submitted it; the ticket only reports that.
                const used = page.store.consume(String(a.ticket), expect);
                if (!used.ok) throw new Error(used.message);
                return { success: true, changed: true, hadPin: Boolean(used.ticket.outcome?.hadPin) };
            }
            if (a.pin !== undefined || a.newPin !== undefined) {
                if (!resolveAllowPinArgument({ config: ctx.config, accountId: ctx.ownId() }).allowed) {
                    throw new Error(PIN_INPUT_OFF);
                }
                const r = await changeHiddenPin(ctx.api, set, { pin: a.pin, newPin: a.newPin, newPin2: a.newPin });
                if (!r.ok) throw new Error(r.message);
                return { success: true, changed: true, hadPin: r.hadPin };
            }
            const asked = await askOnSecurePage({
                page,
                server: ctx.server,
                extra,
                stateless: ctx.stateless,
                needs: "pinRequired",
                deliver: resolveApproval({ config: ctx.config, accountId: ctx.ownId() }).deliver,
                spec: {
                    ...expect,
                    kind: "pin-change",
                    hasPin: set.hasPin,
                    title: set.hasPin ? "Change the hidden-chat PIN" : "Set a hidden-chat PIN",
                    description: set.hasPin
                        ? "Type the current PIN, then the new 4-digit PIN twice."
                        : "Type the new 4-digit PIN twice.",
                    onSubmit: async (typed) => {
                        const r = await changeHiddenPin(ctx.api, set, typed);
                        if (r.ok)
                            return { status: "done", message: "The PIN was saved.", outcome: { hadPin: r.hadPin } };
                        return { status: r.retry ? "retry" : "failed", message: r.message };
                    },
                },
            });
            if (asked.token) {
                const used = page.store.consume(asked.token, expect);
                if (!used.ok) throw new Error(used.message);
                return { success: true, changed: true, hadPin: Boolean(used.ticket.outcome?.hadPin) };
            }
            if (asked.error) throw new Error(asked.error);
            if (asked.declined) throw new Error(`The account owner did not complete the PIN page (${asked.declined}).`);
            return needs(asked.reply);
        },
    },
    hidden_pin_reset: {
        guard: () => ({ key: "conv.hiddenPinReset", target: {} }),
        async run(_a, ctx) {
            // Web: removing the PIN needs no PIN, and the device that asked deletes every hidden conversation.
            const r = await resetHiddenPinAndDelete(ctx.api, ctx.hidden());
            return { success: r.conversations.every((c) => c.deleted), ...r };
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
            // The same reply as `msg typing` (src/core/typing.js): refused for a stranger in a DM.
            return sendTyping(ctx.api, { threadId: a.threadId, type, ownId: ctx.ownId() });
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
        "forever) / 'unmute', 'read' (Zalo Web's \"Mark as read\": a seen receipt for every cached incoming message " +
        "newer than the read position, up to 50, a reaction-seen receipt when a reaction is unread, and the unread " +
        'mark removed when set; the sender sees "Seen" unless this account\'s seen status is hidden, ' +
        "zalo_profile 'set' seen-status 0; `markOnly` removes only the unread mark and the real unread count stays; " +
        "zalo_mark_read only moves this server's own cursor) / 'unread', 'seen' (mark the cached messages `msgIds`, " +
        "or the newest incoming one, seen; it also moves this account's read position), 'block_sharing' " +
        "(`enabled`; needs zBusiness Max, unverified), 'hide' / 'unhide' " +
        "(threadIds, all DMs or all groups; hide needs a PIN set, unhide needs the PIN), 'hidden_pin' (set or " +
        "change the 4-digit PIN of hidden conversations), 'hidden_pin_reset' (remove the PIN and, as Zalo Web " +
        "does, delete every hidden conversation), 'auto_delete' (`ttl`), 'delete' (delete the conversation's history on Zalo for this " +
        "account), 'forget' (delete this machine's copy: messages, board items and media; Zalo is not contacted), " +
        "'typing' (show the typing indicator; refused for a stranger in a DM, as Zalo Web never sends it there) and 'report' (report the user or group to Zalo). " +
        "'unhide', 'hidden_pin_reset', 'delete' and 'forget' are asked about first: `confirm`, `dryRun`. " +
        "The PIN is never typed into this tool: 'hidden' (to list the threads), 'unhide' and 'hidden_pin' reply " +
        "pinRequired with a one-time secureUrl for the account owner; repeat the call with its `ticket`.",
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
            pin: z
                .string()
                .optional()
                .describe(
                    "Refused unless the server sets allowPinArgument (it puts the PIN in this client's logs): the " +
                        "current hidden-chat PIN, for 'hidden', 'unhide' and 'hidden_pin'. Leave it out and use the " +
                        "secureUrl the reply gives",
                ),
            newPin: z
                .string()
                .optional()
                .describe("Refused unless the server sets allowPinArgument: the new 4-digit PIN, for 'hidden_pin'"),
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
            markOnly: z
                .boolean()
                .optional()
                .describe(
                    "Only for 'read': remove only the manual unread mark; Zalo's real unread count stays and nothing " +
                        "is marked seen",
                ),
            msgIds: z
                .array(z.string().min(1))
                .min(1)
                .max(50)
                .optional()
                .describe("Only for 'seen': cached incoming messages to mark seen; leave it out for the newest one"),
            enabled: z.boolean().optional().describe("Only for 'block_sharing': true turns it on, false off"),
            confirm: confirmInput("'unhide', 'hidden_pin_reset', 'delete' and 'forget'"),
            dryRun: dryRunInput("'unhide', 'hidden_pin_reset', 'delete' and 'forget'"),
            ticket: ticketInput(),
        })
        .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
