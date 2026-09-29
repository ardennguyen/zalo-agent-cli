/**
 * With a daemon running, `msg history`'s fetch and its cache write happen in
 * the daemon. The CLI process only displays what the daemon returns, and
 * writes nothing to zalo.db.
 *
 * AGENTS.md §13: one WebSocket per account, one db writer per account. The
 * listener, sync and msg history's fetch are the three paths that write
 * message rows (Arden's 2026-09-30 rulings), and a running `listen`/`mcp`
 * daemon is the one writer while it runs. Before this, the daemon only lent
 * its socket: its history stage paged the old-message stream, wrote nothing
 * and handed the frames back for the CLI to write, and a group's cloud-message
 * store fetch never reached the daemon at all -- the CLI fetched it and wrote
 * it beside the daemon. Two writers for one account.
 *
 * The daemon here is a real second process (./support/history-daemon.js):
 * startDaemonChannel serving createSyncRunners, as `listen` and `mcp start`
 * wire it, on a real zca-js session over ./fake-zalo-session.js, writing the
 * sandbox's zalo.db through its own connection. The CLI is the real command,
 * run in THIS process, with ./support/db-write-spy.js recording every write
 * statement this process makes. Both sides' fake Zalo can serve the same
 * history, so the only thing a test can fail on is which process fetched it
 * and which one wrote it.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, getMessageById, setMessageLocalPath, setMessageStatus } from "../../src/core/db.js";
import { storeLiveMessage } from "../../src/core/live-store.js";
import { getDaemonChannel, startDaemonChannel } from "../../src/core/daemon-channel.js";
import { registerMsgCommands } from "../../src/commands/msg.js";
import { FAKE, installFakeZalo, loginFake, runCommand, serveOldMessages } from "./fake-zalo-session.js";
import { spyOnDbWrites, openDbStatements } from "./support/db-write-spy.js";

const ACCOUNT_DIR = join(CONFIG_DIR, "accounts", FAKE.ownId);
const DB_PATH = join(ACCOUNT_DIR, "zalo.db");
const DAEMON_SCRIPT = join(import.meta.dirname, "support", "history-daemon.js");

// Made-up ids, short on purpose: none of them belongs to anyone.
const GID = "7201";
const PEER = "3201";
const ELSEWHERE = "3209";
const MEMBER = "2201";
/** Message times, all in the past. */
const T0 = Date.UTC(2026, 8, 1);

let seq = 0;
/** A msgId no other test in this file uses. */
const freshId = () => String(5_200_000 + ++seq);

/** A message as Zalo sends it; a socket frame and a cloud-store row share this shape. */
function wire(msgId, threadId, over = {}) {
    const n = Number(msgId) - 5_200_000;
    return {
        msgId,
        cliMsgId: String(T0 + n),
        msgType: "webchat",
        uidFrom: MEMBER,
        idTo: threadId,
        dName: "Member",
        ts: String(T0 + n * 10),
        content: `text ${msgId}`,
        ...over,
    };
}

/** getrecentv2's `data`: a JSON string, as captured. */
const cloudPage = (groupMsgs) => JSON.stringify({ error: 0, lastMsgId: "0", hasMore: 0, isOld: 0, groupMsgs });

/** An old-message frame, in the listener's shape. */
const frame = (threadId, type, data) => ({ threadId, type, data });

/** The same msgId as a later fetch might return it: other text, other time, no st/at/cmd. */
const refetched = (msgId, threadId) =>
    wire(msgId, threadId, { content: "a different copy of the same message", dName: "Member (renamed)" });

/** Read a row back, reopening the file msg history used. */
function stored(msgId) {
    initDb(DB_PATH);
    return getMessageById(msgId);
}

/**
 * A photo the listener stored, then enriched the way the media downloader and
 * a seen receipt do: the columns a history fetch can never reproduce.
 */
function listenerStoredPhoto(msgId, threadId, type) {
    initDb(DB_PATH);
    const data = wire(msgId, threadId, {
        msgType: "chat.photo",
        content: { href: "https://photo.zalo.invalid/p.jpg", thumb: "https://photo.zalo.invalid/t.jpg" },
        st: 3,
        at: 9,
        cmd: type === 1 ? 521 : 501,
    });
    assert.equal(storeLiveMessage({ threadId, type, isSelf: false, data }).stored, true);
    setMessageLocalPath(msgId, join(ACCOUNT_DIR, "media", threadId, "p.jpg"));
    setMessageStatus(msgId, 3);
    const row = getMessageById(msgId);
    assert.ok(row.localPath && row.msgStatus === 3 && JSON.parse(row.raw_data).at === 9, "seed incomplete");
    return row;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fork ./support/history-daemon.js and wait until its channel is published.
 *
 * @returns {Promise<{pid: number, exited: Promise<number|null>, scenario: (s: object) => Promise<void>,
 *   report: () => Promise<{storeCalls: number, socketRequests: number}>, stop: () => Promise<void>,
 *   stderr: () => string}>}
 */
async function startDaemon() {
    const env = { ...process.env, ZALO_TEST_DAEMON_CONFIG_DIR: CONFIG_DIR };
    // The daemon is not a test file; the runner's protocol env would say it is.
    delete env.NODE_TEST_CONTEXT;
    const child = fork(DAEMON_SCRIPT, [], { env, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    // A daemon a test killed on purpose has a closed pipe; that is not a test failure.
    child.on("error", () => {});
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));

    const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the daemon did not start within 90s\n${stderr}`)), 90_000);
        child.once("message", (m) => {
            clearTimeout(timer);
            if (m?.type === "ready") resolve(m);
            else reject(new Error(`the daemon said ${JSON.stringify(m)} before it was ready`));
        });
        exited.then((code) => {
            clearTimeout(timer);
            reject(new Error(`the daemon exited with ${code} before it was ready\n${stderr}`));
        });
    });

    const ask = (msg, replyType) =>
        new Promise((resolve, reject) => {
            const onMessage = (m) => {
                if (m?.type !== replyType) return;
                child.off("message", onMessage);
                resolve(m);
            };
            child.on("message", onMessage);
            child.send(msg, (err) => err && reject(err));
        });

    return {
        pid: ready.pid,
        exited,
        scenario: async (scenario) => {
            await ask({ type: "scenario", scenario }, "scenario-set");
        },
        report: async () => {
            const { storeCalls, socketRequests } = await ask({ type: "report" }, "report");
            return { storeCalls, socketRequests };
        },
        stop: async () => {
            if (child.exitCode === null && child.connected) child.send({ type: "stop" }, () => {});
            await Promise.race([exited, sleep(10_000)]);
            if (child.exitCode === null && child.signalCode === null) child.kill();
        },
        stderr: () => stderr,
    };
}

describe("msg history beside a running daemon", () => {
    let fake;
    let api;
    let spy;
    /** What initDb runs on every open of an up-to-date zalo.db. Opening is not writing. */
    let openDb;
    let socket = null;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        fake = installFakeZalo();
        api = await loginFake();
        spy = spyOnDbWrites();
        openDb = openDbStatements(spy, () => initDb(DB_PATH));
        assert.ok(openDb.size > 0, "the spy saw nothing while initDb ran, so it could not see a write either");
    });

    after(() => {
        spy.restore();
        fake.uninstall();
    });

    beforeEach(() => {
        fake.requests.length = 0;
        fake.clearRoutes();
    });

    afterEach(() => {
        socket?.restore();
        socket = null;
    });

    /**
     * Give THIS process's fake Zalo the same history the daemon has, so a CLI
     * that fetched it itself would succeed -- and be caught doing it.
     */
    function cliCouldFetch({ store = null, pages = [] } = {}) {
        if (store !== null) fake.route("/api/cm/getrecentv2", () => store);
        socket = serveOldMessages(api, pages);
    }

    /** Run `msg history --json`, recording every write statement this process makes meanwhile. */
    async function history(...args) {
        spy.clear();
        const r = await runCommand(registerMsgCommands, ["--json", "msg", "history", ...args]);
        return { ...r, writes: [...spy.writes], all: `${r.stdout}\n${r.stderr}` };
    }

    /**
     * Every write statement beyond opening the db -- anything here is the CLI
     * writing -- as "<rows changed> <statement start>", so a failure reads.
     */
    const cliWrites = (r) =>
        r.writes.filter((w) => w.changes > 0 || !openDb.has(w.sql)).map((w) => `${w.changes} ${w.sql.slice(0, 60)}`);
    /** Whether the CLI inserted a message row itself. */
    const cliInserted = (r) => cliWrites(r).some((w) => w.startsWith("1 INSERT INTO messages"));
    const shown = (r) => (JSON.parse(r.stdout).messages || []).map((m) => m.msgId).sort();

    describe("no daemon", () => {
        it("(b) the CLI fetches and caches itself, as before -- and the spy sees it write", async () => {
            // Also what keeps every "the CLI wrote nothing" below honest: the
            // spy demonstrably records this process's inserts.
            const newId = freshId();
            cliCouldFetch({ store: cloudPage([wire(newId, GID)]) });

            const r = await history(GID, "-t", "1", "-n", "5", "--no-cache");

            assert.equal(r.exitCode, 0, r.all);
            assert.deepEqual(shown(r), [newId]);
            assert.equal(fake.calls("/api/cm/getrecentv2").length, 1, "with no daemon the CLI reads the store");
            assert.ok(cliInserted(r), `the CLI should be the writer here, but wrote: ${cliWrites(r).join(" | ")}`);
            assert.ok(stored(newId));
        });

        it("(d) a live daemon that cannot run the history stage: exit 1, nothing fetched or written here", async () => {
            // A daemon started before the history stage existed still holds
            // the session; fetching beside it, or opening a socket, is what
            // the hand-off exists to prevent.
            const newId = freshId();
            cliCouldFetch({ store: cloudPage([wire(newId, GID)]) });
            writeFileSync(
                join(ACCOUNT_DIR, "daemon-channel.json"),
                JSON.stringify({ pid: process.pid, port: 1, token: "t".repeat(48), stages: ["messages", "reactions"] }),
            );
            try {
                const r = await history(GID, "-t", "1", "-n", "5", "--no-cache");

                assert.equal(r.exitCode, 1, r.all);
                assert.match(JSON.parse(r.stdout).error, /daemon.*restart/i);
                assert.deepEqual(cliWrites(r), [], "the CLI wrote beside a live daemon");
                assert.equal(fake.calls("/api/cm/getrecentv2").length, 0, "the CLI fetched beside a live daemon");
                assert.equal(socket.requests.length, 0, "the CLI opened a socket beside a live daemon");
                assert.equal(stored(newId), null);
            } finally {
                rmSync(join(ACCOUNT_DIR, "daemon-channel.json"), { force: true });
            }
        });

        it("(d) a daemon too old to cache: its answer is shown, and the CLI still writes nothing", async () => {
            // The history stage before this change: it paged the stream and
            // returned frames, caching nothing, for the CLI to write.
            const newId = freshId();
            const frames = [frame(PEER, 0, wire(newId, PEER))];
            cliCouldFetch({ pages: [frames] });
            const chan = await startDaemonChannel({
                getApi: () => api,
                accountDir: ACCOUNT_DIR,
                runners: { history: async () => ({ frames, rawScanned: 1 }) },
            });
            try {
                const r = await history(PEER, "-t", "0", "-n", "5", "--no-cache", "--timeout", "2000");

                assert.equal(r.exitCode, 0, r.all);
                assert.deepEqual(shown(r), [newId], "the daemon's answer was not shown");
                assert.match(r.stderr, /restart/i, "an old daemon must be named, or its uncached answer looks normal");
                assert.deepEqual(cliWrites(r), [], "the CLI wrote beside a live daemon");
                assert.equal(socket.requests.length, 0, "the CLI opened a socket beside a live daemon");
                assert.equal(stored(newId), null, "nothing may cache it: the daemon did not, and the CLI must not");
            } finally {
                chan.stop();
            }
        });
    });

    describe("a daemon running in its own process", () => {
        let daemon;

        before(async () => {
            daemon = await startDaemon();
        });

        after(async () => {
            await daemon?.stop();
        });

        it("(a) a group: the daemon reads the store and caches it; the CLI fetches and writes nothing", async () => {
            const ids = [freshId(), freshId()];
            const store = cloudPage(ids.map((id) => wire(id, GID)));
            await daemon.scenario({ store });
            cliCouldFetch({ store });

            const r = await history(GID, "-t", "1", "-n", "5", "--no-cache");

            assert.equal(r.exitCode, 0, `${r.all}\n${daemon.stderr()}`);
            assert.deepEqual(shown(r), [...ids].sort(), "the CLI must show what the daemon fetched");
            // Red if the CLI writes the rows itself (the store path used to).
            assert.deepEqual(cliWrites(r), [], "the CLI process wrote to zalo.db beside a running daemon");
            assert.equal(fake.calls("/api/cm/getrecentv2").length, 0, "the CLI read the store itself");
            assert.equal(socket.requests.length, 0, "the CLI opened its own socket");
            assert.deepEqual(await daemon.report(), { storeCalls: 1, socketRequests: 0 }, "store first, on the daemon");
            for (const id of ids) {
                const row = stored(id);
                assert.ok(row, `the daemon did not cache ${id}`);
                assert.equal(JSON.parse(row.raw_data).src, "history", "not written by the history writer");
            }
        });

        it("(a) a DM: the daemon scans its own socket and caches it; the CLI opens no socket and writes nothing", async () => {
            const newId = freshId();
            const otherId = freshId();
            const pages = [[frame(PEER, 0, wire(newId, PEER)), frame(ELSEWHERE, 0, wire(otherId, ELSEWHERE))]];
            await daemon.scenario({ pages });
            cliCouldFetch({ pages });

            const r = await history(PEER, "-t", "0", "-n", "10", "--no-cache", "--timeout", "2000");

            assert.equal(r.exitCode, 0, `${r.all}\n${daemon.stderr()}`);
            assert.deepEqual(shown(r), [newId]);
            assert.deepEqual(cliWrites(r), [], "the CLI process wrote to zalo.db beside a running daemon");
            assert.equal(socket.requests.length, 0, "the CLI opened a second socket beside the daemon");
            const seen = await daemon.report();
            assert.equal(seen.storeCalls, 0, "a DM has no store");
            assert.ok(seen.socketRequests >= 1, "the daemon never scanned its socket");
            assert.ok(stored(newId), "the daemon did not cache the DM's message");
            assert.equal(stored(otherId), null, "another conversation's message was cached");
        });

        for (const path of ["store", "socket"]) {
            it(`(c) the daemon leaves a listener-stored row column-identical -- ${path}`, async () => {
                const keptId = freshId();
                const newId = freshId();
                const kept = listenerStoredPhoto(keptId, GID, 1);
                const scenario =
                    path === "store"
                        ? { store: cloudPage([refetched(keptId, GID), wire(newId, GID)]) }
                        : {
                              // An empty store: the stage falls back to the socket.
                              store: cloudPage([]),
                              pages: [
                                  [
                                      frame(GID, 1, refetched(keptId, GID)),
                                      frame(GID, 1, wire(newId, GID)),
                                      // A "delete for me" of the kept row: never applied from history.
                                      frame(
                                          GID,
                                          1,
                                          wire(freshId(), GID, {
                                              msgType: "chat.delete",
                                              content: [
                                                  {
                                                      globalDelMsgId: keptId,
                                                      clientDelMsgId: wire(keptId, GID).cliMsgId,
                                                  },
                                              ],
                                          }),
                                      ),
                                  ],
                              ],
                          };
                await daemon.scenario(scenario);
                cliCouldFetch(scenario);

                const r = await history(GID, "-t", "1", "-n", "10", "--no-cache", "--timeout", "2000");

                assert.equal(r.exitCode, 0, `${r.all}\n${daemon.stderr()}`);
                assert.deepEqual(cliWrites(r), [], "the CLI process wrote to zalo.db beside a running daemon");
                if (path === "socket") {
                    const seen = await daemon.report();
                    assert.equal(seen.storeCalls, 1, "the daemon must try the store first");
                    assert.ok(seen.socketRequests >= 1, "an empty store must fall back to the daemon's socket");
                }
                assert.ok(stored(newId), "the daemon's write-back did not run, so this proves nothing");
                // Red if the daemon's writer replaces a stored row (the listener's upsert would).
                assert.deepEqual(stored(keptId), kept, "the daemon's history write modified a row the listener stored");
            });
        }

        it("(d) a daemon whose fetch fails mid-call: exit 1, nothing written here, no socket of our own", async () => {
            const newId = freshId();
            await daemon.scenario({ failScan: "the socket dropped mid-scan" });
            cliCouldFetch({ pages: [[frame(PEER, 0, wire(newId, PEER))]] });

            const r = await history(PEER, "-t", "0", "-n", "5", "--no-cache", "--timeout", "2000");

            assert.equal(r.exitCode, 1, r.all);
            assert.match(JSON.parse(r.stdout).error, /daemon/i);
            assert.match(
                JSON.parse(r.stdout).error,
                /socket dropped mid-scan/,
                "the daemon's reason must be passed on",
            );
            assert.deepEqual(cliWrites(r), [], "the CLI wrote beside a live daemon");
            assert.equal(socket.requests.length, 0, "the CLI fell back to its own socket beside a live daemon");
            assert.equal(stored(newId), null);
            assert.equal(getDaemonChannel(ACCOUNT_DIR)?.pid, daemon.pid, "the daemon should still be up");
            assert.ok((await daemon.report()).socketRequests >= 1, "the failure was not mid-call");
        });
    });

    describe("a daemon that dies mid-call", () => {
        it("(d) exit 1 and nothing written; once it is confirmed gone, the next run fetches on its own", async () => {
            const dying = await startDaemon();
            try {
                await dying.scenario({ dieOnScan: true });
                const newId = freshId();
                cliCouldFetch({ pages: [[frame(PEER, 0, wire(newId, PEER))]] });

                const r = await history(PEER, "-t", "0", "-n", "5", "--no-cache", "--timeout", "2000");

                assert.equal(r.exitCode, 1, r.all);
                assert.match(JSON.parse(r.stdout).error, /daemon/i);
                assert.deepEqual(cliWrites(r), [], "the CLI wrote while a daemon had the fetch");
                assert.equal(socket.requests.length, 0, "the CLI opened its own socket in the same run");
                assert.equal(stored(newId), null);
                assert.equal(await dying.exited, 3, "the daemon was meant to die mid-call");

                // Its descriptor names a dead pid now: that is "confirmed gone".
                const again = await history(PEER, "-t", "0", "-n", "5", "--no-cache", "--timeout", "2000");
                assert.equal(again.exitCode, 0, again.all);
                assert.deepEqual(shown(again), [newId]);
                assert.ok(socket.requests.length >= 1, "with no daemon left, the CLI scans itself");
                assert.ok(cliInserted(again), "with no daemon left, the CLI is the writer");
                assert.ok(stored(newId));
            } finally {
                await dying.stop();
            }
        });
    });
});
