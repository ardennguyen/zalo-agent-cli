/**
 * The Vietnamese fold used by search (src/utils/vn-text.js): the same as Zalo's own `simpleStripVietnamese`
 * (lowercase, Vietnamese vowels to bare letters, `đ` to `d`), for composed and decomposed spellings alike.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_KEYWORD_LENGTH, foldWithMap, normalizeKeyword, stripVietnamese } from "../../src/utils/vn-text.js";

const nfc = (s) => s.normalize("NFC");
const nfd = (s) => s.normalize("NFD");

describe("stripVietnamese", () => {
    it("folds the measured misses: the words people type without accents", () => {
        const table = {
            được: "duoc",
            không: "khong",
            "cảm ơn": "cam on",
            chào: "chao",
            nhé: "nhe",
            đã: "da",
            "Tiếng Việt": "tieng viet",
        };
        for (const [text, want] of Object.entries(table)) assert.equal(stripVietnamese(text), want, text);
    });

    it("folds every Vietnamese vowel with every mark, upper and lower case", () => {
        const vowels = {
            a: "aàáảãạăằắẳẵặâầấẩẫậ",
            e: "eèéẻẽẹêềếểễệ",
            i: "iìíỉĩị",
            o: "oòóỏõọôồốổỗộơờớởỡợ",
            u: "uùúủũụưừứửữự",
            y: "yỳýỷỹỵ",
        };
        for (const [base, letters] of Object.entries(vowels)) {
            for (const ch of letters) {
                assert.equal(stripVietnamese(ch), base, `${ch} (U+${ch.codePointAt(0).toString(16)})`);
                assert.equal(stripVietnamese(ch.toUpperCase()), base, `${ch.toUpperCase()}`);
            }
        }
    });

    it("folds đ and Đ to d, which has no decomposition", () => {
        assert.equal(stripVietnamese("đ"), "d");
        assert.equal(stripVietnamese("Đ"), "d");
        assert.equal(stripVietnamese("ĐÀ NẴNG đi"), "da nang di");
    });

    it("folds the composed and the decomposed spelling of a letter to the same thing", () => {
        for (const word of ["được", "Việt Nam", "ở đây", "ĐƯỢC", "nhưng"]) {
            assert.equal(stripVietnamese(nfc(word)), stripVietnamese(nfd(word)), word);
            assert.equal(stripVietnamese(nfd(word)), stripVietnamese(word).normalize("NFD"), word);
        }
        assert.equal(stripVietnamese(nfd("Việt")), "viet");
    });

    it("leaves what is not Vietnamese alone, as the official function does", () => {
        assert.equal(stripVietnamese("ñ"), nfd("ñ"), "n with a tilde keeps its tilde");
        assert.equal(stripVietnamese("ç"), nfd("ç"));
        assert.equal(
            stripVietnamese("ü"),
            nfd("ü"),
            "u with a diaeresis keeps it: the diaeresis is not a Vietnamese mark",
        );
        assert.equal(stripVietnamese("straße 日本語 😀"), "straße 日本語 😀");
        assert.equal(stripVietnamese("ABC 123 !?"), "abc 123 !?");
    });

    it("treats a missing text as empty", () => {
        assert.equal(stripVietnamese(null), "");
        assert.equal(stripVietnamese(undefined), "");
        assert.equal(stripVietnamese(""), "");
        assert.equal(stripVietnamese(42), "42");
    });
});

describe("foldWithMap", () => {
    it("says which character of the text each folded character came from, composed or not", () => {
        for (const text of ["Cảm ơn bạn", nfd("Cảm ơn bạn")]) {
            const { norm, map } = foldWithMap(text);
            assert.equal(norm, "cam on ban");
            assert.equal(map.length, norm.length);
            // "ơn" is found at 4 in the folded text; in the original it starts at the same letter.
            const at = norm.indexOf("on");
            assert.equal(text[map[at]].normalize("NFD")[0], "o", "the match starts on the letter ơ");
            assert.ok(
                map.every((v, i) => i === 0 || v >= map[i - 1]),
                "the map never goes backwards",
            );
        }
    });

    it("lets a match be cut out of the original, accents and all", () => {
        const text = "Hẹn gặp lại vào ngày mai nhé";
        const { norm, map } = foldWithMap(text);
        const start = norm.indexOf("ngay mai");
        const end = start + "ngay mai".length;
        assert.equal(text.slice(map[start], map[end - 1] + 1), "ngày mai");
    });
});

describe("normalizeKeyword", () => {
    it("trims, folds, and does not flag an ordinary keyword", () => {
        assert.deepEqual(normalizeKeyword("  Được  "), { keyword: "Được", norm: "duoc", truncated: false });
    });

    it("cuts a keyword to 100 characters, as the official client does, and says so", () => {
        const long = "a".repeat(MAX_KEYWORD_LENGTH + 20);
        const out = normalizeKeyword(long);
        assert.equal(out.keyword.length, MAX_KEYWORD_LENGTH);
        assert.equal(out.truncated, true);
        assert.equal(normalizeKeyword("a".repeat(MAX_KEYWORD_LENGTH)).truncated, false);
    });

    it("gives an empty keyword for nothing or only spaces", () => {
        assert.equal(normalizeKeyword("   ").norm, "");
        assert.equal(normalizeKeyword(undefined).keyword, "");
    });
});
