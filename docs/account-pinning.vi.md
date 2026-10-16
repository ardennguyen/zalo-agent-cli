# Ghim tài khoản cho listener, MCP server hoặc lệnh CLI

[English](account-pinning.md)

Mỗi tiến trình `listen` hoặc `mcp start` lắng nghe đúng một tài khoản, và mọi
lệnh CLI tài khoản cá nhân đều có thể nhắm thẳng vào một tài khoản đã đăng ký
cho tiến trình đó mà không làm đổi tài khoản active chung trong `accounts.json`.

```sh
zalo-agent account list
zalo-agent listen --account <ACCOUNT_ID>
zalo-agent mcp start --account <ACCOUNT_ID>
zalo-agent --account <ACCOUNT_ID> msg send <THREAD_ID> "Xin chào" --json
ZALO_ACCOUNT=<ACCOUNT_ID> zalo-agent conv recent --json

# Hoặc qua zalo-mcp launcher (v2.0+):
zalo-mcp --account <ACCOUNT_ID>
zalo-mcp --account <ACCOUNT_ID> --http 3847 --auth <TOKEN> --host 0.0.0.0
zalo-mcp --account <ACCOUNT_ID> msg list --json
```

Thay `<ACCOUNT_ID>` bằng ID số đầy đủ của tài khoản đã đăng ký (hoặc đặt biến
môi trường `ZALO_ACCOUNT=<ACCOUNT_ID>`). Không nhận tên, ID rút gọn, giá trị
rỗng hoặc ID chưa đăng ký. Giữ ID dạng chuỗi để không làm tròn ID Zalo lớn. Flag
không đổi tài khoản active chung trong `accounts.json` và không đăng nhập đồng
thời mọi tài khoản đã lưu.

Khi bỏ qua `--account` (và `ZALO_ACCOUNT`), `listen` và `mcp start` chọn tài
khoản active một lần lúc khởi động và ghim cố định suốt vòng đời tiến trình.
Lệnh `account switch` sau đó không chuyển daemon đang chạy sang tài khoản khác,
kể cả khi reconnect hoặc retry.

Credentials, cấu hình proxy lúc khởi động, database (`<DATA_DIR>/<ownId>/zalo.db`),
khóa (`daemon.lock`), media, coverage và daemon channel (`daemon-channel.json`)
đều thuộc tài khoản đã chọn. Với `listen` và `mcp start`, khóa được lấy trước
khi đăng nhập; tiến trình listener/MCP thứ hai dùng cùng tài khoản sẽ bị từ chối.
Đăng nhập lỗi lúc khởi động sẽ nhả khóa. Thiếu credentials hoặc UID đăng nhập
không khớp thì dừng ngay, không fallback sang tài khoản khác. Các lệnh CLI chạy
một lần kèm `--account <ACCOUNT_ID>` tự động định tuyến các thao tác cần socket
(upload media, `msg history`, `sync`) qua `daemon-channel.json` của đúng daemon
thuộc tài khoản đó nếu đang chạy.

## Chạy nhiều tài khoản live cùng lúc

Để duy trì nhiều tài khoản Zalo hoạt động đồng thời:

1. **Đăng nhập từng tài khoản** (khuyến nghị mỗi tài khoản dùng một proxy riêng):
   ```sh
   zalo-agent account login -p "http://user:pass@proxy1:8080" -n "Tài khoản A"
   zalo-agent account login -p "http://user:pass@proxy2:8080" -n "Tài khoản B"
   zalo-agent account list
   ```
2. **MCP chế độ stdio (Claude Code / Cursor):** khai báo mỗi tài khoản một mục
   trong `mcpServers` với `"args": ["mcp", "start", "--account", "<ACCOUNT_ID>"]`
   (hoặc `"command": "zalo-mcp", "args": ["--account", "<ACCOUNT_ID>"]`).
3. **MCP chế độ HTTP (VPS):** chạy mỗi tài khoản một tiến trình trên port riêng
   (`--http 3847`, `--http 3848`, …) kèm `--auth` token riêng (và `--config` riêng nếu cần).
4. **Gọi lệnh CLI song song:** truyền `--account <ACCOUNT_ID>` (hoặc `ZALO_ACCOUNT`)
   ở mỗi lệnh CLI để nhiều script/agent chạy cùng lúc không bao giờ tranh chấp
   `accounts.json`. Đổi cấu hình proxy lúc khởi động cần restart daemon tương ứng.
