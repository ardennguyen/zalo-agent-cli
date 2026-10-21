# Zalo Official Account (OA)

[Tiếng Việt](official-account.vi.md)

Manage a Zalo Official Account via the official Zalo OA REST API v3.0 — completely independent from personal Zalo accounts (`zca-js`).

> **Note:** Several OA APIs require a paid OA tier. See [zalo.cloud/oa/pricing](https://zalo.cloud/oa/pricing).

## Quick Start

### Interactive (human)

```bash
zalo-agent oa init
```

Step-by-step guided wizard: enter credentials → OAuth login → webhook setup.

### Non-interactive (AI agent / CI)

```bash
# Login + skip webhook
zalo-agent oa init --app-id <APP_ID> --secret <SECRET> --skip-webhook

# Login + ngrok tunnel
zalo-agent oa init --app-id <APP_ID> --secret <SECRET> --tunnel ngrok -p 3000

# Login + existing webhook URL (VPS/n8n)
zalo-agent oa init --app-id <APP_ID> --secret <SECRET> --webhook-url https://your-server.com/webhook

# JSON output
zalo-agent --json oa init --app-id <APP_ID> --secret <SECRET> --skip-webhook
```

### VPS (headless server)

```bash
# On VPS — starts callback server on 0.0.0.0
zalo-agent oa login --app-id <APP_ID> --secret <SECRET> --callback-host https://your-vps.com

# Copy the auth URL → open in local browser → authorize → VPS receives token
```

---

## Commands

There are **32 commands** in the `oa` group. Every command accepts `--oa-id <id>` (default `default`) for managing multiple OAs, and `--json` for machine-readable output.

### Setup & Auth

| Command | Description |
|---------|-------------|
| `oa init [flags]` | Guided setup wizard (interactive + non-interactive) — see flag table below |
| `oa login --app-id <id> --secret <key> [-p, --port <port>]` | OAuth login (opens browser). Callback server listens on `127.0.0.1:<port>`, default port `3456`. 2-minute timeout |
| `oa login ... --callback-host <url>` | Headless VPS OAuth login — binds `0.0.0.0`, skips opening a browser, and prints the auth URL to open on a local machine |
| `oa refresh` | Refresh the access token using the saved refresh token |
| `oa setup <access-token>` | Set an access token manually (bypassing OAuth) |
| `oa whoami` | View OA profile: name, ID, description, follower count, OA type, service package (and expiry date), and ZCA link status. The package determines which APIs work: OA messaging, ZBS, and Article APIs require a verified OA on a paid Advanced/Premium package |

#### `oa init` flags

The wizard automatically switches to **agent (non-interactive) mode** whenever `--app-id` is passed.

| Flag | Default | Description |
|------|---------|-------------|
| `--app-id <id>` | — | Zalo App ID (triggers non-interactive mode) |
| `--secret <key>` | — | Zalo App Secret Key |
| `--oa-id <id>` | `default` | OA identifier for multi-OA setups |
| `--tunnel <type>` | `ngrok` (agent mode) | `ngrok` \| `cloudflared` \| `none` |
| `--webhook-url <url>` | — | Use an existing webhook URL (VPS, n8n, …) instead of starting a tunnel |
| `--verify-code <code>` | — | Zalo domain verification code |
| `-p, --port <port>` | `3000` | Local webhook listener port |
| `--skip-webhook` | `false` | Skip webhook setup completely |
| `--skip-login` | `false` | Skip OAuth login (reuse an already-saved token) |

The wizard runs through 5 steps: (1) save app-id/secret → (2) OAuth login + profile check → (3) prerequisite checklist at `developers.zalo.me` (interactive mode only) → (4) expose webhook → (5) print summary table (or JSON when `--json` is passed).

### Messaging

```bash
# Send text (message type: cs | transaction | promotion)
zalo-agent oa msg text <user-id> "Message content" [-m cs]

# Send image (direct URL or attachment_id)
zalo-agent oa msg image <user-id> --image-url https://...
zalo-agent oa msg image <user-id> --image-id <attachment_id>

# Send file (must upload first)
zalo-agent oa msg file <user-id> <file-id>

# Send list card
zalo-agent oa msg list <user-id> '[{"title":"Item 1"},{"title":"Item 2"}]'

# Check message delivery status
zalo-agent oa msg status <message-id>
```

### Followers

```bash
zalo-agent oa follower list [--offset 0] [--count 50]
zalo-agent oa follower info <user-id>
zalo-agent oa follower update <user-id> '{"name":"...","phone":"..."}'
```

### Tags

```bash
zalo-agent oa tag list
zalo-agent oa tag assign <user-id> <tag-name>
zalo-agent oa tag remove <tag-name>
zalo-agent oa tag untag <user-id> <tag-name>
```

### Media Upload

```bash
zalo-agent oa upload image ./photo.jpg    # Returns attachment_id
zalo-agent oa upload file ./document.pdf  # Returns file token
```

### Conversations

```bash
zalo-agent oa conv recent [--offset 0] [--count 10]
zalo-agent oa conv history <user-id> [--offset 0] [--count 10]
```

### Webhook Listener

```bash
# Basic
zalo-agent oa listen -p 3000

# With MAC verification
zalo-agent oa listen -p 3000 -s <OA_SECRET_KEY>

# Filter events
zalo-agent oa listen -e user_send_text,follow

# Custom webhook URL path (default /webhook)
zalo-agent oa listen -p 3000 --path /zalo

# Domain verification
zalo-agent oa listen -p 3000 --verify-domain <ZALO_VERIFY_CODE>

# JSON output (pipe)
zalo-agent --json oa listen | while read -r event; do
  echo "$event" | jq '.message.text'
done
```

| Flag | Default | Description |
|------|----------|--------|
| `-p, --port <port>` | `3000` | Listen port |
| `-s, --secret <key>` | — | OA Secret Key for MAC verification (HMAC-SHA256, timing-safe comparison). Warns if omitted |
| `--no-verify` | `false` | Disable MAC verification even when a secret is provided (development only) |
| `-e, --events <list>` | `all` | Comma-separated list of event names to filter |
| `--path <path>` | `/webhook` | Webhook URL path |
| `--verify-domain <code>` | — | Serve `/zalo_verifier<code>.html` for Zalo domain verification |

**Events:** `--events` accepts every event name documented by Zalo, including `follow`, `unfollow`, `user_send_text`, `user_send_image`, `user_send_file`, `user_send_audio`, `user_send_video`, `user_send_sticker`, `user_send_link`, `user_send_business_card`, `user_send_location`, `user_click_chatnow` (user clicked the OA's "Chat now" button), `user_seen_message`, `user_received_message`, `user_reacted_message`, `oa_send_*` echo events, GMF group events, voice call events, and ZBS events — see [`skill/references/oa-command-reference.md`](../skill/references/oa-command-reference.md) for the exhaustive list. `user_send_gif`, `user_click_button`, and `user_click_link` are not valid Zalo event names (listed by mistake prior to 2.0.0); filtering on an undocumented name prints an immediate warning at startup because that filter can never match.

The listener answers Zalo's `hub.challenge` (GET) verification automatically and caps request bodies at 1 MB. It **responds with `200 OK` immediately upon accepting an event** before printing it, because Zalo requires a 200 response within 2 seconds. When Zalo retries an event (`num_retry` header), the JSON output includes `_num_retry` and the printed line marks it as a redelivery so consumers do not process it as a brand-new event.

### Menu, Articles, Store

```bash
zalo-agent oa menu '{"buttons":[...]}'                        # Update OA chat menu

zalo-agent oa article create '{"title":"..."}'                 # Create article (broadcast)
zalo-agent oa article list [--offset 0] [--limit 10]           # List articles
zalo-agent oa article detail <article-id>                      # Article details

zalo-agent oa store product-create '{"name":"..."}'            # Create product
zalo-agent oa store product-list [--offset 0] [--limit 10]     # List products
zalo-agent oa store product-info <product-id>                  # Product details
zalo-agent oa store category-create '{"name":"..."}'           # Create category
zalo-agent oa store category-list                              # List categories
zalo-agent oa store order-create '{"...":"..."}'               # Create order
```

---

## Common Error Codes

| Code | Meaning | Resolution |
|------|---------|-----|
| `-216` | Access token is invalid or expired | Run `zalo-agent oa refresh` or re-run `oa login` |
| `-224` | OA service package tier is too low for this API | Upgrade at [zalo.cloud/oa/pricing](https://zalo.cloud/oa/pricing) |
| `-14029` | App is not approved | Complete app verification at [developers.zalo.me](https://developers.zalo.me) |

---

## Webhook Setup

### Zalo Requirements

1. **Domain verification** — Zalo requires domain ownership verification before enabling webhooks
2. **HTTPS required** — the webhook URL must use HTTPS
3. **Vietnam IP** — required to receive full user profile fields (name, avatar, phone number)
4. **Return 200 OK within 2 seconds** — otherwise Zalo retries at +30s, +5m, +15m, +30m, and +1h, and if deliveries still fail, **disables the webhook and unsubscribes the app** (requiring manual re-registration in the app settings)

### Checklist at `developers.zalo.me`

1. **Official Account → Callback URL**: set `http://localhost:3456/callback` (or `<callback-host>/callback` when logging in from a VPS)
2. **API Registration → Official Account API**: toggle ON
3. **Official Account → Permissions**: select all required permissions → Save
4. **Domain Verification**: serve the verification file or meta tag (use `oa listen --verify-domain <code>`)
5. **Webhook**: configure the HTTPS URL and toggle on the desired event subscriptions

### Ways to Expose the Webhook

| Method | Pros | Cons |
|------|----------|------------|
| **ngrok** | Fastest, single command | Singapore IP, URL changes on restart |
| **cloudflared** | Free, stable | Requires a Cloudflare account |
| **VPS** | Vietnam IP, stable | Requires managing a server |
| **n8n** | Visual workflow builder | Requires deploying n8n |

### With ngrok

```bash
# Terminal 1: listener
zalo-agent oa listen -p 3000 --no-verify --verify-domain <CODE>

# Terminal 2: tunnel
ngrok http 3000
```

### With a VPS (recommended for production)

```bash
# Install on VPS (requires Node.js 22+)
npm install -g @ardennguyen/zalo-agent-cli

# Login from VPS
zalo-agent oa login --app-id <ID> --secret <KEY> --callback-host https://your-vps.com

# Run listener
zalo-agent oa listen -p 3000 -s <SECRET>

# Keep alive with systemd or pm2
pm2 start "zalo-agent oa listen -p 3000 -s <SECRET>" --name zalo-oa
```

---

## Credentials

Saved at `~/.zalo-agent/oa-credentials.json` (mode `0600`, owner-readable only; overridable via `--oa-dir <dir>` or `ZALO_OA_DIR`).

> [!IMPORTANT]
> The default directory is `~/.zalo-agent/` — **with no `-cli` suffix**. Personal accounts use `~/.zalo-agent-cli/`. These two paths are completely separate: wiping one never affects the other, and `logout --purge` on a personal account never touches OA credentials.

```json
{
  "default": {
    "appId": "...",
    "secretKey": "...",
    "accessToken": "...",
    "refreshToken": "...",
    "expiresIn": 90000,
    "updatedAt": "2026-03-17T..."
  }
}
```

`expiresIn` is in seconds — `90000` ≈ **25 hours**. After expiry, OA commands fail with error `-216`. Renew anytime with `zalo-agent oa refresh` (uses the stored refresh token without opening a browser). For long-running listeners, schedule a cron job to refresh the token every ~12–24 hours:

```bash
0 */12 * * * zalo-agent oa refresh --oa-id default >/dev/null 2>&1
```

**Multi-OA:** Use `--oa-id` to manage multiple Official Accounts:

```bash
zalo-agent oa login --app-id <ID1> --secret <KEY1> --oa-id shop1
zalo-agent oa login --app-id <ID2> --secret <KEY2> --oa-id shop2
zalo-agent oa whoami --oa-id shop1
zalo-agent oa whoami --oa-id shop2
```

---

## Security

- Credentials file: `chmod 600` (owner-only)
- MAC verification: HMAC-SHA256 with timing-safe comparison
- Message type allowlist: `cs`, `transaction`, `promotion` only
- Webhook body size limit: 1 MB max
- OAuth callback: binds `127.0.0.1` (local) or `0.0.0.0` (VPS mode)
- No hardcoded secrets — all secrets come from CLI flags or the credential file

---

## Personal vs Official Account Comparison

| | `zalo-agent` (personal) | `zalo-agent oa` (official) |
|---|---|---|
| API | Unofficial (`zca-js`) | Official (Zalo OA API v3.0) |
| Auth | QR code login | OAuth 2.0 |
| Scope | Personal Zalo account | Official Account |
| Risk | Account can be banned | Safe — sanctioned official API |
| Features | Chat, friends, groups, polls, … | Messaging, followers, tags, articles, store, webhook |
| Credentials | `~/.zalo-agent-cli/` | `~/.zalo-agent/` (no `-cli` suffix) |
| Runtime disclaimer | Shown | Suppressed (official API) |
| Pre-command auto-login | Yes | No — `oa` manages its own OAuth token |
| Command count | 184 (of 216 total CLI commands) | 32 |
| Real-time events | WebSocket (`listen`) | HTTP Webhook (`oa listen`) |
| Exposed as MCP tools? | Yes — 25 tools (see [mcp-guide](../skill/references/mcp-guide.md)) | **No** — CLI only |

> [!NOTE]
> `oa` commands are **not** exposed as MCP tools. AI agents that need to act on an Official Account should invoke the CLI directly with `--json`, e.g., `zalo-agent --json oa msg text <uid> "..."`.

---

## Related Documentation

- [docs/official-account.vi.md](official-account.vi.md) — Vietnamese version of this guide
- [skill/references/oa-command-reference.md](../skill/references/oa-command-reference.md) — concise OA quick reference for AI agents
- [skill/references/command-reference.md](../skill/references/command-reference.md) — exhaustive CLI reference (source of truth)
- [INSTALLATION.md](../INSTALLATION.md) / [INSTALLATION.vi.md](../INSTALLATION.vi.md) — installation, MCP client setup, and OA configuration
- [Wiki: Official Account](https://github.com/ardennguyen/zalo-agent-cli/wiki/Official-Account)
