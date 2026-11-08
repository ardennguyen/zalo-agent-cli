/**
 * Users, membership and the always-on cap (src/core/policy-store.js, WP5): the user layer between a tenant and an
 * account, one owning user and one tenant per account (409 MEMBERSHIP otherwise), the precedence of presence settings
 * (src/core/presence-config.js), and the cap: over it the OLDEST always-on account is demoted to on-demand (owner
 * decision 2026-11-08), also when the cap is lowered, and under a host lock that two processes cannot both pass.
 *
 * Every id is made up: users and tenants are opaque CRM ids.
 */
import { SANDBOX_CONFIG_DIR, SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import {
    alwaysOnUsage,
    applyPolicy,
    effectivePolicy,
    enforceAlwaysOnCaps,
    getPolicy,
    onPresenceChange,
    ownerOf,
    policyAuditFile,
    resetPolicyCache,
    tenantsOf,
} from "../../src/core/policy-store.js";
import { validatePolicy } from "../../src/core/policy-schema.js";
import { resolvePresenceSettings } from "../../src/core/presence-config.js";
import { createAdminApi, resolveAdminCredentials } from "../../src/core/admin-api.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { getDefaultConfig, mergeMCPConfigLayer } from "../../src/mcp/mcp-config.js";

let n = 0;
/** A fresh account folder (the store writes only for an account that has one). */
function account() {
    const id = String(1000000000000000300n + BigInt(n++));
    mkdirSync(getAccountDir(id), { recursive: true });
    return id;
}
let u = 0;
const user = () => `crmUser${u++}`;
let tn = 0;
const tenant = () => `tenant${tn++}`;

const setMode = (id, mode, actor = "t") =>
    applyPolicy({ target: { kind: "account", id }, op: "patch", policy: { presence: { mode } }, actor });
const modeOf = (id) => effectivePolicy(id).presence?.mode ?? null;

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));
beforeEach(() => resetPolicyCache());

describe("schema: presence keys", () => {
    it("takes the presence keys at every level and keeps the caps out of an account", () => {
        const v = validatePolicy({
            presence: {
                mode: "ALWAYS-ON",
                idleTimeout: "5m",
                minConnected: "60s",
                maxWakesPerHour: 12,
                warmWait: "10s",
                connectOnStart: true,
                catchUpEvery: "off",
                maxLeases: 64,
                leaseTtl: "90s",
                leaseTtlMax: "600s",
                waitHoldsSocket: "false",
                onKick: "yield",
            },
        });
        assert.deepEqual(v.errors, []);
        assert.equal(v.policy.presence.mode, "always-on");
        assert.equal(v.policy.presence.waitHoldsSocket, false);
        const bad = validatePolicy({
            presence: { idleTimeout: "10s", catchUpEvery: "1m", alwaysOn: { maxPerUser: 2 } },
        });
        assert.deepEqual(bad.errors.map((e) => e.key).sort(), [
            "presence.alwaysOn.maxPerUser",
            "presence.catchUpEvery",
            "presence.idleTimeout",
        ]);
        assert.deepEqual(validatePolicy({ presence: { alwaysOn: { maxPerUser: 2 } } }, { scope: "user" }).errors, []);
        assert.equal(
            validatePolicy({ presence: { alwaysOn: { maxPerTenant: 2 } } }, { scope: "user" }).errors.length,
            1,
            "the tenant cap is a tenant's",
        );
    });
});

describe("users: membership", () => {
    it("a user names exactly one tenant and owns accounts; ids are opaque", () => {
        const a = account();
        const id = user();
        assert.throws(() => applyPolicy({ target: { kind: "user", id }, op: "put", policy: {}, actor: "t" }), {
            code: "INVALID",
        });
        for (const bad of ["../x", "a@b.example", "has space", ""]) {
            assert.throws(
                () =>
                    applyPolicy({ target: { kind: "user", id: bad }, op: "put", policy: {}, tenant: "t", actor: "t" }),
                { code: "INVALID" },
            );
        }
        const r = applyPolicy({
            target: { kind: "user", id },
            op: "put",
            policy: {},
            tenant: "acme",
            accounts: [a],
            actor: "t",
        });
        assert.deepEqual(r.changed, ["accounts", "tenant"]);
        assert.equal(ownerOf(a).id, id);
        const doc = getPolicy({ kind: "user", id });
        assert.equal(doc.tenant, "acme");
        assert.deepEqual(doc.accounts, [a]);
        assert.deepEqual(
            tenantsOf(a).map((t) => t.id),
            ["acme"],
        );
    });

    it("refuses an account under two users (409 MEMBERSHIP)", () => {
        const a = account();
        const one = user();
        applyPolicy({
            target: { kind: "user", id: one },
            op: "put",
            policy: {},
            tenant: "t1",
            accounts: [a],
            actor: "t",
        });
        assert.throws(
            () =>
                applyPolicy({
                    target: { kind: "user", id: user() },
                    op: "put",
                    policy: {},
                    tenant: "t1",
                    accounts: [a],
                    actor: "t",
                }),
            (e) => e.code === "MEMBERSHIP" && e.message.includes(one),
        );
    });

    it("refuses an account under two tenants, from either side", () => {
        const a = account();
        const legacy = tenant();
        applyPolicy({
            target: { kind: "tenant", id: legacy },
            op: "put",
            policy: { quota: { tenant: { accounts: [a] } } },
            actor: "t",
        });
        assert.throws(
            () =>
                applyPolicy({
                    target: { kind: "user", id: user() },
                    op: "put",
                    policy: {},
                    tenant: "other",
                    accounts: [a],
                    actor: "t",
                }),
            { code: "MEMBERSHIP" },
        );
        assert.throws(
            () =>
                applyPolicy({
                    target: { kind: "tenant", id: tenant() },
                    op: "put",
                    policy: { quota: { tenant: { accounts: [a] } } },
                    actor: "t",
                }),
            { code: "MEMBERSHIP" },
            "two legacy lists: refused now (it used to warn)",
        );
        const b = account();
        applyPolicy({
            target: { kind: "user", id: user() },
            op: "put",
            policy: {},
            tenant: "t9",
            accounts: [b],
            actor: "t",
        });
        assert.throws(
            () =>
                applyPolicy({
                    target: { kind: "tenant", id: tenant() },
                    op: "put",
                    policy: { quota: { tenant: { accounts: [b] } } },
                    actor: "t",
                }),
            { code: "MEMBERSHIP" },
        );
        assert.ok(readFileSync(policyAuditFile(), "utf8").includes('"result":"membership"'));
    });

    it("the legacy quota.tenant.accounts still counts, and a tenant's accounts include its users' (quota toward the owner)", () => {
        const a = account();
        const b = account();
        const t = tenant();
        applyPolicy({
            target: { kind: "tenant", id: t },
            op: "put",
            policy: { quota: { tenant: { limit: "5GB", accounts: [a] } } },
            actor: "t",
        });
        applyPolicy({
            target: { kind: "user", id: user() },
            op: "put",
            policy: {},
            tenant: t,
            accounts: [b],
            actor: "t",
        });
        assert.deepEqual(tenantsOf(a)[0].accounts, [a, b].sort());
        assert.deepEqual(tenantsOf(b)[0].accounts, [a, b].sort());
    });
});

describe("precedence", () => {
    it("tenant < user < account in the policy", () => {
        const a = account();
        const t = tenant();
        const id = user();
        applyPolicy({
            target: { kind: "tenant", id: t },
            op: "put",
            policy: { presence: { idleTimeout: "10m", warmWait: "5s", mode: "always-on" } },
            actor: "t",
        });
        applyPolicy({
            target: { kind: "user", id },
            op: "put",
            policy: { presence: { idleTimeout: "20m", minConnected: "2m", alwaysOn: { maxPerUser: 5 } } },
            tenant: t,
            accounts: [a],
            actor: "t",
        });
        applyPolicy({
            target: { kind: "account", id: a },
            op: "patch",
            policy: { presence: { minConnected: "3m" } },
            actor: "t",
        });
        const p = effectivePolicy(a).presence;
        assert.equal(p.warmWait, "5s", "the tenant's");
        assert.equal(p.idleTimeout, "20m", "the user's beats the tenant's");
        assert.equal(p.minConnected, "3m", "the account's beats the user's");
        assert.equal(p.mode, "always-on");
    });

    it("defaults < mcp-config < accounts block < env < policy, and the role forces always-on", () => {
        const a = account();
        const config = mergeMCPConfigLayer(getDefaultConfig(), {
            presence: { mode: "always-on", idleTimeout: "7m", catchUpEvery: "6h" },
            accounts: { [a]: { presence: { idleTimeout: "8m" } } },
        });
        let r = resolvePresenceSettings({ config, accountId: a, env: {} });
        assert.equal(r.settings.mode, "always-on");
        assert.equal(r.settings.idleTimeoutMs, 8 * 60_000);
        assert.equal(r.settings.catchUpEveryMs, 6 * 3_600_000);
        assert.equal(r.settings.connectOnStart, true, "the default");
        r = resolvePresenceSettings({
            config,
            accountId: a,
            env: { ZALO_PRESENCE_MODE: "on-demand", [`ZALO_PRESENCE_IDLE_TIMEOUT_${a}`]: "9m" },
        });
        assert.equal(r.settings.mode, "on-demand");
        assert.equal(r.settings.idleTimeoutMs, 9 * 60_000);
        assert.equal(r.sources.idleTimeoutMs, "environment");
        applyPolicy({
            target: { kind: "account", id: a },
            op: "patch",
            policy: { presence: { idleTimeout: "11m", catchUpEvery: "off" } },
            actor: "t",
        });
        r = resolvePresenceSettings({ config, accountId: a, env: { ZALO_PRESENCE_IDLE_TIMEOUT: "9m" } });
        assert.equal(r.settings.idleTimeoutMs, 11 * 60_000, "the policy beats the environment");
        assert.equal(r.settings.catchUpEveryMs, 0);
        const stdio = resolvePresenceSettings({
            config,
            accountId: a,
            env: { ZALO_PRESENCE_MODE: "on-demand" },
            transport: "stdio",
        });
        assert.equal(stdio.settings.mode, "always-on");
        assert.match(stdio.forced, /stdio/);
    });
});

describe("always-on cap: the oldest is demoted", () => {
    it("a second always-on account for a user with cap 1 demotes the first, with an event and an audit line", () => {
        const [a, b] = [account(), account()];
        const id = user();
        applyPolicy({
            target: { kind: "user", id },
            op: "put",
            policy: {},
            tenant: tenant(),
            accounts: [a, b],
            actor: "t",
        });
        const events = [];
        const off = onPresenceChange((e) => events.push(e));
        try {
            assert.deepEqual(setMode(a, "always-on").demoted, []);
            const r = setMode(b, "always-on");
            assert.deepEqual(
                r.demoted.map((d) => [d.accountId, d.scope, d.cap, d.reason]),
                [[a, "user", 1, "cap"]],
            );
            assert.equal(modeOf(a), "on-demand");
            assert.equal(modeOf(b), "always-on", "the new request wins");
            assert.deepEqual(
                events.map((e) => e.accountId),
                [a],
            );
            assert.equal(getPolicy({ kind: "account", id: a }).updatedBy, "presence-cap");
            assert.ok(readFileSync(policyAuditFile(), "utf8").includes('"result":"capDemoted"'));
        } finally {
            off();
        }
    });

    it("a lowered cap demotes the oldest down to the cap", () => {
        const [a, b, c] = [account(), account(), account()];
        const id = user();
        const t = tenant();
        applyPolicy({
            target: { kind: "user", id },
            op: "put",
            policy: { presence: { alwaysOn: { maxPerUser: 3 } } },
            tenant: t,
            accounts: [a, b, c],
            actor: "t",
        });
        setMode(a, "always-on");
        setMode(b, "always-on");
        setMode(c, "always-on");
        assert.deepEqual(alwaysOnUsage().users.find((x) => x.userId === id).alwaysOn, [a, b, c]);
        const r = applyPolicy({
            target: { kind: "user", id },
            op: "patch",
            policy: { presence: { alwaysOn: { maxPerUser: 1 } } },
            actor: "t",
        });
        assert.deepEqual(
            r.demoted.map((d) => d.accountId),
            [a, b],
        );
        assert.deepEqual([modeOf(a), modeOf(b), modeOf(c)], ["on-demand", "on-demand", "always-on"]);
    });

    it("the tenant cap counts every user of the tenant; a user cap from the tenant applies", () => {
        const t = tenant();
        const [a, b] = [account(), account()];
        applyPolicy({
            target: { kind: "tenant", id: t },
            op: "put",
            policy: { presence: { alwaysOn: { maxPerUser: 5, maxPerTenant: 1 } } },
            actor: "t",
        });
        applyPolicy({
            target: { kind: "user", id: user() },
            op: "put",
            policy: {},
            tenant: t,
            accounts: [a],
            actor: "t",
        });
        applyPolicy({
            target: { kind: "user", id: user() },
            op: "put",
            policy: {},
            tenant: t,
            accounts: [b],
            actor: "t",
        });
        setMode(a, "always-on");
        const r = setMode(b, "always-on");
        assert.deepEqual(
            r.demoted.map((d) => [d.accountId, d.scope]),
            [[a, "tenant"]],
        );
    });

    it("an account with no user is held only to a tenant cap; enforceAlwaysOnCaps can run alone", () => {
        const a = account();
        setMode(a, "always-on");
        assert.equal(modeOf(a), "always-on");
        assert.deepEqual(enforceAlwaysOnCaps(), []);
    });

    it("two processes making accounts always-on at once: the host lock lets exactly the cap through", async () => {
        const accts = [account(), account(), account(), account()];
        const id = user();
        applyPolicy({
            target: { kind: "user", id },
            op: "put",
            policy: {},
            tenant: tenant(),
            accounts: accts,
            actor: "t",
        });
        const store = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "core", "policy-store.js")).href;
        const child = (ids) => {
            const code = `
                const { applyPolicy } = await import(${JSON.stringify(store)});
                for (const id of ${JSON.stringify(ids)})
                    applyPolicy({ target: { kind: "account", id }, op: "patch", policy: { presence: { mode: "always-on" } }, actor: "child" });
            `;
            const p = spawn(process.execPath, ["--input-type=module", "-e", code], {
                env: { ...process.env, HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME, ZALO_SANDBOX_ACTIVE: "1" },
                stdio: ["ignore", "ignore", "pipe"],
            });
            let err = "";
            p.stderr.on("data", (d) => (err += d));
            return once(p, "exit").then(([status]) => assert.equal(status, 0, err));
        };
        await Promise.all([child(accts.slice(0, 2)), child(accts.slice(2))]);
        resetPolicyCache();
        const on = accts.filter((a) => modeOf(a) === "always-on");
        assert.equal(on.length, 1, `exactly the cap stays always-on, got ${on.join(", ")}`);
    });
});

describe("admin API: users and the cap", () => {
    const ADMIN = "admin-token-fedcba9876543210";
    const AGENT = "agent-token-0123456789abcdef";
    const servers = [];
    after(() => servers.forEach((s) => s.close()));

    async function start(ownId) {
        const admin = createAdminApi({
            ownId,
            hashes: resolveAdminCredentials({ env: { ZALO_MCP_ADMIN_TOKEN: ADMIN } }).hashes,
            log: () => {},
        });
        const server = createHTTPServer(() => {}, { admin, buffer: { getStats: () => [] } }, 0, AGENT, "127.0.0.1");
        servers.push(server);
        if (!server.listening) await once(server, "listening");
        return `http://127.0.0.1:${server.address().port}/zalo/admin`;
    }
    const call = async (url, { method = "GET", body } = {}) => {
        const res = await fetch(url, {
            method,
            headers: { Authorization: `Bearer ${ADMIN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    };

    it("PUT/GET a user, 409 on a second owner, demoted in the reply, and the always-on view", async () => {
        const [a, b] = [account(), account()];
        const base = await start(a);
        const id = user();
        const put = await call(`${base}/policy/users/${id}`, {
            method: "PUT",
            body: { tenant: "acme", accounts: [a, b], policy: { presence: { idleTimeout: "15m" } } },
        });
        assert.equal(put.status, 200);
        assert.deepEqual([put.body.tenant, put.body.accounts], ["acme", [a, b].sort()]);
        const got = await call(`${base}/policy/users/${id}`);
        assert.equal(got.body.policy.presence.idleTimeout, "15m");
        const clash = await call(`${base}/policy/users/${user()}`, {
            method: "PUT",
            body: { tenant: "acme", accounts: [a] },
        });
        assert.equal(clash.status, 409);
        assert.equal(clash.body.code, "MEMBERSHIP");
        await call(`${base}/policy/${a}`, { method: "PATCH", body: { presence: { mode: "always-on" } } });
        const second = await call(`${base}/policy/${b}`, {
            method: "PATCH",
            body: { presence: { mode: "always-on" } },
        });
        assert.deepEqual(
            second.body.demoted.map((d) => d.accountId),
            [a],
        );
        assert.equal(second.body.owner, id);
        assert.equal(second.body.effective.presence.mode, "always-on");
        const view = await call(`${base}/presence/always-on`);
        assert.deepEqual(view.body.users.find((x) => x.userId === id).alwaysOn, [b]);
    });
});
