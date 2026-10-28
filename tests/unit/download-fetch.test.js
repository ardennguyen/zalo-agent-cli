/**
 * The fetch of the restore's batch downloads and of the media downloads (plan item ZP-01): the account's own proxy,
 * User-Agent and Referer, instead of the global fetch with none of them.
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WEB_REFERER, createDownloadFetch } from "../../src/zalo/download-fetch.js";

const CHROME =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

/** An api whose context holds a recording fetch, standing in for the proxy-aware one. */
function apiWith(polyfill, userAgent = CHROME) {
    return { getContext: () => ({ userAgent, options: { polyfill } }) };
}

describe("createDownloadFetch", () => {
    it("sends through the account's own fetch (its proxy), not the global one", async () => {
        const seen = [];
        const proxyFetch = async (url, init) => {
            seen.push({ url, init });
            return new Response("ok");
        };
        const f = createDownloadFetch(apiWith(proxyFetch), () => assert.fail("the global fetch was used"));
        const res = await f("https://batch.zalo.invalid/a");
        assert.equal(await res.text(), "ok");
        assert.equal(seen.length, 1);
        assert.equal(seen[0].url, "https://batch.zalo.invalid/a");
    });

    it("carries the session's User-Agent, the Web client's Referer and the browser's fetch headers, and no cookie", async () => {
        let init;
        const f = createDownloadFetch(
            apiWith(async (_u, i) => {
                init = i;
                return new Response("");
            }),
        );
        await f("https://cdn.example.invalid/pic.jpg", { signal: AbortSignal.timeout(1000) });
        assert.equal(init.headers["user-agent"], CHROME);
        assert.equal(init.headers.referer, WEB_REFERER);
        assert.equal(init.headers["sec-fetch-dest"], "empty");
        assert.equal(init.headers["sec-fetch-mode"], "cors");
        assert.equal(init.headers["sec-fetch-site"], "cross-site", "a CDN outside zalo.me");
        assert.match(init.headers["sec-ch-ua"], /Chromium";v="155"/);
        assert.equal(init.headers.cookie, undefined);
        assert.ok(init.signal, "the caller's deadline survives");
    });

    it("is same-site for a zalo.me host and leaves a header the caller set alone", async () => {
        let init;
        const f = createDownloadFetch(
            apiWith(async (_u, i) => {
                init = i;
                return new Response("");
            }),
        );
        await f("https://transfersync.zalo.me/b", { headers: { Referer: "https://elsewhere.invalid/" } });
        assert.equal(init.headers["sec-fetch-site"], "same-site");
        assert.equal(init.headers.Referer, "https://elsewhere.invalid/");
        assert.equal(init.headers.referer, undefined, "no second Referer next to the caller's");
    });

    it("falls back to the plain fetch when there is no usable account context", async () => {
        const marker = async () => new Response("fallback");
        for (const api of [null, undefined, {}, { getContext: () => null }, { getContext: () => ({}) }]) {
            const f = createDownloadFetch(api, marker);
            assert.equal(f, marker);
        }
        const throwing = {
            getContext: () => {
                throw new Error("no context");
            },
        };
        assert.equal(createDownloadFetch(throwing, marker), marker);
    });
});
