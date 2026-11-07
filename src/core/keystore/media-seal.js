/**
 * The media container (at-rest phase 2): every downloaded attachment is stored as a chunked AES-256-GCM container,
 * readable at any byte range without decrypting the rest, and re-keyed by rewriting a few dozen bytes.
 *
 *     "ZACMEDIA" | version u8 | static length u32be | static header (JSON, UTF-8)
 *                | key slot 0 | key slot 1                         each: kid (16 bytes, ASCII) | wrapped DEK (60)
 *                | chunk 0 | chunk 1 | …                           each: AES-256-GCM(DEK, plaintext ≤ 64 KiB) | tag (16)
 *
 * - The static header names the file: `acct` (the account), `msgId` (the message it belongs to, or null for a file
 *   migrated without one), `att` (attachment index), `thumb`, `mime`, `ext`, `size` (plaintext bytes), `chunk` (65536)
 *   and a random `salt`. Its SHA-256 (over everything before the slots) is bound into every chunk and every key wrap,
 *   so an edited header, or a chunk moved to another file, does not open.
 * - The DEK is random per file and is wrapped (AES-256-GCM, 12-byte nonce | 32-byte key | tag = 60 bytes) under the
 *   account's media key, `getDataKey(ownId, "media")`, whose id is the slot's `kid`. A rekey writes the new wrap into
 *   the slot it did not open the DEK from (one positioned write + fsync), so a crash during it leaves the old slot
 *   valid: the gigabytes are never re-encrypted.
 * - Chunk `i` uses nonce `0^4 ‖ u64be(i)` (the DEK is unique per file) and AAD `SHA256(static) ‖ u64be(i) ‖ final`.
 *   A reordered, dropped or appended chunk fails, and so does a file cut at a chunk boundary (the size and the final
 *   flag disagree).
 *
 * File names never change: the first 8 bytes tell a sealed file from a plaintext one (written by 2.x), which is
 * still read, and sealed in place on the way ({@link sealMediaFileInPlace}: written beside, verified, swapped, the
 * plaintext overwritten with zeros and removed; a crash at any step leaves one readable copy).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
    closeSync,
    existsSync,
    fstatSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readSync,
    renameSync,
    rmSync,
    writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { writeFileAtomic } from "../../zalo/kernel/atomic-file.js";
import { KeystoreError, SealError } from "./container.js";
import { deriveDataKey, scopeOfDir } from "./keyring.js";

/** The first bytes of every sealed media file. */
export const MEDIA_MAGIC = Buffer.from("ZACMEDIA", "ascii");
/** The container's format version. */
export const MEDIA_VERSION = 1;
/** Plaintext bytes per chunk. */
export const MEDIA_CHUNK = 65536;
/** The data-key purpose media is sealed under. */
export const MEDIA_PURPOSE = "media";

const TAG = 16;
const NONCE = 12;
const KID = 16;
const WRAPPED = NONCE + 32 + TAG;
const SLOT = KID + WRAPPED;
const PREFIX = MEDIA_MAGIC.length + 1 + 4;
const MAX_STATIC = 64 * 1024;
const EMPTY_KID = Buffer.alloc(KID);

/** Suffixes of an in-place seal that stopped part way (see {@link recoverMediaFile}). */
const SEALING = ".sealing";
const PLAINTEXT_OLD = ".plaintext-old";

const asScope = (s) =>
    typeof s === "string" ? scopeOfDir(resolve(s)) : { id: String(s.id), dir: resolve(String(s.dir)) };

const u64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
};

/** Number of chunks for a plaintext size (an empty file still has one, final, chunk). */
const chunkCount = (size) => Math.max(1, Math.ceil(size / MEDIA_CHUNK));

/**
 * Whether bytes start like a sealed media file.
 *
 * @param {Buffer|Uint8Array|null|undefined} bytes
 * @returns {boolean}
 */
export function isSealedMedia(bytes) {
    return Boolean(bytes && bytes.length >= MEDIA_MAGIC.length && MEDIA_MAGIC.equals(bytes.subarray(0, 8)));
}

/**
 * What a media file is on disk, from its first 8 bytes (no key needed).
 *
 * @param {string} file
 * @returns {"absent"|"sealed"|"plaintext"}
 */
export function mediaFileState(file) {
    let fd;
    try {
        fd = openSync(file, "r");
    } catch (e) {
        if (e.code === "ENOENT" || e.code === "EISDIR") return "absent";
        throw e;
    }
    try {
        const head = Buffer.alloc(MEDIA_MAGIC.length);
        const n = readSync(fd, head, 0, head.length, 0);
        return n === head.length && head.equals(MEDIA_MAGIC) ? "sealed" : "plaintext";
    } finally {
        closeSync(fd);
    }
}

/** Read exactly `len` bytes at `pos`, or fewer at the end of the file. */
function readAt(fd, len, pos) {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
        const n = readSync(fd, buf, got, len - got, pos + got);
        if (n === 0) break;
        got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
}

/**
 * Parse a sealed file's header from an open descriptor (no key needed).
 *
 * @param {number} fd
 * @returns {{meta: object, staticHash: Buffer, slots: Array<{kid: string|null, wrapped: Buffer}>, slotsOffset: number,
 *   dataOffset: number}}
 * @throws {SealError} `NOT_SEALED`, `BAD_VERSION`, `BAD_HEADER`
 */
function headerOf(fd) {
    const prefix = readAt(fd, PREFIX, 0);
    if (!isSealedMedia(prefix)) throw new SealError("not a sealed media file", "NOT_SEALED");
    if (prefix.length < PREFIX) throw new SealError("a sealed media file is cut short", "BAD_HEADER");
    if (prefix[8] !== MEDIA_VERSION) {
        throw new SealError(`sealed media version ${prefix[8]} is not one this release reads`, "BAD_VERSION");
    }
    const staticLen = prefix.readUInt32BE(9);
    if (staticLen < 2 || staticLen > MAX_STATIC) throw new SealError("a sealed media header is damaged", "BAD_HEADER");
    const json = readAt(fd, staticLen, PREFIX);
    const slotsBuf = readAt(fd, 2 * SLOT, PREFIX + staticLen);
    if (json.length < staticLen || slotsBuf.length < 2 * SLOT) {
        throw new SealError("a sealed media file is cut short", "BAD_HEADER");
    }
    let meta;
    try {
        meta = JSON.parse(json.toString("utf8"));
    } catch {
        throw new SealError("a sealed media header is damaged", "BAD_HEADER");
    }
    if (!meta || typeof meta !== "object" || !Number.isSafeInteger(meta.size) || meta.size < 0) {
        throw new SealError("a sealed media header is damaged", "BAD_HEADER");
    }
    if (meta.chunk !== MEDIA_CHUNK) throw new SealError("a sealed media header is damaged", "BAD_HEADER");
    const staticHash = createHash("sha256").update(prefix).update(json).digest();
    const slots = [0, 1].map((i) => {
        const s = slotsBuf.subarray(i * SLOT, (i + 1) * SLOT);
        const kid = s.subarray(0, KID);
        return { kid: kid.equals(EMPTY_KID) ? null : kid.toString("latin1"), wrapped: Buffer.from(s.subarray(KID)) };
    });
    return { meta, staticHash, slots, slotsOffset: PREFIX + staticLen, dataOffset: PREFIX + staticLen + 2 * SLOT };
}

/**
 * A sealed file's header, without a key: its static fields (account, message, size, mime) and its key slots' ids.
 *
 * @param {string} file
 * @returns {{meta: object, kids: Array<string|null>, dataOffset: number}}
 * @throws {SealError}
 */
export function readMediaHeader(file) {
    const fd = openSync(file, "r");
    try {
        const h = headerOf(fd);
        return { meta: h.meta, kids: h.slots.map((s) => s.kid), dataOffset: h.dataOffset };
    } finally {
        closeSync(fd);
    }
}

const wrapAad = (staticHash, kid) => Buffer.concat([Buffer.from("zacmedia/dek\0"), staticHash, Buffer.from(kid)]);

function wrapDek(kek, dek, staticHash, kid) {
    const nonce = randomBytes(NONCE);
    const c = createCipheriv("aes-256-gcm", kek, nonce);
    c.setAAD(wrapAad(staticHash, kid));
    const body = Buffer.concat([c.update(dek), c.final()]);
    return Buffer.concat([nonce, body, c.getAuthTag()]);
}

function unwrapDek(kek, wrapped, staticHash, kid) {
    try {
        const d = createDecipheriv("aes-256-gcm", kek, wrapped.subarray(0, NONCE));
        d.setAAD(wrapAad(staticHash, kid));
        d.setAuthTag(wrapped.subarray(WRAPPED - TAG));
        return Buffer.concat([d.update(wrapped.subarray(NONCE, WRAPPED - TAG)), d.final()]);
    } catch {
        return null;
    }
}

function slotBytes(kid, wrapped) {
    const kidBuf = Buffer.alloc(KID);
    kidBuf.write(kid, "latin1");
    return Buffer.concat([kidBuf, wrapped]);
}

/** The account's current media key (read from the keyring each time: a rekey changes it). */
function mediaKey(scope) {
    return deriveDataKey(scope, MEDIA_PURPOSE);
}

/**
 * The media key of one key id. A key id's key never changes, so a caller that opens many files (a rekey, a
 * migration) passes a Map to keep the derived keys for the length of its run; nothing is cached otherwise.
 *
 * @param {{id: string, dir: string}} scope
 * @param {string} kid
 * @param {Map<string, Buffer>} [keys]
 * @returns {Buffer}
 */
function kekFor(scope, kid, keys) {
    const k = `${kid}@${scope.dir}`;
    let kek = keys?.get(k);
    if (!kek) {
        kek = deriveDataKey(scope, MEDIA_PURPOSE, { keyId: kid }).key;
        keys?.set(k, kek);
    }
    return kek;
}

/**
 * Open the DEK of a file from whichever slot a key of the account opens (`prefer`'s slot first).
 *
 * @param {{id: string, dir: string}} scope
 * @param {object} h - {@link headerOf}
 * @param {{keys?: Map<string, Buffer>, prefer?: string}} [opts]
 * @returns {{dek: Buffer, slot: number, kid: string}}
 */
function openDek(scope, h, { keys, prefer } = {}) {
    const order = [...h.slots.entries()].sort(([, a], [, b]) => (b.kid === prefer) - (a.kid === prefer));
    for (const [i, s] of order) {
        if (!s.kid) continue;
        let kek;
        try {
            kek = kekFor(scope, s.kid, keys);
        } catch (e) {
            if (e instanceof KeystoreError && e.code !== "WRONG_KEY") throw e;
            continue; // a key this keyring no longer has
        }
        const dek = unwrapDek(kek, s.wrapped, h.staticHash, s.kid);
        if (dek) return { dek, slot: i, kid: s.kid };
    }
    throw new SealError(
        "a sealed media file does not open with any key of this account (another keyring, or the header was edited)",
        "AUTH_FAILED",
    );
}

const chunkAad = (staticHash, i, final) => Buffer.concat([staticHash, u64(i), Buffer.from([final ? 1 : 0])]);
const chunkNonce = (i) => Buffer.concat([Buffer.alloc(4), u64(i)]);

function encryptChunk(dek, staticHash, i, final, plain) {
    const c = createCipheriv("aes-256-gcm", dek, chunkNonce(i));
    c.setAAD(chunkAad(staticHash, i, final));
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function decryptChunk(dek, staticHash, i, final, sealed) {
    if (sealed.length < TAG) throw new SealError("a sealed media file is cut short", "TRUNCATED");
    try {
        const d = createDecipheriv("aes-256-gcm", dek, chunkNonce(i));
        d.setAAD(chunkAad(staticHash, i, final));
        d.setAuthTag(sealed.subarray(sealed.length - TAG));
        return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
    } catch {
        throw new SealError(`a sealed media file failed authentication at chunk ${i}`, "AUTH_FAILED");
    }
}

/**
 * A new header for a file of `size` plaintext bytes: its bytes, its DEK and the hash the chunks are bound to.
 *
 * @param {{id: string, dir: string}} scope
 * @param {object} meta - msgId, att, thumb, mime, ext
 * @param {number} size
 */
function newHeader(scope, meta, size) {
    const fields = {
        acct: scope.id,
        msgId: meta.msgId === null || meta.msgId === undefined ? null : String(meta.msgId),
        att: Number.isInteger(meta.att) ? meta.att : 0,
        thumb: Boolean(meta.thumb),
        mime: meta.mime ? String(meta.mime) : null,
        ext: meta.ext ? String(meta.ext) : null,
        size,
        chunk: MEDIA_CHUNK,
        salt: randomBytes(16).toString("base64"),
    };
    const json = Buffer.from(JSON.stringify(fields), "utf8");
    const prefix = Buffer.alloc(PREFIX);
    MEDIA_MAGIC.copy(prefix, 0);
    prefix[8] = MEDIA_VERSION;
    prefix.writeUInt32BE(json.length, 9);
    const staticHash = createHash("sha256").update(prefix).update(json).digest();
    const { key, keyId } = mediaKey(scope);
    const dek = randomBytes(32);
    const slots = Buffer.concat([slotBytes(keyId, wrapDek(key, dek, staticHash, keyId)), Buffer.alloc(SLOT)]);
    return { bytes: Buffer.concat([prefix, json, slots]), dek, staticHash, meta: fields };
}

/**
 * Seal a whole buffer (a download) for one account.
 *
 * @param {string|{id: string, dir: string}} scope - an account folder, or a scope
 * @param {{msgId?: string|null, att?: number, thumb?: boolean, mime?: string|null, ext?: string|null}} meta
 * @param {Buffer} plaintext
 * @returns {Buffer}
 * @throws {KeystoreError} when the media key cannot be had (fail closed: nothing is written in the clear instead)
 */
export function sealMedia(scope, meta, plaintext) {
    const s = asScope(scope);
    const h = newHeader(s, meta, plaintext.length);
    const n = chunkCount(plaintext.length);
    const parts = [h.bytes];
    for (let i = 0; i < n; i++) {
        const piece = plaintext.subarray(i * MEDIA_CHUNK, Math.min(plaintext.length, (i + 1) * MEDIA_CHUNK));
        parts.push(encryptChunk(h.dek, h.staticHash, i, i === n - 1, piece));
    }
    return Buffer.concat(parts);
}

/**
 * Seal a buffer and write it atomically (tmp + fsync + rename, mode 0600): a crash leaves the old file or the new
 * one, never half of either.
 *
 * @param {string} file
 * @param {string|{id: string, dir: string}} scope
 * @param {object} meta - see {@link sealMedia}
 * @param {Buffer} plaintext
 */
export function writeSealedMedia(file, scope, meta, plaintext) {
    writeFileAtomic(file, sealMedia(scope, meta, plaintext));
}

/**
 * Check what a reader expects of a file against its header: the account, and the message when both name one.
 *
 * @throws {SealError} `MISMATCH`
 */
function checkExpect(meta, scope, expect = {}) {
    if (String(meta.acct) !== scope.id) {
        throw new SealError("this media file belongs to another account", "MISMATCH");
    }
    if (
        expect.msgId !== null &&
        expect.msgId !== undefined &&
        meta.msgId !== null &&
        meta.msgId !== undefined &&
        String(expect.msgId) !== String(meta.msgId)
    ) {
        throw new SealError(
            `this media file belongs to message ${meta.msgId}, not ${expect.msgId}: it was swapped`,
            "MISMATCH",
        );
    }
}

/**
 * Open a sealed media file for reading at any byte range. A plaintext file (2.x) is sealed in place first.
 *
 * @param {string} file
 * @param {string|{id: string, dir: string}} scope
 * @param {{msgId?: string|null}} [expect] - the message the caller looked the file up for (a swapped file fails)
 * @param {{keys?: Map<string, Buffer>}} [opts] - derived keys kept across files by a caller that opens many
 * @returns {{size: number, meta: object, read: (start?: number, end?: number) => Buffer,
 *   stream: (opts?: {start?: number, end?: number}) => Readable, close: () => void}} `end` is inclusive, as in an
 *   HTTP Range; `stream` keeps the file open until it ends or is destroyed
 * @throws {SealError|KeystoreError}
 */
export function openMedia(file, scope, expect = {}, { keys } = {}) {
    const s = asScope(scope);
    recoverMediaFile(file);
    if (mediaFileState(file) === "plaintext") {
        sealMediaFileInPlace(file, s, { msgId: expect.msgId ?? null }, keys ? { keys } : {});
    }
    const fd = openSync(file, "r");
    let closed = false;
    try {
        const h = headerOf(fd);
        checkExpect(h.meta, s, expect);
        const { size } = h.meta;
        const n = chunkCount(size);
        const fileSize = fstatSync(fd).size;
        if (fileSize !== h.dataOffset + size + n * TAG) {
            throw new SealError(
                `a sealed media file has ${fileSize} bytes where its header says ${h.dataOffset + size + n * TAG}: ` +
                    "it was cut short or appended to",
                "TRUNCATED",
            );
        }
        const { dek } = openDek(s, h, { keys });
        const chunkAt = (i) => {
            const len = Math.min(MEDIA_CHUNK, size - i * MEDIA_CHUNK) + TAG;
            const sealed = readAt(fd, Math.max(TAG, len), h.dataOffset + i * (MEDIA_CHUNK + TAG));
            return decryptChunk(dek, h.staticHash, i, i === n - 1, sealed);
        };
        const bounds = (start = 0, end = size - 1) => {
            const a = Math.max(0, Math.floor(Number(start) || 0));
            const b = Math.min(size - 1, Math.floor(Number.isFinite(Number(end)) ? Number(end) : size - 1));
            return [a, b];
        };
        function* pieces(start, end) {
            const [a, b] = bounds(start, end);
            if (size === 0 || a > b) {
                if (size === 0) chunkAt(0); // still authenticates the (empty, final) chunk
                return;
            }
            for (let i = Math.floor(a / MEDIA_CHUNK); i <= Math.floor(b / MEDIA_CHUNK); i++) {
                const plain = chunkAt(i);
                const base = i * MEDIA_CHUNK;
                yield plain.subarray(Math.max(0, a - base), Math.min(plain.length, b - base + 1));
            }
        }
        const close = () => {
            if (closed) return;
            closed = true;
            closeSync(fd);
        };
        return {
            size,
            meta: h.meta,
            read: (start, end) => Buffer.concat([...pieces(start, end)]),
            stream: ({ start, end } = {}) => {
                const it = pieces(start, end);
                return new Readable({
                    read() {
                        try {
                            const next = it.next();
                            if (next.done) {
                                this.push(null);
                                close();
                            } else this.push(next.value);
                        } catch (e) {
                            this.destroy(e);
                        }
                    },
                    destroy(err, cb) {
                        close();
                        cb(err);
                    },
                });
            },
            close,
        };
    } catch (e) {
        if (!closed) {
            closed = true;
            closeSync(fd);
        }
        throw e;
    }
}

/**
 * The whole plaintext of a media file (sealed, or plaintext from 2.x: sealed in place on the way).
 *
 * @param {string} file
 * @param {string|{id: string, dir: string}} scope
 * @param {{msgId?: string|null}} [expect]
 * @returns {Buffer}
 */
export function readMediaFile(file, scope, expect = {}) {
    const m = openMedia(file, scope, expect);
    try {
        return m.read();
    } finally {
        m.close();
    }
}

/**
 * Decrypt a media file to `dest` (mode 0600), chunk by chunk. For the callers that need a plaintext path (an upload,
 * the OS viewer, `cloud get --out`); they delete it when done.
 *
 * @param {string} file
 * @param {string} dest
 * @param {string|{id: string, dir: string}} scope
 * @param {{msgId?: string|null}} [expect]
 * @returns {number} bytes written
 */
export function decryptMediaToFile(file, dest, scope, expect = {}) {
    const m = openMedia(file, scope, expect);
    let out;
    try {
        mkdirSync(dirname(resolve(dest)), { recursive: true });
        out = openSync(dest, "w", 0o600);
        let written = 0;
        for (let off = 0; off < m.size; off += MEDIA_CHUNK) {
            const piece = m.read(off, Math.min(m.size, off + MEDIA_CHUNK) - 1);
            writeSync(out, piece);
            written += piece.length;
        }
        return written;
    } finally {
        if (out !== undefined) closeSync(out);
        m.close();
    }
}

/**
 * The plaintext size of a media file without a key: the header's `size` for a sealed file, the file size for a
 * plaintext one, null when it is not there.
 *
 * @param {string} file
 * @returns {number|null}
 */
export function mediaPlainSize(file) {
    try {
        const state = mediaFileState(file);
        if (state === "absent") return null;
        if (state === "plaintext") return fstatSizeOf(file);
        return readMediaHeader(file).meta.size;
    } catch {
        return null;
    }
}

function fstatSizeOf(file) {
    const fd = openSync(file, "r");
    try {
        return fstatSync(fd).size;
    } finally {
        closeSync(fd);
    }
}

/**
 * Re-wrap a sealed file's DEK under the account's current media key (the rekey handler's work per file): the new wrap
 * goes into the slot the DEK was not opened from, flushed, then checked. Idempotent.
 *
 * @param {string} file
 * @param {string|{id: string, dir: string}} scope
 * @param {{keys?: Map<string, Buffer>, afterWrite?: Function}} [opts] - `keys`: derived keys kept across the files
 *   of one rekey; `afterWrite` (tests): a throw stands for a crash after the slot write
 * @returns {"absent"|"plaintext"|"other-account"|"current"|"rewrapped"}
 * @throws {SealError} the file does not open with any key of the account
 */
export function rewrapMediaFile(file, scope, { keys, afterWrite } = {}) {
    const s = asScope(scope);
    const state = mediaFileState(file);
    if (state !== "sealed") return state;
    const fd = openSync(file, "r+");
    try {
        const h = headerOf(fd);
        if (String(h.meta.acct) !== s.id) return "other-account";
        const current = mediaKey(s);
        keys?.set(`${current.keyId}@${s.dir}`, current.key);
        const opened = openDek(s, h, { keys, prefer: current.keyId });
        if (opened.kid === current.keyId) return "current";
        const target = 1 - opened.slot;
        const bytes = slotBytes(current.keyId, wrapDek(current.key, opened.dek, h.staticHash, current.keyId));
        writeSync(fd, bytes, 0, bytes.length, h.slotsOffset + target * SLOT);
        fsyncSync(fd);
        afterWrite?.();
        const check = openDek(s, headerOf(fd), { keys, prefer: current.keyId });
        if (check.kid !== current.keyId) {
            throw new SealError(`${file}: the new key slot did not take`, "AUTH_FAILED");
        }
        return "rewrapped";
    } finally {
        closeSync(fd);
    }
}

/**
 * Finish or undo what an in-place seal that stopped part way left behind:
 *
 *     <file>.sealing        a sealed copy being written, never swapped in   → removed
 *     <file>.plaintext-old  the plaintext, moved aside for the swap         → shredded once <file> is sealed; put
 *                                                                             back when <file> is gone
 *
 * @param {string} file
 */
export function recoverMediaFile(file) {
    if (existsSync(file + SEALING)) rmSync(file + SEALING, { force: true });
    if (existsSync(file + PLAINTEXT_OLD)) {
        const state = mediaFileState(file);
        if (state === "sealed") shred(file + PLAINTEXT_OLD);
        else if (state === "absent") renameSync(file + PLAINTEXT_OLD, file);
        else rmSync(file + PLAINTEXT_OLD, { force: true }); // two plaintext copies: the one in place is newer
    }
}

/** Whether a name is an in-place seal's leftover (never media itself). */
export const isSealLeftover = (name) => name.endsWith(SEALING) || name.endsWith(PLAINTEXT_OLD);

/** The media file a leftover belongs to. */
export const leftoverTarget = (name) =>
    name.endsWith(SEALING) ? name.slice(0, -SEALING.length) : name.slice(0, -PLAINTEXT_OLD.length);

/** Overwrite with zeros, flush, remove: best effort (an SSD or a copy-on-write filesystem may keep the blocks). */
function shred(file) {
    let fd;
    try {
        fd = openSync(file, "r+");
    } catch (e) {
        if (e.code === "ENOENT") return;
        throw e;
    }
    try {
        const size = fstatSync(fd).size;
        const zeros = Buffer.alloc(Math.min(size, 1 << 20));
        for (let off = 0; off < size; off += zeros.length) {
            writeSync(fd, zeros, 0, Math.min(zeros.length, size - off), off);
        }
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    rmSync(file, { force: true });
}

/**
 * Seal a plaintext (2.x) media file in place, streaming (a video is never held in memory): the sealed copy is written
 * beside it (`.sealing`), flushed and checked (length, first and last chunk), the plaintext is moved aside, the copy
 * swapped in, and only then is the plaintext overwritten with zeros and removed. Idempotent; a crash at any step is
 * finished or undone by {@link recoverMediaFile}.
 *
 * @param {string} file
 * @param {string|{id: string, dir: string}} scope
 * @param {{msgId?: string|null, att?: number, thumb?: boolean, mime?: string|null, ext?: string|null}} [meta]
 * @param {{keys?: Map<string, Buffer>, afterWrite?: Function, afterMoveAside?: Function, afterSwap?: Function}} [hooks]
 *   `keys`: derived keys kept across the files of one run; the others (tests): a throw stands for a crash there
 * @returns {"absent"|"already-sealed"|"sealed"}
 */
export function sealMediaFileInPlace(file, scope, meta = {}, hooks = {}) {
    const s = asScope(scope);
    recoverMediaFile(file);
    const state = mediaFileState(file);
    if (state !== "plaintext") return state === "sealed" ? "already-sealed" : "absent";
    const src = openSync(file, "r");
    const tmp = file + SEALING;
    let out;
    try {
        const size = fstatSync(src).size;
        const ext = /\.([A-Za-z0-9]{1,8})$/.exec(file)?.[1]?.toLowerCase() ?? null;
        const h = newHeader(s, { ext, ...meta }, size);
        out = openSync(tmp, "w", 0o600);
        writeSync(out, h.bytes);
        const n = chunkCount(size);
        for (let i = 0; i < n; i++) {
            const plain = readAt(src, Math.min(MEDIA_CHUNK, size - i * MEDIA_CHUNK), i * MEDIA_CHUNK);
            writeSync(out, encryptChunk(h.dek, h.staticHash, i, i === n - 1, plain));
        }
        fsyncSync(out);
        closeSync(out);
        out = undefined;
        hooks.afterWrite?.();
        // Check the copy before the plaintext goes: its length, and that the first and last chunks open.
        const check = openMedia(tmp, s, {}, { keys: hooks.keys });
        try {
            if (check.size !== size) throw new SealError(`${file}: the sealed copy did not verify`, "AUTH_FAILED");
            check.read(0, Math.min(size, MEDIA_CHUNK) - 1);
            if (size > MEDIA_CHUNK) check.read(size - 1, size - 1);
        } finally {
            check.close();
        }
    } catch (e) {
        if (out !== undefined) closeSync(out);
        closeSync(src);
        rmSync(tmp, { force: true });
        throw e;
    }
    closeSync(src);
    renameSync(file, file + PLAINTEXT_OLD);
    hooks.afterMoveAside?.();
    renameSync(tmp, file);
    hooks.afterSwap?.();
    shred(file + PLAINTEXT_OLD);
    return "sealed";
}
