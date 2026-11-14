/**
 * Row MAC: tamper evidence for the cached messages (src/core/row-mac.js, wired in src/core/db.js `initDb`, rekeyed by
 * src/core/keystore/stores.js). Every writer's rows get a MAC through the triggers; a connection without the function
 * cannot write a message; a row changed under the wrong key, or written without a MAC, is found by `db verify` and
 * refused by an action; a recall's tombstone is re-MACed; rows from before the MACs are sealed once; a rekey carries
 * the MACs to the new key.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { CONFIG_DIR, getAccountDbPath } from "../../src/core/credentials.js";
import { openDatabase } from "../../src/core/sqlite.js";
import {
    closeDb,
    forgetThread,
    getMessageForAction,
    initDb,
    insertMessage,
    insertMessageIfAbsent,
    markMessageRecalled,
    verifyMessageRows,
} from "../../src/core/db.js";
import { storageConfigFile } from "../../src/core/keystore/config.js";
import { rekeyAccount } from "../../src/core/keystore/index.js";
import "../../src/core/keystore/stores.js";
import {
    ROW_MAC_FIELDS,
    ROW_MAC_MARKER,
    computeRowMac,
    registerRowMacFunction,
    verifyOnReadMode,
} from "../../src/core/row-mac.js";
import { cachedMessageById } from "../../src/core/cached-message.js";
import { openRawWriter } from "./support/raw-db.js";

let n = 0;
const freshId = () => String(1000000000000000860n + BigInt(n++));
const quiet = () => {};

const msg = (msgId, over = {}) => ({
    msgId,
    threadId: "t1",
    senderId: "1",
    senderName: "A",
    text: `text of ${msgId}`,
    timestamp: 1_700_000_000_000 + Number(String(msgId).replace(/\D/g, "") || 0),
    type: "text",
    raw_data: { cliMsgId: `c-${msgId}`, src: "test" },
    ...over,
});

/** A cache for a fresh account with `rows` messages, left open. */
function cache(rows = 3) {
    const id = freshId();
    const file = getAccountDbPath(id);
    initDb(file);
    for (let i = 0; i < rows; i++) insertMessage(msg(`m${i}`));
    return { id, file };
}

/** Run fn on a second connection keyed like initDb's, closed afterwards. */
function withRaw(file, fn, { rowMac = true } = {}) {
    const db = rowMac ? openRawWriter(file) : openDatabase(file, { log: quiet });
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

describe("row MAC", () => {
    before(() => assertSandboxed(CONFIG_DIR));
    afterEach(() => {
        closeDb();
        rmSync(storageConfigFile(), { force: true });
    });

    it("every writer's rows carry a MAC: upsert, insert-if-absent, and they verify", () => {
        const { file } = cache(3);
        insertMessageIfAbsent(msg("h1"));
        insertMessage(msg("m0", { text: "edited by a later sync" }));
        const r = verifyMessageRows();
        assert.equal(r.checked, 4);
        assert.equal(r.ok, 4);
        assert.equal(r.bad + r.missing, 0);
        assert.equal(r.seal, "sealed");
        assert.equal(
            withRaw(file, (db) => db.prepare("SELECT count(*) AS n FROM message_macs").get().n),
            4,
        );
        assert.equal(getMessageForAction("m0").text, "edited by a later sync");
    });

    it("a connection without the function (a SQLCipher tool holding the db key) cannot write a message", () => {
        const { file } = cache(1);
        closeDb();
        withRaw(
            file,
            (db) => {
                assert.throws(
                    () => db.prepare("UPDATE messages SET text = 'forged' WHERE msgId = 'm0'").run(),
                    /no such function: zac_row_mac/,
                );
                assert.throws(
                    () =>
                        db
                            .prepare("INSERT INTO messages (msgId, threadId, text, timestamp, type) VALUES (?,?,?,?,?)")
                            .run("x1", "t1", "forged", 1, "text"),
                    /no such function: zac_row_mac/,
                );
            },
            { rowMac: false },
        );
        initDb(file);
        assert.equal(getMessageForAction("m0").text, "text of m0");
    });

    it("a row changed under another key is found by verify and refused by an action", () => {
        const { file } = cache(3);
        withRaw(
            file,
            (db) => {
                registerRowMacFunction(db, randomBytes(32));
                db.prepare("UPDATE messages SET text = 'forged' WHERE msgId = 'm1'").run();
            },
            { rowMac: false },
        );
        const r = verifyMessageRows();
        assert.equal(r.bad, 1);
        assert.deepEqual(r.failures, [{ msgId: "m1", threadId: "t1", state: "bad" }]);
        assert.throws(
            () => getMessageForAction("m1"),
            (e) => e.code === "ROW_MAC" && e.state === "bad" && /failed its integrity check/.test(e.message),
        );
        assert.equal(getMessageForAction("m0").msgId, "m0", "the other rows still act");
        // delete / recall / react take their ids through this lookup: it refuses rather than reading as "not cached".
        assert.throws(
            () => cachedMessageById("t1", "m1"),
            (e) => e.code === "ROW_MAC",
        );
        assert.equal(cachedMessageById("t1", "m0").cliMsgId, "c-m0");
        // storage.json's rowMac.verifyOnRead "off" lets the action through (verify still finds it).
        writeFileSync(storageConfigFile(), JSON.stringify({ rowMac: { verifyOnRead: "off" } }));
        assert.equal(getMessageForAction("m1").text, "forged");
        assert.equal(verifyMessageRows().bad, 1);
    });

    it("a row with its MAC removed is 'missing', and is not sealed again on the next open", () => {
        const { file } = cache(2);
        withRaw(file, (db) => db.prepare("DELETE FROM message_macs WHERE msgId = 'm1'").run());
        closeDb();
        initDb(file);
        const r = verifyMessageRows();
        assert.equal(r.missing, 1);
        assert.throws(
            () => getMessageForAction("m1"),
            (e) => e.code === "ROW_MAC" && e.state === "missing",
        );
    });

    it("a recall's tombstone (an UPDATE) is re-MACed, and a delete takes its MAC with it", () => {
        const { file } = cache(3);
        markMessageRecalled("m2", 1_700_000_000_999);
        assert.equal(getMessageForAction("m2").type, "deleted");
        forgetThread("t1");
        const r = verifyMessageRows();
        assert.equal(r.checked, 0);
        assert.equal(r.orphanMacs, 0);
        assert.equal(
            withRaw(file, (db) => db.prepare("SELECT count(*) AS n FROM message_macs").get().n),
            0,
        );
    });

    it("the MAC covers each field, with NULL distinct from '' and a number distinct from its text", () => {
        const key = randomBytes(32);
        const base = ROW_MAC_FIELDS.map((f) => (f === "timestamp" ? 5 : "v"));
        const mac = computeRowMac(key, base);
        assert.equal(mac.length, 16);
        for (let i = 0; i < base.length; i++) {
            const changed = [...base];
            changed[i] = changed[i] === 5 ? 6 : "w";
            assert.notDeepEqual(computeRowMac(key, changed), mac, `field ${ROW_MAC_FIELDS[i]}`);
        }
        const withNull = [...base];
        withNull[2] = null;
        const withEmpty = [...base];
        withEmpty[2] = "";
        assert.notDeepEqual(computeRowMac(key, withNull), computeRowMac(key, withEmpty));
        const asText = [...base];
        asText[4] = "5";
        assert.notDeepEqual(computeRowMac(key, asText), mac);
        assert.notDeepEqual(computeRowMac(randomBytes(32), base), mac, "keyed");
    });

    it("rows from before the MACs are sealed once on open; the next open changes nothing", () => {
        const { file } = cache(4);
        closeDb();
        // A database as WP10 found it: no MAC table, no triggers, no marker.
        withRaw(file, (db) => {
            db.exec(`DROP TRIGGER messages_mac_ai; DROP TRIGGER messages_mac_au; DROP TRIGGER messages_mac_ad;
                     DROP TABLE message_macs;`);
            db.prepare("DELETE FROM sync_state WHERE key = ?").run(ROW_MAC_MARKER);
        });
        initDb(file);
        const r = verifyMessageRows();
        assert.equal(r.ok, 4);
        assert.equal(r.seal, "sealed");
        closeDb();
        const before = withRaw(file, (db) =>
            db.prepare("SELECT value FROM sync_state WHERE key = ?").get(ROW_MAC_MARKER),
        );
        initDb(file);
        const after = withRaw(file, (db) =>
            db.prepare("SELECT value FROM sync_state WHERE key = ?").get(ROW_MAC_MARKER),
        );
        assert.deepEqual(after, before);
    });

    it("a removed seal marker does not re-bless rows: a row written without a MAC stays missing", () => {
        const { file } = cache(2);
        closeDb();
        withRaw(file, (db) => {
            // Someone with the db key: drops the triggers, writes a row, drops the marker to get it sealed.
            db.exec("DROP TRIGGER messages_mac_ai");
            db.prepare("INSERT INTO messages (msgId, threadId, text, timestamp, type) VALUES (?,?,?,?,?)").run(
                "x9",
                "t1",
                "planted",
                9,
                "text",
            );
            db.prepare("DELETE FROM sync_state WHERE key = ?").run(ROW_MAC_MARKER);
        });
        initDb(file);
        const r = verifyMessageRows();
        assert.equal(r.missing, 1);
        assert.equal(r.seal, "absent");
        assert.throws(
            () => getMessageForAction("x9"),
            (e) => e.code === "ROW_MAC",
        );
        insertMessage(msg("m5"));
        assert.equal(getMessageForAction("m5").msgId, "m5", "the trigger is back for new rows");
    });

    it("a forged marker is not trusted", () => {
        const { file } = cache(1);
        closeDb();
        withRaw(file, (db) =>
            db.prepare("UPDATE sync_state SET value = ? WHERE key = ?").run(`sealed:${"0".repeat(64)}`, ROW_MAC_MARKER),
        );
        initDb(file);
        assert.equal(verifyMessageRows().seal, "invalid");
    });

    it("verify scopes to a thread and a time", () => {
        cache(3);
        insertMessage(msg("o1", { threadId: "t2" }));
        assert.equal(verifyMessageRows({ threadId: "t2" }).checked, 1);
        assert.equal(verifyMessageRows({ since: 1_700_000_000_002 }).checked, 1);
    });

    it("rekey carries the MACs to the new key; a tampered row stays a finding", () => {
        const { id, file } = cache(5);
        withRaw(
            file,
            (db) => {
                registerRowMacFunction(db, randomBytes(32));
                db.prepare("UPDATE messages SET text = 'forged' WHERE msgId = 'm3'").run();
            },
            { rowMac: false },
        );
        closeDb();
        rekeyAccount(id);
        initDb(file);
        const r = verifyMessageRows();
        assert.equal(r.ok, 4);
        assert.equal(r.bad, 1);
        assert.equal(r.oldKey, 0, "every good row is under the new key");
        assert.equal(r.seal, "sealed", "the marker moved to the new key");
        // Running the handler again changes nothing.
        closeDb();
        rekeyAccount(id);
        initDb(file);
        assert.equal(verifyMessageRows().ok, 4);
    });

    it("rowMac.verifyOnRead takes actions or off, nothing else", () => {
        assert.equal(verifyOnReadMode({}), "actions");
        assert.equal(verifyOnReadMode({ rowMac: { verifyOnRead: "off" } }), "off");
        assert.throws(() => verifyOnReadMode({ rowMac: { verifyOnRead: "always" } }), /actions, off/);
    });
});
