/**
 * Open the cloud key the phone encrypted to this device.
 *
 * The phone (the account itself, device 0) fetches this device's published bundle, runs X3DH on its side, and sends a
 * pre-key (type-3) Signal message as `encrypted_private_key`. Here we strip the one-byte transport tag
 * (./transport-tag.js), then let the session cipher build the session from the message's embedded base key / identity /
 * pre-key ids together with our stored identity, signed pre-key and the matching one-time pre-key, and decrypt. The
 * plaintext is the account's cloud RSA private key as base64 PKCS#8 text.
 *
 * Processing a pre-key message consumes the matched one-time pre-key (standard X3DH): the store must still hold it at
 * this point, and after this it is gone, so the caller persists the updated store.
 *
 * Protocol layer: no `src/core`, no `src/utils`. The library is loaded lazily (./signal-lib.js).
 */
import { PRE_KEY_TYPE, splitTypeAndMessage } from "./transport-tag.js";
import { loadSignalLib } from "./signal-lib.js";

/** Raised when the reply is not a pre-key message or will not decrypt. */
export class CloudKeyDecryptError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "CloudKeyDecryptError";
    }
}

/**
 * Decrypt `encrypted_private_key` into the base64 PKCS#8 cloud key.
 *
 * @param {object} args
 * @param {import("./signal-store.js").SignalProtocolStore} args.store - this device's Signal store (holds the identity,
 *   signed pre-key and one-time pre-keys); mutated in place as the one-time pre-key is consumed
 * @param {string} args.encryptedPrivateKey - the control's `encrypted_private_key` (base64, type-tagged)
 * @param {string} args.ownUid - the account's own id (the sender, device 0)
 * @param {number} [args.senderDeviceId=0] - the phone is device 0
 * @returns {Promise<string>} the cloud private key, base64 PKCS#8
 * @throws {CloudKeyDecryptError}
 */
export async function decryptCloudKeyReply({ store, encryptedPrivateKey, ownUid, senderDeviceId = 0 }) {
    let split;
    try {
        split = splitTypeAndMessage(encryptedPrivateKey);
    } catch (e) {
        throw new CloudKeyDecryptError(`the reply is not a readable encrypted payload: ${e.message}`);
    }
    if (split.type !== PRE_KEY_TYPE) {
        throw new CloudKeyDecryptError(
            `the reply is message type ${split.type}, not a pre-key message (${PRE_KEY_TYPE}); no session can be built from it`,
        );
    }
    const lib = await loadSignalLib();
    const address = new lib.SignalProtocolAddress(String(ownUid), Number(senderDeviceId));
    const cipher = new lib.SessionCipher(store, address);
    let plaintext;
    try {
        plaintext = await cipher.decryptPreKeyWhisperMessage(split.message);
    } catch (e) {
        throw new CloudKeyDecryptError(`the cloud-key message did not decrypt: ${e?.message || e}`);
    }
    const text = Buffer.from(new Uint8Array(plaintext)).toString("utf8").trim();
    if (!text) throw new CloudKeyDecryptError("the decrypted cloud key was empty");
    return text;
}
