/**
 * docs/config-samples/ -- the configuration the docs tell people to copy.
 *
 * A sample that names a key or variable the code does not read fails silently:
 * the setting is ignored and nothing says so (the wrapper's .env.example listed
 * ZALO_OA_WEBHOOK_PORT for a long time, and the engine never read it). These
 * hold every sample to the code: every mcp-config key is one the loader merges,
 * every environment variable is one a source file reads, the per-account
 * resolution gives what the sample claims, and the CRM receiver verifies a
 * signature produced by the real webhook sender.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    envForAccount,
    getDefaultConfig,
    mergeMCPConfigLayer,
    resolveAccountMCPConfig,
} from "../../src/mcp/mcp-config.js";
import { postMCPWebhook } from "../../src/commands/mcp.js";
import { verifyWebhook } from "../../docs/config-samples/clients/crm-webhook-receiver.mjs";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

const ROOT = join(import.meta.dirname, "..", "..");
const SAMPLES = join(ROOT, "docs", "config-samples");
const read = (...p) => readFileSync(join(SAMPLES, ...p), "utf8");
const list = (dir, ext) => readdirSync(join(SAMPLES, dir)).filter((f) => f.endsWith(ext));

/** Every ZALO_* name some source file mentions. */
function namesInSource() {
    const names = new Set();
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) {
                for (const m of readFileSync(p, "utf8").matchAll(/ZALO_[A-Z0-9_]+/g)) names.add(m[0]);
            }
        }
    };
    walk(join(ROOT, "src"));
    return names;
}

describe("mcp-config samples", () => {
    const defaults = getDefaultConfig();
    const known = new Set([...Object.keys(defaults), "accounts"]);

    for (const file of list("mcp-config", ".json")) {
        it(`${file}: valid JSON that uses only keys the loader merges`, () => {
            const cfg = JSON.parse(read("mcp-config", file));
            for (const key of Object.keys(cfg)) assert.ok(known.has(key), `unknown top-level key "${key}"`);
            for (const section of ["notify", "limits", "media", "tls", "oauth"]) {
                for (const key of Object.keys(cfg[section] ?? {})) {
                    assert.ok(key in defaults[section], `unknown key "${key}" in "${section}"`);
                }
            }
            for (const [id, block] of Object.entries(cfg.accounts ?? {})) {
                assert.match(id, /^[1-9][0-9]*$/, "an account block is keyed by the numeric account id");
                for (const key of Object.keys(block))
                    assert.ok(known.has(key) && key !== "accounts", `${id}: unknown key "${key}"`);
            }
            // And it merges: no section the loader spreads is replaced by a non-object.
            const merged = mergeMCPConfigLayer(defaults, cfg);
            assert.equal(typeof merged.limits, "object");
        });

        it(`${file}: holds no real secret`, () => {
            const cfg = JSON.parse(read("mcp-config", file));
            for (const secret of [
                cfg.webhookSecret,
                cfg.oauth?.clientSecret,
                ...(cfg.oauth?.clients ?? []).map((c) => c.clientSecret),
            ]) {
                assert.ok(
                    secret === null || secret === undefined || /^CHANGE_ME/.test(secret),
                    "a secret in a sample must be a CHANGE_ME placeholder or null",
                );
            }
        });
    }

    it("multi-account.json: each account block overrides the shared settings for that account only", () => {
        const base = mergeMCPConfigLayer(defaults, JSON.parse(read("mcp-config", "multi-account.json")));
        const a = resolveAccountMCPConfig(base, { accountId: "1000000000000000001" }).config;
        const b = resolveAccountMCPConfig(base, { accountId: "1000000000000000002" }).config;
        const other = resolveAccountMCPConfig(base, { accountId: "1000000000000000099" }).config;
        assert.deepEqual([a.httpPort, a.webhook], [3901, "https://crm.example.com/hooks/zalo/shop-a"]);
        assert.deepEqual([b.httpPort, b.webhook], [3902, "https://crm.example.com/hooks/zalo/shop-b"]);
        assert.deepEqual(b.watchThreads, ["dm:*", "group:support"]);
        assert.deepEqual(a.watchThreads, ["dm:*"], "shared setting still applies where the block does not override");
        assert.equal(other.httpPort, null, "an account without a block gets none of the overrides");
        assert.equal(a.groupConfirm, false);
    });
});

describe("env samples", () => {
    const inSource = namesInSource();
    /** Every assignment in a file, active or commented out (`# NAME=value`). */
    const assignments = (text) =>
        [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => ({ name: m[1], value: m[2].trim() }));
    const base = (name) => name.replace(/_[1-9][0-9]{8,}$/, "");

    const files = [...list("env", ".env").map((f) => join("env", f)), join("systemd", "common.env")];
    for (const file of files) {
        it(`${file}: every variable is one the engine reads`, () => {
            const found = assignments(read(file));
            assert.ok(found.length > 0, "the file sets something");
            for (const { name } of found) {
                assert.ok(inSource.has(base(name)), `${name}: no source file reads ${base(name)}`);
            }
        });

        it(`${file}: tokens and secrets are CHANGE_ME placeholders`, () => {
            for (const { name, value } of assignments(read(file))) {
                if (/TOKEN|SECRET/.test(name)) assert.match(value, /^CHANGE_ME/, `${name} must be a placeholder`);
            }
        });
    }

    it("multi-account.env: NAME_<ownId> wins for its account and the plain NAME covers the rest", () => {
        const env = parseEnv(read("env", "multi-account.env"));
        assert.equal(envForAccount("ZALO_MCP_HTTP_PORT", "1000000000000000001", env), "3901");
        assert.equal(envForAccount("ZALO_MCP_HTTP_PORT", "1000000000000000002", env), "3902");
        assert.equal(envForAccount("ZALO_MCP_HOST", "1000000000000000001", env), "127.0.0.1");
        assert.match(envForAccount("ZALO_WEBHOOK_SECRET", "1000000000000000002", env), /OWN_WEBHOOK_SECRET/);
        assert.match(envForAccount("ZALO_WEBHOOK_SECRET", "1000000000000000001", env), /SHARED_WEBHOOK_SECRET/);
    });

    it("the per-service and CRM env files give the token and port with nothing on the command line", () => {
        for (const file of ["lan-server.env", "internet-server.env", "crm-backend.env", "account.env"]) {
            const env = parseEnv(read("env", file));
            assert.ok(envForAccount("ZALO_MCP_AUTH_TOKEN", "1000000000000000001", env), `${file}: token`);
            assert.ok(envForAccount("ZALO_MCP_HTTP_PORT", "1000000000000000001", env), `${file}: port`);
        }
    });

    it("the wrapper-folder .env keeps to ports", () => {
        const names = assignments(read("env", "wrapper-folder.env")).map((a) => a.name);
        // Not ZALO_OA_WEBHOOK_PORT: the engine never read it, and the every-variable test above would say so.
        assert.deepEqual(names, ["ZALO_MCP_HTTP_PORT"]);
    });
});

describe("systemd unit and proxy samples", () => {
    const unit = read("systemd", "zalo-mcp@.service");

    it("the unit takes the account from the instance name and the token from the env file, not argv", () => {
        assert.match(unit, /ExecStart=\S*zalo-agent mcp start --account %i\s*$/m);
        assert.doesNotMatch(unit, /--auth/);
        assert.match(unit, /EnvironmentFile=\/etc\/zalo-mcp\/accounts\/%i\.env/);
        assert.match(unit, /KillSignal=SIGINT/, "SIGINT is the shutdown signal mcp start handles");
    });

    it("the proxies allow /events/wait its full 300 seconds and do not buffer", () => {
        assert.match(read("proxy", "Caddyfile.internet"), /read_timeout 3[1-9]\d?s/);
        assert.match(read("proxy", "Caddyfile.internet"), /flush_interval -1/);
        const nginx = read("proxy", "nginx.internet.conf");
        assert.match(nginx, /proxy_read_timeout 3[1-9]\d?s/);
        assert.match(nginx, /proxy_buffering off/);
    });
});

describe("client samples", () => {
    it("the Claude Code configs are valid JSON naming an MCP server", () => {
        for (const f of ["claude-code-stdio.json", "claude-code-http.json"]) {
            const cfg = JSON.parse(read("clients", f));
            assert.ok(Object.keys(cfg.mcpServers).length >= 1, f);
        }
    });

    it("the CRM receiver verifies exactly what the real webhook sender signs", async () => {
        const secret = "CHANGE_ME_WEBHOOK_SIGNING_SECRET";
        let captured;
        const ok = await postMCPWebhook(
            "https://crm.example.com/hooks/zalo",
            { id: "m1", threadId: "t1", text: "xin chào" },
            { accountId: "1000000000000000001" },
            async (_url, init) => void (captured = init),
            secret,
        );
        assert.equal(ok, true);
        const headers = Object.fromEntries(Object.entries(captured.headers).map(([k, v]) => [k.toLowerCase(), v]));
        assert.equal(verifyWebhook(captured.body, headers, secret), true);
        assert.equal(headers.authorization, `Bearer ${secret}`);
        // Red if the receiver checked a re-serialized body: one changed byte must fail it.
        assert.equal(verifyWebhook(captured.body + " ", headers, secret), false);
        assert.equal(verifyWebhook(captured.body, headers, "CHANGE_ME_OTHER"), false);
        assert.equal(verifyWebhook(captured.body, {}, secret), false, "no signature header");
        assert.deepEqual(Object.keys(JSON.parse(captured.body)).slice(0, 2), ["event", "accountId"]);
    });
});
