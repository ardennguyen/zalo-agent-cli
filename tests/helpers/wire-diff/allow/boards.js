/**
 * Intended differences between zca-js and our engine for the boards area: one row per difference, each also recorded
 * in golden/boards.js. Owned by package BRD; no other package edits this file. Row shape and matching rules:
 * tests/helpers/wire-diff/compare.js. Every row says why, naming the Web method (and bundle offset) it follows.
 *
 * Example: `{ method: "getAllGroups", field: "service", zca: "group_poll", own: "group", why: "Web getGroupListV4" }`
 *
 * Each row also names the test case(s) of tests/unit/wire-boards.test.js it is about (`case`): a method row must be
 * present in every run it is checked against, and one method has runs with and without a given difference (page 1
 * and page 2, a DM and a group), so the test checks each run against the rows of its own case only.
 *
 * Offsets are in Zalo Web 26.11.10's `1.c72c0957b455ab70b73c.js` (agent/work/zalo-web-capture-2026-11-06/bundles/).
 */
import { isDeepStrictEqual } from "node:util";

/** The cases whose requests go to the poll host (every poll call, except the one run without `group_poll`). */
const POLL_CASES = [
    "poll-create",
    "poll-detail",
    "poll-vote",
    "poll-vote-scalar",
    "poll-lock",
    "poll-lock-empty",
    "poll-lock-no-data",
    "poll-lock-166",
    "poll-share",
    "poll-add-options-explicit",
    "poll-add-options-keep",
];

/** True for a whole-number JS number: what a plain JSON.parse makes of a bare id. */
const isNumber = (v) => typeof v === "number" && Number.isInteger(v);

/** True for a string of digits: an id kept whole. */
const isDigits = (v) => typeof v === "string" && /^\d+$/.test(v);

/** The poll cases whose reply carries the creator and a voter as bare 19-digit numbers, per method. */
const POLL_BIG_ID_CASES = {
    createPoll: ["poll-create"],
    getPollDetail: ["poll-detail"],
    votePoll: ["poll-vote", "poll-vote-scalar"],
    addPollOptions: ["poll-add-options-explicit", "poll-add-options-keep"],
};

const POLL_ID_WHY =
    "Web _preParsePollData (@11279239) quotes creator and voters before JSON.parse: a 19-digit uid keeps its digits";

/** The two rows of a poll reply's big ids, for one method. */
const pollIdRows = (method) =>
    ["result.creator", "result.options.0.voters.0"].map((field) => ({
        method,
        case: POLL_BIG_ID_CASES[method],
        field,
        zca: isNumber,
        own: isDigits,
        why: POLL_ID_WHY,
    }));

/** A lockPoll answer with no data: zca-js fails to parse it, the Web (and we) take it as done. */
const lockNoDataRows = (name) => [
    {
        method: "lockPoll",
        case: name,
        field: "result",
        zca: undefined,
        own: null,
        why: "Web lockPoll (@11654791) reads only the outer error_code of /api/poll/end: a success with no data is done",
    },
    {
        method: "lockPoll",
        case: name,
        field: "error",
        zca: { message: "Failed to parse response data", code: null },
        own: null,
        why: "Web lockPoll (@11654791) reads only the outer error_code of /api/poll/end: a success with no data is done",
    },
];

const POLL_HOST_WHY =
    "Web getGroupPollDomain() (@13655956) for every poll call (createPoll @11653486 .. lockPoll @11654791); the " +
    "service map's group_poll, falling back to group only when it has none (spec-boards 0)";

/** A JSON string's value, or undefined when it is not one. */
const parsed = (v) => {
    try {
        return JSON.parse(v);
    } catch {
        return undefined;
    }
};

/** The keys of the Web's DM reminder builder (@3292729), on a create and on an edit. */
const DM_CREATE_KEYS = [
    "toUid",
    "creatorUid",
    "type",
    "color",
    "emoji",
    "startTime",
    "duration",
    "params",
    "needPin",
    "repeat",
    "src",
];
const DM_UPDATE_KEYS = [
    "toUid",
    "creatorUid",
    "type",
    "color",
    "emoji",
    "startTime",
    "duration",
    "params",
    "needPin",
    "repeat",
    "reminderId",
];

/** zca-js's DM reminder `objectData` keys. */
const ZCA_DM_CREATE_KEYS = [
    "toUid",
    "type",
    "color",
    "emoji",
    "startTime",
    "duration",
    "params",
    "needPin",
    "repeat",
    "creatorUid",
    "src",
];
const ZCA_DM_UPDATE_KEYS = [
    "toUid",
    "type",
    "color",
    "emoji",
    "startTime",
    "duration",
    "params",
    "needPin",
    "reminderId",
    "repeat",
];

/** The objectData of one side of a request, parsed. */
const objectDataOf = (req) => parsed(req?.params?.objectData);

/** @type {Array<{method: string, field: string, zca: unknown, own: unknown, why: string, when?: Function, case?: string|string[]}>} */
export default [
    // ── board list ─────────────────────────────────────────────────────
    {
        method: "getListBoard",
        case: "board-list-page2",
        field: "params.last_id",
        zca: 0,
        own: 5,
        why: "Web board manager (@1578806) pages with a cursor: last_id is the id of the previous page's last item",
    },
    {
        method: "getListBoard",
        case: "board-list-page2",
        field: "params.last_type",
        zca: 0,
        own: 3,
        why: "Web board manager (@1578806): last_type is the board type of the previous page's last item (3 = poll)",
    },
    {
        method: "getListBoard",
        case: "board-list-g",
        field: "params.group_id",
        zca: (v) => typeof v === "string" && /^g\d+$/.test(v),
        own: (v, { zca }) => v === zca.params.group_id.slice(1),
        why: "Web strips the conversation prefix g before a board call (getListPinTopics @11657230, the same rule)",
    },
    {
        method: "getListBoard",
        case: "board-list-string",
        field: "result",
        zca: undefined,
        own: (v) => Array.isArray(v?.items) && v.items.every((i) => i.boardType === 1 && typeof i.data === "object"),
        why: "Web reads a JSON-string reply of a bare array as a list of notes (@1577470); zca-js crashes on it",
    },
    {
        method: "getListBoard",
        case: "board-list-string",
        field: "error",
        zca: (v) => /forEach/.test(v?.message ?? ""),
        own: null,
        why: "Web reads a JSON-string reply of a bare array as a list of notes (@1577470); zca-js crashes on it",
    },

    // ── polls ──────────────────────────────────────────────────────────
    { method: "createPoll", case: POLL_CASES, field: "service", zca: "group", own: "group_poll", why: POLL_HOST_WHY },
    {
        method: "getPollDetail",
        case: POLL_CASES,
        field: "service",
        zca: "group",
        own: "group_poll",
        why: POLL_HOST_WHY,
    },
    { method: "votePoll", case: POLL_CASES, field: "service", zca: "group", own: "group_poll", why: POLL_HOST_WHY },
    { method: "lockPoll", case: POLL_CASES, field: "service", zca: "group", own: "group_poll", why: POLL_HOST_WHY },
    { method: "sharePoll", case: POLL_CASES, field: "service", zca: "group", own: "group_poll", why: POLL_HOST_WHY },
    {
        method: "addPollOptions",
        case: POLL_CASES,
        field: "service",
        zca: "group",
        own: "group_poll",
        why: POLL_HOST_WHY,
    },
    ...pollIdRows("createPoll"),
    ...pollIdRows("getPollDetail"),
    ...pollIdRows("votePoll"),
    ...pollIdRows("addPollOptions"),
    {
        method: "getPollDetail",
        case: "poll-detail",
        field: "method",
        zca: "POST",
        own: "GET",
        why: "Web getPollDetail (@11653790) is a GET with params in the query",
    },
    {
        method: "getPollDetail",
        case: "poll-detail",
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type"],
        own: ["zpw_ver", "zpw_type", "params"],
        why: "Web getPollDetail (@11653790) is a GET: params go in the query, after the common params",
    },
    {
        method: "getPollDetail",
        case: "poll-detail",
        field: "headers.content-type",
        zca: "application/x-www-form-urlencoded",
        own: undefined,
        why: "Web getPollDetail (@11653790) is a GET, which has no body and no content type",
    },
    {
        method: "getPollDetail",
        case: "poll-detail",
        field: "form",
        zca: {},
        own: null,
        why: "Web getPollDetail (@11653790) is a GET, with no form body",
    },
    {
        method: "getPollDetail",
        case: "poll-detail",
        field: "formOrder",
        zca: ["params"],
        own: null,
        why: "Web getPollDetail (@11653790) is a GET, with no form body",
    },
    ...lockNoDataRows("poll-lock-empty"),
    ...lockNoDataRows("poll-lock-no-data"),
    {
        method: "addPollOptions",
        case: "poll-add-options-keep",
        field: "params.voted_option_ids",
        zca: [],
        own: [1],
        why:
            "Web vote dialog (getCheckedIdsList @2435416, addNewOptionPoll @2428960) sends the options the account " +
            "keeps selected: the list is the whole selection after the call, so an empty one cleared the votes",
    },

    // ── reminders ──────────────────────────────────────────────────────
    {
        method: "createReminder",
        case: ["reminder-create-dm", "reminder-create-dm-default-time"],
        field: "params.objectData",
        zca: (v) => {
            const o = parsed(v);
            return isDeepStrictEqual(Object.keys(o ?? {}), ZCA_DM_CREATE_KEYS) && o.color === -16245706;
        },
        own: (v, { zca }) => {
            const o = parsed(v);
            const z = objectDataOf(zca);
            return (
                isDeepStrictEqual(Object.keys(o ?? {}), DM_CREATE_KEYS) &&
                o.color === -16777216 &&
                isDeepStrictEqual({ ...o, color: 0 }, { ...z, color: 0 })
            );
        },
        why:
            "Web reminder builder (@3292729): creatorUid second, colour -16777216 (the reminder default @2604437); " +
            "every other value the same",
    },
    {
        method: "createReminder",
        case: "reminder-create-group",
        field: "params.color",
        zca: -16245706,
        own: -16777216,
        why: "Web reminder default colour -16777216 (@2604437, createGroupTopicV2Revamp @11659377)",
    },
    {
        method: "createReminder",
        case: "reminder-create-group",
        field: "result.params",
        zca: (v) => typeof v === "string",
        own: (v, { zca }) => isDeepStrictEqual(v, parsed(zca.result.params)),
        why: "the CLI reads params.title of a topic; a JSON-string params is opened, as zca-js already did for notes",
    },
    {
        method: "createReminder",
        case: "reminder-create-group",
        field: "result.id",
        zca: isNumber,
        own: isDigits,
        why: "Web reminder id keys (@2604923: topicId, reminderId, id, eventId) are quoted before JSON.parse",
    },
    {
        method: "createReminder",
        case: ["reminder-create-dm", "reminder-create-dm-default-time"],
        field: "result.reminderId",
        zca: isNumber,
        own: isDigits,
        why: "Web reminder id keys (@2604923: topicId, reminderId, id, eventId) are quoted before JSON.parse",
    },
    {
        method: "editReminder",
        case: "reminder-edit-group",
        field: "params.startTime",
        zca: (v, { zca }) => v === zca.params.startTime && isNumber(v),
        own: 1700000600000,
        why: "Web edits a loaded reminder (getDetailReminder @11687912): an unchanged time is kept, not set to now",
    },
    {
        method: "editReminder",
        case: "reminder-edit-group",
        field: "params.emoji",
        zca: "",
        own: "🎂",
        why: "Web edits a loaded reminder: an unchanged emoji is kept, not blanked (the caller's emoji, design 6.1 #12)",
    },
    {
        method: "editReminder",
        case: "reminder-edit-group",
        field: "params.repeat",
        zca: 0,
        own: 2,
        why: "Web edits a loaded reminder: an unchanged repeat is kept, not reset to none",
    },
    {
        method: "editReminder",
        case: "reminder-edit-group",
        field: "params.color",
        zca: -16777216,
        own: -65536,
        why: "Web reminder builder (@3292729) sends the loaded reminder's colour",
    },
    {
        method: "editReminder",
        case: "reminder-edit-group",
        field: "result.params",
        zca: (v) => typeof v === "string",
        own: (v, { zca }) => isDeepStrictEqual(v, parsed(zca.result.params)),
        why: "the CLI reads params.title of a topic; a JSON-string params is opened",
    },
    {
        method: "editReminder",
        case: "reminder-edit-group",
        field: "result.id",
        zca: isNumber,
        own: isDigits,
        why: "Web reminder id keys (@2604923: topicId, reminderId, id, eventId) are quoted before JSON.parse",
    },
    {
        method: "editReminder",
        case: "reminder-edit-dm",
        field: "result.reminderId",
        zca: isNumber,
        own: isDigits,
        why: "Web reminder id keys (@2604923: topicId, reminderId, id, eventId) are quoted before JSON.parse",
    },
    {
        method: "editReminder",
        case: "reminder-edit-dm",
        field: "params.objectData",
        zca: (v) => isDeepStrictEqual(Object.keys(parsed(v) ?? {}), ZCA_DM_UPDATE_KEYS),
        own: (v, { zca }) => {
            const o = parsed(v);
            const z = objectDataOf(zca);
            return (
                isDeepStrictEqual(Object.keys(o ?? {}), DM_UPDATE_KEYS) &&
                o.toUid === z.toUid &&
                o.reminderId === z.reminderId &&
                o.params.title === z.params.title &&
                // From the loaded reminder, where zca-js sent now, "", 0 and the default colour:
                o.creatorUid === "1111111111111111200" &&
                o.startTime === 1700000900000 &&
                o.emoji === "🎂" &&
                o.repeat === 1 &&
                o.color === -65536
            );
        },
        why:
            "Web updateOneOneGroupTopic via its reminder builder (@3292729): creatorUid second, reminderId last, and " +
            "the loaded reminder's creator, time, emoji, repeat and colour for every field the caller did not change",
    },
    {
        method: "getReminder",
        case: "reminder-get",
        field: "result.params",
        zca: (v) => typeof v === "string",
        own: (v, { zca }) => isDeepStrictEqual(v, parsed(zca.result.params)),
        why: "the CLI reads params.title of a reminder (reminder.js); a JSON-string params is opened (spec-boards 13)",
    },
    {
        method: "getReminder",
        case: "reminder-get",
        field: "result.id",
        zca: isNumber,
        own: isDigits,
        why: "Web reminder id keys (@2604923: topicId, reminderId, id, eventId) are quoted before JSON.parse",
    },
    {
        method: "getListReminder",
        case: "reminder-list-dm",
        field: "result.0.reminderId",
        zca: isNumber,
        own: isDigits,
        why: "Web reminder id keys (@2604923) are quoted before JSON.parse",
    },
    {
        method: "getListReminder",
        case: "reminder-list-dm",
        field: "result.1.params",
        zca: (v) => typeof v === "string",
        own: (v) => typeof v === "object" && typeof v.title === "string",
        why: "the CLI reads params.title of each reminder; a JSON-string params is opened (spec-boards 14)",
    },
    {
        method: "getListReminder",
        case: ["reminder-list-group", "reminder-list-group-page2"],
        field: "result",
        zca: (v) => Array.isArray(v?.items),
        own: (v, { zca }) =>
            isDeepStrictEqual(
                v,
                zca.result.items
                    .filter((i) => i.boardType === 1 && i.data.startTime > 0)
                    .map((i) => ({ ...i.data, id: String(i.data.id), params: parsed(i.data.params) })),
            ),
        why:
            "Web getListBoardGroup reader (@1576920): the reminders are the topic items with startTime > 0, their " +
            "data unwrapped; ids quoted (@2604923) and params opened",
    },
    {
        method: "getListReminder",
        case: "reminder-list-group-page2",
        field: "params.objectData",
        zca: (v) => parsed(v)?.last_id === 0,
        own: (v, { zca }) => isDeepStrictEqual(parsed(v), { ...objectDataOf(zca), last_id: 8 }),
        why: "Web reminder pager (@1578806): page 2 and later carry last_id, the id of the previous page's last reminder",
    },
    {
        method: "getReminderResponses",
        case: "reminder-responses",
        field: "result.acceptMember.0",
        zca: isNumber,
        own: isDigits,
        why: "ids stay strings: the uid lists of the responses are read losslessly, as the Web's reminder ids are",
    },
];
