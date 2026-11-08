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
ZALO_MCP_AUTH_TOKEN=<TOKEN> zalo-mcp --account <ACCOUNT_ID> --http 3847   # loopback; token lấy từ biến môi trường
zalo-mcp --account <ACCOUNT_ID> conv recent --json
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

Từ 3.0, tiến trình `mcp start --http` hoặc `listen --daemon` mặc định chạy chế độ
hiện diện theo nhu cầu (on-demand): khi rảnh nó tạm nghỉ socket nhưng vẫn giữ tài
khoản (khóa, port và daemon channel). Lệnh chạy một lần cho tài khoản đó vẫn đi qua
nó và đánh thức socket khi cần; không bao giờ mở socket thứ hai bên cạnh.

**Một lần đăng nhập, một nơi chạy.** Đừng bao giờ chạy hai bản của cùng một
credentials cùng lúc (cùng lần đăng nhập trên hai máy, hoặc thư mục cấu hình bị sao
chép): phiên thứ hai lấy socket (mã đóng 3000), và daemon on-demand khi đó chờ ở
trạng thái `yielded` cho đến khi có `zalo-agent presence resume --yes`. Zalo cũng chỉ
giữ một lần đăng nhập web cho mỗi tài khoản: đăng nhập Zalo Web bằng QR ở nơi khác sẽ
đăng xuất máy chủ (`signed_out`). Bên cạnh máy chủ, hãy dùng điện thoại hoặc Zalo PC,
không dùng Zalo Web.

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
   (`--http 3847`, `--http 3848`, …), mỗi tiến trình có token riêng trong
   `ZALO_MCP_AUTH_TOKEN_<ACCOUNT_ID>` (đừng dùng `--auth` trên dòng lệnh: nó hiện trong
   `ps`) và `--config` riêng nếu cần. `zalo-agent fleet ports`, `fleet generate` và
   `fleet start` giữ bảng port và các unit theo tài khoản giúp bạn
   ([configuration.vi.md §3.6](configuration.vi.md#36-nhiều-tài-khoản)).
4. **Gọi lệnh CLI song song:** truyền `--account <ACCOUNT_ID>` (hoặc `ZALO_ACCOUNT`)
   ở mỗi lệnh CLI để nhiều script/agent chạy cùng lúc không bao giờ tranh chấp
   `accounts.json`. Đổi cấu hình proxy lúc khởi động cần restart daemon tương ứng.
