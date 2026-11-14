/**
 * Template image checks for ZBS "API Upload Ảnh" (Zalo's ZBS docs): JPG or PNG up to 500 KB; a logo is a PNG of
 * 400x96 px; a template image is JPG/PNG at 16:9. The pixel size is read from the file header (PNG IHDR, JPEG SOFn).
 */

import fs from "node:fs";
import { extname } from "node:path";
import { OAError } from "../oa/transport.js";

/** The upload limits: 500 KB (read as KiB, like the OA upload limits), jpg/png. */
export const ZBS_IMAGE_LIMITS = Object.freeze({ maxBytes: 500 * 1024, types: Object.freeze(["jpg", "jpeg", "png"]) });

/** The logo rule: PNG, 400x96 px. */
export const LOGO_SIZE = Object.freeze({ width: 400, height: 96 });

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * Pixel size of a PNG or JPEG image from its header bytes, or null when it is neither or the header is cut short.
 *
 * @param {Buffer} buf
 * @returns {{ format: "png"|"jpeg", width: number, height: number }|null}
 */
export function imageSize(buf) {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("latin1", 12, 16) === "IHDR") {
        return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let off = 2;
        while (off + 9 < buf.length) {
            if (buf[off] !== 0xff) return null;
            const marker = buf[off + 1];
            if (marker === 0xff) {
                off += 1;
                continue;
            }
            if (SOF.has(marker)) {
                return { format: "jpeg", height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
            }
            off += 2 + buf.readUInt16BE(off + 2);
        }
    }
    return null;
}

/**
 * Check a file against a template image role before upload: `logo` → PNG of 400x96 px; `image` → JPG/PNG at 16:9
 * (within 1%). Size and extension are checked by the upload itself.
 *
 * @param {string} filePath
 * @param {"logo"|"image"} kind
 * @throws {OAError} code `upload_type` / `upload_missing`
 */
export function checkTemplateImage(filePath, kind) {
    let buf;
    try {
        buf = fs.readFileSync(filePath);
    } catch {
        throw new OAError(`No such file: ${filePath}`, { code: "upload_missing" });
    }
    const size = imageSize(buf);
    if (!size) throw new OAError(`${filePath} is not a PNG or JPEG image`, { code: "upload_type" });
    const ext = extname(filePath).slice(1).toLowerCase();
    if (kind === "logo") {
        if (size.format !== "png" || ext !== "png") {
            throw new OAError("A template logo must be a PNG", { code: "upload_type" });
        }
        if (size.width !== LOGO_SIZE.width || size.height !== LOGO_SIZE.height) {
            throw new OAError(
                `A template logo must be ${LOGO_SIZE.width}x${LOGO_SIZE.height} px (this one is ${size.width}x${size.height})`,
                { code: "upload_type" },
            );
        }
    } else if (kind === "image") {
        const ratio = size.width / size.height;
        if (Math.abs(ratio - 16 / 9) > (16 / 9) * 0.01) {
            throw new OAError(`A template image must be 16:9 (this one is ${size.width}x${size.height})`, {
                code: "upload_type",
            });
        }
    } else {
        throw new OAError(`Unknown image kind "${kind}" (logo or image)`, { code: "invalid_input" });
    }
    return size;
}
