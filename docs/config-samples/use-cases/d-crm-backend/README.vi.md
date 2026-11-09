# Trường hợp d: tài khoản Zalo làm backend cho CRM

[English](README.md) · VPS bên dưới: [c-vps-few-accounts](../c-vps-few-accounts/README.md) · Nền tảng: [docs/deployment.md §5.6](../../../deployment.md)

Bộ cấu hình của [trường hợp c](../c-vps-few-accounts/README.md) (một VPS, mỗi tài khoản một unit systemd, nhà cung cấp passphrase, `za`), cộng thêm những gì CRM cần: mọi tin nhắn đến được **đẩy** tới webhook của CRM, có chữ ký; gửi tin qua `POST /mcp`; trang phê duyệt và trang PIN được gửi tới CRM chứ không phải agent; **admin API** (policy lúc chạy, mức sử dụng, xuất dữ liệu) và **fleet controller** (thêm bằng QR, start/stop, đăng xuất và gỡ bỏ có bảo vệ, sự kiện `account_state`) trên một host quản trị mà chỉ địa chỉ của CRM truy cập được.

## 1. Các tệp

Mọi thứ từ c, cùng từng byte (bài test giữ chúng như vậy), trừ các tệp được đánh dấu **riêng**:

| Tệp trong thư mục này | Nội dung |
|---|---|
| `etc/systemd/system/zalo-mcp@.service`, `etc/systemd/system/zalo-mcp@.service.d/credentials.conf` | mỗi tài khoản một daemon, và mật khẩu lưu trữ của nó |
| `etc/systemd/system/zalo-mcp-purge.service`, `etc/systemd/system/zalo-mcp-purge.timer`, `etc/systemd/system/zalo-mcp-purge.service.d/credentials.conf` | dọn dẹp hằng giờ |
| `etc/systemd/system/zalo-fleet-check.service`, `etc/systemd/system/zalo-fleet-check.timer` | `fleet status --check` mỗi 5 phút |
| `etc/systemd/system/zalo-backup.service`, `etc/systemd/system/zalo-backup.timer`, `etc/systemd/system/zalo-backup.service.d/credentials.conf` | sao lưu hằng đêm |
| `etc/systemd/system/zalo-fleet-controller.service`, `etc/systemd/system/zalo-fleet-controller.service.d/credentials.conf` | fleet controller (`fleet serve`) trên 127.0.0.1:3899, và mật khẩu lưu trữ của nó (thêm bằng QR sẽ niêm phong phiên đăng nhập mới) |
| `etc/systemd/journald.conf.d/zalo.conf`, `etc/logrotate.d/zalo-policy-audit` | giới hạn journal, xoay vòng nhật ký audit |
| `etc/polkit-1/rules.d/50-zalo-fleet.rules` | cho phép `zalo` (controller, `za fleet ...`) start/stop/restart `zalo-mcp@*` |
| `etc/zalo-mcp/common.env` | **riêng**: của c, cộng thêm tệp admin token, `ZALO_MCP_APPROVAL_DELIVER=webhook`, cổng của controller, luồng QR, webhook, URL công khai và host proxy của các tài khoản (`ZALO_FLEET_DOMAIN`) |
| `etc/zalo-mcp/accounts/1000000000000000001.env`, `etc/zalo-mcp/accounts/1000000000000000002.env` | **riêng**: của c, cộng thêm URL webhook và secret ký riêng của mỗi tài khoản |
| `etc/caddy/Caddyfile` | **riêng**: host công khai (MCP, media, trang QR) và host quản trị (`/a/<id>/zalo/admin/*`, `/fleet/zalo/admin/*`), host sau chỉ cho địa chỉ của CRM |
| `home/zalo/.zalo-agent-cli/.env`, `home/zalo/.zalo-agent-cli/storage.json` | của c |
| `home/zalo/.zalo-agent-cli/mcp-config.json` | **riêng**: của c, với `approval.deliver: "webhook"` và `admin.tokenFile` |
| `usr/local/bin/za`, `ufw.sh` | của c |
| `clients/crm-webhook-receiver.mjs`, `clients/crm_webhook_receiver.py` | bộ nhận xác minh `X-Zalo-Signature` trên raw body và đọc một lô (đã test với bộ gửi thật) |
| `clients/crm-send-message.sh` | gửi tin dưới dạng JSON-RPC qua `POST /mcp` |
| `clients/admin-policy.sh` | console: đọc và PATCH một policy với `If-Match`, đọc mức sử dụng |

## 2. Các bước

1. Làm [c](../c-vps-few-accounts/README.md) từ bước 1 tới 5 (máy chủ, tường lửa, `za`, mật khẩu lưu trữ, tài khoản).
2. Sinh các tệp fleet như ở bước 6 của c, rồi dùng `common.env`, các tệp env tài khoản và Caddyfile **của thư mục này** thay cho các tệp được sinh ra, nhưng giữ các token đã sinh: chép dòng `ZALO_MCP_AUTH_TOKEN` của mỗi tài khoản vào tệp lấy từ đây. Đặt URL webhook và một secret **khác nhau** cho mỗi tài khoản (`openssl rand -hex 32`), địa chỉ egress thật của CRM thay cho `198.51.100.7`, và tên miền của bạn.
3. Thư mục env phải thuộc người dùng dịch vụ, vì thêm tài khoản bằng QR sẽ ghi tệp env của tài khoản mới vào đó:
   ```bash
   sudo chown -R zalo:zalo /etc/zalo-mcp/accounts && sudo chmod 700 /etc/zalo-mcp/accounts
   ```
4. Admin token (mỗi host một token, không bao giờ là token của agent):
   ```bash
   openssl rand -hex 32 | sudo install -m 600 -o zalo -g zalo /dev/stdin /etc/zalo-mcp/admin-token
   ```
   Đưa cùng giá trị đó cho console của CRM (kho secret của nó). Hoặc dùng `za policy token --rotate` và để trống `ZALO_MCP_ADMIN_TOKEN_FILE`.
5. Controller: cài unit và drop-in của nó, rồi khởi động mọi thứ:
   ```bash
   sudo install -m 644 etc/systemd/system/zalo-fleet-controller.service /etc/systemd/system/
   sudo install -D -m 644 etc/systemd/system/zalo-fleet-controller.service.d/credentials.conf /etc/systemd/system/zalo-fleet-controller.service.d/credentials.conf
   sudo systemctl daemon-reload
   sudo systemctl enable --now zalo-mcp@1000000000000000001 zalo-mcp@1000000000000000002 zalo-fleet-controller
   sudo systemctl enable --now zalo-mcp-purge.timer zalo-fleet-check.timer zalo-backup.timer
   ```
6. Phía CRM: chạy một bộ nhận (`clients/crm-webhook-receiver.mjs` hoặc `clients/crm_webhook_receiver.py`): xác minh chữ ký trên raw body, trả 2xx ngay lập tức, khử trùng lặp theo `accountId` + ID tin nhắn. Gửi tin: `clients/crm-send-message.sh`. Policy và mức sử dụng: `clients/admin-policy.sh` với `https://admin.zalo.example.com/a/<id>`. Tài khoản: controller tại `https://admin.zalo.example.com/fleet/zalo/admin/accounts`.

## 3. Kiểm tra

```bash
curl -s https://zalo.example.com/a/1000000000000000001/health
curl -s -o /dev/null -w '%{http_code}\n' https://zalo.example.com/a/1000000000000000001/zalo/admin/policy   # 404: không bao giờ có trên host công khai
# từ địa chỉ của CRM:
ZALO_ADMIN_URL=https://admin.zalo.example.com/a/1000000000000000001 ZALO_ADMIN_TOKEN_FILE=... ./clients/admin-policy.sh get
curl -s -H "Authorization: Bearer $(cat admin-token)" https://admin.zalo.example.com/fleet/zalo/admin/accounts
za mcp webhook status --account 1000000000000000001     # outbox: đang chờ, hỏng, lần thành công gần nhất
```

## 4. Presence, thời gian thực và Zalo của chính người dùng

- **Presence** (`mcp-config.json`, policy, hoặc `ZALO_PRESENCE_MODE` cho từng tài khoản): `on-demand` là mặc định cho máy chủ; socket đóng sau `idleTimeout` và mở lại ở lần gọi tool, lần chờ, yêu cầu CLI hoặc **CRM lease** (`POST /zalo/presence/leases`) kế tiếp. Những gì đến trong lúc đó được gửi sau khi kết nối lại, đánh dấu `catchUp: true`. `always-on` là giao nhận thời gian thực, gói trả phí: tối đa `presence.alwaysOn.maxPerUser` (1) cho mỗi người dùng, tài khoản cũ nhất bị hạ xuống khi một tài khoản mới vượt giới hạn. `listen -d` cũng đọc cùng khối `presence` này.
- **Yielded.** Một bản sao thứ hai của cùng phiên đăng nhập (một máy khác, một tab trình duyệt thứ hai của cùng phiên đăng nhập) lấy socket: daemon vẫn chạy, `account_state: yielded`, và từ chối yêu cầu với `YIELDED`. Không có gì tự lấy lại tài khoản: khi người dùng đã đóng phiên kia, CRM xác nhận bằng `POST https://admin.zalo.example.com/fleet/zalo/admin/accounts/<id>/presence/resume` (hoặc `za --account <id> presence resume --yes`).
- **Một phiên đăng nhập web cho mỗi tài khoản.** Khách hàng đăng nhập cùng tài khoản vào **Zalo Web** bằng QR sẽ đăng xuất máy chủ (daemon vẫn chạy, `account_state: signed_out`, và từ chối yêu cầu với `SIGNED_OUT`): hãy thêm lại bằng QR qua controller, vốn tự khởi động lại daemon (`restarted: "relogin"`). Mỗi lần đăng nhập QR thêm một mục mới vào danh sách thiết bị trên điện thoại (các mục web cũ hiện là đã đăng xuất); đăng nhập lại thì giữ nguyên mã thiết bị, nên các tin đang xếp hàng vẫn còn. **Điện thoại** và **ứng dụng Zalo PC** cùng tồn tại với máy chủ. Hãy dặn người dùng: điện thoại hoặc Zalo PC, không dùng Zalo Web.
- **Phiên đăng nhập hết hạn sau khoảng 90 ngày.** Zalo không bao giờ gia hạn một lần đăng nhập QR, nên CRM nên báo người dùng từ sớm trước ngày đó. `GET /fleet/zalo/admin/accounts` có `session: {expiresAt, daysLeft, expired}` cho mỗi tài khoản (hãy hiển thị `daysLeft`), và SSE của controller (`GET /fleet/zalo/admin/events`) cùng webhook của nó (`ZALO_FLEET_WEBHOOK`) gửi sự kiện `session_expiring` `{accountId, expiresAt, daysLeft, expired, threshold, ...}` khi còn 14, 7, 3 và 1 ngày và khi đã hết hạn (webhook riêng của mỗi tài khoản cũng nhận). Gia hạn bằng lệnh thêm QR của controller (`POST /fleet/zalo/admin/accounts/qr {userId}`): người dùng quét, controller khởi động lại daemon (`restarted: "relogin"`), và ngày hết hạn lùi thêm 90 ngày. Như ở c, `fleet status` hiển thị cột `LOGIN ENDS`, timer kiểm tra thất bại khi còn 7 ngày trở xuống, và `zalo_session_days_left` kích hoạt các rule cảnh báo `ZaloSessionEndingSoon` / `ZaloSessionEndingNow`. Quá hạn, tài khoản chuyển sang `account_state: signed_out` và từ chối yêu cầu với `SIGNED_OUT` cho đến lần thêm QR đó.
- Tài khoản thêm bằng QR nhận tệp env từ controller: cổng, một token mới và `ZALO_MCP_PUBLIC_URL` của nó (`https://<ZALO_FLEET_DOMAIN>/a/<id>`, đúng như `fleet generate --domain` ghi; `fleet serve --domain` cũng vậy). Hãy thêm các khối `/a/<id>/` của nó vào Caddyfile (cả hai host) và reload Caddy. `common.env` tin cậy proxy (`ZALO_MCP_TRUSTED_PROXIES`); trên host mà env chung chưa đặt, controller ghi `ZALO_MCP_TRUSTED_PROXIES=127.0.0.1` vào tệp env của tài khoản mới và báo điều đó khi khởi động.

## 5. Những gì còn đang chờ

Được theo dõi trong kế hoạch presence và vòng đời: lệnh nhập dữ liệu xuất từ CRM, người dùng và tenant trải trên nhiều host.
