/**
 * The kernel's own calls on the wire, ours against zca-js's, both built by `createApi` on ONE logged-in context
 * (design 3.1, the differential for K1): keepAlive, fetchAccountInfo, and the bound helpers makeURL, request and
 * resolve that the engine's hand-built calls use.
 *
 * Every difference between the two sides must be one this file declares, and every declared difference must
 * actually be there (a declared difference that disappeared fails too), so the list cannot go stale. The declared
 * ones are the Web-vs-zca-js points of spec-kernel: D1 (query order), D2 (no content type on a GET), D4 (no
 * hand-set Accept-Encoding), and the official profile call (L6: me-v2 with params, os, browser).
 *
 * WP0's shared harness (tests/helpers/wire-diff/) is not on this branch yet; the small pair below does the same
 * job for these calls and can move onto `openPair` once that lands.
 */
import "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createApi } from "../../src/zalo/api.js";
import { boundUtils } from "../../src/zalo/kernel/bound.js";
import { loginWithSession } from "../../src/zalo/login.js";
import { FAKE, FAKE_CREDENTIALS, installFakeZalo, serviceHost } from "./fake-zalo-session.js";

const require = createRequire(import.meta.url);
const zcaUtils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));

const CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

/** The headers both sides are compared on (lowercased by the fake). */
const COMPARED_HEADERS = [
    "accept",
    "accept-language",
    "accept-encoding",
    "content-type",
    "cookie",
    "origin",
    "referer",
    "user-agent",
];

/** The decrypted `params` of a request, wherever it carried them. */
function paramsOf(req) {
    const enc = req.query.params ?? req.form?.params;
    return enc ? JSON.parse(zcaUtils.decodeAES(FAKE.sessionKey, enc)) : null;
}

/** A request as compared: what Zalo would see, minus the encryption. */
function normalize(req) {
    return {
        method: req.method,
        host: req.host,
        path: req.path,
        queryOrder: [...new URL(`https://x.invalid/?${req.rawQuery}`).searchParams.keys()],
        query: Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== "params")),
        params: paramsOf(req),
        headers: Object.fromEntries(COMPARED_HEADERS.map((h) => [h, req.headers[h] ?? null])),
        form: req.form,
    };
}

/**
 * Assert two normalized requests are equal except at the declared differences, and that each declared difference is
 * really there.
 *
 * @param {object} zca
 * @param {object} own
 * @param {Array<{field: string, zca: unknown, own: unknown, why: string}>} allow - `field` is a dotted path
 */
function assertSameWire(zca, own, allow = []) {
    const get = (o, path) => path.split(".").reduce((v, k) => (v === undefined || v === null ? v : v[k]), o);
    const set = (o, path, v) => {
        const keys = path.split(".");
        const last = keys.pop();
        const parent = keys.reduce((x, k) => x[k], o);
        parent[last] = v;
    };
    const a = structuredClone(zca);
    const b = structuredClone(own);
    for (const d of allow) {
        assert.deepEqual(get(a, d.field), d.zca, `declared difference ${d.field} (zca side): ${d.why}`);
        assert.deepEqual(get(b, d.field), d.own, `declared difference ${d.field} (own side): ${d.why}`);
        assert.notDeepEqual(d.zca, d.own, `a declared difference must differ: ${d.field}`);
        set(a, d.field, "<declared>");
        set(b, d.field, "<declared>");
    }
    assert.deepEqual(b, a);
}

/** D1, D2, D4 for a GET with params. */
const GET_DIFFS = (order) => [
    {
        field: "queryOrder",
        zca: [...order.filter((k) => !k.startsWith("zpw_")), "zpw_ver", "zpw_type"],
        own: order,
        why: "D1: Web writes zpw_ver, zpw_type first",
    },
    {
        field: "headers.content-type",
        zca: "application/x-www-form-urlencoded",
        own: null,
        why: "D2: Web sends a content type on a POST only",
    },
    {
        field: "headers.accept-encoding",
        zca: "gzip, deflate, br, zstd",
        own: null,
        why: "D4: fetch chooses its own Accept-Encoding",
    },
];

describe("the kernel's calls, zca-js against ours on one context", () => {
    let fake;
    let ctx;
    let own;
    let zca;

    before(async () => {
        fake = installFakeZalo();
        const api = await loginWithSession(
            { ...structuredClone(FAKE_CREDENTIALS), userAgent: CHROME_UA },
            { apiType: 30, apiVersion: 695, upkeep: false },
        );
        ctx = api.getContext();
        // A cookie every fake host gets, so the Cookie header is compared on a value, not on two empty ones.
        ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
        own = await createApi(ctx, api.zpwServiceMap, ["wss://ws.zalo.invalid/"], { engine: "own" });
        zca = await createApi(ctx, api.zpwServiceMap, ["wss://ws.zalo.invalid/"], { engine: "zca" });
        assert.notEqual(own.keepAlive, zca.keepAlive, "the two sides are different code");
    });
    after(() => fake.uninstall());

    /** Run `fn` against one side and return what went out (the raw query kept for its order) and what came back. */
    async function run(fn) {
        const from = fake.requests.length;
        let value;
        let error = null;
        try {
            value = await fn();
        } catch (e) {
            error = { message: e.message, code: e.code ?? null };
        }
        const reqs = fake.requests.slice(from);
        return { reqs, value, error };
    }

    /** Record the raw query of each request (the fake keeps it parsed only). */
    const rawQueries = [];
    before(() => {
        const inner = ctx.options.polyfill;
        ctx.options.polyfill = (url, init) => {
            rawQueries.push(new URL(String(url)).search.slice(1));
            return inner(url, init);
        };
    });
    const withRaw = (rec) => {
        const n = rec.reqs.length;
        rec.reqs.forEach((r, i) => (r.rawQuery = rawQueries[rawQueries.length - n + i]));
        return rec;
    };

    describe("keepAlive", () => {
        const answerPlain = (body) =>
            fake.rawRoute(
                (r) => r.path === "/keepalive",
                () =>
                    new Response(JSON.stringify(body), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
            );

        it("asks GET {chat}/keepalive with the sealed {imei}, and returns the plain data", async () => {
            fake.clearRoutes();
            answerPlain({ error_code: 0, error_message: "", data: { config_vesion: 7 } });
            const z = withRaw(await run(() => zca.keepAlive()));
            const o = withRaw(await run(() => own.keepAlive()));
            assert.equal(z.reqs.length, 1);
            assert.equal(o.reqs.length, 1);
            const zr = normalize(z.reqs[0]);
            const or = normalize(o.reqs[0]);
            assert.equal(or.host, serviceHost("chat"));
            assert.deepEqual(or.params, { imei: FAKE.imei });
            assert.equal(or.headers.cookie, "wire=fake-w", "the jar's cookie for this host went out");
            // zca-js's keepAlive builds its URL from a base that already carries the version pair, so its query order
            // happens to be Web's here: no D1 difference to declare.
            assert.deepEqual(zr.queryOrder, ["zpw_ver", "zpw_type", "params"]);
            assertSameWire(zr, or, GET_DIFFS(["zpw_ver", "zpw_type", "params"]).slice(1));
            assert.deepEqual(o.value, { config_vesion: 7 });
            assert.deepEqual(o.value, z.value);
        });

        it("throws the same message and code for an outer error", async () => {
            fake.clearRoutes();
            answerPlain({ error_code: 102, error_message: "session timeout", data: null });
            const z = await run(() => zca.keepAlive());
            const o = await run(() => own.keepAlive());
            assert.deepEqual(o.error, { message: "session timeout", code: 102 });
            assert.deepEqual(o.error, z.error);
        });

        it("throws no Zalo code for HTTP 500 (the message is ours: HTTP <status>)", async () => {
            fake.clearRoutes();
            fake.rawRoute(
                (r) => r.path === "/keepalive",
                () => new Response("", { status: 500 }),
            );
            const z = await run(() => zca.keepAlive());
            const o = await run(() => own.keepAlive());
            assert.equal(o.error.code, null);
            assert.equal(z.error.code, null);
            assert.equal(o.error.message, "HTTP 500");
            assert.equal(z.error.message, "Request failed with status code 500");
        });
    });

    describe("fetchAccountInfo", () => {
        it("asks me-v2 the Web way (params, os, browser) where zca-js asks with no params, same answer", async () => {
            fake.clearRoutes();
            fake.route("/api/social/profile/me-v2", () => ({ profile: { userId: "1000000000000000001" } }));
            const z = withRaw(await run(() => zca.fetchAccountInfo()));
            const o = withRaw(await run(() => own.fetchAccountInfo()));
            const zr = normalize(z.reqs[0]);
            const or = normalize(o.reqs[0]);
            assert.equal(or.host, serviceHost("profile"));
            assertSameWire(zr, or, [
                {
                    field: "queryOrder",
                    zca: ["zpw_ver", "zpw_type"],
                    own: ["zpw_ver", "zpw_type", "params", "os", "browser"],
                    why: "L6: the Web's me-v2 carries params, os and browser",
                },
                { field: "params", zca: null, own: { avatar_size: 160, imei: FAKE.imei }, why: "L6" },
                {
                    field: "query",
                    zca: { zpw_ver: "695", zpw_type: "30" },
                    own: { zpw_ver: "695", zpw_type: "30", os: "7", browser: "6" },
                    why: "L6: os 7 (Windows), browser 6 (Chrome)",
                },
                GET_DIFFS([])[1],
                GET_DIFFS([])[2],
            ]);
            assert.deepEqual(o.value, { profile: { userId: "1000000000000000001" } });
            assert.deepEqual(o.value, z.value);
        });

        it("throws the same message and code for an inner error", async () => {
            fake.clearRoutes();
            fake.rawRoute(
                (r) => r.path === "/api/social/profile/me-v2",
                () =>
                    new Response(
                        JSON.stringify({
                            error_code: 0,
                            data: zcaUtils.encodeAES(
                                FAKE.sessionKey,
                                JSON.stringify({ error_code: 114, error_message: "fake inner" }),
                            ),
                        }),
                        { status: 200 },
                    ),
            );
            const z = await run(() => zca.fetchAccountInfo());
            const o = await run(() => own.fetchAccountInfo());
            assert.deepEqual(o.error, { message: "fake inner", code: 114 });
            assert.deepEqual(o.error, z.error);
        });
    });

    describe("the bound helpers (makeURL, request, resolve)", () => {
        const theirs = () => zcaUtils.apiFactory()((_a, _c, utils) => utils)(ctx, zca);
        const ours = () => boundUtils(own);
        const base = `https://${serviceHost("group")}/api/group/fake`;

        it("makeURL: the same names and values, ours in the Web's order", () => {
            const t = new URL(theirs().makeURL(base, { params: "a+b/c=", grid: "fake" }));
            const o = new URL(ours().makeURL(base, { params: "a+b/c=", grid: "fake" }));
            assert.deepEqual(Object.fromEntries(o.searchParams), Object.fromEntries(t.searchParams));
            assert.deepEqual([...o.searchParams.keys()], ["zpw_ver", "zpw_type", "params", "grid"]);
            assert.deepEqual([...t.searchParams.keys()], ["params", "grid", "zpw_ver", "zpw_type"]);
        });

        it("request + resolve: a sealed GET through both, the same request and the same data", async () => {
            fake.clearRoutes();
            fake.route("/api/group/fake", (req) => ({ echo: req.params }));
            const call = (u) => async () => {
                const url = u.makeURL(base, { params: u.encodeAES(JSON.stringify({ grid: "fake-grid" })) });
                return u.resolve(await u.request(url, { method: "GET" }));
            };
            const z = withRaw(await run(call(theirs())));
            const o = withRaw(await run(call(ours())));
            assertSameWire(normalize(z.reqs[0]), normalize(o.reqs[0]), GET_DIFFS(["zpw_ver", "zpw_type", "params"]));
            assert.deepEqual(o.value, { echo: { grid: "fake-grid" } });
            assert.deepEqual(o.value, z.value);
        });

        it("request: a sealed form POST through both, the same request", async () => {
            fake.clearRoutes();
            fake.route("/api/group/fake", () => ({ ok: 1 }));
            const call = (u) => async () =>
                u.resolve(
                    await u.request(u.makeURL(base), {
                        method: "POST",
                        body: new URLSearchParams({ params: u.encodeAES('{"a":1}') }),
                    }),
                );
            const z = withRaw(await run(call(theirs())));
            const o = withRaw(await run(call(ours())));
            // A POST: both send the form content type, and the version pair is the whole query on both sides.
            assertSameWire(normalize(z.reqs[0]), normalize(o.reqs[0]), [GET_DIFFS([])[2]]);
            assert.equal(normalize(o.reqs[0]).headers["content-type"], "application/x-www-form-urlencoded");
            assert.deepEqual(o.value, z.value);
        });

        it("resolve: the same message and code for an undecryptable data and a non-JSON body", async () => {
            const bodies = {
                undecryptable: JSON.stringify({ error_code: 0, data: "not-a-ciphertext" }),
                "not JSON": "<html>",
            };
            for (const [name, body] of Object.entries(bodies)) {
                const z = await run(() => theirs().resolve(new Response(body, { status: 200 })));
                const o = await run(() => ours().resolve(new Response(body, { status: 200 })));
                assert.deepEqual(o.error, { message: "Failed to parse response data", code: null }, name);
                assert.deepEqual(o.error, z.error, name);
            }
        });
    });
});
