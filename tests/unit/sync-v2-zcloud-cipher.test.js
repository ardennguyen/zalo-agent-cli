/**
 * src/core/sync-v2/zcloud-cipher.js — the zCloud params/response cipher.
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
 * The oracle below is that module re-run with crypto-js — the library the web
 * client itself calls — resolved from zca-js's own dependency tree. It is not
 * the module under test, so a green run means our Node-crypto implementation is
 * byte-compatible with the client, not merely consistent with itself.
 *
 * Keys are throwaway constants. Nothing here is a real enk (AGENTS.md §12).
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CONFIG_DIR } from "../../src/core/credentials.js";

const require = createRequire(import.meta.url);
const CryptoJS = createRequire(require.resolve("zca-js"))("crypto-js");

/** Obviously fake keys: 32 and 16 bytes of a repeated byte. */
const ENK_256 = Buffer.alloc(32, 0x5a).toString("base64");
const ENK_128 = Buffer.alloc(16, 0x33).toString("base64");
const OTHER_ENK = Buffer.alloc(32, 0x21).toString("base64");

/** Loaded per test so a missing module fails each test on its own. */
const cipher = () => import("../../src/core/sync-v2/zcloud-cipher.js");

const bytes = (b64) => Uint8Array.from(Buffer.from(b64, "base64"));

/** Zalo Web `98yS.encryptAES(t, n)`, line for line. */
function webEncryptAES(t, n) {
    const e = CryptoJS.enc.Base64.parse(n);
    const a = CryptoJS.lib.WordArray.random(16);
    const s = CryptoJS.AES.encrypt(t, e, { iv: a, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).ciphertext;
    return a.concat(s).toString(CryptoJS.enc.Base64);
}

/** Zalo Web `98yS.decryptAES(t, n)`, line for line. */
function webDecryptAES(t, n) {
    const e = bytes(n);
    const a = bytes(t);
    const s = a.slice(0, 16);
    const r = a.slice(16, a.length);
    return CryptoJS.AES.decrypt(
        { ciphertext: CryptoJS.lib.WordArray.create(r), salt: "" },
        CryptoJS.lib.WordArray.create(e),
        { iv: CryptoJS.lib.WordArray.create(s), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
    ).toString(CryptoJS.enc.Utf8);
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

    it("what it encrypts, the web client's own decryptAES reads", async () => {
        const { encryptZCloud } = await cipher();
        const ct = encryptZCloud(JSON.stringify(PAYLOAD), ENK_256);
        assert.deepEqual(JSON.parse(webDecryptAES(ct, ENK_256)), PAYLOAD);
    });

    it("what the web client's encryptAES produces, it decrypts", async () => {
        const { decryptZCloud } = await cipher();
        const ct = webEncryptAES(JSON.stringify(PAYLOAD), ENK_256);
        assert.deepEqual(JSON.parse(decryptZCloud(ct, ENK_256)), PAYLOAD);
    });

    it("keys the cipher with base64decode(enk), so a 16-byte enk is AES-128 on both sides", async () => {
        const { encryptZCloud, decryptZCloud } = await cipher();
        assert.equal(webDecryptAES(encryptZCloud("short key", ENK_128), ENK_128), "short key");
        assert.equal(decryptZCloud(webEncryptAES("short key", ENK_128), ENK_128), "short key");
    });

    it("encodes params as encodeURIComponent(base64(iv ‖ ciphertext))", async () => {
        const { encodeZCloudParams } = await cipher();
        const encoded = encodeZCloudParams(PAYLOAD, ENK_256);
        assert.doesNotMatch(encoded, /[+/=]/, "base64's + / = must arrive percent-encoded");
        assert.deepEqual(JSON.parse(webDecryptAES(decodeURIComponent(encoded), ENK_256)), PAYLOAD);
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
