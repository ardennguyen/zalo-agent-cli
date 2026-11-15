/**
 * Generate the Signal keys a device publishes, and read a device bundle back from its store.
 *
 * A device needs a fixed set of keys to be addressable: an identity key pair, a registration id, a signed pre-key with
 * its signature, and a batch of one-time pre-keys. {@link generateDeviceIdentity} makes all of them (./signal-protocol.js)
 * and fills a {@link SignalProtocolStore}; the account layer seals that store to disk. {@link bundleFromStore}
 * reads the public half back out, in the order a SUBMIT_BUNDLE needs (src/zalo/e2ee/bundle-wire.js).
 *
 * Protocol layer: no `src/core`, no `src/utils`.
 */
import { SignalProtocolStore } from "./signal-store.js";
import {
    generateIdentityKeyPair,
    generatePreKey,
    generateRegistrationId,
    generateSignedPreKey,
} from "./signal-protocol.js";

/** How many one-time pre-keys a fresh device publishes (Zalo's devices publish a batch of 20). */
export const DEFAULT_ONE_TIME_PREKEY_COUNT = 20;
/**
 * Fallback signed pre-key id for a store built by hand. A generated identity numbers its signed pre-key
 * registrationId + 1, as Zalo's devices do.
 */
export const SIGNED_PREKEY_ID = 1;
/** The id of the first one-time pre-key in a batch; ids run upward from here. */
export const FIRST_ONE_TIME_PREKEY_ID = 100;

/**
 * Generate a fresh device identity and fill a store with it.
 *
 * @param {object} [opts]
 * @param {number} [opts.preKeyCount] - how many one-time pre-keys to make
 * @param {number} [opts.signedPreKeyId] - default registrationId + 1
 * @param {number} [opts.firstPreKeyId]
 * @returns {Promise<{store: SignalProtocolStore, registrationId: number, signedPreKeyId: number,
 *   preKeyIds: number[]}>}
 */
export async function generateDeviceIdentity({
    preKeyCount = DEFAULT_ONE_TIME_PREKEY_COUNT,
    signedPreKeyId,
    firstPreKeyId = FIRST_ONE_TIME_PREKEY_ID,
} = {}) {
    const store = new SignalProtocolStore();

    const identityKeyPair = generateIdentityKeyPair();
    const registrationId = generateRegistrationId();
    store.setIdentity(identityKeyPair, registrationId);
    signedPreKeyId = signedPreKeyId ?? registrationId + 1;

    const signed = generateSignedPreKey(identityKeyPair, signedPreKeyId);
    store.addSignedPreKey(signed.keyId, signed.keyPair, signed.signature);

    const preKeyIds = [];
    for (let i = 0; i < Math.max(1, preKeyCount); i++) {
        const id = firstPreKeyId + i;
        const pk = generatePreKey(id);
        store.addPreKey(pk.keyId, pk.keyPair);
        preKeyIds.push(id);
    }

    return { store, registrationId, signedPreKeyId, preKeyIds };
}

/**
 * Make a fresh batch of one-time pre-keys and add them to a store (to replenish after some were consumed).
 *
 * @param {SignalProtocolStore} store
 * @param {object} [opts]
 * @param {number} [opts.count]
 * @param {number} [opts.firstPreKeyId] - the first id; pick one past the highest id already held
 * @returns {Promise<number[]>} the ids added
 */
export async function generateOneTimePreKeys(store, { count = DEFAULT_ONE_TIME_PREKEY_COUNT, firstPreKeyId } = {}) {
    const start =
        firstPreKeyId ?? (store.preKeyIds().length ? Math.max(...store.preKeyIds()) + 1 : FIRST_ONE_TIME_PREKEY_ID);
    const ids = [];
    for (let i = 0; i < Math.max(1, count); i++) {
        const id = start + i;
        const pk = generatePreKey(id);
        store.addPreKey(pk.keyId, pk.keyPair);
        ids.push(id);
    }
    return ids;
}

/**
 * The public bundle a store publishes, with every key as base64 (what SUBMIT_BUNDLE sends). One one-time pre-key is
 * offered per bundle, the lowest id still held, as Zalo's devices do.
 *
 * @param {SignalProtocolStore} store
 * @returns {{registrationId: number, identityKey: string, signedPreKey: {keyId: number, publicKey: string,
 *   signature: string}, preKeys: Array<{keyId: number, publicKey: string}>}}
 */
export function bundleFromStore(store) {
    const snap = store.toJSON();
    if (!snap.identityKeyPair || snap.registrationId === null) {
        throw new Error("the store has no device identity to publish");
    }
    const signed = snap.signedPreKeys[0];
    if (!signed) throw new Error("the store has no signed pre-key to publish");
    return {
        registrationId: snap.registrationId,
        identityKey: snap.identityKeyPair.pubKey,
        signedPreKey: { keyId: signed[0], publicKey: signed[1].pubKey, signature: signed[1].signature },
        preKeys: snap.preKeys.map(([keyId, kp]) => ({ keyId, publicKey: kp.pubKey })),
    };
}
