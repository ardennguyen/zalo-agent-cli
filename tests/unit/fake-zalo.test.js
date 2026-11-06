/**
 * Self-tests of the fake Zalo (tests/helpers/fake-zalo): the thing every later
 * socket, retry and sync test stands on must itself be trusted first.
 *
 * Everything here runs through the REAL zca-js login and the REAL zca-js
 * listener, which dials the fake's WebSocket server over TCP on 127.0.0.1. Each
 * test says what it asserts on the wire, not what it read back from the fake.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { decodeFrame } from "../../src/core/sync-v2/index.js";
import {
    FAKE_CREDENTIALS,
    installQueuePulls,
    installTransferSync,
    ok,
    serverFrame,
    startFakeZalo,
} from "../helpers/fake-zalo/index.js";

/** A 590 request as the client sends it (the verified field set). */
function syncRequest(n, type = "message") {
    return {
        version: 1,
        cmd: 590,
        subCmd: 0,
        data: {
            data: {
                syncId: `sync-${n}`,
                syncType: 0,
                ek: "fake-ek",
                ik: "fake-ik",
                toDevice: 0,
                tempKey: "",
                deviceName: "fake-client",
                req: { type, priority: type === "conversation" ? 0 : 2, queries: [{}], batchSize: 2000 },
                ver: 1,
                ussidx: 0,
            },
            reqId: `req-${n}`,
        },
    };
}

describe("fake Zalo", () => {
    let zalo;
    let api;

    beforeEach(() => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        zalo = null;
        api = null;
    });

    afterEach(async () => {
        if (api?.listener?.ws) {
            // Teardown only: closing a socket that is still opening reports an error
            // nobody is waiting for. The tests above assert their own events.
            api.listener.on("error", () => {});
            api.listener.stop();
        }
        if (zalo) await zalo.stop();
    });

    describe("login and handshake", () => {
        it("hands out the socket's own URL, and the listener's upgrade carries the credentials we gave it", async () => {
            zalo = await startFakeZalo();
            api = await zalo.login();
            assert.ok(
                api.listener.wsURL.startsWith(zalo.sock.url),
                `wsURL ${api.listener.wsURL} is not the fake socket`,
            );

            const connected = once(api.listener, "connected");
            api.listener.start();
            const conn = await zalo.sock.waitForConnection();
            await connected;
            assert.equal(conn.headers.origin, "https://chat.zalo.me");
            assert.equal(conn.headers["user-agent"], FAKE_CREDENTIALS.userAgent);
            assert.match(conn.headers.cookie, /zpw_sek=offline-test-cookie/);
            const query = new URL(conn.url, "ws://x").searchParams;
            assert.equal(query.get("zpw_type"), "30");
            assert.ok(query.get("zpw_ver"), "no zpw_ver on the socket URL");
        });

        it("sends the key frame, and the listener takes its cipher key from it", async () => {
            zalo = await startFakeZalo();
            api = await zalo.login();
            const key = once(api.listener, "cipher_key");
            api.listener.start();
            const [cipher] = await key;
            assert.equal(typeof cipher, "string");
            assert.ok(Buffer.from(cipher, "base64").length === 32, "the key is not 32 bytes of base64");
        });

        it("can leave the key frame out, for a handshake that never completes", async () => {
            zalo = await startFakeZalo({ autoAuth: false });
            api = await zalo.login();
            let gotKey = false;
            api.listener.on("cipher_key", () => {
                gotKey = true;
            });
            const connected = once(api.listener, "connected");
            api.listener.start();
            await zalo.sock.waitForConnection();
            await connected;
            await new Promise((r) => setTimeout(r, 150));
            assert.equal(gotKey, false);
        });

        it("can start sending the key frame later: the next connection gets it", async () => {
            zalo = await startFakeZalo({ autoAuth: false });
            api = await zalo.login();
            let keys = 0;
            api.listener.on("cipher_key", () => keys++);
            let connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            await new Promise((r) => setTimeout(r, 100));
            assert.equal(keys, 0);
            const closed = once(api.listener, "closed");
            zalo.sock.drop(undefined, 1000);
            await closed;
            zalo.sock.setAutoAuth(true);
            connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            for (let i = 0; i < 100 && keys !== 1; i++) await new Promise((r) => setTimeout(r, 10));
            assert.equal(keys, 1, "the key frame did not come after setAutoAuth(true)");
        });

        it("makes getLoginInfo fail on request: zca-js refuses the session", async () => {
            zalo = await startFakeZalo({ loginError: { error_code: 70, error_message: "maintenance" } });
            await assert.rejects(zalo.login(), /Đăng nhập thất bại/);
            assert.equal(zalo.http.calls("/api/login/getLoginInfo").length, 1);
        });

        it("merges server settings over the defaults without losing the rest", async () => {
            zalo = await startFakeZalo({ settings: { features: { socket: { ping_interval: 55 } } } });
            api = await zalo.login();
            const socket = api.getContext().settings.features.socket;
            assert.equal(socket.ping_interval, 55);
            assert.deepEqual(socket.close_and_retry_codes, [], "an untouched setting was lost in the merge");
            assert.ok(api.getContext().settings.features.sharefile, "a sibling feature was lost in the merge");
        });
    });

    describe("ping", () => {
        it("echoes the client's ping at once, with the same eventId", async () => {
            zalo = await startFakeZalo({ settings: { features: { socket: { ping_interval: 30 } } } });
            api = await zalo.login();
            const connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            const seen = zalo.serverFrames(api.listener);
            const ping = await zalo.sock.waitFor((f) => f.cmd === 2 && f.sub === 1);
            const echo = await seen.waitFor((f) => f.cmd === 2 && f.sub === 1);
            const sentIds = zalo.sock.framesOf(2, 1).map((f) => f.data.eventId);
            assert.ok(ping.data.eventId > 0);
            assert.ok(sentIds.includes(echo.body.data.eventId), "the echo carries an eventId the client never sent");
        });

        it("stops echoing when told to, so a watchdog can be tested against silence", async () => {
            zalo = await startFakeZalo({ settings: { features: { socket: { ping_interval: 30 } } } });
            api = await zalo.login();
            const connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            zalo.sock.setPong(false);
            const seen = zalo.serverFrames(api.listener);
            await zalo.sock.waitFor((f) => f.cmd === 2 && f.sub === 1);
            await new Promise((r) => setTimeout(r, 150));
            assert.ok(zalo.sock.framesOf(2, 1).length >= 2, "the client stopped pinging");
            assert.equal(
                seen.frames.filter((f) => f.cmd === 2 && f.sub === 1).length,
                0,
                "the server echoed a ping while pong was off",
            );
        });
    });

    describe("ends of a connection", () => {
        it("a kick (cmd 3000) makes the real listener close with 3000", async () => {
            zalo = await startFakeZalo();
            api = await zalo.login();
            const connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            const conn = await zalo.sock.waitForConnection();
            const closed = once(api.listener, "closed");
            assert.equal(zalo.sock.kick(conn), true);
            const [code] = await closed;
            assert.equal(code, 3000);
            await zalo.sock.waitForClose(conn);
            assert.equal(conn.closeCode, 3000);
        });

        it("a server close carries its code and reason to the client", async () => {
            zalo = await startFakeZalo();
            api = await zalo.login();
            const connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            const disconnected = once(api.listener, "disconnected");
            zalo.sock.drop(undefined, 4001, "going away");
            const [code, reason] = await disconnected;
            assert.equal(code, 4001);
            assert.equal(String(reason), "going away");
        });

        it("an abrupt drop reads as 1006 on the client", async () => {
            zalo = await startFakeZalo();
            api = await zalo.login();
            const connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            const disconnected = once(api.listener, "disconnected");
            zalo.sock.terminate();
            const [code] = await disconnected;
            assert.equal(code, 1006);
        });

        it("accepts a second connection after the first ended", async () => {
            zalo = await startFakeZalo();
            api = await zalo.login();
            let connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            const first = await zalo.sock.waitForConnection(1);
            const closed = once(api.listener, "closed");
            zalo.sock.drop(first, 1000);
            await closed;
            connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            const second = await zalo.sock.waitForConnection(2);
            assert.notEqual(second.id, first.id);
        });
    });

    describe("queue pulls", () => {
        it("answers the old-message pull the real listener sends, and the listener turns it into an event", async () => {
            zalo = await startFakeZalo();
            installQueuePulls(zalo.sock);
            api = await zalo.login();
            const connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            const old = once(api.listener, "old_messages");
            api.listener.requestOldMessages(0, null);
            const [messages] = await old;
            assert.deepEqual(messages, []);
            const sent = zalo.sock.framesOf(510, 1).at(-1);
            // the Web's key (reqId), not zca-js's own (req_id): see src/zalo/pulls.js
            assert.deepEqual(Object.keys(sent.data).sort(), ["first", "lastId", "preIds", "reqId"]);
        });

        it("answers every connect-time pull with the verified queueStatus shape", async () => {
            zalo = await startFakeZalo();
            installQueuePulls(zalo.sock);
            api = await zalo.login();
            const connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            const seen = zalo.serverFrames(api.listener);
            const pulls = [
                [510, 1],
                [511, 1],
                [515, 0],
                [517, 0],
                [518, 0],
                [603, 1],
                [610, 1],
                [611, 1],
            ];
            for (const [cmd, sub] of pulls) {
                api.listener.sendWs({ version: 1, cmd, subCmd: sub, data: { first: true, lastId: null, preIds: [] } });
            }
            for (const [cmd, sub] of pulls) {
                const reply = await seen.waitFor((f) => f.cmd === cmd && f.sub === sub);
                const q = reply.body.data.queueStatus[`${cmd}_${sub}`];
                assert.deepEqual(Object.keys(q).sort(), ["evict", "ids", "lastId"], `${cmd}/${sub} queue entry`);
                assert.ok(Array.isArray(q.ids));
            }
            api.listener.sendWs({ version: 1, cmd: 537, subCmd: 0, data: { lastId: "0", maxItem: 50 } });
            const actions = await seen.waitFor((f) => f.cmd === 537);
            assert.deepEqual(actions.body.data, { hasMore: false, actions: [] });
        });
    });

    describe("transfer sync", () => {
        async function ready(opts) {
            zalo = await startFakeZalo();
            const sync = installTransferSync(zalo.sock, opts);
            api = await zalo.login();
            const connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            return { sync, seen: zalo.serverFrames(api.listener) };
        }
        const statusesOf = (seen) =>
            seen.frames
                .filter((f) => f.cmd === 601)
                .flatMap((f) => f.body.data.controls)
                .filter((c) => c.content.act === "transfer_status")
                .map((c) => c.content.data.status);

        it("a completed run: ack, statuses 3 then 4, batches, status 5, then dispose acks", async () => {
            const { sync, seen } = await ready({ outcome: "complete", batchesPerRequest: 2, expectedRequests: 2 });
            api.listener.sendWs(syncRequest(1, "conversation"), false);
            api.listener.sendWs(syncRequest(2), false);

            const ack = await seen.waitFor((f) => f.cmd === 590);
            assert.deepEqual(Object.keys(ack.body.data).sort(), ["err", "reqId", "ts"]);
            assert.equal(ack.body.data.err, 0);

            await seen.waitFor((f) => f.cmd === 601 && f.body.data.controls.some((c) => c.content.data.status === 5));
            assert.deepEqual(statusesOf(seen), [3, 4, 5]);

            const batches = seen.frames
                .filter((f) => f.cmd === 601)
                .flatMap((f) => f.body.data.controls)
                .filter((c) => c.content.act === "upload_batch")
                .map((c) => c.content.data);
            assert.equal(batches.length, 4, "two batches for each of the two requests");
            assert.deepEqual(
                batches.map((b) => [b.syncId, b.idx, b.isLast]),
                [
                    ["sync-1", 0, false],
                    ["sync-1", 1, true],
                    ["sync-2", 0, false],
                    ["sync-2", 1, true],
                ],
            );

            const reply = seen.frames.find((f) => f.cmd === 601);
            assert.deepEqual(Object.keys(reply.body.data.queueStatus).sort(), ["603_0", "603_1", "604_0"]);

            api.listener.sendWs(
                {
                    version: 1,
                    cmd: 591,
                    subCmd: 0,
                    data: { data: { syncId: "sync-1", toDevice: 0, reason: 1 }, reqId: "disp-1" },
                },
                false,
            );
            const disposeAck = await seen.waitFor((f) => f.cmd === 591);
            assert.equal(disposeAck.body.data.reqId, "disp-1");
            assert.deepEqual(sync.disposals, [{ syncId: "sync-1", reason: 1, reqId: "disp-1" }]);
            assert.deepEqual(
                sync.requests.map((r) => [r.syncId, r.type, r.priority]),
                [
                    ["sync-1", "conversation", 0],
                    ["sync-2", "message", 2],
                ],
            );
        });

        it("a declined run: statuses 3 then 6, no batches, and the dispose is still acknowledged", async () => {
            const { seen } = await ready({ outcome: "declined" });
            api.listener.sendWs(syncRequest(1, "conversation"), false);
            await seen.waitFor((f) => f.cmd === 601 && f.body.data.controls.some((c) => c.content.data.status === 6));
            api.listener.sendWs(
                {
                    version: 1,
                    cmd: 591,
                    subCmd: 0,
                    data: { data: { syncId: "sync-1", toDevice: 0, reason: 2 }, reqId: "disp-1" },
                },
                false,
            );
            await seen.waitFor((f) => f.cmd === 591);
            assert.deepEqual(statusesOf(seen), [3, 6]);
            const batches = seen.frames
                .filter((f) => f.cmd === 601)
                .flatMap((f) => f.body.data.controls)
                .filter((c) => c.content.act === "upload_batch");
            assert.equal(batches.length, 0);
        });

        it("a waiting run: status 3 and then silence", async () => {
            const { seen } = await ready({ outcome: "waiting" });
            api.listener.sendWs(syncRequest(1, "conversation"), false);
            await seen.waitFor((f) => f.cmd === 601);
            await new Promise((r) => setTimeout(r, 150));
            assert.deepEqual(statusesOf(seen), [3]);
        });

        it("an ack error means no progress frames at all", async () => {
            const { seen } = await ready({ outcome: "complete", ackError: 211 });
            api.listener.sendWs(syncRequest(1, "conversation"), false);
            const ack = await seen.waitFor((f) => f.cmd === 590);
            assert.equal(ack.body.data.err, 211);
            await new Promise((r) => setTimeout(r, 150));
            assert.equal(seen.frames.filter((f) => f.cmd === 601).length, 0);
        });
    });

    describe("sealed frames and the key frame", () => {
        /** A 1-1 message as a 501 push carries it; every id is fake. */
        const dm = (n) => ({
            msgId: `500000000000000000${n}`,
            cliMsgId: `170000000000${n}`,
            uidFrom: "2000000000000000002",
            idTo: "0",
            dName: "Fake Peer",
            ts: "1700000000000",
            msgType: "webchat",
            content: `sealed ${n}`,
        });

        /** Start the listener and collect the content of every `message` it emits. */
        async function listen() {
            const contents = [];
            api.listener.on("message", (m) => contents.push(m.data.content));
            const key = once(api.listener, "cipher_key");
            api.listener.start();
            const [cipher] = await key;
            return { contents, cipher };
        }

        /** Push one 501 per variant and wait for all of their messages. */
        async function pushVariants(contents) {
            const variants = [
                { encrypt: 0 },
                { encrypt: 1, zip: "zlib" },
                { encrypt: 1, zip: "gzip" },
                { encrypt: 2, zip: "zlib" },
                { encrypt: 2, zip: "gzip" },
                { encrypt: 3 },
            ];
            // One at a time: a listener decodes each frame asynchronously, and a frame that needs no inflate or
            // AES can overtake one that does, so pushed back to back their messages may arrive out of order.
            for (const [i, v] of variants.entries()) {
                assert.ok(zalo.sock.pushEncrypted({ cmd: 501, ...v, body: ok({ msgs: [dm(i)] }) }), "push refused");
                for (let t = 0; t < 200 && contents.length <= i; t++) await new Promise((r) => setTimeout(r, 10));
            }
            return variants.map((_, i) => `sealed ${i}`);
        }

        it("seals pushes as encrypt 1, 2 and 3 (zlib and gzip) under the 32-byte key the listener took", async () => {
            zalo = await startFakeZalo();
            api = await zalo.login();
            const { contents, cipher } = await listen();
            assert.equal(cipher, zalo.sock.cipherKey);
            assert.equal(Buffer.from(cipher, "base64").length, 32);
            // Red if a sealed frame does not open with the key the listener was handed: its message never comes.
            assert.deepEqual(contents, await pushVariants(contents));
        });

        it("hands out a 16-byte key when told to, and seals under it", async () => {
            zalo = await startFakeZalo();
            zalo.sock.setCipherKey(Buffer.alloc(16, 5).toString("base64"));
            api = await zalo.login();
            const { contents, cipher } = await listen();
            assert.equal(Buffer.from(cipher, "base64").length, 16);
            assert.deepEqual(contents, await pushVariants(contents));
        });

        it("sends the key frame with the handshake's queues sealed under its own key", async () => {
            const authData = {
                qCmds: [{ cmd: 510, subCmd: 1, queueName: "510_1" }],
                ctrl_qCmds: [{ cmd: 603, subCmd: 1, queueName: "603_1" }],
                bk_cmds: [],
            };
            zalo = await startFakeZalo();
            zalo.sock.setAuthData(authData);
            api = await zalo.login();
            const frames = [];
            // `connected` comes from the socket's open, before any frame: the key frame is the first one seen.
            api.listener.once("connected", () => api.listener.ws.on("message", (raw) => frames.push(Buffer.from(raw))));
            const { cipher } = await listen();
            const keyFrame = frames.find((f) => f.readUInt16LE(1) === 1 && f[3] === 1);
            assert.ok(keyFrame, "no cmd 1/1 frame reached the client");
            const top = JSON.parse(keyFrame.subarray(4).toString("utf8"));
            assert.equal(top.key, cipher);
            assert.equal(top.encrypt, 2);
            // Red if the queue lists were sent in the clear or under another key.
            assert.throws(() => JSON.parse(top.data));
            assert.deepEqual(decodeFrame(top, top.key), { error_code: 0, error_message: "", data: authData });
        });

        it("sends a text frame and raw bytes exactly as given, and keeps each client frame's bytes", async () => {
            zalo = await startFakeZalo();
            api = await zalo.login();
            const got = [];
            api.listener.once("connected", () =>
                api.listener.ws.on("message", (data, isBinary) => got.push({ data: Buffer.from(data), isBinary })),
            );
            await listen();
            const raw = serverFrame(9999, 7, ok({ x: 1 }));
            assert.ok(zalo.sock.pushText("not a frame"));
            assert.ok(zalo.sock.pushRaw(raw));
            for (let i = 0; i < 100 && got.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
            const text = got.find((g) => !g.isBinary);
            assert.equal(text?.data.toString("utf8"), "not a frame");
            assert.ok(
                got.some((g) => g.isBinary && g.data.equals(raw)),
                "the raw frame changed on the way",
            );

            api.listener.requestOldMessages(0, null);
            const pull = await zalo.sock.waitFor((f) => f.cmd === 510);
            assert.equal(pull.raw.readUInt16LE(1), 510);
            assert.deepEqual(JSON.parse(pull.raw.subarray(4).toString("utf8")), pull.data);
            assert.equal(Object.keys(pull).includes("raw"), false, "raw bytes must not clutter a printed frame");
        });

        it("records the upgrade's headers as sent: each name in its own spelling, with its value", async () => {
            zalo = await startFakeZalo();
            api = await zalo.login();
            await listen();
            const [conn] = zalo.sock.connections;
            assert.ok(conn.rawHeaders.length >= 2 && conn.rawHeaders.length % 2 === 0);
            for (let i = 0; i < conn.rawHeaders.length; i += 2) {
                const value = conn.headers[conn.rawHeaders[i].toLowerCase()];
                assert.ok(String(value).includes(conn.rawHeaders[i + 1]), `${conn.rawHeaders[i]} is not in headers`);
            }
        });
    });

    describe("waiting helpers", () => {
        it("time out with a message saying what was awaited", async () => {
            zalo = await startFakeZalo();
            await assert.rejects(
                zalo.sock.waitFor(() => false, 50),
                /timed out after 50 ms waiting for a matching client frame/,
            );
            await assert.rejects(zalo.sock.waitForConnection(1, 50), /connection #1/);
        });
    });
});
