/**
 * `write` driven as the binary: the list needs no login, and a call that would change the account is refused without
 * --yes, before Zalo is contacted.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { runCli, stripAnsi } from "../helpers/cli.js";
import { WRITE_NAMES } from "../../src/zalo/writes.js";

const options = { home: SANDBOX_HOME, timeout: 40_000 };

describe("write", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(
            join(CONFIG_DIR, "accounts.json"),
            JSON.stringify([{ ownId: "4242", name: "Tester", active: true }]),
        );
    });

    it("lists its subcommands and its two guards", async () => {
        const r = await runCli(["write", "--help"], options);
        assert.equal(r.code, 0);
        assert.match(r.all, /list/);
        assert.match(r.all, /run/);
        const run = await runCli(["write", "run", "--help"], options);
        assert.match(run.all, /--dry-run/);
        assert.match(run.all, /--yes/);
    });

    it("lists every write as JSON with its risk, with no login", async () => {
        const r = await runCli(["--json", "write", "list"], options);
        assert.equal(r.code, 0, r.all);
        const writes = JSON.parse(stripAnsi(r.stdout));
        assert.deepEqual(
            writes.map((x) => x.name),
            WRITE_NAMES,
        );
        assert.ok(writes.every((x) => ["private", "visible", "destructive"].includes(x.risk)));
    });

    it("narrows the list by risk, and says what the colours mean", async () => {
        const narrowed = await runCli(["--json", "write", "list", "--risk", "destructive"], options);
        const some = JSON.parse(stripAnsi(narrowed.stdout));
        assert.deepEqual(
            some.map((x) => x.name),
            ["group-kickout-multi", "todo-delete", "topic-remove"],
        );
        const text = stripAnsi((await runCli(["write", "list"], options)).all);
        assert.match(text, /topic-remove/);
        assert.match(text, /destructive/);
        assert.match(text, /None has been answered by a live account/);
    });

    it("refuses to send without --yes, with the way forward, and a failing exit", async () => {
        const r = await runCli(["write", "run", "todo-delete", "--arg", "id=t1"], options);
        assert.equal(r.code, 1);
        const text = stripAnsi(r.all);
        assert.match(text, /✗/);
        assert.match(text, /destructive/);
        assert.match(text, /--dry-run/);
        assert.match(text, /--yes/);
    });

    it("refuses an unknown write, a bad argument and unparseable JSON with a message and a failing exit", async () => {
        for (const args of [
            ["write", "run", "no-such-write", "--yes"],
            ["write", "run", "todo-delete", "--yes", "--arg", "nonsense=1"],
            ["write", "run", "todo-delete", "--yes", "--args", "{not json"],
            ["write", "run", "profile-mode", "--yes", "--arg", "mode=loud"],
            ["write", "run", "topic-create", "--yes", "--arg", "groupId=1", "--arg", "type=0", "--arg", "onlyMe=maybe"],
        ]) {
            const r = await runCli(args, options);
            assert.equal(r.code, 1, args.join(" "));
            assert.match(stripAnsi(r.all), /✗/, args.join(" "));
        }
    });
});
