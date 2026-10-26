/**
 * `write`: the state-changing endpoints of Zalo Web's API that have no command of their own (plan track S, 6.2).
 *
 * `write list` says what there is, what each touches and what it takes. `write run <name>` shows the request with
 * `--dry-run`, and sends it only with `--yes`: each of these changes something on the account, and none has been
 * answered by a live account yet, so a first run of any of them belongs on something disposable. The table is in
 * `src/zalo/writes.js`, beside the web client method each request comes from.
 */
import chalk from "chalk";
import { getApi } from "../core/zalo-client.js";
import { callWrite, describeWrites, WRITES } from "../zalo/writes.js";
import { ReadUsageError } from "../zalo/reads.js";
import { error, info, output } from "../utils/output.js";
import { argsFromDef, collect } from "./read.js";

/** Why a real call was refused, in the words a person needs next. */
export const NEEDS_YES =
    "This changes something on the account and no live account has answered it yet. Add --dry-run to see the " +
    "request, or --yes to send it.";

/** The colour a risk wears in `write list`. */
const RISK_COLOUR = { private: chalk.cyan, visible: chalk.yellow, destructive: chalk.red };

/** One line per write, for a person. */
function printList(writes) {
    const width = Math.max(...writes.map((w) => w.name.length));
    for (const w of writes) {
        const args = w.args.map((a) => (a.required ? a.name : `[${a.name}]`)).join(" ");
        const risk = (RISK_COLOUR[w.risk] || chalk.white)(w.risk.padEnd(11));
        console.log(`  ${risk} ${chalk.bold(w.name.padEnd(width))}  ${w.what}${args ? chalk.dim(`  (${args})`) : ""}`);
    }
    info(
        `${chalk.cyan("private")}: this account's own data · ${chalk.yellow("visible")}: other people see it · ` +
            `${chalk.red("destructive")}: it removes something. None has been answered by a live account yet.`,
    );
}

/**
 * Register `write list` and `write run`.
 *
 * @param {import("commander").Command} program
 */
export function registerWriteCommands(program) {
    const write = program
        .command("write")
        .description(
            "State-changing endpoints of Zalo Web's API that have no command of their own (board items, todos, friends, …)",
        );

    const list = write
        .command("list")
        .description("List the writes, what each touches, and what it takes")
        .option("-r, --risk <risk>", "Only writes of this risk: private, visible or destructive")
        .action((opts) => {
            const writes = describeWrites().filter((w) => !opts.risk || w.risk === opts.risk);
            output(writes, program.opts().json, () => printList(writes));
        });
    // The table is local: listing it needs no session.
    list.zaloLocalOnly = true;

    write
        .command("run <name>")
        .description('Show (--dry-run) or send (--yes) one write; arguments: --args \'{"id":"123"}\' or --arg id=123')
        .option("--args <json>", "Arguments as a JSON object")
        .option("-a, --arg <key=value>", "One argument; repeatable. Typed by what the write declares", collect, [])
        .option("--dry-run", "Print the request that would be sent and send nothing")
        .option("-y, --yes", "Send it: this changes something on the account")
        .action(async (name, opts) => {
            try {
                const def = WRITES[name];
                if (!def) throw new ReadUsageError(`unknown write "${name}"; \`write list\` shows them`);
                const args = argsFromDef(def, name, opts);
                if (!opts.dryRun && !opts.yes) throw new ReadUsageError(`"${name}" (${def.risk}): ${NEEDS_YES}`);
                const result = await callWrite(getApi(), name, args, { dryRun: !!opts.dryRun });
                output(result ?? null, program.opts().json);
            } catch (e) {
                error(e instanceof ReadUsageError ? e.message : `${name} failed: ${e.message}`);
                process.exit(1);
            }
        });
}
