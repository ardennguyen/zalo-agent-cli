/**
 * src/core/zalo-client.js → readImageMetadata()
 *
 * zca-js calls this as its `imageMetadataGetter`. The width/height go
 * straight into the upload params the recipient's client uses to lay the
 * message out, so wrong numbers mean wrongly-rendered image messages and a
 * thrown error aborts the send.
 *
 * The implementation delegates format parsing to `image-size` (pure JS, zero
 * deps, ~20 formats) and adds two things on top:
 *
 *   1. **EXIF orientation.** image-size *reports* `orientation` but does not
 *      act on it. Orientations 5–8 are the 90° rotations, where stored and
 *      displayed dimensions are transposed — the everyday case being a phone
 *      photo. These tests pin the transpose.
 *
 *   2. **A descriptive throw instead of null.** A falsy return makes zca-js
 *      raise a generic "Failed to get image metadata" that names neither the
 *      file nor the reason.
 *
 * Zalo only denylists executables (`restricted_ext_file`), so users can and
 * do pass formats Zalo will not render inline — bmp, tiff, heic. Those are
 * uploaded as file attachments, but the getter must still not choke on them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readImageMetadata } from "../../src/core/zalo-client.js";
import { IMAGES, FILES, ALL, verifyFixtures } from "../fixtures/index.js";

const TMP = mkdtempSync(join(tmpdir(), "zalo-imgmeta-"));
process.on("exit", () => {
    try {
        rmSync(TMP, { recursive: true, force: true });
    } catch {
        /* temp dir */
    }
});

const write = (name, buf) => {
    const p = join(TMP, name);
    writeFileSync(p, buf);
    return p;
};

describe("fixtures are intact", () => {
    it("every fixture exists, is the right size, and matches its SHA-256", () => {
        assert.deepEqual(verifyFixtures(), []);
    });

    it("all fixtures together stay small enough to keep in git", () => {
        const total = ALL.reduce((n, fx) => n + statSync(fx.path).size, 0);
        assert.ok(total < 64 * 1024, `fixtures total ${total} bytes — keep them under 64 KB`);
    });
});

describe("readImageMetadata — dimensions from real encoder output", () => {
    for (const [key, fx] of Object.entries(IMAGES)) {
        it(`reads ${fx.format} as ${fx.width}x${fx.height} (${fx.name})`, async () => {
            const meta = await readImageMetadata(fx.path);
            assert.equal(meta.width, fx.width, `${key}: width`);
            assert.equal(meta.height, fx.height, `${key}: height`);
        });

        it(`reports ${fx.name}'s true byte size`, async () => {
            const meta = await readImageMetadata(fx.path);
            assert.equal(meta.size, statSync(fx.path).size);
        });
    }

    it("distinguishes two JPEGs of different sizes", async () => {
        const small = await readImageMetadata(IMAGES.jpg.path);
        const large = await readImageMetadata(IMAGES.jpgLarge.path);
        assert.deepEqual([small.width, small.height], [64, 48]);
        assert.deepEqual([large.width, large.height], [200, 120]);
    });

    it("returns plain positive integers — zca-js does arithmetic on these", async () => {
        const meta = await readImageMetadata(IMAGES.png.path);
        for (const k of ["width", "height", "size"]) {
            assert.equal(typeof meta[k], "number", `${k} must be a number`);
            assert.ok(Number.isInteger(meta[k]) && meta[k] > 0, `${k} must be a positive integer`);
        }
    });

    it("returns exactly the three keys zca-js consumes", async () => {
        const meta = await readImageMetadata(IMAGES.png.path);
        assert.deepEqual(Object.keys(meta).sort(), ["height", "size", "width"]);
    });
});

describe("readImageMetadata — EXIF orientation", () => {
    // getImageMetaData() feeds these straight through as the layout size, so
    // a portrait phone photo reported as landscape gives the recipient a
    // sideways placeholder. Orientations 1-4 keep the stored dimensions;
    // 5-8 transpose them.

    it("transposes a rotated JPEG to its DISPLAYED dimensions", async () => {
        const fx = IMAGES.jpgRotated; // stored 200x120, EXIF orientation 6
        const meta = await readImageMetadata(fx.path);
        assert.deepEqual(
            [meta.width, meta.height],
            [120, 200],
            "orientation 6 means rotate 90°, so a stored 200x120 displays as 120x200",
        );
    });

    it("leaves an unrotated JPEG alone", async () => {
        const meta = await readImageMetadata(IMAGES.jpgLarge.path);
        assert.deepEqual([meta.width, meta.height], [200, 120]);
    });

    it("transposes for every 90° orientation (5-8) and not for 1-4", async () => {
        // Build the same JPEG with each orientation tag so the boundary is
        // covered rather than assumed.
        const base = readFileSync(IMAGES.jpgLarge.path); // 200x120
        for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
            const p = write(`orient-${o}.jpg`, withExifOrientation(base, o));
            const meta = await readImageMetadata(p);
            const expected = o >= 5 ? [120, 200] : [200, 120];
            assert.deepEqual([meta.width, meta.height], expected, `orientation ${o}`);
        }
    });

    it("still reports the file's real byte size for a rotated image", async () => {
        const meta = await readImageMetadata(IMAGES.jpgRotated.path);
        assert.equal(meta.size, statSync(IMAGES.jpgRotated.path).size);
    });
});

describe("readImageMetadata — formats beyond Zalo's inline set", () => {
    // Zalo restricts only executables, so these reach the CLI. They upload as
    // file attachments rather than inline images, but the getter must read
    // them rather than failing.

    it("reads BMP", async () => {
        const meta = await readImageMetadata(IMAGES.bmp.path);
        assert.deepEqual([meta.width, meta.height], [64, 48]);
    });

    it("reads TIFF", async () => {
        const meta = await readImageMetadata(IMAGES.tiff.path);
        assert.deepEqual([meta.width, meta.height], [64, 48]);
    });
});

describe("readImageMetadata — failure modes", () => {
    // The contract is "throw with something actionable", NOT "return null".
    // zca-js turns a falsy return into a generic ZaloApiError naming neither
    // the file nor the cause.

    for (const [key, fx] of Object.entries(FILES)) {
        it(`throws for ${key} (${fx.name}), naming the file`, async () => {
            await assert.rejects(
                () => readImageMetadata(fx.path),
                (e) => {
                    assert.ok(e instanceof Error, "must throw an Error");
                    assert.match(e.message, new RegExp(fx.name.replace(".", "\\.")), "message should name the file");
                    return true;
                },
            );
        });
    }

    it("never resolves to null for a non-image", async () => {
        for (const fx of Object.values(FILES)) {
            let resolved;
            try {
                resolved = await readImageMetadata(fx.path);
            } catch {
                continue; // throwing is the contract
            }
            assert.fail(`${fx.name} resolved to ${JSON.stringify(resolved)} instead of throwing`);
        }
    });

    it("the error explains which formats render inline", async () => {
        await assert.rejects(() => readImageMetadata(FILES.txt.path), /jpg\/jpeg\/png\/webp\/gif/);
    });

    it("throws for an empty file", async () => {
        await assert.rejects(() => readImageMetadata(write("empty.png", Buffer.alloc(0))));
    });

    it("throws for a JPEG truncated before its SOF marker", async () => {
        const full = readFileSync(IMAGES.jpg.path);
        await assert.rejects(() => readImageMetadata(write("truncated.jpg", full.subarray(0, 20))));
    });

    it("throws ENOENT for a path that does not exist", async () => {
        await assert.rejects(() => readImageMetadata(join(TMP, "nope.png")), /ENOENT/);
    });
});

describe("readImageMetadata — detection is by content, not extension", () => {
    it("reads a PNG that has been given a .jpg name", async () => {
        const p = write("actually-a-png.jpg", readFileSync(IMAGES.png.path));
        const meta = await readImageMetadata(p);
        assert.deepEqual([meta.width, meta.height], [64, 48]);
    });

    it("throws for a text file given a .png name", async () => {
        await assert.rejects(() => readImageMetadata(write("not-an-image.png", "just text")));
    });
});

/**
 * Splice a minimal EXIF APP1 segment carrying only the Orientation tag into
 * a JPEG, right after SOI.
 *
 * IFD entry layout is tag(2) + type(2) + count(4) + value(4) — the value
 * therefore starts at offset 18, not 16. Getting that wrong silently
 * corrupts the count field and parsers quietly ignore the tag.
 */
function withExifOrientation(jpeg, orientation) {
    const tiff = Buffer.alloc(26);
    tiff.write("II", 0, "ascii"); // little-endian
    tiff.writeUInt16LE(0x002a, 2); // TIFF magic
    tiff.writeUInt32LE(8, 4); // offset of IFD0
    tiff.writeUInt16LE(1, 8); // one directory entry
    tiff.writeUInt16LE(0x0112, 10); // tag 274: Orientation
    tiff.writeUInt16LE(3, 12); // type SHORT
    tiff.writeUInt32LE(1, 14); // count
    tiff.writeUInt16LE(orientation, 18); // inline value
    tiff.writeUInt32LE(0, 22); // no next IFD

    const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
    const seg = Buffer.alloc(4 + payload.length);
    seg.writeUInt16BE(0xffe1, 0); // APP1
    seg.writeUInt16BE(payload.length + 2, 2); // length includes itself
    payload.copy(seg, 4);

    return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
}
