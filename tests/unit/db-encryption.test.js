/**
 * The message database encrypted at rest (src/core/sqlite.js, src/core/db.js `initDb`): SQLCipher v4 keyed from the
 * account's data key, the one-way migration of a 2.x plaintext database (and its recovery from a crash at every
 * step), the read-only opener's refusal, and the guards that keep plaintext from leaving a handle.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, getAccountDbPath, getAccountDir } from "../../src/core/credentials.js";
import { openRawWriter } from "./support/raw-db.js";
import { Database, dbFileState, databaseState, migratePlaintextDatabase, openDatabase } from "../../src/core/sqlite.js";
import { closeDb, ensureSearchIndex, initDb, insertMessage, searchMessages, upsertThread } from "../../src/core/db.js";
import { getDataKey } from "../../src/core/keystore/index.js";
import { fullSecurityStatus, migrateStores } from "../../src/core/keystore/stores.js";

const MARKER = "plaintext-marker-zq7";
const quiet = () => {};
let n = 0;
const freshId = () => String(1000000000000000900n + BigInt(n++));

/** A populated cache for a fresh account, closed: its path. */
function populated(id, rows = 40) {
    const file = getAccountDbPath(id);
    initDb(file);
    upsertThread({ threadId: "t1", type: "dm", name: "Fake Friend", lastUpdate: 1 });
    for (let i = 0; i < rows; i++) {
        insertMessage({
            msgId: `m${i}`,
            threadId: "t1",
            senderId: "100",
            senderName: "Fake Friend",
            text: i % 2 ? `xin chào ${MARKER} ${i}` : `hello ${i}`,
            timestamp: 1000 + i,
            type: "text",
            raw_data: { cliMsgId: `c${i}` },
        });
    }
    ensureSearchIndex();
    closeDb();
    return file;
}

/** Turn an encrypted database back into a 2.x-style plaintext one (what an upgrade finds on disk). */
function toPlaintext(file) {
    const db = openDatabase(file);
    db.pragma("rekey = ''");
    db.close();
    assert.equal(dbFileState(file), "plaintext");
}

/** Every row of every table of a database file, read through a short-lived keyed handle. */
function dumpFile(file) {
    const db = openDatabase(file, { log: quiet });
    try {
        return dump(db);
    } finally {
        db.close();
    }
}

/** Every row of every table, for "nothing was lost" comparisons. */
function dump(db) {
    const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => r.name)
        .filter((t) => !t.startsWith("messages_fts"));
    // message_macs is a WITHOUT ROWID table: ordered by its key.
    const order = (t) => (t === "message_macs" ? "msgId" : "rowid");
    return Object.fromEntries(names.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY ${order(t)}`).all()]));
}

const leftovers = (file) =>
    [".encrypting", ".encrypted", ".plaintext-old", ".plaintext-old-wal", ".encrypting-journal"].filter((s) =>
        existsSync(file + s),
    );

describe("zalo.db is encrypted at rest", () => {
    before(() => assertSandboxed(CONFIG_DIR));
    afterEach(() => closeDb());

    it("a new database is created encrypted: no plaintext header, a plain reader gets 'not a database'", () => {
        const file = getAccountDbPath(freshId());
        initDb(file);
        closeDb();
        assert.equal(dbFileState(file), "encrypted");
        assert.ok(!readFileSync(file).subarray(0, 16).toString("latin1").startsWith("SQLite format 3"));
        const plain = new Database(file);
        try {
            assert.throws(
                () => plain.prepare("SELECT count(*) FROM sqlite_master").get(),
                (e) => e.code === "SQLITE_NOTADB" && /not a database/.test(e.message),
            );
        } finally {
            plain.close();
        }
    });

    it("the file and its write-ahead log hold no plaintext", () => {
        const file = getAccountDbPath(freshId());
        initDb(file);
        insertMessage({ msgId: "w1", threadId: "t", senderId: "1", text: MARKER, timestamp: 1, type: "text" });
        assert.ok(existsSync(`${file}-wal`), "the write is still in the WAL");
        assert.ok(!readFileSync(`${file}-wal`).includes(MARKER), "WAL frames are encrypted");
        closeDb();
        assert.ok(!readFileSync(file).includes(MARKER));
    });

    it("a wrong key is 'not a database'; another account's keyring is WRONG_KEY", () => {
        const file = populated(freshId(), 3);
        const raw = new Database(file);
        try {
            raw.pragma("cipher = 'sqlcipher'");
            raw.pragma("legacy = 4");
            raw.pragma(`key = "x'${randomBytes(32).toString("hex")}'"`);
            assert.throws(
                () => raw.prepare("SELECT count(*) FROM sqlite_master").get(),
                (e) => e.code === "SQLITE_NOTADB",
            );
        } finally {
            raw.close();
        }
        const other = freshId();
        initDb(getAccountDbPath(other));
        closeDb();
        const stolen = join(getAccountDir(other), "copied.db");
        copyFileSync(file, stolen);
        assert.throws(
            () => openDatabase(stolen),
            (e) => e.name === "KeystoreError" && e.code === "WRONG_KEY",
        );
    });

    it("opens with the exported key in standard SQLCipher v4 settings (the operator's escape hatch)", () => {
        const id = freshId();
        const file = populated(id, 3);
        const { key } = getDataKey(id, "sqlcipher");
        const raw = new Database(file, { readonly: true });
        try {
            raw.pragma("cipher = 'sqlcipher'");
            raw.pragma("legacy = 4");
            raw.pragma(`key = "x'${key.toString("hex")}'"`);
            assert.equal(raw.prepare("SELECT count(*) AS n FROM messages").get().n, 3);
        } finally {
            raw.close();
        }
    });

    it("migrates a populated plaintext database: every row kept, search and its index still work, plaintext gone", () => {
        const id = freshId();
        const file = populated(id);
        const before = (() => {
            const db = openDatabase(file);
            try {
                return dump(db);
            } finally {
                db.close();
            }
        })();
        toPlaintext(file);
        assert.ok(readFileSync(file).includes(MARKER), "the test really starts from plaintext");

        const logs = [];
        const res = migratePlaintextDatabase(file, { log: (l) => logs.push(l) });
        assert.equal(res.migrated, true);
        assert.equal(res.tables.messages, 40);
        assert.match(logs.join("\n"), /encrypting .*zalo\.db/);
        assert.equal(dbFileState(file), "encrypted");
        assert.ok(!readFileSync(file).includes(MARKER));
        assert.deepEqual(leftovers(file), []);
        assert.ok(!existsSync(`${file}-wal`) || !readFileSync(`${file}-wal`).includes(MARKER));
        const names = readdirSync(getAccountDir(id));
        assert.ok(!names.some((f) => /plaintext|encrypt/.test(f)), `no copy left: ${names}`);

        initDb(file);
        const after = dumpFile(file);
        assert.deepEqual(after, before);
        const hits = searchMessages({ query: MARKER, limit: 100 });
        assert.equal(hits.length, 20);
        const fts = openDatabase(file);
        try {
            assert.equal(
                fts.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?").get(`"${MARKER}"`).n,
                20,
            );
        } finally {
            fts.close();
        }
    });

    it("initDb migrates a plaintext database on its first open", () => {
        const file = populated(freshId(), 5);
        toPlaintext(file);
        const errs = [];
        const orig = console.error;
        console.error = (...a) => errs.push(a.join(" "));
        try {
            initDb(file);
        } finally {
            console.error = orig;
        }
        assert.equal(dbFileState(file), "encrypted");
        assert.match(errs.join("\n"), /is encrypted/);
        closeDb();
    });

    for (const step of ["afterCopy", "afterEncrypt", "afterVerify", "afterMoveAside", "afterSwap"]) {
        it(`a migration that crashes ${step.replace("after", "after the ").toLowerCase()} leaves one readable database, finished on the next open`, () => {
            const file = populated(freshId(), 12);
            const want = dumpFile(file);
            toPlaintext(file);
            assert.throws(
                () =>
                    migratePlaintextDatabase(file, {
                        log: quiet,
                        hooks: {
                            [step]: () => {
                                throw new Error("simulated crash");
                            },
                        },
                    }),
                /simulated crash/,
            );
            const db = openDatabase(file, { log: quiet });
            try {
                assert.deepEqual(dump(db), want);
            } finally {
                db.close();
            }
            assert.equal(dbFileState(file), "encrypted");
            assert.deepEqual(leftovers(file), []);
            assert.ok(!readFileSync(file).includes(MARKER));
        });
    }

    it("refuses to migrate while another process holds daemon.lock, and changes nothing", () => {
        const id = freshId();
        const file = populated(id, 2);
        toPlaintext(file);
        const before = readFileSync(file);
        // The test runner that spawned this file is alive and is not this process.
        writeFileSync(join(getAccountDir(id), "daemon.lock"), String(process.ppid));
        assert.throws(
            () => initDb(file),
            (e) => e.code === "IN_USE" && e.message.includes(String(process.ppid)),
        );
        assert.equal(dbFileState(file), "plaintext");
        assert.deepEqual(readFileSync(file), before);
        assert.deepEqual(leftovers(file), []);
    });

    it("a read-only opener never migrates: a plaintext database is a clear PLAINTEXT error", () => {
        const file = populated(freshId(), 2);
        toPlaintext(file);
        assert.throws(
            () => openDatabase(file, { readonly: true }),
            (e) => e.name === "KeystoreError" && e.code === "PLAINTEXT" && /account security migrate/.test(e.message),
        );
        assert.equal(dbFileState(file), "plaintext");
        // A writer encrypts it; then the read-only opener reads it, and only reads.
        openDatabase(file, { log: quiet }).close();
        const again = openDatabase(file, { readonly: true });
        try {
            assert.equal(again.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
            assert.throws(() => again.prepare("DELETE FROM messages").run(), /readonly/);
        } finally {
            again.close();
        }
    });

    it("a read-only opener of an encrypted database without its keyring says so (and makes none)", () => {
        const file = populated(freshId(), 1);
        const dir = join(CONFIG_DIR, "no-keyring", "acct");
        mkdirSync(dir, { recursive: true });
        copyFileSync(file, join(dir, "zalo.db"));
        assert.throws(
            () => openDatabase(join(dir, "zalo.db"), { readonly: true }),
            (e) => e.code === "NO_KEYRING",
        );
        assert.ok(!existsSync(join(dir, "keyring.json")));
    });

    it("serialize() is disabled: it would hand out the database decrypted", () => {
        const db = openDatabase(getAccountDbPath(freshId()));
        try {
            assert.throws(() => db.serialize(), /disabled/);
        } finally {
            db.close();
        }
    });

    it("account security status and migrate list the database", () => {
        const id = freshId();
        const file = populated(id, 2);
        let row = fullSecurityStatus(id).files.find((f) => f.kind === "message-database");
        assert.equal(row.state, "encrypted");
        assert.equal(row.currentKey, true);
        assert.equal(row.key, "data");
        toPlaintext(file);
        const s = fullSecurityStatus(id);
        row = s.files.find((f) => f.kind === "message-database");
        assert.equal(row.state, "plaintext");
        assert.ok(s.plaintextFiles >= 1);
        const res = migrateStores(id, { log: quiet }).find((r) => r.kind === "message-database");
        assert.equal(res.result, "encrypted");
        assert.equal(migrateStores(id).find((r) => r.kind === "message-database").result, "already-encrypted");
        assert.equal(databaseState(file).state, "encrypted");
        assert.equal(migrateStores(freshId())[0].result, "absent");
    });
});

describe("the repairs initDb runs on every open", () => {
    afterEach(() => closeDb());

    it("still heal a 1-1 marked as a group, and leave a real group alone", () => {
        const file = getAccountDbPath(freshId());
        initDb(file);
        upsertThread({ threadId: "1000000000000000101", type: "group", name: "Really a DM", lastUpdate: 1 });
        upsertThread({ threadId: "1000000000000000102", type: "group", name: "A group", lastUpdate: 1 });
        const base = { senderName: "x", text: "hi", timestamp: 5, type: "text" };
        insertMessage({ ...base, msgId: "h1", threadId: "1000000000000000101", senderId: "1000000000000000101" });
        insertMessage({ ...base, msgId: "h2", threadId: "1000000000000000102", senderId: "1000000000000000103" });
        // The group's id sent only a system line: no proof of a 1-1.
        insertMessage({
            ...base,
            msgId: "ge:h3",
            threadId: "1000000000000000102",
            senderId: "1000000000000000102",
            type: "group_event",
        });
        // upsertThread's sticky rule may not demote: write the bad state the repair is for, directly.
        const raw = openDatabase(file);
        raw.prepare("UPDATE threads SET type = 'group' WHERE threadId = ?").run("1000000000000000101");
        raw.close();
        closeDb();
        initDb(file);
        const check = openDatabase(file);
        try {
            const type = (id) => check.prepare("SELECT type FROM threads WHERE threadId = ?").get(id).type;
            assert.equal(type("1000000000000000101"), "dm");
            assert.equal(type("1000000000000000102"), "group");
        } finally {
            check.close();
        }
    });

    it("read no message table in full: every statement initDb prepares is answered by an index", () => {
        // A full scan of an encrypted cache decrypts every page (about 0.7 s per 100,000 messages), and initDb runs
        // on every command. Capture what it really prepares, then ask SQLite how it would run each one.
        const file = getAccountDbPath(freshId());
        initDb(file);
        closeDb();
        const seen = [];
        const prepare = Database.prototype.prepare;
        Database.prototype.prepare = function (sql) {
            seen.push(sql);
            return prepare.call(this, sql);
        };
        try {
            initDb(file);
        } finally {
            Database.prototype.prepare = prepare;
        }
        const touching = seen.filter((q) => /\bmessages\b/.test(q));
        assert.ok(touching.length >= 4, `the four repairs are seen: ${touching.length}`);
        // Keyed like initDb's, with the row-MAC function: the repairs fire its triggers.
        const db = openRawWriter(file);
        try {
            for (const q of touching) {
                const plan = db
                    .prepare(`EXPLAIN QUERY PLAN ${q}`)
                    .all()
                    .map((r) => r.detail)
                    .join(" | ");
                assert.doesNotMatch(plan, /SCAN (messages|m)(?! USING)/, `${q}\n=> ${plan}`);
            }
        } finally {
            db.close();
        }
    });
});

describe("guards in src/", () => {
    const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
    const files = [];
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) walk(join(d, e.name));
            else if (e.name.endsWith(".js")) files.push(join(d, e.name));
        }
    };
    walk(SRC);

    it("nothing calls serialize() or backup() on a database (both hand out or write the data around the cipher)", () => {
        const bad = files
            .filter((f) => /\.(serialize|backup)\s*\(/.test(readFileSync(f, "utf8")))
            .map((f) => relative(SRC, f));
        assert.deepEqual(bad, []);
    });

    it("only src/core/sqlite.js imports the SQLite driver", () => {
        const bad = files
            .filter((f) =>
                /from\s+["']better-sqlite3(-multiple-ciphers)?["']|require\(["']better-sqlite3/.test(
                    readFileSync(f, "utf8"),
                ),
            )
            .map((f) => relative(SRC, f).replace(/\\/g, "/"));
        assert.deepEqual(bad, ["core/sqlite.js"]);
    });
});
