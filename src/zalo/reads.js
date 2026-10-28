/**
 * The read-only endpoints Zalo Web calls and this client did not (plan track S, 6.1).
 *
 * Every entry is one GET or POST of the web client's API module (`fBUP`, bundle build 826674fb31d2af1b2b59 and the
 * 2026-10-23 refresh), with its service-map host, path, command id and the body it encrypts, read from that module's
 * method of the same purpose. They all ride the session cipher: the body is JSON, AES-encrypted with the session key
 * into `params`, in the query of a GET or the form body of a POST, beside `zpw_ver` and `zpw_type`; the reply is the
 * ordinary session envelope. `check-update` is the exception, a plain query with no encryption.
 *
 * Reads only. A call here changes nothing on the account: no entry sends a message, a receipt, a seen mark or a
 * setting. The state-changing endpoints of the same web client (plan 6.2) are in ./writes.js, behind a dry run and a
 * confirmation.
 *
 * `verified` says whether the entry's reply has been seen on a live account. An entry that is not verified has its
 * request shape from the bundle (or, for the emoji-status pair, only its path and the presence of `params` from a
 * capture), so a failure of it says "not accepted", not "broken".
 */
import { getAccountDir } from "../core/credentials.js";
import { readTranscript, voiceTextFile } from "../core/voice-text.js";
import { readAccountStatus } from "../core/account-status.js";
import { CallError, CallUsageError, arg, buildCall, list, num, runCall } from "./web-call.js";

/** The avatar size the web client asks profile endpoints for. */
const AVATAR_SIZE = 160;

/** The largest signed 64-bit id, past every real message id: a "page back from" read then starts at the newest. */
const NEWEST_PAGE_ID = String(2n ** 63n - 1n);

/**
 * @typedef {object} ReadDef
 * @property {string} host - service-map key, or "auth"
 * @property {string} path
 * @property {number|null} cmd - the web client's command id (documentation; it is not sent)
 * @property {"get"|"post"|"query"} [method="get"] - "query": a GET whose body is the plain query, unencrypted
 * @property {"session"|"plain"} [reply="session"] - "plain": the reply is `{error_code, data}` with `data` unencrypted
 * @property {number[]} [okCodes] - error codes besides 0 that are an answer, not a failure
 * @property {string} what - one line for a person
 * @property {Array<{name: string, type: string, required?: boolean, desc: string}>} args
 * @property {(a: object, ctx: object) => (object|null)} [body] - what is encrypted into `params`; absent: no `params`
 * @property {(a: object) => Record<string,string>} [headers]
 * @property {(a: object) => Record<string,string>} [extraQuery]
 * @property {(a: object, api: object) => any} [local] - a read answered here, with no request of its own: what the
 *   listener recorded on this machine (`voice-transcript`), or an answer composed from several reads (`account-status`,
 *   which makes its own calls). `host` and `path` are "local" and "-"
 * @property {boolean} verified - whether a live account has answered it
 */

/** @type {Record<string, ReadDef>} */
export const READS = {
    // ── session and login (S1) ──────────────────────────────────────────────
    // ── what the listener recorded (nothing is sent) ───────────────────────
    "voice-transcript": {
        host: "local",
        path: "-",
        cmd: null,
        what: "The text of a voice message Zalo transcribed (ask with `write run voice-to-text`); the listener records it when it arrives",
        args: [arg("reqId", "string", "the request id `voice-to-text` returned (leave out for the recent ones)")],
        local: (a, api) => readTranscript(voiceTextFile(getAccountDir(String(api.getOwnId()))), a.reqId),
        verified: true,
    },
    "account-status": {
        host: "local",
        path: "-",
        cmd: null,
        what: "The account's plans in one answer: the zBusiness package and its limits, the zCloud plan, usage, limits and subscription expiry (composed from several reads; `zalo-agent account status` prints the same)",
        args: [],
        local: (_a, api) => readAccountStatus(api, { ownId: String(api.getOwnId()) }),
        verified: true,
    },
    "check-update": {
        host: "auth",
        path: "/api/login/chkUpdate",
        cmd: 11160,
        method: "query",
        reply: "plain",
        okCodes: [1001],
        what: "Whether Zalo has update information for the client version this one announces (1001: none)",
        args: [],
        body: (_a, ctx) => ({ imei: ctx.imei, type: ctx.API_TYPE, client_version: ctx.API_VERSION }),
        verified: true,
    },
    "server-settings": {
        host: "auth",
        path: "/api/login/setting",
        cmd: 11329,
        reply: "plain",
        what: "The server-side client settings the web client reads at boot (seasonal effects and the like)",
        args: [],
        verified: true,
    },

    // ── conversations and read state (S2) ──────────────────────────────────
    "last-messages": {
        host: "conversation",
        path: "/api/preloadconvers/get-last-msgs",
        cmd: 10053,
        what: "The last message of conversations, for a preview (thread id to local message id, as the client asks)",
        args: [arg("items", "json", "object or array naming the conversations and their local message ids", true)],
        body: (a, ctx) => ({ threadIdLocalMsgId: JSON.stringify(a.items), imei: ctx.imei }),
        verified: true,
    },
    "last-seen": {
        host: "chat",
        path: "/api/preloadconvers/get-last-seen",
        cmd: 12009,
        what: "Where the other side has read up to, for the given group and one-to-one conversations",
        args: [
            arg("group", "json", "group conversations (array)"),
            arg("oneone", "json", "one-to-one conversations (array)"),
        ],
        body: (a) => ({ param: JSON.stringify({ group: list(a.group), oneone: list(a.oneone) }) }),
        verified: true,
    },
    "offline-check": {
        host: "conversation",
        path: "/api/conv/cm/grOfl",
        cmd: 12300,
        what: "Which conversations have messages waiting offline (the web client's own boot probe; `{}`, `0`, `0` ask for all)",
        args: [
            arg("queueInfo", "json", "queue info as the client sends it", true),
            arg("lastActId", "string", "last action id"),
            arg("lastMsgId", "string", "last message id"),
        ],
        body: (a) => ({ queueInfo: a.queueInfo, lastActId: a.lastActId ?? "", lastMsgId: a.lastMsgId ?? "" }),
        verified: true,
    },
    "last-seen-react": {
        host: "reaction",
        path: "/api/react/gLastSn",
        cmd: 12450,
        what: "Where the other side has seen reactions up to",
        args: [arg("group", "json", "group conversations (array)"), arg("oneone", "json", "one-to-one (array)")],
        body: (a) => ({ group: list(a.group), oneone: list(a.oneone) }),
        verified: true,
    },
    "message-status": {
        host: "chat",
        path: "/api/message/getStatusMsg",
        cmd: 12016,
        method: "post",
        what: "Delivery and seen status of one-to-one conversations' messages",
        args: [arg("data", "json", "array of `{tId}`: the conversations (user ids) to ask about", true)],
        body: (a) => ({ param: JSON.stringify({ data: a.data }) }),
        verified: true,
    },
    "group-message-status": {
        host: "group",
        path: "/api/group/getStatusMsg",
        cmd: 12017,
        method: "post",
        what: "Delivery and seen status of group messages",
        args: [
            arg(
                "data",
                "json",
                "array of `{tId, ids}`: the group id without its `g`, and the message ids (needed)",
                true,
            ),
        ],
        body: (a) => ({ param: JSON.stringify({ data: a.data }) }),
        verified: true,
    },
    "important-messages": {
        host: "chat",
        path: "/api/message/fetchImportant",
        cmd: 12114,
        what: "A conversation's important messages (urgent, mentions), 50 at a time",
        args: [
            arg("uid", "string", "conversation id", true),
            arg("newestId", "string", "the newest id the client holds: answers what is newer than it"),
            arg("lastId", "string", "page back from this id (default: past every id, the newest page)"),
        ],
        body: (a) => {
            const b = { limit: 50, uid: String(a.uid) };
            if (a.newestId !== undefined && a.newestId !== null) b.newestId = a.newestId;
            else b.lastId = a.lastId ?? NEWEST_PAGE_ID;
            return b;
        },
        verified: true,
    },
    "recent-searches": {
        host: "recent_search",
        path: "/api/recentsearch/list",
        cmd: 12125,
        what: "The search history the account keeps on Zalo's side",
        args: [arg("version", "number", "the history version the client holds (0 for all)")],
        body: (a, ctx) => ({ version: num(a.version, 0), imei: ctx.imei }),
        verified: true,
    },

    // ── friends (S7 reads) ─────────────────────────────────────────────────
    blocklist: {
        host: "friend",
        path: "/api/friend/blocklistv2",
        cmd: 11429,
        what: "The accounts this one has blocked",
        args: [arg("page", "number", "page, from 1"), arg("count", "number", "per page (50)")],
        body: (a) => ({ page: num(a.page, 1), count: num(a.count, 50), avatar: 75 }),
        verified: true,
    },
    "contact-tab-last-read": {
        host: "friend",
        path: "/api/friend/last-read-contact-tab",
        cmd: 12230,
        what: "When the contact tab was last read",
        args: [],
        verified: true,
    },
    "mini-profiles": {
        host: "profile",
        path: "/api/social/friend/getminiprofiles",
        cmd: 12134,
        method: "post",
        what: "Short profiles of accounts (name, avatar), including ones that are no longer valid",
        args: [arg("ids", "json", "user ids (array)", true)],
        body: (a) => ({ friend_ids: list(a.ids).map(String), avatar_size: AVATAR_SIZE, incInvalid: 1, srcReq: -1 }),
        verified: true,
    },
    "friend-verify": {
        host: "profile",
        path: "/api/social/friend/verify",
        cmd: 11138,
        method: "post",
        what: "Which of the friend profiles the client holds are out of date",
        args: [
            arg("versions", "json", "array of `userId_version` strings, the profile versions the client holds", true),
            arg("phonebookVersion", "number", "phonebook version held"),
        ],
        body: (a, ctx) => ({
            phonebook_version: num(a.phonebookVersion, 0),
            friend_pversion_map: list(a.versions).map(String),
            avatar_size: AVATAR_SIZE,
            language: ctx.language || "vi",
            imei: ctx.imei,
        }),
        verified: true,
    },
    phonebook: {
        host: "profile",
        path: "/api/social/friend/phonebook/v2",
        cmd: 12428,
        what: "The phonebook contacts Zalo matched, newer than a version",
        args: [arg("phonebookVersion", "number", "phonebook version held (0 for all)")],
        body: (a) => ({ phonebook_version: num(a.phonebookVersion, 0) }),
        verified: true,
    },
    "friend-context": {
        host: "friend",
        path: "/api/friend/context/multiget",
        cmd: 11442,
        method: "post",
        what: "Extra context the client shows for friends (how they were found, mutual details)",
        args: [arg("ids", "json", "user ids (array)", true)],
        body: (a, ctx) => ({ fids: list(a.ids).map(String), imei: ctx.imei }),
        verified: true,
    },

    // ── profile and groups (S7 reads) ──────────────────────────────────────
    "profile-extra": {
        host: "profile",
        path: "/api/social/profile/extra",
        cmd: 11864,
        what: "The extra profile fields the client shows for an account",
        args: [arg("id", "string", "user id", true)],
        body: (a, ctx) => ({ profile_id: String(a.id), imei: ctx.imei }),
        verified: true,
    },
    "profile-rank": {
        host: "profile",
        path: "/api/social/profile/getrank",
        cmd: 12012,
        what: "An account's rank and badges",
        args: [arg("id", "string", "user id", true)],
        body: (a, ctx) => ({ profile_id: String(a.id), imei: ctx.imei }),
        verified: true,
    },
    "oa-convert-ids": {
        host: "profile",
        path: "/api/social/oa/convertid",
        cmd: 11863,
        what: "Turn Official Account ids into the ids the profile service uses for them (the web client asks before opening an OA from a link)",
        args: [arg("oaIds", "json", "OA ids without the `OA` prefix (array)", true)],
        body: (a) => ({ oa_ids: list(a.oaIds).map(String) }),
        // Answered `{}` for an id that is not an OA (2026-10-28); the shape of a real OA's answer has not been seen.
        verified: true,
    },
    aliases: {
        host: "alias",
        path: "/api/alias/list/v2",
        cmd: 12205,
        what: "The nicknames set for friends (the v2 list)",
        args: [arg("page", "number", "page, from 1"), arg("count", "number", "per page (20)")],
        body: (a, ctx) => ({ page: num(a.page, 1), count: num(a.count, 20), src: -1, imei: ctx.imei }),
        verified: true,
    },
    "noise-ids": {
        host: "profile",
        path: "/api/gid/encrypt",
        cmd: 12053,
        what: "The noised form of ids (the sync stream's opaque conversation ids)",
        args: [arg("ids", "json", "ids (array)", true)],
        body: (a) => ({ noiseUids: list(a.ids).map(String) }),
        verified: true,
    },
    "noised-uids": {
        host: "profile",
        path: "/api/znoise",
        cmd: 12390,
        what: "The noised ids of friends and groups",
        args: [arg("friends", "json", "friend ids (array)"), arg("groups", "json", "group ids (array)")],
        body: (a) => ({ fids: list(a.friends).map(String), gids: list(a.groups).map(String) }),
        verified: true,
    },
    "group-quota-community": {
        host: "group",
        path: "/api/group/quota/community",
        cmd: 12181,
        what: "How many communities an account may create or join, and how many it has",
        args: [arg("groupId", "string", "group id, when asking about one")],
        body: (a, ctx) => ({ language: ctx.language || "vi", grId: a.groupId ?? null }),
        verified: true,
    },
    "group-quota-members": {
        host: "group",
        path: "/api/group/quota/members-comm",
        cmd: 12182,
        what: "Whether a user may be added to a community (its member quota)",
        args: [arg("groupId", "string", "group id", true), arg("userId", "string", "user id", true)],
        body: (a, ctx) => ({ language: ctx.language || "vi", grId: String(a.groupId), uid: String(a.userId) }),
        verified: true,
    },
    "group-user-context": {
        host: "group",
        path: "/api/group/userctx/multiget",
        cmd: 12607,
        method: "post",
        what: "What the account is in each group (role, restrictions)",
        args: [arg("groupIds", "json", "group ids (array)", true)],
        body: (a, ctx) => ({ grids: list(a.groupIds).map(String), imei: ctx.imei }),
        verified: true,
    },

    // ── stickers and GIFs (S4 reads) ───────────────────────────────────────
    "sticker-category": {
        host: "sticker",
        path: "/api/message/sticker/category/detail",
        cmd: 11156,
        what: "One sticker pack and its stickers",
        args: [arg("cid", "number", "pack id", true)],
        body: (a) => ({ cid: num(a.cid) }),
        verified: true,
    },
    "blocksharing-list": {
        host: "conversation",
        path: "/api/conv/blocksharing/getConvers",
        cmd: 12178,
        what: "The conversations that have block sharing on (who turned it on: `isActor` 1 is this account)",
        args: [],
        body: () => ({}),
        verified: true,
    },
    "sticker-personalized": {
        host: "sticker",
        path: "/api/message/sticker/personalized/list",
        cmd: 11745,
        what: "The stickers the account uses most",
        args: [],
        body: (_a, ctx) => ({ imei: ctx.imei }),
        verified: true,
    },
    "sticker-keywords": {
        host: "sticker",
        path: "/api/message/sticker/suggest/keywords",
        cmd: 11740,
        what: "The keywords that suggest stickers while typing",
        args: [],
        body: (_a, ctx) => ({ imei: ctx.imei }),
        verified: true,
    },
    "sticker-tenor-map": {
        host: "sticker",
        path: "/api/message/sticker/tenor/mapping",
        cmd: 12015,
        what: "The map from Tenor GIFs to stickers",
        args: [],
        body: (_a, ctx) => ({ imei: ctx.imei }),
        verified: true,
    },
    "sticker-hello": {
        host: "sticker",
        path: "/api/message/sticker/suggestion",
        cmd: 11751,
        what: "The greeting stickers Zalo suggests",
        args: [],
        body: (_a, ctx) => ({ imei: ctx.imei }),
        verified: true,
    },
    "sticker-effects": {
        host: "sticker",
        path: "/api/message/effects",
        cmd: 11742,
        what: "The effect definitions of sticker effect ids",
        args: [arg("effectIds", "json", "effect ids (array of numbers)", true)],
        body: (a) => ({ effect_ids: list(a.effectIds).map(Number) }),
        verified: true,
    },
    "gif-categories": {
        host: "sticker",
        path: "/api/message/giphy/cates",
        cmd: 11294,
        what: "The GIF categories",
        args: [arg("offset", "number", "from (0)"), arg("limit", "number", "how many (10)")],
        body: (a) => ({ offset: num(a.offset, 0), limit: num(a.limit, 10) }),
        verified: true,
    },
    "gif-trending": {
        host: "sticker",
        path: "/api/message/giphy/trending",
        cmd: 11296,
        what: "The trending GIFs",
        args: [arg("offset", "number", "from (0)"), arg("limit", "number", "how many (10)")],
        body: (a, ctx) => ({ offset: num(a.offset, 0), limit: num(a.limit, 10), imei: ctx.imei }),
        verified: true,
    },
    "gif-search": {
        host: "sticker",
        path: "/api/message/giphy/search",
        cmd: 11297,
        what: "GIFs matching a keyword",
        args: [
            arg("keyword", "string", "what to search for", true),
            arg("offset", "number", "from (0)"),
            arg("limit", "number", "how many (10)"),
        ],
        body: (a) => ({ keyword: String(a.keyword), offset: num(a.offset, 0), limit: num(a.limit, 10) }),
        verified: true,
    },

    // ── boards (S6 reads) ──────────────────────────────────────────────────
    "pin-list": {
        host: "group_board",
        path: "/api/board/pin/list",
        cmd: 12001,
        what: "A group's pinned board items and the pin board's version (the version `unpin` and `unpin-many` need)",
        args: [
            arg("groupId", "string", "group id", true),
            arg("boardVersion", "number", "the version the client holds (0 for all)"),
        ],
        body: (a, ctx) => ({
            groupId: String(a.groupId).startsWith("g") ? String(a.groupId).slice(1) : String(a.groupId),
            boardVersion: num(a.boardVersion, 0),
            imei: ctx.imei,
        }),
        verified: true,
    },
    "banner-info": {
        host: "banner",
        path: "/api/banner/v1/info",
        cmd: 16181,
        what: "The banners Zalo shows at the top of the conversation list (new in this web build)",
        args: [],
        body: (_a, ctx) => ({ imei: ctx.imei }),
        verified: true,
    },

    // ── status (S8 reads) ──────────────────────────────────────────────────
    "emoji-status-friends": {
        host: "emoji_stt",
        path: "/api/v1/emoji-status/friends",
        cmd: 16301,
        what: "The emoji statuses friends have set",
        args: [],
        body: (_a, ctx) => ({ imei: ctx.imei }),
        verified: true,
    },
    "emoji-status-config": {
        host: "emoji_stt",
        path: "/api/v1/emoji-status/resource-config",
        cmd: 16300,
        what: "The emoji status resources the client may offer",
        args: [],
        body: (_a, ctx) => ({ imei: ctx.imei }),
        verified: true,
    },
};

/** Names of every read, sorted. */
export const READ_NAMES = Object.keys(READS).sort();

/** Raised for an unknown read name or a missing argument, before any request is made. */
export const ReadUsageError = CallUsageError;

/** Zalo's own error, from a plain reply. */
export const ReadError = CallError;

/**
 * Build the request for a read without sending it (what {@link callRead} sends; the tests read it).
 *
 * @param {object} api - logged-in zca-js api
 * @param {string} name - a key of {@link READS}
 * @param {object} [args]
 * @returns {ReturnType<typeof buildCall>}
 */
export function buildRead(api, name, args = {}) {
    const def = READS[name];
    if (!def) throw new ReadUsageError(`unknown read "${name}"; known: ${READ_NAMES.join(", ")}`);
    if (def.local)
        throw new ReadUsageError(`"${name}" is a local read: nothing is sent to Zalo, so there is no request to build`);
    return buildCall(api, def, name, args);
}

/**
 * Call a read and return the decoded reply.
 *
 * @param {object} api - logged-in zca-js api
 * @param {string} name - a key of {@link READS}
 * @param {object} [args]
 * @returns {Promise<any>} the reply's data
 * @throws {ReadUsageError} for an unknown name or a missing argument, before any request
 * @throws {Error} Zalo's own error (code in `.code`) when the reply is an error
 */
export async function callRead(api, name, args = {}) {
    const def = READS[name];
    if (def?.local) {
        for (const a of def.args) {
            if (a.required && (args[a.name] === undefined || args[a.name] === null || args[a.name] === "")) {
                throw new ReadUsageError(`"${name}" needs "${a.name}" (${a.desc})`);
            }
        }
        return def.local(args, api);
    }
    return runCall(api, buildRead(api, name, args));
}

/**
 * The reads, for a person or an agent to choose from.
 *
 * @returns {Array<{name: string, what: string, host: string, path: string, verified: boolean,
 *   args: Array<{name: string, type: string, required: boolean, desc: string}>}>}
 */
export function describeReads() {
    return READ_NAMES.map((name) => {
        const d = READS[name];
        return {
            name,
            what: d.what,
            host: d.host,
            path: d.path,
            verified: d.verified,
            args: d.args.map((a) => ({ name: a.name, type: a.type, required: !!a.required, desc: a.desc })),
        };
    });
}
