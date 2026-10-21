/**
 * The durable webhook outbox: what survives a restart, what order events leave in, what happens
 * when the receiver is down, slow or rejects a payload, and what the status says about it.
 *
 * The delivery tests drive the dispatcher with a fake clock and a fake fetch (no sleeping), plus one
 * pair against a real HTTP server so the real fetch, headers and signature are exercised too.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    startWebhookDelivery,
    backoffMs,
    createWebhookDispatcher,
    describeWebhookUrl,
    openOutbox,
    outboxPath,
    webhookHeaders,
} from "../../src/core/webhook-outbox.js";
import { verifyWebhook } from "../../docs/config-samples/clients/crm-webhook-receiver.mjs";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

let dir;
let clock;
let outbox;
let logs;
const now = () => clock;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zalo-outbox-"));
    clock = 1_000_000;
    logs = [];
    outbox = openOutbox(dir, { now });
});
afterEach(() => {
    outbox.close();
    rmSync(dir, { recursive: true, force: true });
});

const ev = (n, extra = {}) => JSON.stringify({ event: "message", accountId: "A", id: `m${n}`, ...extra });
const queue = (...ns) => ns.forEach((n) => outbox.enqueue(`message:m${n}`, ev(n)));

/** A fetch that records every POST and answers from `reply(call)`. */
function fakeFetch(reply = () => 200) {
    const calls = [];
    const fn = async (url, init) => {
        const call = { url, headers: init.headers, body: init.body, signal: init.signal };
        calls.push(call);
        const r = await reply(call, calls.length);
        if (r instanceof Error) throw r;
        return { status: r };
    };
    fn.calls = calls;
    return fn;
}

/** A dispatcher whose timers never fire by themselves; tests call drain() and move `clock`. */
function dispatcher(fetchFn, options = {}) {
    return createWebhookDispatcher({
        outbox,
        url: "https://crm.example.com/hook?token=SECRET_IN_QUERY",
        accountId: "A",
        fetchFn,
        now,
        random: () => 0.5,
        setTimer: () => ({ unref() {} }),
        clearTimer: () => {},
        log: (line) => logs.push(line),
        ...options,
    });
}
const ids = (calls) => calls.flatMap((c) => (JSON.parse(c.body).events ?? [JSON.parse(c.body)]).map((e) => e.id));

describe("outbox storage", () => {
    it("an event is on disk before anything tries to send it, and survives a restart", () => {
        queue(1, 2);
        outbox.close();
        const reopened = openOutbox(dir, { now });
        assert.deepEqual(
            reopened.head(10).map((r) => JSON.parse(r.body).id),
            ["m1", "m2"],
        );
        reopened.close();
    });

    it("the same event key waiting twice is stored once; events without a key never collapse", () => {
        assert.equal(outbox.enqueue("message:m1", ev(1)).queued, true);
        assert.equal(outbox.enqueue("message:m1", ev(1)).queued, false, "a catch-up repeat of a queued message");
        outbox.enqueue(null, ev(2));
        outbox.enqueue(null, ev(2));
        assert.equal(outbox.stats().pending, 3);
    });

    it("a delivered event leaves the table and is counted", () => {
        queue(1, 2);
        const [first] = outbox.head(1);
        outbox.markDelivered([first.seq]);
        const s = outbox.stats();
        assert.equal(s.pending, 1);
        assert.equal(s.deliveredTotal, 1);
        assert.equal(s.lastSuccessAt, clock);
    });

    it("a read-only handle reads a live outbox and refuses to create a missing one", () => {
        queue(1);
        const ro = openOutbox(dir, { readonly: true });
        assert.equal(ro.stats().pending, 1);
        ro.close();
        assert.throws(() => openOutbox(join(dir, "nowhere"), { readonly: true }));
    });

    it("lives in its own file, not in zalo.db", () => {
        assert.match(outboxPath(dir), /webhook-outbox\.db$/);
    });
});

describe("delivery", () => {
    it("sends the stored body unchanged, signed, and deletes the row on 2xx", async () => {
        queue(1);
        const f = fakeFetch();
        const d = dispatcher(f, { secret: "CHANGE_ME_S" });
        await d.drain();
        assert.equal(f.calls.length, 1);
        const [call] = f.calls;
        assert.equal(call.body, ev(1), "single events keep the pre-outbox body byte for byte");
        assert.equal(
            verifyWebhook(
                call.body,
                Object.fromEntries(Object.entries(call.headers).map(([k, v]) => [k.toLowerCase(), v])),
                "CHANGE_ME_S",
            ),
            true,
        );
        assert.equal(call.headers["Authorization"], "Bearer CHANGE_ME_S");
        assert.equal(call.headers["X-Zalo-Attempt"], "1");
        assert.match(call.headers["X-Zalo-Delivery"], /^\d+-\d+$/);
        assert.equal(outbox.stats().pending, 0);
    });

    it("an unsigned webhook sends no signature", () => {
        assert.deepEqual(Object.keys(webhookHeaders("{}", null)), ["Content-Type"]);
        assert.deepEqual(Object.keys(webhookHeaders("{}", "  ")), ["Content-Type"]);
    });

    it("a receiver that is down keeps the event, and nothing is retried before its backoff", async () => {
        queue(1);
        const f = fakeFetch(() => new Error("connect ECONNREFUSED"));
        const d = dispatcher(f);
        await d.drain();
        assert.equal(f.calls.length, 1);
        assert.equal(outbox.stats().pending, 1);
        assert.equal(outbox.head(1)[0].attempts, 1);
        assert.match(outbox.stats().lastError, /ECONNREFUSED/);
        const wait = d.status().nextAttemptAt - clock;
        assert.ok(wait >= 800 && wait <= 1200, `first backoff is about 1 s, was ${wait}`);

        await d.drain();
        assert.equal(f.calls.length, 1, "still inside the backoff: no second POST");
        clock += wait;
        await d.drain();
        assert.equal(f.calls.length, 2, "past the backoff it tries again");
    });

    it("events leave in order, and a failing head holds back everything behind it", async () => {
        queue(1, 2, 3);
        let healthy = false;
        const f = fakeFetch(() => (healthy ? 200 : 503));
        const d = dispatcher(f);
        await d.drain();
        assert.deepEqual(ids(f.calls), ["m1"], "only the head was tried; m2 and m3 did not overtake it");
        healthy = true;
        clock += 10_000;
        await d.drain();
        assert.deepEqual(ids(f.calls), ["m1", "m1", "m2", "m3"]);
        assert.equal(outbox.stats().pending, 0);
        assert.equal(outbox.stats().deliveredTotal, 3);
    });

    it("an outage that outlasts a restart is delivered after it", async () => {
        queue(1, 2);
        await dispatcher(fakeFetch(() => 500)).drain();
        outbox.close();
        outbox = openOutbox(dir, { now });
        const f = fakeFetch();
        const d = dispatcher(f);
        d.start();
        clock += 10_000;
        await d.drain();
        assert.deepEqual(ids(f.calls), ["m1", "m2"]);
        assert.ok(
            logs.some((l) => /2 queued/.test(l)),
            "start says what it found waiting",
        );
    });

    it("backoff grows with consecutive failures and is capped", () => {
        const mid = () => 0.5;
        assert.deepEqual(
            [1, 2, 3, 4].map((n) => backoffMs(n, mid)),
            [1000, 2000, 4000, 8000],
        );
        assert.equal(backoffMs(40, mid), 300_000, "capped at 5 minutes");
        assert.ok(backoffMs(3, () => 0) >= 3200 && backoffMs(3, () => 1) <= 4800, "+/-20% jitter");
    });

    it("a receiver that hangs is cut at the timeout and counted as a failure", async () => {
        queue(1);
        const hang = (url, init) =>
            new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
        const d = createWebhookDispatcher({
            outbox,
            url: "https://crm.example.com/h",
            fetchFn: hang,
            timeoutMs: 20,
            now,
            log: (l) => logs.push(l),
        });
        // The dispatcher's timers are unref'd (they must not hold a daemon open), and this fetch has no socket:
        // without a ref'd handle the event loop drains while the test is still awaiting the timeout.
        const keepAlive = setInterval(() => {}, 1000);
        try {
            await d.drain();
        } finally {
            clearInterval(keepAlive);
        }
        assert.equal(outbox.stats().pending, 1);
        assert.match(outbox.stats().lastError, /timed out after 20 ms/);
        await d.stop();
    });

    it("failures are logged once a minute, not once per attempt, and recovery is announced", async () => {
        queue(1);
        let healthy = false;
        const f = fakeFetch(() => (healthy ? 200 : 502));
        const d = dispatcher(f);
        for (let i = 0; i < 4; i++) {
            await d.drain();
            clock += 20_000;
        }
        const failureLogs = logs.filter((l) => /delivery failed/.test(l));
        assert.ok(failureLogs.length >= 1 && failureLogs.length <= 2, `got ${failureLogs.length}: ${failureLogs}`);
        assert.match(failureLogs[0], /HTTP 502/);
        healthy = true;
        clock += 400_000;
        await d.drain();
        assert.ok(logs.some((l) => /receiver is back/.test(l)));
    });
});

describe("batching", () => {
    it("sends batchSize events per POST as one signed batch, and a lone remainder as a plain event", async () => {
        queue(1, 2, 3, 4, 5, 6, 7);
        const f = fakeFetch();
        const d = dispatcher(f, { batchSize: 3, secret: "CHANGE_ME_S" });
        await d.drain();
        assert.deepEqual(
            f.calls.map((c) => (JSON.parse(c.body).events ?? [1]).length),
            [3, 3, 1],
        );
        const batch = JSON.parse(f.calls[0].body);
        assert.deepEqual(
            { event: batch.event, accountId: batch.accountId, count: batch.count },
            { event: "batch", accountId: "A", count: 3 },
        );
        assert.deepEqual(ids(f.calls), ["m1", "m2", "m3", "m4", "m5", "m6", "m7"], "order is kept across batches");
        assert.equal(f.calls[2].body, ev(7), "a batch of one is the plain event");
        const headers = Object.fromEntries(Object.entries(f.calls[0].headers).map(([k, v]) => [k.toLowerCase(), v]));
        assert.equal(
            verifyWebhook(f.calls[0].body, headers, "CHANGE_ME_S"),
            true,
            "the signature covers the batch body",
        );
        assert.equal(outbox.stats().pending, 0);
    });

    it("a backlog drains in full batches after an outage", async () => {
        for (let i = 1; i <= 25; i++) queue(i);
        const f = fakeFetch();
        await dispatcher(f, { batchSize: 10 }).drain();
        assert.deepEqual(
            f.calls.map((c) => JSON.parse(c.body).count ?? 1),
            [10, 10, 5],
        );
    });

    it("a batch is waited for briefly when batching is on, and sent at once when it is off", () => {
        const delays = [];
        const on = dispatcher(fakeFetch(), {
            batchSize: 5,
            batchWindowMs: 250,
            setTimer: (fn, ms) => (delays.push(ms), { unref() {} }),
        });
        on.notify();
        const off = dispatcher(fakeFetch(), { batchSize: 1, setTimer: (fn, ms) => (delays.push(ms), { unref() {} }) });
        off.notify();
        assert.deepEqual(delays, [250, 0]);
    });
});

describe("a payload the receiver refuses", () => {
    for (const code of [400, 413, 422]) {
        it(`HTTP ${code} on a single event dead-letters it and the queue moves on`, async () => {
            queue(1, 2);
            const f = fakeFetch((c) => (JSON.parse(c.body).id === "m1" ? code : 200));
            await dispatcher(f).drain();
            const s = outbox.stats();
            assert.equal(s.pending, 0);
            assert.equal(s.dead, 1);
            assert.equal(outbox.list({ status: "dead" })[0].seq, 1);
            assert.match(outbox.list({ status: "dead" })[0].last_error, new RegExp(`HTTP ${code}`));
            assert.deepEqual(ids(f.calls), ["m1", "m2"]);
        });
    }

    it("a refused batch is split so one bad event does not take its neighbors with it", async () => {
        queue(1, 2, 3);
        outbox.enqueue("message:poison", ev(99, { text: "poison" }));
        queue(4);
        const f = fakeFetch((c) => (c.body.includes("poison") ? 422 : 200));
        await dispatcher(f, { batchSize: 10 }).drain();
        const s = outbox.stats();
        assert.equal(s.pending, 0);
        assert.equal(s.dead, 1);
        assert.equal(JSON.parse(outbox.list({ status: "dead" })[0].body).id, "m99");
        assert.equal(s.deliveredTotal, 4);
    });

    it("401 and 5xx are not 'refused': a wrong secret or a sick receiver keeps its events", async () => {
        queue(1);
        for (const code of [401, 403, 404, 500, 502, 503, 429]) {
            clock += 400_000;
            await dispatcher(fakeFetch(() => code)).drain();
            assert.equal(outbox.stats().pending, 1, `HTTP ${code}`);
            assert.equal(outbox.stats().dead, 0, `HTTP ${code}`);
        }
    });

    it("dead letters can be put back, one or all, and then deliver", async () => {
        queue(1, 2);
        outbox.markDead([1, 2], "test");
        assert.equal(outbox.retryDead({ seq: 1 }), 1);
        assert.equal(outbox.stats().pending, 1);
        assert.equal(outbox.retryDead(), 1);
        const f = fakeFetch();
        await dispatcher(f).drain();
        assert.deepEqual(ids(f.calls), ["m1", "m2"]);
    });

    it("dead letters can be purged, one or all", () => {
        queue(1, 2, 3);
        outbox.markDead([1, 2, 3], "test");
        assert.equal(outbox.purgeDead({ seq: 2 }), 1);
        assert.equal(outbox.purgeDead(), 2);
        assert.equal(outbox.stats().dead, 0);
    });
});

describe("retention", () => {
    it("an event older than maxAge is dead-lettered, not dropped and not sent", async () => {
        queue(1);
        clock += 25 * 3600_000;
        queue(2);
        const f = fakeFetch();
        await dispatcher(f, { maxAgeMs: 24 * 3600_000 }).drain();
        assert.deepEqual(ids(f.calls), ["m2"]);
        const dead = outbox.list({ status: "dead" });
        assert.equal(dead.length, 1);
        assert.match(dead[0].last_error, /expired/);
        assert.ok(logs.some((l) => /dead-lettered/.test(l)));
    });
});

describe("status", () => {
    it("shows the backlog without leaking the URL's query string or the secret", async () => {
        queue(1, 2);
        clock += 5000;
        const d = dispatcher(
            fakeFetch(() => 503),
            { secret: "CHANGE_ME_S", batchSize: 4 },
        );
        await d.drain();
        const s = d.status();
        assert.equal(s.url, "https://crm.example.com/hook");
        assert.equal(s.signed, true);
        assert.equal(s.batchSize, 4);
        assert.equal(s.pending, 2);
        assert.equal(s.consecutiveFailures, 1);
        assert.equal(s.lastStatus, 503);
        assert.equal(s.oldestPendingAgeMs, 5000);
        assert.ok(s.nextAttemptAt > clock);
        assert.doesNotMatch(JSON.stringify(s), /SECRET/);
    });

    it("describeWebhookUrl tolerates garbage", () => {
        assert.equal(describeWebhookUrl("not a url"), "(invalid URL)");
    });
});

describe("shutdown", () => {
    it("stop() cuts an in-flight POST after the grace period and leaves the event queued", async () => {
        queue(1);
        const hang = (url, init) =>
            new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
        const d = createWebhookDispatcher({
            outbox,
            url: "https://crm.example.com/h",
            fetchFn: hang,
            now,
            log: () => {},
        });
        d.notify();
        await new Promise((r) => setTimeout(r, 30));
        const t0 = Date.now();
        await d.stop({ graceMs: 50 });
        assert.ok(Date.now() - t0 < 1500, "did not wait for the 10 s timeout");
        assert.equal(outbox.stats().pending, 1);
    });

    it("a stopped dispatcher sends nothing more", async () => {
        const f = fakeFetch();
        const d = dispatcher(f);
        await d.stop();
        queue(1);
        d.notify();
        await d.drain();
        assert.equal(f.calls.length, 0);
    });
});

describe("against a real receiver", () => {
    let server;
    let port;
    let behavior;
    const received = [];

    before(async () => {
        server = createServer((req, res) => {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                const raw = Buffer.concat(chunks);
                received.push({ headers: req.headers, raw });
                res.writeHead(behavior()).end("ok");
            });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        port = server.address().port;
    });
    after(() => server.close());

    it("delivers over real HTTP with a signature the sample receiver verifies, after the receiver comes back", async () => {
        received.length = 0;
        let up = false;
        behavior = () => (up ? 200 : 503);
        queue(1, 2);
        const d = createWebhookDispatcher({
            outbox,
            url: `http://127.0.0.1:${port}/hook`,
            secret: "CHANGE_ME_S",
            accountId: "A",
            now,
            log: () => {},
            setTimer: (fn, ms) => ({ unref() {}, fn, ms }),
            clearTimer: () => {},
            random: () => 0.5,
        });
        await d.drain();
        assert.equal(received.length, 1, "503: one try, the rest wait behind it");
        assert.equal(outbox.stats().pending, 2);
        up = true;
        clock += 10_000;
        await d.drain();
        assert.equal(outbox.stats().pending, 0);
        const delivered = received.slice(1);
        assert.deepEqual(
            delivered.map((r) => JSON.parse(r.raw).id),
            ["m1", "m2"],
        );
        for (const r of delivered) assert.equal(verifyWebhook(r.raw, r.headers, "CHANGE_ME_S"), true);
        assert.equal(received[0].headers["x-zalo-attempt"], "1");
        assert.equal(delivered[0].headers["x-zalo-attempt"], "2", "the retry says it is the second attempt");
    });

    it("a receiver that is not listening at all is a failure like any other", async () => {
        queue(1);
        const d = createWebhookDispatcher({
            outbox,
            url: "http://127.0.0.1:1/hook",
            now,
            log: () => {},
            setTimer: () => ({ unref() {} }),
            clearTimer: () => {},
        });
        await d.drain();
        assert.equal(outbox.stats().pending, 1);
        assert.match(outbox.stats().lastError, /ECONNREFUSED|fetch failed|connect/i);
    });
});

describe("startWebhookDelivery (real timers, real receiver)", () => {
    let server;
    let url;
    let posts;
    let status;
    const until = async (cond, ms = 4000) => {
        const t0 = Date.now();
        while (!cond()) {
            if (Date.now() - t0 > ms) throw new Error("timed out waiting");
            await new Promise((r) => setTimeout(r, 10));
        }
    };

    before(async () => {
        server = createServer((req, res) => {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                posts.push(JSON.parse(Buffer.concat(chunks)));
                res.writeHead(status).end();
            });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        url = `http://127.0.0.1:${server.address().port}/hook`;
    });
    after(() => server.close());
    beforeEach(() => {
        posts = [];
        status = 200;
    });

    it("enqueue() is delivered without any other call, and a repeat of a queued id is not sent twice", async () => {
        const d = startWebhookDelivery({ accountDir: dir, accountId: "A", url, log: () => {} });
        status = 503; // hold the first one in the queue so the repeat arrives while it waits
        d.enqueue("message:m1", { event: "message", id: "m1" });
        await until(() => posts.length >= 1);
        d.enqueue("message:m1", { event: "message", id: "m1" });
        assert.equal(d.status().pending, 1, "the repeat collapsed into the queued one");
        d.stop();
    });

    it("with batching on, events that arrive together leave in one POST", async () => {
        const d = startWebhookDelivery({ accountDir: dir, accountId: "A", url, batchSize: 5, log: () => {} });
        for (let i = 1; i <= 5; i++) d.enqueue(`message:m${i}`, { event: "message", id: `m${i}` });
        await until(() => posts.length >= 1);
        assert.equal(posts.length, 1);
        assert.deepEqual(
            posts[0].events.map((e) => e.id),
            ["m1", "m2", "m3", "m4", "m5"],
        );
        await until(() => d.status().pending === 0);
        d.stop();
    });

    it("an event put back by another process (mcp webhook retry) is picked up by the poll", async () => {
        const writer = openOutbox(dir);
        writer.enqueue("message:dead1", JSON.stringify({ event: "message", id: "dead1" }));
        writer.markDead([1], "test");
        const d = startWebhookDelivery({ accountDir: dir, accountId: "A", url, pollMs: 40, log: () => {} });
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(posts.length, 0, "a dead letter is not sent on its own");
        writer.retryDead();
        await until(() => posts.length === 1);
        assert.equal(posts[0].id, "dead1");
        writer.close();
        d.stop();
    });
});
