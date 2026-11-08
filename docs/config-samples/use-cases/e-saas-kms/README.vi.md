# Trường hợp e: host SaaS với khóa KMS cho từng tenant

[English](README.md) · VPS bên dưới: [c-vps-few-accounts](../c-vps-few-accounts/README.md) · Khóa: [docs/security.md](../../../security.md)

Một host (một shard của SaaS) chạy tài khoản của nhiều khách hàng, mỗi tài khoản là một unit `zalo-mcp@<ownId>` như trong [c](../c-vps-few-accounts/README.md), với nhà cung cấp khóa **`kms`**: keyring của mỗi tài khoản được bọc bằng một khóa KMS trên cloud mà host truy cập qua instance role của nó, mỗi tenant một khóa khác nhau. Bộ cấu hình này là một **thiết kế để bắt đầu**, chưa được chạy trọn vẹn từ đầu đến cuối: các backend KMS chưa được kiểm tra với dịch vụ thật.

## 1. Các tệp

| Tệp trong thư mục này | Nội dung |
|---|---|
| `etc/systemd/system/zalo-mcp@.service`, `etc/systemd/system/zalo-mcp-purge.service`, `etc/systemd/system/zalo-mcp-purge.timer`, `etc/systemd/system/zalo-fleet-check.service`, `etc/systemd/system/zalo-fleet-check.timer`, `etc/systemd/system/zalo-backup.service`, `etc/systemd/system/zalo-backup.timer` | những gì `fleet generate --provider kms` ghi ra: không có drop-in credential (instance role chính là credential) |
| `etc/systemd/journald.conf.d/zalo.conf`, `etc/logrotate.d/zalo-policy-audit`, `etc/polkit-1/rules.d/50-zalo-fleet.rules`, `ufw.sh` | như trong c |
| `etc/zalo-mcp/common.env` | được sinh ra, như trong c |
| `etc/zalo-mcp/accounts/1000000000000000001.env`, `etc/zalo-mcp/accounts/1000000000000000002.env` | được sinh ra, như trong c (không chứa khóa: xem `storage.json`) |
| `etc/caddy/Caddyfile` | được sinh ra: `/a/<id>/` cho mỗi tài khoản, admin API và metrics trả 404 |
| `home/zalo/.zalo-agent-cli/.env` | được sinh ra |
| `home/zalo/.zalo-agent-cli/storage.json` | `"provider": "kms"`, backend, ID khóa mặc định, và **khóa tenant của từng tài khoản** trong `accounts.<id>.kms.key`; retention 90 ngày cho tin nhắn, 30 ngày cho media |
| `home/zalo/.zalo-agent-cli/mcp-config.json` | thiết lập đa tài khoản (cổng, webhook, presence cho từng tài khoản) |
| `home/zalo/.zalo-agent-cli/tenants/tenant-a.json` | policy của một tenant thả vào dưới dạng JSON thuần: quota tenant, giới hạn presence, retention; daemon kiểm tra và niêm phong nó khi nhận |
| `usr/local/bin/za` | CLI dưới quyền `zalo` (không có dòng credential: KMS không cần) |

## 2. Các bước

1. Một host như ở bước 1 và 2 của c, có instance role (AWS) hoặc workload identity được phép `Encrypt`/`Decrypt` bằng khóa của các tenant, và SDK được cài cạnh engine (`sudo npm install -g @aws-sdk/client-kms`; GCP, Azure và Vault có SDK riêng).
2. `za fleet generate --out /tmp/fleet --provider kms --base-port 3901 --domain zalo.example.com`, cài đặt theo những gì nó in ra, rồi dùng `storage.json` **của thư mục này** (khóa mặc định của bạn và một `accounts.<id>.kms.key` cho mỗi tài khoản bạn đã biết).
3. Tài khoản được thêm bằng QR (controller của [d](../d-crm-backend/README.md), hoặc `za login` qua đường hầm SSH). Sau đó `za account security provider kms <id> --backend aws --key <tenant key>` (ID tài khoản là tham số: thiếu nó thì mọi tài khoản đều bị chuyển) bọc keyring của tài khoản đó bằng khóa của tenant của nó và ghi khóa vào `accounts.<id>.kms` trong `storage.json`; khóa mặc định giữ nguyên. Dừng unit của tài khoản trước, khởi động lại sau.
4. Tenant: thả `tenants/<tenantId>.json` vào `/home/zalo/.zalo-agent-cli/tenants/` (thuộc sở hữu của zalo); người dùng và tài khoản của họ qua admin API hoặc `za policy set accounts ... --user <id>`.
5. Khởi động như ở bước 7 của c.

## 3. Kiểm tra

```bash
za account security status --all          # provider kms, ID khóa của từng tài khoản (mỗi cái là khóa tenant của nó)
za fleet status
curl -s https://zalo.example.com/a/1000000000000000001/health
```

## 4. Giới hạn hiện tại

- **Khóa tenant nằm ở đâu.** Mỗi keyring ghi lại khóa đã bọc nó, và chính khóa đó mở nó trong mọi tiến trình: daemon, `za`, unit purge và unit backup, bất kể khóa mặc định trong `storage.json` hay `ZALO_KMS_KEY` là gì. `accounts.<id>.kms` trong `storage.json` là khóa dùng để tạo keyring mới cho tài khoản đó (khi đăng nhập lại sau khi xóa); nó được ưu tiên hơn khóa mặc định và `ZALO_KMS_KEY`. Đừng đặt `ZALO_KMS_KEY` trong tệp env của tài khoản: chỉ daemon của tài khoản đó đọc nó.
- **Góc nhìn của một host.** Mỗi host có `fleet.json`, admin token và thư mục `tenants/` riêng; một tenant trên nhiều host được console cộng gộp (`/zalo/admin/usage` trên mỗi host). Chưa có công cụ phân bổ hay chuyển tài khoản.
- **Credential quản trị theo host.** Mỗi host một admin token; với console của nhiều tenant hãy dùng mTLS (`ZALO_MCP_ADMIN_CLIENT_CA`).
- **Presence.** Mặc định on-demand, always-on theo gói trả phí (`presence.alwaysOn.maxPerUser` trong tệp tenant). Các daemon làm theo thiết lập này khi presence theo yêu cầu được bật.
- **Một phiên đăng nhập web cho mỗi tài khoản.** Khách hàng tự đăng nhập QR vào Zalo Web sẽ đăng xuất máy chủ; điện thoại và Zalo PC cùng tồn tại với máy chủ. Hãy dặn khách hàng: điện thoại hoặc Zalo PC, không dùng Zalo Web.
