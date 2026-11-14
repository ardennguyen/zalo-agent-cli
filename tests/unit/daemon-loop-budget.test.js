/**
 * Work a daemon runs on the thread that serves its socket must hand the event loop back.
 *
 * Live 2026-11-08, the first 3.0 run of a 2.x account: `listen` logged "event loop was blocked for 3.1s" and "4.6s"
 * while the background job sealed the account's 457 downloaded files, 50 at a time. Each batch walked the whole
 * messages table for the rows that point at files (1.8 s on the encrypted 436,000-row database) and then sealed 50
 * files in one synchronous run (3.3 s measured). These tests hold the two fixes: the rows come from an index, and the
 * daemon's sealing yields per file and per chunk.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR, getAccountDbPath, getAccountDir } from "../../src/core/credentials.js";
import { closeDb, initDb, insertMessage, setMessageLocalPath } from "../../src/core/db.js";
import { MEDIA_CHUNK, mediaFileState, readMediaFile } from "../../src/core/keystore/media-seal.js";
import { scopeOfDir } from "../../src/core/keystore/keyring.js";
import { REFERENCED_MEDIA_SQL, migrateMedia, migrateMediaSliced } from "../../src/core/media-store.js";

let n = 0;
const freshId = () => String(1000000000000000700n + BigInt(n++));

/** Plaintext (2.x) files in the account's own media root, each `chunks` sealing chunks long. */
function plainFiles(id, count, chunks) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const file = join(getAccountDir(id), "media", "t9", `old${i}.mp4`);
        mkdirSync(dirname(file), { recursive: true });
        const plain = Buffer.alloc(chunks * MEDIA_CHUNK, i + 1);
        writeFileSync(file, plain);
        out.push({ file, plain });
    }
    return out;
}

before(() => assertSandboxed(CONFIG_DIR));

describe("the rows that point at files come from an index", () => {
    it("referencedMedia's query and the retention purge's are index searches, not walks of messages", () => {
        const id = freshId();
        const db = initDb(getAccountDbPath(id));
        try {
            const plan = (sql, ...p) =>
                db
                    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
                    .all(...p)
                    .map((r) => r.detail)
                    .join(" | ");
            for (const [what, detail] of [
                ["referencedMedia", plan(REFERENCED_MEDIA_SQL)],
                [
                    "getDownloadedMediaBefore",
                    plan(
                        "SELECT msgId, threadId, timestamp, localPath FROM messages WHERE localPath IS NOT NULL AND " +
                            "timestamp < ? ORDER BY timestamp ASC",
                        1,
                    ),
                ],
            ]) {
                assert.match(detail, /USING INDEX idx_messages_localpath/, `${what}: ${detail}`);
            }
        } finally {
            closeDb();
        }
    });
});

describe("the daemon's background sealing hands the event loop back", () => {
    it("pauses inside a file (per chunk), not only between files, and seals everything", async () => {
        const id = freshId();
        const files = plainFiles(id, 3, 6);
        let pauses = 0;
        const res = await migrateMediaSliced(id, {
            sliceMs: 0,
            pause: async () => {
                pauses++;
            },
        });
        assert.equal(res.sealed, 3);
        // 6 chunks to seal and 1 MiB-step of shredding per file, plus a step per file: a synchronous run has none.
        assert.ok(pauses >= 3 * 6, `only ${pauses} pause(s) for 18 chunks`);
        for (const f of files) {
            assert.equal(mediaFileState(f.file), "sealed");
            assert.deepEqual(readMediaFile(f.file, scopeOfDir(getAccountDir(id))), f.plain);
        }
    });

    it("timers run while a batch is sealed, on the real event loop", async () => {
        const id = freshId();
        const files = plainFiles(id, 4, 3);
        let sealedWhenTimerRan = null;
        setImmediate(() => {
            sealedWhenTimerRan = files.filter((f) => mediaFileState(f.file) === "sealed").length;
        });
        const res = await migrateMediaSliced(id, { sliceMs: 0 });
        assert.equal(res.sealed, 4);
        assert.notEqual(sealedWhenTimerRan, null);
        assert.ok(sealedWhenTimerRan < 4, "the loop was not served until the whole batch was done");
    });

    it("a stop takes effect between files: every file is whole, the rest is left for the next run", async () => {
        const id = freshId();
        const files = plainFiles(id, 4, 3);
        let pauses = 0;
        const res = await migrateMediaSliced(id, {
            sliceMs: 0,
            pause: async () => {
                pauses++;
            },
            stopped: () => pauses >= 2, // asked to stop inside the first file
        });
        assert.equal(res.more, true);
        assert.ok(res.sealed >= 1 && res.sealed < 4, `sealed ${res.sealed}`);
        for (const f of files) {
            // Read without the read's own seal-on-the-way: a plaintext file is compared as it is.
            if (mediaFileState(f.file) === "plaintext") assert.deepEqual(readFileSync(f.file), f.plain);
            else assert.deepEqual(readMediaFile(f.file, scopeOfDir(getAccountDir(id))), f.plain);
        }
        assert.equal(migrateMedia(id).sealed, 4 - res.sealed, "the next run finishes the rest");
    });

    it("the rows' msgIds still reach the sealed headers", async () => {
        const id = freshId();
        const [f] = plainFiles(id, 1, 1);
        initDb(getAccountDbPath(id));
        insertMessage({ msgId: "lm1", threadId: "t9", senderId: "1", text: "", timestamp: 1, type: "video" });
        setMessageLocalPath("lm1", f.file);
        closeDb();
        await migrateMediaSliced(id, { sliceMs: 0 });
        assert.deepEqual(readMediaFile(f.file, scopeOfDir(getAccountDir(id)), { msgId: "lm1" }), f.plain);
    });
});
