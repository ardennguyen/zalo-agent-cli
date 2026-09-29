/**
 * Zalo @-mention offsets.
 *
 * A mention is `{ pos, uid, len }`, where `pos` and `len` are **UTF-16
 * code-unit offsets into the message string** — not byte offsets, and not
 * grapheme counts. Zalo renders the tag over exactly `text.slice(pos, pos +
 * len)`, so an offset that is off by one paints the highlight over the wrong
 * span and the tagged person may not be notified at all.
 *
 * Measured against real mentions in a local cache (name changed):
 *
 *     text  "Em ko biết mở ch ạ @Trần Bích Ngọc"   { pos: 19, len: 15 }
 *     text.slice(19, 34)              === "@Trần Bích Ngọc"       correct
 *     Buffer.from(text).slice(19, 34) -> "h ạ @Trần Bí…"          wrong
 *
 * Accented Vietnamese is exactly where hand-counted offsets break, and it is
 * most of what this CLI sends. So `--mention <pos:uid:len>` stays for
 * back-compat, but the `@[uid]` token form below computes the offsets from
 * the string it just built and is the one to reach for.
 */

/** The uid Zalo reserves for @All. zca-js turns it into `type: 1`. */
export const ALL_MENTION_UID = "-1";

/**
 * Label used for `@[-1]` when no name is supplied.
 *
 * Zalo's own clients write the literal "@All" (confirmed on real @All rows
 * in the cache: `{ uid: "-1", pos: 0, len: 4, type: 1 }`), including in
 * Vietnamese groups. Do not localize this.
 */
export const ALL_MENTION_LABEL = "All";

/**
 * `@[uid]` — the token expanded by {@link expandMentions}.
 *
 * Deliberately restricted to decimal ids (plus `-1` for @All), which is every
 * uid Zalo accepts in a mention. Anything else in brackets — `@[see below]`,
 * `@[TODO]` — is left in the text verbatim rather than turned into a mention
 * of a uid that does not exist.
 */
const MENTION_TOKEN = /@\[(-?\d+)\]/g;

/**
 * Parse the legacy `--mention pos:uid:len` specs.
 *
 * Kept because scripts pass it; `@[uid]` tokens are the safe way in. Specs
 * that are not three colon-separated parts, or whose pos/len are not numbers,
 * are dropped rather than sent as NaN — zca-js's own filter would discard
 * them anyway, silently and later.
 *
 * @param {string[]} [specs] - raw `pos:uid:len` strings
 * @returns {{pos: number, uid: string, len: number}[]}
 */
export function parseMentionSpecs(specs) {
    return (specs || [])
        .map((spec) => {
            const [pos, uid, len] = String(spec).split(":");
            if (!uid) return null;
            const parsed = { pos: Number(pos), uid, len: Number(len) };
            if (!Number.isFinite(parsed.pos) || !Number.isFinite(parsed.len)) return null;
            return parsed;
        })
        .filter(Boolean);
}

/**
 * Expand `@[uid]` tokens into `@Display Name`, recording each mention's
 * offsets in the string that comes out.
 *
 * Because the offsets are measured on the built string rather than counted by
 * hand, they are correct whatever the surrounding text contains — accents,
 * emoji, earlier mentions of different lengths.
 *
 * `edits` reports each substitution in *input* coordinates so that text
 * styles counted against the pre-expansion message can be moved with
 * {@link shiftStyles}.
 *
 * @param {string} text - message body, possibly containing `@[uid]` tokens
 * @param {(uid: string) => (string|null|undefined)} [resolveName] - uid → display
 *   name; anything falsy falls back to "All" for `@[-1]` and to the uid itself
 *   otherwise, so an unknown user still gets a syntactically valid mention
 * @returns {{text: string, mentions: {pos: number, uid: string, len: number}[],
 *            edits: {start: number, oldLen: number, newLen: number}[]}}
 */
export function expandMentions(text, resolveName) {
    const src = String(text ?? "");
    const mentions = [];
    const edits = [];
    let out = "";
    let cursor = 0;

    // lastIndex is shared state on a module-level regex, so iterate a fresh copy.
    const token = new RegExp(MENTION_TOKEN.source, "g");
    let match;
    while ((match = token.exec(src)) !== null) {
        const uid = match[1];
        const resolved = typeof resolveName === "function" ? resolveName(uid) : null;
        const name = resolved || (uid === ALL_MENTION_UID ? ALL_MENTION_LABEL : uid);
        const label = `@${name}`;

        out += src.slice(cursor, match.index);
        mentions.push({ pos: out.length, uid, len: label.length });
        edits.push({ start: match.index, oldLen: match[0].length, newLen: label.length });
        out += label;
        cursor = match.index + match[0].length;
    }
    out += src.slice(cursor);

    return { text: out, mentions, edits };
}

/**
 * Move text styles across the edits {@link expandMentions} made.
 *
 * `--style start:len:style` and `--md` both produce offsets against the
 * message *before* mentions expand, and a `@[uid]` token is almost always
 * shorter than the name it becomes. Without this, `--md` plus a mention
 * silently paints bold over the wrong words.
 *
 * A style that starts after an edit moves by the edit's delta; a style that
 * spans one grows by it (`**hi @[123]**` keeps the whole run bold).
 *
 * @param {{start: number, len: number, st: string}[]} styles
 * @param {{start: number, oldLen: number, newLen: number}[]} edits
 * @returns {{start: number, len: number, st: string}[]}
 */
export function shiftStyles(styles, edits) {
    if (!edits || edits.length === 0) return styles;
    return styles.map((style) => {
        let start = style.start;
        let len = style.len;
        for (const edit of edits) {
            const delta = edit.newLen - edit.oldLen;
            if (edit.start < style.start) start += delta;
            else if (edit.start < style.start + style.len) len += delta;
        }
        return { ...style, start, len };
    });
}
