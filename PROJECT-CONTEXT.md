# Project context

[Tiếng Việt](PROJECT-CONTEXT.vi.md)

Updated: 2026-10-15. Branch `feat/mcp-sync-requests`, based on upstream main
`f6b9914`. This branch is independent of sender-name PR #2 and account-pinning
PR #3. No unmerged changes from those branches are included.

Source implementation: `zalo_sync` starts a message or reaction sync using the
daemon's existing runners; `zalo_sync_status` reads its progress and result.
One account-local tracker survives separate HTTP requests and shares the stage
lock with CLI sync, history and self-heal. Full details, decisions, security,
rollout and manual validation: [MCP sync](docs/mcp-sync.md). Existing system
architecture/runbook: [deployment](docs/deployment.md).

Status: source contribution, not released/deployed. Full pre-commit gate passed:
1,927 tests passed, 4 skipped, 0 failed (1,931 total); format/lint/check passed.
No live account sync or database migration. Submission is tracked in the
feature branch and the workspace context.
The wrapper's published engine pin remains 2.0.0 and cannot expose these tools
until a new engine is published and the wrapper is updated.
Wrapper PR #1 proposes ^2.0.1; npm currently only has 2.0.0, so its lockfile
regeneration awaits engine publication. Suggested engine/wrapper releases are
2.1.0/1.1.0; neither is published by this contribution.
