/**
 * The account's zCloud cloud key, sealed at rest and reused.
 *
 * The cloud key is an RSA private key (PKCS#8) that opens encrypted zCloud items. Until now a person supplied it at run
 * time every time (`cloud get --key-stdin` / `--key-prompt`) and it was never stored. Once the key has been obtained
 * (from the phone, over the end-to-end-encryption device path — src/core/cloud-key-transfer.js), it is sealed here under
 * the account's data key, exactly like the voice-text file, and loaded transparently by `cloud get`,
 * `sync-media --from-zcloud` and the `zalo_view_media` MCP tool so it need not be re-supplied.
 *
 * SECRETS: the key is written only sealed (0600, data key). Nothing here logs, prints or returns it except
 * {@link loadCloudKey}, which the download path calls to open an item in memory; {@link cloudKeyStatus} never returns a
 * key byte.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAccountDir } from "./credentials.js";
import { openFile, scopeOf, sealFile } from "./keystore/index.js";

const SPEC = { kind: "cloud-key", use: "data" };

/**
 * Where an account's sealed cloud key lives.
 *
 * @param {string} ownId
 * @returns {string}
 */
export function cloudKeyFile(ownId) {
    return join(getAccountDir(String(ownId)), "cloud-key.json");
}

/**
 * Seal and store the cloud key for an account.
 *
 * @param {string} ownId
 * @param {{privateKeyPkcs8Base64: string, keyVersion?: *, publicKey?: *}} key
 * @param {() => number} [now]
 */
export function saveCloudKey(ownId, { privateKeyPkcs8Base64, keyVersion = null, publicKey = null }, now = Date.now) {
    if (!privateKeyPkcs8Base64) throw new Error("no cloud key to store");
    const file = cloudKeyFile(ownId);
    sealFile(
        file,
        scopeOf(String(ownId)),
        SPEC,
        JSON.stringify({ privateKeyPkcs8Base64: String(privateKeyPkcs8Base64), keyVersion, publicKey, savedAt: now() }),
    );
}

/**
 * The stored cloud key for an account, or null when there is none. Held in memory by the caller only.
 *
 * @param {string} ownId
 * @returns {{privateKeyPkcs8Base64: string, keyVersion: *, publicKey: *, savedAt: number}|null}
 * @throws {Error} a KeystoreError when the file is there but its key is not (locked): "no key" would be the wrong answer
 */
export function loadCloudKey(ownId) {
    const file = cloudKeyFile(ownId);
    const bytes = openFile(file, scopeOf(String(ownId)), SPEC);
    if (bytes === null) return null;
    const parsed = JSON.parse(bytes.toString("utf8"));
    return parsed?.privateKeyPkcs8Base64 ? parsed : null;
}

/**
 * Whether an account has a stored cloud key (does not open it).
 *
 * @param {string} ownId
 * @returns {boolean}
 */
export function hasCloudKey(ownId) {
    return existsSync(cloudKeyFile(ownId));
}

/**
 * Delete the stored cloud key.
 *
 * @param {string} ownId
 * @returns {boolean} whether a file was removed
 */
export function forgetCloudKey(ownId) {
    const file = cloudKeyFile(ownId);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
}

/**
 * The cloud key's status for `cloud key status`: never a key byte, only whether one is stored and its metadata.
 *
 * @param {string} ownId
 * @returns {{stored: boolean, keyVersion: *, savedAt: number|null, locked: boolean, file: string}}
 */
export function cloudKeyStatus(ownId) {
    const file = cloudKeyFile(ownId);
    if (!existsSync(file)) return { stored: false, keyVersion: null, savedAt: null, locked: false, file };
    try {
        const key = loadCloudKey(ownId);
        return {
            stored: Boolean(key),
            keyVersion: key?.keyVersion ?? null,
            savedAt: key?.savedAt ?? null,
            locked: false,
            file,
        };
    } catch {
        // The file is there but will not open (no login / locked data key): it is stored, just not readable now.
        return { stored: true, keyVersion: null, savedAt: null, locked: true, file };
    }
}
