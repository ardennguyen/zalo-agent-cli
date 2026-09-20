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

/** Emit JSON or call human formatter based on --json flag. */
export function output(data, jsonMode, humanFormatter) {
    if (jsonMode) {
        console.log(JSON.stringify(data, null, 2));
    } else if (humanFormatter) {
        humanFormatter(data);
    } else {
        console.log(JSON.stringify(data, null, 2));
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
 */
let jsonErrorEmitted = false;
export const error = (msg) => {
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
