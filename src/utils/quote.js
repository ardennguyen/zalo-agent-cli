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

    // transfer-sync-v2 restores rows with an opaque sender id
    // ("VNOISED0000000000000000000000091") rather than the numeric uid the
    // live listener records. Zalo puts this on the wire as `qmsgOwner`, so
    // the quote still sends but may lose its attribution. `msg history`
    // re-fetches the same messages with numeric uids.
    const opaqueSender = !/^-?\d+$/.test(String(uidFrom));

    return {
        ...(opaqueSender && {
            warning:
                `Message ${id} was restored by sync and carries an opaque sender id, so the quoted ` +
                `block may show no author. Run \`msg history <threadId> -t <0|1>\` to re-fetch it first.`,
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
