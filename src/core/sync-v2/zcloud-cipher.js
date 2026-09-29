/**
 * zCloud's params/response cipher — a Node-crypto port of Zalo Web's own.
 *
 * zCloud (`zcld.chat.zalo.me`) does not use the session cipher every other
 * Zalo endpoint uses (the session key with an all-zero IV — zca-js's
 * `encodeAES`/`decodeAES`). Zalo Web's zCloud layer keys a separate AES-CBC
 * with `enk`, the second half of the account's cloud viewer key pair, and
 * prepends a fresh random IV to every ciphertext:
 *
 *   encryptAES(json, enk) = base64( iv16 ‖ AES-CBC-PKCS7(utf8(json), key = base64decode(enk)) )
 *   decryptAES(b64,  enk) = the same, reading the first 16 bytes as the IV
 *   encodeParams(obj)     = encodeURIComponent(encryptAES(JSON.stringify(obj), enk))
 *
 * Source: bundle 1.e0ef5e98f8f9d8970e2c.js, module `98yS` (@2868035) and
 * `tP1L.encodeParams`, build 826674fb31d2af1b2b59, captured 2026-09-29.
 *
 * CryptoJS picks the AES variant from the key's length, so a 16/24/32-byte enk
 * means AES-128/192/256; any other length is refused rather than guessed.
 * Decryption also refuses bytes that are not valid UTF-8 — CryptoJS's
 * `toString(Utf8)` throws "Malformed UTF-8 data" in the same case — so a wrong
 * key surfaces as an error instead of as garbage.
 *
 * Key material never leaves these functions and is never logged.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 16;
const BLOCK_BYTES = 16;
const ALGORITHM_BY_KEY_BYTES = { 16: "aes-128-cbc", 24: "aes-192-cbc", 32: "aes-256-cbc" };
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Decode enk into an AES key and the cipher name its length implies. */
function keyOf(enk) {
    const key = typeof enk === "string" && enk ? Buffer.from(enk, "base64") : Buffer.alloc(0);
    const algorithm = ALGORITHM_BY_KEY_BYTES[key.length];
    if (!algorithm) {
        throw new Error(`zCloud enk must decode to a 16-, 24- or 32-byte AES key (got ${key.length} bytes)`);
    }
    return { key, algorithm };
}

/**
 * Encrypt a string the way Zalo Web's zCloud layer does.
 *
 * @param {string} plaintext
 * @param {string} enk - base64 AES key from the viewer key pair
 * @returns {string} base64 of a random 16-byte IV followed by the ciphertext
 */
export function encryptZCloud(plaintext, enk) {
    const { key, algorithm } = keyOf(enk);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(algorithm, key, iv);
    return Buffer.concat([iv, cipher.update(String(plaintext), "utf8"), cipher.final()]).toString("base64");
}

/**
 * Decrypt a zCloud ciphertext (a reply's `data`, or a request's `params`).
 *
 * Tolerates a percent-encoded value — base64 never contains `%`, so decoding
 * one cannot corrupt a plain value.
 *
 * @param {string} ciphertext - base64(iv16 ‖ ciphertext)
 * @param {string} enk - base64 AES key from the viewer key pair
 * @returns {string} the UTF-8 plaintext
 */
export function decryptZCloud(ciphertext, enk) {
    const { key, algorithm } = keyOf(enk);
    let text = String(ciphertext ?? "");
    if (text.includes("%")) text = decodeURIComponent(text);
    const raw = Buffer.from(text, "base64");
    if (raw.length <= IV_BYTES || (raw.length - IV_BYTES) % BLOCK_BYTES !== 0) {
        throw new Error("zCloud ciphertext is not a 16-byte IV followed by whole AES blocks");
    }
    const decipher = createDecipheriv(algorithm, key, raw.subarray(0, IV_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES)), decipher.final()]);
    return utf8.decode(plain);
}

/**
 * Zalo Web's `encodeParams`: the value of a zCloud request's `params` query field.
 *
 * @param {object} params
 * @param {string} enk
 * @returns {string} encodeURIComponent(base64(iv ‖ ciphertext))
 */
export function encodeZCloudParams(params, enk) {
    return encodeURIComponent(encryptZCloud(JSON.stringify(params), enk));
}
