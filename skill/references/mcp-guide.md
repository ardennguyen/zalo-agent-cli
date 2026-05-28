# Hướng dẫn Zalo MCP Server

Model Context Protocol (MCP) cho phép Claude Code và các MCP client tương tác với Zalo trực tiếp qua 4 tools tiêu chuẩn.

---

## Khởi động nhanh

### Chế độ stdio (Local — Claude Code)

```bash
zalo-agent mcp start
```

Thêm vào `.claude/settings.json`:

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

## Tham chiếu Tools

### `zalo_get_messages`
Lấy tin nhắn từ buffer, hỗ trợ cursor để đọc tăng dần.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `cursor` | string (tuỳ chọn) | Cursor từ lần gọi trước — chỉ lấy tin mới hơn |
| `limit` | number (tuỳ chọn) | Số tin tối đa (mặc định: 50) |
| `threadId` | string (tuỳ chọn) | Lọc theo thread cụ thể |

**Kết quả mẫu:**
```json
{
  "messages": [
    { "id": "msg123", "threadId": "uid456", "text": "Xin chào", "from": "uid789", "ts": 1710000000 }
  ],
  "nextCursor": "cursor_abc",
  "hasMore": false
}
```

---

### `zalo_send_message`
Gửi tin nhắn văn bản đến một thread.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `threadId` | string | ID của người dùng hoặc nhóm |
| `text` | string | Nội dung tin nhắn |
| `type` | number (tuỳ chọn) | 0 = DM (mặc định), 1 = nhóm |

**Kết quả mẫu:**
```json
{ "success": true, "msgId": "msg456", "ts": 1710000001 }
```

---

### `zalo_list_threads`
Liệt kê các thread đang hoạt động kèm số tin chưa đọc.

**Tham số:** không có (tuỳ chọn: `limit`, `unreadOnly`)

**Kết quả mẫu:**
```json
{
  "threads": [
    { "threadId": "uid456", "name": "Phúc", "unread": 3, "lastTs": 1710000000, "type": "user" },
    { "threadId": "gid789", "name": "Nhóm dự án", "unread": 0, "lastTs": 1709999000, "type": "group" }
  ]
}
```

---

### `zalo_mark_read`
Đánh dấu đã đọc — xoá tin khỏi buffer đến cursor chỉ định.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `cursor` | string | Cursor trả về từ `zalo_get_messages` |
| `threadId` | string (tuỳ chọn) | Chỉ mark một thread cụ thể |

---

## Cấu hình (mcp-config.json)

```json
{
  "watchThreads": ["uid123", "gid456"],
  "mode": "whitelist",
  "triggerKeywords": ["@agent", "!task"],
  "notify": {
    "groups": true,
    "dms": true
  },
  "limits": {
    "bufferSize": 500,
    "maxMessageAge": 3600
  }
}
```

| Trường | Mô tả |
|--------|--------|
| `watchThreads` | Danh sách thread ID cần theo dõi |
| `mode` | `whitelist` (chỉ watch) hoặc `all` (toàn bộ) |
| `triggerKeywords` | Chỉ buffer tin có chứa từ khoá này |
| `notify.groups` | Nhận thông báo từ nhóm |
| `limits.bufferSize` | Số tin tối đa trong ring buffer |
| `limits.maxMessageAge` | Tuổi tin tối đa (giây) |

---

## Kiến trúc

```
Zalo WebSocket
     ↓
Ring Buffer (in-memory, max bufferSize)
     ↓
Thread Filter (watchThreads / triggerKeywords)
     ↓
MCP Server (stdio hoặc HTTP)
     ↓
Claude Code / MCP Client
```

- **Auto-reconnect**: WebSocket tự kết nối lại khi mất mạng
- **Cursor-based**: Client đọc tăng dần, không bỏ sót tin
- **Stateless transport**: MCP server không lưu state — state nằm ở buffer

---

## Mẹo sử dụng

- Dùng `watchThreads` để lọc noise — chỉ nhận thread quan trọng
- Gọi `zalo_get_messages` định kỳ với cursor để polling tăng dần
- Dùng `zalo_mark_read` sau khi xử lý xong để buffer không đầy
- Trên VPS: thêm `--auth` để bảo vệ HTTP endpoint
- Kết hợp với `triggerKeywords` để chỉ xử lý khi có mention agent
