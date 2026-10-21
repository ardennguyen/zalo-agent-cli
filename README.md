<p align="center">
  <img src="assets/mascot.png" width="120" alt="zalo-agent-cli mascot" />
</p>

# zalo-agent-cli

Công cụ CLI tự động hóa Zalo — đa tài khoản, proxy, chuyển khoản ngân hàng, thanh toán QR, Official Account API v3.0, và MCP server cho AI agent.
Xây dựng trên [zca-js](https://github.com/RFS-ADRENO/zca-js).

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

**[Tiếng Việt](#bắt-đầu-nhanh)** | **[English](#english)**

> [!WARNING]
> Tool này sử dụng API Zalo **không chính thức** ([zca-js](https://github.com/RFS-ADRENO/zca-js)). Zalo không hỗ trợ và **tài khoản của bạn có thể bị khóa hoặc ban**. Tự chịu trách nhiệm. Không liên kết với Zalo hay VNG. Xem [DISCLAIMER.md](DISCLAIMER.md).

> [!IMPORTANT]
> **Zalo chỉ cho phép một phiên web trên mỗi tài khoản — CLI này chiếm phiên đó.**
> Đăng nhập Zalo Web (hoặc ứng dụng PC khác) sẽ thu hồi phiên của CLI ngay lập tức
> ở phía máy chủ, kể cả khi không có tiến trình nào đang chạy. Ngược lại,
> `zalo-agent login` sẽ đăng xuất Zalo Web. Ứng dụng điện thoại không bị ảnh hưởng.
> Đo ngày 20/09/2026.
> Lệnh `oa` là ngoại lệ — chúng dùng **API chính thức** của Zalo OA, không có rủi ro ban.

> [!TIP]
> **AI Agent Skill** — Dùng với OpenClaw, Claude Code, hoặc bất kỳ agent nào hỗ trợ SKILL.md:
> ```bash
> clawhub install zalo-agent          # OpenClaw (từ ClawHub registry)
> cp -r skill/ ~/.claude/skills/zalo-agent/   # Claude Code
> ```
> 18 nhóm lệnh · 222 lệnh · listen mode + webhook · 55+ ngân hàng VN · đa tài khoản + proxy
> Xem [skill/SKILL.md](skill/SKILL.md) · [Tham chiếu lệnh đầy đủ](skill/references/command-reference.md) · [Eval scenarios](skill/evals/)

> [!NOTE]
> **Zalo Official Account (OA)** — Zalo OA API v3.0 chính thức:
> ```bash
> zalo-agent oa init                                    # Setup wizard (interactive)
> zalo-agent oa init --app-id <ID> --secret <KEY> --skip-webhook  # Non-interactive (AI agent)
> zalo-agent oa whoami                                  # Xem thông tin OA
> zalo-agent oa msg text <user-id> "Xin chào"           # Gửi tin nhắn
> zalo-agent oa listen -p 3000                           # Webhook listener
> ```
> OAuth login · gửi tin nhắn · follower · tag · bài viết · cửa hàng · webhook listener · multi-OA · VPS support
> Xem [docs/official-account.vi.md](docs/official-account.vi.md) · [English](docs/official-account.md)

> [!TIP]
> **MCP Server (AI Agent Integration)** — Model Context Protocol cho Claude Code và các MCP client:
> ```bash
> zalo-agent mcp start                                  # stdio (local Claude Code)
> zalo-agent mcp start --account <ID>                   # Ghim tài khoản (chạy nhiều tài khoản live cùng lúc)
> zalo-agent mcp start --http 3847 --auth your-secret   # HTTP (VPS)
> zalo-agent mcp wait -c my-bot --timeout 55 --json     # Zero-polling chờ tin nhắn mới qua CLI
> zalo-agent mcp mark-read <cursor> -c my-bot --json    # Đánh dấu đã đọc tới cursor qua CLI
> ```
> 25 tools: `zalo_get_messages` · `zalo_send_message` · `zalo_list_threads` · `zalo_search_threads` · `zalo_mark_read` · `zalo_get_history` · `zalo_view_media` · `zalo_react` · `zalo_undo` · `zalo_get_group_members` · `zalo_list_conversations` · `zalo_coverage` · `zalo_sync` · `zalo_sync_status` · `zalo_search_messages` · `zalo_lookup_user` · `zalo_forward_message` · `zalo_delete_message` · `zalo_reminder` · `zalo_note` · `zalo_poll` · `zalo_wait_for_message` · `zalo_label` · `zalo_friend` · `zalo_group`

[Sync qua MCP](docs/mcp-sync.vi.md) · [Ghim đa tài khoản live](docs/account-pinning.vi.md) · [Triển khai Production](docs/deployment.vi.md).
> Auto-reconnect · thread filter · noise reduction · tự tải media · thông báo qua nhóm Zalo · chạy song song nhiều tài khoản (`--account <ID>`)
> Xem [MCP Guide](skill/references/mcp-guide.md) · [INSTALLATION.vi.md](INSTALLATION.vi.md)

---

## Cài đặt

Yêu cầu **Node.js 22+**.

```bash
npm install -g @ardennguyen/zalo-agent-cli
```

Muốn cài kèm MCP server dạng sandbox (khuyến nghị cho AI client) → xem [INSTALLATION.vi.md](INSTALLATION.vi.md) ([English](INSTALLATION.md)).

## Bắt đầu nhanh

### 1. Đăng nhập

```bash
zalo-agent login
```

Quét QR bằng **Zalo app > Quét mã QR** (không dùng camera thường). QR cũng xem được trên trình duyệt tại `http://<host>:18927/qr`. Thông tin đăng nhập tự động lưu tại `~/.zalo-agent-cli/` (quyền 0600).

### 2. Tìm bạn bè

```bash
zalo-agent friend search "Phúc"
```

### 3. Lắng nghe tin nhắn (lấy thread ID)

```bash
zalo-agent listen
```

Mỗi tin nhắn đến sẽ hiện `threadId`. Dùng `--json` để lấy dạng JSON.

### 4. Gửi tin nhắn

```bash
# Gửi cho cá nhân
zalo-agent msg send <THREAD_ID> "Xin chào!"

# Gửi vào nhóm
zalo-agent msg send <THREAD_ID> "Xin chào nhóm!" -t 1
```

---

## Danh sách lệnh

Tất cả lệnh hỗ trợ `--json`. Tài liệu đầy đủ: **[Wiki](https://github.com/ardennguyen/zalo-agent-cli/wiki)** · [Tham chiếu lệnh đầy đủ](skill/references/command-reference.md)

| Nhóm lệnh | Số lệnh | Mô tả | Docs |
|------------|:---:|--------|------|
| *(top-level)* | 11 | `login`, `logout`, `status`, `whoami`, `update`, `sync`, `sync-mobile`, `sync-media`, `sync-reactions`, `sync-boards`, `sync-cloud` | [Đăng nhập & Đăng xuất](https://github.com/ardennguyen/zalo-agent-cli/wiki/%C4%90%C4%83ng-Nh%E1%BA%ADp-&-%C4%90%C4%83ng-Xu%E1%BA%A5t) |
| `msg` | 24 | Gửi tin nhắn, hình, file, voice, video, sticker, link, thẻ chuyển khoản, QR, thu hồi, lịch sử | [Tin nhắn](https://github.com/ardennguyen/zalo-agent-cli/wiki/Tin-Nh%E1%BA%AFn) |
| `friend` | 26 | Danh sách, tìm, thêm, xóa, chặn, biệt danh, gợi ý | [Bạn bè](https://github.com/ardennguyen/zalo-agent-cli/wiki/B%E1%BA%A1n-B%C3%A8) |
| `group` | 35 | Tạo, đổi tên, thành viên, cài đặt, link, ghi chú, lời mời | [Nhóm & Cộng đồng](https://github.com/ardennguyen/zalo-agent-cli/wiki/Nh%C3%B3m) |
| `conv` | 21 | Tắt thông báo, ghim, lưu trữ, ẩn hội thoại, tự xóa, xoá bộ nhớ đệm cục bộ (`forget`) | [Hội thoại](https://github.com/ardennguyen/zalo-agent-cli/wiki/H%E1%BB%99i-Tho%E1%BA%A1i) |
| `account` | 7 | Đa tài khoản & proxy, thiết bị đã liên kết, xóa tài khoản | [Tài khoản](https://github.com/ardennguyen/zalo-agent-cli/wiki/T%C3%A0i-Kho%E1%BA%A3n) |
| `profile` | 14 | Xem/cập nhật hồ sơ, ảnh đại diện, quyền riêng tư | [Hồ sơ](https://github.com/ardennguyen/zalo-agent-cli/wiki/H%E1%BB%93-S%C6%A1) |
| `poll` | 7 | Tạo, bỏ phiếu, đóng khảo sát | [Khảo sát](https://github.com/ardennguyen/zalo-agent-cli/wiki/Kh%E1%BA%A3o-S%C3%A1t) |
| `reminder` | 6 | Tạo, sửa, xóa nhắc nhở | [Nhắc nhở](https://github.com/ardennguyen/zalo-agent-cli/wiki/Nh%E1%BA%AFc-Nh%E1%BB%9F) |
| `auto-reply` | 4 | Quản lý trả lời tự động | [Trả lời tự động](https://github.com/ardennguyen/zalo-agent-cli/wiki/Tr%E1%BA%A3-L%E1%BB%9Di-T%E1%BB%B1-%C4%90%E1%BB%99ng) |
| `quick-msg` | 4 | Tin nhắn nhanh đã lưu | [Tin nhắn nhanh](https://github.com/ardennguyen/zalo-agent-cli/wiki/Tin-Nh%E1%BA%AFn-Nhanh) |
| `label` | 2 | Nhãn hội thoại | [Nhãn](https://github.com/ardennguyen/zalo-agent-cli/wiki/Nh%C3%A3n) |
| `catalog` | 10 | zBusiness — danh mục sản phẩm | [zBusiness](https://github.com/ardennguyen/zalo-agent-cli/wiki/zBusiness) |
| `bank` | 5 | Tài khoản ngân hàng đã lưu, danh sách ngân hàng được hỗ trợ | [Ngân hàng](https://github.com/ardennguyen/zalo-agent-cli/wiki/Ng%C3%A2n-H%C3%A0ng) |
| `listen` | 1 | Lắng nghe real-time, webhook, JSONL, ghi vào cache cục bộ | [Lắng nghe](https://github.com/ardennguyen/zalo-agent-cli/wiki/L%E1%BA%AFng-Nghe) |
| `mcp` | 3 | MCP server (`start`, `wait`, `mark-read`) — 25 tools cho AI agent + zero-polling CLI | [MCP Server](https://github.com/ardennguyen/zalo-agent-cli/wiki/MCP-Server-(VN)) |
| **`oa`** | **32** | **Zalo Official Account API v3.0 — OAuth, tin nhắn, follower, tag, bài viết, cửa hàng, webhook** | **[Official Account](https://github.com/ardennguyen/zalo-agent-cli/wiki/Official-Account-(VN))** |

Xem thêm: [Đa tài khoản & Proxy](https://github.com/ardennguyen/zalo-agent-cli/wiki/%C4%90a-T%C3%A0i-Kho%E1%BA%A3n-&-Proxy) · [Cài đặt VPS](https://github.com/ardennguyen/zalo-agent-cli/wiki/C%C3%A0i-%C4%90%E1%BA%B7t-VPS) · [Thẻ chuyển khoản & QR](https://github.com/ardennguyen/zalo-agent-cli/wiki/Th%E1%BA%BB-Chuy%E1%BB%83n-Kho%E1%BA%A3n-&-QR) · [Bộ nhớ đệm & Đồng bộ](https://github.com/ardennguyen/zalo-agent-cli/wiki/B%E1%BB%99-Nh%E1%BB%9B-%C4%90%E1%BB%87m-&-%C4%90%E1%BB%93ng-B%E1%BB%99) · [Bảo mật](https://github.com/ardennguyen/zalo-agent-cli/wiki/B%E1%BA%A3o-M%E1%BA%ADt)

---

## Tính năng

- Đăng nhập QR qua HTTP server tự động (browser + terminal), báo ngay khi bị **từ chối trên điện thoại** thay vì treo tới hết 60s
- Đa tài khoản với proxy riêng biệt (1:1), device fingerprint riêng cho từng tài khoản; chạy **nhiều tài khoản live đồng thời** (mỗi tài khoản một tiến trình `mcp start` hoặc `listen` kèm `--account <ID>`, và truyền `--account <ID>` / `ZALO_ACCOUNT` trên mọi lệnh CLI mà không ghi đè `accounts.json`)
- **222 lệnh** phủ hết tính năng Zalo cá nhân
- **Zalo Official Account (OA) API v3.0** — OAuth login, gửi tin nhắn, follower, tag, bài viết, cửa hàng, webhook listener, multi-OA
- **MCP server** (stdio + HTTP/HTTPS + OAuth 2.0) — 25 tools cho Claude Code, Gemini và các MCP client: đọc, chờ tin nhắn đến (`zalo_wait_for_message`), gửi (văn bản, link preview, danh thiếp, vào My Documents, đánh dấu Quan trọng/Khẩn cấp), tìm kiếm tin nhắn trong cache, tra cứu người dùng, gắn/gỡ nhãn hội thoại (`zalo_label`), xem bạn bè và xử lý lời mời kết bạn (`zalo_friend`), xem thông tin nhóm, tạo nhóm, thêm/xóa thành viên và rời nhóm (`zalo_group`), thả cảm xúc, thu hồi, chuyển tiếp, xóa tin, nhắc hẹn, ghi chú/ghim tin, bình chọn, xem thành viên nhóm, liệt kê hội thoại gần đây và kiểm tra độ đầy đủ của cache
- **Bộ nhớ đệm cục bộ (SQLite)** — `listen` ghi mọi tin nhắn vào `zalo.db`, `msg history` đọc từ cache, `sync` (hoặc `sync-mobile`) khôi phục toàn bộ lịch sử từ điện thoại vào `zalo.db` (giải mã transfer-sync-v2; xác nhận một lần trên điện thoại), mặc định lấy **toàn bộ** lịch sử (không còn mốc chặn 2024-01-01); thêm `--days <n>` hoặc `--from <YYYY-MM-DD>` nếu chỉ cần một khoảng. Dọn dẹp: `sync-media --prune <days|all>` giải phóng dung lượng nhưng giữ nguyên nội dung tin nhắn, `--prune-orphans` nhắm vào hội thoại tài khoản không còn, và `conv forget` xoá hẳn bản sao cục bộ của một hội thoại — không cái nào gửi gì tới Zalo. Luồng đồng bộ chỉ mang **liên kết** media chứ không mang file, nên sau khi lưu tin nhắn, `sync-mobile` **tự động tải media về** (thêm `--messages-only` nếu chỉ muốn tin nhắn); `sync-media` chạy lại/tiếp tục bước tải này, không cần xác nhận trên điện thoại. Ghi chú, tin ghim, bình chọn và nhắc hẹn nằm ngoài luồng tin nhắn — dùng `sync-boards`
- Tự động tải media (ảnh/audio/video) — một downloader duy nhất cho `listen`, `msg history`, `mcp start` và các lệnh sync, lưu vào `~/.zalo-agent-cli/accounts/<id>/media/<threadId>/` (hoặc tách riêng credentials, database `zalo.db`, media và OA sang các ổ đĩa/mount khác nhau qua `--credentials-dir`, `--data-dir`, `--media-dir`, `--oa-dir` / biến môi trường `ZALO_*_DIR` trong `~/.zalo-agent-cli/.env`; nếu dùng kèm `zalo-mcp`, chỉ nên giữ cấu hình PORT trong `zalo-mcp/.env` và đặt toàn bộ đường dẫn lưu trữ vào `<CONFIG_DIR>/.env`)
- Thẻ chuyển khoản (55+ ngân hàng VN) & QR VietQR
- Lắng nghe real-time với webhook & lưu JSONL local. Webhook **bền vững**: mỗi sự kiện ghi xuống đĩa rồi mới gửi, đúng thứ tự, thử lại khi bên nhận hỏng, sống sót qua khởi động lại (`mcp webhook status`)
- **Vận hành nhiều tài khoản**: `/health`, `/ready`, `/status` và `/metrics` (Prometheus), `fleet status|start|restart|generate`, mức log + xoay vòng `daemon.log`, `ZALO_START_JITTER` / `ZALO_LOGIN_SLOTS` — xem `docs/deployment.vi.md` §4.7–4.8
- Tin nhắn **Markdown** được chuyển thành định dạng thật của Zalo (đậm, nghiêng, gạch đầu dòng, tiêu đề) — `zalo_send_message` mặc định, `msg send --markdown`
- `logout` hủy phiên **phía server** thật sự; `logout --purge` / `account remove` xóa sạch dữ liệu cục bộ
- Output `--json` cho mọi lệnh — scripting & AI agents
- Credentials lưu cục bộ với quyền 0600
- **Dual mode**: interactive (con người) + non-interactive (AI agents, CI/CD)

## Tài liệu

| Tài liệu | Nội dung |
|----------|----------|
| [INSTALLATION.vi.md](INSTALLATION.vi.md) ([EN](INSTALLATION.md)) | Cài đặt `zalo-mcp` wrapper, cấu hình MCP client, thiết lập OA |
| [docs/official-account.vi.md](docs/official-account.vi.md) ([EN](docs/official-account.md)) | Tham chiếu đầy đủ lệnh OA (song ngữ VN / EN) |
| [docs/deployment.vi.md](docs/deployment.vi.md) ([EN](docs/deployment.md)) | Hướng dẫn triển khai production (một socket, nhiều bot, HTTPS, OAuth 2.0, systemd/Docker) |
| [skill/SKILL.md](skill/SKILL.md) | Skill cho AI agent |
| [skill/references/command-reference.md](skill/references/command-reference.md) | Tham chiếu lệnh đầy đủ (nguồn chuẩn) |
| [skill/references/mcp-guide.md](skill/references/mcp-guide.md) | Hướng dẫn MCP server (tiếng Việt) |
| [skill/references/oa-command-reference.md](skill/references/oa-command-reference.md) | Tham chiếu nhanh lệnh OA cho agent |
| [skill/references/login-flow.md](skill/references/login-flow.md) | Các cách đăng nhập (QR, proxy, credentials) |
| [skill/references/listen-mode-guide.md](skill/references/listen-mode-guide.md) | Vận hành listener và webhook |
| [tests/README.md](tests/README.md) | Cách chạy và viết test: bộ offline, E2E phân tầng + checklist thủ công |
| [DISCLAIMER.md](DISCLAIMER.md) | Điều khoản đầy đủ và cảnh báo rủi ro |
| [AGENTS.md](AGENTS.md) | Quy tắc dự án cho AI coding agent |
| [Wiki](https://github.com/ardennguyen/zalo-agent-cli/wiki) | Tài liệu công khai, song ngữ EN + VN |

## Giấy phép

zalo-agent-cli © 2026 Arden Nguyen Duc Huy được cấp phép theo [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Xem [LICENSE](LICENSE) và [NOTICE](NOTICE). Điều khoản đầy đủ và cảnh báo rủi ro nằm trong [DISCLAIMER.md](DISCLAIMER.md).

- **Miễn phí cho mục đích phi thương mại**: cá nhân, học thuật, nghiên cứu. **Không cấp phép cho mục đích thương mại** — ví dụ dùng trong sản phẩm thương mại, để cung cấp dịch vụ có thu phí, hoặc trong hoạt động kinh doanh của một công ty. Muốn xin giấy phép thương mại, hãy [mở một issue](https://github.com/ardennguyen/zalo-agent-cli/issues).
- **Ghi công**: khi chia sẻ dự án này hoặc một phần của nó (nguyên bản hay đã sửa đổi, kể cả bên trong dự án khác), hãy ghi công theo mẫu trong [NOTICE](NOTICE), nêu rõ bạn có sửa đổi hay không, và dẫn link giấy phép.
- **Chia sẻ tương tự (ShareAlike)**: bản sửa đổi được chia sẻ phải dùng CC BY-NC-SA 4.0 (hoặc phiên bản mới hơn, hoặc giấy phép tương thích do Creative Commons liệt kê).
- Các phần dẫn xuất từ phần mềm MIT — [zalo-agent-cli của PhucMPham](https://github.com/PhucMPham/zalo-agent-cli) và bản vá của [zca-js](https://github.com/RFS-ADRENO/zca-js) được đóng gói kèm — vẫn thuộc giấy phép MIT; xem [NOTICE](NOTICE).
- Các phiên bản phát hành trước thay đổi này (2.0.0 trở về trước) được phát hành theo giấy phép MIT và giữ nguyên các điều khoản đó.

---

## English

CLI tool for Zalo automation — multi-account, proxy support, bank transfers, QR payments, Official Account API v3.0, and an MCP server for AI agents.

> [!IMPORTANT]
> **Zalo allows one web session per account — this CLI occupies it.**
> Signing into Zalo Web (or another PC client) revokes the CLI's session
> server-side, instantly, even with nothing running. The reverse is also true:
> `zalo-agent login` signs Zalo Web out. Your phone app is unaffected.
> Measured 2026-09-20.

> [!TIP]
> **AI Agent Skill** — Use with OpenClaw, Claude Code, or any SKILL.md-compatible agent:
> ```bash
> clawhub install zalo-agent                    # OpenClaw (from ClawHub registry)
> cp -r skill/ ~/.claude/skills/zalo-agent/     # Claude Code
> ```
> 18 command groups · 222 commands · listen mode + webhook · 55+ VN banks · multi-account + proxy
> See [skill/SKILL.md](skill/SKILL.md) · [Full command reference](skill/references/command-reference.md) · [Eval scenarios](skill/evals/)

> [!NOTE]
> **Zalo Official Account (OA)** — Official Zalo OA API v3.0:
> ```bash
> zalo-agent oa init                                    # Setup wizard (interactive)
> zalo-agent oa init --app-id <ID> --secret <KEY> --skip-webhook  # Non-interactive (AI agent)
> zalo-agent oa whoami                                  # OA profile
> zalo-agent oa msg text <user-id> "Hello"              # Send message
> zalo-agent oa listen -p 3000                           # Webhook listener
> ```
> OAuth login · messaging · followers · tags · articles · store · webhook listener · multi-OA · VPS support
> See [docs/official-account.md](docs/official-account.md) · [Tiếng Việt](docs/official-account.vi.md)

> [!TIP]
> **MCP Server (AI Agent Integration)** — Model Context Protocol support for Claude Code and MCP clients:
> ```bash
> zalo-agent mcp start                                  # stdio (local Claude Code)
> zalo-agent mcp start --account <ID>                   # Pin account (run multiple live accounts at once)
> zalo-agent mcp start --http 3847 --auth your-secret   # HTTP (VPS)
> zalo-agent mcp wait -c my-bot --timeout 55 --json     # Zero-polling wait for next message via CLI
> zalo-agent mcp mark-read <cursor> -c my-bot --json    # Advance consumer read cursor via CLI
> ```
> 25 tools: `zalo_get_messages` · `zalo_send_message` · `zalo_list_threads` · `zalo_search_threads` · `zalo_mark_read` · `zalo_get_history` · `zalo_view_media` · `zalo_react` · `zalo_undo` · `zalo_get_group_members` · `zalo_list_conversations` · `zalo_coverage` · `zalo_sync` · `zalo_sync_status` · `zalo_search_messages` · `zalo_lookup_user` · `zalo_forward_message` · `zalo_delete_message` · `zalo_reminder` · `zalo_note` · `zalo_poll` · `zalo_wait_for_message` · `zalo_label` · `zalo_friend` · `zalo_group`

[MCP sync](docs/mcp-sync.md) · [Multi-account pinning](docs/account-pinning.md) · [Production deployment](docs/deployment.md).
> Auto-reconnect · thread filter · noise reduction · media auto-download · Zalo-group notifications · concurrent multi-account (`--account <ID>`)
> See [MCP Guide](skill/references/mcp-guide.md) · [INSTALLATION.md](INSTALLATION.md)

### Quick Start

Requires **Node.js 22+**.

```bash
npm install -g @ardennguyen/zalo-agent-cli
zalo-agent login                           # 1. Login via QR
zalo-agent friend search "Name"            # 2. Find a friend
zalo-agent listen                          # 3. Listen for threadId
zalo-agent msg send <THREAD_ID> "Hello!"   # 4. Send a message
```

For the sandboxed MCP-server install (recommended for AI clients), see [INSTALLATION.md](INSTALLATION.md) ([Tiếng Việt](INSTALLATION.vi.md)).

### Commands

Full docs: **[Wiki](https://github.com/ardennguyen/zalo-agent-cli/wiki)** · [Full command reference](skill/references/command-reference.md)

| Group | Commands | Description | Docs |
|-------|:---:|-------------|------|
| *(top-level)* | 11 | `login`, `logout`, `status`, `whoami`, `update`, `sync`, `sync-mobile`, `sync-media`, `sync-reactions`, `sync-boards`, `sync-cloud` | [Login & Logout](https://github.com/ardennguyen/zalo-agent-cli/wiki/Login-&-Logout) |
| `msg` | 24 | Text, images, files, voice, video, stickers, links, bank cards, QR, recall, history | [Messages](https://github.com/ardennguyen/zalo-agent-cli/wiki/Messages) |
| `friend` | 26 | List, find, add, remove, block, alias, recommendations | [Friends](https://github.com/ardennguyen/zalo-agent-cli/wiki/Friends) |
| `group` | 35 | Create, rename, members, settings, links, notes, invites | [Groups](https://github.com/ardennguyen/zalo-agent-cli/wiki/Groups) |
| `conv` | 21 | Mute, pin, archive, hidden, auto-delete, forget local cache | [Conversations](https://github.com/ardennguyen/zalo-agent-cli/wiki/Conversations) |
| `account` | 7 | Multi-account & proxy, linked devices, account removal | [Accounts](https://github.com/ardennguyen/zalo-agent-cli/wiki/Accounts) |
| `profile` | 14 | Profile, avatar gallery, privacy | [Profile](https://github.com/ardennguyen/zalo-agent-cli/wiki/Profile) |
| `poll` | 7 | Create, vote, lock polls | [Polls](https://github.com/ardennguyen/zalo-agent-cli/wiki/Polls) |
| `reminder` | 6 | Create, edit, remove reminders | [Reminders](https://github.com/ardennguyen/zalo-agent-cli/wiki/Reminders) |
| `auto-reply` | 4 | Auto-reply rules | [Auto-Reply](https://github.com/ardennguyen/zalo-agent-cli/wiki/Auto-Reply) |
| `quick-msg` | 4 | Saved quick messages | [Quick Messages](https://github.com/ardennguyen/zalo-agent-cli/wiki/Quick-Messages) |
| `label` | 2 | Conversation labels | [Labels](https://github.com/ardennguyen/zalo-agent-cli/wiki/Labels) |
| `catalog` | 10 | zBusiness catalogs & products | [Catalog](https://github.com/ardennguyen/zalo-agent-cli/wiki/Catalog) |
| `bank` | 5 | Saved bank accounts, supported banks | [Bank](https://github.com/ardennguyen/zalo-agent-cli/wiki/Bank) |
| `listen` | 1 | Real-time listener, webhook, JSONL, local cache writes | [Listener](https://github.com/ardennguyen/zalo-agent-cli/wiki/Listener) |
| `mcp` | 3 | MCP server (`start`, `wait`, `mark-read`) — 25 tools for AI agents + zero-polling CLI | [MCP Server](https://github.com/ardennguyen/zalo-agent-cli/wiki/MCP-Server) |
| **`oa`** | **32** | **Zalo Official Account API v3.0 — OAuth, messaging, followers, tags, articles, store, webhook** | **[Official Account](https://github.com/ardennguyen/zalo-agent-cli/wiki/Official-Account)** |

See also: [Multi-Account & Proxy](https://github.com/ardennguyen/zalo-agent-cli/wiki/Multi-Account-&-Proxy) · [VPS Setup](https://github.com/ardennguyen/zalo-agent-cli/wiki/VPS-Setup) · [Bank Card & QR Payments](https://github.com/ardennguyen/zalo-agent-cli/wiki/Bank-Card-&-QR-Payments) · [Local Cache & Sync](https://github.com/ardennguyen/zalo-agent-cli/wiki/Local-Cache-&-Sync) · [Security](https://github.com/ardennguyen/zalo-agent-cli/wiki/Security)

### Features

- QR login over an auto-started HTTP server (browser + terminal), reporting a **decline on the phone** immediately instead of hanging until the 60s timeout
- Multi-account with a dedicated proxy (1:1) and a per-account device fingerprint; run **multiple live accounts simultaneously** (one `mcp start` or `listen` process per account with `--account <ID>`, plus `--account <ID>` / `ZALO_ACCOUNT` on any CLI command without mutating `accounts.json`)
- **222 commands** covering the personal-account Zalo surface
- **Zalo Official Account (OA) API v3.0** — OAuth login, messaging, followers, tags, articles, store, webhook listener, multi-OA
- **MCP server** (stdio + HTTP/HTTPS + OAuth 2.0) — 25 tools for Claude Code, Gemini and other MCP clients: read, wait for incoming messages (`zalo_wait_for_message`), send (text, local file/image attachments, link previews, contact cards, to My Documents too, marked Important/Urgent), search cached messages, look up users, manage conversation labels (`zalo_label`), list friends and handle friend requests (`zalo_friend`), inspect, create and manage groups and leave them (`zalo_group`), react, recall, forward, delete, reminders, group notes/pins, group polls, list a group's members, list recent conversations, and check how complete the cache is
- **Local SQLite cache** — `listen` writes every message to `zalo.db`, `msg history` reads from it, and `sync` (or `sync-mobile`) restores full history from the phone into `zalo.db` (transfer-sync-v2 decrypt; one confirmation on the phone), defaulting to **all** history (the old 2024-01-01 floor is gone), with `--days <n>` or `--from <YYYY-MM-DD>` to narrow it. Housekeeping: `sync-media --prune <days|all>` reclaims disk while keeping message text, `--prune-orphans` targets conversations the account no longer has, and `conv forget` removes a conversation's local copy entirely — none of which contact Zalo. The sync stream carries media **links**, not files, so a `sync-mobile` run **downloads its attachments automatically** once the messages are stored (`--messages-only` skips it); `sync-media` re-runs or resumes that fetch on its own, with no phone confirmation. Notes, pinned messages, polls and reminders live outside the message stream — `sync-boards` fetches those
- Automatic media download — one downloader shared by `listen`, `msg history`, `mcp start` and the sync commands, saving to `~/.zalo-agent-cli/accounts/<id>/media/<threadId>/` (or separate credentials, `zalo.db`, media, and OA credentials onto independent volumes/mounts via `--credentials-dir`, `--data-dir`, `--media-dir`, `--oa-dir` / `ZALO_*_DIR` in `~/.zalo-agent-cli/.env`; when using `zalo-mcp`, keep `zalo-mcp/.env` for PORT settings only and place all storage/engine settings in `<CONFIG_DIR>/.env`)
- Bank cards (55+ VN banks) and VietQR payment images
- Real-time listener with webhook forwarding and local JSONL archival. The webhook is **durable**: each event is written to disk first, then delivered in order, retried while the receiver is down, and kept across restarts (`mcp webhook status`)
- **Running many accounts**: `/health`, `/ready`, `/status` and `/metrics` (Prometheus), `fleet status|start|restart|generate`, log levels and `daemon.log` rotation, `ZALO_START_JITTER` / `ZALO_LOGIN_SLOTS` — see `docs/deployment.md` §4.7–4.8
- **Markdown** messages become real Zalo formatting (bold, italic, bullets, headings): the default in `zalo_send_message`, `msg send --markdown` on the CLI
- `logout` performs a real **server-side** session invalidation; `logout --purge` / `account remove` wipe all local data
- `--json` output on every command — scripting and AI agents
- Credentials stored locally with 0600 permissions
- **Dual mode**: interactive (human) and non-interactive (AI agents, CI/CD)

### Documentation

| Document | Contents |
|----------|----------|
| [INSTALLATION.md](INSTALLATION.md) ([VI](INSTALLATION.vi.md)) | `zalo-mcp` wrapper install, MCP client config, OA setup |
| [docs/official-account.md](docs/official-account.md) ([VI](docs/official-account.vi.md)) | Full OA command reference (bilingual EN / VN) |
| [docs/deployment.md](docs/deployment.md) ([VI](docs/deployment.vi.md)) | Production deployment guide (one socket, many bots, HTTPS, OAuth 2.0, systemd/Docker) |
| [skill/SKILL.md](skill/SKILL.md) | AI agent skill |
| [skill/references/command-reference.md](skill/references/command-reference.md) | Exhaustive command reference (source of truth) |
| [skill/references/mcp-guide.md](skill/references/mcp-guide.md) | MCP server guide (Vietnamese) |
| [skill/references/oa-command-reference.md](skill/references/oa-command-reference.md) | OA quick reference for agents |
| [skill/references/login-flow.md](skill/references/login-flow.md) | Login methods (QR, proxy, credentials file) |
| [skill/references/listen-mode-guide.md](skill/references/listen-mode-guide.md) | Listener and webhook operation |
| [tests/README.md](tests/README.md) | How to run and write the tests: offline suite, tiered live E2E, manual checklist |
| [DISCLAIMER.md](DISCLAIMER.md) | Full terms and risk warning |
| [AGENTS.md](AGENTS.md) | Project rules for AI coding agents |
| [Wiki](https://github.com/ardennguyen/zalo-agent-cli/wiki) | Public docs, bilingual EN + VN |

---

## License

zalo-agent-cli © 2026 Arden Nguyen Duc Huy is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). See [LICENSE](LICENSE) and [NOTICE](NOTICE). See [DISCLAIMER.md](DISCLAIMER.md) for full terms and risk warnings.

- **Free for non-commercial use** (personal, academic, research). **Commercial use is not licensed** — for example in a commercial product, to provide paid services, or in a company's business operations. To request a commercial license, [open an issue](https://github.com/ardennguyen/zalo-agent-cli/issues).
- **Credit required:** if you share this project or any part of it, as-is or modified (including inside another project), credit it as shown in [NOTICE](NOTICE), say whether you made changes, and link to the license.
- **ShareAlike:** shared modifications must be released under CC BY-NC-SA 4.0 (or a later version, or a compatible license listed by Creative Commons).
- Portions derived from MIT-licensed software — [zalo-agent-cli by PhucMPham](https://github.com/PhucMPham/zalo-agent-cli) and the patched [zca-js](https://github.com/RFS-ADRENO/zca-js) shipped inside the package — remain under the MIT License; see [NOTICE](NOTICE).
- Versions published before this change (2.0.0 and earlier) were released under the MIT License and keep those terms.
