/**
 * The people area on the wire (design 3.1, package PPL): profiles, the friend list, phone and username lookups,
 * aliases, friend requests, the 1-1 pin board, and the friend extras of spec-sweep 1.2 (remove, block, last online,
 * the two retired lists, phones, QR, shared groups, business profile, feed block), src/zalo/api/people.js on one
 * logged-in fake (design 3.1 and 3.3).
 *
 * Each case has two parts: (1) our record against its reviewed golden record; (2) the error answers, each checked
 * against a literal `{message, code}`. The Web behavior is also asserted outright, so a reader sees it here and not
 * only in the golden file.
 *
 * Every id and phone number here is fake (tests/unit/no-real-ids.test.js).
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { FAKE, expectGolden, openWire } from "../helpers/wire-diff/index.js";
import {
    parseBoardTopics,
    parseOnlineStatuses,
    peopleMethods,
    readAllAliases,
    webPhone,
} from "../../src/zalo/api/people.js";

const AREA = "people";
/** Uids past 2^53: a Number() anywhere on the way would round them (4123456789012345678 -> ...680). */
const PEER = "4123456789012345678";
const PEER2 = "1000000000000000002";
/** The dummy phone the docs use. */
const PHONE = "0901234567";

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

describe("wire: people (src/zalo/api/people.js)", () => {
    let wire;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        wire = await openWire();
        // A cookie for every fake host, so the Cookie header is recorded with a value.
        wire.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
        // A phonebook version from the login, so the ordinary getUserInfo case compares it on a value.
        wire.ctx.extraVer = { phonebook: 7 };
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

    /**
     * Run `fn` with some ctx fields replaced, then put them back (both engines read the one ctx).
     *
     * @param {object} fields
     * @param {() => Promise<object>} fn
     * @returns {Promise<object>}
     */
    async function withCtx(fields, fn) {
        const saved = Object.fromEntries(Object.keys(fields).map((k) => [k, wire.ctx[k]]));
        Object.assign(wire.ctx, fields);
        try {
            return await fn();
        } finally {
            Object.assign(wire.ctx, saved);
        }
    }

    describe("getUserInfo", () => {
        const reply = {
            changed_profiles: { [PEER]: { userId: PEER, displayName: "Fake Peer", zaloName: "Fake" } },
            unchanged_profiles: { [PEER2]: { userId: PEER2 } },
            phonebook_version: 7,
        };

        it("POST {profile}/getprofiles/v2: avatar 160, language vi, `_0` added, both bags returned as they came", async () => {
            const rec = await check("getUserInfo", "getUserInfo", [[PEER, `${PEER2}_3`]], { reply });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.service, "profile");
            assert.equal(req.path, "/api/social/friend/getprofiles/v2");
            assert.deepEqual(req.params, {
                phonebook_version: 7,
                // Red if an id went through Number(): PEER is past 2^53. The versioned entry is kept as given.
                friend_pversion_map: [`${PEER}_0`, `${PEER2}_3`],
                avatar_size: 160,
                language: "vi",
                show_online_status: 1,
                imei: FAKE.imei,
            });
            assert.deepEqual(rec.own.result, reply);
            assert.deepEqual(Object.keys(rec.own.result.changed_profiles), [PEER]);
        });

        it("one uid string is a list of one", async () => {
            const rec = await wire.run("getUserInfo", [PEER], { reply });
            assert.deepEqual(rec.own.requests[0].params.friend_pversion_map, [`${PEER}_0`]);
        });

        it('language is "vi" even when the session is in English (zca-js sent the session language)', async () => {
            const rec = await withCtx({ language: "en" }, () =>
                check("getUserInfo/lang-en", "getUserInfo", [PEER], { reply }),
            );
            assert.equal(rec.own.requests[0].params.language, "vi");
        });

        it("phonebook_version 0 when the login carried none (zca-js left the key out)", async () => {
            const rec = await withCtx({ extraVer: {} }, () =>
                check("getUserInfo/no-phonebook", "getUserInfo", [PEER], { reply }),
            );
            assert.equal(rec.own.requests[0].params.phonebook_version, 0);
        });

        it("no uid: refused before any request, with zca-js's message", async () => {
            const rec = await check("getUserInfo/missing", "getUserInfo", [], { reply });
            assert.equal(rec.own.requests.length, 0);
            assert.deepEqual(rec.own.error, { message: "Missing user id", code: null });
        });
    });

    describe("getAllFriends", () => {
        it("GET {profile}/getfriends with avatar 160; the array returned as it came", async () => {
            const friends = [
                { userId: PEER, displayName: "Fake A", zaloName: "A", globalId: "G1", lastActionTime: 1700000000000 },
                { userId: PEER2, displayName: "Fake B", zaloName: "B", globalId: "G2", lastActionTime: 1700000000001 },
            ];
            const rec = await check("getAllFriends", "getAllFriends", [], { reply: friends });
            const [req] = rec.own.requests;
            assert.equal(req.method, "GET");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type", "params"]);
            assert.deepEqual(req.params, {
                incInvalid: 1,
                page: 1,
                count: 20000,
                avatar_size: 160,
                actiontime: 0,
                imei: FAKE.imei,
            });
            assert.deepEqual(rec.own.result, friends);
        });
    });

    describe("findUser", () => {
        const reply = { uid: PEER, display_name: "Fake Peer", zalo_name: "Fake", avatar: "https://fake.invalid/a" };

        it("GET {friend}/profile/get with params once, reqSrc 40, a leading 0 turned into 84", async () => {
            const rec = await check("findUser", "findUser", [PHONE], { reply });
            const [req] = rec.own.requests;
            // Red if params went into the query twice again (zca-js's order is the allowed difference).
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type", "params"]);
            assert.deepEqual(req.params, {
                phone: "84901234567",
                avatar_size: 240,
                language: "vi",
                imei: FAKE.imei,
                reqSrc: 40,
            });
            assert.deepEqual(rec.own.result, reply);
        });

        it("0 -> 84 whatever the session language (zca-js did it only for vi)", async () => {
            const rec = await withCtx({ language: "en" }, () =>
                check("findUser/lang-en", "findUser", [PHONE], { reply }),
            );
            assert.equal(rec.own.requests[0].params.phone, "84901234567");
            assert.equal(rec.own.requests[0].params.language, "en");
        });

        it("216 (no such user) is still thrown, with Zalo's message and code", async () => {
            const rec = await check("findUser/216", "findUser", [PHONE], {
                error: { outer: { error_code: 216, error_message: "fake not found" } },
            });
            assert.deepEqual(rec.own.error, { message: "fake not found", code: 216 });
        });

        it("313 (lookup limit) says so and keeps the code", async () => {
            const rec = await check("findUser/313", "findUser", [PHONE], {
                error: { inner: { error_code: 313, error_message: "fake limit" } },
            });
            assert.equal(rec.own.error.code, 313);
            assert.match(rec.own.error.message, /^Phone search limit reached/);
        });

        it("no phone: refused before any request", async () => {
            const rec = await check("findUser/missing", "findUser", [""], { reply });
            assert.equal(rec.own.requests.length, 0);
            assert.deepEqual(rec.own.error, { message: "Missing phoneNumber", code: null });
        });
    });

    describe("findUserByUsername", () => {
        it("GET {friend}/search/by-user-name with params first in the query", async () => {
            const reply = { uid: PEER, display_name: "Fake Peer", zalo_name: "Fake" };
            const rec = await check("findUserByUsername", "findUserByUsername", ["fake.user"], { reply });
            const [req] = rec.own.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.path, "/api/friend/search/by-user-name");
            assert.deepEqual(req.queryOrder, ["params", "zpw_ver", "zpw_type"]);
            assert.deepEqual(req.params, { user_name: "fake.user", avatar_size: 240 });
            assert.deepEqual(rec.own.result, reply);
        });
    });

    describe("aliases", () => {
        const page = (n, extra = {}) => ({
            items: Array.from({ length: n }, (_, i) => ({ userId: `10000000000000000${10 + i}`, alias: `a${i}` })),
            updateTime: 5,
            ...extra,
        });

        it("getAliasList: GET {alias}/alias/list {page, count, imei}", async () => {
            const rec = await check("getAliasList", "getAliasList", [100, 1], { reply: page(3) });
            const [req] = rec.own.requests;
            assert.equal(req.service, "alias");
            assert.deepEqual(req.params, { page: 1, count: 100, imei: FAKE.imei });
            assert.equal(rec.own.result.items.length, 3);
        });

        it("getAliasList: the defaults are 100 and page 1", async () => {
            const rec = await wire.run("getAliasList", [], { reply: page(0) });
            assert.deepEqual(rec.own.requests[0].params, { page: 1, count: 100, imei: FAKE.imei });
        });

        it("getAliasList: 212 past page 1 is the end of the list, answered as an empty page", async () => {
            const rec = await check("getAliasList/212-later", "getAliasList", [100, 2], {
                error: { inner: { error_code: 212, error_message: "fake end of list" } },
            });
            assert.deepEqual(rec.own.result, { items: [] });
        });

        it("getAliasList: 212 on page 1 is still an error (nothing was collected)", async () => {
            const rec = await check("getAliasList/212-first", "getAliasList", [100, 1], {
                error: { inner: { error_code: 212, error_message: "fake end of list" } },
            });
            assert.deepEqual(rec.own.error, { message: "fake end of list", code: 212 });
        });

        /**
         * readAllAliases against our engine: the pages the fake served, in order, and what came back.
         *
         * @param {object[]} answers - routeSequence answers for /api/alias/list
         * @param {number} [pageSize]
         */
        async function pages(answers, pageSize = 100) {
            wire.fake.clearRoutes();
            wire.fake.routeSequence("/api/alias/list", answers);
            const from = wire.fake.requests.length;
            try {
                const items = await readAllAliases(wire.own, { pageSize });
                return { items, asked: wire.fake.requests.slice(from).map((r) => r.params.page) };
            } finally {
                wire.fake.clearRoutes();
            }
        }

        it("readAllAliases: no hasMore -> on while a page is full (100 then 3: two pages)", async () => {
            const { items, asked } = await pages([{ data: page(100) }, { data: page(3) }]);
            assert.deepEqual(asked, [1, 2]);
            assert.equal(items.length, 103);
        });

        it("readAllAliases: hasMore false stops on a full page (the old length rule would ask again)", async () => {
            const { items, asked } = await pages([{ data: page(100, { hasMore: false }) }, { data: page(3) }]);
            assert.deepEqual(asked, [1]);
            assert.equal(items.length, 100);
        });

        it("readAllAliases: hasMore true goes on past a short page", async () => {
            const { asked } = await pages([
                { data: page(2, { hasMore: true }) },
                { data: page(1, { hasMore: false }) },
            ]);
            assert.deepEqual(asked, [1, 2]);
        });

        it("readAllAliases: 212 on page 2 keeps page 1 and ends", async () => {
            const { items, asked } = await pages([
                { data: page(100) },
                { inner: { error_code: 212, error_message: "fake end of list" } },
            ]);
            assert.deepEqual(asked, [1, 2]);
            assert.equal(items.length, 100);
        });

        it("changeFriendAlias(alias, friendId): GET {alias}/alias/update {friendId, alias, imei}", async () => {
            const rec = await check("changeFriendAlias", "changeFriendAlias", ["Fake Nick", PEER], { reply: "" });
            const [req] = rec.own.requests;
            assert.equal(req.method, "GET");
            assert.equal(req.path, "/api/alias/update");
            assert.deepEqual(req.params, { friendId: PEER, alias: "Fake Nick", imei: FAKE.imei });
        });

        it("removeFriendAlias: GET {alias}/alias/remove {friendId}", async () => {
            const rec = await check("removeFriendAlias", "removeFriendAlias", [PEER], { reply: "" });
            assert.deepEqual(rec.own.requests[0].params, { friendId: PEER });
        });
    });

    describe("friend requests", () => {
        it("sendFriendRequest(msg, userId): POST {friend}/sendreq, source 30 with srcParams as a JSON string", async () => {
            const rec = await check("sendFriendRequest", "sendFriendRequest", ["hello", PEER], { reply: "" });
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type"]);
            assert.deepEqual(req.formOrder, ["params"]);
            assert.deepEqual(req.params, {
                toid: PEER,
                msg: "hello",
                reqsrc: 30,
                imei: FAKE.imei,
                language: "vi",
                srcParams: JSON.stringify({ uidTo: PEER }),
            });
        });

        it("sendFriendRequest keeps Zalo's code on `.code` (225: already friends)", async () => {
            const rec = await check("sendFriendRequest/225", "sendFriendRequest", ["", PEER], {
                error: { outer: { error_code: 225, error_message: "fake already friends" } },
            });
            assert.deepEqual(rec.own.error, { message: "fake already friends", code: 225 });
        });

        for (const [method, path, params] of [
            ["acceptFriendRequest", "/api/friend/accept", { fid: PEER, language: "vi" }],
            ["rejectFriendRequest", "/api/friend/reject", { fid: PEER }],
            ["undoFriendRequest", "/api/friend/undo", { fid: PEER }],
        ]) {
            it(`${method}: POST {friend}${path} ${JSON.stringify(Object.keys(params))}`, async () => {
                const rec = await check(method, method, [PEER], { reply: "" });
                const [req] = rec.own.requests;
                assert.equal(req.method, "POST");
                assert.equal(req.path, path);
                assert.deepEqual(req.params, params);
            });
        }

        it("getSentFriendRequest: GET {friend}/requested/list, keyed by uid", async () => {
            const reply = {
                [PEER]: { userId: PEER, displayName: "Fake", fReqInfo: { message: "hi", src: 30, time: 1 } },
                [PEER2]: { userId: PEER2, displayName: "Fake 2", fReqInfo: { message: "", src: 40, time: 2 } },
            };
            const rec = await check("getSentFriendRequest", "getSentFriendRequest", [], { reply });
            assert.deepEqual(rec.own.requests[0].params, { imei: FAKE.imei });
            // Red if a uid key went through a number: the 19-digit key must come back as written.
            assert.deepEqual(Object.keys(rec.own.result).sort(), [PEER, PEER2].sort());
        });

        it("getSentFriendRequest: 112 (none sent) answers {} instead of throwing, inner or outer", async () => {
            const inner = await check("getSentFriendRequest/112", "getSentFriendRequest", [], {
                error: { inner: { error_code: 112, error_message: "fake none" } },
            });
            assert.deepEqual(inner.own.result, {});
            assert.equal(inner.own.error, null);
            const outer = await check("getSentFriendRequest/112-outer", "getSentFriendRequest", [], {
                error: { outer: { error_code: 112, error_message: "fake none" } },
            });
            assert.deepEqual(outer.own.result, {});
        });

        it("getFriendRequestStatus: GET {friend}/reqstatus {fid, imei}", async () => {
            const reply = { addFriendPrivacy: 1, isSeenFriendReq: 0, is_friend: 0, is_requested: 1, is_requesting: 0 };
            const rec = await check("getFriendRequestStatus", "getFriendRequestStatus", [PEER], { reply });
            assert.deepEqual(rec.own.requests[0].params, { fid: PEER, imei: FAKE.imei });
            assert.deepEqual(rec.own.result, reply);
        });

        it("getFriendRecommendations: GET {friend}/recommendsv2/list {imei}", async () => {
            const reply = {
                expiredDuration: 1,
                collapseMsgListConfig: {},
                recommItems: [{ recommItemType: 1, dataInfo: { recommType: 2, userId: PEER, displayName: "Fake" } }],
            };
            const rec = await check("getFriendRecommendations", "getFriendRecommendations", [], { reply });
            assert.equal(rec.own.requests[0].path, "/api/friend/recommendsv2/list");
            assert.deepEqual(rec.own.result, reply);
        });
    });

    describe("getFriendBoardList", () => {
        it("GET {friend_board}/friendboard/list {conversationId, version 0, imei}; a string topic parsed", async () => {
            const topic = { type: 2, params: '{"msgId":"7000000000000000001"}' };
            const reply = { data: [{ type: 1, params: "{}" }, JSON.stringify(topic)], version: 3 };
            const rec = await check("getFriendBoardList", "getFriendBoardList", [PEER], { reply });
            const [req] = rec.own.requests;
            assert.equal(req.service, "friend_board");
            assert.deepEqual(req.params, { conversationId: PEER, version: 0, imei: FAKE.imei });
            assert.deepEqual(rec.own.result, { data: [{ type: 1, params: "{}" }, topic], version: 3 });
        });

        it("parseBoardTopics keeps objects and text that is not a JSON object", () => {
            assert.deepEqual(parseBoardTopics([{ a: 1 }, '{"b":2}', "plain", "7", null]), [
                { a: 1 },
                { b: 2 },
                "plain",
                "7",
                null,
            ]);
            assert.equal(parseBoardTopics(undefined), undefined);
        });
    });

    describe("the retired lists (ported as they are, verified: false)", () => {
        it("getFriendOnlines: GET {profile}/friend/onlines {imei}; each status read out of its JSON", async () => {
            const reply = {
                predefine: [],
                ownerStatus: "",
                onlines: [{ userId: PEER, status: '{"status":"fake busy"}' }, { userId: PEER2 }],
            };
            const rec = await check("getFriendOnlines", "getFriendOnlines", [], { reply });
            assert.deepEqual(rec.own.requests[0].params, { imei: FAKE.imei });
            assert.deepEqual(
                rec.own.result.onlines.map((o) => o.status),
                ["fake busy", undefined],
            );
        });

        it("getFriendOnlines: HTTP 404 keeps the status in the message (friend online's hint matches /404/)", async () => {
            const rec = await wire.run("getFriendOnlines", [], { error: { status: 404 } });
            assert.match(rec.own.error.message, /404/);
            assert.equal(rec.own.error.code, null);
        });

        it("getCloseFriends: GET {profile}/friend/getclosedfriends with no params (the Web's form)", async () => {
            const rec = await check("getCloseFriends", "getCloseFriends", [], { reply: [] });
            const [req] = rec.own.requests;
            assert.equal(req.path, "/api/social/friend/getclosedfriends");
            assert.deepEqual(req.queryOrder, ["zpw_ver", "zpw_type"]);
            assert.equal(req.params, null);
        });

        it("parseOnlineStatuses leaves a reply without an onlines list alone", () => {
            assert.equal(parseOnlineStatuses(null), null);
            assert.deepEqual(parseOnlineStatuses({ onlines: "x" }), { onlines: "x" });
            assert.deepEqual(parseOnlineStatuses({ onlines: [{ status: "{bad" }] }), { onlines: [{ status: "{bad" }] });
        });
    });

    describe("friend extras (spec-sweep 1.2)", () => {
        for (const [method, args, verb, service, path, params] of [
            ["removeFriend", [PEER], "POST", "friend", "/api/friend/remove", { fid: PEER, imei: FAKE.imei }],
            ["blockUser", [PEER], "POST", "friend", "/api/friend/block", { fid: PEER, imei: FAKE.imei }],
            ["unblockUser", [PEER], "POST", "friend", "/api/friend/unblock", { fid: PEER, imei: FAKE.imei }],
            // A GET: the Web method's body is `this._get(..., 12090)` (@11684243). spec-sweep's verb column said
            // post by its 400-character heuristic, which read the next method's `_post`.
            [
                "lastOnline",
                [PEER],
                "GET",
                "profile",
                "/api/social/profile/lastOnline",
                { uid: PEER, conv_type: 1, imei: FAKE.imei },
            ],
            ["getBizAccount", [PEER], "POST", "profile", "/api/social/friend/get-bizacc", { fid: PEER }],
            [
                "getRelatedFriendGroup",
                [[PEER, PEER2]],
                "POST",
                "friend",
                "/api/friend/group/related",
                // Red if the ids lost their digits or stopped being a JSON string.
                { friend_ids: `["${PEER}","${PEER2}"]`, imei: FAKE.imei },
            ],
            ["getQR", [[PEER, PEER2]], "POST", "friend", "/api/friend/mget-qr", { fids: [PEER, PEER2] }],
            [
                "blockViewFeed",
                [true, PEER],
                "POST",
                "friend",
                "/api/friend/feed/block",
                { fid: PEER, isBlockFeed: 1, imei: FAKE.imei },
            ],
            [
                "getMultiUsersByPhones",
                [[PHONE, "84987654321"]],
                "GET",
                "friend",
                "/api/friend/profile/multiget",
                { phones: ["84901234567", "84987654321"], avatar_size: 240, language: "vi" },
            ],
        ]) {
            it(`${method}: ${verb} {${service}}${path}`, async () => {
                const reply = { [PEER]: { fake: 1 } };
                const rec = await check(method, method, args, { reply });
                const [req] = rec.own.requests;
                assert.equal(req.method, verb);
                assert.equal(req.service, service);
                assert.equal(req.path, path);
                assert.deepEqual(req.params, params);
                assert.deepEqual(rec.own.result, reply);
            });
        }

        it("blockViewFeed(false) shows the feed again: isBlockFeed 0", async () => {
            const rec = await check("blockViewFeed/unblock", "blockViewFeed", [false, PEER], { reply: "" });
            assert.equal(rec.own.requests[0].params.isBlockFeed, 0);
        });

        it("getQR, getRelatedFriendGroup and getMultiUsersByPhones take one id or phone as a list of one", async () => {
            for (const [method, arg, key, want] of [
                ["getQR", PEER, "fids", [PEER]],
                ["getRelatedFriendGroup", PEER, "friend_ids", JSON.stringify([PEER])],
                ["getMultiUsersByPhones", PHONE, "phones", ["84901234567"]],
            ]) {
                const rec = await wire.run(method, [arg], { reply: {} });
                assert.deepEqual(rec.own.requests[0].params[key], want, method);
            }
        });

        it("getMultiUsersByPhones: 0 -> 84 whatever the session language", async () => {
            const rec = await withCtx({ language: "en" }, () =>
                check("getMultiUsersByPhones/lang-en", "getMultiUsersByPhones", [[PHONE]], { reply: {} }),
            );
            assert.deepEqual(rec.own.requests[0].params.phones, ["84901234567"]);
        });

        it("getMultiUsersByPhones with nothing: refused before any request", async () => {
            const rec = await check("getMultiUsersByPhones/missing", "getMultiUsersByPhones", [undefined], {
                reply: {},
            });
            assert.equal(rec.own.requests.length, 0);
            assert.deepEqual(rec.own.error, { message: "Missing phoneNumbers", code: null });
        });
    });

    describe("errors (part 3): the same code on both sides, the same text where zca-js has it", () => {
        /** One call per method, with arguments that reach the wire. */
        const CALLS = [
            ["getUserInfo", [PEER]],
            ["getAllFriends", []],
            ["findUser", [PHONE]],
            ["findUserByUsername", ["fake.user"]],
            ["getAliasList", [100, 1]],
            ["changeFriendAlias", ["n", PEER]],
            ["removeFriendAlias", [PEER]],
            ["sendFriendRequest", ["", PEER]],
            ["acceptFriendRequest", [PEER]],
            ["rejectFriendRequest", [PEER]],
            ["undoFriendRequest", [PEER]],
            ["getSentFriendRequest", []],
            ["getFriendRequestStatus", [PEER]],
            ["getFriendRecommendations", []],
            ["getFriendBoardList", [PEER]],
            ["getFriendOnlines", []],
            ["getCloseFriends", []],
            ["removeFriend", [PEER]],
            ["blockUser", [PEER]],
            ["unblockUser", [PEER]],
            ["lastOnline", [PEER]],
            ["getMultiUsersByPhones", [[PHONE]]],
            ["getQR", [[PEER]]],
            ["getRelatedFriendGroup", [[PEER]]],
            ["getBizAccount", [PEER]],
            ["blockViewFeed", [true, PEER]],
        ];

        it("every method of the module is in this list", () => {
            // Red when a method is added to peopleMethods without an error case here.
            const names = Object.keys(peopleMethods({ call: () => null, ctx: {} }));
            assert.deepEqual(CALLS.map(([n]) => n).sort(), names.sort());
        });

        for (const [method, args] of CALLS) {
            it(`${method}: outer, inner, HTTP 500, undecryptable`, async () => {
                for (const { label, error, expected } of ERROR_ANSWERS) {
                    const rec = await wire.run(method, args, { error });
                    const where = `${method} on ${label}`;
                    assert.deepEqual(rec.own.error, expected, where);
                    assert.equal(rec.own.requests.length, 1, `${where}: one request, no retry`);
                }
            });
        }
    });

    describe("the module", () => {
        it("webPhone turns only a leading 0 into 84", () => {
            assert.equal(webPhone("0901234567"), "84901234567");
            assert.equal(webPhone("84901234567"), "84901234567");
            assert.equal(webPhone("901234560"), "901234560");
        });
    });
});
