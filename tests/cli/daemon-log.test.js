/**
 * The daemon log, end to end through the real binary: a process started as a daemon child
 * (ZALO_DAEMON_CHILD + ZALO_DAEMON_LOG, as `-d` does) writes its output through the level filter, the
 * timestamp or JSON format and the rotating file; and `--log-level` is checked on both daemons.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { runCli, stripAnsi } from "../helpers/cli.js";

const OWN = "401";
let logDir;
let log;

before(() => assertSandboxed(CONFIG_DIR));
beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
        join(CONFIG_DIR, "accounts.json"),
        JSON.stringify([{ ownId: OWN, name: "Example", proxy: null, active: true }]),
    );
    // The account is the name of the directory the log lives in.
    logDir = join(mkdtempSync(join(tmpdir(), "zalo-daemonlog-")), OWN);
    mkdirSync(logDir, { recursive: true });
    log = join(logDir, "daemon.log");
});

/** Run a command that prints a few lines, as a daemon child would. */
const asDaemon = (env = {}) =>
    runCli(["--account", OWN, "mcp", "webhook", "status"], {
        home: SANDBOX_HOME,
        timeout: 60_000,
        env: { ZALO_DAEMON_CHILD: "1", ZALO_DAEMON_LOG: log, ...env },
    });
const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

describe("a daemon child's log", () => {
    it("captures the output, with a timestamp on each line, instead of the terminal", async () => {
        const r = await asDaemon();
        assert.equal(r.code, 0, r.all);
        assert.equal(stripAnsi(r.stdout).trim(), "", "nothing reached stdout: it all went to the log");
        const out = lines();
        assert.ok(out.length >= 1);
        for (const l of out) assert.match(l, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, l);
        assert.ok(out.some((l) => /no webhook outbox/.test(l)));
    });

    it("what a daemon prints on stdout goes through the same filter, not around it", async () => {
        // `account list` writes its table to stdout; `mcp` commands write to stderr, which the test above covers.
        const r = await runCli(["account", "list"], {
            home: SANDBOX_HOME,
            timeout: 60_000,
            env: { ZALO_DAEMON_CHILD: "1", ZALO_DAEMON_LOG: log, ZALO_LOG_FORMAT: "json" },
        });
        assert.equal(r.code, 0, r.all);
        assert.equal(stripAnsi(r.stdout).trim(), "");
        const out = lines().map((l) => JSON.parse(l));
        assert.ok(
            out.some((o) => o.msg.includes("Example")),
            "the account table is in the log, as JSON",
        );
    });

    it("ZALO_LOG_FORMAT=json writes one JSON object per line, with the account", async () => {
        await asDaemon({ ZALO_LOG_FORMAT: "json" });
        const out = lines().map((l) => JSON.parse(l));
        assert.ok(out.length >= 1);
        for (const o of out) {
            assert.deepEqual(Object.keys(o), ["ts", "level", "account", "msg"]);
            assert.equal(o.account, OWN);
        }
        assert.ok(out.some((o) => /no webhook outbox/.test(o.msg) && o.level === "info"));
    });

    it("ZALO_LOG_LEVEL=error leaves out what is not an error, and the per-account name wins over the plain one", async () => {
        await asDaemon({ ZALO_LOG_LEVEL: "error" });
        assert.deepEqual(lines(), [], "this command prints only info and a warning");
        rmSync(log, { force: true });
        await asDaemon({ ZALO_LOG_LEVEL: "error", [`ZALO_LOG_LEVEL_${OWN}`]: "info" });
        assert.ok(lines().some((l) => /no webhook outbox/.test(l)));
    });

    it("an unusable setting is reported in the log and the default is used", async () => {
        await asDaemon({ ZALO_LOG_LEVEL: "loud" });
        const out = lines();
        assert.ok(out.some((l) => /\[logging\] log level "loud" is not one of error, warn, info, debug/.test(l)));
        assert.ok(
            out.some((l) => /no webhook outbox/.test(l)),
            "and it carried on at info",
        );
    });

    it("rotates by size through the real binary", async () => {
        writeFileSync(log, "old line\n".repeat(700)); // 6300 bytes of history
        await asDaemon({ ZALO_LOG_MAX_SIZE: "4k", ZALO_LOG_KEEP: "2" });
        assert.ok(existsSync(`${log}.1`), "the history was rotated out on the first write");
        assert.ok(readFileSync(`${log}.1`, "utf8").startsWith("old line"));
        assert.match(readFileSync(log, "utf8"), /log rotated/);
    });
});

describe("--log-level", () => {
    for (const cmd of [["mcp", "start"], ["listen"]]) {
        it(`${cmd.join(" ")} refuses a level that is not one, before doing anything`, async () => {
            const r = await runCli([...cmd, "--log-level", "loud"], { home: SANDBOX_HOME, timeout: 60_000 });
            assert.equal(r.code, 1);
            assert.match(stripAnsi(r.all), /Invalid --log-level \\?"loud\\?": use one of error, warn, info, debug/);
        });

        it(`${cmd.join(" ")} documents it`, async () => {
            const r = await runCli([...cmd, "--help"], { home: SANDBOX_HOME, timeout: 60_000 });
            const text = stripAnsi(r.all);
            assert.match(text, /--log-level <level>/);
            assert.match(text, /ZALO_LOG_LEVEL/);
        });
    }
});
