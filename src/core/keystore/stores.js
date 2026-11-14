/**
 * The account's encrypted stores (at-rest phase 2) as the key layer sees them: what they are, their state for
 * `account security status`, their migration for `account security migrate`, and their part in a rekey.
 *
 * Importing this module registers the stores' rekey handlers with {@link onRekey}. `rekeyAccount` calls the handlers
 * after the new keys exist and before the old ones are dropped, so every process that can run a rekey
 * (`account security rekey`) must import it: without the handlers a rekey would drop the key the database is
 * encrypted under.
 *
 * The message database (`zalo.db`, SQLCipher, purpose `sqlcipher`) and the webhook outbox (`webhook-outbox.db`,
 * purpose `outbox`, the same database handler), and the downloaded media (purpose `media`, ../media-store.js: a
 * rekey re-wraps each file's key in its header, it never re-encrypts the files). The message rows' MACs (purpose
 * `row-mac`, ../row-mac.js) are re-computed under the new key after the database itself is rekeyed.
 */
import { join } from "node:path";
import { getAccountDbPath, getAccountDir } from "../credentials.js";
import { databaseState, dbFileState, migratePlaintextDatabase, openDatabase, rekeyDatabase } from "../sqlite.js";
import { registerRowMacFunction, rekeyRowMacs } from "../row-mac.js";
import { deriveDataKey, readKeyring } from "./keyring.js";
import { OUTBOX_FILE, OUTBOX_PURPOSE, migratePlaintextOutbox } from "../webhook-outbox.js";
import { mediaStatus, migrateMedia, rekeyMedia } from "../media-store.js";
import { onRekey, scopeOf, securityStatus } from "./index.js";

/**
 * Every encrypted database of an account. `key` is the keyring key it derives from (always the data key); `migrate`
 * encrypts a plaintext one and returns whether it did.
 */
export const DATABASE_STORES = Object.freeze([
    {
        kind: "message-database",
        key: "data",
        purpose: "sqlcipher",
        path: (id) => getAccountDbPath(id),
        migrate: (file, opts) => migratePlaintextDatabase(file, { purpose: "sqlcipher", ...opts }).migrated,
    },
    {
        kind: "webhook-outbox",
        key: "data",
        purpose: OUTBOX_PURPOSE,
        path: (id) => join(getAccountDir(id), OUTBOX_FILE),
        // An empty 2.x outbox is removed (recreated encrypted on its next open), one with rows is encrypted.
        migrate: (file, opts) => migratePlaintextOutbox(file, opts) !== "already-encrypted",
    },
]);

/**
 * Re-encrypt every store of an account under its current data key: the rekey handler. Idempotent (a store already
 * under the current key is left alone), so a rekey that stopped part way is finished by running it again.
 *
 * @param {string} ownId
 * @returns {Array<{kind: string, file: string, result: string}>}
 */
export function rekeyStores(ownId) {
    const results = DATABASE_STORES.map((s) => {
        const file = s.path(ownId);
        return { kind: s.kind, file, result: rekeyDatabase(file, { purpose: s.purpose }) };
    });
    // The row MACs, once the database opens under the new key: each row whose MAC an older key made is re-MACed.
    results.push({ kind: "row-mac", file: getAccountDbPath(ownId), ...rekeyMessageMacs(ownId) });
    // Media: each sealed file's key slot re-wrapped under the new "media" key (about 80 bytes per file).
    const media = rekeyMedia(ownId);
    results.push({ kind: "media", file: null, result: media.rewrapped ? "rekeyed" : "current", ...media });
    return results;
}

onRekey((ownId) => {
    rekeyStores(ownId);
});

/**
 * Re-MAC the message rows under the current `row-mac` key (../row-mac.js `rekeyRowMacs`). Every retired data key is
 * tried, not only the one this rekey replaced, so a rekey that stopped part way and was run again still finishes.
 * A row that verifies under no key is left as it is: it stays a finding of `db verify`.
 *
 * @param {string} ownId
 * @returns {{result: "absent"|"rekeyed"|"current", rewritten?: number, current?: number, failed?: number}}
 */
export function rekeyMessageMacs(ownId) {
    const file = getAccountDbPath(ownId);
    const state = dbFileState(file);
    if (state === "absent" || state === "empty" || state === "plaintext") return { result: "absent" };
    const scope = scopeOf(ownId);
    const { key, keyId } = deriveDataKey(scope, "row-mac");
    const older = (readKeyring(scope.dir)?.retired ?? [])
        .filter((k) => k.use === "data" && k.id !== keyId)
        .flatMap((k) => {
            try {
                return [deriveDataKey(scope, "row-mac", { keyId: k.id }).key];
            } catch {
                return [];
            }
        });
    const db = openDatabase(file);
    try {
        registerRowMacFunction(db, key);
        const r = rekeyRowMacs(db, key, older);
        return { result: r.rewritten ? "rekeyed" : "current", ...r };
    } finally {
        db.close();
    }
}

/**
 * The databases' lines for `account security status`, in the shape of its `files` entries (never key material).
 *
 * @param {string} ownId
 * @returns {Array<{kind: string, key: string, file: string, state: string, keyId?: string, currentKey?: boolean,
 *   error?: string}>}
 */
export function storesStatus(ownId) {
    return DATABASE_STORES.map((s) => {
        const file = s.path(ownId);
        return { kind: s.kind, key: s.key, file, ...databaseState(file, { purpose: s.purpose }) };
    });
}

/**
 * `account security status` with the stores: the sealed files, then the databases; `plaintextFiles` counts both.
 *
 * @param {string} ownId
 * @returns {object}
 */
export function fullSecurityStatus(ownId) {
    const base = securityStatus(ownId);
    const files = [...base.files, ...storesStatus(ownId), mediaStatus(ownId)];
    return { ...base, files, plaintextFiles: files.filter((f) => f.state === "plaintext").length };
}

/**
 * Encrypt every store still in plaintext (`account security migrate`): the databases, then the media (every file
 * sealed in place, resumable). Idempotent. A store that cannot be done now (the key is locked, another process holds
 * it, no disk space) is reported and left as it is.
 *
 * @param {string} ownId
 * @param {{log?: (line: string) => void}} [opts]
 * @returns {Array<{kind: string, file: string, result: "encrypted"|"already-encrypted"|"absent"|"locked"|"failed",
 *   error?: string, sealed?: number}>}
 */
export function migrateStores(ownId, { log } = {}) {
    return [...migrateDatabases(ownId, { log }), migrateMediaStore(ownId, { log })];
}

/** The media part of {@link migrateStores}. */
function migrateMediaStore(ownId, { log } = {}) {
    const file = mediaStatus(ownId).file;
    try {
        const r = migrateMedia(ownId, log ? { log } : {});
        const result = r.failed ? "failed" : r.sealed ? "encrypted" : "already-encrypted";
        return {
            kind: "media",
            file,
            result,
            sealed: r.sealed,
            failed: r.failed,
            ...(r.failed ? { error: `${r.failed} file(s) could not be sealed (first: ${r.errors[0]?.error})` } : {}),
        };
    } catch (e) {
        if (e?.code === "LOCKED") return { kind: "media", file, result: "locked", error: e.message };
        return { kind: "media", file, result: "failed", error: e.message };
    }
}

function migrateDatabases(ownId, { log } = {}) {
    return DATABASE_STORES.map((s) => {
        const file = s.path(ownId);
        const state = databaseState(file, { purpose: s.purpose }).state;
        if (state === "absent") return { kind: s.kind, file, result: "absent" };
        if (state !== "plaintext") return { kind: s.kind, file, result: "already-encrypted" };
        try {
            const done = s.migrate(file, log ? { log } : {});
            return { kind: s.kind, file, result: done ? "encrypted" : "already-encrypted" };
        } catch (e) {
            if (e?.code === "LOCKED") return { kind: s.kind, file, result: "locked", error: e.message };
            return { kind: s.kind, file, result: "failed", error: e.message };
        }
    });
}
