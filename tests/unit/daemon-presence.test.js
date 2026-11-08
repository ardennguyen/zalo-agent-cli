/**
 * The presence wiring both daemons share (src/core/daemon-presence.js), driven through the real socket host with a
 * scripted supervisor, on a fake clock: idle park, wake on every kind of demand, the warming reply and the WARMING
 * error, yielded (every request refused until a resume), signed out (the daemon stays up, refusing), a live policy
 * change of the mode, --no-self-heal refused with on-demand, and ZALO_CONNECT_SLOTS. Every id is made up; nothing
 * here opens a Zalo socket.
 */
import { assertSandboxed, SANDBOX_CONFIG_DIR } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createSocketHost } from "../../src/core/socket-host.js";
import { createGapTracker, IDLE_GAP_REASON, PARKED_AT_KEY } from "../../src/core/listener-lifecycle.js";
import {
    NO_SELF_HEAL_REFUSAL,
    PresenceRefusal,
    createDaemonPresence,
    presenceTransport,
    resolveDaemonPresence,
} from "../../src/core/daemon-presence.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { sendViaDaemon, startDaemonChannel } from "../../src/core/daemon-channel.js";
import { TOOL_PRESENCE, gateToolsByPresence, presenceClassOf } from "../../src/mcp/tool-presence.js";
import { PARK_RETRY_MS, createPresence } from "../../src/core/presence.js";
import { createDaemonHealth, renderPrometheus } from "../../src/core/daemon-health.js";
import { ACCOUNT_STATES, accountStateOfHealth, describeAccountState } from "../../src/core/account-state.js";

const OWN = "1000000000000000911";
const SEC = 1000;
const MIN = 60 * SEC;
const SRC = join(import.meta.dirname, "..", "..", "src");

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
        async advance(ms) {
            const end = t + ms;
            for (;;) {
                let next = null;
                for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
                if (!next) break;
                timers.delete(next[0]);
                t = next[1].at;
                next[1].fn();
                for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
            }
            t = end;
            for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        },
    };
}

const tick = async (n = 5) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

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
        this.emit("state", { state: "connecting" });
    }
    async stop() {
        this.calls.push("stop");
        this.emit("state", { state: "stopped" });
    }
    dispose() {
        this.calls.push("dispose");
    }
    status() {
        return { kickedVia: null };
    }
    up() {
        this.emit("state", { state: "connected" });
    }
}

/**
 * One daemon's presence on the real socket host.
 *
 * @param {object} [o]
 * @returns {object}
 */
function daemon({ presence = {}, env = {}, selfHeal = true, transport = "http", relogin = [], configDir = null } = {}) {
    const clock = fakeClock();
    const made = [];
    const notes = [];
    const healthCalls = [];
    const gapState = new Map();
    const gaps = [];
    const ended = [];
    const script = [...relogin];
    const config = {
        presence: { idleTimeout: "2m", minConnected: "30s", connectOnStart: false, warmWait: "10s", ...presence },
    };
    let lastConnectedAt = clock.now();
    const tracker = createGapTracker({
        syncManager: {
            markConnected: () => (lastConnectedAt = clock.now()),
            markDisconnected: () => {},
            getLastConnectedAt: () => lastConnectedAt,
        },
        reportGap: (from, reason) => {
            gaps.push({ from, reason });
            return true;
        },
        setState: (k, v) => gapState.set(k, v),
        deleteState: (k) => gapState.delete(k),
        now: clock.now,
    });
    const health = {
        noteSocketState: (s) => healthCalls.push(`socket:${s}`),
        noteParked: () => healthCalls.push("idle"),
        noteYielded: () => healthCalls.push("yielded"),
        noteSignedOut: () => healthCalls.push("signed-out"),
    };
    const accountState = {
        noteSocketState: (s) => notes.push(`sup:${s}`),
        note: (s) => notes.push(s),
    };
    let host = null;
    const dp = createDaemonPresence({
        ownId: OWN,
        config,
        transport,
        selfHeal,
        env,
        configDir,
        clock,
        getSocketHost: () => host,
        lifecycle: tracker,
        health,
        accountState,
        coveredUntil: () => lastConnectedAt,
    });
    host = createSocketHost({
        log: () => {},
        relogin: async () => {
            const next = script.shift();
            if (next instanceof Error) throw next;
            return next ?? { id: "api-new" };
        },
        onKicked: () => ended.push("kicked"),
        onRevoked: (e) => {
            if (dp.signOut(e)) return;
            ended.push("revoked");
        },
        isStopping: () => false,
        supervise: (api) => {
            const s = new FakeSupervisor(api);
            made.push(s);
            return s;
        },
        sleep: async () => {},
        checkGate: async () => ({ state: "ok", code: null }),
        health: { noteSocketState: (s) => dp.noteSocketState(s) },
        yieldOnKick: () => dp.yieldOnKick(),
        onParking: () => dp.onParking(),
    });
    return { dp, host, clock, made, notes, healthCalls, gaps, gapState, ended, config, tracker };
}

beforeEach(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

describe("daemon presence: idle park and wake", () => {
    it("starts parked, wakes on a tool call, parks after idleTimeout with no hold", async () => {
        const d = daemon();
        d.dp.start({ id: 1 });
        assert.equal(d.dp.presence.state, "parked");
        assert.equal(d.made.length, 0, "no socket until something needs it");
        assert.ok(d.notes.includes("idle"));
        const t = await d.dp.admit({ cls: "none" });
        assert.equal(d.made.length, 1, "the call woke the socket");
        assert.equal(d.made[0].api.id, 1, "on the session it adopted: no login");
        d.made[0].up();
        assert.equal(d.dp.presence.state, "connected");
        t.release();
        await d.clock.advance(2 * MIN - 1);
        assert.equal(d.dp.presence.state, "connected", "not a millisecond early");
        await d.clock.advance(1);
        await until(() => d.dp.presence.state === "parked", "the park");
        assert.deepEqual(d.made[0].calls, ["start", "stop", "dispose"]);
        assert.equal(d.host.isParked(), true);
        assert.ok(d.gapState.has(PARKED_AT_KEY), "the park stamped coverage (lifecycle.noteParking)");
        assert.ok(d.healthCalls.includes("idle"));
    });

    it("a wake files the parked window as a planned idle gap; minConnected holds a fresh socket up", async () => {
        const d = daemon({ presence: { minConnected: "90s", idleTimeout: "30s" } });
        d.dp.start({ id: 1 });
        (await d.dp.admit()).release();
        d.made[0].up();
        await d.clock.advance(60 * SEC);
        assert.equal(d.dp.presence.state, "connected", "30 s idle passed, but not 90 s connected");
        await d.clock.advance(30 * SEC);
        await until(() => d.dp.presence.state === "parked", "the park");
        await d.clock.advance(5 * MIN);
        (await d.dp.admit()).release();
        await tick();
        assert.equal(d.made.length, 2);
        assert.deepEqual(
            d.gaps.map((g) => g.reason),
            [IDLE_GAP_REASON],
        );
    });

    it("always-on never parks; a policy change to on-demand starts the idle clock live, and back", async () => {
        const d = daemon({ presence: { mode: "always-on" } });
        d.dp.start({ id: 1 });
        assert.equal(d.made.length, 1, "always-on opens the socket at start");
        d.made[0].up();
        await d.clock.advance(30 * MIN);
        assert.equal(d.dp.presence.state, "connected");
        d.config.presence.mode = "on-demand";
        assert.equal(d.dp.applyPolicy(["presence.mode"]), true);
        assert.equal(d.dp.mode, "on-demand");
        await d.clock.advance(2 * MIN);
        await until(() => d.dp.presence.state === "parked", "the park after the switch");
        d.config.presence.mode = "always-on";
        d.dp.applyPolicy(["presence"]);
        await tick();
        assert.equal(d.dp.presence.state, "waking", "always-on holds the socket at once");
        assert.equal(d.made.length, 2);
        assert.equal(d.dp.applyPolicy(["webhook"]), false, "another key changes nothing here");
    });
});

describe("daemon presence: demand by class", () => {
    it("fresh waits for the connect and its catch-up; still warming at warmWait, it answers with a presence block", async () => {
        const d = daemon();
        d.dp.start({ id: 1 });
        const p = d.dp.admit({ cls: "fresh" });
        await tick();
        d.made[0].up();
        d.dp.noteCatchUpDone({ ms: 800 });
        const ready = await p;
        assert.equal(ready.warming, null, "connected and caught up in time: a plain answer");
        ready.release();
        d.made[0].emit("state", { state: "retrying" });
        const late = d.dp.admit({ cls: "fresh" });
        await d.clock.advance(10 * SEC);
        const warm = await late;
        assert.equal(warm.warming.state, "waking");
        assert.equal(warm.warming.catchUp, true);
        assert.match(warm.warming.coveredUntil, /^\d{4}-/);
        warm.release();
    });

    it("socket still not connected at warmWait: WARMING with retryAfterSec, and its hold is released", async () => {
        const d = daemon();
        d.dp.start({ id: 1 });
        const p = d.dp.admit({ cls: "socket" }).then(
            () => null,
            (e) => e,
        );
        await d.clock.advance(10 * SEC);
        const e = await p;
        assert.ok(e instanceof PresenceRefusal && e.code === "WARMING" && e.retryAfterSec >= 2, String(e));
        assert.deepEqual(d.dp.presence.snapshot().holds, {});
    });

    it("a wait holds the socket for its length (metered), none-class calls do not wait", async () => {
        const d = daemon();
        d.dp.start({ id: 1 });
        const w = await d.dp.admit({ cls: "wait" });
        assert.deepEqual(d.dp.presence.snapshot().holds, { wait: 1 });
        assert.equal(d.made.length, 1, "a wait wakes the socket");
        w.release();
        assert.deepEqual(d.dp.presence.snapshot().holds, {});
    });

    it("a CRM lease wakes it; serve() answers status, wake and park", async () => {
        const d = daemon();
        d.dp.start({ id: 1 });
        const lease = d.dp.leases.create({ holder: "crm-1" });
        assert.equal(lease.state, "waking");
        d.made[0].up();
        d.dp.leases.release(lease.leaseId);
        const s = await d.dp.serve({ action: "status" });
        assert.equal(s.mode, "on-demand");
        assert.equal(s.leases, 0);
        await d.clock.advance(30 * SEC);
        const parked = await d.dp.serve({ action: "park" });
        assert.equal(parked.parked, true);
        await d.dp.serve({ action: "wake" });
        await tick();
        assert.equal(d.made.length, 2);
        await assert.rejects(d.dp.serve({ action: "sideways" }), /unknown presence action/);
    });
});

describe("daemon presence: yielded (another session of the same login took the socket)", () => {
    it("the kick yields: the daemon stays up and every request is refused with YIELDED until a resume", async () => {
        const d = daemon();
        d.dp.start({ id: 1 });
        (await d.dp.admit()).release();
        d.made[0].up();
        d.made[0].emit("kicked", { via: "frame-3000" });
        assert.deepEqual(d.ended, [], "no exit 3 on an on-demand daemon");
        assert.equal(d.dp.presence.state, "yielded");
        assert.ok(d.notes.includes("yielded"));
        assert.ok(!d.notes.includes("sup:kicked"), "the kick is said as yielded, never as kicked");
        assert.ok(d.healthCalls.includes("yielded"));
        for (const cls of ["none", "fresh", "socket", "wait"]) {
            await assert.rejects(d.dp.admit({ cls }), (e) => e.code === "YIELDED" && /resume --yes/.test(e.message));
        }
        assert.throws(
            () => d.dp.leases.create({ holder: "crm-1" }),
            (e) => e.code === "YIELDED",
        );
        await assert.rejects(d.dp.serve({ action: "wake" }), (e) => e.code === "YIELDED");
        await d.clock.advance(60 * MIN);
        assert.equal(d.made.length, 1, "nothing took the account back on its own");
        const r = await d.dp.serve({ action: "resume" });
        assert.equal(r.resumed, true);
        await tick();
        assert.equal(d.made.length, 2, "only the resume opened the socket again");
        d.made[1].up();
        const t = await d.dp.admit({ cls: "socket" });
        t.release();
    });

    it("resume is refused when nothing yielded; always-on keeps exit 3 on a kick", async () => {
        const d = daemon();
        d.dp.start({ id: 1 });
        await assert.rejects(d.dp.serve({ action: "resume" }), (e) => e.code === "NOT_YIELDED");
        const a = daemon({ presence: { mode: "always-on" } });
        a.dp.start({ id: 1 });
        a.made[0].up();
        a.made[0].emit("kicked", { via: "frame-3000" });
        assert.deepEqual(a.ended, ["kicked"]);
    });
});

describe("daemon presence: signed out (Zalo refuses the saved login)", () => {
    const refused = () => Object.assign(new Error("session refused"), { code: 102 });

    it("the daemon stays up in signed-out, refuses everything with SIGNED_OUT and never retries", async () => {
        const d = daemon({ presence: { mode: "always-on" }, relogin: [refused(), refused(), refused()] });
        d.dp.start({ id: 1 });
        d.made[0].up();
        d.made[0].emit("session-invalid", { kind: "session-invalid", code: 102 });
        await until(() => d.dp.presence.state === "signed-out", "signed-out");
        assert.deepEqual(d.ended, [], "no exit 4");
        assert.ok(d.notes.includes("signed_out"));
        assert.ok(d.healthCalls.includes("signed-out"));
        assert.ok(d.made[0].calls.includes("dispose"), "the socket was let go");
        for (const cls of ["none", "socket", "wait"]) {
            await assert.rejects(d.dp.admit({ cls }), (e) => e.code === "SIGNED_OUT" && /QR/.test(e.message));
        }
        await assert.rejects(d.dp.serve({ action: "resume" }), (e) => e.code === "SIGNED_OUT");
        assert.equal(d.host.wake(), null, "no session left to wake");
        await d.clock.advance(60 * MIN);
        assert.equal(d.made.length, 1);
    });

    it("ZALO_EXIT_ON_SIGNED_OUT=1 keeps the old ending (exit 4)", async () => {
        const d = daemon({ env: { ZALO_EXIT_ON_SIGNED_OUT: "1" }, relogin: [refused(), refused(), refused()] });
        d.dp.start({ id: 1 });
        (await d.dp.admit()).release();
        d.made[0].up();
        d.made[0].emit("session-invalid", { kind: "session-invalid", code: 102 });
        await until(() => d.ended.length, "the exit");
        assert.deepEqual(d.ended, ["revoked"]);
    });
});

describe("daemon presence: the role and --no-self-heal", () => {
    it("stdio MCP and a foreground listen are always-on; --http and a background listen follow the settings", () => {
        assert.equal(presenceTransport({ command: "mcp" }), "stdio");
        assert.equal(presenceTransport({ command: "mcp", http: true }), "http");
        assert.equal(presenceTransport({ command: "listen" }), "stdout");
        assert.equal(presenceTransport({ command: "listen", background: true }), "webhook");
        const stdio = resolveDaemonPresence({ ownId: OWN, transport: "stdio", env: {} });
        assert.equal(stdio.settings.mode, "always-on");
        assert.ok(stdio.forced);
        assert.equal(resolveDaemonPresence({ ownId: OWN, transport: "http", env: {} }).settings.mode, "on-demand");
    });

    it("--no-self-heal is refused with on-demand, accepted with always-on", () => {
        const r = resolveDaemonPresence({ ownId: OWN, transport: "http", selfHeal: false, env: {} });
        assert.equal(r.problem, NO_SELF_HEAL_REFUSAL);
        assert.throws(() => daemon({ selfHeal: false }), /--no-self-heal cannot run with on-demand/);
        const env = { ZALO_PRESENCE_MODE: "always-on" };
        assert.equal(resolveDaemonPresence({ ownId: OWN, transport: "http", selfHeal: false, env }).problem, null);
        assert.equal(resolveDaemonPresence({ ownId: OWN, transport: "stdio", selfHeal: false, env: {} }).problem, null);
    });

    it("a policy switch to on-demand under --no-self-heal is refused live: the daemon stays always-on", () => {
        const d = daemon({ presence: { mode: "always-on" }, selfHeal: false });
        d.dp.start({ id: 1 });
        d.made[0].up();
        assert.equal(d.dp.presence.catchingUp, false, "without the self-heal a connect is the whole catch-up");
        d.config.presence.mode = "on-demand";
        d.dp.applyPolicy(["presence.mode"]);
        assert.equal(d.dp.mode, "always-on");
    });
});

describe("daemon presence: ZALO_CONNECT_SLOTS", () => {
    let dirs = [];
    afterEach(() => {
        dirs = [];
    });

    it("caps concurrent wakes on the machine; the slot frees at the first catch-up", async () => {
        const configDir = mkdtempSync(join(tmpdir(), "zalo-connect-slots-"));
        dirs.push(configDir);
        const env = { ZALO_CONNECT_SLOTS: "1" };
        const a = daemon({ env, configDir });
        const b = daemon({ env, configDir });
        a.dp.start({ id: "a" });
        b.dp.start({ id: "b" });
        (await a.dp.admit()).release();
        (await b.dp.admit()).release();
        await until(() => a.made.length === 1, "the first wake");
        await new Promise((r) => setTimeout(r, 700));
        assert.equal(b.made.length, 0, "the second wake waits for the slot");
        a.made[0].up();
        a.dp.noteCatchUpDone({ ms: 10 });
        await until(() => b.made.length === 1, "the second wake after the slot freed", 5000);
        b.dp.stop();
        a.dp.stop();
        assert.ok(readFileSync !== null);
    });

    it("off by default: no slot directory is touched", () => {
        const d = daemon();
        d.dp.start({ id: 1 });
        return d.dp.admit().then((t) => {
            t.release();
            assert.equal(d.made.length, 1);
        });
    });
});

describe("daemon presence: the HTTP routes and the daemon channel", () => {
    it("/events/wait opens a wait hold for its length and closes it; yielded answers 409 YIELDED", async () => {
        const d = daemon();
        d.dp.start({ id: 1 });
        let finish;
        const buffer = {
            waitForMessages: () => new Promise((r) => (finish = () => r({ messages: [], hasMore: false }))),
            readCursor: () => 0,
            getStats: () => [],
        };
        const token = "tok-0123456789abcdef";
        const server = createHTTPServer(() => {}, { buffer, presence: d.dp }, 0, token, "127.0.0.1");
        try {
            if (!server.listening) await once(server, "listening");
            const url = `http://127.0.0.1:${server.address().port}/events/wait?timeout=5`;
            const auth = { authorization: `Bearer ${token}` };
            const pending = fetch(url, { headers: auth });
            await until(() => d.dp.presence.snapshot().holds.wait === 1, "the wait hold");
            assert.equal(d.made.length, 1, "the wait woke the socket");
            finish();
            assert.equal((await pending).status, 200);
            await until(() => !d.dp.presence.snapshot().holds.wait, "the hold released");
            d.made[0].up();
            d.made[0].emit("kicked", { via: "frame-3000" });
            const refused = await fetch(url, { headers: auth });
            assert.equal(refused.status, 409);
            assert.equal((await refused.json()).code, "YIELDED");
        } finally {
            server.close();
        }
    });

    it("a CLI request over the daemon channel wakes the socket and waits for it; yielded refuses it", async () => {
        const d = daemon();
        d.dp.start({ id: 1 });
        const accountDir = mkdtempSync(join(tmpdir(), "zalo-presence-channel-"));
        const sent = [];
        const channel = await startDaemonChannel({
            getApi: () => ({ sendMessage: async (m, t) => (sent.push(t), { msgId: "1" }) }),
            accountDir,
            presenceGate: (o) => d.dp.admit(o),
        });
        try {
            const reply = sendViaDaemon(accountDir, { paths: ["x.bin"], threadId: "200", type: 0 });
            await until(() => d.made.length === 1, "the wake");
            assert.deepEqual(sent, [], "the upload waits for the socket");
            d.made[0].up();
            const r = await reply;
            assert.equal(r.ok, true);
            assert.deepEqual(sent, ["200"]);
            assert.deepEqual(d.dp.presence.snapshot().holds, {}, "the hold ended with the request");
            d.made[0].emit("kicked", { via: "frame-3000" });
            const no = await sendViaDaemon(accountDir, { paths: ["x.bin"], threadId: "200", type: 0 });
            assert.equal(no.ok, false);
            assert.equal(no.code, "YIELDED");
            assert.deepEqual(sent, ["200"]);
        } finally {
            channel.stop();
        }
    });
});

describe("MCP tools: every tool has a presence class", () => {
    it("the class table names exactly the tools registerTools registers", () => {
        const src = readFileSync(join(SRC, "mcp", "mcp-tools.js"), "utf8");
        const registered = new Set([...src.matchAll(/server\.registerTool\(\s*"(zalo_\w+)"/g)].map((m) => m[1]));
        assert.ok(registered.size >= 30, "found the tools");
        assert.deepEqual([...registered].sort(), Object.keys(TOOL_PRESENCE).sort());
        for (const c of Object.values(TOOL_PRESENCE))
            assert.ok(typeof c === "function" || /^(none|fresh|socket|wait)$/.test(c));
    });

    it("a send with a file is socket class; a text send is not", () => {
        assert.equal(presenceClassOf("zalo_send_message", { text: "hi" }), "none");
        assert.equal(presenceClassOf("zalo_send_message", { filePath: "a.pdf" }), "socket");
        assert.equal(presenceClassOf("zalo_wait_for_message", {}), "wait");
    });

    it("the gate: WARMING and YIELDED as error replies, a warming block on a fresh read, resume passes a yield", async () => {
        const answers = [];
        const door = {
            admit: async ({ cls }) => {
                const next = answers.shift();
                if (next instanceof Error) throw next;
                return { release: () => answers.push("released"), warming: cls === "fresh" ? next : null };
            },
        };
        const handlers = {};
        const server = { registerTool: (name, _meta, h) => (handlers[name] = h) };
        gateToolsByPresence(server, door);
        server.registerTool("zalo_get_messages", {}, async () => ({ content: [{ type: "text", text: '{"n":1}' }] }));
        server.registerTool("zalo_sync", {}, async () => ({ content: [{ type: "text", text: "{}" }] }));
        server.registerTool("zalo_profile", {}, async (a) => ({
            content: [{ type: "text", text: `{"a":"${a.action}"}` }],
        }));

        answers.push({ state: "waking", catchUp: true, coveredUntil: null });
        const warm = await handlers.zalo_get_messages({});
        assert.deepEqual(JSON.parse(warm.content[0].text), {
            n: 1,
            presence: { state: "waking", catchUp: true, coveredUntil: null },
        });
        assert.equal(answers.shift(), "released");

        answers.push(new PresenceRefusal({ code: "WARMING", message: "still connecting", retryAfterSec: 3 }));
        const warming = await handlers.zalo_sync({});
        assert.equal(warming.isError, true);
        assert.match(warming.content[0].text, /^Error: WARMING: still connecting \(retryAfterSec 3\)/);
        assert.equal(JSON.parse(warming.content[1].text).retryAfterSec, 3);

        answers.push(new PresenceRefusal({ code: "YIELDED", message: "another session", state: "yielded" }));
        const y = await handlers.zalo_profile({ action: "bio" });
        assert.match(y.content[0].text, /^Error: YIELDED/);
        const resumed = await handlers.zalo_profile({ action: "presence_resume" });
        assert.deepEqual(JSON.parse(resumed.content[0].text), { a: "presence_resume" });
    });
});

describe("presence: the event loop is not kept busy", () => {
    it("a host that cannot park is asked again at most every PARK_RETRY_MS, never in a loop", async () => {
        const clock = fakeClock();
        let parks = 0;
        const p = createPresence({
            ownId: OWN,
            clock,
            settings: { connectOnStart: false, idleTimeoutMs: 30 * SEC, minConnectedMs: 0 },
            host: { wake: () => {}, park: async () => (parks++, false) },
        });
        p.start();
        p.hold("tool").release();
        p.noteSocketState("connected");
        await clock.advance(10 * MIN);
        assert.ok(parks <= Math.ceil((10 * MIN) / PARK_RETRY_MS) + 1, `${parks} park attempts in 10 minutes`);
        p.stop();
    });

    it("a parked daemon keeps no timer but the ones it was given (idle: none at all)", async () => {
        const d = daemon();
        d.dp.start({ id: 1 });
        const before = d.dp.presence.snapshot();
        assert.equal(before.state, "parked");
        assert.equal(before.idleAt, null, "no idle clock runs while parked");
    });
});

describe("health and account_state know yielded and signed-out", () => {
    it("yielded and signed-out are not ready, warn, and map to their account states; a resume connects again", () => {
        const health = createDaemonHealth({ kind: "mcp", accountId: OWN, version: "0" });
        try {
            health.noteUp();
            health.noteYielded();
            health.noteDown(3000);
            assert.equal(health.ready().socket, "yielded", "the close after a yield is not a drop");
            assert.equal(health.ready().ready, false);
            assert.ok(health.snapshot().warnings.some((w) => /presence resume/.test(w)));
            assert.equal(accountStateOfHealth(health.snapshot()), "yielded");
            health.noteSocketState("connecting");
            assert.equal(health.ready().socket, "connecting", "a resume shows as connecting");
            health.noteSignedOut();
            health.noteSocketState("connecting");
            assert.equal(health.ready().socket, "signed-out", "nothing but a new login ends it");
            assert.equal(accountStateOfHealth(health.snapshot()), "signed_out");
            assert.ok(ACCOUNT_STATES.includes("yielded") && ACCOUNT_STATES.includes("signed_out"));
            assert.match(
                describeAccountState({ accountId: OWN, state: "signed_out", previous: "connected" }),
                /add the account again by QR/,
            );
        } finally {
            health.stop();
        }
    });

    it("/metrics carries the last wake and catch-up times", () => {
        const health = createDaemonHealth({ kind: "mcp", accountId: OWN, version: "0" });
        try {
            health.setSource("presence", () => ({
                mode: "on-demand",
                lastWakeMs: 1500,
                lastCatchUpMs: 700,
                meter: { connectedMs: 60_000, wakes: 2 },
            }));
            const text = renderPrometheus(health.snapshot());
            assert.match(text, /zalo_presence_last_wake_seconds\{[^}]*\} 1\.5/);
            assert.match(text, /zalo_presence_last_catch_up_seconds\{[^}]*\} 0\.7/);
            assert.match(text, /zalo_presence_wakes_total\{[^}]*\} 2/);
        } finally {
            health.stop();
        }
    });
});
