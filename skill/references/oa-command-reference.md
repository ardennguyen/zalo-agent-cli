# Official Account (OA) and ZBS Command Reference

Zalo's official APIs (OA OpenAPI v2.0/v3.0 and ZBS Template Message), separate from the personal account. **88 commands** (70 `oa` + 18 `zbs`).

- Every `oa` and `zbs` command accepts `--oa-id <id>` (default `default`) to pick which stored OA, and the global `--json`.
- `zbs` uses the same OA access token and credentials as `oa`: log in once with `oa login` (or `oa init`), then both work.
- `oa`/`zbs` commands skip the unofficial-API disclaimer and the personal-account auto-login — they manage their own OAuth token.
- Credentials live in `~/.zalo-agent/oa-credentials.json` — a **different directory** from the personal account's `~/.zalo-agent-cli/` (moved with the global `--oa-dir <dir>` or `ZALO_OA_DIR`).
- **No `oa` or `zbs` command is exposed as an MCP tool.** Agents connected over MCP shell out: `zalo-agent --json oa <command>` / `zalo-agent --json zbs <command>`.
- The access token goes in the `access_token` header, never the URL. An expired token (`-216`/`-220`, ZBS `-124`) is refreshed once with the stored refresh token (serialized under a file lock) and the call retried once.
- Documented limits (text length, upload type and size, page sizes) are checked before anything is sent.

## Guarded commands

These change or delete data on Zalo, or spend money. Without `-y, --yes` nothing is sent and the command exits 2; `--dry-run` says what would happen and sends nothing. A JSON argument or option (`--data`, `<json>`, an article, a template, `template_data`) is inline JSON (starting with `{` or `[`), `@file`, or the path of a JSON file.

| Command | What it does |
|---|---|
| `oa follower delete-info <user-id>` | Deletes what the OA stores about a user |
| `oa userfield delete <key>` | Deletes a custom field and every user's value in it |
| `oa tag remove <tag-name>` | Deletes a tag, untagging every user |
| `oa purchase confirm-order <order-id> <verified-token>` | Pays for an OA product ordered with `create-order` (the Zalo Cloud Account is charged); `create-order` itself charges nothing and is not guarded |
| `oa call consent-request <phone>` | Asks a user for permission to call; Zalo charges each request (440 VND per its OA docs) whatever the answer |
| `oa article remove <article-id>` | Deletes an article or video post |
| `oa group remove-members <group-id> <user-ids>` | Removes members from a group chat |
| `oa group delete <group-id>` | Dissolves a group chat for every member |

## Setup and login

```bash
# Interactive wizard (human)
zalo-agent oa init

# Non-interactive (AI agent / CI)
zalo-agent oa init --app-id <ID> --secret <KEY> --skip-webhook
zalo-agent oa init --app-id <ID> --secret <KEY> --tunnel ngrok -p 3000 --oa-secret <OA_SECRET>
zalo-agent oa init --app-id <ID> --secret <KEY> --webhook-url https://server.com/webhook

# Login (OAuth v4 with PKCE; opens the browser, waits on 127.0.0.1:3456)
zalo-agent oa login --app-id <ID> --secret <KEY>

# VPS login (headless — binds 0.0.0.0, prints the permission URL to open elsewhere)
zalo-agent oa login --app-id <ID> --secret <KEY> --callback-host https://vps.com

# Refresh the token (access token ~25 h; the refresh token is single use, 3 months)
zalo-agent oa refresh

# Set an access token by hand (no refresh possible afterwards)
zalo-agent oa setup <access-token>

# Check the connection
zalo-agent oa whoami
```

`oa login` sends a fresh PKCE `code_challenge` and a `state` with the permission URL, exchanges the code with its `code_verifier`, and saves the access token, refresh token, `expiresIn` and `expiresAt`. It times out after 2 minutes.

`oa refresh` uses the stored refresh token. Zalo makes a refresh token single use and stops the old access token at once, so the refresh runs under a file lock and the new pair is saved before anything uses it.

`oa whoami` prints the OA's name, id, alias, description, verification (`is_verified`), type (`oa_type`: 2 business, 4 government), category (`cate_name`), followers, package (`package_name`, valid through `package_valid_through_date`), auto-renew date and linked Zalo Cloud Account, when Zalo returns them. The package and verification decide which APIs answer: `-224` means the package does not include the feature, `-221` that the OA must be verified.

### `oa login` flags

| Flag | Default | Description |
|------|---------|-------------|
| `--app-id <id>` / `--secret <key>` | — | App credentials (from developers.zalo.me) |
| `-p, --port <port>` | `3456` | Local OAuth callback server port |
| `--callback-host <host>` | — | VPS mode: bind `0.0.0.0`, don't open a browser, use this public base in the redirect URI |
| `--oa-id <id>` | `default` | OA identifier |

### `oa init` flags

The wizard switches to **agent (non-interactive) mode** as soon as `--app-id` is present. It runs the same OAuth login as `oa login`.

| Flag | Default | Description |
|------|---------|-------------|
| `--app-id <id>` | — | Zalo App ID (triggers non-interactive mode) |
| `--secret <key>` | — | Zalo App Secret Key |
| `--oa-id <id>` | `default` | OA identifier for multi-OA |
| `--tunnel <type>` | `ngrok` (agent mode) | `ngrok` \| `cloudflared` \| `none` |
| `--webhook-url <url>` | — | Save an existing webhook URL (VPS, n8n) instead of creating a tunnel |
| `--verify-file <path>` | — | Domain verification: the HTML file downloaded from Zalo, served unchanged by the wizard's listener |
| `--verify-meta <tag>` | — | Domain verification: the `<meta …>` tag Zalo shows, pasted whole |
| `--oa-secret <key>` | — | OA Secret Key (the app's Webhook settings): the wizard's listener checks each event's signature |
| `-p, --port <port>` | `3000` | Local webhook listener port |
| `--skip-webhook` | `false` | Skip webhook setup entirely |
| `--skip-login` | `false` | Skip OAuth (use an already-saved token) |

## Messages (`oa msg`)

`oa msg` sends **consultation (CS) messages** only (`v3.0/oa/message/cs`). Zalo stopped transaction and promotion messages on the OA API on 01/03/2026; send those as ZBS template messages (`zbs send`, `zbs uid`). Text and captions are at most 2000 characters.

```bash
zalo-agent oa msg text <user-id> "message" [--quote <message-id>]
zalo-agent oa msg image <user-id> (--url <url> | --attachment-id <id> | --file <path>) [--caption <text>]
zalo-agent oa msg gif <user-id> (--url <url> | --attachment-id <id> | --file <path>) --width <px> --height <px> [--caption <text>]
zalo-agent oa msg file <user-id> (--token <token> | --file <path>)
zalo-agent oa msg sticker <user-id> <sticker-id>
zalo-agent oa msg request-info <user-id> --title <text> --subtitle <text> --image-url <url>
zalo-agent oa msg react <user-id> <message-id> <reaction>
zalo-agent oa msg anonymous <anonymous-id> --conversation <id> (--text <t> | --image <url|path> | --attachment-id <id> | --file <path> | --file-token <token> | --sticker <id>)
zalo-agent oa msg user-quota <user-id>
```

| Command | Notes |
|---|---|
| `text` | `--quote` replies quoting a message (a `message_id` from a webhook or `oa conv`) |
| `image` | jpg/png ≤ 1 MB; `--file` uploads first, then sends |
| `gif` | ≤ 5 MB; `--width`/`--height` are required by Zalo for a GIF |
| `file` | PDF/DOC/DOCX/CSV ≤ 5 MB; `--token` from `oa upload file` |
| `sticker` | Sticker id from stickers.zaloapp.com |
| `request-info` | The `request_user_info` template: title ≤ 100, subtitle ≤ 500 characters |
| `react` | `:>` `--b` `:-((` `/-strong` `/-heart` `:-h` `:o` `/-remove`, or the names `like`, `heart`, `remove` (`remove` takes the reaction back); at most 50 reactions per message |
| `anonymous` | An anonymous user, in the conversation from their webhook event; exactly one content option |
| `user-quota` | The user's last interaction with the OA and the messages left for them |

## Uploads (`oa upload`)

Zalo keeps uploads 7 days (`-100` after that) and allows 5000 upload requests a month.

```bash
zalo-agent oa upload image ./photo.jpg   # jpg/png ≤ 1 MB → attachment_id
zalo-agent oa upload file ./doc.pdf      # PDF/DOC/DOCX/CSV ≤ 5 MB → token
zalo-agent oa upload gif ./anim.gif      # GIF ≤ 5 MB → attachment_id
```

## Conversations and quota

```bash
zalo-agent oa conv recent [--offset 0] [--count 10] [--all [--max <n>]]
zalo-agent oa conv history <user-id> [--offset 0] [--count 10] [--all [--max <n>]]
zalo-agent oa quota [--owner OA|APP] [--product cs|transaction] [--type sub_quota|purchase_quota|reward_quota]
```

`--count` is 1–10 messages per request (offset 0 is the newest); `--all` walks every page from `--offset`, `--max` stops after that many messages. `oa quota` is the OA's message quota by owner (default `OA`), product and source.

## Users (`oa follower`, `oa userfield`, `oa tag`)

```bash
zalo-agent oa follower info <user-id>
zalo-agent oa follower list [--offset 0] [--count 50] [--tag <name>] [--last-interaction <period>] [--followers-only | --non-followers] [--all]
zalo-agent oa follower update <user-id> [--name <n>] [--phone <p>] [--address <a>] [--city-id <id>] [--district-id <id>] [--dob dd/MM/yyyy] [--alias <a>] [--external-id <id>] [--data <json>]
zalo-agent oa follower delete-info <user-id> --yes
zalo-agent oa follower custom-info <user-id> [--fields <keys>]
zalo-agent oa follower custom-update <user-id> '<json>'

zalo-agent oa userfield list [--type system|oa_custom] [--fields <keys>]
zalo-agent oa userfield create <key> <name> --type <data-type> [--description <t>] [--status active|inactive] [--format <f>] [--table-fields <json>]
zalo-agent oa userfield update <key> [--name <n>] [--description <t>] [--status <s>] [--format <f>] [--table-fields <json>]
zalo-agent oa userfield delete <key> --yes

zalo-agent oa tag list
zalo-agent oa tag assign <user-id> <tag-name>
zalo-agent oa tag untag <user-id> <tag-name>
zalo-agent oa tag remove <tag-name> --yes
```

- `follower list` returns user ids, 50 per page (`--count` 1–50), offset up to 9951 (at most 10,000 users); `--all` walks every page. `--last-interaction` takes `TODAY`, `YESTERDAY`, `L7D`, `L30D` or `YYYY_MM_DD:YYYY_MM_DD`. `follower info` gives a user's details.
- `follower update` sets the `shared_info` fields with named flags (`--name`, `--phone`, `--address`, `--city-id`, `--district-id`, `--dob` from 01/01/1970) plus `user_alias` (`--alias`) and `user_external_id` (`--external-id`, one user per id). `--data '{"shared_info":{"name":"..."},"user_alias":"..."}'` gives the body as JSON; flags override it.
- `follower custom-update` JSON fields: `name`, `phone`, `user_dob` (dd/MM/yyyy), `gender` (`Nam`|`Nữ`|`Khác`), `full_address {user_city_id, user_ward_id, user_address}`, `user_external_id`, `custom_info {<key>: value}`. Custom values come back as strings.
- `userfield create --type`: `boolean`, `number`, `text`, `datetime`, `table`, `email`, `phone`, `url`; the key and data type cannot change afterwards. `--format` (datetime): `dd/MM/yyyy`, `dd/MM/yyyy HH:mm:ss`, `dd-MM-yyyy`, `dd-MM-yyyy HH:mm:ss`, `yyyy-MM-dd`, `yyyy-MM-ddTHH:mm:ss`. A table has at most 5 columns; `update --table-fields` only adds columns. System fields cannot be deleted or deactivated.
- `tag assign` creates a tag that does not exist yet; `tag untag` removes it from one user; `tag remove` deletes it for everyone.

## Zalo Ads forms and purchases

```bash
zalo-agent oa form get <form-id> [--from <time>] [--to <time>] [--offset 0] [--limit 200] [--all]
zalo-agent oa purchase create-order (--product-id <id> | --redeem-code <code>) [--voucher <code>] [--beneficiary OA|APP]
zalo-agent oa purchase confirm-order <order-id> <verified-token> --yes
```

- `form get`: the form's questions and the responses in a window of at most 30 days (`--from`/`--to` as Unix seconds or a date such as 2026-11-01); `--limit` 1–200.
- `purchase create-order` charges nothing yet: it shows the price and the one-time `verified_token` that `confirm-order` needs within 5 minutes (orders can be created from 00:01 to 23:54). `--beneficiary` defaults to `OA`. Product ids are listed in Zalo's OA docs. `confirm-order` pays: the Zalo Cloud Account linked to the app is charged.

## Articles (`oa article`)

```bash
zalo-agent oa article create '<json>' | @article.json [--no-wait] [--timeout 60] [--interval 2]
zalo-agent oa article verify <token>
zalo-agent oa article update <article-id> '<json>' | @article.json [--no-wait] [--timeout 60] [--interval 2]
zalo-agent oa article remove <article-id> --yes
zalo-agent oa article list [--type normal|video] [--offset 0] [--limit 10] [--all]
zalo-agent oa article detail <article-id>
zalo-agent oa article video-upload <file> [--wait] [--timeout 300] [--interval 5]
zalo-agent oa article video-status <token>
```

- The body is the JSON Zalo's OA docs give, inline or `@file`. An article: `{"type":"normal","title":"…","author":"…","cover":{"cover_type":"photo","photo_url":"…","status":"show"},"description":"…","body":[{"type":"text","content":"…"}],"status":"show","comment":"show"}`; a video post: `{"type":"video","title":"…","description":"…","video_id":"…","avatar":"<image url>"}`. `update` takes the whole body again.
- `create`/`update` return a token and the CLI waits (`--timeout` seconds, checking every `--interval`) until `verify` resolves it to the article id; `--no-wait` prints the token at once (resolve it later with `oa article verify`, which fails while Zalo is still processing, `-214`).
- `video-upload`: mp4/avi ≤ 50 MB; prints the token for `video-status` (status 1 ready, 3 processing, 4 failed); `--wait` waits for the `video_id`.

## Group chats (`oa group`, GMF)

Verified OA on the Advanced or Premium package. Paging commands take `--offset` (default 0) and `--count` (default 5, Zalo's default); `list`, `members` and `pending` also take `--all`.

```bash
zalo-agent oa group quota [--owner OA|APP] [--product gmf10|gmf50|gmf100] [--quota-type sub_quota|purchase_quota|reward_quota]
zalo-agent oa group create <name> --asset-id <id> --members <user-ids> [--description <text>]
zalo-agent oa group info <group-id>
zalo-agent oa group update <group-id> [--name <n>] [--avatar <url>] [--description <t>] [--lock-send-msg on|off] [--join-approval on|off] [--msg-history on|off] [--link-join on|off]
zalo-agent oa group avatar <group-id> <image-url>
zalo-agent oa group update-asset <group-id> <asset-id>
zalo-agent oa group invite <group-id> <user-ids>
zalo-agent oa group pending <group-id>
zalo-agent oa group accept <group-id> <user-ids>
zalo-agent oa group reject <group-id> <user-ids>
zalo-agent oa group members <group-id>
zalo-agent oa group add-admins <group-id> <user-ids>
zalo-agent oa group remove-admins <group-id> <user-ids>
zalo-agent oa group remove-members <group-id> <user-ids> --yes
zalo-agent oa group delete <group-id> --yes
zalo-agent oa group list
zalo-agent oa group recent
zalo-agent oa group history <group-id>
zalo-agent oa group send <group-id> [text] [--mention <user-ids> | --mention-all] [--image-url <url> | --attachment-id <id> [--gif --width <px> --height <px>]] [--file-token <token>] [--sticker <id>]
```

- `<user-ids>` are comma-separated. `create --members`: 1–99 users, at least one an admin of the OA; the asset id comes from `oa group quota`. `invite` reaches followers, or users who interacted with the OA in the past 7 days.
- `send`: text by default; `--mention` (or `[@user_id]` in the text) and `--mention-all`; an image by `--image-url` (jpg/png ≤ 1 MB) or `--attachment-id` (text becomes the required caption); `--file-token` from `oa upload file`; `--sticker`.

## Voice calls (`oa call`)

```bash
zalo-agent oa call consent-request <phone> --reason <code> [--type audio|video|audio_and_video] --yes
zalo-agent oa call consent-check <phone>
zalo-agent oa call outbound <user-id> --agent <agent-id> [--type audio]
zalo-agent oa call inbound [--branch <branch-id>] [--agent <agent-id>] [--type audio]
zalo-agent oa call mcc-info
```

- `consent-request` asks a user, by phone number (e.g. `0901234567`), for permission to call: Zalo charges each request (440 VND), so it needs `--yes`; the user has 24 h to answer, an approval lasts 30 days. `--reason`: 101 product/service consultation, 103 order/appointment confirmation, 105 delivery notice, 106 flight notice, 107 order update.
- `outbound` / `inbound` return a call link and QR code (OA calls a user / a user calls the OA); `mcc-info` lists the call center's agents and branches. `--type` defaults to `audio`.

## ZBS Template Message (`zbs`)

Template messages by phone number (plain, hashed, development mode, RSA-encrypted, journey) or by user id, with the OA's token.

```bash
zalo-agent zbs template list [--status enable|pending|reject|disable] [--mine] [--offset 0] [--limit 100] [--all]
zalo-agent zbs template detail <template-id>
zalo-agent zbs template sample <template-id>
zalo-agent zbs template create '<json>' | template.json [--tracking-id <id>] [--no-check]
zalo-agent zbs template update <template-id> '<json>' | template.json [--tracking-id <id>] [--no-check]
zalo-agent zbs template rating <template-id> [--from <time>] [--to <time>] [--offset 0] [--limit 100] [--all]
zalo-agent zbs template quick-reply <template-id> [--from <time>] [--to <time>] [--limit 100]
zalo-agent zbs upload-image <file> [--kind logo|image]

zalo-agent zbs send <phone> <template-id> '<data-json>' [--tracking-id <id>] [--hash-phone | --dev | --rsa [--rsa-key <file>] [--encrypted] [--rsa-mgf1 sha1|sha256]] [--sending-mode 1|3]
zalo-agent zbs rsa-key create
zalo-agent zbs rsa-key get
zalo-agent zbs journey token <phone> [--type token_logistics_7|token_logistics_30|token_coach_bus_7|token_coach_bus_30]
zalo-agent zbs journey check <journey-token>
zalo-agent zbs journey send <phone> <template-id> '<data-json>' --token <journey-token>
zalo-agent zbs uid <user-id> <template-id> '<data-json>'
zalo-agent zbs status <message-id> [--phone <phone>]
zalo-agent zbs quota
zalo-agent zbs quality
```

- **Templates.** `list` is newest first, up to 100 per request; `--mine` keeps only templates created by this app. `detail` shows status, tag, quality, prices, params and buttons; `sample` gives the params with sample values (a `template_data` to start from). `create` takes `template_name`, `template_type`, `tag`, `layout`, `params`, `note` (inline JSON or a file path) and is checked locally against Zalo's template rules first (`--no-check` skips that); `update` edits a template in REJECT status and sends it back to review. Create and update together: 100 a day. `rating` reads the ratings left through a service-rating template; `quick-reply` the answers given through a quick-response template (`--from`/`--to` in milliseconds or a date; `--to` defaults to now).
- **`upload-image`**: a template image or logo, JPG/PNG ≤ 500 KB (5,000 a month per app), returns `media_id`; `--kind logo` also checks PNG 400×96 px, `--kind image` 16:9.
- **`send`**: `<phone>` as `84901234567` or `0901234567`; `<data-json>` is `template_data`, inline or a file path; `--tracking-id` (≤ 48 letters, digits, `_`, `-`) is generated when absent. Modes: plain (default); `--hash-phone` sends the SHA-256 of the number (or pass a 64-hex digest as `<phone>`); `--dev` is development mode (a test send, only to the app's or OA's admins); `--rsa` encrypts the number and every `template_data` value with the OA's RSA public key (`--rsa-key` file, Base64 or PEM; default: fetched from Zalo), `--encrypted` when they are already ciphertexts, `--rsa-mgf1` the OAEP MGF1 digest (default `sha1`). `--sending-mode 3` (over quota) is for whitelisted OAs and tag-3 templates only; plain mode only.
- **`rsa-key`**: `create` makes the OA's key pair (Zalo keeps the private key; fails if one exists, `-143`), `get` prints the public key.
- **`journey`**: logistics / coach-bus journeys. `token` creates a token per recipient and journey (Zalo must enable journeys for the OA first; Zalo's default type is `token_logistics_7`); `check` shows its type, creation and expiry; `send` sends a journey template with it (token and template must be the same type).
- **`uid`**: a template message to a user id of the OA (custom, rating, payment-request and voucher templates created since 10/12/2025).
- **`status`**, **`quota`**, **`quality`**: a phone-number message's delivery status; the OA's daily and monthly-promotion quota for phone-number messages; the OA's sending quality over the last 48 hours and 7 days.

### Permissions each ZBS area needs

The OA grants the app these permission groups (the app's Official Account permission settings on developers.zalo.me):

| Area | Permission group |
|---|---|
| `zbs template …`, `zbs upload-image` | Manage message templates (create, update and `upload-image` also need asset management) |
| `zbs send`, `zbs rsa-key …`, `zbs journey …`, `zbs status`, `zbs quota`, `zbs quality` | Send messages by phone number |
| `zbs uid` | Send messages (the OA messaging permission) |
| ZBS webhook events in `oa listen` | Receive phone-number sending events; receive message-template events; receive UID sending events |

## Webhook listener (`oa listen`)

```bash
zalo-agent oa listen -p 3000 -s <OA_SECRET_KEY>          # Check signatures (recommended)
zalo-agent oa listen -e user_send_text,follow             # Filter events
zalo-agent oa listen --path /zalo                         # Change the webhook path (default /webhook)
zalo-agent oa listen --verify-file zalo_verifierXXXX.html  # Domain verification: the file Zalo gives
zalo-agent oa listen --verify-meta '<meta …>'             # …or the meta tag Zalo shows
zalo-agent oa listen --no-verify                          # Skip the signature check (dev)
zalo-agent --json oa listen                               # One JSON event per line
```

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <port>` | `3000` | Listen port |
| `-s, --secret <key>` | — | OA Secret Key (the app's Webhook settings) for the `X-ZEvent-Signature` check. Warns if absent |
| `--no-verify` | `false` | Skip the signature check even with a secret set (dev only) |
| `-e, --events <list>` | `all` | Comma-separated event filter |
| `--path <path>` | `/webhook` | Webhook URL path |
| `--app-id <id>` | saved app id | Zalo App ID, to check events whose body has no `app_id` (`extension_purchased`, `change_template_quality`, `change_oa_daily_quota`) |
| `--verify-file <path>` | — | Domain verification: the HTML file downloaded from Zalo's "Xác thực domain" page, served unchanged at its own name |
| `--verify-meta <tag>` | — | Domain verification: the `<meta …>` tag Zalo shows, pasted whole, served in the home page's head |

**Signature.** As Zalo's OA webhook docs give it, each event carries `X-ZEvent-Signature: mac=sha256(app_id + body + timestamp + OA secret key)`: a plain SHA-256 in hex over the concatenation of the body's `app_id`, the raw request body exactly as sent, the body's `timestamp` and the OA secret key — **not** an HMAC. The listener recomputes it and compares in constant time; a missing, malformed or wrong signature is answered 401 and printed as a rejected event. The three documented events whose body has no `app_id` (`extension_purchased`, `change_template_quality`, `change_oa_daily_quota`) are checked with the app id from `--app-id`, or else the one `oa setup`/`oa init` saved.

Events `--events` accepts (every name Zalo's OA and ZBS docs give; filtering on any other name prints a warning at start, since that filter can never match):

- Follow and inbound: `follow`, `unfollow`, `user_send_text`, `user_send_image`, `user_send_file`, `user_send_audio`, `user_send_video`, `user_send_sticker`, `user_send_link`, `user_send_business_card`, `user_send_location`, `user_click_chatnow`
- Message lifecycle: `user_seen_message`, `user_received_message`, `user_reacted_message`, `oa_reacted_message`
- Outbound echo: `oa_send_text`, `oa_send_image`, `oa_send_file`, `oa_send_sticker`, `oa_send_gif`, `oa_send_list`
- Anonymous users: `anonymous_send_text`, `anonymous_send_image`, `anonymous_send_file`, `anonymous_send_sticker`, `oa_send_anonymous_text`, `oa_send_anonymous_image`, `oa_send_anonymous_file`, `oa_send_anonymous_sticker`
- User management: `update_user_info`, `user_submit_info`, `add_user_to_tag`, `remove_user_from_tag`, `remove_tag`, `user_withdraw`
- Widget: `widget_interaction_accepted`, `widget_failed_to_sync_user_external_id`
- GMF group management: `create_group`, `delete_group`, `update_group_info`, `add_group_admin`, `remove_group_admin`, `user_join_group`, `user_out_group`, `user_request_join_group`, `accept_request_join_group`, `reject_request_join_group`
- GMF group messages: `user_send_group_text`, `user_send_group_image`, `user_send_group_link`, `user_send_group_audio`, `user_send_group_video`, `user_send_group_business_card`, `user_send_group_sticker`, `user_send_group_gif`, `user_send_group_file`, `oa_send_group_text`, `oa_send_group_image`, `oa_send_group_link`, `oa_send_group_audio`, `oa_send_group_location`, `oa_send_group_video`, `oa_send_group_business_card`, `oa_send_group_sticker`, `oa_send_group_gif`, `oa_send_group_file`
- Voice call: `oa_send_consent`, `user_reply_consent`, `user_call_oa`, `oa_call_user`
- Extension: `extension_purchased`
- ZBS: `change_template_status`, `change_template_quality`, `change_oa_daily_quota`, `user_feedback`, `user_click_response_button`, `event_journey_acknowledged`, `event_journey_time_out`

`follow`/`unfollow` name the user by `follower.id`. Request bodies are capped at 1 MB. The listener **answers 200 as soon as an event is accepted**, before printing it: Zalo wants the 200 within 2 seconds, redelivers at +30 s, +5, +15 and +30 min and +1 h, and in the end disables the webhook and unsubscribes the app. A redelivery carries Zalo's `num_retry` header; the event then has `_num_retry` in `--json` output and its printed line says it is a redelivery.

A GET with `?hub.challenge=<x>` is echoed back: that is this listener's own convenience for tools that probe a webhook that way, not part of Zalo's webhook (Zalo verifies the domain with the verification file or meta tag instead).

## Multi-OA

```bash
zalo-agent oa login --app-id <ID1> --secret <K1> --oa-id shop1
zalo-agent oa login --app-id <ID2> --secret <K2> --oa-id shop2
zalo-agent oa whoami --oa-id shop1
zalo-agent oa msg text <uid> "Hi" --oa-id shop2
zalo-agent zbs quota --oa-id shop2
```

## Credentials

Stored: `~/.zalo-agent/oa-credentials.json` (mode 0600, written atomically under a lock; `--oa-dir` / `ZALO_OA_DIR` moves it). Unlike the personal account's files it is **not** sealed by 3.0's at-rest encryption (docs/security.md §1).

One record per `--oa-id`: `appId`, `secretKey`, `accessToken`, `refreshToken`, `expiresIn`, `expiresAt`, `oaId`, `updatedAt`, and `webhookUrl` / `verifyFile` / `verifyMeta` when `oa init` set them.

## Errors

A Zalo error prints as `OA API error <code>: <Zalo's message> (<what the code means>). <What to do>` (`ZBS API error <code>: …` for a ZBS endpoint, send-by-UID included), and the command exits 1. An id too long for a JavaScript number (Zalo types product, beneficiary and ZCA ids as `long`) comes back as its exact digits, a string. With `--json` the error object carries the same text. The meanings come from the error tables in Zalo's OA and ZBS docs (ZBS endpoints read the ZBS table first; send-by-UID reads the OA table first, as the ZBS error page says). The common ones:

| Code | Meaning | What to do |
|------|---------|------------|
| -216 / -220 | Access token invalid / expired | Refreshed automatically once when a refresh token is stored; else `oa refresh` or `oa login` |
| -124 (ZBS) | Access token invalid | As above |
| -32 | Rate limit (the app: 4,000 requests/minute, or the OA package's limit) | Slow down, retry in the next minute |
| -201 | A parameter is invalid | Check the request's parameters |
| -100 | `attachment_id` expired (uploads are kept 7 days) | Upload again |
| -212 | The app has not registered this API | Register it in the app's Official Account API settings |
| -213 | The user does not follow the OA | — |
| -221 | The OA must be verified for this feature | Verify the OA |
| -223 | The OA has not granted the app this API (or the article quota is reached) | Grant the permission in the app's OA settings |
| -224 | The OA's package does not include this feature | Upgrade the OA's package |
| -230 / -232 | The user has not interacted with the OA in the past 7 days / the interaction expired | The user must have followed the OA, messaged it, accepted a call from it, tapped Message or the call button on its profile, or tapped a menu item with an `oa.query` action; otherwise reach them with ZBS (`zbs uid` / `zbs send`) |
| -234 | This message type cannot be sent at night (22:00–07:00) | Send in the daytime |
| -240 | The v2 message API was shut down | Use the v3 message API |
| -320 / -321 | The app is not linked to a Zalo Cloud Account / the account cannot be charged | Link or top up the ZCA |
| -108 (ZBS) | Invalid phone number | Use 84xxxxxxxxx or 0xxxxxxxxx |
| -131 (ZBS) | The template is not approved | — |
| -133 (ZBS) | Cannot be sent at night (22:00–07:00 Vietnam time) | — |
| -135 (ZBS) | The OA may not send by phone number (not verified, or on the free plan) | — |
| -142 / -143 (ZBS) | The RSA key does not exist / already exists | `zbs rsa-key create` / `zbs rsa-key get` |
| -144 / -1441 (ZBS) | The OA's daily / monthly promotion quota is used up | `zbs quota` |
| -249 | The template does not support sending by UID | Use a custom, rating, payment-request or voucher template |

Failures before Zalo answered carry a word instead of a number: `http_<status>` (the endpoint answered a non-2xx status or a non-JSON body — `HTTP 404 (no such endpoint)` rather than a JSON parse error), `network`, `not_configured` (no stored token: run `oa login`), `upload_too_large`, `upload_type`, `upload_missing`, `token_refresh`.

## Removed in 3.0.0

| Removed | Why | Use instead |
|---|---|---|
| `oa store …` (product, category, order commands) | Zalo Shop is not in Zalo's current OA docs | — |
| `oa menu` | Zalo documents no menu API; the menu is set in the OA's management page | — |
| `oa msg list` | The list template exists only on the v2 message API, which Zalo shut down (`-240`) | `oa msg text`, `oa msg image`, … |
| `oa msg status` | It read ZBS phone-message status | `zbs status <message-id>` |
| `-m, --msg-type transaction\|promotion` | Zalo stopped transaction and promotion messages on the OA API on 01/03/2026 | `zbs send` / `zbs uid` template messages |
| `oa msg image --image-url/--image-id`, `oa msg file <user-id> <token>`, `oa follower update <user-id> <json>` | Renamed to match the docs | `--url` / `--attachment-id`, `--token`, named flags or `--data <json>` |

## Webhook setup checklist (developers.zalo.me)

1. Official Account → Callback URL: `http://localhost:3456/callback` (or `<callback-host>/callback` from a VPS)
2. API registration → Official Account API → turn it on
3. Official Account → permissions → tick what the commands need (OA management, messaging, articles, GMF, calls; the ZBS groups above) → Save
4. Domain verification: a DNS TXT record, or serve what Zalo gives (`oa listen --verify-file <file>` or `--verify-meta '<meta …>'`)
5. Webhook → set the HTTPS URL → turn on the events; copy the OA Secret Key for `oa listen -s`
