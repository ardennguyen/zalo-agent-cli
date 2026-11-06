/**
 * The session cipher (src/zalo/kernel/cipher.js), which every request and reply of a live session goes through.
 * Byte-equal ciphertext is the bar: the cipher is deterministic (zero IV), so any difference in key handling,
 * padding or encoding shows as different bytes.
 *
 * The expected ciphertexts are fixed vectors, produced once by the session cipher the CLI used before this one (the
 * one every live session had gone through) and reviewed when they were written down.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeImei, openSession, sealSession } from "../../src/zalo/kernel/cipher.js";

const KEY = Buffer.alloc(16, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(16, 8).toString("base64");

const VECTORS = {
    ascii: JSON.stringify({ imei: "fake-imei", toid: "1000000000000000001", message: "hello" }),
    vietnamese: JSON.stringify({ message: "Tiếng Việt có dấu: ắ ằ ẳ ẵ ặ đ Ư ơ" }),
    emoji: JSON.stringify({ message: "😀👍🏽 family: 👨‍👩‍👧" }),
    empty: "",
    emptyObject: "{}",
    oneMegabyte: JSON.stringify({ message: "x".repeat(1024 * 1024) }),
};

/** Each vector sealed under KEY: the base64 text, or for the big one the SHA-256 of it. */
const SEALED = {
    ascii: "AnpvQQgyMo0vnOOzxi4bAzIvFDln0cGuvACSbF0/V2CiejXlTamy3lfjjTPhSSFqYwytB7+n6h0BfZVqblL/S1f5IiCr/mVkR7BY3ytSUiY=",
    vietnamese:
        "snUsJRpEh4rQCSs6P84cWcC4nM6X05chjmAvomspc6b3yIP74x6T80wVmH7Pbz/HNZou7JxTVPxxmA8os0+ecHm99cDsqChgKwa9u1ABJog=",
    emoji: "7TrbN6rbgLZv5o438hNz0XunNpxtsT+T6DM6r9M5e3+XVXB0DBRDbI2bXkF9ndpaWx7qGyftK9e5nc5oH2HwEw==",
    empty: "bdjRqZaJMFAMlbykPQhOIw==",
    emptyObject: "hgBUnzvlD9/ewlnr+OSsmQ==",
    oneMegabyte: { sha256: "fd2c8e6c8dc38ea1b2de65c9301e971e488b56f2057fd3e37c73c3a1ea45bf43" },
};

/** VECTORS.ascii sealed under a 24- and a 32-byte key of 5s. */
const SEALED_BY_KEY_LENGTH = {
    24: "vbmDoVBADMF473zTm8ocSaEcevZafUrqRgCcx37hv8FVBrql8337v5sbeKtzbiIcoZBHS9RCtK6zUjOmQCX/yEXrxnQDMfnAPNqT/Xyrmac=",
    32: "7JChM7bLcpIKeXHdn6h8yPQBGJ8yOsJpZk8PDvgxpAd81Z+Zvu93L1TE005r9vFwHdx3/5gKR2EL+uagocN3N+hFIx03ab4Umy+6ndlE19c=",
};

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

describe("the session cipher", () => {
    for (const [name, text] of Object.entries(VECTORS)) {
        it(`seals ${name} text to its fixed bytes, and opens them again`, () => {
            // Red if the key is not base64-decoded, the IV is not zero, the padding differs, or the text is not UTF-8.
            const ours = sealSession(KEY, text);
            const expected = SEALED[name];
            if (typeof expected === "string") {
                assert.equal(ours, expected);
                assert.equal(openSession(KEY, expected), text);
            } else {
                assert.equal(sha256(ours), expected.sha256);
            }
            assert.equal(openSession(KEY, ours), text);
        });
    }

    it("opens a URL-escaped ciphertext (base64's + / = escaped as a query value)", () => {
        const sealed = SEALED.vietnamese;
        assert.match(encodeURIComponent(sealed), /%2B|%2F|%3D/, "the vector must carry an escaped character");
        assert.equal(openSession(KEY, encodeURIComponent(sealed)), VECTORS.vietnamese);
    });

    it("returns null, never garbage, for a wrong key, a bad length, empty data and no key", () => {
        const sealed = sealSession(KEY, VECTORS.ascii);
        assert.equal(openSession(OTHER_KEY, sealed), null);
        assert.equal(openSession(KEY, sealed.slice(0, 10)), null);
        assert.equal(openSession(KEY, ""), null);
        assert.equal(openSession(KEY, null), null);
        assert.equal(openSession("", sealed), null);
        assert.equal(sealSession("", "x"), null);
        assert.equal(sealSession(Buffer.alloc(10).toString("base64"), "x"), null, "10 bytes is no AES key");
    });

    it("picks AES-192 and AES-256 by key length", () => {
        for (const len of [24, 32]) {
            const key = Buffer.alloc(len, 5).toString("base64");
            assert.equal(sealSession(key, VECTORS.ascii), SEALED_BY_KEY_LENGTH[len], `${len}-byte key`);
            assert.equal(openSession(key, sealSession(key, VECTORS.ascii)), VECTORS.ascii);
        }
    });

    it("keeps the shortest fixed vector", () => {
        const text = '{"imei":"fake-imei"}';
        assert.equal(sealSession(KEY, text), "AnpvQQgyMo0vnOOzxi4bAz9JTh5nIso7C2pQYFNttII=");
    });
});

describe("makeImei", () => {
    it("is a random UUID, a dash and the User-Agent's MD5", () => {
        const ua = "Mozilla/5.0 (offline test)";
        const md5 = createHash("md5").update(ua).digest("hex");
        const a = makeImei(ua);
        const b = makeImei(ua);
        assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{32}$/);
        assert.equal(a.slice(37), md5);
        assert.notEqual(a, b, "the UUID part is random");
    });
});
