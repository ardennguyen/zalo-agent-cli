/**
 * Smaller MCP action tools: stickers (`zalo_sticker`, `msg sticker-list` / `sticker-detail`), links (`zalo_link`,
 * `msg link-preview` / `scan-url`) and the local zCloud index (`zalo_cloud`, `cloud ls` / `cloud plan`). Each action
 * makes its command's call; the cloud actions read only the local cache, as their commands do.
 */

import { z } from "zod";
import { findMessageByClientId, getCloudItems, getThreadNames } from "../core/db.js";
import { CLEANUP_WARNING, applyCloudCleanup, planCloudCleanup } from "../core/cloud-plan.js";
import { confirmInput, dryRunInput, ticketInput } from "./action-tool.js";

const MB = 1024 * 1024;

// --- zalo_sticker ---

/** The action table; see src/mcp/action-tool.js for what a row holds. */
export const STICKER_ACTIONS = {
    search: {
        needs: ["keyword"],
        async run(a, { api }) {
            const ids = (await api.getStickers(a.keyword)) ?? [];
            const stickerIds = (Array.isArray(ids) ? ids : []).map(String);
            return { keyword: a.keyword, count: stickerIds.length, stickerIds };
        },
    },
    detail: {
        needs: ["stickerIds"],
        async run(a, { api }) {
            return { data: (await api.getStickersDetail(a.stickerIds.map(Number))) ?? null };
        },
    },
};

/** zalo_sticker's metadata. */
export const STICKER_META = {
    title: "Find Zalo Stickers",
    description:
        "Find Zalo stickers. Actions: 'search' (the sticker ids matching `keyword`) and 'detail' (the details of " +
        "`stickerIds`). To send a sticker, give zalo_send_message a `sticker` keyword; zalo_read 'sticker-category' " +
        "reads a sticker category. Read-only: nothing is sent.",
    inputSchema: z
        .object({
            action: z.enum(Object.keys(STICKER_ACTIONS)).describe("Sticker operation to perform"),
            keyword: z.string().min(1).max(100).optional().describe("Only for 'search': a word to find stickers by"),
            stickerIds: z
                .array(z.string().min(1))
                .min(1)
                .max(50)
                .optional()
                .describe("Only for 'detail': sticker ids, from 'search'"),
        })
        .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

// --- zalo_link ---

/** The action table; see src/mcp/action-tool.js for what a row holds. */
export const LINK_ACTIONS = {
    preview: {
        needs: ["url"],
        async run(a, { api }) {
            const d = (await api.parseLink(a.url))?.data ?? {};
            return {
                url: a.url,
                title: d.title ?? null,
                description: d.desc ?? null,
                source: d.src || d.href || null,
                thumbnail: d.thumb ?? null,
            };
        },
    },
    scan: {
        needs: ["url"],
        async run(a, { api }) {
            const res = await api.scanURL(a.url);
            return { url: a.url, isSafe: res?.isSafe === undefined ? null : Boolean(res.isSafe), data: res ?? null };
        },
    },
};

/** zalo_link's metadata. */
export const LINK_META = {
    title: "Check a Link with Zalo",
    description:
        "Ask Zalo about a link without sending it anywhere. Actions: 'preview' (the title, description and " +
        "thumbnail Zalo would show for `url`) and 'scan' (whether Zalo considers `url` safe to open). To send " +
        "a link card to a conversation, use zalo_send_message `link`.",
    inputSchema: z
        .object({
            action: z.enum(Object.keys(LINK_ACTIONS)).describe("Link operation to perform"),
            url: z.string().url().optional().describe("The link to ask about (required)"),
        })
        .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

// --- zalo_cloud ---

/** "12.3 MB": the size the guard's sentence quotes, as `cloud apply` words it. */
function bytesText(n) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = Number(n) || 0;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** A cleanup plan from the local index, with the filters 'plan' and 'apply' share (as `cloud plan` / `apply`). */
function planOf(a, ctx) {
    const index = openIndex();
    return planCloudCleanup({
        rows: index.rows,
        ownId: ctx.ownId(),
        filters: {
            threads: a.threadIds ?? [],
            kinds: a.kinds ?? [],
            olderThanDays: a.olderThanDays ?? null,
            largerThanBytes: a.largerThanMb === undefined ? null : a.largerThanMb * MB,
            onlySavedLocally: Boolean(a.onlySavedLocally),
            includeGroups: Boolean(a.includeGroups),
            includeMyCloud: Boolean(a.includeMyCloud),
            limit: a.limit,
        },
        savedLocally: index.savedLocally,
        nameOf: index.nameOf,
    });
}

/** What `cloud apply` would act on, as the guard's target: the listed items, their size, their conversations. */
function applyTarget(r) {
    return {
        items: r.listed,
        size: bytesText(r.items.reduce((sum, it) => sum + it.bytes, 0)),
        conversations: new Set(r.items.map((it) => it.threadId)).size,
    };
}

/** The local zCloud index and the helpers a plan needs, as `cloud` reads them. */
function openIndex() {
    const rows = getCloudItems(null, 10_000_000);
    const names = getThreadNames();
    const savedLocally = (item) => {
        if (!item.cliMsgId) return false;
        try {
            return Boolean(findMessageByClientId(item.cliMsgId, item.threadId)?.localPath);
        } catch {
            return false;
        }
    };
    return { rows, nameOf: (id) => names.get(String(id))?.name ?? null, savedLocally };
}

/** The action table; see src/mcp/action-tool.js for what a row holds. */
export const CLOUD_ACTIONS = {
    summary: {
        async run(a, ctx) {
            const index = openIndex();
            const r = planCloudCleanup({
                rows: index.rows,
                ownId: ctx.ownId(),
                filters: { includeGroups: true, includeMyCloud: true, limit: 1 },
                nameOf: index.nameOf,
            });
            return {
                items: r.matched + r.excluded.e2ee,
                bytes: r.bytes,
                byKind: r.byKind,
                byConversation: a.top ? r.byConversation.slice(0, a.top) : r.byConversation,
                e2eeItems: r.excluded.e2ee,
                ...(r.matched + r.excluded.e2ee === 0 && {
                    note: "The local zCloud index is empty: zalo_sync stage 'cloud' fills it.",
                }),
            };
        },
    },
    plan: {
        async run(a, ctx) {
            return { warning: CLEANUP_WARNING, generatedAt: new Date().toISOString(), ...planOf(a, ctx) };
        },
    },
    apply: {
        // The plan is read from the local index first, so the guard, the preview and the call see the same items.
        prepare: (a, ctx) => {
            const plan = planOf(a, ctx);
            return { plan, applyTarget: applyTarget(plan) };
        },
        guard: (a) => ({ key: "cloud.delete", target: a.applyTarget }),
        // Like `cloud apply --dry-run`: the plan itself.
        preview: (a) => ({ warning: CLEANUP_WARNING, verified: false, plan: a.plan }),
        async run(a, ctx) {
            if (!a.plan.listed) return { deleted: 0, failed: [], skipped: [], bytes: 0, matched: 0, verified: false };
            // As `cloud apply`: delete the chat message behind each item, for this account on every device.
            const result = await applyCloudCleanup({
                items: a.plan.items,
                ownId: ctx.ownId(),
                deleteForMe: (t) => ctx.api.deleteMessage(t, true),
            });
            return { ...result, matched: a.plan.matched, verified: false, warning: CLEANUP_WARNING };
        },
    },
};

/** zalo_cloud's metadata. */
export const CLOUD_META = {
    title: "Zalo zCloud Index",
    description:
        "What the account's zCloud index holds, what a cleanup would cover, and the cleanup itself (the `cloud` " +
        "commands), from the local index (zalo_sync stage 'cloud' fills it). Actions: 'summary' (items and bytes by " +
        "kind and by conversation) and 'plan' (the items a cleanup of this shape would cover, and the space it would " +
        "free; groups and My Cloud are left out unless asked for) only read; 'apply' deletes the chat message behind " +
        "each planned item, for this account on every device, as Zalo's cloud view does: it cannot be undone, " +
        "has not been validated live yet, and is asked about first (`confirm`, `dryRun` shows the plan).",
    inputSchema: z
        .object({
            action: z.enum(Object.keys(CLOUD_ACTIONS)).describe("zCloud report to make"),
            top: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe("Only for 'summary': conversations to list (omit for all)"),
            threadIds: z
                .array(z.string().min(1))
                .min(1)
                .max(100)
                .optional()
                .describe("For 'plan' and 'apply': only these conversations"),
            kinds: z
                .array(z.enum(["photo", "video", "file", "voice", "gif", "other"]))
                .min(1)
                .optional()
                .describe("For 'plan' and 'apply': only these kinds"),
            olderThanDays: z
                .number()
                .min(0)
                .optional()
                .describe("For 'plan' and 'apply': only items older than this many days"),
            largerThanMb: z
                .number()
                .min(0)
                .optional()
                .describe("For 'plan' and 'apply': only items of at least this many MB"),
            limit: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe("For 'plan' and 'apply': items to list and act on (default: every match)"),
            onlySavedLocally: z
                .boolean()
                .optional()
                .describe("For 'plan' and 'apply': only items whose file this machine already holds"),
            includeGroups: z.boolean().optional().describe("For 'plan' and 'apply': include group conversations"),
            includeMyCloud: z
                .boolean()
                .optional()
                .describe("For 'plan' and 'apply': include My Cloud, the chat with yourself"),
            confirm: confirmInput("'apply'"),
            ticket: ticketInput(),
            dryRun: dryRunInput("'apply'"),
        })
        .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
