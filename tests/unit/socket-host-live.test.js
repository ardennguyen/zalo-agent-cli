/**
 * The socket host on the real stack: the real supervisor, the real zca-js listener and the fake
 * Zalo's WebSocket. The unit tests of the host script a supervisor; these check that the pieces
 * really fit: a kick ends the daemon and nothing reconnects, a refused session leads to a new login
 * and a new socket, and a socket that cannot authenticate leads to one too.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createSocketHost } from "../../src/core/socket-host.js";
import { resolveSocketSettings } from "../../src/zalo/retry.js";
import { startFakeZalo } from "../helpers/fake-zalo/index.js";

const FAST = resolveSocketSettings({
    retries: { 5015: { times: [10], max: 100 }, 4001: { times: [10], max: 100 }, internal: { times: [10], max: 100 } },
    timeout_authen: 80,
    establish_timeout: 200,
    close_timeout: 100,
});
const TIMING = { pingTimeoutMs: 60, intervalCheckMs: 30, stableMs: 10_000, resumeGapMs: 5000, stuckAfterAttempts: 2 };

async function until(check, what, ms = 4000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await check();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

describe("socket host on the real stack", () => {
    let zalo;
    let host;
    let ended;
    let logs;
    let healthStates;
    let apis;

    beforeEach(() => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        zalo = host = null;
        ended = null;
        logs = [];
        healthStates = [];
        apis = [];
    });

    afterEach(async () => {
        await host?.stop();
        for (const api of apis) {
            api.listener.on("error", () => {});
            api.listener.ws?.terminate?.();
        }
        await zalo?.stop();
    });

    /** A host wired like `listen`: a login callback, exit callbacks that record instead of exiting. */
    async function rig({ fake = {}, extra = {} } = {}) {
        zalo = await startFakeZalo(fake);
        const first = await zalo.login();
        apis.push(first);
        host = createSocketHost({
            log: (level, message) => logs.push(`${level}: ${message}`),
            health: { noteSocketState: (s) => healthStates.push(s) },
            isStopping: () => false,
            relogin: async () => {
                zalo.sock.setAutoAuth(true);
                const api = await zalo.login();
                apis.push(api);
                return api;
            },
            onKicked: () => {
                ended = "kicked";
            },
            onRevoked: () => {
                ended = "revoked";
            },
            supervisorOptions: { settings: FAST, timing: TIMING, probe: async () => true, random: () => 0 },
            ...extra,
        });
        return first;
    }

    it("a duplicate-session frame ends the daemon, and no second socket is ever opened", async () => {
        const api = await rig();
        host.start(api);
        await until(() => host.current().state === "connected", "connected");
        zalo.sock.kick();
        await until(() => ended === "kicked", "the daemon to end");
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(zalo.sock.connections.length, 1, "the daemon reconnected after being kicked");
        assert.ok(healthStates.includes("kicked"));
        assert.ok(logs.some((l) => /Another Zalo session took this account \(frame-3000\)/.test(l)));
    });

    it("a refused session logs in again and moves to a new socket, closing the old one", async () => {
        const api = await rig();
        const first = host.start(api);
        await until(() => first.state === "connected", "connected");
        first.reportServerError(102);
        await until(
            () => host.current() !== first && host.current().state === "connected",
            "the new supervisor to connect",
        );
        assert.equal(apis.length, 2);
        assert.notEqual(host.current().listener, first.listener);
        await until(() => zalo.sock.connections.length === 2, "the second connection");
        await until(() => zalo.sock.connections[0].closed, "the old socket to close");
        assert.ok(healthStates.includes("session-invalid"));
        assert.equal(ended, null);
    });

    it("a socket that cannot authenticate gets a fresh login after a few tries", async () => {
        const api = await rig({ fake: { autoAuth: false } });
        host.start(api);
        await until(() => logs.some((l) => /No usable socket after 2 tries/.test(l)), "the stuck report");
        await until(() => host.current() && host.current().listener !== api.listener, "the new supervisor");
        await until(() => host.current().state === "connected", "the new socket to authenticate");
        assert.equal(ended, null);
        assert.ok(zalo.sock.connections.length >= 3, "the failed tries and the new connection should all be there");
    });

    it("stop() closes the socket, and nothing returns", async () => {
        const api = await rig();
        host.start(api);
        await until(() => host.current().state === "connected", "connected");
        await host.stop();
        await until(() => zalo.sock.connections[0].closed, "the server to see the close");
        await new Promise((r) => setTimeout(r, 250));
        assert.equal(zalo.sock.connections.length, 1);
    });
});
