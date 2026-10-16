import { SANDBOX_HOME, SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { acquireLock, releaseLock } from "../../src/core/lock.js";
import { runCli } from "../helpers/cli.js";

const options = { home: SANDBOX_HOME, timeout: 30_000 };
before(() => assertSandboxed(CONFIG_DIR));
beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
        join(CONFIG_DIR, "accounts.json"),
        JSON.stringify([
            { ownId: "101", name: "Example One", proxy: null, active: false },
            { ownId: "202", name: "Example Two", proxy: null, active: true },
        ]),
    );
});

for (const command of [["listen"], ["mcp", "start"]]) {
    describe(`${command.join(" ")} --account`, () => {
        it("advertises account selection by ID", async () => {
            const result = await runCli([...command, "--help"], options);
            assert.equal(result.code, 0);
            assert.match(result.all, /--account <id>/);
            assert.match(result.all, /exact registered account ID/);
        });

        it("rejects account names before authentication", async () => {
            const result = await runCli([...command, "--account", "Example One"], options);
            assert.notEqual(result.code, 0);
            assert.match(result.all, /full numeric account ID/);
        });

        it("rejects an empty value instead of using the active account", async () => {
            const result = await runCli([...command, "--account", ""], options);
            assert.notEqual(result.code, 0);
            assert.match(result.all, /full numeric account ID/);
        });

        it("requires a value and does not accept a partial numeric ID", async () => {
            const missing = await runCli([...command, "--account"], options);
            assert.notEqual(missing.code, 0);
            assert.match(missing.all, /argument missing/);
            const partial = await runCli([...command, "--account", "10"], options);
            assert.notEqual(partial.code, 0);
            assert.match(partial.all, /not registered/);
        });

        it("uses the explicitly selected inactive account's lock before attempting login", async () => {
            const dir = join(SANDBOX_CONFIG_DIR, "accounts", "101");
            assert.equal(acquireLock(dir), true);
            try {
                const result = await runCli([...command, "--account", "101"], options);
                assert.notEqual(result.code, 0);
                assert.match(result.all, /already running for account 101/);
                assert.doesNotMatch(result.all, /Pinned account login failed/);
                assert.equal(existsSync(join(dir, "zalo.db")), false);
                if (command[0] === "mcp") assert.equal(result.stdout, "");
            } finally {
                releaseLock(dir);
            }
        });

        it("releases the selected account's lock when its saved credentials are missing", async () => {
            const dir = join(SANDBOX_CONFIG_DIR, "accounts", "101");
            const result = await runCli([...command, "--account", "101"], options);
            assert.notEqual(result.code, 0);
            assert.match(result.all, /No saved credentials for the pinned account/);
            assert.equal(existsSync(join(dir, "daemon.lock")), false);
            assert.equal(existsSync(join(dir, "zalo.db")), false);
            const registry = JSON.parse(readFileSync(join(CONFIG_DIR, "accounts.json"), "utf8"));
            assert.equal(registry.find((a) => a.active).ownId, "202");
            if (command[0] === "mcp") assert.equal(result.stdout, "");
        });
    });
}

describe("global --account on one-shot CLI commands", () => {
    it("targets the inactive account without modifying accounts.json", async () => {
        const result = await runCli(["--json", "--account", "101", "status"], options);
        assert.equal(result.code, 0, result.stderr);
        const data = JSON.parse(result.stdout.trim());
        assert.equal(data.activeAccount?.ownId, "101");
        assert.equal(data.activeAccount?.name, "Example One");
        const registry = JSON.parse(readFileSync(join(CONFIG_DIR, "accounts.json"), "utf8"));
        assert.equal(registry.find((a) => a.active).ownId, "202");
    });

    it("also accepts --account after the subcommand or via ZALO_ACCOUNT", async () => {
        const trailing = await runCli(["account", "info", "--json", "--account", "101"], options);
        assert.equal(trailing.code, 0, trailing.stderr);
        assert.equal(JSON.parse(trailing.stdout.trim())?.ownId, "101");

        const envRes = await runCli(["--json", "status"], {
            ...options,
            env: { ZALO_ACCOUNT: "101" },
        });
        assert.equal(envRes.code, 0, envRes.stderr);
        assert.equal(JSON.parse(envRes.stdout.trim()).activeAccount?.ownId, "101");
    });

    it("rejects an unregistered or non-numeric --account on one-shot commands", async () => {
        const unknown = await runCli(["--account", "999", "status"], options);
        assert.notEqual(unknown.code, 0);
        assert.match(unknown.all, /not registered/);

        const byName = await runCli(["--account", "Example One", "status"], options);
        assert.notEqual(byName.code, 0);
        assert.match(byName.all, /full numeric account ID/);
    });
});
