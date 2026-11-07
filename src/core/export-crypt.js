/**
 * The password-encrypted export file (`db export --password`, the admin API's `encryption: "password"`): a plain
 * SQLite export sealed with a key the user's password gives, so the person it is handed to opens it with that password
 * and nothing of this machine (no keyring, no provider).
 *
 * Layout (all integers big-endian; docs/security.md "Password-encrypted export file"):
 *
 *     magic      8 bytes   "ZAEXPORT"
 *     headerLen  uint32    length of the header
 *     header     JSON      {format: "zalo-agent-cli/export", version: 1, content: "sqlite3", cipher: "aes-256-gcm",
 *                           kdf: {name: "scrypt", N, r, p, keyLength: 32, salt: <base64, 16 bytes>},
 *                           chunkSize, nonce: <base64, 8 bytes>, plaintextBytes, createdAt}
 *     chunks     each chunkSize bytes of plaintext (the last one 0..chunkSize) encrypted, followed by its 16-byte tag
 *
 * - key = scrypt(password (UTF-8), salt, N, r, p, 32). The password is never stored, logged or written anywhere.
 * - chunk i: nonce = header nonce (8 bytes) || uint32(i); AAD = SHA-256(magic || headerLen || header) || uint32(i) ||
 *   final (1 byte: 1 for the last chunk). A changed header, a reordered, dropped or added chunk, or a file cut at a
 *   chunk boundary fails to open: the last chunk is the only one sealed as final.
 * - The plaintext is a SQLite database (the decrypted export, with `export_info` and `export_hidden_threads`).
 *
 * Streaming both ways, one chunk in memory at a time.
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";
import { open, rm, stat } from "node:fs/promises";

export const EXPORT_MAGIC = Buffer.from("ZAEXPORT", "ascii");
export const EXPORT_FORMAT = "zalo-agent-cli/export";
export const EXPORT_VERSION = 1;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 64 * 1024;
/** scrypt cost the export is written with: N 2^17, r 8, p 1 (128 MiB, about half a second). */
export const DEFAULT_KDF = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
/** The most a file may ask a reader to spend (a crafted header must not exhaust memory). */
const MAX_N = 2 ** 20;
export const DEFAULT_CHUNK = 1024 * 1024;
/** A password's length bounds. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 1024;

/** A failure to read an export: wrong password, damaged or not an export. */
export class ExportCryptError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "ExportCryptError";
        this.code = code;
    }
}

/**
 * Refuse a password the export will not take (too short or too long, not text). Returns nothing when it is fine.
 *
 * @param {unknown} password
 * @returns {string|null} why it is refused
 */
export function passwordProblem(password) {
    if (typeof password !== "string") return "the password must be text";
    const n = [...password].length;
    if (n < PASSWORD_MIN) return `the password needs at least ${PASSWORD_MIN} characters`;
    if (n > PASSWORD_MAX) return `the password may have at most ${PASSWORD_MAX} characters`;
    return null;
}

function deriveKey(password, kdf) {
    const { N, r, p } = kdf;
    const salt = Buffer.from(kdf.salt, "base64");
    return new Promise((resolve, reject) => {
        scryptCb(
            Buffer.from(password, "utf8"),
            salt,
            32,
            { N, r, p, maxmem: 128 * N * r + 32 * 1024 * 1024 },
            (err, key) => (err ? reject(err) : resolve(key)),
        );
    });
}

const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

function chunkAad(headerHash, index, final) {
    return Buffer.concat([headerHash, u32(index), Buffer.from([final ? 1 : 0])]);
}

/**
 * Encrypt a file under a password into the export format. Writes `out` (0600, never over an existing file); on any
 * failure nothing is left there.
 *
 * @param {string} src - the plaintext (a SQLite file)
 * @param {string} out
 * @param {string} password
 * @param {{kdf?: {N: number, r: number, p: number}, chunkSize?: number, now?: () => number}} [opts]
 * @returns {Promise<{bytes: number, plaintextBytes: number, kdf: object}>}
 */
export async function encryptExportFile(
    src,
    out,
    password,
    { kdf = DEFAULT_KDF, chunkSize = DEFAULT_CHUNK, now = Date.now } = {},
) {
    const problem = passwordProblem(password);
    if (problem) throw new ExportCryptError(problem, "PASSWORD");
    const size = (await stat(src)).size;
    const params = {
        name: "scrypt",
        N: kdf.N,
        r: kdf.r,
        p: kdf.p,
        keyLength: 32,
        salt: randomBytes(16).toString("base64"),
    };
    const nonce = randomBytes(8);
    const header = Buffer.from(
        JSON.stringify({
            format: EXPORT_FORMAT,
            version: EXPORT_VERSION,
            content: "sqlite3",
            cipher: "aes-256-gcm",
            kdf: params,
            chunkSize,
            nonce: nonce.toString("base64"),
            plaintextBytes: size,
            createdAt: new Date(now()).toISOString(),
        }),
        "utf8",
    );
    const prefix = Buffer.concat([EXPORT_MAGIC, u32(header.length), header]);
    const headerHash = createHash("sha256").update(prefix).digest();
    const key = await deriveKey(password, params);
    const input = await open(src, "r");
    let output;
    let written = 0;
    try {
        output = await open(out, "wx", 0o600);
        await output.write(prefix);
        written += prefix.length;
        const buf = Buffer.alloc(chunkSize);
        let pos = 0;
        let index = 0;
        for (;;) {
            const { bytesRead } = await input.read(buf, 0, Math.min(chunkSize, size - pos), pos);
            pos += bytesRead;
            const final = pos >= size;
            const iv = Buffer.concat([nonce, u32(index)]);
            const c = createCipheriv("aes-256-gcm", key, iv);
            c.setAAD(chunkAad(headerHash, index, final));
            const body = Buffer.concat([c.update(buf.subarray(0, bytesRead)), c.final(), c.getAuthTag()]);
            await output.write(body);
            written += body.length;
            index++;
            if (final) break;
            if (bytesRead === 0) throw new Error("the file shrank while it was encrypted");
        }
        await output.sync();
    } catch (e) {
        await output?.close().catch(() => {});
        output = null;
        if (!(e?.code === "EEXIST")) await rm(out, { force: true });
        throw e;
    } finally {
        key.fill(0);
        await input.close();
        await output?.close();
    }
    return { bytes: written, plaintextBytes: size, kdf: { name: "scrypt", N: params.N, r: params.r, p: params.p } };
}

/**
 * The header of an export file (no password needed), or why it is not one.
 *
 * @param {string} file
 * @returns {Promise<{header: object, dataOffset: number, headerHash: Buffer, size: number}>}
 */
export async function readExportHeader(file) {
    const fh = await open(file, "r");
    try {
        const size = (await fh.stat()).size;
        const head = Buffer.alloc(12);
        const { bytesRead } = await fh.read(head, 0, 12, 0);
        if (bytesRead < 12 || !head.subarray(0, 8).equals(EXPORT_MAGIC)) {
            throw new ExportCryptError("this is not a password-encrypted export (no ZAEXPORT header)", "NOT_EXPORT");
        }
        const len = head.readUInt32BE(8);
        if (len < 2 || len > MAX_HEADER_BYTES || 12 + len > size) {
            throw new ExportCryptError("the export's header is damaged", "DAMAGED");
        }
        const raw = Buffer.alloc(len);
        await fh.read(raw, 0, len, 12);
        let header;
        try {
            header = JSON.parse(raw.toString("utf8"));
        } catch {
            throw new ExportCryptError("the export's header is damaged", "DAMAGED");
        }
        const k = header?.kdf;
        if (
            header?.format !== EXPORT_FORMAT ||
            header.version !== EXPORT_VERSION ||
            header.cipher !== "aes-256-gcm" ||
            k?.name !== "scrypt" ||
            !Number.isInteger(k.N) ||
            k.N < 2 ||
            k.N > MAX_N ||
            (k.N & (k.N - 1)) !== 0 ||
            !Number.isInteger(k.r) ||
            k.r < 1 ||
            k.r > 32 ||
            !Number.isInteger(k.p) ||
            k.p < 1 ||
            k.p > 16 ||
            !Number.isInteger(header.chunkSize) ||
            header.chunkSize < 1024 ||
            header.chunkSize > 64 * 1024 * 1024 ||
            Buffer.from(String(header.nonce ?? ""), "base64").length !== 8 ||
            Buffer.from(String(k.salt ?? ""), "base64").length < 16
        ) {
            throw new ExportCryptError("this export's format or parameters are not supported", "UNSUPPORTED");
        }
        const headerHash = createHash("sha256")
            .update(Buffer.concat([head, raw]))
            .digest();
        return { header, dataOffset: 12 + len, headerHash, size };
    } finally {
        await fh.close();
    }
}

/**
 * Decrypt an export file to `out` (0600, never over an existing file). A wrong password or any change to the file is
 * `ExportCryptError` (`WRONG_PASSWORD_OR_DAMAGED`), and nothing is left at `out`.
 *
 * @param {string} file
 * @param {string} out
 * @param {string} password
 * @returns {Promise<{plaintextBytes: number, header: object}>}
 */
export async function decryptExportFile(file, out, password) {
    const { header, dataOffset, headerHash, size } = await readExportHeader(file);
    if (typeof password !== "string" || !password) throw new ExportCryptError("a password is needed", "PASSWORD");
    const key = await deriveKey(password, header.kdf);
    const nonce = Buffer.from(header.nonce, "base64");
    const step = header.chunkSize + TAG_BYTES;
    const input = await open(file, "r");
    let output;
    let total = 0;
    try {
        output = await open(out, "wx", 0o600);
        const buf = Buffer.alloc(step);
        let pos = dataOffset;
        let index = 0;
        for (;;) {
            const want = Math.min(step, size - pos);
            if (want < TAG_BYTES) throw new ExportCryptError("the export is cut short", "WRONG_PASSWORD_OR_DAMAGED");
            const { bytesRead } = await input.read(buf, 0, want, pos);
            pos += bytesRead;
            const final = pos >= size;
            const d = createDecipheriv("aes-256-gcm", key, Buffer.concat([nonce, u32(index)]));
            d.setAAD(chunkAad(headerHash, index, final));
            d.setAuthTag(buf.subarray(bytesRead - TAG_BYTES, bytesRead));
            let plain;
            try {
                plain = Buffer.concat([d.update(buf.subarray(0, bytesRead - TAG_BYTES)), d.final()]);
            } catch {
                throw new ExportCryptError(
                    "the password is wrong, or the file was changed or damaged",
                    "WRONG_PASSWORD_OR_DAMAGED",
                );
            }
            await output.write(plain);
            total += plain.length;
            index++;
            if (final) break;
        }
        if (Number.isInteger(header.plaintextBytes) && header.plaintextBytes !== total) {
            throw new ExportCryptError("the export's size does not match its header", "WRONG_PASSWORD_OR_DAMAGED");
        }
    } catch (e) {
        await output?.close().catch(() => {});
        output = null;
        if (e?.code !== "EEXIST") await rm(out, { force: true });
        throw e;
    } finally {
        key.fill(0);
        await input.close();
        await output?.close();
    }
    return { plaintextBytes: total, header };
}
