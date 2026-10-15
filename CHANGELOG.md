# Changelog

[Tiếng Việt](CHANGELOG.vi.md)

## Unreleased — 2026-10-15

- Resolve phone-restored sender IDs to user IDs and display names using known
  DM mappings and the existing batched profile resolver; keep unknown senders
  explicitly unresolved when lookup fails.
- Enrich missing sender identities on message replay without replacing known
  numeric senders or nonempty names, or reviving recalled messages.
- Add offline regression coverage for sender resolution, replay protection,
  and names returned by MCP history. Existing cached history needs a message
  restore with the fixed engine; reading history alone does not backfill names.

This entry records an unreleased change, not a publication or deployment.
