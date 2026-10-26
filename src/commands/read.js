/**
 * `read`: the read-only endpoints of Zalo Web's API that have no command of their own (plan track S, 6.1).
 *
 * `read list` says what there is; `read run <name>` asks Zalo and prints the answer. Both are in `src/zalo/reads.js`,
 * where each read's host, path and request body are written out beside the web client method they come from. Nothing
 * here changes anything on the account: the table holds reads only (a test keeps it that way).
 */
import chalk from "chalk";
import { getApi } from "../core/zalo-client.js";
import { callRead, describeReads, READS, ReadUsageError } from "../zalo/reads.js";
import { error, info, output } from "../utils/output.js";

/**
 * Turn what a person typed into the arguments of a read: `--args` as JSON, then each `--arg key=value` coerced by the
 * type the read declares. A string stays a string (a Zalo id has 19 digits, more than a number keeps exactly), a
 * number is a number, and "json" is parsed.
 *
 * @param {string} name - a key of READS
 * @param {{args?: string, arg?: string[]}} opts
 * @returns {Record<string, any>}
 * @throws {ReadUsageError} for JSON that is not JSON, an `--arg` with no `=`, or a number that is not one
 */
export function argsFromOptions(name, opts) {
    const def = READS[name];
    if (!def) throw new ReadUsageError(`unknown read "${name}"; \`read list\` shows them`);
    let args = {};
    if (opts.args !== undefined) {
        try {
            args = JSON.parse(opts.args);
        } catch (e) {
            throw new ReadUsageError(`--args is not JSON: ${e.message}`);
        }
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
            throw new ReadUsageError('--args must be a JSON object, e.g. \'{"id":"123"}\'');
        }
    }
    for (const pair of opts.arg || []) {
        const at = pair.indexOf("=");
        if (at < 1) throw new ReadUsageError(`--arg "${pair}" is not key=value`);
        const key = pair.slice(0, at);
        const raw = pair.slice(at + 1);
        const spec = def.args.find((a) => a.name === key);
        if (!spec) {
            throw new ReadUsageError(
                `"${name}" has no argument "${key}"; it takes: ${def.args.map((a) => a.name).join(", ") || "none"}`,
            );
        }
        if (spec.type === "number") {
            const n = Number(raw);
            if (raw.trim() === "" || !Number.isFinite(n))
                throw new ReadUsageError(`--arg ${key}: "${raw}" is not a number`);
            args[key] = n;
        } else if (spec.type === "json") {
            try {
                args[key] = JSON.parse(raw);
            } catch (e) {
                throw new ReadUsageError(`--arg ${key}: not JSON (${e.message})`);
            }
        } else {
            args[key] = raw;
        }
    }
    return args;
}

/** One line per read, for a person. */
function printList(reads) {
    const width = Math.max(...reads.map((r) => r.name.length));
    for (const r of reads) {
        const args = r.args.map((a) => (a.required ? a.name : `[${a.name}]`)).join(" ");
        const mark = r.verified ? chalk.green("✓") : chalk.yellow("?");
        console.log(`  ${mark} ${chalk.bold(r.name.padEnd(width))}  ${r.what}${args ? chalk.dim(`  (${args})`) : ""}`);
    }
    info(
        `${chalk.green("✓")} answered by a live account; ${chalk.yellow("?")} request built from the web client, not yet seen answered.`,
    );
}

/**
 * Register `read list` and `read run`.
 *
 * @param {import("commander").Command} program
 */
export function registerReadCommands(program) {
    const read = program
        .command("read")
        .description(
            "Read-only endpoints of Zalo Web's API that have no command of their own (stickers, GIFs, profile rank, …)",
        );

    const list = read
        .command("list")
        .description("List the reads, what each takes, and whether a live account has answered it")
        .option("-v, --verified", "Only the reads a live account has answered")
        .action((opts) => {
            const reads = describeReads().filter((r) => !opts.verified || r.verified);
            output(reads, program.opts().json, () => printList(reads));
        });
    // The table is local: listing it needs no session.
    list.zaloLocalOnly = true;

    read.command("run <name>")
        .description('Ask Zalo one read and print the answer (arguments: --args \'{"id":"123"}\' or --arg id=123)')
        .option("--args <json>", "Arguments as a JSON object")
        .option("-a, --arg <key=value>", "One argument; repeatable. Typed by what the read declares", collect, [])
        .action(async (name, opts) => {
            try {
                const args = argsFromOptions(name, opts);
                const result = await callRead(getApi(), name, args);
                output(result ?? null, program.opts().json);
            } catch (e) {
                error(e instanceof ReadUsageError ? e.message : `${name} failed: ${e.message}`);
                process.exit(1);
            }
        });
}

/** commander: gather a repeatable option into an array. */
function collect(value, previous) {
    return [...previous, value];
}
