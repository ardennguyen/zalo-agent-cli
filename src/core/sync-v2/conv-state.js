/**
 * Conversation-level state: which conversations are pinned, which are marked
 * unread. None of it travels in the transfer-sync payload, and until this
 * module nothing wrote the `conv_state` table at all -- `conv pinned` fetched
 * the list and only printed it.
 *
 * Two traps, both measured against a live account and both invisible offline:
 *
 * 1. Pinned ids are PREFIXED. getPinConversations() answers
 *    `{conversations: ["g4546...", ...]}` -- `g` for a group, `u` for a user.
 *    Taken as-is, 0 of 2 pinned conversations resolved against the cache;
 *    with the prefix stripped, 2 of 2 did.
 *
 * 2. Unread-mark ids arrive as JSON NUMBERS. A thread id is 19 digits, far
 *    past Number.MAX_SAFE_INTEGER, so `4546985820537230880` comes back as
 *    `4546985820537231000` before zca-js even returns it. Written with
 *    String(id), the mark lands on a thread that does not exist. The exact id
 *    cannot be recovered from the number, but it can be MATCHED: a cached
 *    thread whose id rounds to the same double is the one -- provided exactly
 *    one does. Two ids differing only in their last digits would collide, so
 *    an ambiguous match is reported and never guessed.
 */
import { getConvState, getRecentThreads, upsertConvState } from "../db.js";

/**
 * A pinned-conversation id without its type prefix.
 *
 * @param {string|number} raw - e.g. "g4546985820537230880" or "u123..."
 * @returns {{threadId: string, type: "group"|"dm"|null}}
 */
export function parsePinnedId(raw) {
    const s = String(raw ?? "");
    if (/^g\d+$/.test(s)) return { threadId: s.slice(1), type: "group" };
    if (/^u\d+$/.test(s)) return { threadId: s.slice(1), type: "dm" };
    return { threadId: s, type: null };
}

/**
 * Resolve a precision-lost numeric id to the one cached thread it came from.
 *
 * @param {number|string} lossy - the id as zca-js returned it
 * @param {Array<{threadId: string, type: string}>} threads - cached threads to match against
 * @param {"group"|"dm"} [type] - restrict the match to one kind
 * @returns {{threadId: string|null, why?: "unknown"|"ambiguous"}}
 */
export function resolveLossyThreadId(lossy, threads, type) {
    // A string id was never rounded; take it literally if the cache has it.
    if (typeof lossy === "string" && /^\d+$/.test(lossy)) {
        const exact = threads.find((t) => String(t.threadId) === lossy && (!type || t.type === type));
        if (exact) return { threadId: String(exact.threadId) };
    }
    const target = Number(lossy);
    if (!Number.isFinite(target)) return { threadId: null, why: "unknown" };
    const hits = threads.filter((t) => (!type || t.type === type) && Number(t.threadId) === target);
    if (hits.length === 1) return { threadId: String(hits[0].threadId) };
    return { threadId: null, why: hits.length ? "ambiguous" : "unknown" };
}

/**
 * Pull pinned + unread state and write it to `conv_state`, reconciling rows
 * whose state was cleared on another device.
 *
 * @param {object} args
 * @param {object} args.api - logged-in zca-js api (REST only; no socket)
 * @param {number} [args.now] - clock, for tests
 * @param {Array<{threadId: string, type: string}>} [args.threads] - cached threads; defaults to the cache
 * @returns {Promise<{pinned: number, unpinned: number, unread: number, unmarked: number,
 *   unresolved: number, ambiguous: number, failures: Array<{what: string, reason: string}>}>}
 */
export async function syncConvState({ api, now = Date.now(), threads } = {}) {
    if (!api) throw new Error("syncConvState needs a logged-in api");
    const known = (threads || getRecentThreads(100000)).map((t) => ({
        threadId: String(t.threadId),
        type: t.type,
    }));
    const byId = new Map(known.map((t) => [t.threadId, t]));
    const stats = { pinned: 0, unpinned: 0, unread: 0, unmarked: 0, unresolved: 0, ambiguous: 0, failures: [] };
    const previous = getConvState();

    // --- pinned
    let pinnedIds = null;
    try {
        const res = await api.getPinConversations();
        pinnedIds = new Set();
        for (const raw of res?.conversations || []) {
            const { threadId } = parsePinnedId(raw);
            // Only conversations the cache knows: a pin for a thread we have
            // never seen has nothing to attach to, and inventing a row would
            // make it look synced.
            if (!byId.has(threadId)) {
                stats.unresolved++;
                continue;
            }
            pinnedIds.add(threadId);
        }
    } catch (e) {
        stats.failures.push({ what: "pinned", reason: e?.message || String(e) });
    }

    // --- unread marks
    let unreadIds = null;
    try {
        const res = await api.getUnreadMark();
        const d = res?.data || res || {};
        unreadIds = new Map();
        for (const [list, type] of [
            [d.convsGroup, "group"],
            [d.convsUser, "dm"],
        ]) {
            for (const e of Array.isArray(list) ? list : []) {
                const r = resolveLossyThreadId(e?.id, known, type);
                if (!r.threadId) {
                    if (r.why === "ambiguous") stats.ambiguous++;
                    else stats.unresolved++;
                    continue;
                }
                unreadIds.set(r.threadId, Number(e?.ts) || now);
            }
        }
    } catch (e) {
        stats.failures.push({ what: "unread", reason: e?.message || String(e) });
    }

    // --- write, then reconcile. A list that failed to load says nothing about
    // what is pinned or unread, so its reconciliation is skipped entirely --
    // otherwise one failed request would unpin every conversation.
    if (pinnedIds) {
        for (const threadId of pinnedIds) {
            upsertConvState({ threadId, pinned: true, pinnedAt: now });
            stats.pinned++;
        }
        for (const row of previous) {
            if (row.pinned && !pinnedIds.has(String(row.threadId))) {
                upsertConvState({ threadId: row.threadId, pinned: false, pinnedAt: now });
                stats.unpinned++;
            }
        }
    }
    if (unreadIds) {
        for (const [threadId, ts] of unreadIds) {
            upsertConvState({ threadId, unreadMarked: true, unreadMarkedAt: ts });
            stats.unread++;
        }
        for (const row of previous) {
            if (row.unreadMarked && !unreadIds.has(String(row.threadId))) {
                upsertConvState({ threadId: row.threadId, unreadMarked: false, unreadMarkedAt: now });
                stats.unmarked++;
            }
        }
    }
    return stats;
}
