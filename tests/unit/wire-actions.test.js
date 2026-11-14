/**
 * The actions area on the wire (design 3.1 and 3.3, package ACT): undo, deleteMessage, addReaction, deleteChat, the
 * unread marks, the pinned and archived lists, and the labels, src/zalo/api/actions.js on one logged-in fake.
 *
 * Each case has two parts: (1) our record against its reviewed golden record; (2) the error answers, each checked
 * against a literal `{message, code}`. The expected behavior is also asserted outright, so a reader sees it here and not
 * only in the golden file.
 *
 * Every id here is fake (tests/unit/no-real-ids.test.js).
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { FAKE, T0, expectGolden, openWire } from "../helpers/wire-diff/index.js";
import { actionMethods, planLabelCalls } from "../../src/zalo/api/actions.js";

const AREA = "actions";
const PEER = "1000000000000000002";
const GROUP = "2000000000000000003";
const OWN = FAKE.ownId;
/** A message id past 2^53: parseInt rounds it, a string keeps it. */
const MSG_ID = "7000000000000000001";
const CLI_MSG_ID = "1700000000123";
/** A 19-digit thread id and the twin that rounds to the same double (the loss conv-state documents). */
const LOSSY = "4123456789012345678";
const TWIN = "4123456789012345679";

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

describe("wire: actions (src/zalo/api/actions.js)", () => {
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

    describe("undo", () => {
        it("DM: POST {chat}/api/message/undo in the expected key order, clientId from the session clock", async () => {
            const rec = await check("undo-dm", "undo", [{ msgId: MSG_ID, cliMsgId: CLI_MSG_ID }, PEER, 0], {
                reply: { status: 0 },
            });
            const [req] = rec.own.requests;
            assert.equal(req.service, "chat");
            assert.equal(req.path, "/api/message/undo");
            assert.deepEqual(req.params, { msgId: MSG_ID, toid: PEER, clientId: T0, cliMsgIdUndo: CLI_MSG_ID });
            assert.deepEqual(rec.own.result, { status: 0 });
        });

        it("group: POST {group}/api/group/undomsg with visibility 0 and the imei", async () => {
            const rec = await check("undo-group", "undo", [{ msgId: MSG_ID, cliMsgId: CLI_MSG_ID }, GROUP, 1], {
                reply: { status: 0 },
            });
            const [req] = rec.own.requests;
            assert.equal(req.service, "group");
            assert.equal(req.path, "/api/group/undomsg");
            assert.deepEqual(req.paramsOrder, ["msgId", "grid", "clientId", "visibility", "cliMsgIdUndo", "imei"]);
            assert.equal(req.params.visibility, 0);
            assert.equal(req.params.imei, FAKE.imei);
        });

        it("error 211 says the recall window has passed, and keeps the code", async () => {
            const rec = await check("undo-211", "undo", [{ msgId: MSG_ID, cliMsgId: CLI_MSG_ID }, PEER, 0], {
                error: { inner: { error_code: 211, error_message: "Recall window over" } },
            });
            assert.deepEqual(rec.own.error, { message: "The recall window for this message has passed", code: 211 });
        });

        it("a known group visibility goes out as given (the previous engine always sent 0)", async () => {
            const rec = await wire.run("undo", [{ msgId: MSG_ID, cliMsgId: CLI_MSG_ID, visibility: 1 }, GROUP, 1], {
                reply: {},
            });
            assert.equal(rec.own.requests[0].params.visibility, 1);
        });
    });

    describe("deleteMessage", () => {
        const target = (uidFrom, threadId, type) => ({
            data: { cliMsgId: CLI_MSG_ID, msgId: MSG_ID, uidFrom },
            threadId,
            type,
        });

        it("DM, own message, for me: destId is the peer, with the imei", async () => {
            const rec = await check("delete-dm-own", "deleteMessage", [target(OWN, PEER, 0), true], { reply: {} });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/message/delete");
            assert.deepEqual(req.params, {
                toid: PEER,
                cliMsgId: T0,
                msgs: [{ cliMsgId: CLI_MSG_ID, globalMsgId: MSG_ID, ownerId: OWN, destId: PEER }],
                onlyMe: 1,
                imei: FAKE.imei,
            });
        });

        it("DM, received message: destId is this account's own uid (Zalo's rule; the previous engine put the peer)", async () => {
            const rec = await check("delete-dm-received", "deleteMessage", [target(PEER, PEER, 0), true], {
                reply: {},
            });
            assert.equal(rec.own.requests[0].params.msgs[0].destId, OWN);
            assert.equal(rec.own.requests[0].params.msgs[0].ownerId, PEER);
        });

        it("group, for me: POST {group}/api/group/deletemsg, no imei, destId the group", async () => {
            const rec = await check("delete-group-me", "deleteMessage", [target(PEER, GROUP, 1), true], {
                reply: {},
            });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/group/deletemsg");
            assert.deepEqual(req.paramsOrder, ["grid", "cliMsgId", "msgs", "onlyMe"]);
            assert.equal(req.params.msgs[0].destId, GROUP);
            assert.equal(req.params.onlyMe, 1);
        });

        it("group, someone else's message for everyone: onlyMe 0", async () => {
            const rec = await check("delete-group-everyone", "deleteMessage", [target(PEER, GROUP, 1), false], {
                reply: {},
            });
            assert.equal(rec.own.requests[0].params.onlyMe, 0);
        });

        it("refuses before any request: own message for everyone, and anything for everyone in a DM", async () => {
            for (const [name, args, message] of [
                ["delete-refuse-own", [target(OWN, GROUP, 1), false], /use undo/],
                ["delete-refuse-dm", [target(PEER, PEER, 0), false], /private chat/],
            ]) {
                const rec = await check(name, "deleteMessage", args, { reply: {} });
                // Red if a refusal reached the wire (the e2e suite matches these words).
                assert.equal(rec.own.requests.length, 0, name);
                assert.match(rec.own.error.message, message);
            }
        });
    });

    describe("addReaction", () => {
        const dest = (threadId, type) => ({ data: { msgId: MSG_ID, cliMsgId: CLI_MSG_ID }, threadId, type });

        it("DM: gMsgID is the exact id string, rType from the icon table, msgIds answered as strings", async () => {
            const rec = await check("react-dm", "addReaction", ["/-heart", dest(PEER, 0)], {
                reply: { msgIds: `[${MSG_ID}]` },
            });
            const [req] = rec.own.requests;
            assert.equal(req.service, "reaction");
            assert.equal(req.path, "/api/message/reaction");
            assert.deepEqual(req.paramsOrder, ["react_list", "toid"]);
            assert.equal(req.params.react_list[0].clientId, T0);
            assert.deepEqual(JSON.parse(req.params.react_list[0].message), {
                rMsg: [{ gMsgID: MSG_ID, cMsgID: Number(CLI_MSG_ID), msgType: 1 }],
                rIcon: "/-heart",
                rType: 5,
                source: 6,
            });
            assert.deepEqual(rec.own.result, { msgIds: [MSG_ID] });
        });

        it("group: {react_list, grid, imei} on the reaction host", async () => {
            const rec = await check("react-group", "addReaction", [":>", dest(GROUP, 1)], {
                reply: { msgIds: `[${MSG_ID}]` },
            });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/group/reaction");
            assert.deepEqual(req.paramsOrder, ["react_list", "grid", "imei"]);
            assert.equal(JSON.parse(req.params.react_list[0].message).rType, 0);
        });

        it("an unknown icon goes out with rType -1, the empty icon clears (rType -1); a msgIds array is kept", async () => {
            for (const [name, icon] of [
                ["react-unknown-icon", "/-nosuch"],
                ["react-clear", ""],
            ]) {
                const rec = await check(name, "addReaction", [icon, dest(PEER, 0)], { reply: { msgIds: [] } });
                const message = JSON.parse(rec.own.requests[0].params.react_list[0].message);
                assert.equal(message.rType, -1, name);
                assert.equal(message.rIcon, icon, name);
                assert.deepEqual(rec.own.result, { msgIds: [] });
            }
        });

        it("refuses a thread type other than 0 or 1 before any request (upstream 5a93a0e)", async () => {
            const rec = await check("react-invalid-type", "addReaction", ["/-heart", dest(PEER, 2)], {
                reply: { msgIds: "[]" },
            });
            // Red if the type check moved after the request, or went away (the previous engine fails on the URL instead).
            assert.equal(rec.own.requests.length, 0);
            assert.deepEqual(rec.own.error, { message: "Thread type is invalid", code: null });
            for (const type of [undefined, "x", -1]) {
                const r = await wire.run("addReaction", ["/-heart", dest(PEER, type)], { reply: {} });
                assert.equal(r.own.requests.length, 0, String(type));
                assert.equal(r.own.error.message, "Thread type is invalid", String(type));
            }
        });
    });

    describe("thread types other than user (0) or group (1) are refused before any request", () => {
        const msg = { cliMsgId: CLI_MSG_ID, msgId: MSG_ID, uidFrom: PEER };
        const anchor = { ownerId: PEER, cliMsgId: CLI_MSG_ID, globalMsgId: MSG_ID };
        const CALLS = {
            undo: (type) => [{ msgId: MSG_ID, cliMsgId: CLI_MSG_ID }, PEER, type],
            deleteMessage: (type) => [{ data: msg, threadId: PEER, type }, true],
            deleteChat: (type) => [anchor, PEER, type],
            removeUnreadMark: (type) => [PEER, type],
        };
        for (const [method, args] of Object.entries(CALLS)) {
            it(method, async () => {
                // Red if the method built a request for an unknown thread type (the previous engine sends the DM call).
                for (const type of [2, -1, "x", ""]) {
                    const rec = await wire.run(method, args(type), { reply: {} });
                    assert.equal(rec.own.requests.length, 0, `${method}, type ${JSON.stringify(type)}`);
                    assert.deepEqual(rec.own.error, { message: "Thread type is invalid", code: null });
                }
            });
        }
    });

    describe("deleteChat", () => {
        const anchor = { ownerId: PEER, cliMsgId: CLI_MSG_ID, globalMsgId: MSG_ID };

        it("DM: POST deleteconver with no nretry, cliMsgId a string, the anchor in the expected order", async () => {
            const rec = await check("delete-chat-dm", "deleteChat", [anchor, PEER, 0], { reply: {} });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/message/deleteconver");
            assert.equal(req.query.nretry, undefined);
            assert.deepEqual(req.params, {
                toid: PEER,
                cliMsgId: String(T0),
                conver: anchor,
                onlyMe: 1,
                imei: FAKE.imei,
            });
        });

        it("group: {grid, cliMsgId, conver, onlyMe, imei} on the group host", async () => {
            const rec = await check("delete-chat-group", "deleteChat", [anchor, GROUP, 1], { reply: {} });
            const [req] = rec.own.requests;
            assert.equal(req.service, "group");
            assert.equal(req.path, "/api/group/deleteconver");
            assert.deepEqual(req.paramsOrder, ["grid", "cliMsgId", "conver", "onlyMe", "imei"]);
        });
    });

    describe("unread marks", () => {
        it("getUnreadMark keeps a 19-digit id whole where the previous engine rounded it", async () => {
            const inner = `{"convsGroup":[{"id":${LOSSY},"cliMsgId":${CLI_MSG_ID},"fromUid":${TWIN},"ts":5}],"convsUser":[]}`;
            const rec = await check("unread-get", "getUnreadMark", [], { reply: { data: inner, status: 0 } });
            const [req] = rec.own.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.path, "/api/conv/getUnreadMark");
            assert.deepEqual(req.params, {});
            const entry = rec.own.result.data.convsGroup[0];
            // Red if the reply were parsed plainly: LOSSY and TWIN would both come back as the same double.
            assert.equal(entry.id, LOSSY);
            assert.equal(entry.fromUid, TWIN);
            assert.equal(entry.cliMsgId, CLI_MSG_ID);
            assert.equal(entry.ts, 5, "a key outside the id list stays a number");
        });

        it("getUnreadMark passes an answer without a JSON string through", async () => {
            const rec = await check("unread-get-object", "getUnreadMark", [], {
                reply: { data: { convsGroup: [], convsUser: [] }, status: 0 },
            });
            assert.deepEqual(rec.own.result, { data: { convsGroup: [], convsUser: [] }, status: 0 });
        });

        it("removeUnreadMark (DM) writes the fixed key order, ts from the session clock", async () => {
            const rec = await check("unread-remove-dm", "removeUnreadMark", [PEER, 0], {
                reply: { data: '{"status":1}', status: 0 },
            });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/conv/removeUnreadMark");
            assert.equal(
                req.params.param,
                JSON.stringify({
                    convsGroup: [],
                    convsUser: [PEER],
                    convsGroupData: [],
                    convsUserData: [{ id: PEER, ts: T0 }],
                }),
            );
            assert.deepEqual(rec.own.result, { data: { status: 1 }, status: 0 });
        });

        it("removeUnreadMark (group) is the same order the previous engine already wrote", async () => {
            const rec = await check("unread-remove-group", "removeUnreadMark", [GROUP, 1], {
                reply: { data: '{"status":1}', status: 0 },
            });
            assert.deepEqual(JSON.parse(rec.own.requests[0].params.param).convsGroup, [GROUP]);
        });
    });

    describe("pinned and archived lists", () => {
        it("getPinConversations: GET {conversation}/api/pinconvers/list with the imei", async () => {
            const rec = await check("pins", "getPinConversations", [], {
                reply: { conversations: [`g${GROUP}`, `u${PEER}`], version: 4 },
            });
            const [req] = rec.own.requests;
            assert.equal(req.service, "conversation");
            assert.deepEqual(req.params, { imei: FAKE.imei });
            assert.deepEqual(rec.own.result, { conversations: [`g${GROUP}`, `u${PEER}`], version: 4 });
        });

        it("getPinConversations: error 212 is an empty list, version 0, where the previous engine threw", async () => {
            const rec = await check("pins-212", "getPinConversations", [], {
                error: { inner: { error_code: 212, error_message: "No pinned conversation" } },
            });
            assert.equal(rec.own.error, null);
            assert.deepEqual(rec.own.result, { conversations: [], version: 0 });
            // Red if the empty list were one shared object a caller could change for the next call.
            rec.own.result.conversations.push("x");
            const again = await wire.run("getPinConversations", [], {
                error: { inner: { error_code: 212, error_message: "No pinned conversation" } },
            });
            assert.deepEqual(again.own.result, { conversations: [], version: 0 });
        });

        it("getArchivedChatList: GET {label}/api/archivedchat/list with version 1", async () => {
            for (const [name, version] of [
                ["archived", 7],
                ["archived-string-version", "7"],
            ]) {
                const rec = await check(name, "getArchivedChatList", [], {
                    reply: { version, items: [{ id: GROUP, type: 1 }] },
                });
                assert.equal(rec.own.requests[0].service, "label");
                assert.deepEqual(rec.own.requests[0].params, { version: 1, imei: FAKE.imei });
                assert.equal(rec.own.result.version, version);
            }
        });
    });

    describe("labels", () => {
        const LABEL = {
            id: 1,
            text: "Work",
            textKey: "",
            color: "#0068FF",
            emoji: "",
            offset: 0,
            conversations: [`g${GROUP}`],
            createTime: 5,
        };

        it("getLabels opens labelData", async () => {
            const rec = await check("labels-get", "getLabels", [], {
                reply: { labelData: JSON.stringify([LABEL]), version: 3, lastUpdateTime: 9 },
            });
            assert.equal(rec.own.requests[0].path, "/api/convlabel/get");
            assert.deepEqual(rec.own.result, { labelData: [LABEL], version: 3, lastUpdateTime: 9 });
        });

        it("getLabels takes an empty or already-open labelData as it is (the previous engine would throw)", async () => {
            for (const [labelData, want] of [
                ["", []],
                [[LABEL], [LABEL]],
            ]) {
                const rec = await wire.run("getLabels", [], { reply: { labelData, version: 3, lastUpdateTime: 9 } });
                assert.equal(rec.own.error, null);
                assert.deepEqual(rec.own.result.labelData, want);
            }
        });

        it("updateLabels with no label setting: the full-list POST /api/convlabel/update", async () => {
            const wanted = [{ ...LABEL, conversations: [`g${GROUP}`, PEER] }];
            const rec = await check("labels-legacy", "updateLabels", [{ labelData: wanted, version: 3 }], {
                reply: { labelData: JSON.stringify(wanted), version: 4, lastUpdateTime: 10 },
            });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.path, "/api/convlabel/update");
            assert.deepEqual(req.params, { labelData: JSON.stringify(wanted), version: 3, imei: FAKE.imei });
            assert.deepEqual(rec.own.result, { labelData: wanted, version: 4, lastUpdateTime: 10 });
        });

        it("updateLabels: error 230 says the list changed, and keeps the code", async () => {
            const rec = await check("labels-230", "updateLabels", [{ labelData: [LABEL], version: 2 }], {
                error: { inner: { error_code: 230, error_message: "Label version mismatch" } },
            });
            assert.equal(rec.own.error.code, 230);
            assert.match(rec.own.error.message, /changed since it was read/);
        });
    });

    describe("errors (part 3), every method", () => {
        const CALLS = [
            ["undo", [{ msgId: MSG_ID, cliMsgId: CLI_MSG_ID }, PEER, 0]],
            [
                "deleteMessage",
                [{ data: { cliMsgId: CLI_MSG_ID, msgId: MSG_ID, uidFrom: PEER }, threadId: GROUP, type: 1 }, true],
            ],
            ["addReaction", ["/-heart", { data: { msgId: MSG_ID, cliMsgId: CLI_MSG_ID }, threadId: PEER, type: 0 }]],
            ["deleteChat", [{ ownerId: PEER, cliMsgId: CLI_MSG_ID, globalMsgId: MSG_ID }, PEER, 0]],
            ["getUnreadMark", []],
            ["removeUnreadMark", [GROUP, 1]],
            ["getPinConversations", []],
            ["getArchivedChatList", []],
            ["getLabels", []],
            ["updateLabels", [{ labelData: [], version: 1 }]],
        ];
        for (const [method, args] of CALLS) {
            it(`${method}: the code and message of each error answer`, async () => {
                for (const answer of ERROR_ANSWERS) {
                    const rec = await wire.run(method, args, { error: answer.error });
                    assert.deepEqual(rec.own.error, answer.expected, `${method}, ${answer.label}`);
                }
            });
        }
    });

    it("the area defines exactly the methods this file covers", () => {
        // Red if a method was added to the area without a case here, or one covered here was removed.
        assert.deepEqual(
            Object.keys(actionMethods({})).sort(),
            [
                "addReaction",
                "deleteChat",
                "deleteMessage",
                "getArchivedChatList",
                "getLabels",
                "getPinConversations",
                "getUnreadMark",
                "removeUnreadMark",
                "undo",
                "updateLabels",
            ].sort(),
        );
    });
});

describe("wire: labels when the server asks for the per-label calls (update_label_version 2)", () => {
    let wire;
    const CURRENT = [
        { id: 1, text: "Work", color: "#0068FF", offset: 0, conversations: [`g${GROUP}`], createTime: 5 },
        { id: 2, text: "Old", color: "#D91B1B", offset: 1, conversations: [], createTime: 6 },
    ];

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        wire = await openWire({
            fake: { settings: { features: { chat_label: { api: { update_label_version: 2 } } } } },
        });
        wire.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
    });
    after(() => wire?.close());

    it("tags a conversation with one manage/update call after reading the list (the previous engine sent the full list)", async () => {
        const wanted = [{ ...CURRENT[0], conversations: [`g${GROUP}`, PEER] }, CURRENT[1]];
        const after = { labelData: JSON.stringify(wanted), version: 6, lastUpdateTime: 11 };
        const rec = await wire.run("updateLabels", [{ labelData: wanted, version: 5 }], {
            replies: {
                "/api/convlabel/get": { data: { labelData: JSON.stringify(CURRENT), version: 5, lastUpdateTime: 10 } },
                "/api/convlabel/update": { data: after },
                "/api/convlabel/manage/update": { data: { ...after, oldVersion: 5 } },
            },
        });
        await expectGolden(AREA, "labels-v2", rec.own);
        const [read, update] = rec.own.requests;
        assert.equal(read.path, "/api/convlabel/get");
        assert.equal(update.method, "POST");
        assert.equal(update.service, "label");
        assert.equal(update.path, "/api/convlabel/manage/update");
        // Red if the update sent the whole list, or the imei the manage calls do not carry.
        assert.deepEqual(update.paramsOrder, ["labelInfo", "add", "remove"]);
        assert.deepEqual(JSON.parse(update.params.labelInfo), { id: 1, text: "Work", color: "#0068FF", offset: 0 });
        assert.deepEqual(update.params.add, [PEER]);
        assert.deepEqual(update.params.remove, []);
        assert.deepEqual(rec.own.result, { labelData: wanted, version: 6, lastUpdateTime: 11 });
    });

    it("refuses with 230 after the read when the list moved past the caller's version", async () => {
        const rec = await wire.run("updateLabels", [{ labelData: CURRENT, version: 3 }], {
            replies: {
                "/api/convlabel/get": { data: { labelData: JSON.stringify(CURRENT), version: 5, lastUpdateTime: 10 } },
                "/api/convlabel/update": { inner: { error_code: 230, error_message: "Label version mismatch" } },
            },
        });
        await expectGolden(AREA, "labels-v2-conflict", rec.own);
        assert.equal(rec.own.requests.length, 1, "nothing is written after a conflict");
        assert.equal(rec.own.error.code, 230);
    });

    it("deletes a label and adds one: manage/delete, then manage/add, after the read", async () => {
        const wanted = [CURRENT[0], { text: "New", color: "#4BC377", emoji: "", conversations: [PEER] }];
        const added = { id: 3, text: "New", color: "#4BC377", offset: 1, conversations: [PEER], createTime: 7 };
        const after = { labelData: JSON.stringify([CURRENT[0], added]), version: 7, lastUpdateTime: 12 };
        const rec = await wire.run("updateLabels", [{ labelData: wanted, version: 5 }], {
            replies: {
                "/api/convlabel/get": { data: { labelData: JSON.stringify(CURRENT), version: 5, lastUpdateTime: 10 } },
                "/api/convlabel/update": { data: after },
                "/api/convlabel/manage/delete": {
                    data: { labelData: JSON.stringify([CURRENT[0]]), version: 6, oldVersion: 5, lastUpdateTime: 11 },
                },
                "/api/convlabel/manage/add": { data: { ...after, oldVersion: 6 } },
            },
        });
        await expectGolden(AREA, "labels-v2-add-delete", rec.own);
        const [, del, add] = rec.own.requests;
        assert.deepEqual(
            rec.own.requests.map((r) => `${r.method} ${r.path}`),
            ["GET /api/convlabel/get", "POST /api/convlabel/manage/delete", "POST /api/convlabel/manage/add"],
        );
        // Red if a delete carried more than the ids, or the add an id, an offset or the imei Zalo does not expect.
        assert.deepEqual(del.paramsOrder, ["labelIds"]);
        assert.deepEqual(del.params, { labelIds: [2] });
        assert.deepEqual(add.paramsOrder, ["labelInfo", "add"]);
        assert.equal(add.params.labelInfo, JSON.stringify({ text: "New", color: "#4BC377" }));
        assert.deepEqual(add.params.add, [PEER]);
        assert.deepEqual(rec.own.result, { labelData: [CURRENT[0], added], version: 7, lastUpdateTime: 12 });
    });

    it("is not atomic: a call that fails mid-plan leaves the calls before it applied, and throws", async () => {
        const wanted = [CURRENT[0], { text: "New", color: "#4BC377", conversations: [] }];
        const rec = await wire.run("updateLabels", [{ labelData: wanted, version: 5 }], {
            replies: {
                "/api/convlabel/get": { data: { labelData: JSON.stringify(CURRENT), version: 5, lastUpdateTime: 10 } },
                "/api/convlabel/update": { data: {} },
                "/api/convlabel/manage/delete": { data: { labelData: "[]", version: 6, lastUpdateTime: 11 } },
                "/api/convlabel/manage/add": { inner: { error_code: 230, error_message: "Label version mismatch" } },
            },
        });
        // The delete went out and is not rolled back; the caller learns of the failure and must read the list again.
        assert.deepEqual(
            rec.own.requests.map((r) => r.path),
            ["/api/convlabel/get", "/api/convlabel/manage/delete", "/api/convlabel/manage/add"],
        );
        assert.equal(rec.own.error.code, 230);
        assert.match(rec.own.error.message, /read it again/);
    });

    it("plans deletes, then changes, then new labels; an unchanged label sends nothing", () => {
        const wanted = [
            { ...CURRENT[0], text: "Work!", conversations: [PEER] },
            { text: "New", color: "#4BC377", emoji: "x", conversations: [`g${GROUP}`] },
        ];
        const plan = planLabelCalls(CURRENT, wanted).map(({ def, args }) => [def.path, args]);
        assert.deepEqual(plan, [
            ["/api/convlabel/manage/delete", { labelIds: [2] }],
            [
                "/api/convlabel/manage/update",
                {
                    labelInfo: { id: 1, text: "Work!", color: "#0068FF", offset: 0 },
                    add: [PEER],
                    remove: [`g${GROUP}`],
                },
            ],
            [
                "/api/convlabel/manage/add",
                { labelInfo: { text: "New", color: "#4BC377", emoji: "x" }, add: [`g${GROUP}`] },
            ],
        ]);
        assert.deepEqual(planLabelCalls(CURRENT, CURRENT), []);
    });

    it("sends nothing past the read when the list is already as asked, and answers the list read", async () => {
        const read = { labelData: JSON.stringify(CURRENT), version: 5, lastUpdateTime: 10 };
        const rec = await wire.run("updateLabels", [{ labelData: CURRENT, version: 5 }], {
            replies: { "/api/convlabel/get": { data: read } },
        });
        assert.equal(rec.own.requests.length, 1);
        assert.deepEqual(rec.own.result, { labelData: CURRENT, version: 5, lastUpdateTime: 10 });
    });
});
