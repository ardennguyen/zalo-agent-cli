/**
 * Express server wrapping MCP StreamableHTTP transport with bearer token and OAuth 2.0 auth.
 * Uses stateless mode — each POST /mcp request creates a fresh server+transport.
 */

import { createApiKeyChecker } from "../core/api-keys.js";
import express from "express";
import { renderPrometheus } from "../core/daemon-health.js";
import { batchParams, waitResult } from "./wait-result.js";
import { DEBUG_MARK } from "../core/log-sink.js";
import https from "https";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { newMcpServer } from "./new-server.js";
import { maskSecurePath, SECURE_PATH_PREFIX } from "../core/secure-page.js";
import { maskQrPath, QR_PATH_PREFIX } from "../utils/qr-http-server.js";
import { maskMediaPath, MEDIA_PATH_PREFIX } from "../core/media-deliver.js";
import { clientIpOf, handleMediaRequest, isLoopbackIp } from "../core/media-route.js";
import { ADMIN_PATH_PREFIX } from "../core/admin-api.js";
import { PRESENCE_PATH_PREFIX } from "../core/presence-leases.js";
import { approverFor } from "../core/approval.js";
import { mountOAuth, oauthStartCheck, safeEqual } from "./mcp-oauth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __ZALO_PKG_VERSION__ is substituted by esbuild in the published bundle (scripts/build.mjs); undefined from source.
const pkg = {
    version:
        typeof __ZALO_PKG_VERSION__ !== "undefined"
            ? __ZALO_PKG_VERSION__
            : JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")).version,
};

/**
 * Create HTTP or HTTPS MCP server with optional bearer token and OAuth 2.0 auth.
 * @param {Function} registerToolsFn - Registers tools on a McpServer instance
 * @param {object} deps - { api, buffer, filter, config, nameCache, accountDir, stageLock, syncJobs, health,
 *   securePage, qrPage, hiddenEvents }
 *   (`health` is the daemon's ./core/daemon-health.js object: behind /health, /ready, /status and /metrics;
 *   `securePage` serves the one-time input page at /zalo/secure/<token>, src/core/secure-page.js; `qrPage` the
 *   one-time QR login page at /zalo/qr/<token>, src/utils/qr-http-server.js; `hiddenEvents`
 *   applies the hiddenChats policy to /events/wait's messages; `presence` is the daemon's on-demand presence,
 *   src/core/daemon-presence.js: every tool call and every /events/wait goes through it; `leases` its CRM lease
 *   routes under /zalo/presence; `oauthApprover` returns approverFor's answer for the OAuth approve page,
 *   src/core/approval.js: by default the approver password of `accountDir`)
 * @param {number} port
 * @param {string|null} authToken - Bearer token (null = no auth unless OAuth is on)
 * @param {string} [host="127.0.0.1"] - Bind address
 * @param {{cert: Buffer|string, key: Buffer|string}|null} [tls=null] - TLS cert and private key for HTTPS
 * @param {object|null} [oauth=null] - the OAuth settings (src/mcp/mcp-oauth.js mountOAuth): `clientId`, `clientSecret`,
 *   `redirectUris`, `clients[]` (`{clientId, clientSecret?, redirectUris?}`), `issuerUrl` (publicUrl),
 *   `allowDynamicRegistration`, `secretsAsBearer`, `accessTokenTtlSec`, `refreshTokenTtlSec`, `accountId`, `stateFile`
 * @returns {import("http").Server | import("https").Server}
 * @throws {Error} when OAuth is on but cannot start safely (no publicUrl off loopback, nothing to sign with)
 */
export function createHTTPServer(registerToolsFn, deps, port, authToken, host = "127.0.0.1", tls = null, oauth = null) {
    const app = express();
    const isTls = Boolean(tls?.cert && tls?.key);
    // OAuth is on only when a client is configured or dynamic registration is on (src/mcp/mcp-oauth.js); a server that
    // cannot name its issuer safely, or has nothing to sign with, does not start it.
    const oauthCheck = oauthStartCheck({ oauth, authToken, host, publicUrl: oauth?.issuerUrl || null });
    if (oauthCheck.problem) throw new Error(oauthCheck.problem);
    const authEnabled = Boolean(authToken) || oauthCheck.enabled;
    // Named API keys (src/core/api-keys.js), read live: the first key made turns the bearer check on. So does an OAuth
    // mode saved for the account from the console (src/mcp/oauth-settings.js), whatever it is.
    const apiKeys = deps.apiKeys || createApiKeyChecker(deps.accountDir || null);
    const authOn = () => authEnabled || apiKeys.any() || Boolean(oauthServer?.requiresAuth());
    /** @type {ReturnType<typeof mountOAuth>|null} mounted below, after the body parsers */
    let oauthServer = null;

    /**
     * Whether a bearer token is this server's own credential: the --auth token or an OAuth access token it issued
     * (and, with oauth.secretsAsBearer, a configured client secret). With `req`, an access token's issuer and audience
     * are checked against it. Used by the auth middleware, a bearer media link and the admin API (which refuses it).
     * @param {string} token
     * @param {import("express").Request|null} [req]
     * @returns {boolean}
     */
    const isAgentToken = (token, req = null) => identifyToken(token, req) !== null;
    /**
     * Which of this server's credentials a bearer token is, or null when it opens nothing: `{credential, label?}`
     * with `credential` `legacy` (the --auth token), `apikey:<keyId>` or `oauth:<clientId>[/<grantId>]`. The tool
     * handlers bind it to the account's agent (src/mcp/agents.js); a token is never logged or kept.
     * @param {string} token
     * @param {import("express").Request|null} [req]
     * @returns {{credential: string, label?: string|null}|null}
     */
    const identifyToken = (token, req = null) => {
        if (!authOn() || !token) return null;
        if (authToken && safeEqual(token, authToken)) return { credential: "legacy" };
        const key = apiKeys.identify ? apiKeys.identify(token) : apiKeys.verify(token) ? { keyId: "unknown" } : null;
        if (key) return { credential: `apikey:${key.keyId}`, label: key.label ?? null };
        const grant = oauthServer?.identifyBearer
            ? oauthServer.identifyBearer(token, req)
            : oauthServer?.verifyBearer(token, req)
              ? { clientId: "unknown" }
              : null;
        if (grant)
            return { credential: `oauth:${grant.clientId}${grant.grantId ? `/${grant.grantId}` : ""}`, label: null };
        return null;
    };
    const isAuthorized = (req) => {
        const authHeader = String(req.headers.authorization || "");
        const token = /^bearer\s+/i.test(authHeader) ? authHeader.replace(/^bearer\s+/i, "").trim() : "";
        return isAgentToken(token, req);
    };

    // CORS headers for browser-based MCP clients and OAuth discovery
    app.use((req, res, next) => {
        const remoteIp = req.socket?.remoteAddress || "";
        const isLoopbackWait =
            req.path === "/events/wait" &&
            (remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1");
        if (!isLoopbackWait) {
            res.on("finish", () => {
                const ua = String(req.headers["user-agent"] || "-").slice(0, 80);
                const h = String(req.headers.host || "-");
                console.error(
                    `${DEBUG_MARK}[mcp-http] ${req.method} ${maskMediaPath(maskQrPath(maskSecurePath(req.originalUrl)))} -> ${res.statusCode} (host=${h} ip=${remoteIp} ua="${ua}")`,
                );
            });
        }
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
        if (req.method === "OPTIONS") {
            return res.status(204).end();
        }
        next();
    });

    // The one-time secure input page (src/core/secure-page.js), before the body parsers and the bearer check: a
    // person opens it in a browser with no token, and its own token in the path is what admits them. It reads its
    // small form body itself.
    if (deps.securePage) {
        app.use(SECURE_PATH_PREFIX, (req, res, next) => {
            req.url = `${SECURE_PATH_PREFIX}${req.url.replace(/^\//, "")}`;
            deps.securePage
                .handle(req, res)
                .then((handled) => {
                    if (!handled) next();
                })
                .catch(() => {
                    if (!res.headersSent) res.status(500).set("Cache-Control", "no-store").end();
                });
        });
    }

    // The one-time QR login page, the same way: before the bearer check, admitted by its own token.
    if (deps.qrPage) {
        app.use(QR_PATH_PREFIX, (req, res, next) => {
            req.url = `${QR_PATH_PREFIX}${req.url.replace(/^\//, "")}`;
            deps.qrPage
                .handle(req, res)
                .then((handled) => {
                    if (!handled) next();
                })
                .catch(() => {
                    if (!res.headersSent) res.status(500).set("Cache-Control", "no-store").end();
                });
        });
    }

    // Media links (/zalo/media/<token>, src/core/media-route.js), before the bearer check as well: a capability link
    // is admitted by its token, and a bearer link checks this server's own Authorization itself (isAuthorized).
    if (deps.mediaLinks) {
        app.use(MEDIA_PATH_PREFIX, (req, res, next) => {
            req.url = `${MEDIA_PATH_PREFIX}${req.url.replace(/^\//, "")}`;
            handleMediaRequest(req, res, {
                links: deps.mediaLinks,
                authorize: authOn() ? isAuthorized : null,
            })
                .then((handled) => {
                    if (!handled) next();
                })
                .catch(() => {
                    if (!res.headersSent) res.status(500).set("Cache-Control", "no-store").end();
                });
        });
    }

    // The admin API (src/core/admin-api.js), before the bearer check too: it takes its own credential (an admin token
    // or a client certificate) and refuses the agent's, so an agent can never change its own policy.
    if (deps.admin) {
        app.use(
            ADMIN_PATH_PREFIX,
            express.json({ limit: "64kb" }),
            (req, res) => deps.admin.handle(req, res),
            (err, req, res, _next) => {
                res.status(err?.status || 400)
                    .set("Cache-Control", "no-store")
                    .json({
                        error:
                            err?.type === "entity.parse.failed"
                                ? "the body is not valid JSON"
                                : String(err?.message || err),
                    });
            },
        );
        deps.admin.isAgentToken = isAgentToken;
    }

    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    // A body that is not valid JSON or form data: an OAuth-shaped error (JSON-RPC on /mcp), never express's HTML page.
    app.use((err, req, res, next) => {
        if (!err) return next();
        const status = err.status >= 400 && err.status < 500 ? err.status : 400;
        res.set("Cache-Control", "no-store");
        if (req.path === "/mcp") {
            return res
                .status(status)
                .json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
        }
        return res
            .status(status)
            .json({ error: "invalid_request", error_description: "The request body could not be parsed" });
    });

    // ── OAuth 2.1 (src/mcp/mcp-oauth.js): mounted when a client is configured, dynamic registration is on or the
    // server has a publicUrl; then the account's mode (off, automatic, specific) decides on each request ──
    oauthServer = mountOAuth(app, {
        oauth,
        authToken,
        isTls,
        trustedProxies: deps.trustedProxies || [],
        accountDir: deps.accountDir || null,
        securePage: deps.securePage || null,
        approver:
            deps.oauthApprover ||
            (() => approverFor({ mode: "password", throughAgent: true, accountDir: deps.accountDir || null })),
    });
    const notFound = (_req, res) => res.status(404).json({ error: "not_found" });
    // No OpenID Connect here (no id_token, no JWKS): the discovery document is not pretended.
    app.get("/.well-known/openid-configuration", notFound);
    if (!oauthServer.enabled) {
        // Bearer-only: no OAuth surface at all, not even its discovery documents.
        app.all(/^\/\.well-known\/(oauth-authorization-server|oauth-protected-resource)(\/.*)?$/, notFound);
        for (const p of ["/authorize", "/token", "/register", "/revoke"]) app.all(p, notFound);
    }

    // ── Bearer auth (static token, a named API key or an OAuth access token): all below but /health, /ready ──
    app.use((req, res, next) => {
        if (!authOn()) return next();
        if (req.path === "/health" || req.path === "/ready") return next();
        const authHeader = String(req.headers.authorization || "");
        const token = /^bearer\s+/i.test(authHeader) ? authHeader.replace(/^bearer\s+/i, "").trim() : "";
        const who = identifyToken(token, req);
        if (who) {
            // The caller's identity for the tool handlers (the MCP SDK's own `req.auth` shape, plus ours).
            req.auth = { token: "", clientId: who.credential, scopes: [], extra: who };
            return next();
        }
        // RFC 6750 §3 (and RFC 9728 §5.1: where the protected resource metadata is, when OAuth is on).
        const meta = oauthServer.isOn() ? `, resource_metadata="${oauthServer.resourceMetadataUrl(req)}"` : "";
        const description = token ? "The access token is invalid, expired or revoked" : "A bearer token is required";
        res.setHeader(
            "WWW-Authenticate",
            token
                ? `Bearer realm="zalo-mcp", error="invalid_token", error_description="${description}"${meta}`
                : `Bearer realm="zalo-mcp"${meta}`,
        );
        return res
            .status(401)
            .json({ error: token ? "invalid_token" : "unauthorized", error_description: description });
    });

    // MCP endpoint — stateless, fresh server+transport per request (POST, GET, DELETE per Streamable HTTP spec)
    app.all("/mcp", async (req, res) => {
        try {
            // The caller: the credential the bearer check found (src/mcp/agents.js binds it to an agent); a server
            // that asks for no token has one caller, `open`.
            const caller = req.auth?.extra?.credential ? req.auth.extra : { credential: "open" };
            const server = newMcpServer(pkg.version, deps.instructionsFor ? deps.instructionsFor(caller) : "");
            server.caller = caller;
            // This server lives for one request, so it cannot ask the person anything and hear back: the guard
            // reads this and refuses confirmMode "human" at once instead of waiting (src/core/confirm-guard.js).
            server.statelessHttp = true;
            // Whether this request's client runs on this machine: only then can a tempfile path mean anything to it
            // (src/core/media-deliver.js chooseDelivery). X-Forwarded-For counts only from a trusted proxy.
            server.clientLoopback = isLoopbackIp(clientIpOf(req, deps.trustedProxies || []));
            registerToolsFn(
                server,
                deps.api,
                deps.buffer,
                deps.filter,
                deps.config,
                deps.nameCache,
                deps.accountDir,
                deps.stageLock,
                deps.syncJobs,
                { presence: deps.presence ?? null },
            );

            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined, // stateless mode
            });

            res.on("close", () => {
                transport.close();
                server.close();
            });

            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            console.error("MCP HTTP error:", err);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
            }
        }
    });

    // CRM leases on the socket (src/core/presence-leases.js), behind the agent's bearer check above: a lease holds the
    // socket, it cannot change the presence mode. `mcp start --http` passes `deps.leases` (its presence's routes).
    if (deps.leases) {
        app.use(PRESENCE_PATH_PREFIX, (req, res) => deps.leases.handle(req, res));
    }

    // Long-poll endpoint for zero-CPU event-driven wakeup (protected by auth middleware above)
    app.get("/events/wait", async (req, res) => {
        const rawTimeout = Number(req.query.timeout);
        const timeoutSec = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, 300) : 60;
        const threadId =
            typeof req.query.threadId === "string" && req.query.threadId.trim() ? req.query.threadId.trim() : null;
        const sinceRaw = req.query.since !== undefined ? Number(req.query.since) : undefined;
        const since = Number.isFinite(sinceRaw) ? sinceRaw : undefined;

        const ac = new AbortController();
        res.on("close", () => ac.abort());

        const { limit, settleMs } = batchParams({ limit: req.query.limit, settleMs: req.query.settle });

        // On-demand presence: a wait holds the socket while it waits (refused while yielded or signed out).
        let ticket = null;
        if (deps.presence) {
            try {
                ticket = await deps.presence.admit({ cls: "wait" });
            } catch (e) {
                if (!e?.code) throw e;
                return res.status(409).json({
                    error: e.message,
                    code: e.code,
                    ...(e.state ? { state: e.state } : {}),
                });
            }
        }

        try {
            const { messages, hasMore } = await deps.buffer.waitForMessages({
                threadId,
                since,
                timeoutMs: timeoutSec * 1000,
                signal: ac.signal,
                limit,
                settleMs,
            });
            if (res.writableEnded) return;
            // Hidden chats by the deployment's policy; the cursor still moves past one left out.
            const shown = deps.hiddenEvents ? deps.hiddenEvents(messages) : messages;
            const skipped = Number(messages.at(-1)?._cursor) || 0;
            res.json(
                waitResult({
                    messages: shown,
                    hasMore,
                    cursorWhenEmpty: Math.max(skipped, Number(deps.buffer.readCursor()) || 0),
                }),
            );
        } catch (err) {
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
        } finally {
            ticket?.release();
        }
    });

    // Liveness — no auth required, and deliberately thin: that the process answers, and whether its socket is
    // up. Everything else is behind the token (/status, /metrics).
    app.get("/health", (req, res) => {
        res.json({
            status: "ok",
            uptime: Math.floor(process.uptime()),
            threads: deps.buffer.getStats().length,
            ...(deps.health ? { socket: deps.health.ready().socket, ready: deps.health.ready().ready } : {}),
        });
    });

    // Readiness — no auth required: 200 while the Zalo socket is connected or parked idle (on-demand presence: the
    // process serves, and wakes on demand), so a load balancer or a supervisor can stop sending work to a daemon whose
    // account is offline.
    app.get("/ready", (req, res) => {
        const r = deps.health ? deps.health.ready() : { ready: true, socket: "unknown" };
        res.status(r.ready ? 200 : 503).json(r);
    });

    // Everything the daemon knows about itself (protected by the auth middleware above).
    app.get("/status", (req, res) => {
        if (!deps.health) return res.status(503).json({ error: "this server does not report health" });
        res.json(deps.health.snapshot());
    });

    // The same, as Prometheus text (protected by the auth middleware above; Prometheus sends a bearer token).
    app.get("/metrics", (req, res) => {
        if (!deps.health) return res.status(503).type("text/plain").send("# this server does not report health\n");
        res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8").send(
            renderPrometheus(deps.health.snapshot()),
        );
    });

    if (isTls) {
        // A client CA (admin.clientCa) asks every client for a certificate without requiring one: only the admin API
        // looks at it (req.socket.authorized), and every other route goes on as before.
        const clientCa = tls.ca ? { ca: tls.ca, requestCert: true, rejectUnauthorized: false } : {};
        const primary = https
            .createServer({ cert: tls.cert, key: tls.key, ...clientCa }, app)
            .listen(port, host, () => {
                console.error(`MCP HTTPS server listening on ${host}:${port}`);
            });
        if (port !== 0 && port !== 443) {
            const tls443 = https.createServer({ cert: tls.cert, key: tls.key, ...clientCa }, app);
            tls443.on("error", () => {
                /* port 443 already in use or restricted — ignore */
            });
            tls443.listen(443, host, () => {
                console.error(`MCP HTTPS server also listening on ${host}:443`);
            });
            primary.on("close", () => {
                try {
                    tls443.close();
                } catch {
                    /* ignore */
                }
            });
        }
        return primary;
    }

    return app.listen(port, host, () => {
        console.error(`MCP HTTP server listening on ${host}:${port}`);
    });
}
