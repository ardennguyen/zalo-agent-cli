/**
 * The presence core (src/core/presence.js) on a fake clock: when a daemon parks its socket and when it wakes it.
 *
 * The host is a stand-in that records `wake` / `park` and resolves a park the way the socket host does (false when a
 * hold arrived while it was under way). Nothing here opens a socket.
 */
import { assertSandboxed, SANDBOX_CONFIG_DIR } from "../helpers/sandbox.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    CATCH_UP_HOLD_MAX_MS,
    MAX_STRETCH_MS,
    PRESENCE_DEFAULTS,
    createPresence,
    normalizePresenceSettings,
    pulseOffsetMs,
    stretchedIdleMs,
} from "../../src/core/presence.js";

const MIN = 60_000;

/** A clock whose timers fire only when the test advances it. */
function fakeClock(start = 1_700_000_000_000) {
    let t = start;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => t,
        setTimeout(fn, ms) {
            const id = ++seq;
            timers.set(id, { at: t + Math.max(0, ms), fn });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        /** Move time forward, firing every timer that falls due, in order. */
        async advance(ms) {
            const end = t + ms;
            for (;;) {
                let next = null;
                for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
                if (!next) break;
                timers.delete(next[0]);
                t = next[1].at;
                next[1].fn();
                await new Promise((r) => setImmediate(r));
            }
            t = end;
            await new Promise((r) => setImmediate(r));
        },
        pending: () => timers.size,
    };
}

/** A host that connects when told and parks unless a hold arrived during the park. */
function fakeHost() {
    const calls = [];
    let presence = null;
    return {
        calls,
        bind(p) {
            presence = p;
        },
        wake(why) {
            calls.push(`wake:${why}`);
        },
        async park({ aborted }) {
            calls.push("park");
            await new Promise((r) => setImmediate(r));
            if (aborted()) return false;
            presence?.noteSocketState("stopped");
            return true;
        },
    };
}

function build(settings = {}, extra = {}) {
    const clock = fakeClock();
    const host = fakeHost();
    const states = [];
    const p = createPresence({
        ownId: "1000000000000000901",
        host,
        clock,
        settings: { connectOnStart: false, ...settings },
        onState: (s, prev, d) => states.push({ s, prev, reason: d.reason }),
        ...extra,
    });
    host.bind(p);
    return { p, clock, host, states };
}

beforeEach(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

describe("presence: park only when idle long enough", () => {
    it("stays parked with no demand, wakes on a hold, and parks after idleTimeout", async () => {
        const { p, clock, host } = build({ idleTimeoutMs: 5 * MIN, minConnectedMs: MIN });
        p.start();
        assert.equal(p.state, "parked");
        assert.deepEqual(host.calls, []);
        const h = p.hold("tool");
        assert.equal(p.state, "waking");
        assert.deepEqual(host.calls, ["wake:tool"]);
        p.noteSocketState("connected");
        assert.equal(p.state, "connected");
        h.release();
        await clock.advance(5 * MIN - 1);
        assert.equal(p.state, "connected", "not one millisecond early");
        await clock.advance(1);
        assert.equal(p.state, "parked");
        assert.deepEqual(host.calls, ["wake:tool", "park"]);
    });

    it("never parks within minConnected of the connect, even when the idle clock ran out", async () => {
        const { p, clock } = build({ idleTimeoutMs: 30_000, minConnectedMs: 2 * MIN });
        p.start();
        const h = p.hold("tool");
        h.release(); // released before the socket is even up
        await clock.advance(10_000);
        p.noteSocketState("connected");
        await clock.advance(MIN);
        assert.equal(p.state, "connected", "30 s idle passed, but only 1 of 2 minutes connected");
        await clock.advance(MIN);
        assert.equal(p.state, "parked");
    });

    it("a hold during the park aborts it; the socket stays connected", async () => {
        const { p, clock, host } = build({ idleTimeoutMs: 30_000, minConnectedMs: 0 });
        p.start();
        p.hold("tool").release();
        p.noteSocketState("connected");
        // The host's park yields once before asking `aborted`; a hold lands in that moment.
        const parkStarted = clock.advance(30_000);
        assert.equal(p.state, "parking");
        const h = p.hold("wait");
        await parkStarted;
        await new Promise((r) => setImmediate(r));
        assert.equal(p.state, "connected", "the park was aborted");
        assert.equal(host.calls.filter((c) => c === "park").length, 1);
        assert.equal(host.calls.filter((c) => c.startsWith("wake")).length, 1, "no second wake");
        h.release();
        await clock.advance(30_000);
        assert.equal(p.state, "parked");
    });

    it("a hold after the park wakes the socket again", async () => {
        const { p, clock, host } = build({ idleTimeoutMs: 30_000, minConnectedMs: 0 });
        p.start();
        p.hold("tool").release();
        p.noteSocketState("connected");
        await clock.advance(30_000);
        assert.equal(p.state, "parked");
        p.hold("lease");
        assert.equal(p.state, "waking");
        assert.deepEqual(host.calls, ["wake:tool", "park", "wake:lease"]);
    });

    it("a wake still retrying parks once every hold has closed and the idle timeout passed", async () => {
        const { p, clock, host } = build({ idleTimeoutMs: 30_000, minConnectedMs: MIN });
        p.start();
        const h = p.hold("tool");
        p.noteSocketState("retrying");
        assert.equal(p.state, "waking");
        h.release();
        await clock.advance(30_000);
        assert.equal(p.state, "parked", "minConnected applies only after a connect");
        assert.deepEqual(host.calls, ["wake:tool", "park"]);
    });

    it("a hold with a time to live ends by itself; renew pushes it out", async () => {
        const { p, clock } = build({ idleTimeoutMs: 30_000, minConnectedMs: 0 });
        p.start();
        const h = p.hold("lease", { ttlMs: 90_000 });
        p.noteSocketState("connected");
        await clock.advance(60_000);
        assert.equal(h.renew(90_000), true);
        await clock.advance(89_000);
        assert.equal(p.holding("lease"), true);
        await clock.advance(1000);
        assert.equal(p.holding("lease"), false);
        assert.equal(h.renew(), false, "an expired hold cannot be renewed");
        await clock.advance(30_000);
        assert.equal(p.state, "parked");
    });
});

describe("presence: hysteresis", () => {
    it("stretchedIdleMs doubles per wake over the limit, up to an hour", () => {
        assert.equal(stretchedIdleMs(5 * MIN, 12, 12), 5 * MIN);
        assert.equal(stretchedIdleMs(5 * MIN, 13, 12), 10 * MIN);
        assert.equal(stretchedIdleMs(5 * MIN, 14, 12), 20 * MIN);
        assert.equal(stretchedIdleMs(5 * MIN, 40, 12), MAX_STRETCH_MS);
        assert.equal(stretchedIdleMs(90 * MIN, 40, 12), 90 * MIN, "a base above the cap is never shortened");
    });

    it("the 13th wake in an hour stretches the idle timeout; a quiet hour resets it", async () => {
        const { p, clock } = build({ idleTimeoutMs: 30_000, minConnectedMs: 0, maxWakesPerHour: 12 });
        p.start();
        for (let i = 0; i < 13; i++) {
            const h = p.hold("tool");
            p.noteSocketState("connected");
            h.release();
            if (i < 12) {
                await clock.advance(30_000);
                assert.equal(p.state, "parked", `wake ${i + 1} parks after the base timeout`);
            }
        }
        assert.equal(p.snapshot().wakesLastHour, 13);
        assert.equal(p.snapshot().idleTimeoutMs, 60_000);
        await clock.advance(30_000);
        assert.equal(p.state, "connected", "stretched to 60 s");
        await clock.advance(30_000);
        assert.equal(p.state, "parked");
        await clock.advance(61 * MIN);
        assert.equal(p.snapshot().idleTimeoutMs, 30_000, "back to base after a quiet hour");
    });
});

describe("presence: always-on and live mode changes", () => {
    it("always-on wakes at start and never parks", async () => {
        const { p, clock, host } = build({ mode: "always-on", idleTimeoutMs: 30_000, minConnectedMs: 0 });
        p.start();
        assert.equal(p.state, "waking");
        p.noteSocketState("connected");
        await clock.advance(24 * 60 * MIN);
        assert.equal(p.state, "connected");
        assert.deepEqual(host.calls, ["wake:always-on"]);
        assert.deepEqual(p.snapshot().holds, { "always-on": 1 });
    });

    it("switching to on-demand starts the idle clock; back to always-on wakes a parked socket", async () => {
        const { p, clock } = build({ mode: "always-on", idleTimeoutMs: 30_000, minConnectedMs: 0 });
        p.start();
        p.noteSocketState("connected");
        p.update({ mode: "on-demand" });
        await clock.advance(30_000);
        assert.equal(p.state, "parked");
        p.update({ mode: "always-on" });
        assert.equal(p.state, "waking");
    });
});

describe("presence: start-up catch-up and pulse", () => {
    it("connectOnStart wakes once and parks after the catch-up and minConnected", async () => {
        const { p, clock } = build({ connectOnStart: true, idleTimeoutMs: 30_000, minConnectedMs: MIN });
        p.start();
        assert.equal(p.state, "waking");
        p.noteSocketState("connected");
        await clock.advance(5 * MIN);
        assert.equal(p.state, "connected", "the start hold waits for the catch-up");
        p.noteCatchUpDone({ ms: 1200 });
        await clock.advance(30_000);
        assert.equal(p.state, "parked");
        assert.equal(p.snapshot().lastCatchUpMs, 1200);
    });

    it("a start hold that never hears 'caught up' ends after its cap", async () => {
        const { p, clock } = build({ connectOnStart: true, idleTimeoutMs: 30_000, minConnectedMs: 0 });
        p.start();
        p.noteSocketState("connected");
        await clock.advance(CATCH_UP_HOLD_MAX_MS + 30_000);
        assert.equal(p.state, "parked");
    });

    it("the pulse offset is deterministic per id and inside the period", () => {
        const period = 6 * 60 * MIN;
        const a = pulseOffsetMs("1000000000000000901", period);
        assert.equal(a, pulseOffsetMs("1000000000000000901", period));
        assert.ok(a >= 0 && a < period);
        assert.notEqual(a, pulseOffsetMs("1000000000000000902", period), "two accounts do not pulse together");
        assert.equal(pulseOffsetMs("x", 0), 0);
    });

    it("the pulse is off by default; when set it wakes a parked socket at the account's offset", async () => {
        assert.equal(PRESENCE_DEFAULTS.catchUpEveryMs, 0, "owner decision 4: off until L1/L2 are measured");
        const period = 60 * MIN;
        const { p, clock, host } = build(
            { catchUpEveryMs: period, idleTimeoutMs: 30_000, minConnectedMs: 0 },
            { random: () => 0.5 },
        );
        p.start();
        const offset = pulseOffsetMs("1000000000000000901", period);
        await clock.advance(offset - 1);
        assert.deepEqual(host.calls, []);
        await clock.advance(1);
        assert.deepEqual(host.calls, ["wake:pulse"]);
        p.noteSocketState("connected");
        p.noteCatchUpDone();
        await clock.advance(30_000);
        assert.equal(p.state, "parked");
    });
});

describe("presence: waits, metering, yield", () => {
    it("waitHoldsSocket false: a wait holds nothing and wakes nothing", () => {
        const { p, host } = build({ waitHoldsSocket: false });
        p.start();
        const h = p.hold("wait");
        assert.equal(h.held, false);
        assert.equal(p.state, "parked");
        assert.deepEqual(host.calls, []);
    });

    it("meters connected time and the time waits held the socket", async () => {
        const { p, clock } = build({ idleTimeoutMs: 30_000, minConnectedMs: 0 });
        p.start();
        const w = p.hold("wait");
        p.noteSocketState("connected");
        await clock.advance(120_000);
        w.release();
        await clock.advance(30_000);
        assert.equal(p.state, "parked");
        const m = p.snapshot().meter;
        assert.equal(m.waitHeldMs, 120_000);
        assert.equal(m.connectedMs, 150_000);
        assert.equal(m.wakes, 1);
        assert.equal(m.parks, 1);
    });

    it("on-demand kick yields: background demand does not wake, an explicit action does", async () => {
        const { p, host } = build({ idleTimeoutMs: 30_000, minConnectedMs: 0 });
        p.start();
        p.hold("tool").release();
        p.noteSocketState("connected");
        assert.equal(p.noteKicked(), "yield");
        assert.equal(p.state, "yielded");
        p.hold("wait");
        p.hold("pulse");
        assert.equal(p.state, "yielded", "a wait or a pulse never takes the account back");
        p.hold("tool");
        assert.equal(p.state, "waking");
        assert.deepEqual(host.calls, ["wake:tool", "wake:tool"]);
    });

    it("always-on, or onKick exit, keeps the old answer: the daemon ends", () => {
        const a = build({ mode: "always-on" });
        a.p.start();
        assert.equal(a.p.noteKicked(), "exit");
        const b = build({ onKick: "exit" });
        b.p.start();
        assert.equal(b.p.noteKicked(), "exit");
    });

    it("snapshot carries counts per kind, never a holder", () => {
        const { p } = build();
        p.start();
        p.hold("lease");
        p.hold("lease");
        p.hold("tool");
        assert.deepEqual(p.snapshot().holds, { lease: 2, tool: 1 });
    });

    it("normalizes settings: an idle timeout under 30 s is raised; an unknown mode falls back", () => {
        const s = normalizePresenceSettings({ idleTimeoutMs: 5000, mode: "sometimes" });
        assert.equal(s.idleTimeoutMs, 30_000);
        assert.equal(s.mode, "on-demand");
    });

    it("stop() ends every timer and hold; holds after it are no-ops", async () => {
        const { p, clock } = build({ idleTimeoutMs: 30_000 });
        p.start();
        p.hold("lease", { ttlMs: 90_000 });
        p.stop();
        assert.equal(clock.pending(), 0);
        assert.equal(p.hold("tool").held, false);
        assert.equal(p.state, "stopped");
    });
});

describe("presence: socket rules (AGENTS.md section 13)", () => {
    it("imports nothing from the protocol layer and never supervises a socket itself", () => {
        const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "core", "presence.js"), "utf8");
        assert.doesNotMatch(src, /from\s+["'][^"']*zalo\//, "presence.js must not import src/zalo");
        assert.doesNotMatch(src, /superviseListener/);
        assert.doesNotMatch(src, /^import /m, "the core is pure: no imports at all");
    });
});
