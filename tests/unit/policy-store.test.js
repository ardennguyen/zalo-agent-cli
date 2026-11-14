/**
 * The runtime policy store (src/core/policy-store.js): the schema it takes, the layer it adds above the environment,
 * revisions and If-Match, sealed files, file drops (valid ones sealed, invalid ones rejected with the last good policy
 * kept), tenants, and the audit log (keys and revs, never a value).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { isSealed } from "../../src/core/keystore/index.js";
import {
    PolicyError,
    applyPolicy,
    effectivePolicy,
    getPolicy,
    loadPoliciesStrict,
    onPolicyChange,
    policyAuditFile,
    reloadPolicy,
    resetPolicyCache,
    servePolicyRequest,
    tenantsDir,
    tenantsOf,
    watchPolicies,
} from "../../src/core/policy-store.js";
import { parseBytes, validatePolicy } from "../../src/core/policy-schema.js";
import { policyFor } from "../../src/core/policy-layer.js";
import { resolveConfirmMode } from "../../src/core/confirm-guard.js";
import { resolveHiddenChats, resolveMediaDelivery, resolveMediaLinkAuth } from "../../src/core/deploy-policy.js";
import { resolveWebhookDelivery, resolveWebhookUrl } from "../../src/mcp/mcp-config.js";
import { callViaDaemon, startDaemonChannel } from "../../src/core/daemon-channel.js";

let n = 0;
/** A fresh account folder (the store writes only for an account that has one). */
function account() {
    const id = String(1000000000000000700n + BigInt(n++));
    mkdirSync(getAccountDir(id), { recursive: true });
    return id;
}
const policyFile = (id) => join(getAccountDir(id), "policy.json");

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));
beforeEach(() => resetPolicyCache());

describe("policy schema", () => {
    it("takes every documented key and normalizes values", () => {
        const v = validatePolicy({
            confirmMode: "HUMAN",
            hiddenChats: "contentless",
            approval: { secret: "pin", deliver: "webhook" },
            media: { linkAuth: "Bearer", deliver: { video: "inline" }, capability: { maxClients: 5, ttl: "20m" } },
            quota: { account: { limit: "2GB" }, graceDays: 45, warnAt: 0.8, purgeOrder: "media-first" },
            retention: { messages: "90", media: "keep", outboxDead: "30d", purgeEvery: "6h" },
            webhook: "https://crm.example.com/hook",
            webhookBatchSize: 10,
        });
        assert.deepEqual(v.errors, []);
        assert.equal(v.policy.confirmMode, "human");
        assert.equal(v.policy.media.linkAuth, "bearer");
        assert.equal(v.policy.retention.messages, "90d");
    });

    it("names each bad value, refuses unknown keys, and keeps tenant-only keys out of an account", () => {
        const v = validatePolicy({
            confirmMode: "maybe",
            notify: { enabled: true },
            quota: { tenant: { limit: "1GB" }, warnAt: 2 },
            retention: { messages: "none" },
        });
        const keys = v.errors.map((e) => e.key).sort();
        assert.deepEqual(keys, [
            "confirmMode",
            "notify.enabled",
            "quota.tenant.limit",
            "quota.warnAt",
            "retention.messages",
        ]);
        assert.deepEqual(validatePolicy({ quota: { tenant: { limit: "1GB" } } }, { scope: "tenant" }).errors, []);
    });

    it("refuses restart-only keys and secrets as restartRequired, never as a value it keeps", () => {
        const v = validatePolicy({
            httpPort: 9000,
            tls: { cert: "x" },
            webhookSecret: "s",
            media: { downloadDir: "/x" },
        });
        assert.deepEqual(v.restartRequired.sort(), ["httpPort", "media.downloadDir", "tls", "webhookSecret"]);
        assert.deepEqual(v.policy, {});
    });

    it("reads sizes in binary units and 'unlimited'", () => {
        assert.equal(parseBytes("2GB"), 2 * 1024 ** 3);
        assert.equal(parseBytes("1.5 mb"), 1.5 * 1024 ** 2);
        assert.equal(parseBytes(1000), 1000);
        assert.equal(parseBytes("unlimited"), "unlimited");
        assert.equal(parseBytes("-1"), null);
        assert.equal(parseBytes("2 parsecs"), null);
    });
});

describe("policy store: writes, revisions, the layer above the environment", () => {
    it("a patch raises rev, is sealed on disk, and wins over the environment and the config file", () => {
        const id = account();
        const env = { ZALO_MCP_CONFIRM_MODE: "off", [`ZALO_MCP_HIDDEN_CHATS_${id}`]: "include" };
        assert.equal(resolveConfirmMode({ config: { confirmMode: "agent" }, env, accountId: id }).mode, "off");
        const r = applyPolicy({
            target: { kind: "account", id },
            op: "patch",
            policy: { confirmMode: "human", hiddenChats: "exclude" },
            actor: "test",
        });
        assert.equal(r.rev, 1);
        assert.deepEqual(r.changed, ["confirmMode", "hiddenChats"]);
        assert.ok(isSealed(readFileSync(policyFile(id))), "the file is sealed");
        assert.doesNotMatch(readFileSync(policyFile(id), "latin1"), /human/);
        const cm = resolveConfirmMode({ config: { confirmMode: "agent" }, env, accountId: id });
        assert.deepEqual(cm, { mode: "human", source: "policy:confirmMode" });
        assert.equal(resolveHiddenChats({ env, accountId: id }).mode, "exclude");
        // Explicitly no policy (how a resolver test pins it): the environment again.
        assert.equal(resolveConfirmMode({ env, accountId: id, policy: null }).mode, "off");
    });

    it("If-Match: the rev read goes through, another one is a CONFLICT and nothing changes", () => {
        const id = account();
        const target = { kind: "account", id };
        applyPolicy({ target, op: "patch", policy: { confirmMode: "human" }, actor: "test" });
        assert.throws(
            () => applyPolicy({ target, op: "patch", policy: { confirmMode: "off" }, ifMatch: "0", actor: "test" }),
            (e) => e instanceof PolicyError && e.code === "CONFLICT" && e.rev === 1,
        );
        assert.equal(getPolicy(target).policy.confirmMode, "human");
        const ok = applyPolicy({ target, op: "patch", policy: { confirmMode: "off" }, ifMatch: '"1"', actor: "test" });
        assert.equal(ok.rev, 2);
    });

    it("put replaces, patch merges, null unsets; an unchanged write keeps the rev", () => {
        const id = account();
        const target = { kind: "account", id };
        applyPolicy({ target, op: "put", policy: { confirmMode: "human", media: { linkAuth: "bearer" } }, actor: "t" });
        applyPolicy({ target, op: "patch", policy: { media: { linkRateLimit: 5 } }, actor: "t" });
        assert.deepEqual(getPolicy(target).policy, {
            confirmMode: "human",
            media: { linkAuth: "bearer", linkRateLimit: 5 },
        });
        const r = applyPolicy({ target, op: "patch", policy: { media: { linkAuth: null } }, actor: "t" });
        assert.deepEqual(r.changed, ["media.linkAuth"]);
        const same = applyPolicy({ target, op: "patch", policy: { confirmMode: "human" }, actor: "t" });
        assert.equal(same.rev, r.rev);
        applyPolicy({ target, op: "put", policy: { hiddenChats: "include" }, actor: "t" });
        assert.deepEqual(getPolicy(target).policy, { hiddenChats: "include" });
    });

    it("an invalid or restart-only change is refused and leaves the file as it was", () => {
        const id = account();
        const target = { kind: "account", id };
        applyPolicy({ target, op: "patch", policy: { confirmMode: "human" }, actor: "t" });
        assert.throws(
            () => applyPolicy({ target, op: "patch", policy: { httpPort: 1 }, actor: "t" }),
            (e) => e.code === "RESTART_REQUIRED" && e.restartRequired[0] === "httpPort",
        );
        assert.throws(
            () => applyPolicy({ target, op: "patch", policy: { media: { linkAuth: "nobody" } }, actor: "t" }),
            (e) => e.code === "INVALID" && e.errors[0].key === "media.linkAuth",
        );
        assert.equal(getPolicy(target).rev, 1);
    });

    it("refuses an account with no folder on this host", () => {
        assert.throws(
            () => applyPolicy({ target: { kind: "account", id: "1999999999" }, op: "patch", policy: {}, actor: "t" }),
            (e) => e.code === "NOT_FOUND",
        );
    });

    it("media, webhook settings and the receiver read the policy too", () => {
        const id = account();
        applyPolicy({
            target: { kind: "account", id },
            op: "patch",
            policy: {
                media: {
                    deliver: { photo: "link" },
                    linkAuth: "capability",
                    linkTtl: "2m",
                    capability: { maxClients: 9 },
                },
                webhook: "https://crm.example.com/policy-hook",
                webhookBatchSize: 7,
            },
            actor: "t",
        });
        const env = {
            ZALO_MCP_MEDIA_DELIVER: "photo=inline",
            ZALO_MCP_MEDIA_LINK_AUTH: "bearer",
            ZALO_WEBHOOK_BATCH_SIZE: "2",
        };
        const media = resolveMediaDelivery({ env, accountId: id });
        assert.equal(media.deliver.photo, "link");
        assert.equal(media.deliverSource.photo, "policy:media.deliver");
        assert.equal(media.linkTtlMs, 120_000);
        const auth = resolveMediaLinkAuth({ env, accountId: id, publicUrl: "https://zalo.example.com" });
        assert.equal(auth.linkAuth, "capability");
        assert.equal(auth.maxClients, 9);
        assert.equal(resolveWebhookDelivery(id, {}, env).batchSize, 7);
        assert.equal(
            resolveWebhookUrl({ accountId: id, flag: "https://flag.example.com" }),
            "https://crm.example.com/policy-hook",
        );
    });
});

describe("policy store: tenants", () => {
    it("a tenant's policy reaches the accounts it lists, under the account's own", () => {
        const a = account();
        const b = account();
        applyPolicy({
            target: { kind: "tenant", id: "acme" },
            op: "put",
            policy: { confirmMode: "human", quota: { tenant: { limit: "5GB", accounts: [a, b] }, graceDays: 30 } },
            actor: "t",
        });
        applyPolicy({ target: { kind: "account", id: b }, op: "patch", policy: { confirmMode: "off" }, actor: "t" });
        assert.deepEqual(
            tenantsOf(a).map((t) => t.id),
            ["acme"],
        );
        assert.equal(effectivePolicy(a).confirmMode, "human");
        assert.equal(effectivePolicy(b).confirmMode, "off", "the account's own wins");
        assert.equal(effectivePolicy(b).quota.graceDays, 30);
        assert.ok(isSealed(readFileSync(join(tenantsDir(), "acme.json"))));
        assert.equal(policyFor(account()), null, "an account no tenant lists has no policy");
    });

    it("refuses a tenant id that could name another path", () => {
        assert.throws(
            () => applyPolicy({ target: { kind: "tenant", id: "../x" }, op: "put", policy: {}, actor: "t" }),
            (e) => e.code === "INVALID",
        );
    });
});

describe("policy store: file drops", () => {
    it("a valid drop is checked, sealed in place with the next rev, and announced", () => {
        const id = account();
        const target = { kind: "account", id };
        applyPolicy({ target, op: "patch", policy: { confirmMode: "human" }, actor: "t" });
        const seen = [];
        const off = onPolicyChange((c) => seen.push(c));
        writeFileSync(policyFile(id), JSON.stringify({ policy: { confirmMode: "off", hiddenChats: "contentless" } }));
        const r = reloadPolicy(target, { log: () => {} });
        off();
        assert.equal(r.applied, true);
        assert.equal(r.rev, 2);
        assert.ok(isSealed(readFileSync(policyFile(id))), "sealed in place");
        assert.equal(resolveConfirmMode({ env: {}, accountId: id }).mode, "off");
        assert.deepEqual(seen.at(-1).changed, ["confirmMode", "hiddenChats"]);
    });

    it("an invalid drop is set aside, the last good policy is written back and stays in force", () => {
        const id = account();
        const target = { kind: "account", id };
        applyPolicy({ target, op: "patch", policy: { confirmMode: "human" }, actor: "t" });
        writeFileSync(policyFile(id), JSON.stringify({ confirmMode: "whatever" }));
        const lines = [];
        const r = reloadPolicy(target, { log: (l) => lines.push(l) });
        assert.equal(r.rejected, true);
        assert.ok(existsSync(`${policyFile(id)}.rejected`));
        assert.ok(isSealed(readFileSync(policyFile(id))), "the last good policy is back on disk");
        assert.equal(getPolicy(target).policy.confirmMode, "human");
        assert.equal(resolveConfirmMode({ env: {}, accountId: id }).mode, "human");
        assert.match(lines.join("\n"), /confirmMode is not one of/);
    });

    it("a daemon's start refuses a policy file it cannot use", () => {
        const id = account();
        writeFileSync(policyFile(id), "{ not json");
        assert.throws(
            () => loadPoliciesStrict(id),
            (e) => e instanceof PolicyError && e.code === "INVALID",
        );
        rmSync(policyFile(id));
    });

    it("the watcher picks a drop up (debounced) and applies it", async () => {
        const id = account();
        loadPoliciesStrict(id);
        const got = new Promise((resolve) => {
            const off = onPolicyChange((c) => {
                if (c.id === id) {
                    off();
                    resolve(c);
                }
            });
        });
        const w = watchPolicies({ ownId: id, log: () => {}, debounceMs: 50 });
        try {
            writeFileSync(policyFile(id), JSON.stringify({ policy: { hiddenChats: "include" } }));
            const c = await Promise.race([
                got,
                new Promise((_, rej) => setTimeout(() => rej(new Error("no change seen")), 5000)),
            ]);
            assert.deepEqual(c.changed, ["hiddenChats"]);
            assert.equal(resolveHiddenChats({ env: {}, accountId: id }).mode, "include");
        } finally {
            w.stop();
        }
    });
});

describe("policy store: audit log", () => {
    it("records who, which file, which keys and the revs, never a value", () => {
        const id = account();
        const secretish = "https://crm.example.com/hook?token=AUDIT-MARKER-VALUE";
        applyPolicy({
            target: { kind: "account", id },
            op: "patch",
            policy: { webhook: secretish },
            actor: "admin-api token 127.0.0.1",
        });
        const lines = readFileSync(policyAuditFile(), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
        const mine = lines.filter((l) => l.target === `account:${id}`);
        assert.equal(mine.at(-1).result, "applied");
        assert.deepEqual(mine.at(-1).keys, ["webhook"]);
        assert.equal(mine.at(-1).newRev, 1);
        assert.doesNotMatch(readFileSync(policyAuditFile(), "utf8"), /AUDIT-MARKER-VALUE/);
    });
});

describe("policy store: through a running daemon's channel", () => {
    it("`policy set` beside a daemon is applied by the daemon (live), and a refusal comes back with its code", async () => {
        const id = account();
        const dir = getAccountDir(id);
        const channel = await startDaemonChannel({ getApi: () => null, accountDir: dir, onPolicy: servePolicyRequest });
        try {
            const target = { kind: "account", id };
            const ok = await callViaDaemon(dir, "/policy", { target, op: "patch", policy: { confirmMode: "off" } });
            assert.equal(ok.ok, true, JSON.stringify(ok));
            assert.equal(ok.rev, 1);
            assert.equal(resolveConfirmMode({ env: {}, accountId: id }).mode, "off");
            const refused = await callViaDaemon(dir, "/policy", {
                target,
                op: "patch",
                policy: { tls: {} },
                ifMatch: 1,
            });
            assert.equal(refused.ok, false);
            assert.equal(refused.code, "RESTART_REQUIRED");
            assert.deepEqual(refused.restartRequired, ["tls"]);
        } finally {
            channel.stop();
        }
    });
});
