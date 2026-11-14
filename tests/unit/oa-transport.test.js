/**
 * src/core/oa/transport.js: how every `oa …` / `zbs …` call reaches Zalo's official APIs.
 *
 * Asserted against Zalo's OA docs: the `access_token` header (never the query), the `data=<JSON>` GET convention,
 * JSON and multipart bodies, the error table ("Mã lỗi Official Account API") and the ZBS one ("Bảng mã lỗi"), the
 * X-RateLimit-* headers ("Giới hạn tốc độ gọi API"), one locked refresh on -216/-220 (refresh tokens are single use),
 * and the upload limits ("Upload hình ảnh / file / ảnh GIF"). globalThis.fetch is mocked; nothing reaches Zalo.
 */
import { SANDBOX_HOME } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    OPENAPI_V2,
    OPENAPI_V3,
    ZBS_BASE,
    OAError,
    UPLOAD_LIMITS,
    buildUrl,
    describeOAError,
    loadOACreds,
    mimeTypeOf,
    oaRequest,
    readZaloJson,
    saveOACreds,
    tokenFields,
    uploadForm,
} from "../../src/core/oa/transport.js";
import { refreshStoredToken } from "../../src/core/oa/oauth.js";

const OA_DIR = join(SANDBOX_HOME, ".zalo-agent");
const FILES = join(SANDBOX_HOME, "oa-upload-files");
const TOKEN_URL = "https://oauth.zaloapp.com/v4/oa/access_token";

/**
 * Replace fetch: `reply(url, init)` returns `{ status?, json?, text?, type?, headers? }` (default 200 JSON).
 * Every call is recorded with its URL, method, headers and body.
 */
function mockFetch(reply) {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const r = (await reply(String(url), init, calls.length)) ?? {};
        const body = r.text ?? JSON.stringify(r.json ?? { error: 0, message: "Success", data: {} });
        return new Response(body, {
            status: r.status ?? 200,
            headers: { "content-type": r.type ?? "application/json", ...(r.headers || {}) },
        });
    };
    return { calls, restore: () => (globalThis.fetch = real) };
}

let m;
beforeEach(() => {
    rmSync(OA_DIR, { recursive: true, force: true });
    saveOACreds({ accessToken: "tok-1", refreshToken: "ref-1", appId: "123", secretKey: "sek" });
});
afterEach(() => m?.restore());

describe("the request oaRequest sends", () => {
    it("puts the stored token in the access_token header and never in the URL", async () => {
        m = mockFetch(() => ({}));
        await oaRequest({ url: `${OPENAPI_V2}/oa/getoa` });
        const [c] = m.calls;
        assert.equal(c.url, "https://openapi.zalo.me/v2.0/oa/getoa");
        assert.equal(c.init.method, "GET");
        assert.equal(c.init.headers.access_token, "tok-1");
        assert.doesNotMatch(c.url, /tok-1|access_token/);
        assert.equal(c.init.body, undefined);
    });

    it("`data` becomes ?data=<JSON> (the v2/v3 GET convention), `query` plain params", async () => {
        m = mockFetch(() => ({}));
        await oaRequest({ url: `${OPENAPI_V3}/oa/user/getlist`, data: { offset: 0, count: 50, tag_name: "a b" } });
        await oaRequest({
            url: `${OPENAPI_V2}/article/getslice`,
            query: { offset: 5, limit: 10, type: "video", x: undefined },
        });
        const u1 = new URL(m.calls[0].url);
        assert.equal(u1.origin + u1.pathname, "https://openapi.zalo.me/v3.0/oa/user/getlist");
        assert.deepEqual(JSON.parse(u1.searchParams.get("data")), { offset: 0, count: 50, tag_name: "a b" });
        assert.deepEqual([...u1.searchParams.keys()], ["data"]);
        const u2 = new URL(m.calls[1].url);
        assert.deepEqual(Object.fromEntries(u2.searchParams), { offset: "5", limit: "10", type: "video" });
        assert.equal(buildUrl("https://x.test/p", { data: { a: 1 } }), "https://x.test/p?data=%7B%22a%22%3A1%7D");
    });

    it("`body` is sent as JSON with Content-Type application/json", async () => {
        m = mockFetch(() => ({}));
        await oaRequest({ method: "POST", url: `${OPENAPI_V3}/oa/message/cs`, body: { recipient: { user_id: "1" } } });
        const [c] = m.calls;
        assert.equal(c.init.method, "POST");
        assert.equal(c.init.headers["Content-Type"], "application/json");
        assert.equal(c.init.body, '{"recipient":{"user_id":"1"}}');
    });

    it("`form` is sent as multipart FormData, with no Content-Type of ours (fetch adds the boundary)", async () => {
        m = mockFetch(() => ({}));
        const form = new globalThis.FormData();
        form.append("k", "v");
        await oaRequest({ method: "POST", url: `${OPENAPI_V2}/oa/upload/image`, form });
        const [c] = m.calls;
        assert.ok(c.init.body instanceof globalThis.FormData);
        assert.equal(c.init.headers["Content-Type"], undefined);
    });

    it("an explicit token wins over the stored one, and another oaId reads its own record", async () => {
        saveOACreds({ accessToken: "shop-tok" }, "shop");
        m = mockFetch(() => ({}));
        await oaRequest({ url: `${OPENAPI_V2}/oa/getoa`, token: "given" });
        await oaRequest({ url: `${OPENAPI_V2}/oa/getoa`, oaId: "shop" });
        assert.equal(m.calls[0].init.headers.access_token, "given");
        assert.equal(m.calls[1].init.headers.access_token, "shop-tok");
    });

    it("refuses before any request when the OA is not configured", async () => {
        m = mockFetch(() => ({}));
        await assert.rejects(
            () => oaRequest({ url: `${OPENAPI_V2}/oa/getoa`, oaId: "nobody" }),
            (e) => e instanceof OAError && e.code === "not_configured" && /oa login/.test(e.message),
        );
        assert.equal(m.calls.length, 0);
    });
});

describe("how the answer is read", () => {
    it("returns Zalo's JSON, with X-RateLimit-* as a non-enumerable rateLimit", async () => {
        m = mockFetch(() => ({
            json: { error: 0, message: "Success", data: { name: "N" } },
            headers: { "X-RateLimit-Limit": "4000", "X-RateLimit-Remain": "3999" },
        }));
        const r = await oaRequest({ url: `${OPENAPI_V2}/oa/getoa` });
        assert.deepEqual(r, { error: 0, message: "Success", data: { name: "N" } });
        assert.deepEqual(r.rateLimit, { limit: 4000, remain: 3999 });
        assert.equal(Object.keys(r).includes("rateLimit"), false, "kept out of --json output");
    });

    it("an HTML 404 is OAError http_404 saying the endpoint answered HTTP 404, not a JSON parse error", async () => {
        m = mockFetch(() => ({ status: 404, text: "<html>Not Found</html>", type: "text/html" }));
        await assert.rejects(
            () => oaRequest({ url: `${OPENAPI_V3}/oa/upload/image`, data: { secret: "x" } }),
            (e) =>
                e instanceof OAError &&
                e.code === "http_404" &&
                e.status === 404 &&
                /openapi\.zalo\.me\/v3\.0\/oa\/upload\/image answered HTTP 404/.test(e.message) &&
                !/secret/.test(e.message),
        );
    });

    it("a 200 that is not JSON is OAError http_200", async () => {
        m = mockFetch(() => ({ status: 200, text: "<html>maintenance</html>", type: "text/html" }));
        await assert.rejects(
            () => oaRequest({ url: `${OPENAPI_V2}/oa/getoa` }),
            (e) => e.code === "http_200" && /non-JSON/.test(e.message),
        );
    });

    it("a 500 with a JSON body is still http_500, with the body kept as data", async () => {
        m = mockFetch(() => ({ status: 500, json: { error: -1 } }));
        await assert.rejects(
            () => oaRequest({ url: `${OPENAPI_V2}/oa/getoa` }),
            (e) => e.code === "http_500" && e.data?.error === -1,
        );
    });

    it("error !== 0 is OAError with Zalo's code, message and data plus the docs' meaning", async () => {
        m = mockFetch(() => ({
            json: { error: -230, message: "User has not interacted with the OA in the past 7 days" },
        }));
        await assert.rejects(
            () => oaRequest({ method: "POST", url: `${OPENAPI_V3}/oa/message/cs`, body: {} }),
            (e) =>
                e instanceof OAError &&
                e.code === -230 &&
                e.data.error === -230 &&
                /past 7 days/.test(e.meaning) &&
                /^OA API error -230: User has not interacted/.test(e.message),
        );
    });

    it("a ZBS endpoint's error is labeled ZBS, including send-by-UID on the OA host", async () => {
        m = mockFetch(() => ({ json: { error: -100, message: "Unknown error" } }));
        for (const url of [`${ZBS_BASE}/message/template`, `${OPENAPI_V3}/oa/message/template`]) {
            await assert.rejects(
                () => oaRequest({ method: "POST", url, body: {} }),
                (e) => /^ZBS API error -100/.test(e.message),
                url,
            );
        }
        // Red if the OA's own endpoints start saying ZBS.
        await assert.rejects(
            () => oaRequest({ method: "POST", url: `${OPENAPI_V3}/oa/message/cs`, body: {} }),
            (e) => /^OA API error -100/.test(e.message),
        );
    });

    it("a long id in a reply keeps its exact digits (Zalo types product/beneficiary/ZCA ids as long)", async () => {
        const text = '{"error":0,"data":{"product_id":1000000000000000001,"amount":10,"rate":1.5}}';
        const res = new Response(text, { headers: { "content-type": "application/json" } });
        const r = await readZaloJson(res, `${OPENAPI_V3}/oa/purchase/create_order`);
        // Red if JSON.parse rounds it to 1000000000000000000.
        assert.equal(r.data.product_id, "1000000000000000001");
        assert.equal(r.data.amount, 10);
        assert.equal(r.data.rate, 1.5);
    });

    it("a -32 carries the rate-limit headers", async () => {
        m = mockFetch(() => ({
            json: { error: -32, message: "Your application reached limit call api" },
            headers: { "X-RateLimit-Limit": "4000", "X-RateLimit-Remain": "0" },
        }));
        await assert.rejects(
            () => oaRequest({ url: `${OPENAPI_V2}/oa/getoa` }),
            (e) => e.code === -32 && e.rateLimit.remain === 0 && /rate limit/.test(e.meaning),
        );
    });

    it("reads ZBS codes from the ZBS table, and OA codes from the OA table (-100 differs)", () => {
        assert.match(describeOAError(-100, `${OPENAPI_V2}/oa/upload/image`).meaning, /attachment_id expired/);
        assert.match(describeOAError(-100, `${ZBS_BASE}/message/template`).meaning, /unknown error/);
        // Send-by-UID: ZBS's table sends its sending-condition errors to the OA table, so the OA meaning wins.
        assert.match(describeOAError(-100, `${OPENAPI_V3}/oa/message/template`).meaning, /attachment_id expired/);
        assert.match(describeOAError(-124, `${ZBS_BASE}/message/template`).meaning, /access token is invalid/);
        // A ZBS UID send answers with OA codes: the OA table is the fallback.
        assert.match(describeOAError(-213, `${ZBS_BASE}/message/template`).meaning, /does not follow/);
        for (const code of [-216, -220, -221, -223, -224, -240, -201]) assert.ok(describeOAError(code), String(code));
        assert.equal(describeOAError(-14029), null, "not in Zalo's OA error table");
    });
});

describe("expired token: one locked refresh, one retry", () => {
    const tokenReply = (n) => ({
        json: { access_token: `tok-${n}`, refresh_token: `ref-${n}`, expires_in: "90000" },
    });

    it("-216 refreshes with the stored refresh token, saves the new pair and expiresAt, and retries once", async () => {
        let refreshes = 0;
        m = mockFetch((url, init) => {
            if (url === TOKEN_URL) return tokenReply(1 + ++refreshes);
            return init.headers.access_token === "tok-1"
                ? { json: { error: -216, message: "Access token is invalid" } }
                : { json: { error: 0, data: { ok: true } } };
        });
        const r = await oaRequest({ url: `${OPENAPI_V2}/oa/getoa` });
        assert.deepEqual(r.data, { ok: true });
        assert.deepEqual(
            m.calls.map((c) => (c.url === TOKEN_URL ? "refresh" : c.init.headers.access_token)),
            ["tok-1", "refresh", "tok-2"],
        );
        const sent = Object.fromEntries(new URLSearchParams(String(m.calls[1].init.body)));
        assert.deepEqual(sent, { refresh_token: "ref-1", app_id: "123", grant_type: "refresh_token" });
        assert.equal(m.calls[1].init.headers.secret_key, "sek");
        const c = loadOACreds();
        assert.equal(c.accessToken, "tok-2");
        assert.equal(c.refreshToken, "ref-2", "the single-use refresh token is replaced");
        assert.ok(Date.parse(c.expiresAt) > Date.now());
    });

    it("-220 after the refresh is thrown, not refreshed again (never loops)", async () => {
        let refreshes = 0;
        m = mockFetch((url) =>
            url === TOKEN_URL ? tokenReply(1 + ++refreshes) : { json: { error: -220, message: "expired" } },
        );
        await assert.rejects(
            () => oaRequest({ url: `${OPENAPI_V2}/oa/getoa` }),
            (e) => e.code === -220,
        );
        assert.equal(refreshes, 1);
        assert.equal(m.calls.length, 3);
    });

    it("ZBS's -124 refreshes too; an explicit token and other errors never refresh", async () => {
        m = mockFetch((url, init) => {
            if (url === TOKEN_URL) return tokenReply(2);
            if (init.headers.access_token === "tok-2") return { json: { error: 0 } };
            return { json: { error: url.startsWith(ZBS_BASE) ? -124 : -216 } };
        });
        await oaRequest({ url: `${ZBS_BASE}/template/all` });
        assert.equal(m.calls.filter((c) => c.url === TOKEN_URL).length, 1);
        await assert.rejects(
            () => oaRequest({ url: `${OPENAPI_V2}/oa/getoa`, token: "given" }),
            (e) => e.code === -216,
        );
        assert.equal(m.calls.filter((c) => c.url === TOKEN_URL).length, 1);
    });

    it("without refresh credentials, -216 is thrown as is", async () => {
        saveOACreds({ refreshToken: null });
        m = mockFetch(() => ({ json: { error: -216 } }));
        await assert.rejects(
            () => oaRequest({ url: `${OPENAPI_V2}/oa/getoa` }),
            (e) => e.code === -216,
        );
        assert.equal(m.calls.length, 1);
    });

    it("concurrent calls that all see -216 make one refresh between them", async () => {
        let refreshes = 0;
        m = mockFetch(async (url, init) => {
            if (url === TOKEN_URL) {
                await new Promise((r) => setTimeout(r, 30));
                return tokenReply(1 + ++refreshes);
            }
            return init.headers.access_token === "tok-1" ? { json: { error: -216 } } : { json: { error: 0 } };
        });
        await Promise.all([1, 2, 3, 4].map(() => oaRequest({ url: `${OPENAPI_V2}/oa/getoa` })));
        assert.equal(refreshes, 1, "the refresh token is single use: a second refresh would spend a dead one");
        assert.equal(loadOACreds().refreshToken, "ref-2");
    });

    it("two forced refreshes in a row run one after the other, each with the then-current refresh token", async () => {
        let n = 1;
        m = mockFetch(async (url, init) => {
            await new Promise((r) => setTimeout(r, 10));
            const rt = new URLSearchParams(String(init.body)).get("refresh_token");
            return rt === `ref-${n}`
                ? tokenReply(++n)
                : { json: { error: -14014, error_name: "Invalid refresh token" } };
        });
        await Promise.all([refreshStoredToken(), refreshStoredToken()]);
        assert.equal(loadOACreds().refreshToken, "ref-3");
    });

    it("an OAuth error on refresh says the refresh token may have expired", async () => {
        m = mockFetch(() => ({ json: { error: -14014, error_description: "Invalid refresh token" } }));
        await assert.rejects(
            () => refreshStoredToken(),
            (e) =>
                e instanceof OAError && e.code === -14014 && /3 months/.test(e.message) && /oa login/.test(e.message),
        );
        assert.equal(loadOACreds().refreshToken, "ref-1", "nothing is overwritten on failure");
    });

    it("tokenFields stores expires_in as given and expiresAt from it", () => {
        const f = tokenFields({ access_token: "a", refresh_token: "r", expires_in: "90000" }, 0);
        assert.deepEqual(f, {
            accessToken: "a",
            refreshToken: "r",
            expiresIn: "90000",
            expiresAt: new Date(90_000_000).toISOString(),
        });
    });
});

describe("uploadForm", () => {
    beforeEach(() => {
        rmSync(FILES, { recursive: true, force: true });
        mkdirSync(FILES, { recursive: true });
    });

    it("sends the file as part `file` with its base name and MIME type", async () => {
        const p = join(FILES, "photo.PNG");
        writeFileSync(p, Buffer.alloc(100, 1));
        m = mockFetch(() => ({ json: { error: 0, data: { attachment_id: "att" } } }));
        const r = await uploadForm(`${OPENAPI_V2}/oa/upload/image`, p, UPLOAD_LIMITS.image);
        assert.equal(r.data.attachment_id, "att");
        const [c] = m.calls;
        assert.equal(c.url, "https://openapi.zalo.me/v2.0/oa/upload/image");
        assert.equal(c.init.method, "POST");
        assert.equal(c.init.headers.access_token, "tok-1");
        const part = c.init.body.get("file");
        assert.equal(part.name, "photo.PNG", "the base name, never the whole path");
        assert.equal(part.type, "image/png");
        assert.equal(part.size, 100);
    });

    it("takes the base name of the path (join() gives backslashes on Windows)", async () => {
        const p = join(FILES, "doc.pdf");
        writeFileSync(p, "x");
        m = mockFetch(() => ({}));
        await uploadForm(`${OPENAPI_V2}/oa/upload/file`, p, UPLOAD_LIMITS.file);
        assert.equal(m.calls.at(-1).init.body.get("file").name, "doc.pdf");
        assert.equal(
            mimeTypeOf("C:\\a\\b\\doc.DOCX"),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
    });

    it("refuses an over-size or wrong-type file, or a missing one, before any request", async () => {
        const big = join(FILES, "big.jpg");
        writeFileSync(big, Buffer.alloc(UPLOAD_LIMITS.image.maxBytes + 1));
        const gif = join(FILES, "anim.gif");
        writeFileSync(gif, "GIF89a");
        m = mockFetch(() => ({}));
        await assert.rejects(
            () => uploadForm(`${OPENAPI_V2}/oa/upload/image`, big, UPLOAD_LIMITS.image),
            (e) => e.code === "upload_too_large",
        );
        await assert.rejects(
            () => uploadForm(`${OPENAPI_V2}/oa/upload/image`, gif, UPLOAD_LIMITS.image),
            (e) => e.code === "upload_type",
        );
        await assert.rejects(
            () => uploadForm(`${OPENAPI_V2}/oa/upload/file`, join(FILES, "none.pdf"), UPLOAD_LIMITS.file),
            (e) => e.code === "upload_missing",
        );
        assert.equal(m.calls.length, 0);
    });

    it("the documented limits: image jpg/png 1 MB, file PDF/DOC/DOCX/CSV 5 MB, GIF 5 MB", () => {
        assert.deepEqual(JSON.parse(JSON.stringify(UPLOAD_LIMITS)), {
            image: { maxBytes: 1048576, types: ["jpg", "jpeg", "png"] },
            file: { maxBytes: 5242880, types: ["pdf", "doc", "docx", "csv"] },
            gif: { maxBytes: 5242880, types: ["gif"] },
        });
    });
});
