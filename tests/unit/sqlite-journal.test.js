/**
 * The journal an account database is opened with (src/core/sqlite.js `journalModeFor` / `applyJournalMode`): WAL on a
 * local disk, a rollback journal (TRUNCATE) on a network filesystem, where WAL's memory-mapped `-shm` file is SIGBUS
 * when the storage under it switches servers; `ZALO_SQLITE_JOURNAL` overrides; an existing WAL database switches on
 * open and keeps every row; one held open elsewhere stays in WAL for that open; memory mapping is off.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_DIR, getAccountDbPath } from "../../src/core/credentials.js";
import {
    NETWORK_FS_TYPES,
    SQLITE_JOURNAL_ENV,
    applyJournalMode,
    journalModeFor,
    openDatabase,
} from "../../src/core/sqlite.js";

const NFS = { type: 0x6969 };
const EXT4 = { type: 0xef53 };
const quiet = () => {};
let n = 0;
const freshDb = () => getAccountDbPath(String(1000000000000000700n + BigInt(n++)));

describe("journalModeFor", () => {
    before(() => assertSandboxed(CONFIG_DIR));

    it("auto: TRUNCATE on NFS and the other network filesystems, WAL on a local disk", () => {
        assert.equal(journalModeFor("/x", { env: {}, statfs: () => NFS }), "truncate");
        for (const type of Object.keys(NETWORK_FS_TYPES).map(Number)) {
            assert.equal(journalModeFor("/x", { env: {}, statfs: () => ({ type }) }), "truncate", String(type));
        }
        assert.equal(journalModeFor("/x", { env: {}, statfs: () => EXT4 }), "wal");
        // statfs on Linux may report the type as a bigint-sized number; the magic still matches.
        assert.equal(journalModeFor("/x", { env: {}, statfs: () => ({ type: 0xff534d42 }) }), "truncate");
    });

    it("a folder statfs cannot read counts as local", () => {
        const fail = () => {
            throw new Error("ENOSYS");
        };
        assert.equal(journalModeFor("/x", { env: {}, statfs: fail }), "wal");
    });

    it("ZALO_SQLITE_JOURNAL=wal|truncate decides whatever the filesystem; anything else is auto", () => {
        assert.equal(journalModeFor("/x", { env: { [SQLITE_JOURNAL_ENV]: "wal" }, statfs: () => NFS }), "wal");
        assert.equal(
            journalModeFor("/x", { env: { [SQLITE_JOURNAL_ENV]: " TRUNCATE " }, statfs: () => EXT4 }),
            "truncate",
        );
        assert.equal(journalModeFor("/x", { env: { [SQLITE_JOURNAL_ENV]: "auto" }, statfs: () => NFS }), "truncate");
        assert.equal(journalModeFor("/x", { env: { [SQLITE_JOURNAL_ENV]: "delete" }, statfs: () => EXT4 }), "wal");
    });
});

describe("openDatabase's journal", () => {
    const saved = process.env[SQLITE_JOURNAL_ENV];
    before(() => assertSandboxed(CONFIG_DIR));
    afterEach(() => {
        if (saved === undefined) delete process.env[SQLITE_JOURNAL_ENV];
        else process.env[SQLITE_JOURNAL_ENV] = saved;
    });

    it("a new database on a local disk is WAL with memory mapping off", () => {
        delete process.env[SQLITE_JOURNAL_ENV];
        const db = openDatabase(freshDb(), { log: quiet });
        try {
            // The sandbox lives on the machine's own temp folder: never a network filesystem.
            assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
            assert.equal(db.pragma("mmap_size", { simple: true }), 0);
        } finally {
            db.close();
        }
    });

    it("an existing WAL database switches to TRUNCATE on open, keeps its rows, leaves no -wal/-shm", () => {
        const file = freshDb();
        delete process.env[SQLITE_JOURNAL_ENV];
        let db = openDatabase(file, { log: quiet });
        db.exec("CREATE TABLE t (v TEXT)");
        const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
        for (let i = 0; i < 50; i++) ins.run(`row ${i}`);
        assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
        db.close();

        process.env[SQLITE_JOURNAL_ENV] = "truncate";
        db = openDatabase(file, { log: quiet });
        try {
            assert.equal(db.pragma("journal_mode", { simple: true }), "truncate");
            assert.equal(db.prepare("SELECT count(*) AS c FROM t").get().c, 50);
            db.prepare("INSERT INTO t (v) VALUES ('after')").run();
            assert.equal(existsSync(`${file}-wal`), false, "the WAL was checkpointed and removed");
            assert.equal(existsSync(`${file}-shm`), false, "no shared-memory file is left to map");
            assert.equal(db.pragma("quick_check", { simple: true }), "ok");
        } finally {
            db.close();
        }

        // Back to WAL (an older engine, or the opt-out on a local disk): the rows are all there.
        process.env[SQLITE_JOURNAL_ENV] = "wal";
        db = openDatabase(file, { log: quiet });
        try {
            assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
            assert.equal(db.prepare("SELECT count(*) AS c FROM t").get().c, 51);
        } finally {
            db.close();
        }
    });

    it("a WAL database another connection holds stays WAL for this open, said once", () => {
        const file = freshDb();
        delete process.env[SQLITE_JOURNAL_ENV];
        const holder = openDatabase(file, { log: quiet });
        holder.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('x')");
        const lines = [];
        const second = openDatabase(file, { log: quiet });
        try {
            const got = applyJournalMode(second, file, {
                env: { [SQLITE_JOURNAL_ENV]: "truncate" },
                log: (l) => lines.push(l),
            });
            assert.equal(got, "wal");
            assert.equal(second.pragma("journal_mode", { simple: true }), "wal");
            applyJournalMode(second, file, { env: { [SQLITE_JOURNAL_ENV]: "truncate" }, log: (l) => lines.push(l) });
            assert.equal(lines.length, 1, "said once per file");
            assert.match(lines[0], /stays in WAL/);
        } finally {
            second.close();
            holder.close();
        }
        // Alone now: the next open switches.
        process.env[SQLITE_JOURNAL_ENV] = "truncate";
        const db = openDatabase(file, { log: quiet });
        try {
            assert.equal(db.pragma("journal_mode", { simple: true }), "truncate");
        } finally {
            db.close();
        }
        assert.ok(dirname(file).startsWith(CONFIG_DIR));
    });
});
