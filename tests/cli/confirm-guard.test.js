/**
 * A destructive command driven as the binary: without --yes nothing is sent and it exits 2, --dry-run reports and
 * exits 0, and --yes goes on to the action (src/core/confirm-guard.js, settled in src/index.js's preAction hook).
 *
 * The sandbox HOME has no credentials, so an invocation that got past the guard meets "Not logged in" from the
 * session. Its absence is the proof that the refused and dry runs never reached the session, let alone Zalo.
 */
import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCli, stripAnsi } from "../helpers/cli.js";

const opts = { home: SANDBOX_HOME, timeout: 120_000 };
const GROUP = "9000000000000000077";
const USER = "9100000000000000001";

describe("a guarded command through the binary", () => {
    it("without --yes: nothing is sent, the refusal says how to go on, and it exits 2", async () => {
        // Red if the guard moves after getApi() (the missing session would answer first), or exits 0 or 1.
        const r = await runCli(["group", "remove-member", GROUP, USER], opts);
        const text = stripAnsi(r.all);
        assert.match(
            text,
            /✗ Not done: this would remove 1 member \(9100000000000000001\) from group 9000000000000000077/,
        );
        assert.match(text, /Re-run with --yes, or --dry-run to preview/);
        assert.doesNotMatch(text, /Not logged in/, "the refusal must come before the session is touched");
        assert.equal(r.code, 2);
    });

    it("--json: one JSON value on stdout, `error` first, with the fields a script acts on", async () => {
        const r = await runCli(["--json", "msg", "undo", "5", GROUP], opts);
        assert.equal(r.code, 2);
        const parsed = JSON.parse(r.stdout.trim());
        assert.equal(Object.keys(parsed)[0], "error");
        assert.equal(parsed.confirmationRequired, true);
        assert.equal(parsed.action, "msg undo");
        assert.equal(parsed.irreversible, true);
        assert.equal(parsed.retryWith, "--yes");
        assert.deepEqual(parsed.target, { msgId: "5", threadId: GROUP });
    });

    it("--dry-run: says what would happen, sends nothing, exits 0", async () => {
        const r = await runCli(["poll", "lock", "42", "--dry-run"], opts);
        const text = stripAnsi(r.all);
        assert.match(text, /Dry run: this would close poll 42/);
        assert.doesNotMatch(text, /Not logged in/);
        assert.equal(r.code, 0);
    });

    it("--yes: gets past the guard and only then meets the missing session", async () => {
        const r = await runCli(["poll", "lock", "42", "--yes"], opts);
        const text = stripAnsi(r.all);
        assert.doesNotMatch(text, /Not done/);
        assert.match(text, /Not logged in/);
    });
});
