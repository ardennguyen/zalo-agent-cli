/**
 * Asking Zalo why a session ended (src/zalo/kickout.js), through the real zca-js
 * request path against the fake server.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fetchKickoutInfo, kickoutKeysOf } from "../../src/zalo/kickout.js";
import { encryptZCloud } from "../../src/core/sync-v2/zcloud-cipher.js";
import { FAKE, installFakeZalo, loginFake, serviceHost } from "./fake-zalo-session.js";

const zu = createRequire(import.meta.url)(join(dirname(createRequire(import.meta.url).resolve("zca-js")), "utils.cjs"));

describe("fetchKickoutInfo", () => {
    let fake;
    let api;
    const ZC = { viewer_key: "viewer-key-fake", enk: Buffer.alloc(16, 3).toString("base64") };
    const KEYS = { viewerKey: ZC.viewer_key, enk: ZC.enk };

    beforeEach(async () => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        fake = installFakeZalo({ zcloud: ZC });
        api = await loginFake();
        fake.requests.length = 0;
    });
    afterEach(() => fake.uninstall());

    /** Answer the lookup the way Zalo does: sealed with enk, not with the session key. */
    const seal = {
        zcloud: (json, key) => encryptZCloud(json, key),
        session: (json, key) => zu.encodeAES(key, json),
    };
    const answerSealed = (data, key = ZC.enk, cipher = "zcloud") =>
        fake.rawRoute(
            (r) => r.path === "/api/session/kickout-info",
            () =>
                new Response(
                    JSON.stringify({ error_code: 0, data: seal[cipher](JSON.stringify({ error_code: 0, data }), key) }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
        );

    it("posts the viewer key as the token to the aext host, and returns what Zalo says, opened with enk", async () => {
        answerSealed({ reason: "another-device", at: 1 });
        const info = await fetchKickoutInfo(api, KEYS);
        assert.deepEqual(info, { reason: "another-device", at: 1 });
        const [call] = fake.calls("/api/session/kickout-info");
        assert.equal(call.method, "POST");
        assert.equal(call.host, serviceHost("aext"));
        assert.deepEqual(call.form, { token: "viewer-key-fake" });
        assert.equal(call.query.zpw_type, "30");
        assert.ok(call.query.zpw_ver);
    });

    it("opens an answer sealed in the session cipher's shape with enk too", async () => {
        answerSealed({ reason: "another-device" }, ZC.enk, "session");
        assert.deepEqual(await fetchKickoutInfo(api, KEYS), { reason: "another-device" });
    });

    it("cannot open an answer sealed with another key: the key is enk, not the session key", async () => {
        answerSealed({ reason: "x" }, FAKE.sessionKey);
        assert.equal(await fetchKickoutInfo(api, KEYS), null);
    });

    it("reads the keys from the session the login built (L12b)", () => {
        assert.deepEqual(kickoutKeysOf(api), KEYS);
    });

    it("takes the keys from the login info when that is where the server put them", async () => {
        fake.uninstall();
        fake = installFakeZalo({ loginZcloud: ZC });
        const viaLogin = await loginFake();
        assert.deepEqual(kickoutKeysOf(viaLogin), KEYS);
    });

    it("has no keys when the server-info answer carried none, and then does not call out at all", async () => {
        fake.uninstall();
        fake = installFakeZalo();
        const bare = await loginFake();
        fake.requests.length = 0;
        assert.equal(kickoutKeysOf(bare), null);
        assert.equal(await fetchKickoutInfo(bare, kickoutKeysOf(bare)), null);
        assert.equal(fake.calls("/api/session/kickout-info").length, 0);
    });

    it("does not call out at all without both keys: it will not guess one", async () => {
        for (const none of [undefined, null, {}, { viewerKey: "k" }, { enk: "e" }, { viewerKey: "", enk: "e" }, "k"]) {
            assert.equal(await fetchKickoutInfo(api, none), null);
        }
        assert.equal(fake.calls("/api/session/kickout-info").length, 0);
    });

    it("returns null, never throws, when the reason cannot be learned", async () => {
        // The fake answers 404 to a route nobody registered.
        assert.equal(await fetchKickoutInfo(api, KEYS), null);
        fake.rawRoute(
            (r) => r.path === "/api/session/kickout-info",
            () => {
                throw new Error("boom");
            },
        );
        assert.equal(await fetchKickoutInfo(api, KEYS), null);
    });

    it("returns null when the sealed answer says error, or is not an object", async () => {
        fake.rawRoute(
            (r) => r.path === "/api/session/kickout-info",
            () =>
                new Response(
                    JSON.stringify({
                        error_code: 0,
                        data: zu.encodeAES(ZC.enk, JSON.stringify({ error_code: 5, data: null })),
                    }),
                    { status: 200 },
                ),
        );
        assert.equal(await fetchKickoutInfo(api, KEYS), null);
    });

    it("returns null when there is no aext host to ask", async () => {
        // zca-js cannot build an API without the host, so take it away after login.
        api.getContext().loginInfo.zpw_service_map_v3.aext = [];
        assert.equal(await fetchKickoutInfo(api, KEYS), null);
        assert.equal(fake.calls("/api/session/kickout-info").length, 0);
    });
});
