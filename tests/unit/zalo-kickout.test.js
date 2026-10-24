/**
 * Asking Zalo why a session ended (src/zalo/kickout.js), through the real zca-js
 * request path against the fake server.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { fetchKickoutInfo } from "../../src/zalo/kickout.js";
import { installFakeZalo, loginFake, serviceHost } from "./fake-zalo-session.js";

describe("fetchKickoutInfo", () => {
    let fake;
    let api;

    beforeEach(async () => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        fake = installFakeZalo();
        api = await loginFake();
        fake.requests.length = 0;
    });
    afterEach(() => fake.uninstall());

    it("posts the token as a form field to the aext host, and returns what Zalo says", async () => {
        fake.route("/api/session/kickout-info", () => ({ reason: "another-device", at: 1 }));
        const info = await fetchKickoutInfo(api, "viewer-key-fake");
        assert.deepEqual(info, { reason: "another-device", at: 1 });
        const [call] = fake.calls("/api/session/kickout-info");
        assert.equal(call.method, "POST");
        assert.equal(call.host, serviceHost("aext"));
        assert.deepEqual(call.form, { token: "viewer-key-fake" });
        assert.equal(call.query.zpw_type, "30");
        assert.ok(call.query.zpw_ver);
    });

    it("does not call out at all without a token: it will not guess one", async () => {
        for (const none of [undefined, null, "", 5]) assert.equal(await fetchKickoutInfo(api, none), null);
        assert.equal(fake.calls("/api/session/kickout-info").length, 0);
    });

    it("returns null, never throws, when the reason cannot be learned", async () => {
        // The fake answers 404 to a route nobody registered.
        assert.equal(await fetchKickoutInfo(api, "viewer-key-fake"), null);
        fake.route("/api/session/kickout-info", () => {
            throw new Error("boom");
        });
        assert.equal(await fetchKickoutInfo(api, "viewer-key-fake"), null);
        fake.route("/api/session/kickout-info", () => "not an object");
        assert.equal(await fetchKickoutInfo(api, "viewer-key-fake"), null);
    });

    it("returns null when there is no aext host to ask", async () => {
        // zca-js cannot build an API without the host, so take it away after login.
        api.getContext().loginInfo.zpw_service_map_v3.aext = [];
        assert.equal(await fetchKickoutInfo(api, "viewer-key-fake"), null);
        assert.equal(fake.calls("/api/session/kickout-info").length, 0);
    });
});
