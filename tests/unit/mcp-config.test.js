/**
 * src/mcp/mcp-config.js — MCP config defaults, the nested merge, and
 * parseDuration.
 *
 * The merge is the interesting part: it is shallow at the top level but
 * explicitly deep for `notify`, `limits` and `media`. A user who overrides
 * one nested key must keep the defaults for its siblings.
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    getDefaultConfig,
    loadMCPConfig,
    readMCPConfig,
    resolveAccountMCPConfig,
    envForAccount,
    saveMCPConfig,
    parseDuration,
    resolveWebhookDelivery,
} from "../../src/mcp/mcp-config.js";

const CONFIG_FILE = join(SANDBOX_CONFIG_DIR, "mcp-config.json");

function write(obj) {
    mkdirSync(SANDBOX_CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, typeof obj === "string" ? obj : JSON.stringify(obj), "utf-8");
}

describe("mcp-config — sandboxing", () => {
    it("reads and writes inside the test sandbox", () => assertSandboxed(CONFIG_DIR));
});

describe("getDefaultConfig", () => {
    it("watches both DM and group threads by default", () => {
        assert.deepEqual(getDefaultConfig().watchThreads, ["dm:*", "group:*"]);
    });

    it("defaults to manual mode with notifications and webhook OFF", () => {
        const d = getDefaultConfig();
        assert.equal(d.mode, "manual");
        assert.equal(d.webhook, null);
        assert.equal(d.notify.enabled, false);
        assert.equal(d.notify.thread, null);
    });

    it("returns a fresh object each call — callers may mutate safely", () => {
        const a = getDefaultConfig();
        a.limits.maxMessagesPerPoll = 999;
        assert.equal(getDefaultConfig().limits.maxMessagesPerPoll, 20);
    });

    it("ships the documented limit defaults", () => {
        assert.deepEqual(getDefaultConfig().limits, {
            maxMessagesPerPoll: 20,
            autoDigestThreshold: 50,
            bufferMaxAge: "2h",
            bufferMaxSize: 500,
        });
    });
});

describe("loadMCPConfig", () => {
    it("reads an explicit path when one is given", () => {
        // `mcp start --config <path>` declared this flag, parsed it, and then
        // dropped it: loadMCPConfig took no argument at all, so a second config
        // silently resolved to the default one.
        const custom = join(CONFIG_DIR, "elsewhere.json");
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(custom, JSON.stringify({ watchThreads: ["group:FromCustomPath"] }));
        assert.deepEqual(loadMCPConfig(custom).watchThreads, ["group:FromCustomPath"]);
    });

    it("still falls back to the default file when given nothing", () => {
        saveMCPConfig({ ...getDefaultConfig(), watchThreads: ["group:FromDefaultPath"] });
        assert.deepEqual(loadMCPConfig().watchThreads, ["group:FromDefaultPath"]);
    });

    it("falls back to defaults when the explicit path does not exist", () => {
        assert.deepEqual(loadMCPConfig(join(CONFIG_DIR, "no-such-file.json")), getDefaultConfig());
    });

    beforeEach(() => rmSync(CONFIG_FILE, { force: true }));

    it("returns defaults when no config file exists", () => {
        assert.deepEqual(loadMCPConfig(), getDefaultConfig());
    });

    it("returns defaults (does not throw) on invalid JSON", () => {
        write("{ broken");
        assert.deepEqual(loadMCPConfig(), getDefaultConfig());
    });

    it("overrides a top-level key", () => {
        write({ mode: "auto" });
        assert.equal(loadMCPConfig().mode, "auto");
    });

    it("deep-merges notify — siblings keep their defaults", () => {
        write({ notify: { enabled: true, thread: "123" } });
        const c = loadMCPConfig();
        assert.equal(c.notify.enabled, true);
        assert.equal(c.notify.thread, "123");
        assert.deepEqual(c.notify.on, ["dm"], "untouched nested keys must survive");
        assert.equal(c.notify.cooldown, "5m");
    });

    it("deep-merges limits", () => {
        write({ limits: { bufferMaxSize: 50 } });
        const c = loadMCPConfig();
        assert.equal(c.limits.bufferMaxSize, 50);
        assert.equal(c.limits.maxMessagesPerPoll, 20);
    });

    it("deep-merges media", () => {
        write({ media: { autoOpen: false } });
        const c = loadMCPConfig();
        assert.equal(c.media.autoOpen, false);
        assert.equal(c.media.downloadDir, null);
    });

    it("replaces array values wholesale rather than concatenating", () => {
        write({ watchThreads: ["group:Work*"] });
        assert.deepEqual(loadMCPConfig().watchThreads, ["group:Work*"]);
    });

    it("tolerates a config that omits every nested object", () => {
        write({ mode: "auto" });
        const c = loadMCPConfig();
        assert.equal(typeof c.notify, "object");
        assert.equal(typeof c.limits, "object");
        assert.equal(typeof c.media, "object");
    });
});

describe("saveMCPConfig", () => {
    beforeEach(() => rmSync(CONFIG_FILE, { force: true }));

    it("creates CONFIG_DIR if missing and writes readable JSON", () => {
        rmSync(SANDBOX_CONFIG_DIR, { recursive: true, force: true });
        saveMCPConfig({ mode: "auto" });
        assert.equal(existsSync(CONFIG_FILE), true);
        assert.match(readFileSync(CONFIG_FILE, "utf-8"), /\n {2}"mode"/);
    });

    it("round-trips through loadMCPConfig", () => {
        const cfg = getDefaultConfig();
        cfg.mode = "auto";
        cfg.notify.enabled = true;
        saveMCPConfig(cfg);
        const back = loadMCPConfig();
        assert.equal(back.mode, "auto");
        assert.equal(back.notify.enabled, true);
    });
});

describe("parseDuration", () => {
    it("passes a number straight through", () => {
        assert.equal(parseDuration(5000), 5000);
        assert.equal(parseDuration(0), 0);
    });

    it("parses each supported unit", () => {
        assert.equal(parseDuration("2h"), 7_200_000);
        assert.equal(parseDuration("5m"), 300_000);
        assert.equal(parseDuration("30s"), 30_000);
        assert.equal(parseDuration("250ms"), 250);
    });

    it("is case-insensitive", () => {
        assert.equal(parseDuration("2H"), 7_200_000);
        assert.equal(parseDuration("5M"), 300_000);
    });

    it("tolerates whitespace between value and unit", () => {
        assert.equal(parseDuration("2 h"), 7_200_000);
    });

    it("treats a bare number string as milliseconds", () => {
        assert.equal(parseDuration("1500"), 1500);
    });

    it("returns 0 for unparseable input rather than NaN", () => {
        for (const bad of ["", "abc", "2 days", "-5m", "1.5h", null, undefined, {}]) {
            assert.equal(parseDuration(bad), 0, `parseDuration(${JSON.stringify(bad)}) should be 0`);
        }
    });

    it("never returns NaN — a NaN cooldown would break notifier batching", () => {
        for (const v of ["", "x", "2h", 500, null]) {
            assert.equal(Number.isNaN(parseDuration(v)), false);
        }
    });
});

describe("readMCPConfig -- what mcp start refuses instead of serving the defaults", () => {
    beforeEach(() => rmSync(CONFIG_FILE, { force: true }));

    it("an --config path that does not exist is a problem, not the defaults", () => {
        const r = readMCPConfig(join(CONFIG_DIR, "no-such-file.json"));
        // Red if a mistyped path goes back to silently watching every thread.
        assert.match(r.problem, /cannot read the config file .*no-such-file\.json \(ENOENT\)/);
    });

    it("a config that is not valid JSON is a problem, default path or not", () => {
        write("{ broken");
        assert.match(readMCPConfig().problem, /is not valid JSON/);
        const custom = join(CONFIG_DIR, "broken.json");
        writeFileSync(custom, "{ broken");
        assert.match(readMCPConfig(custom).problem, /is not valid JSON/);
    });

    it("no default file at all is the normal first run: the defaults, no problem", () => {
        assert.deepEqual(readMCPConfig(), { config: getDefaultConfig(), problem: null });
    });

    it("a good file reads exactly as loadMCPConfig reads it", () => {
        write({ watchThreads: ["group:Only*"] });
        const r = readMCPConfig();
        assert.equal(r.problem, null);
        assert.deepEqual(r.config, loadMCPConfig());
        assert.deepEqual(r.config.watchThreads, ["group:Only*"]);
    });
});

describe("envForAccount & resolveAccountMCPConfig — multi-account CRM readiness", () => {
    it("prefers <KEY>_<accountId> over <KEY> and trims whitespace", () => {
        const fakeEnv = {
            ZALO_MCP_AUTH_TOKEN: "global-token",
            ZALO_MCP_AUTH_TOKEN_1001: "  account-1001-token  ",
        };
        assert.equal(envForAccount("ZALO_MCP_AUTH_TOKEN", "1001", fakeEnv), "account-1001-token");
        assert.equal(envForAccount("ZALO_MCP_AUTH_TOKEN", "2002", fakeEnv), "global-token");
        assert.equal(envForAccount("ZALO_MCP_MISSING", "1001", fakeEnv), null);
    });

    it("merges config.accounts[accountId] and <accountDir>/mcp-config.json over top-level config", () => {
        const base = {
            ...getDefaultConfig(),
            watchThreads: ["dm:*"],
            tls: { cert: "/global/cert.pem", key: "/global/key.pem" },
            accounts: {
                1001: {
                    httpPort: 3101,
                    oauth: { clientId: "crm-1001", clientSecret: "sec-1001" },
                },
            },
        };
        const acctDir = join(CONFIG_DIR, "accounts", "1001");
        mkdirSync(acctDir, { recursive: true });
        writeFileSync(
            join(acctDir, "mcp-config.json"),
            JSON.stringify({
                watchThreads: ["group:ACME*"],
                webhook: "https://crm.example.com/hook/1001",
            }),
            "utf-8",
        );

        const { config, problem } = resolveAccountMCPConfig(base, {
            accountId: "1001",
            accountDir: acctDir,
            explicitConfigPath: null,
        });
        assert.equal(problem, null);
        assert.equal(config.httpPort, 3101);
        assert.equal(config.oauth.clientId, "crm-1001");
        assert.equal(config.tls.cert, "/global/cert.pem");
        assert.deepEqual(config.watchThreads, ["group:ACME*"]);
        assert.equal(config.webhook, "https://crm.example.com/hook/1001");
    });

    it("reports a problem when <accountDir>/mcp-config.json exists and is invalid JSON", () => {
        const acctDir = join(CONFIG_DIR, "accounts", "1002");
        mkdirSync(acctDir, { recursive: true });
        writeFileSync(join(acctDir, "mcp-config.json"), "{ invalid json", "utf-8");

        const { problem } = resolveAccountMCPConfig(getDefaultConfig(), {
            accountId: "1002",
            accountDir: acctDir,
            explicitConfigPath: null,
        });
        assert.match(problem, /per-account config file .* is not valid JSON/);
    });
});

describe("resolveWebhookDelivery", () => {
    it("defaults to one event per POST and a 24 hour retention", () => {
        const d = resolveWebhookDelivery("1001", getDefaultConfig(), {});
        assert.deepEqual(d, { batchSize: 1, maxAgeMs: 24 * 3600_000, warnings: [] });
        assert.equal(getDefaultConfig().webhookBatchSize, 1);
        assert.equal(getDefaultConfig().webhookMaxAge, "24h");
    });

    it("takes the config file's values, and listen's no-config call gets the defaults", () => {
        const d = resolveWebhookDelivery("1001", { webhookBatchSize: 20, webhookMaxAge: "6h" }, {});
        assert.deepEqual([d.batchSize, d.maxAgeMs], [20, 6 * 3600_000]);
        assert.deepEqual(resolveWebhookDelivery("1001", undefined, {}).batchSize, 1);
    });

    it("the environment beats the config, and the per-account name beats the plain one", () => {
        const env = {
            ZALO_WEBHOOK_BATCH_SIZE: "10",
            ZALO_WEBHOOK_BATCH_SIZE_1001: "50",
            ZALO_WEBHOOK_MAX_AGE: "12h",
        };
        const cfg = { webhookBatchSize: 2, webhookMaxAge: "1h" };
        const mine = resolveWebhookDelivery("1001", cfg, env);
        assert.deepEqual([mine.batchSize, mine.maxAgeMs], [50, 12 * 3600_000]);
        assert.equal(resolveWebhookDelivery("1002", cfg, env).batchSize, 10);
    });

    it("an unusable value falls back to the default and says so", () => {
        for (const bad of ["0", "101", "2.5", "many", "-3"]) {
            const d = resolveWebhookDelivery("1001", {}, { ZALO_WEBHOOK_BATCH_SIZE: bad });
            assert.equal(d.batchSize, 1, bad);
            assert.equal(d.warnings.length, 1, bad);
            assert.match(d.warnings[0], /batch size/);
        }
        for (const bad of ["soon", "30s", "0", "-1h"]) {
            const d = resolveWebhookDelivery("1001", {}, { ZALO_WEBHOOK_MAX_AGE: bad });
            assert.equal(d.maxAgeMs, 24 * 3600_000, bad);
            assert.match(d.warnings[0], /max age/);
        }
    });
});
