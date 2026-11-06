/**
 * The boards area on the wire (design 3.1 and 3.3, package BRD): notes, the group board list, polls and reminders,
 * and `listOneOneBoard`, src/zalo/api/boards.js on one logged-in fake.
 *
 * Each case has two parts: (1) our record against its reviewed golden record; (2) the error answers. The Web
 * behavior is also asserted outright, so a reader sees it here and not only in the golden file.
 *
 * Two calls make a read first (addPollOptions without votes, editReminder): those cases assert the read on its own.
 *
 * Every id here is fake (tests/unit/no-real-ids.test.js). Bare 19-digit numbers in a reply are written with
 * `JSON.rawJSON`, so the fake serves them as the server would: unquoted.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { getBoardItems, initDb } from "../../src/core/db.js";
import { listOneOneBoard as reExported, syncBoards } from "../../src/core/sync-v2/board.js";
import { FAKE, T0, expectGolden, openWire } from "../helpers/wire-diff/index.js";
import { boardMethods, boardCursor, boardPage, groupReminderPage, listOneOneBoard } from "../../src/zalo/api/boards.js";

const AREA = "boards";
const GROUP = "2000000000000000003";
const PEER = "1000000000000000002";
const OWN = FAKE.ownId;
/** A uid past 2^53: a plain JSON.parse rounds it. */
const BIG_UID = "1111111111111111200";
/** A bare JSON integer of {@link BIG_UID}, as the server sends a uid. */
const BIG_RAW = JSON.rawJSON(BIG_UID);

/** The answers every method is run against for part 2, and what each must throw. */
const ERROR_ANSWERS = [
    {
        label: "an outer error",
        error: { outer: { error_code: 102, error_message: "outer failure" } },
        expected: { message: "outer failure", code: 102 },
    },
    {
        label: "an inner error",
        error: { inner: { error_code: 114, error_message: "inner failure" } },
        expected: { message: "inner failure", code: 114 },
    },
    { label: "HTTP 500", error: { status: 500 }, expected: { message: "HTTP 500", code: null } },
    {
        label: "an undecryptable data",
        error: { undecryptable: true },
        expected: { message: "Failed to parse response data", code: null },
    },
];

/** A note as the server answers a create or an edit. */
const NOTE_REPLY = {
    id: 41,
    type: 0,
    color: -16777216,
    emoji: "",
    startTime: -1,
    duration: -1,
    params: '{"title":"Standup notes"}',
    creatorId: OWN,
    editorId: OWN,
    createTime: T0,
    editTime: T0,
    repeat: 0,
};

/**
 * A poll as the server answers: the creator and a voter as bare 19-digit numbers. A function, not a constant: a
 * `JSON.rawJSON` value cannot be structured-cloned.
 *
 * @returns {object}
 */
const pollReply = () => ({
    poll_id: 5,
    question: "Lunch?",
    options: [
        { option_id: 1, content: "Pho", votes: 1, voted: true, voters: [BIG_RAW] },
        { option_id: 2, content: "Com", votes: 0, voted: false, voters: [] },
    ],
    creator: BIG_RAW,
    joined: true,
    closed: false,
    allow_multi_choices: false,
    allow_add_new_option: true,
    is_anonymous: false,
    poll_type: 0,
    created_time: T0,
    updated_time: T0,
    expired_time: 0,
    is_hide_vote_preview: false,
    num_vote: 1,
});

describe("wire: boards (src/zalo/api/boards.js)", () => {
    let wire;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        wire = await openWire();
        // A cookie for every fake host, so the Cookie header is recorded with a value.
        wire.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
    });
    after(() => wire?.close());

    /**
     * Run one case and check it against its golden record.
     *
     * @param {string} name - the case (golden key)
     * @param {string} method
     * @param {unknown[]} args
     * @param {object} fixture
     * @returns {Promise<object>} the record
     */
    async function check(name, method, args, fixture) {
        const rec = await wire.run(method, args, fixture);
        await expectGolden(AREA, name, rec.own);
        return rec;
    }

    describe("notes", () => {
        it("createNote: POST {group_board}/api/board/topic/createv2, src before imei, params opened", async () => {
            const rec = await check("note-create", "createNote", [{ title: "Standup notes", pinAct: true }, GROUP], {
                reply: NOTE_REPLY,
            });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.service, "group_board");
            assert.equal(req.path, "/api/board/topic/createv2");
            assert.deepEqual(req.paramsOrder, [
                "grid",
                "type",
                "color",
                "emoji",
                "startTime",
                "duration",
                "params",
                "repeat",
                "src",
                "imei",
                "pinAct",
            ]);
            assert.equal(req.params.pinAct, 1);
            assert.equal(req.params.color, -16777216);
            assert.equal(req.params.params, '{"title":"Standup notes"}');
            assert.deepEqual(rec.own.result.params, { title: "Standup notes" });
        });

        it("createNote unpinned sends pinAct 0", async () => {
            const rec = await check("note-create-unpinned", "createNote", [{ title: "Plain" }, GROUP], {
                reply: NOTE_REPLY,
            });
            assert.equal(rec.own.requests[0].params.pinAct, 0);
        });

        it("editNote: POST updatev2 with the topic id; pinAct false leaves the pin (2), never unpins", async () => {
            const rec = await check(
                "note-edit",
                "editNote",
                [{ title: "Renamed", topicId: 41, pinAct: false }, GROUP],
                {
                    reply: NOTE_REPLY,
                },
            );
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/board/topic/updatev2");
            assert.equal(req.params.topicId, 41);
            assert.equal(req.params.pinAct, 2);
            assert.deepEqual(rec.own.result.params, { title: "Standup notes" });
        });
    });

    describe("getListBoard", () => {
        const ITEMS = [
            { boardType: 1, data: { ...NOTE_REPLY } },
            {
                boardType: 2,
                data: { id: 42, params: '{"msg_type":"webchat","title":"pinned"}', creatorId: OWN },
            },
            { boardType: 3, data: { ...pollReply(), creator: OWN, options: [] } },
        ];

        it("page 1: GET {group_board}/api/board/list with a zero cursor; params opened except a poll's", async () => {
            const rec = await check("board-list", "getListBoard", [{ page: 1, count: 3 }, GROUP], {
                reply: { items: structuredClone(ITEMS), count: 3 },
            });
            const [req] = rec.own.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.path, "/api/board/list");
            assert.deepEqual(req.params, {
                group_id: GROUP,
                board_type: 0,
                page: 1,
                count: 3,
                last_id: 0,
                last_type: 0,
                imei: FAKE.imei,
            });
            assert.deepEqual(rec.own.result.items[0].data.params, { title: "Standup notes" });
            assert.deepEqual(rec.own.result.items[1].data.params, { msg_type: "webchat", title: "pinned" });
            assert.equal(rec.own.result.count, 3, "the reply's other keys are kept");
        });

        it("page 2: the cursor of the page before goes out (the previous engine always sent 0/0)", async () => {
            // boardCursor reads the last item with a positive id: the poll, by its poll_id.
            const cursor = boardCursor(ITEMS);
            assert.deepEqual(cursor, { lastId: 5, lastType: 3 });
            const rec = await check("board-list-page2", "getListBoard", [{ page: 2, count: 3, ...cursor }, GROUP], {
                reply: { items: [] },
            });
            assert.equal(rec.own.requests[0].params.last_id, 5);
            assert.equal(rec.own.requests[0].params.last_type, 3);
        });

        it("a g-prefixed group id goes out bare", async () => {
            const rec = await check("board-list-g", "getListBoard", [{}, `g${GROUP}`], { reply: { items: [] } });
            assert.equal(rec.own.requests[0].params.group_id, GROUP);
            assert.equal(rec.own.requests[0].params.page, 1, "default page");
            assert.equal(rec.own.requests[0].params.count, 20, "default count: the Web's page size");
        });

        it("a reply that is a JSON string of a bare array is a list of notes (the previous engine crashed on it)", async () => {
            const rec = await check("board-list-string", "getListBoard", [{ page: 1, count: 20 }, GROUP], {
                reply: JSON.stringify([{ id: 43, params: '{"title":"From a string"}' }]),
            });
            assert.deepEqual(rec.own.result, {
                items: [{ boardType: 1, data: { id: 43, params: { title: "From a string" } } }],
            });
        });
    });

    describe("polls", () => {
        it("createPoll: POST {group_poll}/api/poll/create in the Web's order; creator and voters stay strings", async () => {
            const options = {
                question: "Lunch?",
                options: ["Pho", "Com"],
                expiredTime: 0,
                allowMultiChoices: true,
                allowAddNewOption: true,
                hideVotePreview: false,
                isAnonymous: false,
            };
            const rec = await check("poll-create", "createPoll", [options, GROUP], { reply: pollReply() });
            const [req] = rec.own.requests;
            assert.equal(req.service, "group_poll");
            assert.equal(req.method, "POST");
            assert.deepEqual(req.paramsOrder, [
                "group_id",
                "question",
                "options",
                "expired_time",
                "pinAct",
                "allow_multi_choices",
                "allow_add_new_option",
                "is_hide_vote_preview",
                "is_anonymous",
                "poll_type",
                "src",
                "imei",
            ]);
            assert.equal(req.params.pinAct, false);
            // Red if the reply were parsed plainly: 1111111111111111200 rounds to 1111111111111111168.
            assert.equal(rec.own.result.creator, BIG_UID);
            assert.deepEqual(rec.own.result.options[0].voters, [BIG_UID]);
        });

        it("getPollDetail: GET with params in the query (the previous engine POSTed it)", async () => {
            const rec = await check("poll-detail", "getPollDetail", [5], { reply: pollReply() });
            const [req] = rec.own.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.service, "group_poll");
            assert.deepEqual(req.params, { poll_id: 5, imei: FAKE.imei });
        });

        it("getPollDetail without an id is refused before any request, as before", async () => {
            const rec = await check("poll-detail-missing", "getPollDetail", [0], { reply: {} });
            assert.equal(rec.own.requests.length, 0);
            assert.deepEqual(rec.own.error, { message: "Missing poll id", code: null });
        });

        it("votePoll: GET {group_poll}/api/poll/vote with the whole selection", async () => {
            const rec = await check("poll-vote", "votePoll", [5, [1, 2]], { reply: pollReply() });
            assert.deepEqual(rec.own.requests[0].params, { poll_id: 5, option_ids: [1, 2], imei: FAKE.imei });
        });

        it("votePoll with one id sends it as a list", async () => {
            const rec = await check("poll-vote-scalar", "votePoll", [5, 2], { reply: pollReply() });
            assert.deepEqual(rec.own.requests[0].params.option_ids, [2]);
        });

        it("lockPoll: POST {group_poll}/api/poll/end", async () => {
            const rec = await check("poll-lock", "lockPoll", [5], { reply: null });
            assert.equal(rec.own.requests[0].path, "/api/poll/end");
            assert.equal(rec.own.result, null);
        });

        it("lockPoll: a success with empty data is done (the previous engine failed to parse it)", async () => {
            const rec = await check("poll-lock-empty", "lockPoll", [5], { error: { plain: "" } });
            assert.equal(rec.own.error, null);
            assert.equal(rec.own.result, null);
        });

        it("lockPoll: a success with no data key at all is done too (the previous engine failed to parse it)", async () => {
            const rec = await check("poll-lock-no-data", "lockPoll", [5], {
                error: { text: JSON.stringify({ error_code: 0, error_message: "" }), status: 200 },
            });
            assert.equal(rec.own.error, null);
            assert.equal(rec.own.result, null);
        });

        it("lockPoll: error 166 (already closed) keeps its code", async () => {
            const rec = await check("poll-lock-166", "lockPoll", [5], {
                error: { inner: { error_code: 166, error_message: "Poll is closed" } },
            });
            assert.deepEqual(rec.own.error, { message: "Poll is closed", code: 166 });
        });

        it("sharePoll: POST {group_poll}/api/poll/share", async () => {
            const rec = await check("poll-share", "sharePoll", [5], { reply: null });
            assert.deepEqual(rec.own.requests[0].params, { poll_id: 5, imei: FAKE.imei });
        });

        it("addPollOptions with the votes named: one GET, no imei, as before but on the poll host", async () => {
            const payload = { pollId: 5, options: [{ content: "Bun", voted: true }], votedOptionIds: [2] };
            const rec = await check("poll-add-options-explicit", "addPollOptions", [payload], { reply: pollReply() });
            assert.equal(rec.own.requests.length, 1);
            assert.deepEqual(rec.own.requests[0].params, {
                poll_id: 5,
                new_options: '[{"content":"Bun","voted":true}]',
                voted_option_ids: [2],
            });
        });

        it("addPollOptions without votes reads the poll and keeps the caller's current votes", async () => {
            // The fixture poll has option 1 voted by this account (voted: true): red if the request carried [].
            const payload = { pollId: 5, options: [{ content: "Bun", voted: false }], votedOptionIds: [] };
            const rec = await check("poll-add-options-keep", "addPollOptions", [payload], {
                replies: { "/api/poll/detail": { data: pollReply() } },
                reply: pollReply(),
            });
            const [read, add] = rec.own.requests;
            assert.equal(read.path, "/api/poll/detail");
            assert.equal(read.method, "GET");
            assert.equal(add.path, "/api/poll/option/add");
            assert.deepEqual(add.params.voted_option_ids, [1]);
        });

        it("addPollOptions finds this account's votes by its uid among the voters too", async () => {
            const poll = pollReply();
            poll.options[0].voted = false;
            poll.options[1].voters = [OWN];
            const rec = await wire.run("addPollOptions", [{ pollId: 5, options: [{ content: "Bun" }] }], {
                replies: { "/api/poll/detail": { data: poll } },
                reply: pollReply(),
            });
            assert.deepEqual(rec.own.requests[1].params.voted_option_ids, [2]);
        });
    });

    describe("polls without a group_poll host", () => {
        // A login whose service map has no group_poll host: a missing key fails only the call that needs it.
        let bare;
        before(async () => {
            wire.close();
            bare = await openWire({ fake: { omit: ["group_poll"] } });
        });
        after(async () => {
            bare?.close();
            wire = await openWire();
            wire.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
        });

        it("createPoll falls back to the group host, the Web's own fallback", async () => {
            const rec = await bare.run("createPoll", [{ question: "Q", options: ["a", "b"] }, GROUP], {
                reply: { ...pollReply(), creator: OWN, options: [] },
            });
            assert.equal(rec.own.error, null);
            assert.equal(rec.own.requests[0].service, "group");
            assert.equal(rec.own.requests[0].path, "/api/poll/create");
            await expectGolden(AREA, "poll-create-fallback", rec.own);
        });
    });

    describe("reminders", () => {
        it("createReminder DM: oneone/create, objectData in the Web's order and colour, the caller's emoji", async () => {
            const options = { title: "Call mom", emoji: "📞", startTime: T0 + 3_600_000, repeat: 1 };
            const rec = await check("reminder-create-dm", "createReminder", [options, PEER, 0], {
                reply: { reminderId: 9, creatorUid: OWN, toUid: PEER, startTime: T0 + 3_600_000 },
            });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/board/oneone/create");
            assert.deepEqual(req.paramsOrder, ["objectData", "imei"]);
            assert.equal(
                req.params.objectData,
                JSON.stringify({
                    toUid: PEER,
                    creatorUid: OWN,
                    type: 0,
                    color: -16777216,
                    emoji: "📞",
                    startTime: T0 + 3_600_000,
                    duration: -1,
                    params: { title: "Call mom" },
                    needPin: false,
                    repeat: 1,
                    src: 1,
                }),
            );
            assert.equal(rec.own.result.reminderId, "9");
        });

        it("createReminder DM without a time starts now (the session clock), with the ⏰ emoji", async () => {
            const rec = await check("reminder-create-dm-default-time", "createReminder", [{ title: "Now" }, PEER], {
                reply: { reminderId: 10 },
            });
            const o = JSON.parse(rec.own.requests[0].params.objectData);
            assert.equal(o.startTime, T0);
            assert.equal(o.emoji, "⏰");
            assert.equal(o.repeat, 0);
        });

        it("createReminder group: createv2 with the Web's colour, src before imei, pinAct 0", async () => {
            const options = { title: "Retro", emoji: "⏰", startTime: T0 + 600_000, repeat: 2 };
            const rec = await check("reminder-create-group", "createReminder", [options, GROUP, 1], {
                reply: { ...NOTE_REPLY, id: 44, startTime: T0 + 600_000, params: '{"title":"Retro"}' },
            });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/board/topic/createv2");
            assert.deepEqual(req.params, {
                grid: GROUP,
                type: 0,
                color: -16777216,
                emoji: "⏰",
                startTime: T0 + 600_000,
                duration: -1,
                params: '{"title":"Retro"}',
                repeat: 2,
                src: 1,
                imei: FAKE.imei,
                pinAct: 0,
            });
            assert.equal(rec.own.result.id, "44");
            assert.deepEqual(rec.own.result.params, { title: "Retro" });
        });

        it("a thread type other than 0 or 1 is refused before any request", async () => {
            for (const method of ["createReminder", "editReminder", "removeReminder", "getListReminder"]) {
                const args =
                    method === "removeReminder"
                        ? [9, PEER, 2]
                        : method === "getListReminder"
                          ? [{}, PEER, 2]
                          : [{ title: "x", topicId: 9 }, PEER, 2];
                const rec = await wire.run(method, args, { reply: {} });
                assert.deepEqual(rec.own.error, { message: "Thread type is invalid", code: null }, method);
                assert.equal(rec.own.requests.length, 0, method);
            }
        });

        it("editReminder group: loads the reminder, keeps every field not given (the previous engine sent now, '', 0)", async () => {
            const current = {
                id: 44,
                type: 0,
                color: -65536,
                emoji: "🎂",
                startTime: 1700000600000,
                duration: -1,
                params: '{"title":"Retro"}',
                repeat: 2,
                creatorId: OWN,
            };
            const rec = await check(
                "reminder-edit-group",
                "editReminder",
                [{ title: "Retro v2", topicId: "44" }, GROUP, 1],
                {
                    replies: { "/api/board/topic/getReminder": { data: current } },
                    reply: { ...current, params: '{"title":"Retro v2"}' },
                },
            );
            const [load, update] = rec.own.requests;
            assert.equal(load.path, "/api/board/topic/getReminder");
            assert.deepEqual(load.params, { eventId: "44", imei: FAKE.imei });
            assert.equal(update.path, "/api/board/topic/updatev2");
            assert.deepEqual(update.params, {
                grid: GROUP,
                type: 0,
                color: -65536,
                emoji: "🎂",
                startTime: 1700000600000,
                duration: -1,
                params: '{"title":"Retro v2"}',
                topicId: "44",
                repeat: 2,
                imei: FAKE.imei,
                pinAct: 2,
            });
        });

        it("editReminder group: a field given wins over the loaded one", async () => {
            const current = { id: 44, color: -65536, emoji: "🎂", startTime: T0, params: { title: "Old" }, repeat: 2 };
            const rec = await wire.run("editReminder", [{ topicId: 44, startTime: T0 + 5, repeat: 0 }, GROUP, 1], {
                replies: { "/api/board/topic/getReminder": { data: current } },
                reply: current,
            });
            const p = rec.own.requests[1].params;
            assert.equal(p.startTime, T0 + 5);
            assert.equal(p.repeat, 0);
            assert.equal(p.params, '{"title":"Old"}', "the title is kept when none is given");
        });

        it("editReminder DM: finds the reminder in the DM list, then oneone/update in the Web's order", async () => {
            const list = [
                { reminderId: 8, creatorUid: OWN, toUid: PEER, startTime: T0, params: { title: "Other" } },
                {
                    reminderId: 9,
                    creatorUid: BIG_UID,
                    toUid: PEER,
                    color: -65536,
                    emoji: "🎂",
                    startTime: 1700000900000,
                    repeat: 1,
                    params: { title: "Call mom" },
                },
            ];
            const rec = await check("reminder-edit-dm", "editReminder", [{ title: "Call dad", topicId: 9 }, PEER, 0], {
                replies: { "/api/board/oneone/list": { data: JSON.stringify(list) } },
                reply: { reminderId: 9 },
            });
            const [load, update] = rec.own.requests;
            assert.equal(load.path, "/api/board/oneone/list");
            assert.deepEqual(JSON.parse(load.params.objectData), {
                uid: PEER,
                board_type: 1,
                page: 1,
                count: 20,
                last_id: 0,
                last_type: 0,
            });
            assert.equal(update.path, "/api/board/oneone/update");
            assert.deepEqual(update.paramsOrder, ["objectData"], "no imei on a DM update");
            assert.equal(
                update.params.objectData,
                JSON.stringify({
                    toUid: PEER,
                    creatorUid: BIG_UID,
                    type: 0,
                    color: -65536,
                    emoji: "🎂",
                    startTime: 1700000900000,
                    duration: -1,
                    params: { title: "Call dad" },
                    needPin: false,
                    repeat: 1,
                    reminderId: 9,
                }),
            );
        });

        it("editReminder DM: a reminder not in the list is refused, and nothing is written", async () => {
            const rec = await wire.run("editReminder", [{ title: "x", topicId: 77 }, PEER, 0], {
                replies: { "/api/board/oneone/list": { data: JSON.stringify([{ reminderId: 8 }]) } },
                reply: {},
            });
            assert.match(rec.own.error.message, /not found/);
            assert.equal(rec.own.requests.length, 1, "only the list was read");
            await expectGolden(AREA, "reminder-edit-dm-missing", rec.own);
        });

        it("removeReminder DM: oneone/remove {uid, reminderId}, no imei", async () => {
            const rec = await check("reminder-remove-dm", "removeReminder", [9, PEER, 0], { reply: null });
            assert.deepEqual(rec.own.requests[0].params, { uid: PEER, reminderId: 9 });
            assert.equal(rec.own.requests[0].path, "/api/board/oneone/remove");
        });

        it("removeReminder group: topic/remove {grid, topicId, imei}", async () => {
            const rec = await check("reminder-remove-group", "removeReminder", ["44", GROUP, 1], { reply: null });
            assert.deepEqual(rec.own.requests[0].params, { grid: GROUP, topicId: "44", imei: FAKE.imei });
        });

        it("getReminder: GET topic/getReminder, params opened, id kept whole", async () => {
            const rec = await check("reminder-get", "getReminder", ["44"], {
                reply: {
                    id: 44,
                    params: '{"title":"Retro"}',
                    startTime: T0,
                    responseMem: { acceptMember: [], rejectMember: [], myResp: 0 },
                },
            });
            assert.equal(rec.own.requests[0].method, "GET");
            assert.deepEqual(rec.own.requests[0].params, { eventId: "44", imei: FAKE.imei });
            assert.equal(rec.own.result.id, "44");
            assert.deepEqual(rec.own.result.params, { title: "Retro" });
        });

        it("getListReminder DM: oneone/list board type 1, no imei; reminderIds kept whole, params opened", async () => {
            const list = [
                { reminderId: JSON.rawJSON("7000000000000000001"), startTime: T0, params: { title: "A" } },
                { reminderId: "12", startTime: T0, params: '{"title":"B"}' },
            ];
            const rec = await check("reminder-list-dm", "getListReminder", [{ page: 1, count: 20 }, PEER, 0], {
                reply: JSON.stringify(list),
            });
            const [req] = rec.own.requests;
            assert.deepEqual(req.paramsOrder, ["objectData"]);
            assert.equal(JSON.parse(req.params.objectData).board_type, 1);
            // Red if parsed plainly: 7000000000000000001 rounds to 7000000000000000000.
            assert.equal(rec.own.result[0].reminderId, "7000000000000000001");
            assert.deepEqual(rec.own.result[1].params, { title: "B" });
        });

        const GROUP_LIST = {
            items: [
                { boardType: 1, data: { id: 7, startTime: T0 + 1000, params: '{"title":"Reminder"}' } },
                { boardType: 1, data: { id: 8, startTime: -1, params: '{"title":"A note"}' } },
            ],
        };

        it("getListReminder group: listReminder with imei; the reminders unwrapped, a note filtered out", async () => {
            const rec = await check("reminder-list-group", "getListReminder", [{ page: 1, count: 20 }, GROUP, 1], {
                reply: JSON.stringify(GROUP_LIST),
            });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/board/listReminder");
            assert.deepEqual(req.paramsOrder, ["objectData", "imei"]);
            assert.deepEqual(rec.own.result, [{ id: "7", startTime: T0 + 1000, params: { title: "Reminder" } }]);
        });

        it("getListReminder group page 2 carries last_id", async () => {
            const rec = await check(
                "reminder-list-group-page2",
                "getListReminder",
                [{ page: 2, count: 20, lastId: 8 }, GROUP, 1],
                { reply: JSON.stringify(GROUP_LIST) },
            );
            assert.equal(JSON.parse(rec.own.requests[0].params.objectData).last_id, 8);
        });

        it("getListReminder group: a bare-array reply is read the same way", async () => {
            const rec = await wire.run("getListReminder", [{}, GROUP, 1], {
                reply: JSON.stringify(GROUP_LIST.items.map((i) => i.data)),
            });
            assert.deepEqual(rec.own.result, [{ id: "7", startTime: T0 + 1000, params: { title: "Reminder" } }]);
        });

        it("getReminderResponses: GET listResponseEvent {eventId}, no imei; uids kept whole", async () => {
            const rec = await check("reminder-responses", "getReminderResponses", ["44"], {
                reply: { acceptMember: [BIG_RAW], rejectMember: [] },
            });
            assert.deepEqual(rec.own.requests[0].params, { eventId: "44" });
            // Red if parsed plainly: the uid would come back rounded, as a number.
            assert.deepEqual(rec.own.result, { acceptMember: [BIG_UID], rejectMember: [] });
        });
    });

    describe("listOneOneBoard (ours only: the previous engine had no such call)", () => {
        it("asks /api/board/oneone/list for every kind (board type 0), no imei, and files bare reminders", async () => {
            const board = [
                { boardType: 2, data: { id: 50, params: '{"title":"pinned"}' } },
                { reminderId: 9, startTime: T0, params: { title: "Call mom" } },
            ];
            const rec = await wire.run("listOneOneBoard", [PEER, 2, 50], { reply: JSON.stringify(board) });
            const [req] = rec.own.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.service, "group_board");
            assert.equal(req.path, "/api/board/oneone/list");
            assert.deepEqual(req.paramsOrder, ["objectData"]);
            assert.equal(
                req.params.objectData,
                JSON.stringify({ uid: PEER, board_type: 0, page: 2, count: 50, last_id: 0, last_type: 0 }),
            );
            assert.deepEqual(rec.own.result, {
                items: [
                    { boardType: 2, data: { id: "50", params: { title: "pinned" } } },
                    { boardType: 1, data: { reminderId: "9", startTime: T0, params: { title: "Call mom" }, id: "9" } },
                ],
            });
            await expectGolden(AREA, "oneone-board", rec.own);
        });

        it("asks the same as the DM reminder list, apart from the board type", async () => {
            // The one endpoint serves both, so a drift between the two shows.
            const rem = await wire.run("getListReminder", [{ page: 1, count: 20 }, PEER, 0], { reply: "[]" });
            const own = await wire.run("listOneOneBoard", [PEER, 1, 20], { reply: "[]" });
            const r = JSON.parse(rem.own.requests[0].params.objectData);
            const o = JSON.parse(own.own.requests[0].params.objectData);
            assert.deepEqual(o, { ...r, board_type: 0 });
        });
    });

    describe("src/core/sync-v2/board.js on our engine", () => {
        let root;
        let db;
        before(() => {
            root = mkdtempSync(join(tmpdir(), "zalo-wire-boards-"));
            db = initDb(join(root, "zalo.sqlite"));
        });
        after(() => {
            try {
                db?.close();
            } catch {
                /* already closed */
            }
            rmSync(root, { recursive: true, force: true });
        });

        it("re-exports listOneOneBoard from the protocol layer, where it used to live", () => {
            assert.equal(reExported, listOneOneBoard);
        });

        it("a DM's board is one GET of oneone/list, board type 0, on the logged-in api; the items are stored", async () => {
            wire.fake.clearRoutes();
            wire.fake.routeAnswer("/api/board/oneone/list", (req) =>
                JSON.parse(req.params.objectData).board_type === 0
                    ? { data: JSON.stringify([{ boardType: 2, data: { id: 50, params: '{"title":"pinned"}' } }]) }
                    : { data: "[]" },
            );
            const from = wire.fake.requests.length;
            const stats = await syncBoards({ api: wire.own, threads: [{ threadId: PEER, type: "dm" }], delayMs: 0 });
            wire.fake.clearRoutes();
            assert.equal(stats.failed, 0, JSON.stringify(stats.failures));
            const boards = wire.fake.requests
                .slice(from)
                .filter((r) => r.path === "/api/board/oneone/list")
                .map((r) => JSON.parse(r.params.objectData));
            // Red if the DM board went back to asking for reminders only (board_type 1), the bug board.js documents.
            assert.deepEqual(
                boards.map((o) => o.board_type),
                [0, 1],
                "the board (type 0), then the reminders (type 1)",
            );
            assert.equal(getBoardItems(PEER).length, 1);
            assert.equal(getBoardItems(PEER)[0].title, "pinned");
        });

        it("a group's page 2 carries the cursor of page 1's last item", async () => {
            const calls = [];
            const page = (n) =>
                Array.from({ length: 2 }, (_, i) => ({
                    boardType: i ? 3 : 1,
                    data: i ? { poll_id: 10 * n + i, question: "q" } : { id: 10 * n, params: { title: "t" } },
                }));
            const api = {
                getListBoard: async (options) => {
                    calls.push(options);
                    return { items: calls.length === 1 ? page(1) : [] };
                },
                getListReminder: async () => [],
            };
            await syncBoards({ api, threads: [{ threadId: GROUP, type: "group" }], pageSize: 2, delayMs: 0 });
            // Red if page 2 went out with 0/0 again: the poll (type 3) with poll_id 11 ended page 1.
            assert.deepEqual(calls, [
                { page: 1, count: 2, lastId: 0, lastType: 0 },
                { page: 2, count: 2, lastId: 11, lastType: 3 },
            ]);
        });
    });

    describe("errors (part 3), every method", () => {
        const CALLS = [
            ["createNote", [{ title: "t" }, GROUP]],
            ["editNote", [{ title: "t", topicId: 41 }, GROUP]],
            ["getListBoard", [{ page: 1, count: 20 }, GROUP]],
            ["createPoll", [{ question: "q", options: ["a", "b"] }, GROUP]],
            ["getPollDetail", [5]],
            ["votePoll", [5, [1]]],
            ["lockPoll", [5]],
            ["sharePoll", [5]],
            ["addPollOptions", [{ pollId: 5, options: [{ content: "c", voted: false }], votedOptionIds: [] }]],
            ["createReminder", [{ title: "t", startTime: T0 }, PEER, 0]],
            ["createReminder", [{ title: "t", startTime: T0 }, GROUP, 1]],
            ["editReminder", [{ title: "t", topicId: 9, startTime: T0 }, PEER, 0]],
            ["editReminder", [{ title: "t", topicId: 44, startTime: T0 }, GROUP, 1]],
            ["removeReminder", [9, PEER, 0]],
            ["removeReminder", [44, GROUP, 1]],
            ["getReminder", [44]],
            ["getListReminder", [{ page: 1, count: 20 }, PEER, 0]],
            ["getListReminder", [{ page: 1, count: 20 }, GROUP, 1]],
            ["getReminderResponses", [44]],
        ];
        for (const [method, args] of CALLS) {
            it(`${method}(${args.length > 2 ? `type ${args[2]}` : "…"}): the code and message of each error`, async () => {
                for (const answer of ERROR_ANSWERS) {
                    const rec = await wire.run(method, args, { error: answer.error });
                    assert.deepEqual(rec.own.error, answer.expected, `${method}, ${answer.label}`);
                }
            });
        }

        it("listOneOneBoard: Zalo's code is kept", async () => {
            for (const answer of ERROR_ANSWERS) {
                const rec = await wire.run("listOneOneBoard", [PEER], { error: answer.error });
                assert.ok(rec.own.error, answer.label);
                const want = answer.error.outer?.error_code ?? answer.error.inner?.error_code ?? null;
                assert.equal(rec.own.error.code, want, answer.label);
            }
        });
    });

    describe("the Web's end of a list, single-choice votes, DM creators, page cursors", () => {
        /** Zalo's "no more": an error whose data is the string "[]" (the code is not one the Web reads). */
        const END = { inner: { error_code: 1, error_message: "no more items", data: "[]" } };
        /** A group's reminder page of two topics: a reminder, then a note the reader filters out. */
        const GROUP_LIST_TWO = {
            items: [
                { boardType: 1, data: { id: 7, startTime: T0 + 1000, params: '{"title":"Reminder"}' } },
                { boardType: 1, data: { id: 8, startTime: -1, params: '{"title":"A note"}' } },
            ],
        };

        it('an error whose data is "[]" is an empty page for every list call (the previous engine threw it)', async () => {
            const cases = [
                ["getListBoard", [{ page: 2, count: 20 }, GROUP], { items: [] }],
                ["getListReminder", [{ page: 2, count: 20 }, GROUP, 1], []],
                ["getListReminder", [{ page: 2, count: 20 }, PEER, 0], []],
                ["listOneOneBoard", [PEER, 2, 20], { items: [] }],
            ];
            for (const [method, args, empty] of cases) {
                const rec = await wire.run(method, args, { error: END });
                assert.equal(rec.own.error, null, `${method}: ${JSON.stringify(rec.own.error)}`);
                assert.deepEqual(rec.own.result, empty, method);
            }
            // The same code with any other data is still an error.
            const other = await wire.run("getListBoard", [{}, GROUP], {
                error: { inner: { error_code: 1, error_message: "no more items", data: "x" } },
            });
            assert.equal(other.own.error?.code, 1);
        });

        it("editReminder DM: an edit that finds the end of the list says it was not found, and writes nothing", async () => {
            const rec = await wire.run("editReminder", [{ title: "x", topicId: 77 }, PEER, 0], { error: END });
            assert.match(rec.own.error.message, /not found/);
            assert.equal(rec.own.requests.length, 1);
        });

        it("addPollOptions: voting a new option on a single-choice poll drops the old vote, as the Web's dialog does", async () => {
            // The fixture poll is single-choice with option 1 voted by this account: red if [1] went out beside the
            // new vote, which would hold two votes on a one-vote poll.
            const rec = await wire.run("addPollOptions", [{ pollId: 5, options: [{ content: "Bun", voted: true }] }], {
                replies: { "/api/poll/detail": { data: pollReply() } },
                reply: pollReply(),
            });
            assert.equal(rec.own.error, null);
            const add = rec.own.requests.at(-1);
            assert.equal(add.path, "/api/poll/option/add");
            assert.deepEqual(add.params.voted_option_ids, []);
            assert.equal(add.params.new_options, '[{"content":"Bun","voted":true}]');
        });

        it("addPollOptions: a multi-choice poll keeps the old vote beside the new one", async () => {
            const poll = pollReply();
            poll.allow_multi_choices = true;
            const rec = await wire.run("addPollOptions", [{ pollId: 5, options: [{ content: "Bun", voted: true }] }], {
                replies: { "/api/poll/detail": { data: poll } },
                reply: poll,
            });
            assert.deepEqual(rec.own.requests.at(-1).params.voted_option_ids, [1]);
        });

        it("editReminder DM: a bare 19-digit creatorUid goes back whole; none at all is this account", async () => {
            const list = [{ reminderId: 9, creatorUid: BIG_RAW, toUid: JSON.rawJSON(PEER), startTime: T0 }];
            let rec = await wire.run("editReminder", [{ title: "t", topicId: 9 }, PEER, 0], {
                replies: { "/api/board/oneone/list": { data: JSON.stringify(list) } },
                reply: { reminderId: 9 },
            });
            assert.equal(rec.own.error, null);
            // Red if the list is parsed without creatorUid in its id keys: 1111111111111111200 rounds.
            assert.equal(JSON.parse(rec.own.requests.at(-1).params.objectData).creatorUid, BIG_UID);

            rec = await wire.run("editReminder", [{ title: "t", topicId: 9 }, PEER, 0], {
                replies: { "/api/board/oneone/list": { data: JSON.stringify([{ reminderId: 9, startTime: T0 }]) } },
                reply: { reminderId: 9 },
            });
            // Red if "" goes out as the creator.
            assert.equal(JSON.parse(rec.own.requests.at(-1).params.objectData).creatorUid, OWN);
        });

        it("getListReminder DM: creatorUid and toUid come back whole", async () => {
            const list = [{ reminderId: 9, creatorUid: BIG_RAW, toUid: BIG_RAW, startTime: T0 }];
            const rec = await wire.run("getListReminder", [{}, PEER, 0], { reply: JSON.stringify(list) });
            assert.equal(rec.own.result[0].creatorUid, BIG_UID);
            assert.equal(rec.own.result[0].toUid, BIG_UID);
        });

        it("listOneOneBoard files a bare reminder under its reminderId, as the Web does, even beside an id", async () => {
            const rec = await wire.run("listOneOneBoard", [PEER], {
                reply: JSON.stringify([{ reminderId: 9, id: 3, startTime: T0 }]),
            });
            assert.deepEqual(rec.own.result.items, [
                { boardType: 1, data: { reminderId: "9", id: "9", startTime: T0 } },
            ]);
        });

        it("boardPage: page 2 goes out with the cursor of page 1's last item, on the wire", async () => {
            wire.fake.clearRoutes();
            wire.fake.routeAnswer("/api/board/list", (req) =>
                req.params.page === 1
                    ? {
                          data: {
                              items: [
                                  { boardType: 1, data: { id: 41 } },
                                  { boardType: 3, data: { poll_id: 5 } },
                              ],
                          },
                      }
                    : { data: { items: [{ boardType: 1, data: { id: 40 } }] } },
            );
            const from = wire.fake.requests.length;
            let got;
            try {
                got = await boardPage(wire.own, GROUP, 2, 2);
            } finally {
                wire.fake.clearRoutes();
            }
            const sent = wire.fake.requests
                .slice(from)
                .map((r) => [r.params.page, r.params.last_id, r.params.last_type]);
            assert.deepEqual(sent, [
                [1, 0, 0],
                [2, 5, 3],
            ]);
            assert.deepEqual(got.items, [{ boardType: 1, data: { id: 40 } }]);
        });

        it("groupReminderPage: page 2 carries the id of page 1's last topic, a filtered-out note included", async () => {
            wire.fake.clearRoutes();
            wire.fake.routeAnswer("/api/board/listReminder", (req) =>
                JSON.parse(req.params.objectData).page === 1
                    ? { data: JSON.stringify(GROUP_LIST_TWO) }
                    : { data: JSON.stringify({ items: [] }) },
            );
            const from = wire.fake.requests.length;
            try {
                assert.deepEqual(await groupReminderPage(wire.own, GROUP, 2, 2), []);
            } finally {
                wire.fake.clearRoutes();
            }
            const sent = wire.fake.requests.slice(from).map((r) => JSON.parse(r.params.objectData));
            // The Web's cursor is the last topic of the page (listByConversation), not the last reminder kept.
            assert.deepEqual(
                sent.map((o) => [o.page, o.last_id]),
                [
                    [1, 0],
                    [2, "8"],
                ],
            );
        });
    });

    it("the area defines exactly the methods this file covers", () => {
        // Red if a method was added to the area without a case here, or one covered here was removed.
        assert.deepEqual(
            Object.keys(boardMethods({})).sort(),
            [
                "addPollOptions",
                "createNote",
                "createPoll",
                "createReminder",
                "editNote",
                "editReminder",
                "getListBoard",
                "getListReminder",
                "getPollDetail",
                "getReminder",
                "getReminderResponses",
                "listOneOneBoard",
                "lockPoll",
                "removeReminder",
                "sharePoll",
                "votePoll",
            ].sort(),
        );
    });
});
