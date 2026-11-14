# Zalo MCP Server & CLI Installation Guide

[Tiếng Việt](INSTALLATION.vi.md)

This document covers deploying the **`zalo-mcp`** wrapper — a self-contained, sandboxed installer that pulls in the `zalo-agent-cli` engine and exposes it as a Model Context Protocol (MCP) server, so AI agents (Claude Code, Cursor, and others) can automate Zalo Personal & Official Accounts without touching your global system.

> If you only want the CLI (no MCP server), skip straight to `npm install -g @ardennguyen/zalo-agent-cli` — see the main [README.md](README.md).

---

## How the two repos relate

- **`zalo-agent-cli`** (this repo) — the core engine. All API logic, auth, and the actual MCP server source (`src/mcp/`) live here. Since 3.0.0 it speaks to Zalo through its own implementation of Zalo's protocol (`src/zalo/`), with no zca-js.
- **`zalo-mcp`** — a lightweight deployment wrapper (separate repo: [github.com/ardennguyen/zalo-mcp](https://github.com/ardennguyen/zalo-mcp)). It contains no engine code; its install script pulls `zalo-agent-cli` into an isolated local folder, links the global `zalo-mcp` and `zalo-agent` CLI commands, and writes a `.env` so an AI client can run it immediately. When invoked without a CLI subcommand (`zalo-mcp` or `node mcp-server.js`), it spawns `zalo-agent mcp start` and forwards all `mcp start` flags (`--account`, `--http`, `--auth`, `--host`, `--config`, `--no-self-heal`, `--no-delivered-receipts`, plus global storage flags); when invoked with a CLI subcommand (`zalo-mcp login`, `zalo-mcp --account <ID> msg list --json`, `zalo-mcp sync`, …), it forwards the arguments directly to `zalo-agent`.

Because the wrapper is a pass-through, **the MCP tool surface is defined entirely by `src/mcp/mcp-tools.js` in this repo** — whichever `zalo-agent-cli` version `zalo-mcp` has installed.

> [!NOTE]
> A deployed `zalo-mcp` folder serves the `@ardennguyen/zalo-agent-cli` version installed in its `node_modules/`. Check with:
> ```bash
> node -p "require('./node_modules/@ardennguyen/zalo-agent-cli/package.json').version"
> ```
> Run `./zalo-mcp.sh update` (or `.\zalo-mcp.ps1 update`) to pull the latest published engine.

---

## Upgrading from 2.5.9 to 3.0

Engine 3.0.0 replaces zca-js with the project's own implementation of Zalo's protocol; wrapper `zalo-mcp` 2.1.0 requires it. **3.0 encrypts what 2.x left in plaintext, and that is one-way**, so do these steps in order:

1. **Stop every 2.x process** that uses the home (`listen`, `mcp start`, a `zalo-mcp` service, a scheduled `sync`), on this machine and on any other machine that runs a copy of the same login.
2. **Back up the plaintext home** — `~/.zalo-agent-cli/`, plus the `--credentials-dir` / `--data-dir` / `--media-dir` roots if you moved them — before any 3.0 command runs. It is your only way back to 2.5.9, and it holds the login in the clear: keep it as you would the account itself, and delete it once 3.0 runs as you want.
3. **Update** (`./zalo-mcp.sh update`, `.\zalo-mcp.ps1 update` or `npm install -g @ardennguyen/zalo-agent-cli`). On a Linux server with no desktop keyring, choose a key provider first (a passphrase file, systemd-creds or a KMS: [docs/security.md](docs/security.md)).
4. **Run `zalo-agent account security migrate --all`** (or just start using 3.0: each command seals what it opens). It seals the saved login and small files, encrypts each account's `zalo.db` (SQLCipher; about 1 s per 20 MB, needing about 1.1× its size free) and the webhook outbox, and seals the media (without `migrate`, a running daemon seals the older media in the background). From then on **2.5.9 cannot read any of it**, and there is no command that writes it back in plaintext. `zalo-agent account security status --all` shows what is done.
5. **Never run the backup and the upgraded home at the same time**, here or elsewhere: they are two copies of one saved login and kick each other off.

Then check these breaking changes:

- **The message database is encrypted.** A bot that opened `zalo.db` directly gets `file is not a database`; move it to `zalo-agent db query` / `db export` or the MCP tools.
- **Destructive CLI commands need `--yes`** (`msg undo`, `group leave`, `logout`, `account export`, …): without it they send nothing and exit 2; `--dry-run` previews.
- **Guarded MCP actions need `confirm: true`** (`zalo_undo`, `zalo_delete_message`, `zalo_group` `leave`, …). `confirmMode` in `mcp-config.json` (or `ZALO_MCP_CONFIRM_MODE`, or the runtime policy) decides who confirms: `agent` (default), `human` (the server asks the user: by MCP elicitation under stdio, otherwise on a one-time approve page whose link is in the reply, which works over HTTP too) or `off`. `groupConfirm` / `ZALO_MCP_GROUP_CONFIRM` still work as deprecated aliases for `off`.
- **MCP names:** `msgId` (not `id`/`messageId`), `userId` (not `uid`), `threadType` `"dm"` or `"group"` (a number is refused), and every id is a string. `senderName` is now the alias the account owner set (the Zalo name is `senderZaloName`).
- **On-demand presence is the default for `mcp start --http` and `listen --daemon`**: see [On-demand presence](#on-demand-presence). Set `presence.mode: "always-on"` where a webhook must fire in real time.
- **A kick no longer ends an on-demand daemon**: it yields (`YIELDED`) until `zalo-agent presence resume --yes`. **A login Zalo keeps refusing no longer ends any daemon**: it stays up `signed_out` until the account is added again by QR; `ZALO_EXIT_ON_SIGNED_OUT=1` keeps the old exit 4.
- **Leaving a group deletes its local history** (also when the account is removed or blocked, or the group is disbanded), as Zalo's own apps do; set `groups.onLeave: "keep"` in `storage.json` (or `ZALO_GROUPS_ON_LEAVE=keep`) before upgrading to keep it.
- **`ZALO_QR_FLOW=legacy` is removed**; delete it from `.env`.
- **A CLI command that fails exits 1** (before, most exited 0). Exit codes: 0 done, 1 failed, 2 confirmation needed, 3 an always-on daemon was kicked (another session took the account), 4 Zalo keeps refusing the saved login (a daemon exits 4 only with `ZALO_EXIT_ON_SIGNED_OUT=1`). With `--json` a failure is `{"error": …}`, and stdout is always one JSON object or array.

The full list is in the [CHANGELOG](CHANGELOG.md).

---

## Prerequisites

- **Node.js** 22.19 or later (the CLI's `engines` field asks for `>=22.19.0`, the floor its dependencies `undici` and `commander` set at 22.19 and 22.12)
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
A QR code prints in the terminal, and a local HTTP server also serves it at `http://127.0.0.1:18927/qr` — loopback only; `--qr-url` binds it to every interface for a headless machine, and anyone who reaches it before it expires can sign in as this account. Behind a reverse proxy, `--public-url <url>` (or `ZALO_MCP_PUBLIC_URL`) prints a one-time `<url>/zalo/qr/<token>` page instead. Scan it with the **Zalo app's QR Scanner** (not the phone's regular camera) and confirm on the phone. If you decline on the phone, the CLI reports it immediately instead of waiting out the 60-second QR timeout.

After a QR login:

- **"Sync messages to this device" on the phone.** `login` always reads whether you ticked it. Ticked: the history is restored at once, with no further tap (`--sync-days <n>` limits it). Not ticked: nothing starts, and the command prints the `zalo-agent sync --from <date>` run that restores what this machine lacks. `--no-sync` only reports; `--verbose` lists the control queues read and every control seen (never a key). With a `listen`/`mcp` daemon holding the account the tick is not read and the command is printed instead.
- **The device id is kept.** Zalo keeps the offline queue per device, so a QR re-login of an account that still has its saved login here logs in with the same device id, and Zalo's queue for it survives the re-login (`Device: the same device id ...`). A first login, a login after `logout` (which deletes the saved login) or another account gets a new device id (`Device: a new device id ...`). The saved login records since when the id is in use (`deviceSince`), and a daemon never claims coverage from before it.

> [!IMPORTANT]
> **Zalo keeps one web login per account, and this server is it.** A QR login into **Zalo in a browser** anywhere else signs the server out: a running daemon stays up `signed_out` and refuses every request with `SIGNED_OUT` until you add the account again by QR (`ZALO_EXIT_ON_SIGNED_OUT=1` makes it exit 4 instead), and a browser tab with Zalo open that takes the socket makes an on-demand daemon yield (`YIELDED`). **The phone app and the Zalo desktop app are separate logins that run beside the server** — read along there, never in a browser. Each QR login adds a new entry to the phone's device list (the server's older entries show as logged out); the offline queue survives because the device id is kept.

> **Storage:** `~/.zalo-agent-cli/` (mode `0600`), sealed at rest with the machine's key provider ([docs/security.md](docs/security.md)).
> **Risk:** this is an unofficial API (Zalo's own undocumented protocol) — heavy/automated use can get the account banned. Don't use your primary personal account.

### B. Zalo Official Account and ZBS (official APIs)
```bash
zalo-mcp oa init --app-id <YOUR_APP_ID> --secret <YOUR_APP_SECRET>
```
Follow the browser prompt to authorize the app. For a headless VPS:
```bash
zalo-mcp oa login --app-id <ID> --secret <KEY> --callback-host https://your-domain.com
```

> **Storage:** `~/.zalo-agent/oa-credentials.json` (mode `0600`) — note this is a **different directory** from the personal account's `~/.zalo-agent-cli/`.
> OA access tokens expire after ~25h; a call that finds the token expired refreshes it once with the stored refresh token, and `zalo-mcp oa refresh` renews it anytime. `zbs …` (ZBS Template Message) uses the same login.

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
ZALO_MCP_AUTH_TOKEN=<token> zalo-mcp --http 3847 --host 192.168.1.20   # LAN: the LAN address, the token in the environment
ZALO_MCP_AUTH_TOKEN=<token> zalo-mcp --http 3847 --host 192.168.1.20 --cert /path/to/fullchain.pem --key /path/to/privkey.pem
# Internet / VPS: keep 127.0.0.1 behind a TLS reverse proxy, see docs/config-samples/use-cases/c-vps-few-accounts/README.md
```

Under the hood this runs `zalo-agent mcp start --http <port> [--host <addr>] [--cert <path> --key <path>]`, with the bearer token from `ZALO_MCP_AUTH_TOKEN`. All `mcp start` flags are supported identically via `zalo-mcp` and `zalo-agent mcp start`:

| Flag | Default | Description |
|:---|:---|:---|
| `--account <id>` | Active at startup, then pinned | Registered numeric account ID to pin across reconnect/retry without changing the shared active account |
| `--http <port>` | *(stdio)* | Use HTTP (or HTTPS when `--cert` and `--key` are given) transport on this port |
| `--auth <token>` | `ZALO_MCP_AUTH_TOKEN` in `.env` | Require `Authorization: Bearer <token>` on every endpoint except `/health`, `/ready` and the OAuth discovery/handshake endpoints. Prefer the environment variable: a flag is visible in the process list |
| `--host <address>` | `127.0.0.1` | Bind address. On a LAN, the machine's LAN address; on the internet, keep `127.0.0.1` behind a TLS reverse proxy. Avoid `0.0.0.0` |
| `--cert <path>` | `tls.cert` in `mcp-config.json` | TLS certificate file path (PEM) to serve HTTPS directly via Node's `https` server (requires `--http` and `--key`; automatically attempts secondary bind on port `443` when `port !== 443`) |
| `--key <path>` | `tls.key` in `mcp-config.json` | TLS private key file path (PEM) to serve HTTPS directly via Node's `https` server (requires `--http` and `--cert`) |
| `--client-id <id>` | `zalo-mcp` (or `ZALO_MCP_OAUTH_CLIENT_ID[_<ownId>]`) | OAuth 2.0 Client ID for remote MCP clients like Gemini Connected Apps |
| `--client-secret <key>` | `--auth` / `ZALO_MCP_AUTH_TOKEN[_<ownId>]` | OAuth 2.0 Client Secret for `/token` exchange |
| `--public-url <url>` | `ZALO_MCP_PUBLIC_URL[_<ownId>]`, `publicUrl` in `mcp-config.json` | The one public address of the server behind a proxy or TLS (e.g. `https://zalo.example.com`, optionally with a base path): the MCP endpoint, the OAuth issuer, and the links to the one-time secure and QR pages. `https`, or `http` on localhost only. Unset: links use the server's own address and OAuth infers its issuer from the request's `Host` |
| `--issuer-url <url>` | *(deprecated)* | Deprecated name of `--public-url`; still works |
| `-w, --webhook <url>` | `webhook` in `mcp-config.json` | POST each watched incoming message as JSON to this URL (`ZALO_WEBHOOK_URL[_<ownId>]`) |
| `--webhook-secret <secret>` | `webhookSecret` in `mcp-config.json` | Shared secret to sign webhook POSTs with `Authorization: Bearer <secret>` + `X-Zalo-Signature: sha256=<hmac>` (`ZALO_WEBHOOK_SECRET[_<ownId>]`; the flag wins, then the environment variable, then the config key; an empty flag is refused; prefer the environment variable, since a flag is visible in the process list) |
| `--config <path>` | `~/.zalo-agent-cli/mcp-config.json` | Custom MCP config file |
| `--no-self-heal` | *(enabled)* | Disable automatic gap self-healing after reconnect. Refused at start under on-demand presence (the catch-up is how a parked window comes back); works with `presence.mode: "always-on"` |
| `--log-level <level>` | `info` (`ZALO_LOG_LEVEL`) | `error`, `warn`, `info` or `debug` for `daemon.log` |
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
# → {"status":"ok","uptime":123,"threads":5,"socket":"idle","ready":true}
```

`socket` is `up`, `idle` (parked by on-demand presence; it wakes on demand), `connecting`, `down`, `yielded`, `signed-out`, `maintenance`, `kicked`, `relogin`, `starting` or `stopping`. `GET /ready` (no auth either) answers 200 while it is `up` or `idle`, else 503.

> Binding to any address other than loopback without a token exposes your Zalo session to anyone who can reach the port. Always set `ZALO_MCP_AUTH_TOKEN` for a server other machines reach. The admin API (`/zalo/admin/…`: runtime policy, usage, exports) takes its own admin credential (`zalo-agent policy token --rotate`), never the agent's token; the sample proxies answer 404 for it, so reach it on loopback, over an SSH tunnel or a VPN.

Running it unattended on a production host (systemd unit, restarts, monitoring, backup, security) is covered in [docs/deployment.md](docs/deployment.md). Since 3.0.0 the saved login is encrypted at rest; on a Linux server without a desktop keyring, choose a key provider first (systemd-creds, a KMS or a passphrase file): see [docs/security.md](docs/security.md).

### On-demand presence

Since 3.0.0, **`mcp start --http` (foreground or `-d`) and `listen --daemon` run on-demand**: the socket is held only while something needs it — an MCP tool call, a `zalo_wait_for_message` / `GET /events/wait`, a CRM lease (`POST /zalo/presence/leases`), a CLI request the daemon serves (an upload, a `sync` stage, `mcp wait`) or `zalo-agent presence wake` — and parks after `presence.idleTimeout` (5 minutes; never within `presence.minConnected`, 60 s, of a connect). One catch-up runs at start. What arrives while parked comes back from Zalo's offline queue on the next connect, so webhooks and waits get it then, flagged `catchUp: true`. Cache reads wait up to `presence.warmWait` (10 s) for a waking socket; a call that needs the socket itself may answer `WARMING` with `retryAfterSec`.

- **Real time** (a webhook that must fire as the message arrives): `presence.mode: "always-on"` in `mcp-config.json`, the runtime policy, or `ZALO_PRESENCE_MODE[_<ownId>]=always-on`. stdio MCP and a foreground `listen` printing to stdout are always-on anyway.
- **Another session takes the account** (a second copy of the same login, a browser tab with Zalo open): an on-demand daemon **yields** and refuses everything with `YIELDED`; nothing takes the account back on its own. Close the other session, then `zalo-agent presence resume --yes` (or `zalo_profile` `presence_resume`, or the admin API). An always-on daemon exits 3, as before.
- **Zalo keeps refusing the login** (typically a QR login into Zalo in a browser elsewhere): the daemon stays up `signed_out` and refuses with `SIGNED_OUT` until the account is added again by QR.
- `zalo-agent presence status` shows the mode, the state (`parked`, `waking`, `connected`, `parking`, `yielded`, `signed-out`) and the open holds; `account_state` events go to the webhook, the MCP buffer and `/status`. Many daemons on one machine: `ZALO_CONNECT_SLOTS` caps how many wake at once.

All `presence.*` keys: [docs/configuration.md](docs/configuration.md#users-the-always-on-cap-and-on-demand-presence).

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
   # one systemd unit per account, its token in its own env file: docs/config-samples/use-cases/c-vps-few-accounts
   za fleet generate --out /tmp/fleet --base-port 3901 --domain zalo.example.com
   ```
4. **Concurrent CLI commands per account (without touching `accounts.json`):**
   ```bash
   zalo-agent --account 101 msg send <threadId> "Hello from Shop A" --json
   zalo-mcp --account 202 sync --days 7
   ```

### MCP tools exposed

This engine source registers **36 MCP tools** in `src/mcp/mcp-tools.js`, all covering the **personal account**:

| Tool | Purpose |
|:---|:---|
| `zalo_get_messages` | Read buffered live messages with a cursor for incremental polling |
| `zalo_send_message` | Send text, file/image attachments (`filePath`/`files`), a link preview card (`link`), a contact card (`cardUserId`), a sticker, a voice message from a URL, a video from a URL or a local file, a bank card or a VietQR transfer image to a DM or group — with @-mentions, a quote-reply, Important/Urgent `urgency`, or `threadId: "me"` for My Documents |
| `zalo_list_threads` | List buffered threads with unread counts |
| `zalo_search_threads` | Fuzzy, Vietnamese-accent-insensitive thread search by name |
| `zalo_mark_read` | Mark buffered messages up to a cursor read for one consumer (global, not per-thread; deletes nothing, so several bots can share one server) |
| `zalo_get_history` | Older messages: the local cache first, then Zalo, paginated — Zalo serves only messages since this login, and older history comes from the phone-backed `zalo-agent sync` |
| `zalo_view_media` | A received image/audio/video/file attachment (downloaded first if needed), delivered `inline` (MCP content), as an expiring `link` (`<publicUrl>/zalo/media/<token>`) or as a private `tempfile`, by the deployment's `media.*` policy |
| `zalo_react` | React to a message (`/-strong`, `/-heart`, `:>`, …), as `msg react` does — refused, with nothing sent, when the message's cliMsgId is neither passed nor cached |
| `zalo_undo` | Recall one of your own messages for everyone, as `msg undo` does; same cliMsgId rule |
| `zalo_get_group_members` | List a group's members — uid and display name — as `group members` does |
| `zalo_list_conversations` | Recent conversations from the local cache, newest first, as `conv recent` does |
| `zalo_coverage` | Read-only: pending coverage gaps in the local cache, how many are resolved, and the `zalo-agent sync --from <date>` run that restores the rest |
| `zalo_sync` | Start an owner-requested sync stage (messages, reactions, zCloud index, media downloads, group boards); returns immediately with a job ID. Messages still needs phone confirmation |
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
| `zalo_group` | Every `group` command: inspect, create, rename, members, admins, owner, blocked members, settings, join requests, invite links and invitations, leave, disperse |
| `zalo_friend` | Friend requests, the friend list, nicknames, online and last-seen, remove, block / unblock, hide a feed, find by phones, QR codes, shared groups, business details |
| `zalo_read` | Run one of Zalo's read-only endpoints that no other tool covers (sticker and GIF catalogs and search, profile rank, block list, nicknames, status…), or list them |
| `zalo_write` | Make one of Zalo's state-changing calls that no other tool covers (reminder RSVP, group notes and reminders with repeat rules, pins, multi-recall, …), or list them; a real call needs `confirm: true`, `dryRun: true` shows the request |
| `zalo_conversation` | Pin, archive, mute, hide, mark read or unread, auto-delete, delete or forget a conversation; typing indicator; report a user or group |
| `zalo_profile` | This account's avatar, bio, name, privacy settings, online status, language and linked devices; `usage` (this machine's storage and quota, as `db usage`) and `presence_resume` (take the account back after a yield, as `presence resume`) |
| `zalo_auto_reply` | List, create, update or delete auto-reply rules |
| `zalo_quick_message` | List, add, update or remove quick messages |
| `zalo_catalog` | Zalo Shop catalogs and products |
| `zalo_bank` | Supported banks, and the bank accounts saved on this account |
| `zalo_cloud` | The local zCloud index: summary, cleanup plan, and the cleanup itself (guarded) |
| `zalo_sticker` | Find stickers by keyword, and their details |
| `zalo_link` | A link's preview, and whether Zalo considers it safe |

See [Sync usage and details](docs/mcp-sync.md) / [Tiếng Việt](docs/mcp-sync.vi.md).

Every personal CLI command has an MCP action. **CLI-only** are Official Account and ZBS commands (`oa …`, `zbs …`, separate official APIs), logging in and out (`login`, `logout`, `status`), the local account registry (`account list|login|switch|remove|info|export`), the operator's steps on this machine's keys and data (`account security …`, `db query|backup|export|verify|purge`), the runtime policy (`policy …`: an agent never sees or changes its own limits), the daemon and fleet commands (`listen`, `mcp start`, `mcp webhook …`, `mcp approver`, `presence status|wake|park`, `fleet …`), `update`, `profile lost-focus`, and `cloud get` (it takes the account's cloud key); agents reach them by shelling out to `zalo-agent <command> --json` (or `zalo-mcp <command> --json`).

Full tool reference (parameters, return shapes, config): [skill/references/mcp-guide.md](skill/references/mcp-guide.md).

### MCP config

Optional file at `~/.zalo-agent-cli/mcp-config.json` — shallow-merged per top-level key over the defaults. Useful keys:

```json
{
  "watchThreads": ["dm:*", "group:*"],
  "notify": { "enabled": false, "thread": null, "on": ["dm"], "cooldown": "5m" },
  "limits": { "bufferMaxAge": "2h", "bufferMaxSize": 500 },
  "media": { "downloadDir": null, "autoOpen": null, "deliver": null, "linkAuth": null },
  "confirmMode": "agent",
  "hiddenChats": "exclude",
  "publicUrl": null,
  "presence": { "mode": null, "idleTimeout": null }
}
```

`publicUrl` is the one address people and clients reach a server at behind a proxy or TLS: the MCP endpoint, the OAuth issuer, the one-time approve, PIN and QR pages, and media links. `confirmMode`, `hiddenChats`, `approval.*`, `media.*` (but `downloadDir`), `webhook*` and `presence.*` can also be changed while the server runs, through the runtime policy (`zalo-agent policy set <key> <value>` or the admin API), which beats this file. Full table of fields and defaults: [docs/configuration.md](docs/configuration.md) and [skill/references/mcp-guide.md](skill/references/mcp-guide.md).

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
├── credentials/cred_<ownId>.json  # Per-account saved login (0600, sealed)
├── mcp-config.json                # Optional MCP config
├── storage.json                   # Optional: key provider, quota, retention, groups.onLeave
├── .env                           # Optional: engine settings and storage paths
├── fleet.json                     # Port table of `fleet` (once used)
├── policy-audit.log               # Every runtime-policy change and refusal (keys and revs, never values)
├── admin/, tenants/, users/       # Admin token hash, tenant and user policies (sealed; once used)
├── accounts/<ownId>/
│   ├── zalo.db                    # Message/thread cache: SQLCipher v4, WAL, row MACs
│   ├── keyring.json               # The account's wrapped keys: back it up with credentials/ and zalo.db
│   ├── webhook-outbox.db          # Durable webhook queue (SQLCipher)
│   ├── policy.json                # The account's runtime policy (sealed; once set)
│   ├── media/                     # Media downloaded by `listen` / `msg` (encrypted, per account)
│   ├── sync/                      # sync scratch (the phone restore's protocol cache)
│   ├── daemon.lock                # Held while a `listen`/`mcp start` daemon runs
│   ├── daemon-channel.json        # The running daemon's loopback channel
│   └── daemon.log                 # The daemon's log (rotated)
└── qr.png                         # Most recent login QR
```

> [!WARNING]
> **Without `keyring.json` and the key provider** (the same machine for DPAPI, the keychain, Secret Service or systemd-creds; the same KMS key; the same passphrase), neither the saved login nor the message database can be opened. `zalo-agent db backup --out <file>` writes an encrypted, verified copy of the database while a daemon runs; back up `keyring.json` with it. Moving an install to another machine: [docs/security.md](docs/security.md).

> [!NOTE]
> **One media directory, one layout.** Every command — `listen`, `msg history`, `mcp start`, `sync-media`, `sync-mobile` and the MCP tools — writes to `<mediaRoot>/<threadId>/` (default `accounts/<ownId>/media/<threadId>/`, or `--media-dir` / `ZALO_MEDIA_DIR` globally). Folders are named by thread ID, never by conversation name, because a name can contain a path separator or change when someone renames the group; `_conversations.json` maps ID to name. `mcp-config.json`'s `media.downloadDir` can also override the media root for the MCP server specifically.

> [!WARNING]
> **A custom `--media-dir` / `ZALO_MEDIA_DIR` or `media.downloadDir` is not removed by `logout --purge` or `account remove`.** Those wipe `<DATA_DIR>/<ownId>/` — default media included — and the credential file. Unset, the CLI and MCP server download into that same per-account folder, so a purge removes its media too; an external media mount sits outside it, and its attachments survive. Delete that directory by hand when removing an account for privacy reasons.

Official Account credentials are stored separately at `~/.zalo-agent/oa-credentials.json` (or `<ZALO_OA_DIR>/oa-credentials.json`).

---

## CLI Command Reference (via `npx zalo-agent <command>`)

Append `--json` to any command for machine-readable output. This is a shortlist — the exhaustive reference for all 315 commands is [skill/references/command-reference.md](skill/references/command-reference.md).

### Session & maintenance
| Command | Description |
|:---|:---|
| `npx zalo-agent status` | Check login status |
| `npx zalo-agent whoami` | Show the logged-in user's full profile |
| `npx zalo-agent login [--qr-url] [--public-url <url>] [--credentials <path>] [-p <proxy>] [--no-sync] [--sync-days <n>] [--verbose]` | QR login, or restore from an exported credentials file. After a QR login it reads the phone's "sync messages to this device" tick: ticked, the history is restored at once (no tap); not ticked, it prints the `sync --from <date>` run to use. `--no-sync` only reports; `--verbose` lists what it read. A re-login keeps the device id |
| `npx zalo-agent logout --yes [--delete-history] [--purge] [--no-remote] [--keep-session]` | Sign the device out at Zalo (as Zalo's own apps do) and delete the saved credentials; `--keep-session` only ends the session key (the pre-v3.0 behavior, after which the login ends at Zalo only when the device is removed from the phone's list); optionally delete the local cache or wipe the account entirely |
| `npx zalo-agent sync-mobile --transfer [-d <days>]` | **Restore message history from your phone** into the local cache (one confirmation on the phone). Full history by default; `-d/--days <n>` limits it to the last *n* days and finishes much sooner |
| `npx zalo-agent sync-mobile [-F] [-w <s>]` | Restore history from your phone — prompts the phone once. Add `--socket` for the old server probe, which contacts no phone and usually returns nothing |
| `npx zalo-agent update` | Self-update to the latest published version |
| `npx zalo-agent mcp start [--http <port>] [--host <addr>] [-d]` | Start the MCP server (token from `ZALO_MCP_AUTH_TOKEN`; HTTP runs on-demand presence) |
| `npx zalo-agent presence status\|wake\|park` / `presence resume --yes` | The running daemon's socket under on-demand presence; `resume` takes the account back after a yield |
| `npx zalo-agent policy get\|set\|unset <key> [value]` / `policy token --rotate` | The runtime policy a running server takes without a restart; the admin API's token |
| `npx zalo-agent db query "<sql>"` / `db backup -o <file>` / `db export -o <file> --password` / `db verify` / `db usage` / `db purge --yes` | The encrypted message database: read-only SQL, an encrypted backup, a password-encrypted (or `--plaintext --yes`) copy, the row-MAC check, storage and quota, the quota/retention purge. Hidden chats only with `--include-hidden` and the PIN |
| `npx zalo-agent account security status --all` / `account security migrate --all` | How this machine protects each account's files at rest; seal what is still plaintext |
| `npx zalo-agent mcp wait [since] [-t <threadId>] [--timeout <s>] [-n <count>] [--settle <ms>] [-c <name>]` | Long-poll the running `mcp start` daemon's buffer for the next message (`zalo_wait_for_message` CLI equivalent) |
| `npx zalo-agent mcp mark-read <cursor> [-c <name>]` | Advance the consumer read cursor in the running `mcp start` daemon's buffer (`zalo_mark_read` CLI equivalent) |

### Personal account
| Command | Description |
|:---|:---|
| `npx zalo-agent msg send <threadId> "text" [-t 1]` | Send text (DM, or group with `-t 1`) |
| `npx zalo-agent msg send-image <threadId> <path>` | Send an image |
| `npx zalo-agent msg send-file <threadId> <path>` | Send a file |
| `npx zalo-agent msg history <threadId> [-t 1] [-n 50] [--no-cache]` | Fetch history (served from the local cache unless `--no-cache`) |
| `npx zalo-agent msg undo <msgId> <threadId> -c <cliMsgId> --yes` | Recall a message for everyone |
| `npx zalo-agent friend list` / `friend find <phone>` | List / find friends |
| `npx zalo-agent group list [-q <text>]` / `group members <groupId>` | List groups / members |
| `npx zalo-agent conv recent [-n 20]` | List recent conversations with thread IDs |
| `npx zalo-agent account devices` | List devices/sessions linked to the active account |
| `npx zalo-agent account status` | The account's plans: zBusiness package, zCloud plan, usage and limits, and this machine's storage (read-only) |
| `npx zalo-agent account remove <ownerId> --yes` | Invalidate remote session, wipe local data, delete creds |
| `npx zalo-agent account export [ownerId] -o <path> --yes` | Write the saved login out as a plaintext JSON file (to move it to another machine); nothing is written without `--yes` |
| `npx zalo-agent listen [--webhook <url>] [--save <dir>]` | Real-time listener, optional webhook forwarding and JSONL archival |
| `npx zalo-agent msg send-qr-transfer <id> <acct> --bank <alias> -a <amount>` | Send a VietQR payment |

### Official Account (OA)
| Command | Description |
|:---|:---|
| `npx zalo-agent oa whoami` | View OA profile |
| `npx zalo-agent oa msg text <userId> "text"` | Send a consultation (CS) message to a user |
| `npx zalo-agent oa follower list` | List the OA's user ids |
| `npx zalo-agent oa tag assign <userId> <tag>` | Tag a follower |
| `npx zalo-agent oa upload image <path>` | Upload an image, returns an attachment ID |
| `npx zalo-agent oa listen -p <port> [-s <oa-secret-key>]` | Start a local OA webhook listener (checks event signatures with the OA secret key) |
| `npx zalo-agent oa refresh` | Refresh the OA access token |
| `npx zalo-agent zbs send <phone> <templateId> <data-json>` | Send a ZBS template message by phone number (transaction/promotion messages) |
| `npx zalo-agent zbs status <messageId>` | Delivery status of a ZBS message |

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
| `ZALO_API_VERSION` | Protocol version announced to Zalo (`zpw_ver` / `client_version`), on the HTTP calls and the WebSocket URL alike. Default `695` (the value Zalo currently expects); set an older value such as `685` to roll back. Must be a positive whole number — `0685`, `6.91`, `1e3`, `0x2b3`, `-685` and `0` are refused before Zalo is contacted, so a bad value fails every login rather than quietly falling back. Whitespace-only counts as unset. Only logins read it. |
| `ZALO_QR_FLOW` | Which QR login `login` uses: `official` (the default: the sequence Zalo's own login makes, no `verify-client`, `continue=https://chat.zalo.me/`, the session redirects through `jr.zaloapp.com` and `jr.chat.zalo.me`, and the second QR an account with a trusted device is asked to scan, which makes this client a trusted companion device). It is the only QR login: `legacy` was removed in 3.0.0 and, like any value other than `official`, is refused before Zalo is contacted. Only QR logins read it |
| `ZALO_NET_PROBE` | What a daemon asks to learn whether the network is up while its socket is down (every 10 s). A URL, by default a global search engine's lightweight page; `off` assumes the network is always up and contacts nothing but Zalo |
| `ZALO_JSON_MODE` | Set automatically by the CLI in `--json` and `mcp` modes, so that stdout carries only machine-readable output. Don't set it by hand |
| `ZALO_MCP_HTTP_PORT` | Read by `mcp start` and the `zalo-mcp` wrapper as the fallback `--http` port (supports `ZALO_MCP_HTTP_PORT_<ownId>`) |
| `ZALO_MCP_HOST` | Default bind address for `mcp start --http` (supports `ZALO_MCP_HOST_<ownId>`) |
| `ZALO_MCP_AUTH_TOKEN` | Bearer token for `mcp start --http` and fallback OAuth 2.0 client secret (supports `ZALO_MCP_AUTH_TOKEN_<ownId>`) |
| `ZALO_MCP_OAUTH_CLIENT_ID` | OAuth 2.0 Client ID for `mcp start --http` (default `zalo-mcp`; supports `ZALO_MCP_OAUTH_CLIENT_ID_<ownId>`) |
| `ZALO_MCP_OAUTH_CLIENT_SECRET` | OAuth 2.0 Client Secret for `mcp start --http` (supports `ZALO_MCP_OAUTH_CLIENT_SECRET_<ownId>`) |
| `ZALO_MCP_PUBLIC_URL` | The one public address of `mcp start --http` behind a proxy or TLS: MCP endpoint, OAuth issuer, secure and QR page links; also the QR link of `login` (supports `ZALO_MCP_PUBLIC_URL_<ownId>`) |
| `ZALO_MCP_ISSUER_URL` | Deprecated name of `ZALO_MCP_PUBLIC_URL`, still read by `mcp start` (supports `ZALO_MCP_ISSUER_URL_<ownId>`) |
| `ZALO_MCP_TLS_CERT` / `ZALO_MCP_TLS_KEY` | PEM certificate and private key paths for native HTTPS on `mcp start --http` (supports `_*_<ownId>`) |
| `ZALO_WEBHOOK_URL` / `ZALO_WEBHOOK_SECRET` | Default webhook URL and signing secret (`Authorization: Bearer` + `X-Zalo-Signature: sha256=<hmac>`) for `listen` and `mcp start` (supports `_*_<ownId>`) |
| `ZALO_WEBHOOK_BATCH_SIZE` / `ZALO_WEBHOOK_MAX_AGE` | Events per webhook POST (1–100, default 1) and how long an undelivered event is retried before it is dead-lettered (default `24h`). Both support `_<ownId>`. The webhook is durable: see `zalo-agent mcp webhook status` |
| `ZALO_LOG_LEVEL` / `ZALO_LOG_FORMAT` / `ZALO_LOG_MAX_SIZE` / `ZALO_LOG_KEEP` | `daemon.log` of `listen` and `mcp start`: level `error`, `warn`, `info` (default) or `debug` (adds a line per HTTP request and per message; also `--log-level`), `text` or `json` lines, and rotation at `50m` keeping 3 files |
| `ZALO_START_JITTER` / `ZALO_LOGIN_SLOTS` / `ZALO_LOGIN_SLOT_WAIT` | Spread a fleet's start-up: wait a random 0–N seconds before logging in, and let at most N daemons on the machine be logging in at once (a daemon over the cap waits, then goes ahead after `ZALO_LOGIN_SLOT_WAIT` seconds). Off by default |
| `ZALO_SEND_FORMAT` | `markdown` or `plain`: how text messages are sent. `zalo_send_message` converts Markdown to Zalo formatting by default; `msg send` sends plain unless `--markdown` (or this variable) says otherwise |
| `ZALO_STORAGE_PROVIDER` | The key provider that protects the saved files at rest: `dpapi`, `keychain`, `secret-service`, `systemd-creds`, `kms`, `passphrase`, `env`. Default by platform; a Linux server with no desktop keyring must set one (with `ZALO_STORAGE_PASSPHRASE_FILE`, `ZALO_KMS_KEY`, …). See [docs/security.md](docs/security.md) |
| `ZALO_PRESENCE_MODE` / `ZALO_PRESENCE_IDLE_TIMEOUT` | `on-demand` or `always-on`, and how long an on-demand socket stays up with nothing to do (default `5m`). Both support `_<ownId>`; the runtime policy beats them |
| `ZALO_EXIT_ON_SIGNED_OUT` | `1`: a login Zalo keeps refusing ends the daemon with exit 4, as before 3.0. Default: the daemon stays up `signed_out` until the account is added again by QR |
| `ZALO_CONNECT_SLOTS` / `ZALO_CONNECT_SLOT_WAIT` | At most N daemons on the machine waking their parked socket at once (default 0, no cap), and how long one waits for a slot (default 120 s) |
| `ZALO_MCP_CONFIRM_MODE` / `ZALO_MCP_HIDDEN_CHATS` | Who confirms a destructive tool action (`agent`, `human`, `off`), and what agents see of hidden chats (`exclude`, `contentless`, `include`). Both support `_<ownId>` |
| `ZALO_MCP_TRUSTED_PROXIES` | Reverse-proxy addresses whose `X-Forwarded-For` is believed (e.g. `127.0.0.1`); supports `_<ownId>` |
| `ZALO_RETENTION_MESSAGES` / `ZALO_RETENTION_MEDIA` | `keep` (default) or `<N>d`: how long the local cache keeps messages and media. Both support `_<ownId>` |
| `ZALO_GROUPS_ON_LEAVE` | `purge` (default) or `keep`: what happens to a left, removed-from, blocked-from or disbanded group's local history; supports `_<ownId>` |

This is a shortlist. Every variable, `mcp-config.json` key, `storage.json` key and runtime-policy key, with its precedence: [docs/configuration.md](docs/configuration.md).

---

## Troubleshooting

| Symptom | Cause / fix |
|:---|:---|
| MCP client shows no tools, or the connection drops immediately | Something printed to stdout. In stdio mode stdout is the JSON-RPC channel — check stderr logs for the real error |
| `Another Zalo session took this account`: an always-on daemon exits 3; an on-demand one stays up and every request answers `YIELDED` | Only one WebSocket per account. Close Zalo in the browser (use the phone or the Zalo desktop app instead), don't run `listen` and `mcp start` for the same account at once, and never run two copies of one login; then `zalo-agent presence resume --yes` for an on-demand daemon |
| Every request answers `SIGNED_OUT` (`account_state` `signed_out`) | Zalo revoked the server's login, usually because someone logged into Zalo in a browser with QR: Zalo keeps one web login per account. Log the account in again by QR (`zalo-agent login`, or the fleet controller's QR add), and keep Zalo in the browser closed |
| A tool answers `WARMING` with `retryAfterSec` | The on-demand socket is waking; repeat the call after that many seconds. Set `presence.mode: "always-on"` where that is not acceptable |
| `--no-self-heal cannot run with on-demand presence` at start | The catch-up is how a parked window comes back. Drop `--no-self-heal`, or set `presence.mode: "always-on"` |
| A bot that opened `zalo.db` gets `file is not a database` | Since 3.0.0 the database is encrypted (SQLCipher). Use `zalo-agent db query` / `db export` or the MCP tools |
| A read-only command stops with `PLAINTEXT` | A 2.x file it may not migrate itself; run `zalo-agent account security migrate --all` (with no daemon running) |
| `logout` (any form) / `account remove` refuses with a PID | A `listen` or `mcp start` daemon holds `daemon.lock` for that account. Stop it first |
| `Thread name cache not initialized yet` from `zalo_search_threads` | The cache builds at MCP startup by fetching all groups + friends. Retry after a few seconds |
| HTTP MCP server unreachable from another machine | By default `--http` binds `127.0.0.1` (loopback only). On a LAN, set `ZALO_MCP_HOST` to the LAN address and `ZALO_MCP_AUTH_TOKEN` in the environment (never `--auth` on a command line); on the internet, keep loopback behind a TLS reverse proxy (docs/config-samples/use-cases) (supported on both `zalo-mcp` and `zalo-agent mcp start`) |
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
