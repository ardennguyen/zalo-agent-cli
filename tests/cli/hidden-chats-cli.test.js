/**
 * Hidden chats through the binary: `conv hidden-pin` no longer takes the PIN as an argument.
 *
 * Red if the old form `conv hidden-pin 1234` reaches the session (it would be sent, and the PIN would already sit in
 * the shell history), exits 0, or prints the PIN back.
 */
import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCli, stripAnsi } from "../helpers/cli.js";

const opts = { home: SANDBOX_HOME, timeout: 120_000 };

describe("conv hidden-pin", () => {
    it("refuses a PIN argument before any login, says how to do it now, and never echoes it", async () => {
        const r = await runCli(["conv", "hidden-pin", "8642"], opts);
        const text = stripAnsi(r.all);
        assert.equal(r.code, 1);
        assert.match(text, /no longer takes the PIN as an argument/);
        assert.match(text, /--pin-stdin/);
        assert.doesNotMatch(text, /Not logged in/, "refused before the session is touched");
        assert.doesNotMatch(text, /8642/);
    });

    it("--json: one JSON value, `error` first", async () => {
        const r = await runCli(["--json", "conv", "hidden-pin", "8642"], opts);
        assert.equal(r.code, 1);
        const parsed = JSON.parse(r.stdout.trim());
        assert.equal(Object.keys(parsed)[0], "error");
        assert.equal(parsed.pinArgumentRemoved, true);
        assert.doesNotMatch(r.stdout, /8642/);
    });
});
