import { getApi } from "../core/zalo-client.js";
import { getActive } from "../core/accounts.js";
import { error, info, success, output } from "../utils/output.js";
import { SyncManager } from "../core/sync.js";

export function registerSyncCommands(program) {
    program
        .command("sync-mobile")
        .description("Trigger a manual sync of messages from your Zalo mobile app, and save results into the local cache (zalo.db).")
        .option(
            "-F, --force",
            "Skip the local 'already synced' shortcut and always hit the mobile-sync API (mirrors Zalo Web's own behavior of only re-pinging the phone when it actually thinks something's missing)",
        )
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

                let attempts = 0;
                const maxAttempts = 24; // ~2 minutes at 5s intervals
                const pollInterval = setInterval(async () => {
                    attempts++;
                    try {
                        const result = await syncManager.pollSync(0, 1, { force: true });

                        if (result.status === "saved") {
                            clearInterval(pollInterval);
                            success(`\nSynced ${result.saved}/${result.total} message(s) from mobile into the local cache.`);
                            success("Sync complete.");
                            process.exit(0);
                        } else if (result.status === "empty-or-unrecognized") {
                            process.stdout.write(".");
                        } else if (result.status === "crossdb-error") {
                            process.stdout.write("x");
                        } else {
                            process.stdout.write(".");
                        }
                    } catch (e) {
                        // "Tham số không hợp lệ" usually means no sync available yet
                        if (e.message.includes("Tham số không hợp lệ")) {
                            process.stdout.write(".");
                        } else {
                            error(`\nSync error: ${e.message}`);
                        }
                    }

                    if (attempts >= maxAttempts) {
                        clearInterval(pollInterval);
                        error("\nTimeout waiting for sync data from mobile.");
                        process.exit(1);
                    }
                }, 5000);
            } catch (err) {
                error(`Failed: ${err.message}`);
                process.exit(1);
            }
        });
}
