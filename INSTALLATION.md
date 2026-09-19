# Zalo MCP Server & CLI Installation Guide

This document covers deploying the **`zalo-mcp`** wrapper — a self-contained, sandboxed installer that pulls in the `zalo-agent-cli` engine and exposes it as a Model Context Protocol (MCP) server, so AI agents (Claude Code, Cursor, and others) can automate Zalo Personal & Official Accounts without touching your global system.

> If you only want the CLI (no MCP server), skip straight to `npm install -g @ardennguyen/zalo-agent-cli` — see the main [README.md](README.md).

---

## How the two repos relate

- **`zalo-agent-cli`** (this repo) — the core engine. All API logic, auth, and the actual MCP server source (`src/mcp/`) live here.
- **`zalo-mcp`** — a lightweight deployment wrapper (separate repo: [github.com/ardennguyen/zalo-mcp](https://github.com/ardennguyen/zalo-mcp)). It contains no engine code; its install script pulls `zalo-agent-cli` into an isolated local folder, sets up Node/Python, and writes a `.env` so an AI client can run it immediately.

---

## Prerequisites

- **Node.js** 22+
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

This creates a `zalo-mcp/` folder at your current location, installs Node packages into a local `node_modules/`, creates an isolated Python `venv/` (if Python is available), and writes a `.env`. You may be prompted for a port during interactive install, or edit `.env` afterward.

### Updating / cleaning an existing install

Run from inside the installed `zalo-mcp/` folder:
```bash
# Windows
.\zalo-mcp.ps1 update   # pull latest engine + deps
.\zalo-mcp.ps1 clean    # wipe node_modules/venv for a fresh reinstall

# macOS / Linux
./zalo-mcp.sh update
./zalo-mcp.sh clean
```
**Never run `npm install` directly inside a deployed `zalo-mcp` folder** — always go through `update`, which pulls the latest engine from `github:ardennguyen/zalo-agent-cli` in a controlled way.

---

## Authentication

All credentials are kept strictly local.

### A. Personal Zalo Account (unofficial API)
```bash
npm run login   # from inside the installed zalo-mcp/ folder
```
A QR code prints in the terminal. Scan it with the **Zalo app's QR Scanner** (not the phone's regular camera) and confirm on the phone.

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

> **Storage:** `~/.zalo-agent/oa-credentials.json` (mode `0600`).
> OA access tokens expire after ~25h — refresh anytime with `npx zalo-agent oa refresh`.

---

## AI Agent Integration (MCP)

Point your AI client at the installed `zalo-mcp/mcp-server.js` in stdio mode:

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

**Cursor / other stdio clients:** `node /absolute/path/to/zalo-mcp/mcp-server.js`

**Remote/VPS (HTTP transport):**
```bash
node mcp-server.js --http 3847
```
then point the client at `http://your-vps:3847` with an `Authorization: Bearer <token>` header if `--auth` was set.

`mcp-server.js` is a thin wrapper that just runs `zalo-agent mcp start` from the bundled engine — it exposes **7 MCP tools** covering personal-account messaging: `zalo_get_messages`, `zalo_send_message`, `zalo_list_threads`, `zalo_search_threads`, `zalo_mark_read`, `zalo_get_history`, `zalo_view_media`. Official Account, catalog, poll, reminder, auto-reply, and label features are CLI-only for now (`npx zalo-agent oa ...` etc.) — not yet exposed as MCP tools. Full tool reference: [skill/references/mcp-guide.md](skill/references/mcp-guide.md).

---

## CLI Command Reference (via `npx zalo-agent <command>`)

Append `--json` to any command for machine-readable output.

### Personal Account
| Command | Description |
|:---|:---|
| `npx zalo-agent status` | Check login status |
| `npx zalo-agent msg send <threadId> "text" [-t 1]` | Send text (DM, or group with `-t 1`) |
| `npx zalo-agent msg send-image <threadId> <path>` | Send an image |
| `npx zalo-agent msg send-file <threadId> <path>` | Send a file |
| `npx zalo-agent msg undo <msgId> <threadId> -c <cliMsgId>` | Recall a message for everyone |
| `npx zalo-agent friend list` / `friend find <phone>` | List / find friends |
| `npx zalo-agent group list` / `group members <groupId>` | List groups / members |
| `npx zalo-agent account devices` | List devices/sessions linked to the active account |
| `npx zalo-agent account remove <ownerId>` | Invalidate remote session, wipe local data, delete creds |
| `npx zalo-agent listen [--webhook <url>]` | Real-time listener, optional webhook forwarding |
| `npx zalo-agent msg send-qr-transfer <id> <acct> --bank <alias> -a <amount>` | Send a VietQR payment |

### Official Account (OA)
| Command | Description |
|:---|:---|
| `npx zalo-agent oa whoami` | View OA profile |
| `npx zalo-agent oa msg text <userId> "text"` | Send an OA message to a follower |
| `npx zalo-agent oa follower list` | List OA followers |
| `npx zalo-agent oa upload image <path>` | Upload an image, returns an attachment ID |
| `npx zalo-agent oa listen -p <port>` | Start a local OA webhook listener |

Full reference: [skill/references/command-reference.md](skill/references/command-reference.md) and [docs/official-account.md](docs/official-account.md).

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
