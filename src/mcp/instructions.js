/**
 * What every agent connecting to this MCP server is told once, on connect (the MCP `instructions` field), before it
 * reads a single tool. The tool descriptions say what each tool does; this says what they share: the ids, the way to
 * read and to send, and the few rules a model gets wrong without being told. Keep it short: clients put it in the
 * model's context on every session.
 */
export const SERVER_INSTRUCTIONS = [
    "Zalo MCP server: read and send messages on one Zalo account.",
    "",
    "IDS",
    "- threadId is the conversation: the other person's user id for a DM, the group id for a group. Find one by name with zalo_search_threads, among recent ones with zalo_list_conversations, or from a phone number or username with zalo_lookup_user. `me` is the owner's My Documents.",
    "- msgId is one message, and it is called `msgId` in every input and reply.",
    "- userId is a Zalo user. A message's author is its `senderId` (a userId); group members have a `userId`. `@[userId]` mentions someone.",
    "- cliMsgId is the sender's own id for a message. zalo_send_message returns it, and zalo_react and zalo_undo need it (they read it from the cache when you leave it out).",
    "- threadType is `dm` or `group`, in inputs and in replies. Leave it out: the type stored for the thread is used.",
    "",
    "READING",
    "- To receive messages, wait with zalo_wait_for_message or poll with zalo_get_messages, then call zalo_mark_read with the returned `cursor`. If several bots share the server, each passes its own `consumer` name.",
    '- A recall arrives in that list as an entry with `type` "undo": its `msgId` is the recalled message and its `text` is empty.',
    "- For older messages use zalo_get_history (one conversation) or zalo_search_messages (text, across all conversations).",
    "",
    "SENDING TEXT",
    "- Put real line breaks in `text`. Never type the two characters backslash and n: Zalo shows them as typed.",
    '- Markdown is converted to Zalo formatting by default; `format: "plain"` sends the text as written.',
    "- Mention someone in a group with `@[uid]` (`@[-1]` is everyone). Reply to a message with `quoteMsgId`.",
    "- A text over 3000 bytes goes out as several messages; the reply lists each part.",
    "- A sent message cannot be edited. To correct one, recall it with zalo_undo (msgId and cliMsgId from the send reply) and send it again.",
    "",
    "THE REST OF THE ACCOUNT",
    "- zalo_conversation (pin, mute, archive, hide, mark read, delete), zalo_group, zalo_friend, zalo_profile, zalo_catalog, zalo_bank, zalo_auto_reply, zalo_quick_message, zalo_cloud, zalo_sticker and zalo_link each take an `action`: the CLI subcommand's name with _ for -.",
    "",
    "RULES",
    "- Call zalo_sync only when the owner asked: it makes the owner's phone ask for a confirmation.",
    "- A refused call says why in its error text. Fix the argument it names; do not repeat the same call.",
    "",
    "GUARDED ACTIONS",
    "- Actions Zalo Web asks about first are guarded: zalo_undo, zalo_delete_message, every zalo_write, and the removing or blocking actions of the tools above (each description names its own, e.g. zalo_group `leave`, `disperse`, zalo_friend `remove`, `block`). `dryRun: true` says what one would do and sends nothing; `confirm: true` goes ahead.",
    "- The FIRST time you reach a guarded action, stop and ask the user how they want these handled: always ask them first, let you confirm on your own for some kinds of action, or never do them. Remember the answer in the way you and the user agree on (your memory, the project's rules, its CLAUDE.md or AGENTS.md) so you do not ask again, and follow it: send `confirm: true` only where the user allowed it.",
    '- A refusal with `confirmationRequired` means nothing was sent; repeat the call with `confirm: true` only when allowed. If the server says its confirm mode is "human", it asks the user itself and your `confirm` does not answer for them; a decline means do not retry. Over HTTP it cannot ask: that refusal names what to change.',
    "- Try zalo_write with `dryRun: true` first.",
].join("\n");
