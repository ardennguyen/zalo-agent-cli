/**
 * Per-account credential storage and configurable runtime storage paths.
 *
 * Defaults:
 *   CONFIG_DIR      = ~/.zalo-agent-cli             (env: ZALO_CONFIG_DIR,      flag: --config-dir)
 *   CREDENTIALS_DIR = <CONFIG_DIR>/credentials      (env: ZALO_CREDENTIALS_DIR, flag: --credentials-dir)
 *   DATA_DIR        = <CONFIG_DIR>/accounts         (env: ZALO_DATA_DIR,        flag: --data-dir)
 *   MEDIA_DIR       = null (<DATA_DIR>/<id>/media)  (env: ZALO_MEDIA_DIR,       flag: --media-dir)
 *
 * All credential files use 0600 permissions (owner read/write only).
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

const defaultConfigDir = join(homedir(), ".zalo-agent-cli");

export let CONFIG_DIR = process.env.ZALO_CONFIG_DIR ? resolve(process.env.ZALO_CONFIG_DIR) : defaultConfigDir;
export let CREDENTIALS_DIR = process.env.ZALO_CREDENTIALS_DIR
    ? resolve(process.env.ZALO_CREDENTIALS_DIR)
    : join(CONFIG_DIR, "credentials");
export let DATA_DIR =
    process.env.ZALO_DATA_DIR || process.env.ZALO_DB_DIR
        ? resolve(process.env.ZALO_DATA_DIR || process.env.ZALO_DB_DIR)
        : join(CONFIG_DIR, "accounts");
export let MEDIA_DIR = process.env.ZALO_MEDIA_DIR ? resolve(process.env.ZALO_MEDIA_DIR) : null;

/**
 * Override storage directories from CLI options or runtime config.
 * Updates live ESM bindings (CONFIG_DIR, CREDENTIALS_DIR, DATA_DIR, MEDIA_DIR)
 * and synchronizes process.env so child helpers see the same paths.
 *
 * @param {object} [opts]
 * @param {string} [opts.configDir] - Root config directory (accounts.json, mcp-config.json, qr.png)
 * @param {string} [opts.credentialsDir] - Credentials directory (cred_<ownId>.json)
 * @param {string} [opts.dataDir] - Per-account runtime/database root (<dataDir>/<ownId>/zalo.db)
 * @param {string} [opts.mediaDir] - Downloaded media root (<mediaDir>/<threadId>/)
 * @param {string} [opts.oaDir] - Official Account credentials directory (oa-credentials.json)
 */
export function configureStoragePaths(opts = {}) {
    if (opts.configDir) {
        CONFIG_DIR = resolve(opts.configDir);
        process.env.ZALO_CONFIG_DIR = CONFIG_DIR;
        if (!opts.credentialsDir && !process.env.ZALO_CREDENTIALS_DIR) {
            CREDENTIALS_DIR = join(CONFIG_DIR, "credentials");
        }
        if (!opts.dataDir && !process.env.ZALO_DATA_DIR && !process.env.ZALO_DB_DIR) {
            DATA_DIR = join(CONFIG_DIR, "accounts");
        }
    }
    if (opts.credentialsDir) {
        CREDENTIALS_DIR = resolve(opts.credentialsDir);
        process.env.ZALO_CREDENTIALS_DIR = CREDENTIALS_DIR;
    }
    if (opts.dataDir) {
        DATA_DIR = resolve(opts.dataDir);
        process.env.ZALO_DATA_DIR = DATA_DIR;
    }
    if (opts.mediaDir !== undefined) {
        MEDIA_DIR = opts.mediaDir ? resolve(opts.mediaDir) : null;
        if (MEDIA_DIR) process.env.ZALO_MEDIA_DIR = MEDIA_DIR;
        else delete process.env.ZALO_MEDIA_DIR;
    }
    if (opts.oaDir) {
        process.env.ZALO_OA_DIR = resolve(opts.oaDir);
    }
}

/**
 * Get the per-account runtime/database directory (<DATA_DIR>/<ownId>).
 * @param {string} ownId
 * @returns {string}
 */
export function getAccountDir(ownId) {
    return join(DATA_DIR, String(ownId));
}

/**
 * Get the per-account SQLite database path (<DATA_DIR>/<ownId>/zalo.db).
 * @param {string} ownId
 * @returns {string}
 */
export function getAccountDbPath(ownId) {
    return join(getAccountDir(ownId), "zalo.db");
}

/**
 * Resolve the media root directory for an account.
 * Precedence: explicit override -> MEDIA_DIR (--media-dir / ZALO_MEDIA_DIR) -> <accountDir>/media.
 * @param {string} accountDir
 * @param {string|null} [overrideRoot]
 * @returns {string}
 */
export function resolveMediaRoot(accountDir, overrideRoot = null) {
    const custom = overrideRoot || MEDIA_DIR;
    return custom ? resolve(custom) : resolve(accountDir, "media");
}

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
