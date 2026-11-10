/**
 * Per-account credential storage and configurable runtime storage paths.
 *
 * Defaults:
 *   CONFIG_DIR      = ~/.zalo-agent-cli             (env: ZALO_CONFIG_DIR,      flag: --config-dir)
 *   CREDENTIALS_DIR = <CONFIG_DIR>/credentials      (env: ZALO_CREDENTIALS_DIR, flag: --credentials-dir)
 *   DATA_DIR        = <CONFIG_DIR>/accounts         (env: ZALO_DATA_DIR,        flag: --data-dir)
 *   MEDIA_DIR       = null (<DATA_DIR>/<id>/media)  (env: ZALO_MEDIA_DIR,       flag: --media-dir)
 *
 * All credential files use 0600 permissions (owner read/write only), and since 3.0.0 they are sealed under the
 * account's boot key (src/core/keystore/): a copied file is unreadable without the key provider of this machine.
 */

import { readFileSync, unlinkSync, existsSync, mkdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { parseEnv } from "node:util";
import { openFile, sealFile } from "./keystore/index.js";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";
import { sessionExpiryOf } from "./session-expiry.js";

const defaultConfigDir = join(homedir(), ".zalo-agent-cli");

/**
 * Load environment variables from `.env` files without overwriting existing `process.env` keys.
 * Search order (first defined value wins):
 *   1. Explicit `envFile` (`--env-file <path>` or `ZALO_ENV_FILE`)
 *   2. `<cwd>/.env` (skipped when `ZALO_SANDBOX_ACTIVE=1` so offline tests stay isolated)
 *   3. `<configDir>/.env` (default `~/.zalo-agent-cli/.env`)
 *
 * @param {object} [opts]
 * @param {string} [opts.envFile]
 * @param {string} [opts.configDir]
 * @returns {string[]} Paths of `.env` files that were loaded
 */
export function loadDotEnvFiles(opts = {}) {
    const candidates = [];
    const explicit = opts.envFile || process.env.ZALO_ENV_FILE;
    if (explicit) candidates.push(resolve(explicit));
    if (process.env.ZALO_SANDBOX_ACTIVE !== "1") {
        candidates.push(resolve(process.cwd(), ".env"));
    }
    const cfgRoot = opts.configDir
        ? resolve(opts.configDir)
        : process.env.ZALO_CONFIG_DIR
          ? resolve(process.env.ZALO_CONFIG_DIR)
          : defaultConfigDir;
    candidates.push(join(cfgRoot, ".env"));

    const loaded = [];
    const seen = new Set();
    for (const filePath of candidates) {
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        if (!existsSync(filePath)) continue;
        try {
            const parsed = parseEnv(readFileSync(filePath, "utf-8"));
            for (const [k, v] of Object.entries(parsed)) {
                if (process.env[k] === undefined) {
                    process.env[k] = v;
                }
            }
            loaded.push(filePath);
        } catch {
            /* ignore unreadable .env file */
        }
    }
    return loaded;
}

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
 * Override storage directories from CLI options, `.env` files, or runtime config.
 * Updates live ESM bindings (CONFIG_DIR, CREDENTIALS_DIR, DATA_DIR, MEDIA_DIR)
 * and synchronizes process.env so child helpers see the same paths.
 *
 * @param {object} [opts]
 * @param {string} [opts.envFile] - Optional explicit `.env` file path (`--env-file` / `ZALO_ENV_FILE`)
 * @param {boolean} [opts.loadEnv=true] - Whether to load `.env` files before resolving paths
 * @param {string} [opts.configDir] - Root config directory (accounts.json, mcp-config.json, qr.png)
 * @param {string} [opts.credentialsDir] - Credentials directory (cred_<ownId>.json)
 * @param {string} [opts.dataDir] - Per-account runtime/database root (<dataDir>/<ownId>/zalo.db)
 * @param {string} [opts.mediaDir] - Downloaded media root (<mediaDir>/<threadId>/)
 * @param {string} [opts.oaDir] - Official Account credentials directory (oa-credentials.json)
 */
export function configureStoragePaths(opts = {}) {
    if (opts.loadEnv !== false) {
        loadDotEnvFiles({ envFile: opts.envFile, configDir: opts.configDir });
    }

    const nextConfig = opts.configDir || process.env.ZALO_CONFIG_DIR;
    if (nextConfig) {
        CONFIG_DIR = resolve(nextConfig);
        if (opts.configDir) process.env.ZALO_CONFIG_DIR = CONFIG_DIR;
    }

    const nextCreds = opts.credentialsDir || process.env.ZALO_CREDENTIALS_DIR;
    if (nextCreds) {
        CREDENTIALS_DIR = resolve(nextCreds);
        if (opts.credentialsDir) process.env.ZALO_CREDENTIALS_DIR = CREDENTIALS_DIR;
    } else if (nextConfig) {
        CREDENTIALS_DIR = join(CONFIG_DIR, "credentials");
    }

    const nextData = opts.dataDir || process.env.ZALO_DATA_DIR || process.env.ZALO_DB_DIR;
    if (nextData) {
        DATA_DIR = resolve(nextData);
        if (opts.dataDir) process.env.ZALO_DATA_DIR = DATA_DIR;
    } else if (nextConfig) {
        DATA_DIR = join(CONFIG_DIR, "accounts");
    }

    if (opts.mediaDir !== undefined) {
        MEDIA_DIR = opts.mediaDir ? resolve(opts.mediaDir) : null;
        if (MEDIA_DIR) process.env.ZALO_MEDIA_DIR = MEDIA_DIR;
        else delete process.env.ZALO_MEDIA_DIR;
    } else if (process.env.ZALO_MEDIA_DIR) {
        MEDIA_DIR = resolve(process.env.ZALO_MEDIA_DIR);
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

/** What the key layer calls the saved login: sealed under the boot key, which opens without a login. */
const CRED_SPEC = { kind: "credentials", use: "boot" };

/**
 * What this machine last saved for an account's device: the imei, when that device id was first used here
 * (`deviceSince`, ms), and when the file was last written (`mtime`, ms).
 *
 * Zalo keeps the offline queue per device (imei): a new device's queue starts at its login, so the time a device id
 * was first used bounds what Zalo's queue can give back (agent research: offline-queue retention §4). Never throws.
 *
 * @param {string} ownId
 * @returns {{state: "none"|"unreadable"|"ok", imei?: string|null, deviceSince?: number|null, mtime?: number|null}}
 *   `none` when nothing is saved, `unreadable` when a file exists but cannot be opened or parsed
 */
export function readSavedDevice(ownId) {
    const target = credPath(ownId);
    if (!existsSync(target)) return { state: "none" };
    try {
        const mtime = statSync(target).mtimeMs;
        const bytes = openFile(target, String(ownId), CRED_SPEC);
        if (bytes === null) return { state: "none" };
        const creds = JSON.parse(bytes.toString("utf8"));
        const since = Number(creds?.deviceSince);
        return {
            state: "ok",
            imei: typeof creds?.imei === "string" && creds.imei ? creds.imei : null,
            deviceSince: Number.isFinite(since) && since > 0 ? since : null,
            mtime: Number.isFinite(mtime) ? Math.floor(mtime) : null,
        };
    } catch {
        return { state: "unreadable" };
    }
}

/**
 * The `deviceSince` a save should carry: the time this device id was first used for the account here.
 *
 * - Same imei as the saved login: the saved stamp. A login saved before stamps existed has none; its file's last write
 *   is used instead. That is never earlier than the imei's first use (every save rewrites the file), so coverage is
 *   never claimed from before the device existed.
 * - Nothing saved, and the new credentials carry their own stamp (an exported login, with its imei): that stamp.
 * - Anything else (a new or changed imei, or a saved login that cannot be read): now. A new device.
 *
 * @param {{state: string, imei?: string|null, deviceSince?: number|null, mtime?: number|null}} prev - readSavedDevice()
 * @param {{imei?: string, deviceSince?: number}} creds - what is being saved
 * @param {number} now
 * @returns {number}
 */
export function deviceSinceFor(prev, creds, now) {
    const imei = typeof creds?.imei === "string" && creds.imei ? creds.imei : null;
    if (prev?.state === "ok" && imei && prev.imei === imei) {
        if (Number.isFinite(prev.deviceSince) && prev.deviceSince > 0) return Math.min(prev.deviceSince, now);
        if (Number.isFinite(prev.mtime) && prev.mtime > 0) return Math.min(prev.mtime, now);
        return now;
    }
    const carried = Number(creds?.deviceSince);
    if (prev?.state === "none" && imei && Number.isFinite(carried) && carried > 0 && carried <= now) return carried;
    return now;
}

/**
 * Save credentials for a specific account, sealed. Stamps `deviceSince` (see {@link deviceSinceFor}): kept while
 * the imei stays the same, set to now when it changes. Every login path saves through here.
 * @param {string} ownId
 * @param {object} creds - {imei, cookie, userAgent, language?}
 * @param {{now?: number}} [opts]
 * @returns {string} File path
 * @throws {Error} a KeystoreError when no key can be had: the login is then not saved at all, never in the clear
 */
export function saveCredentials(ownId, creds, { now = Date.now() } = {}) {
    ensureDirs();
    const target = credPath(ownId);
    const deviceSince = deviceSinceFor(readSavedDevice(ownId), creds, now);
    // Sealed, atomic and created at 0600: a login is never left half written, and never readable by others.
    sealFile(target, String(ownId), CRED_SPEC, JSON.stringify({ ...creds, deviceSince }, null, 2));
    noteSessionEnd(ownId, creds?.cookie);
    return target;
}

/** The account folder's session-end marker (src/core/session-notice.js SESSION_NOTICE_FILE). */
const SESSION_MARKER = "session-notice.json";

/**
 * Record when the login just saved ends, in the account folder's marker, so `fleet status` shows it before the
 * account's daemon has ever run (the marker needs no key to read). A new end resets the thresholds already sent;
 * the same end leaves the marker alone. Best effort: a marker that cannot be written never fails a login.
 *
 * @param {string} ownId
 * @param {unknown} jar - the saved cookie jar
 */
function noteSessionEnd(ownId, jar) {
    try {
        const end = sessionExpiryOf(jar);
        if (!end) return;
        const file = join(getAccountDir(ownId), SESSION_MARKER);
        let prev = null;
        try {
            prev = JSON.parse(readFileSync(file, "utf8"));
        } catch {
            prev = null;
        }
        if (prev?.expiresAt === end.expiresAt) return;
        mkdirSync(getAccountDir(ownId), { recursive: true });
        writeFileAtomic(file, JSON.stringify({ expiresAt: end.expiresAt, threshold: null }) + "\n", { mode: 0o600 });
    } catch {
        // The daemon's watch writes it on its first look.
    }
}

/**
 * Load credentials for a specific account. A plaintext file from before 3.0.0 is sealed on the way.
 * @param {string} ownId
 * @returns {object|null} null when there are none (or the file is not JSON)
 * @throws {Error} a KeystoreError / SealError when the file exists but cannot be opened (no provider, wrong key,
 *   edited): saying "not logged in" then would send people to a QR login that would not fix it
 */
export function loadCredentials(ownId) {
    const target = credPath(ownId);
    if (!existsSync(target)) return null;
    const bytes = openFile(target, String(ownId), CRED_SPEC);
    if (bytes === null) return null;
    try {
        return JSON.parse(bytes.toString("utf8"));
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
