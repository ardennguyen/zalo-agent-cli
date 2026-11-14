/**
 * At-rest protection of the account's secret files: the public face of the key layer.
 *
 * Every small file that holds a secret is sealed (./container.js) under a key from the account's keyring
 * (./keyring.js), whose master key only a provider can unwrap (./providers.js). Importing this module installs the
 * sealing codec for the protocol layer's stores (src/zalo/kernel/secret-file.js), so the trusted-device identity and
 * the transfer-sync sessions are sealed like the saved login.
 *
 * Reading a file that is still plaintext (written by 2.x) seals it in place: the sealed copy is written beside it,
 * read back and opened, and only then renamed over the plaintext, so a crash at any point leaves one readable copy.
 * There is no way back to plaintext except `account export`, which writes the login out on purpose.
 *
 * Phase 2 (the message database, media, the outbox) builds on {@link getDataKey} and the buffer/file helpers here.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { CREDENTIALS_DIR, getAccountDir } from "../credentials.js";
import { writeFileAtomic } from "../../zalo/kernel/atomic-file.js";
import { setSecretFileCodec } from "../../zalo/kernel/secret-file.js";
import { TRUST_FILE } from "../../zalo/trust-store.js";
import { KeystoreError, SealError, isSealed, openSealed, readSealedHeader, seal } from "./container.js";
import { dkeyLayerWanted, loadStorageConfig } from "./config.js";
import {
    PURPOSES,
    attachDkey,
    beginRekey,
    currentKey,
    deriveDataKey,
    fileKeyOf,
    finishRekey,
    getProviders,
    hasDkey,
    keyById,
    keyringPath,
    prepareForget,
    readKeyring,
    reconcileDkey,
    rewrapProvider,
    scopeOfDir,
} from "./keyring.js";

export { KeystoreError, SealError, PURPOSES, isSealed, keyringPath, readKeyring, scopeOfDir };

/**
 * Every small secret file, by kind. `use` is the key it is sealed under: `boot` for what a login needs (it must open
 * before the login that brings the dkey), `data` for the rest.
 */
export const SEALED_FILES = Object.freeze([
    { kind: "credentials", use: "boot", path: (id) => join(CREDENTIALS_DIR, `cred_${id}.json`) },
    { kind: "trusted-device", use: "boot", path: (id) => join(getAccountDir(id), TRUST_FILE) },
    {
        kind: "transfer-sync-sessions",
        use: "data",
        path: (id) => join(getAccountDir(id), "sync", "open-sessions.json"),
    },
    { kind: "voice-text", use: "data", path: (id) => join(getAccountDir(id), "voice-text.json") },
    // Boot key: both are read without a login (offline hidden-chat filtering, an approval page).
    { kind: "hidden-threads", use: "boot", path: (id) => join(getAccountDir(id), "hidden-threads.json") },
    { kind: "approver-secret", use: "boot", path: (id) => join(getAccountDir(id), "approver-secret.json") },
]);

/**
 * The account's scope: its id and its folder (where the keyring lives).
 *
 * @param {string} ownId
 * @returns {{id: string, dir: string}}
 */
export function scopeOf(ownId) {
    return { id: String(ownId), dir: resolve(getAccountDir(String(ownId))) };
}

const asScope = (s) => (typeof s === "string" ? scopeOf(s) : { id: String(s.id), dir: resolve(s.dir) });

/**
 * Seal bytes for one account.
 *
 * @param {string|{id: string, dir: string}} scope - an account id, or a scope
 * @param {{kind: string, use?: "boot"|"data"}} spec
 * @param {Buffer|string} plaintext
 * @returns {Buffer}
 * @throws {KeystoreError} when no key can be had (fail closed: nothing is written in the clear instead)
 */
export function sealBuffer(scope, { kind, use = "data" }, plaintext) {
    const s = asScope(scope);
    const base = currentKey(s, use);
    return seal(fileKeyOf(s, base), { acct: s.id, kind, use, kid: base.id, purpose: "file" }, plaintext);
}

/**
 * Open bytes sealed by {@link sealBuffer}; the container must name this account and this kind.
 *
 * @param {string|{id: string, dir: string}} scope
 * @param {{kind: string}} spec
 * @param {Buffer} bytes
 * @returns {Buffer}
 * @throws {SealError|KeystoreError}
 */
export function openBuffer(scope, { kind }, bytes) {
    const s = asScope(scope);
    return openSealed((h) => fileKeyOf(s, { id: h.kid, key: keyById(s, h.kid) }), bytes, {
        acct: s.id,
        kind,
        purpose: "file",
    }).plaintext;
}

/**
 * Seal and write a file atomically (0600).
 *
 * @param {string} file
 * @param {string|{id: string, dir: string}} scope
 * @param {{kind: string, use?: "boot"|"data"}} spec
 * @param {Buffer|string} plaintext
 */
export function sealFile(file, scope, spec, plaintext) {
    writeFileAtomic(file, sealBuffer(scope, spec, plaintext));
}

/**
 * Read a sealed file. A plaintext one (from before 3.0) is sealed in place first, then returned.
 *
 * @param {string} file
 * @param {string|{id: string, dir: string}} scope
 * @param {{kind: string, use?: "boot"|"data"}} spec
 * @returns {Buffer|null} null when there is no file
 * @throws {SealError|KeystoreError}
 */
export function openFile(file, scope, spec) {
    let bytes;
    try {
        bytes = readFileSync(file);
    } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
    }
    if (isSealed(bytes)) {
        try {
            return openBuffer(scope, spec, bytes);
        } catch (e) {
            if (e instanceof SealError) throw new SealError(`${file}: ${e.message}`, e.code);
            throw e;
        }
    }
    migratePlaintext(file, scope, spec, bytes);
    return bytes;
}

/**
 * Replace a plaintext file with its sealed form: write the sealed bytes to a side file, read them back and open them,
 * compare, and only then rename over the plaintext. A file another process changed meanwhile is left to it.
 *
 * @param {string} file
 * @param {string|{id: string, dir: string}} scope
 * @param {{kind: string, use?: "boot"|"data"}} spec
 * @param {Buffer} plaintext - the bytes read from `file`
 * @param {{afterVerify?: (side: string) => void}} [hooks] - tests: runs between the verified side file and the rename
 * @returns {boolean} whether it was replaced
 */
export function migratePlaintext(file, scope, spec, plaintext, { afterVerify } = {}) {
    const sealed = sealBuffer(scope, spec, plaintext);
    const side = `${file}.${process.pid}.sealing`;
    try {
        writeFileAtomic(side, sealed);
        const back = openBuffer(scope, spec, readFileSync(side));
        if (!back.equals(plaintext))
            throw new KeystoreError(`sealing ${file} did not verify; it was left as it was`, "WRONG_KEY");
        afterVerify?.(side);
        let now;
        try {
            now = readFileSync(file);
        } catch {
            return false;
        }
        if (!now.equals(plaintext)) return false;
        writeFileAtomic(file, sealed);
        return true;
    } finally {
        rmSync(side, { force: true });
    }
}

/**
 * The protocol layer's codec: the same sealing, for the stores in src/zalo.
 * `meta` is `{kind, use, account?, dir?}`.
 */
export const sealedCodec = Object.freeze({
    read(file, meta) {
        const bytes = openFile(file, scopeForMeta(meta, file), meta);
        return bytes === null ? null : bytes.toString("utf8");
    },
    write(file, text, meta) {
        sealFile(file, scopeForMeta(meta, file), meta, text);
    },
});

function scopeForMeta(meta, file) {
    if (meta?.dir) return { id: String(meta.account ?? scopeOfDir(meta.dir).id), dir: resolve(meta.dir) };
    if (meta?.account) return scopeOf(meta.account);
    throw new KeystoreError(`no account is known for ${file}`, "CONFIG");
}

setSecretFileCodec(sealedCodec);

/**
 * A codec bound to one account folder, for a store that knows only its file (the transfer-sync sessions).
 *
 * @param {string} accountDir
 * @returns {{read: Function, write: Function}}
 */
export function codecForDir(accountDir) {
    const scope = scopeOfDir(accountDir);
    return {
        read: (file, meta) => sealedCodec.read(file, { ...meta, account: scope.id, dir: scope.dir }),
        write: (file, text, meta) => sealedCodec.write(file, text, { ...meta, account: scope.id, dir: scope.dir }),
    };
}

/**
 * Read a sealed JSON file (a plaintext one is sealed on the way); null when there is none.
 *
 * @param {string} file
 * @param {string|{id: string, dir: string}} scope
 * @param {{kind: string, use?: "boot"|"data"}} spec
 * @returns {any}
 */
export function readSealedJson(file, scope, spec) {
    const bytes = openFile(file, scope, spec);
    return bytes === null ? null : JSON.parse(bytes.toString("utf8"));
}

/**
 * Write a JSON value sealed.
 *
 * @param {string} file
 * @param {string|{id: string, dir: string}} scope
 * @param {{kind: string, use?: "boot"|"data"}} spec
 * @param {any} value
 */
export function writeSealedJson(file, scope, spec, value) {
    sealFile(file, scope, spec, JSON.stringify(value, null, 2));
}

/**
 * A subkey of the account's data key for phase-2 storage: `sqlcipher` (the database key), `media`, `row-mac` (tamper
 * evidence), `outbox`. Opens only with the provider, and with a live login when the dkey layer is on.
 *
 * @param {string} ownId
 * @param {string} purpose
 * @param {{keyId?: string}} [opts] - the id of an older key (kept until a rekey finishes), to read older data
 * @returns {{key: Buffer, keyId: string}} the caller must not log, store or return `key`
 */
export function getDataKey(ownId, purpose, opts = {}) {
    return deriveDataKey(scopeOf(ownId), purpose, opts);
}

/** Handlers phase-2 stores register to re-encrypt themselves during a rekey. */
const rekeyHandlers = new Set();

/**
 * Register a store's re-encryption for `rekey`: called with `(ownId, {oldKeyId, newKeyId})` while both keys open; it
 * must finish (or throw, which stops the rekey with the old keys still in place) before the old keys are dropped.
 *
 * @param {(ownId: string, ids: {oldKeyId: string|null, newKeyId: string}) => void} handler
 * @returns {() => void} unregister
 */
export function onRekey(handler) {
    rekeyHandlers.add(handler);
    return () => rekeyHandlers.delete(handler);
}

/**
 * What a file is on disk.
 *
 * @param {string} file
 * @returns {{state: "absent"|"plaintext"|"sealed"|"damaged", keyId?: string, use?: string}}
 */
export function fileState(file) {
    if (!existsSync(file)) return { state: "absent" };
    let bytes;
    try {
        bytes = readFileSync(file);
    } catch {
        return { state: "damaged" };
    }
    if (!isSealed(bytes)) return { state: "plaintext" };
    try {
        const h = readSealedHeader(bytes);
        return { state: "sealed", keyId: h.kid, use: h.use };
    } catch {
        return { state: "damaged" };
    }
}

/**
 * Seal every plaintext secret file of an account. Idempotent: a sealed file is left as it is. A data file that cannot
 * be sealed yet (the dkey layer waits for a login) is reported `locked` and left for the next login.
 *
 * @param {string} ownId
 * @returns {Array<{kind: string, file: string, result: "sealed"|"already-sealed"|"absent"|"locked"|"failed", error?: string}>}
 */
export function migrateAccount(ownId) {
    const scope = scopeOf(ownId);
    return SEALED_FILES.map((spec) => {
        const file = spec.path(scope.id);
        const st = fileState(file);
        if (st.state === "absent") return { kind: spec.kind, file, result: "absent" };
        if (st.state === "sealed") return { kind: spec.kind, file, result: "already-sealed" };
        try {
            migratePlaintext(file, scope, spec, readFileSync(file));
            return { kind: spec.kind, file, result: "sealed" };
        } catch (e) {
            if (e?.code === "LOCKED") return { kind: spec.kind, file, result: "locked", error: e.message };
            return { kind: spec.kind, file, result: "failed", error: e.message };
        }
    });
}

/**
 * The account's protection, for `account security status`: never a key, a wrapped key or a passphrase.
 *
 * @param {string} ownId
 * @returns {object}
 */
export function securityStatus(ownId) {
    const scope = scopeOf(ownId);
    let ring = null;
    let keyringError = null;
    try {
        ring = readKeyring(scope.dir);
    } catch (e) {
        keyringError = e.message;
    }
    let config = null;
    let configError = null;
    try {
        config = loadStorageConfig();
    } catch (e) {
        configError = e.message;
    }
    const current = new Set((ring?.keys ?? []).map((k) => k.id));
    const files = SEALED_FILES.map((spec) => {
        const file = spec.path(scope.id);
        const st = fileState(file);
        return {
            kind: spec.kind,
            key: spec.use,
            file,
            state: st.state,
            ...(st.state === "sealed" ? { currentKey: current.has(st.keyId) } : {}),
        };
    });
    const data = ring?.keys?.find((k) => k.use === "data");
    return {
        ownId: scope.id,
        keyring: ring
            ? {
                  file: keyringPath(scope.dir),
                  version: ring.version,
                  createdAt: ring.createdAt ?? null,
                  updatedAt: ring.updatedAt ?? null,
                  rotatedAt: ring.rotatedAt ?? null,
                  keys: ring.keys.map((k) => ({
                      use: k.use,
                      id: k.id,
                      createdAt: k.createdAt,
                      dkeyLayer: Boolean(k.dkey),
                  })),
                  rekeyInProgress: (ring.retired ?? []).length > 0,
              }
            : null,
        keyringError,
        provider: ring
            ? {
                  name: ring.provider.name,
                  ...(getProviders()[ring.provider.name]?.describe(ring.provider.options ?? {}) ?? {}),
                  ...ring.provider.options,
              }
            : null,
        configuredProvider: config?.provider ?? null,
        configError,
        dkeyLayer: {
            configured: config ? dkeyLayerWanted(config, scope.id) : null,
            active: Boolean(data?.dkey),
            dataKeyPending: Boolean(ring && !data),
            unlockedInThisProcess: hasDkey(scope),
        },
        files,
        plaintextFiles: files.filter((f) => f.state === "plaintext").length,
    };
}

/**
 * Hand the key layer a live login: unlocks the data key (dkey layer), applies the dkey setting, and seals what is
 * still plaintext. Never throws: a problem is told on stderr (never with key material), and the stores that need the
 * key then fail closed on their own.
 *
 * @param {string|null} ownId
 * @param {object|null} api - the session (`getContext().loginInfo.dkey`)
 * @param {{log?: (line: string) => void}} [opts]
 * @returns {{ok: boolean, dkeyLayer?: boolean, migrated?: number, error?: string}}
 */
export function attachLoginSession(ownId, api, { log = (l) => console.error(l) } = {}) {
    if (!ownId) return { ok: false };
    try {
        const scope = scopeOf(ownId);
        const dkey = api?.getContext?.()?.loginInfo?.dkey;
        const res = attachDkey(scope, typeof dkey === "string" ? dkey : null);
        const usable = typeof dkey === "string" && dkey.length >= 16;
        if (!usable && (res.dkeyLayer || dkeyLayerWanted(loadStorageConfig(), scope.id))) {
            log(
                `[keystore] the dkey layer is on, but Zalo's login reply for ${scope.id} carried no data key: its local data stays locked`,
            );
        }
        const migrated = migrateAccount(ownId).filter((r) => r.result === "sealed").length;
        return { ok: true, dkeyLayer: res.dkeyLayer, migrated };
    } catch (e) {
        log(`[keystore] ${e.message}`);
        return { ok: false, error: e.message };
    }
}

/**
 * New keys for an account, every sealed file re-sealed under them, phase-2 stores told; the old keys stay in the
 * keyring until all of it is done, so an interrupted rekey is finished by running it again.
 *
 * @param {string} ownId
 * @returns {{resealed: number, keys: {boot: string, data: string}}}
 */
export function rekeyAccount(ownId) {
    const scope = scopeOf(ownId);
    // Unlock the current keys (provider, and the dkey layer) before anything changes.
    reconcileDkey(scope);
    const oldData = readKeyring(scope.dir)?.keys.find((k) => k.use === "data")?.id ?? null;
    const opened = [];
    for (const spec of SEALED_FILES) {
        const file = spec.path(scope.id);
        const bytes = openFile(file, scope, spec);
        if (bytes !== null) opened.push({ spec, file });
    }
    const keys = beginRekey(scope);
    let resealed = 0;
    for (const { spec, file } of opened) {
        const bytes = openFile(file, scope, spec);
        if (bytes === null) continue;
        sealFile(file, scope, spec, bytes);
        resealed++;
    }
    for (const handler of rekeyHandlers) handler(scope.id, { oldKeyId: oldData, newKeyId: keys.data });
    finishRekey(scope);
    return { resealed, keys };
}

/**
 * Re-wrap the account's master key for another provider.
 *
 * @param {string} ownId
 * @param {string} name
 * @param {object} [options]
 * @returns {{from: string, to: string}}
 */
export function changeProvider(ownId, name, options = {}) {
    return rewrapProvider(scopeOf(ownId), name, options);
}

/**
 * Before an account's folder is removed: returns what to call afterwards to drop a provider's item (keychain).
 *
 * @param {string} ownId
 * @returns {() => void}
 */
export function prepareAccountForget(ownId) {
    return prepareForget(scopeOf(ownId).dir);
}

/**
 * Whether the account has a keyring.
 *
 * @param {string} ownId
 * @returns {boolean}
 */
export function hasKeyring(ownId) {
    return existsSync(keyringPath(scopeOf(ownId).dir));
}
