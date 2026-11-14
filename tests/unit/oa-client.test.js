/**
 * src/core/oa-client.js (the barrel over src/core/oa/*.js) — Official Account
 * credential storage and OAuth v4 with PKCE as Zalo's OA docs describe it
 * ("Xác thực và ủy quyền cho ứng dụng"): permission URL, code exchange, the
 * login callback.
 *
 * Note the separate storage root: OA lives in ~/.zalo-agent/ (no `-cli`
 * suffix), deliberately apart from the unofficial-API credentials in
 * ~/.zalo-agent-cli/. Conflating the two is an explicit project hazard, so
 * the split is asserted here rather than assumed.
 *
 * Nothing in this file reaches Zalo: requests go to a mocked globalThis.fetch
 * and the exact request is asserted against the docs. The transport itself
 * (oaRequest, errors, refresh-and-retry, uploads) is tests/unit/oa-transport.test.js.
 */

import { SANDBOX_HOME, SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
    saveOACreds,
    saveOAToken,
    loadOACreds,
    loadOAToken,
    getOAuthUrl,
    sendText,
    exchangeCode,
    refreshAccessToken,
    codeChallengeFor,
    createCodeVerifier,
    startOAuthLogin,
    OAError,
} from "../../src/core/oa-client.js";
import { browserCommand, escapeHtml } from "../../src/core/oa/oauth.js";

const OA_DIR = join(SANDBOX_HOME, ".zalo-agent");
const OA_FILE = join(OA_DIR, "oa-credentials.json");

describe("OA storage is separate from personal-account storage", () => {
    it("personal credentials live in ~/.zalo-agent-cli", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });

    it("OA credentials live in ~/.zalo-agent — a different directory", () => {
        saveOAToken("tok", "default");
        assert.equal(existsSync(OA_FILE), true);
        assert.notEqual(OA_DIR, SANDBOX_CONFIG_DIR);
        assert.equal(existsSync(join(SANDBOX_CONFIG_DIR, "oa-credentials.json")), false);
    });
});

describe("saveOACreds / loadOACreds", () => {
    beforeEach(() => rmSync(OA_DIR, { recursive: true, force: true }));

    it("returns null before anything is saved", () => {
        assert.equal(loadOACreds(), null);
        assert.equal(loadOAToken(), null);
    });

    it("creates the data directory on first save", () => {
        saveOACreds({ accessToken: "a" });
        assert.equal(existsSync(OA_DIR), true);
    });

    it("round-trips a credential and stamps updatedAt", () => {
        saveOACreds({ accessToken: "a", refreshToken: "r", appId: "123" });
        const c = loadOACreds();
        assert.equal(c.accessToken, "a");
        assert.equal(c.refreshToken, "r");
        assert.equal(c.appId, "123");
        assert.match(c.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    it("merges into an existing record instead of replacing it", () => {
        saveOACreds({ accessToken: "a", refreshToken: "r", appId: "123" });
        saveOACreds({ accessToken: "a2" });
        const c = loadOACreds();
        assert.equal(c.accessToken, "a2", "the new value wins");
        assert.equal(c.refreshToken, "r", "untouched fields survive a token refresh");
        assert.equal(c.appId, "123");
    });

    it("keeps multiple OAs in separate namespaces", () => {
        saveOACreds({ accessToken: "shop1-token" }, "shop1");
        saveOACreds({ accessToken: "shop2-token" }, "shop2");
        assert.equal(loadOAToken("shop1"), "shop1-token");
        assert.equal(loadOAToken("shop2"), "shop2-token");
        assert.equal(loadOACreds("default"), null, "an unrelated oaId must not leak another OA's token");
    });

    it("saveOAToken is a thin alias that preserves sibling fields", () => {
        saveOACreds({ appId: "123", refreshToken: "r" }, "shop1");
        saveOAToken("fresh", "shop1");
        const c = loadOACreds("shop1");
        assert.equal(c.accessToken, "fresh");
        assert.equal(c.refreshToken, "r");
    });

    it("loadOAToken returns null when the record exists but has no token", () => {
        saveOACreds({ appId: "123" }, "shop1");
        assert.equal(loadOAToken("shop1"), null);
    });

    it(
        "writes oa-credentials.json with 0600 permissions",
        { skip: process.platform === "win32" ? "POSIX mode bits are not meaningful on Windows" : false },
        () => {
            saveOACreds({ accessToken: "a" });
            assert.equal(statSync(OA_FILE).mode & 0o777, 0o600);
        },
    );

    it("stores the secret key nowhere unless explicitly saved", () => {
        saveOACreds({ accessToken: "a", appId: "123" });
        assert.doesNotMatch(readFileSync(OA_FILE, "utf-8"), /secret/i);
    });
});

describe("getOAuthUrl", () => {
    it("targets the v4 OA permission endpoint", () => {
        assert.match(getOAuthUrl("123"), /^https:\/\/oauth\.zaloapp\.com\/v4\/oa\/permission\?/);
    });

    it("includes app_id and the default redirect_uri", () => {
        const u = new URL(getOAuthUrl("123"));
        assert.equal(u.searchParams.get("app_id"), "123");
        assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:3456/callback");
    });

    it("honors a custom redirect_uri", () => {
        const u = new URL(getOAuthUrl("123", "https://example.com/cb"));
        assert.equal(u.searchParams.get("redirect_uri"), "https://example.com/cb");
    });

    it("percent-encodes the redirect so query params survive", () => {
        const url = getOAuthUrl("123", "https://example.com/cb?x=1&y=2");
        assert.match(url, /redirect_uri=https%3A%2F%2Fexample\.com%2Fcb%3Fx%3D1%26y%3D2/);
        assert.equal(new URL(url).searchParams.get("redirect_uri"), "https://example.com/cb?x=1&y=2");
    });

    it("never embeds a secret key", () => {
        assert.doesNotMatch(getOAuthUrl("123"), /secret/i);
    });
});

describe("unconfigured OA", () => {
    beforeEach(() => rmSync(OA_DIR, { recursive: true, force: true }));

    it("sendText tells the user which command configures it", async () => {
        await assert.rejects(() => sendText("uid", "hi"), /OA not configured\. Run: zalo-agent oa login/);
    });
});

describe("PKCE (OA docs step 1)", () => {
    it("a code verifier is 43 characters of upper case, lower case and digits, new every time", () => {
        const seen = new Set();
        for (let i = 0; i < 50; i++) {
            const v = createCodeVerifier();
            assert.match(v, /^[A-Za-z0-9]{43}$/);
            assert.match(v, /[A-Z]/);
            assert.match(v, /[a-z]/);
            assert.match(v, /\d/);
            seen.add(v);
        }
        assert.equal(seen.size, 50);
    });

    it("code_challenge = Base64(SHA-256(ASCII(verifier))) without padding", () => {
        const v = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfG";
        const want = createHash("sha256")
            .update(Buffer.from(v, "ascii"))
            .digest("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        assert.equal(codeChallengeFor(v), want);
        assert.doesNotMatch(codeChallengeFor(v), /=/);
        assert.equal(codeChallengeFor(v).length, 43);
    });

    it("the permission URL carries code_challenge and state", () => {
        const u = new URL(
            getOAuthUrl("123", "http://localhost:3456/callback", { codeChallenge: "chal", state: "st8" }),
        );
        assert.equal(u.origin + u.pathname, "https://oauth.zaloapp.com/v4/oa/permission");
        assert.deepEqual(Object.fromEntries(u.searchParams), {
            app_id: "123",
            redirect_uri: "http://localhost:3456/callback",
            code_challenge: "chal",
            state: "st8",
        });
    });
});

/** Record every fetch; answer from `reply(url, init)` (undefined: pass through to the real fetch). */
function mockFetch(reply) {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const r = await reply(String(url), init);
        if (r === undefined) return real(url, init);
        return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { calls, restore: () => (globalThis.fetch = real) };
}

describe("token requests (OA docs step 4 and refresh)", () => {
    let m;
    afterEach(() => m?.restore());

    it("exchangeCode posts code, app_id, grant_type and code_verifier, form-urlencoded with secret_key; no redirect_uri", async () => {
        m = mockFetch(() => ({ access_token: "a", refresh_token: "r", expires_in: "90000" }));
        const out = await exchangeCode("the-code", "123", "sek", "ver");
        assert.equal(out.access_token, "a");
        const [c] = m.calls;
        assert.equal(c.url, "https://oauth.zaloapp.com/v4/oa/access_token");
        assert.equal(c.init.method, "POST");
        assert.equal(c.init.headers["Content-Type"], "application/x-www-form-urlencoded");
        assert.equal(c.init.headers.secret_key, "sek");
        assert.deepEqual(Object.fromEntries(new URLSearchParams(String(c.init.body))), {
            code: "the-code",
            app_id: "123",
            grant_type: "authorization_code",
            code_verifier: "ver",
        });
    });

    it("refreshAccessToken posts refresh_token, app_id, grant_type=refresh_token and nothing else", async () => {
        m = mockFetch(() => ({ access_token: "a2", refresh_token: "r2", expires_in: "90000" }));
        await refreshAccessToken("r1", "123", "sek");
        const [c] = m.calls;
        assert.equal(c.url, "https://oauth.zaloapp.com/v4/oa/access_token");
        assert.equal(c.init.headers.secret_key, "sek");
        assert.deepEqual(Object.fromEntries(new URLSearchParams(String(c.init.body))), {
            refresh_token: "r1",
            app_id: "123",
            grant_type: "refresh_token",
        });
    });

    it("an HTML answer from the token endpoint is an http_<status> OAError, not a JSON parse error", async () => {
        const real = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
        m = { restore: () => (globalThis.fetch = real) };
        await assert.rejects(
            () => exchangeCode("c", "1", "s", "v"),
            (e) => e instanceof OAError && e.code === "http_502" && /HTTP 502/.test(e.message),
        );
    });
});

/** A port nothing listens on right now. */
function freePort() {
    return new Promise((res) => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

const tick = () => new Promise((r) => setTimeout(r, 50));

describe("the login callback (oa login / oa init)", () => {
    let m;
    beforeEach(() => rmSync(OA_DIR, { recursive: true, force: true }));
    afterEach(() => m?.restore());

    it("binds 127.0.0.1, sends the verifier behind the challenge, saves the tokens with expiresAt, and closes", async () => {
        const port = await freePort();
        m = mockFetch((url) =>
            url.startsWith("https://oauth.zaloapp.com/")
                ? { access_token: "acc", refresh_token: "ref", expires_in: "90000" }
                : undefined,
        );
        let bound;
        const flow = startOAuthLogin({
            appId: "123",
            secretKey: "sek",
            port,
            oaId: "shop",
            onListening: (i) => (bound = i.bindHost),
        });
        const auth = new URL(flow.authUrl);
        const state = auth.searchParams.get("state");
        const challenge = auth.searchParams.get("code_challenge");
        assert.ok(state && challenge);
        assert.equal(auth.searchParams.get("redirect_uri"), `http://localhost:${port}/callback`);
        await tick();
        assert.equal(bound, "127.0.0.1");
        const page = await fetch(`http://127.0.0.1:${port}/callback?code=c1&oa_id=1000000000000000001&state=${state}`);
        assert.equal(page.status, 200);
        const { tokenData, saved } = await flow.done;
        assert.equal(tokenData.access_token, "acc");
        const tokenCall = m.calls.find((c) => c.url.startsWith("https://oauth.zaloapp.com/"));
        const verifier = new URLSearchParams(String(tokenCall.init.body)).get("code_verifier");
        assert.equal(codeChallengeFor(verifier), challenge, "the verifier sent is the one behind the challenge");
        const c = loadOACreds("shop");
        assert.equal(c.accessToken, "acc");
        assert.equal(c.refreshToken, "ref");
        assert.equal(c.oaId, "1000000000000000001");
        assert.ok(Math.abs(Date.parse(c.expiresAt) - Date.now() - 90000 * 1000) < 60_000);
        assert.equal(saved.expiresAt, c.expiresAt);
        await assert.rejects(() => fetch(`http://127.0.0.1:${port}/callback`), "the server is closed after success");
    });

    it("refuses a callback whose state is not this login's, before any token request", async () => {
        const port = await freePort();
        m = mockFetch((url) => (url.startsWith("https://oauth.zaloapp.com/") ? { access_token: "x" } : undefined));
        const flow = startOAuthLogin({ appId: "123", secretKey: "sek", port });
        const rejected = assert.rejects(flow.done, /state mismatch/);
        await tick();
        const page = await fetch(`http://127.0.0.1:${port}/callback?code=c1&state=someone-elses`);
        assert.equal(page.status, 400);
        await rejected;
        assert.equal(m.calls.filter((c) => c.url.startsWith("https://oauth.zaloapp.com/")).length, 0);
    });

    it("HTML-escapes the error text it reflects on the callback page", async () => {
        const port = await freePort();
        m = mockFetch(() => undefined);
        const flow = startOAuthLogin({ appId: "123", secretKey: "sek", port });
        const rejected = assert.rejects(flow.done);
        await tick();
        const state = new URL(flow.authUrl).searchParams.get("state");
        const evil = encodeURIComponent('<script>alert("x")</script>');
        const page = await fetch(`http://127.0.0.1:${port}/callback?state=${state}&error_description=${evil}`);
        const html = await page.text();
        assert.doesNotMatch(html, /<script>/);
        assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
        await rejected;
    });

    it("gives up after its timeout", async () => {
        const port = await freePort();
        const flow = startOAuthLogin({ appId: "123", secretKey: "sek", port, timeoutMs: 30 });
        await assert.rejects(flow.done, /timed out/);
    });

    it("escapeHtml covers the five HTML metacharacters", () => {
        assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    });
});

describe("oa login exits once it is done", () => {
    it("the CLI's login leaves no timer behind: a finished flow lets the process exit at once", async () => {
        // A child process runs one login against a mocked token endpoint; before the fix it hung 2 minutes and exited 1.
        const { spawnSync } = await import("node:child_process");
        const port = await freePort();
        const script = `
            globalThis.fetch = ((real) => async (url, init) =>
                String(url).startsWith("https://oauth.zaloapp.com/")
                    ? new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: "90000" }), {
                          status: 200, headers: { "content-type": "application/json" } })
                    : real(url, init))(globalThis.fetch);
            const { startOAuthLogin } = await import(${JSON.stringify(new URL("../../src/core/oa/oauth.js", import.meta.url).href)});
            const flow = startOAuthLogin({ appId: "1", secretKey: "s", port: ${port} });
            const state = new URL(flow.authUrl).searchParams.get("state");
            setTimeout(() => fetch("http://127.0.0.1:${port}/callback?code=c&state=" + state), 50);
            await flow.done;
            console.log("done");
        `;
        const started = Date.now();
        const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
            env: { ...process.env },
            encoding: "utf8",
            timeout: 20_000,
        });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /done/);
        assert.ok(Date.now() - started < 15_000, "the process exited without waiting out the 2-minute timer");
    });
});

describe("opening the browser", () => {
    it("Windows goes through url.dll without a shell, so the URL is neither a window title nor split at &", () => {
        const url = "https://oauth.zaloapp.com/v4/oa/permission?app_id=1&state=x";
        assert.deepEqual(browserCommand(url, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
        assert.deepEqual(browserCommand(url, "darwin"), ["open", [url]]);
        assert.deepEqual(browserCommand(url, "linux"), ["xdg-open", [url]]);
    });
});
