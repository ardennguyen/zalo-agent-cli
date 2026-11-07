/**
 * The per-account keyring: `<accountDir>/keyring.json`, the only place an account's keys are kept, and only wrapped.
 *
 *     provider key (DPAPI, keychain, systemd-creds, KMS, …)
 *       └─ master key (32 bytes, random)                    keyring.provider.wrapped
 *            ├─ boot key  (32 bytes)                         opens what a login needs: the saved login, the
 *            │                                               trusted-device identity
 *            └─ data key  (32 bytes)                         everything else, and phase 2's subkeys
 *                 └─ (dkey layer) wrapped first under a key derived from the account's `dkey` (HKDF-SHA256, a
 *                    random per-account salt), then under the master key: it opens only with BOTH the provider
 *                    and a live login.
 *
 * Why per account, next to the account's data: removing the account removes its keys (its sealed files become noise
 * even where a copy survives), a SaaS can give each tenant its own KMS key, and `rekey` / `provider` touch one account
 * without the others. Why two keys: the saved login has to open BEFORE the login that would bring the dkey, so it can
 * only be under the provider; everything that is not needed to log in can wait for the dkey.
 *
 * Unwrapped keys live in this process's memory only (a Map, per account directory), are never logged, and are never
 * written anywhere.
 */
import { hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "../../zalo/kernel/atomic-file.js";
import { KeystoreError, unwrapKey, wrapKey } from "./container.js";
import { dkeyLayerWanted, loadStorageConfig } from "./config.js";
import { createProviders, defaultProvider } from "./providers.js";

export const KEYRING_FILE = "keyring.json";
export const KEYRING_FORMAT = "zalo-agent-cli/keyring";
export const KEYRING_VERSION = 1;

/** The subkey purposes phase 2 derives from the data key (the small files use their own, see fileKeyOf). */
export const PURPOSES = ["sqlcipher", "media", "row-mac", "outbox"];

/** @typedef {{id: string, dir: string}} Scope */

let providers = createProviders();
/** dir -> {mk?: Buffer, keys: Map<string, Buffer>, dkeyKek?: Buffer} */
const cache = new Map();

/**
 * Replace the providers (tests: fakes for the OS tools).
 *
 * @param {Record<string, object>} next
 */
export function setProviders(next) {
    providers = next;
    cache.clear();
}

/** @returns {Record<string, object>} */
export function getProviders() {
    return providers;
}

/** Forget every unwrapped key this process holds. */
export function lockAll() {
    for (const c of cache.values()) {
        c.mk?.fill(0);
        for (const k of c.keys.values()) k.fill(0);
        c.dkeyKek?.fill(0);
    }
    cache.clear();
}

/**
 * @param {string} dir
 * @returns {string}
 */
export function keyringPath(dir) {
    return join(dir, KEYRING_FILE);
}

/**
 * The scope of a directory: the account id is the folder's name, as `getAccountDir` lays them out.
 *
 * @param {string} dir
 * @returns {Scope}
 */
export function scopeOfDir(dir) {
    return { id: basename(resolve(dir)), dir: resolve(dir) };
}

/**
 * Read a keyring, or null when there is none.
 *
 * @param {string} dir
 * @returns {object|null}
 * @throws {KeystoreError} for a damaged keyring: never replaced silently, the sealed files depend on it
 */
export function readKeyring(dir) {
    const file = keyringPath(dir);
    if (!existsSync(file)) return null;
    let ring;
    try {
        ring = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        throw new KeystoreError(
            `${file} is damaged; restore it from a backup or log in again with a QR code`,
            "WRONG_KEY",
        );
    }
    if (ring?.format !== KEYRING_FORMAT || ring.version !== KEYRING_VERSION || !ring.provider?.name) {
        throw new KeystoreError(`${file} is not a keyring of a version this release reads`, "WRONG_KEY");
    }
    return ring;
}

function writeKeyring(dir, ring) {
    writeFileAtomic(keyringPath(dir), JSON.stringify({ ...ring, updatedAt: new Date().toISOString() }, null, 2));
}

const keyAad = (ring, entry) => `zalo-agent-cli/keyring/v1|${ring.account}|${ring.ref}|${entry.id}|${entry.use}`;
const dkeyAad = (ring, entry) => `${keyAad(ring, entry)}|dkey`;
const newId = () => randomBytes(8).toString("hex");

/**
 * The provider a new keyring (or `provider <name>`) uses, with its options; refuses (fail closed) when none fits.
 *
 * @param {string|null} [name] - a provider asked for by name; else the configured one, else the platform default
 * @param {object} [config]
 * @returns {{name: string, provider: object, options: object}}
 */
export function resolveProvider(name = null, config = loadStorageConfig()) {
    let chosen = name ?? config.provider;
    if (!chosen) {
        const d = defaultProvider({ providers });
        if (d.refused) throw new KeystoreError(d.refused, "UNAVAILABLE");
        chosen = d.name;
    }
    const provider = providers[chosen];
    if (!provider) throw new KeystoreError(`unknown key provider "${chosen}"`, "CONFIG");
    const options = { ...(config.options?.[chosen] ?? {}) };
    const why = provider.check(options);
    if (why) throw new KeystoreError(`the "${chosen}" key provider cannot be used here: ${why}`, "UNAVAILABLE");
    return { name: chosen, provider, options };
}

function entryOf(c) {
    const dir = resolve(c.dir);
    let e = cache.get(dir);
    if (!e) {
        e = { keys: new Map() };
        cache.set(dir, e);
    }
    return e;
}

/**
 * The account's master key, unwrapped by the keyring's provider (once per process).
 *
 * @param {Scope} scope
 * @param {object} ring
 * @returns {Buffer}
 */
function masterKey(scope, ring) {
    const e = entryOf(scope);
    if (e.mk) return e.mk;
    const name = ring.provider.name;
    const provider = providers[name];
    if (!provider) throw new KeystoreError(`the keyring uses the unknown provider "${name}"`, "CONFIG");
    const config = loadStorageConfig();
    const options = { ...(ring.provider.options ?? {}), ...(config.options?.[name] ?? {}) };
    const why = provider.check(options);
    if (why) {
        throw new KeystoreError(
            `account ${scope.id}'s keyring is protected by "${name}", which cannot be used here: ${why}`,
            "UNAVAILABLE",
        );
    }
    e.mk = provider.unwrap(ring.provider.wrapped, {
        account: ring.account,
        ref: ring.ref,
        options,
        state: ring.provider.state,
    });
    return e.mk;
}

/**
 * Derive the dkey layer's key-encryption key. The dkey itself is not kept.
 *
 * @param {object} ring
 * @param {string} dkey
 * @returns {Buffer}
 */
function dkeyKekOf(ring, dkey) {
    return Buffer.from(
        hkdfSync(
            "sha256",
            Buffer.from(String(dkey), "utf8"),
            Buffer.from(ring.dkeyLayer.salt, "base64"),
            `zalo-agent-cli/v1/dkey-layer/${ring.account}`,
            32,
        ),
    );
}

function sealEntry(ring, mk, use, key, dkeyKek) {
    const entry = { id: newId(), use, createdAt: new Date().toISOString(), dkey: Boolean(dkeyKek) };
    const inner = dkeyKek ? Buffer.from(wrapKey(dkeyKek, key, dkeyAad(ring, entry)), "utf8") : key;
    entry.wrapped = wrapKey(mk, inner, keyAad(ring, entry));
    return entry;
}

/** The raw key of an entry. */
function openEntry(scope, ring, entry) {
    const e = entryOf(scope);
    const hit = e.keys.get(entry.id);
    if (hit) return hit;
    let outer;
    try {
        outer = unwrapKey(masterKey(scope, ring), entry.wrapped, keyAad(ring, entry));
    } catch (err) {
        // Another process may have rekeyed since this one unwrapped the master key: unwrap it again, once.
        if (!e.mk) throw err;
        e.mk = null;
        outer = unwrapKey(masterKey(scope, ring), entry.wrapped, keyAad(ring, entry));
    }
    let key = outer;
    if (entry.dkey) {
        if (!e.dkeyKek) {
            throw new KeystoreError(
                `the local data of account ${scope.id} is locked: the dkey layer is on, so its data key opens only after ` +
                    "a live Zalo login, and this process has not logged in. Run a command that logs in (or start " +
                    "`listen` / `mcp start`); while Zalo cannot be reached (offline, Zalo down) the data stays locked.",
                "LOCKED",
            );
        }
        try {
            key = unwrapKey(e.dkeyKek, outer.toString("utf8"), dkeyAad(ring, entry));
        } catch {
            throw new KeystoreError(`the login's data key does not open account ${scope.id}'s keyring`, "WRONG_KEY");
        }
    }
    e.keys.set(entry.id, key);
    return key;
}

/**
 * Create the account's keyring if it has none. The provider runs outside the file lock (it may take a second, or ask
 * for a passphrase); a keyring another process wrote in the meantime wins and ours is dropped.
 *
 * @param {Scope} scope
 * @returns {object} the keyring
 */
export function ensureKeyring(scope) {
    const existing = readKeyring(scope.dir);
    if (existing) return existing;
    const config = loadStorageConfig();
    const { name, provider, options } = resolveProvider(null, config);
    const mk = randomBytes(32);
    const ref = newId() + newId();
    const { wrapped, state } = provider.wrap(mk, { account: scope.id, ref, options, state: {} });
    const ring = {
        format: KEYRING_FORMAT,
        version: KEYRING_VERSION,
        account: scope.id,
        ref,
        provider: { name, options: describeOptions(name, options), state, wrapped },
        dkeyLayer: { enabled: false, salt: randomBytes(16).toString("base64") },
        keys: [],
        retired: [],
        createdAt: new Date().toISOString(),
    };
    ring.keys.push(sealEntry(ring, mk, "boot", randomBytes(32), null));
    // The data key is made now unless the dkey layer is wanted: then it waits for the first login's dkey.
    if (!dkeyLayerWanted(config, scope.id)) ring.keys.push(sealEntry(ring, mk, "data", randomBytes(32), null));
    const won = withFileLock(`${keyringPath(scope.dir)}.lock`, () => {
        if (existsSync(keyringPath(scope.dir))) return false;
        writeKeyring(scope.dir, ring);
        return true;
    });
    if (!won) {
        provider.forget?.({ account: scope.id, ref, options, state });
        return readKeyring(scope.dir);
    }
    entryOf(scope).mk = mk;
    return ring;
}

/** The options a keyring records: what is needed to unwrap again (no secret is among them). */
function describeOptions(name, options) {
    const keep =
        {
            dpapi: ["scope"],
            "systemd-creds": ["withKey", "user"],
            kms: ["backend", "key", "region", "address", "mount", "namespace", "derived"],
            passphrase: ["file"],
            env: ["variable"],
        }[name] ?? [];
    return Object.fromEntries(keep.filter((k) => options[k] !== undefined).map((k) => [k, options[k]]));
}

/**
 * The current key of one use (`boot` or `data`), with its id.
 *
 * @param {Scope} scope
 * @param {"boot"|"data"} use
 * @param {{create?: boolean}} [opts] - create the keyring when there is none (sealing does; opening does not)
 * @returns {{id: string, key: Buffer}}
 * @throws {KeystoreError}
 */
export function currentKey(scope, use, { create = true } = {}) {
    const ring = create ? ensureKeyring(scope) : readKeyring(scope.dir);
    if (!ring) throw new KeystoreError(`account ${scope.id} has no keyring`, "NO_KEYRING");
    let entry = ring.keys.find((k) => k.use === use);
    if (!entry && use === "data") {
        reconcileDkey(scope);
        entry = readKeyring(scope.dir).keys.find((k) => k.use === "data");
        if (!entry) throw lockedForNewKey(scope);
        return { id: entry.id, key: openEntry(scope, readKeyring(scope.dir), entry) };
    }
    if (!entry) throw new KeystoreError(`account ${scope.id}'s keyring has no ${use} key`, "WRONG_KEY");
    return { id: entry.id, key: openEntry(scope, ring, entry) };
}

function lockedForNewKey(scope) {
    return new KeystoreError(
        `the local data of account ${scope.id} is locked: the dkey layer is on and this account has not logged in ` +
            "since it was turned on, so its data key does not exist yet. Log in (any command that logs in) first.",
        "LOCKED",
    );
}

/**
 * The key a sealed header names (current or retired), for opening.
 *
 * @param {Scope} scope
 * @param {string} kid
 * @returns {Buffer}
 */
export function keyById(scope, kid) {
    const ring = readKeyring(scope.dir);
    if (!ring) {
        throw new KeystoreError(
            `account ${scope.id} has sealed files but no keyring (${keyringPath(scope.dir)}): they cannot be opened; ` +
                "log in again with a QR code",
            "NO_KEYRING",
        );
    }
    const entry = [...ring.keys, ...(ring.retired ?? [])].find((k) => k.id === kid);
    if (!entry)
        throw new KeystoreError(
            `account ${scope.id}'s keyring does not hold the key this file was sealed with`,
            "WRONG_KEY",
        );
    return openEntry(scope, ring, entry);
}

/**
 * Hand the key layer the dkey of a live login. Only a key derived from it is kept, in memory; then the keyring is
 * brought in line with the dkey setting (data key created, or wrapped under / released from the dkey layer).
 *
 * @param {Scope} scope
 * @param {string|null|undefined} dkey
 * @returns {{dkeyLayer: boolean, changed: boolean}}
 */
export function attachDkey(scope, dkey) {
    const ring = ensureKeyring(scope);
    if (typeof dkey === "string" && dkey.length >= 16) entryOf(scope).dkeyKek = dkeyKekOf(ring, dkey);
    return reconcileDkey(scope);
}

/**
 * Make the keyring's data key match the dkey setting for this account, when this process can.
 *
 * @param {Scope} scope
 * @returns {{dkeyLayer: boolean, changed: boolean, pending?: string}}
 */
export function reconcileDkey(scope) {
    const wanted = dkeyLayerWanted(loadStorageConfig(), scope.id);
    const e = entryOf(scope);
    const ring = readKeyring(scope.dir);
    if (!ring) return { dkeyLayer: false, changed: false };
    const data = ring.keys.find((k) => k.use === "data");
    const current = data ? data.dkey : null;
    if (data && current === wanted) return { dkeyLayer: wanted, changed: false };
    if ((wanted || current) && !e.dkeyKek) return { dkeyLayer: Boolean(current), changed: false, pending: "login" };
    const mk = masterKey(scope, ring);
    const raw = data ? openEntry(scope, ring, data) : randomBytes(32);
    return withFileLock(`${keyringPath(scope.dir)}.lock`, () => {
        const fresh = readKeyring(scope.dir);
        const others = fresh.keys.filter((k) => k.use !== "data");
        const entry = sealEntry(fresh, mk, "data", raw, wanted ? e.dkeyKek : null);
        // Keep the id, so every file sealed under it still names a key that exists.
        if (data) {
            entry.id = data.id;
            entry.createdAt = data.createdAt;
            const inner = wanted ? Buffer.from(wrapKey(e.dkeyKek, raw, dkeyAad(fresh, entry)), "utf8") : raw;
            entry.wrapped = wrapKey(mk, inner, keyAad(fresh, entry));
        }
        fresh.keys = [...others, entry];
        fresh.dkeyLayer = { ...fresh.dkeyLayer, enabled: wanted };
        writeKeyring(scope.dir, fresh);
        e.keys.set(entry.id, raw);
        return { dkeyLayer: wanted, changed: true };
    });
}

/**
 * New boot and data keys (and a new master key); the old ones move to `retired` until `finishRekey`, so every file
 * still opens while it is being re-sealed, and a crash in between loses nothing.
 *
 * @param {Scope} scope
 * @returns {{boot: string, data: string|null}} the new key ids
 */
export function beginRekey(scope) {
    const ring = readKeyring(scope.dir);
    if (!ring) throw new KeystoreError(`account ${scope.id} has no keyring to rekey`, "NO_KEYRING");
    const e = entryOf(scope);
    const old = [...ring.keys, ...(ring.retired ?? [])].map((k) => ({ entry: k, raw: openEntry(scope, ring, k) }));
    const dataDkey = ring.keys.find((k) => k.use === "data")?.dkey ?? dkeyLayerWanted(loadStorageConfig(), scope.id);
    if (dataDkey && !e.dkeyKek) throw lockedForNewKey(scope);
    const config = loadStorageConfig();
    const name = ring.provider.name;
    const provider = providers[name];
    const options = { ...(ring.provider.options ?? {}), ...(config.options?.[name] ?? {}) };
    const mk = randomBytes(32);
    const { wrapped, state } = provider.wrap(mk, { account: ring.account, ref: ring.ref, options, state: {} });
    const next = { ...ring, provider: { ...ring.provider, state, wrapped }, keys: [], retired: [] };
    for (const { entry, raw } of old) {
        const kept = { ...entry };
        const inner = entry.dkey ? Buffer.from(wrapKey(e.dkeyKek, raw, dkeyAad(next, entry)), "utf8") : raw;
        kept.wrapped = wrapKey(mk, inner, keyAad(next, entry));
        next.retired.push(kept);
    }
    const boot = sealEntry(next, mk, "boot", randomBytes(32), null);
    const data = sealEntry(next, mk, "data", randomBytes(32), dataDkey ? e.dkeyKek : null);
    next.keys.push(boot, data);
    withFileLock(`${keyringPath(scope.dir)}.lock`, () => writeKeyring(scope.dir, next));
    provider.forget?.({ account: ring.account, ref: ring.ref, options, state: ring.provider.state });
    e.mk = mk;
    return { boot: boot.id, data: data.id };
}

/**
 * Drop the retired keys once every file is re-sealed.
 *
 * @param {Scope} scope
 */
export function finishRekey(scope) {
    withFileLock(`${keyringPath(scope.dir)}.lock`, () => {
        const ring = readKeyring(scope.dir);
        const e = entryOf(scope);
        for (const k of ring.retired ?? []) e.keys.delete(k.id);
        writeKeyring(scope.dir, { ...ring, retired: [], rotatedAt: new Date().toISOString() });
    });
}

/**
 * Re-wrap the master key for another provider (the keys under it, and so every sealed file, stay as they are).
 *
 * @param {Scope} scope
 * @param {string} name
 * @param {object} [extraOptions] - options given on the command line, over storage.json's
 * @returns {{from: string, to: string}}
 */
export function rewrapProvider(scope, name, extraOptions = {}) {
    const ring = readKeyring(scope.dir);
    if (!ring) throw new KeystoreError(`account ${scope.id} has no keyring yet`, "NO_KEYRING");
    const config = loadStorageConfig();
    config.options[name] = { ...(config.options[name] ?? {}), ...extraOptions };
    const target = resolveProvider(name, config);
    const mk = masterKey(scope, ring);
    const { wrapped, state } = target.provider.wrap(mk, {
        account: ring.account,
        ref: ring.ref,
        options: target.options,
        state: {},
    });
    const oldName = ring.provider.name;
    const oldCtx = {
        account: ring.account,
        ref: ring.ref,
        options: ring.provider.options ?? {},
        state: ring.provider.state,
    };
    withFileLock(`${keyringPath(scope.dir)}.lock`, () => {
        const fresh = readKeyring(scope.dir);
        writeKeyring(scope.dir, {
            ...fresh,
            provider: { name: target.name, options: describeOptions(target.name, target.options), state, wrapped },
        });
    });
    try {
        providers[oldName]?.forget?.(oldCtx);
    } catch {
        /* a leftover item in the old store is harmless: the keyring no longer names it */
    }
    return { from: oldName, to: target.name };
}

/**
 * Remove what a provider keeps outside the keyring (a keychain item) for an account being removed. Best effort.
 *
 * @param {string} dir
 * @returns {() => void} call it once the account's folder is gone
 */
export function prepareForget(dir) {
    let ring = null;
    try {
        ring = readKeyring(dir);
    } catch {
        /* nothing to forget */
    }
    return () => {
        cache.delete(resolve(dir));
        if (!ring) return;
        try {
            providers[ring.provider.name]?.forget?.({
                account: ring.account,
                ref: ring.ref,
                options: ring.provider.options ?? {},
                state: ring.provider.state,
            });
        } catch {
            /* best effort */
        }
    };
}

/**
 * A subkey of the account's data key for one purpose (HKDF-SHA256; info names the purpose and the account).
 *
 * @param {Scope} scope
 * @param {string} purpose - one of {@link PURPOSES}
 * @param {{keyId?: string}} [opts] - a retired key's id, to read what was written before a rekey
 * @returns {{key: Buffer, keyId: string}}
 */
export function deriveDataKey(scope, purpose, { keyId } = {}) {
    if (!PURPOSES.includes(purpose))
        throw new KeystoreError(`unknown key purpose "${purpose}" (${PURPOSES.join(", ")})`, "CONFIG");
    const base = keyId ? { id: keyId, key: keyById(scope, keyId) } : currentKey(scope, "data");
    const key = Buffer.from(
        hkdfSync("sha256", base.key, Buffer.from(base.id, "utf8"), `zalo-agent-cli/v1/${purpose}/${scope.id}`, 32),
    );
    return { key, keyId: base.id };
}

/**
 * The file subkey of a key (boot or data): sealed files never use a raw keyring key.
 *
 * @param {Scope} scope
 * @param {{id: string, key: Buffer}} base
 * @returns {Buffer}
 */
export function fileKeyOf(scope, base) {
    return Buffer.from(
        hkdfSync("sha256", base.key, Buffer.from(base.id, "utf8"), `zalo-agent-cli/v1/file/${scope.id}`, 32),
    );
}

/**
 * Whether this process holds the account's data key (or could open it without a login).
 *
 * @param {Scope} scope
 * @returns {boolean}
 */
export function hasDkey(scope) {
    return Boolean(cache.get(resolve(scope.dir))?.dkeyKek);
}
