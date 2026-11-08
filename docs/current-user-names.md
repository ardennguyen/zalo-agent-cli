# Sender identities and current names

[Tiếng Việt](current-user-names.vi.md)

How this client names a person in every output (3.0), then the 2.x change that introduced current labels ([PR #2](https://github.com/ardennguyen/zalo-agent-cli/pull/2)), kept as history. Where this page and [the command reference](../skill/references/command-reference.md) differ, the command reference is current.

## How names work in 3.0: alias first, everywhere

Every output names a person the way Zalo Web and PC do: **the alias the account owner set for them**, then their
phonebook name (only when a caller supplies one: this client reads no phonebook), then their Zalo name, then their
display name, then the uid (`src/core/contact-names.js`). This covers `listen` lines, JSONL and webhooks, the MCP
buffer, notifier and wait results, every `zalo_*` reply, `msg history` / `msg search`, `conv` lists, `friend`
and `group` commands, mentions, quoted messages (`replyTo`), reactions, typing and group events.

| Field | On a message | Meaning |
|---|---|---|
| `senderName` | yes | the name to show: the owner's alias when one is set, else the name the message carried, else the current profile name. **Changed in 3.0:** it used to be the name the message carried |
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

The rest of this page is the 2.x change that introduced current labels, kept as history.

## The 2.x change (history)

Phone-restored messages previously stored opaque sender IDs and empty names.
Sync now resolves senders before each chunk's SQLite transaction, reusing DM
identities from the conversation map and the existing batched profile
`gid/decrypt` + `getUserInfo` fallback for other users. Group identities never
seed sender names. A per-run cache avoids repeated requests, including failed
lookups. Unresolved IDs remain intact with an empty name; no identity is inferred
from message text or the conversation name.

The existing message upsert can enrich an opaque/missing sender ID and fill an
empty name on replay. It preserves established numeric identities, nonempty
names, recall tombstones, attachment paths, and monotonic receipt status.

Current display labels are now separate from message snapshots:

- `senderName` remained the stored historical/first-known snapshot (in 3.0 that value is `senderZaloName`). Phone restores
  that do not carry the original name can only fill an empty snapshot from the
  profile observed during restoration; this does not reconstruct past names.
- `senderDisplayName` is resolved at read time by UID: this account's explicit
  alias, then the profile's `zaloName`, then UID. `senderDisplayNameSource` was
  `alias`, `zalo`, or `uid` (3.0 adds `phonebook` and `display`). The ambiguous API `displayName` is not a substitute
  for `zaloName` in this hierarchy.
- MCP buffered/history reads and CLI message history expose these additive
  fields. CLI human-readable history prints the current label. Display reads
  do not modify SQLite or the message buffer's historical names.
- Current labels used fresh account-scoped API reads, with alias pagination and
  profile batches of 100 (in 3.0 a daemon keeps a complete alias snapshot instead,
  replaced by every complete read, see above).
  Failure/partial alias snapshots are discarded; unavailable profiles fall
  back to UID rather than a stale historical name.
- Sync refreshes cached DM titles, including non-friends outside the requested
  message window, without changing activity order. MCP DM conversation lists,
  thread lists, and searches also refresh current labels. Group titles are
  never replaced by a member's alias.

## Validation (2.x)

- Shipped in 2.x through [PR #2](https://github.com/ardennguyen/zalo-agent-cli/pull/2).
- Regression suite: `tests/unit/sync-v2-senders.test.js`, including SQLite-to-MCP
  history output and protection against conflicting sender identities.
- Required gate: `npm run format`, `npm run lint`, `npm run format:check`, `npm test`.
- Full gate passed on Node 24.11.0: 1,922 tests passed, 4 skipped, 0 failed
  (`npm test -- --test-concurrency=4`). Loopback daemon tests required execution
  outside the socket-restricted sandbox. Formatting and zero-warning lint passed.
- No live account sync, production database edits, wrapper update, or deployment
  was performed. Offline tests use synthetic identities and isolated databases.

## Operation and limitations

No schema migration is needed. Existing rows are enriched when they are replayed
by a later phone-backed message restore using the fixed engine. Merely restarting
MCP or reading history does not rewrite them. Back up the account database (`zalo-agent db backup -o <file>`; the database is
encrypted at rest since 3.0) before an operational restore and use the documented `sync-mobile` options in
`skill/references/command-reference.md`; a restore requires phone confirmation.

Profile lookups are best-effort. A resolved UID falls back to its own ID for
current display when alias/profile data is unavailable. An opaque sender is
retried on a later restore rather than once per message. Current-name reads
add alias/profile REST requests, batched rather than one request per message;
they open no listener and introduce no new account credentials. No live API
rate-limit or load measurement has been performed. The wrapper continues using
its pinned published engine until
its normal release/update process installs a version containing the fix.

Existing project references: `README.md`, `docs/deployment.md`,
`docs/agent-notes.md`, and `skill/references/command-reference.md`.
