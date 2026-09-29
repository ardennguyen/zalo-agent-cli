/**
 * CLI interface tests — verify command parsing, help output, and basic behavior
 * without requiring a Zalo session.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { resolve } from "path";

const CLI = resolve(import.meta.dirname, "index.js");

/**
 * Per-spawn timeout. Every assertion here boots a real `node` process, so a
 * cold start competing with other work on the machine can blow a tight limit
 * and fail a *different* `--help` test on each run — a load symptom that reads
 * exactly like a CLI regression. Generous by default; override with
 * ZALO_TEST_CLI_TIMEOUT_MS when you are genuinely chasing a hang.
 */
const SPAWN_TIMEOUT_MS = Number(process.env.ZALO_TEST_CLI_TIMEOUT_MS) || 30_000;

function run(...args) {
    try {
        return execFileSync("node", [CLI, ...args], {
            encoding: "utf-8",
            timeout: SPAWN_TIMEOUT_MS,
            env: {
                ...process.env,
                HOME: "/tmp/zalo-agent-cli-test-home",
                USERPROFILE: "/tmp/zalo-agent-cli-test-home",
                LOCALAPPDATA: "/tmp/zalo-agent-cli-test-home",
                APPDATA: "/tmp/zalo-agent-cli-test-home",
            },
        });
    } catch (e) {
        // Say which it is, so the next reader does not go hunting for a
        // regression in a command that is merely slow to start.
        if (e.code === "ETIMEDOUT") {
            throw new Error(
                `\`${args.join(" ")}\` did not finish within ${SPAWN_TIMEOUT_MS}ms. That is usually ` +
                    `machine load, not a CLI regression — re-run this file on its own, or raise ` +
                    `ZALO_TEST_CLI_TIMEOUT_MS.`,
                { cause: e },
            );
        }
        throw e;
    }
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
});
