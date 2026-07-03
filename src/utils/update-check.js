/**
 * Non-blocking update check — warns user if a newer version is available.
 * Fetches package.json directly from GitHub raw content (never uses the npm
 * registry, which has a conflicting "zalo-agent-cli" package from a third party).
 * Runs asynchronously in the background; never blocks CLI execution.
 */

import https from "node:https";
import { execSync } from "node:child_process";
import { warning } from "./output.js";

/**
 * Check GitHub for the latest version, warn if outdated.
 * Skipped automatically in piped / scripted environments (non-TTY stdout).
 *
 * @param {string} currentVersion - Current package version (from package.json)
 * @param {boolean} jsonMode - Suppress output in JSON mode
 */
export function checkForUpdates(currentVersion, jsonMode) {
    if (jsonMode) return;
    if (!process.stdout.isTTY) return;                   // skip in piped / scripted mode
    if (process.env.ZALO_AGENT_NO_UPDATE_CHECK) return;  // explicit opt-out

    // Fetch directly from GitHub raw content — avoids the unrelated
    // "zalo-agent-cli" package on the npm registry (different project, different version).
    const url =
        "https://raw.githubusercontent.com/ardennguyen/zalo-agent-cli/main/package.json";

    const req = https.get(url, { timeout: 5000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
            try {
                const { version: latest } = JSON.parse(data);
                if (latest && latest !== currentVersion) {
                    warning(
                        `Update available: ${currentVersion} → ${latest}. Run: zalo-agent update`
                    );
                }
            } catch {
                // Silent failure — malformed JSON or unexpected response
            }
        });
    });

    req.on("error", () => {});              // Silent failure — network issues shouldn't block CLI
    req.on("timeout", () => req.destroy()); // Don't hang indefinitely
}

/**
 * Self-update by re-installing from GitHub.
 * @returns {boolean} success
 */
export function selfUpdate() {
    try {
        execSync("npm install -g github:ardennguyen/zalo-agent-cli", {
            encoding: "utf8",
            stdio: "inherit",
            timeout: 60000,
        });
        return true;
    } catch {
        return false;
    }
}
