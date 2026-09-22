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
import { getDaemonChannel, startDaemonChannel, sendViaDaemon } from "../../src/core/daemon-channel.js";

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
