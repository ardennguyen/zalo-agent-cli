/**
 * Non-blocking update check — warns user if a newer version is available on npm.
 * Runs silently in background; never blocks CLI execution.
 */

import { execSync } from "node:child_process";
import { warning } from "./output.js";

/**
 * Parse "1.2.3", "1.2.3-dev", "1.2" etc. into a comparable shape: a
 * zero-padded [major, minor, patch] tuple plus any pre-release suffix.
 * @param {string} v
 */
function parseVersion(v) {
    const [core, prerelease = ""] = String(v).trim().split("-", 2);
    const parts = core.split(".").map((n) => parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return { parts, prerelease };
}

/**
 * True if `candidate` is a genuinely newer version than `base` — proper
 * numeric major.minor.patch comparison, not string inequality. Also
 * respects basic semver pre-release precedence: a plain release outranks a
 * pre-release of the same core version (e.g. 2.0.0 > 2.0.0-dev), and a
 * pre-release never outranks a later release with the same core (e.g.
 * 1.0.7 is NOT newer than 2.0.0-dev — this is the exact case that used to
 * misfire as a "downgrade" suggestion, since 2.0.0-dev's core (2.0.0)
 * outranks 1.0.7 regardless of the pre-release tag).
 * @param {string} candidate
 * @param {string} base
 */
export function isNewerVersion(candidate, base) {
    const a = parseVersion(candidate);
    const b = parseVersion(base);
    for (let i = 0; i < 3; i++) {
        if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i];
    }
    // Same major.minor.patch core — only the pre-release tag differs.
    if (a.prerelease === b.prerelease) return false;
    if (a.prerelease === "") return true; // candidate is a full release of this core, base is a pre-release of it
    if (b.prerelease === "") return false; // base is already a full release of this core
    return a.prerelease > b.prerelease; // both pre-release: rough lexical fallback
}

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

        // Was `latest !== currentVersion`, which fires just as readily for
        // a downgrade (e.g. this exact case: a local 2.0.0-dev checkout
        // ahead of the 1.0.7 currently published to npm) as for a real
        // update. Only warn when npm's version is an actual newer version.
        if (latest && isNewerVersion(latest, currentVersion)) {
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
