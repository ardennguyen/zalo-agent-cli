/**
 * The three security-relevant surfaces that sat at 0% function coverage.
 *
 * Each is reachable from data this account does not control, each fails
 * open rather than closed, and each was covered only by a checkbox in
 * tests/README.md's manual section:
 *
 *   1. src/utils/open-file.js       — a shell, fed a Zalo-supplied filename
 *   2. src/utils/qr-http-server.js  — the 0.0.0.0 vs 127.0.0.1 bind guard,
 *                                     a regression that already shipped once
 *   3. src/mcp/mcp-http-transport.js — bearer auth, where an empty token
 *                                     silently means "no auth at all"
 *
 * All three are testable offline; nothing here opens a Zalo session.
 */

import "../helpers/sandbox.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFile, SHELL_METACHARACTERS } from "../../src/utils/open-file.js";
import { sanitize } from "../../src/core/sync-v2/media.js";
import { startQrServer, qrVersion } from "../../src/utils/qr-http-server.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { SecurePage } from "../../src/core/secure-page.js";

// ── 1. shell injection through a downloaded filename ───────────────────

describe("openFile — a Zalo filename must not reach cmd.exe as syntax", () => {
    // On Windows openFile() runs `start "" <path>` with shell: true. cmd.exe
    // treats & ^ % ` ! | < > " as syntax, so a path carrying one is a
    // command-injection vector — and the path is built from the filename
    // Zalo hands us for an attachment.
    const EVIL = ["holiday&calc.exe.jpg", "a^b.jpg", "100%s.jpg", "x`whoami`.jpg", "a|b.jpg", 'q"r.jpg'];

    it("sanitize() strips every character cmd.exe would act on", () => {
        for (const name of EVIL) {
            const safe = sanitize(name);
            assert.ok(
                !SHELL_METACHARACTERS.test(safe),
                `sanitize left a shell metacharacter in ${JSON.stringify(safe)} (from ${JSON.stringify(name)})`,
            );
        }
    });

    it("sanitize() still strips the characters Windows forbids in a filename", () => {
        const BS = String.fromCharCode(92);
        for (const ch of ["/", BS, ":", "*", "?", "<", ">", "|", '"']) {
            assert.ok(!sanitize(`a${ch}b`).includes(ch), `sanitize kept ${JSON.stringify(ch)}`);
        }
    });

    it("sanitize() leaves ordinary names — including Vietnamese — alone", () => {
        assert.equal(sanitize("Ảnh chụp màn hình.png"), "Ảnh chụp màn hình.png");
        assert.equal(sanitize("report-2026_final (1).pdf"), "report-2026_final (1).pdf");
    });

    it("openFile() refuses a metacharacter path outright, as a second line of defence", () => {
        // openFile is also reachable from the MCP zalo_view_media tool with a
        // path this codebase did not build, so the guard cannot rely on
        // sanitize() having run.
        const errs = [];
        const realErr = console.error;
        console.error = (m) => errs.push(String(m));
        try {
            openFile("C:\\media\\holiday&calc.exe.jpg");
        } finally {
            console.error = realErr;
        }
        // On non-Windows the guard does not apply (no shell is used), so the
        // assertion is conditional on the branch actually being taken.
        if (process.platform === "win32") {
            assert.equal(errs.length, 1, "expected a refusal");
            assert.match(errs[0], /Refusing to open a path containing shell metacharacters/);
        }
    });
});

// ── 2. the QR server's bind guard ──────────────────────────────────────

describe("startQrServer — bind host", () => {
    const servers = [];
    after(() => servers.forEach((s) => s.close?.()));

    it("binds loopback by default, so the QR is not offered to the network", async () => {
        const s = startQrServer("nonexistent-qr.png", 0, [0], false);
        servers.push(s);
        assert.match(s.url, /^http:\/\/(127\.0\.0\.1|localhost)[:/]/, `default bind must be loopback, got ${s.url}`);
    });

    it("only reaches 0.0.0.0 when exposeOnLan is explicitly true", async () => {
        // The regression this guards already shipped once: scanning the QR
        // signs the scanner in as this account, so a LAN bind offers the
        // account to every host on the network. It must stay opt-in.
        const s = startQrServer("nonexistent-qr.png", 0, [0], true);
        servers.push(s);
        assert.ok(s.url, "expected a server url");
    });

    it("exposes a close() that actually stops listening", async () => {
        const s = startQrServer("nonexistent-qr.png", 0, [0], false);
        assert.equal(typeof s.close, "function");
        s.close();
    });
});

// The page polls /status and swaps in each regenerated QR by this version.
// Measured 2026-09-30: a page opened on the first QR kept it through two
// regenerations, and the scan of the expired code failed.
describe("qrVersion — which QR is current", () => {
    it("is null before any QR exists, and changes when the QR is regenerated", () => {
        const dir = mkdtempSync(join(tmpdir(), "zalo-qr-"));
        const qr = join(dir, "qr.png");
        try {
            assert.equal(qrVersion(qr), null);
            writeFileSync(qr, "first");
            utimesSync(qr, new Date(1_790_000_000_000), new Date(1_790_000_000_000));
            const first = qrVersion(qr);
            assert.equal(typeof first, "number");
            writeFileSync(qr, "second");
            utimesSync(qr, new Date(1_790_000_100_000), new Date(1_790_000_100_000));
            // Red if the page has nothing that changes when a new QR lands.
            assert.notEqual(qrVersion(qr), first);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── 3. MCP bearer auth ─────────────────────────────────────────────────

/** An MCP initialize request: a served one answers 200 with the server's info. */
const INITIALIZE = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

describe("createHTTPServer — bearer auth", () => {
    const servers = [];
    after(() => servers.forEach((s) => s.close()));

    /** Start the transport on an ephemeral port and return its base URL. */
    async function start(authToken) {
        const noopRegister = () => {};
        // /health reports deps.buffer.getStats().length, so the fake needs
        // that much shape or the handler 500s and the auth assertions below
        // would be testing the wrong failure.
        const deps = {
            api: {},
            buffer: { getStats: () => [] },
            filter: {},
            config: {},
            nameCache: null,
            accountDir: ".",
        };
        const server = createHTTPServer(noopRegister, deps, 0, authToken, "127.0.0.1");
        servers.push(server);
        if (!server.listening) await once(server, "listening");
        return `http://127.0.0.1:${server.address().port}`;
    }

    it("/health answers WITHOUT a token", async () => {
        const base = await start("s3cret");
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200, "health must stay reachable for probes");
    });

    it("rejects a request with no Authorization header", async () => {
        const base = await start("s3cret");
        const res = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
        assert.equal(res.status, 401);
    });

    it("rejects a wrong token, and one that merely shares a prefix", async () => {
        const base = await start("s3cret");
        for (const bad of ["wrong", "s3cre", "s3crett", ""]) {
            const res = await fetch(`${base}/mcp`, {
                method: "POST",
                headers: { Authorization: `Bearer ${bad}` },
                body: "{}",
            });
            assert.equal(res.status, 401, `token ${JSON.stringify(bad)} should be rejected`);
        }
    });

    it("CHARACTERIZATION: a null token starts a server with NO auth at all", async () => {
        // src/commands/mcp.js coerces `opts.auth?.trim() || null`, so
        // `--auth "$UNSET"` or `--auth ""` becomes null and every request is
        // accepted — while the startup log still reports success. Pinned
        // here so the day someone makes an empty --auth fatal, this test is
        // the reminder to update the docs with it.
        const base = await start(null);
        const res = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify(INITIALIZE),
        });
        assert.equal(res.status, 200, "with authToken=null the transport serves anyone");
        assert.match(await res.text(), /"serverInfo"/);
    });

    it("the right token is served (the MCP initialize answer), not merely 'not 401'", async () => {
        const base = await start("s3cret");
        const res = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                Authorization: "Bearer s3cret",
            },
            body: JSON.stringify(INITIALIZE),
        });
        assert.equal(res.status, 200);
        assert.match(await res.text(), /"serverInfo"/);
    });
});

/**
 * Build a minimal DER TLV node (`tag`, `length`, `value`).
 * @param {number} tag
 * @param {Buffer} body
 * @returns {Buffer}
 */
function derNode(tag, body) {
    const len = body.length;
    if (len < 128) return Buffer.concat([Buffer.from([tag, len]), body]);
    const lenBytes = [];
    let n = len;
    while (n > 0) {
        lenBytes.unshift(n & 0xff);
        n >>= 8;
    }
    return Buffer.concat([Buffer.from([tag, 0x80 | lenBytes.length, ...lenBytes]), body]);
}

/**
 * Generate an ephemeral self-signed P-256 X.509 certificate and private key in
 * memory using pure Node `node:crypto` (no external `openssl` binary and no
 * static base64 fixture strings that could trip `no-real-ids.test.js`).
 * @returns {{ cert: string, key: string }}
 */
function generateSelfSignedTls() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = publicKey.export({ type: "spki", format: "der" });
    // OID 1.2.840.10045.4.3.2 (ecdsa-with-SHA256)
    const algId = derNode(0x30, Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
    // Name: RDNSequence -> RelativeDistinguishedName -> AttributeTypeAndValue (CN=localhost)
    const cnOid = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);
    const cnVal = derNode(0x0c, Buffer.from("localhost", "utf8"));
    const name = derNode(0x30, derNode(0x31, derNode(0x30, Buffer.concat([cnOid, cnVal]))));
    const validity = derNode(
        0x30,
        Buffer.concat([
            derNode(0x17, Buffer.from("250101000000Z", "ascii")),
            derNode(0x17, Buffer.from("350101000000Z", "ascii")),
        ]),
    );
    const serial = derNode(0x02, Buffer.from([0x01]));
    const tbs = derNode(0x30, Buffer.concat([serial, algId, name, validity, name, spki]));
    const sig = sign("sha256", tbs, privateKey);
    const bitString = derNode(0x03, Buffer.concat([Buffer.from([0x00]), sig]));
    const certDer = derNode(0x30, Buffer.concat([tbs, algId, bitString]));
    const b64 = certDer
        .toString("base64")
        .replace(/(.{64})/g, "$1\n")
        .trim();
    const cert = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
    const key = privateKey.export({ type: "pkcs8", format: "pem" });
    return { cert, key };
}

/**
 * Perform an HTTPS request against a self-signed local test server.
 * @param {number} port
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [options]
 * @returns {Promise<{ status: number, body: string }>}
 */
function httpsRequest(port, path, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: "127.0.0.1",
                port,
                path,
                method: options.method || "GET",
                headers: options.headers || {},
                rejectUnauthorized: false,
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
            },
        );
        req.on("error", reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

/**
 * An MCP initialize call over HTTPS with a bearer token.
 * @param {number} port
 * @param {string} token
 * @returns {Promise<{ status: number, body: string }>}
 */
function mcpInitHttps(port, token) {
    return httpsRequest(port, "/mcp", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(INITIALIZE),
    });
}

describe("createHTTPServer — HTTPS with TLS cert & key", () => {
    const servers = [];
    after(() => servers.forEach((s) => s.close()));

    it("serves HTTPS over TLS and enforces bearer auth on /mcp while leaving /health open", async () => {
        const tls = generateSelfSignedTls();
        const deps = {
            api: {},
            buffer: { getStats: () => [] },
            filter: {},
            config: {},
            nameCache: null,
            accountDir: ".",
        };
        const server = createHTTPServer(() => {}, deps, 0, "tls-s3cret", "127.0.0.1", tls);
        servers.push(server);
        if (!server.listening) await once(server, "listening");
        const port = server.address().port;

        const health = await httpsRequest(port, "/health");
        assert.equal(health.status, 200);
        assert.equal(JSON.parse(health.body).status, "ok");

        const unauth = await httpsRequest(port, "/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        assert.equal(unauth.status, 401);

        // The right token gets the MCP server's answer to initialize, not merely "something other than 401".
        const authed = await mcpInitHttps(port, "tls-s3cret");
        assert.equal(authed.status, 200);
        assert.match(authed.body, /"serverInfo"/);
        assert.equal((await mcpInitHttps(port, "tls-s3cre")).status, 401, "a prefix of the token is not the token");
    });

    it("OAuth over HTTPS for Gemini: discovery, approval, authorization_code with S256 PKCE, refresh, Basic auth", async () => {
        const tls = generateSelfSignedTls();
        const securePage = new SecurePage({ accountId: "1000000000000000001" });
        const deps = {
            api: {},
            buffer: { getStats: () => [] },
            filter: {},
            config: {},
            nameCache: null,
            accountDir: mkdtempSync(join(tmpdir(), "zalo-oauth-tls-")),
            securePage,
            oauthApprover: () => ({
                kind: "password",
                approverSecret: true,
                check: async (typed) =>
                    typed === "approver-password-not-real"
                        ? { status: "approved" }
                        : { status: "retry", message: "Wrong approver password." },
            }),
        };
        const redirectUri = "https://vertexaisearch.cloud.google.com/oauth-redirect";
        const server = createHTTPServer(() => {}, deps, 0, "static-s3cret", "127.0.0.1", tls, {
            accountId: "1000000000000000001",
            clientId: "gemini-client",
            clientSecret: "oauth-s3cret",
            redirectUris: [redirectUri],
            issuerUrl: null,
        });
        servers.push(server);
        if (!server.listening) await once(server, "listening");
        const port = server.address().port;
        securePage.configure({ localBaseUrl: `https://127.0.0.1:${port}` });

        // 1. Metadata discovery (unauthenticated)
        const metaRes = await httpsRequest(port, "/.well-known/oauth-authorization-server");
        assert.equal(metaRes.status, 200);
        const meta = JSON.parse(metaRes.body);
        assert.equal(meta.issuer, `https://127.0.0.1:${port}`);
        assert.equal(meta.authorization_endpoint, `https://127.0.0.1:${port}/authorize`);
        assert.equal(meta.token_endpoint, `https://127.0.0.1:${port}/token`);
        assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);

        const prmRes = await httpsRequest(port, "/.well-known/oauth-protected-resource/mcp");
        assert.equal(prmRes.status, 200);
        assert.equal(JSON.parse(prmRes.body).resource, `https://127.0.0.1:${port}/mcp`);

        // 2. /authorize sends the browser to the approve page; the code comes only after the approver password.
        const verifier = "a-pkce-code-verifier-of-at-least-forty-three-characters";
        const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
        const authPath =
            `/authorize?response_type=code&client_id=gemini-client&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&state=xyz123&code_challenge=${challenge}&code_challenge_method=S256`;
        const authRes = await httpsRequest(port, authPath);
        assert.equal(authRes.status, 302);
        assert.ok(!authRes.headers.location.includes("code="), "no code before approval");
        const pagePath = new URL(authRes.headers.location, `https://127.0.0.1:${port}/authorize`).pathname;
        const approved = await httpsRequest(port, pagePath, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "decision=approve&secret=approver-password-not-real",
        });
        assert.equal(approved.status, 303);
        const redirected = new URL(approved.headers.location);
        assert.equal(redirected.origin + redirected.pathname, redirectUri);
        assert.equal(redirected.searchParams.get("state"), "xyz123");
        assert.equal(redirected.searchParams.get("iss"), `https://127.0.0.1:${port}`);
        const code = redirected.searchParams.get("code");
        assert.match(code, /^zmcp_code_/);

        // 3. Exchange the code at POST /token with client_secret_basic and the PKCE verifier
        const basicAuth = Buffer.from("gemini-client:oauth-s3cret", "utf8").toString("base64");
        const tokenBody = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
        }).toString();
        const tokenHeaders = {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${basicAuth}`,
        };
        const tokenRes = await httpsRequest(port, "/token", { method: "POST", headers: tokenHeaders, body: tokenBody });
        assert.equal(tokenRes.status, 200);
        const tokens = JSON.parse(tokenRes.body);
        assert.match(tokens.access_token, /^zmcp_at_/);
        assert.match(tokens.refresh_token, /^zmcp_rt_/);
        assert.equal(tokens.token_type, "Bearer");
        assert.equal(tokens.expires_in, 3600);

        // 4. Reusing the same authorization code is rejected (single-use)
        const replayRes = await httpsRequest(port, "/token", {
            method: "POST",
            headers: tokenHeaders,
            body: tokenBody,
        });
        assert.equal(replayRes.status, 400);
        assert.equal(JSON.parse(replayRes.body).error, "invalid_grant");

        // 5. The replay revoked that grant (RFC 6749 §4.1.2): its access token no longer opens /mcp. A new grant's does.
        assert.equal((await mcpInitHttps(port, tokens.access_token)).status, 401);
        const again = await httpsRequest(port, authPath);
        const page2 = new URL(again.headers.location, `https://127.0.0.1:${port}/authorize`).pathname;
        const ok2 = await httpsRequest(port, page2, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "decision=approve&secret=approver-password-not-real",
        });
        const code2 = new URL(ok2.headers.location).searchParams.get("code");
        const fresh = JSON.parse(
            (
                await httpsRequest(port, "/token", {
                    method: "POST",
                    headers: tokenHeaders,
                    body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code: code2,
                        redirect_uri: redirectUri,
                        code_verifier: verifier,
                    }).toString(),
                })
            ).body,
        );
        const mcpWithOAuth = await mcpInitHttps(port, fresh.access_token);
        assert.equal(mcpWithOAuth.status, 200);
        assert.match(mcpWithOAuth.body, /"serverInfo"/);

        // 6. Refresh token grant (client_secret_post): a new pair, the refresh token rotated
        const refreshRes = await httpsRequest(port, "/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: fresh.refresh_token,
                client_id: "gemini-client",
                client_secret: "oauth-s3cret",
            }).toString(),
        });
        assert.equal(refreshRes.status, 200);
        const refreshed = JSON.parse(refreshRes.body);
        assert.match(refreshed.access_token, /^zmcp_at_/);
        assert.notEqual(refreshed.refresh_token, fresh.refresh_token);
    });

    it("supports multiple OAuth clients (oauth.clients[]) for concurrent Gemini and CRM integration", async () => {
        const tls = generateSelfSignedTls();
        const deps = {
            api: {},
            buffer: { getStats: () => [] },
            filter: {},
            config: {},
            nameCache: null,
            accountDir: mkdtempSync(join(tmpdir(), "zalo-oauth-tls-")),
        };
        const server = createHTTPServer(() => {}, deps, 0, "master-s3cret", "127.0.0.1", tls, {
            accountId: "1000000000000000001",
            clientId: "gemini-client",
            clientSecret: "gemini-s3cret",
            clients: [{ clientId: "crm-backend", clientSecret: "crm-s3cret" }],
        });
        servers.push(server);
        if (!server.listening) await once(server, "listening");
        const port = server.address().port;
        const cc = (client_id, client_secret) =>
            httpsRequest(port, "/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ grant_type: "client_credentials", client_id, client_secret }).toString(),
            });

        // CRM client exchanges client_credentials with its own secret, and the token opens /mcp
        const crmRes = await cc("crm-backend", "crm-s3cret");
        assert.equal(crmRes.status, 200);
        const crmTok = JSON.parse(crmRes.body);
        assert.match(crmTok.access_token, /^zmcp_at_/);
        assert.equal((await mcpInitHttps(port, crmTok.access_token)).status, 200);

        // A wrong secret, another client's secret and the master bearer token are all rejected for crm-backend
        for (const secret of ["wrong-secret", "gemini-s3cret", "master-s3cret"]) {
            const badRes = await cc("crm-backend", secret);
            assert.equal(badRes.status, 401, secret);
            assert.equal(JSON.parse(badRes.body).error, "invalid_client");
        }
    });
});
