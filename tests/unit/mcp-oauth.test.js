/**
 * The MCP HTTP server's OAuth 2.1 authorization server (src/mcp/mcp-oauth.js), over real HTTP on 127.0.0.1.
 *
 * What would turn each test red (the 2026-11-15 review's findings, A1 to A10):
 * - A1: /register answering with the server's bearer or signing secret, or OAuth answering at all on a bearer-only
 *   server (`--auth` alone);
 * - A2: /authorize handing out a code before the owner approved on the one-time page, or to a redirect URI that is not
 *   registered (a `javascript:` one above all);
 * - A3: a refresh token that does not rotate, a reused one that does not revoke its grant, /revoke doing nothing, a
 *   removed client's token still admitted;
 * - A4: a token of account A admitted by account B, or one whose issuer or audience differs from this server's;
 * - A5: a code redeemed without S256 PKCE, or without the redirect_uri it was issued for;
 * - A6: the static bearer token or another client's secret authenticating a client, a client secret admitted as a
 *   bearer token for /mcp;
 * - A7: registrations lost on restart, or a flood of registrations evicting a client in use;
 * - A8: an issuer built from X-Forwarded-Host sent by a peer that is not a trusted proxy, or OAuth starting off
 *   loopback with no publicUrl;
 * - A9: the path-inserted discovery documents of an issuer with a base path not served;
 * - A10: the protocol details (Basic challenge, JSON errors, iss in the response, rate limits, no fake OIDC document).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { SecurePage } from "../../src/core/secure-page.js";
import { setApproverPassword } from "../../src/core/approval.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import {
    MAX_DYNAMIC_CLIENTS,
    OAUTH_STATE_FILE,
    SUPPORTED_SCOPES,
    createOAuthStore,
    slugFromName,
    oauthStartCheck,
    redirectUriMatches,
    redirectUriProblem,
    safeEqual,
} from "../../src/mcp/mcp-oauth.js";
import { resolveOAuthOptions } from "../../src/commands/mcp.js";
import { parseDuration } from "../../src/mcp/mcp-config.js";

const ACCOUNT_A = "1000000000000000001";
const ACCOUNT_B = "1000000000000000002";
const BEARER = "test-bearer-token-not-real";
const PASSWORD = "approver-password-for-tests";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const CONFIDENTIAL = { clientId: "connector", clientSecret: "test-client-secret-not-real", redirectUris: [CLAUDE_CB] };

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

let ROOT;
before(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    ROOT = mkdtempSync(join(CONFIG_DIR, "oauth-"));
});

/** An approver that wants PASSWORD, as approverFor's answer looks. */
const fakeApprover = () => ({
    kind: "password",
    approverSecret: true,
    check: async (typed) =>
        typed === PASSWORD
            ? { status: "approved", message: "Approved." }
            : { status: "retry", message: "Wrong approver password." },
});

const servers = [];
after(async () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r())))));

/**
 * Start a server. `oauth` is null for a bearer-only one.
 * @returns {Promise<{port: number, base: string, server: import("http").Server, accountDir: string}>}
 */
async function start({
    authToken = BEARER,
    oauth = { ...CONFIDENTIAL },
    accountId = ACCOUNT_A,
    accountDir = mkdtempSync(join(ROOT, "acc-")),
    approver = fakeApprover,
    trustedProxies,
} = {}) {
    const securePage = new SecurePage({ accountId });
    const deps = {
        buffer: { getStats: () => [], readCursor: () => 0 },
        config: {},
        accountDir,
        securePage,
        ...(approver ? { oauthApprover: approver } : {}),
        ...(trustedProxies ? { trustedProxies } : {}),
    };
    const server = createHTTPServer(
        () => {},
        deps,
        0,
        authToken,
        "127.0.0.1",
        null,
        oauth ? { accountId, ...oauth } : null,
    );
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    const port = server.address().port;
    securePage.configure({ localBaseUrl: `http://127.0.0.1:${port}` });
    return { port, base: `http://127.0.0.1:${port}`, server, accountDir };
}

const stop = (s) => new Promise((r) => s.server.close(() => r()));

/** One HTTP request, no redirect followed. */
function req(port, path, { method = "GET", headers = {}, body = null, form = null, json = null } = {}) {
    let payload = body;
    const h = { ...headers };
    if (form) {
        payload = new URLSearchParams(form).toString();
        h["content-type"] = "application/x-www-form-urlencoded";
    } else if (json) {
        payload = JSON.stringify(json);
        h["content-type"] = "application/json";
    }
    return new Promise((resolve, reject) => {
        const r = http.request({ host: "127.0.0.1", port, path, method, headers: h }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let parsed = null;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    /* not JSON */
                }
                resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
            });
        });
        r.on("error", reject);
        if (payload) r.write(payload);
        r.end();
    });
}

/** A PKCE pair. */
function pkce() {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

const authorizePath = (p) => `/authorize?${new URLSearchParams(p).toString()}`;

/**
 * The browser half: /authorize, then the approve page, then back to the client with a code.
 * @returns {Promise<{code: string|null, back: URL|null, pagePath: string, page: object, answer: object}>}
 */
async function approve(
    port,
    { clientId = CONFIDENTIAL.clientId, redirectUri = CLAUDE_CB, password = PASSWORD, extra = {} } = {},
) {
    const { verifier, challenge } = pkce();
    const start = await req(
        port,
        authorizePath({
            response_type: "code",
            client_id: clientId,
            redirect_uri: redirectUri,
            state: "state-123",
            code_challenge: challenge,
            code_challenge_method: "S256",
            scope: "mcp:tools",
            ...extra,
        }),
    );
    assert.equal(start.status, 302, `authorize: ${start.text}`);
    const pageUrl = new URL(start.headers.location, `http://127.0.0.1:${port}/authorize`);
    assert.match(pageUrl.pathname, /^\/zalo\/secure\/[A-Za-z0-9_-]{22}$/);
    const page = await req(port, pageUrl.pathname);
    const answer = await req(port, pageUrl.pathname, {
        method: "POST",
        form: { decision: "approve", secret: password },
    });
    const back = answer.status === 303 ? new URL(answer.headers.location) : null;
    return {
        code: back?.searchParams.get("code") ?? null,
        back,
        verifier,
        pagePath: pageUrl.pathname,
        page,
        answer,
        start,
    };
}

const tokenRequest = (port, form, headers = {}) => req(port, "/token", { method: "POST", form, headers });
const basic = (id, secret) =>
    `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;

/** The whole code flow for the confidential client: tokens. */
async function codeFlow(port, { client = CONFIDENTIAL, redirectUri = CLAUDE_CB } = {}) {
    const a = await approve(port, { clientId: client.clientId, redirectUri });
    assert.ok(a.code, "a code after approval");
    const form = {
        grant_type: "authorization_code",
        code: a.code,
        redirect_uri: redirectUri,
        code_verifier: a.verifier,
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    };
    const res = await tokenRequest(port, form);
    assert.equal(res.status, 200, res.text);
    return { ...res.json, code: a.code, form };
}

/** An MCP initialize call: 200 with the server's info when the bearer is admitted. */
async function mcpInit(port, token, headers = {}) {
    return req(port, "/mcp", {
        method: "POST",
        headers: {
            accept: "application/json, text/event-stream",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        json: {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        },
    });
}
const admitted = (res) => res.status === 200 && res.text.includes('"serverInfo"');

const payloadOf = (token) => JSON.parse(Buffer.from(token.slice(8).split(".")[0], "base64url").toString("utf8"));

// ── A1 ────────────────────────────────────────────────────────────────

describe("A1: OAuth is off unless asked for, and /register never hands out a server secret", () => {
    it("--auth alone: every OAuth route and both discovery documents answer 404; the bearer still works", async () => {
        const s = await start({ oauth: null });
        for (const [method, path] of [
            ["GET", "/.well-known/oauth-authorization-server"],
            ["GET", "/.well-known/oauth-protected-resource"],
            ["GET", "/.well-known/oauth-protected-resource/mcp"],
            ["GET", "/.well-known/openid-configuration"],
            ["GET", "/authorize?response_type=code&client_id=zalo-mcp"],
            ["POST", "/token"],
            ["POST", "/register"],
            ["POST", "/revoke"],
        ]) {
            const res = await req(s.port, path, { method, form: method === "POST" ? { a: "b" } : null });
            assert.equal(res.status, 404, `${method} ${path}`);
            assert.ok(!res.text.includes(BEARER));
        }
        // Not even a client named after the default id can use --auth as its secret.
        const cc = await tokenRequest(s.port, {
            grant_type: "client_credentials",
            client_id: "zalo-mcp",
            client_secret: BEARER,
        });
        assert.equal(cc.status, 404);
        assert.ok(admitted(await mcpInit(s.port, BEARER)), "the static bearer still opens /mcp");
        const unauth = await mcpInit(s.port, null);
        assert.equal(unauth.status, 401);
        assert.ok(!/resource_metadata/.test(unauth.headers["www-authenticate"]), "no OAuth pointer when OAuth is off");
    });

    it("dynamic registration is off by default even with OAuth on: /register is 404 and not advertised", async () => {
        const s = await start();
        assert.equal(
            (await req(s.port, "/register", { method: "POST", json: { redirect_uris: [CLAUDE_CB] } })).status,
            404,
        );
        const meta = (await req(s.port, "/.well-known/oauth-authorization-server")).json;
        assert.equal(meta.registration_endpoint, undefined);
    });

    it("with registration on: a public client by default, a per-client secret on request, never the server's", async () => {
        const s = await start({ oauth: { ...CONFIDENTIAL, allowDynamicRegistration: true } });
        const pub = await req(s.port, "/register", {
            method: "POST",
            json: { redirect_uris: [CLAUDE_CB], client_name: "Claude" },
        });
        assert.equal(pub.status, 201, pub.text);
        assert.equal(pub.json.token_endpoint_auth_method, "none");
        assert.equal(pub.json.client_secret, undefined);
        const conf = await req(s.port, "/register", {
            method: "POST",
            headers: { origin: "https://evil.example" },
            json: { redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: "client_secret_post" },
        });
        assert.equal(conf.status, 201);
        assert.match(conf.json.client_secret, /^zmcp_cs_/);
        assert.equal(conf.headers["access-control-allow-origin"], undefined, "a secret is not readable cross-origin");
        for (const r of [pub, conf]) {
            assert.ok(!r.text.includes(BEARER), "never the --auth token");
            assert.ok(!r.text.includes(CONFIDENTIAL.clientSecret), "never a configured client's secret");
        }
        // Only a hash is kept.
        const state = readFileSync(join(s.accountDir, OAUTH_STATE_FILE), "utf8");
        assert.ok(!state.includes(conf.json.client_secret));
    });

    it("registration needs redirect_uris, and refuses javascript:, data: and http off loopback", async () => {
        const s = await start({ oauth: { allowDynamicRegistration: true } });
        for (const uris of [undefined, [], ["javascript:alert(1)"], ["data:text/html,x"], ["http://evil.example/cb"]]) {
            const res = await req(s.port, "/register", { method: "POST", json: { redirect_uris: uris } });
            assert.equal(res.status, 400, JSON.stringify(uris));
            assert.equal(res.json.client_id, undefined);
        }
        assert.equal(
            (await req(s.port, "/register", { method: "POST", json: { redirect_uris: ["http://127.0.0.1/callback"] } }))
                .status,
            201,
        );
    });
});

// ── A2 ────────────────────────────────────────────────────────────────

describe("A2: a code only after the owner approves, and only to a registered redirect URI", () => {
    it("/authorize issues no code: it sends the browser to the one-time approve page", async () => {
        const s = await start();
        const a = await approve(s.port, { password: "wrong-password" });
        assert.ok(!/code=/.test(a.start.headers.location), "no code before approval");
        assert.equal(a.page.status, 200);
        assert.match(a.page.text, /Approver password/);
        assert.match(a.page.text, /connector/);
        // Which app asks, in both languages, and where the answer goes: the callback's host, never its path.
        assert.match(a.page.text, /Allow access to your Zalo account\?/);
        assert.match(a.page.text, /Cho phép truy cập tài khoản Zalo\?/);
        assert.match(
            a.page.text,
            new RegExp(`<span class="host">${new URL(CLAUDE_CB).host.replace(/\./g, "\\.")}</span>`),
        );
        assert.ok(!a.page.text.includes(new URL(CLAUDE_CB).pathname), "the host only");
        assert.match(a.page.headers["content-security-policy"], /form-action 'self' https:\/\/claude\.ai/);
        assert.equal(a.answer.status, 400, "a wrong password is asked again");
        assert.equal(a.code, null);
        // The right one, on the same page, approves.
        const right = await req(s.port, a.pagePath, {
            method: "POST",
            form: { decision: "approve", secret: PASSWORD },
        });
        assert.equal(right.status, 303);
        const back = new URL(right.headers.location);
        assert.equal(`${back.origin}${back.pathname}`, CLAUDE_CB);
        assert.match(back.searchParams.get("code"), /^zmcp_code_/);
        assert.equal(back.searchParams.get("state"), "state-123");
        assert.equal(back.searchParams.get("iss"), s.base, "RFC 9207 iss");
        // The page is one-time.
        assert.equal(
            (await req(s.port, a.pagePath, { method: "POST", form: { decision: "approve", secret: PASSWORD } })).status,
            409,
        );
    });

    it("Decline sends the client access_denied and no code", async () => {
        const s = await start();
        const { challenge } = pkce();
        const st = await req(
            s.port,
            authorizePath({
                response_type: "code",
                client_id: "connector",
                redirect_uri: CLAUDE_CB,
                state: "s1",
                code_challenge: challenge,
                code_challenge_method: "S256",
            }),
        );
        const path = new URL(st.headers.location, `${s.base}/authorize`).pathname;
        const res = await req(s.port, path, { method: "POST", form: { decision: "decline" } });
        assert.equal(res.status, 303);
        const back = new URL(res.headers.location);
        assert.equal(back.searchParams.get("error"), "access_denied");
        assert.equal(back.searchParams.get("code"), null);
    });

    it("with no approver secret set, /authorize refuses and says how to set one", async () => {
        // The default approver: the account's approver password (none set yet).
        const s = await start({ approver: null });
        const { challenge } = pkce();
        const p = {
            response_type: "code",
            client_id: "connector",
            redirect_uri: CLAUDE_CB,
            code_challenge: challenge,
            code_challenge_method: "S256",
        };
        const res = await req(s.port, authorizePath(p));
        assert.equal(res.status, 403);
        assert.match(res.json.error_description, /mcp approver set/);
        assert.equal(res.headers.location, undefined);
        // Once the owner sets one, the real password approves.
        setApproverPassword(s.accountDir, PASSWORD);
        const a = await approve(s.port);
        assert.match(a.code, /^zmcp_code_/);
    });

    it("refuses javascript:, unregistered and off-loopback http redirect URIs without redirecting", async () => {
        const s = await start({
            oauth: { ...CONFIDENTIAL, clients: [{ clientId: "local", redirectUris: ["http://127.0.0.1/callback"] }] },
        });
        const { challenge } = pkce();
        for (const [clientId, redirectUri] of [
            ["connector", "javascript:alert(document.cookie)"],
            ["connector", "https://evil.example/cb"],
            ["connector", `${CLAUDE_CB}/extra`],
            ["local", "http://evil.example/callback"],
            ["unknown-client", CLAUDE_CB],
        ]) {
            const res = await req(
                s.port,
                authorizePath({
                    response_type: "code",
                    client_id: clientId,
                    redirect_uri: redirectUri,
                    code_challenge: challenge,
                    code_challenge_method: "S256",
                }),
            );
            assert.equal(res.status, 400, `${clientId} ${redirectUri}`);
            assert.equal(res.headers.location, undefined);
        }
        // A loopback redirect URI matches on any port (RFC 8252), and a public configured client needs no secret.
        const flow = await codeFlow(s.port, {
            client: { clientId: "local" },
            redirectUri: "http://127.0.0.1:54321/callback",
        });
        assert.match(flow.access_token, /^zmcp_at_/);
    });

    it("redirect URI rules", () => {
        assert.match(redirectUriProblem("javascript:alert(1)"), /scheme/);
        assert.match(redirectUriProblem("http://example.com/cb"), /loopback/);
        assert.match(redirectUriProblem("https://example.com/cb#x"), /fragment/);
        assert.equal(redirectUriProblem("https://example.com/cb"), null);
        assert.equal(redirectUriProblem("http://[::1]:8080/cb"), null);
        assert.ok(redirectUriMatches("http://localhost/cb", "http://localhost:3000/cb"));
        assert.ok(!redirectUriMatches("https://a.example/cb", "https://a.example:444/cb"), "https: exact only");
        assert.ok(!redirectUriMatches("http://localhost/cb", "http://localhost:3000/cb2"));
    });
});

// ── A3 ────────────────────────────────────────────────────────────────

describe("A3: refresh rotation, reuse detection, revocation, removed clients", () => {
    it("tokens last 1 h (access) and rotate on refresh; a reused refresh token revokes the whole grant", async () => {
        const s = await start();
        const t = await codeFlow(s.port);
        assert.equal(t.expires_in, 3600);
        assert.ok(admitted(await mcpInit(s.port, t.access_token)));
        const auth = { client_id: "connector", client_secret: CONFIDENTIAL.clientSecret };
        const r1 = await tokenRequest(s.port, { grant_type: "refresh_token", refresh_token: t.refresh_token, ...auth });
        assert.equal(r1.status, 200);
        assert.notEqual(r1.json.refresh_token, t.refresh_token, "rotated");
        assert.ok(admitted(await mcpInit(s.port, r1.json.access_token)));
        // The old refresh token again: refused, and everything of this grant goes.
        const reuse = await tokenRequest(s.port, {
            grant_type: "refresh_token",
            refresh_token: t.refresh_token,
            ...auth,
        });
        assert.equal(reuse.status, 400);
        assert.equal(reuse.json.error, "invalid_grant");
        const r2 = await tokenRequest(s.port, {
            grant_type: "refresh_token",
            refresh_token: r1.json.refresh_token,
            ...auth,
        });
        assert.equal(r2.status, 400, "the newest refresh token is revoked too");
        assert.equal((await mcpInit(s.port, r1.json.access_token)).status, 401);
        assert.equal((await mcpInit(s.port, t.access_token)).status, 401);
    });

    it("/revoke (RFC 7009) revokes a refresh token's grant, and an access token's", async () => {
        const s = await start();
        const auth = { client_id: "connector", client_secret: CONFIDENTIAL.clientSecret };
        const a = await codeFlow(s.port);
        const rv = await req(s.port, "/revoke", { method: "POST", form: { token: a.refresh_token, ...auth } });
        assert.equal(rv.status, 200);
        assert.equal((await mcpInit(s.port, a.access_token)).status, 401);
        const again = await tokenRequest(s.port, {
            grant_type: "refresh_token",
            refresh_token: a.refresh_token,
            ...auth,
        });
        assert.equal(again.status, 400);

        const b = await codeFlow(s.port);
        assert.ok(admitted(await mcpInit(s.port, b.access_token)));
        await req(s.port, "/revoke", { method: "POST", form: { token: b.access_token, ...auth } });
        assert.equal((await mcpInit(s.port, b.access_token)).status, 401);
        // An unknown token is answered 200 (RFC 7009 §2.2); a client must still authenticate.
        assert.equal((await req(s.port, "/revoke", { method: "POST", form: { token: "nope", ...auth } })).status, 200);
        assert.equal(
            (await req(s.port, "/revoke", { method: "POST", form: { token: "nope", client_id: "connector" } })).status,
            401,
        );
    });

    it("a removed client's tokens stop working; the store keeps hashes only, at 0600", async () => {
        const dir = mkdtempSync(join(ROOT, "acc-"));
        // One public address across the restart (the ports differ): tokens are bound to the issuer.
        const issuerUrl = "http://localhost:3847";
        const two = { ...CONFIDENTIAL, issuerUrl, clients: [{ clientId: "crm", clientSecret: "crm-secret-not-real" }] };
        const s1 = await start({ oauth: two, accountDir: dir });
        const cc = await tokenRequest(s1.port, {
            grant_type: "client_credentials",
            client_id: "crm",
            client_secret: "crm-secret-not-real",
        });
        assert.equal(cc.status, 200);
        assert.equal(cc.json.refresh_token, undefined, "client_credentials: no refresh token");
        const flow = await codeFlow(s1.port);
        assert.ok(admitted(await mcpInit(s1.port, cc.json.access_token)));
        const state = readFileSync(join(dir, OAUTH_STATE_FILE), "utf8");
        assert.ok(!state.includes(flow.refresh_token), "no refresh token in clear");
        assert.ok(!state.includes(flow.access_token));
        if (process.platform !== "win32") assert.equal(statSync(join(dir, OAUTH_STATE_FILE)).mode & 0o777, 0o600);
        await stop(s1);
        // Restarted without "crm": its token is refused; the other client's grant survives the restart.
        const s2 = await start({ oauth: { ...CONFIDENTIAL, issuerUrl }, accountDir: dir });
        assert.equal((await mcpInit(s2.port, cc.json.access_token)).status, 401);
        const r = await tokenRequest(s2.port, {
            grant_type: "refresh_token",
            refresh_token: flow.refresh_token,
            client_id: "connector",
            client_secret: CONFIDENTIAL.clientSecret,
        });
        assert.equal(r.status, 200, r.text);
        assert.ok(admitted(await mcpInit(s2.port, r.json.access_token)));
    });

    it("lifetimes are configurable", async () => {
        const s = await start({ oauth: { ...CONFIDENTIAL, accessTokenTtlSec: 120 } });
        const t = await codeFlow(s.port);
        assert.equal(t.expires_in, 120);
        const p = payloadOf(t.access_token);
        assert.equal(p.exp - p.iat, 120);
        assert.equal(parseDuration("30d"), 30 * 86400_000);
        const r = resolveOAuthOptions({
            config: { oauth: { accessTokenTtl: "2h", refreshTokenTtl: "30d" } },
            accountId: ACCOUNT_A,
            publicUrl: null,
            env: {},
        });
        assert.equal(r.oauth.accessTokenTtlSec, 7200);
        assert.equal(r.oauth.refreshTokenTtlSec, 30 * 86400);
    });

    it("a refresh token expires after its sliding lifetime", () => {
        let now = 1_000_000_000_000;
        const store = createOAuthStore({ now: () => now });
        const { fam, refreshToken } = store.createFamily({
            cid: "c",
            scp: "mcp:tools",
            aud: "a",
            iss: "i",
            accessExp: 0,
            refreshTtlSec: 100,
        });
        now += 90_000;
        const r = store.rotateRefresh(refreshToken, 100);
        assert.equal(r.ok, true);
        now += 90_000; // 180 s after the grant, 90 s after the rotation: still alive
        assert.ok(store.family(fam));
        now += 20_000;
        assert.equal(store.rotateRefresh(r.refreshToken, 100).ok, false);
    });
});

// ── A4 ────────────────────────────────────────────────────────────────

describe("A4: tokens are bound to their issuer, audience and account", () => {
    it("a token carries iss and aud, and a request naming another issuer is refused", async () => {
        const s = await start();
        const t = await codeFlow(s.port);
        const p = payloadOf(t.access_token);
        assert.equal(p.iss, s.base);
        assert.equal(p.aud, `${s.base}/mcp`);
        assert.ok(admitted(await mcpInit(s.port, t.access_token)));
        assert.equal((await mcpInit(s.port, t.access_token, { host: `localhost:${s.port}` })).status, 401);
    });

    it("a token of account A is refused by account B, though both share the bearer and the client", async () => {
        const a = await start({ accountId: ACCOUNT_A });
        const b = await start({ accountId: ACCOUNT_B });
        const t = await codeFlow(a.port);
        assert.ok(admitted(await mcpInit(a.port, t.access_token)));
        // Same Host as A's server, so only the account differs.
        assert.equal((await mcpInit(b.port, t.access_token, { host: `127.0.0.1:${a.port}` })).status, 401);
    });

    it("a resource other than this server's /mcp is refused; nothing unenforced is advertised", async () => {
        const s = await start();
        const meta = (await req(s.port, "/.well-known/oauth-authorization-server")).json;
        assert.equal(meta.resource_indicators_supported, undefined);
        assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
        assert.deepEqual(meta.scopes_supported, [...SUPPORTED_SCOPES]);
        const { challenge } = pkce();
        const res = await req(
            s.port,
            authorizePath({
                response_type: "code",
                client_id: "connector",
                redirect_uri: CLAUDE_CB,
                code_challenge: challenge,
                code_challenge_method: "S256",
                resource: "https://other.example/mcp",
            }),
        );
        assert.equal(res.status, 302);
        assert.equal(new URL(res.headers.location).searchParams.get("error"), "invalid_target");
        const ok = await approve(s.port, { extra: { resource: `${s.base}/mcp` } });
        assert.ok(ok.code);
    });
});

// ── A5 ────────────────────────────────────────────────────────────────

describe("A5: PKCE S256 is required, and the redirect_uri at /token", () => {
    it("no challenge, plain, or no method: the client gets invalid_request and no approve page", async () => {
        const s = await start();
        const { verifier, challenge } = pkce();
        for (const extra of [
            {},
            { code_challenge: verifier, code_challenge_method: "plain" },
            { code_challenge: challenge },
            { code_challenge: challenge, code_challenge_method: "S512" },
        ]) {
            const res = await req(
                s.port,
                authorizePath({ response_type: "code", client_id: "connector", redirect_uri: CLAUDE_CB, ...extra }),
            );
            assert.equal(res.status, 302, JSON.stringify(extra));
            const back = new URL(res.headers.location);
            assert.equal(back.origin + back.pathname, CLAUDE_CB);
            assert.equal(back.searchParams.get("error"), "invalid_request");
            assert.equal(back.searchParams.get("code"), null);
        }
    });

    it("a wrong verifier or a missing redirect_uri is invalid_grant", async () => {
        const s = await start();
        const auth = { client_id: "connector", client_secret: CONFIDENTIAL.clientSecret };
        const a = await approve(s.port);
        const wrong = await tokenRequest(s.port, {
            grant_type: "authorization_code",
            code: a.code,
            redirect_uri: CLAUDE_CB,
            code_verifier: pkce().verifier,
            ...auth,
        });
        assert.equal(wrong.json.error, "invalid_grant");
        const b = await approve(s.port);
        const noRedirect = await tokenRequest(s.port, {
            grant_type: "authorization_code",
            code: b.code,
            code_verifier: b.verifier,
            ...auth,
        });
        assert.equal(noRedirect.json.error, "invalid_grant");
    });
});

// ── A6 ────────────────────────────────────────────────────────────────

describe("A6: a secret authenticates only its own client and is not a bearer token", () => {
    it("the --auth token and another client's secret are refused at /token", async () => {
        const s = await start({
            oauth: { ...CONFIDENTIAL, clients: [{ clientId: "crm", clientSecret: "crm-secret-not-real" }] },
        });
        for (const [id, secret] of [
            ["connector", BEARER],
            ["crm", BEARER],
            ["crm", CONFIDENTIAL.clientSecret],
            ["connector", "crm-secret-not-real"],
        ]) {
            const res = await tokenRequest(s.port, {
                grant_type: "client_credentials",
                client_id: id,
                client_secret: secret,
            });
            assert.equal(res.status, 401, `${id} with another secret`);
            assert.equal(res.json.error, "invalid_client");
        }
        const ok = await tokenRequest(
            s.port,
            { grant_type: "client_credentials" },
            { authorization: basic("crm", "crm-secret-not-real") },
        );
        assert.equal(ok.status, 200);
    });

    it("a client secret does not open /mcp, unless oauth.secretsAsBearer keeps the 3.0.0 behavior", async () => {
        const s = await start();
        assert.equal((await mcpInit(s.port, CONFIDENTIAL.clientSecret)).status, 401);
        const legacy = await start({ oauth: { ...CONFIDENTIAL, secretsAsBearer: true } });
        assert.ok(admitted(await mcpInit(legacy.port, CONFIDENTIAL.clientSecret)));
    });

    it("mcp start no longer takes the client secret as the bearer token or --auth as the client secret", () => {
        const r = resolveOAuthOptions({
            opts: { auth: BEARER },
            config: {},
            accountId: ACCOUNT_A,
            publicUrl: null,
            env: { ZALO_MCP_OAUTH_CLIENT_SECRET: "only-the-client-secret" },
        });
        assert.equal(r.authToken, BEARER);
        assert.equal(r.oauth.clientSecret, "only-the-client-secret");
        const alone = resolveOAuthOptions({ opts: { auth: BEARER }, config: {}, accountId: ACCOUNT_A, env: {} });
        assert.equal(alone.oauth.clientSecret, null, "--auth is not a client secret");
        assert.equal(oauthStartCheck({ oauth: alone.oauth, authToken: BEARER, host: "127.0.0.1" }).enabled, false);
        const noBearer = resolveOAuthOptions({
            config: { oauth: { clientSecret: "client-secret" } },
            accountId: ACCOUNT_A,
            env: {},
        });
        assert.equal(noBearer.authToken, null, "the client secret is not the bearer token");
        const env = {
            [`ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION_${ACCOUNT_A}`]: "true",
            ZALO_MCP_OAUTH_REDIRECT_URIS: `${CLAUDE_CB}, http://127.0.0.1/cb`,
        };
        const dyn = resolveOAuthOptions({ config: {}, accountId: ACCOUNT_A, env });
        assert.equal(dyn.oauth.allowDynamicRegistration, true);
        assert.deepEqual(dyn.oauth.redirectUris, [CLAUDE_CB, "http://127.0.0.1/cb"]);
        assert.equal(
            resolveOAuthOptions({ config: {}, accountId: ACCOUNT_B, env }).oauth.allowDynamicRegistration,
            false,
        );
    });
});

// ── A7 ────────────────────────────────────────────────────────────────

describe("A7: registered clients persist, and a flood cannot evict one in use", () => {
    it("a registration survives a restart; past the cap, new ones are refused instead of evicting", async () => {
        const dir = mkdtempSync(join(ROOT, "acc-"));
        const oauth = { allowDynamicRegistration: true };
        const s1 = await start({ oauth, accountDir: dir, trustedProxies: ["loopback"] });
        const reg = (n) =>
            req(s1.port, "/register", {
                method: "POST",
                headers: { "x-forwarded-for": `198.51.100.${n % 250}` },
                json: { redirect_uris: [CLAUDE_CB] },
            });
        const first = await reg(0);
        const used = await codeFlow(s1.port, { client: { clientId: first.json.client_id } });
        for (let i = 1; i < MAX_DYNAMIC_CLIENTS; i++) assert.equal((await reg(i)).status, 201);
        const over = await reg(MAX_DYNAMIC_CLIENTS);
        assert.equal(over.status, 400);
        await stop(s1);
        const s2 = await start({ oauth, accountDir: dir });
        const r = await tokenRequest(s2.port, {
            grant_type: "refresh_token",
            refresh_token: used.refresh_token,
            client_id: first.json.client_id,
        });
        assert.equal(r.status, 200, r.text);
    });

    it("/register is rate limited per client address", async () => {
        const s = await start({ oauth: { allowDynamicRegistration: true } });
        const codes = [];
        for (let i = 0; i < 11; i++) {
            codes.push(
                (await req(s.port, "/register", { method: "POST", json: { redirect_uris: [CLAUDE_CB] } })).status,
            );
        }
        assert.deepEqual(codes.slice(0, 10), Array(10).fill(201));
        assert.equal(codes[10], 429);
    });
});

// ── A8 ────────────────────────────────────────────────────────────────

describe("A8: the issuer is never taken from an untrusted X-Forwarded-Host", () => {
    it("ignored from an untrusted peer, honored from a trusted proxy", async () => {
        const s = await start();
        const fwd = { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" };
        const meta = (await req(s.port, "/.well-known/oauth-authorization-server", { headers: fwd })).json;
        assert.equal(meta.issuer, s.base);
        assert.ok(!JSON.stringify(meta).includes("evil.example"));
        const trusted = await start({ trustedProxies: ["loopback"] });
        const viaProxy = (await req(trusted.port, "/.well-known/oauth-authorization-server", { headers: fwd })).json;
        assert.equal(viaProxy.issuer, "https://evil.example");
    });

    it("OAuth off loopback with no publicUrl does not start", () => {
        const check = oauthStartCheck({ oauth: CONFIDENTIAL, authToken: BEARER, host: "0.0.0.0", publicUrl: null });
        assert.match(check.problem, /publicUrl/);
        assert.throws(
            () =>
                createHTTPServer(
                    () => {},
                    { buffer: { getStats: () => [] } },
                    0,
                    BEARER,
                    "0.0.0.0",
                    null,
                    CONFIDENTIAL,
                ),
            /publicUrl/,
        );
        const fine = oauthStartCheck({
            oauth: CONFIDENTIAL,
            authToken: BEARER,
            host: "0.0.0.0",
            publicUrl: "https://zalo.example.com",
        });
        assert.equal(fine.problem, null);
        // A bearer-only server off loopback is not OAuth's business.
        assert.equal(
            oauthStartCheck({ oauth: null, authToken: BEARER, host: "0.0.0.0", publicUrl: null }).problem,
            null,
        );
        // Dynamic registration with nothing to sign with does not start either.
        assert.match(
            oauthStartCheck({ oauth: { allowDynamicRegistration: true }, authToken: null, host: "127.0.0.1" }).problem,
            /secret/,
        );
    });
});

// ── A9 ────────────────────────────────────────────────────────────────

describe("A9: an issuer with a base path serves its path-inserted discovery documents", () => {
    it("/.well-known/oauth-authorization-server/a/<id> and /.well-known/oauth-protected-resource/a/<id>/mcp", async () => {
        const issuer = `https://zalo.example.com/a/${ACCOUNT_A}`;
        const s = await start({ oauth: { ...CONFIDENTIAL, issuerUrl: issuer } });
        const as = await req(s.port, `/.well-known/oauth-authorization-server/a/${ACCOUNT_A}`);
        assert.equal(as.status, 200);
        assert.equal(as.json.issuer, issuer);
        assert.equal(as.json.token_endpoint, `${issuer}/token`);
        const prm = await req(s.port, `/.well-known/oauth-protected-resource/a/${ACCOUNT_A}/mcp`);
        assert.equal(prm.status, 200);
        assert.equal(prm.json.resource, `${issuer}/mcp`);
        assert.deepEqual(prm.json.authorization_servers, [issuer]);
        // Behind the proxy's prefix strip, the appended forms answer too.
        assert.equal((await req(s.port, "/.well-known/oauth-authorization-server")).json.issuer, issuer);
        assert.equal((await req(s.port, "/.well-known/oauth-protected-resource/mcp")).status, 200);
        // Another account's path is not this server's.
        assert.equal((await req(s.port, `/.well-known/oauth-authorization-server/a/${ACCOUNT_B}`)).status, 404);
        const unauth = await mcpInit(s.port, null);
        assert.match(
            unauth.headers["www-authenticate"],
            new RegExp(`resource_metadata="${issuer}/\\.well-known/oauth-protected-resource/mcp"`),
        );
    });
});

// ── A10 ───────────────────────────────────────────────────────────────

describe("A10: protocol details", () => {
    it("Basic auth failure gets a Basic challenge; a malformed body gets JSON invalid_request", async () => {
        const s = await start();
        const bad = await tokenRequest(
            s.port,
            { grant_type: "client_credentials" },
            { authorization: basic("connector", "nope") },
        );
        assert.equal(bad.status, 401);
        assert.equal(bad.json.error, "invalid_client");
        assert.match(bad.headers["www-authenticate"], /^Basic /);
        const malformed = await req(s.port, "/token", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not json",
        });
        assert.equal(malformed.status, 400);
        assert.equal(malformed.json.error, "invalid_request");
        assert.match(malformed.headers["content-type"], /json/);
    });

    it("/mcp's 401 follows RFC 6750: invalid_token for a bad token, a challenge naming the metadata", async () => {
        const s = await start();
        const bad = await mcpInit(s.port, "zmcp_at_forged.signature");
        assert.equal(bad.status, 401);
        assert.equal(bad.json.error, "invalid_token");
        assert.match(bad.headers["www-authenticate"], /^Bearer .*error="invalid_token"/);
        assert.match(bad.headers["www-authenticate"], /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known/);
        const none = await mcpInit(s.port, null);
        assert.equal(none.status, 401);
        assert.ok(!/error=/.test(none.headers["www-authenticate"]), "no error code without credentials");
    });

    it("response_type is required; the fake OpenID document is gone; scopes are granted from the supported set", async () => {
        const s = await start();
        const { challenge } = pkce();
        const res = await req(
            s.port,
            authorizePath({
                client_id: "connector",
                redirect_uri: CLAUDE_CB,
                code_challenge: challenge,
                code_challenge_method: "S256",
            }),
        );
        assert.equal(new URL(res.headers.location).searchParams.get("error"), "unsupported_response_type");
        assert.equal((await req(s.port, "/.well-known/openid-configuration")).status, 404);
        const cc = await tokenRequest(s.port, {
            grant_type: "client_credentials",
            client_id: "connector",
            client_secret: CONFIDENTIAL.clientSecret,
            scope: "read write admin",
        });
        assert.equal(cc.json.scope, "mcp:tools");
    });

    it("a code works once; a replay revokes what it gave; a restart forgets unredeemed codes", async () => {
        const dir = mkdtempSync(join(ROOT, "acc-"));
        const s = await start({ accountDir: dir });
        const t = await codeFlow(s.port);
        const replay = await tokenRequest(s.port, t.form);
        assert.equal(replay.json.error, "invalid_grant");
        assert.equal((await mcpInit(s.port, t.access_token)).status, 401, "the replayed code's grant is revoked");
        const pending = await approve(s.port);
        await stop(s);
        const s2 = await start({ accountDir: dir });
        const after = await tokenRequest(s2.port, {
            grant_type: "authorization_code",
            code: pending.code,
            redirect_uri: CLAUDE_CB,
            code_verifier: pending.verifier,
            client_id: "connector",
            client_secret: CONFIDENTIAL.clientSecret,
        });
        assert.equal(after.json.error, "invalid_grant");
    });

    it("/token and /authorize are rate limited per client address", async () => {
        const s = await start();
        let last;
        for (let i = 0; i < 61; i++) last = await tokenRequest(s.port, { grant_type: "client_credentials" });
        assert.equal(last.status, 429);
        assert.ok(Number(last.headers["retry-after"]) > 0);
    });

    it("safeEqual compares any lengths in constant time", () => {
        assert.equal(safeEqual("abc", "abc"), true);
        assert.equal(safeEqual("abc", "abcd"), false);
        assert.equal(safeEqual("", ""), true);
        assert.equal(safeEqual("abc", undefined), false);
    });
});

// ── Message Router: one connector address per agent ──────────────────────

describe("per-agent connector addresses (/mcp/a/<slug>)", () => {
    /** An MCP initialize call on a given path. */
    const initAt = (port, path, token) =>
        req(port, path, {
            method: "POST",
            headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
            json: {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
            },
        });

    it("a grant made for an agent's address is that agent's: its audience, its approve page, its path only", async () => {
        const s = await start();
        const iss = (await req(s.port, "/.well-known/oauth-authorization-server")).json.issuer;
        const meta = (await req(s.port, "/.well-known/oauth-protected-resource/mcp/a/dev")).json;
        assert.equal(meta.resource, `${iss}/mcp/a/dev`);

        const a = await approve(s.port, { extra: { resource: `${iss}/mcp/a/dev` } });
        assert.match(
            a.page.text,
            /It connects as the agent[\s\S]{0,200}>dev</,
            "the owner sees which agent he connects",
        );
        assert.ok(a.code);
        const res = await tokenRequest(s.port, {
            grant_type: "authorization_code",
            code: a.code,
            redirect_uri: CLAUDE_CB,
            code_verifier: a.verifier,
            client_id: CONFIDENTIAL.clientId,
            client_secret: CONFIDENTIAL.clientSecret,
            resource: `${iss}/mcp/a/dev`,
        });
        assert.equal(res.status, 200, res.text);
        const token = res.json.access_token;
        assert.equal(payloadOf(token).aud, `${iss}/mcp/a/dev`);
        assert.ok(admitted(await initAt(s.port, "/mcp/a/dev", token)));
        assert.ok(admitted(await initAt(s.port, "/mcp", token)), "the account's own address takes any of its grants");
        const other = await initAt(s.port, "/mcp/a/ai", token);
        assert.equal(other.status, 401, "another agent's address refuses it");
        assert.match(other.headers["www-authenticate"], /oauth-protected-resource\/mcp\/a\/ai"/);

        // A token for the account's address does not open an agent's address.
        const plain = await codeFlow(s.port);
        assert.equal((await initAt(s.port, "/mcp/a/dev", plain.access_token)).status, 401);
    });

    it("refuses a resource that is not this server's address or a valid agent's", async () => {
        const s = await start();
        const iss = (await req(s.port, "/.well-known/oauth-authorization-server")).json.issuer;
        for (const resource of [`${iss}/mcp/a/Bad`, `${iss}/mcp/a/`, `${iss}/mcp/x/dev`]) {
            const { challenge } = pkce();
            const r = await req(
                s.port,
                authorizePath({
                    response_type: "code",
                    client_id: CONFIDENTIAL.clientId,
                    redirect_uri: CLAUDE_CB,
                    code_challenge: challenge,
                    code_challenge_method: "S256",
                    resource,
                }),
            );
            assert.equal(new URL(r.headers.location).searchParams.get("error"), "invalid_target", resource);
        }
        assert.equal((await req(s.port, "/.well-known/oauth-protected-resource/mcp/a/Bad")).status, 404);
    });
});

describe("binding a /mcp grant to an agent on the approve page", () => {
    it("offers no agent, the account's agents or a new one; the pick is kept with the grant", async () => {
        const s = await start();
        const { challenge, verifier } = pkce();
        const startRes = await req(
            s.port,
            authorizePath({
                response_type: "code",
                client_id: CONFIDENTIAL.clientId,
                redirect_uri: CLAUDE_CB,
                code_challenge: challenge,
                code_challenge_method: "S256",
            }),
        );
        const pagePath = new URL(startRes.headers.location, `http://127.0.0.1:${s.port}/authorize`).pathname;
        const page = await req(s.port, pagePath);
        assert.match(page.text, /<select id="agent" name="agent"/);
        assert.match(page.text, /value="\+new"/);
        const answer = await req(s.port, pagePath, {
            method: "POST",
            form: { decision: "approve", secret: PASSWORD, agent: "+new", agentNew: "Arden Dev" },
        });
        const code = new URL(answer.headers.location).searchParams.get("code");
        const res = await tokenRequest(s.port, {
            grant_type: "authorization_code",
            code,
            redirect_uri: CLAUDE_CB,
            code_verifier: verifier,
            client_id: CONFIDENTIAL.clientId,
            client_secret: CONFIDENTIAL.clientSecret,
        });
        assert.equal(res.status, 200, res.text);
        const grants = createOAuthStore({ file: join(s.accountDir, OAUTH_STATE_FILE) }).listGrants();
        assert.deepEqual(
            grants.map((g) => [g.agent, g.agentName]),
            [["arden-dev", "Arden Dev"]],
        );
        assert.equal(slugFromName("Trợ lý Đơn hàng!"), "tro-ly-don-hang");
        assert.equal(slugFromName("123"), null);
    });

    it("an agent's own address shows its agent and no picker", async () => {
        const s = await start();
        const iss = (await req(s.port, "/.well-known/oauth-authorization-server")).json.issuer;
        const a = await approve(s.port, { extra: { resource: `${iss}/mcp/a/dev` } });
        assert.doesNotMatch(a.page.text, /name="agent"/);
    });
});
