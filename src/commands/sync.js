import { getApi } from "../core/zalo-client.js";
import { getActive } from "../core/accounts.js";
import { error, info, success, output } from "../utils/output.js";
import { SyncManager } from "../core/sync.js";

export function registerSyncCommands(program) {
    program
        .command("sync-mobile")
        .description("Trigger a manual sync of messages from your Zalo mobile app.")
        .action(async () => {
            const activeAcc = getActive();
            if (!activeAcc) {
                error("No active account. Please login first.");
                process.exit(1);
            }
            try {
                const api = getApi();
                const syncManager = new SyncManager(api, activeAcc.ownId);

                info("Please open Zalo on your mobile device and navigate to Settings -> Sync Messages -> Sync Now.");
                info("Waiting for sync data from mobile...");

                // Poll every 5 seconds for up to 2 minutes
                let attempts = 0;
                const maxAttempts = 24;
                const pollInterval = setInterval(async () => {
                    attempts++;
                    try {
                        const isRetry = attempts === 1 ? 0 : 1;
                        const res = await api.pullMobileMsg(syncManager.keys.publicKey, 0, isRetry, "");
                        if (res && res.data) {
                            clearInterval(pollInterval);
                            success("\nReceived sync data from mobile!");
                            await syncManager.processSyncData(res.data);
                            // Acknowledge
                            await api.deleteSnapshotMobileMsg(syncManager.keys.publicKey);
                            success("Sync complete.");
                            process.exit(0);
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
