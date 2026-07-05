/**
 * Non-blocking update check — warns user if a newer version is available on npm.
 * Runs silently in background; never blocks CLI execution.
 */

import { execSync } from "node:child_process";
import { warning } from "./output.js";

/**
 * Check npm registry for the latest version, warn if outdated.
 * Uses "npm view @ardennguyen/zalo-agent-cli version" to fetch from the npm registry.
 *
 * Skipped automatically when stdout is piped (e.g. tests, scripts, JSON mode, MCP).
 *
 * @param {string} currentVersion - Current package version (from package.json)
 * @param {boolean} jsonMode - Suppress output in JSON mode
 */
export function checkForUpdates(currentVersion, jsonMode) {
    if (jsonMode) return;
    if (!process.stdout.isTTY) return; // skip in piped / scripted mode
    if (process.env.ZALO_AGENT_NO_UPDATE_CHECK) return; // explicit opt-out

    try {
        const latest = execSync("npm view @ardennguyen/zalo-agent-cli version", {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        }).trim();

        if (latest && latest !== currentVersion) {
            warning(
                `Update available: ${currentVersion} → ${latest}. Run: npm install -g @ardennguyen/zalo-agent-cli@latest`,
            );
        }
    } catch {
        // Silent failure — network issues shouldn't block CLI usage
    }
}

/**
 * Self-update by re-installing the latest version from npm registry.
 * @returns {boolean} success
 */
export function selfUpdate() {
    try {
        execSync("npm install -g @ardennguyen/zalo-agent-cli@latest", {
            encoding: "utf8",
            stdio: "inherit",
            timeout: 60000,
        });
        return true;
    } catch {
        return false;
    }
}
