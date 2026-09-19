# Hướng dẫn Zalo MCP Server

Model Context Protocol (MCP) cho phép Claude Code và các MCP client tương tác với Zalo (tài khoản cá nhân) trực tiếp qua **7 tools**. Lưu ý: Official Account (`oa ...`), catalog, poll, reminder, auto-reply, label hiện chỉ có ở CLI — chưa có MCP tool tương ứng.

---

## Khởi động nhanh

### Chế độ stdio (Local — Claude Code)

```bash
zalo-agent mcp start
```

Thêm vào `.claude/settings.json` (yêu cầu `zalo-agent` đã cài global hoặc `npm link`):

```json
{
  "mcpServers": {
    "zalo": {
      "command": "zalo-agent",
      "args": ["mcp", "start"]
    }
  }
}
```

### Chế độ HTTP (VPS — Remote)

```bash
zalo-agent mcp start --http 3847 --auth your-secret
```

Thêm vào cấu hình MCP client:

```json
{
  "mcpServers": {
    "zalo": {
      "url": "http://your-vps:3847",
      "headers": { "Authorization": "Bearer your-secret" }
    }
  }
}
```

---

## Tham chiếu Tools (7 tools)

### `zalo_get_messages`
Lấy tin nhắn đã buffer, hỗ trợ cursor để đọc tăng dần (incremental polling).

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `threadId` | string (tuỳ chọn) | Lọc theo thread cụ thể. Bỏ qua để đọc tất cả thread đang watch |
| `since` | number (mặc định 0) | Cursor từ lần gọi trước — chỉ lấy tin có cursor lớn hơn |
| `limit` | number (mặc định 20, tối đa 100) | Số tin tối đa trả về |

**Kết quả mẫu:**
```json
{
  "messages": [
    { "id": "msg123", "threadId": "uid456", "threadType": "dm", "senderId": "uid789", "senderName": "Phúc", "text": "Xin chào", "timestamp": 1710000000000, "type": "text", "threadName": "Phúc" }
  ],
  "cursor": 42,
  "hasMore": false
}
```
`cursor` trong kết quả là cursor của tin cuối cùng trả về — dùng lại cho lần gọi `since` tiếp theo, hoặc cho `zalo_mark_read`.

---

### `zalo_send_message`
Gửi tin nhắn văn bản đến một thread.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `threadId` | string | ID của người dùng hoặc nhóm |
| `text` | string | Nội dung tin nhắn (bắt buộc, không rỗng) |
| `threadType` | number (mặc định 0) | 0 = DM (User), 1 = nhóm |

**Kết quả mẫu:**
```json
{ "success": true, "messageId": "msg456" }
```

---

### `zalo_list_threads`
Liệt kê các thread đang có tin nhắn trong buffer, kèm số tin chưa đọc.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `type` | enum "group"\|"dm"\|"all" (mặc định "all") | Lọc theo loại thread |

**Kết quả mẫu:**
```json
{
  "threads": [
    { "threadId": "uid456", "unread": 3, "total": 5, "lastActivity": 1710000000000, "threadType": "dm", "name": "Phúc" },
    { "threadId": "gid789", "unread": 0, "total": 12, "lastActivity": 1709999000000, "threadType": "group", "name": "Nhóm dự án", "memberCount": 8 }
  ],
  "total": 2
}
```

---

### `zalo_search_threads`
Tìm thread theo tên, fuzzy matching có hỗ trợ tiếng Việt (bỏ dấu, không phân biệt hoa/thường). Hữu ích để tìm `threadId` theo tên.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `query` | string | Từ khoá tìm kiếm (bắt buộc) |
| `type` | enum "group"\|"dm"\|"all" (mặc định "all") | Lọc theo loại thread |
| `limit` | number (mặc định 10, tối đa 50) | Số kết quả tối đa |

**Kết quả mẫu:**
```json
{
  "results": [
    { "threadId": "gid789", "name": "Nhóm dự án", "type": "group", "memberCount": 8 }
  ],
  "total": 1
}
```
Lưu ý: cache tên thread được xây dựng lúc khởi động MCP server (fetch toàn bộ groups + friends). Nếu gọi ngay sau khi server vừa start có thể gặp lỗi "Thread name cache not initialized yet" — thử lại sau vài giây.

---

### `zalo_mark_read`
Xoá tin khỏi buffer đến cursor chỉ định — **áp dụng cho toàn bộ threads, không giới hạn theo 1 thread**.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `cursor` | number | Cursor trả về từ `zalo_get_messages` — xoá mọi tin có cursor ≤ giá trị này |

**Kết quả mẫu:**
```json
{ "success": true, "discarded": 5 }
```

---

### `zalo_get_history`
Lấy tin nhắn cũ (tối đa ~2 tuần) trực tiếp từ server Zalo — khác với `zalo_get_messages` (đọc từ buffer trong bộ nhớ). Dùng `lastMsgId` để phân trang. Cảnh báo: limit lớn có thể tốn nhiều băng thông/bộ nhớ — nên bắt đầu với limit nhỏ và phân trang dần.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `threadId` | string | ID thread cần lấy lịch sử |
| `threadType` | number (mặc định 0) | 0 = DM, 1 = nhóm |
| `limit` | number (mặc định 50, tối đa 200) | Số tin tối đa |
| `lastMsgId` | string (tuỳ chọn) | Cursor phân trang — lấy từ `cursor` của lần gọi trước |

**Kết quả mẫu:**
```json
{
  "threadId": "uid456",
  "threadType": "dm",
  "count": 30,
  "messages": [ { "msgId": "...", "threadId": "uid456", "senderId": "...", "senderName": "Phúc", "text": "...", "timestamp": 1709990000000, "type": "text" } ],
  "cursor": "abc123",
  "hasMore": true
}
```

---

### `zalo_view_media`
Mở file media (ảnh/audio/video) đã nhận bằng trình xem mặc định của hệ thống. Media được tự động tải về khi nhận (auto-download), tổ chức theo thư mục thread. Nếu chưa tải, tool sẽ tải trước rồi mở.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `messageId` | string | ID tin nhắn (từ `zalo_get_messages`) có đính kèm media |
| `threadId` | string (tuỳ chọn) | Giới hạn tìm kiếm trong 1 thread |
| `open` | boolean (mặc định theo config `media.autoOpen`) | Có mở bằng trình xem hệ thống hay không |

**Kết quả mẫu:**
```json
{ "success": true, "path": "/home/user/.zalo-agent-cli/media/Nhóm dự án/2026-09-19_Phúc_image.jpg", "mediaType": "image" }
```

---

## Cấu hình (`~/.zalo-agent-cli/mcp-config.json`)

File này tuỳ chọn — nếu không tồn tại, server dùng giá trị mặc định bên dưới. Chỉ cần ghi đè field muốn thay đổi (merge nông với default).

```json
{
  "watchThreads": ["dm:*", "group:*"],
  "mode": "manual",
  "triggerKeywords": ["@bot"],
  "notify": {
    "enabled": false,
    "thread": null,
    "on": ["dm"],
    "cooldown": "5m"
  },
  "limits": {
    "maxMessagesPerPoll": 20,
    "autoDigestThreshold": 50,
    "bufferMaxAge": "2h",
    "bufferMaxSize": 500
  },
  "media": {
    "downloadDir": null,
    "autoOpen": true
  }
}
```

| Trường | Mô tả |
|--------|--------|
| `watchThreads` | Danh sách thread cần theo dõi (hỗ trợ wildcard `dm:*`, `group:*`) |
| `mode` | Chế độ lọc thread (mặc định `manual`) |
| `triggerKeywords` | Chỉ áp dụng cho tính năng notify — không lọc buffer của `zalo_get_messages` |
| `notify.enabled` | Bật/tắt gửi thông báo khi agent offline (qua `ZaloNotifier`) |
| `notify.thread` | Thread ID nhận thông báo (mặc định không đặt) |
| `notify.on` | Loại thread kích hoạt thông báo, ví dụ `["dm"]` |
| `notify.cooldown` | Thời gian chờ tối thiểu giữa 2 lần thông báo, ví dụ `"5m"` |
| `limits.maxMessagesPerPoll` | Giá trị `limit` mặc định cho `zalo_get_messages` |
| `limits.autoDigestThreshold` | Ngưỡng số tin để kích hoạt digest (nếu bật) |
| `limits.bufferMaxAge` | Tuổi tin tối đa trong buffer trước khi bị dọn (ví dụ `"2h"`) |
| `limits.bufferMaxSize` | Số tin tối đa giữ lại mỗi thread |
| `media.downloadDir` | Thư mục lưu media tải về (mặc định `~/.zalo-agent-cli/media/`) |
| `media.autoOpen` | Giá trị mặc định cho tham số `open` của `zalo_view_media` |

---

## Kiến trúc

```
Zalo WebSocket (zca-js listener)
     ↓
Ring Buffer (in-memory, mỗi thread giữ tối đa bufferMaxSize tin, tự dọn theo bufferMaxAge)
     ↓
Thread Filter (watchThreads) + Thread Name Cache (groups/friends, fuzzy search)
     ↓
MCP Server (stdio hoặc HTTP) — registerTools() đăng ký cả 7 tools
     ↓
Claude Code / MCP Client
```

- **Auto-reconnect**: WebSocket tự kết nối lại khi mất mạng hoặc bị đóng; tự re-login nếu cần (trừ trường hợp phát hiện phiên trùng — `CLOSE_DUPLICATE` — thì thoát hẳn để tránh xung đột với phiên khác)
- **Cursor-based**: `zalo_get_messages`/`zalo_mark_read` dùng cursor dạng số nguyên tăng dần toàn cục (`_globalCursor`), không dùng chuỗi
- **Stateless transport**: MCP server không tự lưu file — toàn bộ state (buffer, cache) nằm trong bộ nhớ tiến trình, mất khi restart
- **Media auto-download**: ảnh/audio/video nhận được tự tải nền, tổ chức theo thư mục thread; `zalo_view_media` mở file có sẵn hoặc tải trước khi mở

---

## Mẹo sử dụng

- Dùng `watchThreads` để lọc noise — chỉ nhận thread quan trọng
- Gọi `zalo_get_messages` định kỳ với `since` = cursor của lần trước để polling tăng dần
- Dùng `zalo_mark_read` sau khi xử lý xong để buffer không đầy (nhớ: xoá toàn bộ threads, không chỉ 1 thread)
- Dùng `zalo_search_threads` khi chỉ biết tên người/nhóm, chưa biết `threadId`
- `zalo_get_history` chỉ nên dùng khi cần tin nhắn cũ hơn những gì buffer đang giữ (buffer chỉ có tin từ lúc server start)
- Trên VPS: thêm `--auth` để bảo vệ HTTP endpoint
- Official Account, catalog, poll, reminder, auto-reply, label: dùng CLI trực tiếp (`zalo-agent oa ...` v.v.) — chưa có MCP tool tương ứng
