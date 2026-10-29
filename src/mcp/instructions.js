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
    "- msgId is one message, and it is called `msgId` in every input and reply. Live messages also carry it as `id`, and a send reply as `messageId`: the same value, kept for older clients.",
    "- userId is a Zalo user. A message's author is its `senderId` (a userId); group members have a `userId`. `@[userId]` mentions someone.",
    "- cliMsgId is the sender's own id for a message. zalo_send_message returns it, and zalo_react and zalo_undo need it (they read it from the cache when you leave it out).",
    '- threadType, as an input, is the number 0 (DM) or 1 (group); leave it out and the type stored for the thread is used. Messages show `threadType` as the text "dm" or "group": never pass that text back.',
    "",
    "READING",
    "- To receive messages, wait with zalo_wait_for_message or poll with zalo_get_messages, then call zalo_mark_read with the returned `cursor`. If several bots share the server, each passes its own `consumer` name.",
    "- For older messages use zalo_get_history (one conversation) or zalo_search_messages (text, across all conversations).",
    "",
    "SENDING TEXT",
    "- Put real line breaks in `text`. Never type the two characters backslash and n: Zalo shows them as typed.",
    '- Markdown is converted to Zalo formatting by default; `format: "plain"` sends the text as written.',
    "- Mention someone in a group with `@[uid]` (`@[-1]` is everyone). Reply to a message with `quoteMsgId`.",
    "- A text over 3000 bytes goes out as several messages; the reply lists each part.",
    "- A sent message cannot be edited. To correct one, recall it with zalo_undo (msgId and cliMsgId from the send reply) and send it again.",
    "",
    "RULES",
    "- Call zalo_sync only when the owner asked: it makes the owner's phone ask for a confirmation.",
    "- zalo_group `leave` and `remove_member` need `confirm: true`.",
    "- A refused call says why in its error text. Fix the argument it names; do not repeat the same call.",
].join("\n");
