/**
 * The INIT_SUBDEVICE phase of registration: build a Signal session from our device to one of the account's other
 * devices (its published bundle) and encrypt the init message the server expects, so the device counts as live.
 *
 * A device runs this for every platform slot except its own after submitting its bundle: fetch the peer's
 * bundle (GET_BUNDLE 541), build a session, encrypt the init message ({@link INIT_MESSAGE}), and announce the result with
 * INIT_SESSION (543). Here we build just the per-device init message; the live layer (src/core/e2ee-live.js) does the
 * socket round-trips.
 *
 * Protocol layer: no `src/core`, no `src/utils`.
 */
import { base64ToAb } from "./signal-store.js";
import { concatTypeAndMessage } from "./transport-tag.js";
import { encodeAddress, encryptMessage, processPreKeyBundle } from "./signal-protocol.js";

/**
 * The init-message plaintext the client encrypts when announcing a session to its own other devices: the v2 format,
 * a JSON object naming the subdevices to forward (none for the connect-time subdevice init). The older fixed text
 * "ZaloE2ee" is not what the current clients send, and a device that cannot read it builds no session with us.
 */
export const INIT_MESSAGE = JSON.stringify({ subDevice: [] });

/**
 * Build the type-tagged init message for one subdevice: process its bundle into a session in our store, then encrypt
 * {@link INIT_MESSAGE}. Mutates `store` (it gains the session) — the caller persists it.
 *
 * @param {object} args
 * @param {import("./signal-store.js").SignalProtocolStore} args.store - our device's store
 * @param {string} args.ownUid - the account's own id (the peer is our own other device)
 * @param {number} args.deviceId - the peer platform slot
 * @param {{registrationId: number, identityKey: string, signedPreKey: {keyId: number, publicKey: string,
 *   signature: string}, preKey: {keyId: number, publicKey: string}|null}} args.bundleItem - from decodeBundleItem
 * @returns {Promise<string>} the type-tagged init message (base64), for INIT_SESSION's `data[].initMsg`
 */
export async function buildSubdeviceInit({ store, ownUid, deviceId, bundleItem }) {
    const address = encodeAddress(ownUid, deviceId);
    const processed = {
        registrationId: bundleItem.registrationId,
        identityKey: base64ToAb(bundleItem.identityKey),
        signedPreKey: {
            keyId: bundleItem.signedPreKey.keyId,
            publicKey: base64ToAb(bundleItem.signedPreKey.publicKey),
            signature: base64ToAb(bundleItem.signedPreKey.signature),
        },
    };
    if (bundleItem.preKey) {
        processed.preKey = { keyId: bundleItem.preKey.keyId, publicKey: base64ToAb(bundleItem.preKey.publicKey) };
    }
    await processPreKeyBundle(store, address, processed);
    const ciphertext = await encryptMessage(store, address, new TextEncoder().encode(INIT_MESSAGE));
    return concatTypeAndMessage(ciphertext.type, ciphertext.body);
}
