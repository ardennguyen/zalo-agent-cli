/**
 * Markdown to Zalo rich text.
 *
 * Zalo shows `**bold**` and `- item` as typed: a message is plain text plus a list of style ranges
 * (`{ start, len, st }`, offsets in UTF-16 code units, the same unit mentions use), and the apps draw bold,
 * bullets and sizes only from those ranges. An AI agent writes Markdown, so its replies arrived with the
 * asterisks and hyphens still in them. This turns the Markdown into the text Zalo should show and the
 * ranges that make it look right.
 *
 * What Zalo's own clients send, measured on real rich-text messages in a local cache, decides the mapping:
 *
 *   - a bullet is the line's text with NO marker, covered whole by `lst_1` (start at the line start, length
 *     of the line without its newline);
 *   - a heading is a bold line (the numbers in "1. Heading" are literal text);
 *   - bold inside a list item is a second, overlapping range.
 *
 * Supported: `**bold**` / `__bold__`, `*italic*` / `_italic_`, `***both***`, `~~strike~~`, `# headings`
 * (bold; `#` and `##` also big), `- * +` bullet lists with nesting, ordered lists (kept as typed, numbers
 * included: Zalo's own clients type them), `> quotes` (marker dropped), `` `code` `` and fenced blocks
 * (markers dropped, content kept as is), `[text](url)` (becomes `text (url)`), images, `---` rules (dropped),
 * backslash escapes, and Zalo's own `{red:text}` colors. Tables and anything else are left as typed.
 *
 * It is deliberately conservative where Markdown is ambiguous, because most of what is sent is not
 * Markdown at all: `snake_case_names`, `2 * 3 * 4`, a lone `*`, an unclosed `**` and a `5 > 3` stay exactly
 * as written.
 */

export const STYLE = Object.freeze({
    bold: "b",
    italic: "i",
    underline: "u",
    strike: "s",
    red: "c_db342e",
    orange: "c_f27806",
    yellow: "c_f7b503",
    green: "c_15a85f",
    small: "f_13",
    big: "f_18",
    list: "lst_1",
    indent: "ind_$",
});

const COLOR_ST = {
    red: STYLE.red,
    orange: STYLE.orange,
    yellow: STYLE.yellow,
    green: STYLE.green,
    big: STYLE.big,
    small: STYLE.small,
};

const isWord = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c) => c === undefined || /\s/.test(c);

/**
 * One line (or paragraph run) of inline Markdown.
 *
 * @param {string} src
 * @returns {{ text: string, styles: Array<{ start: number, len: number, st: string }> }} offsets relative to `text`
 */
export function convertInline(src) {
    let out = "";
    const styles = [];
    let i = 0;

    /** Append already-converted text, shifting the styles that came with it. */
    const append = (piece) => {
        for (const s of piece.styles) styles.push({ ...s, start: s.start + out.length });
        out += piece.text;
    };
    const wrap = (inner, st) => {
        const piece = convertInline(inner);
        const start = out.length;
        append(piece);
        if (piece.text.length) styles.push({ start, len: piece.text.length, st });
    };

    while (i < src.length) {
        const c = src[i];
        const rest = src.slice(i);

        // An @[uid] mention token passes through whole: its brackets are not a link, whatever follows them.
        if (c === "@") {
            const token = /^@\[-?\d+\]/.exec(rest);
            if (token) {
                out += token[0];
                i += token[0].length;
                continue;
            }
        }

        // Backslash escape: the next character is literal.
        if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!~|>]/.test(src[i + 1])) {
            out += src[i + 1];
            i += 2;
            continue;
        }

        // `code`: the content is literal, the backticks go.
        if (c === "`") {
            const run = /^`+/.exec(rest)[0];
            const close = src.indexOf(run, i + run.length);
            if (close > i + run.length) {
                out += src.slice(i + run.length, close).replace(/^ (.*) $/, "$1");
                i = close + run.length;
                continue;
            }
            out += run;
            i += run.length;
            continue;
        }

        // ![alt](url) and [text](url): Zalo links a bare URL by itself, so the URL stays in the text.
        if (c === "!" || c === "[") {
            const m = /^(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
            if (m) {
                const label = convertInline(m[2]);
                const url = m[3];
                if (!label.text || label.text === url) out += url;
                else {
                    append(label);
                    out += ` (${url})`;
                }
                i += m[0].length;
                continue;
            }
        }

        // <https://example.com>
        if (c === "<") {
            const m = /^<((?:https?|mailto):[^>\s]+)>/.exec(rest);
            if (m) {
                out += m[1];
                i += m[0].length;
                continue;
            }
        }

        // {red:text}, {big:text} ...: Zalo's own extras, kept from `msg send --md`.
        if (c === "{") {
            const m = /^\{(red|orange|yellow|green|big|small):([^}]+)\}/.exec(rest);
            if (m) {
                wrap(m[2], COLOR_ST[m[1]]);
                i += m[0].length;
                continue;
            }
        }

        // Emphasis: *** ** * __ _ ~~
        if (c === "*" || c === "_" || c === "~") {
            const run = /^(\*{1,3}|_{1,2}|~~)/.exec(rest)?.[0];
            if (run) {
                const before = src[i - 1];
                const after = src[i + run.length];
                // An opener has text hugging it on the inside; `_` also must not be inside a word.
                const opens = !isSpace(after) && !(c === "_" && isWord(before)) && !(c === "~" && run.length !== 2);
                if (opens) {
                    const close = findCloser(src, i + run.length, run);
                    if (close !== -1) {
                        const inner = src.slice(i + run.length, close);
                        if (run === "***") {
                            const start = out.length;
                            const piece = convertInline(inner);
                            append(piece);
                            if (piece.text.length) {
                                styles.push({ start, len: piece.text.length, st: STYLE.bold });
                                styles.push({ start, len: piece.text.length, st: STYLE.italic });
                            }
                        } else if (run === "**" || run === "__") wrap(inner, STYLE.bold);
                        else if (run === "~~") wrap(inner, STYLE.strike);
                        else wrap(inner, STYLE.italic);
                        i = close + run.length;
                        continue;
                    }
                }
                out += run;
                i += run.length;
                continue;
            }
        }

        out += c;
        i++;
    }
    return { text: out, styles };
}

/**
 * The index of the delimiter `run` that closes an emphasis opened just before `from`, or -1.
 * A closer has text hugging it on the inside, `_` must not be inside a word, and a code span or a longer
 * run of the same character is skipped.
 */
function findCloser(src, from, run) {
    const ch = run[0];
    for (let j = from; j < src.length; j++) {
        if (src[j] === "\\") {
            j++;
            continue;
        }
        if (src[j] === "`") {
            const ticks = /^`+/.exec(src.slice(j))[0];
            const end = src.indexOf(ticks, j + ticks.length);
            if (end !== -1) j = end + ticks.length - 1;
            continue;
        }
        if (src[j] !== ch) continue;
        const len = /^[*_~]+/.exec(src.slice(j))[0].length;
        if (len === run.length && !isSpace(src[j - 1]) && !(ch === "_" && isWord(src[j + len]))) return j;
        // `**bold *and italic* still bold**`: a nested shorter run opens and closes inside; step over it.
        j += len - 1;
    }
    return -1;
}

const FENCE = /^\s*(```+|~~~+)/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})([.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/**
 * Markdown to the text Zalo should show and the style ranges that dress it.
 *
 * @param {string} markdown
 * @returns {{ text: string, styles: Array<{ start: number, len: number, st: string, indentSize?: number }> }}
 */
export function markdownToZalo(markdown) {
    const lines = String(markdown ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n");
    let text = "";
    const styles = [];
    let fenced = false;
    let wroteLine = false;

    const emit = (line, lineStyles = [], whole = []) => {
        if (wroteLine) text += "\n";
        wroteLine = true;
        const start = text.length;
        for (const s of lineStyles) styles.push({ ...s, start: s.start + start });
        if (line.length)
            for (const st of whole)
                styles.push(
                    typeof st === "string" ? { start, len: line.length, st } : { start, len: line.length, ...st },
                );
        text += line;
    };

    for (const raw of lines) {
        if (FENCE.test(raw)) {
            fenced = !fenced;
            continue; // the fence line itself is not shown
        }
        if (fenced) {
            emit(raw);
            continue;
        }
        if (RULE.test(raw)) continue;

        let m = HEADING.exec(raw);
        if (m) {
            const inline = convertInline(m[2]);
            emit(inline.text, inline.styles, m[1].length <= 2 ? [STYLE.big, STYLE.bold] : [STYLE.bold]);
            continue;
        }
        m = BULLET.exec(raw);
        if (m) {
            const inline = convertInline(m[2]);
            const depth = Math.floor(m[1].replaceAll("\t", "  ").length / 2);
            emit(inline.text, inline.styles, [
                STYLE.list,
                ...(depth > 0 ? [{ st: STYLE.indent, indentSize: Math.min(depth, 4) }] : []),
            ]);
            continue;
        }
        m = ORDERED.exec(raw);
        if (m) {
            const inline = convertInline(m[4]);
            const label = `${m[1]}${m[2]}${m[3]} `;
            emit(
                label + inline.text,
                inline.styles.map((s) => ({ ...s, start: s.start + label.length })),
            );
            continue;
        }
        m = QUOTE.exec(raw);
        if (m) {
            let body = m[1];
            let nested;
            while ((nested = QUOTE.exec(body))) body = nested[1];
            const inline = convertInline(body);
            emit(inline.text, inline.styles);
            continue;
        }
        const inline = convertInline(raw);
        emit(inline.text, inline.styles);
    }
    return { text, styles: dropEmpty(styles) };
}

/** A range over nothing is not a style. */
function dropEmpty(styles) {
    return styles.filter((s) => s.len > 0);
}

/**
 * Whether `text` looks like it was written as Markdown, so a caller can tell a plain message from a formatted one.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeMarkdown(text) {
    const t = String(text ?? "");
    return (
        /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```)/.test(t) ||
        /\*\*\S|__\S|~~\S|`[^`\n]+`|\[[^\]]+\]\([^)]+\)/.test(t)
    );
}

/**
 * How a text message is sent: as Markdown to be converted ("markdown") or exactly as typed ("plain").
 *
 * The MCP tool defaults to Markdown, because what calls it is a model and models write Markdown; the CLI
 * defaults to plain, because what types into it is a person. `ZALO_SEND_FORMAT` changes either default, and
 * an explicit choice (the tool's `format`, the CLI's `--markdown`) wins over it.
 *
 * @param {object} args
 * @param {"markdown"|"plain"|null|undefined} [args.explicit]
 * @param {"markdown"|"plain"} args.fallback - The surface's own default
 * @param {NodeJS.ProcessEnv} [args.env]
 * @returns {"markdown"|"plain"}
 */
export function resolveSendFormat({ explicit, fallback, env = process.env }) {
    if (explicit === "markdown" || explicit === "plain") return explicit;
    const fromEnv = String(env.ZALO_SEND_FORMAT ?? "")
        .trim()
        .toLowerCase();
    return fromEnv === "markdown" || fromEnv === "plain" ? fromEnv : fallback;
}
