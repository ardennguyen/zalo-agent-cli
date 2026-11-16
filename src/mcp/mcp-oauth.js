/**
 * The MCP HTTP server's OAuth 2.1 authorization server, for remote connectors that insist on OAuth (Claude.ai custom
 * connectors, Claude Desktop remote connectors, Gemini Connected Apps, ...). Mounted by src/mcp/mcp-http-transport.js.
 *
 * - **Off unless asked for.** OAuth is on only when a client is configured (`oauth.clientId` with a secret or
 *   `oauth.redirectUris`, or `oauth.clients[]`) or dynamic client registration is turned on
 *   (`oauth.allowDynamicRegistration`). A bearer-only server (`--auth` alone) answers 404 on every OAuth route,
 *   including both discovery documents.
 * - **The operator approves every connection.** `/authorize` checks the client, its exact redirect URI and PKCE (S256
 *   only), then sends the browser to the one-time approve page (src/core/secure-page.js), which asks for the approver
 *   password (`zalo-agent mcp approver set`) or, with `approval.secret: "pin"`, the hidden-chat PIN. Only after that is
 *   an authorization code issued. With no approver secret set, `/authorize` refuses and says how to set one.
 * - **Clients.** Configured clients come from the config (a client with a secret is confidential, one without is
 *   public and must use PKCE). Dynamically registered clients (RFC 7591, opt-in) are public clients unless they ask
 *   for a secret, which is random per client and kept only as a hash; they are persisted, rate limited and capped.
 *   A client secret is checked only for its own client, and is never a bearer for `/mcp` (unless
 *   `oauth.secretsAsBearer` keeps the 3.0.0 behavior).
 * - **Tokens.** Access tokens are HMAC-signed with a key derived by HKDF from the server secret, the account id and a
 *   purpose label, and carry `iss` and `aud` (`<issuer>/mcp`), both checked. Each grant is a token family in the store
 *   (`oauth-state.json` in the account folder, 0600): the refresh token rotates on every use and only its hash is kept;
 *   presenting an already-rotated refresh token revokes the whole family. `/revoke` (RFC 7009) revokes a family. A
 *   token whose client was removed, or whose family was revoked or expired, is refused. Authorization codes live only
 *   in this process's memory, single use: a restart drops them, so a code cannot be replayed across one.
 */

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";
import { clientIpOf, isLoopbackIp, normalizeIp } from "../core/media-route.js";
import { SECURE_PATH_PREFIX } from "../core/secure-page.js";

/** Default access token lifetime: one hour. */
export const DEFAULT_ACCESS_TOKEN_TTL_SEC = 3600;
/** Default refresh token lifetime: 30 days, sliding (each rotation starts it again). */
export const DEFAULT_REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600;
/** An authorization code lives five minutes. */
const AUTH_CODE_TTL_SEC = 300;
/**
 * The scopes this server takes. None narrows what a token can do: every one grants this account's MCP tools, so a
 * client may ask for any of them (Gemini asks for ACCESS_VIEW_MANAGE_MCP_CONTENT, others for offline_access).
 */
export const SUPPORTED_SCOPES = Object.freeze(["mcp:tools", "offline_access", "ACCESS_VIEW_MANAGE_MCP_CONTENT"]);
/** The most dynamically registered clients kept for one account. */
export const MAX_DYNAMIC_CLIENTS = 100;
/** A registered client that never got a token is dropped after a day once the cap is reached. */
const UNUSED_CLIENT_TTL_MS = 24 * 3600 * 1000;
/** Old refresh token hashes kept per family, to recognize a reused one. */
const OLD_REFRESH_KEPT = 20;
/** Requests per client address per window. */
export const RATE_LIMITS = Object.freeze({
    register: { max: 10, windowMs: 3600_000 },
    authorize: { max: 30, windowMs: 600_000 },
    token: { max: 60, windowMs: 60_000 },
    revoke: { max: 60, windowMs: 60_000 },
});
/** The state file in the account folder. */
export const OAUTH_STATE_FILE = "oauth-state.json";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Constant-time comparison of two strings of any length (both are hashed first, so the length leaks nothing).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ha = createHash("sha256").update(a, "utf8").digest();
    const hb = createHash("sha256").update(b, "utf8").digest();
    return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** SHA-256 of a string, hex. */
const hashOf = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");

/**
 * The HMAC key of one token kind for one account: HKDF-SHA256 over the server secret, salted with the account id.
 *
 * @param {string} secret - the server secret (`--auth`, else the first configured client secret)
 * @param {string} accountId
 * @param {"access"} purpose
 * @returns {Buffer}
 */
export function deriveOAuthKey(secret, accountId, purpose) {
    return Buffer.from(
        hkdfSync("sha256", String(secret), `zalo-mcp/oauth/account/${accountId}`, `zalo-mcp oauth ${purpose} v1`, 32),
    );
}

/**
 * Sign a compact JSON payload (`<prefix><payloadB64Url>.<sigB64Url>`).
 * @param {string} prefix
 * @param {object} payload
 * @param {Buffer} key
 * @returns {string}
 */
export function signToken(prefix, payload, key) {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = createHmac("sha256", key).update(`${prefix}${body}`).digest("base64url");
    return `${prefix}${body}.${sig}`;
}

/**
 * Verify a token from {@link signToken} and its `exp` (epoch seconds); null when it is not valid.
 * @param {string} token
 * @param {string} prefix
 * @param {Buffer} key
 * @param {number} [nowSec]
 * @returns {object|null}
 */
export function verifyToken(token, prefix, key, nowSec = Math.floor(Date.now() / 1000)) {
    if (typeof token !== "string" || !token.startsWith(prefix) || token.length > 4096) return null;
    const rest = token.slice(prefix.length);
    const dot = rest.indexOf(".");
    if (dot <= 0) return null;
    const body = rest.slice(0, dot);
    const expected = createHmac("sha256", key).update(`${prefix}${body}`).digest("base64url");
    if (!safeEqual(rest.slice(dot + 1), expected)) return null;
    try {
        const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        if (typeof parsed?.exp !== "number" || parsed.exp < nowSec) return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Why a redirect URI cannot be registered or used, or null when it can: https anywhere, http only on loopback
 * (127.0.0.1, [::1], localhost), never another scheme (`javascript:`, `data:`, a custom app scheme), a fragment or
 * credentials.
 * @param {unknown} uri
 * @returns {string|null}
 */
export function redirectUriProblem(uri) {
    if (typeof uri !== "string" || !uri.trim()) return "a redirect_uri is required";
    if (uri.length > 2048) return "the redirect_uri is too long";
    let u;
    try {
        u = new URL(uri);
    } catch {
        return "the redirect_uri is not an absolute URL";
    }
    if (u.hash || uri.includes("#")) return "the redirect_uri must not carry a fragment";
    if (u.username || u.password) return "the redirect_uri must not carry a user name or password";
    if (u.protocol === "https:") return null;
    if (u.protocol === "http:") {
        return LOOPBACK_HOSTS.has(u.hostname.toLowerCase())
            ? null
            : "an http redirect_uri is allowed only on loopback (127.0.0.1, [::1], localhost); use https";
    }
    return `the redirect_uri scheme ${u.protocol} is not allowed (https, or http on loopback)`;
}

/**
 * Whether a redirect URI given at /authorize matches a registered one: the exact string, except that a registered
 * http loopback URI matches any port (RFC 8252 §7.3).
 * @param {string} registered
 * @param {string} given
 * @returns {boolean}
 */
export function redirectUriMatches(registered, given) {
    if (typeof registered !== "string" || typeof given !== "string") return false;
    if (registered === given) return true;
    let r;
    let g;
    try {
        r = new URL(registered);
        g = new URL(given);
    } catch {
        return false;
    }
    if (r.protocol !== "http:" || !LOOPBACK_HOSTS.has(r.hostname.toLowerCase())) return false;
    return (
        g.protocol === "http:" &&
        g.hostname.toLowerCase() === r.hostname.toLowerCase() &&
        g.pathname === r.pathname &&
        g.search === r.search &&
        !g.username &&
        !g.password &&
        !given.includes("#")
    );
}

/**
 * The persisted OAuth state of one account: dynamically registered clients (secrets as hashes only) and token
 * families (refresh token hashes only). Kept in `file` (0600, replaced atomically on every change); with no file it
 * lives in memory only. The file is read again whenever it changed on disk (another process, the admin API's access
 * routes, revoked a grant or removed a client), before any read or change, so a revoke counts at the next request.
 *
 * @param {{file?: string|null, now?: () => number}} [opts]
 */
export function createOAuthStore({ file = null, now = () => Date.now() } = {}) {
    const sec = () => Math.floor(now() / 1000);
    let state = { v: 1, clients: {}, families: {} };
    let seen = null;
    const markOf = () => {
        try {
            const st = statSync(file);
            return `${st.mtimeMs}:${st.size}`;
        } catch {
            return null;
        }
    };
    const load = (quiet = false) => {
        state = { v: 1, clients: {}, families: {} };
        try {
            const parsed = JSON.parse(readFileSync(file, "utf8"));
            if (parsed?.v === 1) {
                state = {
                    v: 1,
                    clients: parsed.clients && typeof parsed.clients === "object" ? parsed.clients : {},
                    families: parsed.families && typeof parsed.families === "object" ? parsed.families : {},
                };
            }
        } catch (e) {
            if (e?.code !== "ENOENT" && !quiet) {
                console.error(
                    `[mcp-oauth] ${file} could not be read (${e.message}): starting with no clients or tokens`,
                );
            }
        }
        seen = markOf();
    };
    if (file) load();
    /** Pick up a change another writer made. */
    const fresh = () => {
        if (file && markOf() !== seen) load(true);
    };
    const save = () => {
        if (!file) return;
        writeFileAtomic(file, JSON.stringify(state), { mode: 0o600 });
        seen = markOf();
    };
    const liveFamily = (fam) => {
        fresh();
        const f = typeof fam === "string" && Object.hasOwn(state.families, fam) ? state.families[fam] : null;
        return f && f.exp >= sec() ? f : null;
    };

    return {
        file,
        /** A dynamically registered client, or null. */
        client(id) {
            fresh();
            return typeof id === "string" && Object.hasOwn(state.clients, id) ? state.clients[id] : null;
        },
        /** How many dynamically registered clients there are. */
        clientCount() {
            fresh();
            return Object.keys(state.clients).length;
        },
        /** Keep a new dynamically registered client. */
        addClient(record) {
            fresh();
            state.clients[record.clientId] = record;
            save();
        },
        /** Drop registered clients that never got a token and are older than `olderThanMs`. Returns how many. */
        pruneUnusedClients(olderThanMs = UNUSED_CLIENT_TTL_MS) {
            fresh();
            let n = 0;
            for (const [id, c] of Object.entries(state.clients)) {
                if (!c.lastUsedAt && now() - Date.parse(c.createdAt ?? 0) > olderThanMs) {
                    delete state.clients[id];
                    n++;
                }
            }
            if (n) save();
            return n;
        },
        /** Note that a registered client got a token (it is no longer prunable as unused). */
        touchClient(id) {
            const c = this.client(id);
            if (c && !c.lastUsedAt) {
                c.lastUsedAt = new Date(now()).toISOString();
                save();
            }
        },
        /** A live (not expired) token family, or null. */
        family: liveFamily,
        /**
         * Start a token family for one grant. With `refreshTtlSec` it gets a refresh token (returned once; only its
         * hash is kept), else it ends with its access token at `accessExp`.
         * @returns {{fam: string, refreshToken: string|null}}
         */
        createFamily({ cid, scp, aud, iss, accessExp, refreshTtlSec = null }) {
            fresh();
            const fam = randomBytes(12).toString("hex");
            const refreshToken = refreshTtlSec ? `zmcp_rt_${fam}.${randomBytes(32).toString("base64url")}` : null;
            state.families[fam] = {
                cid,
                scp,
                aud,
                iss,
                rt: refreshToken ? hashOf(refreshToken) : null,
                old: [],
                exp: refreshToken ? sec() + refreshTtlSec : accessExp,
                iat: sec(),
            };
            save();
            return { fam, refreshToken };
        },
        /**
         * Use a refresh token: the current one rotates (a new one is returned, the lifetime starts again); an older
         * one of the same family is a reuse, which revokes the family.
         * @returns {{ok: true, family: object, fam: string, refreshToken: string} | {ok: false, reason: "invalid"|"reuse"}}
         */
        rotateRefresh(token, refreshTtlSec) {
            const m = /^zmcp_rt_([0-9a-f]{24})\.[A-Za-z0-9_-]{43}$/.exec(String(token ?? ""));
            if (!m) return { ok: false, reason: "invalid" };
            const fam = m[1];
            const f = liveFamily(fam);
            if (!f || !f.rt) return { ok: false, reason: "invalid" };
            const h = hashOf(token);
            if (safeEqual(h, f.rt)) {
                const next = `zmcp_rt_${fam}.${randomBytes(32).toString("base64url")}`;
                f.old = [...f.old, f.rt].slice(-OLD_REFRESH_KEPT);
                f.rt = hashOf(next);
                f.exp = sec() + refreshTtlSec;
                save();
                return { ok: true, family: f, fam, refreshToken: next };
            }
            if (f.old.some((o) => safeEqual(o, h))) {
                delete state.families[fam];
                save();
                return { ok: false, reason: "reuse" };
            }
            return { ok: false, reason: "invalid" };
        },
        /** The family a refresh token names (whatever its rotation), or null. */
        familyOfRefresh(token) {
            const m = /^zmcp_rt_([0-9a-f]{24})\./.exec(String(token ?? ""));
            return m ? { fam: m[1], family: liveFamily(m[1]) } : null;
        },
        /** Revoke one family: its refresh token and every access token issued from it stop working. */
        revokeFamily(fam) {
            fresh();
            if (typeof fam === "string" && Object.hasOwn(state.families, fam)) {
                delete state.families[fam];
                save();
                return true;
            }
            return false;
        },
        /**
         * Drop expired families, and those (and the registered clients' entries) whose client no longer exists.
         * @param {(cid: string) => boolean} clientExists
         */
        prune(clientExists) {
            fresh();
            let changed = false;
            const t = sec();
            for (const [fam, f] of Object.entries(state.families)) {
                if (f.exp < t || !clientExists(f.cid)) {
                    delete state.families[fam];
                    changed = true;
                }
            }
            if (changed) save();
        },
        /** The dynamically registered clients (no secret hash). */
        listClients() {
            fresh();
            return Object.values(state.clients).map((c) => ({
                clientId: c.clientId,
                name: c.name || null,
                redirectUris: Array.isArray(c.redirectUris) ? c.redirectUris : [],
                confidential: Boolean(c.secretHash),
                createdAt: c.createdAt ?? null,
                lastUsedAt: c.lastUsedAt ?? null,
            }));
        },
        /** The live grants (token families): ids, clients and times only. */
        listGrants() {
            fresh();
            const t = sec();
            return Object.entries(state.families)
                .filter(([, f]) => f.exp >= t)
                .map(([fam, f]) => ({
                    grantId: fam,
                    clientId: f.cid,
                    scope: f.scp ?? null,
                    issuedAt: f.iat ? new Date(f.iat * 1000).toISOString() : null,
                    expiresAt: new Date(f.exp * 1000).toISOString(),
                    refreshable: Boolean(f.rt),
                }));
        },
        /** Remove a dynamically registered client and every grant it holds. Returns the grants revoked, or -1. */
        removeClient(id) {
            fresh();
            if (typeof id !== "string" || !Object.hasOwn(state.clients, id)) return -1;
            delete state.clients[id];
            let n = 0;
            for (const [fam, f] of Object.entries(state.families)) {
                if (f.cid === id) {
                    delete state.families[fam];
                    n++;
                }
            }
            save();
            return n;
        },
        /** Revoke every grant (of one client, with `clientId`). Returns how many. */
        revokeAll({ clientId = null } = {}) {
            fresh();
            let n = 0;
            for (const [fam, f] of Object.entries(state.families)) {
                if (clientId === null || f.cid === clientId) {
                    delete state.families[fam];
                    n++;
                }
            }
            if (n) save();
            return n;
        },
    };
}

/**
 * A fixed-window counter per client address, per endpoint.
 * @param {{max: number, windowMs: number}} limit
 * @param {() => number} now
 */
function rateLimiter({ max, windowMs }, now) {
    const seen = new Map();
    return (key) => {
        const t = now();
        let e = seen.get(key);
        if (!e || t - e.start >= windowMs) {
            if (seen.size > 10_000) seen.clear();
            e = { start: t, n: 0 };
            seen.set(key, e);
        }
        e.n++;
        return e.n <= max ? 0 : Math.ceil((e.start + windowMs - t) / 1000);
    };
}

/**
 * Whether the request's peer is one of the trusted reverse proxies (their X-Forwarded-* headers are believed).
 * @param {import("express").Request} req
 * @param {string[]} trustedProxies
 * @returns {boolean}
 */
export function fromTrustedProxy(req, trustedProxies = []) {
    if (!trustedProxies.length) return false;
    const peer = normalizeIp(req.socket?.remoteAddress);
    return trustedProxies.includes(peer) || (trustedProxies.includes("loopback") && isLoopbackIp(peer));
}

/**
 * The issuer origin (`https://host[/base]`): `publicUrl` when set; else inferred from the request's Host header, and
 * from X-Forwarded-Proto / X-Forwarded-Host only when the peer is a trusted proxy.
 * @param {import("express").Request} req
 * @param {{publicUrl: string|null, isTls: boolean, trustedProxies?: string[]}} ctx
 * @returns {string}
 */
export function resolveIssuerOrigin(req, { publicUrl, isTls, trustedProxies = [] }) {
    if (publicUrl) return publicUrl.replace(/\/+$/, "");
    const trusted = fromTrustedProxy(req, trustedProxies);
    const first = (v) => (typeof v === "string" ? v.split(",")[0].trim() : "");
    const fwdProto = trusted ? first(req.headers["x-forwarded-proto"]).toLowerCase() : "";
    const proto = fwdProto === "https" || fwdProto === "http" ? fwdProto : isTls || req.secure ? "https" : "http";
    const fwdHost = trusted ? first(req.headers["x-forwarded-host"]) : "";
    const host = fwdHost || first(req.headers.host) || "127.0.0.1";
    // A Host header that is not a plain host[:port] is not used to build URLs.
    return /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)
        ? `${proto}://${host}`
        : `${proto}://127.0.0.1`;
}

/**
 * The configured (static) OAuth clients: `{clientId, clientSecret, redirectUris}` (the primary one) and
 * `clients[]`. A client is kept when it has a secret (confidential) or redirect URIs (public, PKCE only).
 * @param {object|null} oauth
 * @returns {{clients: Map<string, {clientId: string, secret: string|null, redirectUris: string[], name: string}>, problems: string[]}}
 */
export function configuredOAuthClients(oauth) {
    const clients = new Map();
    const problems = [];
    const add = (entry, where) => {
        const clientId = typeof entry?.clientId === "string" ? entry.clientId.trim() : "";
        const secret =
            typeof entry?.clientSecret === "string" && entry.clientSecret.trim() ? entry.clientSecret.trim() : null;
        const uris = Array.isArray(entry?.redirectUris)
            ? entry.redirectUris.map((u) => String(u).trim()).filter(Boolean)
            : [];
        if (!clientId || (!secret && !uris.length)) return;
        const good = [];
        for (const u of uris) {
            const why = redirectUriProblem(u);
            if (why) problems.push(`${where} (${clientId}): ${why}: ${u}`);
            else good.push(u);
        }
        clients.set(clientId, { clientId, secret, redirectUris: good, name: clientId });
    };
    if (oauth) add({ clientId: oauth.clientId || "zalo-mcp", ...oauth }, "oauth.redirectUris");
    for (const entry of Array.isArray(oauth?.clients) ? oauth.clients : []) add(entry, "oauth.clients[]");
    return { clients, problems };
}

/**
 * Whether OAuth is on for these settings, and why it cannot start when it cannot (no issuer that a client can trust,
 * no secret to sign with).
 *
 * @param {object} opts
 * @param {object|null} opts.oauth - the oauth options createHTTPServer takes
 * @param {string|null} opts.authToken
 * @param {string} opts.host - the bind address
 * @param {string|null} opts.publicUrl
 * @returns {{enabled: boolean, problem: string|null, warnings: string[]}}
 */
export function oauthStartCheck({ oauth, authToken, host, publicUrl }) {
    const { clients, problems } = configuredOAuthClients(oauth);
    const dynamic = Boolean(oauth?.allowDynamicRegistration);
    const enabled = clients.size > 0 || dynamic;
    if (!enabled) return { enabled, problem: null, warnings: problems };
    const loopbackBind = ["127.0.0.1", "::1", "localhost"].includes(String(host || "127.0.0.1").toLowerCase());
    if (!publicUrl && !loopbackBind) {
        return {
            enabled,
            problem:
                `OAuth is on and the server listens on ${host}, but no publicUrl is set: the issuer would come from ` +
                "each request's Host header. Set --public-url / ZALO_MCP_PUBLIC_URL to the https address clients use",
            warnings: problems,
        };
    }
    if (!signingSecretOf({ authToken, clients })) {
        return {
            enabled,
            problem:
                "OAuth needs a server secret to sign its tokens with: set --auth / ZALO_MCP_AUTH_TOKEN, or give an " +
                "OAuth client a secret",
            warnings: problems,
        };
    }
    return { enabled, problem: null, warnings: problems };
}

function signingSecretOf({ authToken, clients }) {
    if (authToken) return authToken;
    for (const c of clients.values()) if (c.secret) return c.secret;
    return null;
}

/** Client credentials from `Authorization: Basic` (client_secret_basic) or the body (client_secret_post). */
function clientCredentials(req) {
    const header = String(req.headers.authorization || "");
    if (/^basic\s+/i.test(header)) {
        const decoded = Buffer.from(header.replace(/^basic\s+/i, "").trim(), "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        if (colon >= 0) {
            const dec = (s) => {
                try {
                    return decodeURIComponent(s.replace(/\+/g, " "));
                } catch {
                    return s;
                }
            };
            return { clientId: dec(decoded.slice(0, colon)), clientSecret: dec(decoded.slice(colon + 1)), basic: true };
        }
        return { clientId: "", clientSecret: "", basic: true };
    }
    const str = (v) => (typeof v === "string" ? v : "");
    return { clientId: str(req.body?.client_id), clientSecret: str(req.body?.client_secret), basic: false };
}

/** The granted scope: the requested ones this server takes, else `mcp:tools`. */
function grantScope(requested) {
    const asked = String(requested ?? "")
        .split(/\s+/)
        .filter(Boolean);
    const granted = [...new Set(asked.filter((s) => SUPPORTED_SCOPES.includes(s)))];
    return granted.length ? granted.join(" ") : "mcp:tools";
}

/**
 * Mount the authorization server on an express app (after its body parsers, before its bearer check).
 *
 * @param {import("express").Express} app
 * @param {object} ctx
 * @param {object|null} ctx.oauth - `{clientId, clientSecret, redirectUris, clients, issuerUrl, allowDynamicRegistration,
 *   secretsAsBearer, accessTokenTtlSec, refreshTokenTtlSec, accountId, stateFile}`
 * @param {string|null} ctx.authToken - the static bearer token (`--auth`)
 * @param {boolean} ctx.isTls
 * @param {string[]} [ctx.trustedProxies]
 * @param {string|null} [ctx.accountDir] - where `oauth-state.json` lives (no file: memory only)
 * @param {import("../core/secure-page.js").SecurePage|null} [ctx.securePage] - the approve page
 * @param {() => object} [ctx.approver] - approverFor's answer for the approve page (src/core/approval.js)
 * @param {() => number} [ctx.now]
 * @returns {{enabled: boolean, verifyBearer: (token: string, req?: import("express").Request) => boolean,
 *   resourceMetadataUrl: (req: import("express").Request) => string|null, store: object|null}}
 */
export function mountOAuth(app, ctx) {
    const { oauth, authToken, isTls, trustedProxies = [], securePage = null, approver = null } = ctx;
    const now = ctx.now ?? (() => Date.now());
    const nowSec = () => Math.floor(now() / 1000);
    const { clients: configured } = configuredOAuthClients(oauth);
    const dynamicOn = Boolean(oauth?.allowDynamicRegistration);
    const enabled = configured.size > 0 || dynamicOn;
    const secretsAsBearer = Boolean(oauth?.secretsAsBearer);
    const publicUrl = oauth?.issuerUrl || null;
    if (!enabled) {
        return { enabled: false, verifyBearer: () => false, resourceMetadataUrl: () => null, store: null };
    }
    const secret = signingSecretOf({ authToken, clients: configured });
    if (!secret) {
        throw new Error(
            "OAuth needs a server secret to sign its tokens with: set --auth / ZALO_MCP_AUTH_TOKEN, or give an " +
                "OAuth client a secret",
        );
    }
    const accountId = String(oauth?.accountId ?? "");
    const accessKey = deriveOAuthKey(secret, accountId, "access");
    const accessTtl =
        Number(oauth?.accessTokenTtlSec) > 0 ? Number(oauth.accessTokenTtlSec) : DEFAULT_ACCESS_TOKEN_TTL_SEC;
    const refreshTtl =
        Number(oauth?.refreshTokenTtlSec) > 0 ? Number(oauth.refreshTokenTtlSec) : DEFAULT_REFRESH_TOKEN_TTL_SEC;
    const stateFile = oauth?.stateFile ?? (ctx.accountDir ? join(ctx.accountDir, OAUTH_STATE_FILE) : null);
    const store = createOAuthStore({ file: stateFile, now });

    /** A client by id: configured first, then registered. */
    const clientOf = (id) => {
        if (typeof id !== "string" || !id) return null;
        const c = configured.get(id);
        if (c) return { ...c, kind: "configured", confidential: Boolean(c.secret) };
        const d = dynamicOn ? store.client(id) : null;
        if (d) return { ...d, kind: "dynamic", confidential: Boolean(d.secretHash) };
        return null;
    };
    store.prune((cid) => Boolean(clientOf(cid)));

    // Authorization codes: memory only (a restart drops them), single use; a redeemed one remembers its family.
    const codes = new Map();
    const redeemed = new Map();
    const pruneCodes = () => {
        const t = nowSec();
        for (const [k, v] of codes) if (v.exp < t) codes.delete(k);
        for (const [k, v] of redeemed) if (v.exp < t) redeemed.delete(k);
    };

    const issuerOf = (req) => resolveIssuerOrigin(req, { publicUrl, isTls, trustedProxies });
    const resourceOf = (req) => `${issuerOf(req)}/mcp`;
    const ipOf = (req) => clientIpOf(req, trustedProxies);
    const limits = Object.fromEntries(Object.entries(RATE_LIMITS).map(([k, v]) => [k, rateLimiter(v, now)]));
    const limited = (name) => (req, res, next) => {
        const wait = limits[name](ipOf(req));
        if (!wait) return next();
        res.set("Retry-After", String(wait)).set("Cache-Control", "no-store");
        return res.status(429).json({ error: "invalid_request", error_description: "Too many requests; slow down" });
    };
    const oauthError = (res, status, error, description, extraHeaders = {}) => {
        res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
        for (const [k, v] of Object.entries(extraHeaders)) res.set(k, v);
        return res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
    };

    // ── Discovery ──
    // RFC 9728 protected resource metadata, at the root and path-inserted (`/.well-known/oauth-protected-resource/mcp`
    // or `.../<base>/mcp` for an issuer with a base path).
    const issuerPath = (req) => new URL(issuerOf(req)).pathname.replace(/\/+$/, "");
    app.get(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/, (req, res) => {
        const suffix = (req.params[0] ?? "").replace(/\/+$/, "");
        const base = issuerPath(req);
        if (suffix && ![`/mcp`, `${base}/mcp`, base].includes(suffix))
            return res.status(404).json({ error: "not_found" });
        const origin = issuerOf(req);
        res.json({
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            bearer_methods_supported: ["header"],
            scopes_supported: [...SUPPORTED_SCOPES],
            resource_name: "Zalo Agent MCP",
        });
    });
    // RFC 8414 authorization server metadata, at the root and path-inserted
    // (`/.well-known/oauth-authorization-server/<base>` for an issuer `https://host/<base>`).
    app.get(/^\/\.well-known\/oauth-authorization-server(\/.*)?$/, (req, res) => {
        const suffix = (req.params[0] ?? "").replace(/\/+$/, "");
        if (suffix && suffix !== issuerPath(req)) return res.status(404).json({ error: "not_found" });
        const origin = issuerOf(req);
        res.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            ...(dynamicOn ? { registration_endpoint: `${origin}/register` } : {}),
            revocation_endpoint: `${origin}/revoke`,
            response_types_supported: ["code"],
            response_modes_supported: ["query"],
            grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
            token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
            revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: [...SUPPORTED_SCOPES],
            authorization_response_iss_parameter_supported: true,
        });
    });

    // ── RFC 7591 dynamic client registration (opt-in) ──
    app.post("/register", limited("register"), (req, res) => {
        if (!dynamicOn) return res.status(404).json({ error: "not_found" });
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const uris = body.redirect_uris;
        if (!Array.isArray(uris) || !uris.length || uris.length > 10) {
            return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris is required (1 to 10 URIs)");
        }
        for (const u of uris) {
            const why = redirectUriProblem(u);
            if (why) return oauthError(res, 400, "invalid_redirect_uri", why);
        }
        const method = body.token_endpoint_auth_method ?? "none";
        if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
            return oauthError(res, 400, "invalid_client_metadata", "token_endpoint_auth_method is not supported");
        }
        const grants = body.grant_types ?? ["authorization_code", "refresh_token"];
        if (!Array.isArray(grants) || grants.some((g) => !["authorization_code", "refresh_token"].includes(g))) {
            return oauthError(res, 400, "invalid_client_metadata", "grant_types: authorization_code, refresh_token");
        }
        const responseTypes = body.response_types ?? ["code"];
        if (!Array.isArray(responseTypes) || responseTypes.some((t) => t !== "code")) {
            return oauthError(res, 400, "invalid_client_metadata", "response_types: code");
        }
        if (store.clientCount() >= MAX_DYNAMIC_CLIENTS) store.pruneUnusedClients();
        if (store.clientCount() >= MAX_DYNAMIC_CLIENTS) {
            return oauthError(res, 400, "invalid_client_metadata", "Too many registered clients on this server");
        }
        const clientId = `dyn_${randomBytes(16).toString("hex")}`;
        const clientSecret = method === "none" ? null : `zmcp_cs_${randomBytes(32).toString("base64url")}`;
        const name = typeof body.client_name === "string" ? body.client_name.slice(0, 80) : "";
        const createdAt = new Date(now()).toISOString();
        store.addClient({
            clientId,
            name,
            authMethod: method,
            redirectUris: uris,
            secretHash: clientSecret ? hashOf(clientSecret) : null,
            createdAt,
            lastUsedAt: null,
        });
        res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
        // A per-client secret goes only to the caller itself: no cross-origin read of it.
        if (clientSecret) res.removeHeader("Access-Control-Allow-Origin");
        return res.status(201).json({
            client_id: clientId,
            client_id_issued_at: Math.floor(Date.parse(createdAt) / 1000),
            ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
            ...(name ? { client_name: name } : {}),
            redirect_uris: uris,
            token_endpoint_auth_method: method,
            grant_types: grants,
            response_types: ["code"],
        });
    });

    // ── Authorization endpoint: validate, then the operator approves on the one-time page ──
    const handleAuthorize = (req, res) => {
        res.set("Cache-Control", "no-store");
        const params = req.method === "POST" ? { ...req.query, ...(req.body ?? {}) } : req.query;
        const str = (v) => (typeof v === "string" ? v.trim() : "");
        const client = clientOf(str(params.client_id));
        if (!client) return oauthError(res, 400, "invalid_client", "Unknown client_id");
        const redirectUri = str(params.redirect_uri);
        const why = redirectUriProblem(redirectUri);
        if (why) return oauthError(res, 400, "invalid_request", why);
        if (!client.redirectUris.length) {
            return oauthError(
                res,
                400,
                "invalid_request",
                `No redirect URI is registered for client ${client.clientId}: add its callback URL to ` +
                    "oauth.redirectUris (or redirectUris in its oauth.clients[] entry), e.g. " +
                    "https://claude.ai/api/mcp/auth_callback or https://vertexaisearch.cloud.google.com/oauth-redirect",
            );
        }
        if (!client.redirectUris.some((r) => redirectUriMatches(r, redirectUri))) {
            return oauthError(res, 400, "invalid_request", "redirect_uri is not registered for this client");
        }
        const iss = issuerOf(req);
        const state = typeof params.state === "string" ? params.state : undefined;
        const back = (fields) => {
            const target = new URL(redirectUri);
            for (const [k, v] of Object.entries({ ...fields, ...(state !== undefined ? { state } : {}), iss })) {
                target.searchParams.set(k, v);
            }
            return target.href;
        };
        const fail = (error, description) => res.redirect(302, back({ error, error_description: description }));
        if (str(params.response_type) !== "code")
            return fail("unsupported_response_type", "response_type must be code");
        const challenge = str(params.code_challenge);
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
            return fail("invalid_request", "PKCE is required: code_challenge (S256)");
        }
        if (str(params.code_challenge_method) !== "S256") {
            return fail("invalid_request", "code_challenge_method must be S256");
        }
        const resource = resourceOf(req);
        if (params.resource !== undefined && str(params.resource).replace(/\/+$/, "") !== resource) {
            return fail("invalid_target", `resource must be ${resource}`);
        }
        const scope = grantScope(params.scope);
        if (!securePage) {
            return oauthError(
                res,
                503,
                "temporarily_unavailable",
                "This server has no approve page to ask the owner on",
            );
        }
        const a = approver ? approver() : { error: "No approver is configured for this server" };
        if (a.error || !a.kind || !a.check) {
            return oauthError(
                res,
                403,
                "access_denied",
                `${a.error ?? "Connecting an app needs an approver secret."} Connecting an app asks the account ` +
                    "owner for the approver password: set one with `zalo-agent mcp approver set` (or approval.secret " +
                    '"pin" with a hidden-chat PIN), then try again.',
            );
        }
        const redirectOrigin = new URL(redirectUri).origin;
        const label =
            client.name && client.name !== client.clientId ? `"${client.name}" (${client.clientId})` : client.clientId;
        const { token } = securePage.store.issue({
            accountId: securePage.accountId,
            action: "oauth.authorize",
            target: { clientId: client.clientId },
            kind: "confirm",
            title: "Connect an app to this Zalo account",
            description:
                `The app ${label} asks to use this Zalo account through its MCP tools: read its messages and send as ` +
                `it. Approving sends you back to ${redirectOrigin}.`,
            secretKind: a.kind,
            formActionOrigins: [redirectOrigin],
            declineRedirect: back({ error: "access_denied", error_description: "The owner declined" }),
            // What the page shows, in both languages: who asks, for which account, and where the answer goes.
            view: {
                type: "oauth",
                clientName: client.name && client.name !== client.clientId ? client.name : "",
                clientId: client.clientId,
                accountName: securePage.accountDisplayName?.() ?? "",
                accountId: securePage.accountId,
                returnHost: new URL(redirectUri).host,
            },
            onSubmit: async ({ secret: typed }) => {
                const r = await a.check(typed);
                if (r.status !== "approved") return r;
                pruneCodes();
                const code = `zmcp_code_${randomBytes(32).toString("base64url")}`;
                codes.set(hashOf(code), {
                    cid: client.clientId,
                    ruri: redirectUri,
                    cc: challenge,
                    scp: scope,
                    aud: resource,
                    iss,
                    exp: nowSec() + AUTH_CODE_TTL_SEC,
                });
                return { status: "approved", message: "Approved. Returning to the app.", redirect: back({ code }) };
            },
        });
        // Relative, so it stays under the base path a proxy serves this server at.
        return res.redirect(302, `${SECURE_PATH_PREFIX.slice(1)}${token}`);
    };
    app.get("/authorize", limited("authorize"), handleAuthorize);
    app.post("/authorize", limited("authorize"), handleAuthorize);

    /** The authenticated client of a /token or /revoke request, or an error answer already sent. */
    const authenticateClient = (req, res) => {
        const creds = clientCredentials(req);
        const unauthorized = (description) =>
            oauthError(
                res,
                401,
                "invalid_client",
                description,
                creds.basic ? { "WWW-Authenticate": 'Basic realm="zalo-mcp"' } : {},
            );
        const client = clientOf(creds.clientId);
        if (!client) return { sent: unauthorized("Unknown client") };
        if (client.confidential) {
            const ok =
                client.kind === "configured"
                    ? safeEqual(creds.clientSecret, client.secret)
                    : Boolean(creds.clientSecret) && safeEqual(hashOf(creds.clientSecret), client.secretHash);
            if (!ok) return { sent: unauthorized("Invalid client credentials") };
        } else if (creds.clientSecret) {
            return { sent: unauthorized("This client has no secret") };
        }
        return { client };
    };

    const issueAccess = ({ cid, scp, aud, iss, fam }) => {
        const exp = nowSec() + accessTtl;
        return {
            token: signToken(
                "zmcp_at_",
                { typ: "at", iss, aud, cid, fam, scp, iat: nowSec(), exp, jti: randomBytes(12).toString("hex") },
                accessKey,
            ),
            exp,
        };
    };

    // ── Token endpoint ──
    app.post("/token", limited("token"), (req, res) => {
        res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
        const grantType = typeof req.body?.grant_type === "string" ? req.body.grant_type.trim() : "";
        if (!["authorization_code", "refresh_token", "client_credentials"].includes(grantType)) {
            return oauthError(
                res,
                400,
                "unsupported_grant_type",
                "authorization_code, refresh_token or client_credentials",
            );
        }
        const auth = authenticateClient(req, res);
        if (auth.sent) return auth.sent;
        const { client } = auth;
        const str = (v) => (typeof v === "string" ? v.trim() : "");

        if (grantType === "authorization_code") {
            pruneCodes();
            const raw = str(req.body.code);
            const h = hashOf(raw);
            const replay = redeemed.get(h);
            if (replay) {
                // A code used twice: whatever it gave is revoked (RFC 6749 §4.1.2).
                store.revokeFamily(replay.fam);
                redeemed.delete(h);
                return oauthError(res, 400, "invalid_grant", "The authorization code was already used");
            }
            const code = codes.get(h);
            if (!code || code.exp < nowSec()) return oauthError(res, 400, "invalid_grant", "Invalid or expired code");
            if (code.cid !== client.clientId) {
                return oauthError(res, 400, "invalid_grant", "The code was issued to another client");
            }
            if (str(req.body.redirect_uri) !== code.ruri) {
                return oauthError(res, 400, "invalid_grant", "redirect_uri is missing or does not match");
            }
            const verifier = str(req.body.code_verifier);
            if (
                !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
                !safeEqual(createHash("sha256").update(verifier, "ascii").digest("base64url"), code.cc)
            ) {
                return oauthError(res, 400, "invalid_grant", "PKCE code_verifier verification failed");
            }
            if (req.body.resource !== undefined && str(req.body.resource).replace(/\/+$/, "") !== code.aud) {
                return oauthError(res, 400, "invalid_target", `resource must be ${code.aud}`);
            }
            codes.delete(h);
            const { fam, refreshToken } = store.createFamily({
                cid: code.cid,
                scp: code.scp,
                aud: code.aud,
                iss: code.iss,
                accessExp: nowSec() + accessTtl,
                refreshTtlSec: refreshTtl,
            });
            redeemed.set(h, { fam, exp: code.exp });
            if (client.kind === "dynamic") store.touchClient(client.clientId);
            const at = issueAccess({ ...code, fam });
            return res.status(200).json({
                access_token: at.token,
                token_type: "Bearer",
                expires_in: accessTtl,
                refresh_token: refreshToken,
                scope: code.scp,
            });
        }

        if (grantType === "refresh_token") {
            const raw = str(req.body.refresh_token);
            const named = store.familyOfRefresh(raw);
            if (named?.family && named.family.cid !== client.clientId) {
                return oauthError(res, 400, "invalid_grant", "The refresh token was issued to another client");
            }
            const r = store.rotateRefresh(raw, refreshTtl);
            if (!r.ok) {
                return oauthError(
                    res,
                    400,
                    "invalid_grant",
                    r.reason === "reuse"
                        ? "The refresh token was already used: every token of this grant is revoked; authorize again"
                        : "Invalid, expired or revoked refresh token",
                );
            }
            const at = issueAccess({ ...r.family, fam: r.fam });
            return res.status(200).json({
                access_token: at.token,
                token_type: "Bearer",
                expires_in: accessTtl,
                refresh_token: r.refreshToken,
                scope: r.family.scp,
            });
        }

        // client_credentials: a confidential client (a backend) on its own behalf; no refresh token.
        if (!client.confidential) {
            return oauthError(res, 400, "unauthorized_client", "client_credentials needs a confidential client");
        }
        const iss = issuerOf(req);
        const aud = `${iss}/mcp`;
        if (req.body.resource !== undefined && str(req.body.resource).replace(/\/+$/, "") !== aud) {
            return oauthError(res, 400, "invalid_target", `resource must be ${aud}`);
        }
        const scp = grantScope(req.body.scope);
        const exp = nowSec() + accessTtl;
        const { fam } = store.createFamily({ cid: client.clientId, scp, aud, iss, accessExp: exp });
        const at = issueAccess({ cid: client.clientId, scp, aud, iss, fam });
        return res
            .status(200)
            .json({ access_token: at.token, token_type: "Bearer", expires_in: accessTtl, scope: scp });
    });

    // ── RFC 7009 revocation: a refresh or access token revokes its whole grant ──
    app.post("/revoke", limited("revoke"), (req, res) => {
        res.set("Cache-Control", "no-store");
        const auth = authenticateClient(req, res);
        if (auth.sent) return auth.sent;
        const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
        if (!token) return oauthError(res, 400, "invalid_request", "token is required");
        let fam = null;
        let cid = null;
        const named = store.familyOfRefresh(token);
        if (named?.family) {
            fam = named.fam;
            cid = named.family.cid;
        } else {
            const at = verifyToken(token, "zmcp_at_", accessKey, nowSec());
            if (at) {
                fam = at.fam;
                cid = at.cid;
            }
        }
        // A token of another client, or one already gone, is answered the same way (RFC 7009 §2.2).
        if (fam && cid === auth.client.clientId) store.revokeFamily(fam);
        return res.status(200).json({});
    });

    /**
     * Whether a bearer token is an access token this server issued and still honors: signature, expiry, issuer and
     * audience (when the request is known), a client that still exists, and a family not revoked.
     */
    const verifyAccess = (token, req) => {
        const at = verifyToken(token, "zmcp_at_", accessKey, nowSec());
        if (!at || at.typ !== "at") return false;
        if (req) {
            const iss = issuerOf(req);
            if (at.iss !== iss || at.aud !== `${iss}/mcp`) return false;
        }
        if (!clientOf(at.cid)) return false;
        const f = store.family(at.fam);
        return Boolean(f && f.cid === at.cid);
    };
    const verifyBearer = (token, req) => {
        if (!token) return false;
        if (secretsAsBearer) {
            for (const c of configured.values()) if (c.secret && safeEqual(token, c.secret)) return true;
        }
        return verifyAccess(token, req);
    };
    return {
        enabled: true,
        verifyBearer,
        resourceMetadataUrl: (req) => `${issuerOf(req)}/.well-known/oauth-protected-resource/mcp`,
        store,
    };
}
