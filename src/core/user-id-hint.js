/**
 * A clearer refusal when Zalo does not know a user id. A user's id is not the same from every account: another account
 * sees a person under its own id for them. Sent to a user under an id this account does not know (another account's own
 * uid, say), Zalo answers only "Tham số không hợp lệ" (invalid parameter), which says nothing about the id.
 */

/** Zalo's code for an invalid parameter. */
export const INVALID_PARAM_CODE = 114;

/**
 * The error's text, with a note on how to find the right id when Zalo refused a user conversation's parameters.
 * Groups and other errors come back unchanged.
 *
 * @param {unknown} e - the error
 * @param {string} threadId
 * @param {number|string} [type] - 0 a user, 1 a group
 * @returns {string}
 */
export function withUserIdHint(e, threadId, type = 0) {
    const message = e instanceof Error ? e.message : String(e ?? "");
    if (Number(type) !== 0) return message;
    const invalid = Number(e?.code) === INVALID_PARAM_CODE || /tham số không hợp lệ|invalid param/i.test(message);
    if (!invalid) return message;
    return (
        `${message}. If ${threadId} is not an id this account knows (a user's id differs from account to account; ` +
        "another account's own uid is not it), look the user up first: `zalo-agent friend list`, " +
        "`friend find <phone>` or `conv list`."
    );
}
