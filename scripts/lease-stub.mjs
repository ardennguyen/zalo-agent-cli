#!/usr/bin/env node
/**
 * Dev tool (not shipped: the package is the dist bundle of src/index.js): leased mode's timing and fencing with stand-in
 * daemons that never log in to Zalo, for pool rehearsals on throwaway machines.
 *
 *     node scripts/lease-stub.mjs controller --root <dir> --accounts <id,id,...>
 *     node scripts/lease-stub.mjs daemon --root <dir> --account <id>
 *     node scripts/lease-stub.mjs check --root <dir> [--json]
 *
 * `controller` is the fleet controller's real reconcile (src/core/fleet-lease.js createLeaseReconciler) over a driver
 * that runs `daemon` children instead of `zalo-mcp@<id>` units; it reads ZALO_FLEET_LEASE_FILE and writes
 * ZALO_FLEET_LEASE_STATE_FILE as `fleet serve` does. `daemon` is a daemon's real lease start (startDaemonLease: the
 * token, the fence, the 1 s guard, exit 5 on a trip) and, instead of a Zalo socket, a writer: every 100 ms one row
 * (token, holder, time) into `<root>/accounts/<id>/stub.db`, opened with the engine's journal choice, each write after
 * assertLeaseCurrent(). `check` reads every stub.db: PRAGMA integrity_check, and the tokens in write order, which never
 * go down when no stale holder wrote after a newer one (a "double client").
 *
 * `<root>` is the folder that holds `accounts/<id>/` (the shared engine home's .zalo-agent-cli in a pool).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
    LEASE_STATE_FILE_ENV,
    assertLeaseCurrent,
    createLeaseReconciler,
    leaseFileOf,
    readFence,
    readLeases,
    startDaemonLease,
    writeLeaseState,
} from "../src/core/fleet-lease.js";
import { Database, applyJournalMode } from "../src/core/sqlite.js";

const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
    args: rest,
    options: {
        root: { type: "string" },
        accounts: { type: "string" },
        account: { type: "string" },
        holder: { type: "string" },
        json: { type: "boolean", default: false },
    },
});
const root = values.root ? resolve(values.root) : null;
const holder = values.holder || hostname();
const say = (l) => console.error(`${new Date().toISOString()} [${holder}] ${l}`);
const SELF = fileURLToPath(import.meta.url);
const ID = /^[1-9][0-9]{0,30}$/;

if (!root || !["controller", "daemon", "check"].includes(cmd)) {
    console.error("usage: lease-stub.mjs controller|daemon|check --root <dir> [--accounts ids | --account id] [--json]");
    process.exit(2);
}

if (cmd === "daemon") {
    const id = values.account;
    if (!ID.test(id ?? "")) throw new Error("--account <id>");
    const dir = join(root, "accounts", id);
    mkdirSync(dir, { recursive: true });
    const lease = startDaemonLease({ ownId: id, accountDir: dir, log: say });
    if (!lease) process.exit(5);
    const file = join(dir, "stub.db");
    const db = new Database(file, { timeout: 5000 });
    applyJournalMode(db, file, { log: say });
    db.exec("CREATE TABLE IF NOT EXISTS w (seq INTEGER PRIMARY KEY, token INTEGER, holder TEXT, at INTEGER)");
    const ins = db.prepare("INSERT INTO w (token, holder, at) VALUES (?, ?, ?)");
    const token = lease.guard.token();
    lease.onRelease(() => db.close());
    say(`daemon ${id}: writing with token ${token}`);
    const timer = setInterval(() => {
        try {
            assertLeaseCurrent();
            ins.run(token, holder, Date.now());
        } catch (e) {
            say(`daemon ${id}: write refused: ${e.code ?? e.message}`);
        }
    }, 100);
    const quit = () => {
        clearInterval(timer);
        try {
            db.close();
        } catch {
            /* closed */
        }
        process.exit(0);
    };
    process.on("SIGTERM", quit);
    process.on("SIGINT", quit);
} else if (cmd === "controller") {
    const ids = String(values.accounts ?? "")
        .split(",")
        .filter((x) => ID.test(x));
    const leaseFile = leaseFileOf();
    if (!leaseFile) throw new Error("ZALO_FLEET_LEASE_FILE is not set");
    const stateFile = String(process.env[LEASE_STATE_FILE_ENV] ?? "").trim() || null;
    const kids = new Map();
    const driver = {
        kind: "stub",
        async start(id) {
            if (kids.get(id)?.exitCode === null) return { ok: true, detail: "running" };
            const child = spawn(process.execPath, [SELF, "daemon", "--root", root, "--account", id, "--holder", holder], {
                stdio: ["ignore", "inherit", "inherit"],
                env: process.env,
            });
            kids.set(id, child);
            child.on("exit", (code) => say(`daemon ${id} exited ${code}`));
            return { ok: true, detail: `spawned ${child.pid}` };
        },
        async stop(id) {
            const child = kids.get(id);
            if (!child || child.exitCode !== null) return { ok: true, detail: "not running" };
            child.kill("SIGTERM");
            const done = await Promise.race([
                new Promise((r) => child.once("exit", () => r(true))),
                new Promise((r) => setTimeout(() => r(false), 3000)),
            ]);
            if (!done) child.kill("SIGKILL");
            return { ok: true, detail: done ? "stopped" : "killed" };
        },
        async restart(id) {
            await this.stop(id);
            return this.start(id);
        },
        async status(id) {
            const child = kids.get(id);
            const running = Boolean(child && child.exitCode === null && child.signalCode === null);
            return { running, state: running ? "active" : "inactive" };
        },
    };
    const r = createLeaseReconciler({
        driver,
        listAccounts: () => ids.map((ownId) => ({ ownId })),
        readLeases: () => readLeases(leaseFile),
        writeState: stateFile ? (a) => writeLeaseState(stateFile, a) : null,
        fenceToken: (id) => readFence(join(root, "accounts", id))?.token ?? null,
        // A daemon that exits is seen at once (no status cache of 5 s for children of this process).
        refreshMs: 0,
        log: say,
    });
    say(`controller: accounts ${ids.join(",")}, leases ${leaseFile}`);
    r.start();
    // The reconcile's timer does not hold the process (in `fleet serve` the HTTP server does): without a lease yet, and so
    // without a child, this process would end after its first pass.
    const alive = setInterval(() => {}, 60_000);
    const quit = async () => {
        clearInterval(alive);
        r.stop();
        for (const id of kids.keys()) await driver.stop(id);
        process.exit(0);
    };
    process.on("SIGTERM", quit);
    process.on("SIGINT", quit);
} else {
    const base = join(root, "accounts");
    const report = [];
    let bad = 0;
    for (const id of existsSync(base) ? readdirSync(base).filter((x) => ID.test(x)) : []) {
        const file = join(base, id, "stub.db");
        if (!existsSync(file)) continue;
        const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 5000 });
        try {
            const integrity = db.pragma("integrity_check", { simple: true });
            const rows = db.prepare("SELECT seq, token, holder, at FROM w ORDER BY seq").all();
            const runs = [];
            let backwards = 0;
            for (const row of rows) {
                const last = runs[runs.length - 1];
                if (last && row.token < last.token) backwards++;
                if (last && last.token === row.token && last.holder === row.holder) {
                    last.rows++;
                    last.to = row.at;
                } else runs.push({ token: row.token, holder: row.holder, rows: 1, from: row.at, to: row.at });
            }
            const ok = integrity === "ok" && backwards === 0;
            if (!ok) bad++;
            report.push({ account: id, integrity, rows: rows.length, backwards, ok, runs });
        } finally {
            db.close();
        }
    }
    if (values.json) console.log(JSON.stringify({ ok: bad === 0, accounts: report }));
    else {
        for (const a of report) {
            console.log(`${a.account}: ${a.ok ? "ok" : "VIOLATION"} (integrity ${a.integrity}, ${a.rows} rows, ${a.backwards} back)`);
            for (const r of a.runs)
                console.log(
                    `  token ${r.token} on ${r.holder}: ${r.rows} rows ${new Date(r.from).toISOString()} .. ${new Date(r.to).toISOString()}`,
                );
        }
    }
    process.exit(bad ? 1 : 0);
}
