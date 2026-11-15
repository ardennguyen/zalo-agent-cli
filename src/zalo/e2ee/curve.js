/**
 * The Curve25519 primitives of the Signal protocol: key pairs, Diffie-Hellman agreement, and XEdDSA signatures.
 *
 * Keys follow the Signal serialization: a private key is 32 bytes (clamped), a public key is the 32-byte Montgomery
 * u-coordinate behind a one-byte type prefix 0x05 (33 bytes). A signed pre-key is signed with the identity key, which
 * is a Montgomery (X25519) key, so the signature is XEdDSA: the X25519 private scalar is used as an Ed25519 signing
 * scalar and the Montgomery public key is mapped to its Edwards twin to verify.
 *
 * Signing follows the XEdDSA specification exactly (the Edwards public key always has sign bit 0, the nonce hash is
 * domain-separated and mixes in 64 random bytes), so every Signal implementation accepts the result. Verification
 * takes the Edwards sign bit from the top bit of the signature's last byte, as Signal's reference verifier does: an
 * XEdDSA signature always has that bit clear, and older Signal signers that record the sign bit there verify too.
 *
 * The arithmetic is `@noble/curves` (MIT); the hashes are `node:crypto`. Protocol layer: no `src/core`, no `src/utils`.
 */
import { createHash, randomBytes } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

/** The one-byte type prefix of a serialized Curve25519 public key. */
export const DJB_TYPE = 0x05;

const Point = ed25519.Point;
const P = Point.Fp.ORDER;
const Q = Point.Fn.ORDER;

/**
 * A random source: given a length, return that many random bytes. Tests pass a deterministic one.
 *
 * @typedef {(length: number) => Uint8Array} RandomSource
 */

/** The default random source (the system CSPRNG). @type {RandomSource} */
export const systemRandom = (length) => new Uint8Array(randomBytes(length));

/**
 * View any byte container (ArrayBuffer, Uint8Array, Buffer) as a Uint8Array without copying.
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes
 * @returns {Uint8Array}
 */
export function u8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    throw new TypeError("expected bytes");
}

/** Clamp 32 bytes into an X25519 private scalar (a copy). */
function clamp(bytes) {
    const k = Uint8Array.from(u8(bytes));
    if (k.length !== 32) throw new Error("a private key is 32 bytes");
    k[0] &= 248;
    k[31] &= 127;
    k[31] |= 64;
    return k;
}

/**
 * The raw 32-byte Montgomery key of a serialized public key (33 bytes with the 0x05 prefix).
 *
 * @param {ArrayBuffer|ArrayBufferView} publicKey
 * @returns {Uint8Array}
 * @throws {Error} for any other length or prefix
 */
export function rawPublicKey(publicKey) {
    const b = u8(publicKey);
    if (b.length !== 33 || b[0] !== DJB_TYPE) throw new Error("invalid public key: expected 33 bytes with type 0x05");
    return b.subarray(1);
}

/**
 * Make a key pair from 32 private bytes (they are clamped), or from fresh random ones.
 *
 * @param {ArrayBuffer|ArrayBufferView} [privateBytes]
 * @param {RandomSource} [random]
 * @returns {{pubKey: Uint8Array, privKey: Uint8Array}} a 33-byte public key (0x05 prefix) and the clamped private key
 */
export function generateKeyPair(privateBytes, random = systemRandom) {
    const privKey = clamp(privateBytes ?? random(32));
    const pubKey = new Uint8Array(33);
    pubKey[0] = DJB_TYPE;
    pubKey.set(x25519.getPublicKey(privKey), 1);
    return { pubKey, privKey };
}

/**
 * X25519 agreement between our private key and their serialized public key.
 *
 * @param {ArrayBuffer|ArrayBufferView} publicKey - 33 bytes with the 0x05 prefix
 * @param {ArrayBuffer|ArrayBufferView} privateKey - 32 bytes
 * @returns {Uint8Array} the 32-byte shared secret
 * @throws {Error} for a malformed key or a low-order (all-zero) result
 */
export function calculateAgreement(publicKey, privateKey) {
    const priv = u8(privateKey);
    if (priv.length !== 32) throw new Error("a private key is 32 bytes");
    return x25519.getSharedSecret(priv, rawPublicKey(publicKey));
}

/** Little-endian bytes to a bigint. */
function leToBig(bytes) {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
    return n;
}

/** A bigint to `len` little-endian bytes. */
function bigToLe(n, len = 32) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        out[i] = Number(n & 0xffn);
        n >>= 8n;
    }
    return out;
}

const mod = (a, m) => ((a % m) + m) % m;

/** SHA-512 of the concatenated parts, reduced mod the group order. */
function hashToScalar(...parts) {
    const h = createHash("sha512");
    for (const p of parts) h.update(p);
    return mod(leToBig(h.digest()), Q);
}

/** The XEdDSA nonce-hash prefix: the 32-byte little-endian encoding of 2^256 - 2 (0xFE then 31 bytes of 0xFF). */
const HASH1_PREFIX = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 0xfe : 0xff));

/**
 * XEdDSA-sign a message with a Curve25519 private key (Signal's calculateSignature).
 *
 * @param {ArrayBuffer|ArrayBufferView} privateKey - 32 bytes
 * @param {ArrayBuffer|ArrayBufferView} message
 * @param {RandomSource} [random] - supplies the 64-byte nonce input Z
 * @returns {Uint8Array} the 64-byte signature R || s
 */
export function xeddsaSign(privateKey, message, random = systemRandom) {
    const k = mod(leToBig(clamp(privateKey)), Q);
    const E = Point.BASE.multiply(k).toBytes();
    // A has sign bit 0: when kB has sign bit 1, sign with -k (whose point is the negation, sign bit 0).
    const a = E[31] & 0x80 ? mod(-k, Q) : k;
    const A = Uint8Array.from(E);
    A[31] &= 0x7f;
    const M = u8(message);
    const Z = u8(random(64));
    if (Z.length !== 64) throw new Error("XEdDSA needs 64 random bytes");
    const r = hashToScalar(HASH1_PREFIX, bigToLe(a), M, Z);
    if (r === 0n) throw new Error("XEdDSA nonce reduced to zero; sign again");
    const R = Point.BASE.multiply(r).toBytes();
    const h = hashToScalar(R, A, M);
    const s = mod(r + h * a, Q);
    const sig = new Uint8Array(64);
    sig.set(R, 0);
    sig.set(bigToLe(s), 32);
    return sig;
}

/**
 * Verify an XEdDSA signature against a serialized Curve25519 public key (Signal's verifySignature).
 *
 * @param {ArrayBuffer|ArrayBufferView} publicKey - 33 bytes with the 0x05 prefix
 * @param {ArrayBuffer|ArrayBufferView} message
 * @param {ArrayBuffer|ArrayBufferView} signature - 64 bytes
 * @returns {boolean}
 */
export function xeddsaVerify(publicKey, message, signature) {
    let uBytes;
    try {
        uBytes = Uint8Array.from(rawPublicKey(publicKey));
    } catch {
        return false;
    }
    const sig = Uint8Array.from(u8(signature));
    if (sig.length !== 64) return false;
    uBytes[31] &= 0x7f;
    const u = mod(leToBig(uBytes), P);
    if (u === P - 1n) return false; // maps to no Edwards point
    // Birational map u -> y = (u - 1) / (u + 1).
    const y = mod((u - 1n) * Point.Fp.inv(u + 1n), P);
    const A = bigToLe(y);
    A[31] |= sig[63] & 0x80;
    sig[63] &= 0x7f;
    if (sig[63] & 0xe0) return false; // s must be below 2^253
    try {
        return ed25519.verify(sig, u8(message), A, { zip215: false });
    } catch {
        return false;
    }
}
