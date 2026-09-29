/**
 * Rebuild the quote payload `sendMessage({ msg, quote })` needs from a cached
 * message row.
 *
 * Quoting is the one send that cannot be driven from a msgId alone. zca-js
 * puts five fields on the wire — `qmsgOwner`, `qmsgId`, `qmsgCliId`,
 * `qmsgTs`, `qmsg` (and `qmsgAttach` for groups) — and two of them,
 * `cliMsgId` and the `property` blob, appear in no CLI output at all. They
 * live only in `messages.raw_data` in the local SQLite cache, which is why
 * `--quote` is a cache lookup rather than a pure argument transform.
 *
 * Only **text** messages can be quoted natively. zca-js raises
 * `This kind of 'webchat' quote type is not available` when a `webchat`
 * quote's content is not a string, and the sync path stores a *placeholder*
 * string ("[Hình ảnh]", "[Sticker]", "[File] …") for attachments — which
 * would slip past that check and send a quote whose visible text is the
 * placeholder. So the guard here is the row's classified `type`, not the
 * shape of its content.
 */

/**
 * `raw_data` as an object, whatever shape the writer used.
 *
 * The live path stores the message payload directly; some rows nest it under
 * `data`. An older writer stored the bare content string, so a parse that
 * yields a non-object is treated as "no metadata" rather than throwing.
 *
 * @param {string|null|undefined} rawData
 * @returns {object}
 */
function parseRaw(rawData) {
    try {
        const parsed = JSON.parse(rawData || "{}");
        if (!parsed || typeof parsed !== "object") return {};
        return parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    } catch {
        return {};
    }
}

/**
 * Turn a cached `messages` row into the `quote` object zca-js expects.
 *
 * Returns `{ error }` rather than throwing so the caller can report a
 * reason the user can act on — "not cached, run msg history" is a very
 * different problem from "stickers can't be quoted".
 *
 * @param {object|null} row - a row from the `messages` table, or null when the
 *   msgId is not cached
 * @param {object} [opts]
 * @param {string} [opts.msgId] - the requested id, used in messages when `row` is null
 * @param {string} [opts.threadId] - when given, the quote must belong to this thread
 * @returns {{quote: object}|{error: string}}
 */
export function buildQuote(row, { msgId = row?.msgId, threadId = null } = {}) {
    const id = msgId === undefined || msgId === null ? "(unknown)" : String(msgId);

    if (!row) {
        return {
            error:
                `Message ${id} is not in the local cache, so its quote cannot be rebuilt. ` +
                `Fetch the thread first: \`msg history <threadId> -t <0|1>\`.`,
        };
    }

    // msgIds are account-wide, so a mistyped or pasted-from-elsewhere id finds
    // a real row in the wrong conversation. Zalo would render that quote
    // against a message the recipients cannot see.
    if (threadId && row.threadId && String(row.threadId) !== String(threadId)) {
        return {
            error: `Cannot quote message ${id}: it belongs to thread ${row.threadId}, not ${threadId}.`,
        };
    }

    const data = parseRaw(row.raw_data);

    // The classifier's own vocabulary ("text", "photo", "sticker", "file", …).
    // Rows old enough to predate it fall back to the content shape.
    const kind = row.type || (typeof data.content === "string" ? "text" : null);
    if (kind !== "text") {
        return {
            error:
                `Cannot quote message ${id}: Zalo only supports quote-replies to text messages ` +
                `(this one is ${kind ? `a ${kind}` : "not text"}). Send a plain reply instead.`,
        };
    }

    const content = typeof data.content === "string" ? data.content : row.text;
    if (typeof content !== "string" || content.length === 0) {
        return { error: `Cannot quote message ${id}: no text was cached for it.` };
    }

    // Client-generated and only ever known to the sender — nothing can derive it.
    const cliMsgId = data.cliMsgId;
    if (cliMsgId === undefined || cliMsgId === null || cliMsgId === "") {
        return {
            error:
                `Cannot quote message ${id}: its cliMsgId was never cached. ` +
                `Re-fetch the thread with \`msg history <threadId> -t <0|1>\`.`,
        };
    }

    const uidFrom = row.senderId ?? data.uidFrom;
    if (!uidFrom) return { error: `Cannot quote message ${id}: its sender is unknown.` };

    const ts = row.timestamp ?? data.ts;
    if (!ts) return { error: `Cannot quote message ${id}: its timestamp is unknown.` };

    // transfer-sync-v2 restores rows with a NOISED sender id
    // ("VNOISED0000000000000000000000081") rather than the numeric uid the live
    // listener records. This is not a cosmetic attribution problem: Zalo puts
    // it on the wire as `qmsgOwner` and REJECTS the send with code 114.
    // Measured 2026-09-28 — the same quote with a real numeric uid substituted
    // in went through immediately.
    //
    // It is recoverable, so the caller should resolve rather than refuse: these
    // ids decode through the same /api/gid/decrypt the sync path already uses
    // for conversation ids (3/3 resolved, with display names). `buildQuote`
    // stays synchronous and pure, so it reports the need and
    // `resolveQuoteSender` below does the call.
    const opaqueSender = !/^-?\d+$/.test(String(uidFrom));

    return {
        opaqueSender,
        ...(opaqueSender && {
            warning:
                `Message ${id} was restored by sync and carries a noised sender id, which Zalo rejects ` +
                `(code 114). Resolving it; if that fails, run \`msg history <threadId> -t <0|1>\` to ` +
                `re-fetch the message with a real uid.`,
        }),
        quote: {
            content,
            // Normalized rather than echoed: the live path records "webchat"
            // and the sync path records the numeric 0 for the same text
            // message. zca-js maps both to client type 1, so say it once.
            msgType: "webchat",
            // Group quotes go out as `qmsgAttach: JSON.stringify(propertyExt)`.
            // undefined is tolerated (removeUndefinedKeys drops it) but the
            // quoted block renders with the sender's attribution when it's there.
            propertyExt: data.property ?? undefined,
            uidFrom: String(uidFrom),
            msgId: String(row.msgId ?? id),
            cliMsgId: String(cliMsgId),
            ts: String(ts),
            ttl: 0,
        },
    };
}

/**
 * Turn a quote's noised `uidFrom` into the real numeric uid.
 *
 * Only needed when `buildQuote` reported `opaqueSender`. A sync-restored row's
 * sender is a noised id and Zalo rejects it as `qmsgOwner` with code 114, so
 * without this a restored message simply cannot be quoted — which is half the
 * point of restoring it.
 *
 * The decode is the same `/api/gid/decrypt` (cmd 12054) the sync path already
 * uses for conversation ids; `resolveNonFriendDms` accepts message sender ids
 * unchanged. Imported lazily so the pure module keeps no network dependency and
 * stays cheap to test.
 *
 * Mutates and returns `quote` on success. On failure it leaves `quote`
 * untouched and returns an `error` describing what to do instead, rather than
 * sending something the server will reject.
 *
 * @param {object} quote - the `quote` from buildQuote()
 * @param {object} api - a logged-in zca-js api
 * @returns {Promise<{quote?: object, error?: string, resolved?: string}>}
 */
export async function resolveQuoteSender(quote, api) {
    const noised = String(quote?.uidFrom ?? "");
    if (!noised) return { error: "Cannot resolve a quote with no sender." };
    if (/^-?\d+$/.test(noised)) return { quote }; // already real; nothing to do

    let resolveNonFriendDms;
    try {
        ({ resolveNonFriendDms } = await import("../core/sync-v2/gid.js"));
    } catch (e) {
        return { error: `Cannot resolve the quoted message's sender (${e.message}).` };
    }

    let hit;
    try {
        const map = await resolveNonFriendDms(api, [noised]);
        hit = map.get(noised);
    } catch (e) {
        return { error: `Resolving the quoted message's sender failed (${e.message}).` };
    }

    if (!hit?.id) {
        return {
            error:
                `Could not resolve the quoted message's sender. Zalo rejects a noised id with code 114, ` +
                `so run \`msg history <threadId> -t <0|1>\` to re-fetch that message with a real uid.`,
        };
    }

    quote.uidFrom = String(hit.id);
    return { quote, resolved: hit.name || String(hit.id) };
}
