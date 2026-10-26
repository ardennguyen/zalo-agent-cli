/**
 * `write run`'s arguments and its guard: what a person types becomes what the write declares, and a call that changes
 * the account is not sent without --yes.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { argsFromDef } from "../../src/commands/read.js";
import { NEEDS_YES, registerWriteCommands } from "../../src/commands/write.js";
import { WRITES } from "../../src/zalo/writes.js";
import { ReadUsageError } from "../../src/zalo/reads.js";

const args = (name, opts) => argsFromDef(WRITES[name], name, opts);

describe("write arguments", () => {
    it("runs inside the test sandbox", () => assertSandboxed(CONFIG_DIR));

    it("types a boolean as true, false, 1 or 0, and refuses anything else", () => {
        for (const [raw, want] of [
            ["true", true],
            ["false", false],
            ["1", true],
            ["0", false],
        ]) {
            assert.equal(args("topic-create", { arg: [`onlyMe=${raw}`] }).onlyMe, want, raw);
        }
        assert.throws(() => args("topic-create", { arg: ["onlyMe=maybe"] }), /not true or false/);
    });

    it("keeps ids strings, makes numbers numbers, parses json", () => {
        const a = args("pin-reorder", {
            arg: ["groupId=1000000000000000001", "boardVersion=4", 'topics=["a","b"]'],
        });
        assert.deepEqual(a, { groupId: "1000000000000000001", boardVersion: 4, topics: ["a", "b"] });
        assert.throws(() => args("pin-reorder", { arg: ["boardVersion=x"] }), ReadUsageError);
        assert.throws(() => args("pin-reorder", { arg: ["nope=1"] }), /takes: groupId, topics, boardVersion/);
    });
});

describe("the write command's guards", () => {
    const sub = () => {
        const program = new Command();
        registerWriteCommands(program);
        const write = program.commands.find((c) => c.name() === "write");
        return (name) => write.commands.find((c) => c.name() === name);
    };

    it("`list` reads a local table and skips the login; `run` asks Zalo and does not", () => {
        const get = sub();
        assert.equal(get("list").zaloLocalOnly, true);
        assert.notEqual(get("run").zaloLocalOnly, true);
    });

    it("offers --dry-run and --yes, and the refusal names both", () => {
        const run = sub()("run");
        const flags = run.options.map((o) => o.long);
        assert.ok(flags.includes("--dry-run"));
        assert.ok(flags.includes("--yes"));
        assert.match(NEEDS_YES, /--dry-run/);
        assert.match(NEEDS_YES, /--yes/);
    });
});
