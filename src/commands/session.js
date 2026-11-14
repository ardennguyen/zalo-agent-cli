/**
 * `session`: the account's saved login, as its running daemon holds it.
 *
 * - `session renew`: open a renewal link now (src/core/session-renew.js): a one-time QR login page at
 *   `<publicUrl>/zalo/qr/<token>`, served by the account's `mcp start --http` daemon, valid for `session.renew.linkTtl`.
 *   The account's phone scans it and confirms; the daemon saves the new login and switches to it without a restart.
 *   An open link is printed again unless `--fresh` asks for a new one (the old one dies).
 *
 * It goes to the daemon over its loopback channel (`POST /session`): the daemon serves the page and holds the socket
 * the new login replaces, so the CLI never logs in beside it (AGENTS.md section 13). With no daemon, `login` is the way.
 *
 * CLI-only: renewing the login is the operator's step (tests/unit/mcp-cli-parity.test.js).
 */
import { getActive } from "../core/accounts.js";
import { getAccountDir } from "../core/credentials.js";
import { callViaDaemon } from "../core/daemon-channel.js";
import { parseAccountId } from "../core/daemon-account.js";
import { error, info, output, success } from "../utils/output.js";

/** A daemon that answers but has no renewal: older than this command, or `listen`. */
const NO_RENEWAL = /does not take session requests|too old to take \/session/;

/**
 * Register the `session` group.
 *
 * @param {import("commander").Command} program
 * @returns {import("commander").Command}
 */
export function registerSessionCommands(program) {
    const session = program.command("session").description("The account's saved login: renew it before it ends");

    const renew = session
        .command("renew")
        .description(
            "Open a one-time QR login link on the account's running `mcp start --http` daemon (under its publicUrl) " +
                "that renews the saved login: the account's phone scans and confirms, the daemon switches without a restart",
        )
        .option(
            "--account <id>",
            "The registered account whose daemon opens the link (default: active account)",
            parseAccountId,
        )
        .option("--fresh", "Replace an open renewal link with a new one (the old link stops working)")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            const account = getActive();
            if (!account) {
                error("No active account. Please login first.");
                process.exit(1);
            }
            const ownId = String(account.ownId);
            const r = await callViaDaemon(getAccountDir(ownId), "/session", {
                action: "renew",
                fresh: Boolean(opts.fresh),
            });
            if (r === null) {
                error(
                    "No daemon runs for this account, so nothing can serve a renewal link. Start `mcp start --http` " +
                        `with a publicUrl, or log in by hand: zalo-agent --account ${ownId} login`,
                );
                process.exit(1);
            }
            if (!r.ok) {
                error(
                    NO_RENEWAL.test(r.error ?? "")
                        ? "This daemon does not serve renewal links (`listen`, or a version before 3.0.1). " +
                              `Log in by hand: zalo-agent --account ${ownId} login`
                        : r.error,
                );
                process.exit(1);
            }
            const result = {
                accountId: ownId,
                renewUrl: r.renewUrl ?? null,
                renewExpiresAt: r.renewExpiresAt ?? null,
                issued: Boolean(r.issued),
                session: r.session ?? null,
            };
            output(result, jsonMode, () => {
                success(
                    result.issued ? "Renewal link opened." : "A renewal link is already open (--fresh for a new one).",
                );
                info(`Open it and scan the code with this account's phone: ${result.renewUrl}`);
                info(`It works once, until ${result.renewExpiresAt}.`);
                if (result.session?.expiresAt)
                    info(
                        result.session.expired
                            ? `The saved login ended on ${result.session.expiresAt.slice(0, 10)}.`
                            : `The saved login ends on ${result.session.expiresAt.slice(0, 10)} (${result.session.daysLeft} day(s) left).`,
                    );
            });
        });

    renew.zaloLocalOnly = true;
    return session;
}
