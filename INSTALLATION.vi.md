# Hướng dẫn Cài đặt Zalo MCP Server & CLI

[English](INSTALLATION.md)

Tài liệu này hướng dẫn triển khai bộ wrapper **`zalo-mcp`** — bộ cài đặt đóng gói độc lập (sandboxed) tự động tải về engine `zalo-agent-cli` và vận hành nó dưới dạng Model Context Protocol (MCP) server, giúp các AI agent (Claude Code, Cursor, Google Gemini và các client khác) tự động hóa Zalo cá nhân & Official Account mà không làm ảnh hưởng đến môi trường hệ thống toàn cục.

> Nếu bạn chỉ cần dùng CLI (không cần MCP server), có thể cài trực tiếp bằng `npm install -g @ardennguyen/zalo-agent-cli` — xem [README.md](README.md).

---

## Mối quan hệ giữa hai repository

- **`zalo-agent-cli`** (repo này) — engine cốt lõi. Toàn bộ logic API, xác thực và mã nguồn MCP server (`src/mcp/`) nằm tại đây. Từ 3.0.0 engine giao tiếp với Zalo bằng phần cài đặt giao thức Zalo của chính nó (`src/zalo/`), không còn zca-js.
- **`zalo-mcp`** — bộ wrapper triển khai gọn nhẹ (repo riêng: [github.com/ardennguyen/zalo-mcp](https://github.com/ardennguyen/zalo-mcp)). Repo này không chứa code engine; script cài đặt của nó tải `zalo-agent-cli` vào thư mục cục bộ cô lập, liên kết lệnh toàn cục `zalo-mcp` và `zalo-agent`, đồng thời tạo file `.env` để AI client có thể chạy ngay. Khi gọi không kèm lệnh con (`zalo-mcp` hoặc `node mcp-server.js`), nó khởi chạy `zalo-agent mcp start` và chuyển tiếp toàn bộ các flag của `mcp start` (`--account`, `--http`, `--auth`, `--host`, `--cert`, `--key`, `--client-id`, `--client-secret`, `--public-url`, `--issuer-url`, `-w`/`--webhook`, `--webhook-secret`, `--config`, `--no-self-heal`, `--no-delivered-receipts`, `-d`/`--daemon`, `--stop`, `--status`, cùng các flag lưu trữ toàn cục); khi gọi kèm lệnh con CLI (`zalo-mcp login`, `zalo-mcp --account <ID> msg list --json`, `zalo-mcp sync`, …), nó chuyển tiếp trực tiếp các tham số sang `zalo-agent`.

Vì wrapper hoạt động theo cơ chế chuyển tiếp nguyên vẹn (pass-through), **danh sách MCP tool được quyết định hoàn toàn bởi `src/mcp/mcp-tools.js` trong repo này** — theo đúng phiên bản `zalo-agent-cli` đang cài trong `zalo-mcp`.

> [!NOTE]
> Một thư mục `zalo-mcp` đã triển khai sẽ chạy phiên bản `@ardennguyen/zalo-agent-cli` nằm trong `node_modules/` của nó. Kiểm tra bằng:
> ```bash
> node -p "require('./node_modules/@ardennguyen/zalo-agent-cli/package.json').version"
> ```
> Chạy `./zalo-mcp.sh update` (hoặc `.\zalo-mcp.ps1 update`) để cập nhật lên phiên bản engine mới nhất đã phát hành trên npm.

---

## Nâng cấp từ 2.5.9 lên 3.0

Engine 3.0.0 thay zca-js bằng phần cài đặt giao thức Zalo của chính dự án; wrapper `zalo-mcp` 2.1.0 cần bản này. **3.0 mã hóa những gì 2.x để ở dạng rõ, và việc này chỉ đi một chiều**, nên hãy làm đúng thứ tự:

1. **Dừng mọi tiến trình 2.x** dùng thư mục này (`listen`, `mcp start`, dịch vụ `zalo-mcp`, `sync` chạy theo lịch), trên máy này và trên bất kỳ máy nào khác đang chạy một bản sao của cùng phiên đăng nhập.
2. **Sao lưu thư mục dữ liệu khi còn ở dạng rõ** — `~/.zalo-agent-cli/`, cùng các thư mục `--credentials-dir` / `--data-dir` / `--media-dir` nếu bạn đã tách ra — trước khi chạy bất kỳ lệnh 3.0 nào. Đây là đường duy nhất để quay về 2.5.9, và nó chứa phiên đăng nhập ở dạng rõ: giữ nó cẩn thận như chính tài khoản, và xóa đi khi 3.0 đã chạy ổn.
3. **Cập nhật** (`./zalo-mcp.sh update`, `.\zalo-mcp.ps1 update` hoặc `npm install -g @ardennguyen/zalo-agent-cli`). Trên máy chủ Linux không có keyring của desktop, hãy chọn bộ cung cấp khóa trước (file passphrase, systemd-creds hoặc KMS: [docs/security.vi.md](docs/security.vi.md)).
4. **Chạy `zalo-agent account security migrate --all`** (hoặc cứ dùng 3.0 bình thường: mỗi lệnh niêm phong những gì nó mở tới). Lệnh này niêm phong phiên đăng nhập và các file nhỏ, mã hóa `zalo.db` của từng tài khoản (SQLCipher; khoảng 1 giây cho mỗi 20 MB, cần trống khoảng 1,1 lần dung lượng của nó) và hàng đợi webhook, rồi niêm phong media (không chạy `migrate` thì daemon đang chạy sẽ niêm phong media cũ dần trong nền). Từ đó **2.5.9 không đọc được gì nữa**, và không có lệnh nào ghi ngược lại ra dạng rõ. `zalo-agent account security status --all` cho biết đã xong những gì.
5. **Không bao giờ chạy bản sao lưu và bản đã nâng cấp cùng lúc**, trên máy này hay máy khác: đó là hai bản sao của một phiên đăng nhập và chúng sẽ đá nhau ra.

Sau đó kiểm tra các thay đổi phá vỡ tương thích:

- **Cơ sở dữ liệu tin nhắn được mã hóa.** Bot nào mở trực tiếp `zalo.db` sẽ gặp `file is not a database`; hãy chuyển sang `zalo-agent db query` / `db export` hoặc các công cụ MCP.
- **Lệnh CLI phá hủy cần `--yes`** (`msg undo`, `group leave`, `logout`, `account export`, …): thiếu `--yes` thì không gửi gì và thoát với mã 2; `--dry-run` cho xem trước.
- **Thao tác MCP được bảo vệ cần `confirm: true`** (`zalo_undo`, `zalo_delete_message`, `zalo_group` `leave`, …). `confirmMode` trong `mcp-config.json` (hoặc `ZALO_MCP_CONFIRM_MODE`, hoặc chính sách runtime) quyết định ai xác nhận: `agent` (mặc định), `human` (máy chủ hỏi người dùng: qua MCP elicitation khi chạy stdio, hoặc qua trang duyệt dùng một lần có link trong kết quả, dùng được cả qua HTTP) hoặc `off`. `groupConfirm` / `ZALO_MCP_GROUP_CONFIRM` vẫn dùng được như bí danh cũ của `off`.
- **Tên trong MCP:** `msgId` (không còn `id`/`messageId`), `userId` (không còn `uid`), `threadType` là `"dm"` hoặc `"group"` (số bị từ chối), và mọi id là chuỗi. `senderName` giờ là tên gợi nhớ (alias) chủ tài khoản đặt; tên Zalo gốc nằm ở `senderZaloName`.
- **Hiện diện on-demand là mặc định của `mcp start --http` và `listen --daemon`**: xem [Hiện diện on-demand](#hiện-diện-on-demand). Đặt `presence.mode: "always-on"` ở nơi webhook phải chạy theo thời gian thực.
- **Bị đá ra không còn làm daemon on-demand dừng**: nó nhường tài khoản (`YIELDED`) cho tới khi bạn chạy `zalo-agent presence resume --yes`. **Zalo liên tục từ chối đăng nhập cũng không còn làm daemon nào dừng**: nó vẫn chạy ở trạng thái `signed_out` cho tới khi tài khoản được thêm lại bằng QR; `ZALO_EXIT_ON_SIGNED_OUT=1` giữ lại mã thoát 4 như cũ.
- **Rời nhóm thì lịch sử nhóm trên máy bị xóa** (cả khi tài khoản bị xóa hoặc bị chặn khỏi nhóm, hay nhóm bị giải tán), như ứng dụng Zalo; muốn giữ thì đặt `groups.onLeave: "keep"` trong `storage.json` (hoặc `ZALO_GROUPS_ON_LEAVE=keep`) trước khi nâng cấp.
- **`ZALO_QR_FLOW=legacy` đã bị bỏ**; xóa khỏi `.env`.
- **Lệnh CLI thất bại thoát với mã 1** (trước đây phần lớn thoát với mã 0). Mã thoát: 0 thành công, 1 thất bại, 2 cần xác nhận, 3 daemon always-on bị đá ra (phiên khác chiếm tài khoản), 4 Zalo liên tục từ chối phiên đăng nhập đã lưu (daemon chỉ thoát với mã 4 khi có `ZALO_EXIT_ON_SIGNED_OUT=1`). Với `--json`, lỗi là `{"error": …}`, và stdout luôn là một object hoặc mảng JSON.

Danh sách đầy đủ trong [CHANGELOG](CHANGELOG.md).

---

## Yêu cầu hệ thống

- **Node.js** 22.19 trở lên (trường `engines` của CLI yêu cầu `>=22.19.0`, mức sàn do hai thư viện phụ thuộc `undici` và `commander` đặt ra ở 22.19 và 22.12)
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
Mã QR sẽ hiển thị trên terminal, đồng thời một HTTP server cục bộ cũng phục vụ mã QR tại `http://127.0.0.1:18927/qr` (chỉ lắng nghe loopback; thêm `--qr-url` để mở trên mọi interface cho máy chủ không có giao diện đồ họa — lưu ý bất kỳ ai truy cập được URL này trước khi QR hết hạn đều có thể đăng nhập vào tài khoản). Khi đứng sau reverse proxy, `--public-url <url>` (hoặc `ZALO_MCP_PUBLIC_URL`) in ra trang dùng một lần `<url>/zalo/qr/<token>` thay thế. Quét mã bằng **trình Quét mã QR trong ứng dụng Zalo** (không dùng camera thường của điện thoại) và xác nhận trên điện thoại. Nếu bạn bấm từ chối trên điện thoại, CLI sẽ báo lỗi và thoát ngay thay vì chờ hết 60 giây timeout.

Sau khi đăng nhập QR:

- **Ô "Đồng bộ tin nhắn về thiết bị này" trên điện thoại.** `login` luôn đọc xem bạn có tick hay không. Có tick: lịch sử được khôi phục ngay, không cần chạm thêm (`--sync-days <n>` giới hạn số ngày). Không tick: không có gì được khởi chạy, và lệnh in ra `zalo-agent sync --from <ngày>` để khôi phục phần máy này còn thiếu. `--no-sync` chỉ báo; `--verbose` liệt kê các hàng đợi control đã đọc và mọi control đã thấy (không bao giờ in khóa). Khi một daemon `listen`/`mcp` đang giữ tài khoản, ô tick không được đọc và lệnh khôi phục được in ra thay thế.
- **Mã thiết bị được giữ nguyên.** Zalo giữ hàng đợi tin offline theo từng thiết bị, nên đăng nhập QR lại một tài khoản còn phiên đăng nhập đã lưu trên máy này sẽ dùng lại đúng mã thiết bị, và hàng đợi của Zalo cho thiết bị đó vẫn còn sau khi đăng nhập lại (`Device: the same device id ...`). Lần đăng nhập đầu tiên, đăng nhập sau `logout` (lệnh này xóa phiên đã lưu) hoặc một tài khoản khác sẽ nhận mã thiết bị mới (`Device: a new device id ...`). Phiên đã lưu ghi lại thời điểm mã thiết bị bắt đầu được dùng (`deviceSince`), và daemon không bao giờ tính độ phủ của cache từ trước thời điểm đó.

> [!IMPORTANT]
> **Zalo chỉ giữ một phiên đăng nhập web cho mỗi tài khoản, và server này chính là phiên đó.** Quét QR đăng nhập **Zalo trên trình duyệt** ở bất kỳ đâu sẽ đăng xuất server: daemon đang chạy vẫn sống ở trạng thái `signed_out` và từ chối mọi yêu cầu với `SIGNED_OUT` cho tới khi bạn thêm lại tài khoản bằng QR (`ZALO_EXIT_ON_SIGNED_OUT=1` khiến nó thoát với mã 4 thay vào đó), còn một tab trình duyệt đang mở Zalo chiếm socket sẽ khiến daemon on-demand nhường tài khoản (`YIELDED`). **Ứng dụng điện thoại và ứng dụng Zalo trên máy tính là các phiên riêng, chạy song song với server được** — muốn đọc tin thì dùng hai ứng dụng này, đừng dùng trình duyệt. Mỗi lần đăng nhập QR, điện thoại hiện thêm một mục trong danh sách thiết bị (các mục cũ của server hiện là đã đăng xuất); hàng đợi tin offline vẫn còn vì mã thiết bị được giữ nguyên.

> **Lưu trữ:** `~/.zalo-agent-cli/` (quyền `0600`), được niêm phong trên đĩa bằng bộ cung cấp khóa của máy ([docs/security.vi.md](docs/security.vi.md)).
> **Rủi ro:** đây là API không chính thức (giao thức riêng của Zalo, không có tài liệu công khai) — lạm dụng tự động hóa tần suất cao có thể khiến tài khoản bị khóa/ban. Không nên dùng tài khoản cá nhân chính của bạn.

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
ZALO_MCP_AUTH_TOKEN=<token> zalo-mcp --http 3847 --host 192.168.1.20   # LAN: địa chỉ LAN, token qua biến môi trường
ZALO_MCP_AUTH_TOKEN=<token> zalo-mcp --http 3847 --host 192.168.1.20 --cert /path/to/fullchain.pem --key /path/to/privkey.pem
# Internet / VPS: giữ 127.0.0.1 sau một reverse proxy TLS, xem docs/config-samples/use-cases/c-vps-few-accounts/README.vi.md
```

Bên dưới, lệnh này chạy `zalo-agent mcp start --http <port> [--host <addr>] [--cert <path> --key <path>]`, với bearer token lấy từ `ZALO_MCP_AUTH_TOKEN`. Toàn bộ các flag của `mcp start` đều được hỗ trợ giống hệt nhau qua cả `zalo-mcp` lẫn `zalo-agent mcp start`:

| Flag | Mặc định | Mô tả |
|:---|:---|:---|
| `--account <id>` | Tài khoản active lúc khởi động, sau đó ghim cố định | ID số của tài khoản đã đăng ký cần ghim qua các lần reconnect/retry mà không làm đổi tài khoản active chung |
| `--http <port>` | *(stdio)* | Sử dụng giao thức HTTP (hoặc HTTPS khi có `--cert` và `--key`) trên cổng này |
| `--auth <token>` | `ZALO_MCP_AUTH_TOKEN` trong `.env` | Yêu cầu `Authorization: Bearer <token>` trên mọi endpoint trừ `/health`, `/ready` và các endpoint OAuth discovery/handshake. Nên dùng biến môi trường: cờ lộ trong danh sách tiến trình |
| `--host <address>` | `127.0.0.1` | Địa chỉ bind. Trên LAN: địa chỉ LAN của máy; trên internet: giữ `127.0.0.1` sau một reverse proxy TLS. Tránh `0.0.0.0` |
| `--cert <path>` | `tls.cert` trong `mcp-config.json` | Đường dẫn chứng chỉ TLS (PEM) để phục vụ HTTPS trực tiếp qua `https` server của Node (cần `--http` và `--key`; tự động thử bind song song cổng `443` khi `port !== 443`) |
| `--key <path>` | `tls.key` trong `mcp-config.json` | Đường dẫn khóa riêng TLS (PEM) để phục vụ HTTPS trực tiếp (cần `--http` và `--cert`) |
| `--client-id <id>` | `zalo-mcp` (hoặc `ZALO_MCP_OAUTH_CLIENT_ID[_<ownId>]`) | OAuth 2.0 Client ID cho các remote MCP client như Gemini Connected Apps |
| `--client-secret <key>` | `--auth` / `ZALO_MCP_AUTH_TOKEN[_<ownId>]` | OAuth 2.0 Client Secret cho bước đổi token tại `/token` |
| `--public-url <url>` | `ZALO_MCP_PUBLIC_URL[_<ownId>]`, `publicUrl` trong `mcp-config.json` | Địa chỉ công khai duy nhất của server khi đứng sau proxy hoặc TLS (ví dụ `https://zalo.example.com`, có thể kèm base path): endpoint MCP, OAuth issuer, và link tới trang bảo mật và trang QR dùng một lần. `https`, hoặc `http` chỉ trên localhost. Không đặt: link dùng địa chỉ của chính server và OAuth suy issuer từ header `Host` của request |
| `--issuer-url <url>` | *(deprecated)* | Tên cũ của `--public-url`; vẫn dùng được |
| `-w, --webhook <url>` | `webhook` trong `mcp-config.json` | POST mỗi tin nhắn đến (thuộc diện theo dõi) dưới dạng JSON tới URL này (`ZALO_WEBHOOK_URL[_<ownId>]`) |
| `--webhook-secret <secret>` | `webhookSecret` trong `mcp-config.json` | Khóa bí mật để ký các webhook POST bằng `Authorization: Bearer <secret>` + `X-Zalo-Signature: sha256=<hmac>` (`ZALO_WEBHOOK_SECRET[_<ownId>]`; cờ được ưu tiên, rồi biến môi trường, rồi khóa trong cấu hình; cờ để trống bị từ chối; nên dùng biến môi trường vì cờ lộ trong danh sách tiến trình) |
| `--config <path>` | `~/.zalo-agent-cli/mcp-config.json` | Đường dẫn file cấu hình MCP tùy chỉnh |
| `--no-self-heal` | *(bật)* | Tắt cơ chế tự động bù khoảng hở (self-heal) sau khi kết nối lại. Bị từ chối lúc khởi động khi chạy hiện diện on-demand (lần bắt kịp là cách lấy lại khoảng thời gian socket nghỉ); dùng được với `presence.mode: "always-on"` |
| `--log-level <level>` | `info` (`ZALO_LOG_LEVEL`) | `error`, `warn`, `info` hoặc `debug` cho `daemon.log` |
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
# → {"status":"ok","uptime":123,"threads":5,"socket":"idle","ready":true}
```

`socket` là `up`, `idle` (socket đang nghỉ theo hiện diện on-demand; tự thức khi có việc), `connecting`, `down`, `yielded`, `signed-out`, `maintenance`, `kicked`, `relogin`, `starting` hoặc `stopping`. `GET /ready` (cũng không cần xác thực) trả 200 khi là `up` hoặc `idle`, ngược lại 503.

> Bind ra bất kỳ địa chỉ nào ngoài loopback mà không có token sẽ phơi bày toàn bộ phiên Zalo của bạn cho bất kỳ ai kết nối được tới cổng đó. Luôn đặt `ZALO_MCP_AUTH_TOKEN` cho server mà máy khác truy cập được. Admin API (`/zalo/admin/…`: chính sách runtime, dung lượng, xuất dữ liệu) dùng credential admin riêng (`zalo-agent policy token --rotate`), không bao giờ là token của agent; các proxy mẫu trả 404 cho đường dẫn này, nên hãy truy cập nó qua loopback, SSH tunnel hoặc VPN.

Hướng dẫn vận hành máy chủ thực tế (systemd unit, khởi động lại, giám sát, sao lưu, bảo mật) xem tại [docs/deployment.vi.md](docs/deployment.vi.md) / [English](docs/deployment.md). Từ 3.0.0, phiên đăng nhập đã lưu được mã hóa trên đĩa; trên server Linux không có desktop keyring, hãy chọn bộ cung cấp khóa trước (systemd-creds, KMS hoặc file passphrase): xem [docs/security.vi.md](docs/security.vi.md).

### Hiện diện on-demand

Từ 3.0.0, **`mcp start --http` (chạy foreground hay `-d`) và `listen --daemon` chạy on-demand**: socket chỉ được giữ khi có việc cần — một lần gọi tool MCP, một `zalo_wait_for_message` / `GET /events/wait`, một lease của CRM (`POST /zalo/presence/leases`), một yêu cầu CLI mà daemon phục vụ (tải tệp lên, một giai đoạn `sync`, `mcp wait`) hoặc `zalo-agent presence wake` — rồi tạm nghỉ sau `presence.idleTimeout` (5 phút; không bao giờ sớm hơn `presence.minConnected`, 60 giây, kể từ lúc kết nối). Lúc khởi động có một lần bắt kịp. Tin đến trong lúc nghỉ được lấy lại từ hàng đợi offline của Zalo ở lần kết nối sau, nên webhook và các lệnh chờ nhận được vào lúc đó, có cờ `catchUp: true`. Các lệnh đọc cache chờ tối đa `presence.warmWait` (10 giây) để socket thức dậy; lệnh cần chính socket có thể trả `WARMING` kèm `retryAfterSec`.

- **Thời gian thực** (webhook phải chạy ngay khi tin đến): `presence.mode: "always-on"` trong `mcp-config.json`, trong chính sách runtime, hoặc `ZALO_PRESENCE_MODE[_<ownId>]=always-on`. MCP qua stdio và `listen` chạy foreground in ra stdout vốn luôn kết nối.
- **Phiên khác chiếm tài khoản** (bản sao thứ hai của cùng phiên đăng nhập, một tab trình duyệt đang mở Zalo): daemon on-demand **nhường** tài khoản và từ chối mọi thứ với `YIELDED`; không có gì tự lấy lại tài khoản. Đóng phiên kia, rồi chạy `zalo-agent presence resume --yes` (hoặc `zalo_profile` `presence_resume`, hoặc admin API). Daemon always-on vẫn thoát với mã 3 như trước.
- **Zalo liên tục từ chối đăng nhập** (thường do ai đó quét QR đăng nhập Zalo trên trình duyệt ở nơi khác): daemon vẫn chạy ở trạng thái `signed_out` và từ chối với `SIGNED_OUT` cho tới khi tài khoản được thêm lại bằng QR.
- `zalo-agent presence status` cho biết chế độ, trạng thái (`parked`, `waking`, `connected`, `parking`, `yielded`, `signed-out`) và các hold đang mở; sự kiện `account_state` được gửi tới webhook, buffer MCP và `/status`. Nhiều daemon trên một máy: `ZALO_CONNECT_SLOTS` giới hạn số daemon thức dậy cùng lúc.

Mọi khóa `presence.*`: [docs/configuration.vi.md](docs/configuration.vi.md).

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
   # mỗi tài khoản một unit systemd, token trong file env của nó: docs/config-samples/use-cases/c-vps-few-accounts
   za fleet generate --out /tmp/fleet --base-port 3901 --domain zalo.example.com
   ```
4. **Gọi lệnh CLI song song theo từng tài khoản (không làm thay đổi `accounts.json`):**
   ```bash
   zalo-agent --account 101 msg send <threadId> "Xin chào từ Shop A" --json
   zalo-mcp --account 202 sync --days 7
   ```

### Danh sách 36 MCP tools

Engine này đăng ký **36 MCP tools** trong `src/mcp/mcp-tools.js`, phục vụ cho **tài khoản cá nhân**:

| Tool | Công dụng |
|:---|:---|
| `zalo_get_messages` | Đọc tin nhắn live trong buffer kèm cursor để đọc tăng dần |
| `zalo_send_message` | Gửi văn bản, tệp/ảnh đính kèm (`filePath`/`files`), thẻ xem trước liên kết (`link`), danh thiếp (`cardUserId`), sticker, tin nhắn thoại từ URL, video từ URL hoặc tệp cục bộ, thẻ ngân hàng hoặc ảnh QR chuyển khoản VietQR vào DM hoặc nhóm — hỗ trợ tag `@[uid]`, trả lời trích dẫn, đánh dấu Quan trọng/Khẩn cấp (`urgency`), hoặc `threadId: "me"` cho My Documents |
| `zalo_list_threads` | Liệt kê các hội thoại trong buffer kèm số tin chưa đọc |
| `zalo_search_threads` | Tìm kiếm hội thoại theo tên (fuzzy, không phân biệt dấu tiếng Việt) |
| `zalo_mark_read` | Đánh dấu đã đọc các tin trong buffer đến một cursor cho một consumer (toàn cục, không xóa dữ liệu khỏi buffer nên nhiều bot có thể dùng chung một server) |
| `zalo_get_history` | Đọc lịch sử tin nhắn cũ: ưu tiên đọc từ cache cục bộ trước, sau đó mới hỏi server Zalo, có phân trang |
| `zalo_view_media` | Một tệp ảnh/audio/video/tệp đã nhận (tự tải xuống trước nếu chưa có), trả về dạng `inline` (nội dung MCP), link có hạn (`<publicUrl>/zalo/media/<token>`) hoặc `tempfile` riêng tư, theo chính sách `media.*` của triển khai |
| `zalo_react` | Thả cảm xúc vào tin nhắn (`/-strong`, `/-heart`, `:>`, …), giống `msg react` — từ chối nếu thiếu `cliMsgId` ở cả tham số lẫn cache |
| `zalo_undo` | Thu hồi tin nhắn của chính bạn ở cả hai phía, giống `msg undo`; cùng quy tắc `cliMsgId` |
| `zalo_get_group_members` | Liệt kê thành viên nhóm — `uid` và tên hiển thị — giống `group members` |
| `zalo_list_conversations` | Liệt kê các hội thoại gần đây từ cache cục bộ, mới nhất trước, giống `conv recent` |
| `zalo_coverage` | Chỉ đọc: kiểm tra các khoảng hở (coverage gaps) đang chờ trong cache, số khoảng đã đóng, và lệnh `zalo-agent sync --from <date>` để khôi phục |
| `zalo_sync` | Khởi chạy một bước đồng bộ khi chủ tài khoản yêu cầu (tin nhắn, cảm xúc, chỉ mục zCloud, tải media, bảng tin nhóm); trả về ngay mã công việc (`jobId`). Khôi phục tin nhắn vẫn cần xác nhận trên điện thoại |
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
| `zalo_group` | Mọi lệnh `group`: xem, tạo, đổi tên, thành viên, phó nhóm, trưởng nhóm, chặn thành viên, cài đặt, yêu cầu tham gia, link mời và lời mời, rời nhóm, giải tán nhóm |
| `zalo_friend` | Lời mời kết bạn, danh sách bạn bè, biệt danh, trực tuyến và lần cuối online, xóa bạn, chặn / bỏ chặn, ẩn nhật ký, tìm theo nhiều số điện thoại, mã QR, nhóm chung, thông tin doanh nghiệp |
| `zalo_read` | Chạy một endpoint chỉ-đọc của Zalo mà không tool nào khác phủ tới (danh mục sticker và GIF, tìm GIF, hạng hồ sơ, danh sách chặn, biệt danh, trạng thái…), hoặc liệt kê chúng |
| `zalo_write` | Thực hiện một lời gọi thay đổi trạng thái của Zalo mà không tool nào khác phủ tới (RSVP nhắc hẹn, ghi chú và nhắc hẹn nhóm có lặp lại, ghim, thu hồi nhiều tin…), hoặc liệt kê chúng; gọi thật cần `confirm: true`, `dryRun: true` để xem yêu cầu |
| `zalo_conversation` | Ghim, lưu trữ, tắt thông báo, ẩn, đánh dấu đã đọc / chưa đọc, tự xóa, xóa hoặc quên một hội thoại; hiển thị đang soạn tin; báo cáo người dùng hoặc nhóm |
| `zalo_profile` | Ảnh đại diện, tiểu sử, tên, cài đặt riêng tư, trạng thái online, ngôn ngữ và các thiết bị đã liên kết của tài khoản; `usage` (dung lượng và hạn mức trên máy này, như `db usage`) và `presence_resume` (lấy lại tài khoản sau khi nhường, như `presence resume`) |
| `zalo_auto_reply` | Liệt kê, tạo, sửa hoặc xóa quy tắc trả lời tự động |
| `zalo_quick_message` | Liệt kê, thêm, sửa hoặc xóa tin nhắn nhanh |
| `zalo_catalog` | Danh mục và sản phẩm Zalo Shop |
| `zalo_bank` | Các ngân hàng được hỗ trợ và tài khoản ngân hàng đã lưu |
| `zalo_cloud` | Chỉ mục zCloud cục bộ: tóm tắt, kế hoạch dọn dẹp và dọn dẹp thật (được bảo vệ) |
| `zalo_sticker` | Tìm sticker theo từ khóa và xem chi tiết |
| `zalo_link` | Xem trước một liên kết và kiểm tra Zalo có coi nó là an toàn không |

Xem thêm [Chi tiết sử dụng đồng bộ qua MCP](docs/mcp-sync.vi.md) / [English](docs/mcp-sync.md).

Mọi lệnh CLI của tài khoản cá nhân đều có hành động MCP tương ứng. **Chỉ có trên CLI**: các lệnh Official Account (`oa …`, một API riêng), đăng nhập và đăng xuất (`login`, `logout`, `status`), danh sách tài khoản trên máy (`account list|login|switch|remove|info|export`), các bước của người vận hành trên khóa và dữ liệu của máy này (`account security …`, `db query|backup|export|verify|purge`), chính sách runtime (`policy …`: agent không bao giờ xem hay đổi giới hạn của chính nó), các lệnh daemon và fleet (`listen`, `mcp start`, `mcp webhook …`, `mcp approver`, `presence status|wake|park`, `fleet …`), `update`, `profile lost-focus`, và `cloud get` (cần khóa cloud của tài khoản); AI agent dùng chúng bằng cách gọi `zalo-agent <lệnh> --json` (hoặc `zalo-mcp <lệnh> --json`).

Tham chiếu đầy đủ về MCP tools (tham số, cấu trúc trả về, cấu hình): [skill/references/mcp-guide.md](skill/references/mcp-guide.md).

### Cấu hình MCP (`mcp-config.json`)

File tùy chọn tại `~/.zalo-agent-cli/mcp-config.json` — được gộp nông (shallow-merge) theo từng khóa cấp cao nhất với cấu hình mặc định:

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

`publicUrl` là địa chỉ duy nhất mà người dùng và client truy cập server khi đứng sau proxy hoặc TLS: endpoint MCP, OAuth issuer, các trang duyệt, trang PIN và trang QR dùng một lần, và link media. `confirmMode`, `hiddenChats`, `approval.*`, `media.*` (trừ `downloadDir`), `webhook*` và `presence.*` còn đổi được khi server đang chạy, qua chính sách runtime (`zalo-agent policy set <key> <value>` hoặc admin API), và chính sách này được ưu tiên hơn file. Bảng đầy đủ các trường và giá trị mặc định: [docs/configuration.vi.md](docs/configuration.vi.md) và [skill/references/mcp-guide.md](skill/references/mcp-guide.md).

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
├── accounts.json                  # Danh sách tài khoản (0600); sửa dưới khóa, thay thế nguyên tử
├── accounts.json.bak              # Danh sách như trước lần sửa gần nhất
├── credentials/cred_<ownId>.json  # Phiên đăng nhập đã lưu của từng tài khoản (0600, niêm phong)
├── mcp-config.json                # Cấu hình MCP tùy chọn
├── storage.json                   # Tùy chọn: bộ cung cấp khóa, hạn mức, thời hạn lưu, groups.onLeave
├── .env                           # Tùy chọn: cấu hình engine và đường dẫn lưu trữ
├── fleet.json                     # Bảng cổng của `fleet` (khi đã dùng)
├── policy-audit.log               # Mọi thay đổi và từ chối của chính sách runtime (khóa và rev, không có giá trị)
├── admin/, tenants/, users/       # Hash token admin, chính sách tenant và user (niêm phong; khi đã dùng)
├── accounts/<ownId>/
│   ├── zalo.db                    # Bộ nhớ đệm tin nhắn/hội thoại: SQLCipher v4, WAL, row MAC
│   ├── keyring.json               # Các khóa đã bọc của tài khoản: sao lưu cùng credentials/ và zalo.db
│   ├── webhook-outbox.db          # Hàng đợi webhook bền vững (SQLCipher)
│   ├── policy.json                # Chính sách runtime của tài khoản (niêm phong; khi đã đặt)
│   ├── media/                     # Media tải về bởi `listen` / `msg` / `mcp` (mã hóa, theo tài khoản)
│   ├── sync/                      # Dữ liệu tạm của sync (bộ đệm giao thức của lần khôi phục từ điện thoại)
│   ├── daemon.lock                # Khóa giữ bởi daemon `listen`/`mcp start` đang chạy
│   ├── daemon-channel.json        # Kênh loopback của daemon đang chạy
│   └── daemon.log                 # Log của daemon (có xoay vòng)
└── qr.png                         # Mã QR đăng nhập gần nhất
```

> [!WARNING]
> **Không có `keyring.json` và bộ cung cấp khóa** (cùng máy với DPAPI, keychain, Secret Service hay systemd-creds; cùng khóa KMS; cùng passphrase), sẽ không mở được cả phiên đăng nhập đã lưu lẫn cơ sở dữ liệu tin nhắn. `zalo-agent db backup --out <file>` ghi một bản sao đã mã hóa và đã kiểm tra của cơ sở dữ liệu ngay cả khi daemon đang chạy; hãy sao lưu `keyring.json` cùng với nó. Chuyển bản cài đặt sang máy khác: [docs/security.vi.md](docs/security.vi.md).

> [!NOTE]
> **Một thư mục media, một bố cục thống nhất.** Mọi lệnh — `listen`, `msg history`, `mcp start`, `sync-media`, `sync-mobile` và các MCP tools — đều ghi vào `<mediaRoot>/<threadId>/` (mặc định là `accounts/<ownId>/media/<threadId>/`, hoặc `--media-dir` / `ZALO_MEDIA_DIR` toàn cục). Tên thư mục luôn là `threadId`, không bao giờ dùng tên hội thoại vì tên có thể chứa ký tự phân tách đường dẫn hoặc thay đổi khi đổi tên nhóm; `_conversations.json` ánh xạ ID sang tên. Trường `media.downloadDir` trong `mcp-config.json` cũng có thể ghi đè thư mục gốc media cho riêng MCP server.

> [!WARNING]
> **Thư mục tùy chỉnh `--media-dir` / `ZALO_MEDIA_DIR` hoặc `media.downloadDir` KHÔNG bị xóa bởi `logout --purge` hay `account remove`.** Hai lệnh đó chỉ xóa `<DATA_DIR>/<ownId>/` — bao gồm thư mục media mặc định bên trong — cùng file credential. Nếu bạn đặt thư mục media nằm ngoài thư mục tài khoản, các tệp đính kèm ở đó vẫn còn nguyên sau khi purge. Hãy tự xóa thư mục đó bằng tay khi cần gỡ bỏ hoàn toàn dữ liệu vì lý do riêng tư.

Thông tin xác thực Official Account được lưu riêng tại `~/.zalo-agent/oa-credentials.json` (hoặc `<ZALO_OA_DIR>/oa-credentials.json`).

---

## Tham chiếu nhanh lệnh CLI (qua `npx zalo-agent <lệnh>`)

Thêm `--json` vào bất kỳ lệnh nào để nhận kết quả JSON phục vụ tự động hóa. Dưới đây là các lệnh tiêu biểu — tài liệu tham chiếu đầy đủ cho toàn bộ 259 lệnh nằm tại [skill/references/command-reference.md](skill/references/command-reference.md).

### Phiên đăng nhập & bảo trì
| Lệnh | Mô tả |
|:---|:---|
| `npx zalo-agent status` | Kiểm tra trạng thái đăng nhập |
| `npx zalo-agent whoami` | Xem hồ sơ đầy đủ của tài khoản đang đăng nhập |
| `npx zalo-agent login [--qr-url] [--public-url <url>] [--credentials <path>] [-p <proxy>] [--no-sync] [--sync-days <n>] [--verbose]` | Đăng nhập QR, hoặc khôi phục từ file credentials đã xuất. Sau khi đăng nhập QR, lệnh đọc ô "Đồng bộ tin nhắn về thiết bị này" trên điện thoại: có tick thì khôi phục lịch sử ngay (không cần chạm); không tick thì in ra lệnh `sync --from <ngày>` cần chạy. `--no-sync` chỉ báo; `--verbose` liệt kê những gì đã đọc. Đăng nhập lại giữ nguyên mã thiết bị |
| `npx zalo-agent logout --yes [--delete-history] [--purge] [--no-remote] [--keep-session]` | Đăng xuất thiết bị khỏi Zalo (như ứng dụng Zalo) và xóa credentials đã lưu; `--keep-session` chỉ kết thúc khóa phiên (cách cũ trước v3.0, khi đó phiên chỉ kết thúc hẳn nếu gỡ thiết bị trong danh sách trên điện thoại); tùy chọn xóa cache cục bộ hoặc xóa sạch dữ liệu tài khoản |
| `npx zalo-agent sync-mobile --transfer [-d <days>]` | **Khôi phục lịch sử tin nhắn từ điện thoại** vào cache cục bộ (xác nhận một lần trên điện thoại). Mặc định lấy toàn bộ lịch sử; `-d/--days <n>` giới hạn trong *n* ngày gần nhất |
| `npx zalo-agent update` | Tự cập nhật lên phiên bản mới nhất đã phát hành |
| `npx zalo-agent mcp start [--http <port>] [--host <addr>] [-d]` | Khởi chạy MCP server (token lấy từ `ZALO_MCP_AUTH_TOKEN`; HTTP chạy hiện diện on-demand) |
| `npx zalo-agent presence status\|wake\|park` / `presence resume --yes` | Socket của daemon đang chạy theo hiện diện on-demand; `resume` lấy lại tài khoản sau khi nhường |
| `npx zalo-agent policy get\|set\|unset <key> [value]` / `policy token --rotate` | Chính sách runtime mà server đang chạy nhận ngay không cần khởi động lại; token của admin API |
| `npx zalo-agent db query "<sql>"` / `db backup -o <file>` / `db export -o <file> --password` / `db verify` / `db usage` / `db purge --yes` | Cơ sở dữ liệu tin nhắn đã mã hóa: SQL chỉ-đọc, bản sao lưu mã hóa, bản sao mã hóa bằng mật khẩu (hoặc `--plaintext --yes`), kiểm tra row MAC, dung lượng và hạn mức, dọn theo hạn mức/thời hạn lưu. Chat ẩn chỉ có khi dùng `--include-hidden` và nhập PIN |
| `npx zalo-agent account security status --all` / `account security migrate --all` | Cách máy này bảo vệ file của từng tài khoản trên đĩa; niêm phong những gì còn ở dạng rõ |
| `npx zalo-agent mcp wait [since] [-t <threadId>] [--timeout <s>] [-n <count>] [--settle <ms>] [-c <name>]` | Long-poll chờ tin nhắn mới từ buffer của `mcp start` đang chạy (tương đương `zalo_wait_for_message`) |
| `npx zalo-agent mcp mark-read <cursor> [-c <name>]` | Đánh dấu đã đọc tới `<cursor>` trong buffer của `mcp start` đang chạy (tương đương `zalo_mark_read`) |

### Tài khoản cá nhân
| Lệnh | Mô tả |
|:---|:---|
| `npx zalo-agent msg send <threadId> "text" [-t 1]` | Gửi tin nhắn văn bản (DM, hoặc nhóm với `-t 1`) |
| `npx zalo-agent msg send-image <threadId> <path>` | Gửi hình ảnh |
| `npx zalo-agent msg send-file <threadId> <path>` | Gửi tệp đính kèm |
| `npx zalo-agent msg history <threadId> [-t 1] [-n 50] [--no-cache]` | Xem lịch sử tin nhắn (đọc từ cache cục bộ trừ khi có `--no-cache`) |
| `npx zalo-agent msg undo <msgId> <threadId> -c <cliMsgId> --yes` | Thu hồi tin nhắn ở cả hai phía |
| `npx zalo-agent friend list` / `friend find <phone>` | Danh sách / tìm kiếm bạn bè |
| `npx zalo-agent group list [-q <text>]` / `group members <groupId>` | Danh sách nhóm / thành viên nhóm |
| `npx zalo-agent conv recent [-n 20]` | Liệt kê các hội thoại gần đây kèm `threadId` |
| `npx zalo-agent account devices` | Xem danh sách thiết bị/phiên đang liên kết với tài khoản |
| `npx zalo-agent account status` | Các gói của tài khoản: gói zBusiness, gói zCloud, dung lượng đã dùng và giới hạn, và dung lượng trên máy này (chỉ đọc) |
| `npx zalo-agent account remove <ownerId> --yes` | Hủy phiên từ xa, xóa sạch dữ liệu cục bộ và xóa credentials |
| `npx zalo-agent account export [ownerId] -o <path> --yes` | Ghi phiên đăng nhập đã lưu ra một file JSON ở dạng rõ (để chuyển sang máy khác); thiếu `--yes` thì không ghi gì |
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
| `ZALO_API_VERSION` | Phiên bản giao thức công bố với Zalo (`zpw_ver` / `client_version`) trên cả HTTP và WebSocket. Mặc định `695` (giá trị Zalo hiện yêu cầu); đặt một giá trị cũ hơn như `685` nếu muốn quay lại. Phải là số nguyên dương hợp lệ. |
| `ZALO_QR_FLOW` | Cách `login` đăng nhập bằng QR: `official` (mặc định: đúng trình tự đăng nhập của Zalo, không gọi `verify-client`, `continue=https://chat.zalo.me/`, chuyển hướng phiên qua `jr.zaloapp.com` và `jr.chat.zalo.me`, kèm mã QR thứ hai mà tài khoản có thiết bị tin cậy phải quét, khiến client này thành một thiết bị tin cậy đi kèm). Đây là cách đăng nhập QR duy nhất: `legacy` đã bị bỏ ở 3.0.0 và, như mọi giá trị khác `official`, bị từ chối trước khi liên hệ Zalo. Chỉ đăng nhập QR đọc biến này |
| `ZALO_NET_PROBE` | Thứ daemon hỏi để biết mạng còn hoạt động hay không khi socket đang đứt (mỗi 10 giây). Một URL, mặc định là một trang nhẹ của công cụ tìm kiếm toàn cầu; `off` coi như mạng luôn hoạt động và không liên hệ nơi nào ngoài Zalo |
| `ZALO_JSON_MODE` | Được CLI tự động đặt ở chế độ `--json` và `mcp`, để stdout chỉ chứa kết quả dạng máy đọc được. Không cần tự đặt bằng tay |
| `ZALO_MCP_HTTP_PORT` | Cổng fallback cho `--http` của `mcp start` và wrapper `zalo-mcp` (hỗ trợ hậu tố theo tài khoản `ZALO_MCP_HTTP_PORT_<ownId>`) |
| `ZALO_MCP_HOST` | Địa chỉ bind mặc định cho `mcp start --http` (hỗ trợ `ZALO_MCP_HOST_<ownId>`) |
| `ZALO_MCP_AUTH_TOKEN` | Bearer token cho `mcp start --http` và làm OAuth 2.0 client secret dự phòng (hỗ trợ `ZALO_MCP_AUTH_TOKEN_<ownId>`) |
| `ZALO_MCP_OAUTH_CLIENT_ID` | OAuth 2.0 Client ID cho `mcp start --http` (mặc định `zalo-mcp`; hỗ trợ `ZALO_MCP_OAUTH_CLIENT_ID_<ownId>`) |
| `ZALO_MCP_OAUTH_CLIENT_SECRET` | OAuth 2.0 Client Secret cho `mcp start --http` (hỗ trợ `ZALO_MCP_OAUTH_CLIENT_SECRET_<ownId>`) |
| `ZALO_MCP_PUBLIC_URL` | Địa chỉ công khai duy nhất của `mcp start --http` khi đứng sau proxy hoặc TLS: endpoint MCP, OAuth issuer, link trang bảo mật và trang QR; cũng là link QR của `login` (hỗ trợ `ZALO_MCP_PUBLIC_URL_<ownId>`) |
| `ZALO_MCP_ISSUER_URL` | Tên cũ (deprecated) của `ZALO_MCP_PUBLIC_URL`, `mcp start` vẫn đọc (hỗ trợ `ZALO_MCP_ISSUER_URL_<ownId>`) |
| `ZALO_MCP_TLS_CERT` / `ZALO_MCP_TLS_KEY` | Đường dẫn chứng chỉ và khóa riêng PEM cho HTTPS gốc trên `mcp start --http` (hỗ trợ `_*_<ownId>`) |
| `ZALO_WEBHOOK_URL` / `ZALO_WEBHOOK_SECRET` | URL webhook mặc định và khóa ký (`Authorization: Bearer` + `X-Zalo-Signature: sha256=<hmac>`) cho `listen` và `mcp start` (hỗ trợ `_*_<ownId>`) |
| `ZALO_WEBHOOK_BATCH_SIZE` / `ZALO_WEBHOOK_MAX_AGE` | Số sự kiện mỗi POST webhook (1–100, mặc định 1) và thời gian thử lại một sự kiện chưa giao được trước khi chuyển vào dead-letter (mặc định `24h`). Cả hai hỗ trợ `_<ownId>`. Webhook bền vững: xem `zalo-agent mcp webhook status` |
| `ZALO_LOG_LEVEL` / `ZALO_LOG_FORMAT` / `ZALO_LOG_MAX_SIZE` / `ZALO_LOG_KEEP` | `daemon.log` của `listen` và `mcp start`: mức `error`, `warn`, `info` (mặc định) hoặc `debug` (thêm một dòng cho mỗi HTTP request và mỗi tin nhắn; cũng có `--log-level`), dòng `text` hoặc `json`, và xoay vòng ở `50m` giữ 3 file |
| `ZALO_START_JITTER` / `ZALO_LOGIN_SLOTS` / `ZALO_LOGIN_SLOT_WAIT` | Rải thời điểm khởi động của một đội daemon: chờ ngẫu nhiên 0–N giây trước khi đăng nhập, và chỉ cho tối đa N daemon trên máy đăng nhập cùng lúc (daemon vượt giới hạn sẽ chờ, rồi cứ tiếp tục sau `ZALO_LOGIN_SLOT_WAIT` giây). Tắt theo mặc định |
| `ZALO_SEND_FORMAT` | `markdown` hoặc `plain`: cách gửi tin nhắn văn bản. `zalo_send_message` mặc định chuyển Markdown thành định dạng của Zalo; `msg send` gửi nguyên văn trừ khi có `--markdown` (hoặc biến này) |
| `ZALO_STORAGE_PROVIDER` | Bộ cung cấp khóa bảo vệ các file đã lưu trên đĩa: `dpapi`, `keychain`, `secret-service`, `systemd-creds`, `kms`, `passphrase`, `env`. Mặc định theo nền tảng; máy chủ Linux không có keyring của desktop phải đặt (kèm `ZALO_STORAGE_PASSPHRASE_FILE`, `ZALO_KMS_KEY`, …). Xem [docs/security.vi.md](docs/security.vi.md) |
| `ZALO_PRESENCE_MODE` / `ZALO_PRESENCE_IDLE_TIMEOUT` | `on-demand` hoặc `always-on`, và thời gian socket on-demand còn giữ khi không có việc (mặc định `5m`). Cả hai hỗ trợ `_<ownId>`; chính sách runtime được ưu tiên hơn |
| `ZALO_EXIT_ON_SIGNED_OUT` | `1`: Zalo liên tục từ chối đăng nhập thì daemon thoát với mã 4, như trước 3.0. Mặc định: daemon vẫn chạy ở trạng thái `signed_out` cho tới khi tài khoản được thêm lại bằng QR |
| `ZALO_CONNECT_SLOTS` / `ZALO_CONNECT_SLOT_WAIT` | Tối đa N daemon trên máy đánh thức socket đang nghỉ cùng lúc (mặc định 0, không giới hạn), và thời gian một daemon chờ slot (mặc định 120 giây) |
| `ZALO_MCP_CONFIRM_MODE` / `ZALO_MCP_HIDDEN_CHATS` | Ai xác nhận thao tác phá hủy của tool (`agent`, `human`, `off`), và agent thấy gì của chat ẩn (`exclude`, `contentless`, `include`). Cả hai hỗ trợ `_<ownId>` |
| `ZALO_MCP_TRUSTED_PROXIES` | Địa chỉ các reverse proxy được tin header `X-Forwarded-For` (ví dụ `127.0.0.1`); hỗ trợ `_<ownId>` |
| `ZALO_RETENTION_MESSAGES` / `ZALO_RETENTION_MEDIA` | `keep` (mặc định) hoặc `<N>d`: cache cục bộ giữ tin nhắn và media bao lâu. Cả hai hỗ trợ `_<ownId>` |
| `ZALO_GROUPS_ON_LEAVE` | `purge` (mặc định) hoặc `keep`: lịch sử cục bộ của một nhóm đã rời, bị xóa khỏi, bị chặn khỏi hoặc đã giải tán sẽ ra sao; hỗ trợ `_<ownId>` |

Đây chỉ là danh sách rút gọn. Mọi biến môi trường, khóa `mcp-config.json`, khóa `storage.json` và khóa chính sách runtime, cùng thứ tự ưu tiên: [docs/configuration.vi.md](docs/configuration.vi.md).

---

## Khắc phục sự cố (Troubleshooting)

| Hiện tượng | Nguyên nhân / cách xử lý |
|:---|:---|
| MCP client không hiện tool nào, hoặc ngắt kết nối ngay lập tức | Có nội dung in ra stdout. Ở chế độ stdio, stdout là kênh truyền JSON-RPC — hãy kiểm tra log stderr để xem lỗi thực sự |
| `Another Zalo session took this account`: daemon always-on thoát với mã 3; daemon on-demand vẫn chạy và mọi yêu cầu trả `YIELDED` | Zalo chỉ cho phép 1 WebSocket trên mỗi tài khoản. Hãy đóng tab Zalo trên trình duyệt (dùng điện thoại hoặc ứng dụng Zalo trên máy tính thay thế), không chạy `listen` cùng lúc với `mcp start` trên cùng một tài khoản, và không bao giờ chạy hai bản sao của một phiên đăng nhập; sau đó chạy `zalo-agent presence resume --yes` cho daemon on-demand |
| Mọi yêu cầu trả `SIGNED_OUT` (`account_state` `signed_out`) | Zalo đã thu hồi phiên đăng nhập của server, thường vì ai đó quét QR đăng nhập Zalo trên trình duyệt: Zalo chỉ giữ một phiên web cho mỗi tài khoản. Đăng nhập lại tài khoản bằng QR (`zalo-agent login`, hoặc thêm bằng QR qua fleet controller), và đừng mở Zalo trên trình duyệt |
| Một tool trả `WARMING` kèm `retryAfterSec` | Socket on-demand đang thức dậy; gọi lại sau số giây đó. Đặt `presence.mode: "always-on"` nếu không chấp nhận được |
| Lúc khởi động báo `--no-self-heal cannot run with on-demand presence` | Lần bắt kịp là cách lấy lại khoảng thời gian socket nghỉ. Bỏ `--no-self-heal`, hoặc đặt `presence.mode: "always-on"` |
| Bot mở `zalo.db` gặp `file is not a database` | Từ 3.0.0 cơ sở dữ liệu được mã hóa (SQLCipher). Dùng `zalo-agent db query` / `db export` hoặc các MCP tool |
| Lệnh chỉ-đọc dừng với `PLAINTEXT` | Một file của 2.x mà lệnh đó không tự chuyển đổi được; chạy `zalo-agent account security migrate --all` (khi không có daemon nào chạy) |
| `logout` / `account remove` từ chối kèm số PID | Một tiến trình daemon `listen` hoặc `mcp start` đang giữ `daemon.lock` của tài khoản đó. Hãy dừng daemon trước (`--stop`) |
| `Thread name cache not initialized yet` khi gọi `zalo_search_threads` | Bộ nhớ đệm tên hội thoại đang được xây dựng lúc khởi động MCP bằng cách tải danh sách nhóm + bạn bè. Thử lại sau vài giây |
| Không kết nối được tới HTTP MCP server từ máy khác | Mặc định `--http` chỉ bind vào `127.0.0.1` (loopback). Trên LAN, đặt `ZALO_MCP_HOST` là địa chỉ LAN và `ZALO_MCP_AUTH_TOKEN` trong môi trường (không bao giờ `--auth` trên dòng lệnh); trên internet, giữ loopback sau reverse proxy TLS (docs/config-samples/use-cases) (hỗ trợ trên cả `zalo-mcp` và `zalo-agent mcp start`) |
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
