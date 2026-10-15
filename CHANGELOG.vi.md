# Lịch sử thay đổi

[English](CHANGELOG.md)

## Chưa phát hành — 2026-10-15

- Chuyển đích sang `v2.0-dev`, mở CI cho nhánh này. Giữ changelog; chuyển tài
  liệu tính năng sang `docs/current-user-names.vi.md`, bỏ file ngữ cảnh gốc.

- Thêm `senderDisplayName` và `senderDisplayNameSource` hiện tại bên cạnh
  `senderName` lịch sử được giữ nguyên khi MCP/CLI đọc tin nhắn. Ưu tiên alias
  riêng của tài khoản, rồi `zaloName`, rồi UID.
- Cập nhật tên DM khi sync, kể cả hội thoại đã cache ngoài khoảng tin đang
  khôi phục, và khi MCP liệt kê/tìm hội thoại/thread. Xóa/đổi alias hoặc đổi
  tên profile không sửa tên trên tin nhắn hoặc thứ tự hoạt động.
- Bổ sung test phân trang, xóa/đổi alias, cách ly tài khoản, lỗi tra cứu,
  proxy API đang reconnect và tên hiện tại so với lịch sử. Lượt đọc hiển thị
  không ghi database.

- Phân giải ID người gửi trong lịch sử từ điện thoại thành UID và tên bằng bảng
  ánh xạ DM đã biết và cơ chế tra profile theo lô sẵn có; giữ rõ trạng thái chưa
  phân giải khi tra cứu thất bại.
- Bổ sung danh tính còn thiếu khi khôi phục lại tin mà không thay UID dạng số,
  tên không rỗng đã biết hoặc khôi phục nội dung tin đã thu hồi.
- Bổ sung test offline cho phân giải người gửi, bảo vệ dữ liệu khi khôi phục lại
  và tên trong lịch sử MCP. Cache cũ cần khôi phục tin bằng engine đã sửa;
  chỉ đọc lịch sử không tự bổ sung tên.

- Thêm notes 2.1.0 đề xuất cùng template chuẩn bị release trên cloud trong
  release_notes/; chưa kích hoạt workflow, tạo tag hay phát hành.

- Thêm `zalo_sync` (tin nhắn/phản ứng) và `zalo_sync_status`, tăng từ 12 lên 14
  tool MCP. Khởi động trả ngay; restore tin nhắn vẫn cần xác nhận điện thoại.
- Theo dõi job có giới hạn theo tài khoản qua các request stdio/HTTP, chống
  retry lặp và dùng chung khóa sync/history cùng runner của daemon.
- Giữ kết quả restore dở; không thêm writer, socket, migration hay deploy.
- Đề xuất phát hành engine 2.1.0 và wrapper 1.1.0, wrapper nhận ^2.0.1;
  npm mới có 2.0.0 nên cần đợi phát hành để tạo lại lockfile wrapper.

Mục này ghi nhận thay đổi chưa phát hành, không phải trạng thái xuất bản hay deploy.
