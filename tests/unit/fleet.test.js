/**
 * Running many accounts (src/core/fleet.js): the port table, the one word for an account's health, the
 * shuffled start-up batches, the status table, and the files `fleet generate` writes.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    FleetError,
    STATES,
    assignPorts,
    classifyAccount,
    fleetFile,
    generateFleetFiles,
    loadPortTable,
    needsRestart,
    planBatches,
    renderStatusTable,
} from "../../src/core/fleet.js";
import {
    COMMON_ENV_TEMPLATE,
    FLEET_DEFAULTS,
    UNIT_TEMPLATE,
    renderCaddyfile,
    renderUnit,
} from "../../src/core/fleet-templates.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

beforeEach(() => {
    rmSync(SANDBOX_CONFIG_DIR, { recursive: true, force: true });
    mkdirSync(SANDBOX_CONFIG_DIR, { recursive: true });
});

const SAMPLES = join(import.meta.dirname, "..", "..", "docs", "config-samples");
const sample = (...p) => readFileSync(join(SAMPLES, ...p), "utf8");

describe("the port table", () => {
    it("starts empty and assigns from the base port, in account order", () => {
        assert.deepEqual(loadPortTable(), { basePort: 3900, ports: {} });
        const r = assignPorts(["30", "10", "20"]);
        assert.deepEqual(r.ports, { 10: 3900, 20: 3901, 30: 3902 });
        assert.deepEqual(r.added, ["10", "20", "30"]);
        assert.deepEqual(loadPortTable().ports, r.ports);
    });

    it("a port, once given, never moves; a new account takes the lowest free one", () => {
        assignPorts(["10", "20", "30"]);
        const again = assignPorts(["10", "20", "30"]);
        assert.deepEqual(again.added, []);
        const more = assignPorts(["05", "10", "20", "30", "40"]);
        assert.deepEqual(
            more.ports,
            { "05": 3903, 10: 3900, 20: 3901, 30: 3902, 40: 3904 },
            "05 sorts first but takes a free port, it moves nobody",
        );
    });

    it("a port freed by a removed account is reused", () => {
        assignPorts(["10", "20", "30"]);
        writeFileSync(fleetFile(), JSON.stringify({ version: 1, basePort: 3900, ports: { 10: 3900, 30: 3902 } }));
        assert.equal(assignPorts(["10", "30", "99"]).ports["99"], 3901);
    });

    it("the base port applies to a new table only, and is remembered", () => {
        assignPorts(["10"], { basePort: 4100 });
        assert.equal(
            assignPorts(["10", "20"], { basePort: 5000 }).ports["20"],
            4101,
            "5000 is ignored once ports exist",
        );
        assert.equal(loadPortTable().basePort, 4100);
    });

    it("refuses a table that exists but cannot be used, and leaves it untouched", () => {
        for (const content of [
            "not json",
            "[]",
            '{"ports":[]}',
            '{"ports":{"10":"x"}}',
            '{"ports":{"10":70000}}',
            '{"ports":{"10":0}}',
        ]) {
            writeFileSync(fleetFile(), content);
            assert.throws(() => assignPorts(["10"]), FleetError, content);
            assert.throws(() => loadPortTable(), FleetError, content);
            assert.equal(readFileSync(fleetFile(), "utf8"), content);
        }
    });

    it("refuses a base port that is not a port, and runs out cleanly", () => {
        assert.throws(() => assignPorts(["10"], { basePort: 70000 }), /not a port/);
        assert.throws(() => assignPorts(["10", "20"], { basePort: 65535 }), /no free port left/);
    });

    it("the file is a readable JSON document with its version", () => {
        assignPorts(["10"]);
        assert.deepEqual(JSON.parse(readFileSync(fleetFile(), "utf8")), {
            version: 1,
            basePort: 3900,
            ports: { 10: 3900 },
        });
        assert.equal(existsSync(`${fleetFile()}.lock`), false, "the lock is released");
    });
});

describe("classifyAccount", () => {
    const up = (extra = {}) => ({ socket: { state: "up", forSec: 3600 }, warnings: [], ...extra });
    it("stopped, unresponsive, down, starting, degraded, ok", () => {
        assert.equal(classifyAccount({ running: false, health: null }), "stopped");
        assert.equal(classifyAccount({ running: true, health: null }), "unresponsive");
        assert.equal(
            classifyAccount({ running: true, health: { socket: { state: "down", forSec: 400 }, warnings: [] } }),
            "down",
        );
        assert.equal(
            classifyAccount({ running: true, health: { socket: { state: "down", forSec: 20 }, warnings: [] } }),
            "starting",
            "a reconnect in progress",
        );
        assert.equal(
            classifyAccount({ running: true, health: { socket: { state: "starting", forSec: 5 }, warnings: [] } }),
            "starting",
        );
        assert.equal(classifyAccount({ running: true, health: up({ warnings: ["webhook backlog"] }) }), "degraded");
        assert.equal(classifyAccount({ running: true, health: up() }), "ok");
    });

    it("says why a socket is not up when the daemon says so: maintenance, a login being redone, another session", () => {
        for (const state of ["maintenance", "relogin", "kicked"]) {
            assert.equal(
                classifyAccount({ running: true, health: { socket: { state, forSec: 5 }, warnings: [] } }),
                state,
                `a daemon in the ${state} state is not just starting`,
            );
        }
        // A hold wins over how long it has lasted: a maintenance of three hours is still maintenance, not down.
        assert.equal(
            classifyAccount({
                running: true,
                health: { socket: { state: "maintenance", forSec: 10_800 }, warnings: [] },
            }),
            "maintenance",
        );
    });

    it("lists every state it can say, worst last, and restarts only what a restart can mend", () => {
        assert.deepEqual(
            [...STATES],
            ["ok", "degraded", "starting", "maintenance", "relogin", "kicked", "down", "unresponsive", "stopped"],
        );
        // kicked is deliberate: a restart would take the account back from the session that took it.
        assert.deepEqual(["maintenance", "relogin", "kicked"].map(needsRestart), [false, false, false]);
    });

    it("how long a socket may be down is the caller's to choose", () => {
        const h = { socket: { state: "down", forSec: 100 }, warnings: [] };
        assert.equal(classifyAccount({ running: true, health: h }, { downForSec: 60 }), "down");
        assert.equal(classifyAccount({ running: true, health: h }, { downForSec: 600 }), "starting");
    });

    it("only down and unresponsive need a restart: a backlog is the receiver's problem, not the daemon's", () => {
        assert.deepEqual(["ok", "degraded", "starting", "down", "unresponsive", "stopped"].map(needsRestart), [
            false,
            false,
            false,
            true,
            true,
            false,
        ]);
    });
});

describe("planBatches", () => {
    it("covers every item exactly once in batches of the size asked", () => {
        const items = Array.from({ length: 12 }, (_, i) => `a${i}`);
        const batches = planBatches(items, { size: 5 });
        assert.deepEqual(
            batches.map((b) => b.length),
            [5, 5, 2],
        );
        assert.deepEqual(batches.flat().sort(), [...items].sort());
    });

    it("shuffles, so accounts set up together do not start together", () => {
        const items = Array.from({ length: 30 }, (_, i) => `a${i}`);
        const a = planBatches(items, { size: 5, random: () => 0.9 });
        const b = planBatches(items, { size: 5, random: () => 0.1 });
        assert.notDeepEqual(a.flat(), items, "not left in order");
        assert.notDeepEqual(a.flat(), b.flat(), "and depends on the random source");
        assert.deepEqual(planBatches(items, { size: 5 }).flat().sort(), [...items].sort());
    });

    it("does not change its input, and copes with nothing and with an unusable size", () => {
        const items = ["a", "b", "c"];
        planBatches(items, { size: 2 });
        assert.deepEqual(items, ["a", "b", "c"]);
        assert.deepEqual(planBatches([], { size: 5 }), []);
        for (const size of [0, -3, NaN, undefined])
            assert.deepEqual(
                planBatches(items, { size })
                    .map((b) => b.length)
                    .reduce((x, y) => x + y),
                3,
            );
        assert.equal(planBatches(items, { size: 0 }).length, 3, "a size of 0 is one at a time, not an endless loop");
    });
});

describe("renderStatusTable", () => {
    const health = (o = {}) => ({
        socket: { state: "up", forSec: 7200 },
        events: { lastEventAgeSec: 42 },
        coverage: { pendingGaps: 1 },
        webhook: { pending: 3, dead: 1 },
        process: { rssBytes: 104857600 },
        ...o,
    });

    it("one row per account, aligned, with the facts that matter", () => {
        const lines = renderStatusTable([
            {
                accountId: "1001",
                name: "Shop A",
                port: 3901,
                state: "degraded",
                daemon: { running: true, pid: 4242 },
                health: health(),
            },
            {
                accountId: "1002",
                name: "",
                port: 3902,
                state: "stopped",
                daemon: { running: false, pid: null },
                health: null,
            },
        ]);
        assert.equal(lines.length, 3);
        assert.match(lines[0], /^ACCOUNT\s+NAME\s+PORT\s+STATE\s+PID\s+SOCKET\s+LAST EVENT\s+WEBHOOK\s+GAPS\s+MEM$/);
        assert.match(lines[1], /^1001\s+Shop A\s+3901\s+degraded\s+4242\s+up 2\.0h\s+42s\s+3q 1d\s+1\s+100M$/);
        assert.match(lines[2], /^1002\s+3902\s+stopped\s+-\s+-\s+-\s+-\s+-\s+-$/);
        const widths = new Set(
            lines.map((l) => (l.indexOf("STATE") >= 0 ? l.indexOf("STATE") : -1)).filter((i) => i >= 0),
        );
        assert.equal(widths.size, 1);
    });

    it("an account with no webhook says off, and ages are in the unit that reads best", () => {
        const [, row] = renderStatusTable([
            {
                accountId: "1",
                name: "x",
                port: null,
                state: "ok",
                daemon: { running: true, pid: 1 },
                health: health({
                    webhook: null,
                    events: { lastEventAgeSec: 3 * 86400 },
                    socket: { state: "up", forSec: 125 },
                }),
            },
        ]);
        assert.match(row, /off/);
        assert.match(row, /3d/);
        assert.match(row, /up 2m/);
    });
});

describe("the files fleet generate writes", () => {
    let out;
    const accounts = [
        { ownId: "1001", port: 3901 },
        { ownId: "1002", port: 3902 },
    ];
    beforeEach(() => {
        out = mkdtempSync(join(tmpdir(), "zalo-fleet-"));
    });
    afterEach(() => rmSync(out, { recursive: true, force: true }));
    const tokens = () =>
        accounts.map(
            (a) => /^ZALO_MCP_AUTH_TOKEN=(.+)$/m.exec(readFileSync(join(out, "accounts", `${a.ownId}.env`), "utf8"))[1],
        );

    it("writes the unit, the common env, one env file per account and the port table", () => {
        const r = generateFleetFiles({ outDir: out, accounts });
        assert.deepEqual(
            r.written.sort(),
            [
                join("accounts", "1001.env"),
                join("accounts", "1002.env"),
                "common.env",
                "ports.json",
                "zalo-mcp@.service",
            ].sort(),
        );
        assert.deepEqual(r.kept, []);
        assert.deepEqual(JSON.parse(readFileSync(join(out, "ports.json"), "utf8")), { 1001: 3901, 1002: 3902 });
        const env = readFileSync(join(out, "accounts", "1001.env"), "utf8");
        assert.match(env, /^ZALO_MCP_HTTP_PORT=3901$/m);
        assert.match(env, /^ZALO_MCP_HOST=127\.0\.0\.1$/m);
    });

    it("each account gets its own 256-bit token, in a file only its owner can read, and the result never carries one", () => {
        const r = generateFleetFiles({ outDir: out, accounts });
        const [a, b] = tokens();
        assert.match(a, /^[0-9a-f]{64}$/);
        assert.match(b, /^[0-9a-f]{64}$/);
        assert.notEqual(a, b);
        if (process.platform !== "win32") {
            for (const f of ["accounts/1001.env", "accounts/1002.env", "common.env"])
                assert.equal(statSync(join(out, f)).mode & 0o777, 0o600, f);
        }
        const everything =
            JSON.stringify(r) +
            readFileSync(join(out, "ports.json"), "utf8") +
            readFileSync(join(out, "zalo-mcp@.service"), "utf8");
        assert.ok(!everything.includes(a) && !everything.includes(b), "a token appears only in its own env file");
    });

    it("never overwrites what is there; a regenerated account keeps its token even with --force", () => {
        generateFleetFiles({ outDir: out, accounts });
        const before = tokens();
        writeFileSync(join(out, "common.env"), "mine\n");
        const second = generateFleetFiles({ outDir: out, accounts });
        assert.deepEqual(second.written, ["ports.json"], "only the port table, which is derived");
        assert.equal(second.kept.length, 4);
        assert.equal(readFileSync(join(out, "common.env"), "utf8"), "mine\n");
        const forced = generateFleetFiles({ outDir: out, accounts, force: true });
        assert.ok(forced.written.includes("common.env"));
        assert.deepEqual(tokens(), before, "force replaces the files that have no secret, not a token in use");
    });

    it("--rotate-tokens gives every account a new one, and only then", () => {
        generateFleetFiles({ outDir: out, accounts });
        const before = tokens();
        generateFleetFiles({ outDir: out, accounts, rotateTokens: true });
        const after = tokens();
        assert.ok(after.every((t, i) => t !== before[i]));
    });

    it("a Caddyfile is written only when a domain is given, and covers every account", () => {
        generateFleetFiles({ outDir: out, accounts });
        assert.ok(!existsSync(join(out, "Caddyfile")));
        generateFleetFiles({ outDir: out, accounts, domain: "crm.example.com" });
        const caddy = readFileSync(join(out, "Caddyfile"), "utf8");
        assert.match(caddy, /^crm\.example\.com \{/m);
        for (const a of accounts) {
            assert.match(
                caddy,
                new RegExp(`handle_path /a/${a.ownId}/\\* \\{[\\s\\S]*?reverse_proxy 127\\.0\\.0\\.1:${a.port}`),
            );
        }
        assert.equal(
            (caddy.match(/@internal path \/metrics \/status/g) || []).length,
            2,
            "each account's /metrics and /status stay inside",
        );
    });

    it("the unit takes the caller's user, home and binary, and nothing of the default is left behind", () => {
        generateFleetFiles({
            outDir: out,
            accounts,
            paths: { user: "bot", home: "/srv/bot", bin: "/opt/zalo/bin/zalo-agent" },
        });
        const unit = readFileSync(join(out, "zalo-mcp@.service"), "utf8");
        assert.match(unit, /^User=bot$/m);
        assert.match(unit, /^Group=bot$/m);
        assert.match(unit, /^WorkingDirectory=\/srv\/bot$/m);
        assert.match(unit, /^ExecStart=\/opt\/zalo\/bin\/zalo-agent mcp start --account %i$/m);
        assert.match(unit, /^ReadWritePaths=\/srv\/bot\/\.zalo-agent-cli /m);
        assert.doesNotMatch(unit, /\/home\/zalo|User=zalo|\/usr\/bin\/zalo-agent /);
    });
});

describe("the embedded templates are the documented samples", () => {
    it("the systemd unit", () => assert.equal(renderUnit(), sample("systemd", "zalo-mcp@.service")));
    it("the unit constant and the defaults agree", () => {
        assert.equal(UNIT_TEMPLATE, sample("systemd", "zalo-mcp@.service"));
        assert.equal(FLEET_DEFAULTS.user, "zalo");
    });
    it("the common env file", () => assert.equal(COMMON_ENV_TEMPLATE, sample("systemd", "common.env")));
    it("the multi-account Caddyfile", () => {
        assert.equal(
            renderCaddyfile({
                domain: "zalo.example.com",
                accounts: [
                    { ownId: "1000000000000000001", port: 3901 },
                    { ownId: "1000000000000000002", port: 3902 },
                ],
            }),
            sample("proxy", "Caddyfile.multi-account"),
        );
    });
    it("a generated account env sets exactly the variables the sample documents", () => {
        const names = (text) => [...text.matchAll(/^#?\s*(ZALO_[A-Z_]+)=/gm)].map((m) => m[1]).sort();
        const out = mkdtempSync(join(tmpdir(), "zalo-fleet-env-"));
        try {
            generateFleetFiles({ outDir: out, accounts: [{ ownId: "1001", port: 3901 }] });
            assert.deepEqual(
                names(readFileSync(join(out, "accounts", "1001.env"), "utf8")),
                names(sample("env", "account.env")),
            );
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
        assert.equal(readdirSync(SAMPLES).includes("systemd"), true);
    });
});
