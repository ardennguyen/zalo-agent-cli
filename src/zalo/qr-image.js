/**
 * A QR code as a PNG, for the second QR of the trusted-device login (see ./trust-wasm.js).
 *
 * The first QR of a login is an image Zalo's server draws. The second is text the trust module makes, which the
 * page draws itself; this does the same: the text is encoded as bytes, with the page's own choice of error
 * correction (H for a text under 150 characters, M above), and written as a grayscale PNG.
 */
import { deflateSync } from "node:zlib";
import qrcode from "qrcode-generator";

/** Modules of white around the code, as the QR standard asks. */
const QUIET_ZONE = 4;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

const crc32 = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
};

/**
 * Error correction the page uses for a text of this length.
 *
 * @param {string} text
 * @returns {"H"|"M"}
 */
export function errorLevelFor(text) {
    return String(text).length < 150 ? "H" : "M";
}

/**
 * Encode text as a QR code and return it as PNG bytes.
 *
 * @param {string} text
 * @param {{scale?: number}} [options] - pixels per module, 8 by default
 * @returns {Buffer}
 */
export function qrPng(text, { scale = 8 } = {}) {
    const qr = qrcode(0, errorLevelFor(text));
    qr.addData(String(text), "Byte");
    qr.make();
    const modules = qr.getModuleCount();
    const size = (modules + QUIET_ZONE * 2) * scale;

    // One filter byte (0, none) then the row's pixels: 0 is black, 255 white.
    const row = Buffer.alloc(size + 1, 255);
    row[0] = 0;
    const raw = Buffer.alloc((size + 1) * size);
    for (let y = 0; y < size; y++) {
        const moduleY = Math.floor(y / scale) - QUIET_ZONE;
        row.fill(255, 1);
        if (moduleY >= 0 && moduleY < modules) {
            for (let x = 0; x < size; x++) {
                const moduleX = Math.floor(x / scale) - QUIET_ZONE;
                if (moduleX >= 0 && moduleX < modules && qr.isDark(moduleY, moduleX)) row[x + 1] = 0;
            }
        }
        row.copy(raw, y * (size + 1));
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 0; // grayscale
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}
