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
import { randomBytes, timingSafeEqual } from "node:crypto";

const CHANNEL_FILE = "daemon-channel.json";

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
 * @returns {Promise<{port: number, stop: () => void}>}
 */
export function startDaemonChannel({ getApi, accountDir, onLog, runners = {}, lock = createStageLock() }) {
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

    const server = http.createServer(async (req, res) => {
        const reply = (code, body) => {
            res.writeHead(code, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") return reply(404, { error: "not found" });

        const stage = SYNC_ROUTE.exec(req.url || "")?.[1];
        if (req.url !== "/send-attachments" && !stage) return reply(404, { error: "not found" });

        const body = await readJsonBody(req, reply);
        if (!body) return; // already answered, or the request went away
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
