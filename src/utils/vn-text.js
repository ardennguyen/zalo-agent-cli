/**
 * Vietnamese text folding for search (plan item F1).
 *
 * Zalo's own clients search with `simpleStripVietnamese`: lowercase, every Vietnamese vowel with its diacritics
 * to the bare letter, `đ` to `d`, on both the keyword and the text, then a plain substring match. People type
 * "duoc", not "được", so a search that does not fold finds almost nothing (measured: 0 hits against 56 for
 * "duoc"). This is that fold, built on Unicode decomposition so the composed and the decomposed spelling of a letter
 * fold the same.
 *
 * It strips exactly the Vietnamese marks (grave, acute, tilde, hook above, dot below, breve, circumflex, horn) and
 * only from the vowels a, e, i, o, u, y. Every other letter is left as it is: `ñ`, `ç` and `ü` do not lose theirs,
 * as in the official function.
 *
 * Both sides of a search go through the same function, so the result only has to be consistent, not canonical:
 * the output is not recomposed.
 */

/** The vowels Vietnamese puts marks on. */
const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);

/** The combining marks Vietnamese uses: grave, acute, tilde, hook above, dot below, breve, circumflex, horn. */
const VN_MARKS = new Set([0x0300, 0x0301, 0x0303, 0x0309, 0x0323, 0x0306, 0x0302, 0x031b]);

/** How long a search keyword may be (Zalo's `max_kw_len`). */
export const MAX_KEYWORD_LENGTH = 100;

/**
 * Fold a text, and say where each folded character came from.
 *
 * @param {string} text
 * @returns {{norm: string, map: number[]}} `map[i]` is the index in `text` of the character `norm[i]` came from, so a
 *   match found in `norm` can be shown in the original (`[map[start], map[end - 1] + 1)`)
 */
export function foldWithMap(text) {
    const source = String(text ?? "");
    let norm = "";
    const map = [];
    for (let i = 0; i < source.length; i++) {
        // One UTF-16 unit at a time: every Vietnamese letter is in the BMP, and a unit that is half of a pair is
        // passed through whole.
        for (const u of source[i].toLowerCase().normalize("NFD")) {
            const cp = u.codePointAt(0);
            if (VN_MARKS.has(cp) && VOWELS.has(norm.at(-1) ?? "")) continue;
            const out = u === "đ" ? "d" : u;
            for (let k = 0; k < out.length; k++) map.push(i);
            norm += out;
        }
    }
    return { norm, map };
}

/**
 * Fold a text for matching: lowercase, Vietnamese vowels to their bare letters, `đ` to `d`.
 *
 * @param {string|null|undefined} text
 * @returns {string} "" for a missing text
 */
export function stripVietnamese(text) {
    return foldWithMap(text).norm;
}

/**
 * A search keyword as it is matched: trimmed, cut to {@link MAX_KEYWORD_LENGTH} characters, folded.
 *
 * @param {string|null|undefined} query
 * @returns {{keyword: string, norm: string, truncated: boolean}} `keyword` is the trimmed, cut text; `norm` its fold
 */
export function normalizeKeyword(query) {
    const trimmed = String(query ?? "").trim();
    const keyword = trimmed.length > MAX_KEYWORD_LENGTH ? trimmed.slice(0, MAX_KEYWORD_LENGTH) : trimmed;
    return { keyword, norm: stripVietnamese(keyword), truncated: trimmed.length > MAX_KEYWORD_LENGTH };
}
