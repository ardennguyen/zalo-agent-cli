/**
 * Intended differences between zca-js and our engine for the groups area: one row per difference, each also recorded
 * in golden/groups.js. Owned by package GRP; no other package edits this file. Row shape and matching rules:
 * tests/helpers/wire-diff/compare.js. Every row says why, naming the Web method (and bundle offset) it follows.
 *
 * The Web is Zalo Web 26.11.10, main bundle `1.c72c0957b455ab70b73c.js`; offsets are into that file. A row whose
 * `method` is `<method>/<case>` holds only for that case of tests/unit/wire-groups.test.js (the test matches a
 * case's record on its case name and carries the method's own rows over to it).
 */

/** A form content type, with or without the charset a fetch adds. */
const FORM = (v) => /^application\/x-www-form-urlencoded/i.test(v ?? "");

/** A list of -1 entries (the "friend" member type), one per member. */
const FRIEND_TYPES = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x === -1);

/** The rows of a sealed GET that the Web sends as a form POST (params move from the query to the body). */
function getToPost(method, why) {
    return [
        { method, field: "method", zca: "GET", own: "POST", why },
        {
            method,
            field: "queryOrder",
            zca: ["zpw_ver", "zpw_type", "params"],
            own: ["zpw_ver", "zpw_type"],
            why: `${why}: params travel in the form body, not the query`,
        },
        {
            method,
            field: "form",
            zca: null,
            own: {},
            why: `${why}: a form body (its only key, params, is compared decrypted)`,
        },
        { method, field: "formOrder", zca: null, own: ["params"], why: `${why}: the form body is params=<sealed>` },
    ];
}

/**
 * Global rows that are untrue here, by row id, per method (`"*"`: every method of the area). The test drops them
 * (a declared row that is absent would fail):
 *
 * - D3 (every method): the global row says our Accept-Language differs from zca-js's, but the kernel on this branch
 *   still sends zca-js's `en-US,en;q=0.9` (src/zalo/kernel/http.js `ACCEPT_LANGUAGE`, kept on purpose by K1 until
 *   it moves into src/zalo/profile.js). If the kernel changes it, the header shows up as an undeclared difference
 *   and this exemption must go.
 * - D2 (getGroupMembersInfo, changeGroupOwner): the global row says "zca-js's GET carries a form content type, ours
 *   none", but we send these requests as a form POST, so ours carries the form content type too and there is no
 *   difference left to see.
 */
export const GLOBAL_EXEMPT = Object.freeze({
    "*": Object.freeze(["D3"]),
    getGroupMembersInfo: Object.freeze(["D2"]),
    changeGroupOwner: Object.freeze(["D2"]),
});

/** @type {Array<{method: string, field: string, zca: unknown, own: unknown, why: string, when?: Function}>} */
export default [
    {
        id: "http-status-text",
        method: "*",
        field: "error.message",
        when: ({ zca }) => /^Request failed with status code \d+$/.test(zca?.error?.message ?? ""),
        zca: (v) => /^Request failed with status code \d+$/.test(v ?? ""),
        own: (v, { zca }) => v === `HTTP ${/(\d+)$/.exec(zca.error.message)[1]}`,
        why: "kernel decodeReply: a non-2xx reply throws `HTTP <status>` (code null, .status set); zca-js wrote axios's text",
    },

    // getAllGroups: Web getGroupListV4 (@11583497) asks getGroupDomain(), the `group` key; zca-js asked group_poll.
    {
        method: "getAllGroups",
        field: "service",
        zca: "group_poll",
        own: "group",
        why: "Web getGroupListV4 (cmd 12027, @11583497) uses the group domain (spec-groups 2)",
    },

    // getGroupMembersInfo: Web getMemberInGroup (@11583992) is a form POST.
    ...getToPost("getGroupMembersInfo", "Web getMemberInGroup (cmd 12030, @11583992) is a form POST (spec-groups 3)"),

    // getGroupInfo in batches of 100: zca-js sent the whole list at once.
    {
        method: "getGroupInfo/batches",
        field: "requests.length",
        zca: 1,
        own: 2,
        why: "Web asks getmg-v2 for at most group_config.num_max_group_a_req (100) groups at a time (spec-groups 1)",
    },
    {
        method: "getGroupInfo/batches",
        field: "params.gridVerMap",
        zca: (v) => Object.keys(JSON.parse(v)).length === 150,
        own: (v) => Object.keys(JSON.parse(v)).length === 100,
        why: "the first batch carries the first 100 groups",
    },
    {
        method: "getGroupInfo/batches",
        field: "result.*",
        zca: undefined,
        own: (v) => v !== undefined,
        why: "the second batch's answer is merged into the result (zca-js had only one answer)",
    },
    {
        method: "getGroupInfo/batches",
        field: "result.removedsGroup",
        zca: [],
        own: ["9000000000000000199"],
        why: "removedsGroup of every batch is concatenated",
    },

    // getGroupMembersInfo in batches of 300.
    {
        method: "getGroupMembersInfo/batches",
        field: "requests.length",
        zca: 1,
        own: 2,
        why: "Web asks social/group/members for at most group_config.num_max_member_a_req (300) ids (spec-groups 3)",
    },
    {
        method: "getGroupMembersInfo/batches",
        field: "params.friend_pversion_map",
        zca: (v) => v.length === 350,
        own: (v) => v.length === 300,
        why: "the first batch carries the first 300 ids",
    },
    {
        method: "getGroupMembersInfo/batches",
        field: "result.*",
        zca: undefined,
        own: (v) => v !== undefined,
        why: "the second batch's profiles are merged into the result",
    },

    // createGroup: Web createGroupV2 (@11590904) and its compose dialog (@7550860).
    {
        method: "createGroup",
        field: "method",
        zca: "POST",
        own: "GET",
        why: "Web createGroupV2 (cmd 12443, @11590904) is a GET with params in the query (spec-groups 4.1)",
    },
    {
        method: "createGroup",
        field: "headers.content-type",
        zca: FORM,
        own: undefined,
        why: "a GET carries no body, so no content type (zca-js's bodiless POST still sent the form type)",
    },
    {
        method: "createGroup",
        field: "params.membersTypes",
        zca: FRIEND_TYPES,
        own: undefined,
        why: "zca-js misspelled the key (spec-groups 4.2)",
    },
    {
        method: "createGroup",
        field: "params.memberTypes",
        zca: undefined,
        own: FRIEND_TYPES,
        why: "Web createGroupV2 sends memberTypes, -1 per friend member (spec-groups 4.2)",
    },
    {
        method: "createGroup",
        field: "params.zsource",
        zca: 601,
        own: undefined,
        why: "Web createGroupV2 sends no zsource (spec-groups 4.3)",
    },
    {
        method: "createGroup",
        field: "params.groupType",
        zca: undefined,
        own: 1,
        why: "Web's compose dialog passes groupType NORMAL, which module 6E7Z's enum makes 1 (COMMUNITY 2) (design 6.1 #17)",
    },
    {
        method: "createGroup",
        field: "paramsOrder",
        zca: (v) => v.includes("membersTypes") && v.at(-1) === "zsource",
        own: [
            "clientId",
            "gname",
            "gdesc",
            "members",
            "memberTypes",
            "nameChanged",
            "createLink",
            "clientLang",
            "imei",
            "groupType",
        ],
        why: "Web createGroupV2's key order",
    },
    {
        method: "createGroup/withSelf",
        field: "params.members",
        zca: (v) => v.length === 2,
        own: (v) => v.length === 1,
        why: "Web's createGroupV2 controller (@7550860 caller) leaves the own uid out of members",
    },
    {
        method: "createGroup/emptyName",
        field: "requests.length",
        zca: 1,
        own: 0,
        why: "an empty name is refused before any request (design 6.1 #15); zca-js sent a timestamp as the name",
    },
    {
        method: "createGroup/emptyName",
        field: "result",
        zca: (v) => v !== undefined,
        own: undefined,
        why: "refused: nothing is returned",
    },
    {
        method: "createGroup/emptyName",
        field: "error",
        zca: null,
        own: { message: "A group name must not be empty", code: null },
        why: "refused before any request",
    },

    // changeGroupName: an empty name is refused.
    {
        method: "changeGroupName/emptyName",
        field: "requests.length",
        zca: 1,
        own: 0,
        why: "an empty name is refused before any request (design 6.1 #15); zca-js sent a timestamp as the name",
    },
    {
        method: "changeGroupName/emptyName",
        field: "result",
        zca: (v) => v !== undefined,
        own: undefined,
        why: "refused: nothing is returned",
    },
    {
        method: "changeGroupName/emptyName",
        field: "error",
        zca: null,
        own: { message: "A group name must not be empty", code: null },
        why: "refused before any request",
    },

    // changeGroupOwner: a form POST on the Web (spec-sweep 1.3 verb fix).
    ...getToPost("changeGroupOwner", "Web changeGroupOwner (cmd 10063, @11689648) is a form POST (spec-sweep 1.3)"),

    // disperseGroup: Web writes imei first.
    {
        method: "disperseGroup",
        field: "paramsOrder",
        zca: ["grid", "imei"],
        own: ["imei", "grid"],
        why: "Web disperseGroup (cmd 11832, @11612223) builds {imei, grid}",
    },

    // changeGroupAvatar: Web updateAvatar (@11634110) and its callers (@7550378, @15527812).
    {
        method: "changeGroupAvatar",
        field: "params.avatarSize",
        zca: 120,
        own: 160,
        why: "every Web caller of updateAvatar (cmd 11195) passes 160 (@7550378, @15527812)",
    },
    {
        method: "changeGroupAvatar",
        field: "params.clientId",
        zca: (v) => /^g9000000000000000001\d\d:\d\d \d\d\/\d\d\/\d{4}$/.test(v),
        own: (v) => /^1234567890123456789\d\d:\d\d \d\d\/\d\d\/\d{4}$/.test(v),
        why: "Web stamps the clientId as the own uid + getFullTimeFromMilisecond(now) (@7550378); zca-js used g<groupId>",
    },
    {
        method: "changeGroupAvatar",
        field: "paramsOrder",
        zca: ["grid", "avatarSize", "clientId", "imei", "originWidth", "originHeight"],
        own: ["grid", "avatarSize", "clientId", "originWidth", "originHeight", "imei"],
        why: "Web updateAvatar's key order (@11634110)",
    },

    // The Web's avatar size (`le=160` in the API module, @11568587).
    {
        method: "getGroupLinkInfo",
        field: "params.avatar_size",
        zca: 120,
        own: 160,
        why: "Web getGroupInfoByLink (cmd 11824, @11613538) sends the module's avatar size, 160 (@11568587)",
    },
    {
        method: "getGroupLinkInfo",
        field: "params.member_avatar_size",
        zca: 120,
        own: 160,
        why: "Web getGroupInfoByLink (cmd 11824, @11613538) sends the module's avatar size, 160 (@11568587)",
    },
    {
        method: "getGroupInviteBoxList",
        field: "params.avatar_size",
        zca: 120,
        own: 160,
        why: "Web getGroupInvitationList (cmd 12170, @11615676) sends the module's avatar size, 160 (@11568587)",
    },
    {
        method: "getGroupInviteBoxList",
        field: "params.member_avatar_size",
        zca: 120,
        own: 160,
        why: "Web getGroupInvitationList (cmd 12170, @11615676) sends the module's avatar size, 160 (@11568587)",
    },
];
