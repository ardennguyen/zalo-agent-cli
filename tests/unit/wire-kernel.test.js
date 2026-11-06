/**
 * The kernel's own calls on the wire, built by `createApi` on a logged-in context of the fake Zalo (design 3.1 and
 * 3.3, package K1): keepAlive, fetchAccountInfo, and the bound helpers makeURL, request and resolve that the engine's
 * hand-built calls use (src/zalo/kernel/bound.js).
 *
 * Each case is checked against its reviewed record (`expectGolden("kernel", ...)`), and the error cases against a
 * literal `{message, code}`.
 *
 * The bound helpers are not methods of the session object, so the engine this file builds carries four test-only
 * methods (`kernelMakeURL`, `kernelGet`, `kernelPost`, `kernelResolve`) that run the same steps through
 * `boundUtils(api)`.
 */
import "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../../src/zalo/api.js";
import { boundUtils } from "../../src/zalo/kernel/bound.js";
import { FAKE, expectGolden, openWire } from "../helpers/wire-diff/index.js";
import { serviceHost } from "./fake-zalo-session.js";

/** The fake endpoint the bound-helper cases call. */
const FAKE_PATH = "/api/group/fake";

/**
 * `createApi` plus the four bound-helper methods, each run through the session's bound helpers.
 *
 * @param {object} ctx
 * @param {Record<string, string[]>} serviceMap
 * @param {string[]} wsUrls
 * @param {object} opts
 * @returns {object}
 */
function createApiWithHelpers(ctx, serviceMap, wsUrls, opts) {
    const api = createApi(ctx, serviceMap, wsUrls, opts);
    const helpers = () => boundUtils(api);
    const base = `${serviceMap.group[0]}${FAKE_PATH}`;
    return Object.assign(api, {
        /** makeURL: the query's names in wire order, and its values. */
        kernelMakeURL: (params) => {
            const url = new URL(helpers().makeURL(base, params));
            return { order: [...url.searchParams.keys()].join(","), query: Object.fromEntries(url.searchParams) };
        },
        /** A sealed GET: makeURL + encodeAES + request + resolve. */
        kernelGet: async (json) => {
            const u = helpers();
            const url = u.makeURL(base, { params: u.encodeAES(JSON.stringify(json)) });
            return u.resolve(await u.request(url, { method: "GET" }));
        },
        /** A sealed form POST. */
        kernelPost: async (json) => {
            const u = helpers();
            const body = new URLSearchParams({ params: u.encodeAES(JSON.stringify(json)) });
            return u.resolve(await u.request(u.makeURL(base), { method: "POST", body }));
        },
        /** resolve alone, on a body handed to it. */
        kernelResolve: (text) => helpers().resolve(new Response(text, { status: 200 })),
    });
}

describe("the kernel's calls on the wire", () => {
    let wire;

    before(async () => {
        wire = await openWire({ createApi: createApiWithHelpers });
        // A cookie every fake host gets, so the Cookie header is recorded with a value.
        wire.ctx.cookie.setCookieSync("wire=fake-w; Domain=zalo.invalid; Path=/", "https://chat.zalo.invalid/");
    });
    after(() => wire?.close());

    /** A case against its golden entry. */
    async function check(rec, golden) {
        await expectGolden("kernel", golden, rec.own);
    }

    describe("keepAlive", () => {
        it("asks GET {chat}/keepalive with the sealed {imei}, and returns the plain data", async () => {
            const rec = await wire.run("keepAlive", [], {
                replies: { "/keepalive": { plain: { config_vesion: 7 } } },
            });
            await check(rec, "keepAlive");
            const [req] = rec.own.requests;
            assert.equal(rec.own.requests.length, 1);
            assert.equal(req.service, "chat");
            assert.deepEqual(req.params, { imei: FAKE.imei });
            assert.equal(req.headers.cookie, "wire=fake-w", "the jar's cookie for this host went out");
            assert.deepEqual(rec.own.result, { config_vesion: 7 });
        });

        it("throws Zalo's message and code for an outer error", async () => {
            const rec = await wire.run("keepAlive", [], {
                replies: { "/keepalive": { outer: { error_code: 102, error_message: "session timeout" } } },
            });
            await check(rec, "keepAlive/outer-error");
            assert.deepEqual(rec.own.error, { message: "session timeout", code: 102 });
        });

        it("throws no Zalo code for HTTP 500 (the message is ours: HTTP <status>)", async () => {
            const rec = await wire.run("keepAlive", [], { replies: { "/keepalive": { status: 500 } } });
            await check(rec, "keepAlive/http-500");
            assert.deepEqual(rec.own.error, { message: "HTTP 500", code: null });
        });
    });

    describe("fetchAccountInfo", () => {
        it("asks me-v2 the Web way (params, os, browser) and returns the answer", async () => {
            const profile = { profile: { userId: "1000000000000000001" } };
            const rec = await wire.run("fetchAccountInfo", [], {
                replies: { "/api/social/profile/me-v2": { data: profile } },
            });
            await check(rec, "fetchAccountInfo");
            assert.equal(rec.own.requests[0].service, "profile");
            assert.deepEqual(rec.own.result, profile);
        });

        it("throws Zalo's message and code for an inner error", async () => {
            const rec = await wire.run("fetchAccountInfo", [], {
                replies: { "/api/social/profile/me-v2": { inner: { error_code: 114, error_message: "fake inner" } } },
            });
            await check(rec, "fetchAccountInfo/inner-error");
            assert.deepEqual(rec.own.error, { message: "fake inner", code: 114 });
        });

        it("throws a message, and no code, for a data no session key opens", async () => {
            const rec = await wire.run("fetchAccountInfo", [], {
                replies: { "/api/social/profile/me-v2": { undecryptable: true } },
            });
            await check(rec, "fetchAccountInfo/undecryptable");
            assert.deepEqual(rec.own.error, { message: "Failed to parse response data", code: null });
        });
    });

    describe("the bound helpers (makeURL, request, resolve)", () => {
        it("makeURL: the names and values in the Web's order", async () => {
            const rec = await wire.run("kernelMakeURL", [{ params: "a+b/c=", grid: "fake" }]);
            await check(rec, "makeURL");
            assert.equal(rec.own.result.order, "zpw_ver,zpw_type,params,grid");
        });

        it("request + resolve: a sealed GET, its request and its data", async () => {
            const rec = await wire.run("kernelGet", [{ grid: "fake-grid" }], {
                replies: { [FAKE_PATH]: (req) => ({ data: { echo: req.params } }) },
            });
            await check(rec, "request/get");
            assert.equal(rec.own.requests[0].service, "group");
            assert.deepEqual(rec.own.result, { echo: { grid: "fake-grid" } });
        });

        it("request: a sealed form POST", async () => {
            const rec = await wire.run("kernelPost", [{ a: 1 }], {
                replies: { [FAKE_PATH]: (req) => ({ data: { echo: req.params } }) },
            });
            await check(rec, "request/post");
            const [req] = rec.own.requests;
            assert.equal(req.method, "POST");
            assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
            assert.deepEqual(req.formOrder, ["params"]);
            assert.deepEqual(rec.own.result, { echo: { a: 1 } });
        });

        it("resolve: the message and code for an undecryptable data and a non-JSON body", async () => {
            const bodies = {
                undecryptable: JSON.stringify({ error_code: 0, data: "not-a-ciphertext" }),
                "not-json": "<html>",
            };
            for (const [name, body] of Object.entries(bodies)) {
                const rec = await wire.run("kernelResolve", [body]);
                await check(rec, `resolve/${name}`);
                assert.deepEqual(rec.own.error, { message: "Failed to parse response data", code: null }, name);
            }
        });
    });

    it("the cases above ran against the fake hosts of this login", () => {
        // Guards the fixture, not the kernel: a golden file recorded against another host map would hide nothing.
        assert.equal(wire.own.zpwServiceMap.group[0], `https://${serviceHost("group")}`);
    });
});
