/**
 * src/zalo/kernel/zcloud-cipher.js — the zCloud params/response cipher.
 *
 * zCloud (`zcld.chat.zalo.me`) does not use the session cipher every other
 * Zalo endpoint uses (session key, all-zero IV). Zalo Web's module `98yS`
 * (bundle 1.e0ef5e98f8f9d8970e2c.js @2868035, captured 2026-09-29) does:
 *
 *   encryptAES(json, enk) = base64( iv16 ‖ AES-CBC-PKCS7(json, key = base64decode(enk)) )
 *                           with a fresh random iv per call
 *   decryptAES(b64,  enk) = split the first 16 bytes off as the iv, then the same
 *   encodeParams(obj)     = encodeURIComponent(encryptAES(JSON.stringify(obj), enk))
 *
 * The fixed vectors below were produced once by that module re-run with
 * crypto-js (the library the web client itself calls), with a chosen IV in
 * place of the random one, and reviewed when they were written down. They are
 * not made by the module under test, so a green run means our Node-crypto
 * implementation reads what the client writes, not merely that it agrees with
 * itself. The other direction is pinned by restating the format with Node's
 * cipher: the IV our ciphertext carries, then AES-CBC of the plaintext under it.
 *
 * Keys are throwaway constants. Nothing here is a real enk (AGENTS.md §12).
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { CONFIG_DIR } from "../../src/core/credentials.js";

/** Obviously fake keys: 32 and 16 bytes of a repeated byte. */
const ENK_256 = Buffer.alloc(32, 0x5a).toString("base64");
const ENK_128 = Buffer.alloc(16, 0x33).toString("base64");
const OTHER_ENK = Buffer.alloc(32, 0x21).toString("base64");

/** Loaded per test so a missing module fails each test on its own. */
const cipher = () => import("../../src/zalo/kernel/zcloud-cipher.js");

const bytes = (b64) => Uint8Array.from(Buffer.from(b64, "base64"));

/**
 * The web client's `encryptAES` of PAYLOAD under ENK_256 with the IV 00 01 .. 0f, and of "short key" under ENK_128
 * with the IV f0 e0 .. 00.
 */
const WEB_SEALED_256 =
    "AAECAwQFBgcICQoLDA0OD6LMz1Z2VZZ5Q7FsT0Ob/HEGm6pQuo1I0pNcyw1qUHr4mlwQ8nLd0kNNyM05rlqmG67spLYB4TfeXPyc86Pz0M1Qrofk2Ax2" +
    "LlDtYEOvjOSBSwdZYu13d+5+ZmYAyH56Ng==";
const WEB_SEALED_128 = "8ODQwLCgkIBwYFBAMCAQAFMtDiWsfd/xKeKRn8gLT98=";

/**
 * The format, restated: the first 16 bytes are the IV, the rest AES-CBC-PKCS7 of the plaintext under the key
 * base64decode(enk) and that IV.
 *
 * @param {string} ct - base64
 * @param {string} enk - base64
 * @param {string} plaintext
 * @returns {boolean}
 */
function isWebFormat(ct, enk, plaintext) {
    const raw = Buffer.from(ct, "base64");
    const key = Buffer.from(enk, "base64");
    const c = createCipheriv(`aes-${key.length * 8}-cbc`, key, raw.subarray(0, 16));
    const expected = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return raw.subarray(16).equals(expected);
}

const PAYLOAD = { lastNoiseId: "jYCdDehHGa+w3Z9nD0fWzA==", loadType: 1, listNoiseIds: [], note: "xin chào" };

describe("zcloud-cipher — sandbox", () => {
    it("runs inside the test sandbox", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });
});

describe("zcloud-cipher", () => {
    it("round-trips a JSON payload with a throwaway 32-byte key", async () => {
        const { encryptZCloud, decryptZCloud } = await cipher();
        const ct = encryptZCloud(JSON.stringify(PAYLOAD), ENK_256);
        assert.deepEqual(JSON.parse(decryptZCloud(ct, ENK_256)), PAYLOAD);
    });

    it("prepends a fresh random 16-byte IV to every ciphertext", async () => {
        const { encryptZCloud, decryptZCloud } = await cipher();
        const a = encryptZCloud("same plaintext", ENK_256);
        const b = encryptZCloud("same plaintext", ENK_256);
        assert.notEqual(a, b, "two encryptions of one plaintext must differ (random IV)");
        assert.notDeepEqual(bytes(a).slice(0, 16), bytes(b).slice(0, 16), "the first 16 bytes are the IV");
        // 14 bytes of plaintext pad to one 16-byte block, after a 16-byte IV.
        assert.equal(bytes(a).length, 32);
        assert.equal(decryptZCloud(a, ENK_256), "same plaintext");
        assert.equal(decryptZCloud(b, ENK_256), "same plaintext");
    });

    it("what it encrypts is in the web client's format: the IV, then AES-CBC under it", async () => {
        const { encryptZCloud } = await cipher();
        const ct = encryptZCloud(JSON.stringify(PAYLOAD), ENK_256);
        assert.ok(isWebFormat(ct, ENK_256, JSON.stringify(PAYLOAD)));
        // The restatement can fail: the right bytes under another key are not the format.
        assert.equal(isWebFormat(ct, OTHER_ENK, JSON.stringify(PAYLOAD)), false);
    });

    it("what the web client's encryptAES produced, it decrypts", async () => {
        const { decryptZCloud } = await cipher();
        assert.deepEqual(JSON.parse(decryptZCloud(WEB_SEALED_256, ENK_256)), PAYLOAD);
        assert.ok(isWebFormat(WEB_SEALED_256, ENK_256, JSON.stringify(PAYLOAD)), "the restatement reads it too");
    });

    it("keys the cipher with base64decode(enk), so a 16-byte enk is AES-128 on both sides", async () => {
        const { encryptZCloud, decryptZCloud } = await cipher();
        assert.ok(isWebFormat(encryptZCloud("short key", ENK_128), ENK_128, "short key"));
        assert.equal(decryptZCloud(WEB_SEALED_128, ENK_128), "short key");
    });

    it("encodes params as encodeURIComponent(base64(iv ‖ ciphertext))", async () => {
        const { encodeZCloudParams } = await cipher();
        const encoded = encodeZCloudParams(PAYLOAD, ENK_256);
        assert.doesNotMatch(encoded, /[+/=]/, "base64's + / = must arrive percent-encoded");
        assert.ok(isWebFormat(decodeURIComponent(encoded), ENK_256, JSON.stringify(PAYLOAD)));
    });

    it("does not hand back plaintext for a ciphertext made with another key", async () => {
        const { encryptZCloud, decryptZCloud } = await cipher();
        const ct = encryptZCloud(JSON.stringify(PAYLOAD), OTHER_ENK);
        assert.throws(() => decryptZCloud(ct, ENK_256));
    });

    it("rejects an enk that is not a 16-, 24- or 32-byte key", async () => {
        const { encryptZCloud } = await cipher();
        assert.throws(() => encryptZCloud("x", Buffer.alloc(10, 1).toString("base64")), /enk/);
        assert.throws(() => encryptZCloud("x", ""), /enk/);
    });
});
