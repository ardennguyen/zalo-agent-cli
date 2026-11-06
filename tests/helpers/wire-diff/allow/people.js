/**
 * Intended differences between zca-js and our engine for the people area: one row per difference, each also recorded
 * in golden/people.js. Owned by package PPL; no other package edits this file. Row shape and matching rules:
 * tests/helpers/wire-diff/compare.js. Every row says why, naming the Web method (and bundle offset) it follows.
 *
 * Example: `{ method: "getAllGroups", field: "service", zca: "group_poll", own: "group", why: "Web getGroupListV4" }`
 *
 * Each row also names the test case(s) of tests/unit/wire-people.test.js it is about (`case`): a method row must be
 * present in every run it is checked against, and one method has runs with and without a given difference (a vi
 * and an en session, a reply with and without an error code), so the test checks each run against the rows of its
 * own case only.
 *
 * Offsets are in Zalo Web 26.11.10's `1.c72c0957b455ab70b73c.js` (agent/work/zalo-web-capture-2026-11-06/bundles/),
 * except the pin board, which is in `web-startup.a00a02c532982ab4915a.js`.
 */

/** The Web's avatar size for every profile call (its constant `le`), where zca-js asked for 120. */
const AVATAR_WHY = "Web getFriendProfilev2 (@11588058) and getFriendsList (@11581722) ask avatar_size 160 (`le`)";

/** zca-js's query for a phone lookup: `params` appended twice. */
const FIND_USER_CASES = ["findUser", "findUser/lang-en", "findUser/216", "findUser/313"];

/** @type {Array<{method: string, field: string, zca: unknown, own: unknown, why: string, when?: Function, case?: string|string[]}>} */
export default [
    // getUserInfo: avatar 160, language "vi" at every caller, phonebook version 0 when the login had none.
    {
        method: "getUserInfo",
        case: ["getUserInfo", "getUserInfo/lang-en", "getUserInfo/no-phonebook"],
        field: "params.avatar_size",
        zca: 120,
        own: 160,
        why: AVATAR_WHY,
    },
    {
        method: "getUserInfo",
        case: "getUserInfo/lang-en",
        field: "params.language",
        zca: "en",
        own: "vi",
        why: 'Web getFriendProfilev2 (@11588058) defaults language to "vi" and every caller passes "vi"',
    },
    {
        method: "getUserInfo",
        case: "getUserInfo/no-phonebook",
        field: "params.phonebook_version",
        zca: undefined,
        own: 0,
        why: "Web getFriendProfilev2 (@11588058) always sends phonebook_version (default 0); zca-js dropped the key when the login carried no phonebook version",
    },
    {
        method: "getUserInfo",
        case: "getUserInfo/no-phonebook",
        field: "paramsOrder",
        zca: ["friend_pversion_map", "avatar_size", "language", "show_online_status", "imei"],
        own: ["phonebook_version", "friend_pversion_map", "avatar_size", "language", "show_online_status", "imei"],
        why: "the same phonebook_version key, first in the Web's body (@11588058)",
    },

    // getAllFriends: avatar 160.
    {
        method: "getAllFriends",
        case: "getAllFriends",
        field: "params.avatar_size",
        zca: 120,
        own: 160,
        why: AVATAR_WHY,
    },

    // findUser: params once; a leading 0 becomes 84 whatever the language; the lookup limit says so.
    {
        method: "findUser",
        case: FIND_USER_CASES,
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type", "params", "params"],
        own: ["zpw_ver", "zpw_type", "params"],
        why: "Web getUserByPhone (@11609035) sends params once; zca-js appended it to the URL and then again",
    },
    {
        method: "findUser",
        case: "findUser/lang-en",
        field: "params.phone",
        zca: "0901234567",
        own: "84901234567",
        why: "the Web's phone paths turn a leading 0 into 84 whatever the UI language (spec-people 3.3); zca-js did it only for vi",
    },
    {
        method: "findUser",
        case: "findUser/313",
        field: "error.message",
        zca: "fake limit",
        own: "Phone search limit reached, try again later: fake limit",
        why: "the Web's find-friend form reads 312/313 as the phone-search limit (spec-people 3.3); the code is kept",
    },

    // findUserByUsername: params first.
    {
        method: "findUserByUsername",
        case: "findUserByUsername",
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type", "params"],
        own: ["params", "zpw_ver", "zpw_type"],
        why: "Web getUserByUsername (@11609365) builds {params, ...common}: the one call here with params first",
    },

    // getAliasList: 212 past page 1 is the end of the list.
    {
        method: "getAliasList",
        case: "getAliasList/212-later",
        field: "result",
        zca: undefined,
        own: { items: [] },
        why: "the Web's alias repo (@9214260) ends the list on 212 once it has items, keeping what it collected",
    },
    {
        method: "getAliasList",
        case: "getAliasList/212-later",
        field: "error",
        zca: { message: "fake end of list", code: 212 },
        own: null,
        why: "the same 212: an end, not an error (@9214260)",
    },

    // getSentFriendRequest: 112 is "none sent".
    {
        method: "getSentFriendRequest",
        case: ["getSentFriendRequest/112", "getSentFriendRequest/112-outer"],
        field: "result",
        zca: undefined,
        own: {},
        why: "112 means no open sent requests; the engine's callers wanted {} and looked for 112 in a message zca-js never wrote it into (spec-people 13.1, design 6.1 item 15)",
    },
    {
        method: "getSentFriendRequest",
        case: ["getSentFriendRequest/112", "getSentFriendRequest/112-outer"],
        field: "error",
        zca: (v) => v?.code === 112,
        own: null,
        why: "the same 112, answered instead of thrown",
    },

    // getFriendBoardList: string topics parsed.
    {
        method: "getFriendBoardList",
        case: "getFriendBoardList",
        field: "result.data.1",
        zca: (v) => typeof v === "string",
        own: (v) => !!v && typeof v === "object" && v.type === 2,
        why: "a pin topic that arrives as a JSON string is parsed, so findPinnedTopic can read it (spec-people 16.3; Web getListOneOnOnePinTopics, web-startup @979078)",
    },

    // getCloseFriends: no params.
    {
        method: "getCloseFriends",
        case: "getCloseFriends",
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type", "params"],
        own: ["zpw_ver", "zpw_type"],
        why: "Web getCloseFriends (@11609873) and getCloseFriend (@11587342) send the common params only, no params",
    },
    {
        method: "getCloseFriends",
        case: "getCloseFriends",
        field: "params",
        zca: {},
        own: null,
        why: "the same: no sealed body at all (@11609873)",
    },
    {
        method: "getCloseFriends",
        case: "getCloseFriends",
        field: "paramsOrder",
        zca: [],
        own: null,
        why: "the same: no sealed body at all (@11609873)",
    },

    // getMultiUsersByPhones: the same 0 -> 84 rule as findUser; here the rule is ours (see MULTI_BY_PHONES).
    {
        method: "getMultiUsersByPhones",
        case: "getMultiUsersByPhones/lang-en",
        field: "params.phones.0",
        zca: "0901234567",
        own: "84901234567",
        why: "our rule, not one read from the Web's multiget callers: keep the CLI's 0 -> 84 (zca-js did it for a vi session) whatever the language, as findUser does (spec-people 3.3)",
    },
];
