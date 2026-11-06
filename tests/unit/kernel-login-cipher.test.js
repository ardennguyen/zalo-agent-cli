/**
 * The login cipher (src/zalo/kernel/login-cipher.js) against zca-js's `ParamsEncryptor`, `decryptResp` and
 * `getSignKey`, which every saved-session login has used until now.
 *
 * zca-js draws `zcid_ext` from `Math.random`; it is seeded here so its encryptor is reproducible, and the value it
 * drew is handed to ours. The key-size risk (spec-kernel 11.5) is what these guard: the 32-character keys are AES-256
 * keys as UTF-8 bytes, and a hex-decoding mistake would give AES-128 and different bytes everywhere below.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
    ENC_VER,
    createLoginEncryptor,
    deriveEnk,
    makeZcid,
    makeZcidExt,
    openLogin,
    sealLogin,
    signKey,
} from "../../src/zalo/kernel/login-cipher.js";

const require = createRequire(import.meta.url);
const zca = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));

const IMEI = "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef";
const T0 = 1_700_000_000_000;

/** A seeded Math.random (mulberry32) for the duration of `fn`. */
function withSeededRandom(seed, fn) {
    const saved = Math.random;
    let a = seed >>> 0;
    Math.random = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try {
        return fn();
    } finally {
        Math.random = saved;
    }
}

describe("the login cipher against zca-js", () => {
    for (const seed of [1, 7, 42, 2026]) {
        it(`derives the same zcid, enk and params as zca-js (seed ${seed})`, () => {
            const theirs = withSeededRandom(
                seed,
                () => new zca.ParamsEncryptor({ type: 30, imei: IMEI, firstLaunchTime: T0 }),
            );
            const ours = createLoginEncryptor({ type: 30, imei: IMEI, firstLaunchTime: T0, zcidExt: theirs.zcid_ext });
            assert.equal(ours.zcid, theirs.zcid);
            assert.equal(ours.enk, theirs.getEncryptKey());
            assert.deepEqual(ours.params(), theirs.getParams());
            const data = JSON.stringify({ computer_name: "Web", imei: IMEI, language: "vi", ts: T0 });
            assert.equal(ours.seal(data), zca.ParamsEncryptor.encodeAES(ours.enk, data, "base64", false));
        });
    }

    it("opens what zca-js seals with enk, and zca-js opens what we seal, URL-escaped or not", () => {
        const enk = deriveEnk(makeZcid(30, IMEI, T0), "a1b2c3d4e5");
        const answer = { error_code: 0, data: { uid: "1234567890123456789", zpw_enk: "k", note: "Tiếng 😀" } };
        const theirs = zca.ParamsEncryptor.encodeAES(enk, JSON.stringify(answer), "base64", false);
        assert.deepEqual(openLogin(enk, theirs), answer);
        assert.deepEqual(openLogin(enk, encodeURIComponent(theirs)), answer);
        assert.deepEqual(zca.decryptResp(enk, sealLogin(enk, answer)), answer);
    });

    it("hands back the text when what opens is not JSON, and null when it does not open", () => {
        const enk = deriveEnk(makeZcid(30, IMEI, T0), "abcdef");
        assert.equal(openLogin(enk, sealLogin(enk, "not json")), "not json");
        const other = deriveEnk(makeZcid(30, IMEI, T0 + 1), "abcdef");
        assert.equal(openLogin(other, sealLogin(enk, { a: 1 })), null);
        assert.equal(openLogin(enk, "%%%"), null);
    });

    it("signs like zca-js: every field, ordered by name, null and numbers as text", () => {
        const fields = {
            imei: IMEI,
            type: 30,
            client_version: 695,
            computer_name: "Web",
            sp_mtn: -1,
            bkt: -1,
            floatMenuPos: null,
        };
        assert.equal(signKey("getserverinfo", fields), zca.getSignKey("getserverinfo", fields));
        const login = { zcid: "AB", zcid_ext: "cd", enc_ver: ENC_VER, params: "x+y/z=", type: 30, client_version: 695 };
        assert.equal(signKey("getlogininfo", login), zca.getSignKey("getlogininfo", login));
        // A changed value or a changed kind must change the key (red if a field were skipped).
        assert.notEqual(signKey("getlogininfo", { ...login, type: 31 }), signKey("getlogininfo", login));
        assert.notEqual(signKey("getserverinfo", login), signKey("getlogininfo", login));
    });

    it("draws zcid_ext as 6 to 12 lowercase hex characters, like the Web's randomString", () => {
        const lengths = new Set();
        for (let i = 0; i < 400; i++) {
            const ext = makeZcidExt();
            assert.match(ext, /^[0-9a-f]{6,12}$/);
            lengths.add(ext.length);
        }
        assert.ok(lengths.size >= 5, `the length varies (saw ${[...lengths].sort().join(",")})`);
    });

    it("refuses to make a zcid without type, imei or time, as zca-js does", () => {
        assert.throws(() => makeZcid(30, "", T0));
        assert.throws(() => makeZcid(30, IMEI, 0));
        assert.throws(() => zca.ParamsEncryptor.prototype.createZcid.call({}, 30, "", T0));
    });
});
