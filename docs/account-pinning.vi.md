# Ghim tài khoản cho listener hoặc MCP server

[English](account-pinning.md)

Thay đổi chưa phát hành. Mỗi tiến trình vẫn chỉ listen một tài khoản.

Kiểm tra ngày 2026-10-15 trên Node 24.11.0: format, lint không warning,
format check và đủ bộ test offline đạt (1.922 pass, 4 bỏ qua, 0 lỗi).

```sh
zalo-agent account list
zalo-agent listen --account <ACCOUNT_ID>
zalo-agent mcp start --account <ACCOUNT_ID>
```

Thay `<ACCOUNT_ID>` bằng ID số đầy đủ của tài khoản đã đăng ký. Không nhận tên,
ID rút gọn, giá trị rỗng hoặc ID chưa đăng ký. Giữ ID dạng chuỗi để không làm
tròn ID Zalo lớn. Flag không đổi tài khoản active chung và không đăng nhập
đồng thời mọi tài khoản đã lưu.

Khi bỏ qua flag, tài khoản active được chọn một lần lúc khởi động và cũng được
ghim. Đổi active trong registry sau đó không chuyển daemon đang chạy sang tài
khoản khác, kể cả khi reconnect hoặc retry.

Credentials, cấu hình proxy lúc khởi động, database, khóa, media, coverage và
daemon channel đều thuộc tài khoản đã chọn. Lấy khóa trước khi đăng nhập;
không cho listener/MCP thứ hai dùng cùng tài khoản. Đăng nhập lỗi lúc khởi động
sẽ nhả khóa. Thiếu credentials hoặc UID đăng nhập không khớp thì dừng, không
fallback tài khoản khác. Không cần migration registry/database hoặc sửa tin
nhắn đã lưu.

Muốn chạy nhiều tài khoản, dùng một tiến trình cho mỗi ID. MCP HTTP cần port
khác nhau, có thể dùng file `--config` và token xác thực riêng. Đổi cấu hình
proxy lúc khởi động cần restart daemon tương ứng.

Wrapper `zalo-mcp` được kiểm tra chỉ chuyển tiếp `--http` và `--auth`, chưa
chuyển tiếp flag này. Dùng entry point của engine đã phát hành
`zalo-agent mcp start --account <ACCOUNT_ID>` hoặc chờ wrapper hỗ trợ. Truyền
flag vào wrapper đó không ghim tài khoản. Bản sửa không thay wrapper đang
deploy hoặc cài engine chưa phát hành.

Test offline gồm chọn chính xác ID, không đổi active chung, reconnect nhiều lần
sau khi đổi active, proxy riêng, thiếu/lỗi/sai UID khi đăng nhập, khóa trước
đăng nhập, cleanup và lỗi MCP không ghi stdout. Chưa kiểm thử reconnect nhiều
tài khoản thật; cần môi trường test được cho phép sau review/release.
