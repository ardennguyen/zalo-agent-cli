/**
 * Sync the things that never travel in the message stream.
 *
 * transfer-sync-v2 carries messages and nothing else. Notes ("Ghi chú"),
 * pinned messages, polls and reminders ("Nhắc hẹn") are *board* objects behind
 * plain REST endpoints, one call per thread:
 *
 *   groups : {group_board}/api/board/list          -> notes + pinned + polls
 *            {group_board}/api/board/listReminder  -> reminders
 *   DMs    : {group_board}/api/board/oneone/list   -> reminders
 *            {friend_board}/api/friendboard/list   -> the friend board
 *
 * The conversation *events* that announce these do arrive as messages — a
 * reminder shows up as msgType 24, a closed poll as msgType 26 — but those are
 * only announcements. The objects themselves exist solely here.
 *
 * Cost shapes the design: a full account is ~1500 threads and two-plus calls
 * each, so this runs at low concurrency with a pause between calls, supports a
 * thread cap, and skips threads synced recently. It is deliberately not part
 * of the phone-backed restore — no confirmation is needed and nothing here
 * touches the WebSocket.
 */
import { ThreadType } from "zca-js";
import { upsertBoardItem, upsertReminder } from "../db.js";

/** zca-js BoardType: what /api/board/list returns per item. */
export const BOARD_TYPES = { 1: "note", 2: "pinned_message", 3: "poll" };

/** Stringify an id Zalo may send as a number, or leave it null. */
const str = (v) => (v === undefined || v === null ? null : String(v));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Board/reminder payloads keep `params` as either an object or a JSON string. */
function params(obj) {
    const p = obj?.params;
    if (!p) return {};
    if (typeof p === "object") return p;
    try {
        return JSON.parse(p);
    } catch {
        return {};
    }
}

/**
 * Normalize one /api/board/list item. Polls carry a different shape from
 * notes and pinned messages, so they are unpacked separately.
 *
 * @returns {object|null} a row for upsertBoardItem(), or null if unusable
 */
export function normalizeBoardItem(item, threadId, threadType) {
    const type = Number(item?.boardType);
    const d = item?.data;
    if (!d || !type) return null;

    if (type === 3) {
        const id = d.poll_id ?? d.pollId;
        if (id === undefined || id === null) return null;
        return {
            threadId,
            threadType,
            boardType: type,
            itemId: String(id),
            title: d.question ?? null,
            creatorId: str(d.creator),
            createTime: d.created_time,
            editTime: d.updated_time,
            startTime: d.created_time,
            duration: d.expired_time ? d.expired_time - (d.created_time || 0) : null,
            repeat: null,
            emoji: null,
            color: null,
            raw_data: d,
        };
    }

    if (d.id === undefined || d.id === null) return null;
    return {
        threadId,
        threadType,
        boardType: type,
        itemId: String(d.id),
        title: params(d).title ?? null,
        creatorId: str(d.creatorId),
        createTime: d.createTime,
        editTime: d.editTime,
        startTime: d.startTime,
        duration: d.duration,
        repeat: d.repeat,
        emoji: d.emoji ?? null,
        color: d.color,
        raw_data: d,
    };
}

/**
 * Normalize one reminder. DM reminders (`ReminderUser`) and group reminders
 * (`ReminderGroup`) name their creator and id differently.
 *
 * @returns {object|null} a row for upsertReminder(), or null if unusable
 */
export function normalizeReminder(r, threadId, threadType) {
    const id = r?.reminderId ?? r?.id;
    if (id === undefined || id === null) return null;
    return {
        reminderId: String(id),
        threadId,
        threadType,
        title: params(r).title ?? null,
        creatorId: str(r.creatorId) ?? str(r.creatorUid),
        createTime: r.createTime,
        editTime: r.editTime,
        startTime: r.startTime,
        duration: r.duration,
        repeatMode: r.repeat,
        emoji: r.emoji ?? null,
        color: r.color,
        eventType: r.eventType,
        raw_data: r,
    };
}

/** Reminder lists come back as an array, or wrapped in one of a few keys. */
function asList(resp) {
    if (Array.isArray(resp)) return resp;
    for (const k of ["items", "list", "reminders", "data", "events"]) {
        const v = resp?.[k];
        if (Array.isArray(v)) return v;
    }
    if (Array.isArray(resp?.data?.items)) return resp.data.items;
    if (Array.isArray(resp?.data?.list)) return resp.data.list;
    return [];
}

/**
 * Sync board items and reminders for the given threads.
 *
 * Every per-thread call is individually guarded: one thread that 403s (a group
 * you were removed from, a DM with a blocked user) must not abort a run that
 * covers hundreds of others.
 *
 * @param {object} opts
 * @param {object} opts.api - logged-in zca-js api
 * @param {Array<{threadId: string, type: "dm"|"group", name?: string}>} opts.threads
 * @param {boolean} [opts.boards=true] - fetch notes/pinned/polls (groups only)
 * @param {boolean} [opts.reminders=true] - fetch reminders
 * @param {number} [opts.concurrency=3] - parallel threads; Zalo rate-limits hard
 * @param {number} [opts.delayMs=120] - pause between calls within a worker
 * @param {number} [opts.pageSize=50]
 * @param {number} [opts.maxPages=10] - board pagination cap per thread
 * @param {(p: object) => void} [opts.onProgress]
 * @returns {Promise<{threads:number, boardItems:number, reminders:number, failed:number, failures:Array<object>}>}
 */
export async function syncBoards(opts = {}) {
    const {
        api,
        threads = [],
        boards = true,
        reminders = true,
        concurrency = 3,
        delayMs = 120,
        pageSize = 50,
        maxPages = 10,
        onProgress = () => {},
    } = opts;

    const stats = { threads: 0, boardItems: 0, reminders: 0, failed: 0, failures: [] };
    if (!api || !threads.length) return stats;

    const note = (threadId, what, e) => {
        stats.failed++;
        if (stats.failures.length < 20) stats.failures.push({ threadId, what, reason: e?.message || String(e) });
    };

    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const t = threads[cursor++];
            if (!t) return;
            const isGroup = t.type === "group";

            // Notes / pinned messages / polls. Groups only: Zalo exposes no
            // equivalent board listing for a 1-1 conversation.
            if (boards && isGroup) {
                for (let page = 1; page <= maxPages; page++) {
                    let resp;
                    try {
                        resp = await api.getListBoard({ page, count: pageSize }, t.threadId);
                    } catch (e) {
                        note(t.threadId, "board", e);
                        break;
                    }
                    const items = resp?.items || [];
                    for (const item of items) {
                        const row = normalizeBoardItem(item, t.threadId, t.type);
                        if (!row) continue;
                        try {
                            upsertBoardItem(row);
                            stats.boardItems++;
                        } catch (e) {
                            note(t.threadId, "board-write", e);
                        }
                    }
                    if (items.length < pageSize) break;
                    if (delayMs) await sleep(delayMs);
                }
            }

            if (reminders) {
                try {
                    const resp = await api.getListReminder(
                        { page: 1, count: pageSize },
                        t.threadId,
                        isGroup ? ThreadType.Group : ThreadType.User,
                    );
                    for (const r of asList(resp)) {
                        const row = normalizeReminder(r, t.threadId, t.type);
                        if (!row) continue;
                        try {
                            upsertReminder(row);
                            stats.reminders++;
                        } catch (e) {
                            note(t.threadId, "reminder-write", e);
                        }
                    }
                } catch (e) {
                    note(t.threadId, "reminder", e);
                }
            }

            stats.threads++;
            onProgress({
                phase: "thread",
                threadId: t.threadId,
                name: t.name,
                done: stats.threads,
                total: threads.length,
                boardItems: stats.boardItems,
                reminders: stats.reminders,
            });
            if (delayMs) await sleep(delayMs);
        }
    };

    await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, worker));
    return stats;
}
