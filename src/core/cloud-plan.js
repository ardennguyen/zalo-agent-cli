/**
 * What is in the zCloud index, what a cleanup would touch (decision D27, 2026-10-28), and what deleting it sends.
 *
 * Zalo has no endpoint that deletes a zCloud item. Zalo's own "Delete" in its cloud view deletes the chat MESSAGE
 * each item belongs to, for this account only (`onlyMe`, the delete-for-me sync), one message at a time, conversation
 * by conversation, and waits for the cloud queue to drop the items. That has no undo. The planning half reads the local
 * index (`cloud_items`, filled by `sync-cloud`) and the local message cache and sends nothing; {@link
 * cloudDeleteTarget} builds the message reference Zalo's cloud delete sends for one item, which `cloud apply` hands to
 * the session's `deleteMessage`.
 */

/** The message types of a queue item, as Zalo names them, reduced to the kinds a person thinks in. */
const KIND_OF = {
    "chat.photo": "photo",
    "chat.video.msg": "video",
    "chat.voice": "voice",
    "share.file": "file",
    "chat.gif": "gif",
    "chat.doodle": "photo",
};

/**
 * Items per page of Zalo's cloud manager: fixed at 60. Its "select all" selects the loaded page, and a delete works
 * through that page; `cloud apply` works through every match the same way, a page of 60 after another.
 */
export const CLOUD_PAGE_SIZE = 60;

const DAY_MS = 86_400_000;

/**
 * An item reduced to what a plan needs.
 *
 * @param {object} row - a `cloud_items` row
 * @param {string|null} ownId
 * @returns {{noiseId: string, threadId: string|null, bytes: number, ts: number, kind: string, group: boolean,
 *   incoming: boolean, selfChat: boolean, e2ee: boolean, cliMsgId: string|null, zKey: string|null}}
 */
export function describeItem(row, ownId = null) {
    let raw = {};
    try {
        raw = JSON.parse(row.raw_data || "{}");
    } catch {
        raw = {};
    }
    const info = raw.msgInfo || {};
    const type = String(info.msgType ?? "");
    const src = info.srcId === undefined || info.srcId === null ? null : String(info.srcId);
    return {
        noiseId: String(row.noiseId),
        threadId: row.threadId === null || row.threadId === undefined ? null : String(row.threadId),
        bytes: Number(row.mediaSize) || 0,
        ts: Number(row.timestamp) || Number(info.ts) || 0,
        kind: KIND_OF[type] ?? (type ? "other" : "unknown"),
        group: Number(info.destType) === 6,
        incoming: Boolean(ownId && src && src !== String(ownId)),
        // The self chat ("My Cloud"): sent to oneself.
        selfChat: Boolean(ownId && String(row.threadId) === String(ownId)),
        e2ee: Number(info.isE2EE) === 1,
        cliMsgId: info.cliMsgId === undefined || info.cliMsgId === null ? null : String(info.cliMsgId),
        msgId: info.glbMsgId === undefined || info.glbMsgId === null ? null : String(info.glbMsgId),
        srcId: src,
        zKey: row.zKey ?? null,
    };
}

/**
 * The message reference Zalo's cloud delete sends for one item: the message's global id,
 * or `<cliMsgId>_001` when the queue names none; this account written as `"0"` when it sent the message; the
 * conversation the item belongs to. In the shape the session's `deleteMessage(target, true)` takes.
 *
 * @param {ReturnType<typeof describeItem>} item
 * @param {string|null} ownId
 * @returns {{data: {cliMsgId: string, msgId: string, uidFrom: string}, threadId: string, type: 0|1}|null} null for an
 *   item without a client message id, a sender or a conversation (it cannot be named), or an encrypted one
 */
export function cloudDeleteTarget(item, ownId) {
    if (!item || item.e2ee || !item.cliMsgId || !item.srcId || !item.threadId) return null;
    const msgId = item.msgId || `${item.cliMsgId}_001`;
    const uidFrom = ownId && item.srcId === String(ownId) ? "0" : item.srcId;
    return { data: { cliMsgId: item.cliMsgId, msgId, uidFrom }, threadId: item.threadId, type: item.group ? 1 : 0 };
}

/**
 * Delete the messages behind planned items for this account, as Zalo's cloud manager does: a page of
 * {@link CLOUD_PAGE_SIZE} items at a time, and within a page conversation by conversation, one delete-for-me per
 * message, sequentially, with no pause. A conversation stops at its first failure: the rest of
 * its items, in this page and every later one, are not tried, and the other conversations go on. The local index is
 * left alone: the server's cloud queue reports the removals, and the next `sync-cloud` applies them.
 *
 * @param {object} args
 * @param {Array<ReturnType<typeof describeItem>>} args.items - the planned items (every match unless a limit was asked)
 * @param {string|null} args.ownId
 * @param {(target: object) => Promise<unknown>} args.deleteForMe - `(t) => api.deleteMessage(t, true)`
 * @param {(p: {done: number, total: number, item: object, ok: boolean, error?: string, page: number}) => void}
 *   [args.onProgress]
 * @param {number} [args.pageSize] - items per page (tests)
 * @returns {Promise<{deleted: number, failed: Array<{noiseId: string, threadId: string|null, error: string}>,
 *   skipped: Array<{noiseId: string, reason: string}>, bytes: number, pages: number,
 *   stoppedConversations: Array<{threadId: string, error: string}>}>} `bytes`: the media of the deleted items
 */
export async function applyCloudCleanup({
    items,
    ownId,
    deleteForMe,
    onProgress = () => {},
    pageSize = CLOUD_PAGE_SIZE,
}) {
    const skipped = [];
    const named = [];
    for (const it of items) {
        const target = cloudDeleteTarget(it, ownId);
        if (!target) {
            skipped.push({
                noiseId: it.noiseId,
                reason: it.e2ee ? "end-to-end encrypted" : "the message is not named",
            });
            continue;
        }
        named.push({ it, target });
    }
    const total = named.length;
    const failed = [];
    const stopped = new Map(); // threadId -> the error that stopped it
    let deleted = 0;
    let bytes = 0;
    let done = 0;
    let pages = 0;
    for (let start = 0; start < named.length; start += pageSize) {
        pages++;
        const byConv = new Map();
        for (const entry of named.slice(start, start + pageSize)) {
            const list = byConv.get(entry.target.threadId) ?? [];
            list.push(entry);
            byConv.set(entry.target.threadId, list);
        }
        for (const [threadId, list] of byConv) {
            for (const { it, target } of list) {
                if (stopped.has(threadId)) {
                    failed.push({ noiseId: it.noiseId, threadId, error: "not tried: an earlier delete failed" });
                    continue;
                }
                try {
                    await deleteForMe(target);
                    deleted++;
                    bytes += it.bytes;
                    onProgress({ done: ++done, total, item: it, ok: true, page: pages });
                } catch (e) {
                    const error = e?.message || String(e);
                    stopped.set(threadId, error);
                    failed.push({ noiseId: it.noiseId, threadId, error });
                    onProgress({ done: ++done, total, item: it, ok: false, error, page: pages });
                }
            }
        }
    }
    const stoppedConversations = [...stopped].map(([threadId, error]) => ({ threadId, error }));
    return { deleted, failed, skipped, bytes, pages, stoppedConversations };
}

/**
 * Plan a cleanup: which items, how many bytes, and what is risky. A dry run on the local index.
 *
 * Excluded always: end-to-end encrypted items (their removal needs a key and a Signal identity this tool does not
 * have). Excluded unless asked: groups, My Cloud (the self chat).
 *
 * @param {object} args
 * @param {object[]} args.rows - `cloud_items` rows
 * @param {string|null} [args.ownId]
 * @param {object} [args.filters]
 * @param {string[]} [args.filters.threads] - only these conversations
 * @param {string[]} [args.filters.kinds] - only these kinds (photo, video, file, voice, gif, other)
 * @param {number} [args.filters.olderThanDays]
 * @param {number} [args.filters.largerThanBytes]
 * @param {boolean} [args.filters.onlySavedLocally] - only items whose file this machine already has
 * @param {boolean} [args.filters.includeGroups=false]
 * @param {boolean} [args.filters.includeMyCloud=false]
 * @param {number} [args.filters.limit] - items listed; every match unless given (the totals always cover every match)
 * @param {(item: ReturnType<typeof describeItem>) => boolean} [args.savedLocally] - whether this machine holds the
 *   item's file
 * @param {(threadId: string) => string|null} [args.nameOf]
 * @param {number} [args.now]
 * @returns {{
 *   items: Array<object>, matched: number, listed: number, bytes: number,
 *   byKind: Record<string, {items: number, bytes: number}>,
 *   byConversation: Array<{threadId: string, name: string|null, items: number, bytes: number}>,
 *   excluded: {e2ee: number, groups: number, myCloud: number, notSavedLocally: number},
 *   risks: {notSavedLocally: number, incoming: number, groups: number}
 * }}
 */
export function planCloudCleanup({
    rows,
    ownId = null,
    filters = {},
    savedLocally = () => false,
    nameOf = () => null,
    now = Date.now(),
}) {
    const {
        threads = [],
        kinds = [],
        olderThanDays = null,
        largerThanBytes = null,
        onlySavedLocally = false,
        includeGroups = false,
        includeMyCloud = false,
    } = filters;
    // No limit by default: the plan lists every match, and `apply` acts on every one. A limit is the caller's choice.
    const asked = Math.floor(Number(filters.limit));
    const limit = Number.isFinite(asked) && asked >= 1 ? asked : Infinity;
    const wantThreads = new Set(threads.map(String));
    const wantKinds = new Set(kinds.map((k) => String(k).toLowerCase()));
    const cutoff = olderThanDays === null || olderThanDays === undefined ? null : now - Number(olderThanDays) * DAY_MS;

    const excluded = { e2ee: 0, groups: 0, myCloud: 0, notSavedLocally: 0 };
    const chosen = [];
    for (const row of rows) {
        const it = describeItem(row, ownId);
        if (wantThreads.size && !wantThreads.has(String(it.threadId))) continue;
        if (wantKinds.size && !wantKinds.has(it.kind)) continue;
        if (cutoff !== null && !(it.ts > 0 && it.ts < cutoff)) continue;
        if (largerThanBytes !== null && !(it.bytes >= Number(largerThanBytes))) continue;
        if (it.e2ee) {
            excluded.e2ee++;
            continue;
        }
        if (it.selfChat && !includeMyCloud) {
            excluded.myCloud++;
            continue;
        }
        if (it.group && !includeGroups) {
            excluded.groups++;
            continue;
        }
        const saved = Boolean(savedLocally(it));
        if (onlySavedLocally && !saved) {
            excluded.notSavedLocally++;
            continue;
        }
        chosen.push({ ...it, saved });
    }
    chosen.sort((a, b) => b.bytes - a.bytes || b.ts - a.ts);

    const byKind = {};
    const convs = new Map();
    const risks = { notSavedLocally: 0, incoming: 0, groups: 0 };
    let bytes = 0;
    for (const it of chosen) {
        bytes += it.bytes;
        const k = (byKind[it.kind] ??= { items: 0, bytes: 0 });
        k.items++;
        k.bytes += it.bytes;
        const key = it.threadId ?? "?";
        const c = convs.get(key) ?? { threadId: key, name: nameOf(key), items: 0, bytes: 0 };
        c.items++;
        c.bytes += it.bytes;
        convs.set(key, c);
        if (!it.saved) risks.notSavedLocally++;
        if (it.incoming) risks.incoming++;
        if (it.group) risks.groups++;
    }
    const listed = chosen.slice(0, limit).map((it) => ({
        ...it,
        risk: [!it.saved && "not-saved-locally", it.incoming && "incoming-message", it.group && "group"].filter(
            Boolean,
        ),
    }));
    return {
        items: listed,
        matched: chosen.length,
        listed: listed.length,
        bytes,
        byKind,
        byConversation: [...convs.values()].sort((a, b) => b.bytes - a.bytes),
        excluded,
        risks,
    };
}

/**
 * The words that go with every plan: what applying one would mean at Zalo. Printed, and stored in the plan file.
 */
export const CLEANUP_WARNING =
    "Zalo has no endpoint that deletes a zCloud item. The only removal, the one Zalo's own cloud view uses, is " +
    "deleting the chat message the item belongs to, for this account on every device, and that cannot be undone. This is a " +
    "report: nothing was sent to Zalo and nothing was deleted (`cloud apply --yes` with the same filters does it).";
