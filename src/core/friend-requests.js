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
 * Nothing here writes zalo.db: these are reshapers of what the engine's
 * friend calls return, plus the error wording for the writes. Zalo's error
 * code is read from the error's `.code`, never out of its message.
 */
import { errorCodeOf } from "../zalo/errors.js";
import { personNameFields } from "./contact-names.js";

/** The recommendations feed's item type for a request someone sent us. */
export const RECEIVED_FRIEND_REQUEST = 2;

/** Zalo's code for "this account has no open sent friend requests" (`/api/friend/requested/list`). */
export const NO_SENT_REQUESTS = 112;

/** Zalo's code for "too many friend requests taken back": Zalo Web says to wait 24 hours. */
export const UNDO_LIMIT_REACHED = 301;

/**
 * The numeric error code in a message such as "... (225)".
 *
 * Kept for the group actions of `zalo_group`, which still fall back to it; the friend paths read `.code` only.
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
 * The line `friend add` prints when a friend request fails: the specific wording for a known code, else Zalo's code
 * (when the error carries one) and its message.
 *
 * @param {Error|object} err - the error the send threw
 * @param {string} userId
 * @returns {string}
 */
export function friendAddFailure(err, userId) {
    const code = errorCodeOf(err);
    const known = describeFriendAddError(code, userId);
    if (known) return known;
    const why = err?.message ?? String(err);
    return code === null ? `Friend request failed: ${why}` : `Friend request failed (code ${code}): ${why}`;
}

/**
 * What a failed "take back a friend request" means, for the codes that have a meaning of their own.
 *
 * @param {number|string|null|undefined} code - Zalo's error code
 * @param {string} userId
 * @returns {string|undefined} undefined for a code with no specific wording
 */
export function describeFriendUndoError(code, userId) {
    if (Number(code) === UNDO_LIMIT_REACHED) {
        return (
            `Zalo refused to cancel the friend request to ${userId}: too many requests were taken back ` +
            `recently. Try again in 24 hours (code ${UNDO_LIMIT_REACHED}).`
        );
    }
    return undefined;
}

/**
 * The friend requests this account sent and that are still open, keyed by userId; `{}` when there are none.
 *
 * The engine already answers Zalo's "none sent" (112) with `{}`; an error that still carries code 112 reads the
 * same, so "no requests" is never reported as a failure.
 *
 * @param {{getSentFriendRequest: () => Promise<Record<string, object>|null>}} api
 * @returns {Promise<Record<string, object>>}
 */
export async function readSentRequests(api) {
    try {
        const res = await api.getSentFriendRequest();
        return res && typeof res === "object" ? res : {};
    } catch (e) {
        if (errorCodeOf(e) === NO_SENT_REQUESTS) return {};
        throw e;
    }
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

/** `displayName` alias first (the owner's alias, as Zalo shows the person), with `alias` and `zaloName` beside it. */
const names = (uid, u) => personNameFields(uid, u);

/**
 * Requests we sent, from `getSentFriendRequest()` (an object keyed by userId).
 *
 * @param {Record<string, object>|null|undefined} res
 * @returns {Array<{userId: string, displayName: string|null, alias: string|null, zaloName: string|null, message: string, requestedAt: string|null}>}
 */
export function sentRequestsFrom(res) {
    return Object.entries(res && typeof res === "object" ? res : {}).map(([userId, r]) => ({
        userId: String(r?.userId ?? userId),
        ...names(r?.userId ?? userId, r),
        message: r?.fReqInfo?.message ?? "",
        requestedAt: toIso(r?.fReqInfo?.time),
    }));
}

/**
 * Requests sent to us, from `getFriendRecommendations()`: the items of type
 * "received friend request", newest first. Suggestions are left out.
 *
 * @param {{recommItems?: Array<{dataInfo?: object}>}|null|undefined} res
 * @returns {Array<{userId: string, displayName: string|null, alias: string|null, zaloName: string|null, message: string, receivedAt: string|null, seen: boolean}>}
 */
export function receivedRequestsFrom(res) {
    const items = Array.isArray(res?.recommItems) ? res.recommItems : [];
    return items
        .map((i) => i?.dataInfo)
        .filter((d) => d && Number(d.recommType) === RECEIVED_FRIEND_REQUEST && d.userId)
        .map((d) => ({
            userId: String(d.userId),
            ...names(d.userId, d),
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
 * Friends, most recently active first, as the CLI lists them.
 *
 * @param {Array<object>|null|undefined} list - `getAllFriends()`
 * @param {number|null} [limit] - the most to return; omitted, null or <= 0 = every friend
 * @returns {{total: number, friends: Array<{userId: string, displayName: string|null, alias: string|null, zaloName: string|null, lastActionTime: number|null}>}}
 */
export function friendsFrom(list, limit) {
    const all = Array.isArray(list) ? list : [];
    const sorted = [...all].sort((a, b) => (b?.lastActionTime || 0) - (a?.lastActionTime || 0));
    return {
        total: all.length,
        friends: (Number(limit) > 0 ? sorted.slice(0, limit) : sorted).map((f) => ({
            userId: String(f.userId),
            ...names(f.userId, f),
            lastActionTime: f.lastActionTime || null,
        })),
    };
}
