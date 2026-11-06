/**
 * The conversations area on the wire (design 3.1 and 3.3, package ACT): mute, the unread mark, hidden chats and their
 * PIN, and auto-delete, src/zalo/api/conversations.js on one logged-in fake.
 *
 * Each case has two parts: (1) our record against its reviewed golden record; (2) the error answers, each checked
 * against a literal `{message, code}`. The Web behavior is also asserted outright.
 *
 * Every id here is fake (tests/unit/no-real-ids.test.js).
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { FAKE, T0, expectGolden, openWire } from "../helpers/wire-diff/index.js";
import { conversationMethods, secondsUntil8am } from "../../src/zalo/api/conversations.js";

const AREA = "conversations";
const PEER = "1000000000000000002";
const PEER2 = "1000000000000000005";
const GROUP = "2000000000000000003";
/** 1700000000000 is 05:13:20 in Asia/Ho_Chi_Minh, the zone every run uses: 2 h 46 min 40 s before 08:00. */
const BEFORE_8AM = 10_000;
/** Four hours later, 09:13:20: the next 08:00 is tomorrow's, 22 h 46 min 40 s away. */
const T_AFTER_8AM = T0 + 4 * 3600 * 1000;
const AFTER_8AM = 82_000;

/** The answers every method is run against for the error part, and what each must throw. */
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

/**
 * Open a wire with a cookie in the jar, so the Cookie header is recorded with a value.
 *
 * @param {object} [opts] - options of `openWire`
 */
async function open(opts) {
    assertSandboxed(CONFIG_DIR);
    const wire = await openWire(opts);
    wire.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
    return wire;
}

describe("wire: conversations (src/zalo/api/conversations.js)", () => {
    let wire;
    before(async () => {
        wire = await open();
    });
    after(() => wire?.close());

    /** Run one case and check it against its golden record. */
    async function check(name, method, args, fixture) {
        const rec = await wire.run(method, args, fixture);
        await expectGolden(AREA, name, rec.own);
        return rec;
    }

    describe("setMute", () => {
        it("forever: duration -1, startTime in seconds, muteType 1 for a user", async () => {
            const rec = await check("mute-forever", "setMute", [{ duration: -1, action: 1 }, PEER, 0], { reply: {} });
            const [req] = rec.own.requests;
            assert.equal(req.service, "profile");
            assert.equal(req.path, "/api/social/profile/setmute");
            assert.deepEqual(req.params, {
                toid: PEER,
                duration: -1,
                action: 1,
                startTime: T0 / 1000,
                muteType: 1,
                imei: FAKE.imei,
            });
        });

        it("until 8 AM, before 8: the seconds to today's 08:00 local time", async () => {
            const rec = await check("mute-until-8am", "setMute", [{ duration: "until8AM", action: 1 }, PEER, 0], {
                reply: {},
            });
            // Red if the clock were not the session's (the frozen one) or the zone were ignored.
            assert.equal(rec.own.requests[0].params.duration, BEFORE_8AM);
        });

        it("a number of seconds, in a group: muteType 2", async () => {
            const rec = await check("mute-hour-group", "setMute", [{ duration: 3600, action: 1 }, GROUP, 1], {
                reply: {},
            });
            assert.equal(rec.own.requests[0].params.duration, 3600);
            assert.equal(rec.own.requests[0].params.muteType, 2);
        });

        it("unmute: action 3 and duration -1 whatever duration was given", async () => {
            const rec = await check("unmute", "setMute", [{ duration: 3600, action: 3 }, PEER, 0], { reply: {} });
            assert.equal(rec.own.requests[0].params.action, 3);
            assert.equal(rec.own.requests[0].params.duration, -1);
        });

        it("no options: mute forever", async () => {
            const rec = await check("mute-default", "setMute", [undefined, PEER, 0], { reply: {} });
            assert.equal(rec.own.requests[0].params.action, 1);
            assert.equal(rec.own.requests[0].params.duration, -1);
        });

        it("getMute: GET with the imei", async () => {
            const rec = await check("mute-get", "getMute", [], { reply: { chatEntries: [], groupChatEntries: [] } });
            assert.equal(rec.own.requests[0].method, "GET");
            assert.deepEqual(rec.own.requests[0].params, { imei: FAKE.imei });
        });
    });

    describe("addUnreadMark", () => {
        it('DM, newest message unknown: {param: JSON} in the Web\'s order, "-1" for both message ids', async () => {
            const rec = await check("unread-add-dm", "addUnreadMark", [PEER, 0], {
                reply: { data: '{"updateId":1}', status: 0 },
            });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/conv/addUnreadMark");
            assert.deepEqual(Object.keys(req.params), ["param"]);
            // Red if the inner JSON were sent as an object, reordered, stamped from another clock, or named a
            // message nobody gave (the previous engine's clock as cliMsgId and "0" as the sender).
            assert.equal(
                req.params.param,
                JSON.stringify({
                    convsGroup: [],
                    convsUser: [{ id: PEER, cliMsgId: "-1", fromUid: "-1", ts: T0 }],
                    imei: FAKE.imei,
                }),
            );
            assert.deepEqual(rec.own.result, { data: { updateId: 1 }, status: 0 });
        });

        it("DM, newest message given: the entry names its cliMsgId and sender, as the Web's does", async () => {
            const last = { cliMsgId: "1699999999999", fromUid: "0" };
            const rec = await check("unread-add-newest", "addUnreadMark", [PEER, 0, last], {
                reply: { data: '{"updateId":2}', status: 0 },
            });
            // Red if the newest message were dropped for the clock (the previous engine) or the "-1" fallback.
            assert.deepEqual(JSON.parse(rec.own.requests[0].params.param).convsUser, [
                { id: PEER, cliMsgId: "1699999999999", fromUid: "0", ts: T0 },
            ]);
        });

        it('a sender id or client id given alone is not enough: both go out as "-1"', async () => {
            for (const last of [{ cliMsgId: "1699999999999" }, { fromUid: PEER2 }, { cliMsgId: "", fromUid: "0" }]) {
                const rec = await wire.run("addUnreadMark", [PEER, 0, last], { reply: { data: "{}", status: 0 } });
                const [entry] = JSON.parse(rec.own.requests[0].params.param).convsUser;
                assert.deepEqual([entry.cliMsgId, entry.fromUid], ["-1", "-1"], JSON.stringify(last));
            }
        });

        it("group: the entry in convsGroup", async () => {
            const rec = await check("unread-add-group", "addUnreadMark", [GROUP, 1], {
                reply: { data: '{"updateId":1}', status: 0 },
            });
            const inner = JSON.parse(rec.own.requests[0].params.param);
            assert.deepEqual(inner.convsGroup, [{ id: GROUP, cliMsgId: "-1", fromUid: "-1", ts: T0 }]);
            assert.deepEqual(inner.convsUser, []);
        });
    });

    describe("hidden conversations", () => {
        it("getHiddenConversations: GET {conversation}/api/hiddenconvers/get-all with the imei", async () => {
            const rec = await check("hidden-get", "getHiddenConversations", [], { reply: { threads: [], pin: "" } });
            assert.equal(rec.own.requests[0].service, "conversation");
            assert.deepEqual(rec.own.requests[0].params, { imei: FAKE.imei });
        });

        it("hide: {del_threads, add_threads, imei} in the Web's order, both lists as JSON text", async () => {
            const rec = await check("hide", "setHiddenConversations", [true, [PEER, PEER2], 0], { reply: {} });
            const [req] = rec.own.requests;
            assert.deepEqual(req.paramsOrder, ["del_threads", "add_threads", "imei"]);
            assert.equal(req.params.del_threads, "[]");
            assert.deepEqual(JSON.parse(req.params.add_threads), [
                { thread_id: PEER, is_group: 0 },
                { thread_id: PEER2, is_group: 0 },
            ]);
        });

        it("unhide a group, one id given bare", async () => {
            const rec = await check("unhide-group", "setHiddenConversations", [false, GROUP, 1], { reply: {} });
            assert.deepEqual(JSON.parse(rec.own.requests[0].params.del_threads), [{ thread_id: GROUP, is_group: 1 }]);
        });

        it("an empty list is refused before any request", async () => {
            const rec = await check("hide-empty", "setHiddenConversations", [true, [], 0], { reply: {} });
            assert.equal(rec.own.requests.length, 0);
            assert.equal(rec.own.error.message, "threadId is required");
        });

        it("updateHiddenConversPin: the PIN goes out as its MD5 hex, never as the digits", async () => {
            const rec = await check("pin-set", "updateHiddenConversPin", ["1234"], { reply: {} });
            const [req] = rec.own.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.path, "/api/hiddenconvers/update-pin");
            assert.equal(req.params.new_pin, createHash("md5").update("1234").digest("hex"));
            // Red if the plain PIN leaked into the request anywhere.
            assert.doesNotMatch(JSON.stringify(req), /"1234"/);
        });

        it("updateHiddenConversPin refuses anything but four digits before any request", async () => {
            for (const pin of ["123", "12345", "abcd", ""]) {
                const rec = await wire.run("updateHiddenConversPin", [pin], { reply: {} });
                assert.equal(rec.own.requests.length, 0, pin);
            }
        });

        it("resetHiddenConversPin: a GET with the common query only (no sealed {})", async () => {
            const rec = await check("pin-reset", "resetHiddenConversPin", [], { reply: {} });
            const [req] = rec.own.requests;
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type"]);
            assert.equal(req.params, null);
        });
    });

    describe("auto-delete", () => {
        it("getAutoDeleteChat: GET with a sealed {}", async () => {
            const rec = await check("auto-delete-get", "getAutoDeleteChat", [], { reply: { convers: [] } });
            assert.equal(rec.own.requests[0].path, "/api/conv/autodelete/getConvers");
            assert.deepEqual(rec.own.requests[0].params, {});
        });

        it("updateAutoDeleteChat (DM): POST with the sealed params in the query and no body", async () => {
            const rec = await check("auto-delete-dm", "updateAutoDeleteChat", [86400000, PEER, 0], { reply: {} });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type", "params"]);
            assert.deepEqual(req.params, { threadId: PEER, isGroup: 0, ttl: 86400000, clientLang: "vi" });
            // Red if a form body came back: the Web posts nothing.
            assert.equal(req.form, null);
            assert.equal(req.body, null);
        });

        it("updateAutoDeleteChat (group, off)", async () => {
            const rec = await check("auto-delete-group", "updateAutoDeleteChat", [0, GROUP, 1], { reply: {} });
            assert.deepEqual(rec.own.requests[0].params, { threadId: GROUP, isGroup: 1, ttl: 0, clientLang: "vi" });
        });
    });

    it("a thread type other than 0 or 1 is refused before any request", async () => {
        for (const [method, args] of [
            ["setMute", [{}, PEER, 2]],
            ["addUnreadMark", [PEER, 5]],
            ["setHiddenConversations", [true, [PEER], 9]],
            ["updateAutoDeleteChat", [0, PEER, "x"]],
        ]) {
            const rec = await wire.run(method, args, { reply: {} });
            assert.equal(rec.own.requests.length, 0, method);
            assert.equal(rec.own.error?.message, "Thread type is invalid", method);
        }
    });

    describe("errors (part 3), every method", () => {
        const CALLS = [
            ["setMute", [{ duration: -1, action: 1 }, PEER, 0]],
            ["getMute", []],
            ["addUnreadMark", [GROUP, 1]],
            ["getHiddenConversations", []],
            ["setHiddenConversations", [false, [PEER], 0]],
            ["updateHiddenConversPin", ["0000"]],
            ["resetHiddenConversPin", []],
            ["getAutoDeleteChat", []],
            ["updateAutoDeleteChat", [0, PEER, 0]],
        ];
        for (const [method, args] of CALLS) {
            it(`${method}: the code and message of each error`, async () => {
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
            Object.keys(conversationMethods({})).sort(),
            [
                "addUnreadMark",
                "getAutoDeleteChat",
                "getHiddenConversations",
                "getMute",
                "resetHiddenConversPin",
                "setHiddenConversations",
                "setMute",
                "updateAutoDeleteChat",
                "updateHiddenConversPin",
            ].sort(),
        );
    });
});

describe("wire: setMute until 8 AM after 8 AM (tomorrow's 08:00)", () => {
    let wire;
    before(async () => {
        wire = await open({ t0: T_AFTER_8AM });
    });
    after(() => wire?.close());

    it("counts to tomorrow's 08:00 local time", async () => {
        const rec = await wire.run("setMute", [{ duration: "until8AM", action: 1 }, PEER, 0], { reply: {} });
        await expectGolden(AREA, "mute-until-8am-late", rec.own);
        assert.equal(rec.own.requests[0].params.duration, AFTER_8AM);
        assert.equal(rec.own.requests[0].params.startTime, T_AFTER_8AM / 1000);
    });

    it("secondsUntil8am rolls over at exactly 08:00 (a fresh day starts counting from tomorrow)", () => {
        const zone = process.env.TZ;
        process.env.TZ = "Asia/Ho_Chi_Minh";
        try {
            const eight = new Date(T0);
            eight.setHours(8, 0, 0, 0);
            assert.equal(secondsUntil8am(eight.getTime() - 1000), 1);
            assert.equal(secondsUntil8am(eight.getTime()), 24 * 3600);
        } finally {
            if (zone === undefined) delete process.env.TZ;
            else process.env.TZ = zone;
        }
    });
});
