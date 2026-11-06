/**
 * A group's own `visibility`, for the recall (`undo`) of a message in it.
 *
 * Zalo Web's group recall (`undoMessage`, cmd 11192) sends the group's `visibility` from its group-info cache, 0
 * when the cache has none; the previous engine always sent 0 (spec-actions 1.3, open question 4). `msg undo` and `zalo_undo` do
 * what Web does with what they have: the MCP server's thread cache when it holds the value, else the group's info
 * from Zalo (`getGroupInfo`, the call Web's cache is filled from). When neither answers, the payload carries no
 * `visibility` and the engine sends 0, as before.
 *
 * Nothing here writes or logs.
 */

/** Zalo's thread type for a group. */
const THREAD_GROUP = 1;

/**
 * A visibility value as a number, or undefined when there is none.
 *
 * @param {unknown} v
 * @returns {number|undefined}
 */
function visibilityOf(v) {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * The group's `visibility`: from `cache` when it holds the value, else from `api.getGroupInfo`.
 *
 * @param {object} api - a logged-in api
 * @param {string} groupId - the group id (a `g` prefix is ignored)
 * @param {object} [opts]
 * @param {{get: (id: string) => object|null|undefined}} [opts.cache] - the MCP thread cache
 * @returns {Promise<number|undefined>} undefined when nothing knows it
 */
export async function groupVisibility(api, groupId, { cache } = {}) {
    const gid = String(groupId ?? "").replace(/^g(?=\d+$)/, "");
    if (!gid) return undefined;
    let cached;
    try {
        cached = visibilityOf(cache?.get?.(gid)?.visibility);
    } catch {
        cached = undefined;
    }
    if (cached !== undefined) return cached;
    if (typeof api?.getGroupInfo !== "function") return undefined;
    try {
        const info = await api.getGroupInfo([gid]);
        return visibilityOf(info?.gridInfoMap?.[gid]?.visibility);
    } catch {
        return undefined;
    }
}

/**
 * The recall payload for `api.undo`: `{msgId, cliMsgId}`, plus the group's `visibility` for a group message when it
 * is known. A 1-1 recall is returned as it came.
 *
 * @param {object} api
 * @param {{msgId: string, cliMsgId: string}} payload
 * @param {string} threadId
 * @param {number} threadType - 0 a person, 1 a group
 * @param {object} [opts] - `{cache}`, as {@link groupVisibility}
 * @returns {Promise<{msgId: string, cliMsgId: string, visibility?: number}>}
 */
export async function undoPayload(api, payload, threadId, threadType, opts = {}) {
    if (Number(threadType) !== THREAD_GROUP) return payload;
    const visibility = await groupVisibility(api, threadId, opts);
    return visibility === undefined ? payload : { ...payload, visibility };
}
