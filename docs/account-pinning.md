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
ZALO_MCP_AUTH_TOKEN=<TOKEN> zalo-mcp --account <ACCOUNT_ID> --http 3847   # loopback; token from the environment
zalo-mcp --account <ACCOUNT_ID> conv recent --json
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

An `mcp start --http` or `listen --daemon` process runs on-demand presence by
default (3.0): it parks its socket when idle but keeps holding the account (its
lock, port and daemon channel). A one-shot command for that account still goes
through it, and wakes the socket when it needs one; it never opens a second
socket beside it.

**One login, one place.** Never run two copies of one account's credentials at
once (the same login on two machines, or a copied config folder): the second
session takes the socket (close code 3000), and an on-demand daemon then waits,
`yielded`, until `zalo-agent presence resume --yes`. Zalo also keeps only one web
login per account: a QR login into Zalo Web elsewhere signs the server out
(`signed_out`). Use the phone or Zalo PC beside the server, not Zalo Web.

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
   `--http 3848`, …), each with its own token in `ZALO_MCP_AUTH_TOKEN_<ACCOUNT_ID>`
   (never `--auth` on the command line: it shows in `ps`) and optional `--config`
   files. `zalo-agent fleet ports`, `fleet generate` and `fleet start` keep the
   port table and the per-account units for you
   ([configuration.md §3.6](configuration.md#36-many-accounts)).
4. **Concurrent CLI commands:** pass `--account <ACCOUNT_ID>` (or `ZALO_ACCOUNT`)
   on every CLI call so concurrent scripts or agents never race on `accounts.json`.
   Changing startup proxy settings requires restarting that account's daemon.
