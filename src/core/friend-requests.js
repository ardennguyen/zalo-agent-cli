/**
 * Friend requests, as the CLI's `friend` commands and the MCP tool `zalo_friend`
 * both read them.
 *
 * Zalo has no "incoming requests" list of its own. Zalo Web shows them inside
 * the recommendations feed: an item whose `recommType` is 2
 * (`FriendRecommendationsType.ReceivedFriendRequest`) is a request someone
 * sent us, with their message in `recommInfo.message`; type 1 is an ordinary
 * suggestion. `friend recommendations` already labels them `[request]`.
 *
 * Nothing here talks to Zalo or writes zalo.db: these are pure reshapers of
 * what the zca-js calls return, plus the error wording for the writes.
 */

/** zca-js FriendRecommendationsType.ReceivedFriendRequest. */
export const RECEIVED_FRIEND_REQUEST = 2;

/**
 * The numeric error code in a zca-js error message such as "... (225)".
 *
 * @param {unknown} msg
 * @returns {number|null}
 */
export function extractErrorCode(msg) {
    const match = String(msg).match(/\((-?\d+)\)/);
    return match ? Number(match[1]) : null;
}

/**
 * What a failed friend request means, in words that say what to do next.
 *
 * @param {number|string|null|undefined} code - Zalo's error code
 * @param {string} userId
 * @returns {string|undefined} undefined for a code with no specific wording
 */
export function describeFriendAddError(code, userId) {
    const map = {
        225: `Already friends with ${userId}. Use "friend list" to verify.`,
        215: `User ${userId} may have blocked you or is unreachable.`,
        222: `User ${userId} already sent you a friend request. Use "friend accept ${userId}" instead.`,
        "-1": `Invalid userId "${userId}". Use "friend find <phone>" to get the correct userId first.`,
        // Names from Zalo Web's own error table (TOO_MANY_REQUESTS, FULL_FRIEND_REQUESTING, FULL_FRIEND).
        221: "Zalo says too many requests were sent: wait a while before sending more.",
        223: "Zalo says the pending friend-request list is full (223).",
        224: "Zalo says the friend list is full (224).",
    };
    return map[String(code)];
}

/**
 * An epoch timestamp as ISO text, whether Zalo gave seconds or milliseconds.
 *
 * Which unit a friend-request time carries has not been measured on a live
 * account; anything below 1e11 cannot be a millisecond time of this century,
 * so it is read as seconds.
 *
 * @param {unknown} ts
 * @returns {string|null} null when it is not a usable time
 */
export function toIso(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n < 1e11 ? n * 1000 : n).toISOString();
}

const name = (u) => u?.displayName || u?.zaloName || null;

/**
 * Requests we sent, from `getSentFriendRequest()` (an object keyed by userId).
 *
 * @param {Record<string, object>|null|undefined} res
 * @returns {Array<{userId: string, displayName: string|null, message: string, requestedAt: string|null}>}
 */
export function sentRequestsFrom(res) {
    return Object.entries(res && typeof res === "object" ? res : {}).map(([userId, r]) => ({
        userId: String(r?.userId ?? userId),
        displayName: name(r),
        message: r?.fReqInfo?.message ?? "",
        requestedAt: toIso(r?.fReqInfo?.time),
    }));
}

/**
 * Requests sent to us, from `getFriendRecommendations()`: the items of type
 * "received friend request", newest first. Suggestions are left out.
 *
 * @param {{recommItems?: Array<{dataInfo?: object}>}|null|undefined} res
 * @returns {Array<{userId: string, displayName: string|null, message: string, receivedAt: string|null, seen: boolean}>}
 */
export function receivedRequestsFrom(res) {
    const items = Array.isArray(res?.recommItems) ? res.recommItems : [];
    return items
        .map((i) => i?.dataInfo)
        .filter((d) => d && Number(d.recommType) === RECEIVED_FRIEND_REQUEST && d.userId)
        .map((d) => ({
            userId: String(d.userId),
            displayName: name(d),
            message: d.recommInfo?.message ?? "",
            receivedAt: toIso(d.recommTime),
            seen: Boolean(d.isSeenFriendReq),
            _t: Number(d.recommTime) || 0,
        }))
        .sort((a, b) => b._t - a._t)
        .map(({ _t, ...rest }) => rest);
}

/**
 * The relationship with one user, from `getFriendRequestStatus()`.
 * Zalo answers 0 or 1 for each flag; these are booleans.
 *
 * @param {{is_friend?: number, is_requested?: number, is_requesting?: number}|null|undefined} res
 * @param {string} userId
 * @returns {{userId: string, is_friend: boolean, is_requested: boolean, is_requesting: boolean}}
 */
export function friendStatusFrom(res, userId) {
    return {
        userId: String(userId),
        is_friend: Boolean(res?.is_friend),
        is_requested: Boolean(res?.is_requested),
        is_requesting: Boolean(res?.is_requesting),
    };
}

/**
 * Friends, most recently active first, as the CLI lists them, capped.
 *
 * @param {Array<object>|null|undefined} list - `getAllFriends()`
 * @param {number} limit
 * @returns {{total: number, friends: Array<{userId: string, displayName: string|null, lastActionTime: number|null}>}}
 */
export function friendsFrom(list, limit) {
    const all = Array.isArray(list) ? list : [];
    const sorted = [...all].sort((a, b) => (b?.lastActionTime || 0) - (a?.lastActionTime || 0));
    return {
        total: all.length,
        friends: sorted.slice(0, limit).map((f) => ({
            userId: String(f.userId),
            displayName: name(f),
            lastActionTime: f.lastActionTime || null,
        })),
    };
}
