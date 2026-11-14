/**
 * Strip embedded metadata from a photo before it is uploaded, as Zalo's own apps do: a phone photo carries the
 * camera's GPS position, the device make and model, timestamps and a thumbnail of the uncropped original, and none
 * of that belongs in a chat. Pure JS, no codec: the pixels are never decoded or re-encoded, only the containers'
 * metadata blocks are dropped.
 *
 * Per format (sniffed from the bytes, not the file name):
 *
 * - **JPEG**: dropped are APP1 (EXIF, XMP, extended XMP), APP2 other than `ICC_PROFILE` (MPF and FlashPix), APP3 to
 *   APP13, APP15, the JFXX thumbnail APP0 and any other non-JFIF APP0, COM comments, and everything after EOI (a
 *   trailer: the secondary images MPF points at, a motion photo's video, vendor blocks). Kept byte for byte: the
 *   ICC color profile (APP2 `ICC_PROFILE`), APP14 `Adobe` (CMYK/YCCK decoding needs it), the quantization and Huffman
 *   tables, frame and scan headers, restart intervals and the entropy-coded data of every scan. A JFIF APP0 is kept
 *   with its embedded thumbnail removed (rewritten to the 16-byte form, density kept).
 *   **Orientation**: the EXIF Orientation tag is read before the EXIF block goes. When it is 2 to 8 a minimal
 *   APP1 takes the EXIF block's place, holding IFD0 with that single tag and nothing else, so the photo still
 *   displays upright and the width/height the send reports (already turned for orientations 5-8) stay true. An
 *   EXIF block that cannot be read is dropped whole (the photo then shows as stored).
 * - **PNG**: dropped are `tEXt`, `iTXt`, `zTXt`, `eXIf`, `tIME` and anything after `IEND`. Every other chunk
 *   (`IHDR`, `PLTE`, `IDAT`, `iCCP`, `sRGB`, `gAMA`, `cHRM`, `pHYs`, animation chunks, …) is kept byte for byte, its
 *   CRC with it.
 * - **WebP** (RIFF): dropped are the `EXIF` and `XMP ` chunks and anything after the RIFF payload; the EXIF and XMP
 *   bits of the `VP8X` flags are cleared and the RIFF size rewritten. The `ICCP` chunk and the image chunks stay.
 * - **Anything else** (HEIC, AVIF, GIF, BMP, TIFF, …) is returned unchanged with `stripped: false`. GIFs travel on
 *   their own upload path and are not passed here.
 *
 * Never throws on bad input: a buffer that does not parse cleanly as its format is returned unchanged, with
 * `stripped: false` and the reason.
 */

/** JPEG markers by name. */
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const COM = 0xfe;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;

/** EXIF tag 0x0112, Orientation. */
const ORIENTATION_TAG = 0x0112;

/** PNG chunks that carry text, EXIF or a modification time. */
const PNG_DROP = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]);

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** VP8X flag bits: EXIF present, XMP present. */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

/**
 * @typedef {object} StripResult
 * @property {Buffer} bytes - the bytes to upload: the cleaned image, or the input itself when nothing changed or it
 *   was not parsed
 * @property {"jpeg"|"png"|"webp"|null} format - the format recognized, `null` when none of the three
 * @property {boolean} stripped - the image parsed and `bytes` carries none of the metadata listed above
 * @property {string[]} removed - what was dropped, e.g. `["APP1 Exif", "COM"]`, `["tEXt", "eXIf"]`
 * @property {number|null} [orientation] - a JPEG's EXIF orientation that was kept (2-8), else null
 * @property {string} [reason] - why the input was returned unchanged
 */

/**
 * Remove the location, camera, time and text metadata a photo carries, keeping what the picture needs to display
 * the same (color profile, orientation, image data).
 *
 * @param {Uint8Array} input - the photo's bytes
 * @returns {StripResult}
 */
export function stripImageMetadata(input) {
    if (!(input instanceof Uint8Array)) {
        return { bytes: input, format: null, stripped: false, removed: [], reason: "not a byte array" };
    }
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const format = sniff(buf);
    if (!format) return { bytes: buf, format: null, stripped: false, removed: [], reason: "not a JPEG, PNG or WebP" };
    try {
        const out = format === "jpeg" ? stripJpeg(buf) : format === "png" ? stripPng(buf) : stripWebp(buf);
        if (!out.removed.length) return { bytes: buf, format, stripped: true, removed: [], ...extra(out) };
        return { bytes: out.bytes, format, stripped: true, removed: out.removed, ...extra(out) };
    } catch (e) {
        return { bytes: buf, format, stripped: false, removed: [], reason: e?.message || String(e) };
    }
}

/**
 * The format-specific fields of a result.
 *
 * @param {{orientation?: number|null}} out
 * @returns {object}
 */
function extra(out) {
    return "orientation" in out ? { orientation: out.orientation } : {};
}

/**
 * The format of a buffer by its magic bytes.
 *
 * @param {Buffer} b
 * @returns {"jpeg"|"png"|"webp"|null}
 */
function sniff(b) {
    if (b.length >= 3 && b[0] === 0xff && b[1] === SOI && b[2] === 0xff) return "jpeg";
    if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
    if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
        return "webp";
    }
    return null;
}

/**
 * Fail the parse: the caller returns the input unchanged.
 *
 * @param {string} why
 * @returns {never}
 */
function bad(why) {
    throw new Error(why);
}

// ---------------------------------------------------------------- JPEG

/**
 * Whether a JPEG marker stands alone (no length field follows it).
 *
 * @param {number} m
 * @returns {boolean}
 */
function standalone(m) {
    return m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === SOI || m === EOI;
}

/**
 * The ASCII identifier at the start of an APPn payload, up to its NUL (at most 32 bytes).
 *
 * @param {Buffer} payload
 * @returns {string}
 */
function appId(payload) {
    const end = payload.indexOf(0);
    return payload.toString("latin1", 0, end < 0 ? Math.min(payload.length, 32) : Math.min(end, 32));
}

/**
 * Walk a JPEG's segments, dropping the metadata ones; the entropy-coded data of each scan is copied untouched.
 *
 * @param {Buffer} b
 * @returns {{bytes: Buffer, removed: string[], orientation: number|null}}
 */
function stripJpeg(b) {
    const parts = [b.subarray(0, 2)];
    const removed = [];
    let orientation = null;
    let littleEndian = false;
    let exifSeen = false;
    let exifSlot = -1;
    let i = 2;
    let sawScan = false;
    for (;;) {
        if (i >= b.length) bad("JPEG ends before EOI");
        if (b[i] !== 0xff) bad(`JPEG marker expected at ${i}`);
        while (i < b.length && b[i] === 0xff) i++; // fill bytes
        if (i >= b.length) bad("JPEG ends inside a marker");
        const m = b[i];
        const at = i - 1;
        i++;
        if (m === EOI) {
            parts.push(Buffer.from([0xff, EOI]));
            if (i < b.length) removed.push("trailer after EOI");
            break;
        }
        if (m === SOI) bad("second SOI");
        if (standalone(m)) {
            parts.push(b.subarray(at, i));
            continue;
        }
        if (i + 2 > b.length) bad("JPEG segment length past the end");
        const len = b.readUInt16BE(i);
        if (len < 2 || i + len > b.length) bad(`bad JPEG segment length at ${at}`);
        const end = i + len;
        const payload = b.subarray(i + 2, end);
        const seg = b.subarray(at, end);
        i = end;

        if (m === SOS) {
            sawScan = true;
            parts.push(seg);
            // The entropy-coded data runs to the next marker that is neither a stuffed 0xFF00 nor a restart marker.
            let j = i;
            for (;;) {
                if (j + 1 >= b.length) bad("JPEG scan runs to the end without EOI");
                if (b[j] === 0xff) {
                    const n = b[j + 1];
                    if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
                        j += 2;
                        continue;
                    }
                    if (n === 0xff) {
                        j += 1;
                        continue;
                    }
                    break;
                }
                j++;
            }
            parts.push(b.subarray(i, j));
            i = j;
            continue;
        }
        if (m === COM) {
            removed.push("COM");
            continue;
        }
        if (m >= APP0 && m <= 0xef) {
            const n = m - APP0;
            const id = appId(payload);
            if (m === APP0 && id === "JFIF") {
                parts.push(jfifWithoutThumbnail(seg, payload, removed));
                continue;
            }
            if (m === APP2 && id === "ICC_PROFILE") {
                parts.push(seg);
                continue;
            }
            if (m === APP14 && id.startsWith("Adobe")) {
                parts.push(seg);
                continue;
            }
            if (m === APP1 && id === "Exif" && !exifSeen) {
                exifSeen = true;
                ({ value: orientation, littleEndian } = exifOrientation(payload));
                exifSlot = parts.length;
            }
            removed.push(`APP${n}${id ? " " + id : ""}`);
            continue;
        }
        parts.push(seg);
    }
    if (!sawScan) bad("JPEG has no scan");
    if (orientation !== null && orientation !== 1) {
        parts.splice(exifSlot, 0, orientationApp1(orientation, littleEndian));
    } else {
        orientation = null;
    }
    return { bytes: Buffer.concat(parts), removed, orientation };
}

/**
 * A JFIF APP0 segment without its embedded thumbnail: unchanged when it has none, else the 16-byte form with the
 * same version, units and density and a 0x0 thumbnail.
 *
 * @param {Buffer} seg - the whole segment, marker included
 * @param {Buffer} payload - the segment after its length field
 * @param {string[]} removed
 * @returns {Buffer}
 */
function jfifWithoutThumbnail(seg, payload, removed) {
    if (payload.length < 14) return seg;
    const tw = payload[12];
    const th = payload[13];
    if (tw === 0 && th === 0 && payload.length === 14) return seg;
    const out = Buffer.alloc(18);
    out[0] = 0xff;
    out[1] = APP0;
    out.writeUInt16BE(16, 2);
    payload.copy(out, 4, 0, 12);
    removed.push("JFIF thumbnail");
    return out;
}

/**
 * The Orientation tag of IFD0 in an EXIF APP1 payload (`Exif\0\0` + TIFF), and the block's byte order. The value
 * is null when the tag is absent, out of range or the block cannot be read.
 *
 * @param {Buffer} p
 * @returns {{value: number|null, littleEndian: boolean}}
 */
function exifOrientation(p) {
    let le = false;
    try {
        if (p.length < 14 || p.toString("latin1", 0, 6) !== "Exif\0\0") return { value: null, littleEndian: le };
        const t = p.subarray(6);
        const order = t.toString("latin1", 0, 2);
        if (order !== "II" && order !== "MM") return { value: null, littleEndian: le };
        le = order === "II";
        const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
        const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
        if (u16(2) !== 42) return { value: null, littleEndian: le };
        const ifd = u32(4);
        if (ifd + 2 > t.length) return { value: null, littleEndian: le };
        const count = u16(ifd);
        for (let k = 0; k < count; k++) {
            const e = ifd + 2 + k * 12;
            if (e + 12 > t.length) break;
            if (u16(e) !== ORIENTATION_TAG) continue;
            if (u16(e + 2) !== 3) break; // not a SHORT
            const v = u16(e + 8);
            return { value: v >= 1 && v <= 8 ? v : null, littleEndian: le };
        }
        return { value: null, littleEndian: le };
    } catch {
        return { value: null, littleEndian: le };
    }
}

/**
 * A minimal EXIF APP1 segment: a TIFF header in the original block's byte order and IFD0 holding only the
 * Orientation tag.
 *
 * @param {number} orientation - 2 to 8
 * @param {boolean} le - little-endian (`II`) rather than big-endian (`MM`)
 * @returns {Buffer}
 */
function orientationApp1(orientation, le) {
    const out = Buffer.alloc(2 + 2 + 6 + 8 + 2 + 12 + 4);
    const u16 = (v, at) => (le ? out.writeUInt16LE(v, at) : out.writeUInt16BE(v, at));
    const u32 = (v, at) => (le ? out.writeUInt32LE(v, at) : out.writeUInt32BE(v, at));
    let o = 0;
    out[o++] = 0xff;
    out[o++] = APP1;
    out.writeUInt16BE(out.length - 2, o); // JPEG lengths are always big-endian
    o += 2;
    out.write("Exif\0\0", o, "latin1");
    o += 6;
    out.write(le ? "II" : "MM", o, "latin1");
    u16(42, o + 2);
    u32(8, o + 4); // IFD0 right after the header
    o += 8;
    u16(1, o); // one entry
    o += 2;
    u16(ORIENTATION_TAG, o);
    u16(3, o + 2); // SHORT
    u32(1, o + 4); // count
    u16(orientation, o + 8); // value, left-justified in the 4-byte field
    o += 12;
    u32(0, o); // no next IFD
    return out;
}

// ---------------------------------------------------------------- PNG

/**
 * Walk a PNG's chunks, dropping text, EXIF and time chunks and anything after IEND.
 *
 * @param {Buffer} b
 * @returns {{bytes: Buffer, removed: string[]}}
 */
function stripPng(b) {
    const parts = [b.subarray(0, 8)];
    const removed = [];
    let i = 8;
    let first = true;
    for (;;) {
        if (i + 12 > b.length) bad("PNG ends before IEND");
        const len = b.readUInt32BE(i);
        const type = b.toString("latin1", i + 4, i + 8);
        if (!/^[A-Za-z]{4}$/.test(type)) bad(`bad PNG chunk type at ${i}`);
        if (first && type !== "IHDR") bad("PNG does not start with IHDR");
        first = false;
        const end = i + 12 + len;
        if (len > 0x7fffffff || end > b.length) bad(`PNG chunk ${type} runs past the end`);
        if (PNG_DROP.has(type)) removed.push(type);
        else parts.push(b.subarray(i, end));
        i = end;
        if (type === "IEND") break;
    }
    if (i < b.length) removed.push("trailer after IEND");
    return { bytes: Buffer.concat(parts), removed };
}

// ---------------------------------------------------------------- WebP

/**
 * Walk a WebP's RIFF chunks, dropping EXIF and XMP, clearing their VP8X flags and rewriting the RIFF size.
 *
 * @param {Buffer} b
 * @returns {{bytes: Buffer, removed: string[]}}
 */
function stripWebp(b) {
    const riffEnd = 8 + b.readUInt32LE(4);
    if (riffEnd > b.length || riffEnd < 12) bad("RIFF size past the end");
    const parts = [];
    const removed = [];
    let vp8x = null;
    let i = 12;
    while (i < riffEnd) {
        if (i + 8 > riffEnd) bad(`truncated RIFF chunk at ${i}`);
        const fourcc = b.toString("latin1", i, i + 4);
        const size = b.readUInt32LE(i + 4);
        const end = i + 8 + size + (size & 1);
        if (end > riffEnd && i + 8 + size !== riffEnd) bad(`RIFF chunk ${fourcc} runs past the end`);
        const chunk = b.subarray(i, Math.min(end, riffEnd));
        i = Math.min(end, riffEnd);
        if (fourcc === "EXIF" || fourcc === "XMP ") {
            removed.push(fourcc.trim());
            continue;
        }
        if (fourcc === "VP8X") {
            if (size < 10) bad("VP8X chunk too short");
            vp8x = Buffer.from(chunk);
            parts.push(vp8x);
            continue;
        }
        parts.push(chunk);
    }
    if (riffEnd < b.length) removed.push("trailer after RIFF");
    if (vp8x && vp8x[8] & (VP8X_EXIF | VP8X_XMP)) {
        vp8x[8] &= ~(VP8X_EXIF | VP8X_XMP) & 0xff;
        if (!removed.length) removed.push("VP8X metadata flags");
    }
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "latin1");
    head.writeUInt32LE(4 + body.length, 4);
    head.write("WEBP", 8, "latin1");
    return { bytes: Buffer.concat([head, body]), removed };
}
