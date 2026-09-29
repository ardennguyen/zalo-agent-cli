/**
 * The socket heartbeat that holds the restore's idle windows open.
 *
 * Background, so nobody "simplifies" this back to `api.keepAlive()`: that
 * method exists in zca-js and is an HTTP GET to `<chat host>/keepalive`. It
 * never touches the WebSocket, so it cannot keep this socket warm. The frame
 * that does is Zalo's own `cmd 2 / subCmd 1` ping, which the server echoes
 * back -- measured at a 180000 ms interval both in a captured Zalo Web session
 * and in the settings this account is handed at login.
 *
 * These tests drive an injected scheduler, so nothing here waits on a real
 * timer and nothing opens a socket.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_KEEPALIVE_MS,
    MIN_KEEPALIVE_MS,
    PING_CMD,
    PING_SUBCMD,
    SERVER_PING_INTERVAL_MS,
    isPingEcho,
    pingPayload,
    resolveKeepAliveInterval,
    startKeepAlive,
} from "../../src/core/sync-v2/keepalive.js";

/** A scheduler whose pending timer only fires when the test says so. */
function fakeTimers() {
    let next = null;
    let id = 0;
    return {
        timers: {
            setTimeout(fn, ms) {
                next = { fn, ms, id: ++id };
                return { id: next.id, unref() {} };
            },
            clearTimeout(h) {
                if (next && h && next.id === h.id) next = null;
            },
        },
        pending: () => next,
        fire() {
            const t = next;
            assert.ok(t, "expected a scheduled tick");
            next = null;
            t.fn();
            return t.ms;
        },
    };
}

/** Minimal zca-js Listener stand-in: records frames, fakes a socket. */
function fakeListener({ readyState = 1 } = {}) {
    const handlers = new Map();
    const ws = {
        readyState,
        on(ev, fn) {
            handlers.set(ev, [...(handlers.get(ev) || []), fn]);
        },
        off(ev, fn) {
            handlers.set(
                ev,
                (handlers.get(ev) || []).filter((f) => f !== fn),
            );
        },
        emit(ev, ...a) {
            for (const f of handlers.get(ev) || []) f(...a);
        },
    };
    const sent = [];
    return {
        ws,
        sent,
        sendWs(payload, requireId) {
            sent.push({ payload, requireId });
        },
    };
}

/** A real `cmd N / subCmd M` frame, header-compatible with zca-js's parser. */
function frame(cmd, subCmd, body = "{}") {
    const b = Buffer.alloc(4 + Buffer.byteLength(body));
    b.writeUInt8(1, 0);
    b.writeUInt16LE(cmd, 1);
    b.writeUInt8(subCmd, 3);
    b.write(body, 4, "utf8");
    return b;
}

describe("keepalive frame shape", () => {
    it("is Zalo's own cmd 2/1 heartbeat, carrying an eventId", () => {
        const p = pingPayload(1_700_000_000_000);
        assert.equal(p.version, 1);
        assert.equal(p.cmd, PING_CMD);
        assert.equal(p.subCmd, PING_SUBCMD);
        assert.deepEqual(p.data, { eventId: 1_700_000_000_000 });
    });

    it("recognizes the server's echo and nothing else", () => {
        assert.equal(isPingEcho(frame(2, 1, '{"eventId":1}')), true);
        assert.equal(isPingEcho(frame(601, 0)), false);
        assert.equal(isPingEcho(frame(2, 0)), false);
        assert.equal(isPingEcho(Buffer.alloc(2)), false);
        assert.equal(isPingEcho("not a buffer"), false);
    });
});

describe("resolveKeepAliveInterval", () => {
    it("defaults to a third of the interval the server advises", () => {
        assert.equal(DEFAULT_KEEPALIVE_MS * 3, SERVER_PING_INTERVAL_MS);
        assert.equal(resolveKeepAliveInterval(undefined), DEFAULT_KEEPALIVE_MS);
        assert.equal(resolveKeepAliveInterval(0), DEFAULT_KEEPALIVE_MS);
        assert.equal(resolveKeepAliveInterval(NaN), DEFAULT_KEEPALIVE_MS);
        assert.equal(resolveKeepAliveInterval(-5), DEFAULT_KEEPALIVE_MS);
    });

    it("never pings faster than the floor, nor slower than the server's own interval", () => {
        assert.equal(resolveKeepAliveInterval(10), MIN_KEEPALIVE_MS);
        assert.equal(resolveKeepAliveInterval(600000), SERVER_PING_INTERVAL_MS);
        assert.equal(resolveKeepAliveInterval(30000), 30000);
    });
});

describe("startKeepAlive scheduling", () => {
    it("pings on the interval for as long as it is running", () => {
        const L = fakeListener();
        const clock = fakeTimers();
        const k = startKeepAlive(L, { intervalMs: 30000, timers: clock.timers, now: () => 1000 });

        assert.equal(L.sent.length, 0, "nothing goes out before the first tick");
        assert.equal(clock.pending().ms, 30000);

        clock.fire();
        clock.fire();
        clock.fire();
        assert.equal(L.sent.length, 3);
        assert.deepEqual(L.sent[0].payload, pingPayload(1000));
        assert.equal(L.sent[0].requireId, false, "the heartbeat carries no req_id, as Zalo Web's does not");
        k.stop();
    });

    it("reschedules one tick at a time, so a blocked event loop cannot queue a burst", () => {
        const L = fakeListener();
        const clock = fakeTimers();
        const k = startKeepAlive(L, { intervalMs: 45000, timers: clock.timers });
        // Exactly one timer is outstanding at any moment.
        assert.ok(clock.pending());
        clock.fire();
        assert.ok(clock.pending(), "the next tick is armed only after the previous one ran");
        assert.equal(L.sent.length, 1);
        k.stop();
        assert.equal(clock.pending(), null, "stop() disarms the pending tick");
    });

    it("stops rescheduling once the socket is gone", () => {
        const L = fakeListener();
        const clock = fakeTimers();
        startKeepAlive(L, { intervalMs: 30000, timers: clock.timers });
        L.ws = null; // zca-js nulls the socket on close
        clock.fire();
        assert.equal(L.sent.length, 0, "no ping on a dead wire");
        assert.equal(clock.pending(), null, "and no further ticks armed");
    });

    it("stops rescheduling on a CLOSING/CLOSED socket too", () => {
        const L = fakeListener({ readyState: 3 });
        const clock = fakeTimers();
        startKeepAlive(L, { intervalMs: 30000, timers: clock.timers });
        clock.fire();
        assert.equal(L.sent.length, 0);
        assert.equal(clock.pending(), null);
    });

    it("sends nothing at all after stop()", () => {
        const L = fakeListener();
        const clock = fakeTimers();
        const k = startKeepAlive(L, { intervalMs: 30000, timers: clock.timers });
        const pending = clock.pending();
        k.stop();
        pending.fn(); // a tick that had already been handed to the event loop
        assert.equal(L.sent.length, 0);
    });
});

describe("startKeepAlive echo accounting", () => {
    it("counts the server's echoes, which is the only evidence a bare 1006 leaves", () => {
        const L = fakeListener();
        const clock = fakeTimers();
        let t = 0;
        const k = startKeepAlive(L, { intervalMs: 30000, timers: clock.timers, now: () => t });

        t = 30000;
        clock.fire();
        L.ws.emit("message", frame(2, 1, '{"eventId":30000}'));
        assert.deepEqual(
            { sent: k.stats().sent, echoed: k.stats().echoed, silentMs: k.stats().silentMs },
            { sent: 1, echoed: 1, silentMs: 0 },
        );

        // A half-open socket: we keep pinging, nothing comes back.
        t = 60000;
        clock.fire();
        t = 90000;
        clock.fire();
        const s = k.stats();
        assert.equal(s.sent, 3);
        assert.equal(s.echoed, 1);
        assert.equal(s.silentMs, 60000, "silence is measured from the last echo, not the last ping");
        k.stop();
    });

    it("ignores non-heartbeat traffic", () => {
        const L = fakeListener();
        const clock = fakeTimers();
        const k = startKeepAlive(L, { intervalMs: 30000, timers: clock.timers });
        clock.fire();
        L.ws.emit("message", frame(601, 0, '{"data":{}}'));
        assert.equal(k.stats().echoed, 0);
        k.stop();
    });

    it("removes its socket tap on stop, so a reconnect does not double-count", () => {
        const L = fakeListener();
        const clock = fakeTimers();
        const k = startKeepAlive(L, { intervalMs: 30000, timers: clock.timers });
        k.stop();
        L.ws.emit("message", frame(2, 1));
        assert.equal(k.stats().echoed, 0);
    });

    it("follows the socket across a reconnect instead of counting a dead one", () => {
        // A keepalive the caller holds for a whole socket window outlives any
        // single `ws`: sendWs already reads `listener.ws` fresh each tick, and
        // the echo tap has to do the same or it reports total silence on a
        // perfectly healthy reconnected socket.
        const L = fakeListener();
        const clock = fakeTimers();
        const k = startKeepAlive(L, { intervalMs: 30000, timers: clock.timers });
        clock.fire();
        L.ws.emit("message", frame(2, 1));
        assert.equal(k.stats().echoed, 1);

        const old = L.ws;
        L.ws = fakeListener().ws; // the socket a reconnect installs
        clock.fire();
        L.ws.emit("message", frame(2, 1));
        assert.equal(k.stats().echoed, 2, "echoes on the new socket count");

        old.emit("message", frame(2, 1));
        assert.equal(k.stats().echoed, 2, "and the abandoned one is no longer tapped");
        k.stop();
    });

    it("survives a listener whose socket has no event API", () => {
        const L = { ws: { readyState: 1 }, sendWs() {} };
        const clock = fakeTimers();
        assert.doesNotThrow(() => {
            const k = startKeepAlive(L, { intervalMs: 30000, timers: clock.timers });
            clock.fire();
            k.stop();
        });
    });
});
