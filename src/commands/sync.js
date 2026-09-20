import { getApi } from "../core/zalo-client.js";
import { getActive } from "../core/accounts.js";
import { error, info, success, output } from "../utils/output.js";
import { parseIntOption } from "../utils/parse-options.js";
import { SyncManager } from "../core/sync.js";

/**
 * Write a progress tick.
 *
 * These are pure human chatter, so they must never reach stdout in machine
 * mode — a stream of dots in front of a JSON payload is exactly the kind of
 * thing that breaks `| jq`. See src/utils/output.js for the stdout contract.
 */
function progress(ch) {
    if (process.env.ZALO_JSON_MODE) process.stderr.write(ch);
    else process.stdout.write(ch);
}

export function registerSyncCommands(program) {
    program
        .command("sync-mobile")
        .description(
            "Trigger a manual sync of messages from your Zalo mobile app, and save results into the local cache (zalo.db).",
        )
        .option(
            "-F, --force",
            "Skip the local 'already synced' shortcut and always hit the mobile-sync API (mirrors Zalo Web's own behavior of only re-pinging the phone when it actually thinks something's missing)",
        )
        .option("-w, --wait <seconds>", "Give up after this long (default: 120)", parseIntOption, 120)
        .option("-i, --interval <seconds>", "Seconds between attempts (default: 10)", parseIntOption, 10)
        .action(async (opts) => {
            const activeAcc = getActive();
            if (!activeAcc) {
                error("No active account. Please login first.");
                process.exit(1);
            }
            try {
                const api = getApi();
                const syncManager = new SyncManager(api, activeAcc.ownId);

                // First attempt respects the local debounce cache (task #3):
                // if we have no known coverage gap and our last known
                // connection state was healthy, this returns instantly
                // without pinging the phone at all — same shortcut Zalo Web
                // itself takes when you click "Sync" twice in one session.
                const first = await syncManager.pollSync(0, 0, { force: !!opts.force });

                if (first.status === "already-synced") {
                    success("Already synced — no known missed messages since the last successful sync.");
                    info("Pass --force to check the mobile app anyway.");
                    process.exit(0);
                }
                if (first.status === "saved") {
                    success(`Synced ${first.saved}/${first.total} message(s) from mobile into the local cache.`);
                    success("Sync complete.");
                    process.exit(0);
                }
                if (first.status === "empty-or-unrecognized") {
                    success("Sync round-trip completed — nothing new to save.");
                    process.exit(0);
                }
                if (first.status === "crossdb-error") {
                    error(`Sync failed: ${first.error}`);
                    process.exit(1);
                }

                // Only "no-token" (pullMobileMsg itself returned nothing —
                // the phone may need a moment) falls through to a bounded
                // retry loop. Every retry here forces a real check: once the
                // first successful round-trip completes it marks us
                // "caught up" internally, so retries must bypass that cache
                // or they'd short-circuit to "already-synced" instead of
                // actually trying again.
                info("Please open Zalo on your mobile device and navigate to Settings -> Sync Messages -> Sync Now.");
                info("Waiting for sync data from mobile...");

                // Poll SEQUENTIALLY — each attempt starts only after the
                // previous one has finished, then waits the interval.
                //
                // This used to be `setInterval(async () => { await pollSync() }, 5000)`,
                // which does NOT wait for its async callback. pollSync() is a
                // network round-trip that pushes a notification to the user's
                // phone and routinely takes longer than 5s, so attempts
                // overlapped and piled up — the phone received several
                // simultaneous sync requests per tick instead of one every 5s.
                // Reported by a user as "hitting my phone simultaneously over
                // and over", and it is exactly that.
                //
                // Every ping here is a real interruption on someone's device,
                // so the loop is bounded, sequential, and stops at the first
                // success.
                // Each attempt is a real notification on the user's phone, so
                // the interval defaults to 10s rather than the original 5s,
                // and both the interval and the total budget are now the
                // caller's choice via --interval / --wait.
                const intervalMs = Math.max(1, Number(opts.interval) || 10) * 1000;
                const maxAttempts = Math.max(1, Math.floor(((Number(opts.wait) || 120) * 1000) / intervalMs));
                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

                info(
                    `Checking every ${intervalMs / 1000}s for up to ${Math.round((maxAttempts * intervalMs) / 1000)}s ` +
                        `(${maxAttempts} attempt(s)). Each attempt pings your phone — Ctrl-C to stop early.`,
                );

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    await sleep(intervalMs);

                    try {
                        const result = await syncManager.pollSync(0, 1, { force: true });

                        if (result.status === "saved") {
                            success(
                                `\nSynced ${result.saved}/${result.total} message(s) from mobile into the local cache.`,
                            );
                            success("Sync complete.");
                            process.exit(0);
                        } else if (result.status === "crossdb-error") {
                            progress("x");
                        } else {
                            progress(".");
                        }
                    } catch (e) {
                        // "Tham số không hợp lệ" usually means no sync available yet
                        if (e.message.includes("Tham số không hợp lệ")) {
                            progress(".");
                        } else {
                            error(`\nSync error: ${e.message}`);
                        }
                    }
                }

                error("\nTimeout waiting for sync data from mobile.");
                process.exit(1);
            } catch (err) {
                error(`Failed: ${err.message}`);
                process.exit(1);
            }
        });
}
