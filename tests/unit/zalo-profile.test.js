/**
 * The protocol profile (src/zalo/profile.js): the one place the identity this
 * client announces to Zalo is defined.
 *
 * Three things are checked, none by reading a constant back:
 *   - the environment rules of `ZALO_API_VERSION`, on an injected environment;
 *   - the browser presets, through the real fingerprint generator that consumes
 *     them (every platform and Chrome build, not a random sample);
 *   - agreement with the wire: a login through the fake server shows that
 *     `getServerInfo` carries the profile's computer name, type and version.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    API_TYPE,
    API_VERSION_INVALID,
    CHROME_VERSIONS,
    COMPUTER_NAME,
    DEFAULT_API_VERSION,
    DEVICE_LABEL,
    UA_PLATFORMS,
    browserCodeOf,
    buildUserAgent,
    osCodeOf,
    getProfile,
    resolveApiVersion,
} from "../../src/zalo/profile.js";
import { generateDeviceFingerprint } from "../../src/utils/device-fingerprint.js";
import { installFakeZalo, loginFake } from "./fake-zalo-session.js";

describe("resolveApiVersion", () => {
    it("is the default when the variable is absent, empty or blank", () => {
        assert.equal(resolveApiVersion({}), DEFAULT_API_VERSION);
        assert.equal(resolveApiVersion({ ZALO_API_VERSION: "" }), DEFAULT_API_VERSION);
        assert.equal(resolveApiVersion({ ZALO_API_VERSION: "   " }), DEFAULT_API_VERSION);
    });

    it("takes a positive whole number, trimmed", () => {
        assert.equal(resolveApiVersion({ ZALO_API_VERSION: "685" }), 685);
        assert.equal(resolveApiVersion({ ZALO_API_VERSION: " 700 " }), 700);
    });

    it("refuses everything else, naming the variable and the value, with the marker code", () => {
        for (const bad of ["69l", "6.91", "0", "-685", "685abc", "1e3", "0x2b3", "latest", "99999999999999999999"]) {
            assert.throws(
                () => resolveApiVersion({ ZALO_API_VERSION: bad }),
                (e) =>
                    e.code === API_VERSION_INVALID &&
                    e.message.includes("ZALO_API_VERSION") &&
                    e.message.includes(`"${bad}"`),
                `ZALO_API_VERSION=${bad} was accepted or mislabeled`,
            );
        }
    });
});

describe("getProfile", () => {
    it("carries the announced identity, frozen", () => {
        const p = getProfile({});
        assert.deepEqual(p, {
            apiType: API_TYPE,
            apiVersion: DEFAULT_API_VERSION,
            computerName: COMPUTER_NAME,
            deviceLabel: DEVICE_LABEL,
        });
        assert.ok(Object.isFrozen(p));
    });

    it("follows the environment, and fails like resolveApiVersion does", () => {
        assert.equal(getProfile({ ZALO_API_VERSION: "700" }).apiVersion, 700);
        assert.throws(
            () => getProfile({ ZALO_API_VERSION: "x" }),
            (e) => e.code === API_VERSION_INVALID,
        );
    });

    it("keeps the device label recognizable: it never claims to be a browser or a phone", () => {
        assert.match(DEVICE_LABEL, /zalo-agent-cli/);
        assert.doesNotMatch(DEVICE_LABEL, /chrome|firefox|safari|android|iphone|windows|mac/i);
    });
});

describe("browser presets", () => {
    it("build the User-Agent shape Chrome sends, for every platform and build", () => {
        for (const platform of UA_PLATFORMS) {
            for (const v of CHROME_VERSIONS) {
                const ua = buildUserAgent(platform, v);
                assert.match(
                    ua,
                    /^Mozilla\/5\.0 \([^)]+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/,
                );
                assert.ok(ua.includes(`Chrome/${v} `), `${ua} does not carry ${v}`);
                assert.ok(ua.includes(`(${platform.token})`));
            }
        }
    });

    it("are all reachable by the fingerprint generator, each with Client Hints that match its User-Agent", () => {
        const expected = new Set(
            UA_PLATFORMS.flatMap((p) => CHROME_VERSIONS.map((v) => `${buildUserAgent(p, v)}|${p.hint}`)),
        );
        const seen = new Set();
        for (let i = 0; i < 4000 && seen.size < expected.size; i++) {
            const fp = generateDeviceFingerprint();
            const key = `${fp.userAgent}|${fp.secChUaPlatform}`;
            assert.ok(expected.has(key), `generator produced a fingerprint outside the presets: ${key}`);
            const major = /Chrome\/(\d+)\./.exec(fp.userAgent)[1];
            assert.match(fp.secChUa, new RegExp(`"Chromium";v="${major}", "Google Chrome";v="${major}"`));
            seen.add(key);
        }
        assert.equal(seen.size, expected.size, "some preset is never produced");
    });

    it("name only Chrome, never a browser that sends no Client Hints", () => {
        for (const platform of UA_PLATFORMS) {
            assert.doesNotMatch(buildUserAgent(platform, CHROME_VERSIONS[0]), /firefox|safari\/\d+\.\d+\.\d+$/i);
        }
    });
});

describe("the profile against the wire", () => {
    let fake;
    before(() => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        fake = installFakeZalo();
    });
    after(() => fake.uninstall());
    beforeEach(() => {
        fake.requests.length = 0;
        delete process.env.ZALO_API_VERSION;
    });

    it("zca-js sends the same computer name and type as the profile in getServerInfo", async () => {
        await loginFake();
        const serverInfo = fake.calls("/api/login/getServerInfo").at(-1);
        assert.equal(serverInfo.query.computer_name, COMPUTER_NAME);
        assert.equal(serverInfo.query.type, String(API_TYPE));
        assert.equal(serverInfo.query.client_version, String(DEFAULT_API_VERSION));
    });
});

describe("the numbers Zalo's profile call takes for a User-Agent", () => {
    const UA = {
        chromeWin: buildUserAgent(UA_PLATFORMS[0], CHROME_VERSIONS[0]),
        chromeMac: buildUserAgent(UA_PLATFORMS[1], CHROME_VERSIONS[0]),
        edgeWin: `${buildUserAgent(UA_PLATFORMS[0], CHROME_VERSIONS[0])} Edg/155.0.0.0`,
        firefoxWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
        safariMac:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        operaWin: `${buildUserAgent(UA_PLATFORMS[0], CHROME_VERSIONS[0])} OPR/120.0.0.0`,
        linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36",
        android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/155.0.0.0 Mobile Safari/537.36",
        iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1",
    };

    it("name the browser: Edge before Chrome, Opera before both, Safari only when it is not Chrome", () => {
        assert.equal(browserCodeOf(UA.chromeWin), 6);
        assert.equal(browserCodeOf(UA.edgeWin), 5);
        assert.equal(browserCodeOf(UA.operaWin), 1);
        assert.equal(browserCodeOf(UA.firefoxWin), 2);
        assert.equal(browserCodeOf(UA.safariMac), 3);
        assert.equal(browserCodeOf("Mozilla/4.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0)"), 4);
        assert.equal(browserCodeOf("curl/8"), 0);
        assert.equal(browserCodeOf(undefined), 0);
    });

    it("name the operating system", () => {
        assert.equal(osCodeOf(UA.chromeWin), 7);
        assert.equal(osCodeOf(UA.chromeMac), 6);
        assert.equal(osCodeOf(UA.linux), 8);
        assert.equal(osCodeOf(UA.android), 2);
        assert.equal(osCodeOf(UA.iphone), 4);
        assert.equal(osCodeOf("curl/8"), 0);
    });

    it("know every preset the fingerprint generator can produce", () => {
        for (const platform of UA_PLATFORMS) {
            const ua = buildUserAgent(platform, CHROME_VERSIONS[0]);
            assert.equal(browserCodeOf(ua), 6, ua);
            assert.ok([6, 7].includes(osCodeOf(ua)), ua);
        }
    });
});
