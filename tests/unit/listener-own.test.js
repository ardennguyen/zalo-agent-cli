/**
 * Our chat socket listener (src/zalo/listener/listener.js) on its own, over a real WebSocket to the fake Zalo socket
 * (tests/helpers/fake-zalo/socket.js): the lifecycle order the engine's 71 call sites depend on
 * (agent/docs/zca-replace/design.md 4.1, row L2; spec-listener 1.2 and 14), and the places where it follows Zalo Web
 * instead of zca-js.
 *
 * Every id is fake. The context is built by hand (no login), so each case controls the jar, the ping interval and
 * the clock.
 */
import "../helpers/sandbox.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { startFakeSocket } from "../helpers/fake-zalo/socket.js";
import { keyFrame, ok, serverFrame } from "../helpers/fake-zalo/frames.js";
import { createSession } from "../../src/zalo/kernel/session.js";
import { loadJar } from "../../src/zalo/kernel/cookies.js";
import { API_TYPE, DEFAULT_API_VERSION } from "../../src/zalo/profile.js";
import { createApi } from "../../src/zalo/api.js";
import {
    CLOSE_DUPLICATE,
    Listener,
    OWN_READY,
    cookieUrlOf,
    createListener,
    upgradeHeaders,
} from "../../src/zalo/listener/listener.js";

// Fake ids (tests/unit/no-real-ids.test.js): past 2^53 where an id would be.
const OWN = "1000000000000000001";
const PEER = "2000000000000000002";
const GROUP = "3000000000000000003";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred()` is truthy, or fail after `ms`. */
async function until(pred, what, ms = 2000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (pred()) return;
        await sleep(5);
    }
    assert.fail(`timed out waiting for ${what}`);
}

/** A logged-in context, by hand. */
function makeCtx({ pingInterval = 60000, sek = "fake-sek-1" } = {}) {
    const ctx = createSession({ apiType: API_TYPE, apiVersion: DEFAULT_API_VERSION, selfListen: true });
    ctx.cookie = loadJar([{ key: "zpw_sek", value: sek, domain: "chat.zalo.me", path: "/" }]);
    ctx.userAgent = UA;
    ctx.uid = OWN;
    ctx.settings = { features: { socket: { ping_interval: pingInterval } } };
    return ctx;
}

/** A 1-1 message as a 501 push carries it. */
const dm = (n, extra = {}) => ({
    msgId: `500000000000000000${n}`,
    cliMsgId: `170000000000${n}`,
    uidFrom: PEER,
    idTo: "0",
    dName: "Fake Peer",
    ts: "1700000000000",
    msgType: "webchat",
    content: `hello ${n}`,
    ...extra,
});

let rigs = [];

/**
 * A fake socket and our listener pointed at it, with every event recorded in order.
 *
 * @param {object} [o]
 * @param {object} [o.socket] - startFakeSocket options
 * @param {object} [o.ctx] - makeCtx options
 * @param {() => number} [o.now] - the listener's clock
 */
async function rig({ socket = {}, ctx: ctxOpts = {}, now } = {}) {
    const sock = await startFakeSocket(socket);
    const ctx = makeCtx(ctxOpts);
    const listener = createListener(ctx, [sock.url], now ? { now } : {});
    const events = [];
    const errors = [];
    for (const name of [
        "connected",
        "cipher_key",
        "disconnected",
        "closed",
        "message",
        "undo",
        "reaction",
        "old_messages",
        "old_reactions",
        "group_event",
        "friend_event",
        "typing",
        "upload_attachment",
        "delivered_messages",
        "seen_messages",
    ]) {
        listener.on(name, (...args) => events.push({ name, args, ws: listener.ws }));
    }
    listener.on("error", (e) => errors.push(e));
    const r = { sock, ctx, listener, events, errors, names: () => events.map((e) => e.name) };
    rigs.push(r);
    return r;
}

/** Start and wait for the handshake key. */
async function startKeyed(r) {
    const key = once(r.listener, "cipher_key");
    r.listener.start();
    await key;
}

afterEach(async () => {
    for (const r of rigs) {
        try {
            r.listener.stop();
        } catch {
            /* already stopped */
        }
        await r.sock.close();
    }
    rigs = [];
});

describe("listener module", () => {
    it("is what api.js loads: createListener and an OWN_READY set", async () => {
        assert.ok(OWN_READY instanceof Set);
        // api.js builds this listener for the own engine (and, once OWN_READY names it, by default).
        const api = await createApi(makeCtx(), {}, ["wss://ws1-msg.chat.zalo.me/"], { engine: "own", areas: [] });
        assert.ok(api.listener instanceof Listener, "api.js did not load src/zalo/listener/listener.js");
        const l = createListener(makeCtx(), ["wss://ws1-msg.chat.zalo.me/"]);
        assert.ok(l instanceof Listener);
        // The surface the engine reads, as own properties.
        for (const k of ["ws", "cipherKey", "urls", "wsURL", "pingInterval"]) assert.ok(Object.hasOwn(l, k), k);
        assert.equal(l.ws, null);
        assert.deepEqual(l.urls, ["wss://ws1-msg.chat.zalo.me/"]);
        // Web's order: the common query first, then the stamp.
        assert.match(l.wsURL, /^wss:\/\/ws1-msg\.chat\.zalo\.me\/\?zpw_ver=\d+&zpw_type=30&t=\d+$/);
    });

    it("refuses a second start while a socket exists, and a start without a jar", async () => {
        const r = await rig();
        r.listener.start();
        assert.throws(() => r.listener.start(), /Already started/);
        const bare = createListener({ ...makeCtx(), cookie: null }, [r.sock.url]);
        assert.throws(() => bare.start(), /Cookie/);
    });

    it("sendWs without a socket does nothing", () => {
        const l = createListener(makeCtx(), ["ws://127.0.0.1:1/"]);
        assert.doesNotThrow(() => l.sendWs({ version: 1, cmd: 510, subCmd: 1, data: {} }, false));
    });
});

describe("lifecycle order", () => {
    it("connected comes from the open, before the first frame: a tap added then sees the key frame", async () => {
        const r = await rig();
        const seen = [];
        r.listener.once("connected", () => {
            // What socket-tap.js and the supervisor do on `connected`.
            r.listener.ws.on("message", (buf) => seen.push({ cmd: buf.readUInt16LE(1), key: r.listener.cipherKey }));
        });
        await startKeyed(r);
        await until(() => seen.length > 0, "the tap to see a frame");
        // Red if `connected` fired after the key frame (the tap would miss it) ...
        assert.equal(seen[0].cmd, 1);
        // ... or if the key were set after the raw taps ran (self-heal and the tap read it from the listener).
        assert.equal(seen[0].key, r.sock.cipherKey);
        assert.deepEqual(r.names().slice(0, 2), ["connected", "cipher_key"]);
    });

    it("typed events come after every raw tap has seen their frame", async () => {
        const r = await rig();
        await startKeyed(r);
        const order = [];
        r.listener.ws.on("message", (buf) => buf.readUInt16LE(1) === 501 && order.push("tap"));
        r.listener.on("message", () => order.push("event"));
        r.sock.push(501, 0, ok({ msgs: [dm(1)] }));
        await until(() => order.length === 2, "the tap and the event");
        // Red if the listener emitted while the frame was still being delivered (its handler is registered first).
        assert.deepEqual(order, ["tap", "event"]);
    });

    it("ws is null before disconnected, and closed follows with the server's code and reason", async () => {
        const r = await rig();
        await startKeyed(r);
        const ws = r.listener.ws;
        r.sock.drop(undefined, 4001, "fake-reason");
        await until(() => r.names().includes("closed"), "closed");
        const disc = r.events.find((e) => e.name === "disconnected");
        const closed = r.events.find((e) => e.name === "closed");
        assert.equal(disc.ws, null, "ws was still set when disconnected fired");
        assert.deepEqual(disc.args, [4001, "fake-reason"]);
        assert.deepEqual(closed.args, [4001, "fake-reason"]);
        assert.ok(r.names().indexOf("disconnected") < r.names().indexOf("closed"));
        assert.equal(r.listener.cipherKey, undefined);
        assert.notEqual(ws, null);
    });

    it("stop() nulls ws, the key and the ping timer before it returns; disconnected and closed (1000) follow", async () => {
        const r = await rig({ ctx: { pingInterval: 50 } });
        await startKeyed(r);
        assert.ok(r.listener.pingInterval, "the listener pings by itself after the key");
        r.listener.stop();
        assert.equal(r.listener.ws, null);
        assert.equal(r.listener.cipherKey, undefined);
        assert.equal(r.listener.pingInterval, null);
        await until(() => r.names().includes("closed"), "closed");
        assert.deepEqual(r.events.find((e) => e.name === "disconnected").args[0], 1000);
        assert.deepEqual(r.events.find((e) => e.name === "closed").args[0], 1000);
        // A new start is allowed once stop() returned (no "Already started").
        r.listener.start();
        await r.sock.waitForConnection(2);
    });

    it("a kick frame (3000) closes the socket with 3000", async () => {
        const r = await rig();
        await startKeyed(r);
        assert.ok(r.sock.kick());
        await until(() => r.names().includes("closed"), "closed");
        assert.equal(r.events.find((e) => e.name === "closed").args[0], CLOSE_DUPLICATE);
    });

    it("ws.emit('message', buf, true) reaches the dispatcher; the same bytes as text do not", async () => {
        const r = await rig();
        await startKeyed(r);
        const frame = serverFrame(501, 0, ok({ msgs: [dm(2)] }));
        r.listener.ws.emit("message", frame, false);
        r.listener.ws.emit("message", frame); // no flag: what ws calls a text message
        await sleep(30);
        assert.equal(r.names().includes("message"), false, "a text frame was read");
        r.listener.ws.emit("message", frame, true); // what src/core/control-replay.js does
        await until(() => r.names().includes("message"), "the injected message");
        assert.equal(r.events.find((e) => e.name === "message").args[0].data.content, "hello 2");
    });

    it("ignores a real text frame without an error", async () => {
        const r = await rig();
        await startKeyed(r);
        assert.ok(r.sock.pushText(JSON.stringify({ encrypt: 0, data: "{}" })));
        r.sock.push(501, 0, ok({ msgs: [dm(3)] }));
        await until(() => r.names().includes("message"), "the binary message after it");
        assert.deepEqual(r.errors, []);
        assert.equal(r.names().filter((n) => n === "message").length, 1);
    });
});

describe("before the handshake", () => {
    it("queues sends until the key, in order, and never queues a ping", async () => {
        const r = await rig({ socket: { autoAuth: false } });
        const connected = once(r.listener, "connected");
        r.listener.start();
        await connected;
        r.listener.sendWs({ version: 1, cmd: 510, subCmd: 1, data: { first: true, reqId: "req_a" } }, false);
        r.listener.sendWs({ version: 1, cmd: 2, subCmd: 1, data: { eventId: 1 } }, false);
        r.listener.sendWs({ version: 1, cmd: 511, subCmd: 1, data: { first: true, reqId: "req_b" } }, false);
        await sleep(80);
        // Red if sends went out on an open socket before the server accepted the session (zca-js did).
        assert.deepEqual(r.sock.received, []);
        r.sock.pushRaw(keyFrame({ key: r.sock.cipherKey }));
        await r.sock.waitFor((f) => f.cmd === 511);
        // Red if the ping was held and sent late, or the order changed.
        assert.deepEqual(
            r.sock.received.map((f) => [f.cmd, f.data.reqId]),
            [
                [510, "req_a"],
                [511, "req_b"],
            ],
        );
    });

    it("holds frames that came before the key and reads them after it, sealed ones included", async () => {
        const r = await rig({ socket: { autoAuth: false } });
        const connected = once(r.listener, "connected");
        r.listener.start();
        await connected;
        r.sock.push(501, 0, ok({ msgs: [dm(4)] }));
        r.sock.pushEncrypted({ cmd: 501, encrypt: 2, body: ok({ msgs: [dm(5)] }) });
        await sleep(80);
        assert.equal(r.names().includes("message"), false);
        assert.deepEqual(r.errors, [], "a sealed frame was decoded without its key");
        r.sock.pushRaw(keyFrame({ key: r.sock.cipherKey }));
        await until(() => r.names().filter((n) => n === "message").length === 2, "both held messages");
        const contents = r.events.filter((e) => e.name === "message").map((e) => e.args[0].data.content);
        assert.deepEqual(contents, ["hello 4", "hello 5"]);
        assert.ok(r.names().indexOf("cipher_key") < r.names().indexOf("message"));
    });

    it("a handshake that refuses (a non-zero error_code in its data) gives no key and reports an error", async () => {
        const r = await rig({ socket: { autoAuth: false } });
        const connected = once(r.listener, "connected");
        r.listener.start();
        await connected;
        r.sock.push(1, 1, { error_code: 5007, error_message: "", data: {} }, { top: { key: r.sock.cipherKey } });
        await until(() => r.errors.length > 0, "the error");
        assert.match(r.errors[0].message, /5007/);
        assert.equal(r.listener.cipherKey, undefined);
        assert.equal(r.names().includes("cipher_key"), false);
    });
});

describe("ping", () => {
    it("pings on the server's interval while the echoes come", async () => {
        const r = await rig({ ctx: { pingInterval: 20 } });
        await startKeyed(r);
        await until(() => r.sock.framesOf(2, 1).length >= 3, "three pings");
    });

    it("sends no second ping while one is outstanding (Web's guard)", async () => {
        // A frozen clock: the outstanding ping never ages, so only its echo may let the next one go. Red if the
        // guard is removed (a ping on every 20 ms tick).
        const r = await rig({ socket: { autoPong: false }, ctx: { pingInterval: 20 }, now: () => 1_700_000_000_000 });
        await startKeyed(r);
        await r.sock.waitFor((f) => f.cmd === 2);
        await sleep(150);
        assert.equal(r.sock.framesOf(2, 1).length, 1);
        r.sock.setPong(true);
        // The echo of a ping sent from outside (the supervisor) clears the guard too.
        r.listener.sendWs({ version: 1, cmd: 2, subCmd: 1, data: { eventId: 7 } }, false);
        await until(() => r.sock.framesOf(2, 1).length >= 4, "pings to resume once echoes come");
    });

    it("has no interval of its own when the server names none, so the keepalive pings instead", async () => {
        const r = await rig({ ctx: { pingInterval: 0 } });
        await startKeyed(r);
        assert.equal(r.listener.pingInterval, null);
    });
});

describe("upgrade", () => {
    it("reads the cookie from the jar at every start, not once", async () => {
        const r = await rig({ ctx: { sek: "fake-sek-first" } });
        await startKeyed(r);
        assert.match(r.sock.connections[0].headers.cookie, /zpw_sek=fake-sek-first/);
        r.listener.stop();
        await until(() => r.names().includes("closed"), "closed");
        r.ctx.cookie.setCookieSync("zpw_sek=fake-sek-second; Domain=chat.zalo.me; Path=/", "https://chat.zalo.me/");
        await startKeyed(r);
        // Red if the cookie string were computed once, when the listener was built (zca-js did).
        assert.match(r.sock.connections[1].headers.cookie, /zpw_sek=fake-sek-second/);
    });

    it("sends a browser's headers: Pragma spelled right, the page's Origin, the client's User-Agent", async () => {
        const r = await rig();
        await startKeyed(r);
        const conn = r.sock.connections[0];
        const names = conn.rawHeaders.filter((_, i) => i % 2 === 0);
        assert.ok(names.includes("Pragma") && !names.includes("prgama"), `${names}`);
        assert.equal(conn.headers.pragma, "no-cache");
        assert.equal(conn.headers["cache-control"], "no-cache");
        assert.equal(conn.headers.origin, "https://chat.zalo.me");
        assert.equal(conn.headers["user-agent"], UA);
        assert.equal(conn.headers["accept-language"], upgradeHeaders({ userAgent: UA, cookie: "" })["Accept-Language"]);
        assert.match(conn.headers["sec-websocket-extensions"], /permessage-deflate/);
    });

    it("takes the cookies of the socket's own host when it is Zalo's, and the page's otherwise", () => {
        assert.equal(cookieUrlOf("wss://ws2-msg.chat.zalo.me/?t=1"), "https://ws2-msg.chat.zalo.me/");
        assert.equal(cookieUrlOf("ws://127.0.0.1:9/"), "https://chat.zalo.me/");
        assert.equal(cookieUrlOf("not a url"), "https://chat.zalo.me/");
    });

    it("stamps a fresh t at every start and keeps the rest of the query", async () => {
        let t = 1_700_000_000_000;
        const r = await rig({ now: () => t });
        r.listener.wsURL = `${r.sock.url}?zpw_ver=1&zpw_type=30&t=5`;
        t += 1000;
        r.listener.start();
        const conn = await r.sock.waitForConnection();
        const q = new URL(conn.url, "ws://x").searchParams;
        assert.equal(q.get("t"), String(t));
        assert.equal(q.get("zpw_ver"), "1");
    });
});

describe("frames Web reads differently", () => {
    it("does not decode a frame whose top-level error_code is not 0", async () => {
        const r = await rig();
        await startKeyed(r);
        r.sock.push(501, 0, ok({ msgs: [dm(6)] }), { top: { error_code: 102 } });
        await until(() => r.errors.length > 0, "the error");
        assert.equal(r.errors[0].code, 102);
        await sleep(20);
        assert.equal(r.names().includes("message"), false);
    });

    it("keeps the reactions after a malformed one", async () => {
        const r = await rig();
        await startKeyed(r);
        const good = {
            rMsg: [{ gMsgID: "6000000000000000006", cMsgID: "1", msgType: 1 }],
            rIcon: "/-strong",
            rType: 3,
        };
        r.sock.push(
            612,
            0,
            ok({
                reacts: [
                    { uidFrom: PEER, idTo: "0", ts: "1", content: "{not json" },
                    { uidFrom: PEER, idTo: "0", ts: "2", content: JSON.stringify(good) },
                ],
                reactGroups: [],
            }),
        );
        await until(() => r.names().includes("reaction"), "the good reaction");
        const reaction = r.events.find((e) => e.name === "reaction").args[0];
        assert.deepEqual(reaction.data.content, good);
        assert.equal(reaction.threadId, PEER);
        assert.equal(r.errors.length, 1);
    });

    it("reads group and page messages out of a 501, and messages out of a 504", async () => {
        const r = await rig();
        await startKeyed(r);
        r.sock.push(
            501,
            0,
            ok({ msgs: [dm(7)], groupMsgs: [dm(8, { idTo: GROUP })], pageMsgs: [dm(9, { uidFrom: PEER })] }),
        );
        r.sock.push(504, 0, ok({ msgs: [dm(1, { msgId: "5000000000000000010" })], delivereds: [], seens: [] }));
        await until(() => r.names().filter((n) => n === "message").length === 4, "four messages");
        const got = r.events
            .filter((e) => e.name === "message")
            .map((e) => [e.args[0].type, e.args[0].threadId, e.args[0].data.content]);
        assert.deepEqual(got, [
            [0, PEER, "hello 7"],
            [1, GROUP, "hello 8"],
            [0, PEER, "hello 9"],
            [0, PEER, "hello 1"],
        ]);
    });

    it("gives a recall its thread type: 0 in a 1-1 conversation, 1 in a group", async () => {
        const r = await rig();
        await startKeyed(r);
        const recall = { globalMsgId: "5000000000000000011", cliMsgId: "1", deleteMsg: 1 };
        r.sock.push(501, 0, ok({ msgs: [dm(1, { msgType: "chat.undo", content: recall })] }));
        r.sock.push(521, 0, ok({ groupMsgs: [dm(2, { idTo: GROUP, msgType: "chat.undo", content: recall })] }));
        await until(() => r.names().filter((n) => n === "undo").length === 2, "two recalls");
        const undos = r.events.filter((e) => e.name === "undo").map((e) => e.args[0]);
        assert.deepEqual(
            undos.map((u) => [u.type, u.isGroup, u.threadId]),
            [
                [0, false, PEER],
                [1, true, GROUP],
            ],
        );
    });

    it("keeps an end-to-end encrypted message's ciphertext out of its content, marked undecryptable", async () => {
        const r = await rig();
        await startKeyed(r);
        r.sock.push(551, 0, ok({ msgs: [dm(1, { msgType: "chat.e2ee.text", content: "fake-ciphertext" }), dm(2)] }));
        await until(() => r.names().filter((n) => n === "message").length === 2, "both messages");
        const [enc, plain] = r.events.filter((e) => e.name === "message").map((e) => e.args[0].data);
        assert.equal(enc.undecryptable, true);
        assert.equal(enc.content, "", "the ciphertext would be stored as the message text");
        assert.equal(plain.undecryptable, undefined);
        assert.equal(plain.content, "hello 2");
    });
});

describe("upload settlement (601)", () => {
    const fileDone = (fileId, url) => ({
        actionId: "1",
        controlId: "1",
        content: { act_type: "file_done", act: "file_done", fileId, data: { url } },
    });

    it("calls a callback registered the old way with {fileUrl, fileId}, removes it, then emits upload_attachment", async () => {
        const r = await rig();
        await startKeyed(r);
        let got = null;
        r.ctx.uploadCallbacks.set("9000001", (d) => (got = d));
        r.sock.push(601, 0, ok({ controls: [fileDone(9000001, "https://f.invalid/1")] }));
        await until(() => r.names().includes("upload_attachment"), "upload_attachment");
        assert.deepEqual(got, { fileUrl: "https://f.invalid/1", fileId: 9000001 });
        assert.equal(r.ctx.uploadCallbacks.has("9000001"), false);
        assert.deepEqual(r.events.find((e) => e.name === "upload_attachment").args[0], {
            fileUrl: "https://f.invalid/1",
            fileId: 9000001,
        });
    });

    it("settles the registry with the whole control as data, even when the 601 comes before the waiter", async () => {
        const r = await rig();
        await startKeyed(r);
        const control = fileDone("9000002", "https://f.invalid/2");
        r.sock.push(601, 0, ok({ controls: [control] }));
        await until(() => r.names().includes("upload_attachment"), "upload_attachment");
        // The waiter comes after the 601: zca-js lost such a settlement.
        const s = await r.ctx.uploadCallbacks.waitFor("9000002", { timeoutMs: 1000 });
        assert.equal(s.url, "https://f.invalid/2");
        assert.equal(s.kind, "file_done");
        assert.deepEqual(s.data, control);
    });

    it("settles the video and photo forms too, with their URLs", async () => {
        const r = await rig();
        await startKeyed(r);
        const photo = {
            content: { act_type: "photo_success", act: "photo", fileId: "9000004", data: JSON.stringify({ hd: "h" }) },
        };
        const video = { content: { act_type: "video_done", act: "video", fileId: "9000003", data: { url: "v" } } };
        r.sock.push(601, 0, ok({ controls: [video, photo] }));
        const [v, p] = await Promise.all([
            r.ctx.uploadCallbacks.waitFor("9000003", { timeoutMs: 1000 }),
            r.ctx.uploadCallbacks.waitFor("9000004", { timeoutMs: 1000 }),
        ]);
        assert.deepEqual([v.kind, v.url], ["video_done", "v"]);
        assert.deepEqual([p.kind, p.url], ["photo_success", "h"]);
    });
});
