/**
 * An in-memory Signal protocol store for the narrow end-to-end-encryption device this engine can register.
 *
 * The off-the-shelf Signal library (loaded lazily by its siblings in this folder) drives a store that holds the
 * device's identity key pair, its registration id, its signed pre-key and one-time pre-keys, the per-peer sessions it
 * builds, and the identities it has seen. That store is normally a database; here it is a small object that
 * {@link SignalProtocolStore.toJSON} serializes to plain JSON (every key as base64) so the account layer can seal it to
 * disk (src/core/e2ee-device.js) and {@link SignalProtocolStore.fromJSON} reload it.
 *
 * This file is the protocol layer: it imports no `src/core` and no `src/utils`, only Node and the Signal library's
 * data shapes. It never touches the network and never reads or writes a file — persistence is the caller's job. The
 * only peer this store ever talks to is the account itself (the phone, device 0, is the sender of the cloud key), so
 * identities are trusted on first use.
 */

/** The Signal protocol version these keys speak (X3DH + Double Ratchet, message version 3). */
export const SIGNAL_MESSAGE_VERSION = 3;

/** Copy any byte view into a standalone ArrayBuffer (Node Buffers share a pool, so never alias one). */
function toArrayBuffer(view) {
    const u8 =
        view instanceof ArrayBuffer ? new Uint8Array(view) : view instanceof Uint8Array ? view : new Uint8Array(view);
    const out = new ArrayBuffer(u8.byteLength);
    new Uint8Array(out).set(u8);
    return out;
}

/** Base64 of an ArrayBuffer/Uint8Array. */
export function abToBase64(ab) {
    return Buffer.from(ab instanceof ArrayBuffer ? new Uint8Array(ab) : ab).toString("base64");
}

/** A standalone ArrayBuffer from base64 text (copied out of the Buffer pool). */
export function base64ToAb(text) {
    return toArrayBuffer(Buffer.from(String(text), "base64"));
}

/** Serialize a {pubKey, privKey} pair to base64. */
function keyPairToJson(kp) {
    return { pubKey: abToBase64(kp.pubKey), privKey: abToBase64(kp.privKey) };
}

/** Rebuild a {pubKey, privKey} pair of ArrayBuffers from its base64 form. */
function keyPairFromJson(j) {
    return { pubKey: base64ToAb(j.pubKey), privKey: base64ToAb(j.privKey) };
}

/**
 * The store. Construct empty, fill it with {@link setIdentity} / {@link addSignedPreKey} / {@link addPreKey} (what the
 * generator in ./identity.js does), or rebuild a saved one with {@link SignalProtocolStore.fromJSON}.
 */
export class SignalProtocolStore {
    constructor() {
        /** @type {{pubKey: ArrayBuffer, privKey: ArrayBuffer}|null} */
        this._identityKeyPair = null;
        /** @type {number|null} */
        this._registrationId = null;
        /** @type {Map<number, {pubKey: ArrayBuffer, privKey: ArrayBuffer}>} */
        this._preKeys = new Map();
        /** @type {Map<number, {pubKey: ArrayBuffer, privKey: ArrayBuffer, signature: ArrayBuffer}>} */
        this._signedPreKeys = new Map();
        /** @type {Map<string, string>} session records, keyed by encoded address */
        this._sessions = new Map();
        /** @type {Map<string, ArrayBuffer>} trusted identities, keyed by encoded address */
        this._identities = new Map();
    }

    /**
     * Set the device identity.
     *
     * @param {{pubKey: ArrayBuffer, privKey: ArrayBuffer}} keyPair
     * @param {number} registrationId
     */
    setIdentity(keyPair, registrationId) {
        this._identityKeyPair = { pubKey: toArrayBuffer(keyPair.pubKey), privKey: toArrayBuffer(keyPair.privKey) };
        this._registrationId = Number(registrationId);
    }

    /**
     * Add a signed pre-key (its signature is kept for the bundle and for re-submission).
     *
     * @param {number} keyId
     * @param {{pubKey: ArrayBuffer, privKey: ArrayBuffer}} keyPair
     * @param {ArrayBuffer} signature
     */
    addSignedPreKey(keyId, keyPair, signature) {
        this._signedPreKeys.set(Number(keyId), {
            pubKey: toArrayBuffer(keyPair.pubKey),
            privKey: toArrayBuffer(keyPair.privKey),
            signature: toArrayBuffer(signature),
        });
    }

    /**
     * Add a one-time pre-key.
     *
     * @param {number} keyId
     * @param {{pubKey: ArrayBuffer, privKey: ArrayBuffer}} keyPair
     */
    addPreKey(keyId, keyPair) {
        this._preKeys.set(Number(keyId), {
            pubKey: toArrayBuffer(keyPair.pubKey),
            privKey: toArrayBuffer(keyPair.privKey),
        });
    }

    /** How many one-time pre-keys are left (they are consumed when a peer opens a session with one). */
    preKeyCount() {
        return this._preKeys.size;
    }

    /** The ids of the one-time pre-keys still held. */
    preKeyIds() {
        return [...this._preKeys.keys()];
    }

    // ---- StorageType, what the Signal library calls --------------------------------------------------------------

    /** @returns {Promise<{pubKey: ArrayBuffer, privKey: ArrayBuffer}|undefined>} */
    async getIdentityKeyPair() {
        return this._identityKeyPair ?? undefined;
    }

    /** @returns {Promise<number|undefined>} */
    async getLocalRegistrationId() {
        return this._registrationId ?? undefined;
    }

    /**
     * Trust on first use: this store only ever speaks to the account itself. A changed key for a known address is
     * still rejected (it would mean a different device), so a saved identity is honored.
     *
     * @param {string} identifier
     * @param {ArrayBuffer} identityKey
     * @returns {Promise<boolean>}
     */
    async isTrustedIdentity(identifier, identityKey) {
        const seen = this._identities.get(String(identifier));
        if (!seen) return true;
        return abToBase64(seen) === abToBase64(identityKey);
    }

    /**
     * @param {string} identifier
     * @param {ArrayBuffer} identityKey
     * @returns {Promise<boolean>} whether the stored identity changed
     */
    async saveIdentity(identifier, identityKey) {
        const key = String(identifier);
        const prev = this._identities.get(key);
        this._identities.set(key, toArrayBuffer(identityKey));
        return Boolean(prev && abToBase64(prev) !== abToBase64(identityKey));
    }

    /** @param {number|string} keyId @returns {Promise<{pubKey: ArrayBuffer, privKey: ArrayBuffer}|undefined>} */
    async loadPreKey(keyId) {
        const kp = this._preKeys.get(Number(keyId));
        return kp ? { pubKey: kp.pubKey, privKey: kp.privKey } : undefined;
    }

    /** @param {number|string} keyId @param {{pubKey: ArrayBuffer, privKey: ArrayBuffer}} keyPair */
    async storePreKey(keyId, keyPair) {
        this.addPreKey(Number(keyId), keyPair);
    }

    /** @param {number|string} keyId */
    async removePreKey(keyId) {
        this._preKeys.delete(Number(keyId));
    }

    /** @param {number|string} keyId @returns {Promise<{pubKey: ArrayBuffer, privKey: ArrayBuffer}|undefined>} */
    async loadSignedPreKey(keyId) {
        const kp = this._signedPreKeys.get(Number(keyId));
        return kp ? { pubKey: kp.pubKey, privKey: kp.privKey } : undefined;
    }

    /** @param {number|string} keyId @param {{pubKey: ArrayBuffer, privKey: ArrayBuffer}} keyPair */
    async storeSignedPreKey(keyId, keyPair) {
        const prev = this._signedPreKeys.get(Number(keyId));
        this.addSignedPreKey(Number(keyId), keyPair, prev?.signature ?? new ArrayBuffer(0));
    }

    /** @param {number|string} keyId */
    async removeSignedPreKey(keyId) {
        this._signedPreKeys.delete(Number(keyId));
    }

    /** @param {string} encodedAddress @returns {Promise<string|undefined>} */
    async loadSession(encodedAddress) {
        return this._sessions.get(String(encodedAddress));
    }

    /** @param {string} encodedAddress @param {string} record */
    async storeSession(encodedAddress, record) {
        this._sessions.set(String(encodedAddress), record);
    }

    // ---- persistence ---------------------------------------------------------------------------------------------

    /**
     * A plain JSON-able snapshot (every key base64). The caller seals it.
     *
     * @returns {object}
     */
    toJSON() {
        return {
            v: 1,
            identityKeyPair: this._identityKeyPair ? keyPairToJson(this._identityKeyPair) : null,
            registrationId: this._registrationId,
            preKeys: [...this._preKeys].map(([id, kp]) => [id, keyPairToJson(kp)]),
            signedPreKeys: [...this._signedPreKeys].map(([id, kp]) => [
                id,
                { ...keyPairToJson(kp), signature: abToBase64(kp.signature) },
            ]),
            sessions: [...this._sessions],
            identities: [...this._identities].map(([addr, key]) => [addr, abToBase64(key)]),
        };
    }

    /**
     * Rebuild a store from {@link SignalProtocolStore.toJSON}.
     *
     * @param {object} obj
     * @returns {SignalProtocolStore}
     */
    static fromJSON(obj) {
        const store = new SignalProtocolStore();
        if (!obj || typeof obj !== "object") return store;
        if (obj.identityKeyPair) store._identityKeyPair = keyPairFromJson(obj.identityKeyPair);
        store._registrationId = obj.registrationId ?? null;
        for (const [id, kp] of obj.preKeys ?? []) store._preKeys.set(Number(id), keyPairFromJson(kp));
        for (const [id, kp] of obj.signedPreKeys ?? []) {
            store._signedPreKeys.set(Number(id), { ...keyPairFromJson(kp), signature: base64ToAb(kp.signature) });
        }
        for (const [addr, rec] of obj.sessions ?? []) store._sessions.set(String(addr), rec);
        for (const [addr, key] of obj.identities ?? []) store._identities.set(String(addr), base64ToAb(key));
        return store;
    }
}
