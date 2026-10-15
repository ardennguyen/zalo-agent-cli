# Changelog

[Tiếng Việt](CHANGELOG.vi.md)

## Unreleased — 2026-10-15

- Target `v2.0-dev` and run CI for that branch. Keep the changelog; move the
  feature reference to `docs/current-user-names.md` instead of a root context file.

- Add current `senderDisplayName` and `senderDisplayNameSource` alongside the
  preserved historical `senderName` in MCP/CLI message reads. Current labels
  prefer the account owner's explicit alias, then `zaloName`, then UID.
- Refresh DM conversation names during sync, including cached peers outside
  the message window, and on MCP conversation/thread/search reads. Alias removal
  and profile renames do not rewrite message snapshots or activity ordering.
- Add regression coverage for pagination, alias removal/renames, account
  isolation, failed lookups, reconnecting API proxies, and current versus
  historical names. Display reads perform no database writes.

- Resolve phone-restored sender IDs to user IDs and display names using known
  DM mappings and the existing batched profile resolver; keep unknown senders
  explicitly unresolved when lookup fails.
- Enrich missing sender identities on message replay without replacing known
  numeric senders or nonempty names, or reviving recalled messages.
- Add offline regression coverage for sender resolution, replay protection,
  and names returned by MCP history. Existing cached history needs a message
  restore with the fixed engine; reading history alone does not backfill names.

This entry records an unreleased change, not a publication or deployment.
