/**
 * The actions area on the wire (design 3.1, package ACT): undo, deleteMessage, addReaction, deleteChat, the unread
 * marks, the pinned and archived lists, and the labels, zca-js against src/zalo/api/actions.js on one logged-in fake.
 *
 * Each case has the three parts of design 3.1: (1) `assertSameWire` against the rows of tests/helpers/wire-diff/
 * allow/actions.js, which fails on any difference not declared AND on a declared one that is absent; (2) our side
 * against its reviewed golden record; (3) the error answers. The Web-only behavior is also asserted outright, so a
 * row that matched by accident cannot hide it.
 *
 * Every id here is fake (tests/unit/no-real-ids.test.js).
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { ALLOW, FAKE, T0, assertSameWire, expectGolden, openPair } from "../helpers/wire-diff/index.js";
import { OWN_READY, planLabelCalls } from "../../src/zalo/api/actions.js";

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

/**
 * The allowed differences of one case: the area's rows of that case, plus the global rows.
 *
 * @param {string} name - the case
 * @returns {object[]}
 */
function allowFor(name) {
    return ALLOW[AREA].filter((r) => !r.case || [].concat(r.case).includes(name));
}

/** The answers every method is run against for part 3, and whether zca-js has the same message for each. */
const ERROR_ANSWERS = [
    { label: "an outer error", error: { outer: { error_code: 102, error_message: "outer failure" } }, sameText: true },
    { label: "an inner error", error: { inner: { error_code: 114, error_message: "inner failure" } }, sameText: true },
    { label: "HTTP 500", error: { status: 500 }, sameText: false },
    { label: "an undecryptable data", error: { undecryptable: true }, sameText: true },
];

describe("wire: actions (zca-js against src/zalo/api/actions.js)", () => {
    let pair;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        pair = await openPair();
        // A cookie for every fake host, so the Cookie header is compared on a value (zca-js writes an empty header
        // for an empty jar, fetch writes none).
        pair.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
    });
    after(() => pair?.close());

    /**
     * Run one case through both engines, check it against its rows and its golden record.
     *
     * @param {string} name - the case (golden key and allow `case`)
     * @param {string} method
     * @param {unknown[]} args
     * @param {object} fixture
     * @returns {Promise<object>} the record
     */
    async function check(name, method, args, fixture) {
        const rec = await pair.run(method, args, fixture);
        assertSameWire(rec, allowFor(name));
        await expectGolden(AREA, name, rec.own);
        return rec;
    }

    describe("undo", () => {
        it("DM: POST {chat}/api/message/undo in the Web's key order, clientId from the session clock", async () => {
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

        it("a known group visibility goes out as given (zca-js always sent 0)", async () => {
            const rec = await pair.run("undo", [{ msgId: MSG_ID, cliMsgId: CLI_MSG_ID, visibility: 1 }, GROUP, 1], {
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

        it("DM, received message: destId is this account's own uid (the Web's rule; zca-js put the peer)", async () => {
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
            // Red if the type check moved after the request, or went away (zca-js 2.2.0 fails on the URL instead).
            assert.equal(rec.own.requests.length, 0);
            assert.deepEqual(rec.own.error, { message: "Thread type is invalid", code: null });
            for (const type of [undefined, "x", -1]) {
                const r = await pair.run("addReaction", ["/-heart", dest(PEER, type)], { reply: {} });
                assert.equal(r.own.requests.length, 0, String(type));
                assert.equal(r.own.error.message, "Thread type is invalid", String(type));
            }
        });
    });

    describe("deleteChat", () => {
        const anchor = { ownerId: PEER, cliMsgId: CLI_MSG_ID, globalMsgId: MSG_ID };

        it("DM: POST deleteconver with no nretry, cliMsgId a string, the anchor in Web order", async () => {
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
        it("getUnreadMark keeps a 19-digit id whole where zca-js rounds it", async () => {
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
            assert.equal(rec.zca.result.data.convsGroup[0].id, Number(LOSSY), "zca-js rounds it (the reason for this)");
        });

        it("getUnreadMark passes an answer without a JSON string through", async () => {
            const rec = await check("unread-get-object", "getUnreadMark", [], {
                reply: { data: { convsGroup: [], convsUser: [] }, status: 0 },
            });
            assert.deepEqual(rec.own.result, { data: { convsGroup: [], convsUser: [] }, status: 0 });
        });

        it("removeUnreadMark (DM) writes the Web's fixed key order, ts from the session clock", async () => {
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

        it("removeUnreadMark (group) is the same order zca-js already wrote", async () => {
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

        it("getPinConversations: error 212 is an empty list, version 0, where zca-js threw", async () => {
            const rec = await check("pins-212", "getPinConversations", [], {
                error: { inner: { error_code: 212, error_message: "No pinned conversation" } },
            });
            assert.equal(rec.own.error, null);
            assert.deepEqual(rec.own.result, { conversations: [], version: 0 });
            // Red if the empty list were one shared object a caller could change for the next call.
            rec.own.result.conversations.push("x");
            const again = await pair.run("getPinConversations", [], {
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

        it("getLabels takes an empty or already-open labelData as it is (zca-js would throw)", async () => {
            for (const [labelData, want] of [
                ["", []],
                [[LABEL], [LABEL]],
            ]) {
                const rec = await pair.run("getLabels", [], { reply: { labelData, version: 3, lastUpdateTime: 9 } });
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
            it(`${method}: the same code as zca-js (and the same text where zca-js has it)`, async () => {
                for (const answer of ERROR_ANSWERS) {
                    const rec = await pair.run(method, args, { error: answer.error });
                    const where = `${method}, ${answer.label}`;
                    assert.ok(rec.own.error, `${where}: our side did not throw`);
                    assert.ok(rec.zca.error, `${where}: zca-js did not throw`);
                    assert.equal(rec.own.error.code, rec.zca.error.code, where);
                    if (answer.sameText) assert.equal(rec.own.error.message, rec.zca.error.message, where);
                    else assert.equal(rec.own.error.message, "HTTP 500", where);
                }
            });
        }
    });

    it("OWN_READY lists every method this file compares", () => {
        // Red if a method was flipped to our engine without a comparison here, or one compared here was left on zca-js.
        assert.deepEqual(
            [...OWN_READY].sort(),
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
    let pair;
    const CURRENT = [
        { id: 1, text: "Work", color: "#0068FF", offset: 0, conversations: [`g${GROUP}`], createTime: 5 },
        { id: 2, text: "Old", color: "#D91B1B", offset: 1, conversations: [], createTime: 6 },
    ];

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        pair = await openPair({
            fake: { settings: { features: { chat_label: { api: { update_label_version: 2 } } } } },
        });
        pair.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
    });
    after(() => pair?.close());

    it("tags a conversation with one manage/update call after reading the list (zca-js sends the full list)", async () => {
        const wanted = [{ ...CURRENT[0], conversations: [`g${GROUP}`, PEER] }, CURRENT[1]];
        const after = { labelData: JSON.stringify(wanted), version: 6, lastUpdateTime: 11 };
        const rec = await pair.run("updateLabels", [{ labelData: wanted, version: 5 }], {
            replies: {
                "/api/convlabel/get": { data: { labelData: JSON.stringify(CURRENT), version: 5, lastUpdateTime: 10 } },
                "/api/convlabel/update": { data: after },
                "/api/convlabel/manage/update": { data: { ...after, oldVersion: 5 } },
            },
        });
        assertSameWire(rec, allowFor("labels-v2"));
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
        const rec = await pair.run("updateLabels", [{ labelData: CURRENT, version: 3 }], {
            replies: {
                "/api/convlabel/get": { data: { labelData: JSON.stringify(CURRENT), version: 5, lastUpdateTime: 10 } },
                "/api/convlabel/update": { inner: { error_code: 230, error_message: "Label version mismatch" } },
            },
        });
        assertSameWire(rec, allowFor("labels-v2-conflict"));
        await expectGolden(AREA, "labels-v2-conflict", rec.own);
        assert.equal(rec.own.requests.length, 1, "nothing is written after a conflict");
        assert.equal(rec.own.error.code, 230);
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
        const rec = await pair.run("updateLabels", [{ labelData: CURRENT, version: 5 }], {
            replies: { "/api/convlabel/get": { data: read } },
        });
        assert.equal(rec.own.requests.length, 1);
        assert.deepEqual(rec.own.result, { labelData: CURRENT, version: 5, lastUpdateTime: 10 });
    });
});
