/**
 * The conversations area on the wire (design 3.1, package ACT): mute, the unread mark, hidden chats and their PIN,
 * and auto-delete, zca-js against src/zalo/api/conversations.js on one logged-in fake.
 *
 * Each case has the three parts of design 3.1: (1) `assertSameWire` against the rows of tests/helpers/wire-diff/
 * allow/conversations.js, which fails on any difference not declared AND on a declared one that is absent; (2) our
 * side against its reviewed golden record; (3) the error answers. The Web-only behavior is also asserted outright.
 *
 * Every id here is fake (tests/unit/no-real-ids.test.js).
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { ALLOW, FAKE, T0, assertSameWire, expectGolden, openPair } from "../helpers/wire-diff/index.js";
import { OWN_READY, secondsUntil8am } from "../../src/zalo/api/conversations.js";

const AREA = "conversations";
const PEER = "1000000000000000002";
const PEER2 = "1000000000000000005";
const GROUP = "2000000000000000003";
/** 1700000000000 is 05:13:20 in Asia/Ho_Chi_Minh, the zone every run uses: 2 h 46 min 40 s before 08:00. */
const BEFORE_8AM = 10_000;
/** Four hours later, 09:13:20: the next 08:00 is tomorrow's, 22 h 46 min 40 s away. */
const T_AFTER_8AM = T0 + 4 * 3600 * 1000;
const AFTER_8AM = 82_000;

/**
 * The allowed differences of one case: the area's rows of that case, plus the global rows (D3 left out, see
 * wire-actions.test.js `allowFor`: K1 sends the same Accept-Language zca-js does, so D3 is never present).
 *
 * @param {string} name - the case
 * @returns {object[]}
 */
function allowFor(name) {
    return ALLOW[AREA].filter((r) => r.id !== "D3" && (!r.case || [].concat(r.case).includes(name)));
}

/** The answers every method is run against for part 3, and whether zca-js has the same message for each. */
const ERROR_ANSWERS = [
    { label: "an outer error", error: { outer: { error_code: 102, error_message: "outer failure" } }, sameText: true },
    { label: "an inner error", error: { inner: { error_code: 114, error_message: "inner failure" } }, sameText: true },
    { label: "HTTP 500", error: { status: 500 }, sameText: false },
    { label: "an undecryptable data", error: { undecryptable: true }, sameText: true },
];

/**
 * Open a pair with a cookie in the jar (zca-js writes an empty Cookie header for an empty jar, fetch writes none).
 *
 * @param {object} [opts] - options of `openPair`
 */
async function open(opts) {
    assertSandboxed(CONFIG_DIR);
    const pair = await openPair(opts);
    pair.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
    return pair;
}

describe("wire: conversations (zca-js against src/zalo/api/conversations.js)", () => {
    let pair;
    before(async () => {
        pair = await open();
    });
    after(() => pair?.close());

    /** Run one case through both engines, check it against its rows and its golden record. */
    async function check(name, method, args, fixture) {
        const rec = await pair.run(method, args, fixture);
        assertSameWire(rec, allowFor(name));
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
        it("DM: {param: JSON} with the Web's fixed order {convsGroup, convsUser, imei}", async () => {
            const rec = await check("unread-add-dm", "addUnreadMark", [PEER, 0], {
                reply: { data: '{"updateId":1}', status: 0 },
            });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/conv/addUnreadMark");
            assert.deepEqual(Object.keys(req.params), ["param"]);
            // Red if the inner JSON were sent as an object, reordered, or stamped from another clock.
            assert.equal(
                req.params.param,
                JSON.stringify({
                    convsGroup: [],
                    convsUser: [{ id: PEER, cliMsgId: String(T0), fromUid: "0", ts: T0 }],
                    imei: FAKE.imei,
                }),
            );
            assert.deepEqual(rec.own.result, { data: { updateId: 1 }, status: 0 });
        });

        it("group: the entry in convsGroup", async () => {
            const rec = await check("unread-add-group", "addUnreadMark", [GROUP, 1], {
                reply: { data: '{"updateId":1}', status: 0 },
            });
            const inner = JSON.parse(rec.own.requests[0].params.param);
            assert.deepEqual(
                inner.convsGroup.map((e) => e.id),
                [GROUP],
            );
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
                const rec = await pair.run("updateHiddenConversPin", [pin], { reply: {} });
                assert.equal(rec.own.requests.length, 0, pin);
                assert.equal(rec.zca.requests.length, 0, pin);
                assert.deepEqual(rec.own.error, rec.zca.error, pin);
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
            const rec = await pair.run(method, args, { reply: {} });
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
    let pair;
    before(async () => {
        pair = await open({ t0: T_AFTER_8AM });
    });
    after(() => pair?.close());

    it("counts to tomorrow's 08:00 local time", async () => {
        const rec = await pair.run("setMute", [{ duration: "until8AM", action: 1 }, PEER, 0], { reply: {} });
        assertSameWire(rec, allowFor("mute-until-8am-late"));
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
