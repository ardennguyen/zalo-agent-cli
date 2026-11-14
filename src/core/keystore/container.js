/**
 * The sealed-file container: one small, versioned envelope around AES-256-GCM ciphertext.
 *
 *     "ZACSEAL" | version (1 byte) | header length (u16, big-endian) | header (JSON, UTF-8) | ciphertext | tag (16)
 *
 * The header names what the bytes are: `acct` (the account), `kind` (which file: `credentials`, `trusted-device`, …),
 * `use` (which key of the account's keyring: `boot` or `data`), `kid` (that key's id), `purpose` (`file` for the
 * small files; phase-2 stores pass their own) and `n` (the 96-bit nonce, random per seal). Everything before the
 * ciphertext is the additional authenticated data, so a header that was edited, or a file moved to another account
 * or another kind, fails authentication exactly like edited ciphertext does.
 *
 * Nothing here knows about keyrings or files: the caller hands in the key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The first bytes of every sealed file. */
export const MAGIC = Buffer.from("ZACSEAL", "ascii");
/** The container's format version. */
export const FORMAT_VERSION = 1;

const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const PREFIX_BYTES = MAGIC.length + 1 + 2;

/** Raised for a container that is not one, is of an unknown version, or fails authentication. */
export class SealError extends Error {
    /**
     * @param {string} message
     * @param {string} code - `NOT_SEALED`, `BAD_VERSION`, `BAD_HEADER`, `MISMATCH` or `AUTH_FAILED`
     */
    constructor(message, code) {
        super(message);
        this.name = "SealError";
        this.code = code;
    }
}

/**
 * Raised by the key layer when it cannot give a key: no provider on this machine (`UNAVAILABLE`), the provider refused
 * or the key is wrong (`WRONG_KEY`), the dkey layer is on and this process has not logged in (`LOCKED`), the keyring
 * is missing while sealed files exist (`NO_KEYRING`), or the settings are wrong (`CONFIG`). Its message never holds
 * key material.
 */
export class KeystoreError extends Error {
    /**
     * @param {string} message
     * @param {string} code
     */
    constructor(message, code) {
        super(message);
        this.name = "KeystoreError";
        this.code = code;
    }
}

/**
 * Whether `bytes` start like a sealed container (a cheap check: authentication is {@link openSealed}'s job).
 *
 * @param {Buffer|Uint8Array|null|undefined} bytes
 * @returns {boolean}
 */
export function isSealed(bytes) {
    return Boolean(bytes && bytes.length >= PREFIX_BYTES && Buffer.from(bytes).subarray(0, MAGIC.length).equals(MAGIC));
}

/**
 * Read a container's header without opening it (for status reports: which key, which kind).
 *
 * @param {Buffer} bytes
 * @returns {{v: number, alg: string, acct: string, kind: string, use: string, kid: string, purpose: string, n: string}}
 * @throws {SealError}
 */
export function readSealedHeader(bytes) {
    if (!isSealed(bytes)) throw new SealError("not a sealed file", "NOT_SEALED");
    const buf = Buffer.from(bytes);
    const version = buf[MAGIC.length];
    if (version !== FORMAT_VERSION) {
        throw new SealError(`sealed with format version ${version}, which this version cannot read`, "BAD_VERSION");
    }
    const length = buf.readUInt16BE(MAGIC.length + 1);
    if (PREFIX_BYTES + length + TAG_BYTES > buf.length)
        throw new SealError("the sealed file is truncated", "BAD_HEADER");
    let header;
    try {
        header = JSON.parse(buf.subarray(PREFIX_BYTES, PREFIX_BYTES + length).toString("utf8"));
    } catch {
        throw new SealError("the sealed file's header is damaged", "BAD_HEADER");
    }
    if (!header || header.v !== FORMAT_VERSION || header.alg !== "A256GCM" || typeof header.n !== "string") {
        throw new SealError("the sealed file's header is damaged", "BAD_HEADER");
    }
    return header;
}

/**
 * Seal `plaintext` under `key`.
 *
 * @param {Buffer} key - 32 bytes
 * @param {{acct: string, kind: string, use: string, kid: string, purpose?: string}} meta
 * @param {Buffer|string} plaintext
 * @returns {Buffer}
 */
export function seal(key, meta, plaintext) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError("seal: the key must be 32 bytes");
    const nonce = randomBytes(NONCE_BYTES);
    const header = Buffer.from(
        JSON.stringify({
            v: FORMAT_VERSION,
            alg: "A256GCM",
            acct: String(meta.acct),
            kind: String(meta.kind),
            use: String(meta.use),
            kid: String(meta.kid),
            purpose: String(meta.purpose ?? "file"),
            n: nonce.toString("base64"),
        }),
        "utf8",
    );
    const prefix = Buffer.alloc(PREFIX_BYTES);
    MAGIC.copy(prefix, 0);
    prefix[MAGIC.length] = FORMAT_VERSION;
    prefix.writeUInt16BE(header.length, MAGIC.length + 1);
    const aad = Buffer.concat([prefix, header]);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const body = Buffer.concat([
        cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf8")),
        cipher.final(),
    ]);
    return Buffer.concat([aad, body, cipher.getAuthTag()]);
}

/**
 * Open a container. `expect` pins what the caller asked for: a container for another account or another kind is
 * refused before any decryption, so a file copied over another one never opens as it.
 *
 * @param {(header: object) => Buffer} keyFor - the 32-byte key the header's `use`/`kid` name
 * @param {Buffer} bytes
 * @param {{acct?: string, kind?: string, purpose?: string}} [expect]
 * @returns {{plaintext: Buffer, header: object}}
 * @throws {SealError}
 */
export function openSealed(keyFor, bytes, expect = {}) {
    const header = readSealedHeader(bytes);
    for (const field of ["acct", "kind", "purpose"]) {
        if (expect[field] !== undefined && String(expect[field]) !== header[field]) {
            throw new SealError(
                `the sealed file belongs to another ${field === "acct" ? "account" : field}`,
                "MISMATCH",
            );
        }
    }
    const buf = Buffer.from(bytes);
    const length = buf.readUInt16BE(MAGIC.length + 1);
    const aad = buf.subarray(0, PREFIX_BYTES + length);
    const body = buf.subarray(PREFIX_BYTES + length, buf.length - TAG_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const key = keyFor(header);
    try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.n, "base64"));
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        return { plaintext: Buffer.concat([decipher.update(body), decipher.final()]), header };
    } catch {
        throw new SealError(
            "the sealed file failed authentication (damaged, edited, or sealed with another key)",
            "AUTH_FAILED",
        );
    }
}

/**
 * Wrap a key (or any short secret) under a key-encryption key: `nonce | ciphertext | tag`, base64.
 *
 * @param {Buffer} kek - 32 bytes
 * @param {Buffer} secret
 * @param {string} aad - binds the wrap to where it is used
 * @returns {string}
 */
export function wrapKey(kek, secret, aad) {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", kek, nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([cipher.update(secret), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

/**
 * Undo {@link wrapKey}.
 *
 * @param {Buffer} kek
 * @param {string} wrapped
 * @param {string} aad
 * @returns {Buffer}
 * @throws {SealError} `AUTH_FAILED` for a wrong key, a wrong `aad` or damaged bytes
 */
export function unwrapKey(kek, wrapped, aad) {
    const buf = Buffer.from(String(wrapped), "base64");
    if (buf.length < NONCE_BYTES + TAG_BYTES) throw new SealError("a wrapped key is damaged", "AUTH_FAILED");
    try {
        const decipher = createDecipheriv("aes-256-gcm", kek, buf.subarray(0, NONCE_BYTES));
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
        return Buffer.concat([decipher.update(buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES)), decipher.final()]);
    } catch {
        throw new SealError("a wrapped key did not open: wrong key, or the keyring was edited", "AUTH_FAILED");
    }
}
