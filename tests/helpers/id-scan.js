/**
 * The mechanics behind tests/unit/no-real-ids.test.js: list every file this
 * checkout could commit, read each one the way an id could hide in it, and
 * report every long digit run and noised-id token with where it sits.
 *
 * Policy -- which runs are fakes and which are allowlisted -- lives in the
 * test, not here. Nothing in this file decides that a run is harmless.
 *
 * Offline and read-only: it runs `git ls-files` and reads files, nothing else.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * The shortest digit run treated as a possible account id. Zalo user and
 * thread ids are 18-19 digits; 15 leaves a margin and stays clear of the
 * 13-digit millisecond timestamps and message ids every test is full of.
 */
export const MIN_DIGITS = 15;

const DIGIT_RUN = new RegExp(String.raw`\d{${MIN_DIGITS},}`, "g");

/**
 * A noised id: the 32-character base32hex form (0-9, A-V) in which
 * transfer-sync-v2 restores sender and conversation ids. /api/gid/decrypt
 * turns one back into a uid and a display name (src/core/sync-v2/gid.js), so a
 * real one identifies a person as surely as the digits do. A token only counts
 * with both a digit and a letter from G to V: an uppercase hex string, or a
 * plain digit run, is something else.
 */
const NOISED_TOKEN = /[0-9A-V]{32,}/g;
const isNoisedShape = (token) => /\d/.test(token) && /[G-V]/.test(token);

/**
 * Binary formats that hold pixels or page data. They are skipped rather than
 * scanned: their raw bytes can spell a digit run by chance (an uncompressed
 * BMP's pixel values are bytes like any other), so scanning them would fail
 * on noise. Every OTHER binary fails the scan -- a format this cannot read is
 * never treated as a format with nothing in it.
 */
export const MEDIA_EXTENSIONS = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".pdf", ".png", ".tiff", ".webp"]);

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;

/**
 * @typedef {object} Hit
 * @property {string} where - repo path; `archive.zip!entry` for a file inside a zip
 * @property {string} at - "line N", or which name or comment the run sits in
 * @property {string} run - the matched characters themselves
 */

/**
 * @typedef {object} Scan
 * @property {number} files - files read from the checkout
 * @property {string[]} entries - every zip entry opened, as `archive.zip!entry`
 * @property {string[]} skipped - media files deliberately not read
 * @property {string[]} unreadable - files that could not be read; each one is a failure
 * @property {string[]} untracked - scanned paths git does not track yet
 * @property {Hit[]} hits - every digit run of MIN_DIGITS or more
 * @property {Hit[]} noised - every token shaped like a noised id
 */

/** @returns {Scan} */
export function emptyScan() {
    return { files: 0, entries: [], skipped: [], unreadable: [], untracked: [], hits: [], noised: [] };
}

/** Add every long digit run and noised-id token in `text` to `scan`, located by line unless `at` says where. */
function collect(scan, where, text, at) {
    const locate = (index) => at ?? `line ${text.slice(0, index).split("\n").length}`;
    for (const m of text.matchAll(DIGIT_RUN)) scan.hits.push({ where, at: locate(m.index), run: m[0] });
    for (const m of text.matchAll(NOISED_TOKEN)) {
        if (isNoisedShape(m[0])) scan.noised.push({ where, at: locate(m.index), run: m[0] });
    }
}

/**
 * True when the bytes are a zip archive -- including .docx, .xlsx and .jar,
 * which are zips under another name.
 *
 * @param {Buffer} bytes
 */
export function isZip(bytes) {
    return bytes.length >= 4 && [ZIP_LOCAL, ZIP_END].includes(bytes.readUInt32LE(0));
}

/**
 * CRC-32 (IEEE 802.3), the checksum a zip records for every entry.
 *
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 32-bit
 */
export function crc32(bytes) {
    let c = ~0;
    for (const b of bytes) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
}

/**
 * Every entry of a zip archive, decompressed, read through the central
 * directory (so sizes are right even for an entry written with a data
 * descriptor) and checked against its recorded size and CRC-32. Throws on
 * anything it cannot read -- zip64, encryption, a method other than stored or
 * deflate, a size or checksum that does not match -- so an archive this
 * cannot open fails the guard rather than passing it unread.
 *
 * @param {Buffer} zip
 * @returns {{ comment: string, entries: { name: string, comment: string, data: Buffer }[] }}
 */
export function unzip(zip) {
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
        if (zip.readUInt32LE(i) === ZIP_END) {
            end = i;
            break;
        }
    }
    if (end < 0) throw new Error("no end-of-central-directory record");
    const count = zip.readUInt16LE(end + 10);
    let at = zip.readUInt32LE(end + 16);
    if (count === 0xffff || at === 0xffffffff) throw new Error("zip64 archives are not supported");

    const entries = [];
    for (let k = 0; k < count; k++) {
        if (zip.readUInt32LE(at) !== ZIP_CENTRAL) throw new Error(`central directory entry ${k} is corrupt`);
        const flags = zip.readUInt16LE(at + 8);
        const method = zip.readUInt16LE(at + 10);
        const crc = zip.readUInt32LE(at + 16);
        const packedSize = zip.readUInt32LE(at + 20);
        const size = zip.readUInt32LE(at + 24);
        const nameEnd = at + 46 + zip.readUInt16LE(at + 28);
        const commentStart = nameEnd + zip.readUInt16LE(at + 30);
        const commentEnd = commentStart + zip.readUInt16LE(at + 32);
        const local = zip.readUInt32LE(at + 42);
        const name = zip.toString("utf8", at + 46, nameEnd);
        const comment = zip.toString("latin1", commentStart, commentEnd);
        at = commentEnd;

        if (flags & 1) throw new Error(`${name}: encrypted entries are not supported`);
        if (zip.readUInt32LE(local) !== ZIP_LOCAL) throw new Error(`${name}: local header is corrupt`);
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const packed = zip.subarray(start, start + packedSize);
        let data;
        if (method === 0) data = packed;
        else if (method === 8) data = inflateRawSync(packed);
        else throw new Error(`${name}: compression method ${method} is not supported`);
        if (data.length !== size) throw new Error(`${name}: ${data.length} bytes, but the directory says ${size}`);
        if (crc32(data) !== crc) throw new Error(`${name}: CRC-32 does not match the directory`);
        entries.push({ name, comment, data });
    }
    return { comment: zip.toString("latin1", end + 22, end + 22 + zip.readUInt16LE(end + 20)), entries };
}

/**
 * Scan one file's bytes into `scan`.
 *
 * Text is decoded as latin1, which maps each byte to one character, so digit
 * runs and line numbers come out exact whatever the real encoding is. A zip
 * is opened and every entry scanned as a file of its own -- its name and
 * comment too -- recursively. Known media is skipped. Any other binary (one
 * with a NUL byte) is recorded as unreadable.
 *
 * @param {string} where - how hits in these bytes are reported
 * @param {Buffer} bytes
 * @param {Scan} scan
 */
export function scanBytes(where, bytes, scan) {
    if (isZip(bytes)) {
        let zip;
        try {
            zip = unzip(bytes);
        } catch (err) {
            scan.unreadable.push(`${where}: ${err.message}`);
            return;
        }
        collect(scan, where, zip.comment, "archive comment");
        for (const entry of zip.entries) {
            const inner = `${where}!${entry.name}`;
            scan.entries.push(inner);
            collect(scan, inner, entry.name, "entry name");
            collect(scan, inner, entry.comment, "entry comment");
            scanBytes(inner, entry.data, scan);
        }
        return;
    }
    if (!bytes.includes(0)) {
        collect(scan, where, bytes.toString("latin1"));
        return;
    }
    if (MEDIA_EXTENSIONS.has(extname(where).toLowerCase())) {
        scan.skipped.push(where);
        return;
    }
    scan.unreadable.push(`${where}: binary, and not a format this guard can read`);
}

/**
 * Every path this checkout could commit: everything git tracks, plus the
 * untracked files git does not ignore. The second half is what lets the
 * pre-commit gate catch a NEW file before it is staged; tracked files alone
 * would leave it to CI, after the push has already published it.
 *
 * Gitignored files (tests/targets.json, agent/) are never listed. Neither are
 * untracked directories -- git reports a nested checkout as `dir/` and does
 * not descend into it -- nor untracked files under `.claude/`, which holds
 * tool state (worktrees, settings.local.json) that is not gitignored here but
 * is never committed.
 *
 * @param {string} root - the checkout's top level
 * @returns {{ path: string, tracked: boolean }[]}
 */
export function repoFiles(root) {
    const ls = (...args) =>
        execFileSync("git", ["ls-files", "-z", ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 })
            .split("\0")
            .filter(Boolean);
    const tracked = [...new Set(ls())];
    const untracked = ls("--others", "--exclude-standard").filter((p) => !p.endsWith("/") && !p.startsWith(".claude/"));
    return [
        ...tracked.map((path) => ({ path, tracked: true })),
        ...untracked.map((path) => ({ path, tracked: false })),
    ];
}

/**
 * Scan every file `repoFiles()` lists, and every path itself: a media folder
 * is named by thread id, so a path can carry an id as easily as a file can.
 *
 * @param {string} root - the checkout's top level
 * @returns {Scan}
 */
export function scanRepo(root) {
    const scan = emptyScan();
    for (const { path, tracked } of repoFiles(root)) {
        let stat;
        try {
            stat = lstatSync(join(root, path));
        } catch {
            continue; // deleted in the working tree: nothing left to commit
        }
        if (!stat.isFile()) continue; // a symlink or a submodule
        scan.files++;
        if (!tracked) scan.untracked.push(path);
        collect(scan, path, path, "file path");
        scanBytes(path, readFileSync(join(root, path)), scan);
    }
    return scan;
}
