/**
 * Read what a cached `messages` row can tell a command that acts on it.
 *
 * Reacting, forwarding and pinning all name their target by more than its
 * msgId: the client id only the sender ever minted, the sender's numeric uid,
 * the exact text. None of that is in any CLI output; it lives in the row the
 * listener or the mobile sync wrote. Read-only: nothing here writes zalo.db.
 *
 * `msg react`/`msg undo`/`msg delete` and the MCP tools `zalo_react`/
 * `zalo_undo` share the lookups below, so a message one of them can act on is
 * a message the other can too. Opening the db is the caller's: the CLI opens
 * the active account's first, and `mcp start` opened it at start-up.
 */

import { findMessageByClientId, getMessageById } from "./db.js";

/**
 * `raw_data` as an object, whatever shape its writer used.
 *
 * The live path stores the payload directly, some rows nest it under `data`,
 * and an old writer stored a bare string -- which is "no metadata", not an error.
 *
 * @param {string|null|undefined} rawData
 * @returns {object}
 */
export function parseRawData(rawData) {
    try {
        const parsed = JSON.parse(rawData || "{}");
        if (!parsed || typeof parsed !== "object") return {};
        return parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    } catch {
        return {};
    }
}

/**
 * The row's cliMsgId, or null when it was never cached.
 *
 * @param {object} row - a `messages` row
 * @returns {string|null}
 */
export function cachedCliMsgId(row) {
    const id = parseRawData(row?.raw_data).cliMsgId;
    return id === undefined || id === null || id === "" ? null : String(id);
}

/**
 * The message's text as it was sent.
 *
 * The listener trims the `text` column; the payload keeps the original string,
 * which is what Zalo Web forwards and pins.
 *
 * @param {object} row - a `messages` row
 * @returns {string}
 */
export function cachedText(row) {
    const content = parseRawData(row?.raw_data).content;
    return typeof content === "string" && content.length > 0 ? content : row?.text || "";
}

/** A Zalo user id is all digits; a synced row's author can be an opaque noised id, which no tool takes. */
const USER_ID = /^\d+$/;

/**
 * What a reply quotes, in the reply shape every MCP message carries as `replyTo`, from the quote Zalo puts on
 * the message (the `quote` of a live event; the same object a restore keeps). Null when there is no quote or
 * it names no message.
 *
 * @param {object|null|undefined} quote
 * @returns {{msgId: string|null, cliMsgId: string|null, senderId: string|null, senderName: string|null,
 *   text: string, timestamp: number|null, hasAttachment: boolean}|null}
 */
export function quotedReply(quote) {
    if (!quote || typeof quote !== "object") return null;
    const id = (v) => (v === undefined || v === null || v === "" || Number(v) === 0 ? null : String(v));
    const msgId = id(quote.globalMsgId);
    const cliMsgId = id(quote.cliMsgId);
    if (!msgId && !cliMsgId) return null;
    const owner = id(quote.ownerId);
    const attach = typeof quote.attach === "string" ? quote.attach.trim() : quote.attach;
    return {
        msgId,
        cliMsgId,
        senderId: owner && USER_ID.test(owner) ? owner : null,
        senderName: typeof quote.fromD === "string" && quote.fromD ? quote.fromD : null,
        text: typeof quote.msg === "string" ? quote.msg : "",
        timestamp: Number(quote.ts) || null,
        hasAttachment: Boolean(attach) && attach !== "{}",
    };
}

/**
 * What a cached row replies to (see `quotedReply`), read from the payload the listener or a restore stored.
 *
 * @param {object} row - a `messages` row
 * @returns {ReturnType<typeof quotedReply>}
 */
export function cachedReplyTo(row) {
    return resolveReplyTo(quotedReply(parseRawData(row?.raw_data).quote), row?.threadId);
}

/**
 * Fill in `replyTo.msgId` from the cache when the quote named the message only by its client id.
 *
 * A reply sent from the phone quotes with `globalMsgId: "0"` and the quoted message's `cliMsgId` (seen live
 * 2026-11-06), so without this `replyTo.msgId` was null and nothing tied the reply to the message it answers. Left
 * as it is when the message is not cached, or no database is open in this process.
 *
 * @param {ReturnType<typeof quotedReply>} replyTo
 * @param {string|number|null} [threadId] - the reply's thread, where the quoted message is
 * @param {{find?: Function}} [o] - the client-id lookup, `findMessageByClientId` by default
 * @returns {ReturnType<typeof quotedReply>}
 */
export function resolveReplyTo(replyTo, threadId = null, { find = findMessageByClientId } = {}) {
    if (!replyTo || replyTo.msgId || !replyTo.cliMsgId) return replyTo;
    try {
        const row = find(replyTo.cliMsgId, threadId);
        if (row?.msgId) return { ...replyTo, msgId: String(row.msgId) };
    } catch {
        /* no database open here */
    }
    return replyTo;
}

/**
 * Look one message up in the local SQLite cache by its global msgId.
 *
 * `deleteMessage`, `undo` and `addReaction` need the message's `cliMsgId`
 * (and delete its `uidFrom`), neither of which can be derived from the msgId
 * — cliMsgId is client-generated and only the sender ever saw it. Anything
 * `listen`, `mcp start`, `sync` or a prior `msg history` wrote is here, so a
 * message seen before does not need the ids passed by hand. Returns null when
 * the message is not cached (a just-sent one will not be — `msg send` does not
 * write to the db), is cached under a different conversation, or the db is
 * not open.
 *
 * A direct lookup by msgId, checked against the thread. This used to scan the
 * thread's newest 200 rows, so anything older was reported as uncached.
 *
 * Never throws.
 *
 * @param {string} threadId
 * @param {string} msgId
 * @returns {{cliMsgId: string, uidFrom: string|null}|null}
 */
export function cachedMessageById(threadId, msgId) {
    try {
        const row = getMessageById(msgId);
        // msgIds are account-wide: a row from another conversation must not
        // lend its ids to an action aimed at this one.
        if (!row || (row.threadId && String(row.threadId) !== String(threadId))) return null;

        const data = parseRawData(row.raw_data);
        const cliMsgId = cachedCliMsgId(row);
        const uidFrom = row.senderId ?? data.uidFrom;
        return cliMsgId ? { cliMsgId, uidFrom: uidFrom ? String(uidFrom) : null } : null;
    } catch {
        return null; // no db open in this process
    }
}

/**
 * The cliMsgId an action on one message carries: the caller's own, else the
 * cached row's, else null. Never a guess.
 *
 * @param {{msgId: string, threadId: string, cliMsgId?: string|number|null}} target
 * @param {(threadId: string, msgId: string) => ({cliMsgId: string}|null)} lookup
 * @returns {string|null}
 */
function targetCliMsgId({ msgId, threadId, cliMsgId }, lookup) {
    if (cliMsgId) return String(cliMsgId);
    return lookup(threadId, msgId)?.cliMsgId || null;
}

/**
 * The cliMsgId a reaction must carry, or why there is none.
 *
 * Zalo keys a reaction on the target's cliMsgId as well as its msgId. Given
 * the msgId in its place, it answers "Successful." and the reaction never
 * appears for anyone, so a guess is worse than a refusal: the caller's id
 * first, then the cache, then stop.
 *
 * @param {{msgId: string, threadId: string, cliMsgId?: string|number|null}} target
 * @param {object} [opts]
 * @param {(threadId: string, msgId: string) => ({cliMsgId: string}|null)} [opts.lookup] - the cache
 *   lookup; the CLI passes one that opens the active account's db first
 * @param {string} [opts.passItAs] - how the refusal tells the caller to supply the id themselves
 * @returns {{cliMsgId: string}|{error: string}}
 */
export function reactionCliMsgId(target, { lookup = cachedMessageById, passItAs = "-c <cliMsgId>" } = {}) {
    const cliMsgId = targetCliMsgId(target, lookup);
    if (cliMsgId) return { cliMsgId };
    const { msgId, threadId } = target;
    return {
        error:
            `Message ${msgId} is not in the local cache for ${threadId}, so its cliMsgId is unknown — and a ` +
            `reaction keyed on the msgId is accepted by Zalo but never shown, so none was sent. ` +
            `\`listen\` caches messages as they arrive and \`sync\` restores older ones; ` +
            `or pass the id yourself with ${passItAs}.`,
    };
}

/**
 * The cliMsgId a recall (`undo`) must carry, or why there is none.
 *
 * Zalo's recall names the message by msgId and cliMsgId both, and the
 * cliMsgId is not derivable from the msgId. The same precedence as a
 * reaction: the caller's id, then the cache, then a refusal.
 *
 * @param {{msgId: string, threadId: string, cliMsgId?: string|number|null}} target
 * @param {object} [opts]
 * @param {(threadId: string, msgId: string) => ({cliMsgId: string}|null)} [opts.lookup] - the cache lookup
 * @param {string} [opts.passItAs] - how the refusal tells the caller to supply the id themselves
 * @returns {{cliMsgId: string}|{error: string}}
 */
export function recallCliMsgId(
    target,
    { lookup = cachedMessageById, passItAs = "--cli-msg-id (from `listen --json`)" } = {},
) {
    const cliMsgId = targetCliMsgId(target, lookup);
    if (cliMsgId) return { cliMsgId };
    return {
        error: `cliMsgId is required to recall a message and is not in the local cache. Pass ${passItAs}.`,
    };
}

/** True for a numeric Zalo uid, as opposed to a sync row's noised sender id. */
export function isNumericUid(id) {
    return /^\d+$/.test(String(id ?? ""));
}

/**
 * The sender's real numeric uid.
 *
 * A listener row already holds it (the listener rewrites the own "0" to the uid). A
 * row the mobile sync restored holds a noised id instead, which Zalo will not
 * accept in a pin or a forward reference; it decodes through the same
 * /api/gid/decrypt the sync path uses for conversation ids. gid.js is imported
 * lazily so the common path pays nothing for it.
 *
 * @param {object} api - a logged-in session (only used for a noised id)
 * @param {string|null} senderId - the row's senderId
 * @param {string|null} ownId - this account's uid
 * @returns {Promise<{uid: string}|{error: string}>}
 */
export async function resolveSenderUid(api, senderId, ownId) {
    const id = String(senderId ?? "").trim();
    if (id === "0" && ownId) return { uid: String(ownId) };
    if (isNumericUid(id) && id !== "0") return { uid: id };
    if (!id) return { error: "its sender is not in the cache" };

    try {
        const { resolveNonFriendDms } = await import("../zalo/custom/gid.js");
        const hit = (await resolveNonFriendDms(api, [id])).get(id);
        if (hit?.id && isNumericUid(hit.id)) return { uid: String(hit.id) };
    } catch {
        /* reported below */
    }
    return {
        error:
            "it was restored by sync with a noised sender id that Zalo could not decode " +
            "(/api/gid/decrypt), so its sender's uid is unknown",
    };
}
