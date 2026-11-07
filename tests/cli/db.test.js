/**
 * The `db` group driven as the binary, on a sandbox account's encrypted cache, with no login: `db query` returns rows
 * and refuses a write; `db backup` and `db export` write a verified copy (encrypted, or decrypted only with `--yes`:
 * exit 2 without it, nothing written, `--dry-run` previews); `db verify` exits 0 on a clean cache and 1 on a changed
 * row.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDbPath, getAccountDir } from "../../src/core/credentials.js";
import { closeDb, initDb, insertMessage } from "../../src/core/db.js";
import { registerRowMacFunction } from "../../src/core/row-mac.js";
import { dbFileState, openDatabase } from "../../src/core/sqlite.js";
import { runCli, stripAnsi } from "../helpers/cli.js";

const options = { home: SANDBOX_HOME, timeout: 120_000 };
const OWN = "5151";
const json = (r) => JSON.parse(stripAnsi(r.stdout));

describe("db", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(
            join(CONFIG_DIR, "accounts.json"),
            JSON.stringify([{ ownId: OWN, name: "Tester", active: true }]),
        );
        mkdirSync(getAccountDir(OWN), { recursive: true });
        initDb(getAccountDbPath(OWN));
        for (let i = 0; i < 3; i++) {
            insertMessage({
                msgId: `m${i}`,
                threadId: "t1",
                senderId: "u",
                text: `hello ${i}`,
                timestamp: i,
                type: "text",
            });
        }
        closeDb();
    });

    it("query --json returns the rows; a write is refused with exit 1", async () => {
        const r = await runCli(["--json", "db", "query", "SELECT msgId, text FROM messages ORDER BY msgId"], options);
        assert.equal(r.code, 0, r.all);
        const reply = json(r);
        assert.deepEqual(reply.columns, ["msgId", "text"]);
        assert.deepEqual(
            reply.rows.map((x) => x.msgId),
            ["m0", "m1", "m2"],
        );
        const write = await runCli(["db", "query", "DELETE FROM messages"], options);
        assert.equal(write.code, 1);
        assert.match(write.all, /reads/);
        const key = await runCli(["db", "query", "PRAGMA key = 'x'"], options);
        assert.equal(key.code, 1);
    });

    it("backup writes an encrypted, verified copy", async () => {
        const out = join(SANDBOX_HOME, "backup.db");
        const r = await runCli(["--json", "db", "backup", "--out", out], options);
        assert.equal(r.code, 0, r.all);
        const reply = json(r);
        assert.deepEqual([reply.encrypted, reply.messages, reply.quickCheck], [true, 3, "ok"]);
        assert.equal(dbFileState(out), "encrypted");
    });

    it("export --plaintext asks first: exit 2 and nothing written; --dry-run previews; --yes writes it", async () => {
        const out = join(SANDBOX_HOME, "plain.db");
        const refused = await runCli(["db", "export", "--out", out, "--plaintext"], options);
        assert.equal(refused.code, 2, refused.all);
        assert.ok(!existsSync(out));
        const dry = await runCli(["db", "export", "--out", out, "--plaintext", "--dry-run"], options);
        assert.equal(dry.code, 0, dry.all);
        assert.match(dry.all, /decrypted/);
        assert.ok(!existsSync(out));
        const done = await runCli(["--json", "db", "export", "--out", out, "--plaintext", "--yes"], options);
        assert.equal(done.code, 0, done.all);
        assert.equal(json(done).encrypted, false);
        assert.equal(dbFileState(out), "plaintext");
    });

    it("export without --plaintext needs no --yes and writes an encrypted copy", async () => {
        const out = join(SANDBOX_HOME, "enc.db");
        const r = await runCli(["db", "export", "--out", out], options);
        assert.equal(r.code, 0, r.all);
        assert.equal(dbFileState(out), "encrypted");
    });

    it("verify exits 0 on a clean cache, 1 on a row changed under another key", async () => {
        const clean = await runCli(["--json", "db", "verify"], options);
        assert.equal(clean.code, 0, clean.all);
        assert.deepEqual([json(clean).checked, json(clean).clean], [3, true]);
        const db = openDatabase(getAccountDbPath(OWN));
        try {
            registerRowMacFunction(db, randomBytes(32));
            db.prepare("UPDATE messages SET text = 'forged' WHERE msgId = 'm1'").run();
        } finally {
            db.close();
        }
        const dirty = await runCli(["--json", "db", "verify"], options);
        assert.equal(dirty.code, 1, dirty.all);
        const reply = json(dirty);
        assert.equal(reply.bad, 1);
        assert.deepEqual(reply.failures, [{ msgId: "m1", threadId: "t1", state: "bad" }]);
    });
});
