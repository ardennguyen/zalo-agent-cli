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
import { getDefaultConfig, loadMCPConfig, saveMCPConfig, parseDuration } from "../../src/mcp/mcp-config.js";

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

    it("defaults to manual mode with notifications OFF", () => {
        const d = getDefaultConfig();
        assert.equal(d.mode, "manual");
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
