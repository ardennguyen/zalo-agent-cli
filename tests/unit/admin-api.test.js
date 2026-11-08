/**
 * The admin API (src/core/admin-api.js) on a real MCP HTTP server (port 0): its own credential (an admin token, or a
 * client certificate) and never the agent's bearer token; If-Match conflicts (412); restart-only keys (422,
 * restartRequired); the audit log holds no token and no value; a change counts on the very next resolver call.
 */
import { SANDBOX_CONFIG_DIR, SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import https from "node:https";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import {
    adminTokenStatus,
    createAdminApi,
    resolveAdminCredentials,
    rotateAdminToken,
} from "../../src/core/admin-api.js";
import { policyAuditFile } from "../../src/core/policy-store.js";
import { resolveConfirmMode } from "../../src/core/confirm-guard.js";
import { resolveMediaLinkAuth } from "../../src/core/deploy-policy.js";

const OWN = "1000000000000000801";
const OTHER = "1000000000000000802";
const AGENT_TOKEN = "agent-token-0123456789abcdef";
const ADMIN_TOKEN = "admin-token-fedcba9876543210";
const servers = [];

/** A real server on port 0 serving the admin API for OWN; the agent's bearer is AGENT_TOKEN. */
async function start({ hashes, tls = null, mtls = false, usage, presence = null } = {}) {
    const admin = createAdminApi({
        ownId: OWN,
        config: {},
        presence,
        hashes: hashes ?? resolveAdminCredentials({ env: { ZALO_MCP_ADMIN_TOKEN: ADMIN_TOKEN } }).hashes,
        mtls,
        usage: usage ?? (() => ({ accounts: [{ accountId: OWN, total: 42 }] })),
        log: () => {},
    });
    const deps = { admin, buffer: { getStats: () => [] } };
    const server = createHTTPServer(() => {}, deps, 0, AGENT_TOKEN, "127.0.0.1", tls);
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    return `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}`;
}

async function call(base, path, { method = "GET", token, body, headers = {} } = {}) {
    const res = await fetch(`${base}/zalo/admin${path}`, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...headers,
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, etag: res.headers.get("etag"), body: await res.json() };
}

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    mkdirSync(getAccountDir(OWN), { recursive: true });
    mkdirSync(getAccountDir(OTHER), { recursive: true });
});
after(() => servers.forEach((s) => s.close()));

describe("admin API: presence (status, and the resume after a yield)", () => {
    it("GET /presence and POST /presence/resume go to the daemon's presence; a refusal is 409 with its code", async () => {
        const asked = [];
        let yielded = true;
        const presence = {
            serve: async ({ action }) => {
                asked.push(action);
                if (action === "resume" && !yielded) {
                    throw Object.assign(new Error("the account is not yielded"), { code: "NOT_YIELDED" });
                }
                if (action === "resume") yielded = false;
                return { mode: "on-demand", state: action === "resume" ? "waking" : "yielded" };
            },
        };
        const base = await start({ presence });
        const agent = await call(base, "/presence/resume", { method: "POST", token: AGENT_TOKEN });
        assert.equal(agent.status, 401, "the agent's token cannot resume");
        assert.deepEqual(asked, []);
        assert.equal((await call(base, "/presence", { token: ADMIN_TOKEN })).body.mode, "on-demand");
        const r = await call(base, "/presence/resume", { method: "POST", token: ADMIN_TOKEN });
        assert.equal(r.status, 200);
        assert.equal(r.body.state, "waking");
        const again = await call(base, "/presence/resume", { method: "POST", token: ADMIN_TOKEN });
        assert.equal(again.status, 409);
        assert.equal(again.body.code, "NOT_YIELDED");
        assert.equal((await call(base, "/presence/resume", { token: ADMIN_TOKEN })).status, 405);
        assert.deepEqual(asked, ["status", "resume", "resume"]);
    });

    it("a server with no presence answers 404 there", async () => {
        const base = await start();
        assert.equal((await call(base, "/presence", { token: ADMIN_TOKEN })).status, 404);
    });
});

describe("admin API: its own credential", () => {
    it("does not exist without an admin credential (404), whatever token is sent", async () => {
        const base = await start({ hashes: [] });
        assert.equal((await call(base, "/policy", { token: AGENT_TOKEN })).status, 404);
    });

    it("refuses no token, a wrong one, and the agent's own bearer token (401)", async () => {
        const base = await start();
        assert.equal((await call(base, "/policy")).status, 401);
        assert.equal((await call(base, "/policy", { token: "nope-nope-nope-nope" })).status, 401);
        const agent = await call(base, "/policy", {
            token: AGENT_TOKEN,
            method: "PATCH",
            body: { confirmMode: "off" },
        });
        assert.equal(agent.status, 401);
        assert.match(agent.body.error, /agent credential/);
        assert.equal(resolveConfirmMode({ env: {}, accountId: OWN }).mode, "agent", "nothing changed");
    });

    it("refuses the agent's token even when an admin token was set to the same value", async () => {
        const base = await start({
            hashes: resolveAdminCredentials({ env: { ZALO_MCP_ADMIN_TOKEN: AGENT_TOKEN } }).hashes,
        });
        assert.equal((await call(base, "/policy", { token: AGENT_TOKEN })).status, 401);
    });

    it("the sealed token from `policy token --rotate` admits, and a rotation retires the old one at once", async () => {
        const base = await start({ hashes: [] });
        const first = rotateAdminToken();
        assert.equal(adminTokenStatus().set, true);
        assert.equal((await call(base, "/policy", { token: first.token })).status, 200);
        assert.doesNotMatch(
            readFileSync(join(CONFIG_DIR, "admin", "admin-token.json"), "latin1"),
            new RegExp(first.token),
        );
        await new Promise((r) => setTimeout(r, 20));
        const second = rotateAdminToken();
        assert.equal((await call(base, "/policy", { token: first.token })).status, 401);
        assert.equal((await call(base, "/policy", { token: second.token })).status, 200);
    });

    it("a token file (a provider's mount) is read, and a short one is reported, not used", () => {
        const file = join(SANDBOX_HOME, "admin-token");
        writeFileSync(file, `${ADMIN_TOKEN}\n`);
        assert.equal(resolveAdminCredentials({ env: { ZALO_MCP_ADMIN_TOKEN_FILE: file } }).hashes.length, 1);
        writeFileSync(file, "short");
        const r = resolveAdminCredentials({ env: { ZALO_MCP_ADMIN_TOKEN_FILE: file } });
        assert.equal(r.hashes.length, 0);
        assert.match(r.problems[0], /fewer than 16/);
    });
});

describe("admin API: reading and changing the policy", () => {
    it("PATCH applies live: the very next resolver call sees it; GET returns rev, ETag and the effective settings", async () => {
        const base = await start();
        const before = await call(base, "/policy", { token: ADMIN_TOKEN });
        assert.equal(before.status, 200);
        const rev = before.body.rev;
        const r = await call(base, "/policy", {
            token: ADMIN_TOKEN,
            method: "PATCH",
            headers: { "If-Match": `"${rev}"` },
            body: { confirmMode: "human", media: { linkAuth: "bearer" } },
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.rev, rev + 1);
        assert.equal(r.etag, `"${rev + 1}"`);
        assert.deepEqual(r.body.changed, ["confirmMode", "media.linkAuth"]);
        assert.deepEqual(r.body.effective.confirmMode, { mode: "human", source: "policy:confirmMode" });
        // The next tool call's resolvers, with an environment that says otherwise.
        assert.equal(resolveConfirmMode({ env: { ZALO_MCP_CONFIRM_MODE: "off" }, accountId: OWN }).mode, "human");
        assert.equal(
            resolveMediaLinkAuth({ env: { ZALO_MCP_MEDIA_LINK_AUTH: "capability" }, accountId: OWN }).linkAuth,
            "bearer",
        );
    });

    it("If-Match with a stale rev is 412 and changes nothing", async () => {
        const base = await start();
        const { body } = await call(base, "/policy", { token: ADMIN_TOKEN });
        const stale = await call(base, "/policy", {
            token: ADMIN_TOKEN,
            method: "PATCH",
            headers: { "If-Match": `"${body.rev + 5}"` },
            body: { hiddenChats: "include" },
        });
        assert.equal(stale.status, 412);
        assert.equal(stale.body.rev, body.rev);
        assert.equal((await call(base, "/policy", { token: ADMIN_TOKEN })).body.rev, body.rev);
    });

    it("a restart-only key is 422 restartRequired; a bad value is 400 with the key named; bad JSON is 400", async () => {
        const base = await start();
        const restart = await call(base, "/policy", {
            token: ADMIN_TOKEN,
            method: "PATCH",
            body: { httpPort: 9999, confirmMode: "off" },
        });
        assert.equal(restart.status, 422);
        assert.deepEqual(restart.body.restartRequired, ["httpPort"]);
        const bad = await call(base, "/policy", {
            token: ADMIN_TOKEN,
            method: "PATCH",
            body: { quota: { warnAt: 3 } },
        });
        assert.equal(bad.status, 400);
        assert.equal(bad.body.errors[0].key, "quota.warnAt");
        assert.equal((await call(base, "/policy", { token: ADMIN_TOKEN, method: "PUT", body: "{nope" })).status, 400);
    });

    it("PUT replaces another account's policy and a tenant's; an unknown account is 404", async () => {
        const base = await start();
        const put = await call(base, `/policy/${OTHER}`, {
            token: ADMIN_TOKEN,
            method: "PUT",
            body: { policy: { hiddenChats: "contentless" } },
        });
        assert.equal(put.status, 200, JSON.stringify(put.body));
        assert.deepEqual(put.body.policy, { hiddenChats: "contentless" });
        const tenant = await call(base, "/policy/tenants/acme", {
            token: ADMIN_TOKEN,
            method: "PUT",
            body: { quota: { tenant: { limit: "10GB", accounts: [OWN, OTHER] } } },
        });
        assert.equal(tenant.status, 200, JSON.stringify(tenant.body));
        assert.deepEqual((await call(base, "/policy", { token: ADMIN_TOKEN })).body.tenants, ["acme"]);
        assert.equal(
            (await call(base, "/policy/1999999999", { token: ADMIN_TOKEN, method: "PATCH", body: {} })).status,
            404,
        );
    });

    it("GET /usage answers what the server measures", async () => {
        const base = await start();
        const u = await call(base, "/usage", { token: ADMIN_TOKEN });
        assert.equal(u.status, 200);
        assert.equal(u.body.accounts[0].total, 42);
    });

    it("the audit log has the changes and the refusals, and no token or value", async () => {
        const log = readFileSync(policyAuditFile(), "utf8");
        assert.match(log, /"result":"applied"/);
        assert.match(log, /"result":"agentCredentialRefused"/);
        assert.match(log, /"result":"conflict"/);
        assert.match(log, /"result":"restartRequired"/);
        for (const secret of [ADMIN_TOKEN, AGENT_TOKEN, "contentless", "10GB"])
            assert.ok(!log.includes(secret), secret);
    });
});

/** A CA, a server certificate and a client certificate, made with openssl (skipped where there is none). */
function makeCerts() {
    const dir = join(SANDBOX_HOME, "pki");
    mkdirSync(dir, { recursive: true });
    const run = (args) => spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
    if (run(["version"]).status !== 0) return null;
    const subj = (cn) => ["-subj", `/CN=${cn}`];
    const steps = [
        [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "ca.key",
            "-out",
            "ca.crt",
            "-days",
            "2",
            ...subj("test-ca"),
        ],
        ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", ...subj("127.0.0.1")],
        [
            "x509",
            "-req",
            "-in",
            "srv.csr",
            "-CA",
            "ca.crt",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-out",
            "srv.crt",
            "-days",
            "2",
        ],
        ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "cli.key", "-out", "cli.csr", ...subj("console")],
        [
            "x509",
            "-req",
            "-in",
            "cli.csr",
            "-CA",
            "ca.crt",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-out",
            "cli.crt",
            "-days",
            "2",
        ],
    ];
    for (const s of steps) if (run(s).status !== 0) return null;
    const f = (n) => readFileSync(join(dir, n));
    return { ca: f("ca.crt"), srvKey: f("srv.key"), srvCrt: f("srv.crt"), cliKey: f("cli.key"), cliCrt: f("cli.crt") };
}

describe("admin API: mTLS", () => {
    const pki = makeCerts();
    it(
        "a client certificate from admin.clientCa admits; none does not",
        { skip: pki ? false : "no openssl" },
        async () => {
            const base = await start({
                hashes: [],
                mtls: true,
                tls: { cert: pki.srvCrt, key: pki.srvKey, ca: pki.ca },
            });
            const get = (cert) =>
                new Promise((resolve, reject) => {
                    const req = https.request(
                        `${base}/zalo/admin/policy`,
                        {
                            ca: pki.ca,
                            ...(cert ? { cert: pki.cliCrt, key: pki.cliKey } : {}),
                            checkServerIdentity: () => undefined,
                        },
                        (res) => {
                            res.resume();
                            resolve(res.statusCode);
                        },
                    );
                    req.on("error", reject);
                    req.end();
                });
            assert.equal(await get(true), 200);
            assert.equal(await get(false), 401);
        },
    );
});
