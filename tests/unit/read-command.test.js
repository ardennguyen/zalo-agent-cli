/**
 * `read run`'s arguments: what a person types becomes what the read declares.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { argsFromOptions, registerReadCommands } from "../../src/commands/read.js";
import { ReadUsageError } from "../../src/zalo/reads.js";

describe("argsFromOptions", () => {
    it("runs inside the test sandbox", () => assertSandboxed(CONFIG_DIR));

    it("keeps a Zalo id a string: nineteen digits are more than a number holds", () => {
        const a = argsFromOptions("profile-rank", { arg: ["id=1000000000000000001"] });
        assert.equal(a.id, "1000000000000000001");
        assert.equal(typeof a.id, "string");
    });

    it("makes a number a number, and parses a json argument", () => {
        const a = argsFromOptions("gif-search", { arg: ["keyword=cat", "limit=5", "offset=0"] });
        assert.deepEqual(a, { keyword: "cat", limit: 5, offset: 0 });
        const b = argsFromOptions("mini-profiles", { arg: ['ids=["a","b"]'] });
        assert.deepEqual(b, { ids: ["a", "b"] });
    });

    it("takes --args as a JSON object, and --arg adds to it", () => {
        const a = argsFromOptions("gif-search", { args: '{"keyword":"dog"}', arg: ["limit=3"] });
        assert.deepEqual(a, { keyword: "dog", limit: 3 });
    });

    it("keeps an equals sign inside a value", () => {
        assert.equal(argsFromOptions("gif-search", { arg: ["keyword=a=b"] }).keyword, "a=b");
    });

    it("refuses what cannot be an argument, naming the read's own", () => {
        assert.throws(() => argsFromOptions("nope", {}), ReadUsageError);
        assert.throws(() => argsFromOptions("profile-rank", { arg: ["x"] }), /not key=value/);
        assert.throws(() => argsFromOptions("profile-rank", { arg: ["=1"] }), /not key=value/);
        assert.throws(() => argsFromOptions("profile-rank", { arg: ["x=1"] }), /takes: id/);
        assert.throws(() => argsFromOptions("gif-search", { arg: ["limit=many"] }), /not a number/);
        assert.throws(() => argsFromOptions("gif-search", { arg: ["limit="] }), /not a number/);
        assert.throws(() => argsFromOptions("mini-profiles", { arg: ["ids=[1,"] }), /not JSON/);
        assert.throws(() => argsFromOptions("profile-rank", { args: "[1]" }), /JSON object/);
        assert.throws(() => argsFromOptions("profile-rank", { args: "{x" }), /not JSON/);
    });

    it("says there are no arguments for a read that takes none", () => {
        assert.throws(() => argsFromOptions("blocklist", { arg: ["z=1"] }), /takes: page, count/);
        assert.throws(() => argsFromOptions("contact-tab-last-read", { arg: ["z=1"] }), /takes: none/);
    });
});

describe("which `read` subcommands need a session", () => {
    it("`list` reads a local table and skips the login; `run` asks Zalo and does not", () => {
        const program = new Command();
        registerReadCommands(program);
        const read = program.commands.find((c) => c.name() === "read");
        const sub = (name) => read.commands.find((c) => c.name() === name);
        assert.equal(sub("list").zaloLocalOnly, true);
        assert.notEqual(sub("run").zaloLocalOnly, true);
    });
});
