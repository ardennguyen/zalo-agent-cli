/**
 * The proxy-aware fetch (src/core/zalo-client.js `createProxyFetch`) and the maintenance question's route.
 *
 * Node bundles its own undici and the package here is a different major version; a dispatcher built by one and handed
 * to the fetch of the other fails every request with "invalid onRequestStart method". Every call of a proxied account
 * (login, reads, writes) failed with "fetch failed" until the pair was matched. No offline test ever sent a request
 * through a proxy, so none noticed.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createProxyFetch } from "../../src/core/zalo-client.js";

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
        seen.push({ method: req.method, url: req.url, headers: req.headers });
        res.writeHead(200, { "content-type": "text/plain", "x-seen-by": "proxy" });
        res.end(answer);
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

describe("proxy fetch", () => {
    it("runs inside the test sandbox", () => assertSandboxed(CONFIG_DIR));

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
