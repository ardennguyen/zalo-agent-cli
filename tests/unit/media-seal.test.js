/**
 * The media container (src/core/keystore/media-seal.js) and an account's media at rest (src/core/media-store.js):
 * round trips at the chunk edges, random access for HTTP Range reads, every tamper that must fail, the two-slot rekey
 * and its crash, the in-place seal of a 2.x plaintext file and its crashes, the account-level migration, status and
 * rekey, and the decrypted copies of src/core/media-deliver.js.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR, configureStoragePaths, getAccountDbPath, getAccountDir } from "../../src/core/credentials.js";
import { closeDb, initDb, insertMessage, setMessageLocalPath } from "../../src/core/db.js";
import { getDataKey, onRekey, rekeyAccount } from "../../src/core/keystore/index.js";
import { beginRekey, finishRekey, scopeOfDir } from "../../src/core/keystore/keyring.js";
import {
    MEDIA_CHUNK,
    decryptMediaToFile,
    isSealedMedia,
    mediaFileState,
    mediaPlainSize,
    openMedia,
    readMediaFile,
    readMediaHeader,
    rewrapMediaFile,
    sealMedia,
    sealMediaFileInPlace,
    writeSealedMedia,
} from "../../src/core/keystore/media-seal.js";
import { mediaStatus, migrateMedia, rekeyMedia } from "../../src/core/media-store.js";
import { decryptToTempfile, mediaTempRoot, removeMediaTemp, sweepMediaTemp } from "../../src/core/media-deliver.js";
import { fullSecurityStatus, migrateStores } from "../../src/core/keystore/stores.js";

let n = 0;
const freshId = () => String(1000000000000000980n + BigInt(n++));
const scopeFor = (id) => scopeOfDir(getAccountDir(id));
const TAG = 16;

/** Deterministic bytes, so a misplaced chunk shows as wrong content, not only as a length. */
function bytes(len, seed = 1) {
    const out = Buffer.alloc(len);
    let x = seed;
    for (let i = 0; i < len; i++) {
        x = (x * 1103515245 + 12345) >>> 0;
        out[i] = x >>> 24;
    }
    return out;
}

/** A sealed file for a fresh account, on disk; returns what a test needs. */
function sealedFile(len, { msgId = "m1", id = freshId() } = {}) {
    const plain = bytes(len, len + 7);
    const file = join(getAccountDir(id), "media", "t1", `f${len}.bin`);
    writeSealedMedia(file, scopeFor(id), { msgId }, plain);
    return { id, file, plain, scope: scopeFor(id) };
}

before(() => assertSandboxed(CONFIG_DIR));

describe("round trip", () => {
    for (const len of [0, 1, 100, MEDIA_CHUNK - 1, MEDIA_CHUNK, MEDIA_CHUNK + 1, 3 * MEDIA_CHUNK, 5 * 1024 * 1024]) {
        it(`${len} bytes: sealed on disk, opens to the same bytes, size in the header`, () => {
            const { file, plain, scope } = sealedFile(len);
            const raw = readFileSync(file);
            assert.ok(isSealedMedia(raw));
            assert.equal(mediaFileState(file), "sealed");
            if (len >= 32) assert.equal(raw.includes(plain.subarray(0, 32)), false, "plaintext on disk");
            // Overhead: the header plus one tag per chunk (0.024%), never a whole re-encoding.
            const chunks = Math.max(1, Math.ceil(len / MEDIA_CHUNK));
            assert.equal(raw.length, readMediaHeader(file).dataOffset + len + chunks * TAG);
            assert.deepEqual(readMediaFile(file, scope, { msgId: "m1" }), plain);
            assert.equal(mediaPlainSize(file), len);
        });
    }

    it("two seals of the same bytes differ (a random key per file)", () => {
        const id = freshId();
        const p = bytes(1000);
        assert.notDeepEqual(sealMedia(scopeFor(id), {}, p), sealMedia(scopeFor(id), {}, p));
    });
});

describe("random access (HTTP Range)", () => {
    const len = 3 * MEDIA_CHUNK + 1234;
    let f;
    before(() => {
        f = sealedFile(len);
    });
    const C = MEDIA_CHUNK;
    const edges = [
        [0, 0],
        [0, C - 1],
        [C - 1, C],
        [C, C],
        [C - 5, 2 * C + 5],
        [2 * C, 3 * C - 1],
        [3 * C, len - 1],
        [len - 1, len - 1],
        [100, 99 + 3 * C],
        [0, len - 1],
    ];
    for (const [a, b] of edges) {
        it(`bytes ${a}-${b}`, () => {
            const m = openMedia(f.file, f.scope);
            try {
                assert.deepEqual(m.read(a, b), f.plain.subarray(a, b + 1));
            } finally {
                m.close();
            }
        });
    }

    it("an end past the file is clamped; a start past it is empty", () => {
        const m = openMedia(f.file, f.scope);
        try {
            assert.deepEqual(m.read(len - 3, len + 1000), f.plain.subarray(len - 3));
            assert.equal(m.read(len, len + 5).length, 0);
        } finally {
            m.close();
        }
    });

    it("streams a range chunk by chunk, and the stream closes the file", async () => {
        const m = openMedia(f.file, f.scope);
        const parts = [];
        for await (const p of m.stream({ start: C - 10, end: 2 * C + 10 })) parts.push(p);
        assert.deepEqual(Buffer.concat(parts), f.plain.subarray(C - 10, 2 * C + 11));
        assert.ok(parts.length >= 2, "more than one piece: not decrypted as a whole");
    });

    it("decryptMediaToFile writes the plaintext (0600 on POSIX)", () => {
        const out = join(dirname(f.file), "out.bin");
        assert.equal(decryptMediaToFile(f.file, out, f.scope), len);
        assert.deepEqual(readFileSync(out), f.plain);
        if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);
    });
});

describe("tampering fails", () => {
    const len = 2 * MEDIA_CHUNK + 10;
    const tampered = (mutate) => {
        const f = sealedFile(len);
        const raw = readFileSync(f.file);
        writeFileSync(f.file, mutate(raw, readMediaHeader(f.file).dataOffset));
        return f;
    };

    it("a flipped bit in a chunk", () => {
        const f = tampered((raw, off) => {
            raw[off + MEDIA_CHUNK + TAG + 3] ^= 1;
            return raw;
        });
        const m = openMedia(f.file, f.scope);
        assert.deepEqual(m.read(0, 9), f.plain.subarray(0, 10), "the untouched chunk still reads");
        assert.throws(() => m.read(MEDIA_CHUNK + 2, MEDIA_CHUNK + 4), { code: "AUTH_FAILED" });
        m.close();
    });

    it("two chunks swapped", () => {
        const f = tampered((raw, off) => {
            const S = MEDIA_CHUNK + TAG;
            const a = Buffer.from(raw.subarray(off, off + S));
            raw.copy(raw, off, off + S, off + 2 * S);
            a.copy(raw, off + S);
            return raw;
        });
        assert.throws(() => readMediaFile(f.file, f.scope), { code: "AUTH_FAILED" });
    });

    it("cut at a chunk boundary (the last chunk dropped)", () => {
        const f = tampered((raw) => raw.subarray(0, raw.length - (10 + TAG)));
        assert.throws(() => openMedia(f.file, f.scope), { code: "TRUNCATED" });
    });

    it("cut inside a chunk, or appended to", () => {
        const f1 = tampered((raw) => raw.subarray(0, raw.length - 3));
        assert.throws(() => openMedia(f1.file, f1.scope), { code: "TRUNCATED" });
        const f2 = tampered((raw) => Buffer.concat([raw, Buffer.alloc(TAG + 1)]));
        assert.throws(() => openMedia(f2.file, f2.scope), { code: "TRUNCATED" });
    });

    it("an edited header (the size)", () => {
        const f = sealedFile(100);
        const raw = readFileSync(f.file).toString("latin1").replace('"size":100', '"size":101');
        writeFileSync(f.file, Buffer.from(raw, "latin1"));
        assert.throws(() => readMediaFile(f.file, f.scope));
    });

    it("a file put in place of another message's, or read for another account", () => {
        const f = sealedFile(500, { msgId: "m1" });
        assert.throws(() => readMediaFile(f.file, f.scope, { msgId: "m2" }), { code: "MISMATCH" });
        assert.throws(() => readMediaFile(f.file, scopeFor(freshId())), { code: "MISMATCH" });
    });

    it("a key slot copied from another file does not open this one", () => {
        const a = sealedFile(500);
        const b = sealedFile(501, { id: a.id });
        const ha = readMediaHeader(a.file);
        const rawA = readFileSync(a.file);
        const rawB = readFileSync(b.file);
        const slotsA = ha.dataOffset - 2 * 76;
        const slotsB = readMediaHeader(b.file).dataOffset - 2 * 76;
        rawB.copy(rawA, slotsA, slotsB, slotsB + 76);
        writeFileSync(a.file, rawA);
        assert.throws(() => readMediaFile(a.file, a.scope), { code: "AUTH_FAILED" });
    });
});

describe("rekey: two key slots, only the header rewritten", () => {
    it("re-wraps under the new key in the other slot; the chunks are untouched; idempotent", () => {
        const f = sealedFile(3 * MEDIA_CHUNK);
        const before = readFileSync(f.file);
        const { dataOffset } = readMediaHeader(f.file);
        assert.equal(rewrapMediaFile(f.file, f.scope), "current");
        rekeyAccount(f.id);
        const after = readFileSync(f.file);
        const newKid = getDataKey(f.id, "media").keyId;
        const kids = readMediaHeader(f.file).kids;
        assert.ok(kids.includes(newKid), "the new key has a slot");
        assert.deepEqual(after.subarray(dataOffset), before.subarray(dataOffset), "no chunk was re-encrypted");
        const changed = [...after].reduce((c, b, i) => c + (b !== before[i] ? 1 : 0), 0);
        assert.ok(changed <= 76, `${changed} bytes changed: only one slot`);
        assert.deepEqual(readMediaFile(f.file, f.scope), f.plain);
        assert.equal(rewrapMediaFile(f.file, f.scope), "current");
    });

    it("a crash after the slot write, or a torn slot write, leaves the file readable; a rerun finishes", () => {
        const f = sealedFile(MEDIA_CHUNK + 5);
        const oldKid = getDataKey(f.id, "media").keyId;
        beginRekey(f.scope); // new keys; the old one retired, as rekeyAccount does before its handlers
        const crash = () => {
            throw new Error("crash");
        };
        assert.throws(() => rewrapMediaFile(f.file, f.scope, { afterWrite: crash }), /crash/);
        assert.deepEqual(readMediaFile(f.file, f.scope), f.plain, "both slots open it");
        assert.ok(readMediaHeader(f.file).kids.includes(oldKid));
        // A torn write of the new slot (garbage where it goes): the old slot still opens it.
        const raw = readFileSync(f.file);
        const { dataOffset, kids } = readMediaHeader(f.file);
        const newSlot = kids.indexOf(oldKid) === 0 ? 1 : 0;
        randomBytes(76).copy(raw, dataOffset - 2 * 76 + newSlot * 76);
        writeFileSync(f.file, raw);
        assert.deepEqual(readMediaFile(f.file, f.scope), f.plain);
        assert.equal(rewrapMediaFile(f.file, f.scope), "rewrapped", "the rerun writes the slot again");
        finishRekey(f.scope); // the old key dropped
        assert.deepEqual(readMediaFile(f.file, f.scope), f.plain);
        assert.equal(rewrapMediaFile(f.file, f.scope), "current");
    });

    it("rekeyMedia over an account: rewrapped, current, unreadable counted; the old key no longer needed", () => {
        const id = freshId();
        const a = sealedFile(10, { id });
        const b = sealedFile(70_000, { id });
        const damaged = join(getAccountDir(id), "media", "t1", "damaged.bin");
        writeFileSync(damaged, Buffer.concat([Buffer.from("ZACMEDIA"), Buffer.alloc(40)]));
        rekeyAccount(id);
        assert.deepEqual(rekeyMedia(id), { rewrapped: 0, current: 2, unreadable: 1 });
        const st = mediaStatus(id);
        assert.deepEqual([st.sealed, st.staleKey, st.plaintext, st.unreadable], [2, 0, 0, 1]);
        assert.deepEqual(readMediaFile(a.file, a.scope), a.plain);
        assert.deepEqual(readMediaFile(b.file, b.scope), b.plain);
    });

    it("a rekey stopped by a later handler keeps the media readable, and a rerun finishes it", () => {
        const f = sealedFile(5000);
        const off = onRekey(() => {
            throw new Error("a later store failed");
        });
        try {
            assert.throws(() => rekeyAccount(f.id), /a later store failed/);
        } finally {
            off();
        }
        assert.deepEqual(readMediaFile(f.file, f.scope), f.plain);
        assert.equal(mediaStatus(f.id).staleKey, 0, "the media handler ran first: already under the new key");
        rekeyAccount(f.id);
        assert.deepEqual(readMediaFile(f.file, f.scope), f.plain);
        assert.equal(mediaStatus(f.id).staleKey, 0);
    });
});

describe("plaintext media from 2.x", () => {
    function plainFile(id, name = "old.jpg", len = 70_000) {
        const file = join(getAccountDir(id), "media", "t2", name);
        mkdirSync(dirname(file), { recursive: true });
        const plain = bytes(len, 99);
        writeFileSync(file, plain);
        return { file, plain };
    }

    it("is read, and sealed in place on the way", () => {
        const id = freshId();
        const { file, plain } = plainFile(id);
        assert.equal(mediaFileState(file), "plaintext");
        assert.deepEqual(readMediaFile(file, scopeFor(id), { msgId: "x1" }), plain);
        assert.equal(mediaFileState(file), "sealed");
        assert.equal(readMediaHeader(file).meta.msgId, "x1");
        assert.equal(readMediaHeader(file).meta.ext, "jpg");
        assert.deepEqual(readMediaFile(file, scopeFor(id), { msgId: "x1" }), plain);
        assert.deepEqual(
            readdirSync(dirname(file)).filter((n) => n !== "old.jpg"),
            [],
            "no leftover beside it",
        );
    });

    for (const point of ["afterWrite", "afterMoveAside", "afterSwap"]) {
        it(`a crash ${point} leaves one readable copy, and the next read finishes it`, () => {
            const id = freshId();
            const { file, plain } = plainFile(id, `c-${point}.mp4`);
            assert.throws(
                () =>
                    sealMediaFileInPlace(
                        file,
                        scopeFor(id),
                        {},
                        {
                            [point]: () => {
                                throw new Error("crash");
                            },
                        },
                    ),
                /crash/,
            );
            assert.deepEqual(readMediaFile(file, scopeFor(id)), plain);
            assert.equal(mediaFileState(file), "sealed");
            assert.deepEqual(
                readdirSync(dirname(file)).filter((n) => n.startsWith(`c-${point}.mp4.`)),
                [],
                "leftovers recovered",
            );
        });
    }

    it("account migration: own root sealed in batches (resumable), msgIds from the rows, status counts", () => {
        const id = freshId();
        initDb(getAccountDbPath(id));
        const files = [];
        for (let i = 0; i < 5; i++) {
            const { file, plain } = plainFile(id, `p${i}.jpg`, 1000 + i);
            insertMessage({ msgId: `mm${i}`, threadId: "t2", senderId: "1", text: "", timestamp: i, type: "photo" });
            setMessageLocalPath(`mm${i}`, file);
            files.push({ file, plain });
        }
        closeDb();
        const before = mediaStatus(id);
        assert.deepEqual([before.state, before.plaintext, before.sealed], ["plaintext", 5, 0]);
        const first = migrateMedia(id, { limit: 2 });
        assert.deepEqual([first.sealed, first.more], [2, true]);
        assert.equal(mediaStatus(id).plaintext, 3);
        const rest = migrateStores(id).find((r) => r.kind === "media");
        assert.deepEqual([rest.result, rest.sealed], ["encrypted", 3]);
        const after = fullSecurityStatus(id).files.find((f) => f.kind === "media");
        assert.deepEqual([after.state, after.plaintext, after.sealed], ["sealed", 0, 5]);
        for (const [i, f] of files.entries()) {
            assert.equal(readMediaHeader(f.file).meta.msgId, `mm${i}`);
            assert.deepEqual(readMediaFile(f.file, scopeFor(id), { msgId: `mm${i}` }), f.plain);
        }
        assert.equal(migrateMedia(id).sealed, 0, "idempotent");
    });

    it("a shared override root: only this account's referenced plaintext is sealed", () => {
        const id = freshId();
        const root = mkdtempSync(join(SANDBOX_HOME, "shared-media-"));
        const mine = join(root, "t3", "mine.jpg");
        const theirs = join(root, "t3", "theirs.jpg");
        mkdirSync(dirname(mine), { recursive: true });
        writeFileSync(mine, bytes(300));
        writeFileSync(theirs, bytes(300, 5));
        initDb(getAccountDbPath(id));
        insertMessage({ msgId: "s1", threadId: "t3", senderId: "1", text: "", timestamp: 1, type: "photo" });
        setMessageLocalPath("s1", mine);
        closeDb();
        configureStoragePaths({ loadEnv: false, mediaDir: root });
        try {
            assert.equal(mediaStatus(id).plaintext, 1, "only the referenced file counts as this account's");
            migrateMedia(id);
        } finally {
            configureStoragePaths({ loadEnv: false, mediaDir: null });
        }
        assert.equal(mediaFileState(mine), "sealed");
        assert.equal(mediaFileState(theirs), "plaintext", "another account's file is never sealed under this key");
    });
});

describe("decrypted copies (media-deliver tempfiles)", () => {
    it("go to a private folder under the config dir, and are removed on request or by the sweep", () => {
        const f = sealedFile(2000);
        const copy = decryptToTempfile(f.file, f.scope, { msgId: "m1" });
        assert.ok(copy.path.startsWith(mediaTempRoot()));
        assert.deepEqual(readFileSync(copy.path), f.plain);
        assert.ok(copy.expiresAt > Date.now());
        if (process.platform !== "win32") assert.equal(statSync(copy.dir).mode & 0o777, 0o700);
        removeMediaTemp(copy);
        assert.equal(existsSync(copy.dir), false);

        const old = decryptToTempfile(f.file, f.scope, { ttlMs: 0 });
        assert.equal(sweepMediaTemp(60_000, Date.now() + 120_000) >= 1, true);
        assert.equal(existsSync(old.dir), false);
    });

    it("refuse a file swapped in from another message", () => {
        const f = sealedFile(10, { msgId: "m1" });
        assert.throws(() => decryptToTempfile(f.file, f.scope, { msgId: "m9" }), { code: "MISMATCH" });
        assert.equal(
            readdirSync(mediaTempRoot()).some((d) => readdirSync(join(mediaTempRoot(), d)).length > 0),
            false,
            "nothing left behind",
        );
    });
});

describe("no plaintext at rest", () => {
    it("a planted marker is in no file of the account after a seal, a migration and a rekey", () => {
        const id = freshId();
        const marker = Buffer.from(`MARKER-${createHash("sha1").update(randomBytes(8)).digest("hex")}`);
        const plain = Buffer.concat([bytes(1000), marker, bytes(70_000)]);
        writeSealedMedia(join(getAccountDir(id), "media", "t", "a.bin"), scopeFor(id), {}, plain);
        const legacy = join(getAccountDir(id), "media", "t", "b.bin");
        writeFileSync(legacy, plain);
        migrateMedia(id);
        rekeyAccount(id);
        const walk = (d) =>
            readdirSync(d, { withFileTypes: true }).flatMap((e) =>
                e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
            );
        const hits = walk(getAccountDir(id)).filter((p) => readFileSync(p).includes(marker));
        assert.deepEqual(hits, []);
    });
});
