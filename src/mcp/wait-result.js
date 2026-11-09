/**
 * What a "wait for messages" call returns, in one place: the HTTP route `GET /events/wait`, the MCP tool
 * `zalo_wait_for_message` and `mcp wait` over the daemon channel all build it here, so they cannot drift.
 *
 * A call returns every message already waiting (up to what the buffer holds), in cursor order; `limit`
 * is an opt-in bound, and `settleMs` waits that long after the first arrives so a burst lands in one reply.
 * Until 3.0.0 the default was one message per call; a client that read only `message` and continued from
 * `cursor` now skips every message after the first: read `messages`, or pass `limit` 1.
 *
 * `message` is the first message returned and `cursor` the last one's, so `since=cursor` continues exactly
 * where the batch ended; `messages`, `count` and `hasMore` describe the whole batch.
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

export { MAX_SETTLE_MS, batchParams } from "./wait-batch.js";

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
