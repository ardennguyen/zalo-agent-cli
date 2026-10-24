/**
 * The default `logout`: Zalo Web's own six steps (src/zalo/official-logout.js), then a look at whether the
 * device is really signed out (src/core/logout.js, plan items L13a-c and X1).
 *
 * What is asserted is what goes over the wire against the offline fake Zalo, and what the result says:
 * the order and shape of the calls (also checked against the official shape in replay-harness.test.js),
 * that the production `GET logOut` is gone, that a failing step does not stop the others, that only known
 * hosts' `setsid` URLs are followed, and that "signed out" is claimed only for a saved login Zalo then refused.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { describeLogout, serverLogout } from "../../src/core/logout.js";
import { setsidUrlsOf } from "../../src/zalo/official-logout.js";
import { clearSession } from "../../src/core/zalo-client.js";
import { FAKE, FAKE_CREDENTIALS, installFakeZalo, loginFake, serveOfficialLogout } from "./fake-zalo-session.js";

const CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const saved = (over = {}) => ({
    creds: { ...structuredClone(FAKE_CREDENTIALS), userAgent: CHROME_UA },
    proxy: null,
    ownId: FAKE.ownId,
    ...over,
});
const hosts = (fake) => fake.requests.map((r) => `${r.method} ${r.host}${r.path}`);

describe("the official logout", () => {
    let fake;
    let api;

    before(() => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
    });

    beforeEach(async () => {
        fake = installFakeZalo();
        api = await loginFake();
        fake.requests.length = 0;
    });

    afterEach(() => {
        clearSession();
        fake.uninstall();
    });

    it("makes the six official calls in order, and never the production GET logOut", async () => {
        serveOfficialLogout(fake);
        await serverLogout(api, { probeLogin: async () => "revoked" });
        const calls = hosts(fake).filter((c) => !c.includes("/api/social/profile/me-v2"));
        assert.deepEqual(calls, [
            "POST id.zalo.me/jr/logout-token",
            "GET profile.zalo.invalid/api/social/profile/deactive",
            "POST stg-wpa.chat.zalo.me/api/v2/login/logOut",
            "POST id.zalo.me/account/logout",
            "GET jr.zaloapp.com/jr/setsid",
            "GET jr.chat.zalo.me/jr/setsid",
            "GET id.zalo.me/account",
        ]);
        assert.ok(!calls.some((c) => c.includes("wpa.chat.zalo.me/api/login/logOut") && !c.includes("stg-")));
    });

    it("sends the form fields and encrypted parameters each step needs", async () => {
        serveOfficialLogout(fake, { token: "tok-xyz" });
        await serverLogout(api, { probeLogin: async () => "revoked" });
        const by = (path) => fake.requests.find((r) => r.path === path);
        assert.deepEqual(by("/jr/logout-token").form, { continue: "https://chat.zalo.me/" });
        assert.deepEqual(by("/api/social/profile/deactive").params, { imei: FAKE_CREDENTIALS.imei });
        const v2 = by("/api/v2/login/logOut").params;
        assert.deepEqual(Object.keys(v2).sort(), ["computer_name", "imei", "time"]);
        assert.equal(v2.computer_name, "Web");
        assert.ok(v2.time < 1e11, "time is unix seconds, not milliseconds");
        assert.deepEqual(by("/account/logout").form, { token: "tok-xyz" });
        assert.equal(by("/account").query.continue, "https://chat.zalo.me/");
    });

    it("sends script calls as a script and page loads as a browser navigating", async () => {
        serveOfficialLogout(fake);
        await serverLogout(api, { probeLogin: async () => "revoked" });
        const by = (path) => fake.requests.find((r) => r.path === path);
        // zca-js merges headers by key: one spelling each, or a real fetch would join two values into one
        assert.equal(by("/jr/logout-token").headers.origin, "https://chat.zalo.me");
        assert.equal(by("/jr/logout-token").headers.referer, "https://chat.zalo.me/");
        assert.equal(by("/jr/logout-token").headers.accept, "application/json, text/plain, */*");
        assert.equal(by("/account/logout").headers.origin, "https://id.zalo.me");
        assert.equal(by("/account/logout").headers.referer, "https://id.zalo.me/");
        assert.ok(!by("/account/logout").headers.accept.includes("application/json"), "a page load asks for a page");
        assert.equal(by("/jr/logout-token").headers["sec-fetch-mode"], "cors");
        assert.equal(by("/jr/logout-token").headers["sec-fetch-dest"], "empty");
        for (const path of ["/account/logout", "/jr/setsid", "/account"]) {
            const h = by(path).headers;
            assert.equal(h["sec-fetch-mode"], "navigate", path);
            assert.equal(h["sec-fetch-dest"], path === "/jr/setsid" ? "iframe" : "document", path);
            assert.equal(h["upgrade-insecure-requests"], "1", path);
            assert.equal(h.priority, "u=0, i", path);
        }
        assert.equal(by("/jr/setsid").headers["sec-fetch-site"], "cross-site");
    });

    it("keeps going when a step fails, and skips only what needs what that step gave", async () => {
        serveOfficialLogout(fake, { token: null });
        const r = await serverLogout(api, { probeLogin: async () => "unverified" });
        const failed = r.steps.filter((s) => !s.ok).map((s) => s.id);
        assert.deepEqual(failed, ["logout-token", "account logout"]);
        const calls = hosts(fake);
        assert.ok(calls.includes("GET profile.zalo.invalid/api/social/profile/deactive"), "the key is still ended");
        assert.ok(calls.includes("POST stg-wpa.chat.zalo.me/api/v2/login/logOut"));
        assert.ok(!calls.includes("POST id.zalo.me/account/logout"), "no token: no id-domain logout");
        assert.ok(calls.includes("GET id.zalo.me/account"), "the login page is still loaded");
    });

    it("records a step that throws and carries on", async () => {
        serveOfficialLogout(fake);
        // the failing route goes first: the first raw route that matches answers
        fake.clearRoutes();
        fake.rawRoute(
            (r) => r.path === "/jr/logout-token",
            () => {
                throw new Error("connection reset");
            },
        );
        serveOfficialLogout(fake);
        const r = await serverLogout(api, { probeLogin: async () => "unverified" });
        const step = r.steps.find((s) => s.id === "logout-token");
        assert.equal(step.ok, false);
        assert.match(step.error, /connection reset/);
        assert.ok(r.steps.length >= 5, "the other steps still ran");
    });

    it("follows only setsid URLs on the known hosts, over https", async () => {
        serveOfficialLogout(fake, {
            setsid: [
                "https://jr.zaloapp.com/jr/setsid?token=a",
                "https://evil.example.com/jr/setsid?token=a",
                "http://jr.chat.zalo.me/jr/setsid?token=a",
                "https://jr.chat.zalo.me/other/path?token=a",
                "https://jr.chat.zalo.me/jr/setsid?token=b",
            ],
        });
        await serverLogout(api, { probeLogin: async () => "revoked" });
        const followed = fake.requests.filter((r) => r.host.startsWith("jr.") || r.host.includes("evil"));
        assert.deepEqual(
            followed.map((r) => `${r.host}${r.path}?token=${r.query.token}`),
            ["jr.zaloapp.com/jr/setsid?token=a", "jr.chat.zalo.me/jr/setsid?token=b"],
        );
    });

    it("reads the listed URLs out of the page, unescaping the slashes", () => {
        const page = String.raw`<script>x = { listSetSidUrls: ["https:\/\/jr.zaloapp.com\/jr\/setsid?token=1", "https:\/\/jr.chat.zalo.me\/jr\/setsid?token=2"] }</script>`;
        assert.deepEqual(setsidUrlsOf(page), [
            "https://jr.zaloapp.com/jr/setsid?token=1",
            "https://jr.chat.zalo.me/jr/setsid?token=2",
        ]);
        assert.deepEqual(setsidUrlsOf("<html>no list</html>"), []);
        assert.deepEqual(setsidUrlsOf(undefined), []);
    });

    it("--keep-session is the old key-only logout: no id.zalo.me call, no saved-login probe", async () => {
        serveOfficialLogout(fake);
        let probed = false;
        const r = await serverLogout(api, {
            keepSession: true,
            savedLogin: saved(),
            probeLogin: async () => {
                probed = true;
                return "revoked";
            },
        });
        assert.equal(r.mode, "key-only");
        assert.equal(probed, false);
        assert.ok(!fake.requests.some((q) => q.host === "id.zalo.me"));
        assert.ok(fake.requests.some((q) => q.host === "wpa.chat.zalo.me" && q.path === "/api/login/logOut"));
    });

    describe("what it claims", () => {
        it("signed out only when the saved login is then refused", async () => {
            serveOfficialLogout(fake);
            const r = await serverLogout(api, { savedLogin: saved(), probeLogin: async () => "revoked" });
            assert.equal(r.mode, "official");
            assert.equal(r.login, "revoked");
            assert.deepEqual(
                describeLogout(r).map((l) => l.level),
                ["success"],
            );
        });

        it("a saved login that still works is a warning that points at the phone", async () => {
            serveOfficialLogout(fake);
            const r = await serverLogout(api, { savedLogin: saved(), probeLogin: async () => "still-valid" });
            const lines = describeLogout(r);
            assert.ok(!lines.some((l) => l.level === "success"));
            assert.ok(lines.some((l) => l.level === "warning" && /phone's list/.test(l.text)));
        });

        it("says it could not check when there is no saved login to try, and never claims success", async () => {
            serveOfficialLogout(fake);
            let tried = false;
            const r = await serverLogout(api, {
                savedLogin: null,
                probeLogin: async () => {
                    tried = true;
                    return "revoked";
                },
            });
            assert.equal(tried, false);
            assert.equal(r.login, "unverified");
            assert.ok(!describeLogout(r).some((l) => l.level === "success"));
        });

        it("lists each failed step as a warning", async () => {
            serveOfficialLogout(fake, { token: null });
            const r = await serverLogout(api, { savedLogin: saved(), probeLogin: async () => "revoked" });
            const warnings = describeLogout(r).filter((l) => l.level === "warning");
            assert.deepEqual(
                warnings.map((l) => l.text.match(/step "([^"]+)"/)?.[1]),
                ["logout-token", "account logout"],
            );
        });

        it("a session key that still answers is warned about when the saved login could not be checked", async () => {
            serveOfficialLogout(fake);
            fake.route("/api/social/profile/me-v2", () => ({ profile: {} }));
            const r = await serverLogout(api, { probeLogin: async () => "unverified" });
            assert.equal(r.key.verdict, "still-answers");
            assert.ok(describeLogout(r).some((l) => l.level === "warning" && /still answers/.test(l.text)));
        });
    });

    describe("the saved-login probe", () => {
        it("tries the saved login in a login of its own: refused is 'revoked'", async () => {
            serveOfficialLogout(fake);
            const kicked = { body: { error_code: 600, error_message: "", data: null } };
            fake.uninstall();
            fake = installFakeZalo({ loginScript: [kicked] });
            serveOfficialLogout(fake);
            const r = await serverLogout(api, { savedLogin: saved() });
            assert.equal(r.login, "revoked");
            const probe = fake.requests.filter((q) => q.path.startsWith("/api/login/"));
            assert.deepEqual(
                probe.map((q) => q.path),
                ["/api/login/getServerInfo", "/api/login/getLoginInfo"],
            );
            assert.equal(probe[0].headers["user-agent"], CHROME_UA, "with the saved identity, not ours");
        });

        it("a server-info answer of 600 is a refusal too, whatever its wording", async () => {
            serveOfficialLogout(fake);
            fake.uninstall();
            fake = installFakeZalo({
                serverInfoScript: [{ body: { error_code: 600, error_message: "x", data: null } }],
            });
            serveOfficialLogout(fake);
            const r = await serverLogout(api, { savedLogin: saved() });
            assert.equal(r.login, "revoked");
        });

        it("error 102 from the login, as Zalo answered the saved cookie after a real logout, is a refusal", async () => {
            serveOfficialLogout(fake);
            fake.uninstall();
            fake = installFakeZalo({
                loginScript: [
                    {
                        sealedEnvelope: {
                            error_code: 102,
                            error_message: "The session key was improperly submitted or has reached its timeout.",
                            data: null,
                        },
                    },
                ],
            });
            serveOfficialLogout(fake);
            const r = await serverLogout(api, { savedLogin: saved() });
            assert.equal(r.login, "revoked");
        });

        it("error 102 from server info is a refusal too, whatever its wording", async () => {
            serveOfficialLogout(fake);
            fake.uninstall();
            fake = installFakeZalo({
                serverInfoScript: [{ body: { error_code: 102, error_message: "x", data: null } }],
            });
            serveOfficialLogout(fake);
            const r = await serverLogout(api, { savedLogin: saved() });
            assert.equal(r.login, "revoked");
        });

        it("an accepted login is 'still-valid', and leaves no session behind", async () => {
            serveOfficialLogout(fake);
            const r = await serverLogout(api, { savedLogin: saved() });
            assert.equal(r.login, "still-valid");
        });

        it("a network failure proves nothing: 'unverified'", async () => {
            serveOfficialLogout(fake);
            const real = globalThis.fetch;
            globalThis.fetch = async (url, init) => {
                if (new URL(String(url)).pathname.startsWith("/api/login/")) throw new Error("fetch failed");
                return real(url, init);
            };
            try {
                const r = await serverLogout(api, { savedLogin: saved() });
                assert.equal(r.login, "unverified");
            } finally {
                globalThis.fetch = real;
            }
        });
    });
});
