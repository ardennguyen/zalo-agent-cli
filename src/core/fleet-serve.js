/**
 * `zalo-agent fleet serve`: the fleet controller's HTTP server (built around ./fleet-controller.js) and what it is built from on a
 * real host: the supervisor driver (./fleet-supervisor.js), each daemon's loopback channel, the CLI for a logout or a
 * removal, the admin credential (./admin-api.js), and the admin webhook.
 *
 * It holds no account lock and opens no Zalo socket. Binds 127.0.0.1 unless told otherwise; put a reverse proxy with
 * TLS in front (`publicUrl`) for a CRM on another machine.
 */
import express from "express";
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { createAdminApi, resolveAdminCredentials } from "./admin-api.js";

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
