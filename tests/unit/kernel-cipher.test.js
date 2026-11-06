/**
 * The session cipher (src/zalo/kernel/cipher.js) against zca-js's own `encodeAES`/`decodeAES`, which every request
 * and reply of a live session has gone through until now. Byte-equal ciphertext is the bar: the cipher is
 * deterministic (zero IV), so any difference in key handling, padding or encoding shows as different bytes.
 *
 * The fixed vector at the end keeps guarding the bytes after zca-js leaves the tree (design 3.3).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { makeImei, openSession, sealSession } from "../../src/zalo/kernel/cipher.js";

const require = createRequire(import.meta.url);
const zca = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));

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

describe("the session cipher", () => {
    for (const [name, text] of Object.entries(VECTORS)) {
        it(`seals ${name} text to the same bytes zca-js does, and each side opens the other's`, () => {
            // Red if the key is not base64-decoded, the IV is not zero, the padding differs, or the text is not UTF-8.
            const ours = sealSession(KEY, text);
            assert.equal(ours, zca.encodeAES(KEY, text));
            assert.equal(openSession(KEY, ours), text);
            assert.equal(zca.decodeAES(KEY, ours), text);
        });
    }

    it("opens a URL-escaped ciphertext (base64's + / = escaped as a query value)", () => {
        const sealed = zca.encodeAES(KEY, VECTORS.vietnamese);
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

    it("picks AES-192 and AES-256 by key length, as zca-js's crypto-js does", () => {
        for (const len of [24, 32]) {
            const key = Buffer.alloc(len, 5).toString("base64");
            assert.equal(sealSession(key, VECTORS.ascii), zca.encodeAES(key, VECTORS.ascii), `${len}-byte key`);
            assert.equal(openSession(key, sealSession(key, VECTORS.ascii)), VECTORS.ascii);
        }
    });

    it("keeps one fixed vector, checked against zca-js now and alone after the cut-over", () => {
        const text = '{"imei":"fake-imei"}';
        const expected = sealSession(KEY, text);
        assert.equal(expected, zca.encodeAES(KEY, text));
        assert.equal(expected, "AnpvQQgyMo0vnOOzxi4bAz9JTh5nIso7C2pQYFNttII=");
    });
});

describe("makeImei", () => {
    it("is a random UUID, a dash and the User-Agent's MD5, as zca-js's generateZaloUUID", () => {
        const ua = "Mozilla/5.0 (offline test)";
        const md5 = createHash("md5").update(ua).digest("hex");
        const a = makeImei(ua);
        const b = makeImei(ua);
        assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{32}$/);
        assert.equal(a.slice(37), md5);
        assert.equal(zca.generateZaloUUID(ua).slice(37), md5, "the same suffix as zca-js");
        assert.notEqual(a, b, "the UUID part is random");
    });
});
