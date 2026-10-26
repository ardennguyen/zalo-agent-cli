# Sync through MCP

[Tiếng Việt](mcp-sync.vi.md)

The engine exposes 26 MCP tools, including `zalo_sync` and `zalo_sync_status`
(available in `@ardennguyen/zalo-agent-cli` v2.1.0+ and `@ardennguyen/zalo-mcp`
v2.0.0+). `mcp start --account <ID>` (or `ZALO_ACCOUNT=<ID>`) pins the process
to a specific registered account at startup and across reconnects; sync tools
use only that account's runners and lock, with no per-request account override.

## Usage

Call `zalo_sync` only after the owner explicitly requests synchronization. A
coverage report or missing search result alone does not authorize a phone prompt.

```json
{"requestId":"restore-october-1","stage":"messages","from":"2026-10-01"}
```

The tool returns immediately with `jobId`, `state: "running"` and
`phoneConfirmationRequired: true`. Tell the owner to approve the request in the
Zalo phone app. Poll `zalo_sync_status` with `{"jobId":"<returned jobId>"}` every
few seconds. Omitting jobId returns the latest job or `{"state":"idle"}`.

Messages supports `days` (positive integer, up to 36500) **or** `from` (valid
YYYY-MM-DD UTC date). Omit both for all history the phone still holds. The window
applies to all conversations, not a single group. `waitMs` is an optional
30000–600000 ms per-phase budget, not a total job deadline.

For the reaction backlog, call:

```json
{"requestId":"reactions-october-1","stage":"reactions","applyRemovals":true}
```

Reactions has no date window or phone restore prompt. `applyRemovals` defaults to
true and only applies observed reaction removals to the local cache. The stage
does not send reactions or change messages on Zalo. It returns runner counts and
`socketAlive`. This is not the unified CLI sync: conversation state, boards,
cloud index and bulk media remain CLI operations.

## Results and retries

`completed` means the stage returned, not proof of a complete restore. Inspect
`result.reason`, `confirmed`, saved counts and `zalo_coverage` afterward. A
`partial`, `timeout`, `socket-lost` or unconfirmed result must be reported as
such. The runner preserves received data; the job tracker adds no database writes.
Failure produces `state: "failed"` with `error`; the stage lock is always released.
A phone that rejects the request, cancels it, is busy, is low on storage or is
signed out also fails the job, with that reason in `error`: nothing is restored
and nothing is recorded as synced. Only the phone's confirmations count as
`confirmed`, and the wait for one is ten minutes.

Use a unique 1–64 character `requestId` (`A-Z a-z 0-9 . _ : -`) for a new run.
Retry the same key **and arguments** after a client timeout: while retained, it
returns the existing job without starting sync or sending another prompt.
Reusing a key with changed parameters is an error. A busy socket stage returns
an MCP error immediately; no queued or automatic retry is created.

The process keeps the last ten jobs and twenty recent progress events per job
in memory. Jobs, results and request deduplication disappear on restart or
eviction. Check latest status when a start response is lost. After a daemon
restart, check cache coverage before deciding whether another restore is needed.
Closing an MCP request does not cancel its job. No cancellation tool is exposed
because the existing runners have no safe abort contract; do not start another
run to cancel one. Stopping the daemon interrupts work and may leave a partial
restore; no automatic resume is promised.

## Architecture, security and validation

`mcp start` creates one `createSyncJobs` tracker and passes it to both stdio and
HTTP tools. HTTP creates a fresh MCP server per request but shares the tracker.
Both tools call the same `createSyncRunners` as the CLI daemon channel, resolve
the current API per run, and hold the same stage lock as history and self-heal.
No second login, WebSocket, database connection or writer is introduced. A
reconnect updates future runs; socket loss during a restore can end it partially,
as for existing daemon-routed CLI sync.

The tools inherit existing MCP access: the same HTTP bearer token permits sync,
and stdio has the client's local process access. There is no per-bot permission
boundary. `zalo_sync_status` is read-only and never contacts Zalo. Logs remain on
stderr; no job persistence or schema migration. Rollback is a previously published
engine and client restart, following [deployment guidance](deployment.md).

Offline validation covers parameter validation through the SDK, lock exclusion,
idempotent retries, bounded retention, failure/partial outcomes, account-local
state and current-session selection. Real stdio and stateless HTTP transports
use fake runners and synthetic data. No live phone sync or deployment was tested.
Before release, a maintainer should manually request a short restore, approve
the phone, poll through completion and verify cache coverage, then test an
interrupted restore. Do this in a non-production test account.
