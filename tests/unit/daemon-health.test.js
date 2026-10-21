/**
 * What a daemon reports about itself (src/core/daemon-health.js) and how that reaches an operator:
 * the socket state machine, the warnings, the Prometheus text, and the HTTP routes behind the token.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { COUNTED_EVENTS, createDaemonHealth, describeHealth, renderPrometheus } from "../../src/core/daemon-health.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

let clock;
const now = () => clock;
let health;
beforeEach(() => {
    clock = 10_000_000;
    health?.stop();
    health = createDaemonHealth({ kind: "mcp", accountId: "A1", version: "9.9.9", now });
});

describe("socket state", () => {
    it("starts as 'starting', is up on connect, down on a close, and counts reconnects", () => {
        assert.deepEqual(health.ready(), { ready: false, socket: "starting" });
        health.noteUp();
        assert.deepEqual(health.ready(), { ready: true, socket: "up" });
        assert.equal(health.snapshot().socket.reconnects, 0, "the first connect is not a reconnect");

        clock += 5000;
        health.noteDown(1006);
        const down = health.snapshot();
        assert.equal(down.socket.state, "down");
        assert.equal(down.ready, false);
        assert.deepEqual([down.socket.lastClose.code, down.socket.lastClose.ageSec], [1006, 0]);

        clock += 7000;
        health.noteUp();
        const up = health.snapshot();
        assert.equal(up.socket.state, "up");
        assert.equal(up.socket.reconnects, 1);
        assert.equal(up.socket.forSec, 0, "the age restarts on every change of state");
    });

    it("a repeated 'down' does not restart the clock, and 'stopping' is sticky", () => {
        health.noteUp();
        health.noteDown(1000);
        clock += 30_000;
        health.noteDown(1006);
        assert.equal(health.snapshot().socket.forSec, 30, "still counting from the first drop");

        health.noteStopping();
        health.noteUp();
        health.noteDown(1);
        assert.equal(health.snapshot().socket.state, "stopping", "a late connect or close cannot undo a shutdown");
        assert.equal(health.ready().ready, false);
    });

    it("attach() follows a listener: connected, disconnected and closed", () => {
        const listener = new EventEmitter();
        health.attach(listener);
        listener.emit("connected");
        assert.equal(health.ready().ready, true);
        listener.emit("disconnected", 1006, "x");
        assert.equal(health.snapshot().socket.lastClose.code, 1006);
        listener.emit("connected");
        listener.emit("closed", 3000);
        assert.equal(health.snapshot().socket.lastClose.code, 3000);
        assert.equal(health.snapshot().socket.state, "down");
    });

    it("never subscribes to cipher_key, which carries the session's key material", () => {
        const listener = new EventEmitter();
        health.attach(listener);
        assert.ok(!listener.eventNames().includes("cipher_key"));
        assert.deepEqual(
            listener
                .eventNames()
                .filter((n) => !["connected", "disconnected", "closed"].includes(n))
                .sort(),
            [...COUNTED_EVENTS].sort(),
        );
    });
});

describe("events", () => {
    it("counts every kind, and tells a message from someone else from our own echo", () => {
        const listener = new EventEmitter();
        health.attach(listener);
        listener.emit("message", { isSelf: false });
        listener.emit("message", { isSelf: true });
        listener.emit("reaction", {});
        clock += 4000;
        const s = health.snapshot();
        assert.equal(s.events.byKind.message, 2);
        assert.equal(s.events.byKind.reaction, 1);
        assert.equal(s.events.incomingMessages, 1);
        assert.equal(s.events.lastEventAgeSec, 4);
        assert.equal(s.events.lastMessageAgeSec, 4);
    });

    it("before anything arrives the ages are null, not 0", () => {
        const s = health.snapshot();
        assert.equal(s.events.lastEventAgeSec, null);
        assert.equal(s.events.lastMessageAgeSec, null);
        assert.equal(s.events.lastEventAt, null);
    });

    it("a reaction is an event but not a message", () => {
        health.noteEvent("reaction");
        const s = health.snapshot();
        assert.equal(s.events.lastEventAgeSec, 0);
        assert.equal(s.events.lastMessageAgeSec, null);
    });
});

describe("snapshot and warnings", () => {
    it("is 'ok' with nothing wrong, and carries identity", () => {
        health.noteUp();
        const s = health.snapshot();
        assert.equal(s.status, "ok");
        assert.deepEqual(s.warnings, []);
        assert.deepEqual([s.kind, s.accountId, s.version, s.pid], ["mcp", "A1", "9.9.9", process.pid]);
        assert.ok(s.process.rssBytes > 0);
        assert.equal(s.webhook, null);
        assert.equal(s.buffer, null);
        assert.equal(s.stage, null);
        assert.deepEqual(s.coverage, { pendingGaps: 0 });
    });

    it("a socket down for two minutes degrades the status; a brief drop does not", () => {
        health.noteUp();
        health.noteDown(1006);
        clock += 60_000;
        assert.equal(health.snapshot().status, "ok", "a minute is a reconnect in progress");
        clock += 61_000;
        const s = health.snapshot();
        assert.equal(s.status, "degraded");
        assert.match(s.warnings[0], /socket down for 121s \(last close code 1006\)/);
    });

    it("reports webhook backlog, dead letters and open gaps from the plugged-in sources", () => {
        health.noteUp();
        health.setSource("webhook", () => ({
            pending: 12,
            dead: 2,
            oldestPendingAgeMs: 10 * 60_000,
            lastError: "HTTP 503",
            deliveredTotal: 5,
            consecutiveFailures: 3,
            lastSuccessAt: clock - 90_000,
        }));
        health.setSource("gaps", () => 2);
        health.setSource("buffer", () => ({ threads: 4, messages: 30 }));
        health.setSource("stage", () => ({ stage: "messages", startedAt: clock - 45_000 }));
        const s = health.snapshot();
        assert.equal(s.status, "degraded");
        assert.equal(s.warnings.length, 3);
        assert.match(s.warnings.join("\n"), /webhook backlog: 12 queued, oldest 600s \(HTTP 503\)/);
        assert.match(s.warnings.join("\n"), /2 dead-lettered/);
        assert.match(s.warnings.join("\n"), /2 gap\(s\) not yet recovered/);
        assert.equal(s.webhook.lastSuccessAgeSec, 90);
        assert.deepEqual(s.stage, { running: "messages", forSec: 45 });
        assert.deepEqual(s.buffer, { threads: 4, messages: 30 });
    });

    it("a small, young webhook backlog is not a warning: it is the outbox doing its job", () => {
        health.noteUp();
        health.setSource("webhook", () => ({
            pending: 3,
            dead: 0,
            oldestPendingAgeMs: 4000,
            deliveredTotal: 1,
            consecutiveFailures: 1,
        }));
        assert.equal(health.snapshot().status, "ok");
    });

    it("a source that throws, or returns nothing, does not break the snapshot", () => {
        health.noteUp();
        health.setSource("webhook", () => {
            throw new Error("outbox closed");
        });
        health.setSource("gaps", () => undefined);
        const s = health.snapshot();
        assert.equal(s.webhook, null);
        assert.deepEqual(s.coverage, { pendingGaps: 0 });
    });

    it("the snapshot is JSON-safe", () => {
        health.noteUp();
        health.noteEvent("message");
        assert.doesNotThrow(() => JSON.stringify(health.snapshot()));
    });
});

describe("Prometheus text", () => {
    /** A strict-enough parser: every non-comment line is `name{labels} value`. */
    function parse(text) {
        const samples = [];
        const types = {};
        const helps = new Set();
        for (const line of text.trim().split("\n")) {
            if (line.startsWith("# HELP ")) helps.add(line.split(" ")[2]);
            else if (line.startsWith("# TYPE ")) {
                const [, , name, type] = line.split(" ");
                assert.equal(types[name], undefined, `${name} typed twice`);
                assert.ok(["gauge", "counter"].includes(type));
                types[name] = type;
            } else {
                const m = /^([a-z_:][a-z0-9_:]*)\{([^}]*)\} (-?[0-9.eE+]+)$/.exec(line);
                assert.ok(m, `not a sample line: ${line}`);
                assert.ok(types[m[1]], `${m[1]} has a sample before its TYPE`);
                assert.ok(helps.has(m[1]), `${m[1]} has no HELP`);
                assert.match(m[2], /^account="[^"]*"/, "every sample carries the account");
                samples.push({ name: m[1], labels: m[2], value: Number(m[3]) });
            }
        }
        return { samples, types };
    }
    const value = (samples, name) => samples.find((s) => s.name === name)?.value;

    it("exposes the socket, events and process as well-formed metrics", () => {
        health.noteUp();
        health.noteEvent("message");
        clock += 8000;
        const { samples, types } = parse(renderPrometheus(health.snapshot()));
        assert.equal(value(samples, "zalo_up"), 1);
        assert.equal(value(samples, "zalo_last_message_age_seconds"), 8);
        assert.equal(value(samples, "zalo_incoming_messages_total"), 1);
        assert.equal(value(samples, "zalo_coverage_gaps_pending"), 0);
        assert.equal(types.zalo_socket_reconnects_total, "counter");
        assert.equal(types.zalo_up, "gauge");
        assert.ok(value(samples, "zalo_process_resident_memory_bytes") > 0);
        const info = samples.find((s) => s.name === "zalo_info");
        assert.match(info.labels, /kind="mcp",version="9\.9\.9"/);
    });

    it("leaves out what has no value yet instead of printing 0, which would read as 'just now'", () => {
        const { samples } = parse(renderPrometheus(health.snapshot()));
        const names = new Set(samples.map((s) => s.name));
        assert.ok(!names.has("zalo_last_event_age_seconds"));
        assert.ok(!names.has("zalo_last_message_age_seconds"));
        assert.ok(!names.has("zalo_last_close_age_seconds"));
        assert.equal(value(samples, "zalo_up"), 0, "starting is not up");
    });

    it("webhook metrics appear only when a webhook is configured", () => {
        const without = parse(renderPrometheus(health.snapshot())).samples;
        assert.equal(value(without, "zalo_webhook_enabled"), 0);
        assert.ok(!without.some((s) => s.name === "zalo_webhook_pending"));

        health.setSource("webhook", () => ({
            pending: 7,
            dead: 1,
            oldestPendingAgeMs: 61_000,
            deliveredTotal: 40,
            consecutiveFailures: 2,
            lastSuccessAt: clock - 5000,
        }));
        const withIt = parse(renderPrometheus(health.snapshot())).samples;
        assert.equal(value(withIt, "zalo_webhook_enabled"), 1);
        assert.equal(value(withIt, "zalo_webhook_pending"), 7);
        assert.equal(value(withIt, "zalo_webhook_dead"), 1);
        assert.equal(value(withIt, "zalo_webhook_oldest_pending_age_seconds"), 61);
        assert.equal(value(withIt, "zalo_webhook_delivered_total"), 40);
        assert.equal(value(withIt, "zalo_webhook_last_success_age_seconds"), 5);
    });

    it("never prints NaN or Infinity, which a scraper would reject", () => {
        const s = health.snapshot();
        s.process.eventLoopLagP99Ms = NaN;
        s.process.eventLoopLagMaxMs = Infinity;
        const text = renderPrometheus(s);
        assert.doesNotMatch(text, /NaN|Infinity/);
        assert.doesNotMatch(text, /zalo_eventloop_lag_/);
    });

    it("a running stage is a labeled 1, no stage is a plain 0", () => {
        assert.equal(value(parse(renderPrometheus(health.snapshot())).samples, "zalo_stage_running"), 0);
        health.setSource("stage", () => ({ stage: "messages", startedAt: clock }));
        const s = parse(renderPrometheus(health.snapshot())).samples.find((x) => x.name === "zalo_stage_running");
        assert.match(s.labels, /stage="messages"/);
        assert.equal(s.value, 1);
    });

    it("escapes a hostile label value", () => {
        const h = createDaemonHealth({ kind: "mcp", accountId: 'a"b\\c\nd', version: "1", now });
        const text = renderPrometheus(h.snapshot());
        h.stop();
        assert.match(text, /account="a\\"b\\\\c\\nd"/);
        assert.ok(text.split("\n").every((l) => !l.includes("\r")));
    });
});

describe("describeHealth", () => {
    it("says the socket, the last events, the backlog and every warning", () => {
        health.noteUp();
        health.noteDown(1006);
        clock += 200_000;
        health.setSource("webhook", () => ({
            pending: 5,
            dead: 1,
            oldestPendingAgeMs: 400_000,
            deliveredTotal: 9,
            consecutiveFailures: 4,
        }));
        health.setSource("gaps", () => 1);
        const text = describeHealth(health.snapshot()).join("\n");
        assert.match(text, /Socket: down for 200s.*last close code 1006/);
        assert.match(text, /Events: none yet since start/);
        assert.match(text, /Coverage: 1 pending gap/);
        assert.match(text, /Webhook: 5 queued \(oldest 400s\), 1 dead-lettered, 9 delivered, failing x4/);
        assert.match(text, /WARNING: socket down for 200s/);
        assert.match(text, /WARNING: webhook backlog/);
    });
});

describe("HTTP routes", () => {
    const servers = [];
    after(() => servers.forEach((s) => s.close()));

    async function start({ token = "T0KEN", withHealth = true } = {}) {
        const h = withHealth ? createDaemonHealth({ kind: "mcp", accountId: "A1", version: "9.9.9" }) : null;
        h?.setSource("buffer", () => ({ threads: 2, messages: 5 }));
        const deps = {
            api: {},
            buffer: { getStats: () => [{}, {}] },
            filter: {},
            config: {},
            nameCache: null,
            accountDir: ".",
            health: h,
        };
        const server = createHTTPServer(() => {}, deps, 0, token, "127.0.0.1");
        servers.push(server);
        server.on("close", () => h?.stop());
        if (!server.listening) await once(server, "listening");
        return { base: `http://127.0.0.1:${server.address().port}`, health: h };
    }
    const auth = { Authorization: "Bearer T0KEN" };

    it("/health stays open and thin, and now says whether the socket is up", async () => {
        const { base, health: h } = await start();
        let body = await (await fetch(`${base}/health`)).json();
        assert.deepEqual([body.status, body.threads, body.socket, body.ready], ["ok", 2, "starting", false]);
        assert.deepEqual(
            Object.keys(body).sort(),
            ["ready", "socket", "status", "threads", "uptime"],
            "nothing more leaks without a token",
        );
        h.noteUp();
        body = await (await fetch(`${base}/health`)).json();
        assert.deepEqual([body.socket, body.ready], ["up", true]);
    });

    it("/health keeps its old shape when the server has no health object", async () => {
        const { base } = await start({ withHealth: false });
        const body = await (await fetch(`${base}/health`)).json();
        assert.deepEqual(Object.keys(body).sort(), ["status", "threads", "uptime"]);
    });

    it("/ready is 503 until the socket is up, then 200, and needs no token", async () => {
        const { base, health: h } = await start();
        let res = await fetch(`${base}/ready`);
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { ready: false, socket: "starting" });
        h.noteUp();
        res = await fetch(`${base}/ready`);
        assert.equal(res.status, 200);
        h.noteDown(1006);
        assert.equal((await fetch(`${base}/ready`)).status, 503);
    });

    it("/status and /metrics need the token", async () => {
        const { base } = await start();
        for (const path of ["/status", "/metrics"]) {
            assert.equal((await fetch(`${base}${path}`)).status, 401, path);
            assert.equal(
                (await fetch(`${base}${path}`, { headers: { Authorization: "Bearer wrong" } })).status,
                401,
                path,
            );
        }
    });

    it("/status returns the whole snapshot", async () => {
        const { base, health: h } = await start();
        h.noteUp();
        const res = await fetch(`${base}/status`, { headers: auth });
        assert.equal(res.status, 200);
        const s = await res.json();
        assert.deepEqual([s.kind, s.accountId, s.ready, s.socket.state], ["mcp", "A1", true, "up"]);
        assert.deepEqual(s.buffer, { threads: 2, messages: 5 });
    });

    it("/metrics is Prometheus text, sent with a bearer token", async () => {
        const { base, health: h } = await start();
        h.noteUp();
        const res = await fetch(`${base}/metrics`, { headers: auth });
        assert.equal(res.status, 200);
        // Express writes the parameters in alphabetical order; Prometheus reads them in any order.
        assert.match(res.headers.get("content-type"), /^text\/plain;/);
        assert.match(res.headers.get("content-type"), /version=0\.0\.4/);
        const text = await res.text();
        assert.match(text, /^# HELP zalo_up /m);
        assert.match(text, /^zalo_up\{account="A1"\} 1$/m);
    });

    it("without a health object /status and /metrics say so instead of crashing", async () => {
        const { base } = await start({ withHealth: false });
        assert.equal((await fetch(`${base}/status`, { headers: auth })).status, 503);
        assert.equal((await fetch(`${base}/metrics`, { headers: auth })).status, 503);
        assert.equal((await fetch(`${base}/ready`)).status, 200, "no health object: nothing to say it is not ready");
    });
});
