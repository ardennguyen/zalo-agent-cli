/**
 * `presence`: the on-demand presence of the account's running daemon (src/core/presence.js).
 *
 * - `presence status`: the mode (on-demand or always-on), the state (parked, waking, connected, yielded), the open
 *   holds by kind, when it parks next, the last wake time and the metered connected time.
 * - `presence wake`: open the socket now (a short manual hold; still parks after the idle timeout).
 * - `presence park`: close it now (never sooner than `presence.minConnected` after it connected, nor while a hold
 *   is open).
 * - `presence resume`: take the account back after a yield (another session of this login took the socket: the
 *   daemon stayed up and refuses every request until the user closes that session and confirms). Guarded like every
 *   action that changes who holds the account: nothing happens without `--yes` (exit 2); `--dry-run` says what it
 *   would do.
 *
 * All four go to the daemon over its loopback channel (`POST /presence`). The CLI never opens a socket itself
 * (AGENTS.md section 13). A daemon that does not run on-demand presence keeps its socket connected: `status` says
 * so from its health, and `wake` / `park` exit 1.
 *
 * CLI-only: the daemon's presence is the operator's (tests/unit/mcp-cli-parity.test.js).
 */
import { getActive } from "../core/accounts.js";
import { getAccountDir } from "../core/credentials.js";
import { callViaDaemon, statusViaDaemon } from "../core/daemon-channel.js";
import { guardSubcommand } from "../core/confirm-guard.js";
import { error, info, output, success } from "../utils/output.js";

/** The active (or `--account`) account's folder, or exit 1. */
function accountDir() {
    const account = getActive();
    if (!account) {
        error("No active account. Please login first.");
        process.exit(1);
    }
    return { ownId: String(account.ownId), dir: getAccountDir(account.ownId) };
}

/** The active account's id for the guard's sentence, or null. */
function activeOwnId() {
    const account = getActive();
    return account ? String(account.ownId) : null;
}

/** One request to the daemon; null when no daemon runs. */
async function ask(dir, action) {
    return callViaDaemon(dir, "/presence", { action });
}

/** A daemon that answers but has no presence: it keeps its socket connected (always-on, as before 3.0's switch). */
const NOT_RUNNING_PRESENCE = /does not take presence requests|too old to take \/presence/;

/**
 * Register the `presence` group.
 *
 * @param {import("commander").Command} program
 * @returns {import("commander").Command}
 */
export function registerPresenceCommands(program) {
    const presence = program
        .command("presence")
        .description("The account's daemon socket under on-demand presence: status, wake now, park now");

    const status = presence
        .command("status")
        .description(
            "Mode, state (parked, waking, connected, yielded, signed-out), open holds, next park, last wake, metered time",
        )
        .action(async () => {
            const jsonMode = program.opts().json;
            const { ownId, dir } = accountDir();
            const r = await ask(dir, "status");
            if (r === null) {
                output({ accountId: ownId, running: false }, jsonMode, () =>
                    info("No daemon runs for this account: nothing holds its socket."),
                );
                return;
            }
            if (!r.ok && NOT_RUNNING_PRESENCE.test(r.error ?? "")) {
                const h = await statusViaDaemon(dir);
                const result = {
                    accountId: ownId,
                    running: true,
                    mode: "always-on",
                    state: h?.ok ? h.health?.socket?.state : null,
                    onDemand: false,
                };
                output(result, jsonMode, () =>
                    info(`The daemon keeps its socket connected (always-on); socket: ${result.state ?? "unknown"}.`),
                );
                return;
            }
            if (!r.ok) {
                error(r.error);
                process.exit(1);
            }
            const result = { accountId: ownId, running: true, onDemand: true, ...r };
            delete result.ok;
            output(result, jsonMode, () => {
                info(`${result.mode}, ${result.state}${result.idleAt ? `; parks at ${result.idleAt}` : ""}`);
                if (result.state === "yielded")
                    info(
                        "Another session of this login holds the account; requests are refused. Close it, then run: " +
                            "zalo-agent presence resume --yes",
                    );
                if (result.state === "signed-out")
                    info("Zalo refuses the saved login (another browser took it): add the account again by QR.");
                const holds = Object.entries(result.holds ?? {});
                info(`holds: ${holds.length ? holds.map(([k, n]) => `${k} ${n}`).join(", ") : "none"}`);
                if (result.lastWakeMs !== null && result.lastWakeMs !== undefined)
                    info(`last wake: ${result.lastWakeMs} ms`);
            });
        });

    const act = (name, verb) =>
        presence
            .command(name)
            .description(
                name === "wake"
                    ? "Open the socket now (a manual hold; it parks again after the idle timeout)"
                    : "Close the socket now (not sooner than presence.minConnected, nor while a hold is open)",
            )
            .action(async () => {
                const jsonMode = program.opts().json;
                const { ownId, dir } = accountDir();
                const r = await ask(dir, name);
                if (r === null) {
                    error("No daemon runs for this account. Start one (mcp start --http, or listen --daemon).");
                    process.exit(1);
                }
                if (!r.ok) {
                    error(
                        NOT_RUNNING_PRESENCE.test(r.error ?? "")
                            ? `The daemon keeps its socket connected (always-on): there is nothing to ${name}.`
                            : r.error,
                    );
                    process.exit(1);
                }
                const result = { accountId: ownId, ...r };
                delete result.ok;
                output(result, jsonMode, () => success(`${verb}: ${result.state ?? "done"}`));
            });

    const wake = act("wake", "Waking");
    const park = act("park", "Parking");

    const resume = presence
        .command("resume")
        .description(
            "Take the account back after a yield (another session of this login took its socket): close that " +
                "session first, then confirm with --yes",
        )
        .action(async () => {
            const jsonMode = program.opts().json;
            const { ownId, dir } = accountDir();
            const r = await ask(dir, "resume");
            if (r === null) {
                error("No daemon runs for this account. Start one (mcp start --http, or listen --daemon).");
                process.exit(1);
            }
            if (!r.ok) {
                error(
                    NOT_RUNNING_PRESENCE.test(r.error ?? "")
                        ? "The daemon keeps its socket connected (always-on): there is nothing to resume."
                        : r.error,
                );
                process.exit(1);
            }
            const result = { accountId: ownId, ...r };
            delete result.ok;
            output(result, jsonMode, () => success(`Resumed: ${result.state ?? "waking"}`));
        });
    // Taking the account back closes the other session's socket if it is still open: asked first, as Zalo asks.
    guardSubcommand(presence, "resume", "presence.resume", { target: () => ({ ownerId: activeOwnId() }) });

    for (const cmd of [status, wake, park, resume]) cmd.zaloLocalOnly = true;
    return presence;
}
