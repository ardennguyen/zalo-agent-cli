/**
 * Output formatting utilities — JSON mode and colored human-readable output.
 *
 * ## The stdout contract
 *
 * In `--json` mode (and in MCP mode), **stdout carries nothing but one JSON
 * value.** Human-facing chatter — the disclaimer, auto-login notices,
 * progress lines, success confirmations — goes to stderr, and failures are
 * emitted as JSON too, so `zalo-agent --json … | jq` works whether the
 * command succeeded or not.
 *
 * This used to be false in two ways, both of which broke piping:
 *
 *   · `error()` printed `  ✗ <msg>` to stdout regardless of mode, so a
 *     failure produced output that was not JSON at all.
 *   · Commands that call `success()` after `output()` — `msg send --react`
 *     is the one that bit us — appended a human line *after* the JSON.
 *
 * MCP mode gets the same treatment for a different reason: there, stdout is
 * the JSON-RPC transport, so anything else on it corrupts the protocol.
 * `src/commands/mcp.js` also reassigns console.log to console.error as a
 * second layer of defense.
 */

import chalk from "chalk";

/**
 * True when stdout is reserved for machine-readable output.
 * Set by the preAction hook in src/index.js for `--json` and for `mcp`.
 */
function machineMode() {
    return Boolean(process.env.ZALO_JSON_MODE);
}

/**
 * The running command's arguments by name, set by the preAction hook in src/index.js
 * ({@link setReplyContext}): what a reply that Zalo left empty says was done.
 */
let replyContext = {};

/**
 * Record the running command's arguments, for {@link output} to name when Zalo's answer is empty.
 *
 * @param {{registeredArguments?: Array<{name: () => string}>, processedArgs?: unknown[]}|null} command - the
 *   Commander command about to run
 */
export function setReplyContext(command) {
    replyContext = {};
    const names = command?.registeredArguments ?? [];
    names.forEach((arg, i) => {
        const value = command.processedArgs?.[i];
        if (value === undefined) return;
        // `<on|off>` and the like are not names a reader can use.
        const name = /^\w+$/.test(arg.name()) ? arg.name() : "value";
        replyContext[name] = value;
    });
}

/**
 * What `--json` prints for `data`: one object or array, always (the stdout contract above).
 *
 * Many commands print Zalo's answer as it came, and Zalo answers many writes -- and some reads -- with an
 * empty body: "", null, nothing. Printed as is, that was `""` or `null` or the word `undefined`, which a caller
 * cannot tell from a failure. A call that did not throw was accepted, so an empty answer becomes
 * `{"success": true, ...the command's arguments}` (the shape the MCP actions reply with), and any other bare
 * value is kept under `result`. An object or an array is printed unchanged.
 *
 * @param {unknown} data
 * @returns {object|Array}
 */
export function jsonReply(data) {
    if (data !== null && typeof data === "object") return data;
    if (data === undefined || data === null || data === "") return { success: true, ...replyContext };
    return { success: true, ...replyContext, result: data };
}

/** Emit JSON or call human formatter based on --json flag. */
export function output(data, jsonMode, humanFormatter) {
    if (jsonMode) {
        console.log(JSON.stringify(jsonReply(data), null, 2));
    } else if (humanFormatter) {
        humanFormatter(data);
    } else {
        console.log(JSON.stringify(data ?? null, null, 2));
    }
}

/**
 * Report a failure.
 *
 * Human mode: `  ✗ <msg>` on stdout, as before.
 * Machine mode: `{"error": "<msg>"}` on stdout — a caller can test `.error`
 * with jq instead of pattern-matching a ✗ out of mixed output.
 *
 * Only the FIRST error is emitted as JSON. A command that reports several
 * failures would otherwise put several JSON values on stdout, which is just
 * as unparseable as the old ✗ line; subsequent ones go to stderr.
 *
 * Either way the process exits 1 (3.0.0; before, most failures exited 0), unless
 * a more specific non-zero code is already set: 2 for a confirmation refusal
 * (src/core/confirm-guard.js), 3/4 for a kicked or revoked session
 * (src/core/exit-codes.js). A line that is not a failure belongs in warning().
 */
let jsonErrorEmitted = false;
export const error = (msg) => {
    if (!process.exitCode) process.exitCode = 1;
    if (!machineMode()) {
        console.log(chalk.red("  ✗ " + msg));
        return;
    }
    if (jsonErrorEmitted) {
        console.error("  ✗ " + msg);
        return;
    }
    jsonErrorEmitted = true;
    console.log(JSON.stringify({ error: String(msg) }, null, 2));
};

/** Confirm success. Suppressed from stdout in machine mode. */
export const success = (msg) => {
    if (machineMode()) console.error("  ✓ " + msg);
    else console.log(chalk.green("  ✓ " + msg));
};

/** Progress / context line. Suppressed from stdout in machine mode. */
export const info = (msg) => {
    if (machineMode()) console.error("  ● " + msg);
    else console.log(chalk.cyan("  ● " + msg));
};

/** Caveat or risk line. Suppressed from stdout in machine mode. */
export const warning = (msg) => {
    if (machineMode()) console.error("  ⚠ " + msg);
    else console.log(chalk.yellow("  ⚠ " + msg));
};

/** Test seam: reset the once-only JSON error latch. */
export function _resetErrorLatch() {
    jsonErrorEmitted = false;
}
