# Hướng dẫn Zalo MCP Server

Model Context Protocol (MCP) cho phép Claude Code và các MCP client tương tác với Zalo trực tiếp qua 7 tools.

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

## Local SQLite Cache (v1.1.0-beta1)

`mcp start` tự động ghi mọi tin nhắn nhận được vào `zalo.db` — ngoài in-memory buffer.
Điều này cho phép `zalo_get_history` đọc offline và `msg search` tìm được cả tin nhắn MCP.

```
[mcp] Local SQLite cache active — events will be persisted to zalo.db
```

Cache path: `~/.zalo-agent-cli/accounts/<ownId>/zalo.db`

---

## Tham chiếu Tools (7 tools)

### `zalo_get_messages`
Lấy tin nhắn từ buffer real-time, hỗ trợ cursor để đọc tăng dần.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `threadId` | string (tuỳ chọn) | Lọc theo thread cụ thể. Bỏ qua = tất cả |
| `since` | number (tuỳ chọn) | Cursor từ lần gọi trước — chỉ lấy tin mới hơn |
| `limit` | number (tuỳ chọn) | Số tin tối đa (mặc định: 20) |

**Kết quả mẫu:**
```json
{
  "messages": [
    { "id": "msg123", "threadId": "uid456", "text": "Xin chào", "senderId": "uid789", "timestamp": 1710000000 }
  ],
  "nextCursor": 5,
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
| `threadType` | number (tuỳ chọn) | 0 = DM (mặc định), 1 = nhóm |

**Kết quả mẫu:**
```json
{ "success": true, "messageId": "msg456" }
```

---

### `zalo_list_threads`
Liệt kê các thread đang có tin trong buffer kèm số tin chưa đọc.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `type` | string (tuỳ chọn) | `"dm"`, `"group"`, hoặc `"all"` (mặc định) |

**Kết quả mẫu:**
```json
{
  "threads": [
    { "threadId": "uid456", "name": "Phúc", "unread": 3, "threadType": "dm" },
    { "threadId": "gid789", "name": "Nhóm dự án", "unread": 0, "threadType": "group" }
  ],
  "total": 2
}
```

---

### `zalo_search_threads`
Tìm kiếm thread (nhóm/DM) theo tên — fuzzy, accent-insensitive.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `query` | string | Từ khoá tìm kiếm |
| `type` | string (tuỳ chọn) | `"dm"`, `"group"`, hoặc `"all"` |
| `limit` | number (tuỳ chọn) | Số kết quả tối đa (mặc định: 10) |

---

### `zalo_mark_read`
Đánh dấu đã đọc — xoá tin khỏi buffer đến cursor chỉ định.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `cursor` | number | Cursor trả về từ `zalo_get_messages` |

---

### `zalo_get_history`
Lấy lịch sử tin nhắn cũ. **Cache-first từ v1.1.0-beta1.**

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `threadId` | string | Thread ID |
| `threadType` | number (tuỳ chọn) | 0 = DM (mặc định), 1 = nhóm |
| `limit` | number (tuỳ chọn) | Số tin tối đa (mặc định: 50, tối đa: 200) |
| `lastMsgId` | string (tuỳ chọn) | Cursor pagination (chỉ dùng khi fetch live) |
| `no_cache` | boolean (tuỳ chọn) | `false` (mặc định) = đọc từ SQLite cache; `true` = fetch live từ Zalo + backfill cache |

**Kết quả mẫu (cache):**
```json
{
  "threadId": "uid456",
  "threadType": "dm",
  "count": 20,
  "messages": [ { "msgId": "m1", "text": "Xin chào", "timestamp": 1710000000, "source": "cache" } ],
  "source": "cache",
  "hint": "Use no_cache=true to fetch live from Zalo"
}
```

**Kết quả mẫu (live):**
```json
{
  "threadId": "uid456",
  "threadType": "dm",
  "count": 20,
  "messages": [ { "msgId": "m1", "text": "Xin chào", "timestamp": 1710000000, "source": "live" } ],
  "cursor": "msg_abc",
  "hasMore": true,
  "source": "live"
}
```

---

### `zalo_view_media`
Mở file media (ảnh, audio, video) bằng viewer hệ thống.

**Tham số:**
| Tên | Kiểu | Mô tả |
|-----|------|--------|
| `messageId` | string | Message ID có attachment media |
| `threadId` | string (tuỳ chọn) | Thread ID để tìm trong đó |
| `open` | boolean (tuỳ chọn) | Mở bằng viewer hệ thống (mặc định: true) |

---

## Cấu hình (mcp-config.json)

```json
{
  "watchThreads": ["dm:uid123", "group:gid456", "dm:*"],
  "triggerKeywords": ["@agent", "!task"],
  "notify": {
    "groups": true,
    "dms": true
  },
  "limits": {
    "bufferMaxSize": 500,
    "bufferMaxAge": "2h",
    "maxMessagesPerPoll": 20
  },
  "media": {
    "downloadDir": "~/.zalo-agent-cli/media",
    "autoOpen": true
  }
}
```

| Trường | Mô tả |
|--------|--------|
| `watchThreads` | Patterns thread cần theo dõi (`dm:*`, `group:*`, `*`) |
| `triggerKeywords` | Chỉ buffer tin có chứa từ khoá này |
| `limits.bufferMaxSize` | Số tin tối đa trong ring buffer |
| `limits.bufferMaxAge` | Tuổi tin tối đa (`"2h"`, `"30m"`) |

---

## Kiến trúc

```
Zalo WebSocket
     ↓
attachListenerHandlers
     ├──► SQLite zalo.db (passive write — ALL messages)   ← v1.1.0-beta1
     └──► Thread Filter (watchThreads / triggerKeywords)
               ↓
          Ring Buffer (in-memory, max bufferMaxSize)
               ↓
          MCP Server (stdio hoặc HTTP)
               ↓
          Claude Code / MCP Client
```

- **Auto-reconnect**: WebSocket tự kết nối lại khi mất mạng
- **Cursor-based**: Client đọc tăng dần, không bỏ sót tin
- **Cache-first**: `zalo_get_history` đọc SQLite trước khi gọi Zalo API
- **Dual-write**: Mọi tin nhắn đều vào cả SQLite lẫn buffer

---

## Mẹo sử dụng

- Dùng `watchThreads: ["dm:*"]` để nhận tất cả DM, `["group:gid123"]` cho một nhóm cụ thể
- Gọi `zalo_get_messages` định kỳ với `since` cursor để polling tăng dần
- Dùng `zalo_mark_read` sau khi xử lý xong để buffer không đầy
- Trên VPS: thêm `--auth` để bảo vệ HTTP endpoint
- Dùng `zalo_get_history` (không `no_cache`) để đọc lịch sử instant từ cache
- Kết hợp với `triggerKeywords` để chỉ xử lý khi có mention agent
- Xem [docs/local-cache.md](../../docs/local-cache.md) để biết thêm về SQLite cache
