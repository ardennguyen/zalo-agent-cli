/**
 * Batch pull: `limit` and `settleMs` on every way of waiting for messages (the buffer, GET /events/wait,
 * the zalo_wait_for_message tool, `mcp wait` over the daemon channel). Before this a call returned one
 * message, so a bot behind a busy account made one round trip per message.
 *
 * The contract kept: with no `limit` the reply is what it always was, plus `messages`, `count`, `hasMore`.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { MessageBuffer } from "../../src/mcp/message-buffer.js";
import { MAX_BATCH, MAX_SETTLE_MS, batchParams, waitResult } from "../../src/mcp/wait-result.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { startDaemonChannel, waitViaDaemon } from "../../src/core/daemon-channel.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

// A real timestamp: the buffer evicts anything older than its max age, and 1970 is older.
const msg = (n, threadId = "t1") => ({ id: `m${n}`, threadId, text: `hello ${n}`, timestamp: Date.now() });
const fill = (buf, n, threadId = "t1") => {
    for (let i = 1; i <= n; i++) buf.push(threadId, msg(i, threadId));
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe("batchParams", () => {
    it("clamps to 1..100 messages and 0..5000 ms, and falls back on anything unusable", () => {
        assert.deepEqual(batchParams(), { limit: 1, settleMs: 0 });
        assert.deepEqual(batchParams({ limit: 25, settleMs: 200 }), { limit: 25, settleMs: 200 });
        assert.deepEqual(
            batchParams({ limit: "30", settleMs: "300" }),
            { limit: 30, settleMs: 300 },
            "query strings are text",
        );
        assert.deepEqual(batchParams({ limit: 5000, settleMs: 999999 }), { limit: MAX_BATCH, settleMs: MAX_SETTLE_MS });
        assert.deepEqual(batchParams({ limit: 2.9 }), { limit: 2, settleMs: 0 });
        for (const bad of [0, -3, NaN, "many", null, undefined, Infinity]) {
            assert.equal(batchParams({ limit: bad }).limit, 1, String(bad));
        }
        for (const bad of [0, -1, NaN, "soon", null])
            assert.equal(batchParams({ settleMs: bad }).settleMs, 0, String(bad));
    });
});

describe("waitResult", () => {
    it("a timeout is an empty list with the cursor to carry on from", () => {
        assert.deepEqual(waitResult({ messages: [], cursorWhenEmpty: 7 }), {
            status: "timeout",
            message: null,
            messages: [],
            count: 0,
            hasMore: false,
            cursor: 7,
        });
    });

    it("a batch has the first message as `message` and the LAST cursor as `cursor`", () => {
        const r = waitResult({
            messages: [
                { id: "a", _cursor: 4 },
                { id: "b", _cursor: 5 },
                { id: "c", _cursor: 9 },
            ],
            hasMore: true,
            cursorWhenEmpty: 0,
            decorate: (m) => ({ ...m, threadName: "G" }),
        });
        assert.deepEqual([r.status, r.count, r.cursor, r.hasMore], ["message", 3, 9, true]);
        assert.equal(r.message.id, "a");
        assert.deepEqual(
            r.messages.map((m) => m.threadName),
            ["G", "G", "G"],
        );
    });

    it("hasMore is never true on an empty reply", () => {
        assert.equal(waitResult({ messages: [], hasMore: true, cursorWhenEmpty: 0 }).hasMore, false);
    });
});

describe("MessageBuffer.waitForMessages", () => {
    let buf;
    beforeEach(() => {
        buf = new MessageBuffer();
    });

    it("returns buffered messages after `since` up to the limit, in cursor order, across threads, and says more wait", async () => {
        buf.push("a", msg(1, "a"));
        buf.push("b", msg(2, "b"));
        buf.push("a", msg(3, "a"));
        buf.push("b", msg(4, "b"));
        const r = await buf.waitForMessages({ since: 0, limit: 3, timeoutMs: 1000 });
        assert.deepEqual(
            r.messages.map((m) => m.id),
            ["m1", "m2", "m3"],
        );
        assert.equal(r.hasMore, true);
        const rest = await buf.waitForMessages({ since: r.messages[2]._cursor, limit: 3, timeoutMs: 1000 });
        assert.deepEqual(
            rest.messages.map((m) => m.id),
            ["m4"],
        );
        assert.equal(rest.hasMore, false);
    });

    it("a thread filter returns only that thread's messages", async () => {
        buf.push("a", msg(1, "a"));
        buf.push("b", msg(2, "b"));
        buf.push("a", msg(3, "a"));
        const r = await buf.waitForMessages({ threadId: "a", since: 0, limit: 10, timeoutMs: 1000 });
        assert.deepEqual(
            r.messages.map((m) => m.id),
            ["m1", "m3"],
        );
    });

    it("limit 1 is exactly what waitForMessage always returned", async () => {
        fill(buf, 3);
        const one = await buf.waitForMessage({ since: 0, timeoutMs: 1000 });
        const batch = await buf.waitForMessages({ since: 0, timeoutMs: 1000 });
        assert.equal(one.id, "m1");
        assert.deepEqual(batch.messages, [one]);
        assert.equal(batch.hasMore, true);
    });

    it("with no `since` it waits for the next message and returns it", async () => {
        fill(buf, 2); // already buffered: not returned without `since`
        const p = buf.waitForMessages({ limit: 5, timeoutMs: 2000 });
        await delay(20);
        buf.push("t1", msg(3));
        const r = await p;
        assert.deepEqual(
            r.messages.map((m) => m.id),
            ["m3"],
        );
    });

    it("messages that arrive together with the first come back with it", async () => {
        const p = buf.waitForMessages({ limit: 5, timeoutMs: 2000 });
        await delay(20);
        buf.push("t1", msg(1));
        buf.push("t1", msg(2));
        buf.push("t1", msg(3));
        const r = await p;
        assert.deepEqual(
            r.messages.map((m) => m.id),
            ["m1", "m2", "m3"],
        );
    });

    it("settleMs gives a burst time to land; without it only what is already there is returned", async () => {
        // limit 3 and a long settle: it returns when the third arrives, however late a loaded machine makes that.
        const settled = buf.waitForMessages({ limit: 3, settleMs: 5000, timeoutMs: 2000 });
        await delay(20);
        buf.push("t1", msg(1));
        await delay(60);
        buf.push("t1", msg(2));
        await delay(60);
        buf.push("t1", msg(3));
        assert.deepEqual(
            (await settled).messages.map((m) => m.id),
            ["m1", "m2", "m3"],
        );

        const buf2 = new MessageBuffer();
        const quick = buf2.waitForMessages({ limit: 5, timeoutMs: 2000 });
        await delay(20);
        buf2.push("t1", msg(1));
        await delay(60);
        buf2.push("t1", msg(2));
        assert.deepEqual(
            (await quick).messages.map((m) => m.id),
            ["m1"],
        );
    });

    it("a burst that fills the batch ends the settle at once, instead of waiting it out", async () => {
        const p = buf.waitForMessages({ limit: 3, settleMs: 5000, timeoutMs: 2000 });
        await delay(20);
        const t0 = Date.now();
        buf.push("t1", msg(1));
        buf.push("t1", msg(2));
        buf.push("t1", msg(3));
        const r = await p;
        assert.deepEqual(
            r.messages.map((m) => m.id),
            ["m1", "m2", "m3"],
        );
        assert.ok(Date.now() - t0 < 2000, "the 5 s settle was not waited out");
    });

    it("settleMs also applies to messages already buffered, but not once the limit is reached", async () => {
        fill(buf, 2);
        const t0 = Date.now();
        const p = buf.waitForMessages({ since: 0, limit: 3, settleMs: 5000, timeoutMs: 2000 });
        await delay(60);
        buf.push("t1", msg(3));
        const r = await p;
        assert.deepEqual(
            r.messages.map((m) => m.id),
            ["m1", "m2", "m3"],
        );
        assert.ok(Date.now() - t0 >= 50, "it waited for the third message instead of returning the two already there");

        const full = new MessageBuffer();
        fill(full, 3);
        const t1 = Date.now();
        const rf = await full.waitForMessages({ since: 0, limit: 3, settleMs: 2000, timeoutMs: 5000 });
        assert.equal(rf.messages.length, 3);
        assert.ok(Date.now() - t1 < 1000, "a full batch does not wait for company");
    });

    it("times out empty, and an abort ends the wait at once", async () => {
        const t = await buf.waitForMessages({ since: 0, limit: 5, timeoutMs: 80 });
        assert.deepEqual(t, { messages: [], hasMore: false });

        const ac = new AbortController();
        const p = buf.waitForMessages({ limit: 5, timeoutMs: 30_000, signal: ac.signal });
        setTimeout(() => ac.abort(), 30);
        const t0 = Date.now();
        assert.deepEqual(await p, { messages: [], hasMore: false });
        assert.ok(Date.now() - t0 < 1000);
        assert.deepEqual(await buf.waitForMessages({ signal: AbortSignal.abort(), timeoutMs: 5000 }), {
            messages: [],
            hasMore: false,
        });
    });

    it("an abort during the settle window still returns what arrived", async () => {
        const ac = new AbortController();
        const p = buf.waitForMessages({ limit: 5, settleMs: 5000, timeoutMs: 2000, signal: ac.signal });
        await delay(20);
        buf.push("t1", msg(1));
        await delay(20);
        const t0 = Date.now();
        ac.abort();
        const r = await p;
        assert.deepEqual(
            r.messages.map((m) => m.id),
            ["m1"],
        );
        assert.ok(Date.now() - t0 < 1000, "the settle was cut short, not waited out");
    });
});

describe("GET /events/wait", () => {
    const servers = [];
    after(() => servers.forEach((s) => s.close()));

    async function start(buffer) {
        const deps = { api: {}, buffer, filter: {}, config: {}, nameCache: null, accountDir: "." };
        const server = createHTTPServer(() => {}, deps, 0, "T0KEN", "127.0.0.1");
        servers.push(server);
        if (!server.listening) await once(server, "listening");
        return `http://127.0.0.1:${server.address().port}`;
    }
    const get = async (base, qs) =>
        (await fetch(`${base}/events/wait?${qs}`, { headers: { Authorization: "Bearer T0KEN" } })).json();

    it("without `limit` the reply is the old one plus messages, count and hasMore", async () => {
        const buf = new MessageBuffer();
        fill(buf, 3);
        const r = await get(await start(buf), "since=0&timeout=2");
        assert.equal(r.status, "message");
        assert.equal(r.message.id, "m1");
        assert.equal(r.cursor, r.message._cursor, "cursor is the message's own, as before");
        assert.deepEqual([r.count, r.hasMore, r.messages.length], [1, true, 1]);
    });

    it("`limit` returns a batch, `cursor` is the last one, and a drain loop gets everything exactly once", async () => {
        const buf = new MessageBuffer();
        fill(buf, 7);
        const base = await start(buf);
        const seen = [];
        let since = 0;
        let calls = 0;
        for (;;) {
            const r = await get(base, `since=${since}&limit=3&timeout=1`);
            calls++;
            if (r.status !== "message") break;
            seen.push(...r.messages.map((m) => m.id));
            since = r.cursor;
            if (!r.hasMore) break;
        }
        assert.deepEqual(seen, ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
        assert.equal(calls, 3, "seven messages in three calls instead of seven");
    });

    it("an unusable or oversized limit is clamped, never an error", async () => {
        const buf = new MessageBuffer();
        fill(buf, 5);
        const base = await start(buf);
        assert.equal((await get(base, "since=0&limit=abc&timeout=1")).count, 1);
        assert.equal((await get(base, "since=0&limit=0&timeout=1")).count, 1);
        assert.equal((await get(base, "since=0&limit=-4&timeout=1")).count, 1);
        assert.equal((await get(base, "since=0&limit=100000&timeout=1")).count, 5);
    });

    it("`settle` collects a burst into one reply", async () => {
        const buf = new MessageBuffer();
        const base = await start(buf);
        // limit 2 with a long settle: it returns when the second arrives, however late a loaded machine makes that.
        const p = get(base, "limit=2&settle=5000&timeout=3");
        await delay(50);
        buf.push("t1", msg(1));
        await delay(60);
        buf.push("t1", msg(2));
        const r = await p;
        assert.deepEqual(
            r.messages.map((m) => m.id),
            ["m1", "m2"],
        );
    });

    it("a timeout is empty and carries the cursor", async () => {
        const buf = new MessageBuffer();
        fill(buf, 2);
        buf.markRead(2);
        const r = await get(await start(buf), "since=2&limit=5&timeout=1");
        assert.deepEqual([r.status, r.message, r.messages, r.count, r.hasMore], ["timeout", null, [], 0, false]);
        assert.equal(r.cursor, 2);
    });
});

describe("zalo_wait_for_message", () => {
    function tool(buffer) {
        const tools = new Map();
        const server = { registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
        registerTools(
            server,
            {},
            buffer,
            { isWatched: () => true },
            { limits: { maxMessagesPerPoll: 20 } },
            { ready: true, get: (id) => (id === "t1" ? { name: "Team", type: "group" } : null), search: () => [] },
            undefined,
        );
        return {
            server,
            tools,
            call: async (args) => JSON.parse((await tools.get("zalo_wait_for_message").handler(args)).content[0].text),
        };
    }

    it("returns a batch, each message with its thread name, and the last cursor", async () => {
        const buf = new MessageBuffer();
        fill(buf, 4);
        const { call } = tool(buf);
        const r = await call({ since: 0, timeoutSec: 2, limit: 3 });
        assert.deepEqual([r.status, r.count, r.hasMore], ["message", 3, true]);
        assert.deepEqual(
            r.messages.map((m) => m.threadName),
            ["Team", "Team", "Team"],
        );
        assert.equal(r.cursor, r.messages[2]._cursor);
        assert.equal(r.message.id, "m1");
        const rest = await call({ since: r.cursor, timeoutSec: 2, limit: 3 });
        assert.deepEqual([rest.count, rest.hasMore], [1, false]);
    });

    it("with no limit it is one message, as before", async () => {
        const buf = new MessageBuffer();
        fill(buf, 2);
        const r = await tool(buf).call({ since: 0, timeoutSec: 2 });
        assert.equal(r.count, 1);
        assert.equal(r.message.id, "m1");
    });

    it("declares limit and settleMs with their bounds, so a client is refused before the server clamps", () => {
        const { tools } = tool(new MessageBuffer());
        const schema = tools.get("zalo_wait_for_message").meta.inputSchema;
        const ok = (args) => schema.safeParse(args).success;
        assert.equal(ok({ limit: 100, settleMs: 5000 }), true);
        assert.equal(ok({ limit: 101 }), false);
        assert.equal(ok({ limit: 0 }), false);
        assert.equal(ok({ limit: 1.5 }), false);
        assert.equal(ok({ settleMs: 5001 }), false);
        assert.equal(ok({ settleMs: -1 }), false);
        assert.deepEqual(
            [schema.parse({}).limit, schema.parse({}).settleMs],
            [1, 0],
            "left out, a call is the single-message call it always was",
        );
    });
});

describe("mcp wait over the daemon channel", () => {
    let dir;
    const started = [];
    before(() => {
        dir = mkdtempSync(join(tmpdir(), "zalo-batch-chan-"));
    });
    after(() => {
        started.forEach((c) => c.stop());
        rmSync(dir, { recursive: true, force: true });
    });

    it("passes limit and settleMs to the daemon and returns the batch", async () => {
        const seen = [];
        const chan = await startDaemonChannel({
            getApi: () => ({}),
            accountDir: dir,
            onWait: async (params) => {
                seen.push(params);
                return waitResult({
                    messages: [
                        { id: "a", _cursor: 1 },
                        { id: "b", _cursor: 2 },
                    ],
                    hasMore: true,
                    cursorWhenEmpty: 0,
                });
            },
        });
        started.push(chan);
        const r = await waitViaDaemon(dir, { since: 0, timeoutSec: 2, limit: 10, settleMs: 150 });
        assert.equal(r.ok, true);
        assert.deepEqual([r.count, r.hasMore, r.cursor], [2, true, 2]);
        assert.deepEqual(
            r.messages.map((m) => m.id),
            ["a", "b"],
        );
        assert.equal(r.message.id, "a");
        assert.deepEqual([seen[0].limit, seen[0].settleMs], [10, 150]);
    });

    it("a daemon older than batching answers with one `message`, which still reads as a batch of one", async () => {
        const old = mkdtempSync(join(tmpdir(), "zalo-batch-old-"));
        const chan = await startDaemonChannel({
            getApi: () => ({}),
            accountDir: old,
            onWait: async () => ({ status: "message", message: { id: "x", _cursor: 5 }, cursor: 5 }),
        });
        started.push(chan);
        const r = await waitViaDaemon(old, { since: 0, timeoutSec: 2, limit: 10 });
        assert.deepEqual([r.ok, r.count, r.hasMore], [true, 1, false]);
        assert.deepEqual(
            r.messages.map((m) => m.id),
            ["x"],
        );
        rmSync(old, { recursive: true, force: true });
    });
});
