/**
 * src/core/sync.js — `backfillOverSocket()`, the replacement for the retired
 * phone-transfer path.
 *
 * Background (measured against the live Zalo Web client, 2026-09-20): the REST
 * endpoints the old `sync-mobile` relied on — `/api/message/pull_mobile_msg`
 * and `/api/message/get_crossdb` — are still present in Zalo Web's bundle but
 * have zero call sites in it. A web client whose local database has been wiped
 * restores itself over the WebSocket instead, with cmd 510 (DMs) and 511
 * (groups). zca-js already exposes exactly that as
 * `listener.requestOldMessages()` plus the `old_messages` event, so the whole
 * path is drivable — and testable — with a fake listener and no Zalo session.
 *
 * See agent/work/transfer-sync-v2/NOTES.md § Mobile sync.
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { SyncManager } from "../../src/core/sync.js";
import { getMessages, getRecentThreads } from "../../src/core/db.js";

const THREAD_USER = 0;
const THREAD_GROUP = 1;

/**
 * Stands in for a started zca-js Listener. Records which thread types were
 * asked for so the test can assert both were, and lets the test push
 * `old_messages` batches back on its own schedule.
 */
class FakeListener extends EventEmitter {
    constructor() {
        super();
        this.requested = [];
    }
    requestOldMessages(threadType) {
        this.requested.push(threadType);
    }
    /** Deliver a batch the way zca-js does: (messages, threadType). */
    deliver(messages, threadType) {
        this.emit("old_messages", messages, threadType);
    }
}

/** A zca-js UserMessage/GroupMessage-shaped record. */
function msg(msgId, threadId, overrides = {}) {
    return {
        threadId,
        data: {
            msgId,
            uidFrom: "42",
            dName: "Tester",
            content: "hello " + msgId,
            ts: 1700000000000,
            ...overrides,
        },
    };
}

/** Unique account id per test so each gets a clean zalo.db. */
let seq = 0;
const nextAccount = () => `acct_${process.pid}_${++seq}`;

describe("SyncManager.backfillOverSocket", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });

    let manager;
    let listener;

    beforeEach(() => {
        manager = new SyncManager({}, nextAccount());
        listener = new FakeListener();
    });

    it("asks for both DMs and groups, exactly once each", async () => {
        const done = manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        listener.deliver([], THREAD_USER);
        listener.deliver([], THREAD_GROUP);
        await done;

        assert.deepEqual(listener.requested.slice().sort(), [THREAD_USER, THREAD_GROUP]);
    });

    it("persists both batches into zalo.db and reports what it saved", async () => {
        const done = manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        listener.deliver([msg("m1", "t1"), msg("m2", "t1")], THREAD_USER);
        listener.deliver([msg("g1", "g100")], THREAD_GROUP);
        const res = await done;

        assert.equal(res.status, "backfilled");
        assert.equal(res.reason, "complete");
        assert.equal(res.total, 3);
        assert.equal(res.saved, 3);

        const dm = getMessages("t1", 10);
        assert.equal(dm.length, 2, "both DM rows should be queryable");
        assert.equal(getMessages("g100", 10).length, 1);
    });

    it("records the thread type so `conv recent` can order by real activity", async () => {
        const done = manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        listener.deliver([msg("m1", "t1")], THREAD_USER);
        listener.deliver([msg("g1", "g100")], THREAD_GROUP);
        await done;

        const threads = getRecentThreads(10);
        const byId = Object.fromEntries(threads.map((t) => [t.threadId ?? t.thread_id, t.type]));
        assert.equal(byId.t1, "dm");
        assert.equal(byId.g100, "group");
    });

    it("stops on the wait limit when only one thread type ever answers", async () => {
        const res = await manager.backfillOverSocket(listener, { timeoutMs: 150 });
        assert.equal(res.reason, "timeout");
        assert.equal(res.total, 0);
    });

    it("counts a partial answer rather than discarding it on timeout", async () => {
        const done = manager.backfillOverSocket(listener, { timeoutMs: 200 });
        listener.deliver([msg("only", "t9")], THREAD_USER);
        const res = await done;

        assert.equal(res.reason, "timeout");
        assert.equal(res.saved, 1, "messages already delivered must still be saved");
        assert.equal(getMessages("t9", 10).length, 1);
    });

    it("skips malformed records instead of throwing", async () => {
        const done = manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        listener.deliver([{ threadId: "t2" }, { data: { msgId: "x" } }, null, msg("ok", "t2")], THREAD_USER);
        listener.deliver([], THREAD_GROUP);
        const res = await done;

        assert.equal(res.total, 4, "every delivered record is counted");
        assert.equal(res.saved, 1, "only the well-formed one is written");
        assert.equal(getMessages("t2", 10).length, 1);
    });

    it("tolerates a non-array payload without rejecting", async () => {
        const done = manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        listener.deliver(undefined, THREAD_USER);
        listener.deliver([], THREAD_GROUP);
        const res = await done;

        assert.equal(res.status, "backfilled");
        assert.equal(res.total, 0);
    });

    it("reports request-failed when the socket refuses the request", async () => {
        listener.requestOldMessages = () => {
            throw new Error("socket closed");
        };
        const res = await manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        assert.equal(res.reason, "request-failed");
    });

    it("detaches its listener so a later event cannot double-count", async () => {
        const done = manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        listener.deliver([msg("m1", "t3")], THREAD_USER);
        listener.deliver([], THREAD_GROUP);
        const res = await done;

        assert.equal(listener.listenerCount("old_messages"), 0);
        listener.deliver([msg("late", "t3")], THREAD_USER);
        assert.equal(res.total, 1, "a late batch must not mutate a settled result");
    });
});

describe("SyncManager.backfillOverSocket writes the rows the listener writes", () => {
    // It used to carry its own copy of the listener's mapping, documented as
    // "the exact same field mapping", which stopped being true when listen
    // moved to live-store. The copy stored chat.photo as the row type, never
    // set has_attachment, and renamed a group after whoever posted in it.
    let manager;
    let listener;

    beforeEach(() => {
        manager = new SyncManager({}, nextAccount());
        listener = new FakeListener();
    });

    it("classifies a photo into the shared vocabulary, with its attachment flagged", async () => {
        const done = manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        listener.deliver(
            [
                msg("p1", "t1", {
                    msgType: "chat.photo",
                    content: { href: "https://photo-stal-3.zdn.vn/a.jpg", title: "a.jpg" },
                }),
            ],
            THREAD_USER,
        );
        listener.deliver([], THREAD_GROUP);
        await done;

        const [row] = getMessages("t1", 10);
        assert.equal(row.type, "photo", "not the raw live spelling chat.photo");
        assert.equal(row.has_attachment, 1, "sync-media must be able to find it");
    });

    it("does not name a group after the person who posted in it", async () => {
        const done = manager.backfillOverSocket(listener, { timeoutMs: 2000 });
        listener.deliver([], THREAD_USER);
        listener.deliver([msg("g1", "g100", { dName: "Some Member" })], THREAD_GROUP);
        await done;

        const t = getRecentThreads().find((x) => String(x.threadId) === "g100");
        assert.notEqual(t.name, "Some Member");
    });
});
