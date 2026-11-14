/**
 * `read` driven as the binary: the list needs no login, and a bad invocation fails before Zalo is contacted.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { runCli, stripAnsi } from "../helpers/cli.js";
import { READ_NAMES } from "../../src/zalo/reads.js";

const options = { home: SANDBOX_HOME, timeout: 120_000 };

describe("read", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        // An active account with no saved login: a command that tried to sign in would say so.
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(
            join(CONFIG_DIR, "accounts.json"),
            JSON.stringify([{ ownId: "4242", name: "Tester", active: true }]),
        );
    });

    it("lists its subcommands", async () => {
        const r = await runCli(["read", "--help"], options);
        assert.equal(r.code, 0);
        assert.match(r.all, /list/);
        assert.match(r.all, /run/);
    });

    it("lists every read as JSON, with no login", async () => {
        const r = await runCli(["--json", "read", "list"], options);
        assert.equal(r.code, 0, r.all);
        const reads = JSON.parse(stripAnsi(r.stdout));
        assert.deepEqual(
            reads.map((x) => x.name),
            READ_NAMES,
        );
        assert.ok(reads.every((x) => typeof x.what === "string" && Array.isArray(x.args)));
        assert.doesNotMatch(r.all, /AutoLogin|Auto-login|login failed/i, "listing the table logs in to nothing");
    });

    it("lists only the answered reads with --verified, and says what the marks mean", async () => {
        const all = JSON.parse(stripAnsi((await runCli(["--json", "read", "list"], options)).stdout));
        const some = JSON.parse(stripAnsi((await runCli(["--json", "read", "list", "--verified"], options)).stdout));
        // Every read has been answered by a live account since the unanswered todo reads were removed, so the filter
        // keeps them all; what it must never do is keep one that was not answered.
        assert.ok(some.length > 0);
        assert.equal(some.length, all.filter((x) => x.verified).length);
        assert.ok(some.every((x) => x.verified));
        const text = stripAnsi((await runCli(["read", "list"], options)).all);
        assert.match(text, /profile-rank/);
        assert.match(text, /answered by a live account/);
    });

    it("refuses an unknown read, a bad argument and unparseable JSON with a message and a failing exit", async () => {
        for (const args of [
            ["read", "run", "no-such-read"],
            ["read", "run", "profile-rank", "--arg", "nonsense=1"],
            ["read", "run", "profile-rank", "--arg", "noequals"],
            ["read", "run", "profile-rank", "--args", "{not json"],
            ["read", "run", "gif-search", "--arg", "limit=lots", "--arg", "keyword=cat"],
        ]) {
            const r = await runCli(args, options);
            assert.equal(r.code, 1, args.join(" "));
            assert.match(stripAnsi(r.all), /✗/, args.join(" "));
        }
    });
});
