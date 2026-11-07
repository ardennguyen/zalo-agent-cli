/**
 * What the `db` group does with the encrypted message database (src/core/db-tools.js): the read-only query (what it
 * runs, what it refuses before anything is prepared, the row cap, blobs), and the copies (encrypted under the same key,
 * or decrypted), each verified, never overwriting a file, never leaving a partial one.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDbPath, getAccountDir } from "../../src/core/credentials.js";
import { closeDb, initDb, insertMessage } from "../../src/core/db.js";
import { QueryRefused, checkQuery, copyDatabase, runReadOnlyQuery } from "../../src/core/db-tools.js";
import { Database, dbFileState, openDatabase } from "../../src/core/sqlite.js";

let n = 0;
const freshId = () => String(1000000000000000880n + BigInt(n++));
const MARKER = "plaintext-marker-for-db-tools";

/** A cache with `rows` messages for a fresh account; closed unless `keepOpen`. */
function cache(rows = 3, { keepOpen = false } = {}) {
    const id = freshId();
    const file = getAccountDbPath(id);
    initDb(file);
    for (let i = 0; i < rows; i++) {
        insertMessage({
            msgId: `m${i}`,
            threadId: "t1",
            senderId: "1",
            text: `${MARKER} ${i}`,
            timestamp: i,
            type: "text",
        });
    }
    if (!keepOpen) closeDb();
    return { id, file, dir: getAccountDir(id) };
}

describe("db query: what it runs", () => {
    before(() => assertSandboxed(CONFIG_DIR));

    for (const sql of [
        "SELECT count(*) FROM messages",
        "  select msgId from messages where text like '%attach%' -- a word in a string is data",
        "SELECT replace(text, 'a', 'b') AS t FROM messages",
        "SELECT CASE WHEN 1 THEN 'x' END",
        'SELECT "update" FROM (SELECT 1 AS "update")',
        "WITH x AS (SELECT 1 AS a) SELECT a FROM x",
        "VALUES (1), (2)",
        "EXPLAIN QUERY PLAN SELECT * FROM messages WHERE threadId = 't'",
        "PRAGMA table_info(messages)",
        "PRAGMA user_version",
        "SELECT 1; ",
        "/* comment */ SELECT 1",
    ]) {
        it(`runs: ${sql.trim()}`, () => assert.doesNotThrow(() => checkQuery(sql)));
    }
});

describe("db query: what it refuses before anything is prepared", () => {
    before(() => assertSandboxed(CONFIG_DIR));

    for (const [sql, why] of [
        ["INSERT INTO messages (msgId) VALUES ('x')", /reads/],
        ["UPDATE messages SET text = ''", /reads/],
        ["DELETE FROM messages", /reads/],
        ["WITH x AS (SELECT 1) DELETE FROM messages", /DELETE is not allowed/],
        ["ATTACH 'other.db' AS o", /reads/],
        ["SELECT 1; DROP TABLE messages", /one statement/],
        ["SELECT 1; SELECT 2", /one statement/],
        ["PRAGMA key = 'x'", /pragmas/],
        ["PRAGMA rekey = ''", /pragmas/],
        ["PRAGMA journal_mode", /pragmas/],
        ["PRAGMA journal_mode = DELETE", /pragmas/],
        ["PRAGMA user_version = 5", /pragmas/],
        ["SELECT load_extension('evil')", /load_extension/],
        ["SELECT sqlite3mc_config('cipher')", /sqlite3mc_config/],
        ["SELECT zac_row_mac(1)", /zac_row_mac/],
        ["SELECT * FROM pragma_table_info('messages') WHERE 1 AND (SELECT 1 FROM (PRAGMA key))", /PRAGMA/],
        ["VACUUM", /reads/],
        ["", /one SQL statement/],
    ]) {
        it(`refuses: ${sql || "(empty)"}`, () => {
            assert.throws(
                () => checkQuery(sql),
                (e) => e instanceof QueryRefused && e.code === "QUERY_REFUSED" && why.test(e.message),
            );
        });
    }
});

describe("db query against the encrypted database", () => {
    before(() => assertSandboxed(CONFIG_DIR));
    afterEach(() => closeDb());

    it("returns columns and rows, cut at the limit, and says so", () => {
        const { file } = cache(5);
        const all = runReadOnlyQuery(file, "SELECT msgId, text FROM messages ORDER BY msgId");
        assert.deepEqual(all.columns, ["msgId", "text"]);
        assert.equal(all.rowCount, 5);
        assert.equal(all.truncated, false);
        assert.equal(all.rows[0].text, `${MARKER} 0`);
        const cut = runReadOnlyQuery(file, "SELECT msgId FROM messages ORDER BY msgId", { limit: 2 });
        assert.deepEqual(
            cut.rows.map((r) => r.msgId),
            ["m0", "m1"],
        );
        assert.equal(cut.truncated, true);
    });

    it("hands a blob out as base64 under $blob", () => {
        const { file } = cache(1);
        const r = runReadOnlyQuery(file, "SELECT mac FROM message_macs");
        assert.equal(Buffer.from(r.rows[0].mac.$blob, "base64").length, 16);
    });

    it("reads beside a writer that has the database open (the daemon), and sees its committed rows", () => {
        const { file } = cache(2, { keepOpen: true });
        insertMessage({ msgId: "late", threadId: "t1", senderId: "1", text: "x", timestamp: 9, type: "text" });
        assert.equal(runReadOnlyQuery(file, "SELECT count(*) AS n FROM messages").rows[0].n, 3);
    });

    it("a statement the connection itself would not run fails as SQL, and changes nothing", () => {
        const { file } = cache(1);
        assert.throws(() => runReadOnlyQuery(file, "SELECT no_such_column FROM messages"), /no such column/);
        assert.throws(
            () => runReadOnlyQuery(join(getAccountDir(freshId()), "zalo.db"), "SELECT 1"),
            /no message database/,
        );
    });
});

describe("db backup / export: copies of the database", () => {
    before(() => assertSandboxed(CONFIG_DIR));
    afterEach(() => closeDb());

    it("an encrypted copy: no plaintext in it, opens only with the account's key, every message there", () => {
        const { file, dir } = cache(4);
        const out = join(dir, "..", `backup-${n}.db`);
        const r = copyDatabase(file, out);
        assert.equal(r.encrypted, true);
        assert.equal(r.messages, 4);
        assert.equal(r.quickCheck, "ok");
        assert.ok(r.keyId);
        assert.equal(dbFileState(out), "encrypted");
        assert.ok(!readFileSync(out).includes(MARKER));
        const plain = new Database(out, { readonly: true });
        try {
            assert.throws(() => plain.prepare("SELECT count(*) FROM sqlite_master").get(), /not a database/);
        } finally {
            plain.close();
        }
        const keyed = openDatabase(out, { readonly: true, accountDir: dir });
        try {
            assert.equal(keyed.prepare("SELECT count(*) AS n FROM messages").get().n, 4);
        } finally {
            keyed.close();
        }
        assert.ok(!existsSync(`${out}.partial`));
    });

    it("a decrypted copy opens in any SQLite and holds the text; the cache itself stays encrypted", () => {
        const { file, dir } = cache(2);
        const out = join(dir, "..", `export-${n}.db`);
        const r = copyDatabase(file, out, { plaintext: true });
        assert.equal(r.encrypted, false);
        assert.equal(r.keyId, null);
        assert.equal(dbFileState(out), "plaintext");
        const db = new Database(out, { readonly: true });
        try {
            assert.equal(db.prepare("SELECT text FROM messages WHERE msgId = 'm1'").get().text, `${MARKER} 1`);
        } finally {
            db.close();
        }
        assert.equal(dbFileState(file), "encrypted");
        assert.ok(!readFileSync(file).includes(MARKER));
    });

    it("never overwrites a file, and needs an existing folder", () => {
        const { file, dir } = cache(1);
        const out = join(dir, "..", `taken-${n}.db`);
        writeFileSync(out, "keep me");
        assert.throws(() => copyDatabase(file, out), /exists/);
        assert.equal(readFileSync(out, "utf8"), "keep me");
        assert.throws(() => copyDatabase(file, join(dir, "no", "such", "x.db")), /does not exist/);
    });
});
