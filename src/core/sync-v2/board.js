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
 * each, so this runs at low concurrency with a pause between calls, supports a
 * thread cap, and skips threads synced recently. It is deliberately not part
 * of the phone-backed restore — no confirmation is needed and nothing here
 * touches the WebSocket.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ThreadType } from "zca-js";
import { upsertBoardItem, upsertReminder } from "../db.js";

const require = createRequire(import.meta.url);

/** zca-js BoardType: what /api/board/list returns per item. */
export const BOARD_TYPES = { 1: "note", 2: "pinned_message", 3: "poll" };

let _utils = null;
/** zca-js internals, located the same way ./gid.js does. */
function zcaUtils() {
    if (_utils) return _utils;
    _utils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return _utils;
}

/**
 * List a 1-1 conversation's board (notes, pinned messages, polls).
 *
 * zca-js exposes /api/board/oneone/list only through getListReminder, hardwired
 * to board_type 1, so reminders were the only thing a DM ever returned. This
 * asks the same endpoint for every board type, which is what Zalo Web does.
 *
 * @returns {Promise<{items: Array<object>}>}
 */
async function listOneOneBoard(api, threadId, page, pageSize) {
    const zu = zcaUtils();
    const base = `${api.zpwServiceMap.group_board[0]}/api/board/oneone/list`;
    const call = zu.apiFactory()((_api, ctx, utils) => async () => {
        const params = {
            objectData: JSON.stringify({
                uid: String(threadId),
                board_type: 0, // 0 = every kind, not just reminders
                page,
                count: pageSize,
                last_id: 0,
                last_type: 0,
            }),
            imei: ctx.imei,
        };
        const enc = utils.encodeAES(JSON.stringify(params));
        if (!enc) throw new Error("failed to encrypt oneone board params");
        const resp = await utils.request(utils.makeURL(base, { params: enc }), { method: "GET" });
        return utils.resolve(resp);
    })(api.getContext(), api);

    const raw = await call();
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const items = parsed?.items || parsed?.data?.items || (Array.isArray(parsed) ? parsed : []);
    return { items };
}

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
 * @param {(p: object) => void} [opts.onProgress] - one `{phase: "thread",
 *   threadId, ok}` event per finished thread, where `ok` is false if any of
 *   that thread's own calls failed. Callers that clear per-thread state must
 *   check it.
 * @returns {Promise<{threads:number, boardItems:number, reminders:number, failed:number, failures:Array<object>}>}
 */
/**
 * A failure reason someone can act on.
 *
 * zca-js builds its error from the server's error_message, which for these
 * endpoints is often null -- so the message arrives as the literal string
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
        if (stats.failures.length < 20) stats.failures.push({ threadId, what, reason: describeZaloError(e) });
    };

    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const t = threads[cursor++];
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
            // takes the same board_type filter.
            if (boards) {
                for (let page = 1; page <= maxPages; page++) {
                    let resp;
                    try {
                        resp = isGroup
                            ? await api.getListBoard({ page, count: pageSize }, t.threadId)
                            : await listOneOneBoard(api, t.threadId, page, pageSize);
                    } catch (e) {
                        noteHere("board", e);
                        break;
                    }
                    const items = resp?.items || resp?.data?.items || [];
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
                            noteHere("reminder-write", e);
                        }
                    }
                } catch (e) {
                    noteHere("reminder", e);
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

    await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, worker));
    return stats;
}
