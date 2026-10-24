/**
 * The request side of a transfer sync (src/core/sync-v2/channel.js, plan items Y4a, Y6a, Y6b, Y7), against the
 * fake Zalo's real WebSocket: the `590` request with its acknowledgement, the retry rules, the counters, the
 * release with its reason, the late release, and the sessions written down for the next run to clean.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { decodeFrame } from "../../src/core/sync-v2/index.js";
import {
    CLIENT_NOT_SUPPORTED,
    REQUEST_FAILURE,
    SyncRequestError,
    createSessionStore,
    createSyncChannel,
    readAck,
} from "../../src/core/sync-v2/channel.js";
import { DISPOSE_REASON } from "../../src/core/sync-v2/transfer.js";
import { assertConforms, diffBody } from "../helpers/replay/replay.js";
import { WEB_FRAMES } from "../helpers/replay/shapes.js";
import { ok, startFakeZalo } from "../helpers/fake-zalo/index.js";

const decode = (p) => decodeFrame(p, undefined);
const REQ = { type: "message", priority: 2, queries: [{}], batchSize: 2000 };
const send = (channel, syncId, kind = "msg") =>
    channel.request({ kind, syncId, ek: "ek", ik: "ik", req: REQ, deviceName: "zalo-agent-cli" });

describe("the sync channel", () => {
    let zalo;
    let api;
    let channel;
    let dir;
    const sleeps = [];

    before(() => assertSandboxed(CONFIG_DIR));

    beforeEach(async () => {
        process.env.ZALO_JSON_MODE = "1";
        mkdirSync(CONFIG_DIR, { recursive: true });
        dir = mkdtempSync(join(CONFIG_DIR, "chan-"));
        sleeps.length = 0;
        zalo = await startFakeZalo();
        api = await zalo.login();
    });

    afterEach(async () => {
        if (api?.listener?.ws) {
            api.listener.on("error", () => {});
            api.listener.stop();
        }
        await zalo.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    /** Connect the listener and build a channel whose acks come from the real socket. */
    async function open(over = {}) {
        let n = 0;
        const connected = once(api.listener, "connected");
        api.listener.start();
        await connected;
        channel = createSyncChannel({
            getListener: () => api.listener,
            decode,
            sleep: async (ms) => void sleeps.push(ms),
            nextReqId: () => `req_${++n}`,
            ackTimeoutMs: 400,
            disposeAckMs: 400,
            ...over,
        });
        api.listener.ws.on("message", (buf) => channel.handleFrame(buf));
        return channel;
    }

    /** Make the fake answer every 590 and 591 with `ack(frame)`; returns what it received. */
    function answer(ack) {
        const got = { req: [], disp: [] };
        for (const [cmd, into] of [
            [590, got.req],
            [591, got.disp],
        ]) {
            zalo.sock.respond(cmd, 0, (frame) => {
                into.push(frame.data);
                const out = ack(frame.data, into.length);
                return out === null ? undefined : out;
            });
        }
        return got;
    }
    const ackWith =
        (err = 0) =>
        (data) =>
            ok({ reqId: data.reqId, err, ts: 1 });

    describe("a request", () => {
        it("goes out in the official shape, with one reqId counter and a ussidx that counts from 0", async () => {
            const got = answer(ackWith(0));
            await open();
            await send(channel, "sync-a");
            await send(channel, "sync-b");
            await send(channel, "sync-c");
            assert.deepEqual(
                got.req.map((f) => f.reqId),
                ["req_1", "req_2", "req_3"],
            );
            assert.deepEqual(
                got.req.map((f) => f.data.ussidx),
                [0, 1, 2],
            );
            assert.equal(got.req[0].data.deviceName, "zalo-agent-cli");
            assertConforms(diffBody(got.req[0], WEB_FRAMES["590"], "590"), "the 590 request");
        });

        it("resolves with the ack, counting its attempts", async () => {
            answer(ackWith(0));
            await open();
            const r = await send(channel, "sync-a");
            assert.equal(r.attempts, 1);
            assert.equal(r.ts, 1);
        });

        it("is sent again after 1 s and 2 s while Zalo refuses it, then gives up with the code", async () => {
            const got = answer(ackWith(7));
            await open();
            await assert.rejects(
                send(channel, "sync-a"),
                (e) => e instanceof SyncRequestError && e.failure === REQUEST_FAILURE.REFUSED && e.code === 7,
            );
            assert.equal(got.req.length, 3);
            assert.deepEqual(sleeps, [1000, 2000]);
            assert.deepEqual(
                got.req.map((f) => f.reqId),
                ["req_1", "req_2", "req_3"],
                "each attempt has its own reqId, so a late ack of an old one is not taken for the new",
            );
            assert.equal(new Set(got.req.map((f) => f.data.syncId)).size, 1, "the same session each time");
            assert.equal(new Set(got.req.map((f) => f.data.ussidx)).size, 1, "and the same ussidx");
        });

        it("succeeds when a retry is accepted", async () => {
            const got = answer((data, n) => ok({ reqId: data.reqId, err: n < 2 ? 7 : 0, ts: 1 }));
            await open();
            const r = await send(channel, "sync-a");
            assert.equal(r.attempts, 2);
            assert.equal(got.req.length, 2);
        });

        it("is not retried on error 211: this client is not supported", async () => {
            const got = answer(ackWith(CLIENT_NOT_SUPPORTED));
            await open();
            await assert.rejects(
                send(channel, "sync-a"),
                (e) => e.failure === REQUEST_FAILURE.NOT_SUPPORTED && e.code === 211,
            );
            assert.equal(got.req.length, 1);
            assert.deepEqual(sleeps, []);
        });

        it("is not retried on a timeout: the answer may only be late", async () => {
            const got = answer(() => null);
            await open({ ackTimeoutMs: 80 });
            await assert.rejects(send(channel, "sync-a"), (e) => e.failure === REQUEST_FAILURE.TIMEOUT);
            assert.equal(got.req.length, 1);
        });

        it("reports a socket that closed while it waited as that, not as a timeout", async () => {
            answer(() => null);
            await open({ ackTimeoutMs: 2000 });
            const pending = send(channel, "sync-a");
            await zalo.sock.waitFor((f) => f.cmd === 590);
            zalo.sock.terminate();
            await assert.rejects(pending, (e) => e.failure === REQUEST_FAILURE.SOCKET_CLOSED);
        });

        it("ignores an ack for a request nobody is waiting for", async () => {
            await open();
            const frame = Buffer.concat([
                Buffer.from([1, 590 & 255, 590 >> 8, 0]),
                Buffer.from(JSON.stringify({ encrypt: 0, data: JSON.stringify(ok({ reqId: "req_99", err: 0 })) })),
            ]);
            assert.equal(channel.handleFrame(frame), false);
            assert.equal(channel.handleFrame(Buffer.from([1, 0, 0, 0])), false);
            assert.equal(channel.handleFrame("not a buffer"), false);
        });
    });

    describe("a release", () => {
        it("names its reason, is acknowledged, and forgets the session", async () => {
            const got = answer(ackWith(0));
            await open();
            await send(channel, "sync-a");
            assert.deepEqual(channel.open(), ["sync-a"]);
            const r = await channel.release("sync-a", DISPOSE_REASON.ERROR);
            assert.deepEqual(r, { acked: true });
            assert.equal(got.disp.length, 1);
            assert.deepEqual(got.disp[0].data, { syncId: "sync-a", toDevice: 0, reason: 2 });
            assertConforms(diffBody(got.disp[0], WEB_FRAMES["591"], "591"), "the 591 release");
            assert.match(got.disp[0].reqId, /^req_\d+$/);
            assert.deepEqual(channel.open(), []);
        });

        it("writes one log line per acknowledged release, naming its reason (Y13)", async () => {
            answer(ackWith(0));
            const lines = [];
            await open({ log: (m) => lines.push(m) });
            await send(channel, "abcdef-1");
            await send(channel, "ghijkl-2");
            await channel.release("abcdef-1", DISPOSE_REASON.SUCCESS);
            await channel.release("ghijkl-2", DISPOSE_REASON.ERROR);
            assert.deepEqual(
                lines.filter((l) => l.startsWith("released")),
                ["released sync session abcdef (finished)", "released sync session ghijkl (failed)"],
            );
        });

        it("defaults to 'finished' and does nothing for a session it does not know", async () => {
            const got = answer(ackWith(0));
            await open();
            await send(channel, "sync-a");
            await channel.release("sync-a");
            assert.equal(got.disp[0].data.reason, DISPOSE_REASON.SUCCESS);
            assert.deepEqual(await channel.release("never-seen"), { acked: false });
            assert.equal(got.disp.length, 1);
        });

        it("waits for the ack three times, 1 s and 2 s apart, and keeps the session when none comes", async () => {
            const got = answer((data) =>
                data.data?.reason === undefined ? ok({ reqId: data.reqId, err: 0 }) : ok({ reqId: data.reqId, err: 9 }),
            );
            await open();
            await send(channel, "sync-a");
            const r = await channel.release("sync-a", 1);
            assert.equal(r.acked, false);
            assert.equal(got.disp.length, 3);
            assert.deepEqual(sleeps, [1000, 2000]);
            assert.deepEqual(channel.open(), ["sync-a"], "an unacknowledged release leaves the session open");
        });

        it("releases a session whose request was still unanswered the moment the answer lands (late release)", async () => {
            const got = { req: [], disp: [] };
            zalo.sock.respond(590, 0, (frame) => {
                got.req.push(frame.data);
                return [{ cmd: 590, sub: 0, body: ok({ reqId: frame.data.reqId, err: 0, ts: 1 }), delayMs: 120 }];
            });
            zalo.sock.respond(591, 0, (frame) => {
                got.disp.push(frame.data);
                return ok({ reqId: frame.data.reqId, err: 0, ts: 1 });
            });
            await open({ ackTimeoutMs: 2000 });
            const pending = send(channel, "sync-a");
            await zalo.sock.waitFor((f) => f.cmd === 590);
            const early = await channel.release("sync-a", DISPOSE_REASON.CANCELLED);
            assert.deepEqual(early, { acked: false, late: true }, "nothing is sent while the request is unanswered");
            assert.equal(got.disp.length, 0);
            await pending;
            await zalo.sock.waitFor((f) => f.cmd === 591);
            assert.equal(got.disp.length, 1);
            assert.equal(got.disp[0].data.reason, DISPOSE_REASON.CANCELLED);
        });

        it("releaseAll gives each session its own reason, and counts the acknowledged", async () => {
            const got = answer(ackWith(0));
            await open();
            await send(channel, "sync-a");
            await send(channel, "sync-b");
            const n = await channel.releaseAll((id) => (id === "sync-b" ? DISPOSE_REASON.ERROR : undefined));
            assert.equal(n, 2);
            const byId = Object.fromEntries(got.disp.map((f) => [f.data.syncId, f.data.reason]));
            assert.deepEqual(byId, { "sync-a": 1, "sync-b": 2 });
        });
    });

    describe("sessions written down", () => {
        it("a request is recorded when it goes out and forgotten when its release is acknowledged", async () => {
            const file = join(dir, "sessions.json");
            answer(ackWith(0));
            await open({ store: createSessionStore(file) });
            const store = createSessionStore(file);
            await send(channel, "sync-a");
            assert.deepEqual(
                store.load().map((s) => s.syncId),
                ["sync-a"],
            );
            await channel.release("sync-a");
            assert.deepEqual(store.load(), []);
        });

        it("a request that timed out stays written down: the phone may have started it", async () => {
            const file = join(dir, "sessions.json");
            answer(() => null);
            await open({ store: createSessionStore(file), ackTimeoutMs: 60 });
            await assert.rejects(send(channel, "sync-a"));
            assert.deepEqual(
                createSessionStore(file)
                    .load()
                    .map((s) => s.syncId),
                ["sync-a"],
            );
        });

        it("the next run releases what the last one left, with reason 3 (outdated), before anything else", async () => {
            const file = join(dir, "sessions.json");
            createSessionStore(file).save([
                { syncId: "old-1", toDevice: 0 },
                { syncId: "old-2", toDevice: 0 },
            ]);
            const got = answer(ackWith(0));
            await open({ store: createSessionStore(file) });
            const n = await channel.cleanLeftovers();
            assert.equal(n, 2);
            assert.deepEqual(
                got.disp.map((f) => [f.data.syncId, f.data.reason]),
                [
                    ["old-1", 3],
                    ["old-2", 3],
                ],
            );
            assert.deepEqual(createSessionStore(file).load(), []);
        });

        it("a leftover that cannot be released is dropped from the file, not retried forever", async () => {
            const file = join(dir, "sessions.json");
            createSessionStore(file).save([{ syncId: "old-1", toDevice: 0 }]);
            answer(ackWith(9));
            await open({ store: createSessionStore(file) });
            await channel.cleanLeftovers();
            assert.deepEqual(createSessionStore(file).load(), []);
        });

        it("a missing or damaged file is no leftovers", () => {
            assert.deepEqual(createSessionStore(join(dir, "nothing.json")).load(), []);
        });
    });

    describe("readAck", () => {
        const frame = (cmd, body) =>
            Buffer.concat([
                Buffer.from([1, cmd & 255, cmd >> 8, 0]),
                Buffer.from(JSON.stringify({ encrypt: 0, data: JSON.stringify(body) })),
            ]);

        it("reads the reqId, err and ts of a 590 or 591 answer", () => {
            assert.deepEqual(readAck(frame(590, ok({ reqId: "req_4", err: 0, ts: 99 })), decode), {
                cmd: 590,
                reqId: "req_4",
                err: 0,
                ts: 99,
            });
            assert.equal(readAck(frame(591, ok({ reqId: "req_5", err: 3 })), decode).err, 3);
        });

        it("takes a top-level error as the err when the data carries none", () => {
            const body = { error_code: 211, error_message: "", data: { reqId: "req_6" } };
            assert.equal(readAck(frame(590, body), decode).err, 211);
        });

        it("is null for other commands, bodies without a reqId, and frames it cannot read", () => {
            assert.equal(readAck(frame(601, ok({ reqId: "req_1" })), decode), null);
            assert.equal(readAck(frame(590, ok({})), decode), null);
            assert.equal(readAck(Buffer.from([1, 78, 2, 0, 0x7b]), decode), null);
        });
    });
});
