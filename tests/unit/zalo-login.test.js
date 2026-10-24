/**
 * The Web login (src/zalo/login.js, plan items L2a-e, L5, L7, L8), driven against the offline fake Zalo.
 *
 * What is asserted is what goes over the wire and what lands on disk: the order of the calls, the parameters
 * of each, the `signkey`, the stored disaster-recovery values coming back on the next login, the encryption
 * switch, the retry and the timeout, the browser headers, and the cookie write-back. The shape of the whole
 * sequence is checked against the official one in replay-harness.test.js.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR, getAccountDir, loadCredentials, saveCredentials } from "../../src/core/credentials.js";
import { loginWithCredentials, clearSession } from "../../src/core/zalo-client.js";
import {
    buildServerInfoQuery,
    createDrStore,
    drConfigOf,
    encryptionFrom,
    loginWithSession,
    RETRY_EVERY_MS,
} from "../../src/zalo/login.js";
import { browserHeadersFor, fetchSiteOf, secChUaFor, withBrowserHeaders } from "../../src/zalo/headers.js";
import { FAKE, FAKE_CREDENTIALS, installFakeZalo } from "./fake-zalo-session.js";

const require = createRequire(import.meta.url);
const zu = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));

const CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
const OPTIONS = { apiType: 30, apiVersion: 694 };
const creds = (over = {}) => ({ ...structuredClone(FAKE_CREDENTIALS), userAgent: CHROME_UA, ...over });
const drFile = () => join(getAccountDir(FAKE.ownId), "dr-config.json");
const noWait = { sleep: async () => {} };

describe("the server-info query", () => {
    it("carries -1 and -1 when nothing is stored, and a signkey over every field", () => {
        const q = buildServerInfoQuery({ imei: "i", apiType: 30, apiVersion: 694 });
        assert.deepEqual(Object.keys(q), [
            "imei",
            "type",
            "client_version",
            "computer_name",
            "sp_mtn",
            "bkt",
            "signkey",
        ]);
        assert.equal(q.sp_mtn, -1);
        assert.equal(q.bkt, -1);
        const { signkey, ...fields } = q;
        assert.equal(signkey, zu.getSignKey("getserverinfo", fields));
    });

    it("signs every field it sends, so a changed field changes the key", () => {
        const base = { imei: "i", apiType: 30, apiVersion: 694 };
        const plain = buildServerInfoQuery(base).signkey;
        assert.notEqual(buildServerInfoQuery({ ...base, dr: { supportMaintenance: 1, bucketId: 2 } }).signkey, plain);
        assert.notEqual(buildServerInfoQuery({ ...base, viewerKey: "vk" }).signkey, plain);
        assert.notEqual(buildServerInfoQuery({ ...base, floatMenuPos: true }).signkey, plain);
        // the key is the md5 the official client computes: "zsecure" + type + the values sorted by key name
        const q = buildServerInfoQuery({ ...base, viewerKey: "vk", floatMenuPos: true });
        const { signkey, ...fields } = q;
        assert.equal(signkey, zu.getSignKey("getserverinfo", fields));
        assert.equal(fields.floatMenuPos, null);
    });

    it("sends the stored values, the viewer key only when there is one, floatMenuPos only on the second call", () => {
        const q = buildServerInfoQuery({
            imei: "i",
            apiType: 30,
            apiVersion: 694,
            dr: { supportMaintenance: 1, bucketId: 7 },
            viewerKey: "vk",
        });
        assert.equal(q.sp_mtn, 1);
        assert.equal(q.bkt, 7);
        assert.equal(q.viewerKey, "vk");
        assert.equal("floatMenuPos" in q, false);
        assert.equal("viewerKey" in buildServerInfoQuery({ imei: "i", apiType: 30, apiVersion: 694 }), false);
    });
});

describe("the disaster-recovery values", () => {
    it("are read from the settings, and only when both are numbers", () => {
        assert.deepEqual(drConfigOf({ features: { dr_config: { supportMaintenance: 1, bucketId: 4 } } }), {
            supportMaintenance: 1,
            bucketId: 4,
        });
        assert.equal(drConfigOf({ features: {} }), null);
        assert.equal(drConfigOf({ features: { dr_config: { supportMaintenance: 1 } } }), null);
        assert.equal(drConfigOf(undefined), null);
    });

    it("survive in a file, and a missing or damaged file is just 'nothing stored'", () => {
        const file = join(CONFIG_DIR, "dr-store-unit.json");
        rmSync(file, { force: true });
        const store = createDrStore(file);
        assert.equal(store.load(), null);
        assert.equal(store.save({ supportMaintenance: 0, bucketId: 9 }), true);
        assert.deepEqual(store.load(), { supportMaintenance: 0, bucketId: 9 });
        rmSync(file, { force: true });
    });

    it("encryption follows authen.encryption.enable and keeps the current setting when the server says nothing", () => {
        assert.equal(encryptionFrom({ authen: { encryption: { enable: 0 } } }, true), false);
        assert.equal(encryptionFrom({ authen: { encryption: { enable: 1 } } }, false), true);
        assert.equal(encryptionFrom({}, true), true);
        assert.equal(encryptionFrom(undefined, false), false);
    });
});

describe("the login against the fake Zalo", () => {
    let fake;

    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
    });

    beforeEach(() => {
        fake?.uninstall();
        fake = null;
        rmSync(drFile(), { force: true });
        clearSession();
    });

    after(() => {
        fake?.uninstall();
        rmSync(drFile(), { force: true });
    });

    it("asks server info, login info, server info: in that order, and nothing else before the first API call", async () => {
        fake = installFakeZalo();
        await loginWithSession(creds(), OPTIONS);
        assert.deepEqual(
            fake.requests.map((r) => `${r.host}${r.path}`),
            [
                "wpa.chat.zalo.me/api/login/getServerInfo",
                "wpa.chat.zalo.me/api/login/getLoginInfo",
                "wpa.chat.zalo.me/api/login/getServerInfo",
            ],
        );
    });

    it("sends -1/-1 the first time, floatMenuPos on the second call, and no zpw_ver on any login call", async () => {
        fake = installFakeZalo();
        await loginWithSession(creds(), OPTIONS);
        const [first, login, second] = fake.requests;
        assert.equal(first.query.sp_mtn, "-1");
        assert.equal(first.query.bkt, "-1");
        assert.equal("floatMenuPos" in first.query, false);
        assert.equal(second.query.floatMenuPos, "null");
        assert.equal(login.query.enc_ver, "v2");
        assert.equal(login.query.nretry, "0");
        for (const r of [first, login, second]) {
            assert.equal("zpw_ver" in r.query, false, `${r.path} must not announce zpw_ver`);
            assert.equal("zpw_type" in r.query, false, `${r.path} must not announce zpw_type`);
        }
        // both server-info calls are signed over all of their own fields
        for (const r of [first, second]) {
            const { signkey, ...rest } = r.query;
            const typed = { ...rest, type: Number(rest.type), client_version: Number(rest.client_version) };
            if ("floatMenuPos" in typed) typed.floatMenuPos = null;
            assert.equal(signkey, zu.getSignKey("getserverinfo", typed), `${r.path} signkey`);
        }
    });

    it("takes the session's settings from the second server-info answer, not the first", async () => {
        const bare = {
            body: { error_code: 0, error_message: "", data: { settings: { marker: "first" }, extra_ver: {} } },
        };
        fake = installFakeZalo({ serverInfoScript: [bare] });
        const api = await loginWithSession(creds(), { ...OPTIONS, upkeep: false });
        const settings = api.getContext().settings;
        assert.equal(settings.marker, undefined);
        assert.ok(settings.features.sharefile, "the second answer's settings");
    });

    it("stores the server's disaster-recovery values and sends them on the next login", async () => {
        fake = installFakeZalo({ settings: { features: { dr_config: { supportMaintenance: 1, bucketId: 5 } } } });
        await loginWithCredentials(creds(), null, { ownId: FAKE.ownId });
        assert.ok(existsSync(drFile()), "dr-config.json was written in the account directory");
        assert.equal(JSON.parse(readFileSync(drFile(), "utf8")).bucketId, 5);

        fake.requests.length = 0;
        clearSession();
        await loginWithCredentials(creds(), null, { ownId: FAKE.ownId });
        const [first, , second] = fake.requests;
        assert.equal(first.query.sp_mtn, "1");
        assert.equal(first.query.bkt, "5");
        assert.equal(second.query.sp_mtn, "1");
        assert.equal(second.query.bkt, "5");
    });

    it("stores the values under the id the server returns when the caller did not know the account", async () => {
        fake = installFakeZalo({ settings: { features: { dr_config: { supportMaintenance: 0, bucketId: 2 } } } });
        await loginWithCredentials(creds(), null);
        assert.deepEqual(createDrStore(drFile()).load(), { supportMaintenance: 0, bucketId: 2 });
    });

    it("sends login parameters encrypted by default and unencrypted when the server turns encryption off", async () => {
        fake = installFakeZalo();
        await loginWithSession(creds(), OPTIONS);
        const sealed = fake.calls("getLoginInfo")[0].query;
        assert.ok(sealed.zcid && sealed.zcid_ext && sealed.params, "encrypted request");

        fake.uninstall();
        fake = installFakeZalo({ settings: { authen: { encryption: { enable: 0 } } } });
        await loginWithSession(creds(), OPTIONS);
        const plain = fake.calls("getLoginInfo")[0].query;
        assert.equal("zcid" in plain, false);
        assert.equal("params" in plain, false);
        assert.equal(plain.imei, FAKE_CREDENTIALS.imei);
        assert.equal("enc_ver" in plain, false);
    });

    it("answers error 19000 by asking again, unencrypted, once", async () => {
        fake = installFakeZalo({ loginScript: [{ body: { error_code: 19000, error_message: "", data: null } }] });
        const api = await loginWithSession(creds(), OPTIONS);
        const asks = fake.calls("getLoginInfo").map((r) => r.query);
        assert.equal(asks.length, 2);
        assert.ok(asks[0].zcid, "the first ask was encrypted");
        assert.equal("zcid" in asks[1], false, "the second ask was not");
        assert.equal(api.getOwnId(), FAKE.ownId);
    });

    it("does not loop on 19000: a second one is a refusal", async () => {
        const again = { body: { error_code: 19000, error_message: "", data: null } };
        fake = installFakeZalo({ loginScript: [again, again, again] });
        await assert.rejects(
            loginWithSession(creds(), OPTIONS),
            (e) => /Đăng nhập thất bại/.test(e.message) && e.code === 19000,
        );
        assert.equal(fake.calls("getLoginInfo").length, 2);
    });

    it("asks getLoginInfo again every 10 s while the server answers 500-504", async () => {
        fake = installFakeZalo({ loginScript: [{ status: 503 }, { status: 502 }, { status: 500 }] });
        const waits = [];
        const api = await loginWithSession(creds(), { ...OPTIONS, sleep: async (ms) => void waits.push(ms) });
        assert.deepEqual(waits, [RETRY_EVERY_MS, RETRY_EVERY_MS, RETRY_EVERY_MS]);
        assert.equal(fake.calls("getLoginInfo").length, 4);
        assert.equal(api.getOwnId(), FAKE.ownId);
    });

    it("gives up when 120 s of 500s have not helped, and says so", async () => {
        fake = installFakeZalo({ loginScript: Array.from({ length: 30 }, () => ({ status: 504 })) });
        const waits = [];
        await assert.rejects(
            loginWithSession(creds(), { ...OPTIONS, sleep: async (ms) => void waits.push(ms) }),
            /Failed to fetch login info/,
        );
        assert.equal(waits.length, 12, "twelve pauses of ten seconds make the two minutes");
    });

    it("does not retry a 4xx", async () => {
        fake = installFakeZalo({ loginScript: [{ status: 403 }] });
        await assert.rejects(loginWithSession(creds(), { ...OPTIONS, ...noWait }), /Failed to fetch login info/);
        assert.equal(fake.calls("getLoginInfo").length, 1);
    });

    it("gives up on a call that does not answer within the timeout", async () => {
        fake = installFakeZalo({ serverInfoScript: [{ hang: true }] });
        await assert.rejects(
            loginWithSession(creds(), { ...OPTIONS, ...noWait, timeoutMs: 40 }),
            /did not answer within \d+ s: \/api\/login\/getServerInfo/,
        );
    });

    it("reports error 600 from either call as code 600: another session took the account", async () => {
        const kicked = { body: { error_code: 600, error_message: "", data: null } };
        fake = installFakeZalo({ serverInfoScript: [kicked] });
        await assert.rejects(loginWithSession(creds(), { ...OPTIONS, ...noWait }), (e) => e.code === 600);
        fake.uninstall();
        fake = installFakeZalo({ loginScript: [kicked] });
        await assert.rejects(loginWithSession(creds(), { ...OPTIONS, ...noWait }), (e) => e.code === 600);
    });

    it("refuses an incomplete session before any request", async () => {
        fake = installFakeZalo();
        await assert.rejects(loginWithSession({ imei: "i", cookie: [] }, OPTIONS), /Missing required params/);
        assert.equal(fake.requests.length, 0);
    });

    it("carries the browser headers its User-Agent implies on every call", async () => {
        fake = installFakeZalo();
        await loginWithSession(creds(), OPTIONS);
        for (const r of fake.requests) {
            assert.equal(r.headers["sec-fetch-dest"], "empty");
            assert.equal(r.headers["sec-fetch-mode"], "cors");
            assert.equal(r.headers["sec-fetch-site"], "same-site");
            assert.equal(r.headers.priority, "u=1, i");
            assert.equal(r.headers["sec-ch-ua-mobile"], "?0");
            assert.equal(r.headers["sec-ch-ua-platform"], '"Windows"');
            assert.match(r.headers["sec-ch-ua"], /"Chromium";v="155", "Google Chrome";v="155", "Not\?A_Brand";v="99"/);
            assert.equal(r.headers["user-agent"], CHROME_UA);
        }
    });

    it("sends no Client Hints for a User-Agent that is not Chromium", async () => {
        fake = installFakeZalo();
        await loginWithSession(creds({ userAgent: FIREFOX_UA }), OPTIONS);
        for (const r of fake.requests) {
            assert.equal(r.headers["sec-fetch-mode"], "cors");
            assert.equal("sec-ch-ua" in r.headers, false);
            assert.equal("priority" in r.headers, false);
        }
    });

    describe("cookie write-back", () => {
        it("rewrites the saved credentials when the login changed the jar", async () => {
            fake = installFakeZalo({
                serverInfoHeaders: { "set-cookie": "zpw_sek=rotated-by-fake; Domain=zalo.me; Path=/; Secure" },
            });
            saveCredentials(FAKE.ownId, creds());
            await loginWithCredentials(creds(), null, { ownId: FAKE.ownId });
            const saved = loadCredentials(FAKE.ownId);
            const cookies = saved.cookie.cookies ?? saved.cookie;
            assert.ok(
                cookies.some((c) => (c.key ?? c.name) === "zpw_sek" && c.value === "rotated-by-fake"),
                "the rotated cookie was saved",
            );
            assert.equal(saved.imei, FAKE_CREDENTIALS.imei, "the rest of the credentials is untouched");
            assert.equal(saved.userAgent, CHROME_UA);
        });

        it("writes nothing for a login that does not know its account", async () => {
            fake = installFakeZalo({
                serverInfoHeaders: { "set-cookie": "zpw_sek=rotated-by-fake; Domain=zalo.me; Path=/; Secure" },
            });
            rmSync(join(CONFIG_DIR, "credentials", `cred_${FAKE.ownId}.json`), { force: true });
            await loginWithCredentials(creds(), null);
            assert.equal(loadCredentials(FAKE.ownId), null);
        });

        it("writes nothing when the jar is the same as the saved one", async () => {
            fake = installFakeZalo();
            const original = creds();
            saveCredentials(FAKE.ownId, original);
            const before = readFileSync(join(CONFIG_DIR, "credentials", `cred_${FAKE.ownId}.json`), "utf8");
            await loginWithCredentials(original, null, { ownId: FAKE.ownId });
            const after = readFileSync(join(CONFIG_DIR, "credentials", `cred_${FAKE.ownId}.json`), "utf8");
            assert.equal(after, before);
        });
    });
});

describe("the browser headers", () => {
    it("derive Client Hints from the User-Agent: Chrome, Edge, macOS, and none for Firefox", () => {
        assert.deepEqual(secChUaFor(CHROME_UA), {
            secChUa: '"Chromium";v="155", "Google Chrome";v="155", "Not?A_Brand";v="99"',
            secChUaPlatform: '"Windows"',
            secChUaMobile: "?0",
        });
        const edge = `${CHROME_UA} Edg/155.0.0.0`;
        assert.match(secChUaFor(edge).secChUa, /"Microsoft Edge";v="155"/);
        const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36";
        assert.equal(secChUaFor(mac).secChUaPlatform, '"macOS"');
        assert.equal(secChUaFor(FIREFOX_UA), null);
        const phone =
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/155.0.0.0 Mobile Safari/537.36";
        assert.equal(secChUaFor(phone).secChUaMobile, "?1");
        assert.equal(secChUaFor(phone).secChUaPlatform, '"Android"');
    });

    it("say same-site inside zalo.me and cross-site everywhere else", () => {
        assert.equal(fetchSiteOf("https://wpa.chat.zalo.me/api/x"), "same-site");
        assert.equal(fetchSiteOf("https://zalo.me/"), "same-site");
        assert.equal(fetchSiteOf("https://jr.zaloapp.com/jr/syncsession"), "cross-site");
        assert.equal(fetchSiteOf("https://evilzalo.me.example.com/"), "cross-site");
        assert.equal(browserHeadersFor(CHROME_UA, "https://jr.zaloapp.com/x")["sec-fetch-site"], "cross-site");
    });

    it("never replace a header the caller already set, in any letter case, and never add DevTools extras", async () => {
        let seen;
        const wrapped = withBrowserHeaders(async (_url, init) => void (seen = init.headers), CHROME_UA);
        await wrapped("https://chat.zalo.me/x", { headers: { Priority: "u=0, i", Accept: "a" } });
        assert.equal(seen.Priority, "u=0, i");
        assert.equal("priority" in seen, false);
        assert.equal(seen.Accept, "a");
        for (const never of ["cache-control", "pragma", "dnt"]) assert.equal(never in seen, false);

        await wrapped("https://chat.zalo.me/x", { headers: new Headers({ Referer: "r", Priority: "u=0, i" }) });
        assert.ok(seen instanceof Headers);
        assert.equal(seen.get("priority"), "u=0, i", "a header the caller set is kept");
        assert.equal(seen.get("sec-fetch-mode"), "cors");
        assert.equal(seen.get("referer"), "r");
    });
});

describe("the profile call (L6)", () => {
    it("sends me-v2 with the AES params, os and browser numbers, and the common version pair", async () => {
        const fake = installFakeZalo();
        try {
            const api = await loginWithSession(creds(), { ...OPTIONS, upkeep: false });
            fake.route("/api/social/profile/me-v2", () => ({ profile: { userId: "fake" } }));
            await api.fetchAccountInfo();
            const call = fake.calls("/api/social/profile/me-v2").at(-1);
            assert.equal(call.query.os, "7", "Windows");
            assert.equal(call.query.browser, "6", "Chrome");
            assert.equal(call.query.zpw_ver, "694");
            assert.equal(call.query.zpw_type, "30");
            assert.deepEqual(call.params, { avatar_size: 160, imei: FAKE_CREDENTIALS.imei });
        } finally {
            fake.uninstall();
        }
    });
});
