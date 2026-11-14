/**
 * The fleet controller (`fleet serve`, WP7): the supervisor drivers (a fake `systemctl`, a spawn stand-in), and the
 * admin routes on a real port-0 server: the admin credential only (an agent token refused), start/stop/restart,
 * the guard on logout and remove (one call does nothing; the token is single-use and expires), the relay to a
 * daemon's presence, and the SSE stream in order. Nothing here starts a daemon or opens a socket.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    createSpawnDriver,
    createSystemdDriver,
    detectSupervisor,
    supervisorOf,
    unitName,
} from "../../src/core/fleet-supervisor.js";
import { CONFIRM_TTL_MS, createFleetController } from "../../src/core/fleet-controller.js";
import { adminWebhook, buildControllerApp } from "../../src/core/fleet-serve.js";
import { createSessionNotices } from "../../src/core/session-notice.js";

const A = "1000000000000000971";
const B = "1000000000000000972";
const ADMIN = "admin-token-fedcba9876543210";
const AGENT = "agent-token-0123456789abcdef";
const servers = [];

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));
after(() =>
    servers.forEach((s) => {
        s.closeAllConnections?.();
        s.close();
    }),
);

describe("supervisor drivers", () => {
    it("systemd: exact systemctl verbs on zalo-mcp@<id>.service, nothing else can be named", async () => {
        const calls = [];
        const d = createSystemdDriver({
            run: async (args) => {
                calls.push(args);
                return args[0] === "is-active"
                    ? { code: 0, stdout: "active\n", stderr: "" }
                    : { code: 0, stdout: "", stderr: "" };
            },
        });
        assert.equal((await d.start(A)).ok, true);
        await d.stop(A);
        await d.restart(A);
        assert.deepEqual(await d.status(A), { running: true, state: "active" });
        assert.deepEqual(calls, [
            ["start", `zalo-mcp@${A}.service`],
            ["stop", `zalo-mcp@${A}.service`],
            ["restart", `zalo-mcp@${A}.service`],
            ["is-active", `zalo-mcp@${A}.service`],
        ]);
        for (const bad of ["sshd", "1;reboot", "../x", "0123"]) assert.throws(() => unitName(bad));
        await assert.rejects(() => d.start("sshd"));
    });

    it("systemd: a failing systemctl is reported, not thrown", async () => {
        const d = createSystemdDriver({ run: async () => ({ code: 4, stdout: "", stderr: "Access denied" }) });
        const r = await d.start(A);
        assert.equal(r.ok, false);
        assert.match(r.detail, /Access denied/);
    });

    it("detectSupervisor: the variable wins, else systemd when it runs", () => {
        assert.equal(detectSupervisor({ env: { ZALO_FLEET_SUPERVISOR: "spawn" }, exists: () => true }), "spawn");
        assert.equal(detectSupervisor({ env: {}, exists: () => true }), "systemd");
        assert.equal(detectSupervisor({ env: {}, exists: () => false }), "spawn");
    });

    // G3: `fleet stop` of a unit's daemon must stop the unit (Restart=always undoes a plain stop), and `fleet
    // restart` must not spawn a second daemon beside it; an account with no unit stays a spawn.
    it("supervisorOf: per account, by its unit's state; the variable wins; no systemd means spawn", async () => {
        const calls = [];
        const show = (props) => async (args) => {
            calls.push(args);
            return { code: 0, stdout: props, stderr: "" };
        };
        const on = { env: {}, exists: () => true };
        const of = (props) => supervisorOf(A, { ...on, run: show(props) });
        assert.equal(await of("LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n"), "systemd");
        assert.equal(await of("LoadState=loaded\nActiveState=failed\nUnitFileState=disabled\n"), "systemd");
        assert.equal(await of("LoadState=loaded\nActiveState=inactive\nUnitFileState=enabled\n"), "systemd");
        assert.equal(
            await of("LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\n"),
            "spawn",
            "a template installed but never used for this account",
        );
        assert.equal(await of("LoadState=not-found\nActiveState=inactive\nUnitFileState=\n"), "spawn");
        assert.deepEqual(calls[0], ["show", `zalo-mcp@${A}.service`, "--property=LoadState,ActiveState,UnitFileState"]);
        const failing = async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" });
        assert.equal(await supervisorOf(A, { ...on, run: failing }), "spawn");
        const never = async () => assert.fail("systemctl is not asked");
        assert.equal(await supervisorOf(A, { env: {}, exists: () => false, run: never }), "spawn");
        assert.equal(
            await supervisorOf(A, { env: { ZALO_FLEET_SUPERVISOR: "systemd" }, exists: () => false, run: never }),
            "systemd",
        );
        assert.equal(
            await supervisorOf(A, { env: { ZALO_FLEET_SUPERVISOR: "spawn" }, exists: () => true, run: never }),
            "spawn",
        );
        await assert.rejects(supervisorOf("x; rm -rf /", { ...on, run: never }), /not an account id/);
    });

    it("spawn: start, stop, restart and status through the daemon helpers", async () => {
        const log = [];
        let running = false;
        const d = createSpawnDriver({
            spawnDaemon: async ({ args }) => {
                log.push(["spawn", args.at(-1)]);
                running = true;
                return { ok: true, pid: 4242 };
            },
            stopDaemon: async () => {
                log.push(["stop"]);
                const was = running;
                running = false;
                return { stopped: was, graceful: true, pid: 4242 };
            },
            daemonStatus: () => ({ running, pid: running ? 4242 : null }),
            accountDir: (id) => `/tmp/${id}`,
            argsFor: (id) => ["mcp", "start", "--account", id],
        });
        assert.match((await d.start(A)).detail, /pid 4242/);
        assert.deepEqual(await d.status(A), { running: true, state: "active", pid: 4242 });
        await d.restart(A);
        assert.deepEqual(log, [["spawn", A], ["stop"], ["spawn", A]]);
    });
});

/** A controller on a real server, its collaborators recorded. */
async function rig({ now = Date.now, accounts = [A, B], extra = {} } = {}) {
    const calls = [];
    const probes = new Map(accounts.map((id) => [id, { running: false, pid: null, health: null }]));
    const controller = createFleetController({
        driver: {
            kind: "fake",
            start: async (id) => (calls.push(["start", id]), { ok: true, detail: "started" }),
            stop: async (id) => (calls.push(["stop", id]), { ok: true, detail: "stopped" }),
            restart: async (id) => (calls.push(["restart", id]), { ok: true, detail: "restarted" }),
            status: async () => ({ running: false, state: "inactive" }),
        },
        listAccounts: () => accounts.map((ownId) => ({ ownId })),
        probe: async (id) => probes.get(id),
        relay: async (id, path, params) => (
            calls.push(["relay", id, path, params.action]),
            { ok: false, error: "this daemon does not take presence requests" }
        ),
        runCli: async (args) => (calls.push(["cli", ...args]), { code: 0, stdout: "{}", stderr: "" }),
        forget: (id) => calls.push(["forget", id]),
        log: () => {},
        now,
        ...extra,
    });
    const agentHashes = new Set([createHash("sha256").update(AGENT).digest("hex")]);
    const { app } = buildControllerApp({
        controller,
        env: { ZALO_MCP_ADMIN_TOKEN: ADMIN },
        agentHashes,
        log: () => {},
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/zalo/admin`;
    const call = async (path, { method = "GET", token = ADMIN, headers = {} } = {}) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { controller, calls, probes, call, base };
}

describe("controller routes", () => {
    it("takes the admin credential only: no token 401, an agent's token 401, no admin credential set 404", async () => {
        const { call } = await rig();
        assert.equal((await call("/accounts", { token: null })).status, 401);
        const agent = await call("/accounts", { token: AGENT });
        assert.equal(agent.status, 401);
        assert.match(agent.body.error, /agent credential/);
        assert.equal((await call("/accounts")).status, 200);
        const bare = createFleetController({
            driver: { kind: "fake" },
            listAccounts: () => [],
            probe: async () => ({}),
            relay: async () => null,
            runCli: async () => ({ code: 0 }),
        });
        const { app } = buildControllerApp({ controller: bare, env: {}, log: () => {} });
        const s = app.listen(0, "127.0.0.1");
        servers.push(s);
        await once(s, "listening");
        const r = await fetch(`http://127.0.0.1:${s.address().port}/zalo/admin/accounts`, {
            headers: { Authorization: `Bearer ${ADMIN}` },
        });
        assert.equal(r.status, 404);
    });

    it("lists accounts with their polled state; start/stop/restart drive the supervisor", async () => {
        const { call, calls, controller, probes } = await rig();
        probes.set(A, { running: true, pid: 77, health: { socket: { state: "up" } } });
        await controller.poll();
        const list = await call("/accounts");
        assert.deepEqual(
            list.body.accounts.map((a) => [a.accountId, a.state]),
            [
                [A, "connected"],
                [B, "stopped"],
            ],
        );
        for (const verb of ["start", "stop", "restart"])
            assert.equal((await call(`/accounts/${A}/${verb}`, { method: "POST" })).status, 200);
        assert.deepEqual(calls, [
            ["start", A],
            ["stop", A],
            ["restart", A],
        ]);
        assert.equal(
            (await call(`/accounts/1000000000000000999/start`, { method: "POST" })).status,
            404,
            "not registered",
        );
    });

    it("a start after a kick is a takeover, said in the reply", async () => {
        const { call, controller, probes } = await rig();
        probes.set(A, { running: false, kicked: true });
        await controller.poll();
        const r = await call(`/accounts/${A}/start`, { method: "POST" });
        assert.equal(r.body.takeover, true);
    });

    it("logout is guarded: one call does nothing, the token works once, for that action and account only", async () => {
        const { call, calls } = await rig();
        const first = await call(`/accounts/${A}/logout`, { method: "POST" });
        assert.equal(first.status, 409);
        assert.equal(first.body.confirmationRequired, true);
        assert.match(first.body.effect, /phone/);
        assert.deepEqual(calls, [], "the first call changes nothing");
        const t = first.body.confirmToken;
        assert.equal(
            (await call(`/accounts/${B}/logout`, { method: "POST", headers: { "X-Confirm": t } })).status,
            409,
            "another account",
        );
        const ok = await call(`/accounts/${A}/logout`, { method: "POST", headers: { "X-Confirm": t } });
        assert.equal(ok.status, 200);
        assert.deepEqual(calls, [
            ["stop", A],
            ["cli", "--json", "--account", A, "logout"],
        ]);
        assert.equal(
            (await call(`/accounts/${A}/logout`, { method: "POST", headers: { "X-Confirm": t } })).status,
            409,
            "single-use",
        );
    });

    it("the confirm token expires", async () => {
        let t = 1_700_000_000_000;
        const { call, calls } = await rig({ now: () => t });
        const first = await call(`/accounts/${A}`, { method: "DELETE" });
        assert.equal(first.status, 409);
        t += CONFIRM_TTL_MS + 1;
        const late = await call(`/accounts/${A}`, {
            method: "DELETE",
            headers: { "X-Confirm": first.body.confirmToken },
        });
        assert.equal(late.status, 409);
        assert.deepEqual(calls, []);
    });

    it("remove: stop, account remove, forget", async () => {
        const { call, calls } = await rig();
        const first = await call(`/accounts/${B}`, { method: "DELETE" });
        const r = await call(`/accounts/${B}`, { method: "DELETE", headers: { "X-Confirm": first.body.confirmToken } });
        assert.equal(r.status, 200);
        assert.deepEqual(calls, [
            ["stop", B],
            ["cli", "--json", "account", "remove", B],
            ["forget", B],
        ]);
    });

    it("presence wake/park is relayed to the daemon; one without presence says so (409)", async () => {
        const { call, calls } = await rig();
        const r = await call(`/accounts/${A}/presence/wake`, { method: "POST" });
        assert.equal(r.status, 409);
        assert.match(r.body.error, /presence/);
        assert.deepEqual(calls, [["relay", A, "/presence", "wake"]]);
    });

    it("presence resume is relayed to the daemon, and its refusal keeps its code", async () => {
        const { call, calls } = await rig();
        const r = await call(`/accounts/${A}/presence/resume`, { method: "POST" });
        assert.equal(r.status, 409);
        assert.deepEqual(calls, [["relay", A, "/presence", "resume"]]);
    });

    it("SSE: a snapshot first, then each change once, in order", { timeout: 15_000 }, async () => {
        const { controller, base, probes } = await rig();
        const ac = new AbortController();
        const res = await fetch(`${base}/events`, { headers: { Authorization: `Bearer ${ADMIN}` }, signal: ac.signal });
        assert.equal(res.headers.get("content-type"), "text/event-stream");
        const reader = res.body.getReader();
        let text = "";
        const readUntil = async (n) => {
            while ((text.match(/\n\n/g) || []).length < n)
                text += new TextDecoder().decode((await reader.read()).value);
        };
        await readUntil(1);
        controller.noteState(A, "connecting");
        controller.noteState(A, "connecting");
        controller.noteState(A, "connected");
        probes.set(B, { running: true, health: { socket: { state: "idle" } } });
        await controller.poll();
        await readUntil(5);
        const events = text
            .split("\n\n")
            .filter(Boolean)
            .map((b) => ({ type: /^event: (.+)$/m.exec(b)[1], data: JSON.parse(/^data: (.+)$/m.exec(b)[1]) }));
        assert.equal(events[0].type, "snapshot");
        assert.deepEqual(
            events.slice(1).map((e) => [e.data.accountId, e.data.state]),
            [
                [A, "connecting"],
                [A, "connected"],
                [A, "stopped"],
                [B, "idle"],
            ],
            "the repeated connecting is said once; the poll's changes follow in order",
        );
        controller.stop();
        ac.abort();
    });
});

describe("the saved session's end", () => {
    const END = "2026-12-01T00:00:00.000Z";

    it("lists each account's session end and relays session_expiring once per threshold", async () => {
        const hooked = [];
        const saved = new Map();
        const sessions = new Map([
            [A, { expiresAt: END, daysLeft: 40, expired: false }],
            [B, { expiresAt: END, daysLeft: 6, expired: false }],
        ]);
        const { call, controller, probes } = await rig({
            extra: {
                session: (id) => sessions.get(id) ?? null,
                sessionNotices: createSessionNotices({
                    load: (k) => saved.get(k) ?? null,
                    save: (k, v) => saved.set(k, v),
                }),
                webhook: (e) => hooked.push(e),
            },
        });
        // A running daemon's own reading wins over the jar.
        probes.set(A, {
            running: true,
            pid: 7,
            health: { socket: { state: "up" }, session: { expiresAt: END, daysLeft: 12, expired: false } },
        });
        await controller.poll();
        const list = await call("/accounts");
        assert.deepEqual(
            list.body.accounts.map((a) => [a.accountId, a.session]),
            [
                [A, { expiresAt: END, daysLeft: 12, expired: false }],
                [B, { expiresAt: END, daysLeft: 6, expired: false }],
            ],
        );
        const relayed = () => hooked.filter((e) => e.event === "session_expiring");
        assert.deepEqual(
            relayed().map((e) => [e.accountId, e.threshold, e.daysLeft, e.expiresAt]),
            [
                [A, 14, 12, END],
                [B, 7, 6, END],
            ],
        );
        for (const e of relayed())
            assert.deepEqual(Object.keys(e).sort(), [
                "accountId",
                "at",
                "command",
                "daysLeft",
                "event",
                "expired",
                "expiresAt",
                "threshold",
            ]);
        await controller.poll();
        assert.equal(relayed().length, 2, "the same threshold is not relayed again");
        sessions.set(B, { expiresAt: END, daysLeft: 2, expired: false });
        await controller.poll();
        assert.deepEqual(relayed().at(-1).threshold, 3);
        controller.stop();
    });

    it("SSE carries session_expiring like account_state", { timeout: 15_000 }, async () => {
        const { controller, base } = await rig({
            accounts: [A],
            extra: {
                session: () => ({ expiresAt: END, daysLeft: 1, expired: false }),
                sessionNotices: createSessionNotices({ load: () => null, save: () => {} }),
            },
        });
        const ac = new AbortController();
        const res = await fetch(`${base}/events`, { headers: { Authorization: `Bearer ${ADMIN}` }, signal: ac.signal });
        const reader = res.body.getReader();
        let text = "";
        await controller.poll();
        while (!/event: session_expiring\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
        const block = text.split("\n\n").find((b) => b.startsWith("event: session_expiring"));
        const data = JSON.parse(/^data: (.+)$/m.exec(block)[1]);
        assert.equal(data.accountId, A);
        assert.equal(data.threshold, 1);
        controller.stop();
        ac.abort();
    });
});

describe("admin webhook", () => {
    it("posts each event, signed when a secret is set", async () => {
        const sent = [];
        const hook = adminWebhook("https://crm.example.com/hook", "s3cret-s3cret", async (url, init) =>
            sent.push([url, init]),
        );
        hook({ event: "account_state", accountId: A, state: "idle" });
        await new Promise((r) => setImmediate(r));
        assert.equal(sent.length, 1);
        assert.match(sent[0][1].headers["X-Zalo-Signature"], /^sha256=[0-9a-f]{64}$/);
        assert.equal(adminWebhook(null, null)({}), undefined);
    });
});
