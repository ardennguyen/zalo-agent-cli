/**
 * RSA encryption for ZBS "API Gửi tin với hệ mã hóa RSA" (Zalo's ZBS docs).
 *
 * The docs' flow: the OA's public key comes from `rsa/key/gen` or `rsa/key/get` as a Base64 string of its bytes
 * (an X.509 SubjectPublicKeyInfo, "MIIC…"); the phone number (country-code form) and every value of template_data
 * are encrypted with it using the cipher `RSA/ECB/OAEPWITHSHA-256ANDMGF1PADDING`, and each ciphertext is sent as
 * Base64. Zalo decrypts with the private key it keeps.
 *
 * That cipher name is a Java transformation: OAEP with SHA-256 as the label digest. Java's default provider pairs
 * it with MGF1 over SHA-1, other providers with MGF1 over SHA-256, and node:crypto's `publicEncrypt` only offers
 * the second. So the OAEP padding is built here (RFC 8017 §7.1.1) with the MGF1 digest selectable (default SHA-1,
 * the Java default), and the raw RSA step is node:crypto's `publicEncrypt` with no padding.
 */

import { createHash, createPublicKey, constants, publicEncrypt, randomBytes } from "node:crypto";
import { OAError } from "../oa/transport.js";

/** OAEP label digest of `OAEPWITHSHA-256ANDMGF1PADDING`. */
const OAEP_HASH = "sha256";
const H_LEN = 32;
/** MGF1 digests accepted for `mgf1Hash`. */
export const MGF1_HASHES = Object.freeze(["sha1", "sha256"]);

/**
 * Read an RSA public key as the ZBS docs hand it out (Base64 of the DER SubjectPublicKeyInfo), or as PEM.
 *
 * @param {string|Buffer} key - Base64 text, PEM text, or DER bytes
 * @returns {import("node:crypto").KeyObject}
 * @throws {OAError} code `invalid_input`
 */
export function parsePublicKey(key) {
    try {
        let k;
        // DER starts with a SEQUENCE tag (0x30); Base64/PEM text never does ("0" is 0x30 too, but no Base64 SPKI
        // starts with "0": it starts with "MI").
        if (Buffer.isBuffer(key) && key[0] === 0x30) {
            k = createPublicKey({ key, format: "der", type: "spki" });
        } else {
            const text = String(key).trim();
            if (text.startsWith("-----BEGIN")) k = createPublicKey(text);
            else
                k = createPublicKey({
                    key: Buffer.from(text.replace(/\s+/g, ""), "base64"),
                    format: "der",
                    type: "spki",
                });
        }
        if (k.asymmetricKeyType !== "rsa") throw new Error(`a ${k.asymmetricKeyType} key, not RSA`);
        return k;
    } catch (e) {
        throw new OAError(`Not an RSA public key (Base64 or PEM): ${e.message}`, { code: "invalid_input" });
    }
}

function mgf1(seed, length, hash) {
    const out = [];
    let have = 0;
    for (let counter = 0; have < length; counter++) {
        const c = Buffer.alloc(4);
        c.writeUInt32BE(counter);
        const block = createHash(hash).update(seed).update(c).digest();
        out.push(block);
        have += block.length;
    }
    return Buffer.concat(out).subarray(0, length);
}

function xor(a, b) {
    const r = Buffer.alloc(a.length);
    for (let i = 0; i < a.length; i++) r[i] = a[i] ^ b[i];
    return r;
}

/**
 * The largest message (bytes) one OAEP-SHA-256 block can carry for this key: k - 2·32 - 2.
 * @param {import("node:crypto").KeyObject} key
 * @returns {number}
 */
export function maxPlaintextBytes(key) {
    const k = Math.ceil(key.asymmetricKeyDetails.modulusLength / 8);
    return k - 2 * H_LEN - 2;
}

/**
 * Encrypt one value with `RSA/ECB/OAEPWITHSHA-256ANDMGF1PADDING` and return it as Base64.
 *
 * @param {string} text - UTF-8 text
 * @param {import("node:crypto").KeyObject} key - from {@link parsePublicKey}
 * @param {object} [opts]
 * @param {"sha1"|"sha256"} [opts.mgf1Hash] - default "sha1" (Java's default provider)
 * @param {Buffer} [opts.seed] - the OAEP seed (tests only; random otherwise)
 * @returns {string} Base64 ciphertext
 * @throws {OAError} code `invalid_input` when the text is longer than one block allows
 */
export function rsaEncrypt(text, key, { mgf1Hash = "sha1", seed } = {}) {
    if (!MGF1_HASHES.includes(mgf1Hash)) {
        throw new OAError(`MGF1 digest must be one of ${MGF1_HASHES.join(", ")}`, { code: "invalid_input" });
    }
    const m = Buffer.from(String(text), "utf8");
    const k = Math.ceil(key.asymmetricKeyDetails.modulusLength / 8);
    const max = k - 2 * H_LEN - 2;
    if (m.length > max) {
        throw new OAError(`A value of ${m.length} bytes is too long for this RSA key (at most ${max} bytes)`, {
            code: "invalid_input",
        });
    }
    const lHash = createHash(OAEP_HASH).update(Buffer.alloc(0)).digest();
    const ps = Buffer.alloc(k - m.length - 2 * H_LEN - 2);
    const db = Buffer.concat([lHash, ps, Buffer.from([1]), m]);
    const s = seed ?? randomBytes(H_LEN);
    const maskedDb = xor(db, mgf1(s, k - H_LEN - 1, mgf1Hash));
    const maskedSeed = xor(s, mgf1(maskedDb, H_LEN, mgf1Hash));
    const em = Buffer.concat([Buffer.from([0]), maskedSeed, maskedDb]);
    return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, em).toString("base64");
}

/**
 * Encrypt every value of `template_data` (each as its string form), keeping the keys, as the RSA send requires.
 *
 * @param {Record<string, any>} data
 * @param {import("node:crypto").KeyObject} key
 * @param {object} [opts] - as {@link rsaEncrypt}
 * @returns {Record<string, string>}
 */
export function encryptTemplateData(data, key, opts) {
    const out = {};
    for (const [name, value] of Object.entries(data || {})) out[name] = rsaEncrypt(String(value), key, opts);
    return out;
}
