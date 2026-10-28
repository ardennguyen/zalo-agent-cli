# Sync qua MCP

[English](mcp-sync.md)

Engine cung cấp 27 MCP tool, bao gồm `zalo_sync` và `zalo_sync_status` (có từ
`@ardennguyen/zalo-agent-cli` v2.1.0+ và `@ardennguyen/zalo-mcp` v2.0.0+).
`mcp start --account <ID>` (hoặc `ZALO_ACCOUNT=<ID>`) ghim tiến trình vào đúng
tài khoản đã đăng ký lúc khởi động và qua các lần reconnect; hai tool sync chỉ
dùng runner và khóa của tài khoản đó, không nhận tham số đổi tài khoản theo
từng request.

## Cách dùng

Chỉ gọi `zalo_sync` khi chủ tài khoản yêu cầu đồng bộ rõ ràng. Kết quả coverage
hoặc tìm kiếm thiếu tin tự nó không cho phép gửi yêu cầu xác nhận tới điện thoại.

```json
{"requestId":"restore-october-1","stage":"messages","from":"2026-10-01"}
```

Tool trả ngay `jobId`, `state: "running"` và `phoneConfirmationRequired: true`.
Báo chủ tài khoản xác nhận trong ứng dụng Zalo trên điện thoại. Gọi
`zalo_sync_status` với `{"jobId":"<jobId vừa nhận>"}` mỗi vài giây. Bỏ jobId để
xem job mới nhất hoặc `{"state":"idle"}`.

Messages nhận `days` (số nguyên dương, tối đa 36500) **hoặc** `from` (ngày UTC
hợp lệ YYYY-MM-DD). Bỏ cả hai để lấy mọi lịch sử điện thoại còn giữ. Khoảng
thời gian áp dụng cho tất cả hội thoại, không giới hạn một nhóm. `waitMs` tùy
chọn từ 30000–600000 ms là ngân sách chờ mỗi giai đoạn, không phải toàn job.

Job messages còn nhận `fullResync` (hỏi điện thoại toàn bộ mọi hội thoại, bỏ qua phần các
lần chạy trước đã chốt: chạy lâu, dùng khi cache có vẻ thiếu) và `shardSize` (1 đến 30 hội
thoại mỗi lô, mặc định 30; ít hơn thì lô đầu về sớm hơn và mất ít hơn khi đứt kết nối). Cả hai
bị từ chối với reactions.

Đồng bộ hàng đợi phản ứng:

```json
{"requestId":"reactions-october-1","stage":"reactions","applyRemovals":true}
```

Reactions không có khoảng ngày hay prompt khôi phục trên điện thoại.
`applyRemovals` mặc định true, chỉ áp dụng sự kiện gỡ phản ứng đã nhận vào cache
cục bộ. Không gửi phản ứng hay sửa tin trên Zalo. Kết quả là các bộ đếm runner
và `socketAlive`. Đây chưa phải sync tổng hợp CLI: trạng thái hội thoại, board,
cloud index và media hàng loạt vẫn dùng CLI.

## Kết quả và thử lại

`completed` nghĩa là stage đã trả kết quả, không chứng minh khôi phục đầy đủ.
Kiểm tra `result.reason`, `confirmed`, số tin đã lưu và `zalo_coverage` sau đó.
Phải báo đúng kết quả `partial`, `timeout`, `socket-lost` hoặc chưa xác nhận.
Runner giữ dữ liệu đã nhận; bộ theo dõi job không thêm thao tác ghi database.
Lỗi trả `state: "failed"` và `error`; luôn nhả khóa stage.
Điện thoại từ chối yêu cầu, hủy, đang bận, thiếu dung lượng hoặc đã đăng xuất
cũng làm job thất bại, với lý do đó trong `error`: không khôi phục gì và không
ghi nhận là đã đồng bộ. Chỉ các xác nhận từ điện thoại mới tính là `confirmed`,
và thời gian chờ xác nhận là mười phút.

Dùng `requestId` riêng dài 1–64 ký tự (`A-Z a-z 0-9 . _ : -`) cho lần chạy mới.
Sau timeout phía client, thử lại cùng khóa **và tham số**: khi job còn được giữ,
tool trả job cũ, không khởi động sync hay gửi prompt lần nữa. Đổi tham số với
cùng khóa sẽ báo lỗi. Stage đang bận trả lỗi MCP ngay, không xếp hàng hay tự retry.

Process chỉ giữ mười job gần nhất và hai mươi sự kiện tiến độ gần nhất mỗi job
trong RAM. Job, kết quả và chống lặp mất khi restart hoặc bị thay thế. Nếu mất
response khởi động, xem job mới nhất. Sau khi daemon restart, kiểm tra coverage
trước khi quyết định sync lại. Đóng request MCP không hủy job. Chưa có tool hủy
vì runner chưa có cơ chế abort an toàn; không tạo job mới để hủy job cũ. Dừng
daemon ngắt công việc và có thể để lại restore dở. Mất socket thì khác: stage chờ daemon tự kết nối lại (tối đa 120 giây) rồi chạy tiếp, tối đa ba lần, chỉ hỏi điện thoại phần chưa về.

## Kiến trúc, bảo mật và kiểm thử

`mcp start` tạo một `createSyncJobs` dùng chung cho stdio và HTTP. HTTP tạo MCP
server mới mỗi request nhưng giữ chung bộ theo dõi job. Hai tool dùng đúng
`createSyncRunners` của daemon channel CLI, lấy API hiện tại mỗi lần chạy và
giữ chung khóa stage với history/self-heal. Không thêm login, WebSocket,
kết nối database hay writer thứ hai. Reconnect cập nhật các lần chạy sau;
mất socket giữa restore thì chờ daemon tự kết nối lại (tối đa 120 giây) và chạy tiếp,
tối đa ba lần, rồi mới kết thúc dở, như CLI sync qua daemon.

Tool dùng quyền MCP hiện có: cùng bearer token HTTP cho phép sync; stdio dùng
quyền process cục bộ của client. Không có ranh giới quyền riêng từng bot.
`zalo_sync_status` chỉ đọc, không liên hệ Zalo. Log vẫn ở stderr; không lưu job
bền vững hay migration schema. Rollback bằng engine đã phát hành trước đó và
restart client theo [hướng dẫn deploy](deployment.vi.md).

Kiểm thử offline gồm kiểm tra tham số qua SDK, khóa chống chạy chồng, retry
không lặp, giới hạn lưu trữ, lỗi/kết quả dở, cô lập trạng thái tài khoản và chọn
session hiện tại. Transport stdio thật và HTTP stateless dùng runner giả, dữ
liệu giả. Chưa chạy sync điện thoại thật hay deploy. Trước phát hành, maintainer
nên yêu cầu restore ngắn, xác nhận điện thoại, xem tiến độ tới khi xong và kiểm
tra coverage, rồi thử ngắt restore; dùng tài khoản test ngoài production.
