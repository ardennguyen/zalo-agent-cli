/**
 * Leased mode (src/core/fleet-lease.js): an engine of a pool runs an account only while it holds the account's lease.
 * The lease file's shape, the fence (a lower token never runs), each daemon's guard (it trips on a lost entry, a changed
 * token, its deadline even when the file can no longer be read, a higher fence), the controller's reconcile (it stops
 * before the deadline, starts only with a valid lease, keeps a kicked account down, backs off), the refusals at the
 * login, the tools, the controller's routes and the QR add, and that nothing changes without ZALO_FLEET_LEASE_FILE.
 * Fake clocks, drivers and files only: nothing here starts a daemon or opens a socket.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { EXIT_CODE } from "../../src/core/exit-codes.js";
import {
    FENCE_FILE,
    LEASES_KIND,
    LEASE_FILE_ENV,
    LEASE_STATE_KIND,
    START_LEAD_MS,
    assertLeaseCurrent,
    assertLeaseHeld,
    claimFence,
    createLeaseGuard,
    createLeaseReconciler,
    leaseLost,
    leasedMode,
    parseLeases,
    readFence,
    readLeases,
    setProcessLeaseGuard,
    startDaemonLease,
    writeLeaseState,
} from "../../src/core/fleet-lease.js";
import { createFleetController } from "../../src/core/fleet-controller.js";
import { loginDaemonAccount } from "../../src/core/daemon-account.js";
import { gateToolsByLease } from "../../src/mcp/tool-presence.js";

const A = "1000000000000000981";
const B = "1000000000000000982";
const T0 = Date.parse("2026-11-22T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

let root;
let leaseFile;
let stateFile;
const acctDir = (id) => join(root, "accounts", id);

/** Write the lease file as the lease client does. */
function writeLeases(accounts, { holder = "engine-2" } = {}) {
    const body = { kind: LEASES_KIND, v: 1, holder, at: iso(T0), accounts: {} };
    for (const [id, l] of Object.entries(accounts)) body.accounts[id] = { token: l.token, deadline: iso(l.deadline) };
    writeFileSync(leaseFile, JSON.stringify(body));
}

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    root = join(CONFIG_DIR, "fleet-lease-tests");
});
beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(acctDir(A), { recursive: true });
    mkdirSync(acctDir(B), { recursive: true });
    leaseFile = join(root, "leases.json");
    stateFile = join(root, "state.json");
    setProcessLeaseGuard(null);
});
after(() => {
    setProcessLeaseGuard(null);
    rmSync(root, { recursive: true, force: true });
});

describe("the lease file", () => {
    it("parses the contract's shape and drops entries that are not leases", () => {
        const l = parseLeases(
            JSON.stringify({
                kind: LEASES_KIND,
                v: 1,
                holder: "engine-2",
                at: iso(T0),
                accounts: {
                    [A]: { token: 8, deadline: iso(T0 + 40_000) },
                    [B]: { token: 0, deadline: iso(T0) },
                    "not-an-id": { token: 3, deadline: iso(T0) },
                    1000000000000000983: { token: 2, deadline: "never" },
                },
            }),
        );
        assert.equal(l.holder, "engine-2");
        assert.deepEqual([...l.accounts.keys()], [A]);
        assert.deepEqual(l.accounts.get(A), { token: 8, deadlineMs: T0 + 40_000 });
    });

    it("a missing, unreadable or foreign file holds no lease", () => {
        assert.equal(readLeases(leaseFile), null);
        writeFileSync(leaseFile, "{not json");
        assert.equal(readLeases(leaseFile), null);
        writeFileSync(leaseFile, JSON.stringify({ kind: "something-else", v: 1, accounts: {} }));
        assert.equal(readLeases(leaseFile), null);
        writeFileSync(leaseFile, JSON.stringify({ kind: LEASES_KIND, v: 2, accounts: {} }));
        assert.equal(readLeases(leaseFile), null);
    });

    it("leased mode is ZALO_FLEET_LEASE_FILE and nothing else", () => {
        assert.equal(leasedMode({}), false);
        assert.equal(leasedMode({ [LEASE_FILE_ENV]: "  " }), false);
        assert.equal(leasedMode({ [LEASE_FILE_ENV]: "/run/zalo-leases/leases.json" }), true);
    });
});

describe("the fence", () => {
    it("is raised to a higher token, kept for the same, and refuses a lower one", () => {
        claimFence(acctDir(A), 5, "engine-1", { now: () => T0 });
        assert.deepEqual(readFence(acctDir(A)), { token: 5, holder: "engine-1", at: iso(T0) });
        claimFence(acctDir(A), 5, "engine-1", { now: () => T0 + 1 });
        assert.equal(readFence(acctDir(A)).at, iso(T0), "the same token is not rewritten");
        claimFence(acctDir(A), 7, "engine-2", { now: () => T0 + 2 });
        assert.equal(readFence(acctDir(A)).token, 7);
        assert.throws(
            () => claimFence(acctDir(A), 6, "engine-1"),
            (e) => e.code === "LEASE_FENCED" && e.exitCode === EXIT_CODE.LEASE_LOST,
        );
        assert.equal(readFence(acctDir(A)).token, 7, "a refused claim changes nothing");
    });
});

describe("assertLeaseHeld (the login gate)", () => {
    it("outside leased mode checks nothing", () => {
        assert.equal(assertLeaseHeld(A, { env: {} }), null);
    });

    it("refuses without a valid lease, with an expired one, and below the fence", () => {
        const env = { [LEASE_FILE_ENV]: leaseFile };
        assert.throws(() => assertLeaseHeld(A, { env, now: () => T0 }), { code: "LEASE_NOT_HELD" });
        writeLeases({ [A]: { token: 4, deadline: T0 + 30_000 } });
        assert.equal(assertLeaseHeld(A, { env, now: () => T0, accountDir: acctDir(A) }).token, 4);
        assert.throws(() => assertLeaseHeld(A, { env, now: () => T0 + 30_000 }), { code: "LEASE_NOT_HELD" });
        assert.throws(() => assertLeaseHeld(B, { env, now: () => T0 }), { code: "LEASE_NOT_HELD" });
        claimFence(acctDir(A), 9, "engine-3");
        assert.throws(() => assertLeaseHeld(A, { env, now: () => T0, accountDir: acctDir(A) }), {
            code: "LEASE_FENCED",
        });
    });

    it("a daemon's login is refused before any credential is read or login made", async () => {
        const calls = [];
        await assert.rejects(
            loginDaemonAccount(
                { ownId: A, proxy: null },
                {
                    read: () => (calls.push("read"), {}),
                    login: async () => (calls.push("login"), { ownId: A }),
                    reset: () => {},
                    lease: (id) => assertLeaseHeld(id, { env: { [LEASE_FILE_ENV]: leaseFile }, now: () => T0 }),
                },
            ),
            { code: "LEASE_NOT_HELD" },
        );
        assert.deepEqual(calls, [], "no credentials read, no session opened");
    });
});

/** A guard on a fake clock and timer: `tick()` runs its check as the 1 s timer would. */
function guardFor(id, clock, lost) {
    let check = null;
    const g = createLeaseGuard({
        ownId: id,
        accountDir: acctDir(id),
        env: { [LEASE_FILE_ENV]: leaseFile },
        now: () => clock.t,
        onLost: (r) => lost.push(r),
        setInterval: (fn) => ((check = fn), { unref() {} }),
        clearInterval: () => (check = null),
    });
    return { g, tick: () => check?.() };
}

describe("the daemon's guard", () => {
    it("takes its token, claims the fence, follows renewals and trips at the deadline", () => {
        const clock = { t: T0 };
        const lost = [];
        writeLeases({ [A]: { token: 3, deadline: T0 + 40_000 } });
        const { g, tick } = guardFor(A, clock, lost);
        assert.deepEqual(g.start(), { token: 3, deadlineMs: T0 + 40_000 });
        assert.equal(readFence(acctDir(A)).token, 3);
        clock.t = T0 + 30_000;
        writeLeases({ [A]: { token: 3, deadline: T0 + 70_000 } }); // renewed: same token, later deadline
        assert.equal(tick(), null);
        clock.t = T0 + 60_000;
        assert.equal(tick(), null, "the renewal moved the deadline");
        g.current();
        clock.t = T0 + 70_000;
        assert.equal(tick(), "deadline");
        assert.deepEqual(lost, ["deadline"]);
        assert.throws(() => g.current(), { code: "LEASE_LOST" });
    });

    it("an unreadable file past the last deadline stops it (the last deadline stands)", () => {
        const clock = { t: T0 };
        const lost = [];
        writeLeases({ [A]: { token: 3, deadline: T0 + 40_000 } });
        const { g, tick } = guardFor(A, clock, lost);
        g.start();
        writeFileSync(leaseFile, "{half a file");
        clock.t = T0 + 39_000;
        assert.equal(tick(), null, "unreadable but still before the deadline");
        clock.t = T0 + 40_000;
        assert.equal(tick(), "deadline");
        assert.deepEqual(lost, ["deadline"]);
    });

    it("refuses actions at the deadline even before its timer runs (a clock check)", () => {
        const clock = { t: T0 };
        const lost = [];
        writeLeases({ [A]: { token: 3, deadline: T0 + 40_000 } });
        const { g } = guardFor(A, clock, lost);
        g.start();
        setProcessLeaseGuard(g);
        assertLeaseCurrent();
        assert.equal(leaseLost(), false);
        clock.t = T0 + 40_000;
        assert.throws(() => assertLeaseCurrent(), { code: "LEASE_LOST" });
        assert.equal(leaseLost(), true);
        assert.deepEqual(lost, ["deadline"], "the trip also stops the daemon");
    });

    it("a changed token stops it at once (a re-grant after its lease ran out)", () => {
        const clock = { t: T0 };
        const lost = [];
        writeLeases({ [A]: { token: 3, deadline: T0 + 40_000 } });
        const { g, tick } = guardFor(A, clock, lost);
        g.start();
        writeLeases({ [A]: { token: 4, deadline: T0 + 60_000 } });
        assert.equal(tick(), "token-changed");
        assert.equal(g.check(), "token-changed", "tripped once, stays tripped");
        assert.deepEqual(lost, ["token-changed"]);
    });

    it("its entry gone (released or moved) stops it at once", () => {
        const clock = { t: T0 };
        const lost = [];
        writeLeases({ [A]: { token: 3, deadline: T0 + 40_000 }, [B]: { token: 1, deadline: T0 + 40_000 } });
        const { g, tick } = guardFor(A, clock, lost);
        g.start();
        writeLeases({ [B]: { token: 1, deadline: T0 + 40_000 } });
        assert.equal(tick(), "lease-gone");
    });

    it("a higher token in the fence (a newer holder elsewhere) stops it", () => {
        const clock = { t: T0 };
        const lost = [];
        writeLeases({ [A]: { token: 3, deadline: T0 + 40_000 } });
        const { g, tick } = guardFor(A, clock, lost);
        g.start();
        claimFence(acctDir(A), 4, "engine-3");
        assert.equal(tick(), "fenced");
    });

    it("never starts with a token lower than the fence, nor without a lease", () => {
        const clock = { t: T0 };
        claimFence(acctDir(A), 9, "engine-3");
        writeLeases({ [A]: { token: 8, deadline: T0 + 40_000 } });
        assert.throws(() => guardFor(A, clock, []).g.start(), { code: "LEASE_FENCED" });
        assert.equal(readFence(acctDir(A)).token, 9);
        assert.throws(() => guardFor(B, clock, []).g.start(), { code: "LEASE_NOT_HELD" });
    });

    it("startDaemonLease: nothing outside leased mode; exit 5 without a lease; exit 5 with the lock released on a trip", () => {
        const exits = [];
        const log = () => {};
        assert.equal(
            startDaemonLease({ ownId: A, accountDir: acctDir(A), log, exit: (c) => exits.push(c), env: {} }),
            null,
        );
        assert.deepEqual(exits, []);
        const env = { [LEASE_FILE_ENV]: leaseFile };
        startDaemonLease({ ownId: A, accountDir: acctDir(A), log, exit: (c) => exits.push(c), env });
        assert.deepEqual(exits, [EXIT_CODE.LEASE_LOST]);
        assert.equal(EXIT_CODE.LEASE_LOST, 5);

        const soon = Date.now() + 60_000;
        writeLeases({ [A]: { token: 2, deadline: soon } });
        const released = [];
        const d = startDaemonLease({ ownId: A, accountDir: acctDir(A), log, exit: (c) => exits.push(c), env });
        d.onRelease(() => released.push("lock"));
        d.guard.stop();
        writeLeases({});
        assert.equal(d.guard.check(), "lease-gone");
        assert.deepEqual(released, ["lock"]);
        assert.deepEqual(exits, [EXIT_CODE.LEASE_LOST, EXIT_CODE.LEASE_LOST]);
    });
});

/** A fake supervisor: what runs, and every verb it was asked. */
function fakeDriver() {
    const running = new Set();
    const calls = [];
    return {
        running,
        calls,
        kind: "fake",
        async start(id) {
            calls.push(["start", id]);
            running.add(id);
            return { ok: true, detail: "started" };
        },
        async stop(id) {
            calls.push(["stop", id]);
            running.delete(id);
            return { ok: true, detail: "stopped" };
        },
        async restart(id) {
            calls.push(["restart", id]);
            running.add(id);
            return { ok: true, detail: "restarted" };
        },
        async status(id) {
            return { running: running.has(id), state: running.has(id) ? "active" : "inactive" };
        },
    };
}

function reconciler(driver, clock, extra = {}) {
    return createLeaseReconciler({
        driver,
        listAccounts: () => [{ ownId: A }, { ownId: B }],
        readLeases: () => readLeases(leaseFile),
        writeState: (a) => writeLeaseState(stateFile, a, { now: () => clock.t }),
        now: () => clock.t,
        ...extra,
    });
}

describe("the controller's reconcile", () => {
    it("starts only the accounts with a valid lease and writes the state file", async () => {
        const clock = { t: T0 };
        const d = fakeDriver();
        writeLeases({ [A]: { token: 6, deadline: T0 + 40_000 } });
        const r = reconciler(d, clock);
        await r.tick();
        assert.deepEqual(d.calls, [["start", A]], "B has no lease and does not run: nothing to stop");
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        assert.equal(state.kind, LEASE_STATE_KIND);
        assert.deepEqual(state.accounts, { [A]: { token: 6, running: true, state: "started" } });
        assert.equal(r.holds(A), true);
        assert.equal(r.holds(B), false);
    });

    it("stops an account START_LEAD_MS before its deadline, not later", async () => {
        const clock = { t: T0 };
        const d = fakeDriver();
        writeLeases({ [A]: { token: 6, deadline: T0 + 40_000 } });
        const r = reconciler(d, clock);
        await r.tick();
        clock.t = T0 + 40_000 - START_LEAD_MS - 1;
        await r.tick();
        assert.ok(d.running.has(A), "still running just before the lead");
        clock.t = T0 + 40_000 - START_LEAD_MS;
        await r.tick();
        assert.equal(d.running.has(A), false, "stopped at deadline - lead");
        assert.ok(clock.t < T0 + 40_000);
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        assert.deepEqual(state.accounts[A], { token: null, running: false, state: "stopped" });
    });

    it("stops an account whose lease was taken away (a planned move), and starts it again with a new one", async () => {
        const clock = { t: T0 };
        const d = fakeDriver();
        writeLeases({ [A]: { token: 6, deadline: T0 + 40_000 } });
        const r = reconciler(d, clock);
        await r.tick();
        writeLeases({});
        clock.t += 1000;
        await r.tick();
        assert.equal(d.running.has(A), false);
        writeLeases({ [A]: { token: 9, deadline: clock.t + 40_000 } });
        clock.t += 1000;
        await r.tick();
        assert.ok(d.running.has(A));
        assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).accounts[A].token, 9);
    });

    it("an expired lease is never started, and a kicked account is kept down", async () => {
        const clock = { t: T0 };
        const d = fakeDriver();
        writeLeases({ [A]: { token: 6, deadline: T0 + 3000 }, [B]: { token: 2, deadline: T0 + 40_000 } });
        const r = reconciler(d, clock, { kicked: (id) => id === B });
        await r.tick();
        assert.equal(
            d.calls.some((c) => c[0] === "start"),
            false,
        );
    });

    it("backs off a start that fails", async () => {
        const clock = { t: T0 };
        const d = fakeDriver();
        let fails = 0;
        d.start = async (id) => (d.calls.push(["start", id]), fails++, { ok: false, detail: "boom" });
        writeLeases({ [A]: { token: 6, deadline: T0 + 600_000 } });
        const r = reconciler(d, clock);
        await r.tick();
        clock.t += 5000;
        await r.tick();
        assert.equal(fails, 1, "no second try within 10 s");
        clock.t += 6000;
        await r.tick();
        assert.equal(fails, 2);
    });

    it("the running daemon's token after a controller restart comes from its fence", async () => {
        const clock = { t: T0 };
        const d = fakeDriver();
        d.running.add(A);
        writeLeases({ [A]: { token: 6, deadline: T0 + 40_000 } });
        claimFence(acctDir(A), 6, "engine-2");
        const r = reconciler(d, clock, { fenceToken: (id) => readFence(acctDir(id))?.token ?? null });
        await r.tick();
        assert.deepEqual(r.view()[A], { token: 6, running: true, state: "active" });
        assert.equal(
            d.calls.some((c) => c[0] === "start" && c[1] === A),
            false,
        );
    });
});

describe("the controller's routes in leased mode", () => {
    /** Minimal express-like req/res. */
    function call(controller, method, path) {
        return new Promise((resolve) => {
            const res = {
                code: 0,
                status(c) {
                    this.code = c;
                    return this;
                },
                set() {
                    return this;
                },
                json(b) {
                    resolve({ code: this.code, body: b });
                },
            };
            void controller
                .handle({ method, headers: {} }, res, { path, who: "admin", ip: "127.0.0.1" })
                .then((done) => {
                    if (!done) resolve({ code: 404, body: null });
                });
        });
    }

    function controller(lease) {
        const d = fakeDriver();
        const c = createFleetController({
            driver: d,
            listAccounts: () => [{ ownId: A }],
            probe: async () => ({ running: false, health: null }),
            relay: async () => null,
            runCli: async () => ({ code: 0, stdout: "", stderr: "" }),
            jobs: { handle: (_id, _rest, _req, res) => (res.status(202).json({ job: true }), true), stopAll() {} },
            lease,
        });
        return { c, d };
    }

    it("start, restart and job starts are refused without a lease; stop is not", async () => {
        const { c, d } = controller({ holds: () => false });
        for (const p of [`/accounts/${A}/start`, `/accounts/${A}/restart`, `/accounts/${A}/jobs`]) {
            const r = await call(c, "POST", p);
            assert.equal(r.code, 409, p);
            assert.equal(r.body.code, "LEASE_NOT_HELD");
        }
        assert.equal((await call(c, "GET", `/accounts/${A}/jobs`)).code, 202, "a job list is a read");
        assert.equal((await call(c, "POST", `/accounts/${A}/stop`)).code, 200);
        assert.deepEqual(d.calls, [["stop", A]]);
    });

    it("with the lease, or without leased mode, a start goes through", async () => {
        for (const lease of [{ holds: () => true }, null]) {
            const { c, d } = controller(lease);
            assert.equal((await call(c, "POST", `/accounts/${A}/start`)).code, 200);
            assert.deepEqual(d.calls, [["start", A]]);
        }
    });
});

describe("the MCP tools in leased mode", () => {
    it("refuse with LEASE_LOST once the lease ended; nothing is wrapped outside leased mode", async () => {
        const registered = {};
        const server = { registerTool: (name, _meta, handler) => (registered[name] = handler) };
        gateToolsByLease(server, { env: {} });
        server.registerTool("zalo_send_message", {}, async () => "sent");
        assert.equal(await registered.zalo_send_message({}), "sent");

        const server2 = { registerTool: (name, _meta, handler) => (registered[name] = handler) };
        let ended = false;
        gateToolsByLease(server2, {
            env: { [LEASE_FILE_ENV]: leaseFile },
            current: () => {
                if (ended) throw Object.assign(new Error("lease ended"), { code: "LEASE_LOST" });
            },
        });
        server2.registerTool("zalo_send_message", {}, async () => "sent");
        assert.equal(await registered.zalo_send_message({}), "sent");
        ended = true;
        const r = await registered.zalo_send_message({});
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /LEASE_LOST/);
    });
});

describe("fence file name", () => {
    it("is lease-fence.json in the account folder", () => {
        claimFence(acctDir(B), 1, null);
        assert.equal(JSON.parse(readFileSync(join(acctDir(B), FENCE_FILE), "utf8")).token, 1);
    });
});

describe("the saved-login paths in leased mode", () => {
    it("loginWithCredentials and probeSavedLogin open nothing without this engine's lease", async () => {
        const { loginWithCredentials, probeSavedLogin } = await import("../../src/core/zalo-client.js");
        const saved = process.env[LEASE_FILE_ENV];
        process.env[LEASE_FILE_ENV] = leaseFile;
        try {
            await assert.rejects(loginWithCredentials({ imei: "x", cookie: [] }, null), { code: "LEASE_NOT_HELD" });
            await assert.rejects(loginWithCredentials({ imei: "x", cookie: [] }, null, { ownId: A }), {
                code: "LEASE_NOT_HELD",
            });
            await assert.rejects(loginWithCredentials({ imei: "x", cookie: [] }, null, { leaseOwnId: A }), {
                code: "LEASE_NOT_HELD",
            });
            await assert.rejects(probeSavedLogin({ imei: "x", cookie: [] }, null, { ownId: A }), {
                code: "LEASE_NOT_HELD",
            });
        } finally {
            if (saved === undefined) delete process.env[LEASE_FILE_ENV];
            else process.env[LEASE_FILE_ENV] = saved;
        }
    });
});
