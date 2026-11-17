/**
 * Per-account OAuth settings, applied live (src/mcp/oauth-settings.js, src/core/access-api.js, src/mcp/mcp-oauth.js):
 * the console sets an account's mode (off, automatic, specific) and makes confidential clients through the access API,
 * and the running server follows at the next request, with no restart.
 *
 * What would turn each test red:
 * - the default mode not following the configuration (dynamic registration, configured clients) when nothing is saved;
 * - a mode saved without an approver password or a publicUrl, or a mode that is not one of the three;
 * - /register or discovery answering the same before and after a switch (only a restart applying it);
 * - a client made here not authenticating at /token with its secret (post and basic), or its secret being stored or
 *   listed after the one answer that carries it;
 * - a removed client keeping its grants, a grant admitted while the mode is off, or turning OAuth off opening the server.
 *
 * Every id is made up: the accounts are fake ids of the sandbox.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { createAdminApi, resolveAdminCredentials } from "../../src/core/admin-api.js";
import { createAccessApi } from "../../src/core/access-api.js";
import { setApproverPassword } from "../../src/core/approval.js";
import { SecurePage } from "../../src/core/secure-page.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { OAUTH_STATE_FILE } from "../../src/mcp/mcp-oauth.js";
import { OAUTH_SETTINGS_FILE, createOAuthSettingsReader, writeOAuthSettings } from "../../src/mcp/oauth-settings.js";

const ADMIN = "admin-token-for-oauth-settings-tests";
const AGENT = "agent-token-for-oauth-settings-tests";
const PUBLIC = "https://zalo.example.com";
const CB = "https://app.example.com/oauth/callback";
const PASSWORD = "approver-password-for-tests";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const servers = [];
after(async () => Promise.all(servers.map((s) => new Promise((r) => s.close(() => r())))));

let n = 0;
/** A fresh account folder. */
function account({ approver = true } = {}) {
    const id = String(1000000000000000700n + BigInt(n++));
    mkdirSync(getAccountDir(id), { recursive: true });
    if (approver) setApproverPassword(getAccountDir(id), PASSWORD);
    return id;
}

const hashes = resolveAdminCredentials({ env: { ZALO_MCP_ADMIN_TOKEN: ADMIN } }).hashes;

/**
 * A real MCP HTTP server for one account, with the admin API on it.
 * @param {string} ownId
 * @param {{publicUrl?: string|null, authToken?: string|null, config?: object}} [opts] - `config` is the MCP config
 *   both the server and its admin API read, as `mcp start` passes it
 */
async function accountServer(ownId, { publicUrl = PUBLIC, authToken = AGENT, config = {} } = {}) {
    const admin = createAdminApi({ ownId, config, hashes, publicUrl, log: () => {} });
    const securePage = new SecurePage({ accountId: ownId });
    const deps = {
        admin,
        accountDir: getAccountDir(ownId),
        buffer: { getStats: () => [], readCursor: () => 0 },
        securePage,
        oauthApprover: () => ({
            kind: "password",
            approverSecret: true,
            check: async (typed) =>
                typed === PASSWORD ? { status: "approved", message: "ok" } : { status: "retry", message: "no" },
        }),
    };
    const server = createHTTPServer(() => {}, deps, 0, authToken, "127.0.0.1", null, {
        accountId: ownId,
        issuerUrl: publicUrl,
        clients: config.oauth?.clients ?? [],
    });
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    securePage.configure({ localBaseUrl: base });
    const call = async (path, { method = "GET", body, form, token = ADMIN, headers = {} } = {}) => {
        const res = await fetch(`${base}${path}`, {
            method,
            redirect: "manual",
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
                ...headers,
            },
            body: form ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch {
            /* not JSON */
        }
        return { status: res.status, body: json, text, headers: res.headers };
    };
    return { base, call };
}

/** An access API the way the fleet controller builds it (no daemon to say the publicUrl). */
async function controllerAccess(config, accountEnv = () => ({})) {
    const access = createAccessApi({ config, accountEnv, log: () => {} });
    return async (ownId, path, { method = "GET", body } = {}) => {
        let out = null;
        const res = {
            status(code) {
                out = { status: code };
                return this;
            },
            set() {
                return this;
            },
            json(b) {
                out.body = b;
                return this;
            },
        };
        await access.handle({ method, body: body ?? {} }, res, {
            who: "token",
            ip: "127.0.0.1",
            path: `/access/${ownId}${path}`,
        });
        return out;
    };
}

const settingsPath = (id) => `/zalo/admin/access/${id}/oauth/settings`;
const clientsPath = (id) => `/zalo/admin/access/${id}/oauth/clients`;
const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
/** Whether a bearer opens the server (/status sits behind the bearer check; with no health it answers 503). */
const opens = async (call, token) => (await call("/status", { token })).status !== 401;

describe("OAuth settings: the default follows the configuration", () => {
    it("off with nothing configured, specific with a configured client, automatic with dynamic registration", async () => {
        const id = account();
        const plain = await controllerAccess({ publicUrl: PUBLIC });
        const view = await plain(id, "/oauth/settings");
        assert.equal(view.status, 200);
        assert.deepEqual(view.body, { mode: "off", source: "config", approverSet: true, publicUrl: PUBLIC });

        const withClient = await controllerAccess({
            publicUrl: PUBLIC,
            oauth: { clients: [{ clientId: "cfg-app", clientSecret: "cfg-secret-not-real" }] },
        });
        assert.equal((await withClient(id, "/oauth/settings")).body.mode, "specific");

        const dyn = await controllerAccess({ publicUrl: PUBLIC, oauth: { allowDynamicRegistration: true } });
        assert.equal((await dyn(id, "/oauth/settings")).body.mode, "automatic");
        // The account's own environment counts, as `mcp start` reads it.
        const envDyn = await controllerAccess({ publicUrl: PUBLIC }, (o) =>
            o === id ? { ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION: "on" } : {},
        );
        assert.equal((await envDyn(id, "/oauth/settings")).body.mode, "automatic");

        // A saved choice wins over the configuration, and says so.
        assert.equal((await dyn(id, "/oauth/settings", { method: "PUT", body: { mode: "specific" } })).status, 200);
        assert.deepEqual((await dyn(id, "/oauth/settings")).body, {
            mode: "specific",
            source: "account",
            approverSet: true,
            publicUrl: PUBLIC,
        });
        const file = join(getAccountDir(id), OAUTH_SETTINGS_FILE);
        if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    });

    it("the reader picks a change up without being made again", () => {
        const id = account();
        const read = createOAuthSettingsReader(getAccountDir(id));
        assert.equal(read(), null);
        writeOAuthSettings(getAccountDir(id), "automatic");
        assert.equal(read().mode, "automatic");
        writeOAuthSettings(getAccountDir(id), "off");
        assert.equal(read().mode, "off");
    });
});

describe("OAuth settings: PUT refuses what cannot work", () => {
    it("a bad mode, no approver password, no publicUrl; off is always allowed", async () => {
        const noApprover = account({ approver: false });
        const { call } = await accountServer(noApprover);
        for (const mode of ["on", "", null, "AUTOMATIC"]) {
            const r = await call(settingsPath(noApprover), { method: "PUT", body: { mode } });
            assert.equal(r.status, 400, String(mode));
            assert.equal(r.body.code, "INVALID_OAUTH_MODE");
        }
        for (const mode of ["automatic", "specific"]) {
            const r = await call(settingsPath(noApprover), { method: "PUT", body: { mode } });
            assert.equal(r.status, 409);
            assert.equal(r.body.code, "APPROVER_REQUIRED");
        }
        assert.equal((await call(settingsPath(noApprover))).body.approverSet, false);
        assert.equal(existsSync(join(getAccountDir(noApprover), OAUTH_SETTINGS_FILE)), false, "nothing saved");

        const noUrl = account();
        const plain = await controllerAccess({});
        const r = await plain(noUrl, "/oauth/settings", { method: "PUT", body: { mode: "automatic" } });
        assert.equal(r.status, 409);
        assert.equal(r.body.code, "PUBLIC_URL_REQUIRED");
        assert.equal((await plain(noUrl, "/oauth/settings")).body.publicUrl, null);
        const off = await plain(noUrl, "/oauth/settings", { method: "PUT", body: { mode: "off" } });
        assert.equal(off.status, 200);
        assert.deepEqual(off.body, { mode: "off", source: "account", approverSet: true, publicUrl: null });
    });
});

describe("OAuth settings: switched live, no restart", () => {
    it("off -> automatic -> specific changes /register and discovery at the next request", async () => {
        const id = account();
        const { call } = await accountServer(id);
        const register = () =>
            call("/register", { method: "POST", token: null, body: { redirect_uris: [CB], client_name: "Some app" } });
        const meta = () => call("/.well-known/oauth-authorization-server", { token: null });
        const resourceMeta = () => call("/.well-known/oauth-protected-resource/mcp", { token: null });

        // Started with nothing configured: a bearer-only server, though its routes are mounted.
        assert.equal((await register()).status, 404);
        assert.equal((await meta()).status, 404);
        assert.equal((await resourceMeta()).status, 404);
        const unauth = await call("/status", { token: null });
        assert.equal(unauth.status, 401);
        assert.doesNotMatch(String(unauth.headers.get("www-authenticate")), /resource_metadata/);
        assert.ok(await opens(call, AGENT), "the bearer works while off");

        assert.equal((await call(settingsPath(id), { method: "PUT", body: { mode: "automatic" } })).status, 200);
        const m1 = await meta();
        assert.equal(m1.status, 200);
        assert.equal(m1.body.issuer, PUBLIC);
        assert.equal(m1.body.registration_endpoint, `${PUBLIC}/register`);
        assert.equal((await resourceMeta()).status, 200);
        const reg = await register();
        assert.equal(reg.status, 201, reg.text);
        assert.match(reg.body.client_id, /^dyn_/);
        // Every authorization still goes through the approve page.
        const auth = await call(
            `/authorize?${new URLSearchParams({
                response_type: "code",
                client_id: reg.body.client_id,
                redirect_uri: CB,
                code_challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"),
                code_challenge_method: "S256",
            })}`,
            { token: null },
        );
        assert.equal(auth.status, 302);
        assert.match(auth.headers.get("location"), /^zalo\/secure\//);
        assert.match(
            String((await call("/status", { token: null })).headers.get("www-authenticate")),
            /resource_metadata=/,
        );

        assert.equal((await call(settingsPath(id), { method: "PUT", body: { mode: "specific" } })).status, 200);
        assert.equal((await register()).status, 404);
        const m2 = await meta();
        assert.equal(m2.status, 200);
        assert.equal(m2.body.registration_endpoint, undefined);
        // The registered client is not known in specific mode.
        const again = await call(
            `/authorize?response_type=code&client_id=${reg.body.client_id}&redirect_uri=${encodeURIComponent(CB)}`,
            { token: null },
        );
        assert.equal(again.status, 400);
        assert.equal(again.body.error, "invalid_client");

        assert.equal((await call(settingsPath(id), { method: "PUT", body: { mode: "off" } })).status, 200);
        assert.equal((await meta()).status, 404);
        assert.equal((await call("/token", { method: "POST", token: null, form: { a: "b" } })).status, 404);
    });

    it("a server started with no bearer at all stays closed once a mode is saved, even off", async () => {
        const id = account();
        const { call } = await accountServer(id, { authToken: null });
        assert.notEqual((await call("/status", { token: null })).status, 401, "open, as configured");
        assert.equal((await call(settingsPath(id), { method: "PUT", body: { mode: "off" } })).status, 200);
        assert.equal((await call("/status", { token: null })).status, 401);
    });
});

describe("OAuth clients made through the access API", () => {
    it("made once with a secret that works at /token, never stored or shown again", async () => {
        const id = account();
        const { call } = await accountServer(id);
        assert.equal((await call(settingsPath(id), { method: "PUT", body: { mode: "specific" } })).status, 200);

        const made = await call(clientsPath(id), {
            method: "POST",
            body: { name: "ChatGPT", redirectUris: [CB] },
        });
        assert.equal(made.status, 201, made.text);
        assert.deepEqual(Object.keys(made.body).sort(), [
            "clientId",
            "clientSecret",
            "createdAt",
            "name",
            "redirectUris",
        ]);
        assert.match(made.body.clientId, /^[A-Za-z0-9._-]{3,64}$/);
        assert.deepEqual(made.body.redirectUris, [CB]);
        const { clientId, clientSecret } = made.body;

        // Not in the store, not in the list.
        const state = readFileSync(join(getAccountDir(id), OAUTH_STATE_FILE), "utf8");
        assert.equal(state.includes(clientSecret), false);
        const list = await call(clientsPath(id));
        const mine = list.body.clients.find((c) => c.clientId === clientId);
        assert.equal(mine.source, "account");
        assert.equal(mine.confidential, true);
        assert.equal(mine.name, "ChatGPT");
        assert.equal(JSON.stringify(list.body).includes(clientSecret), false);
        assert.equal(JSON.stringify((await call(`/zalo/admin/access/${id}`)).body).includes(clientSecret), false);

        // client_secret_post and client_secret_basic; a wrong secret is refused.
        const post = await call("/token", {
            method: "POST",
            token: null,
            form: { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret },
        });
        assert.equal(post.status, 200, post.text);
        assert.ok(await opens(call, post.body.access_token));
        const viaBasic = await call("/token", {
            method: "POST",
            token: null,
            headers: { Authorization: basic(clientId, clientSecret) },
            form: { grant_type: "client_credentials" },
        });
        assert.equal(viaBasic.status, 200, viaBasic.text);
        const wrong = await call("/token", {
            method: "POST",
            token: null,
            form: { grant_type: "client_credentials", client_id: clientId, client_secret: `${clientSecret}x` },
        });
        assert.equal(wrong.status, 401);

        // While off its grant is refused, not deleted; back on, it works again.
        await call(settingsPath(id), { method: "PUT", body: { mode: "off" } });
        assert.equal(await opens(call, post.body.access_token), false);
        assert.equal((await call(`/zalo/admin/access/${id}/oauth/grants`)).body.grants.length, 2);
        await call(settingsPath(id), { method: "PUT", body: { mode: "automatic" } });
        assert.ok(await opens(call, post.body.access_token));

        // A taken id, a bad id, bad URIs and a bad name are refused.
        const dup = await call(clientsPath(id), {
            method: "POST",
            body: { name: "Again", clientId, redirectUris: [CB] },
        });
        assert.equal(dup.status, 409);
        assert.equal(dup.body.code, "CLIENT_EXISTS");
        const chosen = await call(clientsPath(id), {
            method: "POST",
            body: { name: "Claude", clientId: "claude-team.1", redirectUris: [CB] },
        });
        assert.equal(chosen.status, 201);
        assert.equal(chosen.body.clientId, "claude-team.1");
        for (const [body, code] of [
            [{ name: "x", clientId: "ab", redirectUris: [CB] }, "INVALID_CLIENT_ID"],
            [{ name: "x", clientId: "has space", redirectUris: [CB] }, "INVALID_CLIENT_ID"],
            [{ name: "x", redirectUris: [] }, "INVALID_REDIRECT_URIS"],
            [{ name: "x", redirectUris: ["http://127.0.0.1/cb"] }, "INVALID_REDIRECT_URIS"],
            [{ name: "x", redirectUris: ["javascript:alert(1)"] }, "INVALID_REDIRECT_URIS"],
            [{ name: "x", redirectUris: Array(11).fill(CB) }, "INVALID_REDIRECT_URIS"],
            [{ name: "", redirectUris: [CB] }, "INVALID_NAME"],
            [{ name: "n".repeat(61), redirectUris: [CB] }, "INVALID_NAME"],
        ]) {
            const r = await call(clientsPath(id), { method: "POST", body });
            assert.equal(r.status, 400, JSON.stringify(body));
            assert.equal(r.body.code, code);
        }
    });

    it("an id taken by a configured client is refused; DELETE removes a made client and its grants", async () => {
        const id = account();
        const { call } = await accountServer(id, {
            config: { oauth: { clients: [{ clientId: "cfg-app", clientSecret: "cfg-secret-not-real" }] } },
        });
        assert.equal((await call(settingsPath(id))).body.mode, "specific", "the configured client implies specific");
        const taken = await call(clientsPath(id), {
            method: "POST",
            body: { name: "Clash", clientId: "cfg-app", redirectUris: [CB] },
        });
        assert.equal(taken.status, 409);
        assert.equal(taken.body.code, "CLIENT_EXISTS");

        const made = await call(clientsPath(id), { method: "POST", body: { name: "Gone soon", redirectUris: [CB] } });
        const { clientId, clientSecret } = made.body;
        const t = await call("/token", {
            method: "POST",
            token: null,
            form: { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret },
        });
        assert.equal(t.status, 200, t.text);
        assert.ok(await opens(call, t.body.access_token));
        const rm = await call(`${clientsPath(id)}/${clientId}`, { method: "DELETE" });
        assert.deepEqual(rm.body, { clientId, removed: true, grantsRevoked: 1 });
        assert.equal(await opens(call, t.body.access_token), false, "its token stops at once");
        assert.equal(
            (
                await call("/token", {
                    method: "POST",
                    token: null,
                    form: { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret },
                })
            ).status,
            401,
        );
        assert.equal(
            (await call(clientsPath(id))).body.clients.some((c) => c.clientId === clientId),
            false,
        );

        const cfgAccess = await controllerAccess({
            publicUrl: PUBLIC,
            oauth: { clients: [{ clientId: "cfg-app", clientSecret: "cfg-secret-not-real" }] },
        });
        const other = account();
        const clash = await cfgAccess(other, "/oauth/clients", {
            method: "POST",
            body: { name: "Clash", clientId: "cfg-app", redirectUris: [CB] },
        });
        assert.equal(clash.status, 409);
        assert.equal(clash.body.code, "CLIENT_EXISTS");
        const listed = await cfgAccess(other, "/oauth/clients");
        assert.equal(listed.body.clients.find((c) => c.clientId === "cfg-app").source, "config");
    });
});
