/**
 * Splitting a long text message the way Zalo Web does.
 *
 * Zalo refuses one oversized message instead of cutting it: `114 "Tham số không hợp lệ"` for plain text past 3000
 * UTF-16 units, and `112 "Lỗi không xác định"` for a styled message (what Markdown becomes) whose text plus style
 * list passes roughly 3.1 to 3.5 KB. Chinese and long bulleted answers hit the second one early, because a Chinese
 * character is three bytes and each bullet carries a style entry. Measured live, 2026-10-29.
 *
 * The Web client never sends such a message. It budgets every message at `limitMsgByte` (3000) UTF-8 bytes of the
 * text plus, for a styled message, the JSON of its styles; cuts at a newline when it can, else at a sentence end or
 * a space; trims the pieces; and sends them one after another, 300 ms apart. This does the same.
 *
 * Pure: no I/O, no Zalo. Styles are `{ start, len, st }` and mentions `{ pos, len, uid }`, both in UTF-16 units of
 * the text they belong to; each part gets its own text and the ranges re-based to it.
 */

/** Zalo Web's `limitMsgByte`: the most UTF-8 bytes of text (plus style JSON) in one message. */
export const MESSAGE_BYTE_LIMIT = 3000;

/** The pause between parts of one split message, as Web's `setTimeout(…, 300)`. */
export const PART_GAP_MS = 300;

const byteLength = (s) => Buffer.byteLength(s, "utf8");

/** Style ranges clipped to `[from, to)` and re-based to `from`. */
function clipStyles(styles, from, to) {
    const out = [];
    for (const s of styles) {
        const a = Math.max(s.start, from);
        const b = Math.min(s.start + s.len, to);
        if (b > a) out.push({ ...s, start: a - from, len: b - a });
    }
    return out;
}

/** What one message costs against the limit: its text bytes plus its style list, as Web counts it. */
function cost(text, styles) {
    return byteLength(text) + (styles.length > 0 ? byteLength(JSON.stringify(styles)) : 0);
}

/**
 * How good a place `text[i]` is to end a part after: higher is better, null when it is no break at all.
 * Web's own order (`" ,;)!?."`, a full stop strongest), a newline above all, and the CJK marks that do the same job
 * (Web's list is ASCII only, so a long Chinese text with no space would otherwise be cut blind).
 */
function breakRank(text, i) {
    const c = text[i];
    if (c === "\n") return 7;
    const cjk = { "。": 6, "？": 5, "！": 4, "；": 2, "，": 1, "、": 1 }[c];
    if (cjk !== undefined) return cjk;
    const ascii = " ,;)!?.".indexOf(c);
    if (ascii === -1) return null;
    const next = text[i + 1];
    return c === " " || next === undefined || next === " " || next === "\n" ? ascii : null;
}

/**
 * Where to cut `text` between `pos` and `end` (the farthest the budget allows): the nearest newline in the last two
 * thirds of the window, else the strongest sentence or clause end there, else `end` itself.
 *
 * @returns {number} the cut: the part is `text.slice(pos, cut)`
 */
function chooseCut(text, pos, end) {
    const floor = pos + Math.floor((end - pos) / 3);
    let best = -1;
    let bestRank = -1;
    for (let i = end - 1; i >= floor && i >= pos; i--) {
        const rank = breakRank(text, i);
        if (rank === null) continue;
        if (rank === 7) return i; // the newline is dropped with the whitespace that follows
        if (rank > bestRank) {
            best = i + 1;
            bestRank = rank;
        }
    }
    return best > pos ? best : end;
}

/**
 * Split one message into parts that each fit {@link MESSAGE_BYTE_LIMIT}. A message that fits comes back untouched
 * (the same text, no trimming), so only a message that needed splitting is ever changed.
 *
 * A style range that spans a cut is clipped into both parts. A mention is never cut: the cut moves before it. A
 * surrogate pair (an emoji) is never cut. Whitespace at a cut is dropped, as Web trims its parts.
 *
 * @param {{text: string, styles?: Array<{start: number, len: number, st: string}>, mentions?: Array<{pos: number, len: number, uid: string}>}} message
 * @param {number} [limit] - bytes per part
 * @returns {Array<{text: string, styles: object[], mentions: object[]}>} at least one part
 */
export function splitMessage({ text, styles = [], mentions = [] }, limit = MESSAGE_BYTE_LIMIT) {
    if (cost(text, styles) <= limit) return [{ text, styles, mentions }];

    const parts = [];
    let pos = 0;
    while (pos < text.length) {
        // The farthest end this part can reach inside the budget (always at least one character).
        let lo = pos + 1;
        let hi = text.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (cost(text.slice(pos, mid), clipStyles(styles, pos, mid)) <= limit) lo = mid;
            else hi = mid - 1;
        }
        let cut = lo;

        if (cut < text.length) {
            cut = chooseCut(text, pos, cut);
            for (const m of mentions) {
                if (m.pos > pos && m.pos < cut && cut < m.pos + m.len) cut = m.pos;
            }
            const high = text.charCodeAt(cut - 1);
            if (high >= 0xd800 && high <= 0xdbff) cut -= 1;
            if (cut <= pos) cut = Math.min(text.length, pos + 2);
        }

        const raw = text.slice(pos, cut);
        const body = raw.trimEnd();
        if (body.length > 0) {
            const end = pos + body.length;
            parts.push({
                text: body,
                styles: clipStyles(styles, pos, end),
                mentions: mentions
                    .filter((m) => m.pos >= pos && m.pos + m.len <= end)
                    .map((m) => ({ ...m, pos: m.pos - pos })),
            });
        }
        pos = cut;
        // Web trims each remainder: the whitespace at a cut belongs to no part.
        while (pos < text.length && /\s/.test(text[pos])) pos++;
    }
    return parts.length > 0 ? parts : [{ text, styles, mentions }];
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send the parts of one message one after another, {@link PART_GAP_MS} apart. Stops at the first part Zalo refuses
 * and says how many had already gone out, because nothing can take those back.
 *
 * @template T
 * @param {Array<object>} parts - from {@link splitMessage}
 * @param {(part: object, index: number) => Promise<T>} send - sends one part, resolves what Zalo answered
 * @param {{gapMs?: number, sleep?: (ms: number) => Promise<void>}} [opts]
 * @returns {Promise<T[]>} what Zalo answered for each part, in order
 * @throws {Error} with `.sent` (the answers of the parts that went out) set when a later part failed
 */
export async function sendParts(parts, send, { gapMs = PART_GAP_MS, sleep = defaultSleep } = {}) {
    const answers = [];
    for (let i = 0; i < parts.length; i++) {
        if (i > 0) await sleep(gapMs);
        try {
            answers.push(await send(parts[i], i));
        } catch (e) {
            if (i === 0) throw e;
            const failure = new Error(
                `${e?.message ?? e} (part ${i + 1} of ${parts.length} failed; the ${i} earlier part(s) were already delivered)`,
                { cause: e },
            );
            failure.sent = answers;
            if (e?.code !== undefined) failure.code = e.code;
            throw failure;
        }
    }
    return answers;
}
