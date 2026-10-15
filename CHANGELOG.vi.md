# Lịch sử thay đổi

[English](CHANGELOG.md)

## Chưa phát hành — 2026-10-15

- Phân giải ID người gửi trong lịch sử từ điện thoại thành UID và tên bằng bảng
  ánh xạ DM đã biết và cơ chế tra profile theo lô sẵn có; giữ rõ trạng thái chưa
  phân giải khi tra cứu thất bại.
- Bổ sung danh tính còn thiếu khi khôi phục lại tin mà không thay UID dạng số,
  tên không rỗng đã biết hoặc khôi phục nội dung tin đã thu hồi.
- Bổ sung test offline cho phân giải người gửi, bảo vệ dữ liệu khi khôi phục lại
  và tên trong lịch sử MCP. Cache cũ cần khôi phục tin bằng engine đã sửa;
  chỉ đọc lịch sử không tự bổ sung tên.

Mục này ghi nhận thay đổi chưa phát hành, không phải trạng thái xuất bản hay deploy.
