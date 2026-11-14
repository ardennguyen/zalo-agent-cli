/**
 * `zalo-agent mcp approver <set|status|remove>`: the approver password an approve page asks for (confirmMode "human",
 * `approval.secret`, src/core/approval.js), so an AI agent that can open the link it relays cannot approve its own
 * action.
 *
 * The password is typed at a prompt that does not echo, or piped with `--stdin`; it is never a command-line argument.
 * Only a salted scrypt hash is kept, in `accounts/<ownId>/approver-secret.json` (0600). Nothing here prints it.
 */

import { selectDaemonAccount } from "../core/daemon-account.js";
import { getAccountDir } from "../core/credentials.js";
import {
    approverPasswordProblem,
    approverStatus,
    removeApproverPassword,
    setApproverPassword,
} from "../core/approval.js";
import { promptSecret, readSecretFromStream } from "../utils/secret-input.js";
import { error, info, output, success } from "../utils/output.js";

const ACTIONS = ["set", "status", "remove"];

/**
 * Register `mcp approver`.
 *
 * @param {import("commander").Command} mcp - the `mcp` command
 * @param {import("commander").Command} program - the root, for `--json` and `--account`
 */
export function registerMCPApproverCommand(mcp, program) {
    mcp.command("approver <action>")
        .description(
            "The approver password of approve pages (confirmMode human): set (typed at a hidden prompt, or " +
                "--stdin), status, or remove. Only a salted scrypt hash is stored",
        )
        .option("--account <id>", "Account (default: the active one)")
        .option("--stdin", "set: read the password from the first line of standard input instead of a prompt")
        .action(async (action, opts) => {
            const json = program.opts().json;
            if (!ACTIONS.includes(action)) {
                error(`Unknown action "${action}": use set, status or remove.`);
                process.exit(1);
            }
            let ownId;
            try {
                const requested =
                    opts.account ?? program.opts().account ?? (process.env.ZALO_ACCOUNT?.trim() || undefined);
                ownId = selectDaemonAccount(requested).ownId;
            } catch (e) {
                error(`Account selection failed: ${e.message}`);
                process.exit(1);
            }
            const dir = getAccountDir(ownId);

            if (action === "status") {
                const s = approverStatus(dir);
                output({ accountId: ownId, approverPassword: s.set, setAt: s.setAt }, json, () =>
                    info(
                        s.set
                            ? `An approver password is set (since ${s.setAt}).`
                            : "No approver password is set: approve pages ask only for a click unless approval.secret " +
                                  'is "pin".',
                    ),
                );
                return;
            }
            if (action === "remove") {
                const had = removeApproverPassword(dir);
                output({ accountId: ownId, removed: had, approverPassword: false }, json, () =>
                    had ? success("Approver password removed.") : info("There was no approver password to remove."),
                );
                return;
            }

            let password;
            try {
                if (opts.stdin) password = (await readSecretFromStream()).split(/\r?\n/)[0];
                else if (!process.stdin.isTTY) {
                    error("No terminal to ask on: pipe the password with --stdin (never pass it as an argument).");
                    process.exit(2);
                } else {
                    password = await promptSecret("New approver password: ");
                    const problem = approverPasswordProblem(password);
                    if (problem) {
                        error(problem);
                        process.exit(1);
                    }
                    const again = await promptSecret("Again: ");
                    if (again !== password) {
                        error("The two passwords differ; nothing was saved.");
                        process.exit(1);
                    }
                }
                const { setAt } = setApproverPassword(dir, password);
                password = null;
                output({ accountId: ownId, approverPassword: true, setAt }, json, () =>
                    success("Approver password saved (as a salted hash). Approve pages now ask for it."),
                );
            } catch (e) {
                error(`Could not set the approver password: ${e.message}`);
                process.exit(1);
            }
        });
}
