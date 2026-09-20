/**
 * Subprocess harness for driving `node src/index.js` from tests.
 *
 * Two important facts about this CLI that shape every assertion here:
 *
 *  1. **API failures do not set a non-zero exit code.** Almost every action
 *     handler is `try { ... } catch (e) { error(e.message) }`, and `error()`
 *     writes `  ✗ <message>` to *stdout* via console.log. So "did it work?"
 *     is a question about output text, not about `code`. Commander's own
 *     parse errors (unknown option, missing required option) *do* exit 1.
 *
 *  2. **`--json` mode is not reliably JSON.** Success paths emit JSON, but
 *     the `✗` error line is printed on the same stream. `runJson()` below
 *     therefore reports failures explicitly rather than throwing a bare
 *     JSON.parse SyntaxError.
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.js");

// Built from a char code so no raw ESC byte (or fragile escape) lands in source.
const ANSI = new RegExp(String.fromCharCode(0x1b) + "\\[[0-9;]*m", "g");

/** Strip ANSI color codes so assertions match plain text. */
export function stripAnsi(s) {
    return String(s).replace(ANSI, "");
}

/**
 * Run the CLI and resolve with its result. Never rejects on a non-zero exit
 * code — inspect `code` yourself.
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @param {string} [opts.home]    - value for USERPROFILE/HOME (config root)
 * @param {number} [opts.timeout] - ms, default 60000
 * @param {object} [opts.env]     - extra env vars
 * @returns {Promise<{code:number, stdout:string, stderr:string, all:string}>}
 */
export function runCli(args, opts = {}) {
    const { home, timeout = 60_000, env = {} } = opts;
    const childEnv = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...env };
    if (home) {
        childEnv.USERPROFILE = home;
        childEnv.HOME = home;
        childEnv.HOMEDRIVE = "";
        childEnv.HOMEPATH = "";
    }
    // Belt and braces: checkForUpdates() already bails when stdout isn't a
    // TTY (it never is under execFile), but the explicit opt-out means a
    // test run can never shell out to `npm view`.
    childEnv.ZALO_AGENT_NO_UPDATE_CHECK = "1";

    return new Promise((res) => {
        execFile(
            process.execPath,
            [CLI, ...args],
            { encoding: "utf-8", timeout, env: childEnv, maxBuffer: 32 * 1024 * 1024 },
            (err, stdout, stderr) => {
                const out = stripAnsi(stdout || "");
                const errOut = stripAnsi(stderr || "");
                res({
                    code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
                    killed: Boolean(err && err.killed),
                    stdout: out,
                    stderr: errOut,
                    all: out + errOut,
                });
            },
        );
    });
}

/** The `  ✗ ...` line `error()` prints, if present. */
export function errorLineOf(text) {
    const m = stripAnsi(text).match(/^\s*✗\s*(.+)$/m);
    return m ? m[1].trim() : null;
}

/** True when the CLI reported a `  ✓ ...` success line. */
export function hasSuccess(text) {
    return /^\s*✓\s/m.test(stripAnsi(text));
}

/**
 * Run with `--json` and parse stdout.
 *
 * @returns {Promise<{ok:boolean, data?:any, error?:string, raw:object}>}
 *   `ok:false` with `error` when the CLI printed a `✗` line or emitted
 *   something that isn't JSON.
 */
export async function runJson(args, opts = {}) {
    const raw = await runCli(["--json", ...args], opts);

    // --json now emits failures as {"error": "..."} on stdout. Prefer that
    // over the legacy ✗-line sniffing, which only applies to human mode.
    try {
        const asJson = JSON.parse(raw.stdout.trim());
        if (asJson && typeof asJson.error === "string") return { ok: false, error: asJson.error, raw };
    } catch {
        // Not JSON — fall through to the legacy paths below.
    }
    const err = errorLineOf(raw.stdout) || errorLineOf(raw.stderr);
    if (err) return { ok: false, error: err, raw };

    const text = raw.stdout.trim();
    if (!text) return { ok: false, error: "(empty stdout)", raw };

    try {
        return { ok: true, data: JSON.parse(text), raw };
    } catch {
        // Not all --json output is pure JSON. `msg send --react`, for one,
        // prints the JSON result and then a human "✓ Auto-reacted…" line
        // (success() writes to stdout unconditionally). Rather than fail,
        // extract the first complete JSON value and report the leftover
        // through `trailing`, so a test can assert on it deliberately.
        const value = firstJsonValue(text);
        if (value) return { ok: true, data: value.data, trailing: value.trailing, raw };
        return { ok: false, error: `not JSON: ${text.slice(0, 200)}`, raw };
    }
}

/**
 * Scan for the first complete, balanced JSON value in `text` and return it
 * plus whatever followed. Brace counting is string- and escape-aware so a
 * `}` inside a message body doesn't end the scan early.
 *
 * @returns {{data:any, trailing:string}|null}
 */
function firstJsonValue(text) {
    const start = text.search(/[[{]/);
    if (start < 0) return null;

    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            if (inString) escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (ch === open) depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) {
                try {
                    return {
                        data: JSON.parse(text.slice(start, i + 1)),
                        trailing: text.slice(i + 1).trim(),
                    };
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

/** Convenience: run `--json` and return data, throwing a useful error if not ok. */
export async function json(args, opts = {}) {
    const r = await runJson(args, opts);
    if (!r.ok) throw new Error(`zalo-agent ${args.join(" ")} failed: ${r.error}`);
    return r.data;
}
