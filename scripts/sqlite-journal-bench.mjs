#!/usr/bin/env node
/**
 * Dev tool (not shipped): how fast SQLite commits in each journal mode on a given folder, e.g. an NFS mount.
 *
 *     node scripts/sqlite-journal-bench.mjs --dir /sagent/bulk/bench [--commits 400] [--cipher] [--json]
 *
 * For `wal`, `wal-exclusive` (WAL with locking_mode=EXCLUSIVE: its index in the process's memory, no -shm mapped) and
 * `truncate` (a rollback journal, what the engine uses on a network filesystem), it creates a fresh database in --dir,
 * commits --commits single-row transactions of a message-sized row (synchronous=NORMAL in WAL as SQLite's default for
 * it is FULL; FULL in rollback, the engine's defaults), and prints commits/s and the p50 / p99 / max commit latency.
 * `--cipher` keys each database as the engine does (SQLCipher v4 settings, a random key), so the page encryption is in
 * the numbers. It also reports what `journalModeFor` picks for --dir. Every file it made is removed.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Database, journalModeFor } from "../src/core/sqlite.js";

const { values } = parseArgs({
    options: {
        dir: { type: "string" },
        commits: { type: "string", default: "400" },
        cipher: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
    },
});
if (!values.dir) {
    console.error("usage: node scripts/sqlite-journal-bench.mjs --dir <folder> [--commits N] [--cipher] [--json]");
    process.exit(2);
}
const dir = resolve(values.dir);
const commits = Math.max(10, Number(values.commits) || 400);
mkdirSync(dir, { recursive: true });

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

/** One mode: a fresh database, `commits` single-row transactions, the timings. */
function run(mode) {
    const file = join(dir, `bench-${mode}-${process.pid}.db`);
    const clean = () => {
        for (const s of ["", "-wal", "-shm", "-journal"]) rmSync(file + s, { force: true });
    };
    clean();
    const db = new Database(file, { timeout: 5000 });
    try {
        if (values.cipher) {
            db.pragma("cipher = 'sqlcipher'");
            db.pragma("legacy = 4");
            db.pragma(`key = "x'${randomBytes(32).toString("hex")}'"`);
        }
        db.pragma("mmap_size = 0");
        db.pragma("temp_store = MEMORY");
        if (mode === "wal-exclusive") db.pragma("locking_mode = EXCLUSIVE");
        db.pragma(`journal_mode = ${mode === "truncate" ? "TRUNCATE" : "WAL"}`);
        db.exec("CREATE TABLE m (id INTEGER PRIMARY KEY, thread TEXT, body TEXT, ts INTEGER)");
        const ins = db.prepare("INSERT INTO m (thread, body, ts) VALUES (?, ?, ?)");
        const body = "x".repeat(300);
        const lat = [];
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < commits; i++) {
            const a = process.hrtime.bigint();
            ins.run(`t${i % 20}`, body, Date.now());
            lat.push(Number(process.hrtime.bigint() - a) / 1e6);
        }
        const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
        const check = db.pragma("integrity_check", { simple: true });
        const got = String(db.pragma("journal_mode", { simple: true }));
        lat.sort((x, y) => x - y);
        return {
            mode,
            journal: got,
            commits,
            perSecond: Math.round((commits / totalMs) * 1000),
            p50ms: +pct(lat, 50).toFixed(3),
            p99ms: +pct(lat, 99).toFixed(3),
            maxMs: +lat[lat.length - 1].toFixed(3),
            integrity: check,
        };
    } finally {
        db.close();
        clean();
    }
}

const results = ["wal", "wal-exclusive", "truncate"].map(run);
const out = { dir, picked: journalModeFor(dir), cipher: values.cipher, results };
if (values.json) {
    console.log(JSON.stringify(out));
} else {
    console.log(`${dir}: auto picks ${out.picked}${values.cipher ? " (SQLCipher)" : ""}`);
    for (const r of results) {
        console.log(
            `  ${r.mode.padEnd(14)} ${String(r.perSecond).padStart(6)} commits/s  p50 ${r.p50ms} ms  p99 ${r.p99ms} ms  max ${r.maxMs} ms  ${r.integrity}`,
        );
    }
}
