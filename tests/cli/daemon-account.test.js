import { SANDBOX_HOME, SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { acquireLock, releaseLock } from "../../src/core/lock.js";
import { runCli } from "../helpers/cli.js";
import { checkCli } from "../helpers/cli-fast.js";

// Most commands run in the in-process CLI worker; a check that fails there is re-run as a real child process
// (tests/helpers/cli-fast.js `checkCli`). The two lock tests always spawn for real.
const options = { home: SANDBOX_HOME, timeout: 120_000 };
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
            await checkCli([...command, "--help"], options, (result) => {
                assert.equal(result.code, 0);
                assert.match(result.all, /--account <id>/);
                assert.match(result.all, /exact registered account ID/);
            });
        });

        it("rejects account names before authentication", async () => {
            await checkCli([...command, "--account", "Example One"], options, (result) => {
                assert.notEqual(result.code, 0);
                assert.match(result.all, /full numeric account ID/);
            });
        });

        it("rejects an empty value instead of using the active account", async () => {
            await checkCli([...command, "--account", ""], options, (result) => {
                assert.notEqual(result.code, 0);
                assert.match(result.all, /full numeric account ID/);
            });
        });

        it("requires a value and does not accept a partial numeric ID", async () => {
            await checkCli([...command, "--account"], options, async (missing) => {
                assert.notEqual(missing.code, 0);
                assert.match(missing.all, /argument missing/);
                await checkCli([...command, "--account", "10"], options, (partial) => {
                    assert.notEqual(partial.code, 0);
                    assert.match(partial.all, /not registered/);
                });
            });
        });

        // A real child process: the lock this test holds is checked against a live, separate process.
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

        // Real child processes, not the worker: the lock is released by the process, and a worker that held it
        // would stay alive holding it.
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
        await checkCli(["--json", "--account", "101", "status"], options, (result) => {
            assert.equal(result.code, 0, result.stderr);
            const data = JSON.parse(result.stdout.trim());
            assert.equal(data.activeAccount?.ownId, "101");
            assert.equal(data.activeAccount?.name, "Example One");
            const registry = JSON.parse(readFileSync(join(CONFIG_DIR, "accounts.json"), "utf8"));
            assert.equal(registry.find((a) => a.active).ownId, "202");
        });
    });

    it("also accepts --account after the subcommand or via ZALO_ACCOUNT", async () => {
        await checkCli(["account", "info", "--json", "--account", "101"], options, async (trailing) => {
            assert.equal(trailing.code, 0, trailing.stderr);
            assert.equal(JSON.parse(trailing.stdout.trim())?.ownId, "101");

            await checkCli(["--json", "status"], { ...options, env: { ZALO_ACCOUNT: "101" } }, (envRes) => {
                assert.equal(envRes.code, 0, envRes.stderr);
                assert.equal(JSON.parse(envRes.stdout.trim()).activeAccount?.ownId, "101");
            });
        });
    });

    it("rejects an unregistered or non-numeric --account on one-shot commands", async () => {
        await checkCli(["--account", "999", "status"], options, async (unknown) => {
            assert.notEqual(unknown.code, 0);
            assert.match(unknown.all, /not registered/);

            await checkCli(["--account", "Example One", "status"], options, (byName) => {
                assert.notEqual(byName.code, 0);
                assert.match(byName.all, /full numeric account ID/);
            });
        });
    });
});
