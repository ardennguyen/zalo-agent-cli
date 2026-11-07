/**
 * The local zCloud index: the cloud queue walked into `cloud_items`, and what that index can say about a message.
 *
 * The REST client, its sign-in and the queue's item shapes are the protocol layer's (src/zalo/zcloud.js, whose
 * header explains the handshake and why zCloud is a partial source). This module owns the writes: it applies each
 * queue page to zalo.db the way Zalo Web's walker applies it to its own store.
 */
import {
    backfillCloudZKeys,
    getCloudItemByMsgId,
    getCloudItemByZKey,
    removeCloudItemsBefore,
    removeCloudItemsByZKey,
    removeCloudItemsExcept,
    sweepCloudItemsNotSeenSince,
    upsertCloudItem,
} from "../db.js";
import {
    ACTION,
    LOAD_OLDEST_TO_NEWEST,
    cloudKeyOf,
    conversationOf,
    itemsOf,
    moreFlag,
    nextCursor,
    normalizeCloudItem,
    ownIdOf,
    removalKeysOf,
    selfChatIdOf,
    threadClearOf,
    verifyCloudQueue,
} from "../../zalo/zcloud.js";

/** An entry's time as Zalo Web orders and compares them: the message's own, else the entry's. */
const entryTs = (item) => Number(item?.msgInfo?.ts ?? item?.ts ?? 0) || 0;

/**
 * Apply one page of the queue to the local index, the way Zalo Web's walker does (`verifyFromId`):
 *
 * 1. The newest `reset_cloud` on the page empties the index except the self chat, and every entry on the page that
 *    is older than it (self chat aside) is dropped unread.
 * 2. What is left is read oldest first and applied in three groups, in this order: `add` entries are recorded,
 *    `remove` entries delete the messages they name, `del_thread` entries delete a conversation's older items.
 * 3. `temp` and `duplicate` entries change nothing (the web client does nothing with them either).
 *
 * @param {object[]} items - the page's entries
 * @param {object} [opts]
 * @param {string|null} [opts.ownId]
 * @param {string|null} [opts.selfChatId]
 * @param {number} [opts.seenAt] - stamped on every recorded item (a full walk sweeps on it)
 * @returns {{added:number, removed:number, threadsCleared:number, resets:number, dropped:number,
 *   failures:Array<object>, skipped:Record<string, number>}}
 */
export function applyQueuePage(items, opts = {}) {
    const { ownId = null, seenAt } = opts;
    const selfChatId = opts.selfChatId ?? ownId;
    const out = { added: 0, removed: 0, threadsCleared: 0, resets: 0, dropped: 0, failures: [], skipped: {} };
    const spare = [selfChatId, ownId].filter(Boolean).map(String);

    const newestFirst = [...items].filter(Boolean).sort((a, b) => entryTs(b) - entryTs(a));
    const reset = newestFirst.find((i) => Number(i.action) === 5);
    let live = newestFirst;
    if (reset) {
        out.resets++;
        removeCloudItemsExcept(spare);
        const cut = Number(reset.ts ?? entryTs(reset));
        live = newestFirst.filter((i) => {
            const keep = spare.includes(conversationOf(i.msgInfo, ownId)) || Number(i.ts ?? entryTs(i)) > cut;
            if (!keep) out.dropped++;
            return keep;
        });
    }

    const adds = [];
    const removes = [];
    const clears = [];
    for (const item of live.reverse()) {
        const action = item.action === undefined || item.action === null ? 1 : Number(item.action);
        if (action === 1) adds.push(item);
        else if (action === 2) removes.push(item);
        else if (action === 3) clears.push(item);
        else if (action !== 5) {
            const name = ACTION[action] || `action_${item.action}`;
            out.skipped[name] = (out.skipped[name] || 0) + 1;
        }
    }

    for (const raw of adds) {
        const row = normalizeCloudItem(raw, ownId);
        if (!row) continue;
        try {
            upsertCloudItem({ ...row, seenAt });
            out.added++;
        } catch (e) {
            if (out.failures.length < 20) out.failures.push({ noiseId: row.noiseId, reason: e.message });
        }
    }
    for (const raw of removes) out.removed += removeCloudItemsByZKey(removalKeysOf(raw, ownId));
    for (const raw of clears) {
        const { threadId, deletedAt } = threadClearOf(raw);
        if (!threadId) continue;
        const n = removeCloudItemsBefore(threadId, deletedAt);
        out.removed += n;
        out.threadsCleared++;
    }
    return out;
}

/**
 * Walk the cloud verify queue and keep the local index equal to what it says.
 *
 * This is the CLI's stand-in for what Zalo Web does when it receives a cmd 621 `mycloudMedia` event: page through
 * the queue by `lastNoiseId` while the reply says `hasMore`, applying each page as it arrives
 * ({@link applyQueuePage}: adds are recorded, removals, cleared conversations and resets are applied). A recall, for
 * instance, arrives as a remove entry for a chat.undo, and the item it names is deleted here.
 *
 * `full` walks from the top and, when the server says it is done, deletes every item that no page listed: the
 * mark-and-sweep that corrects an index the incremental walks left stale. It never deletes before the walk has
 * finished, so an interrupted full walk loses nothing.
 *
 * @param {object} opts
 * @param {object} [opts.api]
 * @param {string} [opts.lastNoiseId=""] - resume cursor; "" starts from the top
 * @param {boolean} [opts.full=false] - start from the top and sweep what no page listed
 * @param {number} [opts.pageSize=300] - consulted only when a reply carries no
 *   `hasMore`; the verify request itself has no page-size parameter
 * @param {number} [opts.maxPages=50]
 * @param {string} [opts.ownId] - the account id; defaults to the api's
 * @param {string} [opts.selfChatId] - the self chat's id; defaults to the login's `send2me_id`
 * @param {(p: object) => void} [opts.onProgress]
 * @param {(p: {cursor: string, page: number, complete: boolean}) => void} [opts.onPage] - after each page is applied:
 *   where a later walk may resume (persist it here, so a killed walk still moves forward)
 * @param {(params: object) => Promise<object>} [opts.verify] - injected caller (tests)
 * @returns {Promise<{items:number, removed:number, threadsCleared:number, resets:number, swept:number, pages:number,
 *   lastNoiseId:string|null, failed:number, failures:Array<object>, complete:boolean, skipped:Record<string, number>}>}
 */
export async function syncCloudIndex(opts = {}) {
    const { api, pageSize = 300, maxPages = 50, onProgress = () => {}, onPage = () => {}, full = false } = opts;
    // `complete`: the server said it had nothing further. False means the
    // walk stopped on --pages (or on a cursor it could not advance) and
    // lastNoiseId is where to resume.
    const stats = {
        items: 0,
        removed: 0,
        threadsCleared: 0,
        resets: 0,
        swept: 0,
        pages: 0,
        lastNoiseId: null,
        failed: 0,
        failures: [],
        complete: false,
        skipped: {},
    };
    const verify = opts.verify || (api ? (params) => verifyCloudQueue(api, params) : null);
    if (!verify) return stats;
    const ownId = opts.ownId ?? ownIdOf(api);
    const selfChatId = opts.selfChatId ?? selfChatIdOf(api, ownId);
    const startedAt = Date.now();
    // Rows recorded before the key existed cannot be found by a remove entry until they have it.
    backfillCloudZKeys((raw) => cloudKeyOf(raw, ownId));

    let cursor = full ? "" : opts.lastNoiseId || "";
    for (let page = 0; page < maxPages; page++) {
        let resp;
        try {
            resp = await verify({ lastNoiseId: cursor, loadType: LOAD_OLDEST_TO_NEWEST, listNoiseIds: [] });
        } catch (e) {
            stats.failed++;
            stats.failures.push({ page, reason: e?.message || String(e) });
            break;
        }
        const items = itemsOf(resp);
        stats.pages++;
        const applied = applyQueuePage(items, { ownId, selfChatId, seenAt: startedAt });
        stats.items += applied.added;
        stats.removed += applied.removed;
        stats.threadsCleared += applied.threadsCleared;
        stats.resets += applied.resets;
        for (const [name, n] of Object.entries(applied.skipped)) stats.skipped[name] = (stats.skipped[name] || 0) + n;
        if (applied.failures.length) {
            stats.failed += applied.failures.length;
            for (const f of applied.failures) if (stats.failures.length < 20) stats.failures.push(f);
        }
        onProgress({ phase: "cloud-page", page: stats.pages, items: stats.items, removed: stats.removed });

        const next = nextCursor(resp, items);
        const more = moreFlag(resp);
        const stuck = !next || next === cursor;
        let done = false;
        if (more === null) {
            // No hasMore: fall back to the shape of the page. A short page, a
            // missing cursor, or one that did not move means nothing further.
            if (!items.length || items.length < pageSize || stuck) {
                stats.lastNoiseId = next || cursor || null;
                done = true;
            }
        } else if (!more) {
            stats.lastNoiseId = next || cursor || null;
            done = true;
        } else if (stuck) {
            // The server says there is more but gave no cursor to reach it.
            stats.lastNoiseId = cursor || null;
            stats.failed++;
            stats.failures.push({ page, reason: "zCloud reported more pages but did not advance lastNoiseId" });
            break;
        }
        if (done) {
            stats.complete = true;
            if (stats.lastNoiseId) onPage({ cursor: String(stats.lastNoiseId), page: stats.pages, complete: true });
            break;
        }
        cursor = String(next);
        stats.lastNoiseId = cursor;
        onPage({ cursor, page: stats.pages, complete: false });
    }
    if (full && stats.complete && !stats.failed) stats.swept = sweepCloudItemsNotSeenSince(startedAt);
    return stats;
}

/**
 * The key the cloud queue files a cached message under, `cliMsgId_conversation_sender`, from the message row: the
 * client message id in its `raw_data`, the thread and the sender. Null when the row has no client message id.
 *
 * @param {{threadId?: string, senderId?: string, raw_data?: string}} row - a `messages` row
 * @returns {string|null}
 */
export function messageZKey(row) {
    let cli;
    try {
        cli = JSON.parse(row?.raw_data || "{}")?.cliMsgId;
    } catch {
        return null;
    }
    if (cli === undefined || cli === null || cli === "") return null;
    if (row.threadId === undefined || row.threadId === null || row.senderId === undefined || row.senderId === null) {
        return null;
    }
    return `${cli}_${row.threadId}_${row.senderId}`;
}

/**
 * What the local cloud index can say about one message's media.
 *
 * A hit confirms a zCloud backup existed as of the last `sync-cloud`. A miss is
 * never proof of absence: zCloud is a partial source, and the message may live
 * only on the local-cache path. Callers must not turn `found: false` into "gone".
 *
 * The queue's `glbMsgId` is the literal "0" for about three quarters of its entries, so the message id alone finds
 * few of them. Zalo Web joins on `cliMsgId_conversation_sender` ({@link messageZKey}); that key is tried first and
 * the message id second.
 *
 * @param {string} msgId - the message's global id
 * @param {string|null} [zKey] - the message's queue key ({@link messageZKey})
 * @returns {{found: true, conclusive: true, item: object} | {found: false, conclusive: false, reason: string}}
 */
export function lookupCloudBackup(msgId, zKey = null) {
    let item = zKey ? getCloudItemByZKey(String(zKey)) : null;
    if (!item && msgId !== undefined && msgId !== null && msgId !== "" && String(msgId) !== "0") {
        item = getCloudItemByMsgId(String(msgId));
    }
    if (item) return { found: true, conclusive: true, item };
    return {
        found: false,
        conclusive: false,
        reason:
            "not in the local zCloud index, which proves nothing: zCloud never holds disappearing (TTL) " +
            "messages, disallowed types or conversations, anything over the quota or the per-file limit, or " +
            "anything from before the account opted in, and the index is only as fresh as the last sync-cloud",
    };
}
