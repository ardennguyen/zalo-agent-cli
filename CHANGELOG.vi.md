# Lịch sử thay đổi

[English](CHANGELOG.md)

## Chưa phát hành — 2026-10-15

- Thêm `zalo_sync` (tin nhắn/phản ứng) và `zalo_sync_status`, tăng từ 12 lên 14
  tool MCP. Khởi động trả ngay; restore tin nhắn vẫn cần xác nhận điện thoại.
- Theo dõi job có giới hạn theo tài khoản qua các request stdio/HTTP, chống
  retry lặp và dùng chung khóa sync/history cùng runner của daemon.
- Giữ kết quả restore dở; không thêm writer, socket, migration hay deploy.
- Đề xuất phát hành engine 2.1.0 và wrapper 1.1.0, wrapper nhận ^2.0.1;
  npm mới có 2.0.0 nên cần đợi phát hành để tạo lại lockfile wrapper.
