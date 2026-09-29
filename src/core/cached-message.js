/**
 * Read what a cached `messages` row can tell a command that acts on it.
 *
 * Reacting, forwarding and pinning all name their target by more than its
 * msgId: the client id only the sender ever minted, the sender's numeric uid,
 * the exact text. None of that is in any CLI output; it lives in the row the
 * listener or the mobile sync wrote. Read-only: nothing here writes zalo.db.
 */

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

/** True for a numeric Zalo uid, as opposed to a sync row's noised sender id. */
export function isNumericUid(id) {
    return /^\d+$/.test(String(id ?? ""));
}

/**
 * The sender's real numeric uid.
 *
 * A listener row already holds it (zca-js rewrites the own "0" to the uid). A
 * row the mobile sync restored holds a noised id instead, which Zalo will not
 * accept in a pin or a forward reference; it decodes through the same
 * /api/gid/decrypt the sync path uses for conversation ids. gid.js is imported
 * lazily so the common path pays nothing for it.
 *
 * @param {object} api - a logged-in zca-js API (only used for a noised id)
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
        const { resolveNonFriendDms } = await import("./sync-v2/gid.js");
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
