/**
 * The protocol profile (src/zalo/profile.js): the one place the identity this
 * client announces to Zalo is defined.
 *
 * Three things are checked, none by reading a constant back:
 *   - the environment rules of `ZALO_API_VERSION`, on an injected environment;
 *   - the browser presets, through the real fingerprint generator that consumes
 *     them (every platform and Chrome build, not a random sample);
 *   - agreement with the wire: zca-js writes the computer name into
 *     `getServerInfo` itself, so a login through the fake server shows whether
 *     the profile and zca-js still say the same thing.
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
    buildUserAgent,
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
