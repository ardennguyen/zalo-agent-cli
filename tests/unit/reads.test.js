/**
 * src/zalo/reads.js — the web client's read-only endpoints, checked at the wire.
 *
 * Each case drives `callRead` through zca-js's real `request()` into a stub fetch (`ctx.options.polyfill`, zca-js's own
 * HTTP seam) and checks what the stub received against what the web client's API module builds for the same call
 * (module `fBUP`, read from the 2026-10-23 bundle): the service-map host, the path, GET or POST, and the JSON that is
 * encrypted into `params` with the session key. The expected values are written out here by hand from that module, not
 * computed from the table under test.
 *
 * Keys, ids and hosts are throwaway constants (AGENTS.md §12). No socket, no session, no network.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    IMEI,
    SERVICE_KEYS,
    SESSION_KEY,
    decodeAES,
    harness,
    host,
    response,
    sessionOk,
    sent,
} from "../helpers/web-call.js";
import {
    READS,
    READ_NAMES,
    ReadError,
    ReadUsageError,
    buildRead,
    callRead,
    describeReads,
} from "../../src/zalo/reads.js";

// [name, args, host key, path, method, what the web client encrypts (null: no params)]
const CASES = [
    [
        "last-messages",
        { items: { u1: "m1" } },
        "conversation",
        "/api/preloadconvers/get-last-msgs",
        "GET",
        { threadIdLocalMsgId: '{"u1":"m1"}', imei: IMEI },
    ],
    [
        "last-seen",
        { group: ["g1"], oneone: ["u1"] },
        "chat",
        "/api/preloadconvers/get-last-seen",
        "GET",
        { param: '{"group":["g1"],"oneone":["u1"]}' },
    ],
    [
        "offline-check",
        { queueInfo: { q: 1 }, lastActId: "5", lastMsgId: "6" },
        "conversation",
        "/api/conv/cm/grOfl",
        "GET",
        { queueInfo: { q: 1 }, lastActId: "5", lastMsgId: "6" },
    ],
    [
        "last-seen-react",
        { group: [], oneone: ["u1"] },
        "reaction",
        "/api/react/gLastSn",
        "GET",
        { group: [], oneone: ["u1"] },
    ],
    [
        "message-status",
        { data: [{ tId: "u1" }] },
        "chat",
        "/api/message/getStatusMsg",
        "POST",
        { param: '{"data":[{"tId":"u1"}]}' },
    ],
    [
        "group-message-status",
        { data: [{ tId: "555", ids: ["m1"] }] },
        "group",
        "/api/group/getStatusMsg",
        "POST",
        { param: '{"data":[{"tId":"555","ids":["m1"]}]}' },
    ],
    [
        "important-messages",
        { uid: "u1", newestId: "99" },
        "chat",
        "/api/message/fetchImportant",
        "GET",
        { limit: 50, uid: "u1", newestId: "99" },
    ],
    [
        "important-messages",
        { uid: "u1" },
        "chat",
        "/api/message/fetchImportant",
        "GET",
        { limit: 50, uid: "u1", lastId: String(2n ** 63n - 1n) },
    ],
    [
        "important-messages",
        { uid: "u1", lastId: "7" },
        "chat",
        "/api/message/fetchImportant",
        "GET",
        { limit: 50, uid: "u1", lastId: "7" },
    ],
    ["recent-searches", { version: 3 }, "recent_search", "/api/recentsearch/list", "GET", { version: 3, imei: IMEI }],
    ["blocklist", {}, "friend", "/api/friend/blocklistv2", "GET", { page: 1, count: 50, avatar: 75 }],
    ["contact-tab-last-read", {}, "friend", "/api/friend/last-read-contact-tab", "GET", null],
    [
        "mini-profiles",
        { ids: ["u1", "u2"] },
        "profile",
        "/api/social/friend/getminiprofiles",
        "POST",
        { friend_ids: ["u1", "u2"], avatar_size: 160, incInvalid: 1, srcReq: -1 },
    ],
    [
        "friend-verify",
        { versions: ["u1_5"], phonebookVersion: 2 },
        "profile",
        "/api/social/friend/verify",
        "POST",
        { phonebook_version: 2, friend_pversion_map: ["u1_5"], avatar_size: 160, language: "vi", imei: IMEI },
    ],
    [
        "phonebook",
        { phonebookVersion: 4 },
        "profile",
        "/api/social/friend/phonebook/v2",
        "GET",
        { phonebook_version: 4 },
    ],
    ["friend-context", { ids: ["u1"] }, "friend", "/api/friend/context/multiget", "POST", { fids: ["u1"], imei: IMEI }],
    ["profile-extra", { id: "u1" }, "profile", "/api/social/profile/extra", "GET", { profile_id: "u1", imei: IMEI }],
    ["profile-rank", { id: "u1" }, "profile", "/api/social/profile/getrank", "GET", { profile_id: "u1", imei: IMEI }],
    [
        "aliases",
        { page: 2, count: 5 },
        "alias",
        "/api/alias/list/v2",
        "GET",
        { page: 2, count: 5, src: -1, imei: IMEI },
    ],
    ["noise-ids", { ids: ["u1"] }, "profile", "/api/gid/encrypt", "GET", { noiseUids: ["u1"] }],
    [
        "noised-uids",
        { friends: ["u1"], groups: ["g1"] },
        "profile",
        "/api/znoise",
        "GET",
        { fids: ["u1"], gids: ["g1"] },
    ],
    ["group-quota-community", {}, "group", "/api/group/quota/community", "GET", { language: "vi", grId: null }],
    [
        "group-quota-members",
        { groupId: "555", userId: "u1" },
        "group",
        "/api/group/quota/members-comm",
        "GET",
        { language: "vi", grId: "555", uid: "u1" },
    ],
    [
        "group-user-context",
        { groupIds: ["555"] },
        "group",
        "/api/group/userctx/multiget",
        "POST",
        { grids: ["555"], imei: IMEI },
    ],
    ["sticker-category", { cid: 12 }, "sticker", "/api/message/sticker/category/detail", "GET", { cid: 12 }],
    ["sticker-category", { cid: "12" }, "sticker", "/api/message/sticker/category/detail", "GET", { cid: 12 }],
    ["blocksharing-list", {}, "conversation", "/api/conv/blocksharing/getConvers", "GET", {}],
    ["sticker-personalized", {}, "sticker", "/api/message/sticker/personalized/list", "GET", { imei: IMEI }],
    ["sticker-keywords", {}, "sticker", "/api/message/sticker/suggest/keywords", "GET", { imei: IMEI }],
    ["sticker-tenor-map", {}, "sticker", "/api/message/sticker/tenor/mapping", "GET", { imei: IMEI }],
    ["sticker-hello", {}, "sticker", "/api/message/sticker/suggestion", "GET", { imei: IMEI }],
    ["sticker-effects", { effectIds: [1, "2"] }, "sticker", "/api/message/effects", "GET", { effect_ids: [1, 2] }],
    ["gif-categories", {}, "sticker", "/api/message/giphy/cates", "GET", { offset: 0, limit: 10 }],
    [
        "gif-trending",
        { offset: 10, limit: 5 },
        "sticker",
        "/api/message/giphy/trending",
        "GET",
        { offset: 10, limit: 5, imei: IMEI },
    ],
    [
        "gif-search",
        { keyword: "cat" },
        "sticker",
        "/api/message/giphy/search",
        "GET",
        { keyword: "cat", offset: 0, limit: 10 },
    ],
    ["todo-get", { id: "t1" }, "boards", "/api/board/personal/get", "GET", { id: "t1", imei: IMEI }],
    [
        "todo-list",
        {},
        "boards",
        "/api/board/personal/list",
        "GET",
        { scrollId: "", offset: 0, limit: 20, queries: [], type: 1 },
    ],
    [
        "todo-list",
        { type: "finished", limit: 5 },
        "boards",
        "/api/board/personal/list",
        "GET",
        { scrollId: "", offset: 0, limit: 5, queries: [], type: 2 },
    ],
    [
        "todo-verify",
        { lastUpdatedTime: 1700 },
        "boards",
        "/api/board/personal/todo/verify",
        "GET",
        { scrollId: "", lastUpdatedTime: 1700, imei: IMEI },
    ],
    [
        "pin-list",
        { groupId: "g555", boardVersion: 5 },
        "group_board",
        "/api/board/pin/list",
        "GET",
        { groupId: "555", boardVersion: 5, imei: IMEI },
    ],
    ["banner-info", {}, "banner", "/api/banner/v1/info", "GET", { imei: IMEI }],
    ["emoji-status-friends", {}, "emoji_stt", "/api/v1/emoji-status/friends", "GET", { imei: IMEI }],
    ["emoji-status-config", {}, "emoji_stt", "/api/v1/emoji-status/resource-config", "GET", { imei: IMEI }],
];

describe("reads — sandbox", () => {
    it("runs inside the test sandbox", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });
});

describe("each read goes out the way the web client's API module sends it", () => {
    for (const [name, args, key, path, method, body] of CASES) {
        it(`${name} ${JSON.stringify(args)}`, async () => {
            const h = harness();
            await callRead(h.api, name, args);
            assert.equal(h.calls.length, 1);
            const [c] = h.calls;
            assert.equal(c.origin, host(key));
            assert.equal(c.path, path);
            assert.equal(c.method, method);
            assert.equal(c.query.zpw_ver, "694");
            assert.equal(c.query.zpw_type, "30");
            if (body === null) {
                assert.equal(c.query.params, undefined, "this call carries no params");
                assert.equal(c.form, null);
            } else if (typeof body === "string") {
                assert.equal(decodeAES(SESSION_KEY, c.query.params), body);
            } else {
                assert.deepEqual(sent(c), body);
            }
        });
    }

    it("covers every read in the table (a new read needs a case)", () => {
        const covered = new Set(CASES.map((c) => c[0]));
        const missing = [...READ_NAMES.filter((n) => !covered.has(n))].filter(
            (n) => !["check-update", "server-settings", "voice-transcript"].includes(n),
        );
        assert.deepEqual(missing, []);
    });

    it("voice-transcript is local: it reads what the listener recorded, sends nothing, and builds no request", async () => {
        const h = harness();
        const api = { ...h.api, getOwnId: () => "1000000000000000099" };
        const out = await callRead(api, "voice-transcript", {});
        assert.deepEqual(out, [], "nothing recorded yet for the sandbox account");
        assert.equal(h.calls.length, 0, "nothing was sent to Zalo");
        assert.equal(await callRead(api, "voice-transcript", { reqId: "nope" }), null);
        assert.throws(() => buildRead(h.api, "voice-transcript", {}), /local read/);
        assert.equal(READS["voice-transcript"].host, "local");
    });

    it("check-update is a plain unencrypted query on the auth host", async () => {
        const h = harness();
        await callRead(h.api, "check-update");
        const [c] = h.calls;
        assert.equal(c.origin, "https://wpa.chat.zalo.me");
        assert.equal(c.path, "/api/login/chkUpdate");
        assert.equal(c.method, "GET");
        assert.equal(c.query.imei, IMEI);
        assert.equal(c.query.type, "30");
        assert.equal(c.query.client_version, "694");
        assert.equal(c.query.params, undefined);
    });

    it("server-settings is a GET on the auth host with no params", async () => {
        const h = harness();
        await callRead(h.api, "server-settings");
        const [c] = h.calls;
        assert.equal(c.origin, "https://wpa.chat.zalo.me");
        assert.equal(c.path, "/api/login/setting");
        assert.equal(c.query.params, undefined);
    });
});

describe("what a read returns and refuses", () => {
    it("reads a plain reply of the login host as it is, with no decryption", async () => {
        const h = harness(() =>
            response({ error_code: 0, error_message: "Successful.", data: { seasonalEffect: { type: 3 } } }),
        );
        assert.deepEqual(await callRead(h.api, "server-settings"), { seasonalEffect: { type: 3 } });
    });

    it("takes 1001 from check-update as an answer (no update information), and any other code as an error", async () => {
        const none = harness(() => response({ error_code: 1001, error_message: "Item not found", data: null }));
        assert.equal(await callRead(none.api, "check-update"), null);
        const bad = harness(() => response({ error_code: 7, error_message: "refused", data: null }));
        const e = await callRead(bad.api, "check-update").catch((err) => err);
        assert.ok(e instanceof ReadError);
        assert.equal(e.code, 7);
        const other = harness(() => response({ error_code: 1001, error_message: "Item not found", data: null }));
        const e2 = await callRead(other.api, "server-settings").catch((err) => err);
        assert.ok(e2 instanceof ReadError, "1001 is only an answer where the table says so");
    });

    it("returns the reply's data, decrypted with the session key", async () => {
        const h = harness(() => sessionOk({ items: [1, 2, 3] }));
        assert.deepEqual(await callRead(h.api, "blocklist"), { items: [1, 2, 3] });
    });

    it("fails with Zalo's own error when the reply is one", async () => {
        const h = harness(() => response({ error_code: 114, error_message: "no way" }));
        const e = await callRead(h.api, "blocklist").catch((err) => err);
        assert.ok(e instanceof Error);
        assert.match(e.message, /no way/);
    });

    it("refuses an unknown read, and a missing argument, before sending anything", async () => {
        const h = harness();
        await assert.rejects(callRead(h.api, "no-such-read"), ReadUsageError);
        await assert.rejects(callRead(h.api, "profile-extra", {}), /needs "id"/);
        await assert.rejects(callRead(h.api, "last-messages", {}), /needs "items"/);
        await assert.rejects(callRead(h.api, "gif-search", { keyword: "" }), /needs "keyword"/);
        assert.equal(h.calls.length, 0);
    });

    it("says when the account's service map lacks the host", async () => {
        const h = harness();
        delete h.api.zpwServiceMap.boards;
        await assert.rejects(callRead(h.api, "todo-get", { id: "t1" }), /no "boards" host/);
        assert.equal(h.calls.length, 0);
    });

    it("buildRead shows the request without sending it", () => {
        const h = harness();
        const r = buildRead(h.api, "profile-rank", { id: "u1" });
        assert.equal(r.method, "GET");
        assert.match(r.url, /api\/social\/profile\/getrank/);
        assert.equal(h.calls.length, 0);
    });
});

describe("the table", () => {
    it("is read-only: no path of it names a state change", () => {
        const writes =
            /\/(update|remove|delete|create|send|seen|delivered|undo|manage|kickout|submit|add|accept|reject|logout|upload)\b/i;
        for (const [name, d] of Object.entries(READS)) {
            assert.doesNotMatch(d.path, writes, `${name} (${d.path}) looks like a write`);
            assert.ok(["get", "post", "query", undefined].includes(d.method), name);
        }
    });

    it("names only hosts the service map has, and documents every argument it requires", () => {
        for (const [name, d] of Object.entries(READS)) {
            assert.ok(d.host === "auth" || d.host === "local" || SERVICE_KEYS.has(d.host), `${name}: host ${d.host}`);
            assert.ok(d.what.length > 10, `${name} says what it is`);
            for (const a of d.args) assert.ok(a.desc.length > 3, `${name}.${a.name} is described`);
        }
    });

    it("describes itself for a person or an agent", () => {
        const all = describeReads();
        assert.equal(all.length, READ_NAMES.length);
        const rank = all.find((r) => r.name === "profile-rank");
        assert.deepEqual(rank.args, [{ name: "id", type: "string", required: true, desc: "user id" }]);
        assert.equal(rank.verified, true);
        assert.equal(all.find((r) => r.name === "todo-list").verified, false);
    });
});
