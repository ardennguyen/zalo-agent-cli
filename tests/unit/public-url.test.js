/**
 * One public address for the whole server, `publicUrl` (src/core/deploy-policy.js resolvePublicUrl): the MCP
 * endpoint, the OAuth issuer, the one-time secure page and the QR login page (src/utils/qr-http-server.js).
 *
 * What would turn each test red:
 * - the resolver: a lower layer winning over a higher one, a deprecated name winning over publicUrl, the deprecation
 *   note missing or printed twice, an invalid value silently falling through to a lower layer;
 * - validation: http accepted for a public host, a query, fragment, credentials or junk accepted, localhost http
 *   refused;
 * - links: any link built from a request's Host header (a forged Host must never reach a link);
 * - OAuth: the metadata ignoring publicUrl, or no longer inferring its issuer when nothing is set;
 * - the QR page: served behind the bearer token, cached, framed, loading anything from elsewhere, answering a wrong
 *   or expired token, or its token reaching the request log.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { resetPublicUrlNote, resolvePublicUrl, validatePublicUrl } from "../../src/core/deploy-policy.js";
import { SecurePage } from "../../src/core/secure-page.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";
import { getDefaultConfig, mergeMCPConfigLayer } from "../../src/mcp/mcp-config.js";
import {
    QR_LINK_TTL_MS,
    QrPage,
    maskQrPath,
    noteQrLayer,
    noteQrOutcome,
    startQrServer,
} from "../../src/utils/qr-http-server.js";
import { resolveLoginPublicUrl, runQrLogin } from "../../src/core/qr-login-flow.js";
import { QR_EVENT } from "../../src/zalo/enums.js";
import { qrPng } from "../../src/zalo/qr-image.js";

const ACCOUNT = "1000000000000000001";
const FORGED = "evil.example.net";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

/** A GET (or POST) with any Host header: fetch refuses to forge one. */
function request(port, path, { host = FORGED, method = "GET", headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host, ...headers } }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
                resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
            );
        });
        req.on("error", reject);
        req.end();
    });
}

const freePort = () =>
    new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });

describe("validatePublicUrl", () => {
    it("takes https with an optional base path, normalized and without a trailing slash", () => {
        assert.equal(validatePublicUrl("https://Zalo.Example.com/").url, "https://zalo.example.com");
        assert.equal(validatePublicUrl("  https://example.com/zalo/ ").url, "https://example.com/zalo");
        assert.equal(validatePublicUrl("https://example.com:443/a/b").url, "https://example.com/a/b");
        assert.equal(validatePublicUrl("https://example.com:8443").url, "https://example.com:8443");
        assert.deepEqual(validatePublicUrl(""), { url: null, error: null }, "unset is not an error");
    });

    it("allows http only on this machine", () => {
        for (const ok of ["http://localhost:3100", "http://127.0.0.1:3100/x", "http://[::1]:3100"]) {
            assert.equal(validatePublicUrl(ok).error, null, ok);
        }
        const r = validatePublicUrl("http://zalo.example.com");
        assert.equal(r.url, null);
        assert.match(r.error, /use https/);
        assert.match(validatePublicUrl("http://203.0.113.7:3100").error, /use https/);
    });

    it("refuses junk, other schemes, credentials, a query, a fragment and odd path segments", () => {
        for (const bad of [
            "not a url",
            "zalo.example.com",
            "javascript:alert(1)",
            "ftp://zalo.example.com",
            "https://user:pw@zalo.example.com",
            "https://zalo.example.com/?t=1",
            "https://zalo.example.com/#x",
            "https://zalo.example.com/a//b",
            "https://zalo.example.com/a/../b",
        ]) {
            const r = validatePublicUrl(bad);
            assert.equal(r.url, null, bad);
            assert.ok(r.error, bad);
        }
    });
});

describe("resolvePublicUrl", () => {
    const notes = [];
    const note = (l) => notes.push(l);
    beforeEach(() => {
        notes.length = 0;
        resetPublicUrlNote();
    });

    it("flag > env per account > env > config per account > config > deprecated names", () => {
        const env = {
            [`ZALO_MCP_PUBLIC_URL_${ACCOUNT}`]: "https://env-account.example.com",
            ZALO_MCP_PUBLIC_URL: "https://env.example.com",
            ZALO_MCP_ISSUER_URL: "https://issuer-env.example.com",
        };
        const config = {
            publicUrl: "https://config.example.com",
            oauth: { issuerUrl: "https://issuer-config.example.com" },
            accounts: { [ACCOUNT]: { publicUrl: "https://config-account.example.com" } },
        };
        const r = (o) => resolvePublicUrl({ accountId: ACCOUNT, note, ...o });
        assert.deepEqual(
            [r({ flag: "https://flag.example.com", env, config }).publicUrl, r({ flag: "x", env, config }).source],
            ["https://flag.example.com", "--public-url"],
        );
        assert.equal(r({ env, config }).source, `ZALO_MCP_PUBLIC_URL_${ACCOUNT}`);
        const envNoScoped = { ...env };
        delete envNoScoped[`ZALO_MCP_PUBLIC_URL_${ACCOUNT}`];
        assert.equal(r({ env: envNoScoped, config }).source, "ZALO_MCP_PUBLIC_URL");
        const envAliasOnly = { ...envNoScoped };
        delete envAliasOnly.ZALO_MCP_PUBLIC_URL;
        assert.equal(r({ env: envAliasOnly, config }).source, `accounts.${ACCOUNT}.publicUrl`);
        assert.equal(r({ env: envAliasOnly, config, accountId: "1000000000000000002" }).source, "publicUrl");
        assert.deepEqual(notes, [], "no note while publicUrl itself is set");
        // Only the deprecated names left: they still work, in their own order, with a note.
        const legacy = r({ issuerFlag: "https://issuer-flag.example.com", env: envAliasOnly, config: { oauth: {} } });
        assert.deepEqual([legacy.publicUrl, legacy.deprecated], ["https://issuer-flag.example.com", true]);
        assert.equal(r({ env: envAliasOnly, config: { oauth: config.oauth } }).source, "ZALO_MCP_ISSUER_URL");
        assert.equal(r({ env: {}, config: { oauth: config.oauth } }).publicUrl, "https://issuer-config.example.com");
        assert.equal(notes.length, 1, "the deprecation note is printed once per process");
        assert.match(notes[0], /deprecated name of publicUrl/);
    });

    it("unset: null, from the default", () => {
        assert.deepEqual(resolvePublicUrl({ env: {}, config: getDefaultConfig(), note }), {
            publicUrl: null,
            source: "default",
            error: null,
            deprecated: false,
        });
    });

    it("an unusable value is an error naming where it came from, never a fall-through to a lower layer", () => {
        const r = resolvePublicUrl({
            env: { ZALO_MCP_PUBLIC_URL: "http://zalo.example.com" },
            config: { publicUrl: "https://config.example.com" },
            note,
        });
        assert.equal(r.publicUrl, null);
        assert.match(r.error, /^ZALO_MCP_PUBLIC_URL "http:\/\/zalo\.example\.com" is http on a host other/);
        assert.ok(resolvePublicUrl({ issuerFlag: "nope", env: {}, note }).error, "a deprecated name is checked too");
    });

    it("login reads only the new names: a proxy built for the OAuth issuer does not route the QR page", () => {
        const config = { oauth: { issuerUrl: "https://issuer.example.com" } };
        assert.equal(
            resolveLoginPublicUrl(undefined, { env: { ZALO_MCP_ISSUER_URL: "https://x.example.com" }, config })
                .publicUrl,
            null,
        );
        assert.equal(
            resolveLoginPublicUrl(undefined, { env: {}, config: { publicUrl: "https://zalo.example.com/" } }).publicUrl,
            "https://zalo.example.com",
        );
        assert.equal(
            resolveLoginPublicUrl("https://flag.example.com", {
                env: {},
                config: { publicUrl: "https://c.example.com" },
            }).publicUrl,
            "https://flag.example.com",
        );
        assert.deepEqual(notes, []);
    });

    it("mcp-config.json: publicUrl is a top-level key, merged per account, and pinPage is gone", () => {
        const defaults = getDefaultConfig();
        assert.equal(defaults.publicUrl, null);
        assert.equal("pinPage" in defaults, false);
        const merged = mergeMCPConfigLayer(defaults, { publicUrl: "https://zalo.example.com" });
        assert.equal(merged.publicUrl, "https://zalo.example.com");
    });
});

describe("the OAuth metadata", () => {
    const servers = [];
    after(async () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));
    const start = async (issuerUrl) => {
        const deps = { buffer: { getStats: () => [] }, config: {} };
        const s = createHTTPServer(() => {}, deps, 0, "test-bearer-token-not-real", "127.0.0.1", null, {
            clientId: "c",
            clientSecret: "test-secret-not-real",
            issuerUrl,
        });
        servers.push(s);
        if (!s.listening) await new Promise((r) => s.once("listening", r));
        return s.address().port;
    };

    it("uses publicUrl when it is set, whatever Host the request names", async () => {
        const port = await start("https://zalo.example.com/base");
        const meta = JSON.parse((await request(port, "/.well-known/oauth-authorization-server")).body);
        assert.equal(meta.issuer, "https://zalo.example.com/base");
        assert.equal(meta.token_endpoint, "https://zalo.example.com/base/token");
        const res = JSON.parse((await request(port, "/.well-known/oauth-protected-resource")).body);
        assert.equal(res.resource, "https://zalo.example.com/base/mcp");
        assert.ok(!JSON.stringify(meta).includes(FORGED));
    });

    it("infers its issuer from the request when nothing is set, as 2.x did", async () => {
        const port = await start(null);
        const meta = JSON.parse(
            (await request(port, "/.well-known/oauth-authorization-server", { host: "mcp.example.com" })).body,
        );
        assert.equal(meta.issuer, "http://mcp.example.com");
    });
});

describe("links on the MCP HTTP server never come from the Host header", () => {
    let server;
    let port;
    let dir;
    const logged = [];
    let restore;
    const securePage = new SecurePage({ accountId: ACCOUNT });
    let clock = 1_000_000;
    const qrPage = new QrPage({ now: () => clock });

    before(async () => {
        mkdirSync(CONFIG_DIR, { recursive: true });
        dir = mkdtempSync(join(CONFIG_DIR, "publicurl-"));
        writeFileSync(join(dir, "qr.png"), qrPng("a-sample-text-for-the-page"));
        const original = console.error;
        console.error = (...a) => logged.push(a.join(" "));
        restore = () => (console.error = original);
        process.env.ZALO_LOG_LEVEL = "debug";
        const deps = { buffer: { getStats: () => [], readCursor: () => 0 }, securePage, qrPage };
        server = createHTTPServer(() => {}, deps, 0, "test-bearer-token-not-real", "127.0.0.1");
        await new Promise((r) => server.once("listening", r));
        port = server.address().port;
    });
    after(async () => {
        restore();
        delete process.env.ZALO_LOG_LEVEL;
        await new Promise((r) => server.close(r));
        rmSync(dir, { recursive: true, force: true });
    });

    const spec = {
        accountId: ACCOUNT,
        action: "conv.unhide",
        target: { threadIds: ["1000000000000000002"] },
        kind: "pin",
        title: "Zalo hidden chats",
        description: "Type the PIN.",
        onSubmit: () => ({ status: "approved" }),
    };

    it("the secure page: publicUrl when set, else the local address; the page itself names no host", async () => {
        const local = `http://127.0.0.1:${port}`;
        securePage.configure({ publicUrl: null, localBaseUrl: local });
        const a = await securePage.open(spec);
        assert.ok(a.url.startsWith(`${local}/zalo/secure/`));
        const page = await request(port, `/zalo/secure/${a.token}`);
        assert.equal(page.status, 200);
        assert.ok(!page.body.includes(FORGED), "a forged Host never reaches the page");
        assert.match(page.body, new RegExp(`action="${a.token}"`));

        securePage.configure({ publicUrl: "https://zalo.example.com/base" });
        const b = await securePage.open(spec);
        assert.match(b.url, /^https:\/\/zalo\.example\.com\/base\/zalo\/secure\/[A-Za-z0-9_-]{22}$/);
    });

    it("the QR page: served by token before the bearer check, with the page's protections", async () => {
        qrPage.configure({
            publicUrl: "https://zalo.example.com",
            localBaseUrl: `http://127.0.0.1:${port}`,
            mounted: true,
        });
        noteQrLayer(1);
        const link = qrPage.open({ qrImagePath: join(dir, "qr.png") });
        assert.match(link.url, /^https:\/\/zalo\.example\.com\/zalo\/qr\/[A-Za-z0-9_-]{22}$/);
        assert.equal(link.imageUrl, `${link.url}/qr.png`);
        const path = `/zalo/qr/${link.token}`;

        const page = await request(port, path);
        assert.equal(page.status, 200, "no bearer token needed");
        assert.match(page.headers["cache-control"], /no-store/);
        assert.equal(page.headers["x-frame-options"], "DENY");
        assert.equal(page.headers["x-content-type-options"], "nosniff");
        assert.equal(page.headers["referrer-policy"], "no-referrer");
        const csp = page.headers["content-security-policy"];
        assert.match(csp, /^default-src 'none';/);
        assert.match(csp, /img-src 'self'/);
        assert.match(csp, /frame-ancestors 'none'/);
        const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
        assert.ok(nonce && page.body.includes(`<script nonce="${nonce}">`), "the page's own script, by nonce");
        assert.doesNotMatch(page.body, /https?:\/\//, "nothing absolute: no host, forged or not");
        // Relative to the page's path, so they work under a proxy's base path too.
        assert.match(page.body, new RegExp(`<img id="qr" src="${link.token}/qr\\.png\\?v=`));
        assert.match(page.body, new RegExp(`fetch\\('${link.token}/status'`));

        const image = await request(port, `${path}/qr.png`);
        assert.equal(image.status, 200);
        assert.equal(image.headers["content-type"], "image/png");
        assert.match(image.headers["cache-control"], /no-store/);
        const status = await request(port, `${path}/status`);
        assert.equal(JSON.parse(status.body).layer, 1);
        assert.match(status.headers["cache-control"], /no-store/);
        assert.equal((await request(port, `${path}/`)).status, 200, "with a trailing slash too");

        assert.equal((await request(port, "/zalo/qr/AAAAAAAAAAAAAAAAAAAAAA")).status, 404, "a wrong token");
        assert.equal((await request(port, "/zalo/qr/AAAAAAAAAAAAAAAAAAAAAA/qr.png")).status, 404);
        assert.equal((await request(port, "/mcp", { method: "POST" })).status, 401, "/mcp still needs the bearer");

        await new Promise((r) => setImmediate(r));
        assert.ok(
            logged.some((l) => l.includes("/zalo/qr/***")),
            "logged, masked",
        );
        assert.ok(
            logged.every((l) => !l.includes(link.token)),
            "the token never reaches the log",
        );
        assert.equal(maskQrPath(`GET ${path}/qr.png?v=1`), "GET /zalo/qr/***/qr.png?v=1");
    });

    it("the QR link dies with its code: after the TTL unless a new code extends it, and when the login ends", async () => {
        const link = qrPage.open({ qrImagePath: join(dir, "qr.png") });
        const path = `/zalo/qr/${link.token}`;
        clock += QR_LINK_TTL_MS - 1000;
        qrPage.extend(QR_LINK_TTL_MS); // a new code appeared
        clock += 2000;
        assert.equal((await request(port, path)).status, 200, "kept alive by the new code");
        clock += QR_LINK_TTL_MS;
        assert.equal((await request(port, path)).status, 404, "expired");
        assert.equal(qrPage.token, null);

        const next = qrPage.open({ qrImagePath: join(dir, "qr.png") });
        assert.notEqual(next.token, link.token, "a new login, a new token");
        assert.equal((await request(port, path)).status, 404, "the old one stays dead");
        await next.finish(); // no page open: the link ends at once
        assert.equal((await request(port, `/zalo/qr/${next.token}`)).status, 404, "ended with the login");
    });
});

describe("a login inside a process whose HTTP server serves the QR page", () => {
    it("prints the server's one-time link and starts no server of its own", async () => {
        const page = new QrPage().configure({ publicUrl: "https://zalo.example.com", mounted: true });
        const lines = [];
        const log = console.log;
        console.log = (l) => lines.push(l);
        try {
            const login = (_proxy, onEvent) => {
                onEvent({ type: QR_EVENT.QR_GENERATED, data: { image: "" }, actions: {} });
                return Promise.resolve({ ownId: ACCOUNT });
            };
            const r = await runQrLogin({ jsonMode: true, login, qrPage: page, interactive: false });
            const event = lines.map((l) => JSON.parse(l)).find((e) => e.event === "qr_page");
            assert.match(event.url, /^https:\/\/zalo\.example\.com\/zalo\/qr\/[A-Za-z0-9_-]{22}$/);
            assert.ok(!lines.some((l) => l.includes("qr_server")), "no server of its own");
            assert.ok(page.token);
            await r.finish("done");
            assert.equal(page.token, null, "the link ends with the login");
        } finally {
            console.log = log;
        }
    });
});

describe("the standalone login page with publicUrl (login --public-url)", () => {
    it("prints <publicUrl>/zalo/qr/<token>, asks nobody for an IP, and serves that path beside /qr", async () => {
        const dir = mkdtempSync(join(CONFIG_DIR, "qrpub-"));
        writeFileSync(join(dir, "qr.png"), qrPng("a-sample-text-for-the-page"));
        const lines = [];
        const asked = [];
        const realFetch = globalThis.fetch;
        const log = console.log;
        globalThis.fetch = async (url, ...rest) => {
            if (String(url).includes("ipify")) asked.push(String(url));
            return realFetch(url, ...rest);
        };
        console.log = (l) => lines.push(l);
        process.env.ZALO_JSON_MODE = "1";
        const qrPage = new QrPage();
        const port = await freePort();
        const server = startQrServer(join(dir, "qr.png"), port, [port], true, {
            publicUrl: "https://zalo.example.com/base",
            qrPage,
        });
        try {
            await new Promise((r) => setTimeout(r, 150));
            const event = JSON.parse(lines.find((l) => l.includes("qr_server")));
            assert.match(event.publicUrl, /^https:\/\/zalo\.example\.com\/base\/zalo\/qr\/[A-Za-z0-9_-]{22}$/);
            assert.equal(event.publicImageUrl, `${event.publicUrl}/qr.png`);
            assert.equal(server.link, event.publicUrl);
            assert.deepEqual(asked, [], "the configured address is the address");
            assert.equal(event.localUrl, `http://localhost:${port}/qr`, "the local page is still there");
            const token = event.publicUrl.split("/").pop();
            assert.equal((await request(port, `/zalo/qr/${token}`)).status, 200);
            assert.equal((await request(port, "/qr")).status, 200);
            assert.equal((await request(port, "/zalo/qr/AAAAAAAAAAAAAAAAAAAAAA")).status, 404);
            noteQrOutcome("done");
            await server.finish();
            assert.equal(qrPage.token, null, "the link ends with the server");
        } finally {
            server.close();
            console.log = log;
            globalThis.fetch = realFetch;
            delete process.env.ZALO_JSON_MODE;
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
