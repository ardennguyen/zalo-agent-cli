/**
 * Hand-built images that carry metadata, for the metadata-stripping tests (src/zalo/strip-metadata.js).
 *
 * Every value in them is invented: the "GPS" position, the camera make and model, the comment and the text chunks
 * are marker strings a test can search for in the output. The JPEG is a structurally complete baseline file (tables,
 * frame, scan, EOI) so an image reader can parse it; its entropy-coded data is filler, not a decodable picture.
 */
import { crc32 } from "node:zlib";

/** Strings planted in the metadata; none of them may survive a strip. */
export const SECRETS = {
    make: "FAKECAM-MAKER",
    model: "FAKECAM-MODEL-9",
    gps: "GPS-SECRET-POSITION",
    thumb: "EXIF-THUMBNAIL-BYTES",
    xmp: "XMP-SECRET-PACKET",
    comment: "COM-SECRET-COMMENT",
    trailer: "TRAILER-AFTER-END",
    text: "PNG-TEXT-SECRET",
    itxt: "PNG-ITXT-SECRET",
    exifChunk: "PNG-EXIF-SECRET",
    webpExif: "WEBP-EXIF-SECRET",
    webpXmp: "WEBP-XMP-SECRET",
    photoshop: "APP13-SECRET-IPTC",
    mpf: "MPF-SECRET",
};

/**
 * A JPEG segment: marker, big-endian length, payload.
 *
 * @param {number} marker
 * @param {Buffer} payload
 * @returns {Buffer}
 */
export function segment(marker, payload) {
    const head = Buffer.alloc(4);
    head[0] = 0xff;
    head[1] = marker;
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
}

/**
 * An EXIF APP1 payload: IFD0 with Make, Model, Orientation (when given) and a GPS IFD pointer; the GPS IFD holds one
 * ASCII entry; IFD1 points at an embedded "thumbnail".
 *
 * @param {{orientation?: number|null, littleEndian?: boolean}} [opts]
 * @returns {Buffer}
 */
export function exifPayload({ orientation = 6, littleEndian = true } = {}) {
    const le = littleEndian;
    const t = Buffer.alloc(512);
    const u16 = (v, at) => (le ? t.writeUInt16LE(v, at) : t.writeUInt16BE(v, at));
    const u32 = (v, at) => (le ? t.writeUInt32LE(v, at) : t.writeUInt32BE(v, at));
    t.write(le ? "II" : "MM", 0, "latin1");
    u16(42, 2);
    u32(8, 4);
    const make = Buffer.from(SECRETS.make + "\0", "latin1");
    const model = Buffer.from(SECRETS.model + "\0", "latin1");
    const gps = Buffer.from(SECRETS.gps + "\0", "latin1");
    const thumb = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from(SECRETS.thumb, "latin1"),
        Buffer.from([0xff, 0xd9]),
    ]);
    const entries = [
        [0x010f, 2, make.length, "make"],
        [0x0110, 2, model.length, "model"],
        ...(orientation ? [[0x0112, 3, 1, orientation]] : []),
        [0x8825, 4, 1, "gpsIfd"],
    ];
    const ifd0 = 8;
    const ifd0End = ifd0 + 2 + entries.length * 12 + 4;
    let data = ifd0End;
    const place = {};
    place.make = data;
    make.copy(t, data);
    data += make.length;
    place.model = data;
    model.copy(t, data);
    data += model.length;
    place.gpsIfd = data;
    data += 2 + 12 + 4;
    place.gps = data;
    gps.copy(t, data);
    data += gps.length;
    place.ifd1 = data;
    data += 2 + 2 * 12 + 4;
    place.thumb = data;
    thumb.copy(t, data);
    data += thumb.length;

    u16(entries.length, ifd0);
    entries.forEach(([tag, type, count, val], k) => {
        const e = ifd0 + 2 + k * 12;
        u16(tag, e);
        u16(type, e + 2);
        u32(count, e + 4);
        if (typeof val === "number") u16(val, e + 8);
        else u32(place[val], e + 8);
    });
    u32(place.ifd1, ifd0 + 2 + entries.length * 12);
    // GPS IFD: one ASCII entry (GPSMapDatum, standing in for the position tags)
    u16(1, place.gpsIfd);
    u16(0x0012, place.gpsIfd + 2);
    u16(2, place.gpsIfd + 4);
    u32(gps.length, place.gpsIfd + 6);
    u32(place.gps, place.gpsIfd + 10);
    u32(0, place.gpsIfd + 14);
    // IFD1: JPEGInterchangeFormat and its length
    u16(2, place.ifd1);
    u16(0x0201, place.ifd1 + 2);
    u16(4, place.ifd1 + 4);
    u32(1, place.ifd1 + 6);
    u32(place.thumb, place.ifd1 + 10);
    u16(0x0202, place.ifd1 + 14);
    u16(4, place.ifd1 + 16);
    u32(1, place.ifd1 + 18);
    u32(thumb.length, place.ifd1 + 22);
    u32(0, place.ifd1 + 26);
    return Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t.subarray(0, data)]);
}

/** The JFIF APP0 payload, with a 1x1 thumbnail (three RGB bytes) when asked. */
function jfifPayload(withThumb) {
    const base = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 1, 0, 72, 0, 72]);
    return withThumb
        ? Buffer.concat([base, Buffer.from([1, 1, 0x11, 0x22, 0x33])])
        : Buffer.concat([base, Buffer.from([0, 0])]);
}

/** A fake ICC profile APP2 payload. */
export const ICC_PAYLOAD = Buffer.concat([
    Buffer.from("ICC_PROFILE\0", "latin1"),
    Buffer.from([1, 1]),
    Buffer.alloc(40, 0x5a),
]);

/** An Adobe APP14 payload (version, flags0, flags1, transform). */
export const ADOBE_PAYLOAD = Buffer.from([0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 1]);

/**
 * The image half of a baseline 16x8 JPEG: DQT, SOF0, DHT, DRI, SOS and entropy data with a stuffed 0xFF00 and a
 * restart marker, then EOI.
 *
 * @param {number} [fill] - filler bytes of entropy data
 * @returns {Buffer}
 */
export function jpegImageHalf(fill = 64) {
    const dqt = segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
    const sof = segment(0xc0, Buffer.from([8, 0, 8, 0, 16, 1, 1, 0x11, 0]));
    const dht = segment(
        0xc4,
        Buffer.concat([Buffer.from([0x00]), Buffer.from([0, 1]), Buffer.alloc(14), Buffer.from([0])]),
    );
    const dri = segment(0xdd, Buffer.from([0, 4]));
    const sos = segment(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0]));
    const filler = Buffer.from(Array.from({ length: fill }, (_, i) => (i * 13 + 5) % 0xfe));
    const scan = Buffer.concat([filler, Buffer.from([0xff, 0x00, 0x12, 0xff, 0xd0, 0x34]), filler]);
    return Buffer.concat([dqt, sof, dht, dri, sos, scan, Buffer.from([0xff, 0xd9])]);
}

/**
 * A JPEG with every kind of metadata the stripper knows: JFIF with a thumbnail, EXIF (Make, Model, Orientation, a GPS
 * IFD, a thumbnail), XMP, ICC, MPF, Photoshop APP13, Adobe APP14, a comment, and a trailer after EOI.
 *
 * @param {{orientation?: number|null, littleEndian?: boolean, fill?: number}} [opts]
 * @returns {{bytes: Buffer, image: Buffer, icc: Buffer, adobe: Buffer}} `image` is the tables-to-EOI half, which a
 *   strip must keep byte for byte
 */
export function jpegWithMetadata({ orientation = 6, littleEndian = true, fill = 64 } = {}) {
    const icc = segment(0xe2, ICC_PAYLOAD);
    const adobe = segment(0xee, ADOBE_PAYLOAD);
    const image = jpegImageHalf(fill);
    const bytes = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        segment(0xe0, jfifPayload(true)),
        segment(0xe1, exifPayload({ orientation, littleEndian })),
        segment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${SECRETS.xmp}</x:xmpmeta>`, "latin1")),
        icc,
        segment(0xe2, Buffer.from(`MPF\0${SECRETS.mpf}`, "latin1")),
        segment(0xed, Buffer.from(`Photoshop 3.0\0${SECRETS.photoshop}`, "latin1")),
        adobe,
        segment(0xfe, Buffer.from(SECRETS.comment, "latin1")),
        image,
        Buffer.from(SECRETS.trailer, "latin1"),
    ]);
    return { bytes, image, icc, adobe };
}

/**
 * A PNG chunk with its CRC.
 *
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
export function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
}

/** The PNG signature. */
export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A 1x1 PNG with iCCP, sRGB, gAMA, pHYs and the metadata chunks tEXt, iTXt, zTXt, eXIf and tIME, and a trailer.
 *
 * @returns {{bytes: Buffer, kept: Buffer[]}} `kept` are the chunks a strip must keep, in order
 */
export function pngWithMetadata() {
    const ihdr = pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
    const iccp = pngChunk("iCCP", Buffer.concat([Buffer.from("fake\0\0", "latin1"), Buffer.alloc(20, 0x78)]));
    const srgb = pngChunk("sRGB", Buffer.from([0]));
    const gama = pngChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f]));
    const phys = pngChunk("pHYs", Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]));
    const idat = pngChunk(
        "IDAT",
        Buffer.from([0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00]),
    );
    const iend = pngChunk("IEND", Buffer.alloc(0));
    const bytes = Buffer.concat([
        PNG_SIG,
        ihdr,
        iccp,
        pngChunk("tEXt", Buffer.from(`Comment\0${SECRETS.text}`, "latin1")),
        srgb,
        gama,
        pngChunk("iTXt", Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${SECRETS.itxt}`, "latin1")),
        pngChunk("zTXt", Buffer.from("Raw profile\0\0\x78\x9c\x03\x00\x00\x00\x00\x01", "latin1")),
        pngChunk("eXIf", Buffer.from(`MM\0*${SECRETS.exifChunk}`, "latin1")),
        pngChunk("tIME", Buffer.from([0x07, 0xea, 11, 15, 12, 0, 0])),
        phys,
        idat,
        iend,
        Buffer.from(SECRETS.trailer, "latin1"),
    ]);
    return { bytes, kept: [ihdr, iccp, srgb, gama, phys, idat, iend] };
}

/**
 * A RIFF chunk, padded to an even length.
 *
 * @param {string} fourcc
 * @param {Buffer} data
 * @returns {Buffer}
 */
export function riffChunk(fourcc, data) {
    const head = Buffer.alloc(8);
    head.write(fourcc, 0, "latin1");
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/**
 * An extended WebP: VP8X (ICC, alpha, EXIF and XMP flags set), ICCP, the VP8 bitstream of the 1x1 fixture, an odd-length
 * EXIF chunk and an XMP chunk.
 *
 * @param {Buffer} vp8 - a whole `VP8 ` chunk
 * @returns {{bytes: Buffer, iccp: Buffer, vp8: Buffer}}
 */
export function webpWithMetadata(vp8) {
    const flags = 0x20 | 0x10 | 0x08 | 0x04;
    const vp8x = riffChunk("VP8X", Buffer.from([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const iccp = riffChunk("ICCP", Buffer.alloc(16, 0x33));
    const body = Buffer.concat([
        Buffer.from("WEBP", "latin1"),
        vp8x,
        iccp,
        vp8,
        riffChunk("EXIF", Buffer.from(`II*\0${SECRETS.webpExif}!`, "latin1")),
        riffChunk("XMP ", Buffer.from(`<x:xmpmeta>${SECRETS.webpXmp}</x:xmpmeta>`, "latin1")),
    ]);
    const head = Buffer.alloc(8);
    head.write("RIFF", 0, "latin1");
    head.writeUInt32LE(body.length, 4);
    return { bytes: Buffer.concat([head, body]), iccp, vp8 };
}
