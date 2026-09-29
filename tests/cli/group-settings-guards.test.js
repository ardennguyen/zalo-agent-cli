/**
 * `group settings` through the real binary, for the paths that need no session.
 *
 * tests/unit/group-settings.test.js proves what the read-modify-write sends.
 * What it cannot reach is the action's own glue in src/commands/group.js:
 * whether real argv gets turned into changes, whether an empty invocation is
 * refused before the session is touched, and how a failure is reported. Those
 * all resolve before any network call, so they run here against a throwaway
 * HOME with no credentials.
 *
 * Unlike most commands (see tests/cli/validation.test.js), a refused or failed
 * `group settings` exits 1: a script has to be able to tell "the group's
 * settings were changed" from "nothing was sent", and the refusal paths exist
 * precisely to protect state.
 */

import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCli, errorLineOf } from "../helpers/cli.js";

const opts = { home: SANDBOX_HOME, timeout: 30_000 };
const GROUP = "9000000000000000077";

describe("group settings refuses before it needs a session", () => {
    it("no setting flag: refused with exit 1, without reaching the session", async () => {
        // Red if the empty invocation is not refused (the old command sent
        // eight OFFs here), if the guard moves after getApi() (the missing
        // session would answer first), or if the refusal exits 0.
        const r = await runCli(["group", "settings", GROUP], opts);
        assert.match(errorLineOf(r.stdout) ?? "", /nothing to change/i);
        assert.doesNotMatch(r.all, /Not logged in/, "the refusal must come before the session is touched");
        assert.equal(r.code, 1, "a refusal must exit non-zero");
    });

    it("with a flag, it gets past the guard and only then hits the missing session", async () => {
        // Proves the action turns real argv into a non-empty change: red if
        // `--join-appr` is lost on the way (it would be refused as "nothing
        // to change"), or if a failure exits 0.
        const r = await runCli(["group", "settings", GROUP, "--join-appr"], opts);
        const line = errorLineOf(r.stdout) ?? "";
        assert.doesNotMatch(line, /nothing to change/i);
        assert.match(line, /Not logged in/);
        assert.equal(r.code, 1, "a failure must exit non-zero");
    });

    it("--json: the refusal is a single JSON value on stdout", async () => {
        // Red if the refusal breaks the stdout contract in src/utils/output.js.
        const r = await runCli(["--json", "group", "settings", GROUP], opts);
        const parsed = JSON.parse(r.stdout.trim());
        assert.match(parsed.error, /nothing to change/i);
        assert.equal(r.code, 1);
    });
});
