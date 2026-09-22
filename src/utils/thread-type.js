/**
 * Fill in `--type` from the local cache when the caller did not say.
 *
 * Twenty-two commands take `-t, --type <n>` (0=User, 1=Group) and every one of
 * them defaults it to 0, because a thread id alone does not say which it is.
 * That default is wrong for every group, and wrong in a way that is easy to
 * miss: Zalo routes the send by thread id regardless, so the message arrives
 * and the command reports success. What the declared type actually decides is
 * which socket channel the server echoes the sender's own copy back on — cmd
 * 501 (1-1) or cmd 521 (group) — and the listener types the conversation from
 * that channel. A group send left at the default therefore came back looking
 * like a DM and rewrote the conversation's stored type. Two threads in a real
 * cache were found already mislabelled this way.
 *
 * The cache knows the answer, so nobody should have to remember `-t 1`. This
 * runs as one preAction hook rather than in twenty-two action handlers, and
 * only ever fires when the option is still at its default — passing `-t 0`
 * explicitly still means 0.
 *
 * `upsertThread` refuses to downgrade a group regardless, so this is the
 * ergonomic half of the fix, not the safety half.
 */
import { join } from "node:path";
import { getActive } from "../core/accounts.js";
import { CONFIG_DIR } from "../core/credentials.js";
import { initDb, getThreadType } from "../core/db.js";

/**
 * The cached kind of one conversation, opening the active account's db first.
 *
 * @param {string} threadId
 * @returns {"dm"|"group"|null}
 */
function lookupCachedType(threadId) {
    const acc = getActive();
    if (!acc) return null;
    initDb(join(CONFIG_DIR, "accounts", acc.ownId, "zalo.db"));
    return getThreadType(threadId);
}

/**
 * Rewrite `cmd`'s `--type` to 1 when its threadId argument names a known group.
 *
 * Silent and best-effort by design: this sits in front of every command, so a
 * missing account, an absent cache or an unknown thread must leave the command
 * exactly as it was rather than fail it.
 *
 * @param {import("commander").Command} cmd - the command about to run
 * @param {(threadId: string) => ("dm"|"group"|null)} [lookup] - seam for tests
 * @returns {void}
 */
export function applyCachedThreadType(cmd, lookup = lookupCachedType) {
    try {
        if (typeof cmd?.getOptionValueSource !== "function") return;
        // "default" means commander supplied it, not the user. Anything else --
        // cli, env, config -- is a deliberate choice and is left alone.
        if (cmd.getOptionValueSource("type") !== "default") return;

        // Which positional holds the thread id differs per command: `msg send
        // <threadId> <message>` has it first, `msg react <msgId> <threadId>
        // <reaction>` second. Ask commander instead of assuming.
        const args = cmd.registeredArguments || [];
        const idx = args.findIndex((a) => a.name() === "threadId");
        if (idx < 0) return;
        const threadId = cmd.args?.[idx];
        if (!threadId) return;

        if (lookup(threadId) === "group") cmd.setOptionValue("type", "1");
    } catch {
        /* no cache, no account, or a command shaped differently -- keep the default */
    }
}
