# Changelog

[Tiếng Việt](CHANGELOG.vi.md)

## Unreleased — 2026-10-15

- Target v2.0-dev, enable CI for that target, and remove root project-context
  files. Add proposed 2.1.0 release notes and a cloud release-preparation template
  under release_notes/; no workflow activation, tag or publication.

- Add `zalo_sync` (messages/reactions) and `zalo_sync_status`, taking the MCP
  surface from 12 to 14 tools. Starts return immediately; phone confirmation
  remains required for message restores.
- Track bounded account-local jobs across stdio/HTTP requests, deduplicate
  request retries and use the daemon's shared sync/history lock and runners.
- Preserve partial outcomes; no new writer, socket, migration or deployment.
- Recommend engine 2.1.0 and wrapper 1.1.0 releases, with wrapper range ^2.0.1;
  npm currently has only 2.0.0, so wrapper lockfile regeneration awaits release.
