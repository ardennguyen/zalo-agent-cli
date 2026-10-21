/**
 * What a "wait for messages" call returns, in one place: the HTTP route `GET /events/wait`, the MCP tool
 * `zalo_wait_for_message` and `mcp wait` over the daemon channel all build it here, so they cannot drift.
 *
 * It used to hand back one message per call, so a bot behind a busy account made one round trip per
 * message. `limit` (1-100, default 1) returns up to that many buffered messages at once, in cursor order,
 * and `settleMs` waits that long after the first arrives so a burst lands in one reply.
 *
 * The single-message fields are unchanged and still filled (`message` is the first, `cursor` the last
 * one returned, so `since=cursor` continues exactly where the batch ended); `messages`, `count` and
 * `hasMore` are added. With `limit` 1 the reply is what it always was, plus those three fields.
 */

/** Most messages one call returns. */
export const MAX_BATCH = 100;
/** Longest a call waits for company after the first message. */
export const MAX_SETTLE_MS = 5000;

/**
 * Clamp the caller's batch settings; anything unusable is the default (one message, no settling).
 *
 * @param {{ limit?: unknown, settleMs?: unknown }} [raw]
 * @returns {{ limit: number, settleMs: number }}
 */
export function batchParams({ limit, settleMs } = {}) {
    const l = Number(limit);
    const s = Number(settleMs);
    return {
        limit: Number.isFinite(l) && l >= 1 ? Math.min(MAX_BATCH, Math.floor(l)) : 1,
        settleMs: Number.isFinite(s) && s > 0 ? Math.min(MAX_SETTLE_MS, Math.floor(s)) : 0,
    };
}

/**
 * @param {object} args
 * @param {object[]} args.messages - Buffered messages, in cursor order (empty on timeout)
 * @param {boolean} [args.hasMore] - More messages are already buffered after these
 * @param {number} args.cursorWhenEmpty - The cursor to report on a timeout, so the caller can carry on from it
 * @param {(m: object) => object} [args.decorate] - Adds what only this daemon knows, e.g. the thread name
 * @returns {{ status: "message"|"timeout", message: object|null, messages: object[], count: number, hasMore: boolean, cursor: number }}
 */
export function waitResult({ messages, hasMore = false, cursorWhenEmpty, decorate = (m) => m }) {
    const out = messages.map(decorate);
    return {
        status: out.length ? "message" : "timeout",
        message: out[0] ?? null,
        messages: out,
        count: out.length,
        hasMore: Boolean(hasMore) && out.length > 0,
        cursor: out.length ? messages[messages.length - 1]._cursor : cursorWhenEmpty,
    };
}
