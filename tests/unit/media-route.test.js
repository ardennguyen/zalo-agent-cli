/**
 * `/zalo/media/<token>` on a real HTTP server (port 0): the MCP server's own (createHTTPServer, with an --auth token)
 * and the stdio listener. Bearer vs capability, the capability client window behind a trusted proxy, 401/403/404/410/
 * 416/206/429, the headers, HEAD, a download type, the access log without the token, revocation (hide, logout, expiry)
 * and a Host header that changes nothing.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { scopeOfDir } from "../../src/core/keystore/keyring.js";
import { writeSealedMedia } from "../../src/core/keystore/media-seal.js";
import { MediaLinks, linkForCachedMessage, setMediaLinks } from "../../src/core/media-deliver.js";
import { mediaLinkViaDaemon, startDaemonChannel } from "../../src/core/daemon-channel.js";
import { initDb, insertMessage } from "../../src/core/db.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import {
    clientIpOf,
    closeMediaListener,
    ensureMediaServed,
    isLoopbackIp,
    parseRange,
} from "../../src/core/media-route.js";
import { HiddenChats } from "../../src/core/hidden-chats.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

const ID = "100000000000000733";
const AUTH = "test-bearer-token-media";
const PLAIN = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7) % 251));

function sealed(name, plain = PLAIN, msgId = "m1") {
    const dir = getAccountDir(ID);
    const file = join(dir, "media", "t1", name);
    mkdirSync(dirname(file), { recursive: true });
    writeSealedMedia(file, scopeOfDir(dir), { msgId }, plain);
    return { file, scope: scopeOfDir(dir) };
}

/** One request; resolves with status, headers and the body. */
function request(port, path, { method = "GET", headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        r.on("error", reject);
        r.end();
    });
}

function startServer(links, { trustedProxies = [] } = {}) {
    const deps = {
        buffer: { getStats: () => [] },
        mediaLinks: links,
        trustedProxies,
    };
    const server = createHTTPServer(() => {}, deps, 0, AUTH, "127.0.0.1");
    return new Promise((resolve) => server.once("listening", () => resolve(server)));
}

const pathOf = (url) => new URL(url).pathname;

describe("helpers", () => {
    it("parseRange: one range, a suffix, open-ended, unsatisfiable, several (whole file)", () => {
        assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
        assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
        assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
        assert.deepEqual(parseRange("bytes=95-500", 100), { start: 95, end: 99 });
        assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
        assert.equal(parseRange("bytes=5-1", 100), "unsatisfiable");
        assert.equal(parseRange("bytes=0-1,5-9", 100), null);
        assert.equal(parseRange(undefined, 100), null);
    });

    it("clientIpOf believes X-Forwarded-For only from a trusted proxy", () => {
        const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: { "x-forwarded-for": xff } });
        assert.equal(clientIpOf(req("::ffff:127.0.0.1", "203.0.113.9")), "127.0.0.1", "untrusted: the peer");
        assert.equal(clientIpOf(req("127.0.0.1", "203.0.113.9"), ["127.0.0.1"]), "203.0.113.9");
        assert.equal(
            clientIpOf(req("127.0.0.1", "198.51.100.1, 203.0.113.9, 10.0.0.2"), ["loopback", "10.0.0.2"]),
            "203.0.113.9",
            "the right-most hop that is not a trusted proxy",
        );
        assert.equal(clientIpOf(req("192.0.2.5", "203.0.113.9"), ["127.0.0.1"]), "192.0.2.5");
        assert.equal(isLoopbackIp("::1"), true);
        assert.equal(isLoopbackIp("::ffff:127.0.0.5"), true);
        assert.equal(isLoopbackIp("10.0.0.1"), false);
    });
});

describe("bearer links on the MCP HTTP server", () => {
    let server;
    let port;
    let links;
    const logs = [];
    const origError = console.error;
    before(async () => {
        console.error = (...a) => logs.push(a.join(" "));
        links = new MediaLinks().configure({
            publicUrl: "https://zalo.example.com",
            linkAuth: "bearer",
            bearerAvailable: true,
            log: (l) => logs.push(l),
        });
        server = await startServer(links);
        port = server.address().port;
        links.configure({ localBaseUrl: `http://127.0.0.1:${port}` });
    });
    after(() => {
        console.error = origError;
        server.close();
    });
    const auth = { authorization: `Bearer ${AUTH}` };

    it("needs the server's own bearer token as well as the link", async () => {
        const { file, scope } = sealed("a.jpg");
        const { url } = links.issue({
            accountId: ID,
            msgId: "m1",
            threadId: "t1",
            file,
            scope,
            mime: "image/jpeg",
            name: "a.jpg",
        });
        assert.equal(url.startsWith("https://zalo.example.com/zalo/media/"), true, "built on publicUrl");
        assert.equal((await request(port, pathOf(url))).status, 401);
        assert.equal((await request(port, pathOf(url), { headers: { authorization: "Bearer wrong" } })).status, 401);
        const ok = await request(port, pathOf(url), { headers: auth });
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.body, PLAIN, "the plaintext, decrypted on the way out");
        assert.equal(ok.headers["content-type"], "image/jpeg");
        assert.equal(ok.headers["content-length"], String(PLAIN.length));
        assert.equal(ok.headers["cache-control"], "no-store");
        assert.equal(ok.headers["x-content-type-options"], "nosniff");
        assert.equal(ok.headers["referrer-policy"], "no-referrer");
        assert.equal(ok.headers["content-security-policy"], "default-src 'none'; sandbox");
        assert.equal(ok.headers["accept-ranges"], "bytes");
        assert.match(ok.headers["content-disposition"], /^inline; /);
    });

    it("says 401 before it says anything about an unknown token", async () => {
        assert.equal((await request(port, "/zalo/media/AAAAAAAAAAAAAAAAAAAAAA")).status, 401);
        assert.equal((await request(port, "/zalo/media/AAAAAAAAAAAAAAAAAAAAAA", { headers: auth })).status, 404);
    });

    it("serves one range as 206, several as 200, and 416 past the end", async () => {
        const { file, scope } = sealed("v.mp4");
        const { url } = links.issue({ accountId: ID, msgId: "m1", file, scope, mime: "video/mp4", name: "v.mp4" });
        const part = await request(port, pathOf(url), { headers: { ...auth, range: "bytes=65530-65545" } });
        assert.equal(part.status, 206);
        assert.equal(part.headers["content-range"], `bytes 65530-65545/${PLAIN.length}`);
        assert.deepEqual(part.body, PLAIN.subarray(65530, 65546), "a range across a chunk edge");
        const tail = await request(port, pathOf(url), { headers: { ...auth, range: "bytes=-5" } });
        assert.deepEqual(tail.body, PLAIN.subarray(PLAIN.length - 5));
        const many = await request(port, pathOf(url), { headers: { ...auth, range: "bytes=0-1,5-6" } });
        assert.equal(many.status, 200);
        assert.equal(many.body.length, PLAIN.length);
        const past = await request(port, pathOf(url), { headers: { ...auth, range: `bytes=${PLAIN.length}-` } });
        assert.equal(past.status, 416);
        assert.equal(past.headers["content-range"], `bytes */${PLAIN.length}`);
    });

    it("HEAD answers headers only; a type off the allow-list is a download", async () => {
        const { file, scope } = sealed("doc.pdf", Buffer.from("%PDF-1.4 fake"));
        const { url } = links.issue({
            accountId: ID,
            msgId: "m1",
            file,
            scope,
            mime: "text/html",
            name: "báo cáo.html",
        });
        const head = await request(port, pathOf(url), { method: "HEAD", headers: auth });
        assert.equal(head.status, 200);
        assert.equal(head.body.length, 0);
        assert.equal(head.headers["content-type"], "application/octet-stream", "never served as HTML");
        assert.match(
            head.headers["content-disposition"],
            /^attachment; filename="b_o c_o\.html"; filename\*=UTF-8''b%C3%A1o%20c%C3%A1o\.html$/,
        );
        const post = await request(port, pathOf(url), { method: "POST", headers: auth });
        assert.equal(post.status, 405);
    });

    it("410 once a link is revoked (its chat hidden, the session ended) or expired", async () => {
        const { file, scope } = sealed("r.jpg");
        const spec = { accountId: ID, msgId: "m1", file, scope, mime: "image/jpeg", name: "r.jpg" };
        const a = links.issue({ ...spec, threadId: "t-hidden" });
        const b = links.issue({ ...spec, threadId: "t-other" });
        // The same hook as mcp start: the hidden set changed, links into a now-hidden chat end.
        const hidden = new HiddenChats({ accountId: ID });
        hidden.onChange((set) =>
            links.revokeWhere((l) => l.threadId !== null && set.isHidden(l.threadId), "its chat was hidden"),
        );
        hidden.setFromServer({ threads: [{ thread_id: "t-hidden", is_group: 0 }] });
        const gone = await request(port, pathOf(a.url), { headers: auth });
        assert.equal(gone.status, 410);
        assert.match(gone.body.toString(), /hidden/);
        assert.equal((await request(port, pathOf(b.url), { headers: auth })).status, 200);
        links.revokeAll("the session ended");
        assert.equal((await request(port, pathOf(b.url), { headers: auth })).status, 410);
        const c = links.issue({ ...spec, ttlMs: 1 });
        await new Promise((r) => setTimeout(r, 5));
        assert.equal((await request(port, pathOf(c.url), { headers: auth })).status, 410);
    });

    it("a Host header changes nothing: the link stays on publicUrl and is served the same", async () => {
        const { file, scope } = sealed("h.jpg");
        const { url } = links.issue({ accountId: ID, msgId: "m1", file, scope, mime: "image/jpeg", name: "h.jpg" });
        const res = await request(port, pathOf(url), { headers: { ...auth, host: "evil.example" } });
        assert.equal(res.status, 200);
        assert.equal(
            links
                .issue({ accountId: ID, msgId: "m1", file, scope, mime: "image/jpeg", name: "h.jpg" })
                .url.startsWith("https://zalo.example.com/"),
            true,
        );
    });

    it("logs every request with the token masked, never the token or the Authorization", async () => {
        const { file, scope } = sealed("l.jpg");
        const { url, token } = links.issue({
            accountId: ID,
            msgId: "m1",
            file,
            scope,
            mime: "image/jpeg",
            name: "l.jpg",
        });
        await request(port, `${pathOf(url)}?secret=1`, { headers: { ...auth, referer: `https://x.example/${token}` } });
        const lines = logs.filter((l) => l.includes("/zalo/media/"));
        assert.ok(
            lines.some((l) => /\[media\] GET \/zalo\/media\/\*\*\* -> 200 \d+B \d+ms/.test(l)),
            lines.join("\n"),
        );
        for (const l of logs) {
            assert.equal(l.includes(token), false, `a log line holds the token: ${l}`);
            assert.equal(l.includes(AUTH), false, "a log line holds the bearer token");
            assert.equal(l.includes("secret=1"), false, "a log line holds the query");
        }
    });
});

describe("capability links off loopback, behind a trusted proxy", () => {
    let server;
    let port;
    let links;
    let t = 1_000_000;
    before(async () => {
        links = new MediaLinks({ now: () => t }).configure({
            publicUrl: "https://zalo.example.com",
            linkAuth: "capability",
            maxClients: 3,
            clientTtlMs: 15 * 60_000,
            ttlMs: 60 * 60_000,
            trustedProxies: ["127.0.0.1"],
            rateLimit: 1000,
            log: () => {},
        });
        server = await startServer(links, { trustedProxies: ["127.0.0.1"] });
        port = server.address().port;
    });
    after(() => server.close());

    it("serves the first 3 client addresses for 15 minutes, a fourth gets 403, then fits once a window ends", async () => {
        const { file, scope } = sealed("c.jpg");
        const { url } = links.issue({ accountId: ID, msgId: "m1", file, scope, mime: "image/jpeg", name: "c.jpg" });
        const from = (ip) => request(port, pathOf(url), { headers: { "x-forwarded-for": ip } });
        assert.equal((await from("203.0.113.1")).status, 200, "no bearer token needed");
        assert.equal((await from("203.0.113.2")).status, 200);
        assert.equal((await from("203.0.113.3")).status, 200);
        assert.equal((await from("203.0.113.4")).status, 403);
        assert.equal((await from("203.0.113.1")).status, 200, "an admitted address keeps its place");
        t += 15 * 60_000;
        assert.equal((await from("203.0.113.4")).status, 200);
    });

    it("rate limits one address (429 with Retry-After), and ten bad tokens lock it out for the minute", async () => {
        const { file, scope } = sealed("rl.jpg");
        const { url } = links.issue({ accountId: ID, msgId: "m1", file, scope, mime: "image/jpeg", name: "rl.jpg" });
        links.configure({ rateLimit: 3 });
        const from = (path, ip) => request(port, path, { headers: { "x-forwarded-for": ip } });
        for (let i = 0; i < 3; i++) assert.equal((await from(pathOf(url), "198.51.100.7")).status, 200);
        const limited = await from(pathOf(url), "198.51.100.7");
        assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers["retry-after"]) > 0);
        assert.equal((await from(pathOf(url), "198.51.100.8")).status, 200, "another address is not affected");
        links.configure({ rateLimit: 1000 });
        for (let i = 0; i < 10; i++)
            assert.equal((await from(`/zalo/media/${"B".repeat(22)}`, "198.51.100.9")).status, 404);
        assert.equal((await from(pathOf(url), "198.51.100.9")).status, 429, "a good token after ten bad ones");
    });

    it("without a trusted proxy, X-Forwarded-For is ignored: every request is the proxy's one address", async () => {
        const plain = await startServer(links);
        try {
            const p = plain.address().port;
            const { file, scope } = sealed("n.jpg");
            const { url } = links.issue({ accountId: ID, msgId: "m1", file, scope, mime: "image/jpeg", name: "n.jpg" });
            links.configure({ trustedProxies: [] });
            for (const ip of ["203.0.113.11", "203.0.113.12", "203.0.113.13", "203.0.113.14"]) {
                const r = await request(p, pathOf(url), { headers: { "x-forwarded-for": ip } });
                assert.equal(r.status, 200, "a forged header cannot use up the link's places");
            }
        } finally {
            links.configure({ trustedProxies: ["127.0.0.1"] });
            plain.close();
        }
    });
});

describe("the stdio listener", () => {
    it("serves capability links on 127.0.0.1 only", async () => {
        const links = new MediaLinks().configure({ linkAuth: "capability", log: () => {} });
        await ensureMediaServed(links);
        try {
            assert.match(links.localBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
            const { file, scope } = sealed("s.ogg", Buffer.from("OggS-voice"));
            const { url } = links.issue({ accountId: ID, msgId: "m1", file, scope, mime: "audio/ogg", name: "s.ogg" });
            const port = Number(new URL(url).port);
            const res = await request(port, pathOf(url));
            assert.equal(res.status, 200);
            assert.equal(res.body.toString(), "OggS-voice");
            assert.equal((await request(port, "/elsewhere")).status, 404);
        } finally {
            await closeMediaListener(links);
        }
    });
});

describe("zalo_view_media over the MCP HTTP server", () => {
    it("builds the link on publicUrl whatever Host the request names, and the link serves the file", async () => {
        const accountDir = getAccountDir(ID);
        mkdirSync(accountDir, { recursive: true });
        const db = initDb(join(accountDir, "zalo.db"));
        const { file } = sealed("call.mp4", Buffer.from("VIDEO-OVER-MCP"), "m-http");
        insertMessage({
            msgId: "m-http",
            threadId: "t1",
            senderId: "u2",
            senderName: "A",
            text: "",
            timestamp: 100,
            type: "video",
            raw_data: "{}",
            has_attachment: 1,
            localPath: file,
        });
        const links = new MediaLinks().configure({
            publicUrl: "https://zalo.example.com",
            linkAuth: "bearer",
            bearerAvailable: true,
            log: () => {},
        });
        setMediaLinks(links);
        const deps = {
            api: { getOwnId: () => ID },
            buffer: { read: () => ({ messages: [], cursor: 0 }), getStats: () => [] },
            filter: { isWatched: () => true },
            config: {},
            nameCache: { ready: true, get: () => null, search: () => [] },
            accountDir,
            mediaLinks: links,
        };
        const server = createHTTPServer(registerTools, deps, 0, AUTH, "127.0.0.1");
        await new Promise((r) => server.once("listening", r));
        try {
            const port = server.address().port;
            links.configure({ localBaseUrl: `http://127.0.0.1:${port}` });
            const body = JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "zalo_view_media", arguments: { msgId: "m-http" } },
            });
            const raw = await new Promise((resolve, reject) => {
                const r = http.request(
                    {
                        host: "127.0.0.1",
                        port,
                        path: "/mcp",
                        method: "POST",
                        agent: false,
                        headers: {
                            host: "evil.example",
                            authorization: `Bearer ${AUTH}`,
                            "content-type": "application/json",
                            accept: "application/json, text/event-stream",
                            "content-length": Buffer.byteLength(body),
                        },
                    },
                    (res) => {
                        let text = "";
                        res.on("data", (c) => (text += c));
                        res.on("end", () => resolve(text));
                    },
                );
                r.on("error", reject);
                r.end(body);
            });
            const json = raw.trim().startsWith("{")
                ? raw
                : raw
                      .split("\n")
                      .find((l) => l.startsWith("data: "))
                      .slice(6);
            const reply = JSON.parse(JSON.parse(json).result.content[0].text);
            assert.equal(reply.delivery, "link");
            assert.equal(reply.auth, "bearer");
            assert.match(reply.url, /^https:\/\/zalo\.example\.com\/zalo\/media\/[A-Za-z0-9_-]{22}$/);
            assert.equal(reply.url.includes("evil.example"), false);
            const got = await request(port, pathOf(reply.url), { headers: { authorization: `Bearer ${AUTH}` } });
            assert.equal(got.body.toString(), "VIDEO-OVER-MCP");
        } finally {
            server.close();
            setMediaLinks(null);
            db.close();
        }
    });
});

describe("msg media --deliver link: a link the daemon serves, asked over its channel", () => {
    it("the daemon issues and serves the link; a missing or hidden message is refused", async () => {
        const accountDir = getAccountDir(ID);
        const { file, scope } = sealed("chan.jpg", Buffer.from("CHANNEL-PHOTO"), "m-chan");
        const links = new MediaLinks().configure({ linkAuth: "capability", log: () => {} });
        const rows = {
            "m-chan": { msgId: "m-chan", threadId: "t1", localPath: file },
            "m-gone": { msgId: "m-gone", threadId: "t1", localPath: null },
            "m-hid": { msgId: "m-hid", threadId: "t-secret", localPath: file },
        };
        const channel = await startDaemonChannel({
            getApi: () => null,
            accountDir,
            onMediaLink: ({ msgId }) =>
                linkForCachedMessage({
                    row: rows[msgId] ?? null,
                    scope,
                    accountId: ID,
                    hidden: { isHidden: (t) => t === "t-secret" },
                    links,
                    ensureServed: ensureMediaServed,
                }),
        });
        try {
            const got = await mediaLinkViaDaemon(accountDir, { msgId: "m-chan" });
            assert.equal(got.ok, true, got.error);
            assert.equal(got.auth, "capability");
            const res = await request(Number(new URL(got.url).port), pathOf(got.url));
            assert.equal(res.body.toString(), "CHANNEL-PHOTO");
            assert.match((await mediaLinkViaDaemon(accountDir, { msgId: "m-gone" })).error, /no downloaded media/);
            assert.match((await mediaLinkViaDaemon(accountDir, { msgId: "m-hid" })).error, /hidden chat/);
            assert.match((await mediaLinkViaDaemon(accountDir, { msgId: "m-none" })).error, /not in the local cache/);
        } finally {
            channel.stop();
            await closeMediaListener(links);
        }
    });
});
