import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessageBuffer } from "./message-buffer.js";

/** Helper: create a message with a timestamp (default = now) */
function msg(text, timestamp = Date.now()) {
    return { text, timestamp };
}

describe("MessageBuffer constructor", () => {
    it("uses default maxSize=500 and maxAge=2h", () => {
        const buf = new MessageBuffer();
        assert.equal(buf._maxSize, 500);
        assert.equal(buf._maxAge, 2 * 60 * 60 * 1000);
    });

    it("accepts custom maxSize and maxAge", () => {
        const buf = new MessageBuffer(10, 5000);
        assert.equal(buf._maxSize, 10);
        assert.equal(buf._maxAge, 5000);
    });

    it("starts with empty threads and cursor at 0", () => {
        const buf = new MessageBuffer();
        assert.equal(buf._threads.size, 0);
        assert.equal(buf._globalCursor, 0);
    });
});

describe("MessageBuffer push + read", () => {
    it("push stores message and read returns it", () => {
        const buf = new MessageBuffer();
        buf.push("thread-1", msg("hello"));
        const { messages, cursor } = buf.read("thread-1");
        assert.equal(messages.length, 1);
        assert.equal(messages[0].text, "hello");
        assert.equal(cursor, 1);
    });

    it("multiple pushes to same thread are all returned", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("a"));
        buf.push("t1", msg("b"));
        buf.push("t1", msg("c"));
        const { messages } = buf.read("t1");
        assert.equal(messages.length, 3);
    });

    it("assigns monotonically increasing cursors", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("x"));
        buf.push("t1", msg("y"));
        const { messages } = buf.read("t1");
        assert.ok(messages[0]._cursor < messages[1]._cursor);
    });

    it("read without threadId returns messages from all threads", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("a"));
        buf.push("t2", msg("b"));
        const { messages } = buf.read();
        assert.equal(messages.length, 2);
    });

    it("read from non-existent thread returns empty array", () => {
        const buf = new MessageBuffer();
        const { messages, cursor } = buf.read("no-such-thread");
        assert.deepEqual(messages, []);
        assert.equal(cursor, 0);
    });
});

describe("MessageBuffer cursor-based incremental reads", () => {
    it("since parameter excludes already-seen messages", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("first"));
        const { cursor: c1 } = buf.read("t1");

        buf.push("t1", msg("second"));
        const { messages } = buf.read("t1", c1);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].text, "second");
    });

    it("since=cursor of last message returns empty array", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("only"));
        const { cursor } = buf.read("t1");
        const { messages } = buf.read("t1", cursor);
        assert.deepEqual(messages, []);
    });

    it("respects maxCount limit and sets hasMore=true", () => {
        const buf = new MessageBuffer();
        for (let i = 0; i < 5; i++) buf.push("t1", msg(`m${i}`));
        const { messages, hasMore } = buf.read("t1", 0, 3);
        assert.equal(messages.length, 3);
        assert.equal(hasMore, true);
    });

    it("hasMore=false when all messages fit", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("a"));
        buf.push("t1", msg("b"));
        const { hasMore } = buf.read("t1", 0, 20);
        assert.equal(hasMore, false);
    });
});

describe("MessageBuffer markRead", () => {
    it("discards messages at or before cursor and returns count", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("a"));
        buf.push("t1", msg("b"));
        const { cursor } = buf.read("t1");
        const discarded = buf.markRead(cursor);
        assert.equal(discarded, 2);
    });

    it("messages after cursor are kept", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("a"));
        const { cursor: c1 } = buf.read("t1");
        buf.push("t1", msg("b"));

        buf.markRead(c1);
        const { messages } = buf.read("t1");
        assert.equal(messages.length, 1);
        assert.equal(messages[0].text, "b");
    });

    it("double markRead at same cursor returns 0 on second call", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("a"));
        const { cursor } = buf.read("t1");
        buf.markRead(cursor);
        const second = buf.markRead(cursor);
        assert.equal(second, 0);
    });

    it("markRead across multiple threads discards from all", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("a"));
        buf.push("t2", msg("b"));
        const { cursor } = buf.read(); // reads all
        const discarded = buf.markRead(cursor);
        assert.equal(discarded, 2);
    });
});

describe("MessageBuffer eviction by maxSize", () => {
    it("oldest messages are evicted when maxSize exceeded", () => {
        const buf = new MessageBuffer(3, 99999999);
        for (let i = 1; i <= 5; i++) buf.push("t1", msg(`m${i}`));
        const { messages } = buf.read("t1");
        assert.equal(messages.length, 3);
        // Newest 3 kept
        assert.equal(messages[0].text, "m3");
        assert.equal(messages[2].text, "m5");
    });
});

describe("MessageBuffer eviction by maxAge", () => {
    it("stale messages are removed after maxAge expires", async () => {
        const buf = new MessageBuffer(500, 50); // 50ms maxAge
        buf.push("t1", { text: "old", timestamp: Date.now() });

        await new Promise((r) => setTimeout(r, 80)); // wait for expiry

        // Trigger eviction by pushing another message
        buf.push("t1", { text: "new", timestamp: Date.now() });

        const { messages } = buf.read("t1");
        assert.equal(messages.length, 1);
        assert.equal(messages[0].text, "new");
    });

    it("thread is removed when all messages evicted by age", async () => {
        const buf = new MessageBuffer(500, 30); // 30ms maxAge
        buf.push("t1", { text: "gone", timestamp: Date.now() });

        await new Promise((r) => setTimeout(r, 60));

        // Push to a different thread to avoid triggering eviction on t1
        buf.push("t2", { text: "trigger", timestamp: Date.now() });

        // t1 still has stale message but won't be cleaned unless _evict("t1") runs
        // Push to t1 to trigger cleanup
        buf.push("t1", { text: "trigger-clean", timestamp: Date.now() });

        const { messages } = buf.read("t1");
        // Only new message should remain
        assert.equal(messages.length, 1);
        assert.equal(messages[0].text, "trigger-clean");
    });
});

describe("MessageBuffer multi-thread isolation", () => {
    it("messages in different threads are independent", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("from-t1"));
        buf.push("t2", msg("from-t2"));

        const r1 = buf.read("t1");
        const r2 = buf.read("t2");

        assert.equal(r1.messages.length, 1);
        assert.equal(r1.messages[0].text, "from-t1");
        assert.equal(r2.messages.length, 1);
        assert.equal(r2.messages[0].text, "from-t2");
    });

    it("markRead on shared cursor only keeps messages after it in each thread", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("t1-a"));
        const { cursor: midCursor } = buf.read();
        buf.push("t2", msg("t2-b")); // cursor after midCursor

        buf.markRead(midCursor);

        const r1 = buf.read("t1");
        const r2 = buf.read("t2");
        assert.equal(r1.messages.length, 0);
        assert.equal(r2.messages.length, 1);
    });
});

describe("MessageBuffer getStats", () => {
    it("returns unread/total/lastActivity per thread", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("a"));
        buf.push("t1", msg("b"));
        buf.push("t2", msg("c"));

        const stats = buf.getStats(0);
        assert.equal(stats.length, 2);

        const t1 = stats.find((s) => s.threadId === "t1");
        assert.ok(t1);
        assert.equal(t1.total, 2);
        assert.equal(t1.unread, 2);
        assert.ok(typeof t1.lastActivity === "number");
    });

    it("respects readCursor when computing unread count", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("a"));
        const { cursor } = buf.read("t1");
        buf.push("t1", msg("b")); // unread

        const stats = buf.getStats(cursor);
        const t1 = stats.find((s) => s.threadId === "t1");
        assert.equal(t1.unread, 1);
        assert.equal(t1.total, 2);
    });

    it("excludes threads with no messages", () => {
        const buf = new MessageBuffer(500, 999999);
        buf.push("t1", msg("a"));
        const { cursor } = buf.read("t1");
        buf.markRead(cursor); // discards all messages

        const stats = buf.getStats(0);
        assert.equal(stats.length, 0);
    });
});

describe("MessageBuffer getThreadType", () => {
    it("returns threadType from first buffered message", () => {
        const buf = new MessageBuffer();
        buf.push("t1", { text: "hi", threadType: "dm", timestamp: Date.now() });
        buf.push("t1", { text: "hey", threadType: "dm", timestamp: Date.now() });
        assert.equal(buf.getThreadType("t1"), "dm");
    });

    it("returns null for unknown thread", () => {
        const buf = new MessageBuffer();
        assert.equal(buf.getThreadType("nonexistent"), null);
    });

    it("returns null when thread exists but messages have no threadType", () => {
        const buf = new MessageBuffer();
        buf.push("t1", { text: "hi", timestamp: Date.now() });
        assert.equal(buf.getThreadType("t1"), null);
    });

    it("returns group for group thread", () => {
        const buf = new MessageBuffer();
        buf.push("g1", { text: "hello", threadType: "group", timestamp: Date.now() });
        assert.equal(buf.getThreadType("g1"), "group");
    });
});

describe("MessageBuffer edge cases", () => {
    it("empty read on fresh buffer returns empty array and cursor 0", () => {
        const buf = new MessageBuffer();
        const { messages, cursor } = buf.read("nowhere");
        assert.deepEqual(messages, []);
        assert.equal(cursor, 0);
    });

    it("global cursor increments across different threads", () => {
        const buf = new MessageBuffer();
        buf.push("t1", msg("x"));
        buf.push("t2", msg("y"));
        assert.equal(buf._globalCursor, 2);
    });
});
