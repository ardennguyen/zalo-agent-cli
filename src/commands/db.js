/**
 * `db`: the account's message database, which is encrypted at rest (SQLCipher, src/core/sqlite.js), for the people and
 * programs that used to open `zalo.db` themselves. The key never leaves: these read the database for them.
 *
 * - `db query <sql>`: one read-only statement, rows out (`--json` for programs). Safe beside a running daemon.
 * - Hidden chats stay hidden: `query` and `export` work on a copy without them unless `--include-hidden` and the
 *   hidden-chat PIN (asked at a prompt that does not echo, or `--pin-stdin`; checked as `conv hidden` checks it, with
 *   its lockout). `backup` keeps them: it is the account's restore image, encrypted under its key, and opens only
 *   through these commands, which leave them out again.
 * - `db backup --out <file>`: an encrypted, verified copy; it opens only with this account's keyring and provider.
 * - `db export --out <file>`: the same copy; with `--password` (a prompt) or `--password-stdin` encrypted under a
 *   password the person chooses (src/core/export-crypt.js: it opens anywhere with that password, no keyring); with
 *   `--plaintext` decrypted, for other SQLite tools: guarded like `account export` (`--yes` to write it, `--dry-run`
 *   to preview, exit 2 without either). An export marks the hidden chats it holds (`export_hidden_threads`).
 * - `db verify`: every cached message checked against its row MAC (src/core/row-mac.js); exit 1 on any finding.
 *
 * - `db usage`: the account's storage (database, media, outbox), its quota and retention rules, and the quota state.
 * - `db purge`: the quota/retention purge (src/core/storage-quota.js), delete-only: `--dry-run` counts, `--yes` runs
 *   it, exit 2 without either. Run by the daemon that holds the account (over its channel) when one runs, else here
 *   under daemon.lock: one writer.
 *
 * The others read the local database only: no login (unless the dkey layer needs one to open the key), and none goes
 * through a daemon: a reader beside the daemon's writer is what the database's WAL is for.
 *
 * CLI-only: raw SQL and a decrypted copy are an operator's tools, never an agent's (tests/unit/mcp-cli-parity.test.js).
 */
import { getActive } from "../core/accounts.js";
import { autoLogin, getApi } from "../core/zalo-client.js";
import { CONFIRM_EXIT_CODE, guardSubcommand } from "../core/confirm-guard.js";
import { getAccountDbPath, getAccountDir } from "../core/credentials.js";
import { callViaDaemon } from "../core/daemon-channel.js";
import { closeDb, dbUsedBytes, initDb, verifyMessageRows } from "../core/db.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { describeQuotaEvent, describeStorage, runStoragePass } from "../core/storage-quota.js";
import { purgeDeadDeliveries } from "../core/webhook-outbox.js";
import { QUERY_ROW_LIMIT, QUERY_ROW_LIMIT_MAX, copyDatabase, runReadOnlyQuery } from "../core/db-tools.js";
import { buildExport } from "../core/data-export.js";
import { passwordProblem } from "../core/export-crypt.js";
import { promptSecret, readSecretFromStream } from "../utils/secret-input.js";
import { parseDateBound, parsePeriod } from "../utils/date-range.js";
import { error, info, output, success, warning } from "../utils/output.js";
import { parseIntAtLeast } from "../utils/parse-options.js";
import { addHiddenOptions, hiddenAccess, hiddenSetForCli } from "../utils/hidden-access.js";

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

/** The session, when one can be had (a login with the saved credentials); null otherwise. */
async function sessionOrNull(json) {
    try {
        await autoLogin(json);
        return getApi();
    } catch {
        return null;
    }
}

/**
 * Which threads `db query` / `db export` leave out: the hidden chats, unless `--include-hidden` and the PIN (asked,
 * then checked against the hash Zalo gives a session, with the lockout; exits on failure). Without a session at hand
 * the ids come from the mirror the listener and the hidden-chat commands keep; when no list is known yet, one login
 * reads it. When it still cannot be known, the command refuses (exit 1) rather than show hidden chats.
 *
 * @param {object} opts
 * @param {string} ownId
 * @param {boolean} json
 * @returns {Promise<{mode: "include"|"exclude"|"none", ids: string[], hiddenIds: string[]}>} `hiddenIds`: with the
 *   PIN, the hidden threads (an export marks them)
 */
async function hiddenScope(opts, ownId, json) {
    if (opts.includeHidden) {
        const api = await sessionOrNull(json);
        if (!api) {
            fail(new Error("--include-hidden checks the PIN against Zalo's answer: log in first (zalo-agent login)."));
        }
        const { set } = await hiddenAccess(opts, { ownId, api, json });
        return { mode: "include", ids: [], hiddenIds: [...set.ids] };
    }
    let set;
    try {
        set = await hiddenSetForCli(ownId, null, { preferMirror: true });
        if (!set.known) {
            const api = await sessionOrNull(json);
            if (api) await set.ensure(api);
        }
    } catch (e) {
        fail(new Error(`Could not read which chats are hidden (${e.message}): nothing was read.`));
    }
    if (!set.known) {
        fail(
            new Error(
                "Which chats are hidden is not known on this machine yet, and Zalo could not be asked: nothing was " +
                    "read. Log in (zalo-agent login) or start the listener once, then run this again.",
            ),
        );
    }
    const ids = [...set.ids];
    return { mode: ids.length ? "exclude" : "none", ids, hiddenIds: [] };
}

/**
 * The password of a password-encrypted export: the first line of standard input (`--password-stdin`), or typed twice
 * at a prompt that does not echo. Never an argument. Exits 2 when there is no way to ask, 1 when it is refused.
 *
 * @param {{passwordStdin?: boolean}} opts
 * @param {boolean} json
 * @returns {Promise<string>}
 */
async function exportPassword(opts, json) {
    let password;
    try {
        if (opts.passwordStdin) {
            password = (await readSecretFromStream()).split(/\r?\n/)[0];
        } else {
            if (!process.stdin.isTTY) {
                const why =
                    "Not done: --password asks for the password at a terminal, and there is none. Pipe it to " +
                    "standard input with --password-stdin (never pass it as an argument).";
                if (json) console.log(JSON.stringify({ error: why, passwordRequired: true }, null, 2));
                else error(why);
                process.exit(CONFIRM_EXIT_CODE);
            }
            password = await promptSecret("Export password: ");
            const again = await promptSecret("The same password again: ");
            if (again !== password) throw new Error("the two passwords differ: nothing was written");
        }
    } catch (e) {
        fail(new Error(`Could not read the password: ${e.message}`));
    }
    const problem = passwordProblem(password);
    if (problem) fail(new Error(`${problem[0].toUpperCase()}${problem.slice(1)}: nothing was written.`));
    return password;
}

const mib = (n) => `${(Number(n || 0) / 1024 / 1024).toFixed(1)} MiB`;

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
            "The account's encrypted message database: read-only SQL, backup, export, integrity check, usage, purge",
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
        .action(async (sql, opts) => {
            const jsonMode = program.opts().json;
            const { ownId, file } = accountDb();
            const hidden = await hiddenScope(opts, ownId, jsonMode);
            let result;
            try {
                result = runReadOnlyQuery(file, sql, { limit: opts.limit, excludeThreadIds: hidden.ids });
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
                if (hidden.mode === "exclude")
                    info("Hidden chats are left out (--include-hidden and the PIN show them).");
            });
        });
    addHiddenOptions(query);

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
            "Decrypt the copy, so any SQLite tool opens it (every cached message outside hidden chats, readable by anyone)",
        )
        .option(
            "--password",
            "Encrypt the copy with a password you type (asked twice; it opens anywhere with it, no keyring needed)",
        )
        .option("--password-stdin", "Like --password, reading the password from the first line of standard input")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            const { ownId, file } = accountDb();
            const withPassword = Boolean(opts.password || opts.passwordStdin);
            if (withPassword && opts.plaintext) fail(new Error("Choose --password or --plaintext, not both."));
            if (opts.passwordStdin && opts.pinStdin) {
                fail(
                    new Error(
                        "--password-stdin and --pin-stdin both read standard input: type one of them at its prompt.",
                    ),
                );
            }
            const hidden = await hiddenScope(opts, ownId, jsonMode);
            const password = withPassword ? await exportPassword(opts, jsonMode) : null;
            let r;
            try {
                if (withPassword) {
                    r = await buildExport({
                        dbFile: file,
                        out: opts.out,
                        encryption: "password",
                        password,
                        excludeThreadIds: hidden.ids,
                        hiddenIds: hidden.hiddenIds,
                    });
                } else {
                    r = copyDatabase(file, opts.out, {
                        plaintext: Boolean(opts.plaintext),
                        excludeThreadIds: hidden.ids,
                        exportInfo: { hiddenIds: hidden.hiddenIds },
                    });
                }
            } catch (e) {
                fail(e);
            }
            output(r, jsonMode, () => {
                if (r.encryption === "password") {
                    success(`Wrote a password-encrypted export (${r.messages} messages) to ${r.file}`);
                    info("It opens with that password only (docs/security.md: the export file format).");
                } else if (r.encrypted) {
                    success(`Wrote an encrypted copy (${r.messages} messages) to ${r.file}`);
                    info("For a copy other SQLite tools can open: --plaintext --yes.");
                } else {
                    success(`Wrote a decrypted copy (${r.messages} messages) to ${r.file}`);
                    warning("Anyone who can read that file reads every message in it: delete it when done.");
                }
                if (r.hiddenChats === "excluded")
                    info("Hidden chats are left out (--include-hidden and the PIN add them).");
                else if (r.hiddenChats === "included")
                    info(`${r.hiddenThreads} hidden chat(s) are in it, marked in the table export_hidden_threads.`);
            });
        });
    addHiddenOptions(exporter);

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

    const usage = db
        .command("usage")
        .description(
            "Show the account's storage (database, media, outbox), its quota and retention rules, and its state",
        )
        .action(() => {
            const jsonMode = program.opts().json;
            const { ownId, file } = accountDb();
            let r;
            try {
                initDb(file);
                r = { accountId: ownId, ...describeStorage(ownId, { dbBytes: dbUsedBytes() }) };
            } catch (e) {
                fail(e);
            } finally {
                closeDb();
            }
            output(r, jsonMode, () => {
                const u = r.usage;
                info(`Used: ${mib(u.total)} (database ${mib(u.db)}, media ${mib(u.media)}, outbox ${mib(u.outbox)})`);
                const q = r.quota;
                info(
                    q.accountLimit
                        ? `Limit: ${mib(q.accountLimit)} (${q.percent}%), ${q.level ?? "not checked yet"}` +
                              (q.purgeAt ? `; over since ${q.overSince}, purge at ${q.purgeAt}` : "")
                        : "Limit: none for this account",
                );
                for (const t of q.tenants)
                    info(`Tenant ${t.id}: limit ${mib(t.limit)}, ${t.level ?? "not checked yet"}`);
                info(
                    `Retention: messages ${r.retention.messages}, media ${r.retention.media}, ` +
                        `dead webhook deliveries ${r.retention.outboxDead}; checked every ${r.retention.purgeEvery}`,
                );
                if (r.lastPurge) info(`Last purge: ${r.lastPurge.at}, ${mib(r.lastPurge.freedBytes)} freed`);
            });
        });

    const purge = db
        .command("purge")
        .description(
            "Purge what the quota and retention rules make due (oldest media, then oldest messages); asks first: --yes",
        )
        .option("--dry-run", "Count what would be purged, and purge nothing")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            const { ownId, file } = accountDb();
            const accountDir = getAccountDir(ownId);
            const dryRun = Boolean(opts.dryRun);
            let report;
            // The daemon holding the account is its one writer: it purges.
            const via = await callViaDaemon(accountDir, "/purge", { dryRun }, { timeoutMs: 600_000 });
            if (via) {
                if (!via.ok) fail(new Error(via.error));
                report = via.report;
            } else {
                if (!dryRun && !acquireLock(accountDir)) {
                    fail(new Error("A daemon holds this account but does not answer on its channel; stop it first."));
                }
                try {
                    initDb(file);
                    report = runStoragePass({
                        ownId,
                        dryRun,
                        purgeOutboxDead: (cutoff) => purgeDeadDeliveries(accountDir, cutoff),
                    });
                } catch (e) {
                    fail(e);
                } finally {
                    closeDb();
                    if (!dryRun) releaseLock(accountDir);
                }
            }
            output({ ...report, via: via ? "daemon" : "local" }, jsonMode, () => {
                const r = report;
                const media = r.retention.media.files + r.quota.media.files;
                const msgs = r.retention.messages.rows + r.quota.messages.rows;
                const verb = dryRun ? "Would purge" : "Purged";
                (dryRun ? info : success)(
                    `${verb} ${media} media file(s) and ${msgs} message(s)` +
                        (dryRun ? "" : `, ${r.retention.outboxDead} dead webhook deliver(ies)`) +
                        `; used ${mib(r.usageBefore.total)}${dryRun ? "" : ` -> ${mib(r.usageAfter.total)}`}`,
                );
                for (const e of r.events ?? []) info(describeQuotaEvent({ accountId: ownId, ...e }));
                if (!media && !msgs)
                    info("Nothing is due: no age rule removes anything and no grace period has ended.");
            });
        });

    // They read the local database only: no session needed (src/index.js preAction).
    for (const cmd of [query, backup, exporter, verify, usage, purge]) cmd.zaloLocalOnly = true;
    // A purge deletes for good: --yes to run it, --dry-run (its own: it counts) to preview, exit 2 without either.
    guardSubcommand(db, "purge", "db.purge", {
        target: () => ({ ownerId: getActive()?.ownId ?? null }),
        ownDryRun: true,
    });
    // A decrypted copy is the whole message history in the clear: --yes to write it, --dry-run to preview.
    guardSubcommand(db, "export", "db.exportPlaintext", {
        target: (opts) => ({
            ownerId: getActive()?.ownId ?? null,
            output: opts.out,
            includeHidden: Boolean(opts.includeHidden),
        }),
        when: (_target, opts) => Boolean(opts.plaintext),
    });
    return db;
}
