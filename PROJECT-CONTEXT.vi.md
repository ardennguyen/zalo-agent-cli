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
không giảm.

Tên hiển thị hiện tại được tách khỏi tên lưu trên tin nhắn:

- `senderName` giữ nguyên tên lịch sử/được ghi nhận lần đầu. Lịch sử từ điện
  thoại không có tên gốc chỉ có thể điền tên còn trống bằng profile tại lúc
  khôi phục; không thể tái dựng tên ở thời điểm gửi trong quá khứ.
- `senderDisplayName` được tra lúc đọc theo UID: alias riêng của tài khoản,
  rồi `zaloName` của profile, rồi UID. `senderDisplayNameSource` là `alias`,
  `zalo` hoặc `uid`. Không dùng `displayName` có thể chứa bí danh để thay thế
  `zaloName` trong thứ tự này.
- MCP đọc buffer/lịch sử và CLI đọc lịch sử trả thêm các trường trên. CLI dạng
  văn bản hiển thị tên hiện tại. Lượt đọc không sửa SQLite hoặc tên lịch sử
  trong buffer.
- Tên hiện tại được tra mới theo từng tài khoản, có phân trang alias và chia
  lô profile 100 UID. Không giữ cache alias qua nhiều lượt đọc nên nhận biết
  được việc xóa alias. Bỏ toàn bộ snapshot alias không hoàn chỉnh/thất bại;
  profile không khả dụng thì fallback UID thay vì tên lịch sử đã cũ.
- Sync cập nhật tên chat 1-1 đã cache, gồm cả người chưa kết bạn nằm ngoài
  khoảng tin đang khôi phục, không đổi thứ tự hoạt động. Danh sách hội thoại,
  thread và tìm kiếm DM qua MCP cũng làm mới tên. Tên nhóm không bị thay bằng
  alias của thành viên.

## Kiểm tra và trạng thái

- Thay đổi dành cho [PR upstream #2](https://github.com/ardennguyen/zalo-agent-cli/pull/2);
  đang chờ upstream review và phát hành.
- Test hồi quy: `tests/unit/sync-v2-senders.test.js`, gồm kết quả lịch sử MCP từ
  SQLite và bảo vệ trước danh tính người gửi mâu thuẫn.
- Kiểm tra bắt buộc: `npm run format`, `npm run lint`, `npm run format:check`, `npm test`.
- Đã pass toàn bộ trên Node 24.11.0: 1.922 test đạt, 4 bỏ qua, 0 lỗi
  (`npm test -- --test-concurrency=4`). Test daemon loopback cần chạy ngoài
  sandbox chặn socket. Format và lint không có warning đều đạt.
- Chưa sync tài khoản thật, sửa database production, cập nhật wrapper hoặc
  deploy. Test offline dùng danh tính giả và database cô lập.

## Vận hành và giới hạn

Không cần migration schema. Tin cũ được bổ sung danh tính khi chạy khôi phục
tin nhắn từ điện thoại bằng engine đã sửa. Restart MCP hoặc đọc lịch sử không
tự sửa các dòng cũ. Sao lưu database tài khoản trước khi khôi phục vận hành và
dùng tùy chọn `sync-mobile` trong `skill/references/command-reference.md`;
khôi phục cần xác nhận trên điện thoại.

Tra cứu profile theo khả năng đáp ứng. UID đã phân giải dùng chính ID để hiển
thị khi alias/profile không khả dụng. Người gửi còn mã hóa được thử lại trong
lần khôi phục sau, không gọi lại cho từng tin. Việc hiển thị tên hiện tại gọi
thêm REST alias/profile theo lô thay vì từng tin, không tạo listener hoặc thêm
credential tài khoản. Chưa đo rate limit hoặc tải của API thật.
Wrapper tiếp tục dùng engine đã phát hành được ghim phiên bản, cho đến khi quy
trình phát hành/cập nhật thông thường cài phiên bản chứa bản sửa.

Tài liệu hiện có: `README.md`, `docs/deployment.md`, `docs/agent-notes.md` và
`skill/references/command-reference.md`.
