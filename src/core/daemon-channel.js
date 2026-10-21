/**
 * A loopback channel to the running daemon, so only one WebSocket is ever open.
 *
 * Zalo permits ONE web session per account. Sending a non-inline attachment
 * needs a socket: zca-js's uploadAttachment() parks the send in
 * ctx.uploadCallbacks and only apis/listen.js can settle it, when the
 * upload-complete control frame arrives. So `msg send-file` opened its own
 * listener -- and if a `listen` or `mcp` daemon was already running, Zalo
 * evicted it with cmd 3000 ("Another connection is opened").
 *
 * Measured: nine messages sent into a group with the daemon up. Eight were
 * captured. The one that landed inside the ~6s reconnect window was lost
 * outright, the daemon recorded a coverage gap, and the gap's only repair path
 * (pullMobileMsg) is retired -- so the message was gone for good. The CLI
 * printed a tick.
 *
 * The daemon already holds a healthy socket, so it should do the upload. This
 * is that hand-off: the daemon serves a tiny HTTP endpoint on 127.0.0.1, and a
 * sender that finds one uses it instead of opening a second session. When no
 * daemon is running, nothing changes and the sender opens its own socket as
 * before.
 *
 * Why HTTP over a unix socket or named pipe: the same loopback-server shape is
 * already used three times in this repo (oa-init, oa-listen, qr-http-server),
 * and it works identically on Windows, where this tool mostly runs.
 *
 * ## The same hand-off, for `zalo-agent sync`
 *
 * `sync`'s socket stages had the same collision and a worse workaround. With a
 * daemon up, `planSyncRun` marked them skipped and the three `sync-*` commands
 * hard-errored, so closing a coverage gap meant: stop the daemon, sync, start
 * it again. Measured 2026-09-28 recovering a 72-hour gap -- 1,150 messages
 * restored, and a NEW ~70-second hole opened between the sync's snapshot and
 * the daemon coming back. Whatever arrived in those 70 seconds is unreachable,
 * because the legacy backfill endpoint is retired. The repair tool was
 * manufacturing the damage it repairs.
 *
 * A sync stage is not a one-shot POST like an upload, so `/send-attachments`'s
 * request/response shape does not fit:
 *
 *   - `messages` is a whole transfer-sync-v2 session (cmd 590/591). It
 *     enumerates conversations, waits on a physical tap on the owner's phone,
 *     then receives and decrypts batch after batch. Minutes, not seconds.
 *   - `reactions` (cmd 610/611) pages until the server says there is no more.
 *
 * Both report progress the CLI prints as it happens, and a run that printed
 * nothing for ten minutes would be indistinguishable from a hang. So the
 * daemon RUNS the stage on its own socket and streams NDJSON back over a
 * chunked response: one JSON object per line, `{"t":"event"}` per progress
 * callback, `{"t":"ping"}` every 20s, and a final `{"t":"done"}` or
 * `{"t":"error"}`.
 *
 * Why NDJSON on a chunked response rather than SSE or a poll endpoint:
 *
 *   - SSE's `event:`/`data:` framing and reconnect semantics (`Last-Event-ID`,
 *     retry hints) exist for browsers recovering a dropped feed. There is no
 *     browser here and a dropped feed means the daemon died, which is not
 *     recoverable by replaying -- so the framing is pure overhead.
 *   - A poll endpoint needs a job table, a progress ring buffer and an expiry
 *     sweeper in the daemon, and it still delivers progress late. The stream
 *     pushes, and the response's own lifetime IS the job's lifetime, so there
 *     is nothing to expire.
 *   - Chunked HTTP costs one `res.write` per line on a transport this file
 *     already speaks, with the same loopback bind and the same token.
 *
 * Why the daemon runs the stage rather than proxying raw frames: the decrypt
 * chain (libzproto session records, Zstd, protobuf) and the db writes belong
 * with the socket that produced them. Proxying frames would put the account's
 * one db writer on the wrong side of a pipe.
 *
 * What does NOT change: the phone tap. Routing through the daemon removes the
 * second WebSocket, not the confirmation. A stage only ever runs because a
 * person typed `zalo-agent sync`; the daemon never starts one on its own,
 * which is the same rule the "How the daemon self-heals" note in
 * src/commands/listen.js sets out. What the daemon does start on its own is
 * the offline-queue catch-up (src/core/self-heal.js): no phone involved, and
 * it holds the same one-stage lock these routes do.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createLogSink, createRotatingFile, resolveLogSettings } from "./log-sink.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { maskSecretArgs } from "../utils/secrets.js";

const CHANNEL_FILE = "daemon-channel.json";
const LOCK_FILE = "daemon.lock";
const LOG_FILE = "daemon.log";

/** Sync stages a daemon will run on its own socket, as `POST /sync/<stage>`. */
const SYNC_ROUTE = /^\/sync\/(messages|reactions|history)$/;

/**
 * Keepalive cadence on a running stage.
 *
 * A restore waiting for the owner to reach their phone says nothing for
 * minutes. Without this the client cannot tell that from a daemon that died,
 * and its own inactivity timeout would fire on a run that is working fine.
 */
const PING_MS = 20_000;

/** Client-side inactivity budget: three missed keepalives. */
const DEFAULT_IDLE_MS = 90_000;

/**
 * One stage at a time on a daemon's socket -- the rule the sync routes enforce,
 * as an object the daemon can share with the jobs it starts itself.
 *
 * Two stages sharing the socket is measured to break the restore (see the
 * `lock` note in {@link startDaemonChannel}). The routes used to keep that rule
 * in a variable of their own, which a job the daemon runs on its own
 * initiative -- the offline-queue catch-up after a reconnect (./self-heal.js)
 * -- could not see. Both now hold this one lock: a route that finds it taken
 * answers 409 as before, while the daemon's own job waits its turn.
 *
 * @returns {{
 *   tryAcquire: (stage: string) => (() => void)|null,
 *   acquire: (stage: string) => Promise<() => void>,
 *   current: () => {stage: string, startedAt: number}|null,
 * }} each acquire hands back its release; releasing twice is harmless
 */
export function createStageLock() {
    let held = null;

    const take = (stage) => {
        let settle;
        const done = new Promise((resolve) => (settle = resolve));
        const mine = { stage: String(stage), startedAt: Date.now(), done };
        held = mine;
        return () => {
            if (held !== mine) return;
            held = null;
            settle();
        };
    };

    return {
        tryAcquire(stage) {
            return held ? null : take(stage);
        },
        async acquire(stage) {
            while (held) await held.done;
            return take(stage);
        },
        current() {
            return held ? { stage: held.stage, startedAt: held.startedAt } : null;
        },
    };
}

/** Absolute path of the channel descriptor for an account. */
function channelPath(accountDir) {
    return path.join(accountDir, CHANNEL_FILE);
}

/** True when a pid names a live process. Mirrors lock.js. */
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * The live daemon's channel, or null when there is no usable one.
 *
 * A descriptor whose process is gone is deleted on sight, so a crashed daemon
 * cannot make every later send try to reach a port nobody is listening on.
 *
 * @param {string} accountDir
 * @returns {{port: number, token: string, pid: number, stages: string[]}|null}
 *   `stages` is what this daemon will run for a caller; a descriptor written
 *   before sync routing existed has none, which is not an error.
 */
export function getDaemonChannel(accountDir) {
    const file = channelPath(accountDir);
    try {
        if (!fs.existsSync(file)) return null;
        const info = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!info?.port || !info?.token || !info?.pid) return null;
        if (!isProcessAlive(Number(info.pid))) {
            try {
                fs.unlinkSync(file);
            } catch {
                /* another process cleaned it up first */
            }
            return null;
        }
        return {
            port: Number(info.port),
            token: String(info.token),
            pid: Number(info.pid),
            stages: Array.isArray(info.stages) ? info.stages.map(String) : [],
        };
    } catch {
        return null;
    }
}

/**
 * The running daemon's channel, but only when it can run a sync stage on it.
 *
 * The distinction is the upgrade: a daemon started before sync routing existed
 * publishes a perfectly good channel and 404s every `/sync/` request, and
 * every daemon is that daemon for as long as it keeps running after an
 * upgrade. Asking the descriptor costs nothing, where probing the route would
 * mean sending something. A caller that gets null here is in exactly the
 * situation it was in before this feature: it must not evict the daemon, so it
 * skips or refuses and says that restarting the daemon is what unlocks the
 * hand-off.
 *
 * @param {string} accountDir
 * @param {string} [stage] - require this specific stage; omit to accept any
 * @returns {{port: number, token: string, pid: number, stages: string[]}|null}
 */
export function getSyncChannel(accountDir, stage = null) {
    const chan = getDaemonChannel(accountDir);
    if (!chan || !chan.stages.length) return null;
    return !stage || chan.stages.includes(stage) ? chan : null;
}

/** Constant-time token comparison that tolerates length mismatch. */
function tokenMatches(a, b) {
    const x = Buffer.from(String(a || ""), "utf8");
    const y = Buffer.from(String(b || ""), "utf8");
    if (x.length !== y.length) return false;
    return timingSafeEqual(x, y);
}

/**
 * Read a small JSON body, answering the request myself when it is unusable.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {(code: number, body: object) => void} reply
 * @returns {Promise<object|null>} null when the request was already answered
 */
function readJsonBody(req, reply) {
    return new Promise((resolve) => {
        let raw = "";
        let settled = false;
        const done = (v) => {
            if (settled) return;
            settled = true;
            resolve(v);
        };
        req.setEncoding("utf8");
        // A channel request is a few hundred bytes of paths or sync options.
        // Anything larger is not one, and reading it would only give an
        // attacker a way to grow this process's memory.
        req.on("data", (c) => {
            raw += c;
            if (raw.length > 64 * 1024) req.destroy();
        });
        req.on("end", () => {
            try {
                done(JSON.parse(raw));
            } catch {
                reply(400, { error: "malformed request" });
                done(null);
            }
        });
        // A destroyed request emits "close" without "end"; without this the
        // handler's promise would never settle and the socket would leak.
        req.on("error", () => done(null));
        req.on("close", () => done(null));
    });
}

/**
 * Serve the channel for as long as the daemon runs.
 *
 * @param {object} args
 * @param {() => object} args.getApi - resolves the daemon's CURRENT zca-js api.
 *   A function, not the object: on a duplicate-session close the daemon
 *   re-logs-in and builds a new api, and an upload parked in the old one's
 *   ctx.uploadCallbacks can never be settled -- the send would hang forever.
 * @param {string} args.accountDir
 * @param {(msg: string) => void} [args.onLog] - progress reporting
 * @param {Record<string, (params: object, onEvent: (e: object) => void) => Promise<object>>} [args.runners] -
 *   sync stage bodies, keyed by stage name (see src/core/daemon-sync.js). Each
 *   runs on the daemon's OWN socket, reports progress through `onEvent`, and
 *   resolves the result the invoking CLI prints. A stage with no runner
 *   answers 503, so a daemon that wires none keeps serving uploads exactly as
 *   before. Injected rather than imported because `msg send` imports this
 *   module for sendViaDaemon and must not drag SyncV2's decrypt stack, its
 *   asset fetcher and its db writes into every message send.
 * @param {ReturnType<typeof createStageLock>} [args.lock] - the daemon's stage
 *   lock, shared with the jobs it runs on its own socket (its offline-queue
 *   catch-up). Omitted, the channel keeps one of its own.
 * @param {() => void} [args.onStop] - graceful shutdown callback invoked by
 *   `POST /stop` so `--stop` runs the same teardown as `SIGINT` (stamping
 *   `markConnected`, flushing delivered receipts, releasing `daemon.lock`).
 * @param {(params: object, signal: AbortSignal) => Promise<object>} [args.onWait] -
 *   long-poll callback invoked by `POST /wait` (`zalo-agent mcp wait`).
 * @param {(params: object) => Promise<object>} [args.onMarkRead] -
 *   read-cursor callback invoked by `POST /mark-read` (`zalo-agent mcp mark-read`).
 * @param {() => object} [args.onStatus] - health snapshot returned by `POST /status`
 *   (`listen --status`, `mcp start --status`; see ./daemon-health.js).
 * @returns {Promise<{port: number, stop: () => void}>}
 */
export function startDaemonChannel({
    getApi,
    accountDir,
    onLog,
    runners = {},
    lock = createStageLock(),
    onStop = null,
    onWait = null,
    onMarkRead = null,
    onStatus = null,
}) {
    const token = randomBytes(24).toString("hex");

    // One stage at a time on this socket. Two stages sharing it is measured to
    // break the restore: running the reaction drain beside it lost the socket
    // (close 1006) at batch 0 of 5 on both live attempts -- see the ordering
    // note in src/commands/sync.js. Live capture is deliberately NOT part of
    // this exclusion: the listener is never stopped, so the daemon keeps
    // storing everything that arrives while a stage runs, which is the entire
    // reason for routing the sync here rather than stopping the daemon. The
    // daemon's own catch-up after a reconnect holds the same `lock`.

    /** Hand an attachment upload to this daemon's api. */
    const serveAttachments = async (body, reply) => {
        if (!tokenMatches(body.token, token)) return reply(403, { error: "bad token" });

        const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
        if (!paths.length || !body.threadId) return reply(400, { error: "paths and threadId are required" });

        try {
            onLog?.(`upload on behalf of a sender: ${paths.length} file(s)`);
            // Resolved per request, so a reconnect since startup does not
            // park the upload in a dead api's callback table.
            const result = await getApi().sendMessage(
                { msg: body.caption || "", attachments: paths },
                String(body.threadId),
                Number(body.type) || 0,
            );
            reply(200, { ok: true, result });
        } catch (e) {
            // The sender decides what to do about it; the daemon stays up.
            reply(200, { ok: false, error: e?.message || String(e) });
        }
    };

    /** Run one sync stage on this daemon's socket, streaming progress back. */
    const serveStage = async (stage, body, res, reply) => {
        if (!tokenMatches(body.token, token)) return reply(403, { error: "bad token" });

        const run = runners?.[stage];
        if (typeof run !== "function") {
            return reply(503, { error: `this daemon does not run the ${stage} stage` });
        }
        const release = lock.tryAcquire(stage);
        if (!release) {
            const busy = lock.current() || {};
            return reply(409, {
                error: `a ${busy.stage} sync is already running on this daemon`,
                stage: busy.stage,
                startedAt: busy.startedAt,
            });
        }

        // Committed from here. The head goes out before the stage starts, so a
        // later failure can only be reported as an `error` LINE -- the same
        // trade the attachment route makes by answering {ok:false} on a 200.
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
        res.flushHeaders?.();

        let gone = false;
        const write = (obj) => {
            if (gone || !res.writable) return;
            try {
                res.write(JSON.stringify(obj) + "\n");
            } catch {
                gone = true;
            }
        };
        const ping = setInterval(() => write({ t: "ping" }), PING_MS);
        ping.unref?.();
        // A client that walks away does NOT abort the stage. The restore is
        // writing real messages into zalo.db and still holds the socket, so
        // stopping half way would lose work and free the guard while the
        // socket is busy. We only stop writing to a response nobody reads.
        res.on("close", () => {
            gone = true;
            clearInterval(ping);
        });

        onLog?.(`running the ${stage} sync stage on this daemon's socket`);
        try {
            const params = body.params && typeof body.params === "object" ? body.params : {};
            const result = await run(params, (event) => write({ t: "event", event }));
            write({ t: "done", result });
            onLog?.(`the ${stage} sync stage finished`);
        } catch (e) {
            write({ t: "error", error: e?.message || String(e) });
            onLog?.(`the ${stage} sync stage failed: ${e?.message || String(e)}`);
        } finally {
            clearInterval(ping);
            release();
            try {
                res.end();
            } catch {
                /* the client already went away */
            }
        }
    };

    /** Trigger a graceful shutdown over the loopback channel (`--stop`). */
    const serveStop = (body, reply) => {
        if (!tokenMatches(body.token, token)) return reply(403, { error: "bad token" });
        if (typeof onStop !== "function") {
            return reply(503, { error: "this daemon does not support channel stop" });
        }
        onLog?.("received graceful stop request via daemon channel");
        reply(200, { ok: true, pid: process.pid });
        setImmediate(() => {
            try {
                onStop();
            } catch {
                /* shutdown callback handles its own exit */
            }
        });
    };

    /** Long-poll the MCP daemon's live message buffer (`zalo-agent mcp wait`). */
    const serveWait = async (body, res, reply) => {
        if (!tokenMatches(body.token, token)) return reply(403, { error: "bad token" });
        if (typeof onWait !== "function") {
            return reply(503, {
                error: "this daemon does not have an MCP message buffer (run `zalo-agent mcp start` instead of `listen`)",
            });
        }
        const ac = new AbortController();
        res.on("close", () => ac.abort());
        try {
            const result = await onWait(body, ac.signal);
            if (!res.writableEnded) reply(200, { ok: true, ...result });
        } catch (e) {
            if (!res.writableEnded) reply(200, { ok: false, error: e?.message || String(e) });
        }
    };

    /** Advance one consumer's read cursor in the MCP daemon's buffer (`zalo-agent mcp mark-read`). */
    const serveMarkRead = async (body, reply) => {
        if (!tokenMatches(body.token, token)) return reply(403, { error: "bad token" });
        if (typeof onMarkRead !== "function") {
            return reply(503, {
                error: "this daemon does not have an MCP message buffer (run `zalo-agent mcp start` instead of `listen`)",
            });
        }
        try {
            const result = await onMarkRead(body);
            reply(200, { ok: true, ...result });
        } catch (e) {
            reply(200, { ok: false, error: e?.message || String(e) });
        }
    };

    /** The daemon's health snapshot (`listen --status`, `mcp start --status`). */
    const serveStatus = (body, reply) => {
        if (!tokenMatches(body.token, token)) return reply(403, { error: "bad token" });
        if (typeof onStatus !== "function") return reply(503, { error: "this daemon does not report health" });
        try {
            reply(200, { ok: true, health: onStatus() });
        } catch (e) {
            reply(200, { ok: false, error: e?.message || String(e) });
        }
    };

    const server = http.createServer(async (req, res) => {
        const reply = (code, body) => {
            res.writeHead(code, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") return reply(404, { error: "not found" });

        const stage = SYNC_ROUTE.exec(req.url || "")?.[1];
        if (
            req.url !== "/send-attachments" &&
            req.url !== "/stop" &&
            req.url !== "/wait" &&
            req.url !== "/mark-read" &&
            req.url !== "/status" &&
            !stage
        ) {
            return reply(404, { error: "not found" });
        }

        const body = await readJsonBody(req, reply);
        if (!body) return; // already answered, or the request went away
        if (req.url === "/stop") return serveStop(body, reply);
        if (req.url === "/wait") return serveWait(body, res, reply);
        if (req.url === "/mark-read") return serveMarkRead(body, reply);
        if (req.url === "/status") return serveStatus(body, reply);
        return stage ? serveStage(stage, body, res, reply) : serveAttachments(body, reply);
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        // Loopback only. These endpoints send messages as the logged-in
        // account and restore its history, so they must never be reachable
        // from another machine.
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            // Advertise what this daemon will actually run, so a caller can
            // tell a sync-capable daemon from one started before the routes
            // existed without sending it anything. See getSyncChannel().
            const stages = Object.keys(runners || {}).filter((k) => typeof runners[k] === "function");
            try {
                fs.writeFileSync(channelPath(accountDir), JSON.stringify({ pid: process.pid, port, token, stages }), {
                    mode: 0o600,
                });
            } catch (e) {
                server.close();
                return reject(e);
            }
            resolve({
                port,
                stop() {
                    try {
                        // closeAllConnections, not close(): a stage in flight
                        // holds its response open, and close() alone would
                        // wait for it before the daemon could exit.
                        server.closeAllConnections?.();
                        server.close();
                    } catch {
                        /* already closing */
                    }
                    try {
                        const cur = JSON.parse(fs.readFileSync(channelPath(accountDir), "utf8"));
                        if (Number(cur.pid) === process.pid) fs.unlinkSync(channelPath(accountDir));
                    } catch {
                        /* gone, or another daemon's -- leave it alone */
                    }
                },
            });
        });
    });
}

/**
 * Ask the running daemon to perform an attachment send.
 *
 * @param {string} accountDir
 * @param {{paths: string[], threadId: string, type: number, caption?: string, timeoutMs?: number}} req
 * @returns {Promise<{ok: boolean, result?: object, error?: string}|null>} null when no daemon is running
 */
export function sendViaDaemon(accountDir, req) {
    const chan = getDaemonChannel(accountDir);
    if (!chan) return Promise.resolve(null);

    const payload = JSON.stringify({
        token: chan.token,
        paths: req.paths,
        threadId: String(req.threadId),
        type: Number(req.type) || 0,
        caption: req.caption || "",
    });

    return new Promise((resolve) => {
        const r = http.request(
            {
                host: "127.0.0.1",
                port: chan.port,
                path: "/send-attachments",
                method: "POST",
                headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
                timeout: Number(req.timeoutMs) || 120_000,
            },
            (res) => {
                let raw = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (raw += c));
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(raw));
                    } catch {
                        // A daemon that answers rubbish is a daemon we cannot
                        // use; null sends the caller down its own-socket path.
                        resolve(null);
                    }
                });
            },
        );
        // Every failure resolves null rather than rejecting: an unreachable
        // daemon must degrade to the old behaviour, never fail the send.
        r.on("timeout", () => {
            r.destroy();
            resolve(null);
        });
        r.on("error", () => resolve(null));
        r.end(payload);
    });
}

/**
 * Ask the running daemon to run one sync stage on its socket.
 *
 * The null/non-null split is the opposite of what sendViaDaemon needs, and the
 * difference matters. An attachment send that cannot reach the daemon falls
 * back to opening its own socket, which is merely rude. A SYNC that did the
 * same would evict the daemon -- the exact harm this exists to prevent -- so
 * only one case may say "carry on without me":
 *
 *   - `null`: there is no daemon at all (no descriptor, or its pid is dead).
 *     The caller owns the account's socket and proceeds as it always did.
 *   - `{ok: false, ...}`: a daemon IS there and the stage did not run. The
 *     caller must report that and stop, never open a second session. A live
 *     pid whose channel port refuses the connection counts as this, not as
 *     "no daemon": the process still holds the WebSocket.
 *
 * @param {string} accountDir
 * @param {object} req
 * @param {"messages"|"reactions"} req.stage
 * @param {object} [req.params] - stage options, passed through to the runner
 * @param {(event: object) => void} [req.onEvent] - one call per progress callback
 * @param {number} [req.idleTimeoutMs=90000] - give up after this long with no
 *   line at all. The daemon pings every 20s, so this only fires when it is
 *   genuinely gone -- not while a restore waits on the phone.
 * @returns {Promise<{ok: boolean, result?: object, error?: string, status?: number,
 *   disconnected?: boolean, busyStage?: string, busySince?: number}|null>}
 */
export function syncViaDaemon(accountDir, { stage, params = {}, onEvent, idleTimeoutMs } = {}) {
    const chan = getDaemonChannel(accountDir);
    if (!chan) return Promise.resolve(null);

    const idle = Number(idleTimeoutMs) || DEFAULT_IDLE_MS;
    const payload = JSON.stringify({ token: chan.token, params });

    return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => {
            if (settled) return;
            settled = true;
            resolve(v);
        };

        const r = http.request(
            {
                host: "127.0.0.1",
                port: chan.port,
                path: `/sync/${stage}`,
                method: "POST",
                headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
                timeout: idle,
                // A fresh socket, never one from the global keep-alive pool: a
                // stage holds its connection open for minutes, and a pooled
                // socket would both be an odd thing to park a long stream on
                // and leave the CLI's event loop alive after the run.
                agent: false,
            },
            (res) => {
                let raw = "";
                res.setEncoding("utf8");

                // A daemon that dies mid-stream does NOT error the request and
                // does NOT end the response -- measured: the client sees
                // `aborted` then `error` (ECONNRESET) then `close` on the
                // RESPONSE, and nothing at all on the request. Without these
                // two the promise never settles and the CLI hangs forever on a
                // daemon that is already gone. `close` is the catch-all; the
                // `settled` guard means a finished stage still wins.
                res.on("error", (e) =>
                    finish({ ok: false, disconnected: true, error: e?.code || e?.message || String(e) }),
                );
                res.on("close", () =>
                    finish({
                        ok: false,
                        disconnected: true,
                        error: "the daemon closed the connection before the stage finished",
                    }),
                );

                // A refusal (403/409/503/404) is a plain JSON body, not a
                // stream: the head only becomes NDJSON once the stage starts.
                if (res.statusCode !== 200) {
                    res.on("data", (c) => (raw += c));
                    res.on("end", () => {
                        let body = {};
                        try {
                            body = JSON.parse(raw);
                        } catch {
                            /* an unreadable refusal is still a refusal */
                        }
                        finish({
                            ok: false,
                            status: res.statusCode,
                            error: body.error || `the daemon refused the request (HTTP ${res.statusCode})`,
                            busyStage: body.stage,
                            busySince: body.startedAt,
                        });
                    });
                    return;
                }

                res.on("data", (c) => {
                    raw += c;
                    let nl;
                    while ((nl = raw.indexOf("\n")) >= 0) {
                        const text = raw.slice(0, nl);
                        raw = raw.slice(nl + 1);
                        if (!text.trim()) continue;
                        let ev;
                        try {
                            ev = JSON.parse(text);
                        } catch {
                            continue; // a line we cannot read is not a line we need
                        }
                        if (ev.t === "event") onEvent?.(ev.event);
                        else if (ev.t === "done") finish({ ok: true, result: ev.result });
                        else if (ev.t === "error") finish({ ok: false, error: ev.error });
                    }
                });
                // Ending without a done/error line means the daemon died
                // mid-stage. Silence would read as success, so name it.
                res.on("end", () =>
                    finish({
                        ok: false,
                        disconnected: true,
                        error: "the daemon closed the connection before the stage finished",
                    }),
                );
            },
        );
        r.on("timeout", () => {
            r.destroy();
            finish({ ok: false, disconnected: true, error: `no word from the daemon for ${Math.round(idle / 1000)}s` });
        });
        r.on("error", (e) => finish({ ok: false, disconnected: true, error: e?.message || String(e) }));
        r.end(payload);
    });
}

/**
 * Inspect whether a `listen` or `mcp start` daemon is currently running for an
 * account directory.
 *
 * Consults both `daemon-channel.json` (which removes itself if its PID is dead)
 * and `daemon.lock` (so a daemon still logging in before its channel opens is
 * also seen as running).
 *
 * @param {string} accountDir
 * @returns {{
 *   running: boolean,
 *   pid: number|null,
 *   channelPort: number|null,
 *   stages: string[],
 *   logPath: string,
 * }}
 */
export function getDaemonStatus(accountDir) {
    const logPath = path.join(accountDir, LOG_FILE);
    const chan = getDaemonChannel(accountDir);
    if (chan) {
        return {
            running: true,
            pid: chan.pid,
            channelPort: chan.port,
            stages: chan.stages,
            logPath,
        };
    }

    const lockFile = path.join(accountDir, LOCK_FILE);
    try {
        if (fs.existsSync(lockFile)) {
            const pid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
            if (!Number.isNaN(pid) && isProcessAlive(pid)) {
                return {
                    running: true,
                    pid,
                    channelPort: null,
                    stages: [],
                    logPath,
                };
            }
        }
    } catch {
        /* unreadable lock is treated as not running */
    }

    return {
        running: false,
        pid: null,
        channelPort: null,
        stages: [],
        logPath,
    };
}

/**
 * Ask a running daemon to shut down gracefully over its loopback channel.
 *
 * @param {string} accountDir
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, pid?: number, status?: number, error?: string}|null>}
 *   null when no daemon channel is published
 */
export function stopViaDaemon(accountDir, { timeoutMs = 3000 } = {}) {
    const chan = getDaemonChannel(accountDir);
    if (!chan) return Promise.resolve(null);

    const payload = JSON.stringify({ token: chan.token });
    return new Promise((resolve) => {
        const r = http.request(
            {
                host: "127.0.0.1",
                port: chan.port,
                path: "/stop",
                method: "POST",
                headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
                timeout: Number(timeoutMs) || 3000,
                agent: false,
            },
            (res) => {
                let raw = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (raw += c));
                res.on("end", () => {
                    let body = {};
                    try {
                        body = JSON.parse(raw);
                    } catch {
                        /* non-JSON response */
                    }
                    if (res.statusCode === 200 && body.ok) {
                        resolve({ ok: true, pid: Number(body.pid) || chan.pid });
                    } else {
                        resolve({
                            ok: false,
                            status: res.statusCode,
                            error: body.error || `HTTP ${res.statusCode}`,
                        });
                    }
                });
            },
        );
        r.on("timeout", () => {
            r.destroy();
            resolve({ ok: false, error: "timeout" });
        });
        r.on("error", (e) => resolve({ ok: false, error: e?.message || String(e) }));
        r.end(payload);
    });
}

/**
 * Long-poll the running MCP daemon's live message buffer (`zalo-agent mcp wait`),
 * mirroring the `zalo_wait_for_message` MCP tool over the loopback channel.
 *
 * @param {string} accountDir
 * @param {{threadId?: string|null, since?: number, timeoutSec?: number, consumer?: string}} [opts]
 * @returns {Promise<{ok: boolean, status?: "message"|"timeout"|number, message?: object|null, cursor?: number, error?: string}|null>}
 *   null when no daemon channel is published
 */
export function waitViaDaemon(
    accountDir,
    { threadId = null, since = undefined, timeoutSec = 55, consumer, limit = 1, settleMs = 0 } = {},
) {
    const chan = getDaemonChannel(accountDir);
    if (!chan) return Promise.resolve(null);

    const clampedSec = Math.max(1, Math.min(300, Number(timeoutSec) || 55));
    const payload = JSON.stringify({
        token: chan.token,
        ...(threadId ? { threadId: String(threadId) } : {}),
        ...(typeof since === "number" && Number.isFinite(since) ? { since } : {}),
        timeoutSec: clampedSec,
        ...(limit > 1 ? { limit } : {}),
        ...(settleMs > 0 ? { settleMs } : {}),
        ...(consumer ? { consumer: String(consumer) } : {}),
    });

    return new Promise((resolve) => {
        const r = http.request(
            {
                host: "127.0.0.1",
                port: chan.port,
                path: "/wait",
                method: "POST",
                headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
                timeout: (clampedSec + 10) * 1000,
                agent: false,
            },
            (res) => {
                let raw = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (raw += c));
                res.on("end", () => {
                    let body = {};
                    try {
                        body = JSON.parse(raw);
                    } catch {
                        /* non-JSON response */
                    }
                    if (res.statusCode === 200 && body.ok) {
                        resolve({
                            ok: true,
                            status: body.status,
                            message: body.message ?? null,
                            messages: Array.isArray(body.messages) ? body.messages : body.message ? [body.message] : [],
                            count: body.count ?? (body.message ? 1 : 0),
                            hasMore: Boolean(body.hasMore),
                            cursor: body.cursor,
                        });
                    } else {
                        resolve({
                            ok: false,
                            status: res.statusCode,
                            error: body.error || `HTTP ${res.statusCode}`,
                        });
                    }
                });
            },
        );
        r.on("timeout", () => {
            r.destroy();
            resolve({ ok: false, error: "timeout waiting for daemon response" });
        });
        r.on("error", (e) => resolve({ ok: false, error: e?.message || String(e) }));
        r.end(payload);
    });
}

/**
 * Advance one consumer's read cursor in the running MCP daemon's live message
 * buffer (`zalo-agent mcp mark-read`), mirroring the `zalo_mark_read` MCP tool.
 *
 * @param {string} accountDir
 * @param {{cursor: number, consumer?: string}} opts
 * @returns {Promise<{ok: boolean, marked?: number, readCursor?: number, consumer?: string, status?: number, error?: string}|null>}
 *   null when no daemon channel is published
 */
export function markReadViaDaemon(accountDir, { cursor, consumer } = {}) {
    const chan = getDaemonChannel(accountDir);
    if (!chan) return Promise.resolve(null);

    const payload = JSON.stringify({
        token: chan.token,
        cursor: Number(cursor),
        ...(consumer ? { consumer: String(consumer) } : {}),
    });

    return new Promise((resolve) => {
        const r = http.request(
            {
                host: "127.0.0.1",
                port: chan.port,
                path: "/mark-read",
                method: "POST",
                headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
                timeout: 5000,
                agent: false,
            },
            (res) => {
                let raw = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (raw += c));
                res.on("end", () => {
                    let body = {};
                    try {
                        body = JSON.parse(raw);
                    } catch {
                        /* non-JSON response */
                    }
                    if (res.statusCode === 200 && body.ok) {
                        resolve({
                            ok: true,
                            marked: body.marked ?? 0,
                            readCursor: body.readCursor ?? Number(cursor),
                            consumer: body.consumer || consumer || "default",
                        });
                    } else {
                        resolve({
                            ok: false,
                            status: res.statusCode,
                            error: body.error || `HTTP ${res.statusCode}`,
                        });
                    }
                });
            },
        );
        r.on("timeout", () => {
            r.destroy();
            resolve({ ok: false, error: "timeout waiting for daemon response" });
        });
        r.on("error", (e) => resolve({ ok: false, error: e?.message || String(e) }));
        r.end(payload);
    });
}

/**
 * Stop the running daemon for an account directory, preferring `POST /stop` so
 * the daemon runs its own graceful shutdown handler (`markConnected`, receipt
 * flush, lock/channel cleanup) before falling back to `process.kill(pid)`.
 *
 * @param {string} accountDir
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{stopped: boolean, pid: number|null, graceful: boolean}>}
 */
export async function stopDaemon(accountDir, { timeoutMs = 5000 } = {}) {
    const status = getDaemonStatus(accountDir);
    const lockFile = path.join(accountDir, LOCK_FILE);
    const chanFile = channelPath(accountDir);

    if (!status.running || !status.pid) {
        for (const f of [lockFile, chanFile]) {
            try {
                if (fs.existsSync(f)) fs.unlinkSync(f);
            } catch {
                /* already removed */
            }
        }
        return { stopped: false, pid: null, graceful: false };
    }

    const pid = status.pid;
    let graceful = false;
    const stopRes = await stopViaDaemon(accountDir, { timeoutMs: Math.min(2500, timeoutMs) });
    if (stopRes?.ok) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!isProcessAlive(pid)) {
                graceful = true;
                break;
            }
            await new Promise((r) => setTimeout(r, 80));
        }
    }

    if (isProcessAlive(pid)) {
        try {
            process.kill(pid);
        } catch {
            /* exited between check and kill */
        }
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && isProcessAlive(pid)) {
            await new Promise((r) => setTimeout(r, 80));
        }
    }

    for (const f of [lockFile, chanFile]) {
        try {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {
            /* already removed */
        }
    }

    return { stopped: true, pid, graceful };
}

/**
 * Quote a single argument for a Windows `CommandLineToArgvW` command line.
 *
 * @param {string} arg
 * @returns {string}
 */
function quoteWinArg(arg) {
    const s = String(arg);
    if (!/[\s"]/.test(s) && s.length > 0) return s;
    let out = '"';
    let backslashes = 0;
    for (const ch of s) {
        if (ch === "\\") {
            backslashes++;
        } else if (ch === '"') {
            out += "\\".repeat(backslashes * 2 + 1) + '"';
            backslashes = 0;
        } else {
            out += "\\".repeat(backslashes) + ch;
            backslashes = 0;
        }
    }
    out += "\\".repeat(backslashes * 2) + '"';
    return out;
}

/**
 * When launched as a detached background child via WMI (`ZALO_DAEMON_LOG` set),
 * redirect `process.stdout.write` and `process.stderr.write` to the daemon log
 * file so every log line and uncaught error is captured without relying on
 * inherited OS file descriptors.
 */
export function attachDaemonLogIfChild() {
    if (process.env.ZALO_DAEMON_CHILD !== "1" || !process.env.ZALO_DAEMON_LOG) return;
    const logPath = process.env.ZALO_DAEMON_LOG;
    // The account is the name of the directory the log lives in (<data dir>/<ownId>/daemon.log).
    const ownId = path.basename(path.dirname(logPath));
    const settings = resolveLogSettings({ env: process.env, ownId });

    let file;
    try {
        file = createRotatingFile({ file: logPath, maxBytes: settings.maxBytes, keep: settings.keep });
        file.write(""); // fail now, here, if the log cannot be opened
    } catch {
        return;
    }
    // Levels, timestamps (or JSON) and rotation in front of the file; see ./log-sink.js.
    const sink = createLogSink({ write: file.write, level: settings.level, format: settings.format, accountId: ownId });
    daemonSink = sink;
    const done = (encoding, cb) => {
        if (typeof encoding === "function") encoding();
        else if (typeof cb === "function") cb();
        return true;
    };
    process.stdout.write = (chunk, encoding, cb) => {
        sink.write(chunk);
        return done(encoding, cb);
    };
    process.stderr.write = (chunk, encoding, cb) => {
        sink.write(chunk);
        return done(encoding, cb);
    };
    for (const w of settings.warnings) sink.write(`[logging] ${w}\n`);
    process.on("uncaughtException", (err) => {
        sink.write(`${err?.stack || err}\n`);
        sink.flush();
        process.exit(1);
    });
    process.on("exit", () => sink.flush());
}

/** The daemon child's log sink, once attachDaemonLogIfChild has built it. */
let daemonSink = null;

/**
 * Apply `--log-level` and the per-account settings once the account is known, and, for a run that is not a
 * background daemon, filter stderr when a level or format was asked for.
 *
 * @param {object} args
 * @param {string} args.ownId
 * @param {string|null} [args.levelFlag] - Already validated
 * @param {boolean} [args.filterStderr=true] - Filter stderr of a foreground run; false for the process that only launches a daemon
 * @returns {{ level: string, format: string, warnings: string[] }}
 */
export function configureLogging({ ownId, levelFlag = null, filterStderr = true }) {
    const settings = resolveLogSettings({ env: process.env, ownId, levelFlag });
    if (daemonSink) {
        daemonSink.setLevel(settings.level);
        daemonSink.setFormat(settings.format);
    } else if (filterStderr && settings.explicit && !foregroundFilter) {
        // A foreground run writes to the terminal: filter stderr in place, keep stdout (the output) alone.
        const original = process.stderr.write.bind(process.stderr);
        foregroundFilter = createLogSink({
            write: (text) => original(text),
            level: settings.level,
            format: settings.format,
            accountId: ownId,
        });
        process.stderr.write = (chunk, encoding, cb) => {
            foregroundFilter.write(chunk);
            if (typeof encoding === "function") encoding();
            else if (typeof cb === "function") cb();
            return true;
        };
    }
    return { level: settings.level, format: settings.format, warnings: settings.warnings };
}

let foregroundFilter = null;

/**
 * On Windows, spawn via `Win32_Process.Create` (WMI) so the background daemon
 * is parented to `WmiPrvSE.exe` outside any terminal or agent Job Object
 * (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), preventing the daemon from dying when
 * the calling shell or tool session closes. Returns the new PID or null on
 * failure so the caller can fall back to `child_process.spawn`.
 *
 * @param {string} execPath
 * @param {string[]} args
 * @param {string} logPath
 * @returns {number|null}
 */
function trySpawnWin32JobBreakaway(execPath, args, logPath) {
    if (process.platform !== "win32") return null;
    try {
        const cmdLine = [quoteWinArg(execPath), ...args.map(quoteWinArg)].join(" ");
        const psScript = [
            "$cmd = $env:ZALO_DAEMON_CMD",
            "Remove-Item Env:\\ZALO_DAEMON_CMD -ErrorAction SilentlyContinue",
            '$envList = [string[]]@([System.Environment]::GetEnvironmentVariables().GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })',
            "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = $envList }",
            "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = (Get-Location).Path; ProcessStartupInformation = $si }",
            "if ($r.ReturnValue -ne 0 -or -not $r.ProcessId) { exit 1 }",
            "Write-Output $r.ProcessId",
        ].join("; ");
        const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
            windowsHide: true,
            encoding: "utf8",
            timeout: 8000,
            env: {
                ...process.env,
                ZALO_DAEMON_CHILD: "1",
                ZALO_DAEMON_LOG: logPath,
                ZALO_DAEMON_CMD: cmdLine,
            },
        });
        if (res.status === 0 && res.stdout) {
            const pid = parseInt(res.stdout.trim(), 10);
            if (!Number.isNaN(pid) && pid > 0) return pid;
        }
    } catch {
        /* fall back to standard detached spawn */
    }
    return null;
}

/**
 * Spawn a detached background daemon (`listen -d` or `mcp start --http <port> -d`)
 * redirecting stdout and stderr to `<accountDir>/daemon.log`, and wait until its
 * loopback channel is ready (or report startup failure if it exits early).
 *
 * @param {object} opts
 * @param {string} opts.accountDir
 * @param {string[]} [opts.args] - CLI arguments (defaults to `process.argv.slice(1)`)
 * @param {number} [opts.timeoutMs=15000] - how long to wait for the channel to come up
 * @returns {Promise<{
 *   ok: boolean,
 *   alreadyRunning?: boolean,
 *   pid?: number,
 *   channelPort?: number|null,
 *   logPath: string,
 *   error?: string,
 * }>}
 */
export async function spawnDaemonProcess({ accountDir, args = process.argv.slice(1), timeoutMs = 15_000 }) {
    const status = getDaemonStatus(accountDir);
    if (status.running) {
        return {
            ok: false,
            alreadyRunning: true,
            pid: status.pid,
            channelPort: status.channelPort,
            logPath: status.logPath,
        };
    }

    fs.mkdirSync(accountDir, { recursive: true });
    const logPath = path.join(accountDir, LOG_FILE);
    const filteredArgs = args.filter((a) => a !== "-d" && a !== "--daemon");

    const logFd = fs.openSync(logPath, "a", 0o600);
    // Never the secrets: --auth, --client-secret and --webhook-secret values are masked.
    const header = `\n--- [${new Date().toISOString()}] starting daemon: ${maskSecretArgs(filteredArgs).join(" ")} ---\n`;
    fs.writeSync(logFd, header);
    let startOffset = 0;
    try {
        startOffset = fs.statSync(logPath).size;
    } catch {
        /* ignore */
    }

    let pid = trySpawnWin32JobBreakaway(process.execPath, filteredArgs, logPath);
    if (pid !== null) {
        try {
            fs.closeSync(logFd);
        } catch {
            /* ignore */
        }
    } else {
        const child = spawn(process.execPath, filteredArgs, {
            detached: true,
            windowsHide: true,
            stdio: ["ignore", logFd, logFd],
            env: { ...process.env, ZALO_DAEMON_CHILD: "1", ZALO_DAEMON_LOG: logPath },
        });
        try {
            fs.closeSync(logFd);
        } catch {
            /* ignore */
        }
        child.unref();
        pid = child.pid;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const chan = getDaemonChannel(accountDir);
        if (chan && chan.pid === pid) {
            return { ok: true, pid, channelPort: chan.port, logPath };
        }
        if (!isProcessAlive(pid)) {
            let tail = "";
            try {
                const buf = fs.readFileSync(logPath);
                tail = buf.subarray(startOffset).toString("utf8").trim();
            } catch {
                /* ignore */
            }
            const lastLine =
                tail
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .filter(Boolean)
                    .pop() || "Daemon process exited before becoming ready.";
            return { ok: false, pid, logPath, error: lastLine };
        }
        await new Promise((r) => setTimeout(r, 150));
    }

    const finalStatus = getDaemonStatus(accountDir);
    if (finalStatus.running && finalStatus.pid === pid) {
        return { ok: true, pid, channelPort: finalStatus.channelPort, logPath };
    }
    return {
        ok: false,
        pid,
        logPath,
        error: "Timed out waiting for background daemon to finish starting.",
    };
}

/**
 * Ask the running daemon for its health snapshot (`listen --status`, `mcp start --status`).
 *
 * @param {string} accountDir
 * @returns {Promise<{ok: boolean, health?: object, error?: string}|null>} null when no daemon channel is published;
 *   `ok: false` for a daemon too old to answer (it has the channel but not the route)
 */
export function statusViaDaemon(accountDir) {
    const chan = getDaemonChannel(accountDir);
    if (!chan) return Promise.resolve(null);
    const payload = JSON.stringify({ token: chan.token });
    return new Promise((resolve) => {
        const r = http.request(
            {
                host: "127.0.0.1",
                port: chan.port,
                path: "/status",
                method: "POST",
                headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
                timeout: 5000,
                agent: false,
            },
            (res) => {
                let raw = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (raw += c));
                res.on("end", () => {
                    let body = {};
                    try {
                        body = JSON.parse(raw);
                    } catch {
                        /* non-JSON response */
                    }
                    resolve(
                        res.statusCode === 200 && body.ok
                            ? { ok: true, health: body.health }
                            : { ok: false, error: body.error || `HTTP ${res.statusCode}` },
                    );
                });
            },
        );
        r.on("timeout", () => {
            r.destroy();
            resolve({ ok: false, error: "timeout waiting for the daemon" });
        });
        r.on("error", (e) => resolve({ ok: false, error: e?.message || String(e) }));
        r.end(payload);
    });
}
