# Zalo MCP Server & CLI Installation Guide

[Tiếng Việt](INSTALLATION.vi.md)

This document covers deploying the **`zalo-mcp`** wrapper — a self-contained, sandboxed installer that pulls in the `zalo-agent-cli` engine and exposes it as a Model Context Protocol (MCP) server, so AI agents (Claude Code, Cursor, and others) can automate Zalo Personal & Official Accounts without touching your global system.

> If you only want the CLI (no MCP server), skip straight to `npm install -g @ardennguyen/zalo-agent-cli` — see the main [README.md](README.md).

---

## How the two repos relate

- **`zalo-agent-cli`** (this repo) — the core engine. All API logic, auth, and the actual MCP server source (`src/mcp/`) live here.
- **`zalo-mcp`** — a lightweight deployment wrapper (separate repo: [github.com/ardennguyen/zalo-mcp](https://github.com/ardennguyen/zalo-mcp)). It contains no engine code; its install script pulls `zalo-agent-cli` into an isolated local folder, links the global `zalo-mcp` and `zalo-agent` CLI commands, and writes a `.env` so an AI client can run it immediately. When invoked without a CLI subcommand (`zalo-mcp` or `node mcp-server.js`), it spawns `zalo-agent mcp start` and forwards all `mcp start` flags (`--account`, `--http`, `--auth`, `--host`, `--config`, `--no-self-heal`, `--no-delivered-receipts`, plus global storage flags); when invoked with a CLI subcommand (`zalo-mcp login`, `zalo-mcp --account <ID> msg list --json`, `zalo-mcp sync`, …), it forwards the arguments directly to `zalo-agent`.

Because the wrapper is a pass-through, **the MCP tool surface is defined entirely by `src/mcp/mcp-tools.js` in this repo** — whichever `zalo-agent-cli` version `zalo-mcp` has installed.

> [!NOTE]
> A deployed `zalo-mcp` folder serves the `@ardennguyen/zalo-agent-cli` version installed in its `node_modules/`. Check with:
> ```bash
> node -p "require('./node_modules/@ardennguyen/zalo-agent-cli/package.json').version"
> ```
> Run `./zalo-mcp.sh update` (or `.\zalo-mcp.ps1 update`) to pull the latest published engine.

---

## Prerequisites

- **Node.js** 22+ (the CLI's `engines` field requires it; `undici` and `commander` do too)
- **Git**

---

## Quick Start (one-line install)

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/ardennguyen/zalo-mcp/main/zalo-mcp.sh | bash -s install
```

**Windows (PowerShell):**
```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force; irm https://raw.githubusercontent.com/ardennguyen/zalo-mcp/main/zalo-mcp.ps1 | Out-File $env:TEMP\zalo-mcp.ps1; & $env:TEMP\zalo-mcp.ps1 install
```

This creates a `zalo-mcp/` folder at your current location, installs Node packages into a local `node_modules/`, links the global `zalo-mcp` and `zalo-agent` commands, and writes a `.env`. You may be prompted for ports during interactive install, or edit `.env` afterward.

### Wrapper script commands

Run from inside the installed `zalo-mcp/` folder:

| Command | Description |
|:---|:---|
| `install` | Clone the wrapper from GitHub into a new directory |
| `init [--clean] [--oa-port <port>] [--mcp-port <port>]` | Install Node deps, link global CLI commands, and write `.env` |
| `update` | Pull the latest engine + dependencies |
| `clean` | Remove `node_modules/` for a fresh reinstall |

```bash
# Windows
.\zalo-mcp.ps1 update
.\zalo-mcp.ps1 clean

# macOS / Linux
./zalo-mcp.sh update
./zalo-mcp.sh clean
```

**Never run `npm install` directly inside a deployed `zalo-mcp` folder** — always go through `update`, which refreshes the scripts and `package.json` from the published `@ardennguyen/zalo-mcp` and then installs the engine's latest npm release, `@ardennguyen/zalo-agent-cli@latest`, in a controlled way. A deployment therefore runs a published engine, never a branch.

### `.env` keys (inside `zalo-mcp/`)

Keep `zalo-mcp/.env` **for port configuration only** (`ZALO_MCP_HTTP_PORT`). Put storage directory overrides (`ZALO_CREDENTIALS_DIR`, `ZALO_DATA_DIR`, `ZALO_MEDIA_DIR`, `ZALO_OA_DIR`) and engine settings in `~/.zalo-agent-cli/.env` (`<CONFIG_DIR>/.env`) so `zalo-mcp` and `zalo-agent` always share a single configuration and never drift.

| Key | Default | Purpose |
|:---|:---|:---|
| `ZALO_MCP_HTTP_PORT` | `3847` | Port used when `mcp-server.js --http` is passed without an explicit port |

### npm scripts inside the wrapper

| Script | Runs |
|:---|:---|
| `npm start` / `npm run mcp` | `node mcp-server.js` (stdio MCP server) |
| `npm run login` | `zalo-agent login` — personal-account QR login |
| `npm run oa:init` | `zalo-agent oa init` — Official Account setup wizard |

---

## Authentication

All credentials are kept strictly local.

### A. Personal Zalo Account (unofficial API)
```bash
zalo-mcp login   # or: npm run login (from inside the installed zalo-mcp/ folder)
```
A QR code prints in the terminal, and a local HTTP server also serves it at `http://127.0.0.1:18927/qr` — loopback only; `--qr-url` binds it to every interface for a headless machine, and anyone who reaches it before it expires can sign in as this account. Scan it with the **Zalo app's QR Scanner** (not the phone's regular camera) and confirm on the phone. If you decline on the phone, the CLI reports it immediately instead of waiting out the 60-second QR timeout.

> **Storage:** `~/.zalo-agent-cli/` (mode `0600`).
> **Risk:** this is an unofficial API (via `zca-js`) — heavy/automated use can get the account banned. Don't use your primary personal account.

### B. Zalo Official Account (official API v3.0)
```bash
zalo-mcp oa init --app-id <YOUR_APP_ID> --secret <YOUR_APP_SECRET>
```
Follow the browser prompt to authorize the app. For a headless VPS:
```bash
zalo-mcp oa login --app-id <ID> --secret <KEY> --callback-host https://your-domain.com
```

> **Storage:** `~/.zalo-agent/oa-credentials.json` (mode `0600`) — note this is a **different directory** from the personal account's `~/.zalo-agent-cli/`.
> OA access tokens expire after ~25h — refresh anytime with `zalo-mcp oa refresh`.

Full OA setup, webhook exposure options, and error codes: [docs/official-account.md](docs/official-account.md).

---

## AI Agent Integration (MCP)

### stdio transport (local)

Point your AI client at the global `zalo-mcp` command (or `zalo-agent mcp start`):

**Claude Code (`~/.claude/settings.json`):**
```json
{
  "mcpServers": {
    "zalo": {
      "command": "zalo-mcp",
      "args": []
    }
  }
}
```
*(Or use `"command": "node", "args": ["/absolute/path/to/zalo-mcp/mcp-server.js"]` if the global binary is not on `PATH`.)*

If you installed the CLI globally without the wrapper, point at the CLI directly:
```json
{
  "mcpServers": {
    "zalo": { "command": "zalo-agent", "args": ["mcp", "start"] }
  }
}
```

**Cursor / other stdio clients:** `zalo-mcp` (or `node /absolute/path/to/zalo-mcp/mcp-server.js`)

### HTTP / HTTPS transport (remote / VPS / cloud agents)

```bash
zalo-mcp --http 3847                                 # port from arg, or ZALO_MCP_HTTP_PORT
zalo-mcp --http 3847 --auth <token> --host 0.0.0.0   # remote access with bearer token
zalo-mcp --http 3847 --auth <token> --host 0.0.0.0 --cert /path/to/fullchain.pem --key /path/to/privkey.pem
```

Under the hood this runs `zalo-agent mcp start --http <port> [--auth <token>] [--host <addr>] [--cert <path> --key <path>]`. All `mcp start` flags are supported identically via `zalo-mcp` and `zalo-agent mcp start`:

| Flag | Default | Description |
|:---|:---|:---|
| `--account <id>` | Active at startup, then pinned | Registered numeric account ID to pin across reconnect/retry without changing the shared active account |
| `--http <port>` | *(stdio)* | Use HTTP (or HTTPS when `--cert` and `--key` are given) transport on this port |
| `--auth <token>` | `ZALO_MCP_AUTH_TOKEN` in `.env` | Require `Authorization: Bearer <token>` on every endpoint except `/health` and OAuth discovery/handshake endpoints |
| `--host <address>` | `127.0.0.1` | Bind address — set `0.0.0.0` to accept remote connections |
| `--cert <path>` | `tls.cert` in `mcp-config.json` | TLS certificate file path (PEM) to serve HTTPS directly via Node's `https` server (requires `--http` and `--key`; automatically attempts secondary bind on port `443` when `port !== 443`) |
| `--key <path>` | `tls.key` in `mcp-config.json` | TLS private key file path (PEM) to serve HTTPS directly via Node's `https` server (requires `--http` and `--cert`) |
| `--client-id <id>` | `zalo-mcp` (or `ZALO_MCP_OAUTH_CLIENT_ID[_<ownId>]`) | OAuth 2.0 Client ID for remote MCP clients like Gemini Connected Apps |
| `--client-secret <key>` | `--auth` / `ZALO_MCP_AUTH_TOKEN[_<ownId>]` | OAuth 2.0 Client Secret for `/token` exchange |
| `--issuer-url <url>` | *(inferred from request Host)* | Explicit OAuth 2.0 issuer base URL (e.g. `https://mcp.example.com:3100`) |
| `-w, --webhook <url>` | `webhook` in `mcp-config.json` | POST each watched incoming message as JSON to this URL (`ZALO_WEBHOOK_URL[_<ownId>]`) |
| `--webhook-secret <secret>` | `webhookSecret` in `mcp-config.json` | Shared secret to sign webhook POSTs with `Authorization: Bearer <secret>` + `X-Zalo-Signature: sha256=<hmac>` (`ZALO_WEBHOOK_SECRET[_<ownId>]`; the flag wins, then the environment variable, then the config key; an empty flag is refused; prefer the environment variable, since a flag is visible in the process list) |
| `--config <path>` | `~/.zalo-agent-cli/mcp-config.json` | Custom MCP config file |
| `--no-self-heal` | *(enabled)* | Disable automatic gap self-healing after reconnect |
| `--no-delivered-receipts` | *(enabled)* | Do not send delivered receipts for incoming messages |
| `-d, --daemon` | `false` | Run detached in the background (requires `--http <port>`; logs to `accounts/<ownId>/daemon.log`) |
| `--stop` | `false` | Gracefully stop the running background daemon for this account |
| `--status` | `false` | Show background daemon status (PID, channel port, log path) |

Client config:
```json
{
  "mcpServers": {
    "zalo": {
      "url": "https://your-domain:3847/mcp",
      "headers": { "Authorization": "Bearer your-secret" }
    }
  }
}
```

Health check (never requires auth):
```bash
curl http://localhost:3847/health
# → {"status":"ok","uptime":123,"threads":5}
```

> Binding to `0.0.0.0` without `--auth` exposes your Zalo session to anyone who can reach the port. Always set `--auth` for remote deployments.

Running it unattended on a production host (systemd unit, restarts, monitoring, backup, security) is covered in [docs/deployment.md](docs/deployment.md).

### Running multiple live accounts simultaneously (MCP & CLI)

Each registered personal account has its own isolated SQLite database (`<DATA_DIR>/<ownId>/zalo.db`), media folder, `daemon.lock`, and loopback channel (`daemon-channel.json`). You can run **multiple live accounts at the same time** by starting one MCP server (or `listen` daemon) per account with `--account <ownId>` and passing `--account <ownId>` (or `ZALO_ACCOUNT=<ownId>`) on CLI commands:

1. **Register each account** (one dedicated proxy per account is recommended):
   ```bash
   zalo-agent account login -p "http://user:pass@proxy1:8080" -n "Shop A"
   zalo-agent account login -p "http://user:pass@proxy2:8080" -n "Shop B"
   zalo-agent account list
   ```
2. **Multiple stdio MCP servers in Claude Code / Cursor (`~/.claude/settings.json`, using synthetic IDs `101` and `202`):**
   ```json
   {
     "mcpServers": {
       "zalo-shop-a": {
         "command": "zalo-mcp",
         "args": ["--account", "101"]
       },
       "zalo-shop-b": {
         "command": "zalo-mcp",
         "args": ["--account", "202"]
       }
     }
   }
   ```
3. **Multiple HTTP MCP servers on a VPS (one port per account):**
   ```bash
   zalo-mcp --account 101 --http 3847 --auth <token-a> --host 0.0.0.0
   zalo-mcp --account 202 --http 3848 --auth <token-b> --host 0.0.0.0
   ```
4. **Concurrent CLI commands per account (without touching `accounts.json`):**
   ```bash
   zalo-agent --account 101 msg send <threadId> "Hello from Shop A" --json
   zalo-mcp --account 202 sync --days 7
   ```

### MCP tools exposed

This engine source registers **25 MCP tools** in `src/mcp/mcp-tools.js`, all covering the **personal account**:

| Tool | Purpose |
|:---|:---|
| `zalo_get_messages` | Read buffered live messages with a cursor for incremental polling |
| `zalo_send_message` | Send text, file/image attachments (`filePath`/`files`), a link preview card (`link`), or a contact card (`cardUserId`) to a DM or group — with @-mentions, a quote-reply, Important/Urgent `urgency`, or `threadId: "me"` for My Documents |
| `zalo_list_threads` | List buffered threads with unread counts |
| `zalo_search_threads` | Fuzzy, Vietnamese-accent-insensitive thread search by name |
| `zalo_mark_read` | Mark buffered messages up to a cursor read for one consumer (global, not per-thread; deletes nothing, so several bots can share one server) |
| `zalo_get_history` | Older messages: the local cache first, then Zalo, paginated — Zalo serves only messages since this login, and older history comes from the phone-backed `zalo-agent sync` |
| `zalo_view_media` | Open a received image/audio/video attachment (downloads first if needed) |
| `zalo_react` | React to a message (`/-strong`, `/-heart`, `:>`, …), as `msg react` does — refused, with nothing sent, when the message's cliMsgId is neither passed nor cached |
| `zalo_undo` | Recall one of your own messages for everyone, as `msg undo` does; same cliMsgId rule |
| `zalo_get_group_members` | List a group's members — uid and display name — as `group members` does |
| `zalo_list_conversations` | Recent conversations from the local cache, newest first, as `conv recent` does |
| `zalo_coverage` | Read-only: pending coverage gaps in the local cache, how many are resolved, and the `zalo-agent sync --from <date>` run that restores the rest |
| `zalo_sync` | Start an owner-requested message restore or reaction sync; returns immediately with a job ID. Messages still needs phone confirmation |
| `zalo_sync_status` | Read progress and final result; completed does not mean a partial restore became complete |
| `zalo_search_messages` | Search message text across the local SQLite cache (`zalo.db`), zero network calls |
| `zalo_lookup_user` | Look up a Zalo user by phone, username, userId, or inspect the logged-in account (`self: true`) |
| `zalo_forward_message` | Forward a cached message (`msgId`) to another DM or group (`msg forward` parity) |
| `zalo_delete_message` | Delete a message from own view (`everyone: false`) or for everyone in a group (`everyone: true`) |
| `zalo_reminder` | Create, list, inspect, view responses, edit, or remove reminders in a DM or group |
| `zalo_note` | Create/edit group notes, list group board items, or pin/unpin a cached text message |
| `zalo_poll` | Create, inspect, vote, unvote, add options, lock, or share a group poll |
| `zalo_wait_for_message` | Long-poll the live message buffer for the next incoming watched message without manual polling (mirrors `GET /events/wait` for remote HTTPS/OAuth2 MCP clients) |
| `zalo_label` | List, assign, unassign, or update conversation/contact labels (e.g. `"Nội bộ"`, `"Khách hàng"`, `"Đối tác"`) |
| `zalo_group` | Leave (optionally silently), inspect, create a group, add or remove a member |
| `zalo_friend` | Friend status, sent and received requests, send / accept / reject / cancel a request, list friends |

See [Sync usage and details](docs/mcp-sync.md) / [Tiếng Việt](docs/mcp-sync.vi.md).

Official Account, catalog, auto-reply, quick-msg, profile, friend management beyond requests and the friend list (`zalo_friend` covers those), group administration beyond leaving, inspecting, creating and changing membership (`zalo_group` covers those), and account management are **CLI-only** — not exposed as MCP tools. Agents reach them by shelling out to `zalo-agent <command> --json` (or `zalo-mcp <command> --json`).

Full tool reference (parameters, return shapes, config): [skill/references/mcp-guide.md](skill/references/mcp-guide.md).

### MCP config

Optional file at `~/.zalo-agent-cli/mcp-config.json` — shallow-merged per top-level key over the defaults. Useful keys:

```json
{
  "watchThreads": ["dm:*", "group:*"],
  "notify": { "enabled": false, "thread": null, "on": ["dm"], "cooldown": "5m" },
  "limits": { "maxMessagesPerPoll": 20, "bufferMaxAge": "2h", "bufferMaxSize": 500 },
  "media": { "downloadDir": null, "autoOpen": true }
}
```

Full table of fields and defaults: [skill/references/mcp-guide.md](skill/references/mcp-guide.md).

---

## Local storage layout

By default, everything the CLI persists lives under `~/.zalo-agent-cli/` (personal accounts) and `~/.zalo-agent/` (Official Accounts). In production, each storage root can be placed on a separate volume or mount via global CLI flags or environment variables:

| Storage tier | Default location | CLI flag | Environment variable |
|:---|:---|:---|:---|
| Config & account registry (`accounts.json`, `mcp-config.json`, `qr.png`) | `~/.zalo-agent-cli/` | `--config-dir <dir>` | `ZALO_CONFIG_DIR` |
| Session credentials (`cred_<ownId>.json`, mode `0600`) | `<CONFIG_DIR>/credentials/` | `--credentials-dir <dir>` | `ZALO_CREDENTIALS_DIR` |
| Per-account database & runtime state (`<ownId>/zalo.db`, `daemon.lock`, `daemon-channel.json`) | `<CONFIG_DIR>/accounts/` | `--data-dir <dir>` | `ZALO_DATA_DIR` *(or `ZALO_DB_DIR`)* |
| Downloaded media (`<threadId>/`, `_conversations.json`) | `<DATA_DIR>/<ownId>/media/` | `--media-dir <dir>` | `ZALO_MEDIA_DIR` |
| Official Account credentials (`oa-credentials.json`, mode `0600`) | `~/.zalo-agent/` | `--oa-dir <dir>` | `ZALO_OA_DIR` |

Default layout when no custom paths are set:

```
~/.zalo-agent-cli/
├── accounts.json                  # Account registry (0600); changed under a lock, replaced atomically
├── accounts.json.bak              # The registry as it was before the last change
├── credentials/cred_<ownId>.json  # Per-account session credentials (0600)
├── mcp-config.json                # Optional MCP config
├── accounts/<ownId>/
│   ├── zalo.db                    # SQLite message/thread cache (WAL)
│   ├── media/                     # Media downloaded by `listen` / `msg` (per account)
│   ├── sync/                      # sync scratch (the phone restore's protocol cache)
│   └── daemon.lock                # Held while a `listen`/`mcp start` daemon runs
└── qr.png                         # Most recent login QR
```

> [!NOTE]
> **One media directory, one layout.** Every command — `listen`, `msg history`, `mcp start`, `sync-media`, `sync-mobile` and the MCP tools — writes to `<mediaRoot>/<threadId>/` (default `accounts/<ownId>/media/<threadId>/`, or `--media-dir` / `ZALO_MEDIA_DIR` globally). Folders are named by thread ID, never by conversation name, because a name can contain a path separator or change when someone renames the group; `_conversations.json` maps ID to name. `mcp-config.json`'s `media.downloadDir` can also override the media root for the MCP server specifically.

> [!WARNING]
> **A custom `--media-dir` / `ZALO_MEDIA_DIR` or `media.downloadDir` is not removed by `logout --purge` or `account remove`.** Those wipe `<DATA_DIR>/<ownId>/` — default media included — and the credential file. Unset, the CLI and MCP server download into that same per-account folder, so a purge removes its media too; an external media mount sits outside it, and its attachments survive. Delete that directory by hand when removing an account for privacy reasons.

Official Account credentials are stored separately at `~/.zalo-agent/oa-credentials.json` (or `<ZALO_OA_DIR>/oa-credentials.json`).

---

## CLI Command Reference (via `npx zalo-agent <command>`)

Append `--json` to any command for machine-readable output. This is a shortlist — the exhaustive reference for all 222 commands is [skill/references/command-reference.md](skill/references/command-reference.md).

### Session & maintenance
| Command | Description |
|:---|:---|
| `npx zalo-agent status` | Check login status |
| `npx zalo-agent whoami` | Show the logged-in user's full profile |
| `npx zalo-agent login [--qr-url] [--credentials <path>] [-p <proxy>] [--sync [--sync-days <n>]]` | QR login, or restore from an exported credentials file. `--sync` restores the history right after a QR login with the phone's auto sync key (tick "auto sync" on the phone; no tap needed) |
| `npx zalo-agent logout [--delete-history] [--purge] [--no-remote] [--keep-session]` | Sign the device out at Zalo (as Zalo Web does) and delete the saved credentials; `--keep-session` only ends the session key (the pre-v3.0 behavior, after which the login ends at Zalo only when the device is removed from the phone's list); optionally delete the local cache or wipe the account entirely |
| `npx zalo-agent sync-mobile --transfer [-d <days>]` | **Restore message history from your phone** into the local cache (one confirmation on the phone). Full history by default; `-d/--days <n>` limits it to the last *n* days and finishes much sooner |
| `npx zalo-agent sync-mobile [-F] [-w <s>]` | Restore history from your phone — prompts the phone once. Add `--socket` for the old server probe, which contacts no phone and usually returns nothing |
| `npx zalo-agent update` | Self-update to the latest published version |
| `npx zalo-agent mcp start [--http <port>] [--auth <token>] [--host <addr>]` | Start the MCP server |
| `npx zalo-agent mcp wait [since] [-t <threadId>] [--timeout <s>] [-n <count>] [--settle <ms>] [-c <name>]` | Long-poll the running `mcp start` daemon's buffer for the next message (`zalo_wait_for_message` CLI equivalent) |
| `npx zalo-agent mcp mark-read <cursor> [-c <name>]` | Advance the consumer read cursor in the running `mcp start` daemon's buffer (`zalo_mark_read` CLI equivalent) |

### Personal account
| Command | Description |
|:---|:---|
| `npx zalo-agent msg send <threadId> "text" [-t 1]` | Send text (DM, or group with `-t 1`) |
| `npx zalo-agent msg send-image <threadId> <path>` | Send an image |
| `npx zalo-agent msg send-file <threadId> <path>` | Send a file |
| `npx zalo-agent msg history <threadId> [-t 1] [-n 50] [--no-cache]` | Fetch history (served from the local cache unless `--no-cache`) |
| `npx zalo-agent msg undo <msgId> <threadId> -c <cliMsgId>` | Recall a message for everyone |
| `npx zalo-agent friend list` / `friend find <phone>` | List / find friends |
| `npx zalo-agent group list [-q <text>]` / `group members <groupId>` | List groups / members |
| `npx zalo-agent conv recent [-n 20]` | List recent conversations with thread IDs |
| `npx zalo-agent account devices` | List devices/sessions linked to the active account |
| `npx zalo-agent account remove <ownerId>` | Invalidate remote session, wipe local data, delete creds |
| `npx zalo-agent listen [--webhook <url>] [--save <dir>]` | Real-time listener, optional webhook forwarding and JSONL archival |
| `npx zalo-agent msg send-qr-transfer <id> <acct> --bank <alias> -a <amount>` | Send a VietQR payment |

### Official Account (OA)
| Command | Description |
|:---|:---|
| `npx zalo-agent oa whoami` | View OA profile |
| `npx zalo-agent oa msg text <userId> "text"` | Send an OA message to a follower |
| `npx zalo-agent oa follower list` | List OA followers |
| `npx zalo-agent oa tag assign <userId> <tag>` | Tag a follower |
| `npx zalo-agent oa upload image <path>` | Upload an image, returns an attachment ID |
| `npx zalo-agent oa listen -p <port> [-s <secret>]` | Start a local OA webhook listener |
| `npx zalo-agent oa refresh` | Refresh the OA access token |

Full reference: [skill/references/command-reference.md](skill/references/command-reference.md) and [docs/official-account.md](docs/official-account.md).

---

## Environment variables

`zalo-agent` natively loads `.env` files (via Node 22 `util.parseEnv`, without overwriting existing shell variables) in this order:
1. `--env-file <path>` (or `ZALO_ENV_FILE`)
2. `./.env` in the current working directory
3. `<CONFIG_DIR>/.env` (default `~/.zalo-agent-cli/.env`)

> [!TIP]
> **Recommended `.env` split:** Keep `zalo-mcp/.env` for **port settings only** (`ZALO_MCP_HTTP_PORT`), and put all storage directory overrides (`ZALO_CREDENTIALS_DIR`, `ZALO_DATA_DIR`, `ZALO_MEDIA_DIR`, `ZALO_OA_DIR`) and engine settings in `~/.zalo-agent-cli/.env` (`<CONFIG_DIR>/.env`). That way both `zalo-mcp` and `zalo-agent` read the exact same paths from any directory without conflicting `.env` files.

See [`.env.example`](.env.example) for a template.

| Variable | Effect |
|:---|:---|
| `ZALO_ACCOUNT` | Registered numeric personal account ID to pin for the current process (`listen`, `mcp start`, or any personal CLI command; also overridable via `--account <id>`) without mutating `accounts.json` |
| `ZALO_ENV_FILE` | Path to a custom `.env` file to load at startup (also overridable via `--env-file <path>`) |
| `ZALO_CONFIG_DIR` | Root directory for `accounts.json`, `mcp-config.json`, and `qr.png` (default `~/.zalo-agent-cli`; also overridable via `--config-dir`) |
| `ZALO_CREDENTIALS_DIR` | Directory for personal session files `cred_<ownId>.json` (default `<CONFIG_DIR>/credentials`; also overridable via `--credentials-dir`) |
| `ZALO_DATA_DIR` / `ZALO_DB_DIR` | Root directory for per-account data `<ownId>/zalo.db`, `daemon.lock`, and `daemon-channel.json` (default `<CONFIG_DIR>/accounts`; also overridable via `--data-dir`) |
| `ZALO_MEDIA_DIR` | Root directory for downloaded media `<threadId>/` and `_conversations.json` across all commands (default `<DATA_DIR>/<ownId>/media`; also overridable via `--media-dir`) |
| `ZALO_OA_DIR` | Directory for Official Account `oa-credentials.json` (default `~/.zalo-agent`; also overridable via `--oa-dir`) |
| `ZALO_AGENT_NO_UPDATE_CHECK` | Set to any value to disable the background update-version check |
| `ZALO_API_VERSION` | Protocol version announced to Zalo (`zpw_ver` / `client_version`), on the HTTP calls and the WebSocket URL alike. Default `694` (the live Zalo Web value); set `685` to roll back to zca-js's default. Must be a positive whole number — `0685`, `6.91`, `1e3`, `0x2b3`, `-685` and `0` are refused before Zalo is contacted, so a bad value fails every login rather than quietly falling back. Whitespace-only counts as unset. Only logins read it. |
| `ZALO_QR_FLOW` | Which QR login `login` uses: `official` (the default: the sequence Zalo Web makes, no `verify-client`, `continue=https://chat.zalo.me/`, the session redirects through `jr.zaloapp.com` and `jr.chat.zalo.me`) or `legacy` (zca-js's own, the way back). Anything else is refused before Zalo is contacted. Only QR logins read it |
| `ZALO_NET_PROBE` | What a daemon asks to learn whether the network is up while its socket is down (every 10 s). A URL, by default a global search engine's lightweight page; `off` assumes the network is always up and contacts nothing but Zalo |
| `ZALO_JSON_MODE` | Set automatically by the CLI in `--json` and `mcp` modes to suppress `zca-js` stdout logs. Don't set it by hand |
| `ZALO_MCP_HTTP_PORT` | Read by `mcp start` and the `zalo-mcp` wrapper as the fallback `--http` port (supports `ZALO_MCP_HTTP_PORT_<ownId>`) |
| `ZALO_MCP_HOST` | Default bind address for `mcp start --http` (supports `ZALO_MCP_HOST_<ownId>`) |
| `ZALO_MCP_AUTH_TOKEN` | Bearer token for `mcp start --http` and fallback OAuth 2.0 client secret (supports `ZALO_MCP_AUTH_TOKEN_<ownId>`) |
| `ZALO_MCP_OAUTH_CLIENT_ID` | OAuth 2.0 Client ID for `mcp start --http` (default `zalo-mcp`; supports `ZALO_MCP_OAUTH_CLIENT_ID_<ownId>`) |
| `ZALO_MCP_OAUTH_CLIENT_SECRET` | OAuth 2.0 Client Secret for `mcp start --http` (supports `ZALO_MCP_OAUTH_CLIENT_SECRET_<ownId>`) |
| `ZALO_MCP_ISSUER_URL` | Explicit OAuth 2.0 issuer base URL for `mcp start --http` (supports `ZALO_MCP_ISSUER_URL_<ownId>`) |
| `ZALO_MCP_TLS_CERT` / `ZALO_MCP_TLS_KEY` | PEM certificate and private key paths for native HTTPS on `mcp start --http` (supports `_*_<ownId>`) |
| `ZALO_WEBHOOK_URL` / `ZALO_WEBHOOK_SECRET` | Default webhook URL and signing secret (`Authorization: Bearer` + `X-Zalo-Signature: sha256=<hmac>`) for `listen` and `mcp start` (supports `_*_<ownId>`) |
| `ZALO_WEBHOOK_BATCH_SIZE` / `ZALO_WEBHOOK_MAX_AGE` | Events per webhook POST (1–100, default 1) and how long an undelivered event is retried before it is dead-lettered (default `24h`). Both support `_<ownId>`. The webhook is durable: see `zalo-agent mcp webhook status` |
| `ZALO_LOG_LEVEL` / `ZALO_LOG_FORMAT` / `ZALO_LOG_MAX_SIZE` / `ZALO_LOG_KEEP` | `daemon.log` of `listen` and `mcp start`: level `error`, `warn`, `info` (default) or `debug` (adds a line per HTTP request and per message; also `--log-level`), `text` or `json` lines, and rotation at `50m` keeping 3 files |
| `ZALO_START_JITTER` / `ZALO_LOGIN_SLOTS` / `ZALO_LOGIN_SLOT_WAIT` | Spread a fleet's start-up: wait a random 0–N seconds before logging in, and let at most N daemons on the machine be logging in at once (a daemon over the cap waits, then goes ahead after `ZALO_LOGIN_SLOT_WAIT` seconds). Off by default |
| `ZALO_SEND_FORMAT` | `markdown` or `plain`: how text messages are sent. `zalo_send_message` converts Markdown to Zalo formatting by default; `msg send` sends plain unless `--markdown` (or this variable) says otherwise |

---

## Troubleshooting

| Symptom | Cause / fix |
|:---|:---|
| MCP client shows no tools, or the connection drops immediately | Something printed to stdout. In stdio mode stdout is the JSON-RPC channel — check stderr logs for the real error |
| `Duplicate Zalo Web session detected. Exiting.` | Only one WebSocket per account. Close Zalo Web in the browser, and don't run `listen` and `mcp start` for the same account at once |
| `logout` (any form) / `account remove` refuses with a PID | A `listen` or `mcp start` daemon holds `daemon.lock` for that account. Stop it first |
| `Thread name cache not initialized yet` from `zalo_search_threads` | The cache builds at MCP startup by fetching all groups + friends. Retry after a few seconds |
| HTTP MCP server unreachable from another machine | By default `--http` binds `127.0.0.1` (loopback only). Pass `--host 0.0.0.0 --auth <token>` (supported on both `zalo-mcp` and `zalo-agent mcp start`) |
| `zalo_view_media` saves somewhere other than `accounts/<ownId>/media/<threadId>/` | Only when `--media-dir` / `ZALO_MEDIA_DIR` is set, or `media.downloadDir` is set in `mcp-config.json`. Unset, the server uses the same per-account folder as every other command |
| `sync-mobile` reports nothing and your phone never prompted | You passed `--socket`, which asks the server-side probe instead of your phone; it normally returns empty. Drop the flag. |
| OA call fails with `-216` | Access token expired → `npx zalo-agent oa refresh` |
| OA call fails with `-224` | OA tier too low → see [zalo.cloud/oa/pricing](https://zalo.cloud/oa/pricing) |
| A "new version available" notice never appears | It is skipped when stdout isn't a TTY, in `--json` mode, or when `ZALO_AGENT_NO_UPDATE_CHECK` is set |

---

## npm Registry Fail-Safe

If `@ardennguyen/zalo-agent-cli` is ever unavailable from npm, `update` cannot help: both of its steps read the npm registry, and its first step overwrites `package.json` with the published wrapper's copy, so pointing the dependency at GitHub and then running `update` undoes the change. As a deliberate, one-off exception to the rule above, install the engine from source inside the deployed folder:
```bash
npm install github:ardennguyen/zalo-agent-cli
```
The next `update` returns the folder to the npm release.

---

## More Documentation

Full command reference, MCP setup details, local cache behavior, Official Account API, and more — both English and Vietnamese:
**[Wiki → github.com/ardennguyen/zalo-agent-cli/wiki](https://github.com/ardennguyen/zalo-agent-cli/wiki)**
