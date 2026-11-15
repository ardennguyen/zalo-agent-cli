/**
 * zalo_official: the oa / zbs / social commands over MCP. It lists the CLI's own commands, builds the argv the CLI
 * parses, settles a guarded command through the server's guard before anything runs, and reports the command's JSON
 * reply or its error. The last test runs a real command in a child process, inside the sandbox.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { GUARDS } from "../../src/core/confirm-guard.js";
import {
    OFFICIAL_CLI_ONLY,
    officialArgv,
    officialCommands,
    officialMeta,
    officialTool,
} from "../../src/mcp/official-tool.js";
import { tool } from "./support/mcp-send-harness.js";
import * as commander from "commander";

const commanderOf = () => commander;

/** The real tool on the real server wiring, with a fake runner that records each argv. */
function harness(reply = { code: 0, stdout: '{"ok": true}', stderr: "" }) {
    const runs = [];
    const { tools } = tool();
    const registered = tools.get("zalo_official");
    // Re-make the handler with the fake runner, keeping the server's ok/err/gate by calling through a ctx probe.
    const ok = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
    const err = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
    const gate = async (key, target, { confirm, dryRun }) => {
        if (dryRun) return ok({ dryRun: true, action: GUARDS[key].mcp, target });
        if (confirm === true) return null;
        return {
            content: [{ type: "text", text: JSON.stringify({ confirmationRequired: true, action: GUARDS[key].mcp }) }],
            isError: true,
        };
    };
    const handler = officialTool(
        { ok, err, gate },
        {
            run: async (argv) => {
                runs.push(argv);
                return reply;
            },
        },
    );
    const call = async (args) => {
        const res = await handler(args);
        const text = res.content[0].text;
        return { isError: res.isError === true, text, body: res.isError ? null : JSON.parse(text) };
    };
    return { runs, call, registered };
}

// Every test in this file runs in the sandbox: a failing hook fails them all.
before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

describe("zalo_official", () => {
    it("is registered by registerTools, with the CLI's commands and none of the CLI-only ones", () => {
        const { registered } = harness();
        assert.ok(registered, "zalo_official is registered");
        const names = [...officialCommands().keys()];
        assert.ok(names.includes("oa msg text") && names.includes("zbs send") && names.includes("social me"));
        for (const only of Object.keys(OFFICIAL_CLI_ONLY)) assert.equal(names.includes(only), false, only);
        assert.equal(officialMeta().inputSchema.safeParse({ command: "oa login" }).success, false);
        assert.equal(officialMeta().inputSchema.safeParse({ command: "oa whoami", notAnInput: 1 }).success, false);
    });

    it("lists every command with its arguments and options when no command is given", async () => {
        const { call, runs } = harness();
        const r = await call({});
        const text = r.body.commands.find((c) => c.command === "oa msg text");
        assert.deepEqual(
            text.args.map((a) => a.name),
            ["user-id", "text"],
        );
        assert.ok(text.options.some((o) => o.name === "oa-id" && o.takes === "value" && o.default === "default"));
        assert.equal(r.body.commands.find((c) => c.command === "oa tag remove").guarded, true);
        assert.ok(!r.body.commands.some((c) => c.options.some((o) => o.name === "yes" || o.name === "dry-run")));
        assert.deepEqual(runs, [], "listing runs nothing");
    });

    it("builds the CLI's argv: options as --flag=value, then --, then the arguments", async () => {
        const { call, runs } = harness();
        const r = await call({
            command: "oa msg text",
            args: ["123", "-not a flag"],
            options: { "oa-id": "shop", quote: "m1" },
        });
        assert.equal(r.isError, false, r.text);
        assert.deepEqual(runs[0], ["oa", "msg", "text", "--oa-id=shop", "--quote=m1", "--", "123", "-not a flag"]);
        assert.deepEqual(r.body, { command: "oa msg text", result: { ok: true } });
    });

    it("takes switches, negated switches, camelCase names and list options", () => {
        const cmds = officialCommands();
        const list = officialArgv("oa follower list", cmds.get("oa follower list"), [], {
            all: true,
            followersOnly: true,
        });
        assert.deepEqual(list.argv, ["oa", "follower", "list", "--all", "--followers-only", "--"]);
        const create = officialArgv("oa article create", cmds.get("oa article create"), ["{}"], { "no-wait": true });
        assert.deepEqual(create.argv, ["oa", "article", "create", "--no-wait", "--", "{}"]);
        assert.equal(create.opts.wait, false);
        const invite = officialArgv("oa group invite", cmds.get("oa group invite"), ["g1", "u1", "u2"], {});
        assert.deepEqual(invite.positional, ["g1", ["u1", "u2"]]);
    });

    it("refuses a wrong argument count, an unknown option, and the guard's own flags", async () => {
        const { call, runs } = harness();
        for (const args of [
            { command: "oa msg text", args: ["123"] },
            { command: "oa whoami", args: ["extra"] },
            { command: "oa whoami", options: { nope: "1" } },
            { command: "oa tag remove", args: ["vip"], options: { yes: true } },
            { command: "oa follower list", options: { all: "yes" } },
            { command: "oa msg text", args: ["1", "t"], options: { quote: ["a", "b"] } },
        ]) {
            const r = await call(args);
            assert.equal(r.isError, true, JSON.stringify(args));
        }
        assert.deepEqual(runs, [], "nothing ran");
    });

    it("settles a guarded command first: refused, previewed, then run with --yes", async () => {
        const { call, runs } = harness();
        const refused = await call({ command: "oa tag remove", args: ["vip"] });
        assert.equal(refused.isError, true);
        assert.equal(JSON.parse(refused.text).action, "zalo_official oa tag remove");
        const dry = await call({ command: "oa tag remove", args: ["vip"], dryRun: true });
        assert.equal(dry.body.dryRun, true);
        assert.deepEqual(runs, [], "nothing ran before confirm");
        const done = await call({ command: "oa tag remove", args: ["vip"], confirm: true });
        assert.equal(done.isError, false, done.text);
        assert.deepEqual(runs[0], ["oa", "tag", "remove", "--yes", "--", "vip"]);
    });

    it("the argv parses back to the same values in commander, list options included", () => {
        const { Command } = commanderOf();
        let seen;
        const make = () => {
            const program = new Command();
            program
                .command("create <name> [rest...]")
                .option("--asset-id <id>")
                .option("--members <ids...>")
                .option("--all")
                .action((name, rest, opts) => (seen = { name, rest, ...opts }));
            return program;
        };
        const cmd = make().commands[0];
        const built = officialArgv("create", cmd, ["--yes", "b", "c"], {
            members: ["u1", "u2"],
            "asset-id": "-a1",
            all: true,
        });
        make().parse(built.argv, { from: "user" });
        assert.deepEqual(seen, { name: "--yes", rest: ["b", "c"], assetId: "-a1", members: ["u1", "u2"], all: true });
    });

    it("the server's real guard refuses an unconfirmed guarded command", async () => {
        const { registered } = harness();
        const res = await registered.handler({ command: "oa group delete", args: ["g1"] });
        assert.equal(res.isError, true);
        assert.equal(JSON.parse(res.content[0].text).confirmationRequired, true);
    });

    it("refuses dryRun on a command that is not guarded", async () => {
        const { call, runs } = harness();
        const r = await call({ command: "oa whoami", dryRun: true });
        assert.equal(r.isError, true);
        assert.deepEqual(runs, []);
    });

    it("every guarded official command names zalo_official as its MCP side", () => {
        for (const [path, cmd] of officialCommands()) {
            if (!cmd.zaloGuard) continue;
            assert.equal(GUARDS[cmd.zaloGuard.key].mcp, `zalo_official ${path}`, path);
        }
    });

    it("reports the command's JSON error when it fails", async () => {
        const { call } = harness({ code: 1, stdout: '{\n  "error": "OA not configured"\n}', stderr: "" });
        const r = await call({ command: "oa whoami" });
        assert.equal(r.isError, true);
        assert.match(r.text, /OA not configured/);
    });

    it("runs the real CLI in a child process", async () => {
        const handler = officialTool({
            ok: (body) => ({ body }),
            err: (text) => ({ isError: true, text }),
            gate: async () => null,
        });
        const status = await handler({ command: "social status" });
        assert.deepEqual(status.body, { command: "social status", result: { profile: "default", loggedIn: false } });
        const whoami = await handler({ command: "oa whoami" });
        assert.equal(whoami.isError, true);
        assert.match(whoami.text, /OA not configured/);
    });
});
