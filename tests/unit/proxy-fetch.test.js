/**
 * The proxy-aware fetch (src/zalo/client.js `createProxyFetch`) and the maintenance question's route.
 *
 * Node bundles its own undici and the package here is a different major version; a dispatcher built by one and handed
 * to the fetch of the other fails every request with "invalid onRequestStart method". Every call of a proxied account
 * (login, reads, writes) failed with "fetch failed" until the pair was matched. No offline test ever sent a request
 * through a proxy, so none noticed.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createProxyFetch } from "../../src/zalo/client.js";

const servers = [];
after(() => {
    for (const s of servers) {
        s.closeAllConnections?.();
        s.close();
    }
});

/** A plain HTTP proxy: undici sends it absolute-URI requests, and it answers for the origin. */
async function proxy(answer = "via-proxy") {
    const seen = [];
    const server = http.createServer((req, res) => {
        // One connection per request (see media-age-zcloud.test.js): a kept-alive socket closed by
        // the keep-alive timer while a slowed client reuses it fails the request ("other side closed").
        res.setHeader("connection", "close");
        seen.push({ method: req.method, url: req.url, headers: req.headers });
        res.writeHead(200, { "content-type": "text/plain", "x-seen-by": "proxy" });
        res.end(answer);
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

// Every test in this file runs in the sandbox: a failing hook fails them all.
before(() => assertSandboxed(CONFIG_DIR));

describe("proxy fetch", () => {
    it("sends a request through the proxy and returns a standard Response", async () => {
        const p = await proxy();
        const f = createProxyFetch(p.url);
        const res = await f("http://zalo.test/api/x?y=1", { method: "GET", headers: { "x-probe": "1" } });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), "via-proxy");
        assert.equal(res.headers.get("x-seen-by"), "proxy");
        assert.equal(p.seen.length, 1, "the proxy, not the origin, was asked");
        assert.equal(p.seen[0].url, "http://zalo.test/api/x?y=1");
        assert.equal(p.seen[0].headers["x-probe"], "1");
    });

    it("carries a body, as the login's POSTs do", async () => {
        const p = await proxy("ok");
        const f = createProxyFetch(p.url);
        const res = await f("http://zalo.test/post", { method: "POST", body: "a=1&b=2" });
        assert.equal(await res.text(), "ok");
        assert.equal(p.seen[0].method, "POST");
    });
});

describe("proxy fetch: a request on a connection of its own", () => {
    it("a request marked freshConnection does not use the pool, and its connection is closed after it", async () => {
        const seen = [];
        const server = http.createServer((req, res) => {
            seen.push({ url: req.url, port: req.socket.remotePort, connection: req.headers.connection });
            res.end("ok");
        });
        // Kept alive on purpose, for longer than the test: the pool must be there to show the marked request skips it.
        server.keepAliveTimeout = 60_000;
        servers.push(server);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const f = createProxyFetch(`http://127.0.0.1:${server.address().port}`);
        for (const [path, init] of [
            ["/a", {}],
            ["/b", { freshConnection: true }],
            ["/c", {}],
        ]) {
            assert.equal(await (await f(`http://zalo.test${path}`, init)).text(), "ok");
        }
        assert.deepEqual(
            seen.map((s) => s.url),
            ["http://zalo.test/a", "http://zalo.test/b", "http://zalo.test/c"],
            "all three through the proxy",
        );
        assert.equal(seen[2].port, seen[0].port, "an unmarked request reuses the pooled connection");
        assert.notEqual(seen[1].port, seen[0].port, "the marked request opened its own");
        assert.equal(seen[1].connection, "close");
    });
});
