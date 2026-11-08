/**
 * CRM leases (src/core/presence-leases.js) on a real MCP HTTP server (port 0): 201/200/404/204, the TTL bounds, the
 * per-account cap (429), the agent's bearer token is enough (no admin credential), a lease holds the presence socket
 * and its expiry releases it, and the holder id never reaches a log or a reply.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { LEASE_TTL, createLeaseRoutes, createLeaseStore } from "../../src/core/presence-leases.js";
import { createPresence } from "../../src/core/presence.js";

const AGENT_TOKEN = "agent-token-0123456789abcdef";
const HOLDER = "crm_inbox-HOLDER7";
const servers = [];

/** A clock the test moves; timers fire only on advance. */
function fakeClock() {
    let t = 1_700_000_000_000;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => t,
        setTimeout(fn, ms) {
            timers.set(++seq, { at: t + ms, fn });
            return seq;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        advance(ms) {
            t += ms;
            for (const [id, x] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
                if (x.at <= t && timers.has(id)) {
                    timers.delete(id);
                    x.fn();
                }
            }
        },
    };
}

async function start({ presence = null, maxLeases, clock, logs = [] } = {}) {
    const store = createLeaseStore({ presence, ...(maxLeases ? { maxLeases } : {}), ...(clock ? { clock } : {}) });
    const leases = createLeaseRoutes({
        store,
        describe: () => presence?.snapshot() ?? null,
        log: (l) => logs.push(l),
    });
    const server = createHTTPServer(() => {}, { leases, buffer: { getStats: () => [] } }, 0, AGENT_TOKEN, "127.0.0.1");
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    return { base: `http://127.0.0.1:${server.address().port}`, store };
}

async function call(base, path, { method = "GET", token = AGENT_TOKEN, body } = {}) {
    const res = await fetch(`${base}/zalo/presence${path}`, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        /* an HTML 404 from express */
    }
    return { status: res.status, body: parsed, raw: text };
}

function presenceRig() {
    const calls = [];
    const p = createPresence({
        ownId: "1000000000000000951",
        host: {
            wake: (why) => calls.push(`wake:${why}`),
            park: async () => true,
        },
        settings: { connectOnStart: false },
    });
    p.start();
    return { p, calls };
}

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));
after(() => servers.forEach((s) => s.close()));

describe("lease API on a real server", () => {
    it("create 201, renew 200, release 204, then renew and release are 404", async () => {
        const { base } = await start();
        const created = await call(base, "/leases", { method: "POST", body: { holder: HOLDER } });
        assert.equal(created.status, 201);
        assert.match(created.body.leaseId, /^pl_[A-Za-z0-9_-]{10,}$/);
        assert.ok(Date.parse(created.body.expiresAt) > Date.now() + 80_000, "default ttl 90 s");
        const id = created.body.leaseId;
        const renewed = await call(base, `/leases/${id}`, { method: "PUT", body: { ttlSec: 300 } });
        assert.equal(renewed.status, 200);
        assert.ok(Date.parse(renewed.body.expiresAt) > Date.now() + 290_000);
        assert.equal((await call(base, `/leases/${id}`, { method: "DELETE" })).status, 204);
        assert.equal((await call(base, `/leases/${id}`, { method: "PUT", body: {} })).status, 404);
        assert.equal((await call(base, `/leases/${id}`, { method: "DELETE" })).status, 404);
    });

    it("refuses a missing token, but takes the agent's bearer (no admin credential needed)", async () => {
        const { base } = await start();
        assert.equal(
            (await call(base, "/leases", { method: "POST", token: null, body: { holder: HOLDER } })).status,
            401,
        );
        assert.equal((await call(base, "/leases", { method: "POST", body: { holder: HOLDER } })).status, 201);
    });

    it("checks the holder and the TTL bounds (400)", async () => {
        const { base } = await start();
        for (const body of [
            {},
            { holder: "has space" },
            { holder: "x".repeat(65) },
            { holder: "a@b.example" },
            { holder: HOLDER, ttlSec: LEASE_TTL.minSec - 1 },
            { holder: HOLDER, ttlSec: LEASE_TTL.maxSec + 1 },
            { holder: HOLDER, ttlSec: 30.5 },
        ]) {
            const r = await call(base, "/leases", { method: "POST", body });
            assert.equal(r.status, 400, JSON.stringify(body));
            assert.equal(r.body.code, "INVALID");
        }
    });

    it("caps the leases per account (429)", async () => {
        const { base } = await start({ maxLeases: 2 });
        for (let i = 0; i < 2; i++)
            assert.equal((await call(base, "/leases", { method: "POST", body: { holder: HOLDER } })).status, 201);
        const third = await call(base, "/leases", { method: "POST", body: { holder: HOLDER } });
        assert.equal(third.status, 429);
        assert.equal(third.body.code, "TOO_MANY");
    });

    it("a lease wakes a parked presence and holds it; GET shows counts, never a holder", async () => {
        const { p, calls } = presenceRig();
        const logs = [];
        const { base } = await start({ presence: p, logs });
        assert.equal(p.state, "parked");
        const created = await call(base, "/leases", { method: "POST", body: { holder: HOLDER } });
        assert.equal(created.body.state, "waking");
        assert.deepEqual(calls, ["wake:lease"]);
        const view = await call(base, "");
        assert.equal(view.status, 200);
        assert.equal(view.body.leases, 1);
        assert.deepEqual(view.body.holds, { lease: 1 });
        assert.equal(view.body.mode, "on-demand");
        assert.ok(!view.raw.includes(HOLDER), "GET /zalo/presence must not name a holder");
        await call(base, `/leases/${created.body.leaseId}`, { method: "DELETE" });
        assert.equal(p.holding("lease"), false, "the release ends the hold: the idle clock starts");
        assert.ok(logs.length >= 2);
        assert.ok(!logs.join("\n").includes(HOLDER), "no holder id in the log");
    });

    it("with no presence (always connected) a lease is accepted and holds nothing", async () => {
        const { base } = await start();
        const view = await call(base, "");
        assert.equal(view.body.mode, "always-on");
        assert.equal(
            (await call(base, "/leases", { method: "POST", body: { holder: HOLDER } })).body.state,
            "connected",
        );
    });

    it("the route does not exist on a server that was not given leases", async () => {
        const server = createHTTPServer(() => {}, { buffer: { getStats: () => [] } }, 0, AGENT_TOKEN, "127.0.0.1");
        servers.push(server);
        if (!server.listening) await once(server, "listening");
        const r = await call(`http://127.0.0.1:${server.address().port}`, "");
        assert.equal(r.status, 404);
    });
});

describe("lease store: expiry", () => {
    it("the TTL expiry releases the presence hold; renewing first keeps it", () => {
        const clock = fakeClock();
        const { p } = presenceRig();
        const store = createLeaseStore({ presence: p, clock });
        const a = store.create({ holder: HOLDER, ttlSec: 15 });
        const b = store.create({ holder: HOLDER, ttlSec: 15 });
        clock.advance(10_000);
        store.renew(b.leaseId, { ttlSec: 15 });
        clock.advance(5_000);
        assert.equal(store.count(), 1, "a expired at 15 s");
        assert.throws(() => store.renew(a.leaseId), { code: "NOT_FOUND" });
        assert.equal(p.holding("lease"), true);
        clock.advance(10_000);
        assert.equal(store.count(), 0);
        assert.equal(p.holding("lease"), false);
    });

    it("stop() drops every lease and its hold", () => {
        const { p } = presenceRig();
        const store = createLeaseStore({ presence: p, clock: fakeClock() });
        store.create({ holder: HOLDER });
        store.stop();
        assert.equal(store.count(), 0);
        assert.equal(p.holding(), false);
    });
});
