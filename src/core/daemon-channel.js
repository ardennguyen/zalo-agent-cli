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
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

const CHANNEL_FILE = "daemon-channel.json";

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
 * @returns {{port: number, token: string, pid: number}|null}
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
        return { port: Number(info.port), token: String(info.token), pid: Number(info.pid) };
    } catch {
        return null;
    }
}

/** Constant-time token comparison that tolerates length mismatch. */
function tokenMatches(a, b) {
    const x = Buffer.from(String(a || ""), "utf8");
    const y = Buffer.from(String(b || ""), "utf8");
    if (x.length !== y.length) return false;
    return timingSafeEqual(x, y);
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
 * @returns {Promise<{port: number, stop: () => void}>}
 */
export function startDaemonChannel({ getApi, accountDir, onLog }) {
    const token = randomBytes(24).toString("hex");

    const server = http.createServer((req, res) => {
        const reply = (code, body) => {
            res.writeHead(code, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (req.method !== "POST" || req.url !== "/send-attachments") return reply(404, { error: "not found" });

        let raw = "";
        req.setEncoding("utf8");
        // A send request is a few hundred bytes of paths. Anything larger is
        // not one, and reading it would only give an attacker a way to grow
        // this process's memory.
        req.on("data", (c) => {
            raw += c;
            if (raw.length > 64 * 1024) req.destroy();
        });
        req.on("end", async () => {
            let body;
            try {
                body = JSON.parse(raw);
            } catch {
                return reply(400, { error: "malformed request" });
            }
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
        });
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        // Loopback only. This endpoint sends messages as the logged-in account,
        // so it must never be reachable from another machine.
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            try {
                fs.writeFileSync(channelPath(accountDir), JSON.stringify({ pid: process.pid, port, token }), {
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
