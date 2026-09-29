/**
 * No real Zalo account id may be committed to this repository.
 *
 * AGENTS.md §0 #6 always said so, and nine files broke it anyway (fixed in
 * b0f267c): real ids sat in src/ comments that ship to npm, in tests, in a
 * CSV fixture, and inside tests/fixtures/archive.zip, where no text search
 * could see them. One test called a real id "Fictional ids of the real
 * length". A rule that nothing checks fails silently. This file is the check,
 * and it runs in `npm test`.
 *
 * WHAT IS READ. Every file git tracks, plus every untracked file git does not
 * ignore, so the pre-commit gate catches a new file before it is staged
 * instead of CI catching it after the push has published it. Text is read
 * as-is. A zip is opened and every entry read after decompression, names and
 * comments included. Images and PDFs are skipped. Any other binary FAILS the
 * suite, because "cannot read it" is not "nothing in it". Paths are read too:
 * media folders are named by thread id. Gitignored files (tests/targets.json,
 * agent/) are never opened. The mechanics are in tests/helpers/id-scan.js.
 *
 * WHAT IS A HIT. Any run of 15 or more digits, wherever it sits: in a string,
 * after a `g`/`u` kind prefix, inside a longer token.
 *
 * THE FAKE-ID CONVENTION. A hit is a fake when, after dropping at most three
 * digits from each end, what is left is
 *
 *   (a) one digit, repeated:   1000000000000000001    200000000000000031
 *                              9100000000000000001    1111111111111111200
 *
 *   (b) a counting run, each digit one more than the last, 9 wrapping to 0:
 *                              1234567890123456789    4123456789012345678
 *                              4123456789012345679    (a twin, one apart)
 *
 * The digits in a fake noised id count too: VNOISED0000000000000000000000021
 * is (a). A real 19-digit id fits either shape by chance at most 3 times in a
 * trillion. Pick a fake that keeps what its test depends on -- the length,
 * being past Number.MAX_SAFE_INTEGER, a twin that rounds to the same double,
 * a fixture's byte size -- as b0f267c did.
 *
 * NOISED IDS. transfer-sync-v2 restores sender and conversation ids in a
 * noised form: 32 characters of base32hex (0-9, A-V). /api/gid/decrypt turns
 * one back into a uid and a display name, so a real noised id is a real
 * identity with no digit run to catch it. Any such token (one with a digit
 * and a letter from G to V) is a hit, and a fake must spell NOISED:
 * VNOISED0000000000000000000000021.
 *
 * THE ALLOWLIST (ALLOWED, below) is for runs that are not ids at all: numeric
 * boundaries, and values derived from a fake. Every entry carries its reason,
 * and an entry nothing uses any more fails the suite. A real id never goes
 * there. It gets replaced.
 *
 * A failure names the file, the line and the length, never the id itself:
 * the CI log of a public repository is public too.
 */

import "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { MIN_DIGITS, crc32, emptyScan, scanBytes, scanRepo, unzip } from "../helpers/id-scan.js";

const ROOT = join(import.meta.dirname, "..", "..");

// ── The convention ─────────────────────────────────────────────────────

/** Digits a fake may carry outside its pattern, at each end. */
const FREE_DIGITS = 3;

/**
 * True when a digit run is a fake by the convention at the top of this file.
 *
 * @param {string} run - MIN_DIGITS or more digits
 */
function isFakeId(run) {
    for (let head = 0; head <= FREE_DIGITS; head++) {
        for (let tail = 0; tail <= FREE_DIGITS; tail++) {
            const core = [...run.slice(head, run.length - tail)].map(Number);
            if (core.length < MIN_DIGITS - 2 * FREE_DIGITS) continue;
            if (core.every((d) => d === core[0])) return true;
            if (core.every((d, i) => i === 0 || d === (core[i - 1] + 1) % 10)) return true;
        }
    }
    return false;
}

/**
 * True when a noised-id token is a fake by the convention at the top of this file.
 *
 * @param {string} token - 32 or more base32hex characters
 */
const isFakeNoised = (token) => token.includes("NOISED");

/**
 * Long digit runs that are not ids at all, each with its reason. Computed
 * where the value has a definition, so the reason can be checked by reading.
 */
const ALLOWED = new Map([
    [String(2n ** 63n), "2^63, Zalo Web's MAX_MSG_ID: NEWEST_MSG_ID in src/core/group-history.js, and its tests"],
    [
        String(Number.MAX_SAFE_INTEGER),
        "Number.MAX_SAFE_INTEGER: MAX_TS in src/core/sync-v2/index.js, a window's open end",
    ],
    [
        String(Number("4123456789012345678")),
        "the fake 4123456789012345678 as JS prints it after float64 rounding -- the loss conv-state documents",
    ],
]);

// ── The repository ─────────────────────────────────────────────────────

/** A path or message with every long digit run replaced by its length. */
const mask = (text) => text.replace(new RegExp(String.raw`\d{${MIN_DIGITS},}`, "g"), (run) => `<${run.length} digits>`);

describe("no real account id is committed to this repository", () => {
    let scan;
    before(() => {
        scan = scanRepo(ROOT);
    });

    /** Where a hit is, without its digits -- even when the digits are in the path. */
    const locate = (hit) => {
        const untracked = scan.untracked.includes(hit.where.split("!")[0]) ? " (untracked)" : "";
        return `${mask(hit.where)}${untracked}, ${hit.at}`;
    };

    it("reads the whole checkout, zip entries included", () => {
        // A guard that reads nothing passes everything. The fake group id in
        // the fixture CSV sits inside a deflated entry, so seeing it proves the
        // entry was really decompressed and scanned.
        assert.ok(scan.files >= 100, `only ${scan.files} files were scanned -- is this a git checkout?`);
        assert.ok(scan.entries.includes("tests/fixtures/archive.zip!data.csv"), "archive.zip was never opened");
        assert.ok(
            scan.hits.some((h) => h.where === "tests/fixtures/archive.zip!data.csv" && isFakeId(h.run)),
            "the fake id inside archive.zip!data.csv was not seen",
        );
        assert.ok(
            scan.noised.some((h) => isFakeNoised(h.run)),
            "not even the suite's own fake noised ids were seen",
        );
        assert.deepEqual(
            scan.unreadable.map(mask),
            [],
            "every file must be readable: teach tests/helpers/id-scan.js the format, or list it in MEDIA_EXTENSIONS",
        );
    });

    it("every long digit run is a fake by convention or allowlisted", () => {
        const bad = scan.hits.filter((h) => !isFakeId(h.run) && !ALLOWED.has(h.run));
        assert.ok(
            bad.length === 0,
            `${bad.length} run(s) of ${MIN_DIGITS}+ digits are not fakes by the convention in ` +
                "tests/unit/no-real-ids.test.js:\n" +
                bad.map((h) => `  ${locate(h)}: a ${h.run.length}-digit value`).join("\n") +
                "\nReplace each with a fake that keeps what its test depends on (length, being past " +
                "Number.MAX_SAFE_INTEGER, a twin one apart, a fixture's byte size). Only a value that is " +
                "not an id at all belongs in ALLOWED, with its reason.",
        );
    });

    it("every noised id spells NOISED", () => {
        const bad = scan.noised.filter((h) => !isFakeNoised(h.run));
        assert.ok(
            bad.length === 0,
            `${bad.length} token(s) shaped like a noised id do not spell NOISED:\n` +
                bad.map((h) => `  ${locate(h)}: a ${h.run.length}-character noised id`).join("\n") +
                "\n/api/gid/decrypt turns a real one back into a uid and a name. Replace it with a fake of the " +
                "same length, e.g. VNOISED followed by digits, as tests/unit/msg-pin.test.js does.",
        );
    });

    it("every ALLOWED entry is still in use", () => {
        const seen = new Set(scan.hits.map((h) => h.run));
        const stale = [...ALLOWED.keys()].filter((run) => !seen.has(run));
        assert.deepEqual(stale, [], "these ALLOWED entries match nothing any more -- delete them");
    });
});

// ── The convention, pinned ─────────────────────────────────────────────

/** A deterministic pseudo-random 19-digit id: what a real one looks like. */
const pseudoId = (i) => {
    const n = BigInt(`0x${createHash("sha256").update(`pseudo id ${i}`).digest("hex").slice(0, 16)}`);
    return String((n % (9n * 10n ** 18n)) + 10n ** 18n);
};

/** Base32hex, in two halves: written out whole it is a noised-id-shaped token itself. */
const BASE32HEX = "0123456789" + "ABCDEFGHIJKLMNOPQRSTUV";

/** A deterministic pseudo-random noised id: what a real one looks like. */
const pseudoNoised = (i) =>
    [...createHash("sha256").update(`pseudo noised ${i}`).digest()].map((b) => BASE32HEX[b % 32]).join("");

describe("the fake-id convention", () => {
    it("accepts every shape of fake the suite uses", () => {
        const fakes = [
            "1000000000000000001",
            "200000000000000031",
            "9100000000000000001",
            "9200000000000000100",
            "0000000000000000000000021",
            "1111111111111111200",
            "9999999999999999999",
            "1234567890123456789",
            "4123456789012345678",
            "4123456789012345679",
        ];
        for (const fake of fakes) assert.ok(isFakeId(fake), `${fake} should be a fake by convention`);
    });

    it("rejects a fourth free digit at an end, and any wrong digit in the middle", () => {
        // Built, not written out: a literal of any of these would fail this very file.
        const nearMisses = {
            "four free digits at the tail": `1${"0".repeat(14)}1234`,
            "four free digits at the head": `1234${"0".repeat(14)}1`,
            "one wrong digit mid-count": `${"1234567890".repeat(2).slice(0, 9)}5${"1234567890".repeat(2).slice(10, 19)}`,
            "one wrong digit mid-zeros": `1${"0".repeat(8)}7${"0".repeat(8)}1`,
        };
        for (const [why, run] of Object.entries(nearMisses)) {
            assert.equal(run.length, 19, `${why}: precondition, 19 digits`);
            assert.equal(isFakeId(run), false, `${why}: should not pass as a fake`);
        }
    });

    it("lets no random 19-digit id through in 10,000 tries", () => {
        for (let i = 0; i < 10_000; i++) {
            const id = pseudoId(i);
            assert.equal(id.length, 19);
            assert.equal(isFakeId(id), false, `pseudo-random id #${i} passed as a fake`);
        }
    });

    it("takes a noised id for a fake only when it spells NOISED", () => {
        assert.ok(isFakeNoised("VNOISED0000000000000000000000021"));
        for (let i = 0; i < 1000; i++) {
            assert.equal(isFakeNoised(pseudoNoised(i)), false, `pseudo-random noised id #${i} passed as a fake`);
        }
    });
});

// ── The guard has to be able to fail ───────────────────────────────────

/** A one-entry deflated zip archive, built in memory. */
function zipOf(name, text) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const file = Buffer.from(name);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract: 2.0
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(file.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed to extract
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(file.length, 28);
    // The local header offset (42) stays 0: the entry opens the archive.

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + file.length, 12);
    end.writeUInt32LE(local.length + file.length + packed.length, 16);

    return Buffer.concat([local, file, packed, central, file, end]);
}

describe("the guard fails on what it exists to catch", () => {
    // Built at runtime, so no literal of it sits in this file.
    const PLANTED = pseudoId(0);

    it("finds an id in text, even glued to a kind prefix", () => {
        const scan = emptyScan();
        scanBytes("planted.test.js", Buffer.from(`const a = 1;\nconst pinned = "g${PLANTED}";\n`), scan);
        assert.deepEqual(scan.hits, [{ where: "planted.test.js", at: "line 2", run: PLANTED }]);
        assert.equal(isFakeId(PLANTED), false, "and the convention does not excuse it");
    });

    it("finds an id inside a deflated zip entry, which a raw search cannot see", () => {
        const zip = zipOf("data.csv", `thread_id,kind\n${PLANTED},dm\n`);
        assert.ok(!zip.toString("latin1").includes(PLANTED), "precondition: deflate hides the id from a raw search");
        const scan = emptyScan();
        scanBytes("planted.zip", zip, scan);
        assert.deepEqual(scan.entries, ["planted.zip!data.csv"]);
        assert.deepEqual(scan.hits, [{ where: "planted.zip!data.csv", at: "line 2", run: PLANTED }]);
    });

    it("finds an id in a name: media folders are named by thread id", () => {
        const scan = emptyScan();
        scanBytes("planted.zip", zipOf(`media/${PLANTED}/photo.txt`, "nothing in here"), scan);
        assert.deepEqual(scan.hits, [
            { where: `planted.zip!media/${PLANTED}/photo.txt`, at: "entry name", run: PLANTED },
        ]);
    });

    it("finds a noised id, which has no digit run to catch, and does not take a hex string for one", () => {
        const noised = pseudoNoised(0);
        const hex = createHash("sha256").update("not an id").digest("hex").toUpperCase();
        const scan = emptyScan();
        scanBytes("planted.test.js", Buffer.from(`const sender = "${noised}";\nconst sha = "${hex}";\n`), scan);
        assert.deepEqual(scan.noised, [{ where: "planted.test.js", at: "line 1", run: noised }]);
        assert.equal(isFakeNoised(noised), false, "and the convention does not excuse it");
    });

    it("fails on a binary it cannot read, rather than skipping it", () => {
        const scan = emptyScan();
        scanBytes("zalo.db", Buffer.from("SQLite format 3\0"), scan);
        assert.equal(scan.unreadable.length, 1);
    });

    it("fails on a zip it cannot open, rather than skipping it", () => {
        const scan = emptyScan();
        scanBytes("truncated.zip", zipOf("data.csv", PLANTED).subarray(0, 40), scan);
        assert.equal(scan.unreadable.length, 1);
        assert.deepEqual(scan.hits, []);
    });

    it("reads the real archive.zip fixture, each entry checked against its CRC-32", () => {
        // zipOf() shares crc32() with the reader, so it cannot prove crc32()
        // right on its own. An archive written by a real archiver can.
        const { entries } = unzip(readFileSync(join(ROOT, "tests", "fixtures", "archive.zip")));
        assert.deepEqual(entries.map((e) => e.name).sort(), ["data.csv", "notes.txt"]);
    });
});
