/**
 * `account security rekey` and the encrypted message database (src/core/keystore/stores.js): the store registers its
 * rekey handler, so new keys re-encrypt zalo.db before the old ones are dropped; the handler is idempotent, and a rekey
 * that stops part way (in our handler or in another one) is finished by running it again, with the old key kept until
 * then.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { CONFIG_DIR, getAccountDbPath, getAccountDir } from "../../src/core/credentials.js";
import { Database, dbFileState, openDatabase } from "../../src/core/sqlite.js";
import { closeDb, initDb, insertMessage } from "../../src/core/db.js";
import { getDataKey, onRekey, readKeyring, rekeyAccount } from "../../src/core/keystore/index.js";
import { lockAll } from "../../src/core/keystore/keyring.js";
import { fullSecurityStatus, rekeyStores } from "../../src/core/keystore/stores.js";

let n = 0;
const freshId = () => String(1000000000000000950n + BigInt(n++));
const quiet = () => {};

/** A cache with `rows` messages for a fresh account; closed. */
function cache(id, rows = 5) {
    const file = getAccountDbPath(id);
    initDb(file);
    for (let i = 0; i < rows; i++) {
        insertMessage({ msgId: `r${i}`, threadId: "t", senderId: "1", text: `row ${i}`, timestamp: i, type: "text" });
    }
    closeDb();
    return file;
}

const count = (file) => {
    const db = openDatabase(file, { log: quiet });
    try {
        return db.prepare("SELECT count(*) AS n FROM messages").get().n;
    } finally {
        db.close();
    }
};

/** Does this raw key open the file? (what an attacker holding only the old key could do) */
function opensWith(file, key) {
    const db = new Database(file, { readonly: true });
    try {
        db.pragma("cipher = 'sqlcipher'");
        db.pragma("legacy = 4");
        db.pragma(`key = "x'${key.toString("hex")}'"`);
        db.prepare("SELECT count(*) FROM sqlite_master").get();
        return true;
    } catch (e) {
        if (e.code === "SQLITE_NOTADB") return false;
        throw e;
    } finally {
        db.close();
    }
}

const dbRow = (id) => fullSecurityStatus(id).files.find((f) => f.kind === "message-database");
const dataKeyId = (id) => readKeyring(getAccountDir(id)).keys.find((k) => k.use === "data").id;

describe("rekey re-encrypts the message database", () => {
    before(() => assertSandboxed(CONFIG_DIR));
    afterEach(() => closeDb());

    it("round trip: new key, every row kept, the old key no longer opens it, the old key is dropped", () => {
        const id = freshId();
        const file = cache(id, 7);
        const old = getDataKey(id, "sqlcipher");
        assert.equal(dbRow(id).keyId, old.keyId);

        rekeyAccount(id);

        const ring = readKeyring(getAccountDir(id));
        assert.deepEqual(ring.retired, []);
        const now = dbRow(id);
        assert.equal(now.state, "encrypted");
        assert.equal(now.currentKey, true);
        assert.equal(now.keyId, dataKeyId(id));
        assert.notEqual(now.keyId, old.keyId);
        assert.equal(count(file), 7);
        assert.equal(opensWith(file, old.key), false, "the old key must not open it");
        assert.equal(opensWith(file, getDataKey(id, "sqlcipher").key), true);
        // Also from a fresh process's view (no key cached in memory).
        lockAll();
        assert.equal(count(file), 7);
    });

    it("the handler is idempotent: a database already under the current key is left alone", () => {
        const id = freshId();
        const file = cache(id, 2);
        const before = readFileSync(file);
        assert.deepEqual(
            rekeyStores(id).map((r) => r.result),
            ["current"],
        );
        assert.deepEqual(readFileSync(file), before);
    });

    it("an account with no database, or a still-plaintext one, rekeys without touching it", () => {
        const id = freshId();
        cache(id, 1);
        const file = getAccountDbPath(id);
        const db = openDatabase(file);
        db.pragma("rekey = ''");
        db.close();
        assert.equal(dbFileState(file), "plaintext");
        rekeyAccount(id);
        assert.equal(dbFileState(file), "plaintext", "a rekey never migrates; the next open does, under the new key");
        assert.equal(count(file), 1);
        assert.equal(dbRow(id).keyId, dataKeyId(id));

        const empty = freshId();
        getDataKey(empty, "sqlcipher"); // a keyring, no database
        assert.deepEqual(
            rekeyStores(empty).map((r) => r.result),
            ["absent"],
        );
        rekeyAccount(empty);
    });

    it("a rekey stopped by a later handler keeps the old key; running it again finishes", () => {
        const id = freshId();
        const file = cache(id, 4);
        const off = onRekey(() => {
            throw new Error("another store failed");
        });
        try {
            assert.throws(() => rekeyAccount(id), /another store failed/);
        } finally {
            off();
        }
        const mid = fullSecurityStatus(id);
        assert.equal(mid.keyring.rekeyInProgress, true, "the old keys are still in the keyring");
        assert.equal(count(file), 4, "the database still opens");

        rekeyAccount(id);
        const done = fullSecurityStatus(id);
        assert.equal(done.keyring.rekeyInProgress, false);
        const row = done.files.find((f) => f.kind === "message-database");
        assert.equal(row.keyId, dataKeyId(id));
        assert.equal(row.currentKey, true);
        assert.equal(count(file), 4);
    });

    it("when the database's own rekey fails, the old key is not dropped: it still opens, and a rerun finishes", () => {
        const id = freshId();
        const file = cache(id, 3);
        const oldKeyId = dataKeyId(id);
        // Something unreadable where the database is: its handler throws, so the rekey must stop.
        renameSync(file, `${file}.aside`);
        writeFileSync(file, randomBytes(8192));
        assert.throws(
            () => rekeyAccount(id),
            (e) => e.code === "WRONG_KEY",
        );
        renameSync(`${file}.aside`, file);
        const ring = readKeyring(getAccountDir(id));
        assert.ok(
            ring.retired.some((k) => k.id === oldKeyId),
            "the key the database is under is kept (retired)",
        );
        assert.equal(count(file), 3, "it opens under the retired key");
        assert.equal(dbRow(id).currentKey, false);

        rekeyAccount(id);
        assert.deepEqual(readKeyring(getAccountDir(id)).retired, []);
        assert.equal(dbRow(id).currentKey, true);
        assert.equal(count(file), 3);
    });
});
