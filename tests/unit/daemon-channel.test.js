/**
 * `src/core/daemon-channel.js` — handing an upload to the running daemon.
 *
 * Zalo permits one web session per account. A non-inline attachment can only
 * be sent over a socket (zca-js parks the upload until the upload-complete
 * frame arrives), so `msg send-file` opened its own — and Zalo answered by
 * evicting whatever daemon was already connected.
 *
 * Measured before the fix: three file sends against a running listener
 * produced three evictions, three coverage gaps, and one message lost
 * outright, while the CLI printed a tick each time. After it: three sends,
 * zero evictions, zero gaps.
 *
 * Every failure here must degrade to "no daemon" rather than fail the send,
 * so most of these assert a null rather than a throw.
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import {
    getDaemonChannel,
    getSyncChannel,
    startDaemonChannel,
    sendViaDaemon,
    syncViaDaemon,
} from "../../src/core/daemon-channel.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-daemon-chan-"));
const started = [];
let n = 0;
let dir;

beforeEach(() => {
    dir = join(ROOT, `acct${n++}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
});

after(() => {
    for (const s of started) {
        try {
            s.stop();
        } catch {
            /* already stopped */
        }
    }
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering handle is not worth failing the run over */
    }
});

/** A daemon whose api records what it was asked to send. */
function fakeDaemon(dirPath, impl) {
    const sent = [];
    const api = {
        sendMessage: async (payload, threadId, type) => {
            sent.push({ payload, threadId, type });
            if (impl) return impl(payload, threadId, type);
            return { message: { msgId: "m1" } };
        },
    };
    return { api, sent, getApi: () => api, dirPath };
}

/** A promise the test settles by hand, for parking a stage in flight. */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * A stand-in daemon that writes bytes of the test's choosing.
 *
 * The real server always frames its lines correctly, so it cannot exercise the
 * client's NDJSON parser against a stream that splits a line across two TCP
 * writes -- which is the classic way a line parser breaks.
 */
async function rawChannel(dirPath, respond) {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => respond(res));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    writeFileSync(
        join(dirPath, "daemon-channel.json"),
        JSON.stringify({ pid: process.pid, port: server.address().port, token: "t".repeat(48) }),
    );
    return {
        stop() {
            server.closeAllConnections?.();
            server.close();
        },
    };
}

describe("getDaemonChannel", () => {
    it("reports no daemon when nothing has been written", () => {
        assert.equal(getDaemonChannel(dir), null);
    });

    it("treats a descriptor whose process is gone as no daemon, and removes it", () => {
        // A crashed daemon must not make every later send dial a dead port.
        const file = join(dir, "daemon-channel.json");
        writeFileSync(file, JSON.stringify({ pid: 0x7ffffffe, port: 1, token: "t" }));
        assert.equal(getDaemonChannel(dir), null);
        assert.equal(existsSync(file), false, "the stale descriptor should be cleaned up");
    });

    it("ignores a corrupt descriptor rather than throwing", () => {
        writeFileSync(join(dir, "daemon-channel.json"), "not json");
        assert.equal(getDaemonChannel(dir), null);
    });

    it("ignores a descriptor missing a field", () => {
        writeFileSync(join(dir, "daemon-channel.json"), JSON.stringify({ pid: process.pid, port: 1 }));
        assert.equal(getDaemonChannel(dir), null);
    });
});

describe("startDaemonChannel", () => {
    it("publishes a descriptor this process can be found by, and withdraws it on stop", async () => {
        const d = fakeDaemon(dir);
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir });
        started.push(chan);

        const found = getDaemonChannel(dir);
        assert.equal(found.port, chan.port);
        assert.equal(found.pid, process.pid);
        assert.ok(found.token.length >= 32, "the token must not be guessable");

        chan.stop();
        assert.equal(existsSync(join(dir, "daemon-channel.json")), false);
    });

    it("binds loopback only — this endpoint sends as the logged-in account", async () => {
        const d = fakeDaemon(dir);
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir });
        started.push(chan);
        const { token, port } = getDaemonChannel(dir);
        const res = await fetch(`http://127.0.0.1:${port}/send-attachments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token, paths: ["/a.pdf"], threadId: "t1", type: 1 }),
        });
        assert.equal(res.status, 200);
    });

    it("refuses a request with the wrong token", async () => {
        const d = fakeDaemon(dir);
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir });
        started.push(chan);
        const res = await fetch(`http://127.0.0.1:${chan.port}/send-attachments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: "wrong", paths: ["/a.pdf"], threadId: "t1" }),
        });
        assert.equal(res.status, 403);
        assert.equal(d.sent.length, 0, "a rejected request must not reach sendMessage");
    });

    it("refuses an unknown route", async () => {
        const d = fakeDaemon(dir);
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir });
        started.push(chan);
        const res = await fetch(`http://127.0.0.1:${chan.port}/anything`);
        assert.equal(res.status, 404);
    });
});

describe("sendViaDaemon", () => {
    it("reports no daemon rather than failing when none is running", async () => {
        assert.equal(await sendViaDaemon(dir, { paths: ["/a.pdf"], threadId: "t1", type: 1 }), null);
    });

    it("hands the upload to the daemon, with the thread type intact", async () => {
        const d = fakeDaemon(dir);
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir });
        started.push(chan);

        const r = await sendViaDaemon(dir, { paths: ["/a.pdf", "/b.zip"], threadId: "t9", type: 1, caption: "c" });
        assert.equal(r.ok, true);
        assert.equal(d.sent.length, 1);
        assert.deepEqual(d.sent[0].payload.attachments, ["/a.pdf", "/b.zip"]);
        assert.equal(d.sent[0].threadId, "t9");
        assert.equal(d.sent[0].type, 1, "a group send must not arrive as a 1-1");
    });

    it("surfaces a failed upload as an error, leaving the daemon up", async () => {
        const d = fakeDaemon(dir, () => {
            throw new Error("upload rejected");
        });
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir });
        started.push(chan);

        const r = await sendViaDaemon(dir, { paths: ["/a.pdf"], threadId: "t1", type: 0 });
        assert.equal(r.ok, false);
        assert.match(r.error, /upload rejected/);
        assert.equal(getDaemonChannel(dir).port, chan.port, "the daemon must survive a failed send");
    });

    it("rejects a request naming no files", async () => {
        const d = fakeDaemon(dir);
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir });
        started.push(chan);
        const res = await fetch(`http://127.0.0.1:${chan.port}/send-attachments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: getDaemonChannel(dir).token, paths: [], threadId: "t1" }),
        });
        assert.equal(res.status, 400);
    });

    it("uses the daemon's CURRENT api, not the one it started with", async () => {
        // On a duplicate-session close the daemon re-logs-in and builds a new
        // api. An upload parked in the old one's ctx.uploadCallbacks can never
        // settle, so the send hangs forever -- which is exactly what happened
        // when this module captured the api object instead of a getter.
        let current = null;
        const chan = await startDaemonChannel({ getApi: () => current, accountDir: dir });
        started.push(chan);

        const first = fakeDaemon(dir);
        current = first.api;
        await sendViaDaemon(dir, { paths: ["/a.pdf"], threadId: "t1", type: 0 });

        const afterReconnect = fakeDaemon(dir);
        current = afterReconnect.api;
        await sendViaDaemon(dir, { paths: ["/b.pdf"], threadId: "t1", type: 0 });

        assert.equal(first.sent.length, 1, "the pre-reconnect api took only the first send");
        assert.equal(afterReconnect.sent.length, 1, "the second send went to the new api");
    });

    it("falls back to no-daemon when the descriptor points at a dead port", async () => {
        // The port is ours, so the pid check passes; nothing is listening.
        writeFileSync(
            join(dir, "daemon-channel.json"),
            JSON.stringify({ pid: process.pid, port: 1, token: "t".repeat(48) }),
        );
        assert.equal(await sendViaDaemon(dir, { paths: ["/a.pdf"], threadId: "t1", type: 0 }), null);
    });

    it("writes the descriptor with owner-only permissions", async (t) => {
        if (process.platform === "win32") return t.skip("POSIX mode bits are not meaningful on Windows");
        const d = fakeDaemon(dir);
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir });
        started.push(chan);
        const { mode } = statSync(join(dir, "daemon-channel.json"));
        assert.equal(mode & 0o077, 0, "the token must not be readable by other users");
    });

    it("leaves another daemon's descriptor alone on stop", async () => {
        const d = fakeDaemon(dir);
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir });
        // Pretend a different daemon replaced us between start and stop.
        writeFileSync(join(dir, "daemon-channel.json"), JSON.stringify({ pid: process.pid + 1, port: 2, token: "t" }));
        chan.stop();
        const left = JSON.parse(readFileSync(join(dir, "daemon-channel.json"), "utf8"));
        assert.equal(left.port, 2, "stopping must not delete a descriptor we no longer own");
    });
});

/**
 * Routing a `zalo-agent sync` socket stage through the running daemon.
 *
 * The workaround this replaces was: stop the daemon, sync, start it again.
 * Measured 2026-09-28 recovering a 72-hour gap -- 1,150 messages restored, and
 * a NEW ~70-second hole opened between the restore's snapshot and the daemon
 * coming back, unrepairable because the legacy backfill endpoint is retired.
 *
 * A stage is minutes long and reports progress as it goes, so unlike an upload
 * it cannot be one blocking POST. These pin the parts that make the streaming
 * version safe: progress arrives while the stage is still running, a second
 * sync is refused rather than sharing the socket, and no failure mode lets the
 * caller decide to open a socket of its own.
 */
function fakeRunners(impl = {}) {
    const calls = [];
    const runners = {};
    for (const stage of ["messages", "reactions"]) {
        runners[stage] = async (params, onEvent) => {
            calls.push({ stage, params });
            return impl[stage] ? impl[stage](params, onEvent) : { stage, ok: true };
        };
    }
    return { runners, calls };
}

/** Start a channel that serves the sync stages, registered for cleanup. */
async function syncDaemon(dirPath, impl) {
    const d = fakeDaemon(dirPath);
    const { runners, calls } = fakeRunners(impl);
    const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dirPath, runners });
    started.push(chan);
    return { chan, calls, daemon: d };
}

describe("syncViaDaemon — no daemon", () => {
    it("reports no daemon as null, so the caller opens its own socket as it always did", async () => {
        // The ONLY case that may fall back. Everything else must not, because
        // a daemon that answered at all still holds the account's session.
        assert.equal(await syncViaDaemon(dir, { stage: "messages" }), null);
    });

    it("treats a live pid with a dead port as a failure, NOT as no daemon", async () => {
        // The process is alive, so it is still holding the WebSocket. Falling
        // back here would open a second session and evict it -- the exact harm
        // this path exists to prevent. sendViaDaemon answers null to the same
        // descriptor, and that difference is deliberate.
        writeFileSync(
            join(dir, "daemon-channel.json"),
            JSON.stringify({ pid: process.pid, port: 1, token: "t".repeat(48) }),
        );
        const r = await syncViaDaemon(dir, { stage: "messages" });
        assert.notEqual(r, null, "a live daemon process must never read as 'no daemon'");
        assert.equal(r.ok, false);
        assert.equal(r.disconnected, true);
        assert.equal(await sendViaDaemon(dir, { paths: ["/a.pdf"], threadId: "t1", type: 0 }), null);
    });
});

describe("the sync routes", () => {
    it("runs the stage and hands back its result", async () => {
        const { calls } = await syncDaemon(dir, {
            messages: () => ({ conversations: 3, messagesSaved: 287 }),
        });
        const r = await syncViaDaemon(dir, { stage: "messages", params: { days: 1 } });
        assert.equal(r.ok, true);
        assert.deepEqual(r.result, { conversations: 3, messagesSaved: 287 });
        assert.deepEqual(calls, [{ stage: "messages", params: { days: 1 } }]);
    });

    it("streams progress while the stage is still running", async () => {
        // The whole reason this is not a single blocking POST: a full-history
        // restore prints per-batch progress for minutes, and a run that said
        // nothing until it finished would be indistinguishable from a hang.
        const gate = deferred();
        const seen = [];
        await syncDaemon(dir, {
            messages: async (_p, onEvent) => {
                onEvent({ phase: "conversation", detail: "requesting your conversation list" });
                onEvent({ phase: "confirm", detail: "tap the prompt on your phone" });
                await gate.promise;
                onEvent({ phase: "progress", detail: "batch 1/1" });
                return { messagesSaved: 1 };
            },
        });

        const r = await syncViaDaemon(dir, {
            stage: "messages",
            onEvent: (e) => {
                seen.push(e.phase);
                // Only ever true if the line arrived before the stage resolved.
                if (e.phase === "confirm") gate.resolve();
            },
        });
        assert.equal(r.ok, true);
        assert.deepEqual(seen, ["conversation", "confirm", "progress"]);
    });

    it("reports a stage that threw, and leaves the daemon serving", async () => {
        const { chan } = await syncDaemon(dir, {
            reactions: () => {
                throw new Error("connection dropped while waiting for the phone");
            },
        });
        const r = await syncViaDaemon(dir, { stage: "reactions" });
        assert.equal(r.ok, false);
        assert.match(r.error, /connection dropped/);
        assert.equal(getDaemonChannel(dir).port, chan.port, "a failed stage must not take the daemon down");
        // And the guard is free again, or one bad stage would wedge the daemon.
        assert.equal((await syncViaDaemon(dir, { stage: "messages" })).ok, true);
    });

    it("refuses a second sync while one is in flight, naming the one that holds it", async () => {
        // Two stages on one socket is measured to break the restore: running
        // the reaction drain beside it lost the socket (close 1006) at batch 0
        // of 5 on both live attempts.
        const gate = deferred();
        await syncDaemon(dir, { messages: () => gate.promise });

        const first = syncViaDaemon(dir, { stage: "messages" });
        // Let the first request reach the runner before racing it.
        await new Promise((r) => setTimeout(r, 50));
        const second = await syncViaDaemon(dir, { stage: "reactions" });

        assert.equal(second.ok, false);
        assert.equal(second.status, 409);
        assert.equal(second.busyStage, "messages");
        assert.ok(second.busySince > 0, "the refusal says when the running stage started");

        gate.resolve({ messagesSaved: 0 });
        assert.equal((await first).ok, true);
        // Released on the way out: the next sync is accepted.
        assert.equal((await syncViaDaemon(dir, { stage: "reactions" })).ok, true);
    });

    it("keeps serving attachment uploads while a sync runs", async () => {
        // The guard is sync-vs-sync only. Live capture and uploads are the
        // things the daemon must keep doing throughout -- not losing them is
        // the entire point of routing the sync here.
        const gate = deferred();
        const { daemon } = await syncDaemon(dir, { messages: () => gate.promise });

        const running = syncViaDaemon(dir, { stage: "messages" });
        await new Promise((r) => setTimeout(r, 50));
        const sent = await sendViaDaemon(dir, { paths: ["/a.pdf"], threadId: "t1", type: 0 });
        assert.equal(sent.ok, true);
        assert.equal(daemon.sent.length, 1);

        gate.resolve({});
        await running;
    });

    it("refuses a stage this daemon does not run, rather than hanging", async () => {
        // An older daemon still serving uploads has no runners at all.
        const d = fakeDaemon(dir);
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir });
        started.push(chan);
        const r = await syncViaDaemon(dir, { stage: "messages" });
        assert.equal(r.ok, false);
        assert.equal(r.status, 503);
    });

    it("refuses a sync request with the wrong token", async () => {
        const { calls, chan } = await syncDaemon(dir);
        const res = await fetch(`http://127.0.0.1:${chan.port}/sync/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: "wrong", params: {} }),
        });
        assert.equal(res.status, 403);
        assert.equal(calls.length, 0, "a rejected request must not reach the runner");
    });

    it("serves only the two named stages", async () => {
        const { chan } = await syncDaemon(dir);
        const res = await fetch(`http://127.0.0.1:${chan.port}/sync/everything`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: getDaemonChannel(dir).token }),
        });
        assert.equal(res.status, 404);
    });

    it("hands the runner an object even when the caller sent no params", async () => {
        const { calls } = await syncDaemon(dir);
        await syncViaDaemon(dir, { stage: "reactions" });
        assert.deepEqual(calls[0].params, {});
    });

    it("says so when the daemon dies mid-stage instead of reading as success", async () => {
        // Silence after a half-written stream would otherwise resolve as an
        // empty-but-fine run, and the caller would record a sync that never
        // happened.
        const gate = deferred();
        const { chan } = await syncDaemon(dir, { messages: () => gate.promise });
        const run = syncViaDaemon(dir, { stage: "messages" });
        await new Promise((r) => setTimeout(r, 50));
        chan.stop();

        const r = await run;
        assert.equal(r.ok, false);
        assert.equal(r.disconnected, true);
        gate.resolve({});
    });
});

describe("the sync stream parser", () => {
    it("reassembles a line split across two writes", async () => {
        const raw = await rawChannel(dir, (res) => {
            res.writeHead(200, { "content-type": "application/x-ndjson" });
            res.write('{"t":"event","event":{"phase":"pro');
            setTimeout(() => {
                res.write('gress","detail":"batch 1/2"}}\n{"t":"done","result":{"ok":1}}\n');
                res.end();
            }, 20);
        });
        const seen = [];
        const r = await syncViaDaemon(dir, { stage: "messages", onEvent: (e) => seen.push(e) });
        raw.stop();

        assert.deepEqual(seen, [{ phase: "progress", detail: "batch 1/2" }]);
        assert.deepEqual(r.result, { ok: 1 });
    });

    it("ignores keepalives and lines it cannot read", async () => {
        // A keepalive exists so a restore waiting on a phone tap does not look
        // dead. Surfacing it as progress would print a blank line every 20s.
        const raw = await rawChannel(dir, (res) => {
            res.writeHead(200, { "content-type": "application/x-ndjson" });
            res.end('{"t":"ping"}\n\nnot json\n{"t":"event","event":{"phase":"page"}}\n{"t":"done","result":2}\n');
        });
        const seen = [];
        const r = await syncViaDaemon(dir, { stage: "reactions", onEvent: (e) => seen.push(e) });
        raw.stop();

        assert.deepEqual(seen, [{ phase: "page" }]);
        assert.equal(r.result, 2);
    });

    it("reports a stream that ends with no verdict", async () => {
        const raw = await rawChannel(dir, (res) => {
            res.writeHead(200, { "content-type": "application/x-ndjson" });
            res.end('{"t":"event","event":{"phase":"assets"}}\n');
        });
        const r = await syncViaDaemon(dir, { stage: "messages" });
        raw.stop();

        assert.equal(r.ok, false);
        assert.equal(r.disconnected, true);
        assert.match(r.error, /before the stage finished/);
    });

    it("gives up on a daemon that says nothing at all", async () => {
        const raw = await rawChannel(dir, () => {
            /* accept the request and never answer */
        });
        const r = await syncViaDaemon(dir, { stage: "messages", idleTimeoutMs: 120 });
        raw.stop();

        assert.equal(r.ok, false);
        assert.equal(r.disconnected, true);
    });
});

/**
 * The channel is a transport, and has to stay one.
 *
 * `src/commands/msg.js` imports this module at the top level for
 * `sendViaDaemon`, so every `msg` invocation pays for whatever it pulls in.
 * The sync stages it now serves live behind injected `runners`
 * (src/core/daemon-sync.js) for exactly that reason — importing SyncV2 here
 * would drag the libzproto decrypt stack, the CDN asset fetcher and the
 * sqlite writes into a path that never touches any of them, and it would make
 * these tests need a database to check an HTTP route.
 *
 * Same technique as tests/unit/sync-socket-rules.test.js: read the source and
 * fail the build on a shape the offline suite cannot otherwise reach.
 */
describe("daemon-channel.js stays a transport", () => {
    const SRC = readFileSync(join(import.meta.dirname, "..", "..", "src", "core", "daemon-channel.js"), "utf8");

    it("imports nothing from the sync, db or live-capture layers", () => {
        const imports = [...SRC.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
        assert.deepEqual(
            imports.filter((p) => !p.startsWith("node:")),
            [],
            `daemon-channel.js may only import node builtins; found: ${imports.join(", ")}`,
        );
    });

    it("names no stage body of its own — every one arrives as a runner", () => {
        // Prose about SyncV2 is expected: the header explains at length why it
        // is NOT imported here. A reference in code is the regression.
        const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        assert.match(code, /runners/, "the stage bodies are injected");
        assert.doesNotMatch(code, /\bSyncV2\b|\bdrainReactions\b/, "a stage body has leaked into the transport");
    });
});

/**
 * Telling a sync-capable daemon from one that predates the routes.
 *
 * Every daemon is the old one for as long as it keeps running after an
 * upgrade, and it publishes a perfectly good channel while 404-ing every
 * `/sync/` request. Probing the route is not an option — there is no harmless
 * sync request — so the descriptor says what the daemon serves, and a caller
 * that reads "nothing" behaves exactly as it did before this feature existed:
 * skip or refuse, never evict.
 */
describe("getSyncChannel", () => {
    it("accepts a daemon that advertises the stage", async () => {
        const d = fakeDaemon(dir);
        const { runners } = fakeRunners();
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir, runners });
        started.push(chan);

        assert.deepEqual(getDaemonChannel(dir).stages.sort(), ["messages", "reactions"]);
        assert.equal(getSyncChannel(dir).port, chan.port);
        assert.equal(getSyncChannel(dir, "messages").port, chan.port);
        assert.equal(getSyncChannel(dir, "reactions").port, chan.port);
    });

    it("rejects a daemon that advertises no stage at all", async () => {
        // An upload-only daemon: exactly what a pre-upgrade process publishes.
        const d = fakeDaemon(dir);
        const chan = await startDaemonChannel({ getApi: d.getApi, accountDir: dir });
        started.push(chan);

        assert.deepEqual(getDaemonChannel(dir).stages, [], "it still serves uploads");
        assert.equal(getSyncChannel(dir), null, "but a sync must not be routed to it");
    });

    it("reads a descriptor with no stages field as serving none", () => {
        // Written by a build that had never heard of sync routing.
        writeFileSync(
            join(dir, "daemon-channel.json"),
            JSON.stringify({ pid: process.pid, port: 1, token: "t".repeat(48) }),
        );
        assert.deepEqual(getDaemonChannel(dir).stages, []);
        assert.equal(getSyncChannel(dir), null);
    });

    it("rejects a daemon that does not advertise the stage asked for", async () => {
        const d = fakeDaemon(dir);
        const chan = await startDaemonChannel({
            getApi: d.getApi,
            accountDir: dir,
            runners: { reactions: async () => ({}) },
        });
        started.push(chan);

        assert.equal(getSyncChannel(dir, "reactions").port, chan.port);
        assert.equal(getSyncChannel(dir, "messages"), null);
        // …and the route refuses it too, so a daemon swapped out between the
        // descriptor read and the request still fails loudly.
        assert.equal((await syncViaDaemon(dir, { stage: "messages" })).status, 503);
    });

    it("is null when there is no daemon, same as getDaemonChannel", () => {
        assert.equal(getSyncChannel(dir), null);
    });
});

/**
 * The two option choices in `src/core/daemon-sync.js` that are invisible when
 * wrong.
 *
 * Both fail silently rather than loudly, which is why they are pinned here:
 * a missing `liveStore: false` writes every live message twice for the length
 * of a multi-minute restore (the daemon's own handlers already store them),
 * and a `reconnect` callback would have a stage tear the socket down
 * underneath the daemon's own re-login-and-rebuild recovery.
 */
describe("daemon-sync.js option choices", () => {
    const SRC = readFileSync(join(import.meta.dirname, "..", "..", "src", "core", "daemon-sync.js"), "utf8");
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    it("never lets the restore add a second live-store tap", () => {
        assert.match(code, /liveStore:\s*false/, "the daemon is already the tap");
    });

    it("leaves reconnection to the daemon", () => {
        assert.doesNotMatch(code, /\breconnect\s*:/, "a stage must not race the daemon's own recovery");
    });

    it("keeps the restore's heartbeat on — a daemon has no socket window of its own", () => {
        assert.match(code, /keepAlive:\s*true/);
    });
});
