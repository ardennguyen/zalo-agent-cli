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
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_NAMES } from "../../src/core/keystore/config.js";
import { verifyOnReadMode } from "../../src/core/row-mac.js";
import { validatePolicy } from "../../src/core/policy-schema.js";
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
import {
    DEFAULT_MEDIA_DELIVER,
    resolveMediaDelivery,
    resolveMediaLinkAuth,
    resolvePublicUrl,
    resolveTrustedProxies,
    validatePublicUrl,
} from "../../src/core/deploy-policy.js";
import { eventsOf, verifyWebhook } from "../../docs/config-samples/clients/crm-webhook-receiver.mjs";
import { createWebhookDispatcher, openOutbox } from "../../src/core/webhook-outbox.js";
import { createDaemonHealth, renderPrometheus } from "../../src/core/daemon-health.js";
import { PRESENCE_KEYS, resolvePresenceSettings } from "../../src/core/presence-config.js";
import { generateFleetFiles } from "../../src/core/fleet.js";
import { USE_CASES, generateFor } from "../helpers/use-case-manifest.js";

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
            for (const section of ["notify", "limits", "media", "tls", "oauth", "approval", "admin", "presence"]) {
                for (const key of Object.keys(cfg[section] ?? {})) {
                    assert.ok(key in defaults[section], `unknown key "${key}" in "${section}"`);
                }
            }
            for (const [id, block] of Object.entries(cfg.accounts ?? {})) {
                assert.match(id, /^[1-9][0-9]*$/, "an account block is keyed by the numeric account id");
                for (const key of Object.keys(block))
                    assert.ok(known.has(key) && key !== "accounts", `${id}: unknown key "${key}"`);
            }
            // publicUrl is one address for the whole server; its 2.x names stay out of the samples.
            assert.equal(cfg.oauth?.issuerUrl, undefined, "oauth.issuerUrl is the deprecated name of publicUrl");
            if (cfg.publicUrl !== null && cfg.publicUrl !== undefined) {
                assert.equal(validatePublicUrl(cfg.publicUrl).error, null, "a sample publicUrl must be usable");
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

    it("crm-backend.json: the CRM reaches this server, and its one-time pages, at one public address", () => {
        const cfg = mergeMCPConfigLayer(defaults, JSON.parse(read("mcp-config", "crm-backend.json")));
        assert.deepEqual(resolvePublicUrl({ config: cfg, env: {} }), {
            publicUrl: "https://zalo.crm.example.com",
            source: "publicUrl",
            error: null,
            deprecated: false,
        });
    });

    it("every sample sets each media key explicitly, and they resolve to what the docs say", () => {
        for (const file of list("mcp-config", ".json")) {
            const cfg = mergeMCPConfigLayer(defaults, JSON.parse(read("mcp-config", file)));
            for (const key of ["deliver", "inlineMaxBytes", "allowDeliver", "linkTtl", "tempfileTtl", "linkAuth"]) {
                assert.notEqual(cfg.media[key], null, `${file}: media.${key} is set`);
            }
            const p = resolveMediaDelivery({ config: cfg, env: {} });
            assert.deepEqual(p.deliver, DEFAULT_MEDIA_DELIVER, `${file}: the documented defaults, spelled out`);
            assert.equal(p.inlineMaxBytes, 5_242_880);
            assert.equal(p.linkTtlMs, 600_000);
        }
        const auth = (file, id) => {
            const base = mergeMCPConfigLayer(defaults, JSON.parse(read("mcp-config", file)));
            const cfg = id ? resolveAccountMCPConfig(base, { accountId: id }).config : base;
            return resolveMediaLinkAuth({ config: cfg, env: {}, accountId: id, publicUrl: cfg.publicUrl });
        };
        assert.equal(auth("internet.json").linkAuth, "bearer");
        assert.equal(auth("crm-backend.json").linkAuth, "bearer");
        assert.equal(auth("local-agent.json").linkAuth, "capability");
        assert.deepEqual(
            [auth("multi-account.json", "1000000000000000002").maxClients, auth("multi-account.json").maxClients],
            [10, 3],
            "a per-account tier raises the capability limit for that account only",
        );
        const internet = mergeMCPConfigLayer(defaults, JSON.parse(read("mcp-config", "internet.json")));
        assert.deepEqual(resolveMediaDelivery({ config: internet, env: {} }).allowDeliver, ["inline", "link"]);
        assert.deepEqual(resolveTrustedProxies({ config: internet, env: {} }), ["127.0.0.1"]);
    });

    it("every sample sets each presence key explicitly; backends are on-demand, the local agent always-on", () => {
        for (const file of list("mcp-config", ".json")) {
            const cfg = mergeMCPConfigLayer(defaults, JSON.parse(read("mcp-config", file)));
            for (const key of Object.keys(PRESENCE_KEYS)) {
                assert.notEqual(cfg.presence[key], null, `${file}: presence.${key} is set`);
            }
            const r = resolvePresenceSettings({ config: cfg, env: {} });
            assert.equal(r.settings.mode, file === "local-agent.json" ? "always-on" : "on-demand", file);
            assert.equal(r.settings.idleTimeoutMs, 300_000);
            assert.equal(r.settings.catchUpEveryMs, 0, `${file}: the pulse is off until L1/L2 are measured`);
            assert.equal(r.settings.connectOnStart, true);
            assert.equal(validatePolicy({ presence: JSON.parse(read("mcp-config", file)).presence }).errors.length, 0);
        }
        const env = parseEnv(read("env", "multi-account.env"));
        const one = resolvePresenceSettings({ accountId: "1000000000000000001", env });
        const two = resolvePresenceSettings({ accountId: "1000000000000000002", env });
        assert.deepEqual([one.settings.mode, two.settings.mode], ["always-on", "on-demand"]);
    });

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
        assert.equal(a.confirmMode, "agent");
    });
});

describe("env samples", () => {
    const inSource = namesInSource();
    /** Every assignment in a file, active or commented out (`# NAME=value`). */
    const assignments = (text) =>
        [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => ({ name: m[1], value: m[2].trim() }));
    const base = (name) => name.replace(/_[1-9][0-9]{8,}$/, "");

    const files = [
        ...list("env", ".env").map((f) => join("env", f)),
        join("systemd", "common.env"),
        join("systemd", "home.env"),
    ];
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
                // A *_FILE names where a secret is kept (a path), never the secret itself.
                if (/_FILE$/.test(name)) assert.match(value, /^\//, `${name} must be an absolute path`);
                else if (/TOKEN|SECRET/.test(name)) assert.match(value, /^CHANGE_ME/, `${name} must be a placeholder`);
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

    it("crm-backend.env: the admin console's credential is a file the service reads, never inline or the agent's", () => {
        const env = parseEnv(read("env", "crm-backend.env"));
        assert.match(envForAccount("ZALO_MCP_ADMIN_TOKEN_FILE", "1000000000000000001", env), /^\//);
        assert.equal(envForAccount("ZALO_MCP_ADMIN_TOKEN", "1000000000000000001", env), null);
        const cfg = JSON.parse(read("mcp-config", "crm-backend.json"));
        assert.deepEqual(Object.keys(cfg.admin).sort(), ["clientCa", "tokenFile"]);
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

    it("the proxies never compress media links (byte ranges) and give the engine the client's own address", () => {
        assert.match(read("proxy", "Caddyfile.internet"), /@compress not path \/zalo\/media\/\*\s+encode @compress /);
        assert.match(
            read("proxy", "Caddyfile.multi-account"),
            /@compress not path \/a\/\*\/zalo\/media\/\*\s+encode @compress /,
        );
        assert.doesNotMatch(read("proxy", "Caddyfile.internet"), /^\tencode zstd/m, "no unconditional encode");
        const media = /location \/zalo\/media\/ \{([^}]*)\}/.exec(read("proxy", "nginx.internet.conf"))?.[1] ?? "";
        assert.match(media, /gzip off;/);
        assert.match(media, /proxy_buffering off;/);
        assert.match(media, /proxy_set_header X-Forwarded-For \$remote_addr;/);
    });

    // G5: the admin API (runtime policy, usage, export) and the Prometheus endpoints never answer from the internet.
    it("every internet proxy answers 404 for /zalo/admin/*, /metrics and /status", () => {
        for (const f of ["Caddyfile.internet", "Caddyfile.multi-account"]) {
            const text = read("proxy", f);
            const blocks = text.split(/reverse_proxy 127\.0\.0\.1:39|reverse_proxy 127\.0\.0\.1:3847/).length - 1;
            assert.ok(blocks >= 1, f);
            assert.equal(
                (
                    text.match(
                        /@internal path \/metrics \/status \/zalo\/admin \/zalo\/admin\/\*\n\t+respond @internal 404/g,
                    ) || []
                ).length,
                blocks,
                `${f}: every MCP upstream keeps the admin API and metrics inside`,
            );
        }
        const nginx = read("proxy", "nginx.internet.conf");
        assert.match(nginx, /location \/zalo\/admin \{ return 404; \}/);
        assert.match(nginx, /location = \/metrics +\{ return 404; \}/);
        assert.match(nginx, /location = \/status +\{ return 404; \}/);
    });

    it("the internet proxies route the one-time QR link to the login's QR port, and the rest to the MCP server", () => {
        assert.match(
            read("proxy", "Caddyfile.internet"),
            /handle \/zalo\/qr\/\* \{\s*reverse_proxy 127\.0\.0\.1:18927/,
        );
        assert.match(
            read("proxy", "nginx.internet.conf"),
            /location \/zalo\/qr\/ \{\s*proxy_pass http:\/\/127\.0\.0\.1:18927;/,
        );
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
                    "-B", // no __pycache__ inside the checkout: no-real-ids reads every file there
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

describe("monitoring samples", () => {
    const rules = read("monitoring", "alert-rules.yml");

    /** Every metric a daemon can expose, once it has seen a close, an event, a stage and a webhook. */
    function emittedMetrics() {
        const health = createDaemonHealth({ kind: "mcp", accountId: "A1", version: "1" });
        health.noteUp();
        health.noteDown(1006);
        health.noteUp();
        health.noteEvent("message");
        health.setSource("webhook", () => ({
            pending: 1,
            dead: 0,
            oldestPendingAgeMs: 1000,
            deliveredTotal: 1,
            consecutiveFailures: 0,
            lastSuccessAt: Date.now() - 1000,
        }));
        health.setSource("buffer", () => ({ threads: 1, messages: 1 }));
        health.setSource("stage", () => ({ stage: "messages", startedAt: Date.now() }));
        health.setSource("accountState", () => ({ state: "connected", since: null }));
        const text = renderPrometheus(health.snapshot());
        health.stop();
        return new Set(text.match(/^zalo_[a-z_]+/gm));
    }

    it("every metric an alert rule reads is one the daemon exposes", () => {
        const emitted = emittedMetrics();
        const used = new Set(rules.match(/\bzalo_[a-z_]+/g));
        assert.ok(used.size >= 8, "the rules read the daemon's own metrics");
        for (const name of used)
            assert.ok(emitted.has(name), `alert-rules.yml reads ${name}, which /metrics does not expose`);
    });

    it("the ten documented alerts are all there, each with an expression, a severity and a summary", () => {
        const blocks = rules.split(/^\s+- alert: /m).slice(1);
        assert.equal(blocks.length, 10);
        for (const b of blocks) {
            assert.match(b, /\n\s+expr: \S/, `${b.split("\n")[0]} has no expr`);
            assert.match(b, /severity: (page|warn|info)/);
            assert.match(b, /summary: "/);
        }
    });

    it("the scrape config sends the bearer token from a file, never inline", () => {
        const scrape = read("monitoring", "prometheus.yml");
        assert.match(scrape, /metrics_path: \/metrics/);
        assert.match(scrape, /type: Bearer/);
        assert.match(scrape, /credentials_file: /);
        assert.doesNotMatch(scrape, /^\s+credentials: /m);
        assert.ok(!scrape.includes("\t") && !rules.includes("\t"), "YAML does not allow tabs");
    });
});

describe("storage samples", () => {
    // docs/config-samples/storage/*.json are what docs/security.md points operators at: each names a provider the key
    // layer knows and holds no key material (a key id or path only).
    for (const file of list("storage", ".json")) {
        it(`${file}: a known provider, a boolean dkeyLayer, no key material`, () => {
            const cfg = JSON.parse(read("storage", file));
            assert.ok(PROVIDER_NAMES.includes(cfg.provider), `${cfg.provider} is a provider`);
            assert.equal(typeof cfg.dkeyLayer, "boolean");
            // Every key set explicitly, even at its default (the owner's rule), and to a value the layer takes.
            assert.equal(verifyOnReadMode(cfg), cfg.rowMac?.verifyOnRead, "rowMac.verifyOnRead is set and valid");
            assert.doesNotMatch(read("storage", file), /"(key|secret|passphrase)"\s*:\s*"[A-Za-z0-9+/=]{40,}"/);
            // Retention and quota: every key set, each to a value the policy schema takes (no "none" mode).
            for (const key of ["messages", "media", "outboxDead", "purgeEvery"])
                assert.ok(cfg.retention?.[key], `retention.${key} is set`);
            for (const key of ["graceDays", "warnAt", "purgeOrder"])
                assert.ok(key in (cfg.quota ?? {}), `quota.${key} is set`);
            assert.ok("limit" in (cfg.quota?.account ?? {}), "quota.account.limit is set (null: no limit)");
            const v = validatePolicy({ retention: cfg.retention, quota: cfg.quota }, { allowNull: true });
            assert.deepEqual(v.errors, [], JSON.stringify(v.errors));
        });
    }
});

describe("use-case sample sets (docs/config-samples/use-cases/)", () => {
    const UC = join(SAMPLES, "use-cases");
    const inSource = namesInSource();
    const base = (name) => name.replace(/_[1-9][0-9]{8,}$/, "");
    const assignments = (text) =>
        [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => ({ name: m[1], value: m[2].trim() }));
    const walk = (dir, prefix = "") =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
        );
    const ucRead = (uc, rel) => readFileSync(join(UC, uc, rel), "utf8");

    // What `fleet generate` writes for each set the samples are made from, in a scratch folder.
    const gens = {};
    before(() => {
        for (const [name, cfg] of Object.entries(generateFor)) {
            const out = mkdtempSync(join(tmpdir(), "zalo-uc-gen-"));
            generateFleetFiles({ outDir: out, ...cfg });
            gens[name] = out;
        }
    });
    after(() => {
        for (const out of Object.values(gens)) rmSync(out, { recursive: true, force: true });
    });

    it("there is one folder per use case, and nothing else", () => {
        assert.deepEqual(readdirSync(UC).sort(), Object.keys(USE_CASES).sort());
    });

    for (const [uc, manifest] of Object.entries(USE_CASES)) {
        it(`${uc}: holds its full set, nothing missing and nothing extra`, () => {
            assert.deepEqual(walk(join(UC, uc)).sort(), Object.keys(manifest).sort());
        });

        it(`${uc}: every shared file is byte-identical to its building block or to fleet generate`, () => {
            for (const [rel, src] of Object.entries(manifest)) {
                if (!src) continue;
                const want = src.sample
                    ? readFileSync(join(SAMPLES, src.sample), "utf8")
                    : src.gen
                      ? readFileSync(join(gens[src.gen], src.file), "utf8")
                      : readFileSync(join(UC, src.useCase), "utf8");
                assert.equal(ucRead(uc, rel), want, `${uc}/${rel} drifted from ${JSON.stringify(src)}`);
            }
        });

        it(`${uc}: the README (EN and VN) names every file, and the two have the same sections`, () => {
            const files = Object.keys(manifest).filter((f) => !/^(README|MIGRATE)(\.vi)?\.md$/.test(f));
            for (const doc of ["README.md", "README.vi.md"]) {
                const text = ucRead(uc, doc);
                for (const f of files) assert.ok(text.includes(f), `${uc}/${doc} does not name ${f}`);
            }
            for (const [en, vi] of [
                ["README.md", "README.vi.md"],
                ["MIGRATE.md", "MIGRATE.vi.md"],
            ]) {
                if (!(en in manifest)) continue;
                const sections = (t) => (t.match(/^#{2,3} /gm) || []).length;
                assert.equal(sections(ucRead(uc, vi)), sections(ucRead(uc, en)), `${uc}: ${vi} and ${en} sections`);
                assert.ok(ucRead(uc, en).includes(vi) && ucRead(uc, vi).includes(en), `${uc}: ${en} and ${vi} link`);
            }
        });

        it(`${uc}: no token on a command line, and no 0.0.0.0 bind`, () => {
            for (const rel of Object.keys(manifest)) {
                const text = ucRead(uc, rel);
                assert.doesNotMatch(text, /--auth[ =]/, `${uc}/${rel}: a token on a command line is in ps and history`);
                for (const line of text.split("\n").filter((l) => l.includes("0.0.0.0")))
                    assert.match(line, /\b(not|never|không)\b/, `${uc}/${rel}: bind an address, not every interface`);
            }
        });

        const envFiles = Object.keys(manifest).filter((f) => /(^|\/)(\.env|[^/]+\.env)$/.test(f));
        if (envFiles.length) {
            it(`${uc}: every variable in its env files is one the engine reads, and every secret a placeholder`, () => {
                for (const rel of envFiles) {
                    for (const { name, value } of assignments(ucRead(uc, rel))) {
                        assert.ok(inSource.has(base(name)), `${uc}/${rel}: no source file reads ${name}`);
                        if (/_FILE$/.test(name)) assert.match(value, /^\//, `${uc}/${rel}: ${name} is a path`);
                        else if (/TOKEN|SECRET/.test(name)) assert.match(value, /^CHANGE_ME/, `${uc}/${rel}: ${name}`);
                    }
                }
            });
        }

        const configs = Object.keys(manifest).filter((f) => f.endsWith("mcp-config.json"));
        for (const rel of configs) {
            it(`${uc}: ${rel} uses only keys the loader merges and sets every presence key`, () => {
                const defaults = getDefaultConfig();
                const cfg = JSON.parse(ucRead(uc, rel));
                for (const key of Object.keys(cfg)) assert.ok(key in defaults || key === "accounts", key);
                const merged = mergeMCPConfigLayer(defaults, cfg);
                for (const key of Object.keys(PRESENCE_KEYS)) assert.notEqual(merged.presence[key], null, key);
                assert.equal(merged.media.downloadDir, null, "media under the account folder, inside ReadWritePaths");
            });
        }

        const storages = Object.keys(manifest).filter((f) => /storage(\.[a-z]+)?\.json$/.test(f));
        for (const rel of storages) {
            it(`${uc}: ${rel} names a known provider and holds no key`, () => {
                const cfg = JSON.parse(ucRead(uc, rel));
                assert.ok(PROVIDER_NAMES.includes(cfg.provider));
                assert.doesNotMatch(ucRead(uc, rel), /"(key|secret|passphrase)"\s*:\s*"[A-Za-z0-9+/=]{40,}"/);
            });
        }
    }

    const VPS = ["c-vps-few-accounts", "d-crm-backend", "e-saas-kms"];
    const HOME = "home/zalo/.zalo-agent-cli";

    // G1, on the sets themselves.
    it("c, d, e: every path an env file sets is under the unit's ReadWritePaths; common.env sets none", () => {
        for (const uc of VPS) {
            const rw = /^ReadWritePaths=(.+)$/m.exec(ucRead(uc, "etc/systemd/system/zalo-mcp@.service"))[1].split(" ");
            const dirs = (rel) =>
                Object.entries(parseEnv(ucRead(uc, rel)))
                    .filter(([k]) => /_DIR$/.test(k))
                    .map(([, v]) => v);
            assert.deepEqual(dirs("etc/zalo-mcp/common.env"), [], `${uc}: common.env is read by the units only`);
            for (const p of dirs(`${HOME}/.env`))
                assert.ok(
                    rw.some((w) => p === w || p.startsWith(`${w}/`)),
                    `${uc}: ${p}`,
                );
            assert.ok(rw.includes("/home/zalo/.zalo-agent-cli"), uc);
        }
    });

    // G2, on the sets themselves.
    it("c and d: the passphrase provider is wired for every unit that opens sealed files, and for za", () => {
        for (const uc of ["c-vps-few-accounts", "d-crm-backend"]) {
            assert.equal(JSON.parse(ucRead(uc, `${HOME}/storage.json`)).provider, "passphrase", uc);
            const units = Object.keys(USE_CASES[uc]).filter((f) =>
                /^etc\/systemd\/system\/zalo-(mcp@|mcp-purge|backup|fleet-controller)\.service$/.test(f),
            );
            assert.ok(units.length >= 3, uc);
            for (const unit of units) {
                const dropin = `${unit}.d/credentials.conf`;
                assert.ok(dropin in USE_CASES[uc], `${uc}: ${unit} gets the credential`);
                assert.match(
                    ucRead(uc, dropin),
                    /^LoadCredentialEncrypted=zalo-storage-passphrase:\/etc\/zalo-mcp\/storage-passphrase\.cred$/m,
                );
            }
            assert.match(ucRead(uc, "usr/local/bin/za"), /LoadCredentialEncrypted=zalo-storage-passphrase:/);
        }
        assert.equal(JSON.parse(ucRead("e-saas-kms", `${HOME}/storage.json`)).provider, "kms");
        assert.doesNotMatch(ucRead("e-saas-kms", "usr/local/bin/za"), /LoadCredential/);
    });

    // G4 and G5, on the sets themselves.
    it("c, d, e: each account's public URL comes back through its own proxy block, and the admin API never does", () => {
        for (const uc of VPS) {
            const common = parseEnv(ucRead(uc, "etc/zalo-mcp/common.env"));
            assert.deepEqual(resolveTrustedProxies({ config: {}, env: common }), ["127.0.0.1"], uc);
            const caddy = ucRead(uc, "etc/caddy/Caddyfile");
            const [pub, admin] = caddy.split(/^admin\.zalo\.example\.com \{$/m);
            for (const id of ["1000000000000000001", "1000000000000000002"]) {
                const env = { ...common, ...parseEnv(ucRead(uc, `etc/zalo-mcp/accounts/${id}.env`)) };
                const url = resolvePublicUrl({ env, config: {}, aliases: false }).publicUrl;
                assert.equal(url, `https://zalo.example.com/a/${id}`, `${uc}/${id}`);
                const block = new RegExp(
                    `handle_path /a/${id}/\\* \\{\\n\\t\\t@internal path /metrics /status /zalo/admin /zalo/admin/\\*\\n\\t\\trespond @internal 404\\n\\n\\t\\treverse_proxy 127\\.0\\.0\\.1:39\\d\\d \\{\\n\\t\\t\\tflush_interval -1\\n\\t\\t\\ttransport http \\{\\n\\t\\t\\t\\tread_timeout 310s`,
                );
                assert.match(pub, block, `${uc}: ${id}'s public block`);
            }
            assert.match(pub, /@compress not path \/a\/\*\/zalo\/media\/\*\n\tencode @compress /, uc);
            assert.equal((pub.match(/reverse_proxy 127\.0\.0\.1:39\d\d/g) || []).length, 2, `${uc}: no other upstream`);
            if (admin) {
                assert.match(admin, /^\troute \{\n\t\t@outsider not remote_ip \S+\n\t\trespond @outsider 404\n/m, uc);
                assert.equal((admin.match(/@other not path \/zalo\/admin \/zalo\/admin\/\*/g) || []).length, 3, uc);
            }
        }
    });

    it("c: the main account is the one always-on; the companion and the rest are on-demand", () => {
        const base = mergeMCPConfigLayer(
            getDefaultConfig(),
            JSON.parse(ucRead("c-vps-few-accounts", `${HOME}/mcp-config.json`)),
        );
        const mode = (id) =>
            resolvePresenceSettings({ config: resolveAccountMCPConfig(base, { accountId: id }).config, env: {} })
                .settings.mode;
        assert.deepEqual([mode("1000000000000000001"), mode("1000000000000000002")], ["always-on", "on-demand"]);
        const d = JSON.parse(ucRead("d-crm-backend", `${HOME}/mcp-config.json`));
        assert.equal(d.approval.deliver, "webhook");
        assert.equal(d.admin.tokenFile, "/etc/zalo-mcp/admin-token");
    });

    it("e: the tenant file is a policy the store accepts, and each account names its own KMS key", () => {
        const doc = JSON.parse(ucRead("e-saas-kms", `${HOME}/tenants/tenant-a.json`));
        assert.deepEqual(validatePolicy(doc.policy, { scope: "tenant", allowNull: true }).errors, []);
        const keys = ["1000000000000000001", "1000000000000000002"].map(
            (id) => parseEnv(ucRead("e-saas-kms", `etc/zalo-mcp/accounts/${id}.env`)).ZALO_KMS_KEY,
        );
        assert.ok(keys.every((k) => /^arn:aws:kms:/.test(k)));
        assert.notEqual(keys[0], keys[1]);
    });

    it("c: MIGRATE (EN and VN) says to copy before any 3.0 command and never to run two copies of one login", () => {
        for (const doc of ["MIGRATE.md", "MIGRATE.vi.md"]) {
            const text = ucRead("c-vps-few-accounts", doc);
            assert.match(text, /account security provider passphrase/, doc);
            assert.match(text, /account security migrate --all/, doc);
            assert.match(text, /logout --no-remote/, doc);
        }
    });
});
