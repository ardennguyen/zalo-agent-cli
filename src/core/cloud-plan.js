/**
 * What is in the zCloud index, what a cleanup would touch (decision D27, 2026-10-28), and what deleting it sends.
 *
 * Zalo has no endpoint that deletes a zCloud item. Zalo Web's own "Delete" in its cloud view (the confirm dialog
 * `STR_MY_CLOUD_DELETE_TITLE`, bundle 2026-11-06) deletes the chat MESSAGE each item belongs to, for this account only
 * (`onlyMe`, the delete-for-me sync), one message at a time, conversation by conversation, and waits for the cloud
 * queue to drop the items. That has no undo. The planning half reads the local index (`cloud_items`, filled by
 * `sync-cloud`) and the local message cache and sends nothing; {@link cloudDeleteTarget} builds the message reference
 * the Web sends for one item, which `cloud apply` hands to the session's `deleteMessage`.
 */

/** The message types of a queue item, as the Web client names them, reduced to the kinds a person thinks in. */
const KIND_OF = {
    "chat.photo": "photo",
    "chat.video.msg": "video",
    "chat.voice": "voice",
    "share.file": "file",
    "chat.gif": "gif",
    "chat.doodle": "photo",
};

/** The default and the largest number of items a plan lists. */
export const PLAN_DEFAULT_LIMIT = 200;
export const PLAN_MAX_LIMIT = 2000;

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
 * The message reference Zalo Web's cloud delete sends for one item (its `deleteCloudItems`): the message's global id,
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
 * Delete the messages behind planned items for this account, as Zalo Web's cloud delete does: conversation by
 * conversation, one message at a time, stopping a conversation at its first failure (the Web throws there) and going
 * on with the next. The local index is left alone: the server's cloud queue reports the removals, and the next
 * `sync-cloud` applies them, as the Web's view waits for them.
 *
 * @param {object} args
 * @param {Array<ReturnType<typeof describeItem>>} args.items - the planned items
 * @param {string|null} args.ownId
 * @param {(target: object) => Promise<unknown>} args.deleteForMe - `(t) => api.deleteMessage(t, true)`
 * @param {(p: {done: number, total: number, item: object, ok: boolean, error?: string}) => void} [args.onProgress]
 * @returns {Promise<{deleted: number, failed: Array<{noiseId: string, threadId: string|null, error: string}>,
 *   skipped: Array<{noiseId: string, reason: string}>, bytes: number}>} `bytes`: the media of the deleted items
 */
export async function applyCloudCleanup({ items, ownId, deleteForMe, onProgress = () => {} }) {
    const byConv = new Map();
    const skipped = [];
    for (const it of items) {
        const target = cloudDeleteTarget(it, ownId);
        if (!target) {
            skipped.push({
                noiseId: it.noiseId,
                reason: it.e2ee ? "end-to-end encrypted" : "the message is not named",
            });
            continue;
        }
        const list = byConv.get(target.threadId) ?? [];
        list.push({ it, target });
        byConv.set(target.threadId, list);
    }
    const total = items.length - skipped.length;
    const failed = [];
    let deleted = 0;
    let bytes = 0;
    let done = 0;
    for (const [threadId, list] of byConv) {
        for (let i = 0; i < list.length; i++) {
            const { it, target } = list[i];
            try {
                await deleteForMe(target);
                deleted++;
                bytes += it.bytes;
                onProgress({ done: ++done, total, item: it, ok: true });
            } catch (e) {
                const error = e?.message || String(e);
                failed.push({ noiseId: it.noiseId, threadId, error });
                onProgress({ done: ++done, total, item: it, ok: false, error });
                for (const rest of list.slice(i + 1)) {
                    failed.push({ noiseId: rest.it.noiseId, threadId, error: "not tried: an earlier delete failed" });
                }
                break;
            }
        }
    }
    return { deleted, failed, skipped, bytes };
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
 * @param {number} [args.filters.limit] - items listed (the totals cover every match)
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
    const limit = Math.min(PLAN_MAX_LIMIT, Math.max(1, Math.floor(Number(filters.limit) || PLAN_DEFAULT_LIMIT)));
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
        byConversation: [...convs.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 20),
        excluded,
        risks,
    };
}

/**
 * The words that go with every plan: what applying one would mean at Zalo. Printed, and stored in the plan file.
 */
export const CLEANUP_WARNING =
    "Zalo has no endpoint that deletes a zCloud item. The only removal, the one Zalo Web's cloud view uses, is deleting " +
    "the chat message the item belongs to, for this account on every device, and that cannot be undone. This is a " +
    "report: nothing was sent to Zalo and nothing was deleted (`cloud apply --yes` with the same filters does it).";
