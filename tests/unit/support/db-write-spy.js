/**
 * Which write statements THIS process ran against SQLite.
 *
 * Reading zalo.db back cannot answer "did the CLI write?" once a daemon in
 * another process legitimately writes the same rows: a row looks the same
 * whichever connection inserted it. So this watches the writes where they
 * happen. Every db.js writer goes through a better-sqlite3 statement's `run()`
 * (a transaction's BEGIN/COMMIT too), and `exec()` carries the schema, so
 * wrapping those two records every write this process makes -- the SQL, and
 * how many rows it changed. Another process's writes are invisible to it,
 * which is the point.
 *
 * Opening zalo.db is not free of statements: every process that calls
 * initDb() runs the same CREATE ... IF NOT EXISTS and one-off migration
 * UPDATEs, changing no row on an up-to-date database. {@link openDbStatements}
 * collects exactly those, so a test can tell "opened the db" from "wrote to it".
 *
 * Also a preload for a live check -- `NODE_OPTIONS=--import=<this file>` with
 * `ZALO_DB_WRITE_SPY=1` prints every write statement the process ran, and its
 * row count, to stderr when it exits.
 */
import Database from "better-sqlite3";

/** The prototype every better-sqlite3 statement shares. */
const STATEMENT = Object.getPrototypeOf(new Database(":memory:").prepare("SELECT 1"));

/** One-line form of a statement, for messages and set membership. */
const oneLine = (sql) => String(sql).replace(/\s+/g, " ").trim();

/**
 * Start recording this process's write statements.
 *
 * @returns {{
 *   writes: Array<{sql: string, changes: number, via: "run"|"exec"}>,
 *   clear: () => void,
 *   restore: () => void,
 * }} `writes` fills as statements run; `restore()` removes the wrappers
 */
export function spyOnDbWrites() {
    const writes = [];
    const run = STATEMENT.run;
    const exec = Database.prototype.exec;
    STATEMENT.run = function (...args) {
        const res = run.apply(this, args);
        // A reader returns rows (SELECT, a PRAGMA query); it changes nothing.
        if (!this.reader) writes.push({ sql: oneLine(this.source), changes: Number(res?.changes) || 0, via: "run" });
        return res;
    };
    Database.prototype.exec = function (sql) {
        // Recorded before it runs: initDb's ALTER TABLEs throw on a column
        // that already exists, and an attempted write is still one.
        writes.push({ sql: oneLine(sql), changes: 0, via: "exec" });
        return exec.call(this, sql);
    };
    return {
        writes,
        clear: () => {
            writes.length = 0;
        },
        restore: () => {
            STATEMENT.run = run;
            Database.prototype.exec = exec;
        },
    };
}

/**
 * The statements initDb() runs on a database that is already up to date.
 *
 * @param {object} spy - from {@link spyOnDbWrites}
 * @param {() => void} open - opens the database, e.g. `() => initDb(path)`
 * @returns {Set<string>} their one-line SQL
 */
export function openDbStatements(spy, open) {
    open(); // the first open may create tables and migrate
    spy.clear();
    open(); // the second shows what every later open runs
    const seen = new Set(spy.writes.map((w) => w.sql));
    spy.clear();
    return seen;
}

if (process.env.ZALO_DB_WRITE_SPY === "1") {
    const spy = spyOnDbWrites();
    process.on("exit", () => {
        const changed = spy.writes.filter((w) => w.changes > 0);
        const rows = changed.reduce((n, w) => n + w.changes, 0);
        console.error(
            `[db-write-spy] pid ${process.pid}: ${spy.writes.length} write statement(s), ` +
                `${changed.length} of them changed ${rows} row(s).`,
        );
        for (const w of spy.writes) console.error(`[db-write-spy]   ${w.changes} row(s)  ${w.sql.slice(0, 140)}`);
    });
}
