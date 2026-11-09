# Trường hợp b: máy chủ MCP HTTP trên máy tính hoặc mạng LAN của bạn

[English](README.md) · Cấu hình: [docs/configuration.md](../../../configuration.md) · Máy chủ trên internet: [c-vps-few-accounts](../c-vps-few-accounts/README.md)

Mỗi tài khoản một máy chủ MCP chạy lâu dài trên một máy Windows hoặc macOS, được các AI client trên cùng máy (loopback) hoặc cùng mạng LAN truy cập qua HTTP. Máy chủ vẫn chạy khi không có client nào mở, và tự chạy lại sau khi khởi động lại máy dưới dạng Windows service hoặc launchd agent.

Máy chủ HTTP chạy **theo nhu cầu** (on-demand, `presence` trong `mcp-config.json`): nó mở socket Zalo của tài khoản khi một client gọi tool hoặc chờ tin nhắn, và đóng socket sau 5 phút rảnh; những gì đến trong lúc đó được lấy từ hàng đợi ngoại tuyến của Zalo ở lần gọi kế tiếp (`catchUp: true`). Với webhook cần chạy thời gian thực, hãy đặt `"mode": "always-on"`.

## 1. Các tệp

| Tệp trong thư mục này | Đặt vào | Nội dung |
|---|---|---|
| `server-loopback.env` | `~/.zalo-agent-cli/server.env` | chỉ client trên máy này (127.0.0.1) |
| `server-lan.env` | `~/.zalo-agent-cli/server.env` | client trong mạng LAN (địa chỉ LAN, tường lửa chỉ mở cho subnet) |
| `home/.zalo-agent-cli/mcp-config.json` | `~/.zalo-agent-cli/mcp-config.json` | bộ lọc hội thoại, media, presence theo yêu cầu |
| `home/.zalo-agent-cli/storage.windows.json` | `~/.zalo-agent-cli/storage.json` trên Windows | tùy chọn: DPAPI CurrentUser, cấu hình mặc định |
| `home/.zalo-agent-cli/storage.macos.json` | `~/.zalo-agent-cli/storage.json` trên macOS | tùy chọn: keychain, cấu hình mặc định |
| `home/.zalo-agent-cli/.env` | `~/.zalo-agent-cli/.env` | tùy chọn: thiết lập mà mọi lệnh đều đọc |
| `windows/zalo-mcp-service.xml` | cạnh `zalo-mcp-service.exe` (WinSW) | Windows service, dừng êm bằng Ctrl+C |
| `macos/com.example.zalo-mcp.plist` | `~/Library/LaunchAgents/` | launchd agent của người dùng của bạn |
| `clients/claude-code-http-lan.json` | `.mcp.json` của client | Claude Code qua HTTP với bearer token |

Chọn một trong hai tệp `server-*.env` và sao chép thành `server.env`. Token **chỉ** nằm trong tệp đó (mode 600, hoặc trên Windows chỉ người dùng của bạn được đọc), không bao giờ nằm trên dòng lệnh.

## 2. Các bước

1. Cài đặt và đăng nhập như trong [a-desktop-stdio](../a-desktop-stdio/README.md) (shell thường, không bao giờ nâng quyền).
2. Tạo token: `openssl rand -hex 32` (hoặc `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) và đặt vào `server.env` dưới tên `ZALO_MCP_AUTH_TOKEN`.
3. Chạy thử ở foreground trước:
   ```bash
   zalo-agent --env-file ~/.zalo-agent-cli/server.env mcp start --account 1000000000000000001
   ```
   Dừng bằng Ctrl+C.
4. Chạy lâu dài:
   - **Windows:** WinSW (`zalo-mcp-service.xml`, dùng người dùng của bạn làm tài khoản service, không dùng LocalSystem): `.\zalo-mcp-service.exe install`, rồi `start`.
   - **macOS:** sửa các đường dẫn trong plist (`CHANGE_ME_USER`, `command -v zalo-agent`), rồi `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.zalo-mcp.plist`.
   - Hoặc, không dùng trình quản lý service: `zalo-agent --env-file ... mcp start --account <id> -d` (dừng khi đăng xuất hoặc khởi động lại máy).
5. Trong mạng LAN, chỉ mở cổng cho subnet: Windows `New-NetFirewallRule -DisplayName "Zalo MCP" -Direction Inbound -Protocol TCP -LocalPort 3847 -RemoteAddress 192.168.1.0/24 -Action Allow`; tường lửa ứng dụng của macOS sẽ hỏi ở lần khởi động đầu tiên.
6. Trỏ client tới máy chủ bằng `clients/claude-code-http-lan.json` (`ZALO_MCP_TOKEN` trong môi trường của client).

## 3. Kiểm tra

```bash
curl -s http://127.0.0.1:3847/health                                        # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://192.168.1.20:3847/mcp   # 401 khi không có token
zalo-agent mcp start --account 1000000000000000001 --status
```

Với http thường ngoài loopback, máy chủ không cấp link media (link mang token dùng một lần và cần https): ảnh được trả trực tiếp, media khác thành tệp tạm. Muốn có link trong mạng LAN, hãy cấp chứng chỉ cho máy chủ (`ZALO_MCP_TLS_CERT` / `ZALO_MCP_TLS_KEY` trong `server.env`).

## 4. Điện thoại, Zalo PC và Zalo Web

Zalo chỉ giữ **một phiên đăng nhập web cho mỗi tài khoản**, và máy chủ này chính là phiên đó. Đăng nhập QR vào **Zalo Web** sẽ đăng xuất máy chủ: service vẫn chạy nhưng trả lời mọi lệnh gọi bằng `SIGNED_OUT` cho đến khi bạn chạy lại `zalo-agent login` và khởi động lại service (`ZALO_EXIT_ON_SIGNED_OUT=1` trong `server.env` cho nó thoát mã 4 thay vào đó). **Điện thoại** và **ứng dụng Zalo PC** hoạt động song song với máy chủ. Hãy dùng chúng, không dùng Zalo Web. Mỗi lần đăng nhập QR thêm một mục mới vào danh sách thiết bị trên điện thoại (các mục web cũ hiện là đã đăng xuất); đăng nhập lại thì giữ nguyên mã thiết bị, nên hàng đợi tin nhắn bị lỡ của Zalo vẫn còn.

Và mỗi tài khoản chỉ chạy ở một nơi: một bản sao thứ hai của cùng phiên đăng nhập (một máy khác, hoặc `mcp start` chạy cạnh service) sẽ lấy socket. Khi đó máy chủ này **nhường lại**: nó vẫn chạy, trả lời `YIELDED`, và không tự lấy lại gì. Hãy đóng bản sao kia, rồi chạy `zalo-agent presence resume --yes --account <id>`.

## 5. Khi phiên đăng nhập sắp hết hạn

Một lần đăng nhập QR kéo dài khoảng 90 ngày và Zalo không bao giờ gia hạn. Máy chủ báo trước cho bạn: dòng khởi động in ra ngày hết hạn, `mcp start --status` cảnh báo từ khi còn 14 ngày, và một sự kiện hệ thống `session_expiring` (kèm `text`) đến agent qua `zalo_get_messages` / `zalo_wait_for_message` / `GET /events/wait`, vào log và vào webhook nếu có đặt, khi còn 14, 7, 3 và 1 ngày và khi đã hết hạn. Việc kiểm tra chạy lúc khởi động và mỗi giờ từ cookie đã lưu, không gửi gì tới Zalo, nên chế độ presence on-demand không làm nó trễ. Để gia hạn: `zalo-agent --account <id> login`, quét QR, rồi khởi động lại máy chủ (lệnh restart của service, hoặc `mcp start --account <id> --stop` rồi khởi động lại). Mã thiết bị giữ nguyên, nên hàng đợi tin nhắn bị lỡ của Zalo vẫn còn. Nếu để quá hạn, mọi lệnh gọi trả về `SIGNED_OUT` cho đến khi bạn đăng nhập lại.
