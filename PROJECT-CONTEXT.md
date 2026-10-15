# Project context

[Tiếng Việt](PROJECT-CONTEXT.vi.md)

Updated: 2026-10-15. Branch: `fix/sync-sender-identities`. Base: `f6b9914`.

## Current change

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

- `senderName` remains the stored historical/first-known snapshot. Phone restores
  that do not carry the original name can only fill an empty snapshot from the
  profile observed during restoration; this does not reconstruct past names.
- `senderDisplayName` is resolved at read time by UID: this account's explicit
  alias, then the profile's `zaloName`, then UID. `senderDisplayNameSource` is
  `alias`, `zalo`, or `uid`. The ambiguous API `displayName` is not a substitute
  for `zaloName` in this hierarchy.
- MCP buffered/history reads and CLI message history expose these additive
  fields. CLI human-readable history prints the current label. Display reads
  do not modify SQLite or the message buffer's historical names.
- Current labels use fresh account-scoped API reads, with alias pagination and
  profile batches of 100. No cross-request alias cache survives alias removal.
  Failure/partial alias snapshots are discarded; unavailable profiles fall
  back to UID rather than a stale historical name.
- Sync refreshes cached DM titles, including non-friends outside the requested
  message window, without changing activity order. MCP DM conversation lists,
  thread lists, and searches also refresh current labels. Group titles are
  never replaced by a member's alias.

## Validation and state

- Change targets [upstream PR #2](https://github.com/ardennguyen/zalo-agent-cli/pull/2);
  upstream review and release are pending.
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
MCP or reading history does not rewrite them. Back up the account database before
an operational restore and use the documented `sync-mobile` options in
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
