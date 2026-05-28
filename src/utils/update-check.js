/**
 * Non-blocking update check — warns user if a newer version is available on npm.
 * Runs silently in background; never blocks CLI execution.
 */

import { execSync } from "node:child_process";
import { warning } from "./output.js";

/**
 * Check npm registry for latest version, warn if outdated.
 * @param {string} currentVersion - Current package version
 * @param {boolean} jsonMode - Suppress output in JSON mode
 */
export function checkForUpdates(currentVersion, jsonMode) {
    if (jsonMode) return;

    try {
        const latest = execSync("npm view zalo-agent-cli version", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();

        if (latest && latest !== currentVersion) {
            warning(`Update available: ${currentVersion} → ${latest}. Run: zalo-agent update`);
        }
    } catch {
        // Silent failure — network issues shouldn't block CLI usage
    }
}

/**
 * Self-update by running npm install -g.
 * @returns {boolean} success
 */
export function selfUpdate() {
    try {
        execSync("npm install -g zalo-agent-cli@latest", {
            encoding: "utf8",
            stdio: "inherit",
            timeout: 60000,
        });
        return true;
    } catch {
        return false;
    }
}
