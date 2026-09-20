import { join } from "path";
import { getApi } from "../core/zalo-client.js";
import { getActive } from "../core/accounts.js";
import { CONFIG_DIR } from "../core/credentials.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { error, info, success, warning } from "../utils/output.js";
import { parseIntOption } from "../utils/parse-options.js";
import { SyncManager } from "../core/sync.js";

/** Zalo close code for a duplicate web session (Zalo Web is open elsewhere). */
const CLOSE_DUPLICATE = 3000;

export function registerSyncCommands(program) {
    program
        .command("sync-mobile")
        .description(
            "Backfill recent message history from Zalo's servers into the local cache (zalo.db). " +
                "The old phone-to-PC transfer this command used to perform has been retired by Zalo — " +
                "use --legacy to try it anyway.",
        )
        .option(
            "-F, --force",
            "With --legacy: skip the local 'already synced' shortcut and hit the network anyway (mirrors Zalo Web's own behavior of only re-syncing when it thinks something's missing). The default path has no such shortcut, so this is a no-op without --legacy",
        )
        .option(
            "-L, --legacy",
            "Try the retired pull_mobile_msg/get_crossdb phone-transfer endpoint instead. One attempt only — it pings your mobile app",
        )
        .option("-w, --wait <seconds>", "Give up after this long", parseIntOption, 30)
        .action(async (opts) => {
            const activeAcc = getActive();
            if (!activeAcc) {
                error("No active account. Please login first.");
                process.exit(1);
            }

            if (opts.force && !opts.legacy) {
                warning("--force only affects --legacy; the socket backfill always runs. Ignoring it.");
            }

            if (opts.legacy) {
                await runLegacySync(activeAcc, opts);
                return;
            }
            await runSocketBackfill(activeAcc, opts);
        });
}

/**
 * Best-effort backfill: ask Zalo's servers for old messages over the WebSocket
 * (socket cmd 510 for DMs, 511 for groups) and write whatever comes back into
 * zalo.db.
 *
 * HONEST STATUS, measured 2026-09-20: on the account this was developed
 * against, Zalo answers both commands with an EMPTY set — including when given
 * the exact `lastId` anchors Zalo Web itself sends. Zalo Web gets the same
 * empty answer and then falls back to `transfer-sync-v2` (socket cmd 590/591,
 * libsignal-encrypted), which is the only path observed carrying real data and
 * is NOT implemented here.
 *
 * DO NOT read "no phone contact" as a feature. The phone IS the data source:
 * the account owner confirmed that a real Zalo Web sync makes their phone show
 * a request notification, which means cmd 590 causes the server to wake the
 * phone, and the phone encrypts the payload that comes back as cmd 601. A run
 * of this command that leaves the phone silent has not synced anything.
 *
 * So this is a probe that costs nothing and occasionally may return something,
 * not a restore. What it improves on is harm, not capability: the version it
 * replaced pinged the owner's phone ~24 times per run chasing a retired REST
 * endpoint that could never answer. See tests/NOTES.md § Mobile sync.
 *
 * @param {{ownId: string, name?: string}} activeAcc
 * @param {{wait?: number}} opts
 */
async function runSocketBackfill(activeAcc, opts) {
    const accountDir = join(CONFIG_DIR, "accounts", activeAcc.ownId);

    // The backfill opens a WebSocket and writes to zalo.db, which is exactly
    // what the `listen` daemon does. One socket and one db writer per account.
    if (!acquireLock(accountDir)) {
        error(`A listen daemon is already running for account ${activeAcc.ownId}.`);
        info("Stop it first, or let it keep the cache up to date on its own — it writes the same rows.");
        process.exit(1);
    }

    let api;
    let syncManager;
    try {
        api = getApi();
        syncManager = new SyncManager(api, activeAcc.ownId);
    } catch (err) {
        releaseLock(accountDir);
        error(`Failed: ${err.message}`);
        process.exit(1);
    }

    const waitMs = Math.max(1, Number(opts.wait) || 30) * 1000;
    let exitCode = 1;

    try {
        info("Connecting…");
        const connected = await new Promise((res) => {
            let settled = false;
            const done = (v) => {
                if (settled) return;
                settled = true;
                res(v);
            };
            const timer = setTimeout(() => done({ ok: false, reason: "timeout" }), waitMs);
            api.listener.on("connected", () => {
                clearTimeout(timer);
                done({ ok: true });
            });
            api.listener.on("closed", (code) => {
                clearTimeout(timer);
                done({ ok: false, reason: code === CLOSE_DUPLICATE ? "duplicate" : `closed (${code})` });
            });
            api.listener.on("error", (e) => {
                clearTimeout(timer);
                done({ ok: false, reason: e && e.message ? e.message : "socket error" });
            });
            api.listener.start({ retryOnClose: false });
        });

        if (!connected.ok) {
            if (connected.reason === "duplicate") {
                error("Zalo closed this connection: another web session is already open on this account.");
                info("Zalo allows one web session per account. Sign out of Zalo Web, then run this again.");
            } else {
                error(`Could not open a connection: ${connected.reason}`);
            }
        } else {
            syncManager.markConnected();
            info("Requesting recent history from the server…");
            const res = await syncManager.backfillOverSocket(api.listener, {
                timeoutMs: waitMs,
                onBatch: ({ count, threadType }) => {
                    info(`  received ${count} ${threadType === 0 ? "direct" : "group"} message(s)`);
                },
            });

            if (res.total === 0) {
                warning("No history returned — and your phone was never asked.");
                info(
                    "A real Zalo sync notifies your phone, because the phone is the data source: Zalo Web sends " +
                        "socket cmd 590, the server wakes the phone, the phone encrypts and uploads, and the payload " +
                        "comes back as cmd 601. That handshake (transfer-sync-v2) is NOT implemented here, so the " +
                        "absence of a notification on your phone means no real sync took place.",
                );
                info("See tests/NOTES.md § Mobile sync. To capture messages from now on, run: zalo-agent listen");
                exitCode = 0;
            } else {
                success(`Backfilled ${res.saved}/${res.total} message(s) into the local cache.`);
                if (res.reason === "timeout") {
                    warning("Stopped on the wait limit — re-run with a longer --wait if you expected more.");
                }
                exitCode = 0;
            }
        }
    } catch (err) {
        error(`Failed: ${err.message}`);
    } finally {
        try {
            api.listener.stop();
        } catch {
            // Already closed — nothing to clean up.
        }
        releaseLock(accountDir);
    }

    process.exit(exitCode);
}

/**
 * The retired path, kept behind --legacy so the behavior stays inspectable.
 *
 * `/api/message/pull_mobile_msg` and `/api/message/get_crossdb` are still
 * present in Zalo Web's own bundle but have ZERO call sites in it — the client
 * moved to a WebSocket protocol (cmd 590/591, "transfer-sync-v2"). The
 * endpoints answer with an empty payload rather than an error, which is why
 * this used to look like "the phone hasn't replied yet" and retry for two
 * minutes, putting a notification on the owner's phone each time.
 *
 * It runs exactly once now.
 *
 * @param {{ownId: string}} activeAcc
 * @param {{force?: boolean}} opts
 */
async function runLegacySync(activeAcc, opts) {
    warning(
        "--legacy uses an endpoint Zalo has retired. This pings your mobile app and will most likely find nothing.",
    );
    try {
        const syncManager = new SyncManager(getApi(), activeAcc.ownId);
        const res = await syncManager.pollSync(0, 0, { force: !!opts.force });

        switch (res.status) {
            case "already-synced":
                success("Already synced — no known missed messages since the last successful sync.");
                info("Pass --force to check anyway.");
                process.exit(0);
                break;
            case "saved":
                success(`Synced ${res.saved}/${res.total} message(s) from mobile into the local cache.`);
                process.exit(0);
                break;
            case "empty-or-unrecognized":
                success("Sync round-trip completed — nothing new to save.");
                process.exit(0);
                break;
            case "legacy-retired":
                error("The legacy mobile-sync endpoint returned nothing — Zalo no longer serves it.");
                info("Run `zalo-agent sync-mobile` without --legacy to backfill over the WebSocket instead.");
                process.exit(1);
                break;
            case "crossdb-error":
                error(`Sync failed: ${res.error}`);
                process.exit(1);
                break;
            default:
                error(`Unrecognized sync result: ${res.status}`);
                process.exit(1);
        }
    } catch (err) {
        error(`Failed: ${err.message}`);
        process.exit(1);
    }
}
