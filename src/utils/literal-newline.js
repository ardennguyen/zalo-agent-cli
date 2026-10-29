/**
 * A text that has the two characters backslash and `n` where a line break was meant.
 *
 * A model that double-escapes its tool arguments sends `Hello\n\nWorld` as a backslash and an n, and Zalo shows them
 * as typed. The text is never changed here (a backslash-n can be exactly what someone means, in a code sample or a
 * Windows path): the sender is only told, so the agent can see its own mistake in the tool result.
 *
 * It fires only when the text has such a sequence and no real line break at all; a text that has both is a code
 * sample or a deliberate mix, and a text of many lines that happens to contain `\n` once is not the mistake.
 */

/**
 * @param {string} text
 * @returns {boolean} true when `text` contains a backslash followed by `n` and no real newline
 */
export function hasLiteralNewline(text) {
    return typeof text === "string" && text.includes("\\n") && !/[\r\n]/.test(text);
}

/** What the sender is told, in the reply's `warnings`. */
export const LITERAL_NEWLINE_WARNING =
    "The text has the two characters backslash and n (\\n) and no line break, and Zalo shows them as typed, not as " +
    "a new line. If you meant line breaks, send the message again with real newlines and recall this one with " +
    "zalo_undo (its msgId and cliMsgId are in this reply).";
