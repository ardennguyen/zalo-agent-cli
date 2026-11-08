/**
 * The `presence` group driven as the binary, with no daemon: `status` says nothing holds the socket, `wake` and
 * `park` exit 1 and open nothing themselves (the CLI never opens a socket; AGENTS.md section 13); `resume` is
 * guarded (exit 2 without --yes).
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { runCli, stripAnsi } from "../helpers/cli.js";

const options = { home: SANDBOX_HOME, timeout: 120_000 };
const OWN = "5353";

describe("presence", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(
            join(CONFIG_DIR, "accounts.json"),
            JSON.stringify([{ ownId: OWN, name: "Tester", active: true }]),
        );
        mkdirSync(getAccountDir(OWN), { recursive: true });
    });

    it("status with no daemon: running false, exit 0", async () => {
        const r = await runCli(["--json", "presence", "status"], options);
        assert.equal(r.code, 0, r.all);
        assert.deepEqual(JSON.parse(stripAnsi(r.stdout)), { accountId: OWN, running: false });
    });

    it("resume is guarded: without --yes nothing is asked of the daemon (exit 2); --dry-run says what it would do", async () => {
        const bare = await runCli(["presence", "resume"], options);
        assert.equal(bare.code, 2, bare.all);
        assert.match(bare.all, /take account 5353 back from the other session/);
        const dry = await runCli(["--json", "presence", "resume", "--dry-run"], options);
        assert.equal(dry.code, 0, dry.all);
        assert.equal(JSON.parse(stripAnsi(dry.stdout)).action, "presence resume");
        const yes = await runCli(["presence", "resume", "--yes"], options);
        assert.equal(yes.code, 1, yes.all);
        assert.match(yes.all, /No daemon runs/);
    });

    it("wake and park with no daemon exit 1 and say a daemon is needed", async () => {
        for (const verb of ["wake", "park"]) {
            const r = await runCli(["presence", verb], options);
            assert.equal(r.code, 1, r.all);
            assert.match(r.all, /No daemon runs/);
        }
    });
});
