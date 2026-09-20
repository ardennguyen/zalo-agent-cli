/**
 * Committed sample media for the test suite.
 *
 * These are real, valid files — not base64 stubs generated at runtime. That
 * matters for two reasons:
 *
 *  1. `readImageMetadata()` in src/core/zalo-client.js reads dimensions via
 *     image-size and then applies EXIF orientation. Only genuine encoder
 *     output exercises the real format parsers, and only a genuinely
 *     EXIF-tagged file exercises the orientation transpose.
 *
 *  2. The live suite uploads them to Zalo, which rejects malformed media.
 *
 * The PNG/JPEG/GIF images were produced by System.Drawing at known
 * dimensions, so the expected width/height below are ground truth rather
 * than assumptions. `image-1x1.webp` is the canonical 44-byte minimal lossy
 * WebP test vector — small because no WebP encoder was available on the
 * machine that built these; see README.md to regenerate a larger one.
 *
 * Every fixture carries a SHA-256. `verifyFixtures()` checks it, so drift is
 * caught outright rather than surfacing later as a confusing upload failure.
 * That is not hypothetical: `document.pdf` was silently rewritten on disk by
 * a PDF handler (a hand-written 453-byte PDF 1.4 became a 4674-byte
 * linearized PDF 1.6). The checksums below describe the files as they now
 * stand; if one legitimately changes, regenerate them with README.md.
 *
 * Total footprint is ~32 KB.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dirname;

const f = (name, extra = {}) => ({ name, path: join(DIR, name), ...extra });

/** Images, with the dimensions their encoder actually wrote. */
export const IMAGES = {
    png: f("image-64x48.png", { width: 64, height: 48, format: "PNG" }),
    jpg: f("image-64x48.jpg", { width: 64, height: 48, format: "JPEG" }),
    gif: f("image-64x48.gif", { width: 64, height: 48, format: "GIF" }),
    jpgLarge: f("image-200x120.jpg", { width: 200, height: 120, format: "JPEG" }),
    webp: f("image-1x1.webp", { width: 1, height: 1, format: "WebP" }),
    // Stored 200x120 landscape, EXIF orientation 6 (rotate 90°) — so the
    // DISPLAYED size is 120x200. Guards the orientation transpose.
    jpgRotated: f("image-200x120-rot90.jpg", { width: 120, height: 200, format: "JPEG", orientation: 6 }),
    // Not an inline format for Zalo — it uploads as a file attachment —
    // but image-size reads it, so the getter must not choke on it.
    bmp: f("image-64x48.bmp", { width: 64, height: 48, format: "BMP", inline: false }),
    tiff: f("image-64x48.tiff", { width: 64, height: 48, format: "TIFF", inline: false }),
};

/** Non-image attachments — the zca-js "others" upload path. */
export const FILES = {
    txt: f("notes.txt"),
    csv: f("data.csv"),
    pdf: f("document.pdf"),
    zip: f("archive.zip"),
};

export const ALL = [...Object.values(IMAGES), ...Object.values(FILES)];

/**
 * Expected size + SHA-256 for every fixture. Regenerate with:
 *   node tests/fixtures/checksums.js
 */
const EXPECTED = {
    "image-64x48.png": { size: 587, sha256: "b3dee443cff4063038690b55ac7f71649faf4aff3e05ab7d5190059d273e63f9" },
    "image-64x48.jpg": { size: 1999, sha256: "9f813890cfc32e30dd031bc8f3608abe9470756c67a7a99d8ef9b7c0d3155da1" },
    "image-64x48.gif": { size: 1928, sha256: "103958b994b1ae96a5d82035566c8283dc9f72de916ba3bacd501538277117a6" },
    "image-200x120.jpg": { size: 4609, sha256: "3ae9712778473d71d1123d05e15e56bb82df575e1ccef7698ad958c249c54641" },
    "image-1x1.webp": { size: 44, sha256: "bd25bde9fc4427cd6f3babcb8f888fe6174ca48881c103e243d4c6f83f30aab6" },
    "image-200x120-rot90.jpg": {
        size: 4645,
        sha256: "1555e83de3d361489f00629aae750f60f73c8052a2c0b47378d953b6c9d2fc1d",
    },
    "image-64x48.bmp": { size: 12342, sha256: "0fa58d3f6d17964741f00762929e05bcf2361012820717f09e0ec065c3f2d089" },
    "image-64x48.tiff": { size: 498, sha256: "1e44d2bf366540be2e9cd797352b489688df3df7f0b48b2ee4d0204cab847b83" },
    "notes.txt": { size: 358, sha256: "dd7cea74ff9aa9db63b6bdd31cfdc4e2743102dd9aa6f5313e95dc80be05979d" },
    "data.csv": { size: 149, sha256: "0f206fb824afaf6898beac2b88b11e5f5371542fd79f61282e361430111cac17" },
    "document.pdf": { size: 4674, sha256: "1743a5b41dfe9d3366246f62833860611bad4f61e52408cb1b154693754b8dea" },
    "archive.zip": { size: 561, sha256: "360d02cbe822ba953f938b325563f1f404f2daca3792062c02eae42da1db2042" },
};

/** Magic-byte signature each fixture must still start with. */
const SIGNATURES = {
    "image-64x48.png": [0x89, 0x50, 0x4e, 0x47],
    "image-64x48.jpg": [0xff, 0xd8, 0xff],
    "image-200x120.jpg": [0xff, 0xd8, 0xff],
    "image-64x48.gif": [0x47, 0x49, 0x46],
    "image-1x1.webp": [0x52, 0x49, 0x46, 0x46],
    "image-200x120-rot90.jpg": [0xff, 0xd8, 0xff],
    "image-64x48.bmp": [0x42, 0x4d],
    "image-64x48.tiff": [0x49, 0x49, 0x2a],
    "document.pdf": [0x25, 0x50, 0x44, 0x46],
    "archive.zip": [0x50, 0x4b, 0x03, 0x04],
};

const hex = (b) => "0x" + Number(b).toString(16).padStart(2, "0");

/** SHA-256 of a fixture, as lowercase hex. */
export function checksumOf(name) {
    return createHash("sha256")
        .update(readFileSync(join(DIR, name)))
        .digest("hex");
}

/**
 * Verify every fixture is present, the right size, has the right magic bytes,
 * and still hashes to its recorded SHA-256.
 *
 * Catches truncation, a Git LFS pointer, CRLF mangling by a checkout, and an
 * external tool silently re-saving a file (which has actually happened here —
 * see the note at the top of this file).
 *
 * @returns {string[]} problems found; empty when all fixtures are intact
 */
export function verifyFixtures() {
    const problems = [];

    for (const fx of ALL) {
        let size;
        try {
            size = statSync(fx.path).size;
        } catch {
            problems.push(`${fx.name}: missing`);
            continue;
        }
        if (size === 0) {
            problems.push(`${fx.name}: empty`);
            continue;
        }

        const sig = SIGNATURES[fx.name];
        if (sig) {
            const head = [...readFileSync(fx.path).subarray(0, sig.length)];
            if (sig.some((b, i) => head[i] !== b)) {
                problems.push(
                    `${fx.name}: bad magic bytes — expected ${sig.map(hex).join(" ")}, got ${head.map(hex).join(" ")}`,
                );
                continue;
            }
        }

        const want = EXPECTED[fx.name];
        if (!want) continue;
        if (size !== want.size) {
            problems.push(`${fx.name}: size ${size} != expected ${want.size} — the file changed on disk`);
            continue;
        }
        const got = checksumOf(fx.name);
        if (got !== want.sha256) {
            problems.push(`${fx.name}: sha256 ${got.slice(0, 16)}… != expected ${want.sha256.slice(0, 16)}…`);
        }
    }

    return problems;
}
