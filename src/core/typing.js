/**
 * Sending the "typing…" indicator (`msg typing`, zalo_conversation `typing`): one function, one reply, and Zalo's
 * privacy rule for strangers.
 *
 * Zalo does not send typing to a stranger in a 1-1 conversation when the `enable_new_privacy_stranger_chat`
 * switch is on and the peer is a stranger. This client follows it, using the
 * friend list this process already holds ({@link rememberFriends}: the MCP server loads it on start). A one-shot CLI
 * holds none: the cache is cold, so the indicator is sent and the reply says the check could not be made. Groups are
 * never checked.
 */
import { THREAD_TYPE } from "../zalo/enums.js";

/** The friend ids this process knows, or null while it knows none (cold). */
let friends = null;

/**
 * Remember this account's friends (from `getAllFriends`, or a list of ids), replacing what was known.
 *
 * @param {Array<string|{userId?: string, uid?: string}>|null} list - null forgets them (cold again)
 */
export function rememberFriends(list) {
    if (!Array.isArray(list)) {
        friends = null;
        return;
    }
    friends = new Set(
        list.map((f) => (f && typeof f === "object" ? String(f.userId ?? f.uid ?? "") : String(f))).filter(Boolean),
    );
}

/**
 * Whether a user is a friend: true, false, or null when this process knows no friend list.
 *
 * @param {string} userId
 * @returns {boolean|null}
 */
export function isKnownFriend(userId) {
    return friends === null ? null : friends.has(String(userId));
}

/**
 * Show the typing indicator in a conversation, unless it is a 1-1 with a stranger.
 *
 * Reply: `{success, threadId, threadType, friendCheck, note?}`; `friendCheck` is "friend", "unknown" (no friend list
 * in this process, sent anyway) or "group" (not checked).
 *
 * @param {object} api - logged-in session
 * @param {{threadId: string, type: 0|1, ownId?: string, isFriend?: (userId: string) => boolean|null}} opts
 * @returns {Promise<{success: true, threadId: string, threadType: "dm"|"group", friendCheck: string, note?: string}>}
 * @throws {Error} for a stranger in a 1-1 conversation, before any request
 */
export async function sendTyping(api, { threadId, type, ownId, isFriend = isKnownFriend }) {
    const id = String(threadId);
    const group = Number(type) === THREAD_TYPE.GROUP;
    let friendCheck = "group";
    if (!group) {
        const known = ownId && id === String(ownId) ? true : isFriend(id);
        if (known === false) {
            throw new Error(
                "Not sent: this user is not a friend, and Zalo never shows a stranger that you are typing " +
                    "(its privacy rule for strangers' chats).",
            );
        }
        friendCheck = known ? "friend" : "unknown";
    }
    await api.sendTypingEvent(id, group ? THREAD_TYPE.GROUP : THREAD_TYPE.USER);
    return {
        success: true,
        threadId: id,
        threadType: group ? "group" : "dm",
        friendCheck,
        ...(friendCheck === "unknown" && {
            note:
                "Sent without checking whether this user is a friend: no friend list is loaded in this process. " +
                "Zalo does not send typing to strangers.",
        }),
    };
}
