# Pinning a listener, MCP server, or CLI command to an account

[Tiếng Việt](account-pinning.vi.md)

Each `listen` or `mcp start` process listens to exactly one account, and any
personal-account CLI command can target a specific registered account for that
process without changing the shared active account in `accounts.json`.

```sh
zalo-agent account list
zalo-agent listen --account <ACCOUNT_ID>
zalo-agent mcp start --account <ACCOUNT_ID>
zalo-agent --account <ACCOUNT_ID> msg send <THREAD_ID> "Hello" --json
ZALO_ACCOUNT=<ACCOUNT_ID> zalo-agent conv recent --json

# Or via the zalo-mcp launcher (v2.0+):
zalo-mcp --account <ACCOUNT_ID>
zalo-mcp --account <ACCOUNT_ID> --http 3847 --auth <TOKEN> --host 0.0.0.0
zalo-mcp --account <ACCOUNT_ID> msg list --json
```

Replace `<ACCOUNT_ID>` with the full numeric ID of a registered account (or set
`ZALO_ACCOUNT=<ACCOUNT_ID>`). Names, numeric prefixes, empty values, and unknown
IDs are rejected. IDs stay strings, so large Zalo IDs are not rounded. This flag
does not change the shared active account in `accounts.json` and does not log in
every registered account.

Without `--account` (or `ZALO_ACCOUNT`), `listen` and `mcp start` select the
active account once at startup and pin it for the lifetime of the process. A
later `account switch` in `accounts.json` does not move a running daemon to
another account, including on reconnect or retry.

Credentials, startup proxy configuration, database (`<DATA_DIR>/<ownId>/zalo.db`),
lock (`daemon.lock`), media, coverage, and daemon channel (`daemon-channel.json`)
all use the selected account. For `listen` and `mcp start`, the lock is acquired
before login; a second listener/MCP for the same account is refused. Startup
login failure releases the lock. Missing credentials or a mismatched
authenticated UID fail closed without falling back to another account. One-shot
CLI commands invoked with `--account <ACCOUNT_ID>` automatically route socket
operations (media upload, `msg history`, `sync`) through that account's running
daemon channel if one is up.

## Running multiple live accounts simultaneously

To keep multiple Zalo accounts live at the same time:

1. **Log in each account** (one dedicated proxy per account is recommended):
   ```sh
   zalo-agent account login -p "http://user:pass@proxy1:8080" -n "Account A"
   zalo-agent account login -p "http://user:pass@proxy2:8080" -n "Account B"
   zalo-agent account list
   ```
2. **stdio MCP (Claude Code / Cursor):** register one `mcpServers` entry per
   account, each with `"args": ["mcp", "start", "--account", "<ACCOUNT_ID>"]`
   (or `"command": "zalo-mcp", "args": ["--account", "<ACCOUNT_ID>"]`).
3. **HTTP MCP (VPS):** run one process per account on separate ports (`--http 3847`,
   `--http 3848`, …) with separate `--auth` tokens (and optional `--config` files).
4. **Concurrent CLI commands:** pass `--account <ACCOUNT_ID>` (or `ZALO_ACCOUNT`)
   on every CLI call so concurrent scripts or agents never race on `accounts.json`.
   Changing startup proxy settings requires restarting that account's daemon.
