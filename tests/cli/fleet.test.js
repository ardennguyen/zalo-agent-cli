/**
 * `zalo-agent fleet ...` through the real binary against throwaway accounts: the port table, the status
 * table and its exit code, the start/restart plans, and the generated supervisor files.
 *
 * No daemon is started here (that needs a Zalo session); `--dry-run` shows the plan, and the live run of
 * fleet start/restart/stop on the test account is recorded in docs/agent-notes.md.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { runCli, stripAnsi } from "../helpers/cli.js";

const options = { home: SANDBOX_HOME, timeout: 60_000 };
const IDS = ["501", "502", "503", "504", "505"];

const fleet = (...args) => runCli(["fleet", ...args], options);
const fleetJson = async (...args) => {
    const r = await runCli(["--json", "fleet", ...args], options);
    const text = stripAnsi(r.stdout);
    return { code: r.code, json: JSON.parse(text.slice(text.indexOf("{"))), all: r.all };
};

before(() => assertSandboxed(CONFIG_DIR));
beforeEach(() => {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
        join(CONFIG_DIR, "accounts.json"),
        JSON.stringify(IDS.map((ownId, i) => ({ ownId, name: `Shop ${i + 1}`, proxy: null, active: i === 0 }))),
    );
});

describe("fleet ports", () => {
    it("assigns a stable port to every account, from 3900", async () => {
        const { json } = await fleetJson("ports");
        assert.deepEqual(
            json.ports.map((p) => [p.accountId, p.port]),
            IDS.map((id, i) => [id, 3900 + i]),
        );
        const again = await fleetJson("ports");
        assert.deepEqual(again.json, json, "the same on the next run");
    });

    it("--base applies to a new table; a new account never moves the others", async () => {
        await fleetJson("ports", "--base", "4100");
        const accounts = JSON.parse(readFileSync(join(CONFIG_DIR, "accounts.json"), "utf8"));
        accounts.push({ ownId: "500", name: "New", proxy: null, active: false });
        writeFileSync(join(CONFIG_DIR, "accounts.json"), JSON.stringify(accounts));
        const { json } = await fleetJson("ports", "--base", "9000");
        const byId = Object.fromEntries(json.ports.map((p) => [p.accountId, p.port]));
        assert.equal(byId["501"], 4100);
        assert.equal(byId["505"], 4104);
        assert.equal(byId["500"], 4105, "the new account takes the next free port, whatever it sorts like");
    });

    it("refuses a base that is not a port, and a damaged table, without writing", async () => {
        const bad = await fleet("ports", "--base", "70000");
        assert.equal(bad.code, 1);
        assert.match(stripAnsi(bad.all), /Invalid --base/);
        writeFileSync(join(CONFIG_DIR, "fleet.json"), "{ nope");
        const damaged = await fleet("ports");
        assert.equal(damaged.code, 1);
        assert.match(stripAnsi(damaged.all), /cannot be read/);
        assert.equal(readFileSync(join(CONFIG_DIR, "fleet.json"), "utf8"), "{ nope");
    });
});

describe("fleet status", () => {
    it("one row per account, all stopped when no daemon runs, with a summary", async () => {
        const r = await fleet("status");
        assert.equal(r.code, 0, r.all);
        const text = stripAnsi(r.stdout);
        const lines = text.split("\n").filter(Boolean);
        const header = lines.findIndex((l) => /^ACCOUNT\s+NAME\s+PORT\s+STATE\s+PID\s+SOCKET/.test(l));
        assert.ok(header >= 0, "the table has its header");
        for (const id of IDS)
            assert.ok(
                lines.some((l) => l.startsWith(id) && /stopped/.test(l)),
                id,
            );
        assert.ok(lines.some((l) => /5 stopped/.test(l)));
    });

    it("does not assign ports: status only reads", async () => {
        await fleet("status");
        assert.equal(existsSync(join(CONFIG_DIR, "fleet.json")), false);
    });

    it("--json gives each account's state and a summary", async () => {
        const { json } = await fleetJson("status");
        assert.equal(json.accounts.length, 5);
        assert.deepEqual(json.summary, { stopped: 5 });
        assert.deepEqual(Object.keys(json.accounts[0]).sort(), [
            "accountId",
            "daemon",
            "health",
            "name",
            "port",
            "state",
        ]);
        assert.deepEqual(json.accounts[0].daemon, { running: false, pid: null });
    });

    it("can be limited to named accounts, and refuses one that is not registered", async () => {
        const { json } = await fleetJson("status", "502", "504");
        assert.deepEqual(
            json.accounts.map((a) => a.accountId),
            ["502", "504"],
        );
        const r = await fleet("status", "999");
        assert.equal(r.code, 1);
        assert.match(stripAnsi(r.all), /Account 999 is not registered/);
    });

    it("--check exits 1 unless every account is serving", async () => {
        assert.equal((await fleet("status", "--check")).code, 1);
        assert.equal((await fleet("status")).code, 0);
    });

    it("refuses a nonsense --down-for", async () => {
        const r = await fleet("status", "--down-for", "-5");
        assert.equal(r.code, 1);
        assert.match(stripAnsi(r.all), /Invalid --down-for/);
    });

    it("with no accounts registered it says so", async () => {
        writeFileSync(join(CONFIG_DIR, "accounts.json"), "[]");
        const r = await fleet("status");
        assert.equal(r.code, 1);
        assert.match(stripAnsi(r.all), /No accounts are registered/);
    });
});

describe("fleet start and restart: the plan", () => {
    it("start --dry-run plans every account in shuffled batches and starts nothing", async () => {
        const { json, code } = await fleetJson("start", "--dry-run", "--batch", "2", "--stagger", "0");
        assert.equal(code, 0);
        assert.equal(json.dryRun, true);
        assert.deepEqual(json.started.map((s) => s.accountId).sort(), IDS);
        assert.ok(json.started.every((s) => /would start \(mcp, port 39\d\d\)/.test(s.detail)));
        for (const id of IDS)
            assert.equal(existsSync(join(CONFIG_DIR, "accounts", id, "daemon.log")), false, "nothing was spawned");
    });

    it("start --listen plans listen daemons, which need no port", async () => {
        const { json } = await fleetJson("start", "501", "--dry-run", "--listen", "--stagger", "0");
        assert.deepEqual(
            json.started.map((s) => s.detail),
            ["would start (listen)"],
        );
    });

    it("start names its batches on stderr in --json mode, so stdout stays one document", async () => {
        const r = await runCli(["--json", "fleet", "start", "--dry-run", "--batch", "2", "--stagger", "0"], options);
        const batches = stripAnsi(r.stderr)
            .split("\n")
            .filter((l) => /batch \d\/3/.test(l));
        assert.equal(batches.length, 3, "5 accounts at 2 a batch is 3 batches");
        assert.doesNotThrow(() => JSON.parse(stripAnsi(r.stdout)));
    });

    it("refuses nonsense batch and stagger values", async () => {
        for (const args of [
            ["--batch", "0"],
            ["--batch", "101"],
            ["--batch", "x"],
            ["--stagger", "-1"],
            ["--stagger", "99999"],
        ]) {
            const r = await fleet("start", "--dry-run", ...args);
            assert.equal(r.code, 1, args.join(" "));
            assert.match(stripAnsi(r.all), /Invalid --(batch|stagger)/);
        }
    });

    it("a bare restart restarts nothing: it asks to be told which", async () => {
        const r = await fleet("restart");
        assert.equal(r.code, 1);
        assert.match(stripAnsi(r.all), /Name the accounts to restart, or pass --unhealthy or --all/);
    });

    it("restart --unhealthy leaves stopped accounts alone: nothing is down, so nothing to restart", async () => {
        const { json } = await fleetJson("restart", "--unhealthy", "--dry-run");
        assert.deepEqual(json, { restarted: [], considered: 5 });
    });

    it("restart --all --dry-run plans every account and changes nothing", async () => {
        const { json } = await fleetJson("restart", "--all", "--dry-run", "--stagger", "0");
        assert.equal(json.restarted.length, 5);
        assert.equal(json.dryRun, true);
    });

    it("restart of named accounts plans only those", async () => {
        const { json } = await fleetJson("restart", "503", "--dry-run", "--listen");
        assert.deepEqual(
            json.restarted.map((r) => [r.accountId, r.detail]),
            [["503", "would start (listen)"]],
        );
    });
});

describe("fleet stop", () => {
    it("with no daemon running it says so for each account and succeeds", async () => {
        const { json, code } = await fleetJson("stop");
        assert.equal(code, 0);
        assert.equal(json.stopped.length, 5);
        assert.ok(json.stopped.every((s) => s.stopped === false));
    });
});

describe("fleet generate", () => {
    let out;
    beforeEach(() => {
        out = mkdtempSync(join(tmpdir(), "zalo-fleetgen-"));
    });
    afterEach(() => rmSync(out, { recursive: true, force: true }));
    const gen = (...a) => fleet("generate", "--out", out, ...a);

    it("writes the unit, env files with tokens, and the port table that fleet ports shows", async () => {
        const r = await gen();
        assert.equal(r.code, 0, r.all);
        assert.ok(existsSync(join(out, "zalo-mcp@.service")));
        const ports = JSON.parse(readFileSync(join(out, "ports.json"), "utf8"));
        assert.deepEqual(ports, Object.fromEntries(IDS.map((id, i) => [id, 3900 + i])));
        for (const id of IDS) {
            const env = readFileSync(join(out, "accounts", `${id}.env`), "utf8");
            assert.match(env, new RegExp(`^ZALO_MCP_HTTP_PORT=${ports[id]}$`, "m"));
            assert.match(env, /^ZALO_MCP_AUTH_TOKEN=[0-9a-f]{64}$/m);
        }
        const { json } = await fleetJson("ports");
        assert.deepEqual(Object.fromEntries(json.ports.map((p) => [p.accountId, p.port])), ports);
    });

    it("never prints a token", async () => {
        const r = await gen();
        const tokens = IDS.map(
            (id) => /^ZALO_MCP_AUTH_TOKEN=(.+)$/m.exec(readFileSync(join(out, "accounts", `${id}.env`), "utf8"))[1],
        );
        for (const t of tokens) assert.ok(!r.all.includes(t));
        assert.match(stripAnsi(r.all), /Tokens are in accounts\/<id>\.env \(mode 600\) and are not printed here/);
    });

    it("a second run keeps everything, tokens included; --force replaces the plain files; --rotate-tokens the tokens", async () => {
        await gen();
        const tokenOf = () => readFileSync(join(out, "accounts", "501.env"), "utf8").match(/TOKEN=(.+)/)[1];
        const t1 = tokenOf();
        const second = await runCli(["--json", "fleet", "generate", "--out", out], options);
        const j2 = JSON.parse(stripAnsi(second.stdout).slice(stripAnsi(second.stdout).indexOf("{")));
        assert.deepEqual(j2.written, ["ports.json"]);
        assert.equal(tokenOf(), t1);
        await gen("--force");
        assert.equal(tokenOf(), t1, "force does not replace a token in use");
        await gen("--rotate-tokens");
        assert.notEqual(tokenOf(), t1);
    });

    it("--user/--home/--bin go into the unit; --domain adds a Caddyfile", async () => {
        await gen("--user", "bot", "--home", "/srv/bot", "--bin", "/opt/za", "--domain", "crm.example.com");
        const unit = readFileSync(join(out, "zalo-mcp@.service"), "utf8");
        assert.match(unit, /^User=bot$/m);
        assert.match(unit, /^ExecStart=\/opt\/za mcp start --account %i$/m);
        const caddy = readFileSync(join(out, "Caddyfile"), "utf8");
        assert.match(caddy, /^crm\.example\.com \{/m);
        assert.equal((caddy.match(/handle_path \/a\/50\d\//g) || []).length, 5);
    });

    it("needs --out, and a sane --base-port", async () => {
        const noOut = await fleet("generate");
        assert.equal(noOut.code, 1);
        assert.match(stripAnsi(noOut.all), /required option '--out <dir>'/);
        const bad = await gen("--base-port", "0");
        assert.equal(bad.code, 1);
        assert.deepEqual(readdirSync(out), [], "nothing was written");
    });
});

describe("fleet needs no Zalo session", () => {
    it("never logs in as the active account: it only reads files and each daemon's loopback channel", async () => {
        // A saved login for the active account, which every other command would auto-login with.
        mkdirSync(join(CONFIG_DIR, "credentials"), { recursive: true });
        writeFileSync(
            join(CONFIG_DIR, "credentials", "cred_501.json"),
            JSON.stringify({ imei: "i", cookie: {}, userAgent: "UA", language: "vi" }),
        );
        for (const args of [["status"], ["ports"], ["start", "--dry-run", "--stagger", "0"], ["stop"]]) {
            const r = await fleet(...args);
            const text = stripAnsi(r.all);
            assert.doesNotMatch(
                text,
                /Auto-login|Logged in as|session|zca-js is up to date/i,
                `fleet ${args.join(" ")}: ${text}`,
            );
        }
    });

    it("a global --account does not pin the process either: fleet acts on every account", async () => {
        const r = await runCli(["--account", "501", "fleet", "status", "502"], options);
        assert.equal(r.code, 0, r.all);
        assert.match(stripAnsi(r.stdout), /502/);
    });
});
