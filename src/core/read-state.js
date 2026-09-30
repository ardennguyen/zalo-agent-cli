/**
 * Read state that other devices report, which zca-js drops: how far the
 * account has read each conversation, and which conversations the human
 * marked unread by hand.
 *
 * Without it, a conversation the human already read on the phone still looks
 * unread to the cache, to `conv` and to the MCP, and a bot answers or
 * escalates a thread the human has handled. Two server messages carry it,
 * both read from Zalo Web's bundle (1.e0ef5e98…) and the first captured live
 * (agent/work/zalo-web-capture-2026-09-29/live/socket.L2_group_reaction.json):
 *
 * 1. `clearUnreads` rows, `{idTo, isGroup, lastMsgId, lastCliMsgId, type, sct, ts}`.
 *    They arrive on their own cmds -- 504 CLEAR_UNREADS_1_1 and 524
 *    CLEAR_UNREADS_GROUP (@~6435615) -- and as a field of every chat envelope
 *    (501/502/521/522) and offline-queue page (510/511). A row says the
 *    account has read conversation `idTo` through message `lastMsgId`, on some
 *    device: the web keys it `isGroup ? "g" + idTo : idTo` and treats every
 *    message at or before `lastMsgId` as read (@~10578566). A row with `type`
 *    2 and `sct` 1, 2 or 3 reports a folder or the message-request box as
 *    seen, not a conversation, and a `lastMsgId` of 0 reads nothing; the web
 *    skips both, and so does this.
 *
 * 2. The 601 control push with `act_type: "mark_unread"`: the manual unread
 *    flag, set on another device (`act: "add"`, content
 *    `{convsGroup: [{id, cliMsgId, fromUid, ts}], convsUser: [...]}`) or
 *    cleared (`act: "remove"`, content `{convsGroup: [id], convsUser: [id]}`).
 *    The content is a JSON string on the control's `content` (the web's
 *    MarkUnreadManager, @~6215256). zca-js's 601 handler knows only
 *    `file_done`, `group` and `fr`.
 *
 * Cmd 613 carries `clearUnreads` too, on the reaction path: reactions seen,
 * not messages read. It is not read here.
 *
 * What is stored: `conv_state.lastReadMsgId`/`lastReadTs`, which only move
 * forward (db.js `recordReadWatermark`), and `unreadMarked`/`unreadMarkedAt`,
 * which the next `sync` also reconciles (./sync-v2/conv-state.js). The
 * listener is this module's only caller: it reads and stores, and never sends.
 *
 * Not yet measured live: which of these cmds a read on the phone arrives on,
 * and whether our own `conv read` is echoed back to the listener.
 */
import { getConvState, getRecentThreads, recordReadWatermark, upsertConvState } from "./db.js";
import { resolveLossyThreadId } from "./sync-v2/conv-state.js";

/** Every envelope that can carry `clearUnreads` rows. */
export const CLEAR_UNREADS_CMDS = Object.freeze([501, 502, 504, 510, 511, 521, 522, 524]);

/** The control push; `mark_unread` is one of its `act_type`s. */
export const CMD_PUSH_CTRL = 601;

/**
 * JSON.parse that keeps long integers exact.
 *
 * A thread id is 19 digits, past Number.MAX_SAFE_INTEGER, and a bare number
 * that long comes out of JSON.parse already rounded -- the unread-mark list's
 * trap (./sync-v2/conv-state.js). Every integer literal of 16 or more digits
 * outside a string is read as a string instead.
 *
 * @param {string} text
 * @returns {*}
 */
export function parseKeepingIds(text) {
    // Strings are matched first and kept as they are, so digits inside one are
    // never touched; the lookarounds keep a fraction or exponent intact.
    const quoted = String(text).replace(/("(?:[^"\\]|\\.)*")|(?<![\d.])(-?\d{16,})(?![.eE\d])/g, (m, str, num) =>
        str === undefined ? `"${num}"` : str,
    );
    return JSON.parse(quoted);
}

/**
 * A conversation id as an exact string, or null when it cannot be known.
 *
 * A number the JSON already rounded is matched against the cached threads,
 * as the unread-mark sync does, and dropped when no single thread matches.
 *
 * @param {*} raw
 * @param {boolean} isGroup
 * @param {() => Array<{threadId: string, type: string}>} threads
 * @returns {string|null}
 */
function exactThreadId(raw, isGroup, threads) {
    if (typeof raw === "string") return /^\d+$/.test(raw) ? raw : null;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
    if (Number.isSafeInteger(raw)) return String(raw);
    return resolveLossyThreadId(raw, threads(), isGroup ? "group" : "dm").threadId;
}

/** Cached threads, loaded once per frame and only when a rounded id needs them. */
function lazyThreads() {
    let list = null;
    return () => {
        if (!list) list = getRecentThreads(100000).map((t) => ({ threadId: String(t.threadId), type: t.type }));
        return list;
    };
}

/**
 * The conversation reads in one envelope.
 *
 * @param {object|null} data - a decoded frame's `data`
 * @param {() => Array<{threadId: string, type: string}>} [threads] - cached threads, for a rounded id
 * @returns {Array<{threadId: string, isGroup: boolean, lastMsgId: string, lastCliMsgId: string|null, ts: number|null}>}
 */
export function readMarksFrom(data, threads = lazyThreads()) {
    const rows = Array.isArray(data?.clearUnreads) ? data.clearUnreads : [];
    const out = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        // A folder or the request box being seen, not a conversation (the web's @~10578566).
        if (Number(row.type) === 2 && [1, 2, 3].includes(Number(row.sct))) continue;
        const lastMsgId = String(row.lastMsgId ?? "");
        if (!/^\d+$/.test(lastMsgId) || BigInt(lastMsgId) === 0n) continue;
        const isGroup = Number(row.isGroup) === 1;
        const threadId = exactThreadId(row.idTo, isGroup, threads);
        if (!threadId) continue;
        const ts = Number(row.ts);
        out.push({
            threadId,
            isGroup,
            lastMsgId,
            lastCliMsgId: row.lastCliMsgId === undefined || row.lastCliMsgId === null ? null : String(row.lastCliMsgId),
            ts: Number.isFinite(ts) && ts > 0 ? ts : null,
        });
    }
    return out;
}

/**
 * The manual unread marks set or cleared in one 601 control push.
 *
 * @param {object|null} data - a decoded 601 frame's `data`
 * @param {() => Array<{threadId: string, type: string}>} [threads] - cached threads, for a rounded id
 * @returns {Array<{threadId: string, isGroup: boolean, marked: boolean, ts: number|null}>}
 */
export function unreadMarksFrom(data, threads = lazyThreads()) {
    const controls = Array.isArray(data?.controls) ? data.controls : [];
    const out = [];
    for (const control of controls) {
        const c = control?.content;
        if (!c || c.act_type !== "mark_unread" || (c.act !== "add" && c.act !== "remove")) continue;
        const marked = c.act === "add";
        let payload = c.content ?? c.data;
        if (typeof payload === "string") {
            try {
                payload = parseKeepingIds(payload);
            } catch {
                continue;
            }
        }
        if (!payload || typeof payload !== "object") continue;
        for (const [list, isGroup] of [
            [payload.convsGroup, true],
            [payload.convsUser, false],
        ]) {
            for (const entry of Array.isArray(list) ? list : []) {
                // "add" names each conversation as {id, cliMsgId, fromUid, ts}; "remove" as a bare id.
                const raw = entry && typeof entry === "object" ? entry.id : entry;
                const threadId = exactThreadId(raw, isGroup, threads);
                if (!threadId) continue;
                const ts = Number(entry?.ts);
                out.push({ threadId, isGroup, marked, ts: marked && Number.isFinite(ts) && ts > 0 ? ts : null });
            }
        }
    }
    return out;
}

/**
 * A conversation's read state as `conv recent` and the MCP report it: the
 * account's own reading on Zalo -- what the human read on the phone or Zalo
 * Web -- not any bot's cursor.
 *
 * @param {{lastReadMsgId: string|null, lastReadTs: number|null, unreadMarked: boolean,
 *   unreadAfter: number|null}|undefined} st - one entry of db.js `getReadStates`
 * @returns {{lastReadMsgId: string|null, lastReadAt: string|null, unreadAfter: number|null,
 *   markedUnread: boolean}|null} null when nothing is known
 */
export function describeReadState(st) {
    if (!st || (st.lastReadMsgId === null && !st.unreadMarked)) return null;
    return {
        lastReadMsgId: st.lastReadMsgId,
        lastReadAt: st.lastReadTs ? new Date(st.lastReadTs).toISOString() : null,
        unreadAfter: st.unreadAfter,
        markedUnread: st.unreadMarked,
    };
}

/**
 * The READ column of `conv recent`.
 *
 * @param {ReturnType<typeof describeReadState>} rs
 * @returns {string} "read", "3 unread", "marked unread", "3 unread, marked", or "-" when nothing is known
 */
export function readStateLabel(rs) {
    if (!rs) return "-";
    const n = rs.unreadAfter;
    if (rs.markedUnread) return n > 0 ? `${n} unread, marked` : "marked unread";
    if (n > 0) return `${n} unread`;
    return n === 0 ? "read" : "-";
}

/**
 * Whether the account has read one message on Zalo, on any device.
 *
 * @param {string} msgId
 * @param {string|null|undefined} lastReadMsgId - the conversation's watermark
 * @returns {boolean|null} true at or before the watermark, false after it, null when either id is unknown
 */
export function readOnZalo(msgId, lastReadMsgId) {
    if (!/^\d+$/.test(String(msgId ?? "")) || !/^\d+$/.test(String(lastReadMsgId ?? ""))) return null;
    return BigInt(msgId) <= BigInt(lastReadMsgId);
}

/**
 * A stored change as a listener event: the JSON a consumer gets, and the line
 * a human reads.
 *
 * @param {{kind: "read"|"unread_mark", threadId: string, isGroup: boolean,
 *   lastReadMsgId?: string, ts?: number|null, marked?: boolean}} change
 * @returns {{data: object, human: string}}
 */
export function readStateEvent(change) {
    const { threadId, isGroup } = change;
    if (change.kind === "read") {
        return {
            data: { event: "read", threadId, isGroup, lastReadMsgId: change.lastReadMsgId, ts: change.ts ?? null },
            human: `Read up to message ${change.lastReadMsgId} in ${threadId}`,
        };
    }
    return {
        data: { event: "unread_mark", threadId, isGroup, marked: change.marked },
        human: change.marked ? `Marked unread: ${threadId}` : `Unread mark cleared: ${threadId}`,
    };
}

/**
 * Keep `conv_state` in step with the read state other devices report.
 *
 * Subscribes to the daemon's socket tap once; the tap outlives every socket
 * and every re-login, so nothing needs re-attaching.
 *
 * @param {object} args
 * @param {ReturnType<import("./socket-tap.js").createSocketTap>} args.tap
 * @param {(change: {kind: "read", threadId: string, isGroup: boolean, lastReadMsgId: string, ts: number|null}
 *   | {kind: "unread_mark", threadId: string, isGroup: boolean, marked: boolean}) => void} [args.onChange] -
 *   each change that altered what is stored, for a listener to print
 * @param {(line: string) => void} [args.log]
 * @returns {{stop: () => void}}
 */
export function createReadStateSync({ tap, onChange = () => {}, log = (line) => console.error(line) }) {
    const say = (line) => {
        try {
            log(`read state: ${line}`);
        } catch {
            /* a broken logger must not break the socket */
        }
    };
    const tell = (change) => {
        try {
            onChange(change);
        } catch (e) {
            say(`a change handler failed: ${e?.message || e}`);
        }
    };

    function onEnvelope(frame) {
        for (const r of readMarksFrom(frame.data)) {
            try {
                if (!recordReadWatermark({ threadId: r.threadId, msgId: r.lastMsgId, ts: r.ts })) continue;
            } catch (e) {
                say(`could not store a read of ${r.threadId}: ${e?.message || e}`);
                continue;
            }
            tell({ kind: "read", threadId: r.threadId, isGroup: r.isGroup, lastReadMsgId: r.lastMsgId, ts: r.ts });
        }
    }

    function onControl(frame) {
        for (const m of unreadMarksFrom(frame.data)) {
            try {
                const before = getConvState(m.threadId);
                if (Boolean(before?.unreadMarked) === m.marked) continue;
                upsertConvState({
                    threadId: m.threadId,
                    unreadMarked: m.marked,
                    unreadMarkedAt: m.ts ?? Date.now(),
                });
            } catch (e) {
                say(`could not store the unread mark of ${m.threadId}: ${e?.message || e}`);
                continue;
            }
            tell({ kind: "unread_mark", threadId: m.threadId, isGroup: m.isGroup, marked: m.marked });
        }
    }

    const offs = [...CLEAR_UNREADS_CMDS.map((cmd) => tap.on(cmd, onEnvelope)), tap.on(CMD_PUSH_CTRL, onControl)];
    return {
        stop() {
            for (const off of offs.splice(0)) off();
        },
    };
}
