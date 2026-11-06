/**
 * The login cipher (src/zalo/kernel/login-cipher.js), which every saved-session login goes through.
 *
 * The expected zcid, keys, sealed bytes and sign keys are fixed vectors, produced once by the login cipher the CLI
 * used before this one (with `zcid_ext` drawn from a seeded `Math.random`) and reviewed when they were written down.
 * The key-size risk (spec-kernel 11.5) is what these guard: the 32-character keys are AES-256 keys as UTF-8 bytes,
 * and a hex-decoding mistake would give AES-128 and different bytes everywhere below.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

const IMEI = "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef";
const T0 = 1_700_000_000_000;

/** The zcid of type 30, IMEI and T0. */
const ZCID =
    "1BC51ADA99F03BF7CAEF1BA75C4A1DECA7DE1134FF534A0761C10CF5A06B97BF16875414716AF11890405E01A77B6593F5FBB8FADC983929" +
    "560171C49ADA8EA23166DC8C3F94030B33ACEB9CBE71842336179FA53B4579E023EAFFEBB221DE40";

/** For each zcid_ext: the key it derives with ZCID, and the login data below sealed with that key. */
const LOGIN_VECTORS = [
    {
        zcidExt: "00b349c9",
        enk: "D6F4D2EF1C1D9F3FCE1A0E12BFA3095B",
        sealed:
            "HYLLnwYpuq8rIFWC14YiyJharhSpv1qBBgRxLkoTHsNAEX4HKC8SmJR1o8TcAKqEWETVZQ4alO2Pr0WG5aMTP9xvsA28UsBnDi0n9EuAWkkt" +
            "meYNc0u1c6l48LteXXDacif3OgYoT069CC68t0JEctpzytmhiA1Vh53lQ5CdDdsvKXxW62wz+1tOQ01xxGr0",
    },
    {
        zcidExt: "0fdc7f",
        enk: "C35C10471C1D9F3FCE1A0E12BFA3095B",
        sealed:
            "+ggG4oab7Gzpv71V1xQkqllZkBZl9ue0k7NlQe1SFUU4p/PQrRnPomKhZAT4BmR0zVT1cbavDtu5hfu28loUdYnCzk9/lIv95SB5Tswv0uwh" +
            "bv1vfQ7ULDjr8EtHSMcqlKTnSpaym5nVbWmwdRSJeBGxXO97iaQ+IuGyRs56GSEFtOHe2HiSvF89bISTO3YH",
    },
    {
        zcidExt: "72c32b8a",
        enk: "E03E90951C1D9F3FCE1A0E12BFA3095B",
        sealed:
            "O62RQGIGPO6FzojiHjqBpAP5vS15qznOWo1CP8CTKiz5RKK86VEsOoTldqDnH/IYadY9PMprNZhMxf0ddmGyYySHrclf1eDogcfPDJudmWBl" +
            "BShfZKVkqGUgc6rgK+NfemXMCuq7ys+AJNAauaZfIFKJVm99PGMa4O4BYulKVuAS+RLFjPXjwAnBxj1ebJ0P",
    },
    {
        zcidExt: "4ef99a7a",
        enk: "424D27341C1D9F3FCE1A0E12BFA3095B",
        sealed:
            "cEeiTlRt8Cr8949vJQsSc28OmTT6ThkOSkWbqcE11xPUpGJBpqu40MJuVM6BXNULsZb45ho5f3lH4YsDSWuTBbmwuxhCnECe5Di+Khajgj4v" +
            "KMZCzJpKlZmWp7lf487PtVaCoVYHMSXxD9rWoxFnDshk9KYE+jf/d9qhfMRCIPxYgP2K0Eqi0pJ+FaCpoAPC",
    },
];

describe("the login cipher", () => {
    for (const { zcidExt, enk, sealed } of LOGIN_VECTORS) {
        it(`derives the fixed zcid, enk and params, and seals to the fixed bytes (zcid_ext ${zcidExt})`, () => {
            const ours = createLoginEncryptor({ type: 30, imei: IMEI, firstLaunchTime: T0, zcidExt });
            assert.equal(ours.zcid, ZCID);
            assert.equal(ours.enk, enk);
            assert.deepEqual(ours.params(), { zcid: ZCID, zcid_ext: zcidExt, enc_ver: ENC_VER });
            const data = JSON.stringify({ computer_name: "Web", imei: IMEI, language: "vi", ts: T0 });
            assert.equal(ours.seal(data), sealed);
            assert.deepEqual(openLogin(enk, sealed), JSON.parse(data));
        });
    }

    it("opens what it seals with enk, URL-escaped or not, and nothing sealed with another key", () => {
        const enk = deriveEnk(makeZcid(30, IMEI, T0), "a1b2c3d4e5");
        const answer = { error_code: 0, data: { uid: "1234567890123456789", zpw_enk: "k", note: "Tiếng 😀" } };
        const sealed = sealLogin(enk, answer);
        assert.deepEqual(openLogin(enk, sealed), answer);
        assert.deepEqual(openLogin(enk, encodeURIComponent(sealed)), answer);
        assert.equal(openLogin(enk, LOGIN_VECTORS[0].sealed), null);
    });

    it("hands back the text when what opens is not JSON, and null when it does not open", () => {
        const enk = deriveEnk(makeZcid(30, IMEI, T0), "abcdef");
        assert.equal(openLogin(enk, sealLogin(enk, "not json")), "not json");
        const other = deriveEnk(makeZcid(30, IMEI, T0 + 1), "abcdef");
        assert.equal(openLogin(other, sealLogin(enk, { a: 1 })), null);
        assert.equal(openLogin(enk, "%%%"), null);
    });

    it("signs every field, ordered by name, null and numbers as text, to the fixed keys", () => {
        const fields = {
            imei: IMEI,
            type: 30,
            client_version: 695,
            computer_name: "Web",
            sp_mtn: -1,
            bkt: -1,
            floatMenuPos: null,
        };
        assert.equal(signKey("getserverinfo", fields), "b1b29549204b9cbb1ca20df3e29d3c05");
        const login = { zcid: "AB", zcid_ext: "cd", enc_ver: ENC_VER, params: "x+y/z=", type: 30, client_version: 695 };
        assert.equal(signKey("getlogininfo", login), "667767583be23196b3d8a4e9f8171e70");
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

    it("refuses to make a zcid without imei or time", () => {
        assert.throws(() => makeZcid(30, "", T0));
        assert.throws(() => makeZcid(30, IMEI, 0));
    });
});
