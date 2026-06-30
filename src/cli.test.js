/**
 * CLI interface tests — verify command parsing, help output, and basic behavior
 * without requiring a Zalo session.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { resolve } from "path";

const CLI = resolve(import.meta.dirname, "index.js");

function run(...args) {
    return execFileSync("node", [CLI, ...args], {
        encoding: "utf-8",
        timeout: 10000,
        env: { ...process.env, HOME: "/tmp/zalo-agent-cli-test-home" },
    });
}

describe("CLI interface", () => {
    it("--version outputs 1.0.0", () => {
        const out = run("--version");
        assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
    });

    it("--help lists all command groups", () => {
        const out = run("--help");
        assert.match(out, /login/);
        assert.match(out, /msg/);
        assert.match(out, /friend/);
        assert.match(out, /group/);
        assert.match(out, /conv/);
        assert.match(out, /account/);
    });

    it("msg --help lists all subcommands", () => {
        const out = run("msg", "--help");
        assert.match(out, /send /);
        assert.match(out, /send-image/);
        assert.match(out, /send-file/);
        assert.match(out, /send-card/);
        assert.match(out, /send-bank/);
        assert.match(out, /send-qr-transfer/);
        assert.match(out, /sticker/);
        assert.match(out, /react/);
        assert.match(out, /delete/);
        assert.match(out, /forward/);
    });

    it("friend --help lists subcommands", () => {
        const out = run("friend", "--help");
        assert.match(out, /list/);
        assert.match(out, /find/);
        assert.match(out, /info/);
        assert.match(out, /block/);
    });

    it("group --help lists subcommands", () => {
        const out = run("group", "--help");
        assert.match(out, /create/);
        assert.match(out, /members/);
        assert.match(out, /rename/);
    });

    it("conv --help lists subcommands", () => {
        const out = run("conv", "--help");
        assert.match(out, /mute/);
        assert.match(out, /pinned/);
        assert.match(out, /archived/);
    });

    it("account --help lists subcommands", () => {
        const out = run("account", "--help");
        assert.match(out, /login/);
        assert.match(out, /switch/);
        assert.match(out, /export/);
        assert.match(out, /remove/);
    });

    it("login --help shows all flags", () => {
        const out = run("login", "--help");
        assert.match(out, /--proxy/);
        assert.match(out, /--credentials/);
        assert.match(out, /--qr-url/);
        assert.match(out, /--qr-port/);
    });

    it("logout --help shows --purge", () => {
        const out = run("logout", "--help");
        assert.match(out, /--purge/);
    });

    it("account list on clean state shows no accounts", () => {
        const out = run("account", "list");
        assert.match(out, /No accounts/);
    });

    it("msg --help lists search subcommand", () => {
        const out = run("msg", "--help");
        assert.match(out, /search/);
    });

    it("msg search --help shows expected flags", () => {
        const out = run("msg", "search", "--help");
        assert.match(out, /--thread/);
        assert.match(out, /--limit/);
        // --json is a global root flag (shown in root --help, not subcommand help)
        const rootOut = run("--help");
        assert.match(rootOut, /--json/);
    });

    it("conv recent --help shows --no-cache flag", () => {
        const out = run("conv", "--help");
        // conv is a parent command; subcommand help via 'conv recent --help'
        const out2 = run("conv", "recent", "--help");
        assert.match(out2, /--no-cache/);
    });

    it("msg history --help shows --no-cache flag", () => {
        const out = run("msg", "history", "--help");
        assert.match(out, /--no-cache/);
    });

    it("friend list --help shows --no-cache flag", () => {
        const out = run("friend", "list", "--help");
        assert.match(out, /--no-cache/);
    });

    it("friend search --help shows --no-cache flag", () => {
        const out = run("friend", "search", "--help");
        assert.match(out, /--no-cache/);
    });

    it("mcp --help lists start subcommand", () => {
        const out = run("mcp", "--help");
        assert.match(out, /start/);
    });
});
