# Zalo MCP Server & CLI Installation Guide

This document covers deploying the **`zalo-mcp`** wrapper — a self-contained, sandboxed installer that pulls in the `zalo-agent-cli` engine and exposes it as a Model Context Protocol (MCP) server, so AI agents (Claude Code, Cursor, and others) can automate Zalo Personal & Official Accounts without touching your global system.

> If you only want the CLI (no MCP server), skip straight to `npm install -g @ardennguyen/zalo-agent-cli` — see the main [README.md](README.md).

---

## How the two repos relate

- **`zalo-agent-cli`** (this repo) — the core engine. All API logic, auth, and the actual MCP server source (`src/mcp/`) live here.
- **`zalo-mcp`** — a lightweight deployment wrapper (separate repo: [github.com/ardennguyen/zalo-mcp](https://github.com/ardennguyen/zalo-mcp)). It contains no engine code; its install script pulls `zalo-agent-cli` into an isolated local folder, sets up Node/Python, and writes a `.env` so an AI client can run it immediately. `mcp-server.js` simply spawns `zalo-agent mcp start` and pipes stdio through, forwarding `--http` and `--auth`.

Because the wrapper is a pass-through, **the MCP tool surface is defined entirely by `src/mcp/mcp-tools.js` in this repo** — whichever `zalo-agent-cli` version `zalo-mcp` has installed.

---

## Prerequisites

- **Node.js** 22+ (the CLI's `engines` field requires it; `undici` and `commander` do too)
- **Python** 3.8+ (optional — only needed if the MCP server renders charts/PDF reports)
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

This creates a `zalo-mcp/` folder at your current location, installs Node packages into a local `node_modules/`, creates an isolated Python `venv/` (if Python is available), and writes a `.env`. You may be prompted for ports during interactive install, or edit `.env` afterward.

### Wrapper script commands

Run from inside the installed `zalo-mcp/` folder:

| Command | Description |
|:---|:---|
| `install` | Clone the wrapper from GitHub into a new directory |
| `init [--clean] [--oa-port <port>] [--mcp-port <port>]` | Install Node/Python deps and write `.env` |
| `update` | Pull the latest engine + dependencies |
| `clean` | Remove `node_modules/` and `venv/` for a fresh reinstall |

```bash
# Windows
.\zalo-mcp.ps1 update
.\zalo-mcp.ps1 clean

# macOS / Linux
./zalo-mcp.sh update
./zalo-mcp.sh clean
```

**Never run `npm install` directly inside a deployed `zalo-mcp` folder** — always go through `update`, which pulls the latest engine from `github:ardennguyen/zalo-agent-cli` in a controlled way.

### `.env` keys

| Key | Default | Purpose |
|:---|:---|:---|
| `ZALO_MCP_HTTP_PORT` | `3847` | Port used when `mcp-server.js --http` is passed without an explicit port |
| `ZALO_OA_WEBHOOK_PORT` | `3000` | Default port for the OA webhook listener |
| `ZALO_OA_APP_ID` | *(unset)* | Zalo OA App ID, if you connect an Official Account |
| `ZALO_OA_SECRET` | *(unset)* | Zalo OA App Secret |

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
npm run login   # from inside the installed zalo-mcp/ folder
```
A QR code prints in the terminal, and a local HTTP server also serves it at `http://<host>:18927/qr` for headless machines. Scan it with the **Zalo app's QR Scanner** (not the phone's regular camera) and confirm on the phone. If you decline on the phone, the CLI reports it immediately instead of waiting out the 60-second QR timeout.

> **Storage:** `~/.zalo-agent-cli/` (mode `0600`).
> **Risk:** this is an unofficial API (via `zca-js`) — heavy/automated use can get the account banned. Don't use your primary personal account.

### B. Zalo Official Account (official API v3.0)
```bash
npx zalo-agent oa init --app-id <YOUR_APP_ID> --secret <YOUR_APP_SECRET>
```
Follow the browser prompt to authorize the app. For a headless VPS:
```bash
npx zalo-agent oa login --app-id <ID> --secret <KEY> --callback-host https://your-domain.com
```

> **Storage:** `~/.zalo-agent/oa-credentials.json` (mode `0600`) — note this is a **different directory** from the personal account's `~/.zalo-agent-cli/`.
> OA access tokens expire after ~25h — refresh anytime with `npx zalo-agent oa refresh`.

Full OA setup, webhook exposure options, and error codes: [docs/official-account.md](docs/official-account.md).

---

## AI Agent Integration (MCP)

### stdio transport (local)

Point your AI client at the installed `zalo-mcp/mcp-server.js`:

**Claude Code (`~/.claude/settings.json`):**
```json
{
  "mcpServers": {
    "zalo": {
      "command": "node",
      "args": ["/absolute/path/to/zalo-mcp/mcp-server.js"],
      "cwd": "/absolute/path/to/zalo-mcp"
    }
  }
}
```

If you installed the CLI globally instead of using the wrapper, point at the CLI directly:
```json
{
  "mcpServers": {
    "zalo": { "command": "zalo-agent", "args": ["mcp", "start"] }
  }
}
```

**Cursor / other stdio clients:** `node /absolute/path/to/zalo-mcp/mcp-server.js`

### HTTP transport (remote / VPS)

```bash
node mcp-server.js --http 3847                 # port from arg, or ZALO_MCP_HTTP_PORT
node mcp-server.js --http 3847 --auth <token>  # require a bearer token
```

Under the hood this runs `zalo-agent mcp start --http <port> [--auth <token>]`. Extra flags available when calling the CLI directly:

| Flag | Default | Description |
|:---|:---|:---|
| `--http <port>` | *(stdio)* | Use HTTP transport on this port |
| `--auth <token>` | *(none)* | Require `Authorization: Bearer <token>` on every endpoint except `/health` |
| `--host <address>` | `127.0.0.1` | Bind address — set `0.0.0.0` to accept remote connections |
| `--config <path>` | `~/.zalo-agent-cli/mcp-config.json` | Custom MCP config file |

Client config:
```json
{
  "mcpServers": {
    "zalo": {
      "url": "http://your-vps:3847/mcp",
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

### MCP tools exposed

`mcp-server.js` is a thin wrapper around `zalo-agent mcp start`, so it exposes exactly the **7 MCP tools** registered in `src/mcp/mcp-tools.js`, all covering the **personal account**:

| Tool | Purpose |
|:---|:---|
| `zalo_get_messages` | Read buffered live messages with a cursor for incremental polling |
| `zalo_send_message` | Send a text message to a DM or group |
| `zalo_list_threads` | List buffered threads with unread counts |
| `zalo_search_threads` | Fuzzy, Vietnamese-accent-insensitive thread search by name |
| `zalo_mark_read` | Discard buffered messages up to a cursor (global, not per-thread) |
| `zalo_get_history` | Fetch older messages (~2 weeks) from the Zalo server, paginated |
| `zalo_view_media` | Open a received image/audio/video attachment (downloads first if needed) |

Official Account, catalog, poll, reminder, auto-reply, label, profile, and account management are **CLI-only** — not exposed as MCP tools. Agents reach them by shelling out to `npx zalo-agent <command> --json`.

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

Everything the CLI persists lives under `~/.zalo-agent-cli/`:

```
~/.zalo-agent-cli/
├── accounts.json                  # Account registry (0600)
├── credentials/cred_<ownId>.json  # Per-account session credentials (0600)
├── mcp-config.json                # Optional MCP config
├── accounts/<ownId>/
│   ├── zalo.db                    # SQLite message/thread cache (WAL)
│   ├── media/                     # Auto-downloaded attachments
│   ├── sync/                      # RSA sync keys
│   └── daemon.lock                # Held while a `listen` daemon runs
└── qr.png                         # Most recent login QR
```

Official Account credentials are stored separately at `~/.zalo-agent/oa-credentials.json`.

---

## CLI Command Reference (via `npx zalo-agent <command>`)

Append `--json` to any command for machine-readable output. This is a shortlist — the exhaustive reference for all 178 commands is [skill/references/command-reference.md](skill/references/command-reference.md).

### Session & maintenance
| Command | Description |
|:---|:---|
| `npx zalo-agent status` | Check login status |
| `npx zalo-agent whoami` | Show the logged-in user's full profile |
| `npx zalo-agent login [--qr-url] [--credentials <path>] [-p <proxy>]` | QR login, or restore from an exported credentials file |
| `npx zalo-agent logout [--delete-history] [--purge] [--no-remote]` | Invalidate the session server-side; optionally delete the local cache or wipe the account entirely |
| `npx zalo-agent sync-mobile --transfer [-d <days>]` | **Restore message history from your phone** into the local cache (one confirmation on the phone). Full history by default; `-d/--days <n>` limits it to the last *n* days and finishes much sooner |
| `npx zalo-agent sync-mobile [-F] [-w <s>]` | Best-effort server socket backfill — no phone contact, usually returns nothing |
| `npx zalo-agent update` | Self-update to the latest published version |
| `npx zalo-agent mcp start [--http <port>] [--auth <token>] [--host <addr>]` | Start the MCP server |

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

| Variable | Effect |
|:---|:---|
| `ZALO_AGENT_NO_UPDATE_CHECK` | Set to any value to disable the background update-version check |
| `ZALO_JSON_MODE` | Set automatically by the CLI in `--json` and `mcp` modes to suppress `zca-js` stdout logs. Don't set it by hand |
| `ZALO_MCP_HTTP_PORT` | Read by the `zalo-mcp` wrapper as the fallback `--http` port |

---

## Troubleshooting

| Symptom | Cause / fix |
|:---|:---|
| MCP client shows no tools, or the connection drops immediately | Something printed to stdout. In stdio mode stdout is the JSON-RPC channel — check stderr logs for the real error |
| `Duplicate Zalo Web session detected. Exiting.` | Only one WebSocket per account. Close Zalo Web in the browser, and don't run `listen` and `mcp start` for the same account at once |
| `account remove` / `logout --purge` refuses with a PID | A `listen` daemon holds `daemon.lock` for that account. Stop it first |
| `Thread name cache not initialized yet` from `zalo_search_threads` | The cache builds at MCP startup by fetching all groups + friends. Retry after a few seconds |
| OA call fails with `-216` | Access token expired → `npx zalo-agent oa refresh` |
| OA call fails with `-224` | OA tier too low → see [zalo.cloud/oa/pricing](https://zalo.cloud/oa/pricing) |
| A "new version available" notice never appears | It is skipped when stdout isn't a TTY, in `--json` mode, or when `ZALO_AGENT_NO_UPDATE_CHECK` is set |

---

## npm Registry Fail-Safe

If `@ardennguyen/zalo-agent-cli` is ever unavailable from npm, `zalo-mcp`'s `package.json` dependency can be pointed straight at GitHub instead:
```json
"@ardennguyen/zalo-agent-cli": "github:ardennguyen/zalo-agent-cli"
```
Then re-run `./zalo-mcp.sh update` (or `.\zalo-mcp.ps1 update`) to pull and install the engine directly from source.

---

## More Documentation

Full command reference, MCP setup details, local cache behavior, Official Account API, and more — both English and Vietnamese:
**[Wiki → github.com/ardennguyen/zalo-agent-cli/wiki](https://github.com/ardennguyen/zalo-agent-cli/wiki)**
