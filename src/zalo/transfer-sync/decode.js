/**
 * Decoding a downloaded transfer-sync batch: split, decrypt, decompress, protobuf-decode.
 *
 *   batch bytes -> [u32 LE len][payload] chunks -> decrypt (metadata: the session record and a plaintext;
 *   message: a plaintext, with the session record) -> Zstd (or inflate, gunzip) -> `SyncChunk.toObject()`
 *
 * Pure functions over a `codecs` object (`{zproto, M, C}`, see ./assets.js `loadCodecs`), so the same code runs on
 * the main thread and in a decode worker (./decode-worker.js), and the two cannot drift apart.
 */
import zlib from "node:zlib";

/**
 * Split a downloaded batch blob into its length-prefixed payload chunks.
 *
 * @param {Uint8Array} input
 * @returns {Buffer[]}
 */
export function splitChunks(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const out = [];
    let o = 0;
    while (o + 4 <= buf.length) {
        const n = buf.readUInt32LE(o);
        o += 4;
        if (o + n > buf.length) break;
        out.push(buf.subarray(o, o + n));
        o += n;
    }
    return out;
}

/**
 * Zstd, else inflate, else gunzip, else the bytes as they are.
 *
 * @param {Uint8Array} p
 * @returns {Uint8Array}
 */
export function decompress(p) {
    try {
        return zlib.zstdDecompressSync(p);
    } catch {}
    try {
        return zlib.inflateSync(p);
    } catch {}
    try {
        return zlib.gunzipSync(p);
    } catch {}
    return p;
}

/**
 * Decode one chunk of a batch.
 *
 * @param {Uint8Array} chunk
 * @param {object} ctx
 * @param {number} ctx.batchType - 2 for the metadata batch, which carries the session record
 * @param {{ikPub: Uint8Array, ikPriv: Uint8Array, ekPriv: Uint8Array}} ctx.keys - this run's identity key pair and
 *   the session's ephemeral private key
 * @param {Uint8Array|null} ctx.sessionRecord - from the metadata batch; a message chunk without one is skipped
 * @param {{zproto: object, M: object, C: object}} codecs
 * @param {"M"|"C"} cls - the message or the conversation protobuf
 * @returns {{sessionRecord: Uint8Array|null, obj: object|null}} `obj` null for a chunk that did not decode
 */
export function decodeChunk(chunk, ctx, codecs, cls) {
    let sessionRecord = ctx.sessionRecord ?? null;
    let plain;
    if (ctx.batchType === 2) {
        const m = codecs.zproto.decryptMetadata(chunk, ctx.keys.ikPub, ctx.keys.ikPriv, ctx.keys.ekPriv);
        sessionRecord = m.sessionRecord;
        plain = m.plaintext;
    } else {
        if (!sessionRecord) return { sessionRecord, obj: null };
        plain = codecs.zproto.decryptMessage(chunk, sessionRecord).plaintext;
    }
    let obj = null;
    try {
        obj = codecs[cls].SyncChunk.deserializeBinary(decompress(plain)).toObject();
    } catch {
        obj = null;
    }
    return { sessionRecord, obj };
}

/**
 * Decode a whole batch. A chunk that cannot be decrypted or decoded is skipped, as one bad frame must not drop the
 * rest of the batch.
 *
 * @param {Uint8Array} blob - the downloaded batch
 * @param {{batchType: number, keys: object, sessionRecord?: Uint8Array|null}} ctx - see {@link decodeChunk}
 * @param {{zproto: object, M: object, C: object}} codecs
 * @param {"M"|"C"} cls
 * @returns {{sessionRecord: Uint8Array|null, objs: object[]}} the session record after this batch, and its objects
 *   in order
 */
export function decodeBatch(blob, ctx, codecs, cls) {
    let sessionRecord = ctx.sessionRecord ?? null;
    const objs = [];
    for (const chunk of splitChunks(blob)) {
        try {
            const r = decodeChunk(chunk, { ...ctx, sessionRecord }, codecs, cls);
            sessionRecord = r.sessionRecord;
            if (r.obj) objs.push(r.obj);
        } catch {
            /* skip a bad chunk */
        }
    }
    return { sessionRecord, objs };
}
