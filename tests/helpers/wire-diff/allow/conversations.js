/**
 * Intended differences between zca-js and our engine for the conversations area: one row per difference, each also
 * recorded in golden/conversations.js. Owned by package ACT; no other package edits this file. Row shape and matching
 * rules: tests/helpers/wire-diff/compare.js. Every row says why, naming the Web method (and bundle offset) it follows.
 *
 * Example: `{ method: "getAllGroups", field: "service", zca: "group_poll", own: "group", why: "Web getGroupListV4" }`
 *
 * Each row also names the test case(s) of tests/unit/wire-conversations.test.js it is about (`case`): a method row
 * must be present in every run it is checked against, and one method has runs with and without a given difference
 * (a DM and a group, hide and unhide), so the test checks each run against the rows of its own case only.
 *
 * Offsets are in Zalo Web 26.11.10's `1.c72c0957b455ab70b73c.js` (agent/work/zalo-web-capture-2026-11-06/bundles/).
 */
import { isDeepStrictEqual } from "node:util";

/** A JSON string's value, or undefined when it is not one. */
const parsed = (v) => {
    try {
        return JSON.parse(v);
    } catch {
        return undefined;
    }
};

const AUTO_DELETE_WHY =
    "Web updateAutoDeleteConvers (@11691440) seals the params into the query and posts no body (_post(url, null))";

/** @type {Array<{method: string, field: string, zca: unknown, own: unknown, why: string, when?: Function, case?: string|string[]}>} */
export default [
    // addUnreadMark: the Web's fixed key order inside `param` (addMarkAsUnread @11602557).
    {
        method: "addUnreadMark",
        case: "unread-add-dm",
        field: "params.param",
        zca: (v) => isDeepStrictEqual(Object.keys(parsed(v) ?? {}), ["convsUser", "convsGroup", "imei"]),
        own: (v, { zca }) =>
            isDeepStrictEqual(Object.keys(parsed(v) ?? {}), ["convsGroup", "convsUser", "imei"]) &&
            isDeepStrictEqual(parsed(v), parsed(zca.params.param)),
        why: "Web addMarkAsUnread (@11602557) always writes {convsGroup, convsUser, imei}",
    },

    // setHiddenConversations: the Web's fixed key order (updateItemHiddenChat @11686769).
    {
        method: "setHiddenConversations",
        case: "hide",
        field: "paramsOrder",
        zca: ["add_threads", "del_threads", "imei"],
        own: ["del_threads", "add_threads", "imei"],
        why: "Web updateItemHiddenChat (@11686769) always writes {del_threads, add_threads, imei}",
    },

    // resetHiddenConversPin: no params at all (resetPIN @11687472).
    {
        method: "resetHiddenConversPin",
        case: "pin-reset",
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type", "params"],
        own: ["zpw_ver", "zpw_type"],
        why: "Web resetPIN (@11687472) GETs /api/hiddenconvers/reset with the common params only",
    },
    {
        method: "resetHiddenConversPin",
        case: "pin-reset",
        field: "params",
        zca: {},
        own: null,
        why: "Web resetPIN (@11687472) sends no params, not a sealed {}",
    },
    {
        method: "resetHiddenConversPin",
        case: "pin-reset",
        field: "paramsOrder",
        zca: [],
        own: null,
        why: "Web resetPIN (@11687472) sends no params, not a sealed {}",
    },

    // updateAutoDeleteChat: POST with the params in the query and no body.
    {
        method: "updateAutoDeleteChat",
        case: ["auto-delete-dm", "auto-delete-group"],
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type"],
        own: ["zpw_ver", "zpw_type", "params"],
        why: AUTO_DELETE_WHY,
    },
    {
        method: "updateAutoDeleteChat",
        case: ["auto-delete-dm", "auto-delete-group"],
        field: "headers.content-type",
        zca: "application/x-www-form-urlencoded",
        own: undefined,
        why: `${AUTO_DELETE_WHY}: with no body there is no content type`,
    },
    {
        method: "updateAutoDeleteChat",
        case: ["auto-delete-dm", "auto-delete-group"],
        field: "form",
        zca: {},
        own: null,
        why: AUTO_DELETE_WHY,
    },
    {
        method: "updateAutoDeleteChat",
        case: ["auto-delete-dm", "auto-delete-group"],
        field: "formOrder",
        zca: ["params"],
        own: null,
        why: AUTO_DELETE_WHY,
    },
];
