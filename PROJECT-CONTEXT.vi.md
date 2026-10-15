# Ngữ cảnh dự án

[English](PROJECT-CONTEXT.md)

Cập nhật: 2026-10-15. Branch `feat/mcp-sync-requests`, dựa trên upstream main
`f6b9914`. Branch độc lập với PR #2 về tên người gửi và PR #3 về ghim tài khoản;
không gộp thay đổi chưa merge từ hai branch đó.

Đã code: `zalo_sync` khởi động sync tin nhắn hoặc phản ứng bằng runner sẵn có
của daemon; `zalo_sync_status` đọc tiến độ và kết quả. Bộ theo dõi theo tài
khoản giữ chung giữa các request HTTP và dùng khóa stage chung với CLI sync,
history/self-heal. Chi tiết, quyết định, bảo mật, rollout và kiểm thử thủ công:
[MCP sync](docs/mcp-sync.vi.md). Kiến trúc/runbook hiện có:
[deployment](docs/deployment.md).

Trạng thái: thay đổi source, chưa phát hành/deploy. Full gate đã qua:
1.927 test pass, 4 bỏ qua, 0 lỗi (tổng 1.931); format/lint/check đều đạt.
Chưa sync tài khoản thật hay migration database. Theo dõi việc gửi upstream
trên feature branch và tài liệu workspace. Wrapper vẫn ghim engine đã phát
hành 2.0.0, chưa thể có tool mới
cho tới khi phát hành engine và cập nhật wrapper.
Wrapper PR #1 đề xuất ^2.0.1; npm mới có 2.0.0 nên cần đợi engine phát hành
để tạo lại lockfile. Đề xuất engine/wrapper 2.1.0/1.1.0; chưa phát hành bản nào
trong công việc này.
