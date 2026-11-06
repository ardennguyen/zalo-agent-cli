/**
 * The session cipher: how every request's `params` is sealed and every reply's `data` is opened once a login
 * has handed out its key (`zpw_enk`).
 *
 * Wire facts (Zalo Web's `encodeAES`/`decodeAES`, spec-kernel 10.2): the key is the base64-decoded `zpw_enk`
 * (16 bytes, so AES-128); AES in CBC mode with an IV of 16 zero bytes and PKCS#7 padding; the plaintext is the
 * caller's UTF-8 text (a JSON string); the ciphertext travels as standard base64 (`+`, `/`, `=`), and the URL or
 * form encoder escapes it. Opening first undoes any URL escaping (`decodeURIComponent`), then reverses the rest.
 *
 * The kickout lookup's answer is sealed the same way under another key (`auth_ext_info.enk`), so both helpers take
 * the key as an argument rather than reading a session.
 *
 * Nothing here retries: the cipher is deterministic, a second try gives the same answer.
 */
import { createCipheriv, createDecipheriv, createHash, randomUUID } from "node:crypto";

/** A zero IV, as Zalo's session cipher uses. */
const ZERO_IV = Buffer.alloc(16);

/** The AES variant for a raw key of this many bytes. */
const AES_BY_LENGTH = new Map([
    [16, "aes-128-cbc"],
    [24, "aes-192-cbc"],
    [32, "aes-256-cbc"],
]);

/** UTF-8 that refuses malformed input, so a wrong key reads as a failure instead of as garbage text. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The algorithm and raw bytes of a base64 session key.
 *
 * @param {string} key - base64, as Zalo hands it out
 * @returns {{algorithm: string, bytes: Buffer}|null} null for a key of no AES length
 */
function sessionKey(key) {
    if (typeof key !== "string" || key === "") return null;
    const bytes = Buffer.from(key, "base64");
    const algorithm = AES_BY_LENGTH.get(bytes.length);
    return algorithm ? { algorithm, bytes } : null;
}

/**
 * Seal text with a session key.
 *
 * @param {string} key - the base64 key (`zpw_enk`, or the kickout `enk`)
 * @param {string} text - usually `JSON.stringify(params)`
 * @returns {string|null} standard base64, or null when the key is not a usable AES key
 */
export function sealSession(key, text) {
    const k = sessionKey(key);
    if (!k || typeof text !== "string") return null;
    const cipher = createCipheriv(k.algorithm, k.bytes, ZERO_IV);
    return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

/**
 * Open what {@link sealSession} sealed.
 *
 * @param {string} key - the base64 key it was sealed with
 * @param {string} data - base64, URL-escaped or not
 * @returns {string|null} the text, or null for any failure (wrong key, bad padding, not base64, not UTF-8)
 */
export function openSession(key, data) {
    const k = sessionKey(key);
    if (!k || typeof data !== "string" || data === "") return null;
    try {
        const raw = Buffer.from(decodeURIComponent(data), "base64");
        if (raw.length === 0 || raw.length % 16 !== 0) return null;
        const decipher = createDecipheriv(k.algorithm, k.bytes, ZERO_IV);
        return STRICT_UTF8.decode(Buffer.concat([decipher.update(raw), decipher.final()]));
    } catch {
        return null;
    }
}

/**
 * A new device id (the `imei` every request carries), the way Zalo Web makes one: a random UUID, a dash, and the
 * MD5 of the User-Agent in lowercase hex.
 *
 * @param {string} userAgent
 * @returns {string}
 */
export function makeImei(userAgent) {
    return `${randomUUID()}-${createHash("md5")
        .update(String(userAgent ?? ""))
        .digest("hex")}`;
}
