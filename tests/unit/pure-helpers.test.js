/**
 * Pure helpers with no I/O: bank BIN resolution, proxy masking, message-text
 * extraction, device fingerprinting, and version comparison.
 *
 * `src/utils/bank-helpers.test.js` and `src/utils/proxy-helpers.test.js`
 * already cover the happy paths; what follows targets the edges those
 * suites leave open — the ones that decide whether a command silently does
 * the wrong thing rather than erroring.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    resolveBankBin,
    BANK_NAME_TO_BIN,
    BIN_TO_DISPLAY,
    generateQrTransferImage,
} from "../../src/utils/bank-helpers.js";
import { maskProxy } from "../../src/utils/proxy-helpers.js";
import { extractMessageText } from "../../src/utils/extract-message-text.js";
import { generateDeviceFingerprint } from "../../src/utils/device-fingerprint.js";
import { isNewerVersion } from "../../src/utils/update-check.js";

describe("resolveBankBin", () => {
    it("resolves canonical lowercase names", () => {
        assert.equal(resolveBankBin("ocb"), 970448);
        assert.equal(resolveBankBin("vietcombank"), 970436);
    });

    it("resolves documented aliases to the same BIN", () => {
        assert.equal(resolveBankBin("vcb"), resolveBankBin("vietcombank"));
        assert.equal(resolveBankBin("mb"), resolveBankBin("mbbank"));
        assert.equal(resolveBankBin("ctg"), resolveBankBin("vietinbank"));
    });

    it("is case-insensitive", () => {
        assert.equal(resolveBankBin("OCB"), 970448);
        assert.equal(resolveBankBin("TechcomBank"), 970407);
    });

    it("strips spaces and underscores", () => {
        assert.equal(resolveBankBin("kien long bank"), 970452);
        assert.equal(resolveBankBin("kien_long_bank"), 970452);
        assert.equal(resolveBankBin(" ocb "), 970448, "leading/trailing space must not defeat lookup");
    });

    it("accepts a numeric BIN string when that BIN is known", () => {
        assert.equal(resolveBankBin("970448"), 970448);
    });

    it("rejects a numeric BIN that is not in the display table", () => {
        assert.equal(resolveBankBin("123456"), null);
        assert.equal(resolveBankBin("0"), null);
    });

    it("returns null for an unknown name", () => {
        assert.equal(resolveBankBin("notabank"), null);
        assert.equal(resolveBankBin(""), null);
    });

    it("every alias in BANK_NAME_TO_BIN resolves to a BIN with a display name", () => {
        const orphans = Object.entries(BANK_NAME_TO_BIN)
            .filter(([, bin]) => !BIN_TO_DISPLAY[bin])
            .map(([name, bin]) => `${name}→${bin}`);
        assert.deepEqual(orphans, [], "these aliases would print a bare BIN instead of a bank name");
    });

    it("every alias round-trips through resolveBankBin", () => {
        for (const [name, bin] of Object.entries(BANK_NAME_TO_BIN)) {
            assert.equal(resolveBankBin(name), bin, `alias "${name}" did not resolve`);
        }
    });
});

describe("generateQrTransferImage", () => {
    it("returns null for a BIN with no SePay mapping, without hitting the network", async () => {
        assert.equal(await generateQrTransferImage(999999, "123456789"), null);
    });
});

describe("maskProxy", () => {
    it('returns "none" for null/undefined/empty', () => {
        assert.equal(maskProxy(null), "none");
        assert.equal(maskProxy(undefined), "none");
        assert.equal(maskProxy(""), "none");
    });

    it("masks the password and keeps everything else legible", () => {
        assert.equal(maskProxy("http://user:secret@host:8080"), "http://user:***@host:8080");
    });

    it("masks across schemes", () => {
        assert.equal(maskProxy("socks5://u:p@h:1080"), "socks5://u:***@h:1080");
        assert.equal(maskProxy("https://u:p@h:443"), "https://u:***@h:443");
    });

    it("leaves a credential-free proxy untouched", () => {
        assert.equal(maskProxy("http://host:8080"), "http://host:8080");
    });

    it("masks passwords containing punctuation", () => {
        const masked = maskProxy("http://user:p%40ss:w0rd!@host:8080");
        assert.doesNotMatch(masked, /w0rd/);
        assert.match(masked, /\*\*\*/);
    });

    it("never leaks the password for any realistic shape", () => {
        const secrets = ["hunter2", "p@ssw0rd", "a:b:c", "!@#$%^&*()"];
        for (const s of secrets) {
            const out = maskProxy(`http://bob:${s}@proxy.example:3128`);
            assert.equal(out.includes(s), false, `password "${s}" leaked through maskProxy`);
        }
    });
});

describe("extractMessageText", () => {
    it("returns a typed placeholder for non-object content", () => {
        assert.equal(extractMessageText(null, "photo"), "[photo]");
        assert.equal(extractMessageText(undefined, undefined), "[attachment]");
        assert.equal(extractMessageText("plain", "text"), "[text]");
    });

    it("prefers params.message above everything else", () => {
        const content = { params: { message: "winner" }, description: "d", title: "t", text: "x" };
        assert.equal(extractMessageText(content, "chat.quote"), "winner");
    });

    it("falls through the documented field priority", () => {
        assert.equal(extractMessageText({ description: "d", title: "t" }), "d");
        assert.equal(extractMessageText({ title: "t", text: "x" }), "t");
        assert.equal(extractMessageText({ text: "x", msg: "m" }), "x");
        assert.equal(extractMessageText({ msg: "m", href: "h" }), "m");
        assert.equal(extractMessageText({ href: "https://e.com" }), "https://e.com");
    });

    it("uses content.content only when it is a string", () => {
        assert.equal(extractMessageText({ content: "inner" }), "inner");
        const nested = extractMessageText({ content: { deep: 1 } }, "weird");
        assert.match(nested, /^\[weird: /);
    });

    it("inlines small unknown objects for debuggability", () => {
        assert.equal(extractMessageText({ a: 1 }, "unknown"), '[unknown: {"a":1}]');
    });

    it("falls back to a bare placeholder for large unknown objects", () => {
        const big = { blob: "x".repeat(500) };
        assert.equal(extractMessageText(big, "sticker"), "[sticker]");
    });

    it("survives a circular object instead of throwing", () => {
        const circular = { type: "weird" };
        circular.self = circular;
        assert.equal(extractMessageText(circular, "cycle"), "[cycle]");
    });

    it("treats an empty params.message as absent and keeps falling through", () => {
        assert.equal(extractMessageText({ params: { message: "" }, description: "d" }), "d");
    });
});

describe("generateDeviceFingerprint", () => {
    it("returns all four Client Hint fields", () => {
        const fp = generateDeviceFingerprint();
        assert.deepEqual(Object.keys(fp).sort(), ["secChUa", "secChUaMobile", "secChUaPlatform", "userAgent"]);
    });

    it("is internally consistent — the UA's Chrome major matches sec-ch-ua", () => {
        for (let i = 0; i < 40; i++) {
            const fp = generateDeviceFingerprint();
            const major = fp.userAgent.match(/Chrome\/(\d+)\./)[1];
            assert.match(fp.secChUa, new RegExp(`"Google Chrome";v="${major}"`));
            assert.match(fp.secChUa, new RegExp(`"Chromium";v="${major}"`));
        }
    });

    it("never advertises Firefox alongside Chrome hints (the bug this module fixes)", () => {
        for (let i = 0; i < 40; i++) {
            assert.doesNotMatch(generateDeviceFingerprint().userAgent, /Firefox/);
        }
    });

    it("pairs the platform hint with the matching UA platform token", () => {
        for (let i = 0; i < 40; i++) {
            const fp = generateDeviceFingerprint();
            if (fp.secChUaPlatform === '"Windows"') assert.match(fp.userAgent, /Windows NT 10\.0/);
            else if (fp.secChUaPlatform === '"macOS"') assert.match(fp.userAgent, /Macintosh; Intel Mac OS X/);
            else assert.fail(`unexpected platform ${fp.secChUaPlatform}`);
        }
    });

    it("always reports desktop (?0) — no mobile presets exist", () => {
        for (let i = 0; i < 20; i++) assert.equal(generateDeviceFingerprint().secChUaMobile, "?0");
    });

    it("actually varies across calls — a constant fingerprint is the thing to avoid", () => {
        const seen = new Set();
        for (let i = 0; i < 200; i++) seen.add(generateDeviceFingerprint().userAgent);
        assert.ok(seen.size > 1, "fingerprint must not be identical on every call");
    });
});

describe("isNewerVersion", () => {
    it("compares numerically, not lexically", () => {
        assert.equal(isNewerVersion("1.0.10", "1.0.9"), true, "10 > 9 numerically even though '10' < '9' as strings");
        assert.equal(isNewerVersion("1.0.9", "1.0.10"), false);
        assert.equal(isNewerVersion("2.0.0", "10.0.0"), false);
    });

    it("is false for equal versions", () => {
        assert.equal(isNewerVersion("2.0.0", "2.0.0"), false);
    });

    it("respects major > minor > patch precedence", () => {
        assert.equal(isNewerVersion("2.0.0", "1.9.9"), true);
        assert.equal(isNewerVersion("1.2.0", "1.1.9"), true);
        assert.equal(isNewerVersion("1.1.2", "1.1.1"), true);
    });

    it("pads short versions to three components", () => {
        assert.equal(isNewerVersion("1.1", "1.0.9"), true);
        assert.equal(isNewerVersion("2", "1.9.9"), true);
    });

    it("a full release outranks a pre-release of the same core", () => {
        assert.equal(isNewerVersion("2.0.0", "2.0.0-dev"), true);
        assert.equal(isNewerVersion("2.0.0-dev", "2.0.0"), false);
    });

    it("does NOT suggest downgrading a local pre-release ahead of npm (the documented misfire)", () => {
        assert.equal(
            isNewerVersion("1.0.7", "2.0.0-dev"),
            false,
            "published 1.0.7 must never be offered as an update to a local 2.0.0-dev",
        );
    });

    it("compares two pre-releases of the same core lexically", () => {
        assert.equal(isNewerVersion("2.0.0-beta", "2.0.0-alpha"), true);
        assert.equal(isNewerVersion("2.0.0-alpha", "2.0.0-beta"), false);
    });

    it("treats non-numeric junk as 0 rather than producing NaN comparisons", () => {
        assert.equal(isNewerVersion("x.y.z", "0.0.0"), false);
        assert.equal(isNewerVersion("1.0.0", "x.y.z"), true);
    });
});
