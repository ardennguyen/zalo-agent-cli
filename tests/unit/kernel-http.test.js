/**
 * The transport (src/zalo/kernel/http.js): URLs, default headers by kind, cookies in and out, redirects followed as
 * a browser navigation, the timeout, and the reply envelope. Every request goes to a recording fake fetch; every
 * id, key and cookie is fake.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

// The transport's timeout is an unref'd AbortSignal on purpose (a request must never keep a daemon alive). With a
// fake server that never answers and nothing else running, Linux lets the event loop drain before the timer fires,
// and node:test cancels the pending tests ("Promise resolution is still pending but the event loop has already
// resolved"); Windows passed. A ref'd interval for the file's length stands in for the daemon's socket, as in
// tests/unit/receipts.test.js.
let keepAlive;
before(() => {
    keepAlive = setInterval(() => {}, 25);
});
after(() => clearInterval(keepAlive));
import { ZaloApiError } from "../../src/zalo/errors.js";
import { sealSession } from "../../src/zalo/kernel/cipher.js";
import { cookieHeader, loadJar } from "../../src/zalo/kernel/cookies.js";
import {
    ACCEPT_LANGUAGE,
    DEFAULT_TIMEOUT_MS,
    MAX_REDIRECTS,
    buildUrl,
    decodeReply,
    httpRequest,
    multipartBody,
    sealParams,
} from "../../src/zalo/kernel/http.js";

const KEY = Buffer.alloc(16, 7).toString("base64");
const UA = "Mozilla/5.0 (offline test)";

/** A session whose fetch records each request and answers from `answer(url, init, i)`. */
function session(answer = () => new Response("{}", { status: 200 }), extra = {}) {
    const seen = [];
    const ctx = {
        API_TYPE: 30,
        API_VERSION: 695,
        secretKey: KEY,
        imei: "fake-imei",
        userAgent: UA,
        cookie: loadJar([{ key: "zpw_sek", value: "fake-sek", domain: "chat.zalo.me", path: "/" }]),
        options: {
            polyfill: async (url, init) => {
                seen.push({ url: String(url), ...init });
                return answer(String(url), init, seen.length - 1);
            },
        },
        ...extra,
    };
    return { ctx, seen };
}

const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("buildUrl", () => {
    const ctx = { API_VERSION: 695, API_TYPE: 30 };

    it("writes zpw_ver and zpw_type first, then the params in order (D1), escaped per value", () => {
        const url = buildUrl(ctx, "https://chat.zalo.invalid/keepalive", { params: "a+b/c=", note: "x y~" });
        assert.equal(
            url,
            "https://chat.zalo.invalid/keepalive?zpw_ver=695&zpw_type=30&params=a%2Bb%2Fc%3D&note=x%20y~",
        );
    });

    it("keeps a query the base already has, adds no second version pair, leaves undefined out", () => {
        const url = buildUrl(ctx, "https://h.invalid/p?zpw_ver=1&a=1", { b: undefined, c: null, d: 0 });
        assert.equal(url, "https://h.invalid/p?zpw_type=30&zpw_ver=1&a=1&c=null&d=0");
    });

    it("carries no version pair for the login host (version: false) and always ends with a query otherwise", () => {
        assert.equal(
            buildUrl(ctx, "https://wpa.invalid/api/login/x", { a: 1 }, { version: false }),
            "https://wpa.invalid/api/login/x?a=1",
        );
        assert.equal(buildUrl(ctx, "https://h.invalid/p"), "https://h.invalid/p?zpw_ver=695&zpw_type=30");
    });
});

describe("httpRequest: headers", () => {
    it("sends an API GET as an XHR from chat.zalo.me, with no content type (D2) and no Accept-Encoding (D4)", async () => {
        const { ctx, seen } = session();
        await httpRequest(ctx, "https://tt-chat1-wpa.chat.zalo.me/api/x?zpw_ver=695");
        const h = seen[0].headers;
        assert.equal(seen[0].method, "GET");
        assert.equal(h.accept, "application/json, text/plain, */*");
        assert.equal(h.origin, "https://chat.zalo.me");
        assert.equal(h.referer, "https://chat.zalo.me/");
        assert.equal(h["user-agent"], UA);
        assert.equal(h["accept-language"], ACCEPT_LANGUAGE);
        assert.equal(h.cookie, "zpw_sek=fake-sek");
        assert.equal("content-type" in h, false);
        assert.equal("accept-encoding" in h, false);
        assert.ok(
            Object.keys(h).every((k) => k === k.toLowerCase()),
            "one spelling per header",
        );
    });

    it("adds the form content type to a form POST only, never to a multipart one", async () => {
        const { ctx, seen } = session();
        await httpRequest(ctx, "https://h.zalo.me/a", { method: "POST", body: new URLSearchParams({ params: "x" }) });
        assert.equal(seen[0].headers["content-type"], "application/x-www-form-urlencoded");
        assert.ok(seen[0].body instanceof URLSearchParams, "the body reaches fetch as it was given");
        const form = multipartBody({
            field: "fileContent",
            filename: "blob",
            type: "image/png",
            bytes: new Uint8Array([1, 2]),
        });
        await httpRequest(ctx, "https://h.zalo.me/b", { method: "POST", body: form });
        assert.equal("content-type" in seen[1].headers, false, "fetch writes multipart/form-data and its boundary");
        const part = seen[1].body.get("fileContent");
        assert.equal(part.name, "blob");
        assert.equal(part.type, "image/png");
    });

    it("lets a caller's header replace the default whatever its letter case, so no value is sent twice", async () => {
        const { ctx, seen } = session();
        await httpRequest(ctx, "https://id.zalo.me/x", {
            method: "POST",
            body: new URLSearchParams(),
            headers: { Origin: "https://id.zalo.me", ACCEPT: "a", "Cloud-Viewer-Key": "fake-vk" },
        });
        const h = seen[0].headers;
        assert.equal(h.origin, "https://id.zalo.me");
        assert.equal(h.accept, "a");
        assert.equal(h["cloud-viewer-key"], "fake-vk");
        assert.equal("Origin" in h, false);
    });

    it("sends the jar's cookies for the full URL (D5) and keeps what the answer sets, host-only included (D6)", async () => {
        const { ctx, seen } = session((url) =>
            url.includes("/set")
                ? new Response("", { status: 200, headers: { "set-cookie": "fresh=fake-2; Path=/" } })
                : new Response("", { status: 200 }),
        );
        ctx.cookie = loadJar([{ key: "api_only", value: "fake-1", domain: "chat.zalo.me", path: "/api" }]);
        await httpRequest(ctx, "https://chat.zalo.me/api/x");
        await httpRequest(ctx, "https://chat.zalo.me/other");
        assert.equal(seen[0].headers.cookie, "api_only=fake-1");
        assert.equal("cookie" in seen[1].headers, false, "the /api cookie stays on /api, no empty Cookie header");
        await httpRequest(ctx, "https://wpa.chat.zalo.me/set");
        assert.equal(cookieHeader(ctx.cookie, "https://wpa.chat.zalo.me/"), "fresh=fake-2");
        assert.equal(cookieHeader(ctx.cookie, "https://chat.zalo.me/"), "", "host-only: that host only");
    });

    it("refuses a session with no User-Agent, and gives a session with no jar an empty one", async () => {
        const { ctx } = session();
        await assert.rejects(httpRequest({ ...ctx, userAgent: undefined }, "https://h.zalo.me/"), /User agent/);
        const bare = session().ctx;
        bare.cookie = undefined;
        await httpRequest(bare, "https://h.zalo.me/");
        assert.equal(typeof bare.cookie.getCookieStringSync, "function");
    });
});

describe("httpRequest: redirects", () => {
    const redirect = (location, status = 302, headers = {}) =>
        new Response(null, { status, headers: { location, ...headers } });

    it('follows a chain with an absolute and a relative Location in "jar" mode, keeping each hop\'s cookie', async () => {
        const { ctx, seen } = session((url) => {
            if (url.startsWith("https://id.zalo.me/account/checksession")) {
                return redirect("https://jr.zaloapp.com/jr/syncsession?token=fake-t1");
            }
            if (url.startsWith("https://jr.zaloapp.com/jr/syncsession")) {
                return redirect("https://jr.chat.zalo.me/jr/pushsession?token=fake-t2", 302, {
                    "set-cookie": "zsync=fake-s; Path=/",
                });
            }
            if (url.startsWith("https://jr.chat.zalo.me/jr/pushsession")) {
                return redirect("/jr/done", 303, {
                    "set-cookie": "zpw_sek=fake-new; Domain=chat.zalo.me; Path=/",
                });
            }
            return new Response("ok", { status: 200 });
        });
        ctx.cookie = loadJar([]);
        const page = "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F";
        const res = await httpRequest(ctx, "https://id.zalo.me/account/checksession?continue=x", {
            headers: { referer: page, accept: "text/html" },
            follow: "jar",
        });
        assert.equal(res.status, 200);
        assert.deepEqual(
            seen.map((r) => new URL(r.url).host + new URL(r.url).pathname),
            [
                "id.zalo.me/account/checksession",
                "jr.zaloapp.com/jr/syncsession",
                "jr.chat.zalo.me/jr/pushsession",
                "jr.chat.zalo.me/jr/done",
            ],
        );
        assert.ok(
            seen.every((r) => r.redirect === "manual"),
            "fetch never follows by itself, or hop cookies are lost",
        );
        assert.equal(seen[0].headers.referer, page);
        // Hops: navigation headers; the Referer stays the initiating page, cut to its origin cross-origin.
        for (const hop of seen.slice(1)) {
            assert.equal(hop.method, "GET");
            assert.equal(hop.headers["sec-fetch-mode"], "navigate");
            assert.equal(hop.headers["sec-fetch-dest"], "document");
            assert.equal(hop.headers.referer, "https://id.zalo.me/");
            assert.equal(hop.headers["sec-fetch-site"], "cross-site", "once cross-site, the chain stays cross-site");
            assert.equal("origin" in hop.headers, false, "a navigation GET has no Origin");
        }
        assert.equal(seen[2].headers.cookie, undefined, "zsync belongs to jr.zaloapp.com, not to jr.chat.zalo.me");
        assert.equal(cookieHeader(ctx.cookie, "https://jr.zaloapp.com/"), "zsync=fake-s");
        assert.equal(cookieHeader(ctx.cookie, "https://chat.zalo.me/"), "zpw_sek=fake-new");
    });

    it("turns a POST answered 302 into a GET without a body, and keeps method and body on a 307", async () => {
        for (const [status, method, hasBody] of [
            [302, "GET", false],
            [303, "GET", false],
            [307, "POST", true],
            [308, "POST", true],
        ]) {
            const { ctx, seen } = session((url) =>
                url.endsWith("/start") ? redirect("https://id.zalo.me/next", status) : new Response("ok"),
            );
            await httpRequest(ctx, "https://id.zalo.me/start", {
                method: "POST",
                body: new URLSearchParams({ token: "fake" }),
                headers: { referer: "https://id.zalo.me/" },
                follow: "jar",
            });
            assert.equal(seen[1].method, method, `${status}`);
            assert.equal("body" in seen[1], hasBody, `${status} body`);
            assert.equal("content-type" in seen[1].headers, hasBody, `${status} content type`);
        }
    });

    it("drops a caller's own content type on the GET a 302 turns a POST into, and keeps it on a 307", async () => {
        // The case above leaves the content type to the transport. Here the caller writes it, in its own spelling:
        // the hop builds its headers from the caller's, so a GET hop that kept it would carry a content type for a
        // body it does not have. Red if the 302 hop keeps "Content-Type", or if the 307 hop loses it.
        for (const [status, kept] of [
            [302, false],
            [307, true],
        ]) {
            const { ctx, seen } = session((url) =>
                url.endsWith("/start") ? redirect("https://id.zalo.me/next", status) : new Response("ok"),
            );
            await httpRequest(ctx, "https://id.zalo.me/start", {
                method: "POST",
                body: new URLSearchParams({ token: "fake" }),
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
                follow: "jar",
            });
            assert.equal(seen.length, 2, `${status}: one hop`);
            assert.equal(
                seen[0].headers["content-type"],
                "application/x-www-form-urlencoded;charset=UTF-8",
                `${status}: the POST carries the caller's value`,
            );
            const hopTypes = Object.keys(seen[1].headers).filter((k) => k.toLowerCase() === "content-type");
            if (kept) {
                assert.equal(seen[1].method, "POST");
                assert.deepEqual(hopTypes, ["content-type"], "a 307 keeps the body and its type");
            } else {
                assert.equal(seen[1].method, "GET");
                assert.deepEqual(hopTypes, [], "a GET hop sends no content type in any spelling");
                assert.equal("body" in seen[1], false);
            }
        }
    });

    it("gives up after the hop limit instead of looping", async () => {
        const { ctx, seen } = session((url) => redirect(url.endsWith("/a") ? "/b" : "/a"));
        await assert.rejects(httpRequest(ctx, "https://id.zalo.me/a", { follow: "jar" }), /Too many redirects/);
        assert.equal(seen.length, MAX_REDIRECTS + 1);
    });

    it('returns a 3xx as it is in "manual" mode, and lets fetch follow in the default mode', async () => {
        const { ctx, seen } = session(() => redirect("https://id.zalo.me/next"));
        const res = await httpRequest(ctx, "https://id.zalo.me/a", { follow: "manual" });
        assert.equal(res.status, 302);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].redirect, "manual");
        await httpRequest(ctx, "https://id.zalo.me/a");
        assert.equal(seen[1].redirect, undefined, "the default leaves redirects to fetch");
    });
});

describe("httpRequest: timeout", () => {
    /** A server that never answers, until the request is aborted. */
    const hang = (_url, init) =>
        new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason)));

    it("waits 10 s by default (Zalo Web's), and none when told 0", async () => {
        assert.equal(DEFAULT_TIMEOUT_MS, 10_000);
        const { ctx, seen } = session();
        await httpRequest(ctx, "https://h.zalo.me/a");
        assert.ok(seen[0].signal instanceof AbortSignal, "a default request carries a timeout signal");
        await httpRequest(ctx, "https://h.zalo.me/a", { timeoutMs: 0 });
        assert.equal(seen[1].signal, undefined);
    });

    it("says what timed out, as a ZaloApiError marked as a timeout", async () => {
        const { ctx } = session(hang);
        await assert.rejects(httpRequest(ctx, "https://h.zalo.me/api/slow", { timeoutMs: 30 }), (e) => {
            assert.ok(e instanceof ZaloApiError);
            assert.equal(e.timeout, true);
            assert.match(e.message, /did not answer within \d+ s: \/api\/slow/);
            return true;
        });
    });

    it("passes the caller's own abort through as it is, not as a timeout", async () => {
        const { ctx } = session(hang);
        const ac = new AbortController();
        const p = httpRequest(ctx, "https://h.zalo.me/a", { signal: ac.signal });
        ac.abort();
        await assert.rejects(p, (e) => e?.name === "AbortError" && e.timeout === undefined);
    });
});

describe("decodeReply", () => {
    const ctx = { secretKey: KEY };
    const sealed = (inner) => json({ error_code: 0, error_message: "", data: sealSession(KEY, JSON.stringify(inner)) });
    const thrown = async (p) => {
        try {
            await p;
        } catch (e) {
            return { message: e.message, code: e.code, status: e.status };
        }
        assert.fail("expected a rejection");
    };

    it("returns the inner data of a session reply", async () => {
        assert.deepEqual(await decodeReply(ctx, sealed({ error_code: 0, data: { ok: [1, "2"] } })), { ok: [1, "2"] });
    });

    it("throws Zalo's message and code for an outer error and for an inner error", async () => {
        assert.deepEqual(await thrown(decodeReply(ctx, json({ error_code: 102, error_message: "timeout" }))), {
            message: "timeout",
            code: 102,
            status: undefined,
        });
        assert.deepEqual(await thrown(decodeReply(ctx, sealed({ error_code: 216, error_message: "no user" }))), {
            message: "no user",
            code: 216,
            status: undefined,
        });
    });

    it("keeps the error envelope's data on .data, outer and inner, and leaves .data off when there is none", async () => {
        const caught = async (p) => {
            try {
                await p;
            } catch (e) {
                return e;
            }
            assert.fail("expected a rejection");
        };
        // Red if the error drops the envelope's data: the boards read a list's end from an error whose data is "[]".
        const inner = await caught(decodeReply(ctx, sealed({ error_code: 7, error_message: "end", data: "[]" })));
        assert.ok(inner instanceof ZaloApiError);
        assert.equal(inner.code, 7);
        assert.equal(inner.data, "[]");
        const outer = await caught(decodeReply(ctx, json({ error_code: 8, error_message: "x", data: { why: 1 } })));
        assert.deepEqual(outer.data, { why: 1 });
        const none = await caught(decodeReply(ctx, sealed({ error_code: 9, error_message: "no data" })));
        assert.equal(Object.hasOwn(none, "data"), false);
        assert.equal(Object.hasOwn(new ZaloApiError("plain", 1), "data"), false);
    });

    it("throws HTTP <status> with no code for a non-2xx, so the status is never read as a Zalo code", async () => {
        assert.deepEqual(await thrown(decodeReply(ctx, json({}, 500))), {
            message: "HTTP 500",
            code: null,
            status: 500,
        });
    });

    it('throws "Failed to parse response data" (no code) for a body that is not JSON or a data that does not open', async () => {
        const plainText = new Response("<html>", { status: 200 });
        assert.deepEqual(await thrown(decodeReply(ctx, plainText)), {
            message: "Failed to parse response data",
            code: null,
            status: undefined,
        });
        const wrongKey = json({ error_code: 0, data: sealSession(Buffer.alloc(16, 9).toString("base64"), "{}") });
        assert.equal((await thrown(decodeReply(ctx, wrongKey))).message, "Failed to parse response data");
    });

    it("reads a plain reply's data as it is", async () => {
        const reply = json({ error_code: 0, error_message: "", data: { config_vesion: 7 } });
        assert.deepEqual(await decodeReply(ctx, reply, { encrypted: false }), { config_vesion: 7 });
    });

    it("answers okCodes and emptyOn codes instead of throwing; emptyOn hands out a fresh copy each time", async () => {
        const empty = { conversations: [], version: 0 };
        const a = await decodeReply(ctx, sealed({ error_code: 212, error_message: "none" }), {
            emptyOn: { 212: empty },
        });
        assert.deepEqual(a, empty);
        a.conversations.push("mutated");
        const b = await decodeReply(ctx, sealed({ error_code: 212 }), { emptyOn: { 212: empty } });
        assert.deepEqual(b.conversations, [], "a caller's change does not leak into the next answer");
        const dup = await decodeReply(ctx, sealed({ error_code: 1, data: { dup: true } }), {
            okCodes: [1],
            envelope: true,
        });
        assert.deepEqual(dup, { data: { dup: true }, code: 1, message: "" });
        assert.equal((await thrown(decodeReply(ctx, sealed({ error_code: 2 }), { okCodes: [1] }))).code, 2);
    });

    it("parses the opened text with the caller's parser (the lossless id path)", async () => {
        const reply = new Response(
            JSON.stringify({
                error_code: 0,
                data: sealSession(KEY, '{"error_code":0,"data":{"uid":1234567890123456789}}'),
            }),
        );
        const data = await decodeReply(ctx, reply, {
            parse: (text) => JSON.parse(text.replace(/"uid":(\d+)/, '"uid":"$1"')),
        });
        assert.equal(data.uid, "1234567890123456789", "red if the plain JSON.parse ran and rounded the id");
    });
});

describe("sealParams", () => {
    it("seals JSON with the session key and refuses a session that has none", () => {
        assert.equal(sealParams({ secretKey: KEY }, { imei: "fake" }), sealSession(KEY, '{"imei":"fake"}'));
        assert.throws(() => sealParams({ secretKey: null }, {}), /Not logged in/);
    });
});
