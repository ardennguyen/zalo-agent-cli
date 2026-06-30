# Local SQLite Cache & Full-Text Search

> **Available from v1.1.0-beta1**

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

## Ví dụ workflow

```bash
# 1. Bắt đầu listen trong terminal thứ nhất
zalo-agent listen

# 2. Trong terminal thứ hai — thao tác thông thường nhưng giờ rất nhanh
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

## Example workflow

```bash
# 1. Start the listener in one terminal
zalo-agent listen

# 2. In another terminal — same commands, but now instant
zalo-agent conv recent             # Reads from cache instantly
zalo-agent msg history <ID>        # History from cache
zalo-agent msg search "birthday"   # Offline full-text search
```
