/**
 * Engine 3.1 part A, the generic surfaces a control plane drives: limits (`limits.accountsPerUser`,
 * `limits.usersPerTenant`, `presence.alwaysOn.onCap`, `quota.user.limit`, `media.store`, `retention.mediaTempCap`),
 * the QR add refused before its login starts, users and tenants listed and deleted (refused while they have members),
 * the host's `GET /usage` and `GET /routes` on the fleet controller, and the access and secrets routes of an account
 * (OAuth clients and grants, named API keys, webhook secret and test, approver password, zCloud key). Every refusal
 * carries a stable `code`; the audit log holds ids and action codes, never a value.
 *
 * Every id is made up: users and tenants are opaque ids, accounts are fake ids of the sandbox.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import {
    applyPolicy,
    checkQrAdd,
    deleteTenant,
    deleteUser,
    describeTenants,
    describeUsers,
    effectivePolicy,
    policyAuditFile,
    resetPolicyCache,
} from "../../src/core/policy-store.js";
import { validatePolicy } from "../../src/core/policy-schema.js";
import { resolveMediaStore, resolveMediaTempCap } from "../../src/core/deploy-policy.js";
import { hostUsage, resolveQuota } from "../../src/core/storage-quota.js";
import { mediaTempRoot, sweepMediaTemp } from "../../src/core/media-deliver.js";
import { createAdminApi, resolveAdminCredentials } from "../../src/core/admin-api.js";
import { createAccessApi } from "../../src/core/access-api.js";
import { createApiKeyChecker, createApiKey } from "../../src/core/api-keys.js";
import { createWebhookSecretSource } from "../../src/core/webhook-secret.js";
import { saveCloudKey } from "../../src/core/cloud-key-store.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { OAUTH_STATE_FILE, createOAuthStore } from "../../src/mcp/mcp-oauth.js";
import { createFleetController } from "../../src/core/fleet-controller.js";
import { createQrFlows } from "../../src/core/fleet-qr.js";
import { buildControllerApp } from "../../src/core/fleet-serve.js";
import { describeAccountRoutes } from "../../src/core/fleet-templates.js";

const ADMIN = "admin-token-fedcba9876543210";
const AGENT = "agent-token-0123456789abcdef";
const servers = [];

let n = 0;
/** A fresh account folder. */
function account() {
    const id = String(1000000000000000500n + BigInt(n++));
    mkdirSync(getAccountDir(id), { recursive: true });
    return id;
}
let un = 0;
const user = () => `cpUser${un++}`;
let tn = 0;
const tenant = () => `cpTenant${tn++}`;

const putUser = (id, body) =>
    applyPolicy({ target: { kind: "user", id }, op: "patch", policy: body.policy ?? {}, actor: "t", ...body });
const putTenant = (id, policy) => applyPolicy({ target: { kind: "tenant", id }, op: "put", policy, actor: "t" });
const setMode = (id, mode) =>
    applyPolicy({ target: { kind: "account", id }, op: "patch", policy: { presence: { mode } }, actor: "t" });
const refusal = (fn) => {
    try {
        fn();
    } catch (e) {
        return e;
    }
    assert.fail("expected a refusal");
};

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));
beforeEach(() => resetPolicyCache());
after(() =>
    servers.forEach((s) => {
        s.closeAllConnections?.();
        s.close();
    }),
);

describe("schema: the 3.1 keys", () => {
    it("takes each key where it belongs, normalizes it, and refuses it elsewhere", () => {
        const ok = validatePolicy({ media: { store: "photo, VOICE" }, retention: { mediaTempCap: "200MB" } });
        assert.deepEqual(ok.errors, []);
        assert.deepEqual(ok.policy.media.store, ["photo", "voice"]);
        assert.equal(validatePolicy({ media: { store: "NONE" } }).policy.media.store, "none");
        assert.match(validatePolicy({ media: { store: ["photo", "x"] } }).errors[0].error, /unknown media kind "x"/);
        const user = validatePolicy(
            {
                quota: { user: { limit: "5GB" } },
                limits: { accountsPerUser: 3 },
                presence: { alwaysOn: { onCap: "Refuse" } },
            },
            { scope: "user" },
        );
        assert.deepEqual(user.errors, []);
        assert.equal(user.policy.presence.alwaysOn.onCap, "refuse");
        assert.deepEqual(validatePolicy({ limits: { usersPerTenant: 20 } }, { scope: "tenant" }).errors, []);
        const onAccount = validatePolicy({
            quota: { user: { limit: "1GB" } },
            limits: { accountsPerUser: 1, usersPerTenant: 1 },
            presence: { alwaysOn: { onCap: "refuse" } },
        });
        assert.deepEqual(onAccount.errors.map((e) => e.key).sort(), [
            "limits.accountsPerUser",
            "limits.usersPerTenant",
            "presence.alwaysOn.onCap",
            "quota.user.limit",
        ]);
        assert.equal(validatePolicy({ limits: { usersPerTenant: 2 } }, { scope: "user" }).errors.length, 1);
    });

    it("resolves media.store and retention.mediaTempCap", () => {
        assert.equal(resolveMediaStore(null, { policy: null }).mode, "all");
        assert.equal(resolveMediaStore(null, { policy: { media: { store: "none" } } }).kinds.size, 0);
        assert.deepEqual([...resolveMediaStore(null, { policy: { media: { store: ["voice"] } } }).kinds], ["voice"]);
        assert.equal(resolveMediaTempCap(null, { policy: { retention: { mediaTempCap: "1KB" } } }), 1024);
        assert.equal(resolveMediaTempCap(null, { policy: { retention: { mediaTempCap: "unlimited" } } }), null);
        assert.equal(resolveMediaTempCap(null, { policy: null }), null);
    });
});

describe("limits.accountsPerUser and limits.usersPerTenant", () => {
    it("refuses a write that gives a user more accounts than its limit (tenant default, user override)", () => {
        const t = tenant();
        putTenant(t, { limits: { accountsPerUser: 1 } });
        const u = user();
        const [a, b] = [account(), account()];
        putUser(u, { tenant: t, accounts: [a] });
        const e = refusal(() => putUser(u, { accounts: [a, b] }));
        assert.equal(e.code, "ACCOUNTS_PER_USER_LIMIT");
        assert.equal(e.limit, 1);
        assert.deepEqual(describeUsers().find((x) => x.userId === u).accounts, [a], "nothing written");
        // The user's own limit beats the tenant's default.
        putUser(u, { policy: { limits: { accountsPerUser: 2 } } });
        putUser(u, { accounts: [a, b] });
        // A lowered limit removes nothing, and a write that does not add is not refused.
        putUser(u, { policy: { limits: { accountsPerUser: 1 } } });
        assert.deepEqual(describeUsers().find((x) => x.userId === u).accounts, [a, b].sort());
        putUser(u, { accounts: [a] });
        assert.match(readFileSync(policyAuditFile(), "utf8"), /"result":"ACCOUNTS_PER_USER_LIMIT"/);
    });

    it("refuses one user more than a tenant's limit, a new user or one moved in", () => {
        const t = tenant();
        const other = tenant();
        putTenant(t, { limits: { usersPerTenant: 1 } });
        putUser(user(), { tenant: t });
        const e = refusal(() => putUser(user(), { tenant: t }));
        assert.equal(e.code, "USERS_PER_TENANT_LIMIT");
        const mover = user();
        putUser(mover, { tenant: other });
        assert.equal(refusal(() => putUser(mover, { tenant: t })).code, "USERS_PER_TENANT_LIMIT");
        // Rewriting a member already in the tenant is not one more.
        const first = describeUsers().find((x) => x.tenant === t).userId;
        putUser(first, { policy: { confirmMode: "human" } });
    });
});

describe("presence.alwaysOn.onCap", () => {
    it("demote (the default) keeps today's behavior: the oldest always-on account goes to on-demand", () => {
        const u = user();
        const [a, b] = [account(), account()];
        putUser(u, { tenant: tenant(), accounts: [a, b] });
        setMode(a, "always-on");
        const r = setMode(b, "always-on");
        assert.equal(r.demoted.length, 1);
        assert.equal(effectivePolicy(a).presence.mode, "on-demand");
    });

    it("refuse: the write that would go over the cap is refused and nothing changes", () => {
        const t = tenant();
        putTenant(t, { presence: { alwaysOn: { onCap: "refuse" } } });
        const u = user();
        const [a, b] = [account(), account()];
        putUser(u, { tenant: t, accounts: [a, b] });
        setMode(a, "always-on");
        const e = refusal(() => setMode(b, "always-on"));
        assert.equal(e.code, "ALWAYS_ON_CAP");
        assert.equal(effectivePolicy(a).presence.mode, "always-on");
        assert.equal(effectivePolicy(b).presence?.mode ?? null, null);
        // The user's own setting overrides the tenant's.
        putUser(u, { policy: { presence: { alwaysOn: { onCap: "demote" } } } });
        assert.equal(setMode(b, "always-on").demoted.length, 1);
    });
});

describe("QR add: refused before the login starts", () => {
    it("checkQrAdd: unknown user, a user at its limit, a full always-on cap; a login again passes", () => {
        assert.equal(checkQrAdd({ userId: "cpNobody" }).code, "USER_NOT_FOUND");
        const t = tenant();
        putTenant(t, { limits: { accountsPerUser: 1 }, presence: { alwaysOn: { onCap: "refuse" } } });
        const u = user();
        const a = account();
        putUser(u, { tenant: t });
        assert.equal(checkQrAdd({ userId: u }), null);
        putUser(u, { accounts: [a] });
        const full = checkQrAdd({ userId: u });
        assert.equal(full.code, "ACCOUNTS_PER_USER_LIMIT");
        assert.equal(full.status, 409);
        assert.equal(checkQrAdd({ userId: u, accountId: a }), null, "the account it owns, logged in again");
        const v = user();
        const b = account();
        putUser(v, { tenant: tenant(), policy: { presence: { alwaysOn: { onCap: "refuse" } } }, accounts: [b] });
        setMode(b, "always-on");
        assert.equal(checkQrAdd({ userId: v, presence: "always-on" }).code, "ALWAYS_ON_CAP");
        assert.equal(checkQrAdd({ userId: v, presence: "on-demand" }), null);
    });

    it("the flow is refused with its code and no login child is spawned", () => {
        let spawned = 0;
        const flows = createQrFlows({
            spawnLogin: () => {
                spawned++;
                return { onLine: () => {}, kill: () => {}, exited: new Promise(() => {}) };
            },
            finish: async () => ({}),
            precheck: (o) => checkQrAdd(o),
            dir: join(CONFIG_DIR, "qr-test"),
        });
        const r = flows.create({ userId: "cpNobody2" });
        assert.equal(r.code, 404);
        assert.equal(r.body.code, "USER_NOT_FOUND");
        assert.equal(flows.create({ userId: "x", presence: "sometimes" }).body.code, "INVALID_PRESENCE");
        assert.equal(spawned, 0);
    });
});

/** A fleet controller app on port 0 with the admin token; `extra` goes to the controller. */
async function controllerRig({ accounts = [], extra = {}, app: appExtra = {} } = {}) {
    const controller = createFleetController({
        driver: { kind: "fake" },
        listAccounts: () => accounts.map((ownId) => ({ ownId })),
        probe: async () => ({ running: false }),
        relay: async () => null,
        runCli: async () => ({ code: 0 }),
        ...extra,
    });
    const { app } = buildControllerApp({
        controller,
        env: { ZALO_MCP_ADMIN_TOKEN: ADMIN },
        log: () => {},
        ...appExtra,
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/zalo/admin`;
    return async (path, { method = "GET", body, token = ADMIN } = {}) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
}

describe("admin API: users and tenants", () => {
    it("lists them, refuses deleting one with members (409 + code), deletes an empty one", async () => {
        const call = await controllerRig();
        const t = tenant();
        const u = user();
        const a = account();
        putTenant(t, { quota: { tenant: { limit: "1GB" } } });
        putUser(u, { tenant: t, accounts: [a] });
        const users = await call("/policy/users");
        assert.equal(users.status, 200);
        assert.deepEqual(
            users.body.users.find((x) => x.userId === u),
            {
                userId: u,
                tenant: t,
                accounts: [a],
                rev: 1,
                updatedAt: users.body.users.find((x) => x.userId === u).updatedAt,
            },
        );
        const tenants = await call("/policy/tenants");
        assert.deepEqual(tenants.body.tenants.find((x) => x.tenantId === t).users, [u]);
        let r = await call(`/policy/users/${u}`, { method: "DELETE" });
        assert.equal(r.status, 409);
        assert.equal(r.body.code, "USER_HAS_ACCOUNTS");
        r = await call(`/policy/tenants/${t}`, { method: "DELETE" });
        assert.equal(r.status, 409);
        assert.equal(r.body.code, "TENANT_HAS_MEMBERS");
        putUser(u, { accounts: [] });
        assert.equal((await call(`/policy/users/${u}`, { method: "DELETE" })).status, 200);
        assert.equal((await call(`/policy/users/${u}`, { method: "DELETE" })).body.code, "USER_NOT_FOUND");
        assert.equal((await call(`/policy/tenants/${t}`, { method: "DELETE" })).status, 200);
        assert.equal(
            describeTenants().some((x) => x.tenantId === t),
            false,
        );
        assert.equal((await call(`/policy/tenants/${t}`, { method: "DELETE" })).body.code, "TENANT_NOT_FOUND");
        assert.equal((await call("/policy/users", { method: "POST" })).body.code, "METHOD_NOT_ALLOWED");
        assert.equal((await call("/policy/users", { token: AGENT })).body.code, "UNAUTHORIZED");
    });

    it("the store functions refuse the same way", () => {
        const t = tenant();
        putTenant(t, { quota: { tenant: { accounts: [account()] } } });
        assert.equal(refusal(() => deleteTenant(t, { actor: "t" })).code, "TENANT_HAS_MEMBERS");
        assert.equal(refusal(() => deleteUser("cpNobody3", { actor: "t" })).code, "USER_NOT_FOUND");
    });
});

describe("quota.user.limit and the host usage", () => {
    it("resolves a user's share (tenant default, user override) and sums the host per user and tenant", () => {
        const t = tenant();
        putTenant(t, { quota: { user: { limit: "1GB" }, tenant: { limit: "10GB" } } });
        const u = user();
        const [a, b] = [account(), account()];
        putUser(u, { tenant: t, accounts: [a, b] });
        assert.equal(resolveQuota(a).user.limit, 1024 ** 3);
        assert.deepEqual(resolveQuota(a).user.accounts, [a, b].sort());
        putUser(u, { policy: { quota: { user: { limit: "2GB" } } } });
        assert.equal(resolveQuota(b).user.limit, 2 * 1024 ** 3);
        writeFileSync(
            join(getAccountDir(a), "quota-state.json"),
            JSON.stringify({ usage: { total: 300, db: 100, media: 200, outbox: 0, measuredAt: 1 } }),
        );
        writeFileSync(join(getAccountDir(b), "x.bin"), Buffer.alloc(10));
        const h = hostUsage([a, b], { statfs: () => ({ bavail: 5, bsize: 10, blocks: 9 }) });
        const ua = h.accounts.find((x) => x.accountId === a);
        assert.equal(ua.totalBytes, 300);
        assert.equal(ua.method, "last");
        assert.equal(ua.userId, u);
        assert.equal(h.accounts.find((x) => x.accountId === b).method, "files");
        const row = h.users.find((x) => x.userId === u);
        assert.equal(row.limitBytes, 2 * 1024 ** 3);
        assert.equal(
            row.totalBytes,
            h.accounts.reduce((s, x) => s + x.totalBytes, 0),
        );
        assert.equal(h.tenants.find((x) => x.tenantId === t).limitBytes, 10 * 1024 ** 3);
        assert.deepEqual(h.disk, { freeBytes: 50, totalBytes: 90 });
    });

    it("GET /usage on the controller answers the host's usage (no longer 501)", async () => {
        const a = account();
        const call = await controllerRig({ app: { usage: () => hostUsage([a]) } });
        const r = await call("/usage");
        assert.equal(r.status, 200);
        assert.equal(r.body.accounts[0].accountId, a);
        const none = await controllerRig();
        assert.equal((await none("/usage")).body.code, "NOT_SUPPORTED");
    });
});

describe("account routes for a host agent", () => {
    it("lists id -> port and path, the discovery rewrites, and the Caddyfile with a domain", async () => {
        const doc = describeAccountRoutes({
            accounts: [
                { ownId: "1000000000000000902", port: 3902 },
                { ownId: "1000000000000000901", port: 3901 },
                { ownId: "1000000000000000903", port: null },
            ],
            domain: "zalo.example.com",
        });
        assert.deepEqual(
            doc.routes.map((r) => [r.accountId, r.upstream, r.path]),
            [
                ["1000000000000000901", "127.0.0.1:3901", "/a/1000000000000000901"],
                ["1000000000000000902", "127.0.0.1:3902", "/a/1000000000000000902"],
            ],
        );
        assert.equal(doc.routes[0].publicUrl, "https://zalo.example.com/a/1000000000000000901");
        assert.deepEqual(doc.unrouted, ["1000000000000000903"]);
        assert.match(doc.caddyfile, /handle_path \/a\/1000000000000000901\/\* \{/);
        assert.ok(doc.internalPaths.includes("/zalo/admin/*"));
        assert.equal(describeAccountRoutes({ accounts: [], domain: null }).caddyfile, null);
        const call = await controllerRig({ extra: { routes: () => doc } });
        const r = await call("/routes");
        assert.equal(r.status, 200);
        assert.equal(r.body.routes.length, 2);
        assert.equal((await call("/routes", { method: "POST" })).body.code, "METHOD_NOT_ALLOWED");
    });
});

describe("retention.mediaTempCap", () => {
    it("removes the oldest decrypted copies until the folder is under the cap, never the one kept", () => {
        mkdirSync(mediaTempRoot(), { recursive: true });
        const now = Date.now();
        for (const [name, age] of [
            ["m-old", 30_000],
            ["m-mid", 20_000],
            ["m-new", 10_000],
        ]) {
            const d = join(mediaTempRoot(), name);
            mkdirSync(d, { recursive: true });
            writeFileSync(join(d, "f.bin"), Buffer.alloc(100));
            utimesSync(d, new Date(now - age), new Date(now - age));
        }
        const removed = sweepMediaTemp(3_600_000, now, { capBytes: 150, keep: join(mediaTempRoot(), "m-mid") });
        assert.equal(removed, 2);
        assert.deepEqual(readdirSync(mediaTempRoot()).sort(), ["m-mid"]);
        assert.equal(sweepMediaTemp(3_600_000, now), 0, "no cap: only the TTL counts");
    });
});

/** A real MCP HTTP server for one account with the admin API; its own bearer is AGENT. */
async function accountServer(ownId, { fetchFn, accountEnv } = {}) {
    const admin = createAdminApi({
        ownId,
        config: {},
        hashes: resolveAdminCredentials({ env: { ZALO_MCP_ADMIN_TOKEN: ADMIN } }).hashes,
        accessApi: createAccessApi({ config: {}, fetchFn, accountEnv, log: () => {} }),
        log: () => {},
    });
    const deps = { admin, accountDir: getAccountDir(ownId), buffer: { getStats: () => [] } };
    const server = createHTTPServer(() => {}, deps, 0, AGENT, "127.0.0.1");
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, { method = "GET", body, token = ADMIN } = {}) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { base, call };
}

describe("access: named API keys", () => {
    it("made once (hash at rest), listed without the key, accepted at once, revoked at once", async () => {
        const id = account();
        const { call } = await accountServer(id);
        const made = await call(`/zalo/admin/access/${id}/api-keys`, {
            method: "POST",
            body: { label: "crm sync", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
        });
        assert.equal(made.status, 201);
        assert.match(made.body.key, /^zak_[0-9a-f]{12}_/);
        assert.equal(readFileSync(join(getAccountDir(id), "api-keys.json"), "latin1").includes(made.body.key), false);
        const list = await call(`/zalo/admin/access/${id}/api-keys`);
        assert.deepEqual(Object.keys(list.body.keys[0]).sort(), [
            "createdAt",
            "expired",
            "expiresAt",
            "keyId",
            "label",
        ]);
        assert.equal(JSON.stringify(list.body).includes(made.body.key), false);
        // The key is a bearer for the account's server (/status sits behind the bearer check), not for the admin API.
        assert.equal((await call("/status", { token: made.body.key })).status !== 401, true);
        assert.equal((await call("/status", { token: AGENT })).status !== 401, true, "the legacy token still works");
        assert.equal((await call(`/zalo/admin/access/${id}`, { token: made.body.key })).status, 401);
        const gone = await call(`/zalo/admin/access/${id}/api-keys/${made.body.keyId}`, { method: "DELETE" });
        assert.equal(gone.body.revoked, true);
        assert.equal((await call("/status", { token: made.body.key })).status, 401);
        const again = await call(`/zalo/admin/access/${id}/api-keys/${made.body.keyId}`, { method: "DELETE" });
        assert.equal(again.body.code, "API_KEY_NOT_FOUND");
        const bad = await call(`/zalo/admin/access/${id}/api-keys`, { method: "POST", body: { label: "" } });
        assert.equal(bad.body.code, "API_KEY_INVALID");
        const audit = readFileSync(policyAuditFile(), "utf8");
        assert.match(audit, new RegExp(`"op":"apiKey.create","id":"${made.body.keyId}"`));
        assert.equal(audit.includes(made.body.key), false);
    });

    it("an expired key is refused, and the first key turns the bearer check on for a server without one", () => {
        const id = account();
        const dir = getAccountDir(id);
        const check = createApiKeyChecker(dir);
        assert.equal(check.any(), false);
        const k = createApiKey(dir, { label: "short", expiresAt: new Date(Date.now() + 60_000).toISOString() });
        assert.equal(check.verify(k.key), true);
        assert.equal(check.any(), true);
        const later = createApiKeyChecker(dir, { now: () => Date.now() + 120_000 });
        assert.equal(later.verify(k.key), false);
        assert.equal(check.verify(`${k.key.slice(0, -1)}A`), false);
    });
});

describe("access: OAuth clients and grants", () => {
    it("lists them, revokes one grant by id and all of them, removes a client; the daemon's store sees it", async () => {
        const id = account();
        const file = join(getAccountDir(id), OAUTH_STATE_FILE);
        const daemon = createOAuthStore({ file });
        daemon.addClient({ clientId: "dyn_cp1", name: "App", redirectUris: [], secretHash: null, createdAt: "x" });
        const g1 = daemon.createFamily({ cid: "dyn_cp1", scp: "mcp:tools", aud: "a", iss: "i", refreshTtlSec: 3600 });
        const g2 = daemon.createFamily({ cid: "dyn_cp1", scp: "mcp:tools", aud: "a", iss: "i", refreshTtlSec: 3600 });
        const g3 = daemon.createFamily({ cid: "dyn_cp1", scp: "mcp:tools", aud: "a", iss: "i", refreshTtlSec: 3600 });
        const { call } = await accountServer(id);
        const grants = await call(`/zalo/admin/access/${id}/oauth/grants`);
        assert.deepEqual(grants.body.grants.map((g) => g.grantId).sort(), [g1.fam, g2.fam, g3.fam].sort());
        assert.equal(JSON.stringify(grants.body).includes(g1.refreshToken), false);
        const one = await call(`/zalo/admin/access/${id}/oauth/grants/${g1.fam}`, { method: "DELETE" });
        assert.equal(one.body.revoked, true);
        assert.equal(daemon.family(g1.fam), null, "the running daemon's store re-read the file");
        assert.equal(
            (await call(`/zalo/admin/access/${id}/oauth/grants/${g1.fam}`, { method: "DELETE" })).body.code,
            "GRANT_NOT_FOUND",
        );
        const all = await call(`/zalo/admin/access/${id}/oauth/revoke-all`, { method: "POST", body: {} });
        assert.equal(all.body.revoked, 2);
        assert.equal(daemon.family(g2.fam), null);
        const g4 = daemon.createFamily({ cid: "dyn_cp1", scp: "mcp:tools", aud: "a", iss: "i", refreshTtlSec: 3600 });
        const clients = await call(`/zalo/admin/access/${id}/oauth/clients`);
        assert.equal(clients.body.clients[0].kind, "registered");
        const rm = await call(`/zalo/admin/access/${id}/oauth/clients/dyn_cp1`, { method: "DELETE" });
        assert.deepEqual(rm.body, { clientId: "dyn_cp1", removed: true, grantsRevoked: 1 });
        assert.equal(daemon.client("dyn_cp1"), null);
        assert.equal(daemon.family(g4.fam), null);
        assert.equal(
            (await call(`/zalo/admin/access/${id}/oauth/clients/dyn_cp1`, { method: "DELETE" })).body.code,
            "CLIENT_NOT_FOUND",
        );
    });

    it("lists the client the account's own environment configures, with its grant, as the daemon serves it", async () => {
        const id = account();
        // Configured only in the account's env file (the fleet's env dir), the way `fleet generate` writes it.
        const accountEnv = (ownId) =>
            ownId === id
                ? {
                      ZALO_MCP_OAUTH_CLIENT_ID: "env-client-cp",
                      ZALO_MCP_OAUTH_CLIENT_SECRET: "placeholder-client-secret",
                      ZALO_MCP_OAUTH_REDIRECT_URIS: "https://app.example.com/callback",
                  }
                : {};
        const daemon = createOAuthStore({ file: join(getAccountDir(id), OAUTH_STATE_FILE) });
        const g = daemon.createFamily({
            cid: "env-client-cp",
            scp: "mcp:tools",
            aud: "a",
            iss: "i",
            refreshTtlSec: 3600,
        });
        const { call } = await accountServer(id, { accountEnv });

        const summary = await call(`/zalo/admin/access/${id}`);
        assert.deepEqual(
            summary.body.oauth.clients.map((c) => [c.clientId, c.kind, c.confidential]),
            [["env-client-cp", "configured", true]],
        );
        assert.deepEqual(
            summary.body.oauth.grants.map((x) => [x.grantId, x.clientId]),
            [[g.fam, "env-client-cp"]],
        );
        assert.equal(JSON.stringify(summary.body).includes("placeholder-client-secret"), false, "never the secret");
        const clients = await call(`/zalo/admin/access/${id}/oauth/clients`);
        assert.deepEqual(clients.body.clients[0].redirectUris, ["https://app.example.com/callback"]);
        // It is the server's own client: removing it is refused as configured, not as unknown.
        const rm = await call(`/zalo/admin/access/${id}/oauth/clients/env-client-cp`, { method: "DELETE" });
        assert.equal(rm.body.code, "CLIENT_CONFIGURED");
        // Another account's env does not leak into this one's list.
        const other = account();
        const { call: callOther } = await accountServer(other, { accountEnv });
        assert.deepEqual((await callOther(`/zalo/admin/access/${other}/oauth/clients`)).body.clients, []);
    });
});

describe("access: webhook, approver, cloud key", () => {
    it("rotates the webhook secret (shown once), signs the test with it, and a daemon's source picks it up", async () => {
        const id = account();
        const seen = [];
        const fetchFn = async (url, init) => {
            seen.push({ url, init });
            return new Response("{}", { status: 200 });
        };
        const { call } = await accountServer(id, { fetchFn });
        assert.equal(
            (await call(`/zalo/admin/access/${id}/webhook/test`, { method: "POST" })).body.code,
            "WEBHOOK_NOT_SET",
        );
        const put = await call(`/zalo/admin/access/${id}/webhook`, {
            method: "PUT",
            body: { url: "https://hooks.example.com/zalo?token=abc" },
        });
        assert.equal(put.status, 200);
        assert.equal(put.body.url, "https://hooks.example.com/zalo", "no query string in the answer");
        const source = createWebhookSecretSource({ accountDir: getAccountDir(id), fallback: "from-env" });
        assert.equal(source(), "from-env");
        const rot = await call(`/zalo/admin/access/${id}/webhook/secret`, { method: "POST" });
        assert.match(rot.body.secret, /^whsec_/);
        assert.equal(source(), rot.body.secret, "the next delivery signs with the new secret");
        const test = await call(`/zalo/admin/access/${id}/webhook/test`, { method: "POST" });
        assert.deepEqual([test.body.delivered, test.body.signed], [true, true]);
        const sent = seen.at(-1).init;
        const want = createHmac("sha256", rot.body.secret).update(sent.body).digest("hex");
        assert.equal(sent.headers["X-Zalo-Signature"], `sha256=${want}`);
        assert.equal(JSON.parse(sent.body).event, "webhook_test");
        const summary = await call(`/zalo/admin/access/${id}`);
        assert.equal(summary.body.webhook.secret.source, "admin");
        assert.equal(JSON.stringify(summary.body).includes(rot.body.secret), false);
        assert.equal((await call(`/zalo/admin/access/${id}/webhook/secret`, { method: "DELETE" })).body.cleared, true);
        assert.equal(source(), "from-env");
        assert.equal(readFileSync(policyAuditFile(), "utf8").includes(rot.body.secret), false);
    });

    it("sets and clears the approver password (hashed), reads and deletes the cloud key status", async () => {
        const id = account();
        const { call } = await accountServer(id);
        const short = await call(`/zalo/admin/access/${id}/approver`, { method: "PUT", body: { password: "short" } });
        assert.equal(short.body.code, "APPROVER_PASSWORD_INVALID");
        const set = await call(`/zalo/admin/access/${id}/approver`, {
            method: "PUT",
            body: { password: "a long enough password" },
        });
        assert.equal(set.body.set, true);
        assert.equal(
            readFileSync(join(getAccountDir(id), "approver-secret.json"), "latin1").includes("long enough"),
            false,
        );
        assert.equal((await call(`/zalo/admin/access/${id}/approver`)).body.set, true);
        assert.equal((await call(`/zalo/admin/access/${id}/approver`, { method: "DELETE" })).body.cleared, true);
        assert.equal(
            (await call(`/zalo/admin/access/${id}/approver`, { method: "DELETE" })).body.code,
            "APPROVER_NOT_SET",
        );
        assert.equal((await call(`/zalo/admin/access/${id}/cloud-key`)).body.stored, false);
        assert.equal(
            (await call(`/zalo/admin/access/${id}/cloud-key`, { method: "DELETE" })).body.code,
            "CLOUD_KEY_NOT_FOUND",
        );
        try {
            saveCloudKey(id, { privateKeyPkcs8Base64: "AAAA" });
        } catch {
            writeFileSync(join(getAccountDir(id), "cloud-key.json"), "sealed elsewhere");
        }
        assert.equal((await call(`/zalo/admin/access/${id}/cloud-key`)).body.stored, true);
        assert.equal((await call(`/zalo/admin/access/${id}/cloud-key`, { method: "DELETE" })).body.deleted, true);
        assert.equal(existsSync(join(getAccountDir(id), "cloud-key.json")), false);
        assert.equal((await call("/zalo/admin/access/1000000000000000999")).body.code, "ACCOUNT_NOT_FOUND");
        assert.equal((await call("/zalo/admin/access/abc")).body.code, "INVALID_ACCOUNT_ID");
        const audit = readFileSync(policyAuditFile(), "utf8");
        assert.match(audit, /"op":"approver.set"/);
        assert.match(audit, /"op":"cloudKey.delete"/);
        assert.equal(audit.includes("long enough"), false);
    });
});
