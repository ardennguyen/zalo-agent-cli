# Official Account (OA) Command Reference

Zalo OA API v3.0 — official API, separate from personal account. **32 commands.**

- Every `oa` command accepts `--oa-id <id>` (default `"default"`) for multi-OA, and `--json`.
- `oa` commands skip the unofficial-API disclaimer and skip the personal-account auto-login — they manage their own OAuth token.
- Credentials live in `~/.zalo-agent/oa-credentials.json` — a **different directory** from the personal account's `~/.zalo-agent-cli/`.
- **No OA command is exposed as an MCP tool.** Agents connected over MCP must shell out: `zalo-agent --json oa <command>`.

## Setup

```bash
# Interactive wizard (human)
zalo-agent oa init

# Non-interactive (AI agent / CI)
zalo-agent oa init --app-id <ID> --secret <KEY> --skip-webhook
zalo-agent oa init --app-id <ID> --secret <KEY> --tunnel ngrok -p 3000
zalo-agent oa init --app-id <ID> --secret <KEY> --webhook-url https://server.com/webhook

# Manual login
zalo-agent oa login --app-id <ID> --secret <KEY>

# VPS login (headless — binds 0.0.0.0, prints auth URL)
zalo-agent oa login --app-id <ID> --secret <KEY> --callback-host https://vps.com

# Refresh token (~25h expiry)
zalo-agent oa refresh

# Manual token set
zalo-agent oa setup <access-token>

# Check connection
zalo-agent oa whoami
```

### `oa init` flags

The wizard switches to **agent (non-interactive) mode** as soon as `--app-id` is present.

| Flag | Default | Description |
|------|---------|-------------|
| `--app-id <id>` | — | Zalo App ID (triggers non-interactive mode) |
| `--secret <key>` | — | Zalo App Secret Key |
| `--oa-id <id>` | `default` | OA identifier for multi-OA |
| `--tunnel <type>` | `ngrok` (agent mode) | `ngrok` \| `cloudflared` \| `none` |
| `--webhook-url <url>` | — | Save an existing webhook URL (VPS, n8n) instead of creating a tunnel |
| `--verify-code <code>` | — | Zalo domain verification code |
| `-p, --port <port>` | `3000` | Local webhook listener port |
| `--skip-webhook` | `false` | Skip webhook setup entirely |
| `--skip-login` | `false` | Skip OAuth (use an already-saved token) |

### `oa login` flags

| Flag | Default | Description |
|------|---------|-------------|
| `--app-id <id>` / `--secret <key>` | — | App credentials |
| `-p, --port <port>` | `3456` | Local OAuth callback server port |
| `--callback-host <url>` | — | VPS mode: bind `0.0.0.0`, don't auto-open a browser, use this host in the redirect URI |
| `--oa-id <id>` | `default` | OA identifier |

OAuth times out after 2 minutes.

## Messaging

Message types: `cs` (customer service), `transaction`, `promotion`.

```bash
zalo-agent oa msg text <user-id> "message" [-m cs]
zalo-agent oa msg image <user-id> --image-url https://...
zalo-agent oa msg image <user-id> --image-id <attachment_id>
zalo-agent oa msg file <user-id> <file-token>
zalo-agent oa msg list <user-id> '[{"title":"A","subtitle":"B"}]'
zalo-agent oa msg status <message-id>
```

## Followers

```bash
zalo-agent oa follower list [--offset 0] [--count 50]
zalo-agent oa follower info <user-id>
zalo-agent oa follower update <user-id> '{"name":"...","phone":"..."}'
```

## Tags

```bash
zalo-agent oa tag list
zalo-agent oa tag assign <user-id> <tag-name>
zalo-agent oa tag remove <tag-name>
zalo-agent oa tag untag <user-id> <tag-name>
```

## Media Upload

```bash
zalo-agent oa upload image ./photo.jpg   # Returns attachment_id
zalo-agent oa upload file ./doc.pdf      # Returns file token
```

## Conversations

```bash
zalo-agent oa conv recent [--offset 0] [--count 10]
zalo-agent oa conv history <user-id> [--offset 0] [--count 10]
```

## Webhook Listener

```bash
zalo-agent oa listen -p 3000                           # Basic
zalo-agent oa listen -p 3000 -s <OA_SECRET>            # MAC verify
zalo-agent oa listen -e user_send_text,follow           # Filter events
zalo-agent oa listen --path /zalo                       # Change webhook path (default /webhook)
zalo-agent oa listen --verify-domain <CODE>             # Domain verification
zalo-agent oa listen --no-verify                        # Skip MAC (dev)
zalo-agent --json oa listen                             # JSON pipe
```

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <port>` | `3000` | Listen port |
| `-s, --secret <key>` | — | OA Secret Key for HMAC-SHA256 MAC verification (timing-safe compare). Warns if absent |
| `--no-verify` | `false` | Disable MAC verification even with a secret set (dev only) |
| `-e, --events <list>` | `all` | Comma-separated event filter |
| `--path <path>` | `/webhook` | Webhook URL path |
| `--verify-domain <code>` | — | Serve `/zalo_verifier<code>.html` for domain verification |

Events: follow, unfollow, user_send_text, user_send_image, user_send_file, user_send_location, user_send_sticker, user_send_gif, user_click_button, user_click_link

Zalo's `hub.challenge` GET verification is answered automatically. Request bodies are capped at 1MB.

## Menu, Articles, Store

```bash
zalo-agent oa menu '{"buttons":[...]}'                        # Update the OA chat menu

zalo-agent oa article create '{"title":"..."}'                 # Create/broadcast an article
zalo-agent oa article list [--offset 0] [--limit 10]           # List articles
zalo-agent oa article detail <article-id>                      # Article details/status

zalo-agent oa store product-create '{"name":"..."}'            # Create a product
zalo-agent oa store product-list [--offset 0] [--limit 10]     # List products
zalo-agent oa store product-info <product-id>                  # Product details
zalo-agent oa store category-create '{"name":"..."}'           # Create a category
zalo-agent oa store category-list                              # List categories
zalo-agent oa store order-create '{"...":"..."}'               # Create an order
```

## Multi-OA

```bash
zalo-agent oa login --app-id <ID1> --secret <K1> --oa-id shop1
zalo-agent oa login --app-id <ID2> --secret <K2> --oa-id shop2
zalo-agent oa whoami --oa-id shop1
zalo-agent oa msg text <uid> "Hi" --oa-id shop2
```

## Credentials

Stored: `~/.zalo-agent/oa-credentials.json` (chmod 600)

Contains: appId, secretKey, accessToken, refreshToken, expiresIn, webhookUrl, verifyCode

## Common Errors

| Code | Meaning | Fix |
|------|---------|-----|
| -216 | Invalid access token | `oa refresh` or `oa login` |
| -224 | OA tier too low | Upgrade at zalo.cloud/oa/pricing |
| -14029 | App not approved | Verify app at developers.zalo.me |

## Webhook Setup Checklist

1. developers.zalo.me → Official Account → Callback URL: `http://localhost:3456/callback`
2. Đăng ký sử dụng API → Official Account API → toggle ON
3. Official Account → Chọn quyền → tick all → Lưu
4. Xác thực domain (serve verification file or meta tag)
5. Webhook → set HTTPS URL → bật events
