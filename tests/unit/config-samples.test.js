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
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
import { eventsOf, verifyWebhook } from "../../docs/config-samples/clients/crm-webhook-receiver.mjs";
import { createWebhookDispatcher, openOutbox } from "../../src/core/webhook-outbox.js";

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

    it("the receivers read a real batch the dispatcher sends, and a lone event, alike", async () => {
        const dir = mkdtempSync(join(tmpdir(), "zalo-sample-batch-"));
        const outbox = openOutbox(dir);
        try {
            for (const n of [1, 2, 3])
                outbox.enqueue(null, JSON.stringify({ event: "message", accountId: "A", id: `m${n}` }));
            const posts = [];
            const dispatcher = createWebhookDispatcher({
                outbox,
                url: "https://crm.example.com/hooks/zalo",
                secret: "CHANGE_ME_WEBHOOK_SIGNING_SECRET",
                accountId: "A",
                batchSize: 2,
                fetchFn: async (_url, init) => (posts.push(init), { status: 200 }),
                log: () => {},
            });
            await dispatcher.drain();
            await dispatcher.stop();
            assert.equal(posts.length, 2, "a batch of two, then the third alone");

            const lower = (init) =>
                Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
            for (const init of posts) {
                assert.equal(verifyWebhook(init.body, lower(init), "CHANGE_ME_WEBHOOK_SIGNING_SECRET"), true);
            }
            assert.deepEqual(
                eventsOf(JSON.parse(posts[0].body)).map((e) => e.id),
                ["m1", "m2"],
            );
            assert.deepEqual(
                eventsOf(JSON.parse(posts[1].body)).map((e) => e.id),
                ["m3"],
            );

            // The Python receiver: same two bodies, same signatures, same answer.
            const py = spawnSync(
                "python",
                [
                    "-I",
                    "-c",
                    [
                        "import json, sys, importlib.util",
                        "spec = importlib.util.spec_from_file_location('r', sys.argv[1])",
                        "r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)",
                        "bodies = json.loads(sys.argv[2]); secret = sys.argv[3]",
                        "out = []",
                        "for b in bodies:",
                        "    raw = b['body'].encode()",
                        "    assert r.verify_webhook(raw, {'X-Zalo-Signature': b['sig']}, secret)",
                        "    assert not r.verify_webhook(raw + b' ', {'X-Zalo-Signature': b['sig']}, secret)",
                        "    out.append([e['id'] for e in r.events_of(json.loads(raw))])",
                        "print(json.dumps(out))",
                    ].join("\n"),
                    join(SAMPLES, "clients", "crm_webhook_receiver.py"),
                    JSON.stringify(posts.map((p) => ({ body: p.body, sig: p.headers["X-Zalo-Signature"] }))),
                    "CHANGE_ME_WEBHOOK_SIGNING_SECRET",
                ],
                { encoding: "utf8" },
            );
            if (py.error?.code === "ENOENT") return; // no Python on this machine: the JS receiver above still ran
            assert.equal(py.status, 0, py.stderr);
            assert.deepEqual(JSON.parse(py.stdout), [["m1", "m2"], ["m3"]]);
        } finally {
            outbox.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
