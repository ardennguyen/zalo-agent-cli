# Hướng dẫn Cài đặt Zalo MCP Server & CLI

[English](INSTALLATION.md)

Tài liệu này hướng dẫn triển khai bộ wrapper **`zalo-mcp`** — bộ cài đặt đóng gói độc lập (sandboxed) tự động tải về engine `zalo-agent-cli` và vận hành nó dưới dạng Model Context Protocol (MCP) server, giúp các AI agent (Claude Code, Cursor, Google Gemini và các client khác) tự động hóa Zalo cá nhân & Official Account mà không làm ảnh hưởng đến môi trường hệ thống toàn cục.

> Nếu bạn chỉ cần dùng CLI (không cần MCP server), có thể cài trực tiếp bằng `npm install -g @ardennguyen/zalo-agent-cli` — xem [README.md](README.md).

---

## Mối quan hệ giữa hai repository

- **`zalo-agent-cli`** (repo này) — engine cốt lõi. Toàn bộ logic API, xác thực và mã nguồn MCP server (`src/mcp/`) nằm tại đây.
- **`zalo-mcp`** — bộ wrapper triển khai gọn nhẹ (repo riêng: [github.com/ardennguyen/zalo-mcp](https://github.com/ardennguyen/zalo-mcp)). Repo này không chứa code engine; script cài đặt của nó tải `zalo-agent-cli` vào thư mục cục bộ cô lập, liên kết lệnh toàn cục `zalo-mcp` và `zalo-agent`, đồng thời tạo file `.env` để AI client có thể chạy ngay. Khi gọi không kèm lệnh con (`zalo-mcp` hoặc `node mcp-server.js`), nó khởi chạy `zalo-agent mcp start` và chuyển tiếp toàn bộ các flag của `mcp start` (`--account`, `--http`, `--auth`, `--host`, `--cert`, `--key`, `--client-id`, `--client-secret`, `--issuer-url`, `-w`/`--webhook`, `--webhook-secret`, `--config`, `--no-self-heal`, `--no-delivered-receipts`, `-d`/`--daemon`, `--stop`, `--status`, cùng các flag lưu trữ toàn cục); khi gọi kèm lệnh con CLI (`zalo-mcp login`, `zalo-mcp --account <ID> msg list --json`, `zalo-mcp sync`, …), nó chuyển tiếp trực tiếp các tham số sang `zalo-agent`.

Vì wrapper hoạt động theo cơ chế chuyển tiếp nguyên vẹn (pass-through), **danh sách MCP tool được quyết định hoàn toàn bởi `src/mcp/mcp-tools.js` trong repo này** — theo đúng phiên bản `zalo-agent-cli` đang cài trong `zalo-mcp`.

> [!NOTE]
> Một thư mục `zalo-mcp` đã triển khai sẽ chạy phiên bản `@ardennguyen/zalo-agent-cli` nằm trong `node_modules/` của nó. Kiểm tra bằng:
> ```bash
> node -p "require('./node_modules/@ardennguyen/zalo-agent-cli/package.json').version"
> ```
> Chạy `./zalo-mcp.sh update` (hoặc `.\zalo-mcp.ps1 update`) để cập nhật lên phiên bản engine mới nhất đã phát hành trên npm.

---

## Yêu cầu hệ thống

- **Node.js** 22+ (trường `engines` của CLI cũng như `undici` và `commander` đều yêu cầu Node 22+)
- **Git**

---

## Bắt đầu nhanh (cài đặt bằng 1 lệnh)

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/ardennguyen/zalo-mcp/main/zalo-mcp.sh | bash -s install
```

**Windows (PowerShell):**
```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force; irm https://raw.githubusercontent.com/ardennguyen/zalo-mcp/main/zalo-mcp.ps1 | Out-File $env:TEMP\zalo-mcp.ps1; & $env:TEMP\zalo-mcp.ps1 install
```

Lệnh này tạo thư mục `zalo-mcp/` tại vị trí hiện tại, cài đặt các gói Node vào `node_modules/` cục bộ, liên kết lệnh toàn cục `zalo-mcp` và `zalo-agent`, đồng thời tạo file `.env`. Bạn có thể nhập cổng (port) khi cài tương tác hoặc sửa file `.env` sau.

### Các lệnh của script wrapper

Chạy từ bên trong thư mục `zalo-mcp/` đã cài đặt:

| Lệnh | Mô tả |
|:---|:---|
| `install` | Clone wrapper từ GitHub vào một thư mục mới |
| `init [--clean] [--oa-port <port>] [--mcp-port <port>]` | Cài đặt dependencies, liên kết lệnh CLI toàn cục và tạo `.env` |
| `update` | Cập nhật engine và dependencies lên bản mới nhất |
| `clean` | Xóa `node_modules/` để cài đặt lại từ đầu |

```bash
# Windows
.\zalo-mcp.ps1 update
.\zalo-mcp.ps1 clean

# macOS / Linux
./zalo-mcp.sh update
./zalo-mcp.sh clean
```

**Tuyệt đối không chạy `npm install` trực tiếp bên trong thư mục `zalo-mcp` đã triển khai** — hãy luôn dùng lệnh `update`. Lệnh này sẽ làm mới các script và `package.json` từ gói `@ardennguyen/zalo-mcp` đã phát hành, sau đó cài đặt bản phát hành npm mới nhất của engine (`@ardennguyen/zalo-agent-cli@latest`) một cách có kiểm soát. Nhờ vậy, môi trường triển khai luôn chạy bản phát hành chính thức chứ không chạy nhánh đang phát triển.

### Các khóa `.env` (bên trong `zalo-mcp/`)

Chỉ giữ `zalo-mcp/.env` **cho cấu hình cổng** (`ZALO_MCP_HTTP_PORT`). Đặt mọi cấu hình thư mục lưu trữ (`ZALO_CREDENTIALS_DIR`, `ZALO_DATA_DIR`, `ZALO_MEDIA_DIR`, `ZALO_OA_DIR`) và cấu hình engine vào `~/.zalo-agent-cli/.env` (`<CONFIG_DIR>/.env`) để `zalo-mcp` và `zalo-agent` luôn dùng chung một cấu hình thống nhất.

| Khóa | Mặc định | Mục đích |
|:---|:---|:---|
| `ZALO_MCP_HTTP_PORT` | `3847` | Cổng mặc định khi chạy `mcp-server.js --http` mà không truyền số cổng |

### Các npm script bên trong wrapper

| Script | Lệnh thực thi |
|:---|:---|
| `npm start` / `npm run mcp` | `node mcp-server.js` (MCP server qua stdio) |
| `npm run login` | `zalo-agent login` — đăng nhập QR cho tài khoản cá nhân |
| `npm run oa:init` | `zalo-agent oa init` — wizard thiết lập Official Account |

---

## Xác thực (Authentication)

Toàn bộ thông tin xác thực đều được lưu cục bộ trên máy của bạn.

### A. Tài khoản Zalo cá nhân (API không chính thức)
```bash
zalo-mcp login   # hoặc: npm run login (từ bên trong thư mục zalo-mcp/)
```
Mã QR sẽ hiển thị trên terminal, đồng thời một HTTP server cục bộ cũng phục vụ mã QR tại `http://127.0.0.1:18927/qr` (chỉ lắng nghe loopback; thêm `--qr-url` để mở trên mọi interface cho máy chủ không có giao diện đồ họa — lưu ý bất kỳ ai truy cập được URL này trước khi QR hết hạn đều có thể đăng nhập vào tài khoản). Quét mã bằng **trình Quét mã QR trong ứng dụng Zalo** (không dùng camera thường của điện thoại) và xác nhận trên điện thoại. Nếu bạn bấm từ chối trên điện thoại, CLI sẽ báo lỗi và thoát ngay thay vì chờ hết 60 giây timeout.

> **Lưu trữ:** `~/.zalo-agent-cli/` (quyền `0600`).
> **Rủi ro:** đây là API không chính thức (qua `zca-js`) — lạm dụng tự động hóa tần suất cao có thể khiến tài khoản bị khóa/ban. Không nên dùng tài khoản cá nhân chính của bạn.

### B. Zalo Official Account (API chính thức v3.0)
```bash
zalo-mcp oa init --app-id <YOUR_APP_ID> --secret <YOUR_APP_SECRET>
```
Làm theo hướng dẫn trên trình duyệt để cấp quyền cho ứng dụng. Đối với VPS không có trình duyệt:
```bash
zalo-mcp oa login --app-id <ID> --secret <KEY> --callback-host https://your-domain.com
```

> **Lưu trữ:** `~/.zalo-agent/oa-credentials.json` (quyền `0600`) — lưu ý đây là **thư mục hoàn toàn khác** với `~/.zalo-agent-cli/` của tài khoản cá nhân.
> Access token của OA hết hạn sau ~25 giờ — làm mới bất kỳ lúc nào bằng `zalo-mcp oa refresh`.

Hướng dẫn chi tiết về OA, cách mở webhook và bảng mã lỗi: [docs/official-account.vi.md](docs/official-account.vi.md) / [English](docs/official-account.md).

---

## Tích hợp AI Agent (MCP)

### Giao thức stdio (cục bộ)

Trỏ AI client của bạn vào lệnh toàn cục `zalo-mcp` (hoặc `zalo-agent mcp start`):

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
*(Hoặc dùng `"command": "node", "args": ["/duong/dan/tuyet/doi/den/zalo-mcp/mcp-server.js"]` nếu lệnh toàn cục không nằm trong `PATH`.)*

Nếu bạn cài CLI toàn cục mà không dùng wrapper, trỏ trực tiếp vào CLI:
```json
{
  "mcpServers": {
    "zalo": { "command": "zalo-agent", "args": ["mcp", "start"] }
  }
}
```

**Cursor / các stdio client khác:** `zalo-mcp` (hoặc `node /duong/dan/tuyet/doi/den/zalo-mcp/mcp-server.js`)

### Giao thức HTTP / HTTPS (remote / VPS / cloud agents)

```bash
zalo-mcp --http 3847                                 # cổng từ tham số, hoặc ZALO_MCP_HTTP_PORT
zalo-mcp --http 3847 --auth <token> --host 0.0.0.0   # truy cập từ xa kèm bearer token
zalo-mcp --http 3847 --auth <token> --host 0.0.0.0 --cert /path/to/fullchain.pem --key /path/to/privkey.pem
```

Bên dưới, lệnh này chạy `zalo-agent mcp start --http <port> [--auth <token>] [--host <addr>] [--cert <path> --key <path>]`. Toàn bộ các flag của `mcp start` đều được hỗ trợ giống hệt nhau qua cả `zalo-mcp` lẫn `zalo-agent mcp start`:

| Flag | Mặc định | Mô tả |
|:---|:---|:---|
| `--account <id>` | Tài khoản active lúc khởi động, sau đó ghim cố định | ID số của tài khoản đã đăng ký cần ghim qua các lần reconnect/retry mà không làm đổi tài khoản active chung |
| `--http <port>` | *(stdio)* | Sử dụng giao thức HTTP (hoặc HTTPS khi có `--cert` và `--key`) trên cổng này |
| `--auth <token>` | `ZALO_MCP_AUTH_TOKEN` trong `.env` | Yêu cầu `Authorization: Bearer <token>` trên mọi endpoint trừ `/health` và các endpoint OAuth discovery/handshake |
| `--host <address>` | `127.0.0.1` | Địa chỉ bind — đặt `0.0.0.0` để nhận kết nối từ xa |
| `--cert <path>` | `tls.cert` trong `mcp-config.json` | Đường dẫn chứng chỉ TLS (PEM) để phục vụ HTTPS trực tiếp qua `https` server của Node (cần `--http` và `--key`; tự động thử bind song song cổng `443` khi `port !== 443`) |
| `--key <path>` | `tls.key` trong `mcp-config.json` | Đường dẫn khóa riêng TLS (PEM) để phục vụ HTTPS trực tiếp (cần `--http` và `--cert`) |
| `--client-id <id>` | `zalo-mcp` (hoặc `ZALO_MCP_OAUTH_CLIENT_ID[_<ownId>]`) | OAuth 2.0 Client ID cho các remote MCP client như Gemini Connected Apps |
| `--client-secret <key>` | `--auth` / `ZALO_MCP_AUTH_TOKEN[_<ownId>]` | OAuth 2.0 Client Secret cho bước đổi token tại `/token` |
| `--issuer-url <url>` | *(suy từ header Host)* | URL gốc OAuth 2.0 issuer tường minh (ví dụ `https://mcp.example.com:3100`) |
| `-w, --webhook <url>` | `webhook` trong `mcp-config.json` | POST mỗi tin nhắn đến (thuộc diện theo dõi) dưới dạng JSON tới URL này (`ZALO_WEBHOOK_URL[_<ownId>]`) |
| `--webhook-secret <secret>` | `webhookSecret` trong `mcp-config.json` | Khóa bí mật để ký các webhook POST bằng `Authorization: Bearer <secret>` + `X-Zalo-Signature: sha256=<hmac>` (`ZALO_WEBHOOK_SECRET[_<ownId>]`; cờ được ưu tiên, rồi biến môi trường, rồi khóa trong cấu hình; cờ để trống bị từ chối; nên dùng biến môi trường vì cờ lộ trong danh sách tiến trình) |
| `--config <path>` | `~/.zalo-agent-cli/mcp-config.json` | Đường dẫn file cấu hình MCP tùy chỉnh |
| `--no-self-heal` | *(bật)* | Tắt cơ chế tự động bù khoảng hở (self-heal) sau khi kết nối lại |
| `--no-delivered-receipts` | *(bật)* | Không gửi báo nhận (`delivered`) cho các tin nhắn đến |
| `-d, --daemon` | `false` | Chạy ngầm trong nền (yêu cầu `--http <port>`; ghi log vào `accounts/<ownId>/daemon.log`) |
| `--stop` | `false` | Dừng tiến trình daemon chạy ngầm của tài khoản này một cách an toàn |
| `--status` | `false` | Xem trạng thái daemon chạy ngầm (PID, cổng channel, đường dẫn log) |

Cấu hình phía client:
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

Kiểm tra trạng thái (không yêu cầu xác thực):
```bash
curl http://localhost:3847/health
# → {"status":"ok","uptime":123,"threads":5}
```

> Việc bind ra `0.0.0.0` mà không đặt `--auth` sẽ phơi bày toàn bộ phiên Zalo của bạn cho bất kỳ ai kết nối được tới cổng đó. Luôn đặt `--auth` khi triển khai từ xa.

Hướng dẫn vận hành máy chủ thực tế (systemd unit, khởi động lại, giám sát, sao lưu, bảo mật) xem tại [docs/deployment.vi.md](docs/deployment.vi.md) / [English](docs/deployment.md).

### Chạy nhiều tài khoản live đồng thời (MCP & CLI)

Mỗi tài khoản cá nhân đã đăng ký có cơ sở dữ liệu SQLite (`<DATA_DIR>/<ownId>/zalo.db`), thư mục media, `daemon.lock` và kênh loopback (`daemon-channel.json`) tách biệt riêng. Bạn có thể chạy **nhiều tài khoản live cùng lúc** bằng cách khởi chạy một MCP server (hoặc `listen` daemon) cho mỗi tài khoản kèm `--account <ownId>`, và truyền `--account <ownId>` (hoặc `ZALO_ACCOUNT=<ownId>`) khi gọi lệnh CLI:

1. **Đăng ký từng tài khoản** (khuyến nghị mỗi tài khoản dùng một proxy riêng):
   ```bash
   zalo-agent account login -p "http://user:pass@proxy1:8080" -n "Shop A"
   zalo-agent account login -p "http://user:pass@proxy2:8080" -n "Shop B"
   zalo-agent account list
   ```
2. **Chạy nhiều stdio MCP server trong Claude Code / Cursor (`~/.claude/settings.json`, dùng ID minh họa `101` và `202`):**
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
3. **Chạy nhiều HTTP MCP server trên VPS (mỗi tài khoản một cổng):**
   ```bash
   zalo-mcp --account 101 --http 3847 --auth <token-a> --host 0.0.0.0
   zalo-mcp --account 202 --http 3848 --auth <token-b> --host 0.0.0.0
   ```
4. **Gọi lệnh CLI song song theo từng tài khoản (không làm thay đổi `accounts.json`):**
   ```bash
   zalo-agent --account 101 msg send <threadId> "Xin chào từ Shop A" --json
   zalo-mcp --account 202 sync --days 7
   ```

### Danh sách 27 MCP tools

Engine này đăng ký **27 MCP tools** trong `src/mcp/mcp-tools.js`, phục vụ cho **tài khoản cá nhân**:

| Tool | Công dụng |
|:---|:---|
| `zalo_get_messages` | Đọc tin nhắn live trong buffer kèm cursor để đọc tăng dần |
| `zalo_send_message` | Gửi văn bản, tệp/ảnh đính kèm (`filePath`/`files`), thẻ xem trước liên kết (`link`), hoặc danh thiếp (`cardUserId`) vào DM hoặc nhóm — hỗ trợ tag `@[uid]`, trả lời trích dẫn, đánh dấu Quan trọng/Khẩn cấp (`urgency`), hoặc `threadId: "me"` cho My Documents |
| `zalo_list_threads` | Liệt kê các hội thoại trong buffer kèm số tin chưa đọc |
| `zalo_search_threads` | Tìm kiếm hội thoại theo tên (fuzzy, không phân biệt dấu tiếng Việt) |
| `zalo_mark_read` | Đánh dấu đã đọc các tin trong buffer đến một cursor cho một consumer (toàn cục, không xóa dữ liệu khỏi buffer nên nhiều bot có thể dùng chung một server) |
| `zalo_get_history` | Đọc lịch sử tin nhắn cũ: ưu tiên đọc từ cache cục bộ trước, sau đó mới hỏi server Zalo, có phân trang |
| `zalo_view_media` | Mở tệp ảnh/audio/video đã nhận (tự tải xuống trước nếu chưa có trên đĩa) |
| `zalo_react` | Thả cảm xúc vào tin nhắn (`/-strong`, `/-heart`, `:>`, …), giống `msg react` — từ chối nếu thiếu `cliMsgId` ở cả tham số lẫn cache |
| `zalo_undo` | Thu hồi tin nhắn của chính bạn ở cả hai phía, giống `msg undo`; cùng quy tắc `cliMsgId` |
| `zalo_get_group_members` | Liệt kê thành viên nhóm — `uid` và tên hiển thị — giống `group members` |
| `zalo_list_conversations` | Liệt kê các hội thoại gần đây từ cache cục bộ, mới nhất trước, giống `conv recent` |
| `zalo_coverage` | Chỉ đọc: kiểm tra các khoảng hở (coverage gaps) đang chờ trong cache, số khoảng đã đóng, và lệnh `zalo-agent sync --from <date>` để khôi phục |
| `zalo_sync` | Khởi chạy khôi phục tin nhắn hoặc đồng bộ cảm xúc khi chủ tài khoản yêu cầu; trả về ngay mã công việc (`jobId`). Khôi phục tin nhắn vẫn cần xác nhận trên điện thoại |
| `zalo_sync_status` | Xem tiến độ và kết quả đồng bộ |
| `zalo_search_messages` | Tìm kiếm nội dung văn bản tin nhắn trên toàn bộ cache SQLite cục bộ (`zalo.db`), không gọi mạng |
| `zalo_lookup_user` | Tra cứu người dùng Zalo theo số điện thoại, username, `userId`, hoặc xem hồ sơ tài khoản đang đăng nhập (`self: true`) |
| `zalo_forward_message` | Chuyển tiếp một tin nhắn đã có trong cache (`msgId`) sang DM hoặc nhóm khác (tương đương `msg forward`) |
| `zalo_delete_message` | Xóa tin nhắn ở phía bạn (`everyone: false`) hoặc xóa với mọi người trong nhóm (`everyone: true`) |
| `zalo_reminder` | Tạo, liệt kê, xem chi tiết, xem phản hồi, sửa hoặc xóa nhắc hẹn trong DM hoặc nhóm |
| `zalo_note` | Tạo/sửa ghi chú nhóm, liệt kê bảng tin nhóm, hoặc ghim/bỏ ghim tin nhắn văn bản trong cache |
| `zalo_poll` | Tạo, xem chi tiết, bình chọn, rút bình chọn, thêm phương án, khóa hoặc chia sẻ bình chọn nhóm |
| `zalo_wait_for_message` | Chờ tin nhắn mới tiếp theo trong buffer theo cơ chế long-poll (0% CPU, không cần vòng lặp polling; tương đương `GET /events/wait`) |
| `zalo_label` | Liệt kê, gắn, gỡ hoặc cập nhật nhãn hội thoại (ví dụ `"Nội bộ"`, `"Khách hàng"`, `"Đối tác"`) |
| `zalo_group` | Rời nhóm (có thể rời im lặng), xem thông tin nhóm, tạo nhóm, thêm hoặc xóa thành viên |
| `zalo_friend` | Trạng thái kết bạn, lời mời đã gửi / đã nhận, gửi / chấp nhận / từ chối / huỷ lời mời, danh sách bạn bè |
| `zalo_read` | Chạy một endpoint chỉ-đọc của Zalo Web mà không tool nào khác phủ tới (danh mục sticker và GIF, tìm GIF, hạng hồ sơ, danh sách chặn, biệt danh, trạng thái…), hoặc liệt kê chúng |
| `zalo_write` | Thực hiện một lời gọi thay đổi trạng thái của Zalo Web mà không tool nào khác phủ tới (RSVP nhắc hẹn, ghi chú và nhắc hẹn nhóm có lặp lại, ghim, todo, thu hồi nhiều tin…), hoặc liệt kê chúng; gọi thật cần `confirm: true`, `dryRun: true` để xem yêu cầu |

Xem thêm [Chi tiết sử dụng đồng bộ qua MCP](docs/mcp-sync.vi.md) / [English](docs/mcp-sync.md).

Các tính năng Official Account (`oa`), danh mục sản phẩm (`catalog`), trả lời tự động (`auto-reply`), tin nhắn nhanh (`quick-msg`), hồ sơ (`profile`), quản lý bạn bè ngoài lời mời kết bạn và danh sách bạn (`friend`; hai phần đó đã có trong `zalo_friend`), quản trị nhóm nâng cao ngoài rời nhóm, xem thông tin, tạo nhóm và thêm/xóa thành viên (`group`; các thao tác đó đã có trong `zalo_group`), và quản lý tài khoản (`account`) **chỉ có trên CLI** — chưa có MCP tool riêng. AI agent có thể sử dụng chúng bằng cách gọi `zalo-agent <lệnh> --json` (hoặc `zalo-mcp <lệnh> --json`).

Tham chiếu đầy đủ về MCP tools (tham số, cấu trúc trả về, cấu hình): [skill/references/mcp-guide.md](skill/references/mcp-guide.md).

### Cấu hình MCP (`mcp-config.json`)

File tùy chọn tại `~/.zalo-agent-cli/mcp-config.json` — được gộp nông (shallow-merge) theo từng khóa cấp cao nhất với cấu hình mặc định:

```json
{
  "watchThreads": ["dm:*", "group:*"],
  "notify": { "enabled": false, "thread": null, "on": ["dm"], "cooldown": "5m" },
  "limits": { "maxMessagesPerPoll": 20, "bufferMaxAge": "2h", "bufferMaxSize": 500 },
  "media": { "downloadDir": null, "autoOpen": true }
}
```

Bảng đầy đủ các trường và giá trị mặc định: [skill/references/mcp-guide.md](skill/references/mcp-guide.md).

---

## Cấu trúc lưu trữ cục bộ

Mặc định, mọi dữ liệu do CLI lưu trữ nằm dưới `~/.zalo-agent-cli/` (tài khoản cá nhân) và `~/.zalo-agent/` (Official Account). Trong môi trường production, từng thư mục có thể được tách sang ổ đĩa hoặc mount point riêng thông qua các global flag hoặc biến môi trường:

| Tầng lưu trữ | Vị trí mặc định | Flag CLI | Biến môi trường |
|:---|:---|:---|:---|
| Cấu hình & danh sách tài khoản (`accounts.json`, `mcp-config.json`, `qr.png`) | `~/.zalo-agent-cli/` | `--config-dir <dir>` | `ZALO_CONFIG_DIR` |
| Thông tin phiên đăng nhập (`cred_<ownId>.json`, quyền `0600`) | `<CONFIG_DIR>/credentials/` | `--credentials-dir <dir>` | `ZALO_CREDENTIALS_DIR` |
| Cơ sở dữ liệu & trạng thái runtime theo tài khoản (`<ownId>/zalo.db`, `daemon.lock`, `daemon-channel.json`) | `<CONFIG_DIR>/accounts/` | `--data-dir <dir>` | `ZALO_DATA_DIR` *(hoặc `ZALO_DB_DIR`)* |
| Media đã tải xuống (`<threadId>/`, `_conversations.json`) | `<DATA_DIR>/<ownId>/media/` | `--media-dir <dir>` | `ZALO_MEDIA_DIR` |
| Thông tin xác thực Official Account (`oa-credentials.json`, quyền `0600`) | `~/.zalo-agent/` | `--oa-dir <dir>` | `ZALO_OA_DIR` |

Cấu trúc mặc định khi không đặt đường dẫn tùy chỉnh:

```
~/.zalo-agent-cli/
├── accounts.json                  # Danh sách tài khoản (0600)
├── credentials/cred_<ownId>.json  # Thông tin phiên của từng tài khoản (0600)
├── mcp-config.json                # Cấu hình MCP tùy chọn
├── accounts/<ownId>/
│   ├── zalo.db                    # Bộ nhớ đệm tin nhắn/hội thoại SQLite (WAL)
│   ├── media/                     # Media tải về bởi `listen` / `msg` / `mcp` (theo tài khoản)
│   ├── sync/                      # Dữ liệu tạm của sync (bộ đệm giao thức của lần khôi phục từ điện thoại)
│   └── daemon.lock                # Khóa giữ bởi daemon `listen`/`mcp start` đang chạy
└── qr.png                         # Mã QR đăng nhập gần nhất
```

> [!NOTE]
> **Một thư mục media, một bố cục thống nhất.** Mọi lệnh — `listen`, `msg history`, `mcp start`, `sync-media`, `sync-mobile` và các MCP tools — đều ghi vào `<mediaRoot>/<threadId>/` (mặc định là `accounts/<ownId>/media/<threadId>/`, hoặc `--media-dir` / `ZALO_MEDIA_DIR` toàn cục). Tên thư mục luôn là `threadId`, không bao giờ dùng tên hội thoại vì tên có thể chứa ký tự phân tách đường dẫn hoặc thay đổi khi đổi tên nhóm; `_conversations.json` ánh xạ ID sang tên. Trường `media.downloadDir` trong `mcp-config.json` cũng có thể ghi đè thư mục gốc media cho riêng MCP server.

> [!WARNING]
> **Thư mục tùy chỉnh `--media-dir` / `ZALO_MEDIA_DIR` hoặc `media.downloadDir` KHÔNG bị xóa bởi `logout --purge` hay `account remove`.** Hai lệnh đó chỉ xóa `<DATA_DIR>/<ownId>/` — bao gồm thư mục media mặc định bên trong — cùng file credential. Nếu bạn đặt thư mục media nằm ngoài thư mục tài khoản, các tệp đính kèm ở đó vẫn còn nguyên sau khi purge. Hãy tự xóa thư mục đó bằng tay khi cần gỡ bỏ hoàn toàn dữ liệu vì lý do riêng tư.

Thông tin xác thực Official Account được lưu riêng tại `~/.zalo-agent/oa-credentials.json` (hoặc `<ZALO_OA_DIR>/oa-credentials.json`).

---

## Tham chiếu nhanh lệnh CLI (qua `npx zalo-agent <lệnh>`)

Thêm `--json` vào bất kỳ lệnh nào để nhận kết quả JSON phục vụ tự động hóa. Dưới đây là các lệnh tiêu biểu — tài liệu tham chiếu đầy đủ cho toàn bộ 227 lệnh nằm tại [skill/references/command-reference.md](skill/references/command-reference.md).

### Phiên đăng nhập & bảo trì
| Lệnh | Mô tả |
|:---|:---|
| `npx zalo-agent status` | Kiểm tra trạng thái đăng nhập |
| `npx zalo-agent whoami` | Xem hồ sơ đầy đủ của tài khoản đang đăng nhập |
| `npx zalo-agent login [--qr-url] [--credentials <path>] [-p <proxy>] [--sync [--sync-days <n>]]` | Đăng nhập QR, hoặc khôi phục từ file credentials đã xuất. `--sync` khôi phục lịch sử ngay sau khi đăng nhập QR bằng khóa auto sync của điện thoại (tích "auto sync" trên điện thoại; không cần chạm xác nhận) |
| `npx zalo-agent logout [--delete-history] [--purge] [--no-remote] [--keep-session]` | Đăng xuất thiết bị khỏi Zalo (như Zalo Web) và xóa credentials đã lưu; `--keep-session` chỉ kết thúc khóa phiên (cách cũ trước v3.0, khi đó phiên chỉ kết thúc hẳn nếu gỡ thiết bị trong danh sách trên điện thoại); tùy chọn xóa cache cục bộ hoặc xóa sạch dữ liệu tài khoản |
| `npx zalo-agent sync-mobile [-d <days>]` | **Khôi phục lịch sử tin nhắn từ điện thoại** vào cache cục bộ (xác nhận một lần trên điện thoại). Mặc định lấy toàn bộ lịch sử; `-d/--days <n>` giới hạn trong *n* ngày gần nhất |
| `npx zalo-agent update` | Tự cập nhật lên phiên bản mới nhất đã phát hành |
| `npx zalo-agent mcp start [--http <port>] [--auth <token>] [--host <addr>]` | Khởi chạy MCP server |
| `npx zalo-agent mcp wait [since] [-t <threadId>] [--timeout <s>] [-n <count>] [--settle <ms>] [-c <name>]` | Long-poll chờ tin nhắn mới từ buffer của `mcp start` đang chạy (tương đương `zalo_wait_for_message`) |
| `npx zalo-agent mcp mark-read <cursor> [-c <name>]` | Đánh dấu đã đọc tới `<cursor>` trong buffer của `mcp start` đang chạy (tương đương `zalo_mark_read`) |

### Tài khoản cá nhân
| Lệnh | Mô tả |
|:---|:---|
| `npx zalo-agent msg send <threadId> "text" [-t 1]` | Gửi tin nhắn văn bản (DM, hoặc nhóm với `-t 1`) |
| `npx zalo-agent msg send-image <threadId> <path>` | Gửi hình ảnh |
| `npx zalo-agent msg send-file <threadId> <path>` | Gửi tệp đính kèm |
| `npx zalo-agent msg history <threadId> [-t 1] [-n 50] [--no-cache]` | Xem lịch sử tin nhắn (đọc từ cache cục bộ trừ khi có `--no-cache`) |
| `npx zalo-agent msg undo <msgId> <threadId> -c <cliMsgId>` | Thu hồi tin nhắn ở cả hai phía |
| `npx zalo-agent friend list` / `friend find <phone>` | Danh sách / tìm kiếm bạn bè |
| `npx zalo-agent group list [-q <text>]` / `group members <groupId>` | Danh sách nhóm / thành viên nhóm |
| `npx zalo-agent conv recent [-n 20]` | Liệt kê các hội thoại gần đây kèm `threadId` |
| `npx zalo-agent account devices` | Xem danh sách thiết bị/phiên đang liên kết với tài khoản |
| `npx zalo-agent account remove <ownerId>` | Hủy phiên từ xa, xóa sạch dữ liệu cục bộ và xóa credentials |
| `npx zalo-agent listen [--webhook <url>] [--save <dir>]` | Lắng nghe thời gian thực, chuyển tiếp webhook và lưu trữ JSONL |
| `npx zalo-agent msg send-qr-transfer <id> <acct> --bank <alias> -a <amount>` | Gửi mã QR chuyển khoản VietQR |

### Official Account (OA)
| Lệnh | Mô tả |
|:---|:---|
| `npx zalo-agent oa whoami` | Xem thông tin hồ sơ OA |
| `npx zalo-agent oa msg text <userId> "text"` | Gửi tin nhắn OA cho người quan tâm (follower) |
| `npx zalo-agent oa follower list` | Danh sách follower của OA |
| `npx zalo-agent oa tag assign <userId> <tag>` | Gắn tag cho follower |
| `npx zalo-agent oa upload image <path>` | Tải ảnh lên OA, trả về `attachment_id` |
| `npx zalo-agent oa listen -p <port> [-s <secret>]` | Khởi chạy webhook listener cục bộ cho OA |
| `npx zalo-agent oa refresh` | Làm mới access token của OA |

Tham chiếu đầy đủ: [skill/references/command-reference.md](skill/references/command-reference.md) và [docs/official-account.vi.md](docs/official-account.vi.md).

---

## Biến môi trường

`zalo-agent` tự động nạp các file `.env` (qua `util.parseEnv` của Node 22, không ghi đè các biến môi trường đã có sẵn trong shell) theo thứ tự ưu tiên:
1. `--env-file <path>` (hoặc `ZALO_ENV_FILE`)
2. `./.env` tại thư mục làm việc hiện tại
3. `<CONFIG_DIR>/.env` (mặc định `~/.zalo-agent-cli/.env`)

> [!TIP]
> **Cách phân tách `.env` khuyến nghị:** Chỉ giữ cấu hình cổng trong `zalo-mcp/.env` (`ZALO_MCP_HTTP_PORT`), và đặt mọi đường dẫn lưu trữ (`ZALO_CREDENTIALS_DIR`, `ZALO_DATA_DIR`, `ZALO_MEDIA_DIR`, `ZALO_OA_DIR`) cùng cấu hình engine trong `~/.zalo-agent-cli/.env` (`<CONFIG_DIR>/.env`). Nhờ đó cả `zalo-mcp` và `zalo-agent` đều đọc đúng cùng một đường dẫn dù chạy từ bất kỳ thư mục nào.

Xem file mẫu tại [`.env.example`](.env.example).

| Biến môi trường | Tác dụng |
|:---|:---|
| `ZALO_ACCOUNT` | ID số của tài khoản cá nhân đã đăng ký cần ghim cho tiến trình hiện tại (`listen`, `mcp start`, hoặc bất kỳ lệnh CLI cá nhân nào; tương đương `--account <id>`) mà không sửa `accounts.json` |
| `ZALO_ENV_FILE` | Đường dẫn tới file `.env` tùy chỉnh cần nạp lúc khởi động (tương đương `--env-file <path>`) |
| `ZALO_CONFIG_DIR` | Thư mục gốc chứa `accounts.json`, `mcp-config.json` và `qr.png` (mặc định `~/.zalo-agent-cli`; tương đương `--config-dir`) |
| `ZALO_CREDENTIALS_DIR` | Thư mục chứa các file phiên đăng nhập cá nhân `cred_<ownId>.json` (mặc định `<CONFIG_DIR>/credentials`; tương đương `--credentials-dir`) |
| `ZALO_DATA_DIR` / `ZALO_DB_DIR` | Thư mục gốc chứa dữ liệu từng tài khoản `<ownId>/zalo.db`, `daemon.lock` và `daemon-channel.json` (mặc định `<CONFIG_DIR>/accounts`; tương đương `--data-dir`) |
| `ZALO_MEDIA_DIR` | Thư mục gốc chứa media tải về `<threadId>/` và `_conversations.json` cho mọi lệnh (mặc định `<DATA_DIR>/<ownId>/media`; tương đương `--media-dir`) |
| `ZALO_OA_DIR` | Thư mục chứa `oa-credentials.json` của Official Account (mặc định `~/.zalo-agent`; tương đương `--oa-dir`) |
| `ZALO_AGENT_NO_UPDATE_CHECK` | Đặt bất kỳ giá trị nào để tắt kiểm tra phiên bản mới chạy ngầm |
| `ZALO_API_VERSION` | Phiên bản giao thức công bố với Zalo (`zpw_ver` / `client_version`) trên cả HTTP và WebSocket. Mặc định `694` (giá trị Zalo Web hiện tại); đặt `685` nếu muốn quay về mặc định cũ của `zca-js`. Phải là số nguyên dương hợp lệ. |
| `ZALO_QR_FLOW` | Cách `login` đăng nhập bằng QR: `official` (mặc định: đúng trình tự Zalo Web, không gọi `verify-client`, `continue=https://chat.zalo.me/`, chuyển hướng phiên qua `jr.zaloapp.com` và `jr.chat.zalo.me`, kèm mã QR thứ hai mà tài khoản có thiết bị tin cậy phải quét, khiến client này thành một thiết bị tin cậy đi kèm) hoặc `legacy` (của zca-js). Giá trị khác bị từ chối trước khi liên hệ Zalo. Chỉ đăng nhập QR đọc biến này |
| `ZALO_NET_PROBE` | Thứ daemon hỏi để biết mạng còn hoạt động hay không khi socket đang đứt (mỗi 10 giây). Một URL, mặc định là một trang nhẹ của công cụ tìm kiếm toàn cầu; `off` coi như mạng luôn hoạt động và không liên hệ nơi nào ngoài Zalo |
| `ZALO_JSON_MODE` | Được CLI tự động đặt ở chế độ `--json` và `mcp` để chặn log stdout của `zca-js`. Không cần tự đặt bằng tay |
| `ZALO_MCP_HTTP_PORT` | Cổng fallback cho `--http` của `mcp start` và wrapper `zalo-mcp` (hỗ trợ hậu tố theo tài khoản `ZALO_MCP_HTTP_PORT_<ownId>`) |
| `ZALO_MCP_HOST` | Địa chỉ bind mặc định cho `mcp start --http` (hỗ trợ `ZALO_MCP_HOST_<ownId>`) |
| `ZALO_MCP_AUTH_TOKEN` | Bearer token cho `mcp start --http` và làm OAuth 2.0 client secret dự phòng (hỗ trợ `ZALO_MCP_AUTH_TOKEN_<ownId>`) |
| `ZALO_MCP_OAUTH_CLIENT_ID` | OAuth 2.0 Client ID cho `mcp start --http` (mặc định `zalo-mcp`; hỗ trợ `ZALO_MCP_OAUTH_CLIENT_ID_<ownId>`) |
| `ZALO_MCP_OAUTH_CLIENT_SECRET` | OAuth 2.0 Client Secret cho `mcp start --http` (hỗ trợ `ZALO_MCP_OAUTH_CLIENT_SECRET_<ownId>`) |
| `ZALO_MCP_ISSUER_URL` | URL gốc OAuth 2.0 issuer tường minh cho `mcp start --http` (hỗ trợ `ZALO_MCP_ISSUER_URL_<ownId>`) |
| `ZALO_MCP_TLS_CERT` / `ZALO_MCP_TLS_KEY` | Đường dẫn chứng chỉ và khóa riêng PEM cho HTTPS gốc trên `mcp start --http` (hỗ trợ `_*_<ownId>`) |
| `ZALO_WEBHOOK_URL` / `ZALO_WEBHOOK_SECRET` | URL webhook mặc định và khóa ký (`Authorization: Bearer` + `X-Zalo-Signature: sha256=<hmac>`) cho `listen` và `mcp start` (hỗ trợ `_*_<ownId>`) |
| `ZALO_WEBHOOK_BATCH_SIZE` / `ZALO_WEBHOOK_MAX_AGE` | Số sự kiện mỗi POST webhook (1–100, mặc định 1) và thời gian thử lại một sự kiện chưa giao được trước khi chuyển vào dead-letter (mặc định `24h`). Cả hai hỗ trợ `_<ownId>`. Webhook bền vững: xem `zalo-agent mcp webhook status` |
| `ZALO_LOG_LEVEL` / `ZALO_LOG_FORMAT` / `ZALO_LOG_MAX_SIZE` / `ZALO_LOG_KEEP` | `daemon.log` của `listen` và `mcp start`: mức `error`, `warn`, `info` (mặc định) hoặc `debug` (thêm một dòng cho mỗi HTTP request và mỗi tin nhắn; cũng có `--log-level`), dòng `text` hoặc `json`, và xoay vòng ở `50m` giữ 3 file |
| `ZALO_START_JITTER` / `ZALO_LOGIN_SLOTS` / `ZALO_LOGIN_SLOT_WAIT` | Rải thời điểm khởi động của một đội daemon: chờ ngẫu nhiên 0–N giây trước khi đăng nhập, và chỉ cho tối đa N daemon trên máy đăng nhập cùng lúc (daemon vượt giới hạn sẽ chờ, rồi cứ tiếp tục sau `ZALO_LOGIN_SLOT_WAIT` giây). Tắt theo mặc định |
| `ZALO_SEND_FORMAT` | `markdown` hoặc `plain`: cách gửi tin nhắn văn bản. `zalo_send_message` mặc định chuyển Markdown thành định dạng của Zalo; `msg send` gửi nguyên văn trừ khi có `--markdown` (hoặc biến này) |

---

## Khắc phục sự cố (Troubleshooting)

| Hiện tượng | Nguyên nhân / cách xử lý |
|:---|:---|
| MCP client không hiện tool nào, hoặc ngắt kết nối ngay lập tức | Có nội dung in ra stdout. Ở chế độ stdio, stdout là kênh truyền JSON-RPC — hãy kiểm tra log stderr để xem lỗi thực sự |
| `Duplicate Zalo Web session detected. Exiting.` | Zalo chỉ cho phép 1 WebSocket trên mỗi tài khoản. Hãy đóng tab Zalo Web trên trình duyệt và không chạy `listen` cùng lúc với `mcp start` trên cùng một tài khoản |
| `logout` / `account remove` từ chối kèm số PID | Một tiến trình daemon `listen` hoặc `mcp start` đang giữ `daemon.lock` của tài khoản đó. Hãy dừng daemon trước (`--stop`) |
| `Thread name cache not initialized yet` khi gọi `zalo_search_threads` | Bộ nhớ đệm tên hội thoại đang được xây dựng lúc khởi động MCP bằng cách tải danh sách nhóm + bạn bè. Thử lại sau vài giây |
| Không kết nối được tới HTTP MCP server từ máy khác | Mặc định `--http` chỉ bind vào `127.0.0.1` (loopback). Hãy truyền `--host 0.0.0.0 --auth <token>` (hỗ trợ trên cả `zalo-mcp` và `zalo-agent mcp start`) |
| `zalo_view_media` lưu file ở nơi khác ngoài `accounts/<ownId>/media/<threadId>/` | Xảy ra khi đã đặt `--media-dir` / `ZALO_MEDIA_DIR`, hoặc đặt `media.downloadDir` trong `mcp-config.json`. Nếu để trống, server dùng chung thư mục theo tài khoản với mọi lệnh khác |
| `sync-mobile` không trả về tin nào và điện thoại không hiện thông báo xác nhận | Bạn đã truyền `--socket` (chỉ hỏi vùng đệm phía server thay vì hỏi điện thoại). Hãy bỏ flag `--socket` |
| Lệnh OA báo lỗi `-216` | Access token đã hết hạn → chạy `npx zalo-agent oa refresh` |
| Lệnh OA báo lỗi `-224` | Gói dịch vụ OA chưa đủ cấp độ → xem [zalo.cloud/oa/pricing](https://zalo.cloud/oa/pricing) |
| Không thấy thông báo có phiên bản mới | Thông báo kiểm tra phiên bản tự động bỏ qua khi stdout không phải TTY, khi dùng `--json`, hoặc khi đặt `ZALO_AGENT_NO_UPDATE_CHECK` |

---

## Phương án dự phòng khi npm Registry gặp sự cố

Nếu gói `@ardennguyen/zalo-agent-cli` tạm thời không tải được từ npm, lệnh `update` sẽ không dùng được vì cả hai bước của nó đều đọc từ npm registry. Khi đó, như một ngoại lệ chủ đích, bạn có thể cài trực tiếp engine từ mã nguồn trên GitHub bên trong thư mục triển khai:
```bash
npm install github:ardennguyen/zalo-agent-cli
```
Lần chạy `update` tiếp theo sẽ đưa thư mục quay lại bản phát hành chính thức trên npm.

---

## Tài liệu tham khảo thêm

Tham chiếu lệnh đầy đủ, chi tiết thiết lập MCP, cơ chế bộ nhớ đệm cục bộ, Official Account API và nhiều hướng dẫn khác — song ngữ Anh & Việt:
**[Wiki → github.com/ardennguyen/zalo-agent-cli/wiki](https://github.com/ardennguyen/zalo-agent-cli/wiki)**
