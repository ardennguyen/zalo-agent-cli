/**
 * Non-blocking update check — warns user if a newer version is available on GitHub.
 * Runs silently in background; never blocks CLI execution.
 */

import { execSync } from "node:child_process";
import { warning } from "./output.js";

/**
 * Check GitHub for the latest version, warn if outdated.
 * Uses "npm view github:<owner>/<repo>" to fetch directly from the GitHub repository,
 * NOT from the npm registry (a different, unrelated "zalo-agent-cli" package exists there).
 *
 * Skipped automatically when stdout is piped (e.g. tests, scripts, JSON mode, MCP).
 *
 * @param {string} currentVersion - Current package version (from package.json)
 * @param {boolean} jsonMode - Suppress output in JSON mode
 */
export function checkForUpdates(currentVersion, jsonMode) {
    if (jsonMode) return;
    if (!process.stdout.isTTY) return;                   // skip in piped / scripted mode
    if (process.env.ZALO_AGENT_NO_UPDATE_CHECK) return;  // explicit opt-out

    try {
        // "github:owner/repo" routes npm to GitHub, not the npm registry.
        // NOTE: avoid "npm view zalo-agent-cli version" — that hits the npm registry
        // where an unrelated project with the same name is published at a different version.
        const latest = execSync(
            "npm view github:ardennguyen/zalo-agent-cli version",
            {
                encoding: "utf8",
                timeout: 5000,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            }
        ).trim();

        if (latest && latest !== currentVersion) {
            warning(
                `Update available: ${currentVersion} → ${latest}. Run: zalo-agent update`
            );
        }
    } catch {
        // Silent failure — network issues shouldn't block CLI usage
    }
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
