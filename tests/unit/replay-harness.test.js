/**
 * The replay harness (tests/helpers/replay): proof that it goes red when a
 * request drifts, and a pin of exactly how far today's code is from the
 * official Web client.
 *
 * Part 1 feeds the harness synthetic calls and checks that each kind of drift
 * is reported, and that a conforming sequence is not. A harness that cannot
 * fail proves nothing, so this comes first.
 *
 * Part 2 runs today's code (login, logout, socket requests) through the fake
 * Zalo and compares it with the shapes of the official client:
 *   - the differences that exist TODAY are pinned exactly: if one changes, this
 *     test says so, in either direction;
 *   - the target ("conforms") is declared as a `todo` test per v3.0 item, so a
 *     later phase turns it green and removes the `todo`.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { serverLogout } from "../../src/core/logout.js";
import { SyncV2 } from "../../src/core/sync-v2/index.js";
import { assertConforms, diffBody, diffSequence } from "../helpers/replay/replay.js";
import {
    WEB_BOOT,
    WEB_FRAMES,
    WEB_LOGOUT,
    WEB_LOGOUT_FORBIDDEN,
    WEB_QR_LOGIN,
    WEB_QR_LOGIN_FORBIDDEN,
} from "../helpers/replay/shapes.js";
import { installQueuePulls, startFakeZalo } from "../helpers/fake-zalo/index.js";
import { serviceHost } from "./fake-zalo-session.js";

/** A call that satisfies a shape, built from the shape itself. */
function conformingCall(shape) {
    const fill = (spec) => {
        const out = {};
        for (const k of spec?.required ?? []) out[k] = "x";
        for (const [k, v] of Object.entries(spec?.equals ?? {})) out[k] = String(v);
        return out;
    };
    return {
        method: shape.method,
        host: shape.host.startsWith("service:") ? serviceHost(shape.host.slice(8)) : shape.host,
        path: shape.path ?? `/prefix${shape.pathEndsWith}`,
        query: fill(shape.query),
        form: shape.form ? fill(shape.form) : null,
    };
}
const sequenceOf = (shapes) => shapes.map(conformingCall);
const opts = { hostOf: serviceHost };

describe("replay harness: it goes red when a request drifts", () => {
    it("accepts a sequence that conforms, and ignores calls the shapes do not cover", () => {
        const observed = [
            { method: "GET", host: "registry.npmjs.org", path: "/zca-js", query: {}, form: null },
            ...sequenceOf(WEB_BOOT),
        ];
        assert.deepEqual(diffSequence(observed, WEB_BOOT), []);
        assert.deepEqual(diffSequence(sequenceOf(WEB_LOGOUT), WEB_LOGOUT, opts), []);
        assert.deepEqual(diffSequence(sequenceOf(WEB_QR_LOGIN), WEB_QR_LOGIN, opts), []);
    });

    it("reports a missing query key by name", () => {
        const observed = sequenceOf(WEB_BOOT);
        delete observed[1].query.signkey;
        assert.deepEqual(diffSequence(observed, WEB_BOOT), ['login-info: query key "signkey" is missing']);
    });

    it("reports a forbidden query key by name", () => {
        const observed = sequenceOf(WEB_BOOT);
        observed[1].query.zpw_ver = "694";
        assert.deepEqual(diffSequence(observed, WEB_BOOT), ['login-info: query key "zpw_ver" must not be sent']);
    });

    it("reports a wrong fixed value, with what was sent and what was expected", () => {
        const observed = sequenceOf(WEB_BOOT);
        observed[1].query.enc_ver = "v1";
        assert.deepEqual(diffSequence(observed, WEB_BOOT), ['login-info: query "enc_ver" is "v1", expected "v2"']);
    });

    it("lets a long poll repeat, and still checks every repeat", () => {
        const observed = sequenceOf(WEB_QR_LOGIN);
        const scan = observed.findIndex((c) => c.path.endsWith("/waiting-scan"));
        observed.splice(scan + 1, 0, structuredClone(observed[scan]), structuredClone(observed[scan]));
        assert.deepEqual(diffSequence(observed, WEB_QR_LOGIN, opts), []);

        delete observed[scan + 2].form.code;
        assert.deepEqual(diffSequence(observed, WEB_QR_LOGIN, opts), ['waiting-scan: form key "code" is missing']);
    });

    it("reports a missing form key on a POST", () => {
        const observed = sequenceOf(WEB_QR_LOGIN);
        delete observed[4].form.bundle;
        assert.deepEqual(diffSequence(observed, WEB_QR_LOGIN, opts), ['waiting-confirm: form key "bundle" is missing']);
    });

    it("reports a call that was never made", () => {
        const observed = sequenceOf(WEB_LOGOUT).filter((c) => c.path !== "/jr/logout-token");
        assert.deepEqual(diffSequence(observed, WEB_LOGOUT, opts), ["logout-token: the call was never made"]);
    });

    it("reports a call made out of order", () => {
        const observed = sequenceOf(WEB_BOOT);
        [observed[0], observed[1]] = [observed[1], observed[0]];
        const found = diffSequence(observed, WEB_BOOT);
        assert.ok(
            found.some((m) => /made out of order/.test(m)),
            `an out-of-order sequence was accepted: ${JSON.stringify(found)}`,
        );
    });

    it("reports a call made twice where the sequence has it once", () => {
        const observed = sequenceOf(WEB_LOGOUT);
        observed.push(structuredClone(observed[0]));
        const found = diffSequence(observed, WEB_LOGOUT, opts);
        assert.deepEqual(found, ["logout-token: made again (call #8), the sequence has it once per step"]);
    });

    it("tells a wrong host from a right one", () => {
        const observed = sequenceOf(WEB_LOGOUT);
        observed[2].host = "wpa.chat.zalo.me"; // the v2 logout belongs on the stg-wpa host
        assert.deepEqual(diffSequence(observed, WEB_LOGOUT, opts), [
            "v2 logout: sent to wpa.chat.zalo.me, expected stg-wpa.chat.zalo.me",
        ]);
    });

    it("reports a forbidden call, counting it", () => {
        const observed = [
            ...sequenceOf(WEB_LOGOUT),
            { method: "GET", host: "wpa.chat.zalo.me", path: "/api/login/logOut", query: {}, form: null },
        ];
        assert.deepEqual(diffSequence(observed, WEB_LOGOUT, { ...opts, forbidden: WEB_LOGOUT_FORBIDDEN }), [
            "forbidden call wpa.chat.zalo.me/api/login/logOut was made 1 time(s)",
        ]);
        const login = [
            ...sequenceOf(WEB_QR_LOGIN),
            { method: "POST", host: "id.zalo.me", path: "/verify-client", query: {}, form: {} },
        ];
        assert.equal(diffSequence(login, WEB_QR_LOGIN, { ...opts, forbidden: WEB_QR_LOGIN_FORBIDDEN }).length, 1);
    });

    it("compares a frame body level by level", () => {
        const good = {
            data: {
                syncId: "s",
                syncType: 0,
                ek: "e",
                ik: "i",
                toDevice: 0,
                tempKey: "",
                deviceName: "d",
                req: { type: "message", priority: 2, queries: [], batchSize: 1 },
                ver: 1,
                ussidx: 0,
            },
            reqId: "r",
        };
        assert.deepEqual(diffBody(good, WEB_FRAMES["590"], "590"), []);

        const drifted = structuredClone(good);
        delete drifted.reqId;
        delete drifted.data.ussidx;
        drifted.data.syncType = 1;
        delete drifted.data.req.batchSize;
        assert.deepEqual(diffBody(drifted, WEB_FRAMES["590"], "590"), [
            '590: key "reqId" is missing',
            '590.data: key "ussidx" is missing',
            '590.data: "syncType" is 1, expected 0',
            '590.data.req: key "batchSize" is missing',
        ]);
    });

    it("assertConforms fails with every mismatch in one message", () => {
        assert.doesNotThrow(() => assertConforms([]));
        assert.throws(
            () => assertConforms(["a: bad", "b: worse"], "the login"),
            (e) => {
                return (
                    /the login do not conform/.test(e.message) && /a: bad/.test(e.message) && /b: worse/.test(e.message)
                );
            },
        );
    });
});

describe("replay harness: today's code against the official Web client", () => {
    let zalo;
    let api;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        zalo = await startFakeZalo();
        installQueuePulls(zalo.sock);
        api = await zalo.login();
    });

    after(async () => {
        if (api?.listener?.ws) {
            api.listener.on("error", () => {});
            api.listener.stop();
        }
        await zalo.stop();
    });

    describe("login", () => {
        it("differs from the official boot in exactly these ways (L2a-L2b move this to none)", () => {
            const loginCalls = zalo.http.requests.slice();
            assert.deepEqual(diffSequence(loginCalls, WEB_BOOT), [
                'server-info (first): query key "sp_mtn" is missing',
                'server-info (first): query key "bkt" is missing',
                "login-info: made out of order (call #2, before its place in the sequence)",
                'login-info: query key "zpw_ver" must not be sent',
                'login-info: query key "zpw_type" must not be sent',
                "server-info (second): the call was never made",
            ]);
        });

        it(
            "conforms to the official boot",
            { todo: "L2a-L2b (P2): getServerInfo twice, getLoginInfo without zpw_ver/zpw_type" },
            () => {
                assertConforms(diffSequence(zalo.http.requests.slice(), WEB_BOOT), "today's login calls");
            },
        );
    });

    describe("logout", () => {
        let calls;
        before(async () => {
            zalo.http.requests.length = 0;
            await serverLogout(api); // the fake answers 404 to all of it: only what is SENT matters here
            calls = zalo.http.requests.slice();
        });

        it("differs from the official sequence in exactly these ways (L13a-c / X1 move this to none)", () => {
            assert.deepEqual(
                diffSequence(calls, WEB_LOGOUT, { hostOf: serviceHost, forbidden: WEB_LOGOUT_FORBIDDEN }),
                [
                    "logout-token: the call was never made",
                    "profile deactive: the call was never made",
                    "account logout: the call was never made",
                    "setsid (zaloapp): the call was never made",
                    "setsid (chat): the call was never made",
                    "login page: the call was never made",
                    "forbidden call wpa.chat.zalo.me/api/login/logOut was made 1 time(s)",
                ],
            );
        });

        it("sends the v2 logout the way the official client does (this part already conforms)", () => {
            const v2 = calls.filter((c) => c.path === "/api/v2/login/logOut");
            assert.equal(v2.length, 1);
            assert.equal(v2[0].host, "stg-wpa.chat.zalo.me");
            assert.equal(v2[0].method, "POST");
            assert.deepEqual(Object.keys(v2[0].form), ["params"]);
        });

        it(
            "conforms to the official logout",
            { todo: "L13a-c / X1 (P2): the verified 6-step sequence, no production GET logOut" },
            () => {
                assertConforms(
                    diffSequence(calls, WEB_LOGOUT, { hostOf: serviceHost, forbidden: WEB_LOGOUT_FORBIDDEN }),
                    "today's logout calls",
                );
            },
        );
    });

    describe("socket frames", () => {
        before(async () => {
            const connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
        });

        it("sends a transfer-sync request (590) of the official shape", async () => {
            const key = { publicKey: Buffer.alloc(32, 1) };
            SyncV2.prototype._send590.call({}, api.listener, "msg", "abcdef123456", key, key, {
                type: "message",
                priority: 2,
                queries: [{}],
                batchSize: 2000,
            });
            const frame = await zalo.sock.waitFor((f) => f.cmd === 590);
            assertConforms(diffBody(frame.data, WEB_FRAMES["590"], "590"), "the 590 request");
        });

        it("sends a transfer-sync dispose (591) of the official shape", async () => {
            SyncV2.prototype._dispose.call({}, api.listener, "abcdef123456");
            const frame = await zalo.sock.waitFor((f) => f.cmd === 591);
            assertConforms(diffBody(frame.data, WEB_FRAMES["591"], "591"), "the 591 request");
        });

        it("sends the old-message pull (510) differing in exactly one key: req_id for reqId", async () => {
            api.listener.requestOldMessages(0, null);
            const frame = await zalo.sock.waitFor((f) => f.cmd === 510);
            assert.deepEqual(diffBody(frame.data, WEB_FRAMES.pull, "510"), ['510: key "reqId" is missing']);
            assert.match(frame.data.req_id, /^req_\d+$/, "zca-js's own key is gone: this pin needs a second look");
        });

        it(
            "sends the old-message pull the official way",
            { todo: "X5 (P3): our own socket layer sends reqId" },
            async () => {
                const frame = zalo.sock.framesOf(510, 1).at(-1);
                assertConforms(diffBody(frame.data, WEB_FRAMES.pull, "510"), "the 510 pull");
            },
        );
    });
});
