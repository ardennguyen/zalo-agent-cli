/**
 * What the `db` group does with the encrypted message database (src/core/db-tools.js): the read-only query (what it
 * runs, what it refuses before anything is prepared, the row cap, blobs), and the copies (encrypted under the same key,
 * or decrypted), each verified, never overwriting a file, never leaving a partial one. Hidden chats: with their ids
 * given, a query and an export see none of their rows (messages, search entries, reactions, row MACs, threads,
 * conv_state, boards, sync_state keys), however the SQL is written, and the decrypted file holds no trace of them.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDbPath, getAccountDir } from "../../src/core/credentials.js";
import { closeDb, ensureSearchIndex, initDb, insertMessage, setSyncState, upsertReaction } from "../../src/core/db.js";
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

    it("returns every row when no limit is asked (past the old 1000-row default)", () => {
        const { file } = cache(1);
        const sql = "WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM c WHERE x < 1500) SELECT x FROM c";
        const all = runReadOnlyQuery(file, sql);
        assert.equal(all.rowCount, 1500);
        assert.equal(all.truncated, false);
        assert.equal(runReadOnlyQuery(file, sql, { limit: 1200 }).rowCount, 1200);
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

const SECRET = "hidden-only-secret-words";
const HID = "1000000000000000871";
const VIS = "1000000000000000872";

/** A cache with a visible and a hidden conversation, each with a message, reaction, thread row, state and board. */
function cacheWithHidden() {
    const id = freshId();
    const file = getAccountDbPath(id);
    initDb(file);
    for (const [tid, text, mid] of [
        [VIS, `${MARKER} visible`, "mv"],
        [HID, `${SECRET} hidden`, "mh"],
        [`g${HID}`, `${SECRET} prefixed`, "mg"],
    ]) {
        insertMessage({ msgId: mid, threadId: tid, senderId: "1", text, timestamp: 5, type: "text" });
        upsertReaction({ msgId: mid, threadId: tid, userId: "2", icon: "/-heart", rType: 0, timestamp: 5 });
    }
    setSyncState(`boardStale:${HID}`, "1");
    setSyncState(`boardStale:${VIS}`, "1");
    ensureSearchIndex();
    closeDb();
    const w = openDatabase(file);
    try {
        for (const [tid, name] of [
            [VIS, "Visible Name"],
            [HID, `${SECRET} Name`],
        ]) {
            w.prepare("INSERT INTO threads (threadId, type, name) VALUES (?, 'dm', ?)").run(tid, name);
            w.prepare("INSERT INTO conv_state (threadId, pinned) VALUES (?, 1)").run(tid);
            w.prepare("INSERT INTO board_items (id, threadId, title) VALUES (?, ?, ?)").run(`b${tid}`, tid, name);
        }
    } finally {
        w.close();
    }
    return { id, file, dir: getAccountDir(id) };
}

describe("hidden chats: left out of db query and db export", () => {
    before(() => assertSandboxed(CONFIG_DIR));

    // Each statement would show a hidden row if one were in the file it reads.
    const TRICKY = [
        "SELECT * FROM messages",
        "SELECT * FROM threads",
        "SELECT * FROM reactions",
        "SELECT * FROM conv_state",
        "SELECT * FROM board_items",
        "SELECT * FROM sync_state",
        "SELECT * FROM message_macs",
        "SELECT * FROM messages_fts",
        "SELECT * FROM messages_fts_content",
        "SELECT rowid, * FROM messages_fts WHERE messages_fts MATCH 'secret'",
        "SELECT r.* , m.text FROM reactions r LEFT JOIN messages m ON m.msgId = r.msgId",
        "SELECT name FROM sqlite_master WHERE type = 'table'",
        "WITH t AS (SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages') SELECT * FROM messages, t",
        "SELECT msgId, text FROM main.messages UNION ALL SELECT name, sql FROM temp.sqlite_master",
        "SELECT count(*) AS n, group_concat(text) AS all_text FROM messages WHERE text LIKE '%' || 'secret' || '%'",
    ];

    it("without the PIN: no statement reaches a hidden row; with nothing left out, they are all there", () => {
        const { file, dir } = cacheWithHidden();
        for (const sql of TRICKY) {
            const r = runReadOnlyQuery(file, sql, { excludeThreadIds: [HID] });
            const text = JSON.stringify(r.rows);
            assert.ok(!text.includes(SECRET), `${sql}: ${text}`);
            assert.ok(!text.includes(HID), `${sql}: ${text}`);
            assert.ok(!text.includes('"mh"') && !text.includes('"mg"'), `${sql}: ${text}`);
        }
        const visible = runReadOnlyQuery(file, "SELECT msgId FROM messages", { excludeThreadIds: [HID] });
        assert.deepEqual(
            visible.rows.map((x) => x.msgId),
            ["mv"],
        );
        const all = runReadOnlyQuery(file, "SELECT msgId FROM messages ORDER BY msgId");
        assert.deepEqual(
            all.rows.map((x) => x.msgId),
            ["mg", "mh", "mv"],
        );
        const fts = runReadOnlyQuery(file, "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'secret'");
        assert.equal(fts.rowCount, 2, "the search index holds them in the account's own database");
        assert.deepEqual(
            readdirSync(dir).filter((f) => f.startsWith(".db-query-")),
            [],
            "the filtered copy is removed",
        );
    });

    it("a decrypted export without the PIN holds no byte of a hidden chat; with nothing left out it does", () => {
        const { file, dir } = cacheWithHidden();
        const out = join(dir, "..", `hidden-export-${n}.db`);
        const r = copyDatabase(file, out, { plaintext: true, excludeThreadIds: [HID] });
        assert.equal(r.hiddenChats, "excluded");
        assert.equal(r.messages, 1);
        const bytes = readFileSync(out);
        assert.ok(!bytes.includes(SECRET), "no hidden text, not even in a freed page or the search index");
        assert.ok(!bytes.includes(HID), "no hidden thread id");
        assert.ok(bytes.includes(`${MARKER} visible`));
        const full = join(dir, "..", `full-export-${n}.db`);
        copyDatabase(file, full, { plaintext: true });
        assert.ok(readFileSync(full).includes(SECRET), "the test would see the text if it were there");
    });

    it("an encrypted export without the PIN opens with the account's key and has no hidden rows", () => {
        const { file, dir } = cacheWithHidden();
        const out = join(dir, "..", `hidden-enc-${n}.db`);
        const r = copyDatabase(file, out, { excludeThreadIds: [HID] });
        assert.equal(r.encrypted, true);
        const db = openDatabase(out, { readonly: true, accountDir: dir });
        try {
            assert.deepEqual(db.prepare("SELECT threadId FROM threads").all(), [{ threadId: VIS }]);
        } finally {
            db.close();
        }
    });
});
