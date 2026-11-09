/**
 * `account_state` (src/core/account-state.js, WP6): each change said once, the kick said before the exit, idle is
 * never down (fleet, /ready, Prometheus), the event carries ids and no names, and both daemons wire it the same way.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    ACCOUNT_STATES,
    accountStateOfHealth,
    accountStateSystemEvent,
    createAccountStateTracker,
    createBufferStateFilter,
} from "../../src/core/account-state.js";
import { createDaemonHealth, renderPrometheus } from "../../src/core/daemon-health.js";
import { STATES, classifyAccount } from "../../src/core/fleet.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";

const OWN = "1000000000000000961";
const SRC = join(import.meta.dirname, "..", "..", "src");
before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

describe("which account_state events reach the MCP buffer a wait reads", () => {
    const run = (states) => {
        const keep = createBufferStateFilter();
        return states.filter((state) => keep({ state }));
    };

    it("a park and the wake that ends it stay out: a wait is not answered by the wake it caused", () => {
        assert.deepEqual(run(["connecting", "connected", "idle", "connecting", "connected", "idle"]), [
            "connecting",
            "connected",
        ]);
    });

    it("a drop after the wake, a kick, a yield and a sign-out still go in", () => {
        assert.deepEqual(
            run(["connecting", "connected", "idle", "connecting", "connected", "connecting", "connected"]),
            ["connecting", "connected", "connecting", "connected"],
        );
        assert.deepEqual(run(["connected", "idle", "connecting", "yielded"]), ["connected", "yielded"]);
        assert.deepEqual(run(["connected", "idle", "connecting", "login_needed", "signed_out"]), [
            "connected",
            "login_needed",
            "signed_out",
        ]);
        assert.deepEqual(run(["connected", "kicked"]), ["connected", "kicked"]);
    });

    it("mcp start pushes through the filter, and the CLI wait prints a system event as one", () => {
        const src = readFileSync(join(SRC, "commands", "mcp.js"), "utf8");
        assert.match(src, /if \(intoBuffer\(event\)\) buffer\.pushSystem\(accountStateSystemEvent\(event\)\)/);
        assert.match(src, /if \(m\.system\) \{/);
    });
});

describe("account_state tracker", () => {
    it("each transition is said once, in order; supervisor noise maps to the same word", () => {
        const seen = [];
        const t = createAccountStateTracker({
            accountId: OWN,
            emit: (e) => seen.push(e),
            now: () => 1_700_000_000_000,
        });
        for (const s of ["connecting", "retrying", "offline", "connected", "connected", "stopped", "session-invalid"])
            t.noteSocketState(s);
        t.note("kicked", { exitCode: 3 });
        t.note("kicked", { exitCode: 3 });
        assert.deepEqual(
            seen.map((e) => [e.previous, e.state]),
            [
                [null, "connecting"],
                ["connecting", "connected"],
                ["connected", "login_needed"],
                ["login_needed", "kicked"],
            ],
        );
        assert.equal(seen.at(-1).detail.exitCode, 3);
        assert.deepEqual(t.current().state, "kicked");
    });

    it("the event shape has ids only: no name field anywhere", () => {
        const seen = [];
        const t = createAccountStateTracker({
            accountId: OWN,
            emit: (e) => seen.push(e),
            detail: () => ({ presence: "on-demand" }),
        });
        t.note("connected");
        const e = seen[0];
        assert.deepEqual(Object.keys(e).sort(), ["accountId", "at", "detail", "event", "previous", "state"]);
        assert.equal(e.event, "account_state");
        assert.ok(!/name/i.test(JSON.stringify(e)), "no name key or value");
        const sys = accountStateSystemEvent(e);
        assert.equal(sys.type, "account_state");
        assert.equal(sys.event, undefined);
        assert.match(sys.text, /connected/);
    });

    it("a receiver that throws never takes the daemon down", () => {
        const t = createAccountStateTracker({
            accountId: OWN,
            emit: () => {
                throw new Error("boom");
            },
        });
        assert.equal(t.note("connected"), true);
    });

    it("health states map to account states for the controller", () => {
        assert.equal(accountStateOfHealth(null, { running: false }), "stopped");
        assert.equal(accountStateOfHealth({ socket: { state: "idle" } }), "idle");
        assert.equal(accountStateOfHealth({ socket: { state: "up" } }), "connected");
        assert.equal(accountStateOfHealth({ socket: { state: "relogin" } }), "login_needed");
        assert.equal(accountStateOfHealth({ socket: { state: "down" } }), "connecting");
        for (const s of ["idle", "connecting", "connected", "kicked", "login_needed", "maintenance", "stopped"])
            assert.ok(ACCOUNT_STATES.includes(s));
    });
});

describe("idle is never down", () => {
    it("fleet: idle is its own state, never down, at any age", () => {
        assert.ok(STATES.includes("idle"));
        assert.equal(
            classifyAccount({ running: true, health: { socket: { state: "idle", forSec: 1e6 }, warnings: [] } }),
            "idle",
        );
    });

    it("/ready is 200 while parked; zalo_up stays 0 and zalo_presence_state says idle", async () => {
        const health = createDaemonHealth({ kind: "mcp", accountId: OWN, version: "0" });
        health.setSource("accountState", () => ({ state: "idle", since: null }));
        health.setSource("presence", () => ({ mode: "on-demand", state: "parked" }));
        const server = createHTTPServer(
            () => {},
            { health, buffer: { getStats: () => [] } },
            0,
            "tok-0123456789abcdef",
            "127.0.0.1",
        );
        try {
            if (!server.listening) await once(server, "listening");
            const base = `http://127.0.0.1:${server.address().port}`;
            assert.equal((await fetch(`${base}/ready`)).status, 503, "starting is not ready");
            health.noteUp();
            health.noteParked();
            const r = await fetch(`${base}/ready`);
            assert.equal(r.status, 200);
            assert.deepEqual(await r.json(), { ready: true, socket: "idle" });
            const text = renderPrometheus(health.snapshot());
            assert.match(text, /zalo_up\{[^}]*\} 0/);
            assert.match(text, /zalo_presence_state\{[^}]*state="idle",mode="on-demand"\} 1/);
            assert.equal(health.snapshot().accountState.state, "idle");
        } finally {
            server.close();
            health.stop();
        }
    });
});

describe("both daemons wire account_state the same way (symmetry)", () => {
    const shared = readFileSync(join(SRC, "core/daemon-presence.js"), "utf8");
    it("the shared presence wiring hands every supervisor state but a kick to the tracker", () => {
        assert.match(shared, /if \(state !== "kicked"\) accountState\?\.noteSocketState\?\.\(state\)/);
        assert.match(shared, /accountState\?\.note\?\.\("yielded"/);
        assert.match(shared, /accountState\?\.note\?\.\("signed_out"/);
    });
    for (const file of ["commands/mcp.js", "commands/listen.js"]) {
        const src = readFileSync(join(SRC, file), "utf8");
        it(`${file}: the tracker sees every supervisor state and the kick is said before exit 3`, () => {
            assert.match(src, /createAccountStateTracker\(/);
            assert.match(src, /noteSocketState: \(state\) => daemonPresence\.noteSocketState\(state\)/);
            assert.match(src, /health\.setSource\("accountState", \(\) => accountState\.current\(\)\)/);
            const kicked = src.slice(src.indexOf("onKicked: () => {"));
            const note = kicked.indexOf('accountState.note("kicked"');
            const exit = kicked.indexOf("process.exit(EXIT_CODE.KICKED)");
            assert.ok(note > 0 && exit > note, "the kicked event precedes exit 3");
            // A refused login signs out and keeps the daemon up; exit 4 (after login_needed) only when opted out.
            const revoked = src.slice(src.indexOf("onRevoked: (e) => {"));
            const signOut = revoked.indexOf("if (daemonPresence.signOut(e)) return;");
            const note4 = revoked.indexOf('accountState.note("login_needed"');
            const exit4 = revoked.indexOf("process.exit(EXIT_CODE.SESSION_REVOKED)");
            assert.ok(signOut > 0 && note4 > signOut && exit4 > note4);
        });
    }
});

after(() => {});
