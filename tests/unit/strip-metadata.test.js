/**
 * Photo metadata stripping (src/zalo/strip-metadata.js): what each format loses, what it keeps byte for byte, the
 * EXIF orientation that survives, and malformed input coming back unchanged. The images are hand-built
 * (tests/helpers/metadata-images.js); every planted value is a marker string, none of it real.
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { imageSize } from "image-size";
import { stripImageMetadata } from "../../src/zalo/strip-metadata.js";
import { IMAGES } from "../fixtures/index.js";
import {
    ADOBE_PAYLOAD,
    PNG_SIG,
    SECRETS,
    jpegImageHalf,
    jpegWithMetadata,
    pngChunk,
    pngWithMetadata,
    segment,
    webpWithMetadata,
} from "../helpers/metadata-images.js";

/** Whether `buf` contains the latin1 string `s`. */
const has = (buf, s) => buf.indexOf(Buffer.from(s, "latin1")) >= 0;

/**
 * A JPEG's segments up to the first SOS: `[marker, payload]`.
 *
 * @param {Buffer} b
 * @returns {Array<[number, Buffer]>}
 */
function jpegHeaderSegments(b) {
    const out = [];
    let i = 2;
    while (i < b.length) {
        assert.equal(b[i], 0xff, `marker at ${i}`);
        const m = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        out.push([m, b.subarray(i + 4, i + 2 + len)]);
        if (m === 0xda) break;
        i += 2 + len;
    }
    return out;
}

/**
 * Every PNG chunk: `[type, whole chunk, crc ok]`.
 *
 * @param {Buffer} b
 * @returns {Array<[string, Buffer, boolean]>}
 */
function pngChunks(b) {
    const out = [];
    let i = 8;
    while (i < b.length) {
        const len = b.readUInt32BE(i);
        const type = b.toString("latin1", i + 4, i + 8);
        const whole = b.subarray(i, i + 12 + len);
        const crcOk = crc32(b.subarray(i + 4, i + 8 + len)) >>> 0 === b.readUInt32BE(i + 8 + len);
        out.push([type, whole, crcOk]);
        i += 12 + len;
    }
    return out;
}

/**
 * Every RIFF chunk of a WebP: `[fourcc, payload]`.
 *
 * @param {Buffer} b
 * @returns {Array<[string, Buffer]>}
 */
function riffChunks(b) {
    const out = [];
    let i = 12;
    while (i < b.length) {
        const size = b.readUInt32LE(i + 4);
        out.push([b.toString("latin1", i, i + 4), b.subarray(i + 8, i + 8 + size)]);
        i += 8 + size + (size & 1);
    }
    return out;
}

describe("stripImageMetadata: JPEG", () => {
    it("drops EXIF (make, model, GPS, thumbnail), XMP, MPF, APP13, the comment and the trailer", () => {
        const { bytes } = jpegWithMetadata();
        for (const s of Object.values(SECRETS).filter((v) => !v.startsWith("PNG") && !v.startsWith("WEBP"))) {
            assert.ok(has(bytes, s), `the input carries ${s}`);
        }
        const r = stripImageMetadata(bytes);
        assert.equal(r.format, "jpeg");
        assert.equal(r.stripped, true);
        for (const s of [
            SECRETS.make,
            SECRETS.model,
            SECRETS.gps,
            SECRETS.thumb,
            SECRETS.xmp,
            SECRETS.comment,
            SECRETS.trailer,
            SECRETS.photoshop,
            SECRETS.mpf,
        ]) {
            assert.equal(has(r.bytes, s), false, `${s} is gone`);
        }
        assert.ok(r.bytes.length < bytes.length);
        assert.deepEqual(r.removed, [
            "JFIF thumbnail",
            "APP1 Exif",
            "APP1 http://ns.adobe.com/xap/1.0/",
            "APP2 MPF",
            "APP13 Photoshop 3.0",
            "COM",
            "trailer after EOI",
        ]);
    });

    it("keeps the ICC profile, the Adobe segment and the image data byte for byte, and stays a valid JPEG", () => {
        const { bytes, image, icc, adobe } = jpegWithMetadata();
        const out = stripImageMetadata(bytes).bytes;
        assert.deepEqual([...out.subarray(0, 2)], [0xff, 0xd8], "starts with SOI");
        assert.deepEqual([...out.subarray(-2)], [0xff, 0xd9], "ends with EOI");
        assert.ok(out.subarray(-image.length).equals(image), "tables, frame, scan and EOI unchanged");
        assert.ok(out.indexOf(icc) > 0, "ICC_PROFILE kept");
        assert.ok(out.indexOf(adobe) > 0, "Adobe APP14 kept");
        const dims = imageSize(out);
        assert.deepEqual([dims.width, dims.height, dims.type], [16, 8, "jpg"]);
    });

    it("keeps orientation 6 in a minimal EXIF holding that one tag, in the input's byte order", () => {
        for (const littleEndian of [true, false]) {
            const out = stripImageMetadata(jpegWithMetadata({ orientation: 6, littleEndian }).bytes);
            assert.equal(out.orientation, 6);
            const exif = jpegHeaderSegments(out.bytes).filter(([m]) => m === 0xe1);
            assert.equal(exif.length, 1, "one APP1 left");
            const p = exif[0][1];
            const order = littleEndian ? "II" : "MM";
            const tiff = p.subarray(6);
            const u16 = (o) => (littleEndian ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
            const u32 = (o) => (littleEndian ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
            assert.equal(p.toString("latin1", 0, 8), `Exif\0\0${order}`);
            assert.equal(p.length, 32, "header, one entry, no next IFD");
            assert.equal(u16(8), 1, "IFD0 has one entry");
            assert.deepEqual([u16(10), u16(12), u32(14), u16(18)], [0x0112, 3, 1, 6]);
            assert.equal(u32(22), 0, "no IFD1 (no thumbnail)");
            assert.equal(imageSize(out.bytes).orientation, 6, "an image reader still sees orientation 6");
        }
    });

    it("orientation 1 or none: no EXIF at all is left", () => {
        for (const orientation of [1, null]) {
            const out = stripImageMetadata(jpegWithMetadata({ orientation }).bytes);
            assert.equal(out.orientation, null);
            assert.equal(jpegHeaderSegments(out.bytes).filter(([m]) => m === 0xe1).length, 0);
            assert.equal(has(out.bytes, "Exif"), false);
        }
    });

    it("an EXIF block that cannot be read is dropped whole", () => {
        const bytes = Buffer.concat([
            Buffer.from([0xff, 0xd8]),
            segment(0xe1, Buffer.from(`Exif\0\0XX garbage ${SECRETS.gps}`, "latin1")),
            jpegImageHalf(),
        ]);
        const r = stripImageMetadata(bytes);
        assert.equal(r.stripped, true);
        assert.equal(r.orientation, null);
        assert.equal(has(r.bytes, SECRETS.gps), false);
        assert.ok(r.bytes.equals(Buffer.concat([Buffer.from([0xff, 0xd8]), jpegImageHalf()])));
    });

    it("a JPEG with nothing to drop comes back as the same buffer", () => {
        const bytes = readFileSync(IMAGES.jpg.path);
        const r = stripImageMetadata(bytes);
        assert.equal(r.stripped, true);
        assert.deepEqual(r.removed, []);
        assert.equal(r.bytes, bytes);
        const plain = Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xee, ADOBE_PAYLOAD), jpegImageHalf()]);
        assert.equal(stripImageMetadata(plain).bytes, plain);
    });

    it("the orientation-only fixture keeps its orientation and its bytes", () => {
        const bytes = readFileSync(IMAGES.jpgRotated.path);
        const r = stripImageMetadata(bytes);
        assert.equal(r.orientation, 6);
        assert.ok(r.bytes.equals(bytes));
    });

    it("a plain Uint8Array is accepted", () => {
        const { bytes } = jpegWithMetadata();
        const view = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
        const r = stripImageMetadata(view);
        assert.equal(r.stripped, true);
        assert.equal(has(r.bytes, SECRETS.gps), false);
    });
});

describe("stripImageMetadata: PNG", () => {
    it("drops tEXt, iTXt, zTXt, eXIf, tIME and the trailer; every kept chunk is unchanged and CRC-valid", () => {
        const { bytes, kept } = pngWithMetadata();
        const r = stripImageMetadata(bytes);
        assert.equal(r.format, "png");
        assert.equal(r.stripped, true);
        assert.deepEqual(r.removed, ["tEXt", "iTXt", "zTXt", "eXIf", "tIME", "trailer after IEND"]);
        assert.ok(r.bytes.equals(Buffer.concat([PNG_SIG, ...kept])));
        const chunks = pngChunks(r.bytes);
        assert.deepEqual(
            chunks.map(([t]) => t),
            ["IHDR", "iCCP", "sRGB", "gAMA", "pHYs", "IDAT", "IEND"],
        );
        assert.ok(
            chunks.every(([, , ok]) => ok),
            "every CRC checks",
        );
        for (const s of [SECRETS.text, SECRETS.itxt, SECRETS.exifChunk, SECRETS.trailer]) {
            assert.equal(has(r.bytes, s), false, `${s} is gone`);
        }
        assert.deepEqual([imageSize(r.bytes).width, imageSize(r.bytes).height], [1, 1]);
    });

    it("the fixture PNG has nothing to drop and comes back as the same buffer", () => {
        const bytes = readFileSync(IMAGES.png.path);
        assert.equal(stripImageMetadata(bytes).bytes, bytes);
    });
});

describe("stripImageMetadata: WebP", () => {
    const fixture = readFileSync(IMAGES.webp.path);
    const vp8 = fixture.subarray(12);

    it("drops EXIF and XMP, clears their VP8X flags and rewrites the RIFF size", () => {
        const { bytes, iccp } = webpWithMetadata(vp8);
        const r = stripImageMetadata(bytes);
        assert.equal(r.format, "webp");
        assert.equal(r.stripped, true);
        assert.deepEqual(r.removed, ["EXIF", "XMP"]);
        assert.equal(r.bytes.readUInt32LE(4), r.bytes.length - 8, "RIFF size");
        const chunks = riffChunks(r.bytes);
        assert.deepEqual(
            chunks.map(([f]) => f),
            ["VP8X", "ICCP", "VP8 "],
        );
        assert.equal(chunks[0][1][0], 0x20 | 0x10, "ICC and alpha flags stay, EXIF and XMP cleared");
        assert.ok(r.bytes.indexOf(iccp) > 0, "ICCP kept");
        assert.ok(r.bytes.subarray(-vp8.length).equals(vp8), "bitstream unchanged");
        assert.equal(has(r.bytes, SECRETS.webpExif), false);
        assert.equal(has(r.bytes, SECRETS.webpXmp), false);
        assert.deepEqual([imageSize(r.bytes).width, imageSize(r.bytes).height], [1, 1]);
    });

    it("a simple WebP comes back as the same buffer", () => {
        assert.equal(stripImageMetadata(fixture).bytes, fixture);
    });
});

describe("stripImageMetadata: anything it cannot parse comes back unchanged", () => {
    const cases = {
        "a truncated JPEG (no EOI)": () => jpegWithMetadata().bytes.subarray(0, 400),
        "a JPEG segment length past the end": () =>
            Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff]), Buffer.from(SECRETS.gps, "latin1")]),
        "a JPEG with no scan": () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        "a PNG chunk running past the end": () =>
            Buffer.concat([
                PNG_SIG,
                pngChunk("IHDR", Buffer.alloc(13)),
                Buffer.from([0, 0, 1, 0, 0x74, 0x45, 0x58, 0x74]),
            ]),
        "a PNG without IEND": () => Buffer.concat([PNG_SIG, pngChunk("IHDR", Buffer.alloc(13))]),
        "a WebP whose RIFF size is past the end": () => {
            const b = Buffer.from(webpWithMetadata(fixtureVp8()).bytes);
            b.writeUInt32LE(b.length * 2, 4);
            return b;
        },
    };
    function fixtureVp8() {
        return readFileSync(IMAGES.webp.path).subarray(12);
    }
    for (const [name, make] of Object.entries(cases)) {
        it(name, () => {
            const input = make();
            const r = stripImageMetadata(input);
            assert.equal(r.bytes, input, "the very same buffer");
            assert.equal(r.stripped, false);
            assert.equal(typeof r.reason, "string");
        });
    }

    it("GIF, BMP, TIFF, random bytes and an empty buffer are not touched", () => {
        for (const input of [
            readFileSync(IMAGES.gif.path),
            readFileSync(IMAGES.bmp.path),
            readFileSync(IMAGES.tiff.path),
            Buffer.from("not an image at all"),
            Buffer.alloc(0),
        ]) {
            const r = stripImageMetadata(input);
            assert.equal(r.bytes, input);
            assert.equal(r.format, null);
            assert.equal(r.stripped, false);
        }
    });

    it("something that is not bytes is returned as it is", () => {
        assert.equal(stripImageMetadata(undefined).bytes, undefined);
        assert.equal(stripImageMetadata("a path").stripped, false);
    });
});
