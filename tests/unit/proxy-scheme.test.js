/**
 * The session's proxy agents speak HTTP CONNECT only, so a proxy URL of another scheme (socks5://) is refused when the
 * session options are built, with a message that names the scheme and never the credentials.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSessionOptions } from "../../src/zalo/client.js";

describe("session proxy schemes", () => {
    it("takes http:// and https:// proxies", () => {
        for (const url of ["http://u:p@127.0.0.1:8080", "HTTPS://127.0.0.1:8443"]) {
            const opts = buildSessionOptions(url, { logging: false, env: {} });
            assert.ok(opts.agent, url);
            assert.equal(typeof opts.polyfill, "function", url);
        }
    });

    it("refuses socks5:// and a URL without a scheme, naming no credentials", () => {
        assert.throws(
            () => buildSessionOptions("socks5://u:secret@127.0.0.1:1080", { env: {} }),
            (e) => {
                assert.match(e.message, /proxy scheme "socks5"/);
                assert.equal(e.message.includes("secret"), false);
                return true;
            },
        );
        assert.throws(
            () => buildSessionOptions("u:secret@127.0.0.1:1080", { env: {} }),
            (e) => /without a scheme/.test(e.message) && !e.message.includes("secret"),
        );
    });

    it("builds no agent without a proxy", () => {
        assert.equal(buildSessionOptions(null, { logging: false, env: {} }).agent, undefined);
    });
});
