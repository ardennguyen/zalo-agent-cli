/**
 * Park and wake (on-demand presence, WP2): the socket host closes the socket on purpose and opens it again on the
 * same session; the coverage bookkeeping files the parked window as a planned `idle` gap; self-heal closes it from
 * Zalo's offline queue or names what the queue lost as `idle-evicted`; health says `idle`, not `down`.
 *
 * The daemons are not wired to park yet (WP3). Every id is made up.
 */
import { assertSandboxed, SANDBOX_CONFIG_DIR } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createSocketHost } from "../../src/core/socket-host.js";
import {
    IDLE_EVICTED_REASON,
    IDLE_GAP_REASON,
    PARKED_AT_KEY,
    alarmingGapCount,
    createGapTracker,
    startupGapReason,
} from "../../src/core/listener-lifecycle.js";
import { createDaemonHealth } from "../../src/core/daemon-health.js";
import { classifyAccount } from "../../src/core/fleet.js";
import { getPendingSyncGaps, initDb, recordSyncGap } from "../../src/core/db.js";
import { storeLiveMessage } from "../../src/core/live-store.js";
import { createStageLock } from "../../src/core/daemon-channel.js";
import { createSocketTap } from "../../src/zalo/listener/socket-tap.js";
import { GroupMessage } from "../../src/zalo/listener/models.js";
import { createSelfHeal } from "../../src/core/self-heal.js";
import { resolveSocketSettings } from "../../src/zalo/retry.js";
import { startFakeZalo } from "../helpers/fake-zalo/index.js";
import { fakeListener } from "./support/fake-socket.js";

const SRC = join(import.meta.dirname, "..", "..", "src");
const tick = () => new Promise((r) => setImmediate(r));

async function until(check, what, ms = 4000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await check();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

/** A supervisor that does what it is told and records what was done to it. */
class FakeSupervisor extends EventEmitter {
    constructor(api) {
        super();
        this.api = api;
        this.calls = [];
    }
    start() {
        this.calls.push("start");
    }
    async stop() {
        this.calls.push("stop");
    }
    dispose() {
        this.calls.push("dispose");
    }
    status() {
        return { kickedVia: this.kickedVia ?? null };
    }
}

beforeEach(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

describe("socket host: park and wake (scripted supervisor)", () => {
    let made;
    let logs;
    let sleeps;
    let ended;
    let stopping;

    beforeEach(() => {
        made = [];
        logs = [];
        sleeps = [];
        ended = null;
        stopping = false;
    });

    function host(script = [], extra = {}) {
        const queue = [...script];
        return createSocketHost({
            log: (level, message) => logs.push(`${level}: ${message}`),
            relogin: async () => {
                const next = queue.shift();
                if (next instanceof Error) throw next;
                return next ?? { id: "api-new" };
            },
            onKicked: () => {
                ended = ended ? `${ended}+kicked` : "kicked";
            },
            onRevoked: () => {
                ended = "revoked";
            },
            isStopping: () => stopping,
            supervise: (api) => {
                const s = new FakeSupervisor(api);
                made.push(s);
                return s;
            },
            sleep: async (ms) => void sleeps.push(ms),
            checkGate: async () => ({ state: "ok", code: null }),
            ...extra,
        });
    }

    it("park stops then disposes the supervisor, asks for no login, and marks the close planned first", async () => {
        const order = [];
        const h = host([], { onParking: () => order.push("onParking") });
        const sup = h.start({ id: 1 });
        const stop = sup.stop.bind(sup);
        sup.stop = async () => {
            order.push("stop");
            return stop();
        };
        assert.equal(await h.park({ prepare: async () => order.push("prepare") }), true);
        assert.deepEqual(order, ["prepare", "onParking", "stop"]);
        assert.deepEqual(sup.calls, ["start", "stop", "dispose"]);
        assert.equal(h.isParked(), true);
        assert.equal(h.current(), null);
        assert.deepEqual(sleeps, [], "a park never leads to a relogin");
        assert.ok(!logs.some((l) => /Reconnecting|Logging in again/.test(l)));
    });

    it("a hold that arrives while preparing aborts the park; the socket is untouched", async () => {
        const h = host();
        const sup = h.start({ id: 1 });
        assert.equal(await h.park({ aborted: () => true }), false);
        assert.deepEqual(sup.calls, ["start"]);
        assert.equal(h.isParked(), false);
        assert.equal(h.current(), sup);
    });

    it("does not park during a relogin or a shutdown", async () => {
        const h = host();
        h.start({ id: 1 });
        stopping = true;
        assert.equal(await h.park(), false);
    });

    it("wake starts a new supervisor on the same session; a second wake is a no-op", async () => {
        const h = host();
        const api = { id: 1 };
        h.start(api);
        await h.park();
        const next = h.wake();
        assert.equal(made.length, 2);
        assert.equal(next.api, api, "the wake reuses the session; it never logs in by itself");
        assert.deepEqual(next.calls, ["start"]);
        assert.equal(h.isParked(), false);
        assert.equal(h.wake(), next);
        assert.equal(made.length, 2);
        assert.deepEqual(sleeps, []);
    });

    it("a kick during a wake ends the daemon once (exit 3 as always)", async () => {
        const h = host();
        h.start({ id: 1 });
        await h.park();
        h.wake().emit("kicked", { via: "frame-3000" });
        assert.equal(ended, "kicked");
        await tick();
        assert.equal(made.length, 2, "nothing reconnected after the kick");
    });

    it("a refused session on wake goes the existing way: relogin, and the daemon ends after 3 refusals", async () => {
        const refused = () => Object.assign(new Error("x"), { code: 102 });
        const h = host([refused(), refused(), refused()]);
        h.start({ id: 1 });
        await h.park();
        h.wake().emit("session-invalid", { kind: "session-invalid", code: 102 });
        await until(() => ended === "revoked", "onRevoked");
        assert.equal(sleeps.length, 3);
    });

    it("yieldOnKick: the kicked socket is let go and the daemon stays up; the next wake takes the account back", async () => {
        const seen = [];
        const h = host([], {
            yieldOnKick: (info) => {
                seen.push(info.via);
                return true;
            },
        });
        const sup = h.start({ id: 1 });
        sup.emit("kicked", { via: "frame-3000" });
        assert.equal(ended, null, "no exit");
        assert.deepEqual(seen, ["frame-3000"]);
        assert.equal(h.isParked(), true);
        assert.ok(sup.calls.includes("dispose"));
        assert.ok(logs.some((l) => /Yielded the account/.test(l)));
        const back = h.wake();
        assert.equal(back.api.id, 1);
        assert.equal(made.length, 2);
    });

    it("a login answered with a kick yields too when presence says so", async () => {
        const h = host([Object.assign(new Error("kicked"), { code: 600 })], { yieldOnKick: () => true });
        h.start({ id: 1 });
        await h.reloginNow("test");
        assert.equal(ended, null);
        assert.equal(h.isParked(), true);
    });

    it("a yield hook that throws falls back to the exit", () => {
        const h = host([], {
            yieldOnKick: () => {
                throw new Error("boom");
            },
        });
        h.start({}).emit("kicked", { via: "frame-3000" });
        assert.equal(ended, "kicked");
    });
});

describe("socket host: park and wake on the real stack", () => {
    let zalo;
    let host;
    let api;
    const closes = [];

    afterEach(async () => {
        await host?.stop();
        api?.listener.on("error", () => {});
        api?.listener.ws?.terminate?.();
        await zalo?.stop();
        zalo = host = api = null;
        closes.length = 0;
    });

    it("the park's close is a requested one: no retry, no new connection; the wake opens one on the same session", async () => {
        process.env.ZALO_JSON_MODE = "1";
        zalo = await startFakeZalo();
        api = await zalo.login();
        const retries = [];
        host = createSocketHost({
            log: (level, message) => {
                if (/Reconnecting/.test(message)) retries.push(message);
            },
            isStopping: () => false,
            relogin: async () => {
                throw new Error("a park must never log in again");
            },
            onKicked: () => {},
            onRevoked: () => {},
            supervisorOptions: {
                settings: resolveSocketSettings({ close_timeout: 100 }),
                timing: { pingTimeoutMs: 2000, intervalCheckMs: 30, stableMs: 10_000, resumeGapMs: 5000 },
                probe: async () => true,
                random: () => 0,
            },
        });
        const first = host.start(api);
        first.on("disconnected", (e) => closes.push(e));
        await until(() => first.state === "connected", "connected");
        assert.equal(await host.park(), true);
        assert.equal(first.state, "stopped");
        assert.equal(closes.length, 1);
        assert.equal(closes[0].requested, true, "the park's close must read as requested");
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(zalo.sock.connections.length, 1, "nothing reconnected while parked");
        assert.deepEqual(retries, []);

        const next = host.wake();
        await until(() => next.state === "connected", "the wake to connect");
        assert.equal(zalo.sock.connections.length, 2);
        assert.equal(next.listener, api.listener, "the same session's listener");
    });
});

describe("gap tracker: a parked window is planned", () => {
    function rig() {
        const state = new Map();
        const gaps = [];
        let t = 1_700_000_000_000;
        let lastConnectedAt = null;
        const syncManager = {
            markConnected: () => {
                lastConnectedAt = t;
            },
            markDisconnected: () => gaps.push("markDisconnected"),
            getLastConnectedAt: () => lastConnectedAt,
        };
        const tracker = createGapTracker({
            syncManager,
            reportGap: (from, reason) => {
                gaps.push({ from, to: t, reason });
                return true;
            },
            setState: (k, v) => state.set(k, v),
            deleteState: (k) => state.delete(k),
            now: () => t,
        });
        return { tracker, gaps, state, advance: (ms) => (t += ms), at: () => t };
    }

    it("noteParking stamps coverage and the park time; the park's close is not a drop", () => {
        const r = rig();
        const parkedAt = r.at();
        r.tracker.noteParking();
        assert.equal(r.state.get(PARKED_AT_KEY), parkedAt);
        r.tracker.noteDown();
        assert.equal(r.tracker.isDown(), false);
        assert.deepEqual(r.gaps, [], "no markDisconnected, no gap");
        assert.equal(r.tracker.isParked(), true);
    });

    it("noteWake files [parkedAt, now] as an idle gap and clears the stamp; noteUp then claims coverage", () => {
        const r = rig();
        const parkedAt = r.at();
        r.tracker.noteParking();
        r.advance(3_600_000);
        r.tracker.noteWake();
        r.tracker.noteUp();
        assert.deepEqual(r.gaps, [{ from: parkedAt, to: parkedAt + 3_600_000, reason: IDLE_GAP_REASON }]);
        assert.equal(r.state.has(PARKED_AT_KEY), false);
        assert.equal(r.tracker.isParked(), false);
    });

    it("an up with no announced wake still files the parked window once", () => {
        const r = rig();
        r.tracker.noteParking();
        r.advance(1000);
        r.tracker.noteUp();
        r.tracker.noteUp();
        assert.equal(r.gaps.filter((g) => g.reason === IDLE_GAP_REASON).length, 1);
    });

    it("a drop still open when the park begins is filed as a drop, not folded into the planned window", () => {
        const r = rig();
        const downAt = r.at();
        r.tracker.noteDown();
        r.advance(5000);
        r.tracker.noteParking();
        assert.deepEqual(r.gaps[1], { from: downAt, to: downAt + 5000, reason: "reconnect-gap" });
    });

    it("a start-up after a crash while parked is an idle window, anything else a startup gap", () => {
        assert.equal(startupGapReason({ lastConnectedAt: 5, parkedAt: 5 }), IDLE_GAP_REASON);
        assert.equal(startupGapReason({ lastConnectedAt: 6, parkedAt: 5 }), "startup-gap");
        assert.equal(startupGapReason({ lastConnectedAt: 6, parkedAt: null }), "startup-gap");
    });

    it("health and fleet count only the gaps worth a warning", () => {
        assert.equal(
            alarmingGapCount([{ reason: "idle" }, { reason: IDLE_EVICTED_REASON }, { reason: "reconnect-gap" }]),
            2,
        );
    });
});

describe("self-heal: the idle window", () => {
    const ROOT = mkdtempSync(join(tmpdir(), "zalo-presence-heal-"));
    let seq = 0;
    const OWN = "900001";
    const GROUP = "7301";
    const T0 = Date.UTC(2026, 8, 1);
    const QCMDS = [
        { cmd: 510, subCmd: 1, queueName: "510_1" },
        { cmd: 511, subCmd: 1, queueName: "511_1" },
    ];
    let idSeq = 0;
    const nextId = () => String(6_300_000 + ++idSeq * 10);
    const tsOf = (id) => T0 + (Number(id) - 6_300_000) * 1000;
    const row = (msgId) => ({
        actionId: String(Number(msgId) + 7),
        msgId,
        cliMsgId: String(tsOf(msgId) + 3),
        msgType: "webchat",
        uidFrom: "2301",
        idTo: GROUP,
        dName: "Member",
        ts: String(tsOf(msgId)),
        content: `text ${msgId}`,
    });
    const page = (cmd, rows, { evict = 0, lastActionId } = {}) => {
        const last = lastActionId ?? rows.at(-1)?.msgId ?? "0";
        return {
            error_code: 0,
            error_message: "",
            data: {
                lastActionId: last,
                more: 0,
                msgs: cmd === 510 ? rows : [],
                groupMsgs: cmd === 511 ? rows : [],
                pageMsgs: [],
                clearUnreads: [],
                delivereds: [],
                seens: [],
                groupSeens: [],
                queueStatus: { [`${cmd}_1`]: { ids: rows.map((r) => r.msgId), lastId: last, evict } },
                eesession: [],
            },
        };
    };
    const scripted = (pages = {}) => {
        const left = { 510: [...(pages[510] || [])], 511: [...(pages[511] || [])] };
        return (payload) => {
            if (payload.cmd !== 510 && payload.cmd !== 511) return null;
            const next = left[payload.cmd].shift();
            if (next === null) return null;
            const body = next ?? page(payload.cmd, [], { lastActionId: payload.data.lastId });
            body.data.reqId = payload.data.reqId;
            return body;
        };
    };
    const pending = () => getPendingSyncGaps().map((g) => ({ fromTs: g.fromTs, toTs: g.toTs, reason: g.reason }));
    let savedFetch;

    beforeEach(() => {
        initDb(join(ROOT, `db${seq++}.sqlite`));
        savedFetch = globalThis.fetch;
        globalThis.fetch = async () => {
            throw new Error("offline test: no HTTP");
        };
    });
    afterEach(() => {
        globalThis.fetch = savedFetch;
    });

    async function heal(respond) {
        const listener = fakeListener({ respond });
        const tap = createSocketTap();
        const api = { listener, getOwnId: () => OWN };
        const h = createSelfHeal({
            getApi: () => api,
            tap,
            lock: createStageLock(),
            log: () => {},
            timeoutMs: 150,
            maxPages: 4,
        });
        listener.on("message", (m) => storeLiveMessage(m));
        tap.attach(listener);
        h.attach(listener);
        listener.emit("connected");
        return { listener, h };
    }
    const settle = async (d) => {
        d.listener.auth({ qCmds: QCMDS });
        await new Promise((r) => setTimeout(r, 0));
        await d.h.settled();
    };

    it("a queue drained to more: 0 resolves the idle gap; nothing is reported", async () => {
        const d = await heal(scripted());
        const g1 = nextId();
        d.listener.emit("message", new GroupMessage(OWN, row(g1)));
        recordSyncGap(tsOf(g1) + 1000, tsOf(g1) + 3_600_000, IDLE_GAP_REASON);
        await settle(d);
        assert.deepEqual(pending(), []);
    });

    it("an evicting queue turns the uncovered part into one idle-evicted gap", async () => {
        const g1 = nextId();
        const survivor = nextId();
        const d = await heal(scripted({ 511: [page(511, [row(survivor)], { evict: 1 })] }));
        d.listener.emit("message", new GroupMessage(OWN, row(g1)));
        recordSyncGap(tsOf(g1) + 1000, tsOf(survivor) + 60_000, IDLE_GAP_REASON);
        await settle(d);
        assert.deepEqual(pending(), [{ fromTs: tsOf(g1) + 1000, toTs: tsOf(survivor), reason: IDLE_EVICTED_REASON }]);
        assert.equal(alarmingGapCount(getPendingSyncGaps()), 1);
    });

    it("a queue that does not answer leaves the idle window as idle-evicted (no longer planned)", async () => {
        const g1 = nextId();
        const d = await heal(scripted({ 510: [null] }));
        d.listener.emit("message", new GroupMessage(OWN, row(g1)));
        recordSyncGap(tsOf(g1) + 5000, tsOf(g1) + 60_000, IDLE_GAP_REASON);
        await settle(d);
        assert.deepEqual(pending(), [
            { fromTs: tsOf(g1) + 5000, toTs: tsOf(g1) + 60_000, reason: IDLE_EVICTED_REASON },
        ]);
    });

    it("an ordinary gap keeps its old naming", async () => {
        const g1 = nextId();
        const d = await heal(scripted({ 510: [null] }));
        d.listener.emit("message", new GroupMessage(OWN, row(g1)));
        recordSyncGap(tsOf(g1) + 5000, tsOf(g1) + 60_000, "reconnect-gap");
        await settle(d);
        assert.equal(pending()[0].reason, "reconnect-gap");
    });
});

describe("health: idle is not down", () => {
    it("noteParked is idle; the park's own close does not turn it to down; a wake is connecting, then up", () => {
        const h = createDaemonHealth({ kind: "mcp", accountId: "1000000000000000901", version: "0" });
        try {
            const listener = new EventEmitter();
            h.attach(listener);
            listener.emit("connected");
            h.noteParked();
            listener.emit("disconnected", 1000);
            assert.equal(h.snapshot().socket.state, "idle");
            assert.deepEqual(h.snapshot().warnings, []);
            h.noteSocketState("connecting");
            assert.equal(h.snapshot().socket.state, "connecting");
            listener.emit("connected");
            assert.equal(h.snapshot().socket.state, "up");
        } finally {
            h.stop();
        }
    });

    it("fleet does not call an idle daemon down, however long it has been idle", () => {
        const health = { socket: { state: "idle", forSec: 86_400 }, warnings: [] };
        assert.notEqual(classifyAccount({ running: true, health }), "down");
    });
});

describe("socket rules for park and wake (AGENTS.md section 13)", () => {
    const walk = (dir) =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : [],
        );

    it("only socket-host.js starts a supervisor outside the protocol layer", () => {
        const callers = walk(SRC)
            .filter((f) => !f.includes(`${join("src", "zalo")}`))
            .filter((f) => /superviseListener\s*\(|supervise\s*=\s*superviseListener/.test(readFileSync(f, "utf8")))
            .map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"));
        assert.deepEqual(callers, ["core/socket-host.js"]);
    });

    it("listen and mcp start both read a park's close as planned and count only alarming gaps (symmetry)", () => {
        for (const file of ["commands/mcp.js", "commands/listen.js"]) {
            const src = readFileSync(join(SRC, file), "utf8");
            const handler = src.slice(src.indexOf('listener.on("disconnected"'));
            assert.match(
                handler.slice(0, 500),
                /socketHost\.isParking\(\) \|\| socketHost\.isParked\(\)\) return;/,
                file,
            );
            assert.match(src, /health\.setSource\("gaps", \(\) => alarmingGapCount\(getPendingSyncGaps\(\)\)\)/, file);
        }
    });

    it("presence.js never imports the socket", () => {
        const src = readFileSync(join(SRC, "core", "presence.js"), "utf8");
        assert.doesNotMatch(src, /zalo\/socket\.js/);
    });
});
