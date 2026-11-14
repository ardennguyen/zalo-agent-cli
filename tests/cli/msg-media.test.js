/**
 * `msg media` driven as the binary: the cache only, no login. The bytes it writes are the plaintext the downloader
 * sealed; the cached file stays sealed; a link needs a running daemon; a hidden chat's media is refused.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR, getAccountDbPath, getAccountDir } from "../../src/core/credentials.js";
import { initDb, insertMessage, upsertThread } from "../../src/core/db.js";
import { scopeOfDir } from "../../src/core/keystore/keyring.js";
import { writeSealedMedia } from "../../src/core/keystore/media-seal.js";
import { HiddenChats } from "../../src/core/hidden-chats.js";
import { runCli, stripAnsi } from "../helpers/cli.js";

const options = { home: SANDBOX_HOME, timeout: 120_000 };
const OWN = "4343";
const PLAIN = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 13) % 256));

describe("msg media", () => {
    let sealed;
    before(() => {
        assertSandboxed(CONFIG_DIR);
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(
            join(CONFIG_DIR, "accounts.json"),
            JSON.stringify([{ ownId: OWN, name: "Tester", active: true }]),
        );
        const dir = getAccountDir(OWN);
        mkdirSync(dir, { recursive: true });
        initDb(getAccountDbPath(OWN));
        upsertThread({ threadId: "t1", name: "Chat", type: "dm", lastUpdate: 1 });
        sealed = join(dir, "media", "t1", "p.jpg");
        mkdirSync(dirname(sealed), { recursive: true });
        writeSealedMedia(sealed, scopeOfDir(dir), { msgId: "p1" }, PLAIN);
        const base = { threadId: "t1", senderId: "u2", senderName: "A", text: "", raw_data: "{}", has_attachment: 1 };
        insertMessage({ ...base, msgId: "p1", timestamp: 1, type: "photo", localPath: sealed });
        insertMessage({ ...base, msgId: "p2", timestamp: 2, type: "photo", localPath: null });
    });

    it("--out writes exactly the plaintext, and the cache stays sealed", async () => {
        const out = join(SANDBOX_HOME, "out.jpg");
        const r = await runCli(["--json", "msg", "media", "p1", "--out", out], options);
        assert.equal(r.code, 0, r.all);
        const reply = JSON.parse(stripAnsi(r.stdout));
        assert.deepEqual([reply.delivery, reply.size, reply.msgId], ["file", PLAIN.length, "p1"]);
        assert.deepEqual(readFileSync(out), PLAIN);
        assert.equal(readFileSync(sealed).includes(PLAIN.subarray(0, 4096)), false);
    });

    it("by default leaves a private decrypted copy and says where and until when", async () => {
        const r = await runCli(["--json", "msg", "media", "p1"], options);
        assert.equal(r.code, 0, r.all);
        const reply = JSON.parse(stripAnsi(r.stdout));
        assert.equal(reply.delivery, "tempfile");
        assert.ok(reply.path.startsWith(join(CONFIG_DIR, "tmp", "media")), reply.path);
        assert.deepEqual(readFileSync(reply.path), PLAIN, "the copy outlives the command until the sweep");
        assert.ok(Date.parse(reply.expiresAt) > Date.now());
    });

    it("--deliver inline prints base64 under --json", async () => {
        const r = await runCli(["--json", "msg", "media", "p1", "--deliver", "inline"], options);
        assert.equal(r.code, 0, r.all);
        const reply = JSON.parse(stripAnsi(r.stdout));
        assert.deepEqual(Buffer.from(reply.data, "base64"), PLAIN);
        assert.equal(reply.mimeType, "image/jpeg");
    });

    it("--deliver link needs a running daemon, and says so", async () => {
        const r = await runCli(["msg", "media", "p1", "--deliver", "link"], options);
        assert.equal(r.code, 1);
        assert.match(r.all, /running daemon/);
    });

    it("refuses media that is not downloaded, a hidden chat, and two outputs at once", async () => {
        const missing = await runCli(["msg", "media", "p2"], options);
        assert.equal(missing.code, 1);
        assert.match(missing.all, /sync-media -T t1/);
        const both = await runCli(["msg", "media", "p1", "--out", "x", "--stdout"], options);
        assert.equal(both.code, 1);
        // The sealed id mirror the daemon keeps, written the way it writes it.
        const mirror = new HiddenChats({ accountId: OWN, stateDir: getAccountDir(OWN) });
        mirror.setFromServer({ threads: [{ thread_id: "t1", is_group: 0 }] });
        try {
            const hidden = await runCli(["msg", "media", "p1", "--out", join(SANDBOX_HOME, "h.jpg")], options);
            assert.equal(hidden.code, 1);
            assert.match(hidden.all, /hidden chat/);
        } finally {
            mirror.clear();
        }
    });
});
