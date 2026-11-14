/**
 * Sync the things that never travel in the message stream.
 *
 * transfer-sync-v2 carries messages and nothing else. Notes ("Ghi chú"),
 * pinned messages, polls and reminders ("Nhắc hẹn") are *board* objects behind
 * plain REST endpoints, one call per thread:
 *
 *   groups : {group_board}/api/board/list          -> notes + pinned + polls
 *            {group_board}/api/board/listReminder  -> reminders
 *   DMs    : {group_board}/api/board/oneone/list   -> the SAME board kinds
 *            {friend_board}/api/friendboard/list   -> the friend board
 *
 * Boards are NOT a group-only feature. A 1-1 conversation has notes, pinned
 * messages and reminders too, behind /api/board/oneone/* (list/create/update/
 * remove, cmd 12430-12432). An earlier version of this module asked for
 * reminders on a DM and nothing else, so every pinned message and note in a 1-1
 * conversation was silently missing.
 *
 * The conversation *events* that announce these do arrive as messages — a
 * reminder shows up as msgType 24, a closed poll as msgType 26 — but those are
 * only announcements. The objects themselves exist solely here.
 *
 * Cost shapes the design: a full account is ~1500 threads and two-plus calls
 * each, so this runs at low concurrency (at most 3) with a pause between calls,
 * and stops the whole pass on Zalo's 221. It is deliberately not part
 * of the phone-backed restore — no confirmation is needed and nothing here
 * touches the WebSocket.
 */
import { THREAD_TYPE } from "../../zalo/enums.js";
import { boardCursor, listOneOneBoard } from "../../zalo/api/boards.js";
import { upsertBoardItem, upsertReminder } from "../db.js";

/**
 * List a 1-1 conversation's board (notes, pinned messages, reminders): `/api/board/oneone/list` with board type 0,
 * every kind. It lives in the protocol layer (src/zalo/api/boards.js); re-exported here
 * where it used to be.
 */
export { listOneOneBoard };

/** What /api/board/list returns per item (`boardType`). */
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
 * A failure reason someone can act on.
 *
 * The error is built from the server's error_message, which for these
 * endpoints is often null -- so the message can arrive as the literal string
 * "null" and the only signal is the numeric code. A live board pass reported
 * 165 failures, every one of them printed as "null".
 *
 * @param {unknown} e
 * @returns {string}
 */
export function describeZaloError(e) {
    const msg = e?.message;
    const text = msg && msg !== "null" && msg !== "undefined" ? String(msg) : "";
    const code = e?.code;
    if (code !== undefined && code !== null) return text ? `${text} (code ${code})` : `code ${code}`;
    return text || String(e);
}

/** Board items per page (MAX_REF_LOAD_TOPIC). */
export const BOARD_PAGE_SIZE = 20;
/** Reminders asked per page. */
export const REMINDER_PAGE_SIZE = 50;
/** Threads fetched at once, at most: Zalo itself opens one board at a time, so this stays low. */
export const MAX_BOARD_CONCURRENCY = 3;
/** Zalo's "too many requests". */
const TOO_MANY_REQUESTS = 221;

/** The id a board item or reminder is known by, for the "did the page move" check. */
const itemKey = (item) => {
    const d = item?.data ?? item;
    const id = d?.poll_id ?? d?.pollId ?? d?.id ?? d?.reminderId ?? item?.reminderId;
    return id === undefined || id === null ? null : `${item?.boardType ?? ""}:${id}`;
};

/**
 * Sync board items and reminders for the given threads.
 *
 * Every per-thread call is individually guarded: one thread that 403s (a group
 * you were removed from, a DM with a blocked user) must not abort a run that
 * covers hundreds of others. A 221 ("too many requests") is different: it is
 * about the account, not the thread, so the whole pass stops there and says how
 * many threads were left (`stoppedBy: "rate-limit"`, `left`, `nextThreadId`).
 *
 * A board is paged 20 items a page, until a page
 * comes back empty. There is no page cap; the runaway guard is a page that
 * brings nothing new (the cursor did not move), which ends that board and is
 * counted in `stalled`.
 *
 * @param {object} opts
 * @param {object} opts.api - the logged-in api
 * @param {Array<{threadId: string, type: "dm"|"group", name?: string}>} opts.threads
 * @param {boolean} [opts.boards=true] - fetch notes/pinned/polls
 * @param {boolean} [opts.reminders=true] - fetch reminders
 * @param {number} [opts.concurrency=3] - parallel threads, at most 3
 * @param {number} [opts.delayMs=120] - pause between calls within a worker
 * @param {number} [opts.pageSize=20] - board items per page
 * @param {number} [opts.maxPages=Infinity] - opt-in board page bound per thread
 * @param {(p: object) => void} [opts.onProgress] - one `{phase: "thread",
 *   threadId, ok}` event per finished thread, where `ok` is false if any of
 *   that thread's own calls failed. Callers that clear per-thread state must
 *   check it.
 * @returns {Promise<{threads:number, boardItems:number, reminders:number, failed:number, failures:Array<object>,
 *   stalled:number, stoppedBy:null|"rate-limit", left:number, nextThreadId:string|null}>}
 */
export async function syncBoards(opts = {}) {
    const {
        api,
        threads = [],
        boards = true,
        reminders = true,
        concurrency = MAX_BOARD_CONCURRENCY,
        delayMs = 120,
        pageSize = BOARD_PAGE_SIZE,
        maxPages = Infinity,
        onProgress = () => {},
    } = opts;

    const stats = {
        threads: 0,
        boardItems: 0,
        reminders: 0,
        failed: 0,
        failures: [],
        stalled: 0,
        stoppedBy: null,
        left: 0,
        nextThreadId: null,
    };
    if (!api || !threads.length) return stats;

    const note = (threadId, what, e) => {
        stats.failed++;
        if (stats.failures.length < 20) stats.failures.push({ threadId, what, reason: describeZaloError(e) });
    };
    /** First thread index a rate limit left undone; the pass ends there. */
    let stopAt = Infinity;
    const limited = (e, index) => {
        if (Number(e?.code) !== TOO_MANY_REQUESTS) return false;
        stats.stoppedBy = "rate-limit";
        stopAt = Math.min(stopAt, index);
        return true;
    };

    let cursor = 0;
    const worker = async () => {
        for (;;) {
            if (stats.stoppedBy) return;
            const index = cursor++;
            const t = threads[index];
            if (!t) return;
            const isGroup = t.type === "group";

            // Per-thread, not per-run: the caller clears a thread's "board
            // changed" flag on the strength of this, and a run-wide failure
            // count would clear the flag for a thread whose fetch actually
            // failed -- losing the one signal that says to come back to it.
            let hadFailure = false;
            const noteHere = (what, e) => {
                hadFailure = true;
                note(t.threadId, what, e);
            };

            // Notes / pinned messages / polls, for BOTH thread kinds. A group
            // uses /api/board/list; a 1-1 uses /api/board/oneone/list, which
            // takes the same board_type filter. A group's page 2 and later carry
            // the cursor of the page before (the id and type of its last item),
            // so an item added mid-scan does not shift one
            // past the page boundary.
            if (boards) {
                let pageCursor = { lastId: 0, lastType: 0 };
                const seen = new Set();
                for (let page = 1; page <= maxPages; page++) {
                    let resp;
                    try {
                        resp = isGroup
                            ? await api.getListBoard({ page, count: pageSize, ...pageCursor }, t.threadId)
                            : await listOneOneBoard(api, t.threadId, page, pageSize);
                    } catch (e) {
                        if (limited(e, index)) return;
                        noteHere("board", e);
                        break;
                    }
                    const items = resp?.items || resp?.data?.items || [];
                    // Only an empty page ends the board: with the cursor, Zalo can answer
                    // a short page while more items follow.
                    if (items.length === 0) break;
                    const keys = items.map(itemKey);
                    if (keys.every((k) => k !== null && seen.has(k))) {
                        // The cursor did not move: the same page again. Stop rather than loop.
                        stats.stalled++;
                        break;
                    }
                    for (const k of keys) if (k !== null) seen.add(k);
                    for (const item of items) {
                        const row = normalizeBoardItem(item, t.threadId, t.type);
                        if (!row) continue;
                        try {
                            upsertBoardItem(row);
                            stats.boardItems++;
                        } catch (e) {
                            noteHere("board-write", e);
                        }
                    }
                    pageCursor = boardCursor(items);
                    if (delayMs) await sleep(delayMs);
                }
            }

            if (reminders) {
                const seen = new Set();
                for (let page = 1; ; page++) {
                    let list;
                    try {
                        list = asList(
                            await api.getListReminder(
                                { page, count: REMINDER_PAGE_SIZE },
                                t.threadId,
                                isGroup ? THREAD_TYPE.GROUP : THREAD_TYPE.USER,
                            ),
                        );
                    } catch (e) {
                        if (limited(e, index)) return;
                        noteHere("reminder", e);
                        break;
                    }
                    const keys = list.map(itemKey);
                    if (!list.length || (page > 1 && keys.every((k) => k !== null && seen.has(k)))) break;
                    for (const k of keys) if (k !== null) seen.add(k);
                    for (const r of list) {
                        const row = normalizeReminder(r, t.threadId, t.type);
                        if (!row) continue;
                        try {
                            upsertReminder(row);
                            stats.reminders++;
                        } catch (e) {
                            noteHere("reminder-write", e);
                        }
                    }
                    // A short page is the last one.
                    if (list.length < REMINDER_PAGE_SIZE) break;
                    if (delayMs) await sleep(delayMs);
                }
            }

            stats.threads++;
            onProgress({
                phase: "thread",
                threadId: t.threadId,
                name: t.name,
                ok: !hadFailure,
                done: stats.threads,
                total: threads.length,
                boardItems: stats.boardItems,
                reminders: stats.reminders,
            });
            if (delayMs) await sleep(delayMs);
        }
    };

    await Promise.all(Array.from({ length: Math.max(1, Math.min(MAX_BOARD_CONCURRENCY, concurrency)) }, worker));
    if (stats.stoppedBy) {
        stats.left = threads.length - stats.threads;
        stats.nextThreadId = threads[stopAt]?.threadId ?? null;
    }
    return stats;
}
