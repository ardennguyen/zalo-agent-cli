/**
 * The table runner (src/zalo/kernel/endpoint.js) with an endpoint's `bigIdKeys`: the reply is opened with the
 * session key and parsed through json-ids.js `preParse`, so a 19-digit id under a listed key arrives as a string
 * with every digit. Every id, key and host here is fake.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sealSession } from "../../src/zalo/kernel/cipher.js";
import { callEndpoint } from "../../src/zalo/kernel/endpoint.js";

const KEY = Buffer.alloc(16, 9).toString("base64");

/** A fake id past Number.MAX_SAFE_INTEGER whose twin (…678) rounds to the same double. */
const BIG_ID = "4123456789012345679";

/** A logged-in api whose transport answers every call with `inner`, sealed with the session key. */
function apiAnswering(innerText) {
    const seen = [];
    const ctx = {
        API_TYPE: 30,
        API_VERSION: 695,
        secretKey: KEY,
        imei: "fake-imei",
        userAgent: "Mozilla/5.0 (offline test)",
        options: {
            polyfill: async (url, init) => {
                seen.push({ url: String(url), ...init });
                const body = JSON.stringify({ error_code: 0, error_message: "", data: sealSession(KEY, innerText) });
                return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
            },
        },
    };
    return { api: { getContext: () => ctx, zpwServiceMap: { chat: ["https://chat.zalo.invalid"] } }, seen };
}

/** What the server writes: the ids as bare JSON numbers, at the top and inside a list. */
const INNER = `{"error_code":0,"error_message":"","data":{"msgId":${BIG_ID},"msgIds":[${BIG_ID},7],"ts":1700000000000}}`;

const DEF = {
    host: "chat",
    path: "/api/fake/read",
    method: "get",
    body: () => ({ imei: "fake-imei" }),
};

describe("callEndpoint with bigIdKeys", () => {
    it("keeps every digit of a 19-digit id under a listed key, as a string", async () => {
        const { api, seen } = apiAnswering(INNER);
        const data = await callEndpoint(api, { ...DEF, bigIdKeys: ["msgId", "msgIds"] }, {});
        assert.equal(seen.length, 1);
        assert.equal(new URL(seen[0].url).pathname, "/api/fake/read");
        // Red if the reply is parsed with a plain JSON.parse: the id would come back as the rounded number.
        assert.equal(data.msgId, BIG_ID);
        assert.deepEqual(data.msgIds, [BIG_ID, "7"], "every bare integer in a listed array becomes a string");
        assert.equal(data.ts, 1700000000000, "a key that is not listed stays a number");
    });

    it("loses the digits without bigIdKeys (the control: the reply above really carries a number)", async () => {
        const { api } = apiAnswering(INNER);
        const data = await callEndpoint(api, DEF, {});
        assert.equal(typeof data.msgId, "number");
        assert.notEqual(String(data.msgId), BIG_ID, "a double cannot hold this id");
    });
});

describe("callEndpoint with swapHosts (Web's switchDomain)", () => {
    /** A transport that answers each host with the status in `byHost`, 200 with an empty object otherwise. */
    function hostsAnswering(byHost, profile) {
        const seen = [];
        const ctx = {
            API_TYPE: 30,
            API_VERSION: 695,
            secretKey: KEY,
            imei: "fake-imei",
            userAgent: "Mozilla/5.0 (offline test)",
            options: {
                polyfill: async (url) => {
                    const host = new URL(String(url)).host;
                    seen.push(host);
                    const status = byHost[host] ?? 200;
                    const body =
                        status === 200
                            ? JSON.stringify({ error_code: 0, error_message: "", data: sealSession(KEY, INNER_OK) })
                            : "not found";
                    return new Response(body, { status });
                },
            },
        };
        return { api: { getContext: () => ctx, zpwServiceMap: { profile } }, seen };
    }
    const INNER_OK = '{"error_code":0,"error_message":"","data":{"onlines":[]}}';
    const SWAP = { host: "profile", path: "/api/fake/onlines", method: "get", swapHosts: true, body: () => ({}) };

    it("moves to the next profile host after an HTTP 404, and answers from it", async () => {
        const { api, seen } = hostsAnswering({ "a.zalo.invalid": 404 }, [
            "https://a.zalo.invalid/",
            "https://b.zalo.invalid",
        ]);
        const data = await callEndpoint(api, SWAP, {});
        assert.deepEqual(data, { onlines: [] });
        assert.deepEqual(seen, ["a.zalo.invalid", "b.zalo.invalid"]);
    });

    it("fails with the last HTTP status, naming how many hosts were tried, when every host fails", async () => {
        const { api, seen } = hostsAnswering({ "a.zalo.invalid": 404, "b.zalo.invalid": 404 }, [
            "https://a.zalo.invalid",
            "https://b.zalo.invalid",
        ]);
        await assert.rejects(callEndpoint(api, SWAP, {}), (e) => {
            assert.match(e.message, /^HTTP 404 \(on each of the 2 hosts tried\)$/);
            assert.equal(e.status, 404);
            return true;
        });
        assert.equal(seen.length, 2);
    });

    it("keeps one host's error as it is, and never swaps a definition that did not ask for it", async () => {
        const one = hostsAnswering({ "a.zalo.invalid": 404 }, ["https://a.zalo.invalid"]);
        await assert.rejects(callEndpoint(one.api, SWAP, {}), { message: "HTTP 404" });
        const plain = hostsAnswering({ "a.zalo.invalid": 404 }, ["https://a.zalo.invalid", "https://b.zalo.invalid"]);
        await assert.rejects(callEndpoint(plain.api, { ...SWAP, swapHosts: false }, {}), { message: "HTTP 404" });
        assert.deepEqual(plain.seen, ["a.zalo.invalid"], "a definition without swapHosts asks the first host only");
    });
});

describe("callEndpoint with paramsFirst", () => {
    const keys = (url) => [...new URL(url).searchParams.keys()];

    it("puts params before zpw_ver and zpw_type, then the plain query", async () => {
        const { api, seen } = apiAnswering('{"error_code":0,"data":{}}');
        await callEndpoint(api, { ...DEF, paramsFirst: true, query: () => ({ extra: "1" }) }, {});
        assert.equal(seen[0].method, "GET");
        assert.deepEqual(keys(seen[0].url), ["params", "zpw_ver", "zpw_type", "extra"]);
        assert.equal(new URL(seen[0].url).searchParams.get("zpw_ver"), "695");
    });

    it("the control: without it the version pair goes first", async () => {
        const { api, seen } = apiAnswering('{"error_code":0,"data":{}}');
        await callEndpoint(api, DEF, {});
        assert.deepEqual(keys(seen[0].url), ["zpw_ver", "zpw_type", "params"]);
    });
});
