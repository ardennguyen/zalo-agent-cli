/**
 * What is in the zCloud index, and what a cleanup would touch: a report, never an action (decision D27, 2026-10-28).
 *
 * Zalo has no endpoint that deletes a zCloud item. The only removal the clients have is deleting the chat MESSAGE the
 * item belongs to, for this account on every device (`onlyMe`), which has no undo, so this module only describes. It
 * reads the local index (`cloud_items`, filled by `sync-cloud`) and the local message cache, and names the items a
 * cleanup of a given shape would cover, how much space that frees, and what is risky about it. Nothing is sent to Zalo.
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
        zKey: row.zKey ?? null,
    };
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
    "Zalo has no endpoint that deletes a zCloud item. The only removal is deleting the chat message the item belongs to, " +
    "for this account on every device, and that cannot be undone. This is a report: nothing was sent to Zalo and nothing " +
    "was deleted.";
