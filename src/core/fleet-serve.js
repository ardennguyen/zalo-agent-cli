/**
 * `zalo-agent fleet serve`: the fleet controller's HTTP server (built around ./fleet-controller.js) and what it is built from on a
 * real host: the supervisor driver (./fleet-supervisor.js), each daemon's loopback channel, the CLI for a logout or a
 * removal, the admin credential (./admin-api.js), and the admin webhook.
 *
 * It holds no account lock and opens no Zalo socket. Binds 127.0.0.1 unless told otherwise; put a reverse proxy with
 * TLS in front (`publicUrl`) for a CRM on another machine.
 */
import express from "express";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { createAdminApi, resolveAdminCredentials } from "./admin-api.js";
import { assignPorts } from "./fleet.js";
import { LOCAL_PROXY, accountPublicUrl, renderAccountEnv } from "./fleet-templates.js";
import { applyPolicy, getPolicy } from "./policy-store.js";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";

/** The default port of the controller. */
export const DEFAULT_CONTROLLER_PORT = 3899;

/**
 * The SHA-256 of every agent token in an env dir (`<dir>/<ownId>.env`, `ZALO_MCP_AUTH_TOKEN`): refused by the
 * controller even if an admin token were set to the same value.
 *
 * @param {string|null} dir
 * @returns {Set<string>} hex digests
 */
export function agentTokenHashes(dir) {
    const out = new Set();
    if (!dir || !existsSync(dir)) return out;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".env"))) {
        try {
            const env = parseEnv(readFileSync(join(dir, f), "utf8"));
            for (const [k, v] of Object.entries(env)) {
                if (/^ZALO_MCP_AUTH_TOKEN(_\d+)?$/.test(k) && v)
                    out.add(createHash("sha256").update(v, "utf8").digest("hex"));
            }
        } catch {
            /* an unreadable file holds no token we can check */
        }
    }
    return out;
}

/**
 * Run this CLI as a child (`account remove`, `logout`): the same guards and code paths a person gets.
 *
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv}} [o]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runSelf(args, { env = process.env } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [process.argv[1], ...args], {
            env: { ...env, ZALO_JSON_MODE: "1" },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + e.message }));
        child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

/**
 * The admin webhook: every `account_state` and QR event, POSTed as JSON, signed like the daemons' webhooks when a
 * secret is set (`Authorization: Bearer <secret>`, `X-Zalo-Signature: sha256=<HMAC>`). Fire and forget.
 *
 * @param {string|null} url
 * @param {string|null} secret
 * @param {typeof fetch} [fetchFn]
 * @returns {(event: object) => void}
 */
export function adminWebhook(url, secret, fetchFn = fetch) {
    if (!url) return () => {};
    return (event) => {
        const body = JSON.stringify(event);
        const headers = { "Content-Type": "application/json" };
        if (secret) {
            headers.Authorization = `Bearer ${secret}`;
            headers["X-Zalo-Signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
        }
        fetchFn(url, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) }).catch(() => {});
    };
}

/**
 * Build the controller's express app.
 *
 * @param {object} args
 * @param {object} args.controller - ./fleet-controller.js
 * @param {object} [args.config] - the MCP config (`admin.*`)
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {Set<string>} [args.agentHashes] - refused tokens (hex SHA-256)
 * @param {{servePage: (req: object, res: object) => Promise<boolean>}|null} [args.qrPages]
 * @param {(line: string) => void} [args.log]
 * @returns {{app: object, admin: object}}
 */
export function buildControllerApp({
    controller,
    config = {},
    env = process.env,
    agentHashes = new Set(),
    qrPages = null,
    log = (l) => console.error(l),
}) {
    const creds = resolveAdminCredentials({ config, env });
    for (const p of creds.problems) log(`[fleet] ${p}`);
    const admin = createAdminApi({
        ownId: null,
        config,
        hashes: creds.hashes,
        mtls: false,
        isAgentCredential: (token) => agentHashes.has(createHash("sha256").update(token, "utf8").digest("hex")),
        routes: (req, res, ctx) => controller.handle(req, res, ctx),
        log,
    });
    const app = express();
    app.disable("x-powered-by");
    if (qrPages) {
        app.use("/zalo/qr/", (req, res, next) => {
            req.url = req.originalUrl;
            qrPages
                .servePage(req, res)
                .then((done) => {
                    if (!done && !res.headersSent) res.status(404).set("Cache-Control", "no-store").end();
                })
                .catch(next);
        });
    }
    app.use(express.json({ limit: "64kb" }));
    app.use("/zalo/admin", (req, res) => admin.handle(req, res));
    app.get("/health", (_req, res) => res.json({ status: "ok", kind: "fleet-controller" }));
    return { app, admin };
}

/** A free loopback port (the child login's own page; never offered, but it must not collide). */
function freePort() {
    return new Promise((resolve) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on("error", () => resolve(0));
    });
}

/**
 * One QR login as a child process (`zalo-agent --json login`), for ./fleet-qr.js: its JSON lines, a kill, its exit.
 * The child is the same `login` a person runs (credentials saved, account registered); a QR login is HTTP and opens no
 * chat socket.
 *
 * @param {{proxy?: string|null}} [o]
 * @returns {{onLine: (fn: (line: string) => void) => void, kill: () => void, exited: Promise<number>}}
 */
export function spawnLoginChild({ proxy = null } = {}) {
    const lines = [];
    const subscribers = [];
    let child = null;
    let killed = false;
    const exited = freePort().then(
        (port) =>
            new Promise((resolve) => {
                if (killed) return resolve(1);
                child = spawn(
                    process.execPath,
                    [
                        process.argv[1],
                        "--json",
                        "login",
                        ...(port ? ["--qr-port", String(port)] : []),
                        ...(proxy ? ["--proxy", proxy] : []),
                    ],
                    {
                        env: { ...process.env, ZALO_JSON_MODE: "1" },
                        stdio: ["ignore", "pipe", "pipe"],
                        windowsHide: true,
                    },
                );
                const rl = createInterface({ input: child.stdout });
                rl.on("line", (l) => {
                    lines.push(l);
                    for (const fn of subscribers) fn(l);
                });
                child.stderr.resume();
                child.on("error", () => resolve(1));
                child.on("exit", (code) => resolve(code ?? 1));
            }),
    );
    return {
        onLine: (fn) => {
            subscribers.push(fn);
            for (const l of lines) fn(l);
        },
        kill: () => {
            killed = true;
            child?.kill();
        },
        exited,
    };
}

/**
 * The QR add's finish steps, after the child login registered the account: a port, the env file with a generated
 * token (and, with a `domain`, the account's public URL as `fleet generate --domain` writes it), the user's
 * membership, the presence mode, and the start (or a deliberate restart of a daemon the new login kicked).
 *
 * @param {object} o
 * @param {string} o.ownId
 * @param {string} o.userId
 * @param {"on-demand"|"always-on"|null} o.presence
 * @param {boolean} o.start
 * @param {boolean} o.wasRunning
 * @param {string|null} o.envDir
 * @param {string|null} [o.domain] - the proxy layout's host: the env file gets `ZALO_MCP_PUBLIC_URL=https://<domain>/a/<id>`
 * @param {boolean} [o.trustProxy] - also `ZALO_MCP_TRUSTED_PROXIES=127.0.0.1` (the shared env does not trust the proxy)
 * @param {{start: Function, restart: Function}} o.driver
 * @param {() => string} [o.makeToken]
 * @returns {Promise<object>} what the `done` event carries
 */
export async function finishQrAdd({
    ownId,
    userId,
    presence,
    start,
    wasRunning,
    envDir,
    domain = null,
    trustProxy = false,
    driver,
    makeToken = () => randomBytes(32).toString("hex"),
}) {
    const port = assignPorts([ownId]).ports[ownId];
    const publicUrl = domain ? accountPublicUrl(domain, ownId) : null;
    let envWritten = false;
    if (envDir) {
        const file = join(envDir, `${ownId}.env`);
        if (!existsSync(file)) {
            mkdirSync(envDir, { recursive: true });
            const trustedProxies = publicUrl && trustProxy ? LOCAL_PROXY : null;
            writeFileAtomic(file, renderAccountEnv({ ownId, port, token: makeToken(), publicUrl, trustedProxies }), {
                mode: 0o600,
            });
            envWritten = true;
        }
    }
    const user = getPolicy({ kind: "user", id: userId });
    if (!user.accounts.includes(ownId)) {
        applyPolicy({
            target: { kind: "user", id: userId },
            op: "patch",
            policy: {},
            accounts: [...user.accounts, ownId],
            actor: "fleet-controller qr",
        });
    }
    let demoted = [];
    if (presence) {
        demoted = applyPolicy({
            target: { kind: "account", id: ownId },
            op: "patch",
            policy: { presence: { mode: presence } },
            actor: "fleet-controller qr",
        }).demoted;
    }
    const out = {
        port,
        envWritten,
        userId,
        ...(envWritten && publicUrl ? { publicUrl } : {}),
        ...(demoted.length ? { demoted } : {}),
    };
    if (wasRunning) {
        // The new login took the session from the running daemon (it exits 3): bring it back on purpose.
        const r = await driver.restart(ownId);
        return { ...out, restarted: "relogin", started: r.ok };
    }
    if (start) {
        const r = await driver.start(ownId);
        return { ...out, started: r.ok };
    }
    return { ...out, started: false };
}
