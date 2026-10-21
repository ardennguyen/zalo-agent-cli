/**
 * Express server wrapping MCP StreamableHTTP transport with bearer token and OAuth 2.0 auth.
 * Uses stateless mode — each POST /mcp request creates a fresh server+transport.
 */

import express from "express";
import { renderPrometheus } from "../core/daemon-health.js";
import { batchParams, waitResult } from "./wait-result.js";
import https from "https";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));

const ACCESS_TOKEN_TTL_SEC = 30 * 24 * 3600; // 30 days
const REFRESH_TOKEN_TTL_SEC = 365 * 24 * 3600; // 365 days
const AUTH_CODE_TTL_SEC = 600; // 10 minutes
const DEFAULT_SCOPES = ["mcp:tools", "read", "write", "ACCESS_VIEW_MANAGE_MCP_CONTENT"];

/**
 * Constant-time string comparison.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Sign a compact JSON payload with HMAC-SHA256 (`<prefix><payloadB64Url>.<sigB64Url>`).
 * @param {string} prefix
 * @param {object} payload
 * @param {string} secret
 * @returns {string}
 */
function signOAuthToken(prefix, payload, secret) {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = createHmac("sha256", secret).update(`${prefix}${body}`).digest("base64url");
    return `${prefix}${body}.${sig}`;
}

/**
 * Verify a compact HMAC-SHA256 token and check its `exp` claim (epoch seconds).
 * @param {string} token
 * @param {string} expectedPrefix
 * @param {string} secret
 * @returns {object|null}
 */
function verifyOAuthToken(token, expectedPrefix, secret) {
    if (typeof token !== "string" || !token.startsWith(expectedPrefix)) return null;
    const rest = token.slice(expectedPrefix.length);
    const dot = rest.indexOf(".");
    if (dot <= 0) return null;
    const body = rest.slice(0, dot);
    const sig = rest.slice(dot + 1);
    const expectedSig = createHmac("sha256", secret).update(`${expectedPrefix}${body}`).digest("base64url");
    if (!safeEqual(sig, expectedSig)) return null;
    try {
        const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        const now = Math.floor(Date.now() / 1000);
        if (typeof parsed.exp !== "number" || parsed.exp < now) return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Extract OAuth client credentials from `Authorization: Basic ...` (`client_secret_basic`)
 * or request body (`client_secret_post`).
 * @param {import("express").Request} req
 * @returns {{ clientId: string, clientSecret: string }}
 */
function extractClientCredentials(req) {
    const authHeader = req.headers.authorization || "";
    if (/^basic\s+/i.test(authHeader)) {
        try {
            const decoded = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf8");
            const colon = decoded.indexOf(":");
            if (colon >= 0) {
                const rawId = decoded.slice(0, colon);
                const rawSecret = decoded.slice(colon + 1);
                try {
                    return {
                        clientId: decodeURIComponent(rawId),
                        clientSecret: decodeURIComponent(rawSecret),
                    };
                } catch {
                    return { clientId: rawId, clientSecret: rawSecret };
                }
            }
        } catch {
            /* fall through to body */
        }
    }
    return {
        clientId: typeof req.body?.client_id === "string" ? req.body.client_id : "",
        clientSecret: typeof req.body?.client_secret === "string" ? req.body.client_secret : "",
    };
}

/**
 * Verify PKCE `code_verifier` against stored `code_challenge` and `code_challenge_method`.
 * @param {string} verifier
 * @param {string} challenge
 * @param {string} [method="S256"]
 * @returns {boolean}
 */
function verifyPkce(verifier, challenge, method = "S256") {
    if (typeof verifier !== "string" || !verifier) return false;
    if (method.toUpperCase() === "PLAIN") {
        return safeEqual(verifier, challenge);
    }
    const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
    return safeEqual(computed, challenge);
}

/**
 * Resolve the external origin (`https://host:port`) for OAuth metadata & `WWW-Authenticate` headers.
 * @param {import("express").Request} req
 * @param {string|null} configuredIssuer
 * @param {boolean} isTls
 * @returns {string}
 */
function resolveIssuerOrigin(req, configuredIssuer, isTls) {
    if (configuredIssuer) return configuredIssuer.replace(/\/+$/, "");
    const protoHeader = req.headers["x-forwarded-proto"];
    const proto =
        (typeof protoHeader === "string" && protoHeader.split(",")[0].trim()) ||
        (isTls || req.secure ? "https" : req.protocol || "http");
    const hostHeader = req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1";
    const host = typeof hostHeader === "string" ? hostHeader.split(",")[0].trim() : "127.0.0.1";
    return `${proto}://${host}`;
}

/**
 * Create HTTP or HTTPS MCP server with optional bearer token and OAuth 2.0 auth.
 * @param {Function} registerToolsFn - Registers tools on a McpServer instance
 * @param {object} deps - { api, buffer, filter, config, nameCache, accountDir, stageLock, syncJobs, health }
 *   (`health` is the daemon's ./core/daemon-health.js object: behind /health, /ready, /status and /metrics)
 * @param {number} port
 * @param {string|null} authToken - Bearer token (null = no auth unless oauth.clientSecret or oauth.clients is set)
 * @param {string} [host="127.0.0.1"] - Bind address
 * @param {{cert: Buffer|string, key: Buffer|string}|null} [tls=null] - TLS cert and private key for HTTPS
 * @param {{clientId?: string|null, clientSecret?: string|null, issuerUrl?: string|null, clients?: Array<{clientId: string, clientSecret: string}>}|null} [oauth=null]
 * @returns {import("http").Server | import("https").Server}
 */
export function createHTTPServer(registerToolsFn, deps, port, authToken, host = "127.0.0.1", tls = null, oauth = null) {
    const app = express();
    const isTls = Boolean(tls?.cert && tls?.key);
    const configuredClientId = oauth?.clientId || "zalo-mcp";
    const configuredIssuer = oauth?.issuerUrl || null;

    // Static OAuth clients map: clientId -> clientSecret (supports primary + oauth.clients[] for multi-consumer CRM/AI)
    const configuredClients = new Map();
    if (oauth?.clientSecret || authToken) {
        configuredClients.set(configuredClientId, oauth?.clientSecret || authToken);
    }
    if (Array.isArray(oauth?.clients)) {
        for (const entry of oauth.clients) {
            const cid = typeof entry?.clientId === "string" ? entry.clientId.trim() : "";
            const csec = typeof entry?.clientSecret === "string" ? entry.clientSecret.trim() : "";
            if (cid && csec) {
                configuredClients.set(cid, csec);
            }
        }
    }
    const signingSecret =
        oauth?.clientSecret ||
        authToken ||
        (configuredClients.size > 0 ? configuredClients.values().next().value : null);

    // Single-use authorization code replay cache (jti -> expiry epoch seconds)
    const redeemedCodes = new Map();
    // Bounded dynamic client registrations (RFC 7591)
    const dynamicClients = new Map();

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
                    `[mcp-http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (host=${h} ip=${remoteIp} ua="${ua}")`,
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

    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    // ── OAuth 2.0 / 2.1 Discovery & Authorization Endpoints ────────────
    if (signingSecret) {
        // RFC 9728 Protected Resource Metadata
        const handleProtectedResourceMetadata = (req, res) => {
            const origin = resolveIssuerOrigin(req, configuredIssuer, isTls);
            res.json({
                resource: `${origin}/mcp`,
                authorization_servers: [origin],
                bearer_methods_supported: ["header"],
                scopes_supported: DEFAULT_SCOPES,
                resource_name: "Zalo Agent MCP",
            });
        };
        app.get("/.well-known/oauth-protected-resource", handleProtectedResourceMetadata);
        app.get("/.well-known/oauth-protected-resource/mcp", handleProtectedResourceMetadata);

        // RFC 8414 OAuth Authorization Server Metadata (+ OIDC discovery alias)
        const handleAuthServerMetadata = (req, res) => {
            const origin = resolveIssuerOrigin(req, configuredIssuer, isTls);
            res.json({
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                registration_endpoint: `${origin}/register`,
                revocation_endpoint: `${origin}/revoke`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
                code_challenge_methods_supported: ["S256"],
                scopes_supported: DEFAULT_SCOPES,
                resource_indicators_supported: true,
            });
        };
        app.get("/.well-known/oauth-authorization-server", handleAuthServerMetadata);
        app.get("/.well-known/openid-configuration", handleAuthServerMetadata);

        // RFC 7591 Dynamic Client Registration
        app.post("/register", (req, res) => {
            res.setHeader("Cache-Control", "no-store");
            const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
            const authMethod = req.body?.token_endpoint_auth_method || "client_secret_post";
            const issuedAt = Math.floor(Date.now() / 1000);
            const dynId = `dyn_${randomBytes(12).toString("hex")}`;
            const dynSecret = authMethod === "none" ? undefined : signingSecret;
            if (dynamicClients.size >= 200) {
                const oldest = dynamicClients.keys().next().value;
                if (oldest) dynamicClients.delete(oldest);
            }
            dynamicClients.set(dynId, {
                clientId: dynId,
                authMethod,
                redirectUris,
            });
            res.status(201).json({
                client_id: dynId,
                ...(dynSecret ? { client_secret: dynSecret, client_secret_expires_at: 0 } : {}),
                client_id_issued_at: issuedAt,
                redirect_uris: redirectUris,
                token_endpoint_auth_method: authMethod,
                grant_types: req.body?.grant_types || ["authorization_code", "refresh_token"],
                response_types: req.body?.response_types || ["code"],
            });
        });

        // OAuth 2.0 Authorization Endpoint (GET & POST)
        const handleAuthorize = (req, res) => {
            res.setHeader("Cache-Control", "no-store");
            const params = req.method === "POST" ? { ...req.query, ...req.body } : req.query;
            const responseType = String(params.response_type || "code");
            const clientId = String(params.client_id || "").trim();
            const redirectUri = String(params.redirect_uri || "").trim();
            const state = params.state !== undefined ? String(params.state) : undefined;
            const scope = typeof params.scope === "string" && params.scope.trim() ? params.scope.trim() : "mcp:tools";
            const codeChallenge =
                typeof params.code_challenge === "string" && params.code_challenge.trim()
                    ? params.code_challenge.trim()
                    : null;
            const codeChallengeMethod =
                typeof params.code_challenge_method === "string" && params.code_challenge_method.trim()
                    ? params.code_challenge_method.trim()
                    : "S256";

            if (!redirectUri || !URL.canParse(redirectUri)) {
                return res.status(400).json({
                    error: "invalid_request",
                    error_description: "A valid redirect_uri is required",
                });
            }
            if (!clientId || (!configuredClients.has(clientId) && !dynamicClients.has(clientId))) {
                return res.status(400).json({
                    error: "invalid_client",
                    error_description: "Unknown client_id",
                });
            }
            if (responseType !== "code") {
                const errUrl = new URL(redirectUri);
                errUrl.searchParams.set("error", "unsupported_response_type");
                if (state !== undefined) errUrl.searchParams.set("state", state);
                return res.redirect(302, errUrl.href);
            }

            const now = Math.floor(Date.now() / 1000);
            const code = signOAuthToken(
                "zmcp_code_",
                {
                    typ: "code",
                    cid: clientId,
                    ruri: redirectUri,
                    cc: codeChallenge,
                    ccm: codeChallengeMethod,
                    scp: scope,
                    exp: now + AUTH_CODE_TTL_SEC,
                    jti: randomBytes(12).toString("hex"),
                },
                signingSecret,
            );

            const target = new URL(redirectUri);
            target.searchParams.set("code", code);
            if (state !== undefined) target.searchParams.set("state", state);
            return res.redirect(302, target.href);
        };
        app.get("/authorize", handleAuthorize);
        app.post("/authorize", handleAuthorize);

        // OAuth 2.0 Token Endpoint
        app.post("/token", (req, res) => {
            res.setHeader("Cache-Control", "no-store");
            const grantType = String(req.body?.grant_type || "").trim();
            const { clientId, clientSecret } = extractClientCredentials(req);

            const issueTokens = (cid, scope = "mcp:tools") => {
                const now = Math.floor(Date.now() / 1000);
                const accessToken = signOAuthToken(
                    "zmcp_at_",
                    {
                        typ: "at",
                        cid,
                        scp: scope,
                        exp: now + ACCESS_TOKEN_TTL_SEC,
                        jti: randomBytes(8).toString("hex"),
                    },
                    signingSecret,
                );
                const refreshToken = signOAuthToken(
                    "zmcp_rt_",
                    {
                        typ: "rt",
                        cid,
                        scp: scope,
                        exp: now + REFRESH_TOKEN_TTL_SEC,
                        jti: randomBytes(8).toString("hex"),
                    },
                    signingSecret,
                );
                return {
                    access_token: accessToken,
                    token_type: "Bearer",
                    expires_in: ACCESS_TOKEN_TTL_SEC,
                    refresh_token: refreshToken,
                    scope,
                };
            };

            const isValidSecretFor = (cid) => {
                if (!clientSecret) return false;
                if (cid && configuredClients.has(cid)) {
                    const expected = configuredClients.get(cid);
                    return (
                        safeEqual(clientSecret, expected) || Boolean(authToken && safeEqual(clientSecret, authToken))
                    );
                }
                return (
                    safeEqual(clientSecret, signingSecret) || Boolean(authToken && safeEqual(clientSecret, authToken))
                );
            };

            if (grantType === "authorization_code") {
                const rawCode = String(req.body?.code || "").trim();
                const codePayload = verifyOAuthToken(rawCode, "zmcp_code_", signingSecret);
                if (!codePayload || codePayload.typ !== "code") {
                    return res.status(400).json({
                        error: "invalid_grant",
                        error_description: "Invalid or expired authorization code",
                    });
                }

                // Prune expired redeemed codes and enforce single use
                const now = Math.floor(Date.now() / 1000);
                for (const [k, exp] of redeemedCodes) {
                    if (exp < now) redeemedCodes.delete(k);
                }
                if (redeemedCodes.has(codePayload.jti)) {
                    return res.status(400).json({
                        error: "invalid_grant",
                        error_description: "Authorization code has already been used",
                    });
                }

                const effectiveClientId = clientId || codePayload.cid;
                if (effectiveClientId !== codePayload.cid) {
                    return res.status(400).json({
                        error: "invalid_grant",
                        error_description: "client_id does not match authorization code",
                    });
                }

                const dynClient = dynamicClients.get(effectiveClientId);
                const isPublicDynClient = dynClient?.authMethod === "none" && Boolean(codePayload.cc);
                if (!isValidSecretFor(effectiveClientId) && !isPublicDynClient) {
                    return res.status(401).json({
                        error: "invalid_client",
                        error_description: "Invalid client_secret",
                    });
                }

                if (req.body?.redirect_uri && req.body.redirect_uri !== codePayload.ruri) {
                    return res.status(400).json({
                        error: "invalid_grant",
                        error_description: "redirect_uri mismatch",
                    });
                }

                if (codePayload.cc) {
                    const verifier = String(req.body?.code_verifier || "");
                    if (!verifyPkce(verifier, codePayload.cc, codePayload.ccm)) {
                        return res.status(400).json({
                            error: "invalid_grant",
                            error_description: "PKCE code_verifier verification failed",
                        });
                    }
                }

                redeemedCodes.set(codePayload.jti, codePayload.exp);
                return res.status(200).json(issueTokens(effectiveClientId, codePayload.scp));
            }

            if (grantType === "refresh_token") {
                const rawRefresh = String(req.body?.refresh_token || "").trim();
                const rtPayload = verifyOAuthToken(rawRefresh, "zmcp_rt_", signingSecret);
                if (!rtPayload || rtPayload.typ !== "rt") {
                    return res.status(400).json({
                        error: "invalid_grant",
                        error_description: "Invalid or expired refresh_token",
                    });
                }
                const effectiveClientId = clientId || rtPayload.cid;
                const dynClient = dynamicClients.get(effectiveClientId);
                if (!isValidSecretFor(effectiveClientId) && dynClient?.authMethod !== "none") {
                    return res.status(401).json({
                        error: "invalid_client",
                        error_description: "Invalid client_secret",
                    });
                }
                return res.status(200).json(issueTokens(rtPayload.cid, rtPayload.scp));
            }

            if (grantType === "client_credentials") {
                if (clientId && !configuredClients.has(clientId) && !dynamicClients.has(clientId)) {
                    return res.status(401).json({
                        error: "invalid_client",
                        error_description: "Invalid client_id",
                    });
                }
                const targetClientId = clientId || configuredClientId;
                if (!isValidSecretFor(targetClientId)) {
                    return res.status(401).json({
                        error: "invalid_client",
                        error_description: "Invalid client_secret",
                    });
                }
                const scope =
                    typeof req.body?.scope === "string" && req.body.scope.trim() ? req.body.scope.trim() : "mcp:tools";
                return res.status(200).json(issueTokens(targetClientId, scope));
            }

            return res.status(400).json({
                error: "unsupported_grant_type",
                error_description: "Supported grant_types: authorization_code, refresh_token, client_credentials",
            });
        });

        // RFC 7009 Token Revocation Endpoint
        app.post("/revoke", (_req, res) => {
            res.status(200).json({});
        });
    }

    // ── Bearer / OAuth2 Auth Middleware — skips /health ─────────────────
    if (signingSecret) {
        app.use((req, res, next) => {
            if (req.path === "/health" || req.path === "/ready") return next();
            const authHeader = req.headers.authorization || "";
            const token = /^bearer\s+/i.test(authHeader) ? authHeader.slice(7).trim() : "";

            let matchesStaticToken =
                Boolean(token) && ((authToken && safeEqual(token, authToken)) || safeEqual(token, signingSecret));
            if (!matchesStaticToken && token) {
                for (const sec of configuredClients.values()) {
                    if (safeEqual(token, sec)) {
                        matchesStaticToken = true;
                        break;
                    }
                }
            }
            const oauthClaims =
                !matchesStaticToken && token ? verifyOAuthToken(token, "zmcp_at_", signingSecret) : null;

            if (!matchesStaticToken && !oauthClaims) {
                const origin = resolveIssuerOrigin(req, configuredIssuer, isTls);
                const wwwAuth = token
                    ? `Bearer error="invalid_token", error_description="Unauthorized", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
                    : `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`;
                res.setHeader("WWW-Authenticate", wwwAuth);
                return res.status(401).json({ error: "Unauthorized" });
            }
            next();
        });
    }

    // MCP endpoint — stateless, fresh server+transport per request (POST, GET, DELETE per Streamable HTTP spec)
    app.all("/mcp", async (req, res) => {
        try {
            const server = new McpServer({ name: "zalo-agent", version: pkg.version });
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
            res.json(waitResult({ messages, hasMore, cursorWhenEmpty: deps.buffer.readCursor() }));
        } catch (err) {
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
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

    // Readiness — no auth required: 200 only while the Zalo socket is connected, so a load balancer or a
    // supervisor can stop sending work to a daemon whose account is offline.
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
        const primary = https.createServer({ cert: tls.cert, key: tls.key }, app).listen(port, host, () => {
            console.error(`MCP HTTPS server listening on ${host}:${port}`);
        });
        if (port !== 0 && port !== 443) {
            const tls443 = https.createServer({ cert: tls.cert, key: tls.key }, app);
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
