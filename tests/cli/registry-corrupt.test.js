/**
 * A damaged accounts.json must reach the user as a message and change nothing. It used to read as "no
 * accounts", so the next `login` replaced it with a registry of one and every other account vanished.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { runCli, stripAnsi } from "../helpers/cli.js";

const options = { home: SANDBOX_HOME, timeout: 60_000 };
const FILE = join(CONFIG_DIR, "accounts.json");

before(() => assertSandboxed(CONFIG_DIR));
beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(FILE, '[{"ownId":"101","name":"Example","proxy":null,"active":tru');
});

describe("a damaged accounts.json", () => {
    for (const args of [
        ["account", "list"],
        ["account", "switch", "101"],
        ["--account", "101", "mcp", "webhook", "status"],
    ]) {
        it(`${args.join(" ")}: says what is wrong, exits 1, and leaves the file alone`, async () => {
            const before = readFileSync(FILE, "utf8");
            const r = await runCli(args, options);
            const text = stripAnsi(r.all);
            assert.equal(r.code, 1, text);
            assert.match(text, /cannot be read as the account list/);
            assert.match(text, /left untouched/);
            assert.doesNotMatch(text, /\n\s+at .*\.js:\d+/, "a message, not a stack trace");
            assert.equal(readFileSync(FILE, "utf8"), before);
        });
    }
});
