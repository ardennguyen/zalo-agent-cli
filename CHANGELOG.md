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

- Add proposed 2.1.0 release notes and a cloud release-preparation template
  under release_notes/; no workflow activation, tag or publication.

- Add `zalo_sync` (messages/reactions) and `zalo_sync_status`, taking the MCP
  surface from 12 to 14 tools. Starts return immediately; phone confirmation
  remains required for message restores.
- Track bounded account-local jobs across stdio/HTTP requests, deduplicate
  request retries and use the daemon's shared sync/history lock and runners.
- Preserve partial outcomes; no new writer, socket, migration or deployment.
- Recommend engine 2.1.0 and wrapper 1.1.0 releases, with wrapper range ^2.0.1;
  npm currently has only 2.0.0, so wrapper lockfile regeneration awaits release.

This entry records an unreleased change, not a publication or deployment.
