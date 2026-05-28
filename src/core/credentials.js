/**
 * Per-account credential storage at ~/.zalo-agent-cli/credentials/
 * All credential files use 0600 permissions (owner read/write only).
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const CONFIG_DIR = join(homedir(), ".zalo-agent-cli");
export const CREDENTIALS_DIR = join(CONFIG_DIR, "credentials");

/** Ensure config directories exist. */
function ensureDirs() {
    mkdirSync(CREDENTIALS_DIR, { recursive: true });
}

function credPath(ownId) {
    return join(CREDENTIALS_DIR, `cred_${ownId}.json`);
}

/**
 * Save credentials for a specific account.
 * @param {string} ownId
 * @param {object} creds - {imei, cookie, userAgent, language?}
 * @returns {string} File path
 */
export function saveCredentials(ownId, creds) {
    ensureDirs();
    const target = credPath(ownId);
    writeFileSync(target, JSON.stringify(creds, null, 2), "utf-8");
    chmodSync(target, 0o600);
    return target;
}

/**
 * Load credentials for a specific account.
 * @param {string} ownId
 * @returns {object|null}
 */
export function loadCredentials(ownId) {
    const target = credPath(ownId);
    if (!existsSync(target)) return null;
    try {
        return JSON.parse(readFileSync(target, "utf-8"));
    } catch {
        return null;
    }
}

/**
 * Delete credentials for a specific account.
 * @param {string} ownId
 * @returns {boolean}
 */
export function deleteCredentials(ownId) {
    const target = credPath(ownId);
    if (existsSync(target)) {
        unlinkSync(target);
        return true;
    }
    return false;
}
