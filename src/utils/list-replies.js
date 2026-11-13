/**
 * What a list command prints with `--json` when Zalo's answer is empty ("", null, nothing, or `{}`): the natural empty
 * value of its reply, never `{"success": true}`, which a caller reading a list cannot use (src/utils/output.js jsonReply).
 *
 * An array-shaped reply empties to `[]`; an object-shaped one to its documented object with the list fields empty
 * (what the human formatter of each command reads). tests/cli/json-contract.test.js holds every list-named command to
 * it in the empty-reply walks.
 */

/** Command path → a function giving its empty reply (a fresh value each time). */
const LIST_REPLIES = {
    "msg sticker-list": () => [],
    "friend list": () => [],
    "friend close": () => [],
    "friend online": () => ({ onlines: [] }),
    "friend alias-list": () => ({ items: [] }),
    "friend sent-requests": () => ({}),
    "friend recommendations": () => ({ recommItems: [] }),
    "friend find-phones": () => ({}),
    "friend common-groups": () => ({ groupRelateds: {}, shared: [] }),
    "group members-info": () => ({ profiles: {} }),
    "group pending": () => ({ users: [] }),
    "group blocked": () => ({ blocked_members: [], has_more: false }),
    "group invite-boxes": () => ({ invitations: [], total: 0, hasMore: false }),
    "conv archived": () => ({ items: [] }),
    "conv muted": () => ({ chatEntries: [], groupChatEntries: [] }),
    "profile avatars": () => ({ photos: [], hasMore: false }),
    "reminder responses": () => ({ acceptMember: [], rejectMember: [] }),
    "auto-reply list": () => ({ item: [] }),
    "quick-msg list": () => ({ items: [] }),
    "label list": () => ({ labelData: [] }),
    "catalog list": () => ({ items: [], has_more: false }),
    "catalog products": () => ({ items: [], has_more: false }),
    "bank accounts": () => ({ myBanks: [], hasMore: false }),
};

/** The commands whose empty reply is a list value (for the contract test). */
export const LIST_COMMANDS = Object.freeze(Object.keys(LIST_REPLIES));

/**
 * A command's path below the program: "conv archived".
 *
 * @param {{name: () => string, parent?: object|null}|null} command
 * @returns {string}
 */
export function commandPath(command) {
    const parts = [];
    for (let c = command; c?.parent; c = c.parent) parts.unshift(c.name());
    return parts.join(" ");
}

/**
 * The empty reply of a list command, or undefined for any other command.
 *
 * @param {string} path - e.g. "conv archived"
 * @returns {object|Array|undefined}
 */
export function emptyListReply(path) {
    return Object.hasOwn(LIST_REPLIES, path) ? LIST_REPLIES[path]() : undefined;
}
