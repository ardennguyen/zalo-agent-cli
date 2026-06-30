# Local Cache & Full-Text Search

> **Available from v1.1.0**

`zalo-agent-cli` lưu trữ tin nhắn, bạn bè và hội thoại vào cơ sở dữ liệu SQLite cục bộ
(`~/.zalo-agent-cli/accounts/<id>/zalo.db`) để cho phép truy vấn offline và tìm kiếm nhanh.

**[Tiếng Việt](#tổng-quan)** | **[English](#overview)**

---

## Tổng quan

### Cách hoạt động

```
zalo-agent listen   ──► WebSocket Zalo ──► ghi vào zalo.db (WAL mode)
                                                   │
zalo-agent conv recent       ◄── đọc từ zalo.db ──┤
zalo-agent msg history <id>  ◄── đọc từ zalo.db ──┤
zalo-agent msg search <query>◄── FTS5 search ─────┘
```

Mỗi khi `listen` đang chạy, **mọi sự kiện** (tin nhắn đến, yêu cầu kết bạn, v.v.) được
ghi ngay vào database. Các lệnh như `conv recent` và `msg history` sẽ đọc từ cache cục bộ
**trước tiên** — nhanh hơn và không tốn băng thông — rồi mới fallback về Zalo API nếu
cache trống.

### Cấu trúc database

| Bảng | Nội dung |
|------|----------|
| `contacts` | Bạn bè (uid, tên, số điện thoại, last_action) |
| `groups` | Nhóm (gid, tên, số thành viên) |
| `chats` | Trạng thái hội thoại (thread_id, tên, last_active, unread_count) |
| `messages` | Tin nhắn (msg_id, thread_id, nội dung, timestamp) |
| `messages_fts` | Virtual table FTS5 để tìm kiếm toàn văn bản |

### Bảo mật

- Database lưu tại `~/.zalo-agent-cli/accounts/<ownId>/zalo.db`
- Thư mục có quyền `0700`, file có quyền `0600` (chỉ owner đọc/ghi được)
- Mỗi tài khoản có database riêng biệt (account isolation)

---

## Lệnh

### `listen` — Đồng bộ thụ động

```bash
zalo-agent listen
# [db] Local SQLite cache active — events will be persisted to zalo.db
```

Khi chạy `listen`, mọi tin nhắn và sự kiện sẽ được ghi vào `zalo.db` trong nền.
Chỉ **một** tiến trình `listen` được phép chạy trên mỗi tài khoản — nếu cố khởi động thêm,
tool sẽ báo lỗi và thoát ngay.

### `friend list` — Cache-first friend list 🆕

```bash
zalo-agent friend list              # Cache-first (instant if seeded)
zalo-agent friend list --no-cache   # Force live fetch from Zalo + re-seeds cache
```

### `friend search` — Cache-first friend search 🆕

```bash
zalo-agent friend search "Phúc"              # Searches local contacts cache
zalo-agent friend search "Phúc" --no-cache   # Force live fetch then filter
```

### `conv recent` — Đọc từ cache

```bash
zalo-agent conv recent             # Đọc từ cache (nếu có)
zalo-agent conv recent --no-cache  # Bắt buộc fetch từ Zalo API
```

Lần đầu chạy: fetch từ Zalo và lưu vào cache.
Lần sau: đọc ngay từ cache — **tức thì, không cần mạng**.

### `msg history` — Lịch sử tin nhắn với cache

```bash
zalo-agent msg history <THREAD_ID>             # Đọc từ cache trước
zalo-agent msg history <THREAD_ID> --no-cache  # Fetch trực tiếp từ Zalo
```

Kết quả từ Zalo API cũng sẽ được ghi vào database (backfill) để dùng offline sau.

### `msg search` — Tìm kiếm toàn văn bản (FTS5) 🆕

```bash
# Tìm kiếm toàn bộ tin nhắn đã cache
zalo-agent msg search "xin chào"

# Giới hạn trong một thread cụ thể
zalo-agent msg search "xin chào" --thread <THREAD_ID>

# Giới hạn số kết quả
zalo-agent msg search "xin chào" -n 5

# Dạng JSON
zalo-agent msg search "xin chào" --json
```

> [!NOTE]
> `msg search` chỉ hoạt động trên tin nhắn **đã được cache** cục bộ.
> Bạn cần chạy `zalo-agent listen` trước để build cache.

---

## Tích hợp MCP (`zalo-agent mcp start`)

Khi chạy `zalo-agent mcp start`, mọi tin nhắn nhận qua WebSocket cũng được **tự động ghi vào `zalo.db`** (ngoài việc đưa vào in-memory buffer). Điều này có nghĩa là:

- `msg search` sẽ tìm được cả tin nhắn đến lúc MCP đang chạy
- `msg history` sẽ đọc cache thay vì gọi Zalo API
- Cache tích lũy bất kể bạn dùng `listen` hay `mcp start`

```
zalo-agent mcp start
    → [mcp] Local SQLite cache active — events will be persisted to zalo.db
```

### MCP Tool: `zalo_get_history` với `no_cache`

Trong MCP, tool `zalo_get_history` cũng hỗ trợ cache-first:

```json
// Cache-first (mặc định)
{ "threadId": "uid123", "limit": 50 }

// Bắt buộc fetch live từ Zalo + backfill cache
{ "threadId": "uid123", "limit": 50, "no_cache": true }
```

Kết quả trả về có thêm trường `"source": "cache"` hoặc `"source": "live"`.

---

## Ví dụ workflow

```bash
# 1. Bắt đầu listen trong terminal thứ nhất
zalo-agent listen

# 2. Trong terminal thứ hai — thao tác thông thường nhưng giờ rất nhanh
zalo-agent friend list             # Danh sách bạn bè từ cache
zalo-agent friend search "Phúc"    # Tìm bạn từ cache
zalo-agent conv recent             # Đọc từ cache ngay lập tức
zalo-agent msg history <ID>        # Lịch sử từ cache
zalo-agent msg search "sinh nhật"  # Tìm kiếm toàn văn bản offline
```

---

## English

## Overview

### How it works

```
zalo-agent listen   ──► Zalo WebSocket ──► writes to zalo.db (WAL mode)
                                                   │
zalo-agent conv recent       ◄── reads from zalo.db ──┤
zalo-agent msg history <id>  ◄── reads from zalo.db ──┤
zalo-agent msg search <query>◄── FTS5 search ─────────┘
```

While `listen` is running, **every event** (incoming messages, friend requests, etc.) is
immediately persisted to the local database. Commands like `conv recent` and `msg history`
will read from the local cache **first** — fast and offline — and only fall back to the Zalo
API if the cache is empty.

### Database schema

| Table | Contents |
|-------|----------|
| `contacts` | Friends (uid, name, phone, last_action) |
| `groups` | Groups (gid, name, member count) |
| `chats` | Thread state (thread_id, name, last_active, unread_count) |
| `messages` | Messages (msg_id, thread_id, content, timestamp) |
| `messages_fts` | FTS5 virtual table for full-text search |

### Security

- Database stored at `~/.zalo-agent-cli/accounts/<ownId>/zalo.db`
- Directory permissions `0700`, file permissions `0600` (owner only)
- Each account has its own isolated database

---

## Commands

### `listen` — Passive sync daemon

```bash
zalo-agent listen
# [db] Local SQLite cache active — events will be persisted to zalo.db
```

While `listen` runs, every message and event is written to `zalo.db` in the background.
Only **one** `listen` process is allowed per account — a lock file prevents corruption.

### `friend list` — Cache-first friend list 🆕

```bash
zalo-agent friend list              # Cache-first (instant if seeded)
zalo-agent friend list --no-cache   # Force live fetch from Zalo + re-seeds cache
```

### `friend search` — Cache-first friend search 🆕

```bash
zalo-agent friend search "Phuc"              # Searches local contacts cache
zalo-agent friend search "Phuc" --no-cache   # Force live fetch then filter
```

### `conv recent` — Cache-first conversations

```bash
zalo-agent conv recent             # Reads from cache (if seeded)
zalo-agent conv recent --no-cache  # Force live fetch from Zalo
```

First run: fetches from Zalo and seeds the cache.  
Subsequent runs: reads instantly from cache — **no network required**.

### `msg history` — Cache-first message history

```bash
zalo-agent msg history <THREAD_ID>             # Cache-first
zalo-agent msg history <THREAD_ID> --no-cache  # Force live fetch
```

Live fetches are also backfilled into the database for future offline use.

### `msg search` — Full-text search (FTS5) 🆕

```bash
# Search all cached messages
zalo-agent msg search "hello"

# Limit to a specific thread
zalo-agent msg search "hello" --thread <THREAD_ID>

# Limit result count
zalo-agent msg search "hello" -n 5

# JSON output
zalo-agent msg search "hello" --json
```

> [!NOTE]
> `msg search` only works on **locally cached** messages.
> You need to run `zalo-agent listen` first to build the cache.

---

## MCP Integration (`zalo-agent mcp start`)

When running `zalo-agent mcp start`, every message received via WebSocket is also **automatically written to `zalo.db`** (in addition to the in-memory buffer). This means:

- `msg search` finds messages received while MCP was running
- `msg history` reads from cache instead of hitting Zalo's API
- Cache accumulates regardless of whether you use `listen` or `mcp start`

```
zalo-agent mcp start
    → [mcp] Local SQLite cache active — events will be persisted to zalo.db
```

### MCP Tool: `zalo_get_history` with `no_cache`

The `zalo_get_history` MCP tool also supports cache-first:

```json
// Cache-first (default)
{ "threadId": "uid123", "limit": 50 }

// Force live fetch from Zalo + backfill cache
{ "threadId": "uid123", "limit": 50, "no_cache": true }
```

The response includes a `"source"` field: `"cache"` or `"live"`.

---

## Example workflow

```bash
# 1. Start the listener in one terminal
zalo-agent listen

# 2. In another terminal — same commands, but now instant
zalo-agent friend list             # Friends from cache
zalo-agent friend search "Phuc"    # Search friends from cache
zalo-agent conv recent             # Reads from cache instantly
zalo-agent msg history <ID>        # History from cache
zalo-agent msg search "birthday"   # Offline full-text search
```
