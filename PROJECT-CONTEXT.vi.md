# Ngữ cảnh dự án

[English](PROJECT-CONTEXT.md)

Cập nhật: 2026-10-15. Branch: `fix/sync-sender-identities`. Commit gốc: `f6b9914`.

## Thay đổi hiện tại

Tin nhắn khôi phục từ điện thoại trước đây lưu ID người gửi dạng mã hóa và tên
rỗng. Sync hiện phân giải người gửi trước transaction SQLite của từng chunk,
tái sử dụng danh tính DM trong bảng ánh xạ hội thoại và cơ chế gọi profile theo
lô `gid/decrypt` + `getUserInfo` sẵn có cho những người còn lại. Danh tính nhóm
không được dùng làm tên người gửi. Cache theo lần chạy tránh gọi lặp, kể cả khi
tra cứu thất bại. ID chưa phân giải được giữ nguyên với tên rỗng; không suy đoán
danh tính từ nội dung tin hoặc tên hội thoại.

Upsert tin nhắn hiện có thể bổ sung ID dạng số cho người gửi đang thiếu/chỉ có
ID mã hóa và điền tên còn trống khi tin được khôi phục lại. Giữ nguyên danh tính
dạng số đã biết, tên không rỗng, dấu thu hồi, đường dẫn file và trạng thái nhận/đọc
không giảm. MCP tiếp tục đọc trực tiếp các trường này từ cache.

## Kiểm tra và trạng thái

- Đã code cục bộ; đang chờ upstream review và phát hành.
- Test hồi quy: `tests/unit/sync-v2-senders.test.js`, gồm kết quả lịch sử MCP từ
  SQLite và bảo vệ trước danh tính người gửi mâu thuẫn.
- Kiểm tra bắt buộc: `npm run format`, `npm run lint`, `npm run format:check`, `npm test`.
- Đã pass cục bộ trên Node 24.11.0: 1.906 test đạt, 4 bỏ qua, 0 lỗi
  (`npm test -- --test-concurrency=4` chạy đủ bộ test, có giới hạn chạy đồng thời).
- Chưa sync tài khoản thật, sửa database production, cập nhật wrapper hoặc
  deploy. Test offline dùng danh tính giả và database cô lập.

## Vận hành và giới hạn

Không cần migration schema. Tin cũ được bổ sung danh tính khi chạy khôi phục
tin nhắn từ điện thoại bằng engine đã sửa. Restart MCP hoặc đọc lịch sử không
tự sửa các dòng cũ. Sao lưu database tài khoản trước khi khôi phục vận hành và
dùng tùy chọn `sync-mobile` trong `skill/references/command-reference.md`;
khôi phục cần xác nhận trên điện thoại.

Tra cứu profile theo khả năng đáp ứng. UID đã phân giải vẫn có thể chưa có tên
nếu profile không khả dụng. Người gửi chưa phân giải sẽ được thử lại trong lần
khôi phục sau, không gọi lại cho từng tin. Giữ nguyên cách chia lô và gọi endpoint
profile hiện có; không tạo listener thứ hai hoặc thêm credential tài khoản.
Wrapper tiếp tục dùng engine đã phát hành được ghim phiên bản, cho đến khi quy
trình phát hành/cập nhật thông thường cài phiên bản chứa bản sửa.

Tài liệu hiện có: `README.md`, `docs/deployment.md`, `docs/agent-notes.md` và
`skill/references/command-reference.md`.
