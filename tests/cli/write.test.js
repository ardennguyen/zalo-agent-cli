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
import { checkCli } from "../helpers/cli-fast.js";
import { WRITE_NAMES } from "../../src/zalo/writes.js";

const options = { home: SANDBOX_HOME, timeout: 120_000 };
// Commands run in the in-process CLI worker; a check that fails there is re-run as a real child process
// (tests/helpers/cli-fast.js `checkCli`), so only a real process can fail a test.
const textOf = (args, stream, check) => checkCli(args, options, (r) => check(stripAnsi(r[stream])));

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
        // A real child process: the smoke check that the worker and a real process agree.
        const r = await runCli(["write", "--help"], options);
        assert.equal(r.code, 0);
        assert.match(r.all, /list/);
        assert.match(r.all, /run/);
        await checkCli(["write", "run", "--help"], options, (run) => {
            assert.match(run.all, /--dry-run/);
            assert.match(run.all, /--yes/);
        });
    });

    it("lists every write as JSON with its risk, with no login", async () => {
        await checkCli(["--json", "write", "list"], options, (r) => {
            assert.equal(r.code, 0, r.all);
            const writes = JSON.parse(stripAnsi(r.stdout));
            assert.deepEqual(
                writes.map((x) => x.name),
                WRITE_NAMES,
            );
            assert.ok(writes.every((x) => ["private", "visible", "destructive"].includes(x.risk)));
        });
    });

    it("narrows the list by risk, and says what the colours mean", async () => {
        await checkCli(["--json", "write", "list", "--risk", "destructive"], options, async (narrowed) => {
            const some = JSON.parse(stripAnsi(narrowed.stdout));
            assert.deepEqual(
                some.map((x) => x.name),
                ["group-kickout-multi", "label-delete", "topic-remove"],
            );
            await textOf(["write", "list"], "all", (text) => {
                assert.match(text, /topic-remove/);
                assert.match(text, /destructive/);
                assert.match(text, /None has been answered by a live account/);
            });
        });
    });

    it("refuses to send without --yes, with the way forward, and exit 2 (not confirmed, not failed)", async () => {
        await checkCli(["write", "run", "topic-remove", "--arg", "groupId=g1", "--arg", "topicId=t1"], options, (r) => {
            assert.equal(r.code, 2);
            const text = stripAnsi(r.all);
            assert.match(text, /✗/);
            assert.match(text, /destructive/);
            assert.match(text, /--dry-run/);
            assert.match(text, /--yes/);
        });
    });

    it("refuses an unknown write, a bad argument and unparseable JSON with a message and a failing exit", async () => {
        for (const args of [
            ["write", "run", "no-such-write", "--yes"],
            ["write", "run", "topic-remove", "--yes", "--arg", "nonsense=1"],
            ["write", "run", "topic-remove", "--yes", "--args", "{not json"],
            [
                "write",
                "run",
                "topic-response",
                "--yes",
                "--args",
                '{"groupId":"1","eventId":"2"}',
                "--arg",
                "type=maybe",
            ],
            ["write", "run", "topic-create", "--yes", "--arg", "groupId=1", "--arg", "type=0", "--arg", "onlyMe=maybe"],
        ]) {
            await checkCli(args, options, (r) => {
                assert.equal(r.code, 1, args.join(" "));
                assert.match(stripAnsi(r.all), /✗/, args.join(" "));
            });
        }
    });
});
