# Trường hợp a: một người, một máy tính, MCP qua stdio

[English](README.md) · Cài đặt: [INSTALLATION.md](../../../../INSTALLATION.md) · Cấu hình: [docs/configuration.md](../../../configuration.md)

Claude Desktop hoặc Claude Code trên máy Windows hay macOS của chính bạn tự khởi động máy chủ MCP qua stdio, cho một hoặc hai tài khoản Zalo của bạn. Không có gì lắng nghe trên mạng; không có gì chạy khi client đã đóng.

## 1. Các tệp

| Tệp trong thư mục này | Đặt vào | Nội dung |
|---|---|---|
| `home/.zalo-agent-cli/mcp-config.json` | `~/.zalo-agent-cli/mcp-config.json` (Windows `%USERPROFILE%\.zalo-agent-cli\`) | tùy chọn: bộ lọc hội thoại, media, chế độ xác nhận; presence luôn bật (stdio luôn giữ kết nối) |
| `home/.zalo-agent-cli/storage.windows.json` | `~/.zalo-agent-cli/storage.json` trên Windows | tùy chọn: ghi rõ cấu hình mặc định (DPAPI, tài khoản Windows của bạn) |
| `home/.zalo-agent-cli/storage.macos.json` | `~/.zalo-agent-cli/storage.json` trên macOS | tùy chọn: ghi rõ cấu hình mặc định (login keychain) |
| `home/.zalo-agent-cli/.env` | `~/.zalo-agent-cli/.env` | tùy chọn: thiết lập mà mọi lệnh đều đọc |
| `clients/claude-code.json` | `.mcp.json` của dự án (hoặc `claude mcp add`) | Claude Code, qua wrapper `zalo-mcp` |
| `clients/claude-desktop.json` | `claude_desktop_config.json` | Claude Desktop, mỗi tài khoản một mục |

Tệp của Claude Desktop: Windows `%APPDATA%\Claude\claude_desktop_config.json`, macOS `~/Library/Application Support/Claude/claude_desktop_config.json`.

## 2. Các bước

1. Cài Node 22 và engine: `npm install -g @ardennguyen/zalo-agent-cli` (hoặc trình cài đặt của wrapper `zalo-mcp`, [INSTALLATION.md](../../../../INSTALLATION.md)).
2. Đăng nhập từ một terminal thường (không bao giờ dùng shell Administrator hay `sudo`): `zalo-agent login`, quét mã QR bằng ứng dụng Zalo, rồi `zalo-agent account list` để lấy ID tài khoản.
3. Tùy chọn: sao chép `mcp-config.json`, tệp `storage.*.json` ứng với hệ điều hành của bạn (đổi tên thành `storage.json`) và `.env` vào `~/.zalo-agent-cli/`.
4. Đặt tệp client vào đúng chỗ, thay `1000000000000000001` bằng ID tài khoản của bạn. Trên macOS, Claude Desktop không thấy PATH của shell: hãy đặt cho `command` đường dẫn đầy đủ mà `command -v zalo-agent` in ra (ví dụ `/opt/homebrew/bin/zalo-agent`).
5. Khởi động lại client và yêu cầu nó liệt kê các cuộc trò chuyện Zalo gần đây.

Tài khoản thứ hai: thêm một mục thứ hai với `--account` riêng. Mỗi tài khoản là một tiến trình máy chủ.

## 3. Kiểm tra

```bash
zalo-agent account list                 # tài khoản, đang hoạt động
zalo-agent account security status      # các tệp được niêm phong bằng DPAPI / keychain
zalo-agent mcp start --account 1000000000000000001 --status   # chỉ khi client đang chạy nó
```

## 4. Điện thoại, Zalo PC và Zalo Web

Zalo chỉ giữ **một phiên đăng nhập web cho mỗi tài khoản**, và máy chủ này chính là phiên đó. Đăng nhập cùng tài khoản vào **Zalo Web** (chat.zalo.me) bằng QR sẽ đăng xuất máy chủ: phiên đăng nhập của nó bị từ chối, và mọi lệnh gọi tool trả về `SIGNED_OUT` cho đến khi bạn chạy lại `zalo-agent login` (quét QR) và khởi động lại client. **Điện thoại** và **ứng dụng Zalo PC** là các phiên đăng nhập riêng và hoạt động song song với máy chủ. Hãy dùng điện thoại hoặc Zalo PC, không dùng Zalo Web.

Mỗi lần đăng nhập QR thêm một mục mới vào danh sách thiết bị trên điện thoại (các mục web cũ hiện là đã đăng xuất). Đăng nhập lại cùng tài khoản thì giữ nguyên mã thiết bị, nên những tin Zalo xếp hàng cho nó trong lúc vắng mặt vẫn đến.

Cũng đừng chạy cùng một tài khoản trên hai client cùng lúc (Claude Desktop và Claude Code cùng khởi động `--account <same id>`): lần khởi động thứ hai sẽ thấy tài khoản đang được dùng.
