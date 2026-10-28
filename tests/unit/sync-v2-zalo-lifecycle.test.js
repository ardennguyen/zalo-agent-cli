/**
 * How a restore treats its socket and its sessions, as Zalo's own clients do (Web and PC; the evidence and the
 * captures are in docs/agent-notes.md, "A restore the way Zalo's clients run it"):
 *
 *  - nothing is sent before the server's hello has been processed, and the first frame after it is a ping;
 *  - one ping per interval, not two;
 *  - a socket that dropped is reopened after a pause, and the first thing sent on the new one is the release, with
 *    reason 3, of every session the dead one left open, before any request, with sessions counted from 1 again;
 *  - sessions are requested up front in a wave, held until the wave is stored, and released together.
 *
 * Everything runs on the real zca-js listener against the fake Zalo's real WebSocket.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { getMessageById } from "../../src/core/db.js";
import { RECONNECT_DELAY_MS, connectListener, reconnectListener } from "../../src/commands/sync.js";
import { SyncV2 } from "../../src/core/sync-v2/index.js";
import { startKeepAlive } from "../../src/core/sync-v2/keepalive.js";
import { FAKE, installQueuePulls, startFakeZalo } from "../helpers/fake-zalo/index.js";
import { fakeCodecs, installFakePhone } from "../helpers/fake-zalo/phone.js";

const T = Date.UTC(2026, 9, 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUIET = { features: { socket: { ping_interval: 600_000 } } };

/** `n` one-message conversations, each served as a session of its own when the shards are one wide. */
const convs = (n) =>
    Array.from({ length: n }, (_, i) => ({
        id: `LIFE${i}`,
        kind: "oneone",
        lastTs: T + 1000 + i,
        messages: [{ id: `${5000 + i}`, text: `life ${i}`, ts: T + 1000 + i }],
    }));

describe("the socket: the hello first, then a ping", () => {
    let zalo = null;
    let api = null;

    before(() => assertSandboxed(CONFIG_DIR));

    afterEach(async () => {
        if (api?.listener?.ws) {
            api.listener.on("error", () => {});
            api.listener.stop();
        }
        if (zalo) await zalo.stop();
        zalo = api = null;
    });

    it("is not connected until the server's hello has been processed; nothing is sent before it, then one ping", async () => {
        zalo = await startFakeZalo({ autoAuth: false, settings: QUIET });
        api = await zalo.login();
        let settled = null;
        const pending = connectListener(api, 5000).then((v) => (settled = v));
        await zalo.sock.waitForConnection();
        await sleep(150);
        assert.equal(settled, null, "an open socket without the hello is not a connection");
        assert.equal(zalo.sock.received.length, 0, "nothing was sent before the hello");

        zalo.sock.push(1, 1, {}, { top: { key: "AAAAAAAAAAAAAAAAAAAAAA==" } });
        assert.deepEqual(await pending, { ok: true });
        await sleep(50);
        assert.deepEqual(
            zalo.sock.received.map((f) => [f.cmd, f.sub]),
            [[2, 1]],
            "the first frame after the hello is a ping, and the only one",
        );
    });

    it("waits at least two seconds before it reopens a socket, as Web does (2, 3, 5, 8 s)", () => {
        assert.ok(RECONNECT_DELAY_MS >= 2000, `the pause is ${RECONNECT_DELAY_MS} ms`);
    });

    it("waits the pause it is given before it opens the new socket", async () => {
        zalo = await startFakeZalo({ settings: QUIET });
        api = await zalo.login();
        assert.equal((await connectListener(api, 5000)).ok, true);
        zalo.sock.terminate();
        await zalo.sock.waitForClose(zalo.sock.connections[0]);
        const closedAt = Date.now();
        assert.equal(await reconnectListener(api, 5000, 300), true);
        const second = zalo.sock.connections[1];
        assert.ok(second.openedAt - closedAt >= 280, `the new socket opened ${second.openedAt - closedAt} ms after`);
    });
});

describe("the keepalive does not double the ping", () => {
    /** A listener stub and a scheduler that only fires when told. */
    function rig(listenerOver = {}) {
        const sent = [];
        let queued = null;
        const listener = {
            ws: { readyState: 1, on() {}, off() {} },
            sendWs: (p) => sent.push(p),
            ...listenerOver,
        };
        const timers = {
            setTimeout: (fn) => {
                queued = fn;
                return { unref() {} };
            },
            clearTimeout() {},
        };
        return { sent, listener, timers, fire: () => queued?.() };
    }

    it("on the default cadence, while zca-js is pinging on the server's interval, it only counts echoes", () => {
        const r = rig({ pingInterval: {} });
        const ka = startKeepAlive(r.listener, { timers: r.timers });
        r.fire();
        assert.equal(r.sent.length, 0, "zca-js already sent this interval's ping");
        assert.equal(ka.stats().sent, 0);
        ka.stop();
    });

    it("pings by itself when nothing else does, or when its caller asked for an interval of its own", () => {
        const alone = rig();
        const a = startKeepAlive(alone.listener, { timers: alone.timers });
        alone.fire();
        assert.equal(alone.sent.length, 1);
        a.stop();

        const own = rig({ pingInterval: {} });
        const b = startKeepAlive(own.listener, { timers: own.timers, intervalMs: 20_000 });
        own.fire();
        assert.equal(own.sent.length, 1);
        b.stop();
    });
});

describe("a restore the way Zalo's clients run it", () => {
    let zalo = null;
    let api = null;
    let n = 0;

    before(() => assertSandboxed(CONFIG_DIR));

    afterEach(async () => {
        if (api?.listener?.ws) {
            api.listener.on("error", () => {});
            api.listener.stop();
        }
        if (zalo) await zalo.stop();
        zalo = api = null;
    });

    /** Connect through the real helper, run the restore, report everything. */
    async function run(phoneOpts, { withPhone, ...restoreOpts } = {}) {
        zalo = await startFakeZalo({ settings: QUIET });
        installQueuePulls(zalo.sock);
        const phone = installFakePhone(zalo, phoneOpts);
        withPhone?.(phone);
        api = await zalo.login();
        const sync = new SyncV2(api, `${FAKE.ownId}${++n}-life`);
        assert.equal((await connectListener(api, 5000)).ok, true);
        const events = [];
        let result = null;
        let error = null;
        try {
            result = await sync.restore({
                codecs: fakeCodecs(),
                keepAlive: false,
                settleMs: 0,
                pollMs: 20,
                waitMs: 30_000,
                onStatus: (e) => events.push(e),
                ...restoreOpts,
            });
        } catch (e) {
            error = e;
        }
        return { result, error, events, phone };
    }

    it("holds a wave's sessions open until the whole wave is stored, then releases them together", async () => {
        // How many of the seven messages are stored at the moment the phone receives each release. Released one by
        // one as each shard was stored, the first release of a wave would come with one message of it stored.
        const storedAtRelease = [];
        const { result, error, phone } = await run(
            { conversations: convs(7) },
            {
                shardSize: 1,
                waveSize: 3,
                withPhone: (p) => {
                    const push = p.releases.push.bind(p.releases);
                    p.releases.push = (...r) => {
                        storedAtRelease.push(
                            Array.from({ length: 7 }, (_, i) => getMessageById(`${5000 + i}`)).filter(Boolean).length,
                        );
                        return push(...r);
                    };
                },
            },
        );
        assert.equal(error, null);
        assert.equal(result.reason, "complete");
        assert.equal(result.messagesSaved, 7);
        assert.deepEqual(
            storedAtRelease,
            [0, 3, 3, 3, 6, 6, 6, 7],
            "the conversation round's release, then each wave released only once all of its messages are stored",
        );
        assert.deepEqual(
            phone.order.map((o) => o.cmd),
            [590, 591, 590, 590, 590, 591, 591, 591, 590, 590, 590, 591, 591, 591, 590, 591],
            "the conversation round and its release, then three waves: all requests, then all releases",
        );
    });

    it("releases a wave's sessions one after the other, each after the previous ack (bursts were answered only in part)", async () => {
        const { result, error } = await run(
            { conversations: convs(10), releaseAckDelayMs: 40 },
            { shardSize: 1, waveSize: 10 },
        );
        assert.equal(error, null);
        assert.equal(result.reason, "complete");
        // The releases after the conversation round's: the phone takes 40 ms to answer, so a release that waited for the
        // previous ack goes out at least that long after it.
        const releases = zalo.sock.received.filter((f) => f.cmd === 591).slice(1);
        assert.equal(releases.length, 10);
        for (const [i, f] of releases.entries()) {
            if (i > 0)
                assert.ok(
                    f.t - releases[i - 1].t >= 35,
                    `release ${i} went out ${f.t - releases[i - 1].t} ms after the one before`,
                );
        }
    });

    it("fails a session the phone left incomplete and idle on its own, stores what arrived, and asks again at the end", async () => {
        // The phone never sends the batch of one conversation of the second session, then goes idle (status 2): live,
        // 2026-10-28, the run waited ten minutes for it and then stopped. Now: a short grace, that session alone fails,
        // and its missing conversation is asked for once more in a session of its own.
        const { result, error, events, phone } = await run(
            { conversations: convs(6), losePartition: (p, attempt) => p.endsWith("/LIFE2") && attempt === 1 },
            { shardSize: 1, waveSize: 3, stallIdleMs: 150 },
        );
        assert.equal(error, null);
        assert.equal(result.reason, "complete", "the retry round recovered it");
        assert.equal(result.messagesSaved, 6);
        const warn = events.find((e) => e.phase === "warn" && /went idle/.test(e.detail));
        assert.ok(warn, "the run says what happened");
        assert.match(warn.detail, /0 of 1 conversation\(s\) of batch 3 delivered/);
        assert.equal(phone.requests.length, 8, "the conversation round, six sessions, and one more for the lost one");
        assert.equal(phone.requests.at(-1).queries.length, 1, "only the missing conversation is asked for again");
    });

    it("says what a session it keeps waiting for has and lacks, instead of waiting in silence", async () => {
        const ctl = new AbortController();
        const notes = [];
        const { result, error } = await run(
            { outcome: "silent" },
            {
                signal: ctl.signal,
                waitMs: 600_000,
                stallNoteMs: 150,
                onStatus: (e) => {
                    if (e.phase !== "wait") return;
                    notes.push(e.detail);
                    ctl.abort();
                },
            },
        );
        assert.equal(error, null);
        assert.equal(result.reason, "cancelled");
        assert.equal(notes.length, 1);
        assert.match(
            notes[0],
            /^still waiting for the phone: 0 batch\(es\) of the conversation list so far, phone status 3$/,
        );
    });

    /** What the first moves on the new socket are, after a drop: a ping, releases with reason 3, then the requests. */
    function assertNewSocketStart({ ussidxOfFirstRequest }) {
        const first = zalo.sock.connections[0];
        const second = zalo.sock.connections[1];
        assert.ok(second, "the restore opened a second socket");
        const onSecond = zalo.sock.received.filter((f) => f.conn === second.id);
        assert.deepEqual([onSecond[0].cmd, onSecond[0].sub], [2, 1], "the first frame on the new socket is a ping");
        const syncFrames = onSecond.filter((f) => f.cmd === 590 || f.cmd === 591);
        const firstRequest = syncFrames.findIndex((f) => f.cmd === 590);
        assert.ok(firstRequest > 0, "releases come before the first request");
        const released = syncFrames.slice(0, firstRequest);
        assert.ok(
            released.every((f) => f.cmd === 591 && f.data.data.reason === 3),
            "all of them with reason 3 (outdated)",
        );
        const firstSocketSessions = new Set(
            zalo.sock.received.filter((f) => f.conn === first.id && f.cmd === 590).map((f) => f.data.data.syncId),
        );
        assert.ok(
            released.every((f) => firstSocketSessions.has(f.data.data.syncId)),
            "and they are the sessions of the socket that died",
        );
        assert.equal(
            syncFrames[firstRequest].data.data.ussidx,
            ussidxOfFirstRequest,
            "sessions are counted again on the new socket",
        );
        // One at a time: the second release goes out after the first one's ack (the phone takes 40 ms to answer).
        if (released.length > 1) {
            assert.ok(released[1].t - released[0].t >= 35, "each release of a dead socket waits for the one before");
        }
        return released;
    }

    it("after a drop while a wave is stored: a ping, the dead socket's sessions released with reason 3, then the requests, counted from 1", async () => {
        let dropped = false;
        const { result, error, phone } = await run(
            {
                conversations: convs(6),
                ackDelayMs: 40,
                releaseAckDelayMs: 40,
                downloadStatus: (path, handle) => {
                    // The wire dies as the first wave's first batch is downloaded: the conversation round and all
                    // three requests of the wave have been sent by then.
                    if (!dropped && handle.requests.length >= 4) {
                        dropped = true;
                        zalo.sock.terminate();
                    }
                    return null;
                },
            },
            { shardSize: 1, waveSize: 3, reconnect: () => reconnectListener(api, 5000, 0) },
        );
        assert.equal(error, null);
        assert.equal(result.reason, "complete");
        assert.equal(result.messagesSaved, 6, "what the dead socket never served is asked for again");
        const released = assertNewSocketStart({ ussidxOfFirstRequest: 1 });
        assert.ok(released.length >= 3, "the three sessions of the wave");
        assert.ok(phone.releases.some((r) => r.reason === 3));
    });

    it("after a drop during the conversation round: the same start on the new socket, counting from 0", async () => {
        let downloads = 0;
        const { result, error } = await run(
            {
                conversations: convs(3),
                ackDelayMs: 40,
                releaseAckDelayMs: 40,
                downloadStatus: () => {
                    if (++downloads === 1) zalo.sock.terminate();
                    return null;
                },
            },
            { shardSize: 1, waveSize: 3, reconnect: () => reconnectListener(api, 5000, 0) },
        );
        assert.equal(error, null);
        assert.equal(result.reason, "complete");
        assert.equal(result.messagesSaved, 3);
        const released = assertNewSocketStart({ ussidxOfFirstRequest: 0 });
        assert.equal(released.length, 1, "the conversation session of the dead socket");
    });
});
