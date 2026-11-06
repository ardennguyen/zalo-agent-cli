/**
 * Intended differences between zca-js and our engine for the business area: one row per difference, each also recorded
 * in golden/business.js. Owned by package PRF; no other package edits this file. Row shape and matching rules:
 * tests/helpers/wire-diff/compare.js. Every row says why, naming the Web method (and bundle offset) it follows.
 *
 * Example: `{ method: "getAllGroups", field: "service", zca: "group_poll", own: "group", why: "Web getGroupListV4" }`
 *
 * Each row also names the test case(s) of tests/unit/wire-business.test.js it is about (`case`): a method row must
 * be present in every run it is checked against, and one method has runs with and without a given difference
 * (getListBankAccount in range and clamped), so the test checks each run against the rows of its own case only.
 *
 * Offsets are in Zalo Web 26.11.10's `1.c72c0957b455ab70b73c.js` (agent/work/zalo-web-capture-2026-11-06/bundles/).
 */

const BANK_DIRECTORY_WHY = "Web getListBank (@11705022) GETs /api/transfer/conf with the common params only";
const AUTO_REPLY_WHY = (m, at) =>
    `Web ${m} (@${at}) seals the params into the query and posts no body (_post(url, null))`;

/** The four rows of an auto-reply write: params in the query, no body. */
function autoReplyRows(method, cases, webMethod, at) {
    const why = AUTO_REPLY_WHY(webMethod, at);
    return [
        {
            method,
            case: cases,
            field: "queryOrder",
            zca: ["zpw_ver", "zpw_type"],
            own: ["zpw_ver", "zpw_type", "params"],
            why,
        },
        { method, case: cases, field: "form", zca: {}, own: null, why },
        { method, case: cases, field: "formOrder", zca: ["params"], own: null, why },
        {
            method,
            case: cases,
            field: "headers.content-type",
            zca: "application/x-www-form-urlencoded",
            own: undefined,
            why: `${why}: with no body there is no content type`,
        },
    ];
}

/** @type {Array<{method: string, field: string, zca: unknown, own: unknown, why: string, when?: Function, case?: string|string[]}>} */
export default [
    // getListBank: no params at all. (spec-sweep 1.3 read its verb as post; the method body is _get(url, null).)
    {
        method: "getListBank",
        case: "bank-directory",
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type", "params"],
        own: ["zpw_ver", "zpw_type"],
        why: BANK_DIRECTORY_WHY,
    },
    { method: "getListBank", case: "bank-directory", field: "params", zca: {}, own: null, why: BANK_DIRECTORY_WHY },
    {
        method: "getListBank",
        case: "bank-directory",
        field: "paramsOrder",
        zca: [],
        own: null,
        why: BANK_DIRECTORY_WHY,
    },

    // getListBankAccount: page >= 0 and limit >= 1, clamped as getListBankCard (@11704708) clamps them.
    {
        method: "getListBankAccount",
        case: "bank-accounts-clamp",
        field: "params.page",
        zca: -1,
        own: 0,
        why: "Web getListBankCard (@11704708) sends page > 0 ? page : 0",
    },
    {
        method: "getListBankAccount",
        case: "bank-accounts-clamp",
        field: "params.limit",
        zca: 0,
        own: 1,
        why: "Web getListBankCard (@11704708) sends limit > 1 ? limit : 1",
    },

    // addQuickMessage with a photo: the Web's key order {keyword, message, media, type, imei} (@11693495).
    {
        method: "addQuickMessage",
        case: "quick-add-media",
        field: "paramsOrder",
        zca: ["keyword", "message", "type", "imei", "media"],
        own: ["keyword", "message", "media", "type", "imei"],
        why: "Web createQuickReplyItem (@11693495) writes {keyword, message, media, type, imei}",
    },

    // updateQuickMessage with a photo: the Web's key order {itemId, keyword, message, media, type} (@11693816).
    {
        method: "updateQuickMessage",
        case: "quick-update-media",
        field: "paramsOrder",
        zca: ["itemId", "keyword", "message", "type", "media"],
        own: ["itemId", "keyword", "message", "media", "type"],
        why: "Web updateQuickReplyItem (@11693816) writes {itemId, keyword, message, media, type}",
    },

    // Auto-reply writes: the params ride in the query, no body.
    ...autoReplyRows("createAutoReply", ["auto-reply-create", "auto-reply-create-chosen"], "createAutoReply", 11692077),
    ...autoReplyRows("updateAutoReply", "auto-reply-update", "updateAutoReply", 11692503),
    ...autoReplyRows("deleteAutoReply", "auto-reply-delete", "deleteAutoReply", 11692936),
];
