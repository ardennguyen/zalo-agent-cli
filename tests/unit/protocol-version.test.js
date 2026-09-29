/**
 * The protocol version this CLI announces to Zalo.
 *
 * zca-js defaults to zpw_ver=685 (`createContext(apiType = 30, apiVersion =
 * 685)`, zca-js dist/context.js); the live Zalo Web client sends 691 on every
 * URL (agent/work/zalo-web-capture-2026-09-29: FINDINGS.md §7, comparison
 * §3g). `createZalo()` now asks for 691, overridable with ZALO_API_VERSION so
 * a bad bump can be rolled back without a release.
 *
 * Asserted on the wire, through a real login against ./fake-zalo-session.js --
 * never by reading the options object back:
 *   - getLoginInfo carries it as zpw_ver AND client_version,
 *   - getServerInfo carries it as client_version,
 *   - an ordinary API call carries it as zpw_ver,
 *   - the WebSocket URL the listener would dial carries it as zpw_ver
 *     (computed when the session is built; nothing is dialed here).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR, saveCredentials } from "../../src/core/credentials.js";
import { addAccount } from "../../src/core/accounts.js";
import { autoLogin, clearSession, isLoggedIn } from "../../src/core/zalo-client.js";
import { FAKE, FAKE_CREDENTIALS, installFakeZalo, loginFake } from "./fake-zalo-session.js";

/** Log in, make one API call, and collect every place the version travels. */
async function announced(fake) {
    const api = await loginFake();
    fake.route("/api/social/profile/me-v2", () => ({ profile: {} }));
    await api.fetchAccountInfo();
    const loginInfo = fake.calls("/api/login/getLoginInfo").at(-1);
    const serverInfo = fake.calls("/api/login/getServerInfo").at(-1);
    const apiCall = fake.calls("/api/social/profile/me-v2").at(-1);
    return {
        loginZpwVer: loginInfo.query.zpw_ver,
        loginZpwType: loginInfo.query.zpw_type,
        loginClientVersion: loginInfo.query.client_version,
        serverClientVersion: serverInfo.query.client_version,
        apiZpwVer: apiCall.query.zpw_ver,
        apiZpwType: apiCall.query.zpw_type,
        socketZpwVer: new URL(api.listener.wsURL).searchParams.get("zpw_ver"),
    };
}

const everywhere = (v) => ({
    loginZpwVer: v,
    loginZpwType: "30",
    loginClientVersion: v,
    serverClientVersion: v,
    apiZpwVer: v,
    apiZpwType: "30",
    socketZpwVer: v,
});

describe("protocol version (zpw_ver / client_version)", () => {
    let fake;
    const saved = process.env.ZALO_API_VERSION;

    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1"; // keeps zca-js's login logging off stdout
        fake = installFakeZalo();
    });

    after(() => fake.uninstall());

    beforeEach(() => {
        fake.requests.length = 0;
        delete process.env.ZALO_API_VERSION;
    });

    afterEach(() => {
        if (saved === undefined) delete process.env.ZALO_API_VERSION;
        else process.env.ZALO_API_VERSION = saved;
    });

    it("announces 691, the live Zalo Web version, by default", async () => {
        assert.deepEqual(await announced(fake), everywhere("691"));
    });

    it("announces ZALO_API_VERSION instead when it is set", async () => {
        process.env.ZALO_API_VERSION = "700";
        assert.deepEqual(await announced(fake), everywhere("700"));
    });

    it("can roll back to zca-js's 685", async () => {
        process.env.ZALO_API_VERSION = "685";
        assert.deepEqual(await announced(fake), everywhere("685"));
    });

    it("treats an empty ZALO_API_VERSION as unset", async () => {
        process.env.ZALO_API_VERSION = "  ";
        assert.deepEqual(await announced(fake), everywhere("691"));
    });

    it("refuses anything but a positive whole number, naming the variable, before any request", async () => {
        for (const bad of ["69l", "6.91", "0", "-685", "685abc", "1e3", "0x2b3", "latest"]) {
            fake.requests.length = 0;
            process.env.ZALO_API_VERSION = bad;
            await assert.rejects(
                loginFake(),
                (e) => e.message.includes("ZALO_API_VERSION") && e.message.includes(`"${bad}"`),
                `ZALO_API_VERSION=${bad} was not refused with a message naming it`,
            );
            assert.deepEqual(
                fake.requests.map((r) => `${r.host}${r.path}`),
                [],
                `ZALO_API_VERSION=${bad} still reached the network`,
            );
        }
    });

    it("autoLogin blames a bad ZALO_API_VERSION on the setting, not on a revoked session", async () => {
        // Every command logs in through autoLogin(), which adds a "this session
        // was revoked" hint when the error text matches /600/ among others. A
        // mistyped version containing "600" must not send someone to re-login.
        addAccount(FAKE.ownId, "Offline test account");
        saveCredentials(FAKE.ownId, structuredClone(FAKE_CREDENTIALS));
        clearSession();
        process.env.ZALO_API_VERSION = "6001x";

        const lines = [];
        const saved = console.error;
        console.error = (...a) => lines.push(a.join(" "));
        try {
            await autoLogin(true);
        } finally {
            console.error = saved;
        }

        const text = lines.join("\n");
        assert.match(text, /AutoLogin failed: ZALO_API_VERSION must be a positive whole number/);
        assert.doesNotMatch(text, /revoked/, "a bad setting was reported as a revoked session");
        assert.equal(isLoggedIn(), false);
        assert.deepEqual(fake.requests, [], "a bad ZALO_API_VERSION still reached the network");
    });
});
