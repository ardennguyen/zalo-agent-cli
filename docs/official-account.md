# Zalo Official Account (OA)

Quản lý Zalo Official Account qua API v3.0 chính thức. Độc lập hoàn toàn với tài khoản cá nhân (zca-js).

> **Lưu ý:** Một số API cần upgrade OA tier. Xem [zalo.cloud/oa/pricing](https://zalo.cloud/oa/pricing).

## Bắt đầu nhanh

### Interactive (con người)

```bash
zalo-agent oa init
```

Wizard hướng dẫn từng bước: nhập credentials → OAuth login → webhook setup.

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

## Lệnh

Tổng cộng **32 lệnh** trong nhóm `oa`. Mọi lệnh đều nhận `--oa-id <id>` (mặc định `default`) để quản lý nhiều OA, và `--json` để xuất kết quả dạng máy đọc.

### Setup & Auth

| Lệnh | Mô tả |
|-------|--------|
| `oa init [flags]` | Guided setup wizard (interactive + non-interactive) — xem bảng flag bên dưới |
| `oa login --app-id <id> --secret <key> [-p, --port <port>]` | OAuth login (mở browser). Callback server chạy ở `127.0.0.1:<port>`, mặc định port `3456`. Timeout 2 phút |
| `oa login ... --callback-host <url>` | OAuth login từ VPS — bind `0.0.0.0`, không tự mở browser, in URL để mở thủ công trên máy local |
| `oa refresh` | Làm mới access token (dùng refresh token đã lưu) |
| `oa setup <access-token>` | Set token thủ công (bỏ qua OAuth) |
| `oa whoami` | Xem thông tin OA: tên, ID, mô tả, số follower |

#### Flag của `oa init`

Wizard tự chuyển sang **chế độ agent (non-interactive)** ngay khi có `--app-id`.

| Flag | Mặc định | Mô tả |
|------|----------|--------|
| `--app-id <id>` | — | Zalo App ID (kích hoạt chế độ non-interactive) |
| `--secret <key>` | — | Zalo App Secret Key |
| `--oa-id <id>` | `default` | Định danh OA cho multi-OA |
| `--tunnel <type>` | `ngrok` (chế độ agent) | `ngrok` \| `cloudflared` \| `none` |
| `--webhook-url <url>` | — | Dùng webhook URL có sẵn (VPS, n8n…) thay vì tạo tunnel |
| `--verify-code <code>` | — | Mã xác thực domain của Zalo |
| `-p, --port <port>` | `3000` | Port cho webhook listener cục bộ |
| `--skip-webhook` | `false` | Bỏ qua hoàn toàn bước webhook |
| `--skip-login` | `false` | Bỏ qua OAuth (dùng token đã lưu) |

Wizard chạy qua 5 bước: (1) lưu app-id/secret → (2) OAuth login + kiểm tra profile → (3) checklist điều kiện tại developers.zalo.me (chỉ ở chế độ interactive) → (4) expose webhook → (5) in bảng tóm tắt (JSON nếu chạy với `--json`).

### Tin nhắn

```bash
# Gửi text (message type: cs | transaction | promotion)
zalo-agent oa msg text <user-id> "Nội dung" [-m cs]

# Gửi ảnh (URL hoặc attachment_id)
zalo-agent oa msg image <user-id> --image-url https://...
zalo-agent oa msg image <user-id> --image-id <attachment_id>

# Gửi file (cần upload trước)
zalo-agent oa msg file <user-id> <file-id>

# Gửi danh sách
zalo-agent oa msg list <user-id> '[{"title":"Item 1"},{"title":"Item 2"}]'

# Kiểm tra trạng thái
zalo-agent oa msg status <message-id>
```

### Follower

```bash
zalo-agent oa follower list [--offset 0] [--count 50]
zalo-agent oa follower info <user-id>
zalo-agent oa follower update <user-id> '{"name":"...","phone":"..."}'
```

### Tag

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

### Hội thoại

```bash
zalo-agent oa conv recent [--offset 0] [--count 10]
zalo-agent oa conv history <user-id> [--offset 0] [--count 10]
```

### Webhook Listener

```bash
# Cơ bản
zalo-agent oa listen -p 3000

# Với MAC verification
zalo-agent oa listen -p 3000 -s <OA_SECRET_KEY>

# Lọc events
zalo-agent oa listen -e user_send_text,follow

# Đổi đường dẫn webhook (mặc định /webhook)
zalo-agent oa listen -p 3000 --path /zalo

# Domain verification
zalo-agent oa listen -p 3000 --verify-domain <ZALO_VERIFY_CODE>

# JSON output (pipe)
zalo-agent --json oa listen | while read -r event; do
  echo "$event" | jq '.message.text'
done
```

| Flag | Mặc định | Mô tả |
|------|----------|--------|
| `-p, --port <port>` | `3000` | Port lắng nghe |
| `-s, --secret <key>` | — | OA Secret Key để verify MAC (HMAC-SHA256, so sánh timing-safe). Không có thì in cảnh báo |
| `--no-verify` | `false` | Tắt verify MAC dù đã có secret (chỉ dùng khi dev) |
| `-e, --events <list>` | `all` | Lọc event, phân cách bằng dấu phẩy |
| `--path <path>` | `/webhook` | Đường dẫn URL của webhook |
| `--verify-domain <code>` | — | Phục vụ file `/zalo_verifier<code>.html` để xác thực domain |

**Events hỗ trợ:** `follow`, `unfollow`, `user_send_text`, `user_send_image`, `user_send_file`, `user_send_location`, `user_send_sticker`, `user_send_gif`, `user_click_button`, `user_click_link`

Listener tự trả lời `hub.challenge` (GET) của Zalo, và giới hạn body tối đa 1MB.

### Menu, Bài viết, Cửa hàng

```bash
zalo-agent oa menu '{"buttons":[...]}'                        # Cập nhật menu OA

zalo-agent oa article create '{"title":"..."}'                 # Tạo bài viết (broadcast)
zalo-agent oa article list [--offset 0] [--limit 10]           # Danh sách bài viết
zalo-agent oa article detail <article-id>                      # Chi tiết bài viết

zalo-agent oa store product-create '{"name":"..."}'            # Tạo sản phẩm
zalo-agent oa store product-list [--offset 0] [--limit 10]     # Danh sách sản phẩm
zalo-agent oa store product-info <product-id>                  # Chi tiết sản phẩm
zalo-agent oa store category-create '{"name":"..."}'           # Tạo danh mục
zalo-agent oa store category-list                              # Danh mục
zalo-agent oa store order-create '{"...":"..."}'               # Tạo đơn hàng
```

---

## Mã lỗi thường gặp

| Mã | Ý nghĩa | Cách xử lý |
|------|---------|-----|
| `-216` | Access token không hợp lệ / hết hạn | `zalo-agent oa refresh` hoặc `oa login` lại |
| `-224` | Gói OA chưa đủ tier cho API này | Nâng cấp tại [zalo.cloud/oa/pricing](https://zalo.cloud/oa/pricing) |
| `-14029` | App chưa được duyệt | Xác minh app tại [developers.zalo.me](https://developers.zalo.me) |

---

## Webhook Setup

### Yêu cầu từ Zalo

1. **Domain verification** — Zalo cần verify domain trước khi dùng webhook
2. **HTTPS required** — webhook URL phải là HTTPS
3. **IP Việt Nam** — để nhận đầy đủ thông tin user (tên, avatar, SĐT)
4. **Trả về 200 OK** — trong vòng 5 giây

### Checklist tại developers.zalo.me

1. **Official Account → Callback URL**: đặt `http://localhost:3456/callback` (hoặc `<callback-host>/callback` khi login từ VPS)
2. **Đăng ký sử dụng API → Official Account API**: bật ON
3. **Official Account → Chọn quyền**: tick đủ quyền cần dùng → Lưu
4. **Xác thực domain**: serve file verification hoặc meta tag (dùng `oa listen --verify-domain <code>`)
5. **Webhook**: đặt URL HTTPS và bật các event cần nhận

### Các cách expose webhook

| Cách | Ưu điểm | Nhược điểm |
|------|----------|------------|
| **ngrok** | Nhanh nhất, 1 lệnh | IP Singapore, URL thay đổi mỗi lần |
| **cloudflared** | Free, stable | Cần Cloudflare account |
| **VPS** | IP VN, ổn định | Cần quản lý server |
| **n8n** | Visual workflow | Cần deploy n8n |

### Với ngrok

```bash
# Terminal 1: listener
zalo-agent oa listen -p 3000 --no-verify --verify-domain <CODE>

# Terminal 2: tunnel
ngrok http 3000
```

### Với VPS (khuyến nghị cho production)

```bash
# Install trên VPS (cần Node.js 22+)
npm install -g @ardennguyen/zalo-agent-cli

# Login từ VPS
zalo-agent oa login --app-id <ID> --secret <KEY> --callback-host https://your-vps.com

# Run listener
zalo-agent oa listen -p 3000 -s <SECRET>

# Dùng systemd/pm2 để keep alive
pm2 start "zalo-agent oa listen -p 3000 -s <SECRET>" --name zalo-oa
```

---

## Credentials

Lưu tại `~/.zalo-agent/oa-credentials.json` (quyền 0600, chỉ owner đọc được).

> [!IMPORTANT]
> Thư mục này là `~/.zalo-agent/` — **không có hậu tố `-cli`**. Tài khoản cá nhân dùng `~/.zalo-agent-cli/`. Hai đường dẫn khác nhau hoàn toàn: xoá cái này không ảnh hưởng cái kia, và `logout --purge` của tài khoản cá nhân không đụng tới credentials OA.

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

`expiresIn` tính bằng giây — `90000` ≈ **25 giờ**. Sau đó mọi lệnh OA sẽ trả về lỗi `-216`. Làm mới bằng `zalo-agent oa refresh` (dùng refresh token đã lưu, không cần mở browser lại). Với listener chạy dài ngày, nên đặt cron làm mới token mỗi ~24 giờ:

```bash
0 */12 * * * zalo-agent oa refresh --oa-id default >/dev/null 2>&1
```

**Multi-OA:** Dùng `--oa-id` để quản lý nhiều OA:

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
- Message type whitelist: `cs`, `transaction`, `promotion` only
- Webhook body size limit: 1MB max
- OAuth callback: binds `127.0.0.1` (local) or `0.0.0.0` (VPS mode)
- No hardcoded secrets — all from CLI flags or credential file

---

## So sánh

| | `zalo-agent` (personal) | `zalo-agent oa` (official) |
|---|---|---|
| API | Unofficial (zca-js) | Official (Zalo OA API v3.0) |
| Auth | QR code login | OAuth 2.0 |
| Scope | Tài khoản cá nhân | Official Account |
| Risk | Có thể bị ban | An toàn, API chính thức |
| Features | Chat, friend, group, poll... | Messaging, follower, tag, article, store, webhook |
| Credentials | `~/.zalo-agent-cli/` | `~/.zalo-agent/` (không có hậu tố `-cli`) |
| Disclaimer khi chạy | Có | Không (API chính thức) |
| Auto-login trước lệnh | Có | Không — `oa` tự quản lý token riêng |
| Số lệnh | 146 | 32 |
| Realtime | WebSocket (`listen`) | Webhook HTTP (`oa listen`) |
| Có MCP tool? | Có — 7 tools (xem [mcp-guide](../skill/references/mcp-guide.md)) | **Chưa** — chỉ dùng được qua CLI |

> [!NOTE]
> Các lệnh `oa` **chưa** được expose thành MCP tool. AI agent muốn dùng OA phải gọi CLI trực tiếp, ví dụ `zalo-agent --json oa msg text <uid> "..."`.

---

## Tài liệu liên quan

- [skill/references/oa-command-reference.md](../skill/references/oa-command-reference.md) — bản tham chiếu OA tiếng Anh cho AI agent
- [skill/references/command-reference.md](../skill/references/command-reference.md) — tham chiếu đầy đủ mọi lệnh (nguồn chuẩn)
- [INSTALLATION.md](../INSTALLATION.md) — cài đặt, cấu hình MCP client, thiết lập OA
- [Wiki: Official Account (VN)](https://github.com/ardennguyen/zalo-agent-cli/wiki/Official-Account-(VN))
