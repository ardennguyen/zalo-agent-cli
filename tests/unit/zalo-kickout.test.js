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
import { describeKickout, fetchKickoutInfo, kickoutKeysOf, lookupKickout } from "../../src/zalo/kickout.js";
import { encryptZCloud } from "../../src/core/sync-v2/zcloud-cipher.js";
import { FAKE, installFakeZalo, loginFake, serviceHost } from "./fake-zalo-session.js";

const zu = createRequire(import.meta.url)(join(dirname(createRequire(import.meta.url).resolve("zca-js")), "utils.cjs"));

describe("fetchKickoutInfo", () => {
    let fake;
    let api;
    // What getLoginInfo carries as `auth_ext_info`: a long viewer key and a 24-character base64 AES-128 key.
    const ZC = { viewer_key: "viewer-key-fake", enk: Buffer.alloc(16, 3).toString("base64") };
    const KEYS = { viewerKey: ZC.viewer_key, enk: ZC.enk };
    // A real answer's data: the source of the kick and the second it happened.
    const KICK = { kickoutSrc: 2, kickoutTs: 1793000613 };

    beforeEach(async () => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        fake = installFakeZalo({ authExtInfo: ZC });
        api = await loginFake();
        fake.requests.length = 0;
    });
    afterEach(() => fake.uninstall());

    /** Answer the lookup the way Zalo does: sealed with enk, in the session cipher's shape; not with the session key. */
    const seal = {
        zcloud: (json, key) => encryptZCloud(json, key),
        session: (json, key) => zu.encodeAES(key, json),
    };
    const answerSealed = (data, key = ZC.enk, cipher = "session") =>
        fake.rawRoute(
            (r) => r.path === "/api/session/kickout-info",
            () =>
                new Response(
                    JSON.stringify({ error_code: 0, data: seal[cipher](JSON.stringify({ error_code: 0, data }), key) }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
        );

    it("posts the viewer key as the token to the aext host, and returns what Zalo says, opened with enk", async () => {
        answerSealed(KICK);
        const info = await fetchKickoutInfo(api, KEYS);
        assert.deepEqual(info, KICK);
        const [call] = fake.calls("/api/session/kickout-info");
        assert.equal(call.method, "POST");
        assert.equal(call.host, serviceHost("aext"));
        assert.deepEqual(call.form, { token: "viewer-key-fake" });
        assert.equal(call.query.zpw_type, "30");
        assert.ok(call.query.zpw_ver);
    });

    it("opens an answer sealed in zCloud's shape (a random IV in front) with enk too", async () => {
        answerSealed(KICK, ZC.enk, "zcloud");
        assert.deepEqual(await fetchKickoutInfo(api, KEYS), KICK);
    });

    it("cannot open an answer sealed with another key: the key is enk, not the session key", async () => {
        answerSealed({ reason: "x" }, FAKE.sessionKey);
        assert.equal(await fetchKickoutInfo(api, KEYS), null);
    });

    it("reads the keys from the session the login built (L12b)", () => {
        assert.deepEqual(kickoutKeysOf(api), KEYS);
    });

    it("ignores the zCloud key pair: it is another key, and Zalo answers error 112 to it", async () => {
        fake.uninstall();
        fake = installFakeZalo({ extraLoginInfo: { zcloud: { viewer_key: "z".repeat(216), enk: "e".repeat(44) } } });
        const other = await loginFake();
        assert.equal(kickoutKeysOf(other), null);
    });

    it("has no keys when the login answer carried no auth_ext_info, and then does not call out at all", async () => {
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

    it("lookupKickout adds the server's words to what Zalo answered, from the session's own settings", async () => {
        fake.uninstall();
        fake = installFakeZalo({
            authExtInfo: ZC,
            settings: {
                features: {
                    kick_out_config: {
                        2: { title: { en: "Device changed" }, content: [{ en: "You logged in on another browser." }] },
                    },
                },
            },
        });
        const withWords = await loginFake();
        answerSealed(KICK);
        const got = await lookupKickout(withWords);
        assert.deepEqual(got, {
            ...KICK,
            src: 2,
            at: "2026-10-26T07:43:33.000Z",
            title: "Device changed",
            text: "You logged in on another browser.",
        });
    });

    it("lookupKickout is null when there is nothing to say, and does not call out without keys", async () => {
        fake.uninstall();
        fake = installFakeZalo();
        const bare = await loginFake();
        fake.requests.length = 0;
        assert.equal(await lookupKickout(bare), null);
        assert.equal(fake.calls("/api/session/kickout-info").length, 0);
    });

    it("returns null for Zalo's error 112 (nothing recorded for the key), the answer a wrong key gets", async () => {
        fake.rawRoute(
            (r) => r.path === "/api/session/kickout-info",
            () =>
                new Response(JSON.stringify({ error_code: 112, error_message: "No data found", data: null }), {
                    status: 200,
                }),
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

describe("describeKickout", () => {
    const settings = {
        features: {
            kick_out_config: {
                2: {
                    title: { en: "Device changed", vi: "Đổi thiết bị" },
                    content: [
                        {
                            en: "You previously logged into Zalo on a different browser.",
                            vi: "Bạn vừa đăng nhập Zalo trên một trình duyệt khác.",
                        },
                        { en: "Messages may be missing.", vi: "Có thể thiếu tin nhắn." },
                    ],
                },
            },
        },
    };

    it("gives the server's own title and text for the source, and the moment, in English", () => {
        assert.deepEqual(describeKickout({ kickoutSrc: 2, kickoutTs: 1793000613 }, settings), {
            src: 2,
            at: "2026-10-26T07:43:33.000Z",
            title: "Device changed",
            text: "You previously logged into Zalo on a different browser. Messages may be missing.",
        });
    });

    it("gives it in Vietnamese on request", () => {
        const d = describeKickout({ kickoutSrc: 2, kickoutTs: 1 }, settings, "vi");
        assert.equal(d.title, "Đổi thiết bị");
        assert.match(d.text, /^Bạn vừa đăng nhập Zalo/);
    });

    it("has no text, not an empty one, for a source whose table entry has no content", () => {
        const d = describeKickout(
            { kickoutSrc: 3 },
            { features: { kick_out_config: { 3: { title: { en: "T" }, content: [] } } } },
        );
        assert.equal(d.title, "T");
        assert.equal(d.text, null);
    });

    it("keeps the number and says nothing else for a source the server did not describe", () => {
        assert.deepEqual(describeKickout({ kickoutSrc: 9, kickoutTs: 0 }, settings), {
            src: 9,
            at: null,
            title: null,
            text: null,
        });
        assert.deepEqual(describeKickout({ kickoutSrc: 2 }, undefined), { src: 2, at: null, title: null, text: null });
        assert.deepEqual(describeKickout(null, settings), { src: null, at: null, title: null, text: null });
    });
});
