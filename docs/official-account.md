# Zalo Official Account (OA) and ZBS

[Tiếng Việt](official-account.vi.md)

Manage a Zalo Official Account through Zalo's official APIs — the OA OpenAPI (v2.0/v3.0) with `oa …`, and ZBS Template Message with `zbs …` — completely independent from personal Zalo accounts (the unofficial API). Both groups use the same OA login.

> **Note:** Several OA APIs require a verified OA or a paid OA package. See [zalo.cloud/oa/pricing](https://zalo.cloud/oa/pricing).

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

# Login + ngrok tunnel, checking event signatures
zalo-agent oa init --app-id <APP_ID> --secret <SECRET> --tunnel ngrok -p 3000 --oa-secret <OA_SECRET_KEY>

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

There are **94 commands**: 70 in the `oa` group, 18 in the `zbs` group and 6 in the `social` group ([Social API](#social-api-social)). Every command accepts `--oa-id <id>` (default `default`) for managing multiple OAs, and `--json` for machine-readable output. Every option and default is in [`skill/references/oa-command-reference.md`](../skill/references/oa-command-reference.md); this page shows the shape of each area.

### Setup & Auth

| Command | Description |
|---------|-------------|
| `oa init [flags]` | Guided setup wizard (interactive + non-interactive) — see flag table below |
| `oa login --app-id <id> --secret <key> [-p, --port <port>]` | OAuth v4 login with PKCE (`code_challenge` + `state`; the code is exchanged with its `code_verifier`). Opens the browser; the callback server listens on `127.0.0.1:<port>`, default port `3456`. 2-minute timeout |
| `oa login ... --callback-host <url>` | Headless VPS OAuth login — binds `0.0.0.0`, skips opening a browser, and prints the auth URL to open on a local machine |
| `oa refresh` | Refresh the access token using the saved refresh token. Zalo makes the refresh token single use, so the refresh is serialized under a file lock and the new pair saved before use |
| `oa setup <access-token>` | Set an access token manually (bypassing OAuth; no refresh possible) |
| `oa whoami` | View the OA's profile: name, ID, description, verification, type, category, followers, package (valid-through date), linked Zalo Cloud Account. The package and verification decide which APIs work (`-224`: package too low; `-221`: the OA must be verified) |

#### `oa init` flags

The wizard automatically switches to **agent (non-interactive) mode** whenever `--app-id` is passed.

| Flag | Default | Description |
|------|---------|-------------|
| `--app-id <id>` | — | Zalo App ID (triggers non-interactive mode) |
| `--secret <key>` | — | Zalo App Secret Key |
| `--oa-id <id>` | `default` | OA identifier for multi-OA setups |
| `--tunnel <type>` | `ngrok` (agent mode) | `ngrok` \| `cloudflared` \| `none` |
| `--webhook-url <url>` | — | Use an existing webhook URL (VPS, n8n, …) instead of starting a tunnel |
| `--verify-file <path>` | — | Domain verification: the HTML file downloaded from Zalo, served unchanged by the wizard's listener |
| `--verify-meta <tag>` | — | Domain verification: the `<meta …>` tag Zalo shows, pasted whole |
| `--oa-secret <key>` | — | OA Secret Key (the app's Webhook settings): the wizard's listener checks each event's signature |
| `-p, --port <port>` | `3000` | Local webhook listener port |
| `--skip-webhook` | `false` | Skip webhook setup completely |
| `--skip-login` | `false` | Skip OAuth login (reuse an already-saved token) |

The wizard runs through 5 steps: (1) save app-id/secret → (2) OAuth login + profile check → (3) prerequisite checklist at `developers.zalo.me` (interactive mode only) → (4) expose webhook → (5) print summary table (or JSON when `--json` is passed).

### Messaging

`oa msg` sends consultation (CS) messages only. Zalo stopped transaction and promotion messages on the OA API on 01/03/2026: send those as ZBS template messages (`zbs send`, `zbs uid`, below).

```bash
# Text (≤ 2000 characters), optionally quoting a message
zalo-agent oa msg text <user-id> "Message content" [--quote <message-id>]

# Image (jpg/png ≤ 1 MB) by URL, attachment_id, or a local file uploaded first
zalo-agent oa msg image <user-id> --url https://... [--caption "..."]
zalo-agent oa msg image <user-id> --file ./photo.jpg

# GIF, file, sticker
zalo-agent oa msg gif <user-id> --file ./anim.gif --width 320 --height 240
zalo-agent oa msg file <user-id> --file ./document.pdf
zalo-agent oa msg sticker <user-id> <sticker-id>

# Ask a follower to share their information
zalo-agent oa msg request-info <user-id> --title "..." --subtitle "..." --image-url https://...

# React to a message (like, heart, remove, or the documented codes)
zalo-agent oa msg react <user-id> <message-id> like

# Message an anonymous user, in the conversation from their webhook event
zalo-agent oa msg anonymous <anonymous-id> --conversation <conversation-id> --text "..."

# A user's last interaction and remaining messages; the OA's quota
zalo-agent oa msg user-quota <user-id>
zalo-agent oa quota
```

### Media Upload

Zalo keeps uploads 7 days and allows 5000 upload requests a month.

```bash
zalo-agent oa upload image ./photo.jpg    # jpg/png ≤ 1 MB → attachment_id
zalo-agent oa upload file ./document.pdf  # PDF/DOC/DOCX/CSV ≤ 5 MB → token
zalo-agent oa upload gif ./anim.gif       # GIF ≤ 5 MB → attachment_id
```

### Conversations

```bash
zalo-agent oa conv recent [--offset 0] [--count 10] [--all]
zalo-agent oa conv history <user-id> [--offset 0] [--count 10] [--all]
```

At most 10 messages per request; `--all` walks every page (`--max <n>` stops early).

### Users, user fields, tags

```bash
zalo-agent oa follower list [--count 50] [--tag <name>] [--last-interaction L7D] [--followers-only] [--all]
zalo-agent oa follower info <user-id>

# Update what the OA stores about a user: shared_info fields by name, plus alias and external id
zalo-agent oa follower update <user-id> --name "Nguyen Van A" --phone 0901234567 --alias "VIP"
zalo-agent oa follower update <user-id> --data '{"shared_info":{"address":"..."},"user_external_id":"crm-42"}'

zalo-agent oa follower custom-info <user-id>
zalo-agent oa follower custom-update <user-id> '{"custom_info":{"tier":"gold"}}'
zalo-agent oa follower delete-info <user-id> --yes

zalo-agent oa userfield list
zalo-agent oa userfield create <key> <name> --type text
zalo-agent oa userfield delete <key> --yes

zalo-agent oa tag list
zalo-agent oa tag assign <user-id> <tag-name>
zalo-agent oa tag untag <user-id> <tag-name>
zalo-agent oa tag remove <tag-name> --yes
```

`follower list` returns user ids (50 a page, at most 10,000 users); `follower info` gives one user's details.

### Zalo Ads forms, purchases

```bash
zalo-agent oa form get <form-id> --from 2026-11-01 --to 2026-11-13
zalo-agent oa purchase create-order --product-id <id>               # price + one-time token, nothing charged yet
zalo-agent oa purchase confirm-order <order-id> <verified-token> --yes   # pays (within 5 minutes)
```

### Articles

```bash
zalo-agent oa article create @article.json          # waits until Zalo gives the article id (--no-wait: the token)
zalo-agent oa article verify <token>
zalo-agent oa article update <article-id> @article.json
zalo-agent oa article list [--type normal|video] [--all]
zalo-agent oa article detail <article-id>
zalo-agent oa article remove <article-id> --yes
zalo-agent oa article video-upload ./clip.mp4 --wait
zalo-agent oa article video-status <token>
```

### Group chats (GMF) and voice calls

```bash
zalo-agent oa group quota                                    # asset ids
zalo-agent oa group create "Support" --asset-id <id> --members <user-id>,<user-id>
zalo-agent oa group send <group-id> "Hello [@<user-id>]"
zalo-agent oa group members <group-id> --all
zalo-agent oa group remove-members <group-id> <user-ids> --yes
zalo-agent oa group delete <group-id> --yes

zalo-agent oa call consent-request 0901234567 --reason 101 --yes   # charged per request
zalo-agent oa call consent-check 0901234567
zalo-agent oa call outbound <user-id> --agent <agent-id>
zalo-agent oa call mcc-info
```

`oa group` also has `info`, `update`, `avatar`, `update-asset`, `invite`, `pending`, `accept`, `reject`, `add-admins`, `remove-admins`, `list`, `recent` and `history`; `oa call` also has `inbound`. Group chats need a verified OA on the Advanced or Premium package.

### ZBS Template Message

Template messages by phone number or user id, with the OA's token (`oa login` first).

```bash
zalo-agent zbs template list [--status enable] [--all]
zalo-agent zbs template detail <template-id>
zalo-agent zbs template sample <template-id>          # a template_data to start from
zalo-agent zbs template create template.json          # checked locally against Zalo's rules first
zalo-agent zbs upload-image ./logo.png --kind logo

zalo-agent zbs send 0901234567 <template-id> '{"customer_name":"A","order_code":"X1"}'
zalo-agent zbs send 84901234567 <template-id> data.json --hash-phone
zalo-agent zbs send 0901234567 <template-id> data.json --dev          # test send to the OA's admins
zalo-agent zbs send 0901234567 <template-id> data.json --rsa          # encrypted with the OA's RSA key
zalo-agent zbs uid <user-id> <template-id> data.json

zalo-agent zbs status <message-id>
zalo-agent zbs quota
zalo-agent zbs quality
```

`zbs` also has `template update|rating|quick-reply`, `rsa-key create|get` and `journey token|check|send`. Each area needs a permission the OA grants the app: templates and `upload-image` need *manage message templates* (create, update and uploads also *asset management*); sends by phone number, RSA keys, journeys, status, quota and quality need *send messages by phone number*; `zbs uid` needs the OA *send messages* permission.

### Guarded commands

`oa follower delete-info`, `oa userfield delete`, `oa tag remove`, `oa purchase confirm-order`, `oa call consent-request` (each request is charged), `oa article remove`, `oa group remove-members` and `oa group delete` send nothing without `-y, --yes` (they exit 2); `--dry-run` says what would happen. A JSON argument or option (`--data`, `<json>`, an article, a template, `template_data`) is inline JSON (starting with `{` or `[`), `@file`, or the path of a JSON file.

### Webhook Listener

```bash
# Basic
zalo-agent oa listen -p 3000

# With signature verification
zalo-agent oa listen -p 3000 -s <OA_SECRET_KEY>

# Filter events
zalo-agent oa listen -e user_send_text,follow

# Custom webhook URL path (default /webhook)
zalo-agent oa listen -p 3000 --path /zalo

# Domain verification
zalo-agent oa listen -p 3000 --verify-file zalo_verifierXXXX.html   # the file Zalo gives
zalo-agent oa listen -p 3000 --verify-meta '<meta …>'              # or the tag Zalo shows

# JSON output (pipe)
zalo-agent --json oa listen | while read -r event; do
  echo "$event" | jq '.message.text'
done
```

| Flag | Default | Description |
|------|----------|--------|
| `-p, --port <port>` | `3000` | Listen port |
| `-s, --secret <key>` | — | OA Secret Key (the app's Webhook settings) for the `X-ZEvent-Signature` check. Warns if omitted |
| `--no-verify` | `false` | Skip the signature check even when a secret is provided (development only) |
| `-e, --events <list>` | `all` | Comma-separated list of event names to filter |
| `--path <path>` | `/webhook` | Webhook URL path |
| `--app-id <id>` | saved app id | Zalo App ID, to check events whose body has no `app_id` (`extension_purchased`, `change_template_quality`, `change_oa_daily_quota`) |
| `--verify-file <path>` | — | Domain verification: the HTML file downloaded from Zalo's "Xác thực domain" page, served unchanged at its own name |
| `--verify-meta <tag>` | — | Domain verification: the `<meta …>` tag Zalo shows, pasted whole, served in the home page's head |

**Signature:** as Zalo's OA webhook docs give it, each event carries `X-ZEvent-Signature: mac=sha256(app_id + body + timestamp + OA secret key)` — a plain SHA-256 (hex) over the body's `app_id`, the raw body exactly as sent, the body's `timestamp` and the OA secret key, **not** an HMAC. The listener recomputes it, compares in constant time, and answers a bad or missing signature with 401.

**Events:** `--events` accepts every event name in Zalo's OA and ZBS docs: follow/unfollow, inbound messages (`user_send_*`, `user_click_chatnow`), message lifecycle (`user_seen_message`, `user_received_message`, `user_reacted_message`, `oa_reacted_message`), `oa_send_*` echoes, anonymous users, user management, widget, GMF group management and group messages, voice calls, `extension_purchased`, and ZBS events — see [`skill/references/oa-command-reference.md`](../skill/references/oa-command-reference.md) for the exhaustive list. Filtering on an undocumented name prints a warning at startup because that filter can never match. `follow`/`unfollow` events name the user by `follower.id`.

The listener caps request bodies at 1 MB. It **responds with `200 OK` immediately upon accepting an event** before printing it, because Zalo requires a 200 response within 2 seconds. When Zalo retries an event (`num_retry` header), the JSON output includes `_num_retry` and the printed line marks it as a redelivery so consumers do not process it as a brand-new event. A GET with `?hub.challenge=<x>` is echoed back: that is this listener's own convenience for tools that probe webhooks that way, not part of Zalo's webhook.

### Removed in 3.0.0

| Removed | Why | Use instead |
|---|---|---|
| `oa store …` | Zalo Shop is not in Zalo's current OA docs | — |
| `oa menu` | Zalo documents no menu API; the menu is set in the OA's management page | — |
| `oa msg list` | The list template exists only on the v2 message API, which Zalo shut down | `oa msg text`, `oa msg image`, … |
| `oa msg status` | It read ZBS phone-message status | `zbs status <message-id>` |
| `-m transaction` / `-m promotion` | Zalo stopped them on the OA API on 01/03/2026 | `zbs send` / `zbs uid` |

---

## Common Error Codes

A Zalo error prints as `OA API error <code>: <Zalo's message> (<what the code means>). <What to do>` (`ZBS API error <code>: …` for a ZBS endpoint) and the command exits 1. The meanings come from the error tables in Zalo's OA and ZBS docs; the full list the CLI knows is in the [reference](../skill/references/oa-command-reference.md#errors).

| Code | Meaning | Resolution |
|------|---------|-----|
| `-216` / `-220` | Access token is invalid / expired | Refreshed automatically once if a refresh token is stored; otherwise `zalo-agent oa refresh` or `oa login` |
| `-124` (ZBS) | Access token is invalid | As above |
| `-32` | Rate limit reached | Slow down and retry in the next minute |
| `-201` | A parameter is invalid | Check the request's parameters |
| `-213` | The user does not follow the OA | — |
| `-221` | The OA must be verified for this feature | Verify the OA |
| `-223` | The OA has not granted the app this API | Grant the permission in the app's OA settings |
| `-224` | The OA's package does not include this feature | Upgrade at [zalo.cloud/oa/pricing](https://zalo.cloud/oa/pricing) |
| `-230` | The user has not interacted with the OA in the past 7 days | The user must have followed the OA, messaged it, accepted a call from it, tapped Message or the call button on its profile, or tapped a menu item with an `oa.query` action; otherwise reach them with ZBS (`zbs uid` / `zbs send`) |
| `-240` | The v2 message API was shut down | Use the v3 API |
| `-135` (ZBS) | The OA may not send by phone number | Verify the OA / use a paid plan |
| `-144` (ZBS) | The OA's daily quota for phone-number messages is used up | `zbs quota` |
| `http_<status>` | The endpoint answered a non-2xx status or a non-JSON body (e.g. `HTTP 404 (no such endpoint)`) | — |

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
3. **Official Account → Permissions**: select the permissions the commands need (including the ZBS groups for `zbs`) → Save
4. **Domain Verification**: add the DNS TXT record, or serve what Zalo gives (`oa listen --verify-file <file>` or `--verify-meta '<meta …>'`)
5. **Webhook**: configure the HTTPS URL, toggle on the desired event subscriptions, and copy the OA Secret Key for `oa listen -s`

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
zalo-agent oa listen -p 3000 -s <OA_SECRET_KEY> --verify-file zalo_verifierXXXX.html

# Terminal 2: tunnel
ngrok http 3000
```

### With a VPS (recommended for production)

```bash
# Install on VPS (requires Node.js 22.19+)
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

Saved at `~/.zalo-agent/oa-credentials.json` (mode `0600`, owner-readable only, written atomically under a lock; overridable via `--oa-dir <dir>` or `ZALO_OA_DIR`). `oa` and `zbs` read the same file.

> [!IMPORTANT]
> The default directory is `~/.zalo-agent/` — **with no `-cli` suffix**. Personal accounts use `~/.zalo-agent-cli/`. These two paths are completely separate: wiping one never affects the other, and `logout --purge` on a personal account never touches OA credentials.

```json
{
  "default": {
    "appId": "...",
    "secretKey": "...",
    "accessToken": "...",
    "refreshToken": "...",
    "expiresIn": "90000",
    "expiresAt": "2026-11-14T...",
    "updatedAt": "2026-11-13T..."
  }
}
```

`expiresIn` is in seconds — `90000` ≈ **25 hours**; `expiresAt` is when the token stops working. After expiry a call answers `-216`/`-220`, and the CLI refreshes the token once with the stored refresh token and retries. You can also renew anytime with `zalo-agent oa refresh` (no browser). The refresh token itself lasts 3 months and is single use, so a token that is never used for 3 months needs a new `oa login`. For long-running listeners that make no calls, a cron refresh keeps the pair fresh:

```bash
0 */12 * * * zalo-agent oa refresh --oa-id default >/dev/null 2>&1
```

**Multi-OA:** Use `--oa-id` to manage multiple Official Accounts:

```bash
zalo-agent oa login --app-id <ID1> --secret <KEY1> --oa-id shop1
zalo-agent oa login --app-id <ID2> --secret <KEY2> --oa-id shop2
zalo-agent oa whoami --oa-id shop1
zalo-agent zbs quota --oa-id shop2
```

---

## Security

- Credentials file: `chmod 600` (owner-only)
- Access token sent in the `access_token` header, never in the URL
- Webhook signature: `sha256(app_id + body + timestamp + OA secret key)` per Zalo's docs, compared in constant time
- Destructive and paying commands need `--yes`
- Webhook body size limit: 1 MB max
- OAuth: PKCE with `state`; the callback binds `127.0.0.1` (local) or `0.0.0.0` (VPS mode)
- No hardcoded secrets — all secrets come from CLI flags or the credential file
- Not sealed: the at-rest encryption 3.0 brought to the personal account's files ([security.md](security.md)) does not cover `oa-credentials.json`. Keep the OA directory on an encrypted disk and readable by the service account only.

---

## Social API (`social`)

A Zalo user logs in to **your app** and the app reads that user's app-scoped ID, name and avatar (Zalo's Social API: OAuth v4 with PKCE and `state`, then `graph.zalo.me`). Independent from the personal account and from the OA: its own app login per `--profile` (default `default`) in `~/.zalo-agent/social-credentials.json` (0600). The app's callback URL (developers.zalo.me → the app → Đăng nhập → Web) must be `http://localhost:<port>/callback` or `<callback-host>/callback`. Every call carries `appsecret_proof`. The access token lasts 1 hour and renews itself (once, on error 452, serialized); the login lasts at most 30 days, because a refreshed token keeps what was left of the one it replaced. A Zalo error prints `Social API error <code>: <message> (<meaning from the Social docs' table>)`; `-501` means the call came from an IP outside Vietnam. Not an MCP tool.

```bash
zalo-agent social setup --app-id <app-id> --secret <app-secret>
zalo-agent social login --dpop          # opens the browser; waits on http://localhost:3457/callback
zalo-agent social me --picture large
zalo-agent social status
```

| Command | Description |
|---------|-------------|
| `setup --app-id <id> --secret <key> [--profile <name>]` | Save the app's ID and secret key. |
| `login [--app-id <id>] [--secret <key>] [-p, --port <port>] [--callback-host <host>] [--dpop] [--profile <name>]` | Open Zalo's permission page (`oauth.zaloapp.com/v4/permission`, PKCE and `state`), wait for the callback on 127.0.0.1 (0.0.0.0 with `--callback-host`), check `state`, exchange the code with the verifier, save the tokens, then show the user. Port default 3457. `--dpop` binds the tokens to a new P-256 key pair (DPoP, ES256): every later call and refresh carries a proof signed with it, so a stolen token is useless on its own. |
| `refresh [--profile <name>]` | Renew the access token now (the refresh token is single use; serialized under a lock). Refused, with nothing sent, once the 30-day login ended. |
| `me [--fields <list>] [--picture small\|normal\|large] [--profile <name>]` | `GET graph.zalo.me/v2.0/me`: `id` (this app's ID for the user, not usable by other apps), `name`, `picture` (smallest unless `--picture`), and `is_sensitive` when asked (a user the law requires special handling for). Other fields are refused before any request. |
| `status [--profile <name>]` | Whether a user is logged in, when the access token and the login end, DPoP on or off. Never shows a token. |
| `logout [--profile <name>]` | Forget the user's tokens and DPoP key on this machine; the app's ID and secret stay. |

---

## Personal vs Official Account Comparison

| | `zalo-agent` (personal) | `zalo-agent oa` / `zbs` (official) |
|---|---|---|
| API | Unofficial (Zalo's own protocol) | Official (Zalo OA API v2.0/v3.0, ZBS) |
| Auth | QR code login | OAuth 2.0 (v4, PKCE) |
| Scope | Personal Zalo account | Official Account |
| Risk | Account can be banned | Safe — sanctioned official API |
| Features | Chat, friends, groups, polls, … | CS messages, users, tags, articles, group chats, calls, template messages, webhook |
| Credentials | `~/.zalo-agent-cli/` | `~/.zalo-agent/` (no `-cli` suffix) |
| Runtime disclaimer | Shown | Suppressed (official API) |
| Pre-command auto-login | Yes | No — `oa` manages its own OAuth token |
| Command count | 227 (of 321 total CLI commands) | 94 (70 `oa` + 18 `zbs` + 6 `social`) |
| Real-time events | WebSocket (`listen`) | HTTP Webhook (`oa listen`) |
| Exposed as MCP tools? | Yes — 36 tools (see [mcp-guide](../skill/references/mcp-guide.md)) | **No** — CLI only |

> [!NOTE]
> `oa` and `zbs` commands are **not** exposed as MCP tools. AI agents that need to act on an Official Account should invoke the CLI directly with `--json`, e.g., `zalo-agent --json oa msg text <uid> "..."`.

---

## Related Documentation

- [docs/official-account.vi.md](official-account.vi.md) — Vietnamese version of this guide
- [skill/references/oa-command-reference.md](../skill/references/oa-command-reference.md) — every `oa` and `zbs` option, the webhook events, the error codes
- [skill/references/command-reference.md](../skill/references/command-reference.md) — exhaustive CLI reference (source of truth)
- [INSTALLATION.md](../INSTALLATION.md) / [INSTALLATION.vi.md](../INSTALLATION.vi.md) — installation, MCP client setup, and OA configuration
- [Wiki: Official Account](https://github.com/ardennguyen/zalo-agent-cli/wiki/Official-Account)
