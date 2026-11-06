/**
 * The build-week switch of src/zalo/api.js (design 2): which engine answers each name, and the proof that zca-js
 * runs on the context our kernel builds (design 4.4). If zca-js could not run on our context, the zca side of every
 * area's differential test would be lost; these tests are where that would show first.
 */
import "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CookieJar } from "tough-cookie";
import { LoginQRCallbackEventType, MuteAction, ReportReason, ThreadType, UpdateLangAvailableLanguages } from "zca-js";
import { MUTE_ACTION, QR_EVENT, REPORT_REASON, THREAD_TYPE, UPDATE_LANG } from "../../src/zalo/enums.js";
import { createApi, engineFor } from "../../src/zalo/api.js";
import { CallUsageError } from "../../src/zalo/kernel/endpoint.js";
import { loginWithSession } from "../../src/zalo/login.js";
import { FAKE, FAKE_CREDENTIALS, installFakeZalo, serviceHost } from "./fake-zalo-session.js";

const WS = ["wss://ws.zalo.invalid/"];

describe("engineFor", () => {
    const ready = new Set(["getGroupInfo"]);

    it("answers a ready name from our code and everything else from zca-js when nothing is set", () => {
        assert.equal(engineFor("getGroupInfo", { env: {}, ready }), "own");
        assert.equal(engineFor("getAllGroups", { env: {}, ready }), "zca");
        assert.equal(engineFor("listener", { env: {}, ready }), "zca");
    });

    it("ZALO_ENGINE=zca or own decides every name, the lists included", () => {
        const lists = { ZALO_ENGINE_OWN: "getAllGroups", ZALO_ENGINE_ZCA: "getGroupInfo" };
        for (const name of ["getGroupInfo", "getAllGroups", "listener"]) {
            assert.equal(engineFor(name, { env: { ...lists, ZALO_ENGINE: "zca" }, ready }), "zca", name);
            assert.equal(engineFor(name, { env: { ...lists, ZALO_ENGINE: "own" }, ready }), "own", name);
        }
    });

    it("the per-name lists override the ready sets, zca first, with spaces and empty entries ignored", () => {
        const env = { ZALO_ENGINE_ZCA: " getGroupInfo, ,x", ZALO_ENGINE_OWN: "getAllGroups,getGroupInfo" };
        assert.equal(engineFor("getGroupInfo", { env, ready }), "zca", "named in both: zca-js wins");
        assert.equal(engineFor("getAllGroups", { env, ready }), "own");
        assert.equal(engineFor("x", { env, ready }), "zca");
        assert.equal(engineFor("sendSeenEvent", { env, ready }), "zca");
    });

    it("a caller's engine beats the environment, and a value that is neither engine is refused", () => {
        assert.equal(engineFor("getAllGroups", { env: { ZALO_ENGINE: "zca" }, ready, engine: "own" }), "own");
        assert.throws(() => engineFor("x", { env: { ZALO_ENGINE: "ours" } }), /ZALO_ENGINE must be "own" or "zca"/);
    });
});

describe("createApi on one logged-in context", () => {
    let fake;
    let ctx;
    let map;

    before(async () => {
        fake = installFakeZalo();
        const api = await loginWithSession(structuredClone(FAKE_CREDENTIALS), {
            apiType: 30,
            apiVersion: 695,
            upkeep: false,
        });
        ctx = api.getContext();
        map = api.zpwServiceMap;
    });
    after(() => fake.uninstall());

    /** One fake area: a ready method, a not-ready method, and one that reads a host the map lacks. */
    function fakeArea() {
        const calls = [];
        const area = {
            name: "fake",
            ready: new Set(["getGroupInfo", "sendText"]),
            factories: [
                (s) => ({
                    getGroupInfo: async (id) => (calls.push(["getGroupInfo", id]), { own: true }),
                    getAllGroups: async () => (calls.push(["getAllGroups"]), { own: true }),
                    sendText: async (m, t, ty) => (calls.push(["sendText", m, t, ty]), { msgId: "own" }),
                    hostOf: (key) => s.host(key),
                    clientIds: () => [s.nextClientId(), s.nextClientId()],
                    uploads: () => s.uploads,
                }),
            ],
        };
        return { area, calls };
    }

    it("answers a ready name from our area and the rest from zca-js, by default", async () => {
        const { area, calls } = fakeArea();
        const api = await createApi(ctx, map, WS, { env: {}, areas: [area], listenerModule: null });
        assert.deepEqual(await api.getGroupInfo("fake-group"), { own: true });
        assert.deepEqual(calls, [["getGroupInfo", "fake-group"]]);
        // getAllGroups is ours too, but not ready: zca-js answers it, so it asks the fake server.
        fake.route("/api/group/getlg/v4", () => ({ gridVerMap: { 1: "0" } }));
        const before = fake.requests.length;
        const groups = await api.getAllGroups();
        assert.equal(calls.length, 1, "our not-ready getAllGroups was not called");
        assert.ok(fake.requests.length > before, "zca-js made the request");
        assert.deepEqual(groups.gridVerMap, { 1: "0" });
        // A zca-js-only name is there and is zca-js's function.
        assert.equal(typeof api.sendSeenEvent, "function");
        assert.equal(api.getOwnId(), String(FAKE.ownId));
        assert.equal(api.getContext(), ctx, "the same context object, not a copy");
        assert.equal(api.zpwServiceMap, map);
    });

    it("ZALO_ENGINE_ZCA puts a ready name back on zca-js, ZALO_ENGINE_OWN takes a not-ready one", async () => {
        const { area, calls } = fakeArea();
        const env = { ZALO_ENGINE_ZCA: "getGroupInfo", ZALO_ENGINE_OWN: "getAllGroups" };
        const api = await createApi(ctx, map, WS, { env, areas: [area], listenerModule: null });
        await api.getAllGroups();
        assert.deepEqual(calls, [["getAllGroups"]]);
        fake.route("/api/group/getmg-v2", () => ({ gridInfoMap: {} }));
        await api.getGroupInfo("fake-group");
        assert.deepEqual(calls, [["getAllGroups"]], "zca-js answered getGroupInfo");
    });

    it("ZALO_ENGINE=own: a name only zca-js has throws by name, and the listener refuses to start", async () => {
        const { area } = fakeArea();
        const api = await createApi(ctx, map, WS, { env: { ZALO_ENGINE: "own" }, areas: [area], listenerModule: null });
        await assert.rejects(api.sendSeenEvent([], 0), /sendSeenEvent is not in the own engine yet/);
        assert.deepEqual(await api.getAllGroups(), { own: true }, "ours, ready or not");
        assert.throws(() => api.listener.start(), /listener is not in the own engine yet/);
        await assert.rejects(
            api.sendMessage({ msg: "x", attachments: ["a.png"] }, "1", 0),
            /sendAttachments is not in the own engine yet/,
        );
    });

    it("composes sendMessage from the half it needs: text from our sendText when it is ready", async () => {
        const { area, calls } = fakeArea();
        const api = await createApi(ctx, map, WS, { env: {}, areas: [area], listenerModule: null });
        assert.deepEqual(await api.sendMessage({ msg: "hi" }, "1000000000000000001", 0), { msgId: "own" });
        assert.deepEqual(calls, [["sendText", { msg: "hi" }, "1000000000000000001", 0]]);
        // Named in ZALO_ENGINE_ZCA, both halves go to zca-js, which sends the text itself.
        fake.route("/api/message/sms", () => ({ msgId: "9000000000000000009" }));
        const zcaApi = await createApi(ctx, map, WS, {
            env: { ZALO_ENGINE_ZCA: "sendMessage" },
            areas: [fakeArea().area],
            listenerModule: null,
        });
        const sent = await zcaApi.sendMessage({ msg: "hi" }, "1000000000000000001", 0);
        assert.equal(sent.message.msgId, "9000000000000000009");
        assert.equal(fake.calls("/api/message/sms").at(-1).params.message, "hi");
    });

    it("resolves hosts at call time: a missing key fails the one call, naming the key", async () => {
        const { area } = fakeArea();
        const api = await createApi(ctx, map, WS, { env: {}, areas: [area], listenerModule: null });
        assert.throws(
            () => api.hostOf("no_such_service"),
            (e) => e instanceof CallUsageError && /no_such_service/.test(e.message),
        );
        assert.equal(api.hostOf("chat"), `https://${serviceHost("chat")}`);
        assert.equal(
            api.hostOf(["no_such_service", "group"]),
            `https://${serviceHost("group")}`,
            "the first present key",
        );
        const ids = api.clientIds();
        assert.equal(ids[1], ids[0] + 1, "two client ids in one millisecond still differ");
        assert.equal(api.uploads(), ctx.uploadCallbacks);
    });

    it("uses our listener when its module says it is ready, and zca-js's otherwise", async () => {
        const ours = { createListener: (c, urls) => ({ mine: true, c, urls }), OWN_READY: new Set(["listener"]) };
        const a = await createApi(ctx, map, WS, { env: {}, areas: [], listenerModule: ours });
        assert.equal(a.listener.mine, true);
        assert.equal(a.listener.c, ctx);
        const b = await createApi(ctx, map, WS, {
            env: { ZALO_ENGINE_ZCA: "listener" },
            areas: [],
            listenerModule: ours,
        });
        assert.equal(b.listener.mine, undefined);
        assert.equal(typeof b.listener.start, "function");
    });

    describe("zca-js on our context (design 4.4)", () => {
        it("both engines answer on one context: the same cookie, imei and session key reach the server", async () => {
            fake.rawRoute(
                (r) => r.path === "/keepalive",
                () => new Response(JSON.stringify({ error_code: 0, data: { config_vesion: 3 } }), { status: 200 }),
            );
            const own = await createApi(ctx, map, WS, { engine: "own" });
            const zca = await createApi(ctx, map, WS, { engine: "zca" });
            const from = fake.requests.length;
            assert.deepEqual(await zca.keepAlive(), { config_vesion: 3 });
            assert.deepEqual(await own.keepAlive(), { config_vesion: 3 });
            const [z, o] = fake.requests.slice(from);
            assert.equal(z.headers.cookie, o.headers.cookie || "", "zca-js read our jar");
            assert.equal(z.query.params, o.query.params, "the same imei sealed with the same key");
            // A session call sealed by zca-js opens with our key, and its reply opens with zca-js's.
            fake.route("/api/social/profile/me-v2", () => ({ profile: { userId: "fake" } }));
            assert.deepEqual(await zca.fetchAccountInfo(), { profile: { userId: "fake" } });
        });

        it("zca-js's listener builds on our context: our jar gives it the cookie string", async () => {
            ctx.cookie.setCookieSync("zpw_sek=fake-listener; Domain=chat.zalo.me; Path=/", "https://chat.zalo.me/");
            const zca = await createApi(ctx, map, WS, { engine: "zca" });
            assert.match(zca.listener.cookie, /zpw_sek=fake-listener/);
            assert.equal(zca.listener.userAgent, ctx.userAgent);
        });

        it("zca-js's uploads and listener use our registry: a callback it registers is settled by ours", async () => {
            let got = null;
            ctx.uploadCallbacks.set("fake-file-1", (data) => (got = data));
            assert.equal(typeof ctx.uploadCallbacks.get("fake-file-1"), "function");
            assert.equal(
                ctx.uploadCallbacks.settle("fake-file-1", { url: "https://f.invalid/1", data: { x: 1 } }),
                true,
            );
            // zca-js's upload merges what its listener would pass, `{fileUrl, fileId}`, into its result; the
            // control itself (`data`) is for our waiters. Red if settle hands the callback `data` again.
            assert.deepEqual(got, { fileUrl: "https://f.invalid/1", fileId: "fake-file-1" });
            assert.equal(ctx.uploadCallbacks.has("fake-file-1"), false);
            // A settlement that arrives first is kept for the waiter that comes after it.
            ctx.uploadCallbacks.settle("fake-file-2", { url: "https://f.invalid/2", kind: "file_done", data: {} });
            const s = await ctx.uploadCallbacks.waitFor("fake-file-2", { timeoutMs: 1000 });
            assert.equal(s.url, "https://f.invalid/2");
            await assert.rejects(
                ctx.uploadCallbacks.waitFor("never", { timeoutMs: 20 }),
                (e) => e.code === "UPLOAD_TIMEOUT",
            );
        });

        it("the jar is the tough-cookie zca-js resolves: one copy, one class", () => {
            const zcaRequire = createRequire(createRequire(import.meta.url).resolve("zca-js"));
            const ourRequire = createRequire(
                fileURLToPath(new URL("../../src/zalo/kernel/cookies.js", import.meta.url)),
            );
            assert.equal(ourRequire.resolve("tough-cookie"), zcaRequire.resolve("tough-cookie"));
            assert.ok(ctx.cookie instanceof zcaRequire("tough-cookie").CookieJar);
            assert.ok(ctx.cookie instanceof CookieJar);
        });

        it("keeps zca-js quiet: logging is off on the context, so nothing it does reaches stdout", () => {
            assert.equal(ctx.options.logging, false);
        });
    });
});

describe("the enums the engine moves onto (src/zalo/enums.js)", () => {
    it("carry zca-js's numbers, which are what the wire and the QR events use", () => {
        assert.deepEqual(THREAD_TYPE, { USER: ThreadType.User, GROUP: ThreadType.Group });
        assert.deepEqual(MUTE_ACTION, { MUTE: MuteAction.MUTE, UNMUTE: MuteAction.UNMUTE });
        assert.deepEqual(REPORT_REASON, {
            OTHER: ReportReason.Other,
            SENSITIVE: ReportReason.Sensitive,
            ANNOY: ReportReason.Annoy,
            FRAUD: ReportReason.Fraud,
        });
        assert.deepEqual(UPDATE_LANG, { VI: UpdateLangAvailableLanguages.VI, EN: UpdateLangAvailableLanguages.EN });
        assert.deepEqual(QR_EVENT, {
            QR_GENERATED: LoginQRCallbackEventType.QRCodeGenerated,
            QR_EXPIRED: LoginQRCallbackEventType.QRCodeExpired,
            QR_SCANNED: LoginQRCallbackEventType.QRCodeScanned,
            QR_DECLINED: LoginQRCallbackEventType.QRCodeDeclined,
            GOT_LOGIN_INFO: LoginQRCallbackEventType.GotLoginInfo,
        });
        for (const e of [THREAD_TYPE, MUTE_ACTION, REPORT_REASON, UPDATE_LANG, QR_EVENT]) assert.ok(Object.isFrozen(e));
    });
});
