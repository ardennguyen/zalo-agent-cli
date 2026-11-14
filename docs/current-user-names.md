# Sender identities and current names

[Tiếng Việt](current-user-names.vi.md)

How this client names a person in every output. Where this page and [the command reference](../skill/references/command-reference.md) differ, the command reference is current.

## How names work in 3.0: alias first, everywhere

Every output names a person the way Zalo's own apps do: **the alias the account owner set for them**, then their
phonebook name (only when a caller supplies one: this client reads no phonebook), then their Zalo name, then their
display name, then the uid (`src/core/contact-names.js`). This covers `listen` lines, JSONL and webhooks, the MCP
buffer, notifier and wait results, every `zalo_*` reply, `msg history` / `msg search`, `conv` lists, `friend`
and `group` commands, mentions, quoted messages (`replyTo`), reactions, typing and group events.

| Field | On a message | Meaning |
|---|---|---|
| `senderName` | yes | the name to show: the owner's alias when one is set, else the name the message carried, else the current profile name. **Changed in 3.0:** in 2.x it was the name the message carried |
| `senderAlias` | yes | the alias, or `null` |
| `senderZaloName` | yes | the name the message carried (the stored snapshot, never rewritten) |
| `senderDisplayName`, `senderDisplayNameSource` | yes | the current label and where it came from: `alias`, `phonebook`, `zalo`, `display` or `uid` |
| `displayName` / `dName` / `dpn` / `inviterName` | a person, a `listen` event, a pending member, an invitation | the same alias-first value in the field that already existed |
| `alias`, `zaloName` | a person | the raw values beside it |

**Stored rows are never rewritten.** `zalo.db` keeps the name each message carried; the alias is applied when a row
is shown or returned. A 1-1 conversation is titled by the alias when shown; a group's title never is.

**Where the aliases come from.** A `listen` or `mcp start` daemon reads the account's alias list at start, again
about 1.5 s after Zalo's `alias` control (an alias set, changed or removed on any device) and every 30 minutes. It
keeps the snapshot in the account's database (`user_aliases`, carried by `db export`) so one-shot commands use it
without a request, and it retitles the stored 1-1s whose alias changed. A failed or partial read never replaces the
snapshot (an absent entry means the owner removed that alias, so only a complete read counts). A `profile` control
(the account's own name changed on another device) rereads the account's name. An incoming direct message costs no
alias request: the daemon's snapshot answers it.

## Messages restored from the phone

A phone-backed restore (`zalo-agent sync`) resolves each sender before it stores a batch: a 1-1 conversation's
identity comes from the conversation map, anyone else's from a batched profile lookup. Group identities never become
sender names, and no identity is guessed from message text or the conversation name. A sender that cannot be
resolved keeps its id with an empty name and is tried again by a later restore; a later restore can also fill a
missing id or an empty name, but never replaces a known id or a name already stored.

## Notes

- A restored message that did not carry its sender's original name gets the name the profile has at restore time;
  past names are not reconstructed.
- Profile lookups are best-effort: with no alias or profile available, a person is shown by their id.
- Showing current names adds batched alias and profile requests, never one request per message, and opens no
  second listener.
- Existing rows are enriched only by a later restore; restarting the MCP server or reading history does not rewrite
  them. Back up the account database first (`zalo-agent db backup -o <file>`); a restore needs a tap on the phone.
