/**
 * Open the cloud key the phone encrypted to this device.
 *
 * The phone (the account itself, device 0) answers on the Signal session our subdevice init set up with it: a normal
 * (type-2) message, decrypted on that session. A pre-key (type-3) message is also handled: the session cipher builds the
 * session from the message's embedded base key / identity / pre-key ids together with our stored identity, signed
 * pre-key and the matching one-time pre-key. Either way we first strip the one-byte transport tag (./transport-tag.js).
 * The plaintext is the account's cloud RSA private key as base64 PKCS#8 text.
 *
 * Processing a pre-key message consumes the matched one-time pre-key (standard X3DH): the store must still hold it at
 * this point, and after this it is gone, so the caller persists the updated store.
 *
 * Protocol layer: no `src/core`, no `src/utils`. The library is loaded lazily (./signal-lib.js).
 */
import { PRE_KEY_TYPE, WHISPER_TYPE, splitTypeAndMessage } from "./transport-tag.js";
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
    const lib = await loadSignalLib();
    const address = new lib.SignalProtocolAddress(String(ownUid), Number(senderDeviceId));
    // The usual case: the phone answers on the session our subdevice init set up with it, as a normal (type-2) message.
    if (split.type === WHISPER_TYPE) {
        let plain;
        try {
            plain = await new lib.SessionCipher(store, address).decryptWhisperMessage(split.message);
        } catch (e) {
            throw new CloudKeyDecryptError(
                `the cloud-key message did not decrypt on the session with the phone: ${e?.message || e}`,
            );
        }
        const out = Buffer.from(new Uint8Array(plain)).toString("utf8").trim();
        if (!out) throw new CloudKeyDecryptError("the decrypted cloud key was empty");
        return out;
    }
    if (split.type !== PRE_KEY_TYPE) {
        throw new CloudKeyDecryptError(
            `the reply is message type ${split.type}, neither a session (${WHISPER_TYPE}) nor a pre-key (${PRE_KEY_TYPE}) message`,
        );
    }
    const header = readPreKeyHeader(split.message);
    let plaintext;
    let firstError;
    try {
        plaintext = await new lib.SessionCipher(store, address).decryptPreKeyWhisperMessage(split.message);
    } catch (e) {
        firstError = e;
    }
    // The ids in the message are lookup handles chosen by whoever numbered the bundle; the key material is what
    // decrypts. When the referenced id is not held under that number, try each held key under the referenced id.
    if (plaintext === undefined) plaintext = await decryptWithHeldKeys(lib, store, address, split.message, header);
    if (plaintext === undefined) {
        throw new CloudKeyDecryptError(
            `the cloud-key message did not decrypt: ${firstError?.message || firstError} ` +
                `(message refers to signed pre-key ${header?.signedPreKeyId ?? "?"}, ` +
                `one-time pre-key ${header?.preKeyId ?? "none"}; this device holds signed ` +
                `[${store.signedPreKeyIds().join(",")}], one-time ${describeIds(store.preKeyIds())})`,
        );
    }
    const text = Buffer.from(new Uint8Array(plaintext)).toString("utf8").trim();
    if (!text) throw new CloudKeyDecryptError("the decrypted cloud key was empty");
    return text;
}

/**
 * Retry the decrypt with every held signed pre-key (and one-time pre-key) presented under the ids the message names.
 * Each attempt runs on a scratch view of the store, so a failed attempt leaves no session or consumed key behind; the
 * winning attempt's session is copied back and its real one-time pre-key removed.
 *
 * @returns {Promise<ArrayBuffer|undefined>}
 */
async function decryptWithHeldKeys(lib, store, address, message, header) {
    if (!header || header.signedPreKeyId === undefined) return undefined;
    const oneTime = header.preKeyId === undefined ? [undefined] : [...store.preKeyIds(), undefined];
    for (const signedId of store.signedPreKeyIds()) {
        for (const preId of oneTime) {
            const view = aliasView(store, { header, signedId, preId });
            try {
                const plaintext = await new lib.SessionCipher(view, address).decryptPreKeyWhisperMessage(message);
                for (const [k, v] of view.scratchSessions) await store.storeSession(k, v);
                if (preId !== undefined) await store.removePreKey(preId);
                return plaintext;
            } catch {
                // next candidate
            }
        }
    }
    return undefined;
}

/** A store view that answers the message's ids with the given held keys and keeps writes to itself. */
function aliasView(store, { header, signedId, preId }) {
    const view = Object.create(store);
    view.scratchSessions = new Map();
    view.loadSignedPreKey = async (id) => store.loadSignedPreKey(Number(id) === header.signedPreKeyId ? signedId : id);
    view.loadPreKey = async (id) =>
        preId !== undefined && Number(id) === header.preKeyId ? store.loadPreKey(preId) : undefined;
    view.loadSession = async (k) => view.scratchSessions.get(String(k)) ?? store.loadSession(k);
    view.storeSession = async (k, v) => void view.scratchSessions.set(String(k), v);
    view.removePreKey = async () => {};
    view.saveIdentity = async () => false;
    return view;
}

/** A short, secret-free summary of a list of key ids. */
function describeIds(ids) {
    if (!ids.length) return "none";
    const sorted = [...ids].sort((a, b) => a - b);
    return `${sorted.length} (${sorted[0]}..${sorted[sorted.length - 1]})`;
}

/**
 * Read the public header ids of a serialized PreKeyWhisperMessage: one version byte, then protobuf fields
 * preKeyId=1, registrationId=5, signedPreKeyId=6 (varints; the bytes fields 2-4 are skipped).
 *
 * @param {ArrayBuffer} message
 * @returns {{preKeyId?: number, registrationId?: number, signedPreKeyId?: number}|null} null when unreadable
 */
export function readPreKeyHeader(message) {
    const b = new Uint8Array(message);
    const out = {};
    let i = 1;
    const varint = () => {
        let v = 0;
        let mul = 1;
        for (;;) {
            if (i >= b.length) throw new Error("truncated");
            const c = b[i++];
            v += (c & 0x7f) * mul;
            if (!(c & 0x80)) return v;
            mul *= 128;
        }
    };
    try {
        while (i < b.length) {
            const key = varint();
            const field = Math.floor(key / 8);
            const wire = key & 7;
            if (wire === 0) {
                const v = varint();
                if (field === 1) out.preKeyId = v;
                else if (field === 5) out.registrationId = v;
                else if (field === 6) out.signedPreKeyId = v;
            } else if (wire === 2) {
                const len = varint(); // read first: `i += varint()` would add to the pre-read index
                i += len;
            } else {
                return null;
            }
        }
    } catch {
        return null;
    }
    return out;
}
