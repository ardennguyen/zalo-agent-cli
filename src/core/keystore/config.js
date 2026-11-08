/**
 * Where the key layer's settings come from: `<config-dir>/storage.json`, then environment variables (which win, so a
 * fleet's per-account env file can set one account apart).
 *
 *     {
 *       "provider": "dpapi",                         // ZALO_STORAGE_PROVIDER
 *       "dkeyLayer": false,                          // ZALO_STORAGE_DKEY_LAYER=1|0
 *       "accounts": { "<ownId>": { "dkeyLayer": true, "kms": { "key": "…" } } },   // one account apart
 *       "dpapi": { "scope": "CurrentUser" },         // or "LocalMachine"; ZALO_DPAPI_SCOPE
 *       "systemdCreds": { "withKey": "auto" },       // host | tpm2 | host+tpm2 | auto; ZALO_SYSTEMD_CREDS_WITH_KEY
 *       "kms": { "backend": "aws", "key": "…" },     // aws | gcp | azure | vault; ZALO_KMS_BACKEND, ZALO_KMS_KEY
 *       "passphrase": { "file": "/path" },           // ZALO_STORAGE_PASSPHRASE_FILE
 *       "env": { "variable": "ZALO_STORAGE_KEY" },   // the variable that holds the key (base64, 32 bytes)
 *       "rowMac": { "verifyOnRead": "actions" }      // or "off": actions check a cached row's MAC (../row-mac.js)
 *     }
 *
 * A provider section under `accounts.<ownId>` (a tenant's KMS key) is the most specific setting: it beats the top level
 * and the environment for that account, so every process (the daemon, `za`, the purge and backup units) picks the same
 * key without reading the account's env file. A keyring also records the key that wraps it, and that one opens it
 * (./keyring.js), whatever the default is now.
 *
 * mcp-config.json is the MCP server's own file; the key layer serves every command, so it has its own. The file holds
 * no secret: only names of providers, key ids and paths.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../credentials.js";
import { writeFileAtomic } from "../../zalo/kernel/atomic-file.js";
import { KeystoreError } from "./container.js";

/** Every provider name the key layer knows. */
export const PROVIDER_NAMES = [
    "dpapi",
    "keychain",
    "secret-service",
    "systemd-creds",
    "kms",
    "passphrase",
    "env",
    "test",
];

/** @returns {string} */
export function storageConfigFile() {
    return join(CONFIG_DIR, "storage.json");
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v).trim());
const falsy = (v) => /^(0|false|no|off)$/i.test(String(v).trim());

/**
 * The file's settings, as written (empty when there is no file).
 *
 * @returns {object}
 * @throws {Error} when the file exists but is not a JSON object: a setting that might make the layer weaker is never
 *   guessed
 */
export function readStorageFile() {
    const file = storageConfigFile();
    if (!existsSync(file)) return {};
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
        throw new KeystoreError(`${file} is not valid JSON (${e.message}); fix or remove it`, "CONFIG");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new KeystoreError(`${file} must hold a JSON object`, "CONFIG");
    return parsed;
}

/**
 * Save the file's settings (non-secret values only).
 *
 * @param {object} settings
 */
export function writeStorageFile(settings) {
    writeFileAtomic(storageConfigFile(), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

/**
 * The settings in effect: the file, with the environment on top.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{provider: string|null, dkeyLayer: boolean, accounts: object, options: Record<string, object>}}
 */
export function loadStorageConfig(env = process.env) {
    const file = readStorageFile();
    const options = {
        dpapi: { ...(file.dpapi ?? {}) },
        "systemd-creds": { ...(file.systemdCreds ?? {}) },
        kms: { ...(file.kms ?? {}) },
        passphrase: { ...(file.passphrase ?? {}) },
        env: { ...(file.env ?? {}) },
        keychain: { ...(file.keychain ?? {}) },
        "secret-service": { ...(file.secretService ?? {}) },
        test: {},
    };
    if (env.ZALO_DPAPI_SCOPE) options.dpapi.scope = env.ZALO_DPAPI_SCOPE;
    if (env.ZALO_SYSTEMD_CREDS_WITH_KEY) options["systemd-creds"].withKey = env.ZALO_SYSTEMD_CREDS_WITH_KEY;
    if (env.ZALO_KMS_BACKEND) options.kms.backend = env.ZALO_KMS_BACKEND;
    if (env.ZALO_KMS_KEY) options.kms.key = env.ZALO_KMS_KEY;
    if (env.ZALO_STORAGE_PASSPHRASE_FILE) options.passphrase.file = env.ZALO_STORAGE_PASSPHRASE_FILE;

    const provider = env.ZALO_STORAGE_PROVIDER?.trim() || (typeof file.provider === "string" ? file.provider : null);
    if (provider && !PROVIDER_NAMES.includes(provider)) {
        throw new KeystoreError(
            `unknown key provider "${provider}" (known: ${PROVIDER_NAMES.filter((p) => p !== "test").join(", ")})`,
            "CONFIG",
        );
    }
    let dkeyLayer = file.dkeyLayer === true;
    if (env.ZALO_STORAGE_DKEY_LAYER !== undefined && env.ZALO_STORAGE_DKEY_LAYER !== "") {
        if (truthy(env.ZALO_STORAGE_DKEY_LAYER)) dkeyLayer = true;
        else if (falsy(env.ZALO_STORAGE_DKEY_LAYER)) dkeyLayer = false;
        else
            throw new KeystoreError(
                `ZALO_STORAGE_DKEY_LAYER must be 1 or 0, not "${env.ZALO_STORAGE_DKEY_LAYER}"`,
                "CONFIG",
            );
    }
    const accounts = file.accounts && typeof file.accounts === "object" ? file.accounts : {};
    return { provider, dkeyLayer, accounts, options, envOverride: env.ZALO_STORAGE_DKEY_LAYER };
}

/** The `storage.json` section name of each provider's options (top level and under `accounts.<ownId>`). */
export const PROVIDER_SECTIONS = Object.freeze({
    dpapi: "dpapi",
    "systemd-creds": "systemdCreds",
    kms: "kms",
    passphrase: "passphrase",
    env: "env",
    keychain: "keychain",
    "secret-service": "secretService",
});

/**
 * A provider's options for one account: the top level (file, then environment), then the account's own section.
 *
 * @param {ReturnType<typeof loadStorageConfig>} config
 * @param {string} name - the provider
 * @param {string|null} [ownId]
 * @returns {object}
 */
export function providerOptionsFor(config, name, ownId = null) {
    const base = { ...(config.options?.[name] ?? {}) };
    const section = PROVIDER_SECTIONS[name];
    const own = ownId !== null && ownId !== undefined && section ? config.accounts?.[String(ownId)]?.[section] : null;
    return own && typeof own === "object" && !Array.isArray(own) ? { ...base, ...own } : base;
}

/**
 * Whether the dkey layer is wanted for one account: the environment, else the account's own entry, else the default.
 *
 * @param {ReturnType<typeof loadStorageConfig>} config
 * @param {string} ownId
 * @returns {boolean}
 */
export function dkeyLayerWanted(config, ownId) {
    if (config.envOverride !== undefined && config.envOverride !== "") return config.dkeyLayer;
    const own = config.accounts?.[String(ownId)]?.dkeyLayer;
    return typeof own === "boolean" ? own : config.dkeyLayer;
}
