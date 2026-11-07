/**
 * `db`: the account's message database, which is encrypted at rest (SQLCipher, src/core/sqlite.js), for the people and
 * programs that used to open `zalo.db` themselves. The key never leaves: these read the database for them.
 *
 * - `db query <sql>`: one read-only statement, rows out (`--json` for programs). Safe beside a running daemon.
 * - `db backup --out <file>`: an encrypted, verified copy; it opens only with this account's keyring and provider.
 * - `db export --out <file>`: the same copy; with `--plaintext` decrypted, for other SQLite tools: guarded like
 *   `account export` (`--yes` to write it, `--dry-run` to preview, exit 2 without either).
 * - `db verify`: every cached message checked against its row MAC (src/core/row-mac.js); exit 1 on any finding.
 *
 * All read the local database only: no login (unless the dkey layer needs one to open the key), and none goes through
 * a daemon: a reader beside the daemon's writer is what the database's WAL is for. `db purge` (retention) joins this
 * group with its own guard.
 *
 * CLI-only: raw SQL and a decrypted copy are an operator's tools, never an agent's (tests/unit/mcp-cli-parity.test.js).
 */
import { getActive } from "../core/accounts.js";
import { guardSubcommand } from "../core/confirm-guard.js";
import { getAccountDbPath } from "../core/credentials.js";
import { closeDb, initDb, verifyMessageRows } from "../core/db.js";
import { QUERY_ROW_LIMIT, QUERY_ROW_LIMIT_MAX, copyDatabase, runReadOnlyQuery } from "../core/db-tools.js";
import { parseDateBound, parsePeriod } from "../utils/date-range.js";
import { error, info, output, success, warning } from "../utils/output.js";
import { parseIntAtLeast } from "../utils/parse-options.js";

/** The active (or `--account`) account's database path, or exit 1. */
function accountDb() {
    const account = getActive();
    if (!account) {
        error("No active account. Please login first.");
        process.exit(1);
    }
    return { ownId: account.ownId, file: getAccountDbPath(account.ownId) };
}

/** Print a failure and exit 1. */
function fail(e) {
    error(e?.message ?? String(e));
    process.exit(1);
}

/** A cell for the human table. */
function cell(v) {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "object" && v.$blob !== undefined) return `<blob ${Buffer.from(v.$blob, "base64").length} bytes>`;
    return String(v).replace(/\s+/g, " ");
}

/**
 * Register the `db` group.
 *
 * @param {import("commander").Command} program
 * @returns {import("commander").Command}
 */
export function registerDbCommands(program) {
    const db = program
        .command("db")
        .description(
            "The account's encrypted message database: read-only SQL, encrypted backup, export, integrity check",
        );

    const query = db
        .command("query <sql>")
        .description(
            "Run one read-only SQL statement on the message database (SELECT / WITH / VALUES / EXPLAIN, a few schema pragmas)",
        )
        .option(
            "-n, --limit <n>",
            `Return at most n rows (default ${QUERY_ROW_LIMIT}, at most ${QUERY_ROW_LIMIT_MAX})`,
            parseIntAtLeast(1),
            QUERY_ROW_LIMIT,
        )
        .action((sql, opts) => {
            const jsonMode = program.opts().json;
            const { file } = accountDb();
            let result;
            try {
                result = runReadOnlyQuery(file, sql, { limit: opts.limit });
            } catch (e) {
                fail(e);
            }
            output(result, jsonMode, () => {
                console.log(result.columns.join("\t"));
                for (const row of result.rows) console.log(result.columns.map((c) => cell(row[c])).join("\t"));
                info(
                    `${result.rowCount} row(s)${result.truncated ? `, cut at --limit ${opts.limit}: there are more` : ""} ` +
                        `(${result.ms} ms)`,
                );
            });
        });

    const backup = db
        .command("backup")
        .description(
            "Write an encrypted, verified copy of the message database (it opens only with this account's keyring)",
        )
        .requiredOption("-o, --out <file>", "The new file to write (never overwritten)")
        .action((opts) => {
            const jsonMode = program.opts().json;
            const { file } = accountDb();
            let r;
            try {
                r = copyDatabase(file, opts.out);
            } catch (e) {
                fail(e);
            }
            output(r, jsonMode, () => {
                success(`Wrote an encrypted copy (${r.messages} messages, ${r.bytes} bytes) to ${r.file}`);
                info(
                    "It opens only with this account's keyring.json and key provider: back those up too " +
                        "(docs/security.md, backups).",
                );
            });
        });

    const exporter = db
        .command("export")
        .description(
            "Copy the message database: encrypted like backup, or decrypted with --plaintext (asks first: --yes)",
        )
        .requiredOption("-o, --out <file>", "The new file to write (never overwritten)")
        .option(
            "--plaintext",
            "Decrypt the copy, so any SQLite tool opens it (every cached message, readable by anyone)",
        )
        .action((opts) => {
            const jsonMode = program.opts().json;
            const { file } = accountDb();
            let r;
            try {
                r = copyDatabase(file, opts.out, { plaintext: Boolean(opts.plaintext) });
            } catch (e) {
                fail(e);
            }
            output(r, jsonMode, () => {
                if (r.encrypted) {
                    success(`Wrote an encrypted copy (${r.messages} messages) to ${r.file}`);
                    info("For a copy other SQLite tools can open: --plaintext --yes.");
                } else {
                    success(`Wrote a decrypted copy (${r.messages} messages) to ${r.file}`);
                    warning("Anyone who can read that file reads every cached message: delete it when done.");
                }
            });
        });

    const verify = db
        .command("verify")
        .description("Check every cached message against its row MAC (tamper evidence); exit 1 on any finding")
        .option("-T, --thread <threadId>", "Only this conversation")
        .option("--since <date>", "Only messages on or after this date (YYYY-MM-DD, local time)")
        .option("--last <period>", "Only the last 7d, 2w, 3m, 1y (instead of --since)")
        .action((opts) => {
            const jsonMode = program.opts().json;
            const { file } = accountDb();
            let since;
            try {
                if (opts.since && opts.last) throw new Error("Use --since or --last, not both.");
                if (opts.since) since = parseDateBound(opts.since, "start");
                if (opts.last) since = parsePeriod(opts.last);
            } catch (e) {
                fail(e);
            }
            let r;
            try {
                initDb(file);
                r = verifyMessageRows({ threadId: opts.thread, since });
            } catch (e) {
                fail(e);
            } finally {
                closeDb();
            }
            const findings = r.bad + r.missing;
            output({ ...r, clean: findings === 0 }, jsonMode, () => {
                const line = `${r.checked} message(s) checked in ${(r.ms / 1000).toFixed(1)} s: ${r.ok} ok`;
                if (!findings) success(line);
                else error(`${line}, ${r.bad} changed, ${r.missing} without a MAC`);
                for (const f of r.failures) info(`  ${f.state.padEnd(7)} ${f.msgId} (thread ${f.threadId})`);
                if (findings > r.failures.length) info(`  … and ${findings - r.failures.length} more`);
                if (r.oldKey)
                    info(`${r.oldKey} row(s) still under a retired key: run \`account security rekey\` again.`);
                if (r.seal !== "sealed") warning(`The seal marker is ${r.seal}: rows without a MAC were not sealed.`);
            });
            if (findings) process.exitCode = 1;
        });

    // They read the local database only: no session needed (src/index.js preAction).
    for (const cmd of [query, backup, exporter, verify]) cmd.zaloLocalOnly = true;
    // A decrypted copy is the whole message history in the clear: --yes to write it, --dry-run to preview.
    guardSubcommand(db, "export", "db.exportPlaintext", {
        target: (opts) => ({ ownerId: getActive()?.ownId ?? null, output: opts.out }),
        when: (_target, opts) => Boolean(opts.plaintext),
    });
    return db;
}
