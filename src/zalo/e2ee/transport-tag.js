/**
 * The one-byte message-type tag a Zalo end-to-end payload carries in front of the standard Signal message.
 *
 * The standard Signal library keeps a ciphertext's type in a separate field (`{type, body}`); Zalo's protocol
 * instead prepends that type as a single byte to the body and base64s the pair, and strips it again before decrypting. So a Zalo `encrypted_private_key` is
 * `base64( [typeByte] ++ serializedSignalMessage )`, and to decrypt it we take the first byte as the type and hand the
 * rest to the session cipher. For the cloud key the type is always PRE_KEY (3): a pre-key message that sets up the
 * session on our side.
 */

/** Zalo's transport type tags (the same numbering the standard Signal message types use). */
export const WHISPER_TYPE = 2;
export const PRE_KEY_TYPE = 3;
export const SENDER_KEY_TYPE = 4;
export const SENDER_KEY_DISTRIBUTION_TYPE = 5;

/**
 * Split a base64 payload into its one-byte type tag and the Signal message bytes that follow it.
 *
 * @param {string} base64 - the `encrypted_private_key` (or any tagged payload)
 * @returns {{type: number, message: ArrayBuffer}}
 * @throws {Error} for an empty or non-string payload
 */
export function splitTypeAndMessage(base64) {
    if (typeof base64 !== "string" || base64 === "") throw new Error("not a tagged payload");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length < 2) throw new Error("tagged payload is too short to hold a type and a message");
    // Copy into a standalone ArrayBuffer: a Node Buffer shares the pool, so its `.buffer` must never be handed out.
    const rest = bytes.subarray(1);
    const message = new ArrayBuffer(rest.length);
    new Uint8Array(message).set(rest);
    return { type: bytes[0], message };
}

/**
 * Prepend a type tag to a Signal message and base64 it (the inverse of {@link splitTypeAndMessage}; used by the test
 * "phone" to build a payload the real strip opens).
 *
 * @param {number} type
 * @param {ArrayBuffer|Uint8Array|Buffer|string} message - the serialized Signal message (bytes, or a binary string)
 * @returns {string}
 */
export function concatTypeAndMessage(type, message) {
    let body;
    if (typeof message === "string") {
        body = Buffer.from(message, "binary");
    } else if (message instanceof ArrayBuffer) {
        body = Buffer.from(new Uint8Array(message));
    } else {
        body = Buffer.from(message);
    }
    return Buffer.concat([Buffer.from([type & 0xff]), body]).toString("base64");
}
