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
names, recall tombstones, attachment paths, and monotonic receipt status. MCP
history continues reading these fields directly from the cache.

## Validation and state

- Local implementation; upstream review and release are pending.
- Regression suite: `tests/unit/sync-v2-senders.test.js`, including SQLite-to-MCP
  history output and protection against conflicting sender identities.
- Required gate: `npm run format`, `npm run lint`, `npm run format:check`, `npm test`.
- Gate passed locally on Node 24.11.0: 1,906 tests passed, 4 skipped, 0 failed
  (`npm test -- --test-concurrency=4` runs the full suite with bounded concurrency).
- No live account sync, production database edits, wrapper update, or deployment
  was performed. Offline tests use synthetic identities and isolated databases.

## Operation and limitations

No schema migration is needed. Existing rows are enriched when they are replayed
by a later phone-backed message restore using the fixed engine. Merely restarting
MCP or reading history does not rewrite them. Back up the account database before
an operational restore and use the documented `sync-mobile` options in
`skill/references/command-reference.md`; a restore requires phone confirmation.

Profile lookups are best-effort. A resolved UID can still have no display name
when profile data is unavailable. An unresolved sender is retried on a later
restore rather than once per message. Existing profile endpoint batching and
request behavior are unchanged; no second listener or new account credentials
are introduced. The wrapper continues using its pinned published engine until
its normal release/update process installs a version containing the fix.

Existing project references: `README.md`, `docs/deployment.md`,
`docs/agent-notes.md`, and `skill/references/command-reference.md`.
