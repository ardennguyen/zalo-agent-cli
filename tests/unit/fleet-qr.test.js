/**
 * The QR add flow of the fleet controller (src/core/fleet-qr.js, WP8): per-flow QR pages that share no state, the
 * flow cap, an expired code followed by a new one, `done` registering once, a running daemon restarted on purpose
 * (`restarted: "relogin"`), the finish steps (port, env file, membership, presence, start), the admin routes on a real
 * port-0 server, and a static check that a QR login opens no chat socket. The login child is a stand-in.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { QrPage } from "../../src/utils/qr-http-server.js";
import { createQrFlows } from "../../src/core/fleet-qr.js";
import { createFleetController } from "../../src/core/fleet-controller.js";
import { buildControllerApp, finishQrAdd } from "../../src/core/fleet-serve.js";
import { applyPolicy, effectivePolicy, getPolicy } from "../../src/core/policy-store.js";
import { loadPortTable } from "../../src/core/fleet.js";

const ADMIN = "admin-token-fedcba9876543210";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const SRC = join(import.meta.dirname, "..", "..", "src");
const servers = [];
const tick = () => new Promise((r) => setImmediate(r));

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));
after(() =>
    servers.forEach((s) => {
        s.closeAllConnections?.();
        s.close();
    }),
);

/** A login child that says what the test tells it to. */
function fakeChild() {
    const subs = [];
    let exit;
    const child = {
        onLine: (fn) => subs.push(fn),
        kill: () => {
            child.killed = true;
            exit(143);
        },
        exited: new Promise((r) => (exit = r)),
        say: (obj) => subs.forEach((fn) => fn(JSON.stringify(obj))),
        exit: (c) => exit(c),
    };
    return child;
}

function flowsRig({ maxFlows = 4, isRunning = () => false } = {}) {
    const children = [];
    const finished = [];
    const flows = createQrFlows({
        spawnLogin: () => {
            const c = fakeChild();
            children.push(c);
            return c;
        },
        finish: async (o) => {
            finished.push(o);
            return o.wasRunning ? { restarted: "relogin" } : { started: o.start };
        },
        isRunning,
        dir: join(CONFIG_DIR, "qr-flows-test"),
        publicUrl: "https://fleet.example.com",
        maxFlows,
    });
    return { flows, children, finished };
}

describe("QrPage: one state per page", () => {
    it("two pages do not share scanned, expired or the outcome; each serves only its own token", async () => {
        const a = new QrPage().configure({ publicUrl: "https://fleet.example.com", mounted: true });
        const b = new QrPage().configure({ publicUrl: "https://fleet.example.com", mounted: true });
        const la = a.open({ qrImagePath: join(CONFIG_DIR, "none-a.png") });
        const lb = b.open({ qrImagePath: join(CONFIG_DIR, "none-b.png") });
        a.noteScanned("x");
        a.noteOutcome("done");
        const server = http.createServer(async (req, res) => {
            for (const p of [a, b]) if (p.owns(req.url)) return void (await p.handle(req, res));
            res.writeHead(404).end();
        });
        servers.push(server);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const base = `http://127.0.0.1:${server.address().port}`;
        const status = async (link) => (await fetch(`${base}/zalo/qr/${link.token}/status`)).json();
        assert.equal((await status(la)).outcome, "done");
        const sb = await status(lb);
        assert.deepEqual([sb.scanned, sb.outcome], [null, null], "page B never saw A's scan or outcome");
        assert.equal(a.owns(`/zalo/qr/${lb.token}`), false);
        assert.equal(b.owns(`/zalo/qr/${lb.token}/qr.png`), true);
    });
});

describe("QR flows", () => {
    it("a code, a scan, an expired code then a new one, and done: in that order, done once", async () => {
        const { flows, children, finished } = flowsRig();
        const r = flows.create({ userId: "crmU9", presence: "on-demand" });
        assert.equal(r.code, 202);
        assert.match(r.body.pageUrl, /^https:\/\/fleet\.example\.com\/zalo\/qr\/[A-Za-z0-9_-]{22}$/);
        const c = children[0];
        c.say({ event: "qr", image: PNG, layer: 1 });
        c.say({ event: "qr_expired" });
        c.say({ event: "qr", image: PNG, layer: 1 });
        c.say({ event: "qr_scanned", name: "Someone" });
        c.say({ event: "login_success", ownId: "1000000000000000981", name: "Someone" });
        c.say({ event: "login_success", ownId: "1000000000000000981" });
        await tick();
        await tick();
        assert.equal(finished.length, 1, "done registers once");
        assert.deepEqual(finished[0], {
            ownId: "1000000000000000981",
            userId: "crmU9",
            presence: "on-demand",
            start: true,
            wasRunning: false,
        });
        const req = { method: "GET", on: () => {} };
        let text = "";
        const res = { writeHead: () => {}, write: (t) => (text += t), end: () => {} };
        await flows.handle(req, res, { path: `/accounts/qr/${r.body.flowId}/events` });
        const types = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
        assert.deepEqual(types, ["qr", "expired", "qr", "scanned", "done"]);
        assert.ok(!text.includes("Someone"), "no name in any event");
    });

    it("caps the flows at once (429), and a cancelled one frees its slot", () => {
        const { flows, children } = flowsRig({ maxFlows: 2 });
        const one = flows.create({ userId: "u1" });
        flows.create({ userId: "u2" });
        assert.equal(flows.create({ userId: "u3" }).code, 429);
        assert.equal(flows.cancel(one.body.flowId), true);
        assert.equal(children[0].killed, true);
        assert.equal(flows.create({ userId: "u3" }).code, 202);
        assert.equal(flows.create({ userId: "bad id" }).code, 400);
        assert.equal(flows.create({ userId: "u4", presence: "sometimes" }).code, 400);
    });

    it("an account whose daemon runs is finished with wasRunning: the controller restarts it (relogin)", async () => {
        const { flows, children, finished } = flowsRig({ isRunning: () => true });
        flows.create({ userId: "u5" });
        children[0].say({ event: "login_success", ownId: "1000000000000000982" });
        await tick();
        await tick();
        assert.equal(finished[0].wasRunning, true);
    });

    it("a login child that exits without a login fails the flow", async () => {
        const { flows, children } = flowsRig();
        const r = flows.create({ userId: "u6" });
        children[0].exit(1);
        await tick();
        let text = "";
        await flows.handle(
            { method: "GET", on: () => {} },
            { writeHead: () => {}, write: (t) => (text += t), end: () => {} },
            { path: `/accounts/qr/${r.body.flowId}/events` },
        );
        assert.match(text, /event: failed/);
        assert.match(text, /"reason":"exited"/);
    });
});

describe("finish steps", () => {
    it("port, env file with a token (0600), membership, presence, start", async () => {
        const ownId = "1000000000000000983";
        mkdirSync(getAccountDir(ownId), { recursive: true });
        applyPolicy({ target: { kind: "user", id: "crmFin" }, op: "put", policy: {}, tenant: "tFin", actor: "t" });
        const envDir = join(CONFIG_DIR, "etc-accounts");
        const calls = [];
        const driver = {
            start: async (id) => (calls.push(["start", id]), { ok: true }),
            restart: async (id) => (calls.push(["restart", id]), { ok: true }),
        };
        const r = await finishQrAdd({
            ownId,
            userId: "crmFin",
            presence: "always-on",
            start: true,
            wasRunning: false,
            envDir,
            driver,
            makeToken: () => "t".repeat(64),
        });
        assert.equal(r.port, loadPortTable().ports[ownId]);
        assert.equal(r.envWritten, true);
        const file = join(envDir, `${ownId}.env`);
        assert.match(readFileSync(file, "utf8"), new RegExp(`ZALO_MCP_HTTP_PORT=${r.port}`));
        if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.deepEqual(getPolicy({ kind: "user", id: "crmFin" }).accounts, [ownId]);
        assert.equal(effectivePolicy(ownId).presence.mode, "always-on");
        assert.deepEqual(calls, [["start", ownId]]);
        const again = await finishQrAdd({
            ownId,
            userId: "crmFin",
            presence: null,
            start: false,
            wasRunning: true,
            envDir,
            driver,
        });
        assert.equal(again.envWritten, false, "an existing env file keeps its token");
        assert.equal(again.restarted, "relogin");
        assert.ok(existsSync(file));
    });
});

describe("controller QR routes on a real server", () => {
    it("POST /accounts/qr is 202 behind the admin credential; the page is served at /zalo/qr/<token>; image 404 until a code", async () => {
        const { flows } = flowsRig();
        const controller = createFleetController({
            driver: { kind: "fake" },
            listAccounts: () => [],
            probe: async () => ({ running: false }),
            relay: async () => null,
            runCli: async () => ({ code: 0 }),
            qr: flows,
        });
        const { app } = buildControllerApp({
            controller,
            env: { ZALO_MCP_ADMIN_TOKEN: ADMIN },
            qrPages: flows,
            log: () => {},
        });
        const server = app.listen(0, "127.0.0.1");
        servers.push(server);
        await once(server, "listening");
        const base = `http://127.0.0.1:${server.address().port}`;
        const auth = { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" };
        assert.equal((await fetch(`${base}/zalo/admin/accounts/qr`, { method: "POST", body: "{}" })).status, 401);
        const r = await fetch(`${base}/zalo/admin/accounts/qr`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ userId: "crmQ" }),
        });
        assert.equal(r.status, 202);
        const body = await r.json();
        assert.equal((await fetch(`${base}${body.imageUrl}`, { headers: auth })).status, 404);
        const token = body.pageUrl.split("/").pop();
        const page = await fetch(`${base}/zalo/qr/${token}`);
        assert.equal(page.status, 200);
        assert.equal(page.headers.get("cache-control"), "no-store, max-age=0");
        assert.equal((await fetch(`${base}/zalo/qr/AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
        assert.equal(
            (await fetch(`${base}/zalo/admin/accounts/qr/${body.flowId}`, { method: "DELETE", headers: auth })).status,
            200,
        );
        flows.stop();
    });
});

describe("a QR login opens no chat socket (AGENTS.md section 13)", () => {
    it("the login path never starts or supervises a listener", () => {
        for (const f of [
            "zalo/qr-login.js",
            "zalo/client.js",
            "core/zalo-client.js",
            "commands/login.js",
            "core/qr-login-flow.js",
        ]) {
            const src = readFileSync(join(SRC, f), "utf8");
            assert.doesNotMatch(src, /listener\.start\(|superviseListener|createSocketHost/, f);
        }
    });
});
