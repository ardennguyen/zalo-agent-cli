/**
 * Intended differences between zca-js and our engine for the actions area: one row per difference, each also recorded
 * in golden/actions.js. Owned by package ACT; no other package edits this file. Row shape and matching rules:
 * tests/helpers/wire-diff/compare.js. Every row says why, naming the Web method (and bundle offset) it follows.
 *
 * Example: `{ method: "getAllGroups", field: "service", zca: "group_poll", own: "group", why: "Web getGroupListV4" }`
 *
 * Each row also names the test case(s) of tests/unit/wire-actions.test.js it is about (`case`): a method row must be
 * present in every run it is checked against, and one method has runs with and without a given difference (a DM and a
 * group, a reply with and without an error), so the test checks each run against the rows of its own case only.
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

/** The inner reaction message with its gMsgID blanked, for comparing everything else. */
const withoutGMsgId = (message) => {
    const m = parsed(message);
    if (!m || !Array.isArray(m.rMsg)) return m;
    return { ...m, rMsg: m.rMsg.map((r) => ({ ...r, gMsgID: "<id>" })) };
};

/** The rows the two label-v2 cases share: request 0 is zca-js's full-list update and our read of the current list. */
const LABEL_V2_CASES = ["labels-v2", "labels-v2-conflict"];
const LABEL_V2_WHY =
    "Web chat_label remote config (default update_label_version 1, @7592252): at 2 the Web edits labels through " +
    "/api/convlabel/manage/* (paths @6485240), never the full-list update; we read the list first to plan those calls";

/** @type {Array<{method: string, field: string, zca: unknown, own: unknown, why: string, when?: Function, case?: string|string[]}>} */
export default [
    // undo: the Web's key order (undoMessage @11679164).
    {
        method: "undo",
        case: ["undo-dm", "undo-211"],
        field: "paramsOrder",
        zca: ["msgId", "clientId", "cliMsgIdUndo", "toid"],
        own: ["msgId", "toid", "clientId", "cliMsgIdUndo"],
        why: "Web undoMessage (@11679164) writes {msgId, toid, clientId, cliMsgIdUndo}",
    },
    {
        method: "undo",
        case: "undo-group",
        field: "paramsOrder",
        zca: ["msgId", "clientId", "cliMsgIdUndo", "grid", "visibility", "imei"],
        own: ["msgId", "grid", "clientId", "visibility", "cliMsgIdUndo", "imei"],
        why: "Web undoMessage (@11679164) writes {msgId, grid, clientId, visibility, cliMsgIdUndo, imei}",
    },
    {
        method: "undo",
        case: "undo-211",
        field: "error.message",
        zca: "Recall window over",
        own: "The recall window for this message has passed",
        why: "spec-actions 1.3: the Web shows STR_ERR_UNDO_211 for code 211; we say it plainly and keep the code",
    },

    // deleteMessage: a DM message the peer sent lives in this account's own thread (Web delete-selected flow).
    {
        method: "deleteMessage",
        case: "delete-dm-received",
        field: "params.msgs.0.destId",
        zca: "1000000000000000002",
        own: "1234567890123456789",
        why: "spec-actions 2.3: the Web's deleteOneOneMessageV2 (@11675655) callers set destId to this account's uid when ownerId is not this account",
    },

    // addReaction: gMsgID is the id as stored, a string (Web reaction sender @9241119).
    {
        method: "addReaction",
        case: ["react-dm", "react-group", "react-unknown-icon", "react-clear"],
        field: "params.react_list.0.message",
        zca: (v) => typeof parsed(v)?.rMsg?.[0]?.gMsgID === "number",
        own: (v, { zca }) => {
            const own = parsed(v)?.rMsg?.[0]?.gMsgID;
            const theirs = parsed(zca.params.react_list[0].message)?.rMsg?.[0]?.gMsgID;
            // Only gMsgID differs, and it is the exact id zca-js rounded.
            return (
                typeof own === "string" &&
                /^\d+$/.test(own) &&
                Number(own) === theirs &&
                isDeepStrictEqual(withoutGMsgId(v), withoutGMsgId(zca.params.react_list[0].message))
            );
        },
        why: "Web sendReaction (@9241119) puts the stored message id, a string, in gMsgID; parseInt rounds it past 2^53",
    },
    {
        method: "addReaction",
        case: ["react-dm", "react-group"],
        field: "result.msgIds.*",
        zca: (v) => typeof v === "number",
        own: (v) => typeof v === "string" && /^\d+$/.test(v),
        why: "ids stay strings (design rules): msgIds held as a JSON string is opened without rounding",
    },
    {
        method: "addReaction",
        case: "react-invalid-type",
        field: "error.message",
        zca: "Invalid URL",
        own: "Thread type is invalid",
        why: "upstream zca-js 5a93a0e (after 2.2.0) refuses a type other than user/group before the request; 2.2.0 fails on an undefined URL",
    },
    {
        method: "addReaction",
        case: "react-invalid-type",
        field: "error.code",
        zca: "ERR_INVALID_URL",
        own: null,
        why: "the same refusal as upstream 5a93a0e: a ZaloApiError with no Zalo code, not Node's URL error",
    },

    // getUnreadMark: ids kept whole (Web getMarkAsUnread @11602400 parses with preParse(["id", "fromUid", "cliMsgId"])).
    {
        method: "getUnreadMark",
        case: "unread-get",
        field: "result.data.*",
        zca: (v) => typeof v === "number",
        own: (v) => typeof v === "string" && /^\d+$/.test(v),
        why: "spec-actions 5.3: the Web quotes id/fromUid/cliMsgId before parsing, so a 19-digit id keeps every digit",
    },

    // removeUnreadMark: the Web's fixed key order inside `param` (removeMarkAsUnread @11602868).
    {
        method: "removeUnreadMark",
        case: "unread-remove-dm",
        field: "params.param",
        zca: (v) =>
            isDeepStrictEqual(Object.keys(parsed(v) ?? {}), [
                "convsUser",
                "convsGroup",
                "convsUserData",
                "convsGroupData",
            ]),
        own: (v, { zca }) =>
            isDeepStrictEqual(Object.keys(parsed(v) ?? {}), [
                "convsGroup",
                "convsUser",
                "convsGroupData",
                "convsUserData",
            ]) && isDeepStrictEqual(parsed(v), parsed(zca.params.param)),
        why: "Web removeMarkAsUnread (@11602868) always writes {convsGroup, convsUser, convsGroupData, convsUserData}",
    },

    // getPinConversations: 212 is "nothing pinned" (Web getPinnedConversations, spec-actions 7.3).
    {
        method: "getPinConversations",
        case: "pins-212",
        field: "error",
        zca: { message: "No pinned conversation", code: 212 },
        own: null,
        why: "spec-actions 7.3: the Web reads error 212 of /api/pinconvers/list as an empty list, version 0",
    },
    {
        method: "getPinConversations",
        case: "pins-212",
        field: "result",
        zca: undefined,
        own: { conversations: [], version: 0 },
        why: "spec-actions 7.3: the Web reads error 212 of /api/pinconvers/list as an empty list, version 0",
    },

    // updateLabels, legacy flow: 230 said plainly.
    {
        method: "updateLabels",
        case: "labels-230",
        field: "error.message",
        zca: "Label version mismatch",
        own: "The label list changed since it was read (version conflict): read it again and retry",
        why: "spec-actions 10.3: on 230 the Web drops its version and re-reads (updateConversationLabel @11663306); we say so and keep the code",
    },

    // updateLabels, v2 flow: a read of the list, then per-label calls (the first request differs throughout).
    {
        method: "updateLabels",
        case: "labels-v2",
        field: "requests.length",
        zca: 1,
        own: 2,
        why: LABEL_V2_WHY,
    },
    { method: "updateLabels", case: LABEL_V2_CASES, field: "method", zca: "POST", own: "GET", why: LABEL_V2_WHY },
    {
        method: "updateLabels",
        case: LABEL_V2_CASES,
        field: "path",
        zca: "/api/convlabel/update",
        own: "/api/convlabel/get",
        why: LABEL_V2_WHY,
    },
    {
        method: "updateLabels",
        case: LABEL_V2_CASES,
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type"],
        own: ["zpw_ver", "zpw_type", "params"],
        why: LABEL_V2_WHY,
    },
    {
        method: "updateLabels",
        case: LABEL_V2_CASES,
        field: "params.labelData",
        zca: (v) => typeof v === "string",
        own: undefined,
        why: LABEL_V2_WHY,
    },
    {
        method: "updateLabels",
        case: LABEL_V2_CASES,
        field: "params.version",
        zca: (v) => typeof v === "number",
        own: undefined,
        why: LABEL_V2_WHY,
    },
    {
        method: "updateLabels",
        case: LABEL_V2_CASES,
        field: "paramsOrder",
        zca: ["labelData", "version", "imei"],
        own: ["imei"],
        why: LABEL_V2_WHY,
    },
    {
        method: "updateLabels",
        case: LABEL_V2_CASES,
        field: "headers.content-type",
        zca: "application/x-www-form-urlencoded",
        own: undefined,
        why: `${LABEL_V2_WHY}; a GET carries no content type (D2)`,
    },
    { method: "updateLabels", case: LABEL_V2_CASES, field: "form", zca: {}, own: null, why: LABEL_V2_WHY },
    { method: "updateLabels", case: LABEL_V2_CASES, field: "formOrder", zca: ["params"], own: null, why: LABEL_V2_WHY },
    {
        method: "updateLabels",
        case: "labels-v2-conflict",
        field: "error.message",
        zca: "Label version mismatch",
        own: "The label list changed since it was read (version conflict): read it again and retry",
        why: `${LABEL_V2_WHY}; the manage calls carry no version, so the conflict is found against the list just read (code 230 kept)`,
    },
];
