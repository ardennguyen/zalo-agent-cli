/**
 * The session object `createApi` builds (src/zalo/api.js, design 1.3), and the surface the engine calls on it.
 *
 * `conv unread` called `getApi().markAsUnread(...)` for its whole life. No such method ever existed -- it is
 * `addUnreadMark` -- so the command died on "is not a function" before reaching the network, every time, and
 * nothing caught it: the offline suite never built a real session object, and the live suite only exercises the
 * commands someone thought to include. So this checks it statically: every `api.<name>(` and `getApi().<name>(`
 * the engine performs must be a function on the object `createApi` returns. Removing or renaming a method now
 * fails here rather than one command at runtime. (tests/unit/api-call-shapes.test.js checks that each call has the
 * shape the method declares.)
 *
 * Beside that, the object itself: the session's own members, the composed `sendMessage`, call-time hosts, one
 * client-id source per session, the listener, and no two areas defining one name.
 *
 * Every id here is fake.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { AREAS, createApi } from "../../src/zalo/api.js";
import { CallUsageError } from "../../src/zalo/kernel/endpoint.js";
import { Listener } from "../../src/zalo/listener/listener.js";
import { loginWithSession } from "../../src/zalo/login.js";
import { jsFiles } from "../helpers/api-call-sites.js";
import { FAKE, FAKE_CREDENTIALS, installFakeZalo, serviceHost } from "./fake-zalo-session.js";

const ROOT = join(import.meta.dirname, "..", "..");
const WS = ["wss://ws.zalo.invalid/"];

/**
 * Files whose local `api` is not the session object, each with the reason. The test fails if the reason stops
 * holding, so the list cannot hide a real call.
 */
const NOT_THE_SESSION = {
    "src/core/daemon-health.js": "its `api` is the health tracker it returns (`const api = {`)",
};

/** The session object on a context nothing calls through: every member, no network. */
function offlineApi() {
    return createApi({ uid: FAKE.ownId, uploadCallbacks: new Map() }, {}, WS, { createListener: () => null });
}

/** Every method name of the session object. */
function surface() {
    const api = offlineApi();
    return new Set(Object.keys(api).filter((k) => typeof api[k] === "function"));
}

/**
 * The parts of src/zalo that call the session object from outside it: the custom calls, the queues, transfer sync,
 * message text, receipts, zCloud and logout (they lived in src/core and src/utils before the layer took them).
 */
const ZALO_CALLERS = ["zalo/custom", "zalo/queues", "zalo/transfer-sync", "zalo/format"];
const ZALO_CALLER_FILES = [
    "zalo/receipts.js",
    "zalo/zcloud.js",
    "zalo/logout.js",
    "zalo/client.js",
    "zalo/listener/keepalive.js",
    "zalo/listener/socket-tap.js",
    "zalo/listener/reactions.js",
];

/**
 * Every `api.<name>(` and `getApi().<name>(` in src/commands, src/core, src/mcp, src/utils and the callers in
 * src/zalo, with where it is.
 */
function callSites() {
    const found = [];
    const files = [
        ...["commands", "core", "mcp", "utils", ...ZALO_CALLERS].flatMap((dir) => jsFiles(join(ROOT, "src", dir))),
        ...ZALO_CALLER_FILES.map((f) => join(ROOT, "src", f)),
    ];
    for (const file of files) {
        const rel = relative(ROOT, file).replace(/\\/g, "/");
        if (NOT_THE_SESSION[rel]) continue;
        readFileSync(file, "utf8")
            .split("\n")
            .forEach((line, i) => {
                for (const m of line.matchAll(/(?:\bapi|\bgetApi\(\))\s*\.\s*(\w+)\s*\(/g)) {
                    found.push({ name: m[1], where: `${rel}:${i + 1}` });
                }
            });
    }
    return found;
}

describe("api surface: what the engine calls", () => {
    it("has the session's own members and every area's methods, as ordinary own properties", () => {
        const api = offlineApi();
        for (const k of ["zpwServiceMap", "listener", "getContext", "getOwnId", "sendMessage", "keepAlive"]) {
            assert.ok(Object.hasOwn(api, k), `missing ${k}`);
        }
        const names = surface();
        // Red if the surface collapsed (an area not loaded): the engine calls well over a hundred methods.
        assert.ok(names.size > 140, `only ${names.size} methods`);
        for (const area of AREAS) {
            for (const factory of area.factories) {
                for (const name of Object.keys(factory({}))) assert.ok(names.has(name), `${area.name}: ${name}`);
            }
        }
    });

    it("every api.<method>( and getApi().<method>( in src/ names a method the session object has", () => {
        const names = surface();
        const calls = callSites();
        // Guards the guard: a scan that found nothing would pass vacuously.
        assert.ok(calls.length > 150, `expected many call sites, found ${calls.length}`);
        const bad = calls.filter((c) => !names.has(c.name));
        assert.deepEqual(
            bad,
            [],
            "these call a method the session object does not have:\n" +
                bad.map((b) => `  ${b.where} -> ${b.name}()`).join("\n"),
        );
    });

    it("each file excused from the scan still has its own `api`, for the stated reason", () => {
        for (const [file, why] of Object.entries(NOT_THE_SESSION)) {
            assert.match(readFileSync(join(ROOT, file), "utf8"), /\bconst api = \{/, `${file}: ${why}`);
        }
    });

    it("every send reports the client id it put on the wire, or is listed as no message", () => {
        // `msg undo` and `msg delete` need a message's cliMsgId, and only the sender ever saw it: a send that
        // mints a client id and returns only {msgId} produces a message that can be sent and never recalled
        // (tier 4 once left three such messages behind). Each send below has a case that compares the reported
        // cliMsgId with the clientId on the wire (wire-messages.test.js `reportsWireId`, wire-upload.test.js,
        // send-client-id.test.js). Red when a new send-like method appears without being put in one list or the
        // other, and when a listed name is no longer a method.
        const REPORTS_CLIENT_ID = [
            "sendMessage",
            "sendText",
            "sendAttachments",
            "sendCard",
            "sendSticker",
            "sendLink",
            "sendVoice",
            "sendVideo",
            "sendVideoFile",
            "sendBankCard",
        ];
        const NOT_A_MESSAGE = {
            sendTypingEvent: "a typing indicator is ephemeral and is never recalled",
            sendReport: "a report is not a message",
            sendFriendRequest: "a friend request is not a message and has no cliMsgId",
            uploadAttachment: "an upload step; sendAttachments reports the message",
            uploadProductPhoto: "an upload step, not a send",
        };
        const names = surface();
        const sendLike = [...names].filter((n) => /^(send|forward|upload)/.test(n)).sort();
        assert.deepEqual(sendLike, [...REPORTS_CLIENT_ID, ...Object.keys(NOT_A_MESSAGE)].sort());
    });

    it("does not call markAsUnread, which never existed", () => {
        // Named explicitly so the regression reads as itself in a failure.
        assert.deepEqual(
            callSites().filter((c) => c.name === "markAsUnread"),
            [],
        );
        assert.equal(surface().has("markAsUnread"), false);
    });
});

describe("api surface: the session object on a logged-in context", () => {
    let fake;
    let ctx;
    let map;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
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

    /** One fake area: a text half, an attachment half, and the session handle's helpers. */
    function fakeArea() {
        const calls = [];
        const area = {
            name: "fake",
            factories: [
                (s) => ({
                    sendText: async (m, t, ty) => (calls.push(["sendText", m, t, ty]), { msgId: "text" }),
                    sendAttachments: async (m, t, ty) => (calls.push(["sendAttachments", m, t, ty]), { msgId: "file" }),
                    hostOf: (key) => s.host(key),
                    clientIds: () => [s.nextClientId(), s.nextClientId()],
                    uploads: () => s.uploads,
                }),
            ],
        };
        return { area, calls };
    }

    it("is built on the context it is given: its own id, the same context, the login's service map", () => {
        const api = createApi(ctx, map, WS, { areas: [], createListener: () => null });
        assert.equal(api.getOwnId(), String(FAKE.ownId));
        assert.equal(typeof api.getOwnId(), "string");
        assert.equal(api.getContext(), ctx, "the same context object, not a copy");
        assert.equal(api.zpwServiceMap, map);
    });

    it("composes sendMessage: text to sendText, anything with attachments to sendAttachments", async () => {
        const { area, calls } = fakeArea();
        const api = createApi(ctx, map, WS, { areas: [area], createListener: () => null });
        assert.deepEqual(await api.sendMessage({ msg: "hi" }, "1000000000000000001", 0), { msgId: "text" });
        assert.deepEqual(await api.sendMessage("plain", "1000000000000000001", 1), { msgId: "text" });
        assert.deepEqual(await api.sendMessage({ msg: "", attachments: [] }, "1000000000000000001", 0), {
            msgId: "text",
        });
        assert.deepEqual(await api.sendMessage({ msg: "c", attachments: ["a.png"] }, "1000000000000000001", 1), {
            msgId: "file",
        });
        assert.deepEqual(await api.sendMessage({ attachments: "a.png" }, "1000000000000000001", 0), { msgId: "file" });
        assert.deepEqual(
            calls.map(([half, , , type]) => [half, type]),
            [
                ["sendText", 0],
                ["sendText", 1],
                ["sendText", 0],
                ["sendAttachments", 1],
                ["sendAttachments", 0],
            ],
        );
    });

    it("resolves hosts at call time: a missing key fails the one call, naming the key", () => {
        const { area } = fakeArea();
        const api = createApi(ctx, map, WS, { areas: [area], createListener: () => null });
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

    it("builds our listener by default, on the context and the socket URLs it is given", () => {
        const api = createApi(ctx, map, WS, { areas: [] });
        assert.ok(api.listener instanceof Listener);
        assert.deepEqual(api.listener.urls, WS);
        const seen = [];
        const injected = createApi(ctx, map, WS, {
            areas: [],
            createListener: (c, urls) => (seen.push([c, urls]), {}),
        });
        assert.deepEqual(seen, [[ctx, WS]]);
        assert.deepEqual(injected.listener, {});
    });

    it("refuses two areas that define one name, and an area that redefines the session's own", () => {
        const one = { name: "one", factories: [() => ({ dup: () => 1 })] };
        const two = { name: "two", factories: [() => ({ dup: () => 2 })] };
        assert.throws(
            () => createApi(ctx, map, WS, { areas: [one, two], createListener: () => null }),
            /dup is defined by two area modules/,
        );
        const rude = { name: "rude", factories: [() => ({ getOwnId: () => "x" })] };
        assert.throws(
            () => createApi(ctx, map, WS, { areas: [rude], createListener: () => null }),
            /getOwnId is the session's own/,
        );
        // The real areas, all together, define no name twice.
        assert.doesNotThrow(() => createApi(ctx, map, WS, { createListener: () => null }));
    });
});
