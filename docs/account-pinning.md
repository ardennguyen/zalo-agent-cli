# Pinning a listener or MCP server to an account

[Tiếng Việt](account-pinning.vi.md)

Unreleased change. Each process still listens to exactly one account.

Validated 2026-10-15 on Node 24.11.0: formatting, zero-warning lint, format check,
and the full offline suite passed (1,922 passed, 4 skipped, 0 failed).

```sh
zalo-agent account list
zalo-agent listen --account <ACCOUNT_ID>
zalo-agent mcp start --account <ACCOUNT_ID>
```

Replace `<ACCOUNT_ID>` with the full numeric ID of a registered account. Names,
numeric prefixes, empty values, and unknown IDs are rejected. IDs stay strings,
so large Zalo IDs are not rounded. This flag does not change the shared active
account and does not log in every registered account.

Without the flag, the active account is selected once at startup and is also
pinned. A later registry switch does not move that daemon to another account,
including on reconnect or retry.

Credentials, startup proxy configuration, database, lock, media, coverage and
daemon channel all use the selected account. The lock is acquired before login;
a second listener/MCP for the same account is refused. Startup login failure
releases the lock. Missing credentials or a mismatched authenticated UID fail
closed without falling back to another account. No registry/database migration
or stored-message rewrite is needed.

For multiple accounts, run a separate process per ID. HTTP MCP instances need
different ports and can use separate `--config` files/authentication tokens.
Changing startup proxy settings requires restarting that daemon.

The inspected `zalo-mcp` wrapper forwards only `--http` and `--auth`, not this
flag. Use the published engine's `zalo-agent mcp start --account <ACCOUNT_ID>`
entry point or wait for wrapper support. Passing the flag to that wrapper does
not pin an account. This change does not modify a deployed wrapper or install
an unreleased engine.

Offline regressions cover exact selection, unchanged active registry, repeated
reconnects after an active-account switch, per-account proxies, missing/failed/
mismatched login, lock-before-login ordering, cleanup, and stdio-safe MCP errors.
Live multi-account reconnects remain unverified and need an authorized test
environment after review/release.
