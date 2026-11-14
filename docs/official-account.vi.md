# Zalo Official Account (OA) và ZBS

[English](official-account.md)

Quản lý Zalo Official Account qua các API chính thức của Zalo — OA OpenAPI (v2.0/v3.0) với `oa …`, và ZBS Template Message với `zbs …`. Độc lập hoàn toàn với tài khoản cá nhân (API không chính thức). Hai nhóm lệnh dùng chung một lần đăng nhập OA.

> **Lưu ý:** Một số API cần OA đã xác thực hoặc gói OA trả phí. Xem [zalo.cloud/oa/pricing](https://zalo.cloud/oa/pricing).

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

# Login + ngrok tunnel, có kiểm tra chữ ký event
zalo-agent oa init --app-id <APP_ID> --secret <SECRET> --tunnel ngrok -p 3000 --oa-secret <OA_SECRET_KEY>

# Login + existing webhook URL (VPS/n8n)
zalo-agent oa init --app-id <APP_ID> --secret <SECRET> --webhook-url https://your-server.com/webhook

# JSON output
zalo-agent --json oa init --app-id <APP_ID> --secret <SECRET> --skip-webhook
```

### VPS (headless server)

```bash
# Trên VPS — khởi động callback server ở 0.0.0.0
zalo-agent oa login --app-id <APP_ID> --secret <SECRET> --callback-host https://your-vps.com

# Copy URL xác thực → mở trên trình duyệt máy local → uỷ quyền → VPS nhận token
```

---

## Lệnh

Tổng cộng **88 lệnh**: 70 lệnh trong nhóm `oa` và 18 lệnh trong nhóm `zbs`. Mọi lệnh đều nhận `--oa-id <id>` (mặc định `default`) để quản lý nhiều OA, và `--json` để xuất kết quả dạng máy đọc. Mọi tùy chọn và giá trị mặc định có trong [`skill/references/oa-command-reference.md`](../skill/references/oa-command-reference.md); trang này cho thấy dáng của từng nhóm.

### Setup & Auth

| Lệnh | Mô tả |
|-------|--------|
| `oa init [flags]` | Guided setup wizard (interactive + non-interactive) — xem bảng flag bên dưới |
| `oa login --app-id <id> --secret <key> [-p, --port <port>]` | OAuth v4 login với PKCE (`code_challenge` + `state`; đổi code lấy token kèm `code_verifier`). Mở browser; callback server chạy ở `127.0.0.1:<port>`, mặc định port `3456`. Timeout 2 phút |
| `oa login ... --callback-host <url>` | OAuth login từ VPS — bind `0.0.0.0`, không tự mở browser, in URL để mở thủ công trên máy local |
| `oa refresh` | Làm mới access token bằng refresh token đã lưu. Zalo chỉ cho dùng refresh token một lần, nên việc làm mới chạy tuần tự dưới khóa file và cặp token mới được lưu trước khi dùng |
| `oa setup <access-token>` | Set token thủ công (bỏ qua OAuth; không làm mới được) |
| `oa whoami` | Xem thông tin OA: tên, ID, mô tả, xác thực, loại OA, danh mục, số follower, gói dịch vụ (hạn dùng), liên kết Zalo Cloud Account. Gói và trạng thái xác thực quyết định API nào dùng được (`-224`: gói chưa đủ; `-221`: OA phải được xác thực) |

#### Flag của `oa init`

Wizard tự chuyển sang **chế độ agent (non-interactive)** ngay khi có `--app-id`.

| Flag | Mặc định | Mô tả |
|------|----------|--------|
| `--app-id <id>` | — | Zalo App ID (kích hoạt chế độ non-interactive) |
| `--secret <key>` | — | Zalo App Secret Key |
| `--oa-id <id>` | `default` | Định danh OA cho multi-OA |
| `--tunnel <type>` | `ngrok` (chế độ agent) | `ngrok` \| `cloudflared` \| `none` |
| `--webhook-url <url>` | — | Dùng webhook URL có sẵn (VPS, n8n…) thay vì tạo tunnel |
| `--verify-file <path>` | — | Xác thực domain: file HTML tải từ Zalo, listener của wizard phục vụ nguyên vẹn |
| `--verify-meta <tag>` | — | Xác thực domain: thẻ `<meta …>` Zalo hiển thị, dán nguyên thẻ |
| `--oa-secret <key>` | — | OA Secret Key (phần cài đặt Webhook của app): listener của wizard kiểm tra chữ ký từng event |
| `-p, --port <port>` | `3000` | Port cho webhook listener cục bộ |
| `--skip-webhook` | `false` | Bỏ qua hoàn toàn bước webhook |
| `--skip-login` | `false` | Bỏ qua OAuth (dùng token đã lưu) |

Wizard chạy qua 5 bước: (1) lưu app-id/secret → (2) OAuth login + kiểm tra profile → (3) checklist điều kiện tại developers.zalo.me (chỉ ở chế độ interactive) → (4) expose webhook → (5) in bảng tóm tắt (JSON nếu chạy với `--json`).

### Tin nhắn

`oa msg` chỉ gửi tin Tư vấn (CS). Zalo đã dừng tin Giao dịch và tin Truyền thông trên OA API từ 01/03/2026: hãy gửi chúng dưới dạng tin template ZBS (`zbs send`, `zbs uid`, bên dưới).

```bash
# Text (≤ 2000 ký tự), có thể trích dẫn một tin nhắn
zalo-agent oa msg text <user-id> "Nội dung" [--quote <message-id>]

# Ảnh (jpg/png ≤ 1 MB) theo URL, attachment_id, hoặc file cục bộ (tự upload trước)
zalo-agent oa msg image <user-id> --url https://... [--caption "..."]
zalo-agent oa msg image <user-id> --file ./photo.jpg

# GIF, file, sticker
zalo-agent oa msg gif <user-id> --file ./anim.gif --width 320 --height 240
zalo-agent oa msg file <user-id> --file ./document.pdf
zalo-agent oa msg sticker <user-id> <sticker-id>

# Yêu cầu follower chia sẻ thông tin
zalo-agent oa msg request-info <user-id> --title "..." --subtitle "..." --image-url https://...

# Thả cảm xúc vào tin nhắn (like, heart, remove, hoặc các mã Zalo công bố)
zalo-agent oa msg react <user-id> <message-id> like

# Nhắn người dùng ẩn danh, trong hội thoại lấy từ event webhook của họ
zalo-agent oa msg anonymous <anonymous-id> --conversation <conversation-id> --text "..."

# Lần tương tác cuối và số tin còn lại với một người dùng; hạn mức tin của OA
zalo-agent oa msg user-quota <user-id>
zalo-agent oa quota
```

### Media Upload

Zalo giữ file upload trong 7 ngày và cho phép 5000 lượt upload mỗi tháng.

```bash
zalo-agent oa upload image ./photo.jpg    # jpg/png ≤ 1 MB → attachment_id
zalo-agent oa upload file ./document.pdf  # PDF/DOC/DOCX/CSV ≤ 5 MB → token
zalo-agent oa upload gif ./anim.gif       # GIF ≤ 5 MB → attachment_id
```

### Hội thoại

```bash
zalo-agent oa conv recent [--offset 0] [--count 10] [--all]
zalo-agent oa conv history <user-id> [--offset 0] [--count 10] [--all]
```

Tối đa 10 tin mỗi lần gọi; `--all` đi hết các trang (`--max <n>` để dừng sớm).

### Người dùng, trường thông tin, tag

```bash
zalo-agent oa follower list [--count 50] [--tag <name>] [--last-interaction L7D] [--followers-only] [--all]
zalo-agent oa follower info <user-id>

# Cập nhật thông tin OA lưu về người dùng: các trường shared_info theo tên flag, cùng alias và external id
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

`follower list` trả về danh sách user id (50 mỗi trang, tối đa 10.000 người dùng); `follower info` cho chi tiết một người dùng.

### Form Zalo Ads, mua sản phẩm

```bash
zalo-agent oa form get <form-id> --from 2026-11-01 --to 2026-11-13
zalo-agent oa purchase create-order --product-id <id>               # giá + token dùng một lần, chưa trừ tiền
zalo-agent oa purchase confirm-order <order-id> <verified-token> --yes   # thanh toán (trong vòng 5 phút)
```

### Bài viết

```bash
zalo-agent oa article create @article.json          # chờ đến khi Zalo trả id bài viết (--no-wait: trả token)
zalo-agent oa article verify <token>
zalo-agent oa article update <article-id> @article.json
zalo-agent oa article list [--type normal|video] [--all]
zalo-agent oa article detail <article-id>
zalo-agent oa article remove <article-id> --yes
zalo-agent oa article video-upload ./clip.mp4 --wait
zalo-agent oa article video-status <token>
```

### Nhóm chat (GMF) và gọi thoại

```bash
zalo-agent oa group quota                                    # asset id
zalo-agent oa group create "Support" --asset-id <id> --members <user-id>,<user-id>
zalo-agent oa group send <group-id> "Xin chào [@<user-id>]"
zalo-agent oa group members <group-id> --all
zalo-agent oa group remove-members <group-id> <user-ids> --yes
zalo-agent oa group delete <group-id> --yes

zalo-agent oa call consent-request 0901234567 --reason 101 --yes   # tính phí mỗi yêu cầu
zalo-agent oa call consent-check 0901234567
zalo-agent oa call outbound <user-id> --agent <agent-id>
zalo-agent oa call mcc-info
```

`oa group` còn có `info`, `update`, `avatar`, `update-asset`, `invite`, `pending`, `accept`, `reject`, `add-admins`, `remove-admins`, `list`, `recent` và `history`; `oa call` còn có `inbound`. Nhóm chat cần OA đã xác thực trên gói Advanced hoặc Premium.

### ZBS Template Message

Tin template theo số điện thoại hoặc user id, dùng token của OA (chạy `oa login` trước).

```bash
zalo-agent zbs template list [--status enable] [--all]
zalo-agent zbs template detail <template-id>
zalo-agent zbs template sample <template-id>          # template_data mẫu để bắt đầu
zalo-agent zbs template create template.json          # kiểm tra cục bộ theo quy định template của Zalo trước
zalo-agent zbs upload-image ./logo.png --kind logo

zalo-agent zbs send 0901234567 <template-id> '{"customer_name":"A","order_code":"X1"}'
zalo-agent zbs send 84901234567 <template-id> data.json --hash-phone
zalo-agent zbs send 0901234567 <template-id> data.json --dev          # gửi thử tới admin của OA
zalo-agent zbs send 0901234567 <template-id> data.json --rsa          # mã hóa bằng khóa RSA của OA
zalo-agent zbs uid <user-id> <template-id> data.json

zalo-agent zbs status <message-id>
zalo-agent zbs quota
zalo-agent zbs quality
```

`zbs` còn có `template update|rating|quick-reply`, `rsa-key create|get` và `journey token|check|send`. Mỗi nhóm cần một quyền mà OA cấp cho app: template và `upload-image` cần quyền *quản lý Message Template* (tạo, sửa template và upload còn cần quyền *quản lý tài sản*); gửi tin qua số điện thoại, khóa RSA, journey, trạng thái, quota và chất lượng cần quyền *gửi tin qua số điện thoại*; `zbs uid` cần quyền *gửi tin nhắn* của OA.

### Lệnh có bảo vệ

`oa follower delete-info`, `oa userfield delete`, `oa tag remove`, `oa purchase confirm-order`, `oa call consent-request` (mỗi yêu cầu đều tính phí), `oa article remove`, `oa group remove-members` và `oa group delete` không gửi gì nếu thiếu `-y, --yes` (thoát với mã 2); `--dry-run` cho biết sẽ làm gì. Tham số hoặc tùy chọn JSON (`--data`, `<json>`, bài viết, template, `template_data`) là JSON viết trực tiếp (bắt đầu bằng `{` hoặc `[`), `@file`, hoặc đường dẫn tới file JSON.

### Webhook Listener

```bash
# Cơ bản
zalo-agent oa listen -p 3000

# Có kiểm tra chữ ký
zalo-agent oa listen -p 3000 -s <OA_SECRET_KEY>

# Lọc events
zalo-agent oa listen -e user_send_text,follow

# Đổi đường dẫn webhook (mặc định /webhook)
zalo-agent oa listen -p 3000 --path /zalo

# Domain verification
zalo-agent oa listen -p 3000 --verify-file zalo_verifierXXXX.html   # file Zalo cung cấp
zalo-agent oa listen -p 3000 --verify-meta '<meta …>'              # hoặc thẻ Zalo hiển thị

# JSON output (pipe)
zalo-agent --json oa listen | while read -r event; do
  echo "$event" | jq '.message.text'
done
```

| Flag | Mặc định | Mô tả |
|------|----------|--------|
| `-p, --port <port>` | `3000` | Port lắng nghe |
| `-s, --secret <key>` | — | OA Secret Key (phần cài đặt Webhook của app) để kiểm tra `X-ZEvent-Signature`. Không có thì in cảnh báo |
| `--no-verify` | `false` | Bỏ kiểm tra chữ ký dù đã có secret (chỉ dùng khi dev) |
| `-e, --events <list>` | `all` | Lọc event, phân cách bằng dấu phẩy |
| `--path <path>` | `/webhook` | Đường dẫn URL của webhook |
| `--app-id <id>` | app id đã lưu | Zalo App ID, để kiểm tra sự kiện không có `app_id` trong body (`extension_purchased`, `change_template_quality`, `change_oa_daily_quota`) |
| `--verify-file <path>` | — | Xác thực domain: file HTML tải từ trang "Xác thực domain" của Zalo, phục vụ nguyên vẹn đúng tên file |
| `--verify-meta <tag>` | — | Xác thực domain: thẻ `<meta …>` Zalo hiển thị, dán nguyên thẻ; đặt trong head của trang chủ |

**Chữ ký:** theo tài liệu webhook OA của Zalo, mỗi event có header `X-ZEvent-Signature: mac=sha256(app_id + body + timestamp + OA secret key)` — một SHA-256 thường (hex) trên chuỗi nối `app_id` của body, body thô đúng như được gửi, `timestamp` của body và OA secret key, **không phải** HMAC. Listener tính lại, so sánh thời gian hằng định, và trả 401 cho chữ ký sai hoặc thiếu.

**Events:** `--events` nhận mọi tên event trong tài liệu OA và ZBS của Zalo: follow/unfollow, tin nhắn đến (`user_send_*`, `user_click_chatnow`), vòng đời tin nhắn (`user_seen_message`, `user_received_message`, `user_reacted_message`, `oa_reacted_message`), các event `oa_send_*`, người dùng ẩn danh, quản lý người dùng, widget, quản lý nhóm GMF và tin nhắn nhóm, gọi thoại, `extension_purchased` và các event ZBS — danh sách đầy đủ ở [`skill/references/oa-command-reference.md`](../skill/references/oa-command-reference.md). Lọc theo một tên Zalo không công bố thì listener cảnh báo ngay khi khởi động, vì bộ lọc đó không bao giờ khớp. Event `follow`/`unfollow` xác định người dùng qua `follower.id`.

Listener giới hạn body tối đa 1 MB. Listener **trả 200 ngay khi nhận** event rồi mới in ra, vì Zalo đòi 200 trong vòng 2 giây. Khi Zalo gửi lại một event (header `num_retry`), kết quả JSON có `_num_retry` và dòng in ra ghi rõ đó là lần gửi lại, để không xử lý nhầm thành event mới. Một GET kèm `?hub.challenge=<x>` được trả lại nguyên giá trị: đây là tiện ích riêng của listener cho các công cụ kiểm tra webhook theo cách đó, không thuộc cơ chế webhook của Zalo.

### Đã gỡ bỏ trong 3.0.0

| Đã gỡ | Lý do | Dùng thay |
|---|---|---|
| `oa store …` | Zalo Shop không còn trong tài liệu OA hiện tại của Zalo | — |
| `oa menu` | Zalo không công bố API menu; menu được đặt trong trang quản lý OA | — |
| `oa msg list` | Template danh sách chỉ có ở API tin nhắn v2, Zalo đã tắt | `oa msg text`, `oa msg image`, … |
| `oa msg status` | Lệnh này đọc trạng thái tin ZBS qua số điện thoại | `zbs status <message-id>` |
| `-m transaction` / `-m promotion` | Zalo dừng trên OA API từ 01/03/2026 | `zbs send` / `zbs uid` |

---

## Mã lỗi thường gặp

Lỗi từ Zalo được in dạng `OA API error <mã>: <thông báo của Zalo> (<ý nghĩa của mã>). <Cách xử lý>` (`ZBS API error <mã>: …` với endpoint ZBS) và lệnh thoát với mã 1. Ý nghĩa lấy từ bảng mã lỗi trong tài liệu OA và ZBS của Zalo; danh sách đầy đủ CLI biết có trong [bản tham chiếu](../skill/references/oa-command-reference.md#errors).

| Mã | Ý nghĩa | Cách xử lý |
|------|---------|-----|
| `-216` / `-220` | Access token không hợp lệ / hết hạn | Tự làm mới một lần nếu có refresh token đã lưu; nếu không, `zalo-agent oa refresh` hoặc `oa login` lại |
| `-124` (ZBS) | Access token không hợp lệ | Như trên |
| `-32` | Vượt giới hạn tốc độ gọi API | Giảm tốc, thử lại ở phút sau |
| `-201` | Tham số không hợp lệ | Kiểm tra tham số của request |
| `-213` | Người dùng chưa quan tâm OA | — |
| `-221` | OA phải được xác thực để dùng tính năng này | Xác thực OA |
| `-223` | OA chưa cấp quyền API này cho app | Cấp quyền trong phần cài đặt OA của app |
| `-224` | Gói dịch vụ của OA không có tính năng này | Nâng cấp tại [zalo.cloud/oa/pricing](https://zalo.cloud/oa/pricing) |
| `-230` | Người dùng không tương tác với OA trong 7 ngày qua | Người dùng phải đã quan tâm OA, nhắn tin cho OA, nhận cuộc gọi từ OA, bấm Nhắn tin hoặc nút Gọi trên trang OA, hoặc bấm menu có hành động `oa.query`; nếu không, hãy gửi qua ZBS (`zbs uid` / `zbs send`) |
| `-240` | API tin nhắn v2 đã bị tắt | Dùng API v3 |
| `-135` (ZBS) | OA không được gửi tin qua số điện thoại | Xác thực OA / dùng gói trả phí |
| `-144` (ZBS) | OA đã dùng hết hạn mức gửi tin qua SĐT trong ngày | `zbs quota` |
| `http_<status>` | Endpoint trả mã HTTP không phải 2xx hoặc body không phải JSON (ví dụ `HTTP 404 (no such endpoint)`) | — |

---

## Webhook Setup

### Yêu cầu từ Zalo

1. **Domain verification** — Zalo cần verify domain trước khi dùng webhook
2. **HTTPS required** — webhook URL phải là HTTPS
3. **IP Việt Nam** — để nhận đầy đủ thông tin user (tên, avatar, SĐT)
4. **Trả về 200 OK** — trong vòng 2 giây. Quá hạn thì Zalo gửi lại sau 30 giây, 5, 15, 30 phút và 1 giờ, và nếu vẫn lỗi thì **tắt webhook, huỷ đăng ký app** — khi đó phải đăng ký lại trong phần cài đặt app

### Checklist tại developers.zalo.me

1. **Official Account → Callback URL**: đặt `http://localhost:3456/callback` (hoặc `<callback-host>/callback` khi login từ VPS)
2. **Đăng ký sử dụng API → Official Account API**: bật ON
3. **Official Account → Chọn quyền**: tick các quyền mà lệnh cần (kể cả các nhóm quyền ZBS cho `zbs`) → Lưu
4. **Xác thực domain**: thêm bản ghi DNS TXT, hoặc phục vụ đúng thứ Zalo cung cấp (`oa listen --verify-file <file>` hoặc `--verify-meta '<meta …>'`)
5. **Webhook**: đặt URL HTTPS, bật các event cần nhận, và chép OA Secret Key để dùng cho `oa listen -s`

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
zalo-agent oa listen -p 3000 -s <OA_SECRET_KEY> --verify-file zalo_verifierXXXX.html

# Terminal 2: tunnel
ngrok http 3000
```

### Với VPS (khuyến nghị cho production)

```bash
# Install trên VPS (cần Node.js 22.19+)
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

Lưu tại `~/.zalo-agent/oa-credentials.json` (quyền 0600, chỉ owner đọc được, ghi nguyên tử dưới khóa; có thể đổi thư mục qua `--oa-dir <dir>` hoặc `ZALO_OA_DIR`). `oa` và `zbs` đọc chung file này.

> [!IMPORTANT]
> Thư mục mặc định này là `~/.zalo-agent/` — **không có hậu tố `-cli`**. Tài khoản cá nhân dùng `~/.zalo-agent-cli/`. Hai đường dẫn khác nhau hoàn toàn: xoá cái này không ảnh hưởng cái kia, và `logout --purge` của tài khoản cá nhân không đụng tới credentials OA.

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

`expiresIn` tính bằng giây — `90000` ≈ **25 giờ**; `expiresAt` là lúc token hết hạn. Sau đó lệnh gọi sẽ nhận `-216`/`-220`, và CLI tự làm mới token một lần bằng refresh token đã lưu rồi gọi lại. Cũng có thể làm mới bất kỳ lúc nào bằng `zalo-agent oa refresh` (không cần mở browser). Bản thân refresh token có hạn 3 tháng và chỉ dùng được một lần, nên nếu 3 tháng không dùng tới thì phải `oa login` lại. Với listener chạy dài ngày mà không gọi API, nên đặt cron làm mới để giữ cặp token còn hạn:

```bash
0 */12 * * * zalo-agent oa refresh --oa-id default >/dev/null 2>&1
```

**Multi-OA:** Dùng `--oa-id` để quản lý nhiều OA:

```bash
zalo-agent oa login --app-id <ID1> --secret <KEY1> --oa-id shop1
zalo-agent oa login --app-id <ID2> --secret <KEY2> --oa-id shop2
zalo-agent oa whoami --oa-id shop1
zalo-agent zbs quota --oa-id shop2
```

---

## Bảo mật (Security)

- Credentials file: `chmod 600` (owner-only)
- Access token gửi trong header `access_token`, không bao giờ nằm trên URL
- Chữ ký webhook: `sha256(app_id + body + timestamp + OA secret key)` theo tài liệu Zalo, so sánh thời gian hằng định
- Lệnh xóa dữ liệu hoặc trả tiền cần `--yes`
- Webhook body size limit: tối đa 1 MB
- OAuth: PKCE kèm `state`; callback bind `127.0.0.1` (local) hoặc `0.0.0.0` (VPS mode)
- Không hardcode secret — tất cả lấy từ CLI flag hoặc file credential
- Không được niêm phong: mã hóa trên đĩa mà 3.0 áp dụng cho các file của tài khoản cá nhân ([security.vi.md](security.vi.md)) không bao gồm `oa-credentials.json`. Hãy để thư mục OA trên ổ đã mã hóa và chỉ cho tài khoản dịch vụ đọc.

---

## So sánh

| | `zalo-agent` (personal) | `zalo-agent oa` / `zbs` (official) |
|---|---|---|
| API | Unofficial (giao thức riêng của Zalo) | Official (Zalo OA API v2.0/v3.0, ZBS) |
| Auth | QR code login | OAuth 2.0 (v4, PKCE) |
| Scope | Tài khoản cá nhân | Official Account |
| Risk | Có thể bị ban | An toàn, API chính thức |
| Features | Chat, friend, group, poll... | Tin tư vấn, người dùng, tag, bài viết, nhóm chat, gọi thoại, tin template, webhook |
| Credentials | `~/.zalo-agent-cli/` | `~/.zalo-agent/` (không có hậu tố `-cli`) |
| Disclaimer khi chạy | Có | Không (API chính thức) |
| Auto-login trước lệnh | Có | Không — `oa` tự quản lý token riêng |
| Số lệnh | 227 (trong tổng 315 lệnh CLI) | 88 (70 `oa` + 18 `zbs`) |
| Realtime | WebSocket (`listen`) | Webhook HTTP (`oa listen`) |
| Có MCP tool? | Có — 36 tools (xem [mcp-guide](../skill/references/mcp-guide.md)) | **Chưa** — chỉ dùng được qua CLI |

> [!NOTE]
> Các lệnh `oa` và `zbs` **chưa** được expose thành MCP tool. AI agent muốn dùng OA phải gọi CLI trực tiếp, ví dụ `zalo-agent --json oa msg text <uid> "..."`.

---

## Tài liệu liên quan

- [docs/official-account.md](official-account.md) — bản tiếng Anh của tài liệu này
- [skill/references/oa-command-reference.md](../skill/references/oa-command-reference.md) — mọi tùy chọn của `oa` và `zbs`, các event webhook, mã lỗi (tiếng Anh)
- [skill/references/command-reference.md](../skill/references/command-reference.md) — tham chiếu đầy đủ mọi lệnh (nguồn chuẩn)
- [INSTALLATION.vi.md](../INSTALLATION.vi.md) / [INSTALLATION.md](../INSTALLATION.md) — cài đặt, cấu hình MCP client, thiết lập OA
- [Wiki: Official Account (VN)](https://github.com/ardennguyen/zalo-agent-cli/wiki/Official-Account-(VN))
