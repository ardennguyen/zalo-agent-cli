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

import { senderNameFields } from "../core/contact-names.js";

/**
 * A buffered message with its sender named as of now: the owner's alias when one is set, else the name the message
 * carried. The buffer keeps the name from when the message arrived, and an alias set or changed since (a rename while
 * parked comes back in the same catch-up as the messages, and is read about two seconds after them) would otherwise
 * show the old name, where Zalo PC and Web show the current alias.
 *
 * @param {object} m
 * @returns {object}
 */
function withCurrentSender(m) {
    if (!m || m.system || m.senderId === undefined || m.senderId === null) return m;
    return { ...m, ...senderNameFields(m.senderId, m.senderZaloName ?? m.senderName ?? null) };
}

export { MAX_BATCH, MAX_SETTLE_MS, batchParams } from "./wait-batch.js";

/**
 * @param {object} args
 * @param {object[]} args.messages - Buffered messages, in cursor order (empty on timeout)
 * @param {boolean} [args.hasMore] - More messages are already buffered after these
 * @param {number} args.cursorWhenEmpty - The cursor to report on a timeout, so the caller can carry on from it
 * @param {(m: object) => object} [args.decorate] - Adds what only this daemon knows, e.g. the thread name
 * @returns {{ status: "message"|"timeout", message: object|null, messages: object[], count: number, hasMore: boolean, cursor: number }}
 */
export function waitResult({ messages, hasMore = false, cursorWhenEmpty, decorate = (m) => m }) {
    const out = messages.map((m) => decorate(withCurrentSender(m)));
    return {
        status: out.length ? "message" : "timeout",
        message: out[0] ?? null,
        messages: out,
        count: out.length,
        hasMore: Boolean(hasMore) && out.length > 0,
        cursor: out.length ? messages[messages.length - 1]._cursor : cursorWhenEmpty,
    };
}
