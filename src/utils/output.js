/**
 * Output formatting utilities — JSON mode and colored human-readable output.
 */

import chalk from "chalk";

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

export const success = (msg) => console.log(chalk.green("  ✓ " + msg));
export const error = (msg) => console.log(chalk.red("  ✗ " + msg));
export const info = (msg) => console.log(chalk.cyan("  ● " + msg));
export const warning = (msg) => console.log(chalk.yellow("  ⚠ " + msg));
