/**
 * The lookup of a message by the client-side id its sender generated (src/core/db.js `findMessageByClientId`).
 *
 * It used to read and parse the JSON of every row of the thread, once per synced message that lacked a server id:
 * 190 ms per message on a 42,000-row thread. That stalled a restore's event loop for minutes, the socket's pings
 * went unanswered, and Zalo closed it (1006). It is indexed now; these tests pin both what it finds and how fast.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { findMessageByClientId, initDb, insertMessage } from "../../src/core/db.js";

describe("findMessageByClientId", () => {
    let file;
    let n = 0;

    before(() => assertSandboxed(CONFIG_DIR));
    beforeEach(() => {
        // The module keeps its connection open (Windows will not delete the file under it), so each test gets a new
        // file inside the sandbox, which is removed as a whole.
        mkdirSync(join(CONFIG_DIR, "lookup-tests"), { recursive: true });
        file = join(CONFIG_DIR, "lookup-tests", `zalo-${process.pid}-${++n}.db`);
        initDb(file);
    });

    const row = (msgId, threadId, cliMsgId, timestamp = 1000) => ({
        msgId,
        threadId,
        senderId: "1",
        senderName: "n",
        text: "t",
        timestamp,
        type: "text",
        raw_data: { cliMsgId },
    });

    it("finds a message by its client id, inside one thread or across all", () => {
        insertMessage(row("g1", "t1", "c-1"));
        insertMessage(row("g2", "t2", "c-2"));
        assert.equal(findMessageByClientId("c-1", "t1")?.msgId, "g1");
        assert.equal(findMessageByClientId("c-1", "t2"), null, "another thread's message is not this thread's");
        assert.equal(findMessageByClientId("c-2")?.msgId, "g2");
        assert.equal(findMessageByClientId("nope", "t1"), null);
        assert.equal(findMessageByClientId("nope"), null);
    });

    it("returns the newest when several rows share a client id", () => {
        insertMessage(row("old", "t1", "c-9", 1000));
        insertMessage(row("new", "t1", "c-9", 5000));
        insertMessage(row("mid", "t1", "c-9", 3000));
        assert.equal(findMessageByClientId("c-9", "t1")?.msgId, "new");
        assert.equal(findMessageByClientId("c-9")?.msgId, "new");
    });

    it("takes no id, and a number is an id like a string", () => {
        insertMessage(row("g1", "t1", "55"));
        assert.equal(findMessageByClientId(undefined, "t1"), null);
        assert.equal(findMessageByClientId(null), null);
        assert.equal(findMessageByClientId(""), null);
        assert.equal(findMessageByClientId(55, "t1")?.msgId, "g1");
    });

    it("is not thrown by a row whose raw_data is not JSON (an older writer stored the bare text)", () => {
        const other = new Database(file);
        other
            .prepare(
                "INSERT INTO messages (msgId, threadId, senderId, text, timestamp, type, raw_data) VALUES (?,?,?,?,?,?,?)",
            )
            .run("bare", "t1", "1", "hello", 1, "text", "just some text, not json");
        other.close();
        insertMessage(row("g1", "t1", "c-1"));
        assert.equal(findMessageByClientId("c-1", "t1")?.msgId, "g1");
        assert.equal(findMessageByClientId("c-1")?.msgId, "g1");
    });

    it("stays fast on a big thread: thousands of lookups over tens of thousands of rows take well under a second each way", () => {
        const other = new Database(file);
        const add = other.prepare(
            "INSERT INTO messages (msgId, threadId, senderId, text, timestamp, type, raw_data) VALUES (?,?,?,?,?,?,?)",
        );
        other.transaction(() => {
            for (let i = 0; i < 40_000; i++) {
                add.run(`m${i}`, "big", "1", "hello", i, "text", JSON.stringify({ cliMsgId: `c${i}`, src: "sync" }));
            }
        })();
        other.close();
        const start = Date.now();
        for (let i = 0; i < 3000; i++) {
            assert.equal(findMessageByClientId(`c${i * 13}`, "big")?.msgId, `m${i * 13}`);
        }
        for (let i = 0; i < 3000; i++) assert.equal(findMessageByClientId(`absent${i}`, "big"), null);
        for (let i = 0; i < 500; i++) assert.equal(findMessageByClientId(`c${i}`)?.msgId, `m${i}`);
        // The scanning version took about 190 ms per lookup here: more than ten minutes for this loop.
        assert.ok(Date.now() - start < 8000, `the lookups took ${Date.now() - start} ms`);
    });

    it("works again after the database is reopened (the prepared lookups belong to a connection)", () => {
        insertMessage(row("g1", "t1", "c-1"));
        assert.equal(findMessageByClientId("c-1", "t1")?.msgId, "g1");
        initDb(file);
        assert.equal(findMessageByClientId("c-1", "t1")?.msgId, "g1");
    });
});
