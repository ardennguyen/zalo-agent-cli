/**
 * Users and friends: profiles, the friend list, lookups by phone and username, aliases, friend requests, the 1-1 pin
 * board, and the friend extras (remove, block, last online, QR, shared groups, business profile, feed block).
 *
 * Every call is one request on the session envelope (kernel/endpoint.js): a JSON body sealed with the session key
 * into `params`, in the query of a GET or the form of a POST, next to `zpw_ver` and `zpw_type`. The wire follows
 * what the server expects (agent/docs/zca-replace/spec-people.md, spec-sweep.md 1.2/1.3); where it differs from what
 * the previous engine sent, the difference is pinned by tests/unit/wire-people.test.js and its golden records:
 *
 * - profiles and the friend list ask for 160 px avatars, Zalo's one profile size (not 120);
 * - `getprofiles/v2` always says `language: "vi"`, and sends phonebook version 0 when the
 *   login carried none (the key is never left out);
 * - a phone lookup sends `params` once (not twice in the query) and turns a leading `0` into `84`
 *   whatever the session's language (for the multi-phone lookup that rule is ours, see MULTI_BY_PHONES);
 * - a username lookup puts `params` before `zpw_ver`/`zpw_type`, the one call in this area that does;
 * - "no sent requests" (code 112) answers `{}` instead of throwing;
 * - code 212 on a later alias page is the end of the list, answered as an empty page;
 * - 1-1 pin topics that arrive as JSON strings are parsed to objects;
 * - the close-friends list is asked with no `params` at all.
 *
 * Two endpoints answer HTTP 404 on live accounts since 2026-09-29 (`getFriendOnlines`, `getCloseFriends`); they are
 * kept and marked `verified: false` (design 6.1 item 13). Zalo's Friends tab still asks `friend/onlines` with
 * `{imei}`, at most once a minute (`list_friend_online_time`), and nothing newer replaced it; on an HTTP 4xx/5xx it
 * moves to the service map's next profile host, so `getFriendOnlines` now does the same.
 *
 * Ids stay strings throughout: no id is ever converted to a number.
 */
import { AVATAR_SIZE } from "../profile.js";
import { ZaloApiError } from "../errors.js";

/** The avatar size of the phone and username search. */
export const SEARCH_AVATAR_SIZE = 240;

/** The friend-request source for the "find friend" form. */
export const REQ_SRC_FIND_FRIEND_FORM = 40;

/** The friend-request source for "add friend" from a 1-1 chat. */
export const REQ_SRC_CHAT = 30;

/** Phone-search codes that mean "too many lookups". */
export const PHONE_SEARCH_LIMIT_CODES = Object.freeze([312, 313]);

/**
 * A phone number as Zalo's lookups send it: a leading `0` becomes the Vietnamese country code `84`, whatever the
 * session's language.
 *
 * @param {string} phone
 * @returns {string}
 */
export function webPhone(phone) {
    const p = String(phone);
    return p.startsWith("0") ? `84${p.slice(1)}` : p;
}

/**
 * The `friend_pversion_map` entry of a uid: `<uid>_<profile version>`, with version 0 ("send the whole profile")
 * unless the caller already gave an entry with a version.
 *
 * @param {string} uid
 * @returns {string}
 */
export function profileVersionEntry(uid) {
    const id = String(uid);
    return id.includes("_") ? id : `${id}_0`;
}

/**
 * Parse the topics of a 1-1 pin board: an entry that arrives as a JSON string becomes its object; anything else is
 * kept as it is.
 *
 * @param {unknown} data - the reply's `data`
 * @returns {unknown}
 */
export function parseBoardTopics(data) {
    if (!Array.isArray(data)) return data;
    return data.map((entry) => {
        if (typeof entry !== "string") return entry;
        try {
            const parsed = JSON.parse(entry);
            return parsed && typeof parsed === "object" ? parsed : entry;
        } catch {
            return entry;
        }
    });
}

/**
 * The text inside one online friend's `status`, which Zalo sends as JSON text (`{"status": "..."}`); the value
 * itself when it holds no such text.
 *
 * @param {unknown} status
 * @returns {unknown}
 */
function statusTextOf(status) {
    if (typeof status !== "string") return status;
    let wrapped;
    try {
        wrapped = JSON.parse(status);
    } catch {
        return status;
    }
    return typeof wrapped?.status === "string" ? wrapped.status : status;
}

/**
 * The online-friends reply with each friend's `status` read out of its JSON text. A reply without an `onlines`
 * list comes back as it is; entries are copied, never changed in place, and an entry without a text status is kept
 * as it came.
 *
 * @param {unknown} data - the reply's `data`
 * @returns {unknown}
 */
export function parseOnlineStatuses(data) {
    const onlines = data && typeof data === "object" ? data.onlines : undefined;
    if (!Array.isArray(onlines)) return data;
    const read = (entry) =>
        typeof entry?.status === "string" ? { ...entry, status: statusTextOf(entry.status) } : entry;
    return { ...data, onlines: onlines.map(read) };
}

// ── Endpoint definitions (design 1.2) ──────────────────────────────────────────────────────────────────────────

/** `POST {profile}/api/social/friend/getprofiles/v2`. */
export const GET_PROFILES = Object.freeze({
    host: "profile",
    path: "/api/social/friend/getprofiles/v2",
    cmd: 11140,
    method: "post",
    body: ({ userIds }, ctx) => ({
        phonebook_version: ctx.extraVer?.phonebook ?? 0,
        friend_pversion_map: userIds.map(profileVersionEntry),
        avatar_size: AVATAR_SIZE,
        language: "vi",
        show_online_status: 1,
        imei: ctx.imei,
    }),
    reply: "session",
});

/** `GET {profile}/api/social/friend/getfriends` (without its cold-start `init=1`). */
export const GET_FRIENDS = Object.freeze({
    host: "profile",
    path: "/api/social/friend/getfriends",
    cmd: 11137,
    method: "get",
    body: (_args, ctx) => ({
        incInvalid: 1,
        page: 1,
        count: 20000,
        avatar_size: AVATAR_SIZE,
        actiontime: 0,
        imei: ctx.imei,
    }),
    reply: "session",
});

/** `GET {friend}/api/friend/profile/get`, the find-friend lookup. */
export const FIND_BY_PHONE = Object.freeze({
    host: "friend",
    path: "/api/friend/profile/get",
    cmd: 11420,
    method: "get",
    body: ({ phone }, ctx) => ({
        phone: webPhone(phone),
        avatar_size: SEARCH_AVATAR_SIZE,
        language: ctx.language,
        imei: ctx.imei,
        reqSrc: REQ_SRC_FIND_FRIEND_FORM,
    }),
    reply: "session",
});

/** `GET {friend}/api/friend/search/by-user-name`, `params` first in the query. */
export const FIND_BY_USERNAME = Object.freeze({
    host: "friend",
    path: "/api/friend/search/by-user-name",
    cmd: 10004,
    method: "get",
    paramsFirst: true,
    body: ({ username }) => ({ user_name: username, avatar_size: SEARCH_AVATAR_SIZE }),
    reply: "session",
});

/** `GET {alias}/api/alias/list` (v1, the default while `enable_feature_alias_v2` is 0). */
export const ALIAS_LIST = Object.freeze({
    host: "alias",
    path: "/api/alias/list",
    cmd: 12200,
    method: "get",
    body: ({ count, page }, ctx) => ({ page, count, imei: ctx.imei }),
    reply: "session",
});

/** `GET {alias}/api/alias/list` past page 1: code 212 there means the list has ended. */
export const ALIAS_LIST_LATER = Object.freeze({ ...ALIAS_LIST, emptyOn: { 212: { items: [] } } });

/** `GET {alias}/api/alias/update` (a change made with a GET, as the server expects). */
export const ALIAS_UPDATE = Object.freeze({
    host: "alias",
    path: "/api/alias/update",
    cmd: 12201,
    method: "get",
    body: ({ friendId, alias }, ctx) => ({ friendId, alias, imei: ctx.imei }),
    reply: "session",
});

/** `GET {alias}/api/alias/remove`. */
export const ALIAS_REMOVE = Object.freeze({
    host: "alias",
    path: "/api/alias/remove",
    cmd: 12202,
    method: "get",
    body: ({ friendId }) => ({ friendId }),
    reply: "session",
});

/** `POST {friend}/api/friend/sendreq` with the 1-1 chat source (`{src: 30, srcParams}`). */
export const SEND_REQUEST = Object.freeze({
    host: "friend",
    path: "/api/friend/sendreq",
    cmd: 11424,
    method: "post",
    body: ({ userId, msg }, ctx) => ({
        toid: userId,
        msg,
        reqsrc: REQ_SRC_CHAT,
        imei: ctx.imei,
        language: ctx.language,
        // A JSON string inside the JSON body, as the server expects it.
        srcParams: JSON.stringify({ uidTo: userId }),
    }),
    reply: "session",
});

/** `POST {friend}/api/friend/accept`. */
export const ACCEPT_REQUEST = Object.freeze({
    host: "friend",
    path: "/api/friend/accept",
    cmd: 11427,
    method: "post",
    body: ({ friendId }, ctx) => ({ fid: friendId, language: ctx.language }),
    reply: "session",
});

/** `POST {friend}/api/friend/reject`. */
export const REJECT_REQUEST = Object.freeze({
    host: "friend",
    path: "/api/friend/reject",
    cmd: 11428,
    method: "post",
    body: ({ friendId }) => ({ fid: friendId }),
    reply: "session",
});

/** `POST {friend}/api/friend/undo`. */
export const UNDO_REQUEST = Object.freeze({
    host: "friend",
    path: "/api/friend/undo",
    cmd: 11441,
    method: "post",
    body: ({ friendId }) => ({ fid: friendId }),
    reply: "session",
});

/** `GET {friend}/api/friend/requested/list`; code 112 is "none sent", answered `{}`. */
export const SENT_REQUESTS = Object.freeze({
    host: "friend",
    path: "/api/friend/requested/list",
    cmd: 12203,
    method: "get",
    body: (_args, ctx) => ({ imei: ctx.imei }),
    emptyOn: { 112: {} },
    reply: "session",
});

/** `GET {friend}/api/friend/reqstatus`. */
export const REQUEST_STATUS = Object.freeze({
    host: "friend",
    path: "/api/friend/reqstatus",
    cmd: 11430,
    method: "get",
    body: ({ friendId }, ctx) => ({ fid: friendId, imei: ctx.imei }),
    reply: "session",
});

/** `GET {friend}/api/friend/recommendsv2/list`. */
export const RECOMMENDATIONS = Object.freeze({
    host: "friend",
    path: "/api/friend/recommendsv2/list",
    cmd: 11437,
    method: "get",
    body: (_args, ctx) => ({ imei: ctx.imei }),
    reply: "session",
});

/** `GET {friend_board}/api/friendboard/list`; string topics parsed to objects. */
export const FRIEND_BOARD = Object.freeze({
    host: "friend_board",
    path: "/api/friendboard/list",
    cmd: 12065,
    method: "get",
    body: ({ conversationId }, ctx) => ({ conversationId, version: 0, imei: ctx.imei }),
    reply: "session",
    transform: (data) =>
        data && typeof data === "object" && !Array.isArray(data)
            ? { ...data, data: parseBoardTopics(data.data) }
            : data,
});

/**
 * `GET {profile}/api/social/friend/onlines`, what Zalo's Friends tab asks. HTTP 404 live
 * since 2026-09-29 on the first profile host; an HTTP 4xx/5xx moves on to the next host of the service map.
 * Unverified.
 */
export const FRIEND_ONLINES = Object.freeze({
    host: "profile",
    path: "/api/social/friend/onlines",
    cmd: 11290,
    method: "get",
    verified: false,
    swapHosts: true,
    body: (_args, ctx) => ({ imei: ctx.imei }),
    reply: "session",
    transform: parseOnlineStatuses,
});

/** `GET {profile}/api/social/friend/getclosedfriends`, no `params`. HTTP 404 live. */
export const CLOSE_FRIENDS = Object.freeze({
    host: "profile",
    path: "/api/social/friend/getclosedfriends",
    cmd: 11141,
    method: "get",
    verified: false,
    reply: "session",
});

/** `POST {friend}/api/friend/remove`. */
export const REMOVE_FRIEND = Object.freeze({
    host: "friend",
    path: "/api/friend/remove",
    cmd: 11423,
    method: "post",
    body: ({ friendId }, ctx) => ({ fid: friendId, imei: ctx.imei }),
    reply: "session",
});

/** `POST {friend}/api/friend/block` (set). */
export const BLOCK_USER = Object.freeze({
    host: "friend",
    path: "/api/friend/block",
    cmd: 11422,
    method: "post",
    body: ({ userId }, ctx) => ({ fid: userId, imei: ctx.imei }),
    reply: "session",
});

/** `POST {friend}/api/friend/unblock` (unset). */
export const UNBLOCK_USER = Object.freeze({
    host: "friend",
    path: "/api/friend/unblock",
    cmd: 11433,
    method: "post",
    body: ({ userId }, ctx) => ({ fid: userId, imei: ctx.imei }),
    reply: "session",
});

/**
 * `GET {profile}/api/social/profile/lastOnline`, a GET (cmd 12090). `conv_type`: 1 for a user who is not an OA, 2 for
 * an OA (a profile whose `type` is 1 or more), 0 for a group; 1 when the caller names none.
 */
export const LAST_ONLINE = Object.freeze({
    host: "profile",
    path: "/api/social/profile/lastOnline",
    cmd: 12090,
    method: "get",
    body: ({ uid, convType }, ctx) => ({ uid, conv_type: [0, 1, 2].includes(convType) ? convType : 1, imei: ctx.imei }),
    reply: "session",
});

/**
 * `GET {friend}/api/friend/profile/multiget`.
 *
 * The leading `0` -> `84` of {@link webPhone} is our rule here, not a confirmed one for this
 * endpoint: it keeps what the CLI has always sent for a Vietnamese session (the previous engine made the same change when the
 * session language was `vi`), and applies it whatever the language, as `findUser` does.
 */
export const MULTI_BY_PHONES = Object.freeze({
    host: "friend",
    path: "/api/friend/profile/multiget",
    cmd: 11440,
    method: "get",
    body: ({ phones }, ctx) => ({
        phones: phones.map(webPhone),
        avatar_size: SEARCH_AVATAR_SIZE,
        language: ctx.language,
    }),
    reply: "session",
});

/** `POST {friend}/api/friend/mget-qr`. */
export const GET_QR = Object.freeze({
    host: "friend",
    path: "/api/friend/mget-qr",
    cmd: 12128,
    method: "post",
    body: ({ userIds }) => ({ fids: userIds }),
    reply: "session",
});

/** `POST {friend}/api/friend/group/related`; the ids go as a JSON string. */
export const RELATED_GROUPS = Object.freeze({
    host: "friend",
    path: "/api/friend/group/related",
    cmd: 11439,
    method: "post",
    body: ({ friendIds }, ctx) => ({ friend_ids: JSON.stringify(friendIds), imei: ctx.imei }),
    reply: "session",
});

/** `POST {profile}/api/social/friend/get-bizacc`. */
export const BIZ_ACCOUNT = Object.freeze({
    host: "profile",
    path: "/api/social/friend/get-bizacc",
    cmd: 12074,
    method: "post",
    body: ({ friendId }) => ({ fid: friendId }),
    reply: "session",
});

/** `POST {friend}/api/friend/feed/block`. */
export const BLOCK_FEED = Object.freeze({
    host: "friend",
    path: "/api/friend/feed/block",
    cmd: 12204,
    method: "post",
    body: ({ userId, isBlockFeed }, ctx) => ({ fid: userId, isBlockFeed: isBlockFeed ? 1 : 0, imei: ctx.imei }),
    reply: "session",
});

/**
 * A list argument as an array: one id becomes a list of one.
 *
 * @param {string|string[]} v
 * @returns {string[]}
 */
const listOf = (v) => (Array.isArray(v) ? v : [v]);

// ── The methods ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The people calls, bound to one session handle. Argument order is what the engine passes today.
 *
 * @param {import("../api.js").Session} s
 * @returns {Record<string, Function>}
 */
export function peopleMethods(s) {
    return {
        /**
         * Profiles of one or more users, in `changed_profiles` (and `unchanged_profiles`) keyed by uid.
         *
         * @param {string|string[]} userId - a uid, or uids; an entry with `_<version>` is sent as it is
         * @returns {Promise<{changed_profiles: object, unchanged_profiles: object, phonebook_version?: number}>}
         * @throws {ZaloApiError} "Missing user id" before any request when none is given
         */
        getUserInfo: async (userId) => {
            const userIds = listOf(userId).filter((id) => id !== undefined && id !== null && id !== "");
            if (!userIds.length) throw new ZaloApiError("Missing user id");
            return s.call(GET_PROFILES, { userIds });
        },

        /**
         * Every friend of the account, in one page of up to 20000.
         *
         * @returns {Promise<object[]>}
         */
        getAllFriends: () => s.call(GET_FRIENDS, {}),

        /**
         * A user by phone number (snake_case reply: `uid`, `display_name`, `zalo_name`, ...).
         *
         * @param {string} phoneNumber - local (`0...`) or with the country code (`84...`)
         * @returns {Promise<object>}
         * @throws {ZaloApiError} "Missing phoneNumber" before any request; Zalo's 216 (no such user) as it comes; a
         *   312/313 (lookup limit) with a message that says so
         */
        findUser: async (phoneNumber) => {
            if (!phoneNumber) throw new ZaloApiError("Missing phoneNumber");
            try {
                return await s.call(FIND_BY_PHONE, { phone: phoneNumber });
            } catch (e) {
                if (e instanceof ZaloApiError && PHONE_SEARCH_LIMIT_CODES.includes(e.code)) {
                    throw new ZaloApiError(`Phone search limit reached, try again later: ${e.message}`, e.code);
                }
                throw e;
            }
        },

        /**
         * A user by Zalo username (snake_case reply).
         *
         * @param {string} username
         * @returns {Promise<object>}
         */
        findUserByUsername: (username) => s.call(FIND_BY_USERNAME, { username }),

        /**
         * One page of the account's friend aliases. Past page 1, Zalo's 212 is the end of the list and answers
         * `{items: []}`.
         *
         * @param {number} [count] - page size, 100 by default
         * @param {number} [page] - 1-based, 1 by default
         * @returns {Promise<{items: Array<{userId: string, alias: string}>, updateTime?: number, hasMore?: boolean}>}
         */
        getAliasList: (count = 100, page = 1) =>
            s.call(Number(page) > 1 ? ALIAS_LIST_LATER : ALIAS_LIST, { count, page }),

        /**
         * Set a friend's alias.
         *
         * @param {string} alias - the new alias
         * @param {string} friendId
         * @returns {Promise<unknown>}
         */
        changeFriendAlias: (alias, friendId) => s.call(ALIAS_UPDATE, { alias, friendId }),

        /**
         * Remove a friend's alias.
         *
         * @param {string} friendId
         * @returns {Promise<unknown>}
         */
        removeFriendAlias: (friendId) => s.call(ALIAS_REMOVE, { friendId }),

        /**
         * Send a friend request, as from a 1-1 chat.
         *
         * @param {string} msg - the message sent with it
         * @param {string} userId
         * @returns {Promise<unknown>}
         */
        sendFriendRequest: (msg, userId) => s.call(SEND_REQUEST, { msg, userId }),

        /**
         * Accept a friend request.
         *
         * @param {string} friendId
         * @returns {Promise<unknown>}
         */
        acceptFriendRequest: (friendId) => s.call(ACCEPT_REQUEST, { friendId }),

        /**
         * Reject a friend request.
         *
         * @param {string} friendId
         * @returns {Promise<unknown>}
         */
        rejectFriendRequest: (friendId) => s.call(REJECT_REQUEST, { friendId }),

        /**
         * Take back a friend request this account sent.
         *
         * @param {string} friendId
         * @returns {Promise<unknown>}
         */
        undoFriendRequest: (friendId) => s.call(UNDO_REQUEST, { friendId }),

        /**
         * The friend requests this account sent and that are still open, keyed by uid; `{}` when there are none.
         *
         * @returns {Promise<Record<string, object>>}
         */
        getSentFriendRequest: () => s.call(SENT_REQUESTS, {}),

        /**
         * Whether a user is a friend, has a request from this account, or sent one to it (0/1 each).
         *
         * @param {string} friendId
         * @returns {Promise<{is_friend: number, is_requested: number, is_requesting: number}>}
         */
        getFriendRequestStatus: (friendId) => s.call(REQUEST_STATUS, { friendId }),

        /**
         * Recommended friends and received friend requests (`recommItems[].dataInfo.recommType` 2).
         *
         * @returns {Promise<{recommItems: object[]}>}
         */
        getFriendRecommendations: () => s.call(RECOMMENDATIONS, {}),

        /**
         * The pin topics of a 1-1 conversation, each an object.
         *
         * @param {string} conversationId - the peer's uid
         * @returns {Promise<{data: object[], version: number}>}
         */
        getFriendBoardList: (conversationId) => s.call(FRIEND_BOARD, { conversationId }),

        /**
         * The friends online now (unverified: HTTP 404 on live accounts since 2026-09-29).
         *
         * @returns {Promise<{onlines: object[]}>}
         */
        getFriendOnlines: () => s.call(FRIEND_ONLINES, {}),

        /**
         * The close-friends list (unverified: HTTP 404 on live accounts since 2026-09-29).
         *
         * @returns {Promise<unknown>}
         */
        getCloseFriends: () => s.call(CLOSE_FRIENDS, {}),

        /**
         * Remove a friend.
         *
         * @param {string} friendId
         * @returns {Promise<unknown>}
         */
        removeFriend: (friendId) => s.call(REMOVE_FRIEND, { friendId }),

        /**
         * Block a user.
         *
         * @param {string} userId
         * @returns {Promise<unknown>}
         */
        blockUser: (userId) => s.call(BLOCK_USER, { userId }),

        /**
         * Unblock a user.
         *
         * @param {string} userId
         * @returns {Promise<unknown>}
         */
        unblockUser: (userId) => s.call(UNBLOCK_USER, { userId }),

        /**
         * When a user was last online.
         *
         * @param {string} uid
         * @param {0|1|2} [convType] - 1 a user (default), 2 an OA, 0 a group
         * @returns {Promise<{settings?: object, lastOnline?: number}>}
         */
        lastOnline: (uid, convType = 1) => s.call(LAST_ONLINE, { uid, convType }),

        /**
         * Users by phone numbers, keyed by phone.
         *
         * @param {string|string[]} phoneNumbers
         * @returns {Promise<Record<string, object>>}
         * @throws {ZaloApiError} "Missing phoneNumbers" before any request when none is given
         */
        getMultiUsersByPhones: async (phoneNumbers) => {
            if (!phoneNumbers) throw new ZaloApiError("Missing phoneNumbers");
            return s.call(MULTI_BY_PHONES, { phones: listOf(phoneNumbers).map(String) });
        },

        /**
         * The QR code image URL of one or more users, keyed by uid.
         *
         * @param {string|string[]} userId
         * @returns {Promise<Record<string, string>>}
         */
        getQR: (userId) => s.call(GET_QR, { userIds: listOf(userId) }),

        /**
         * The groups this account shares with one or more friends (`groupRelateds`, keyed by uid).
         *
         * @param {string|string[]} friendId
         * @returns {Promise<{groupRelateds: Record<string, string[]>}>}
         */
        getRelatedFriendGroup: (friendId) => s.call(RELATED_GROUPS, { friendIds: listOf(friendId) }),

        /**
         * A user's business-account profile.
         *
         * @param {string} friendId
         * @returns {Promise<object>}
         */
        getBizAccount: (friendId) => s.call(BIZ_ACCOUNT, { friendId }),

        /**
         * Hide (or show again) a user's posts in this account's feed.
         *
         * @param {boolean} isBlockFeed - true hides, false shows
         * @param {string} userId
         * @returns {Promise<unknown>}
         */
        blockViewFeed: (isBlockFeed, userId) => s.call(BLOCK_FEED, { isBlockFeed, userId }),
    };
}

/**
 * Every alias of the account, page by page, the way Zalo pages the alias list: on while the reply's `hasMore` is
 * true when it has that field, otherwise while a page comes back exactly
 * full; code 212 after the first page ends the list (getAliasList answers it as an empty page). An empty page ends
 * it too, so a server that keeps saying `hasMore` cannot loop.
 *
 * @param {{getAliasList: (count: number, page: number) => Promise<{items?: object[], hasMore?: boolean}>}} api
 * @param {{pageSize?: number, maxPages?: number}} [opts]
 * @returns {Promise<Array<{userId: string, alias: string}>>}
 */
export async function readAllAliases(api, { pageSize = 100, maxPages = 1000 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
        const reply = await api.getAliasList(pageSize, page);
        const items = Array.isArray(reply?.items) ? reply.items : [];
        out.push(...items);
        const more = reply && Object.hasOwn(reply, "hasMore") ? Boolean(reply.hasMore) : items.length === pageSize;
        if (!more || !items.length) break;
    }
    return out;
}
