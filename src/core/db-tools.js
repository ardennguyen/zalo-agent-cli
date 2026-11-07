/**
 * What the `db` command group does with an account's encrypted message database (src/commands/db.js): a read-only
 * SQL query, an encrypted copy (backup, export), a decrypted copy (export --plaintext). The file stays SQLCipher
 * (src/core/sqlite.js); these are the ways a bot, a BI tool or an operator reads it without the key ever leaving.
 *
 * - {@link runReadOnlyQuery}: one statement that returns rows, on a read-only connection with `query_only=ON`, after
 *   a check of the SQL text that refuses writes, ATTACH / DETACH, any PRAGMA but a few that only describe the schema
 *   (so `PRAGMA key` / `rekey` never reach the cipher), and the functions that reach outside the database. At most
 *   `limit` rows are returned (the reply says when there were more).
 * - {@link copyDatabase}: `VACUUM INTO` a temporary file next to the target, which SQLite3MC writes encrypted under the
 *   same key (a consistent snapshot, safe beside a daemon that writes), then verified (`quick_check`, the message
 *   count) and renamed into place, created 0600. With `plaintext` the copy is decrypted in place (`PRAGMA rekey = ''`)
 *   before that, and verified again as a plain SQLite file.
 *
 * Hidden chats (src/core/hidden-chats.js) stay hidden here until the PIN is given: with `excludeThreadIds` both work on
 * a copy with every row of those threads removed ({@link stripHiddenThreads}), so no SQL text, however it is written
 * (the search tables, `sqlite_master`, joins), reaches them: they are not in the file it reads.
 *
 * Nothing here writes to the account's database: a running `listen` / `mcp start` keeps writing while it runs (WAL).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database, dbFileState, openDatabase } from "./sqlite.js";
import { ROW_MAC_TABLE } from "./row-mac.js";

/** Rows `db query` returns unless told otherwise, and the most it ever returns. */
export const QUERY_ROW_LIMIT = 1000;
export const QUERY_ROW_LIMIT_MAX = 100_000;

/** The only pragmas `db query` runs: they describe the schema and change nothing. */
const READ_PRAGMAS = new Set([
    "table_info",
    "table_xinfo",
    "table_list",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "user_version",
    "page_count",
    "page_size",
    "freelist_count",
]);

/**
 * Words that make a statement change something (a CTE can lead into a write: `WITH … DELETE`). The connection refuses
 * them too; this says why first. Transaction words are not listed: a statement here must start with a read.
 */
const WRITE_WORDS = new Set([
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "DROP",
    "ALTER",
    "VACUUM",
    "REINDEX",
    "ANALYZE",
    "ATTACH",
    "DETACH",
]);

/** Functions that reach outside the database, or into the cipher. */
const DENIED_FUNCTIONS =
    /^(load_extension|readfile|writefile|edit|fts3_tokenizer|zac_row_mac|sqlite3mc_\w*|sqlcipher_\w*)$/i;

/** A query `db query` will not run, and why. */
export class QueryRefused extends Error {
    constructor(message) {
        super(message);
        this.name = "QueryRefused";
        this.code = "QUERY_REFUSED";
    }
}

/**
 * The words of an SQL text, with string literals, quoted identifiers and comments taken out (a word inside them is
 * data, not SQL), and whether anything follows a `;`.
 *
 * @param {string} sql
 * @returns {{words: Array<{word: string, next: string}>, trailing: boolean}}
 */
function lex(sql) {
    const words = [];
    let i = 0;
    let trailing = false;
    let ended = false;
    const s = String(sql);
    while (i < s.length) {
        const c = s[i];
        if (c === "-" && s[i + 1] === "-") {
            const nl = s.indexOf("\n", i);
            i = nl < 0 ? s.length : nl + 1;
        } else if (c === "/" && s[i + 1] === "*") {
            const close = s.indexOf("*/", i + 2);
            i = close < 0 ? s.length : close + 2;
        } else if (c === "'" || c === '"' || c === "`" || c === "[") {
            const close = c === "[" ? "]" : c;
            let j = i + 1;
            for (;;) {
                const k = s.indexOf(close, j);
                if (k < 0) {
                    j = s.length;
                    break;
                }
                if (close !== "]" && s[k + 1] === close) {
                    j = k + 2; // a doubled quote is the quote itself
                    continue;
                }
                j = k + 1;
                break;
            }
            if (ended) trailing = true;
            i = j;
        } else if (c === ";") {
            ended = true;
            i++;
        } else if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
            if (ended) trailing = true;
            let k = j;
            while (k < s.length && /\s/.test(s[k])) k++;
            words.push({ word: s.slice(i, j), next: s[k] ?? "" });
            i = j;
        } else {
            if (ended && !/\s/.test(c)) trailing = true;
            i++;
        }
    }
    return { words, trailing };
}

/**
 * Refuse an SQL text `db query` must not run. Throws {@link QueryRefused}; returns nothing when it may run.
 *
 * @param {string} sql
 */
export function checkQuery(sql) {
    const { words, trailing } = lex(sql);
    if (!words.length) throw new QueryRefused("Give one SQL statement, for example: SELECT count(*) FROM messages");
    if (trailing) throw new QueryRefused("Give one statement only: there is more after the `;`.");
    const first = words[0].word.toUpperCase();
    if (first === "PRAGMA") {
        const name = words[1]?.word?.toLowerCase();
        if (!name || !READ_PRAGMAS.has(name) || words[1].next === "=" || words.length > 3) {
            throw new QueryRefused(
                `Only these pragmas run here, and only to read: ${[...READ_PRAGMAS].join(", ")}. ` +
                    "(Settings and the key are never reachable through db query.)",
            );
        }
        return;
    }
    if (!["SELECT", "WITH", "VALUES", "EXPLAIN"].includes(first)) {
        throw new QueryRefused(`db query runs a statement that reads (SELECT, WITH, VALUES, EXPLAIN), not ${first}.`);
    }
    for (const { word, next } of words) {
        const up = word.toUpperCase();
        if (WRITE_WORDS.has(up)) throw new QueryRefused(`db query only reads: ${up} is not allowed.`);
        if (up === "PRAGMA") throw new QueryRefused("db query does not take a PRAGMA inside another statement.");
        if (next === "(" && DENIED_FUNCTIONS.test(word)) {
            throw new QueryRefused(`db query does not call ${word}(): it reaches outside the database.`);
        }
    }
}

/** A value as JSON carries it: a blob as `{"$blob": "<base64>"}`, a bigint as a string. */
function jsonValue(v) {
    if (Buffer.isBuffer(v)) return { $blob: v.toString("base64") };
    if (typeof v === "bigint") return String(v);
    return v;
}

/** The forms a thread id takes: as given, and without or with Zalo's `g`/`u` list prefix. */
function threadIdForms(ids) {
    const out = new Set();
    for (const raw of ids ?? []) {
        const id = String(raw ?? "").trim();
        if (!id) continue;
        const bare = /^[gu]\d+$/i.test(id) ? id.slice(1) : id;
        for (const v of [id, bare, `g${bare}`, `u${bare}`]) out.add(v);
    }
    return [...out];
}

/**
 * Remove every row of the given threads from an open, writable database (a copy, never the account's own): their
 * messages with their search entries, row MACs and reactions, every row of any table with a `threadId` column
 * (threads, reactions, conv_state, board_items, reminders, cloud_items, and any added later), and the `sync_state`
 * keys named after them. The search index is then merged (`optimize`), so the deleted entries leave its segments too;
 * `secure_delete` zeroes the freed pages.
 *
 * @param {import("better-sqlite3-multiple-ciphers").Database} db
 * @param {Iterable<string>} threadIds
 * @returns {{threads: number}} how many thread ids were asked for
 */
export function stripHiddenThreads(db, threadIds) {
    const ids = threadIdForms(threadIds);
    if (!ids.length) return { threads: 0 };
    db.pragma("secure_delete = ON");
    const tables = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
        .all()
        .filter((t) => !t.name.startsWith("sqlite_") && !/^CREATE VIRTUAL/i.test(t.sql ?? ""))
        .map((t) => t.name);
    const has = (t) => tables.includes(t);
    const hasFts = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'").get());
    const quote = (name) => `"${name.replace(/"/g, '""')}"`;
    db.exec("CREATE TEMP TABLE IF NOT EXISTS hidden_ids (id TEXT PRIMARY KEY)");
    const add = db.prepare("INSERT OR IGNORE INTO temp.hidden_ids (id) VALUES (?)");
    const inHidden = "threadId IN (SELECT id FROM temp.hidden_ids)";
    const ofHidden = `SELECT msgId FROM messages WHERE ${inHidden}`;
    db.transaction(() => {
        for (const id of ids) add.run(id);
        if (has("messages")) {
            // What the delete triggers do, done here too: nothing may depend on them.
            if (hasFts) {
                db.exec(`DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE ${inHidden})`);
            }
            if (has(ROW_MAC_TABLE)) db.exec(`DELETE FROM ${ROW_MAC_TABLE} WHERE msgId IN (${ofHidden})`);
            if (has("reactions")) db.exec(`DELETE FROM reactions WHERE msgId IN (${ofHidden})`);
        }
        for (const t of tables) {
            const cols = db.prepare("SELECT name FROM pragma_table_info(?)").all(t);
            if (cols.some((c) => c.name === "threadId")) db.exec(`DELETE FROM ${quote(t)} WHERE ${inHidden}`);
        }
        if (has("sync_state")) {
            db.exec(
                "DELETE FROM sync_state WHERE EXISTS (SELECT 1 FROM temp.hidden_ids h WHERE key LIKE '%:' || h.id)",
            );
        }
    })();
    if (hasFts) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')");
    db.exec("DROP TABLE temp.hidden_ids");
    return { threads: new Set(ids.map((id) => (/^[gu]\d+$/i.test(id) ? id.slice(1) : id))).size };
}

/** A thread id without Zalo's `g`/`u` list prefix. */
const bareId = (id) => {
    const t = String(id ?? "").trim();
    return /^[gu]\d+$/i.test(t) ? t.slice(1) : t;
};

/** The tables an export carries besides the account's own (an import reads them; a backup has none). */
export const EXPORT_TABLES = Object.freeze(["export_info", "export_hidden_threads"]);

/**
 * Mark a copy as an export: `export_info` (format, version, when, whether hidden chats are in it) and
 * `export_hidden_threads` (one row per hidden thread the file holds, `hidden = 1`, so an import can hide them again).
 * When hidden chats were left out, the second table is empty: the file does not even say which ids were hidden. The
 * PIN and its hash are never in an export.
 *
 * @param {import("better-sqlite3-multiple-ciphers").Database} db - the copy, writable
 * @param {{hiddenIds?: string[], excluded?: boolean, now?: number}} info
 */
export function markExport(db, { hiddenIds = [], excluded = false, now = Date.now() } = {}) {
    const ids = excluded ? [] : [...new Set(hiddenIds.map(bareId).filter(Boolean))];
    db.exec(
        "CREATE TABLE IF NOT EXISTS export_info (key TEXT PRIMARY KEY, value TEXT);" +
            "CREATE TABLE IF NOT EXISTS export_hidden_threads (threadId TEXT PRIMARY KEY, " +
            "hidden INTEGER NOT NULL DEFAULT 1 CHECK (hidden IN (0, 1)))",
    );
    const info = db.prepare("INSERT OR REPLACE INTO export_info (key, value) VALUES (?, ?)");
    const mark = db.prepare("INSERT OR REPLACE INTO export_hidden_threads (threadId, hidden) VALUES (?, 1)");
    db.transaction(() => {
        info.run("format", "zalo-agent-cli/db-export");
        info.run("version", "1");
        info.run("createdAt", new Date(now).toISOString());
        info.run("hiddenChats", excluded ? "excluded" : ids.length ? "included" : "none");
        for (const id of ids) mark.run(id);
    })();
}

/** The name prefix of the filtered copies `db query` reads (next to the account's database, encrypted like it). */
const FILTERED_PREFIX = ".db-query-";

/** Remove the filtered copies a killed `db query` left behind (older than ten minutes: a running query's is younger). */
function sweepFilteredCopies(accountDir) {
    let names = [];
    try {
        names = readdirSync(accountDir);
    } catch {
        return;
    }
    for (const n of names) {
        if (!n.startsWith(FILTERED_PREFIX)) continue;
        const p = join(accountDir, n);
        try {
            if (Date.now() - statSync(p).mtimeMs > 10 * 60_000) rmSync(p, { force: true });
        } catch {
            /* gone already */
        }
    }
}

/**
 * A snapshot of the account's database with the given threads removed, written encrypted under the same key next to
 * it. The caller removes it (`drop`).
 *
 * @param {string} file
 * @param {Iterable<string>} threadIds
 * @returns {{path: string, drop: () => void}}
 */
function filteredCopy(file, threadIds) {
    const accountDir = dirname(resolve(file));
    sweepFilteredCopies(accountDir);
    const path = join(accountDir, `${FILTERED_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}.db`);
    const drop = () => {
        for (const s of ["", "-wal", "-shm", "-journal"]) rmSync(path + s, { force: true });
    };
    try {
        const src = openDatabase(file, { readonly: true });
        try {
            src.prepare("VACUUM INTO ?").run(path);
        } finally {
            src.close();
        }
        chmodSync(path, 0o600);
        const w = openDatabase(path, { accountDir });
        try {
            w.pragma("journal_mode = DELETE");
            stripHiddenThreads(w, threadIds);
        } finally {
            w.close();
        }
    } catch (e) {
        drop();
        throw e;
    }
    return { path, drop };
}

/**
 * Run one read-only statement on an account's database.
 *
 * @param {string} file - `accounts/<ownId>/zalo.db`
 * @param {string} sql
 * @param {{limit?: number, params?: Array<unknown>, excludeThreadIds?: string[]}} [opts] - `excludeThreadIds`: the
 *   hidden threads; the statement then runs on a copy without them
 * @returns {{columns: string[], rows: object[], rowCount: number, truncated: boolean, ms: number}}
 * @throws {QueryRefused} for a statement it does not run; `KeystoreError` when the key cannot be had; SqliteError for
 *   SQL that does not prepare
 */
export function runReadOnlyQuery(file, sql, { limit = QUERY_ROW_LIMIT, params = [], excludeThreadIds = [] } = {}) {
    checkQuery(sql);
    const cap = Math.min(Math.max(1, Math.floor(Number(limit) || QUERY_ROW_LIMIT)), QUERY_ROW_LIMIT_MAX);
    if (!existsSync(file)) throw new QueryRefused(`There is no message database for this account yet (${file}).`);
    const started = Date.now();
    const copy = excludeThreadIds?.length ? filteredCopy(file, excludeThreadIds) : null;
    let db;
    try {
        db = copy
            ? openDatabase(copy.path, { readonly: true, accountDir: dirname(resolve(file)) })
            : openDatabase(file, { readonly: true });
    } catch (e) {
        copy?.drop();
        throw e;
    }
    try {
        db.pragma("query_only = ON");
        let stmt;
        try {
            stmt = db.prepare(sql);
        } catch (e) {
            if (/more than one statement/i.test(e.message)) throw new QueryRefused("Give one statement only.");
            throw e;
        }
        if (!stmt.reader) throw new QueryRefused("db query runs a statement that returns rows.");
        if (!stmt.readonly) throw new QueryRefused("db query only reads.");
        const columns = stmt.columns().map((c) => c.name);
        const rows = [];
        let truncated = false;
        for (const row of stmt.iterate(...params)) {
            if (rows.length >= cap) {
                truncated = true;
                break;
            }
            rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, jsonValue(v)])));
        }
        return { columns, rows, rowCount: rows.length, truncated, ms: Date.now() - started };
    } finally {
        db.close();
        copy?.drop();
    }
}

/**
 * Copy an account's database to `out`: encrypted under the same key (a backup, which opens only with this account's
 * keyring), or with `plaintext` decrypted. Refuses to overwrite a file.
 *
 * @param {string} file - `accounts/<ownId>/zalo.db`
 * @param {string} out
 * @param {{plaintext?: boolean, excludeThreadIds?: string[], exportInfo?: {hiddenIds?: string[]}|null}} [opts] -
 *   `excludeThreadIds`: the hidden threads, left out of the copy (removed from it, then the copy is rebuilt with
 *   `VACUUM`, so no freed page keeps them); `exportInfo`: an export (not a backup) gets the `export_info` and
 *   `export_hidden_threads` tables ({@link markExport}), `hiddenIds` being the hidden threads it holds
 * @returns {{file: string, bytes: number, encrypted: boolean, keyId: string|null, messages: number, quickCheck: string,
 *   hiddenChats: "excluded"|"included"|null, hiddenThreads: number, ms: number}}
 */
export function copyDatabase(file, out, { plaintext = false, excludeThreadIds = [], exportInfo = null } = {}) {
    const target = resolve(out);
    if (!existsSync(file)) throw new Error(`There is no message database for this account yet (${file}).`);
    if (existsSync(target)) throw new Error(`${target} exists: name a new file (nothing was written).`);
    if (!existsSync(dirname(target))) throw new Error(`The folder ${dirname(target)} does not exist.`);
    const accountDir = dirname(resolve(file));
    const tmp = `${target}.partial`;
    const clean = () => {
        for (const s of ["", "-wal", "-shm", "-journal"]) rmSync(tmp + s, { force: true });
    };
    const started = Date.now();
    clean();
    try {
        const src = openDatabase(file, { readonly: true });
        let keyId;
        try {
            keyId = src.keyId;
            // A snapshot of one read transaction: a daemon may go on writing meanwhile.
            src.prepare("VACUUM INTO ?").run(tmp);
        } finally {
            src.close();
        }
        chmodSync(tmp, 0o600);
        if (excludeThreadIds?.length || exportInfo) {
            const w = openDatabase(tmp, { accountDir });
            try {
                w.pragma("journal_mode = DELETE");
                if (excludeThreadIds?.length) stripHiddenThreads(w, excludeThreadIds);
                if (exportInfo) markExport(w, { ...exportInfo, excluded: Boolean(excludeThreadIds?.length) });
                if (excludeThreadIds?.length) w.exec("VACUUM");
            } finally {
                w.close();
            }
        }
        if (plaintext) {
            const w = openDatabase(tmp, { accountDir });
            try {
                // SQLite3MC decrypts (as it encrypts) only out of WAL.
                w.pragma("journal_mode = DELETE");
                w.pragma("rekey = ''");
            } finally {
                w.close();
            }
            if (dbFileState(tmp) !== "plaintext") throw new Error("the copy did not decrypt");
        }
        const check = plaintext
            ? new Database(tmp, { readonly: true, fileMustExist: true })
            : openDatabase(tmp, { readonly: true, accountDir });
        let quickCheck;
        let messages;
        try {
            quickCheck = check.pragma("quick_check", { simple: true });
            messages = check.prepare("SELECT count(*) AS n FROM messages").get().n;
        } finally {
            check.close();
        }
        if (quickCheck !== "ok") throw new Error(`the copy failed its integrity check (${quickCheck})`);
        if (existsSync(target)) throw new Error(`${target} appeared while copying (nothing was written)`);
        renameSync(tmp, target);
        return {
            file: target,
            bytes: statSync(target).size,
            encrypted: !plaintext,
            keyId: plaintext ? null : keyId,
            messages,
            quickCheck,
            hiddenChats: excludeThreadIds?.length ? "excluded" : exportInfo?.hiddenIds?.length ? "included" : null,
            hiddenThreads: excludeThreadIds?.length ? 0 : new Set((exportInfo?.hiddenIds ?? []).map(bareId)).size,
            ms: Date.now() - started,
        };
    } catch (e) {
        clean();
        throw e;
    }
}
