/**
 * Hidden chats on the command line: which threads a command leaves out, and the PIN that lets one command show them.
 *
 * The CLI follows its flags, not mcp-config.json: hidden chats are left out unless the command is run with
 * `--include-hidden`, which asks for the PIN at a prompt that does not echo (src/utils/secret-input.js), or reads it
 * from standard input with `--pin-stdin`. The PIN is never a command-line argument, never printed, stored or logged;
 * it is checked against the hash Zalo gave this process (src/core/hidden-chats.js) and dropped. Without a terminal and
 * without `--pin-stdin` the command does not hang: it prints a "needs PIN" reply and exits 2.
 */

import { getAccountDir } from "../core/credentials.js";
import { CONFIRM_EXIT_CODE } from "../core/confirm-guard.js";
import { hiddenChatsFor, pinFailureLine } from "../core/hidden-chats.js";
import { promptSecret, readSecretFromStream } from "./secret-input.js";
import { error } from "./output.js";

/** The exit code of a command that needs the PIN and could not ask for it (as an unconfirmed guarded command). */
export const PIN_REQUIRED_EXIT_CODE = CONFIRM_EXIT_CODE;

/** The flags every command that can show hidden chats takes. */
export function addHiddenOptions(command, { include = true } = {}) {
    if (include) {
        command.option(
            "--include-hidden",
            "Show hidden conversations too: asks for the hidden-chat PIN (never pass it on the command line)",
        );
    }
    command.option("--pin-stdin", "Read the hidden-chat PIN from standard input instead of a prompt");
    return command;
}

/**
 * The account's hidden set for a CLI command: read fresh from Zalo when a session is at hand, else the id mirror the
 * daemon keeps. Never throws.
 *
 * @param {string} ownId
 * @param {object|null} api - a logged-in session, or null for a cache-only command
 * @param {{preferMirror?: boolean}} [how] - a cache answer: use the id mirror when there is one, and ask Zalo only
 *   when there is none yet (the mirror is written by every read of the list, and kept current by the listener)
 * @returns {Promise<import("../core/hidden-chats.js").HiddenChats>}
 */
export async function hiddenSetForCli(ownId, api, { preferMirror = false } = {}) {
    const set = hiddenChatsFor(ownId, { stateDir: getAccountDir(ownId) });
    if (preferMirror && set.known) return set;
    if (api?.getHiddenConversations) {
        try {
            await set.refresh(api);
        } catch (e) {
            console.error(`[hidden-chats] could not read the hidden conversations: ${e.message}`);
        }
    }
    return set;
}

/**
 * Read one PIN: from standard input (`--pin-stdin`, its first line) or a prompt. Returns null when there is no way to
 * ask (no terminal and no `--pin-stdin`).
 *
 * @param {{pinStdin?: boolean, prompt?: string, lines?: string[]|null}} how
 * @returns {Promise<string|null>}
 */
export async function readPin({ pinStdin = false, prompt = "Hidden-chat PIN: ", lines = null } = {}) {
    if (pinStdin) {
        if (lines) return lines.shift() ?? "";
        return (await readSecretFromStream()).split(/\r?\n/)[0].trim();
    }
    if (!process.stdin.isTTY) return null;
    return promptSecret(prompt);
}

/** The lines of standard input, for a command that reads several PINs (`conv hidden-pin --pin-stdin`). */
export async function readPinLines() {
    return (await readSecretFromStream()).split(/\r?\n/).map((l) => l.trim());
}

/**
 * Print the "needs PIN" reply and exit 2 (no terminal to ask on and no `--pin-stdin`).
 *
 * @param {boolean} json
 * @param {object} [extra] - fields to add (count, hasPin)
 */
export function exitPinRequired(json, extra = {}) {
    const why =
        "Not done: this needs the hidden-chat PIN, and there is no terminal to ask on. Pipe it to standard input " +
        "with --pin-stdin (never pass it as an argument).";
    if (json)
        console.log(JSON.stringify({ error: why, pinRequired: true, retryWith: "--pin-stdin", ...extra }, null, 2));
    else error(why);
    process.exit(PIN_REQUIRED_EXIT_CODE);
}

/**
 * Ask for the PIN and check it; exits on failure (2 when it cannot ask, 1 for a wrong PIN or a lockout).
 *
 * @param {import("../core/hidden-chats.js").HiddenChats} set
 * @param {{pinStdin?: boolean, json?: boolean, extra?: object}} how
 * @returns {Promise<true>}
 */
export async function unlockOrExit(set, { pinStdin = false, json = false, extra = {} } = {}) {
    if (!set.hasPin) {
        error(pinFailureLine({ reason: "no-pin" }));
        process.exit(1);
    }
    const locked = set.lockoutStatus();
    if (locked.retryAfterMs > 0) {
        error(pinFailureLine({ reason: "locked", ...locked }));
        process.exit(1);
    }
    let pin;
    try {
        pin = await readPin({ pinStdin });
    } catch (e) {
        error(`Could not read the PIN: ${e.message}`);
        process.exit(1);
    }
    if (pin === null) exitPinRequired(json, extra);
    const r = set.verifyPin(pin);
    pin = null;
    if (!r.ok) {
        error(pinFailureLine(r));
        process.exit(1);
    }
    return true;
}

/**
 * What one command shows: `exclude` unless `--include-hidden` and the PIN checks out (then `include`).
 *
 * @param {object} opts - the command's options (`includeHidden`, `pinStdin`)
 * @param {{ownId: string, api: object|null, json?: boolean}} ctx
 * @returns {Promise<{set: import("../core/hidden-chats.js").HiddenChats, mode: "exclude"|"include", ids: string[]}>}
 */
export async function hiddenAccess(opts, { ownId, api, json = false }) {
    // Unlocking needs the PIN hash, which only Zalo's answer carries; leaving out needs only the ids.
    const set = await hiddenSetForCli(ownId, api, { preferMirror: !opts?.includeHidden });
    if (opts?.includeHidden) {
        await unlockOrExit(set, { pinStdin: Boolean(opts.pinStdin), json });
        return { set, mode: "include", ids: [] };
    }
    return { set, mode: "exclude", ids: [...set.ids] };
}
