/**
 * Lossless ids in JSON text: quote the bare integers under a known list of keys before `JSON.parse` sees them.
 *
 * Zalo sends ids (user, group, message, action ids) as bare JSON integers, many past 2^53, which `JSON.parse` rounds.
 * No big-number parser is used. Each socket handler runs its frame text through a pass
 * that wraps the digits of every listed key's value in quotes, then parses it plainly. The pass also reaches the
 * same keys inside JSON that is held, escaped, in a string value (`"data":"{\"uid\":123}"`), so a nested payload
 * parsed later keeps its ids too.
 *
 * Consequences:
 *  - a listed key's integer becomes a string, however small (`"msgId":5` -> `"5"`);
 *  - an integer under a key that is not listed stays a number (lossy past 2^53);
 *  - negative numbers, decimals and exponents are left as they are;
 *  - in an array under a listed key (`"ids":[1,2]`), each bare integer item is quoted and other items are left alone.
 *
 * The key lists are Zalo's, one per socket handler family (chat, control, request/response). Pure functions, no I/O.
 */

/** Keys the chat handler quotes (messages, receipts, recalls: cmds 501, 521, 502, 522, 504, 510, 511, ...). */
export const CHAT_ID_KEYS = Object.freeze([
    "uidFrom",
    "uidTo",
    "uid",
    "ownerId",
    "destId",
    "srcId",
    "fromUid",
    "threadId",
    "globalMsgId",
    "globalDelMsgId",
    "msgId",
    "refMessageId",
    "actionId",
    "lastActionIdOther",
    "lastActionId",
    "resetLastActionId",
    "lastId",
    "ids",
]);

/** Keys the control handler quotes (controls, reactions, typing: cmds 601, 602, 603, 610, 611, 612, ...). */
export const CTRL_ID_KEYS = Object.freeze([
    "uid",
    "group_id",
    "owner_id",
    "groupId",
    "msgId",
    "refMessageId",
    "actionId",
    "lastActionIdOther",
    "lastActionId",
    "resetLastActionId",
    "lastId",
    "ids",
]);

/** Keys the request/response handler quotes: the chat list without the two global message id keys. */
export const API_ID_KEYS = Object.freeze(CHAT_ID_KEYS.filter((k) => k !== "globalMsgId" && k !== "globalDelMsgId"));

/** One compiled pattern per key list, keyed by the list's joined text. */
const PATTERNS = new Map();

/**
 * The pattern for one key list. Groups: 1 the backslashes before each quote of the key (0 at the top level, 1 or more
 * inside an escaped JSON string; the closing quote must carry the same), 2 the key, 3 and 4 the spacing around the
 * colon, 5 a bare unsigned integer (not followed by more of a number), 6 the inside of an array with no nested
 * array or object.
 *
 * @param {readonly string[]} keys
 * @returns {RegExp}
 */
function patternFor(keys) {
    const sig = keys.join("\n");
    let re = PATTERNS.get(sig);
    if (!re) {
        const names = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        re = new RegExp(String.raw`(\\*)"(${names})\1"(\s*):(\s*)(?:(\d+)(?![\d.eE])|\[([^[\]{}]*)\])`, "g");
        PATTERNS.set(sig, re);
    }
    return re;
}

/** Quote one array's bare-integer items, keeping every other item and all spacing as it was. */
function quoteItems(inside, esc) {
    return inside
        .split(",")
        .map((item) => item.replace(/^(\s*)(\d+)(\s*)$/, (_m, a, n, b) => `${a}${esc}"${n}${esc}"${b}`))
        .join(",");
}

/**
 * Quote the bare integers under `keys` in a JSON text, so a plain `JSON.parse` keeps
 * every digit of those ids. Text that is not a string, an empty text, or an empty key list is returned unchanged.
 *
 * @param {string} text - JSON text (a whole frame payload, or a nested payload)
 * @param {readonly string[]} keys - the keys whose integer values become strings
 * @returns {string} the same JSON with those integers quoted
 */
export function preParse(text, keys) {
    if (typeof text !== "string" || text.length === 0 || !Array.isArray(keys) || keys.length === 0) return text;
    return text.replace(patternFor(keys), (_m, esc, key, s1, s2, num, inside) => {
        const head = `${esc}"${key}${esc}"${s1}:${s2}`;
        if (num !== undefined) return `${head}${esc}"${num}${esc}"`;
        return `${head}[${quoteItems(inside, esc)}]`;
    });
}

/**
 * `JSON.parse` after {@link preParse}: the ids under `keys` arrive as strings, every digit kept.
 *
 * @param {string} text - JSON text
 * @param {readonly string[]} keys - the keys whose integer values become strings
 * @returns {any} the parsed value
 * @throws {SyntaxError} when the text is not JSON
 */
export function parseWithIds(text, keys) {
    return JSON.parse(preParse(text, keys));
}
