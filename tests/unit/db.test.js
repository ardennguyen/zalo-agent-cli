/**
 * src/core/db.js — the per-account SQLite cache.
 *
 * Covers schema creation, the "not initialized" guard on every exported
 * function, upsert/conflict semantics (including the COALESCE rule that
 * stops a re-insert from erasing a previously discovered localPath), query
 * ordering and paging, and the sync_state / sync_gaps bookkeeping the
 * reconnect backfill depends on.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    initDb,
    insertMessage,
    getMessages,
    upsertThread,
    getRecentThreads,
    upsertContact,
    getSyncState,
    setSyncState,
    recordSyncGap,
    getPendingSyncGaps,
    resolveSyncGap,
    resolveAllPendingSyncGaps,
} from "../../src/core/db.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-db-test-"));

/**
 * db.js keeps its connection in a module-private `db` and exports no
 * closeDb(), so nothing else can release the handle. On Windows an open
 * SQLite handle makes rmSync fail with EPERM, so the suite tracks every
 * connection initDb() hands back and closes them itself.
 */
const opened = [];
function open(path) {
    const handle = initDb(path);
    opened.push(handle);
    return handle;
}

after(() => {
    for (const h of opened) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        // A lingering WAL/SHM handle is not worth failing the run over.
    }
});

const msg = (over = {}) => ({
    msgId: "m1",
    threadId: "t1",
    senderId: "u1",
    senderName: "Sender",
    text: "hello",
    timestamp: 1_700_000_000_000,
    type: "text",
    raw_data: null,
    localPath: null,
    has_attachment: false,
    ...over,
});

describe("guards before initDb", () => {
    // These run in a fresh process before initDb is ever called for the
    // suite below, proving the module-level `db` guard is real.
    it("every reader/writer throws 'Database not initialized'", () => {
        const calls = [
            () => insertMessage(msg()),
            () => getMessages("t1"),
            () => getRecentThreads(),
            () => upsertThread({ threadId: "t1" }),
            () => upsertContact({ userId: "u1" }),
            () => getSyncState("k"),
            () => setSyncState("k", "v"),
            () => recordSyncGap(1, 2, "r"),
            () => getPendingSyncGaps(),
            () => resolveSyncGap(1),
            () => resolveAllPendingSyncGaps(),
        ];
        for (const fn of calls) {
            assert.throws(fn, /Database not initialized/, `${fn} should refuse before initDb()`);
        }
    });
});

describe("initDb", () => {
    it("creates the database file and enables WAL", () => {
        const p = join(ROOT, "created.db");
        const db = open(p);
        assert.equal(existsSync(p), true);
        assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    });

    it("is idempotent — re-initializing an existing file keeps its rows", () => {
        const p = join(ROOT, "idempotent.db");
        open(p);
        insertMessage(msg({ msgId: "keep-me" }));
        open(p);
        assert.equal(getMessages("t1").length, 1);
    });
});

describe("messages", () => {
    before(() => open(join(ROOT, "messages.db")));
    beforeEach(() => {
        // Fresh file per group of assertions keeps ordering tests honest.
        open(join(ROOT, `messages-${Math.random().toString(36).slice(2)}.db`));
    });

    it("inserts and reads back a row", () => {
        insertMessage(msg());
        const [row] = getMessages("t1");
        assert.equal(row.msgId, "m1");
        assert.equal(row.text, "hello");
        assert.equal(row.senderName, "Sender");
    });

    it("stores has_attachment as 0/1, not a boolean", () => {
        insertMessage(msg({ msgId: "a", has_attachment: true }));
        insertMessage(msg({ msgId: "b", has_attachment: false }));
        const rows = Object.fromEntries(getMessages("t1").map((r) => [r.msgId, r.has_attachment]));
        assert.equal(rows.a, 1);
        assert.equal(rows.b, 0);
    });

    it("serializes an object raw_data to JSON text", () => {
        insertMessage(msg({ raw_data: { nested: true } }));
        assert.equal(getMessages("t1")[0].raw_data, '{"nested":true}');
    });

    it("passes a string raw_data through unchanged", () => {
        insertMessage(msg({ raw_data: '{"already":"json"}' }));
        assert.equal(getMessages("t1")[0].raw_data, '{"already":"json"}');
    });

    it("upserts on msgId conflict instead of duplicating", () => {
        insertMessage(msg({ text: "first" }));
        insertMessage(msg({ text: "edited" }));
        const rows = getMessages("t1");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].text, "edited");
    });

    it("COALESCE keeps an existing localPath when the re-insert has none", () => {
        insertMessage(msg({ localPath: "/media/photo.jpg" }));
        insertMessage(msg({ localPath: null }));
        assert.equal(
            getMessages("t1")[0].localPath,
            "/media/photo.jpg",
            "a later cache write must not erase a downloaded attachment path",
        );
    });

    it("a non-null localPath on re-insert does replace the old one", () => {
        insertMessage(msg({ localPath: "/media/old.jpg" }));
        insertMessage(msg({ localPath: "/media/new.jpg" }));
        assert.equal(getMessages("t1")[0].localPath, "/media/new.jpg");
    });

    it("returns newest-first", () => {
        insertMessage(msg({ msgId: "old", timestamp: 1000 }));
        insertMessage(msg({ msgId: "new", timestamp: 3000 }));
        insertMessage(msg({ msgId: "mid", timestamp: 2000 }));
        assert.deepEqual(
            getMessages("t1").map((r) => r.msgId),
            ["new", "mid", "old"],
        );
    });

    it("honors the limit", () => {
        for (let i = 0; i < 10; i++) insertMessage(msg({ msgId: `m${i}`, timestamp: 1000 + i }));
        assert.equal(getMessages("t1", 3).length, 3);
    });

    it("defaults to a limit of 50", () => {
        for (let i = 0; i < 60; i++) insertMessage(msg({ msgId: `m${i}`, timestamp: 1000 + i }));
        assert.equal(getMessages("t1").length, 50);
    });

    it("fromTimestamp pages strictly older messages", () => {
        insertMessage(msg({ msgId: "a", timestamp: 1000 }));
        insertMessage(msg({ msgId: "b", timestamp: 2000 }));
        insertMessage(msg({ msgId: "c", timestamp: 3000 }));
        assert.deepEqual(
            getMessages("t1", 50, 3000).map((r) => r.msgId),
            ["b", "a"],
            "the anchor message itself must be excluded",
        );
    });

    it("scopes results to the requested thread", () => {
        insertMessage(msg({ msgId: "a", threadId: "t1" }));
        insertMessage(msg({ msgId: "b", threadId: "t2" }));
        assert.deepEqual(
            getMessages("t2").map((r) => r.msgId),
            ["b"],
        );
    });

    it("returns [] for an unknown thread", () => {
        assert.deepEqual(getMessages("nope"), []);
    });
});

describe("threads", () => {
    beforeEach(() => open(join(ROOT, `threads-${Math.random().toString(36).slice(2)}.db`)));

    it("upserts and lists newest-first", () => {
        upsertThread({ threadId: "t1", type: "dm", name: "Alpha", lastUpdate: 100 });
        upsertThread({ threadId: "t2", type: "group", name: "Beta", lastUpdate: 300 });
        upsertThread({ threadId: "t3", type: "dm", name: "Gamma", lastUpdate: 200 });
        assert.deepEqual(
            getRecentThreads().map((t) => t.threadId),
            ["t2", "t3", "t1"],
        );
    });

    it("updates name and lastUpdate on conflict", () => {
        upsertThread({ threadId: "t1", type: "group", name: "Old", lastUpdate: 100 });
        upsertThread({ threadId: "t1", type: "group", name: "Renamed", lastUpdate: 500 });
        const [t] = getRecentThreads();
        assert.equal(t.name, "Renamed");
        assert.equal(t.lastUpdate, 500);
        assert.equal(getRecentThreads().length, 1);
    });

    it("COALESCE preserves an existing sync_timestamp when the update omits one", () => {
        upsertThread({ threadId: "t1", type: "dm", name: "A", lastUpdate: 1, sync_timestamp: 777 });
        upsertThread({ threadId: "t1", type: "dm", name: "A", lastUpdate: 2 });
        assert.equal(getRecentThreads()[0].sync_timestamp, 777);
    });

    it("honors the limit", () => {
        for (let i = 0; i < 5; i++) upsertThread({ threadId: `t${i}`, type: "dm", name: `T${i}`, lastUpdate: i });
        assert.equal(getRecentThreads(2).length, 2);
    });

    it("never downgrades a known group to a dm", () => {
        // A live message is typed by the socket command that carried it, and
        // the server echoes the sender's own message back on the channel
        // matching the type the SEND declared. Sending to a group with the
        // default thread type therefore returns the echo on the DM channel,
        // and a blind `type = excluded.type` rewrote a synced group to "dm" --
        // observed live, and found already sitting in a real cache.
        upsertThread({ threadId: "g1", type: "group", name: "G", lastUpdate: 100 });
        upsertThread({ threadId: "g1", type: "dm", name: "", lastUpdate: 200 });
        assert.equal(getRecentThreads()[0].type, "group");
    });

    it("still promotes a dm to a group, because that direction is a correction", () => {
        upsertThread({ threadId: "g2", type: "dm", name: "G", lastUpdate: 100 });
        upsertThread({ threadId: "g2", type: "group", name: "", lastUpdate: 200 });
        assert.equal(getRecentThreads()[0].type, "group");
    });
});

describe("contacts", () => {
    beforeEach(() => open(join(ROOT, `contacts-${Math.random().toString(36).slice(2)}.db`)));

    it("upserts by userId", () => {
        upsertContact({ userId: "u1", name: "Old Name", phone: "84900000000" });
        const res = upsertContact({ userId: "u1", name: "New Name", phone: "84911111111" });
        assert.equal(res.changes, 1);
    });
});

describe("sync_state", () => {
    beforeEach(() => open(join(ROOT, `state-${Math.random().toString(36).slice(2)}.db`)));

    it("returns null for an unset key", () => {
        assert.equal(getSyncState("never-written"), null);
    });

    it("round-trips a value", () => {
        setSyncState("lastConnectedAt", "12345");
        assert.equal(getSyncState("lastConnectedAt"), "12345");
    });

    it("stringifies on write — callers always read strings back", () => {
        setSyncState("n", 42);
        assert.equal(getSyncState("n"), "42");
        setSyncState("b", true);
        assert.equal(getSyncState("b"), "true");
    });

    it("overwrites on conflict rather than erroring", () => {
        setSyncState("k", "one");
        setSyncState("k", "two");
        assert.equal(getSyncState("k"), "two");
    });
});

describe("sync_gaps", () => {
    beforeEach(() => open(join(ROOT, `gaps-${Math.random().toString(36).slice(2)}.db`)));

    it("records a gap and returns its id", () => {
        const id = recordSyncGap(1000, 2000, "reconnect-gap");
        assert.equal(typeof id, "number");
        assert.ok(id > 0);
    });

    it("lists pending gaps oldest-first", () => {
        recordSyncGap(3000, 4000, "c");
        recordSyncGap(1000, 2000, "a");
        recordSyncGap(2000, 3000, "b");
        assert.deepEqual(
            getPendingSyncGaps().map((g) => g.reason),
            ["a", "b", "c"],
        );
    });

    it("stores the reason and a createdAt stamp", () => {
        const before = Date.now();
        recordSyncGap(1, 2, "startup-gap");
        const [g] = getPendingSyncGaps();
        assert.equal(g.reason, "startup-gap");
        assert.equal(g.status, "pending");
        assert.ok(g.createdAt >= before);
    });

    it("resolveSyncGap removes just that gap from the pending list", () => {
        const a = recordSyncGap(1, 2, "a");
        recordSyncGap(3, 4, "b");
        resolveSyncGap(a);
        assert.deepEqual(
            getPendingSyncGaps().map((g) => g.reason),
            ["b"],
        );
    });

    it("resolveSyncGap stamps resolvedAt", () => {
        const id = recordSyncGap(1, 2, "a");
        resolveSyncGap(id);
        assert.equal(getPendingSyncGaps().length, 0);
    });

    it("resolveAllPendingSyncGaps clears everything outstanding", () => {
        recordSyncGap(1, 2, "a");
        recordSyncGap(3, 4, "b");
        recordSyncGap(5, 6, "c");
        resolveAllPendingSyncGaps();
        assert.deepEqual(getPendingSyncGaps(), []);
    });

    it("resolving twice is harmless", () => {
        const id = recordSyncGap(1, 2, "a");
        resolveSyncGap(id);
        assert.doesNotThrow(() => resolveSyncGap(id));
    });
});
describe("getRecentThreads — type filtering", () => {
    // The filter must happen in SQL, not after a global LIMIT. Seed a cache
    // where the newest threads are all DMs, so a post-hoc JS filter would
    // return no groups at all.
    beforeEach(() => {
        open(join(ROOT, `recent-${Math.random().toString(36).slice(2)}.db`));
        // 10 DMs, newest. 10 groups, older.
        for (let i = 0; i < 10; i++)
            upsertThread({ threadId: `dm${i}`, type: "dm", name: `DM ${i}`, lastUpdate: 2000 + i });
        for (let i = 0; i < 10; i++)
            upsertThread({ threadId: `g${i}`, type: "group", name: `Group ${i}`, lastUpdate: 1000 + i });
    });

    it("returns both types when no filter is given", () => {
        const rows = getRecentThreads(5);
        assert.equal(rows.length, 5);
        assert.ok(
            rows.every((r) => r.type === "dm"),
            "the 5 newest overall happen to be DMs in this fixture",
        );
    });

    it("returns the newest N GROUPS, not the groups among the newest N threads", () => {
        const rows = getRecentThreads(5, "group");
        assert.equal(rows.length, 5, "asking for 5 groups must return 5 groups");
        assert.ok(rows.every((r) => r.type === "group"));
        assert.deepEqual(
            rows.map((r) => r.threadId),
            ["g9", "g8", "g7", "g6", "g5"],
            "newest-first within the filtered set",
        );
    });

    it("returns the newest N DMs when filtered to dm", () => {
        const rows = getRecentThreads(5, "dm");
        assert.equal(rows.length, 5);
        assert.ok(rows.every((r) => r.type === "dm"));
        assert.deepEqual(
            rows.map((r) => r.threadId),
            ["dm9", "dm8", "dm7", "dm6", "dm5"],
        );
    });

    it("a post-hoc JS filter would have returned ZERO groups here — the bug this fixes", () => {
        const naive = getRecentThreads(5).filter((r) => r.type === "group");
        assert.equal(naive.length, 0, "demonstrates why the filter must be in SQL");
        assert.equal(getRecentThreads(5, "group").length, 5);
    });

    it("honors the limit when fewer rows exist than requested", () => {
        assert.equal(getRecentThreads(50, "group").length, 10);
    });

    it("returns [] for a type with no rows", () => {
        open(join(ROOT, `empty-${Math.random().toString(36).slice(2)}.db`));
        upsertThread({ threadId: "only-dm", type: "dm", name: "x", lastUpdate: 1 });
        assert.deepEqual(getRecentThreads(10, "group"), []);
    });
});

describe("thread ordering after a sync", () => {
    it("keeps the newest timestamp when messages arrive out of order", () => {
        // The sync upserts a thread once per message, and messages do not
        // arrive newest-first. A plain assignment left each thread stamped with
        // whichever message happened to be processed last, so `conv recent`
        // ordered by an arbitrary message rather than the newest one.
        open(join(ROOT, "ordering.db"));
        upsertThread({ threadId: "t1", type: "dm", name: "Alice", lastUpdate: 3000 });
        upsertThread({ threadId: "t1", type: "dm", name: "Alice", lastUpdate: 1000 });
        assert.equal(getRecentThreads(10)[0].lastUpdate, 3000);
    });

    it("orders conversations newest-first regardless of write order", () => {
        open(join(ROOT, "ordering2.db"));
        upsertThread({ threadId: "old", type: "dm", name: "Old", lastUpdate: 1000 });
        upsertThread({ threadId: "new", type: "dm", name: "New", lastUpdate: 9000 });
        upsertThread({ threadId: "mid", type: "dm", name: "Mid", lastUpdate: 5000 });
        upsertThread({ threadId: "new", type: "dm", name: "New", lastUpdate: 2000 });
        assert.deepEqual(
            getRecentThreads(10).map((t) => t.threadId),
            ["new", "mid", "old"],
        );
    });

    it("does not let a nameless upsert erase a known display name", () => {
        // Only some synced messages carry dName; the rest must not blank it.
        open(join(ROOT, "ordering3.db"));
        upsertThread({ threadId: "t1", type: "dm", name: "Alice", lastUpdate: 2 });
        upsertThread({ threadId: "t1", type: "dm", name: "", lastUpdate: 3 });
        const [t] = getRecentThreads(10);
        assert.equal(t.name, "Alice");
        assert.equal(t.lastUpdate, 3, "but the newer timestamp still applies");
    });
});
