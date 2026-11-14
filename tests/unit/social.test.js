/**
 * `social`: Zalo's Social API, every request checked against Zalo's Social docs ("User Access Token V4",
 * "Thông tin tên, ảnh đại diện", "Cơ chế hết hạn của User Refresh Token", "Mã lỗi", "Demonstrating
 * Proof-of-Possession"). Offline: fetch is replaced and the login's callback is called on 127.0.0.1.
 */
import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, createPublicKey, verify } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
    GRAPH_V2,
    SOCIAL_TOKEN_URL,
    getMe,
    loadSocialCreds,
    refreshSocialToken,
    saveSocialCreds,
    socialTokenFields,
    startSocialLogin,
} from "../../src/core/social/client.js";
import { createDpopKey, dpopProof } from "../../src/core/social/dpop.js";
import { describeMe, loginStatus } from "../../src/commands/social.js";

const OA_DIR = join(SANDBOX_HOME, ".zalo-agent");
const realFetch = globalThis.fetch;

/** Replace fetch for calls that are not to 127.0.0.1 (the login's own callback); record them. */
function mockFetch(reply) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        if (String(url).startsWith("http://127.0.0.1") || String(url).startsWith("http://localhost")) {
            return realFetch(url, init);
        }
        calls.push({ url: String(url), init });
        const r = (await reply(String(url), init, calls.length)) ?? {};
        return new Response(JSON.stringify(r.json ?? { error: 0 }), {
            status: r.status ?? 200,
            headers: { "content-type": "application/json" },
        });
    };
    return calls;
}

/** Check a DPoP proof's signature against the public key in its own header, and return its parts. */
function readProof(jwt) {
    const [h, p, s] = jwt.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url"));
    const payload = JSON.parse(Buffer.from(p, "base64url"));
    const ok = verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        { key: createPublicKey({ key: header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        Buffer.from(s, "base64url"),
    );
    return { header, payload, ok };
}

beforeEach(() => rmSync(OA_DIR, { recursive: true, force: true }));
afterEach(() => (globalThis.fetch = realFetch));

describe("DPoP proof", () => {
    it("is an ES256 dpop+jwt with the public key, htu without the query, htm and iat; it verifies", () => {
        const key = createDpopKey();
        const jwt = dpopProof({ method: "get", url: `${GRAPH_V2}/me?fields=id`, key, now: 1751877103000 });
        const { header, payload, ok } = readProof(jwt);
        assert.equal(ok, true, "the signature verifies with the header's own key");
        assert.equal(header.typ, "dpop+jwt");
        assert.equal(header.alg, "ES256");
        assert.deepEqual(Object.keys(header.jwk).sort(), ["crv", "kty", "x", "y"], "no private part leaks");
        assert.deepEqual(payload, { htu: "https://graph.zalo.me/v2.0/me", htm: "GET", iat: 1751877103 });
    });
});

describe("social login", () => {
    async function login(opts = {}) {
        const port = 40000 + Math.floor(Math.random() * 20000);
        const flow = startSocialLogin({ appId: "1000000000000000001", secretKey: "sek", port, ...opts });
        const auth = new URL(flow.authUrl);
        // Red if the user login goes to the OA's permission page.
        assert.equal(`${auth.origin}${auth.pathname}`, "https://oauth.zaloapp.com/v4/permission");
        const state = auth.searchParams.get("state");
        const challenge = auth.searchParams.get("code_challenge");
        await new Promise((r) => setTimeout(r, 50));
        const cb = await fetch(`http://127.0.0.1:${port}/callback?code=CODE1&state=${state}`);
        assert.equal(cb.status, 200, await cb.text());
        const { saved } = await flow.done;
        return { auth, challenge, saved };
    }

    it("PKCE + state on /v4/permission, then the code exchanged on /v4/access_token with the verifier", async () => {
        const calls = mockFetch(() => ({
            json: { access_token: "AT1", refresh_token: "RT1", expires_in: "3600" },
        }));
        const before = Date.now();
        const { auth, challenge, saved } = await login();
        assert.equal(auth.searchParams.get("app_id"), "1000000000000000001");
        assert.match(auth.searchParams.get("redirect_uri"), /^http:\/\/localhost:\d+\/callback$/);
        const [token] = calls;
        assert.equal(token.url, SOCIAL_TOKEN_URL);
        assert.equal(token.init.headers.secret_key, "sek");
        assert.equal(token.init.headers.DPoP, undefined, "no DPoP unless asked");
        const body = Object.fromEntries(new URLSearchParams(token.init.body));
        assert.equal(body.grant_type, "authorization_code");
        assert.equal(body.code, "CODE1");
        assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), challenge);
        // Access token 1 h; the login ends 30 days on.
        assert.equal(saved.accessToken, "AT1");
        const loginEnd = Date.parse(saved.refreshExpiresAt) - before;
        assert.ok(Math.abs(loginEnd - 30 * 24 * 3600 * 1000) < 60_000, saved.refreshExpiresAt);
        assert.equal(loadSocialCreds().refreshToken, "RT1");
    });

    it("--dpop: the exchange carries a proof for the token URL and the key is kept with the login", async () => {
        const calls = mockFetch(() => ({ json: { access_token: "AT1", refresh_token: "RT1", expires_in: "3600" } }));
        const { saved } = await login({ dpop: true });
        const { payload, ok, header } = readProof(calls[0].init.headers.DPoP);
        assert.equal(ok, true);
        assert.deepEqual([payload.htu, payload.htm], [SOCIAL_TOKEN_URL, "POST"]);
        assert.equal(header.jwk.x, saved.dpopKey.x, "the stored key is the one the token is bound to");
    });
});

describe("social me", () => {
    beforeEach(() =>
        saveSocialCreds({
            appId: "1000000000000000001",
            secretKey: "sek",
            accessToken: "AT1",
            refreshToken: "RT1",
            refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
    );

    it("GET graph.zalo.me/v2.0/me with fields, the access_token header and appsecret_proof", async () => {
        const calls = mockFetch(() => ({
            json: {
                error: 0,
                id: "3000000000000000001",
                name: "Test User",
                picture: { data: { url: "https://x/a.jpg" } },
            },
        }));
        const me = await getMe({ pictureSize: "large" });
        const u = new URL(calls[0].url);
        assert.equal(`${u.origin}${u.pathname}`, "https://graph.zalo.me/v2.0/me");
        assert.equal(u.searchParams.get("fields"), "id,name,picture.type(large)");
        assert.equal(calls[0].init.headers.access_token, "AT1");
        assert.doesNotMatch(calls[0].url, /AT1/, "the token is never in the URL");
        assert.equal(calls[0].init.headers.appsecret_proof, createHmac("sha256", "sek").update("AT1").digest("hex"));
        assert.deepEqual(describeMe(me), [
            "User: Test User (app-scoped ID: 3000000000000000001)",
            "Avatar: https://x/a.jpg",
        ]);
    });

    it("an undocumented field or avatar size is refused before any request", async () => {
        const calls = mockFetch(() => ({}));
        await assert.rejects(() => getMe({ fields: ["id", "phone"] }), /Unknown field phone/);
        await assert.rejects(() => getMe({ pictureSize: "huge" }), /small, normal, large/);
        assert.equal(calls.length, 0);
    });

    it("an invalid session (452) is refreshed once and retried with the new token; the login's end is inherited", async () => {
        const end = loadSocialCreds().refreshExpiresAt;
        const calls = mockFetch((url, init) => {
            if (url === SOCIAL_TOKEN_URL)
                return { json: { access_token: "AT2", refresh_token: "RT2", expires_in: "3600" } };
            return init.headers.access_token === "AT1"
                ? { json: { error: 452, message: "Session key invalid" } }
                : { json: { error: 0, id: "3000000000000000001", name: "Test User" } };
        });
        const me = await getMe();
        assert.equal(me.name, "Test User");
        assert.deepEqual(
            calls.map((c) => c.url.split("?")[0]),
            [`${GRAPH_V2}/me`, SOCIAL_TOKEN_URL, `${GRAPH_V2}/me`],
        );
        const body = Object.fromEntries(new URLSearchParams(calls[1].init.body));
        assert.deepEqual(body, { refresh_token: "RT1", app_id: "1000000000000000001", grant_type: "refresh_token" });
        const after = loadSocialCreds();
        assert.equal(after.refreshToken, "RT2");
        // Red if a refresh gives the login another 30 days: a refreshed token keeps what was left.
        assert.equal(after.refreshExpiresAt, end);
    });

    it("a Social error reads as the docs' meaning", async () => {
        mockFetch(() => ({ json: { error: -501, message: "Personal information is limited" } }));
        await assert.rejects(() => getMe(), /Social API error -501: .*outside Vietnam/);
    });

    it("with DPoP, every call and the refresh carry a proof from the stored key", async () => {
        const key = createDpopKey();
        saveSocialCreds({ dpopKey: key });
        const calls = mockFetch((url, init) =>
            url === SOCIAL_TOKEN_URL
                ? { json: { access_token: "AT2", refresh_token: "RT2", expires_in: "3600" } }
                : init.headers.access_token === "AT1"
                  ? { json: { error: 452 } }
                  : { json: { error: 0, id: "1" } },
        );
        await getMe();
        for (const c of calls) {
            const { ok, header } = readProof(c.init.headers.DPoP);
            assert.equal(ok, true, c.url);
            assert.equal(header.jwk.x, key.x, `${c.url}: same key pair`);
        }
    });
});

describe("refresh and status", () => {
    it("an ended login is not refreshed: no request, a clear way out", async () => {
        saveSocialCreds({
            appId: "1",
            secretKey: "s",
            accessToken: "AT1",
            refreshToken: "RT1",
            refreshExpiresAt: new Date(Date.now() - 1000).toISOString(),
        });
        const calls = mockFetch(() => ({}));
        await assert.rejects(() => refreshSocialToken(), /login expired.*social login/);
        assert.equal(calls.length, 0);
    });

    it("refresh_token_expires_in, when Zalo sends it, sets the login's end", () => {
        const f = socialTokenFields(
            { access_token: "a", refresh_token: "r", expires_in: "3600", refresh_token_expires_in: "7200" },
            { now: 0 },
        );
        assert.equal(f.expiresAt, new Date(3600_000).toISOString());
        assert.equal(f.refreshExpiresAt, new Date(7200_000).toISOString());
    });

    it("status never shows a token or the DPoP key", () => {
        const s = loginStatus(
            {
                appId: "1",
                accessToken: "AT1",
                refreshToken: "RT1",
                dpopKey: { d: "secret" },
                expiresAt: "2000-01-01T00:00:00Z",
            },
            Date.parse("2026-01-01"),
        );
        assert.doesNotMatch(JSON.stringify(s), /AT1|RT1|secret/);
        assert.equal(s.dpop, true);
        assert.equal(s.accessTokenValid, false);
    });
});
