# Trường hợp c: một VPS Linux, một quản trị viên, vài tài khoản

[English](README.md) · Chuyển tài khoản từ thư mục home Windows 2.5.9: [MIGRATE.md](MIGRATE.md) · Nền tảng: [docs/deployment.md](../../../deployment.md)

Một VPS Ubuntu 24.04 (Node 22.19+, Caddy, ufw), một người dùng dịch vụ `zalo`, một quản trị viên đăng nhập qua SSH, và hai tài khoản Zalo (ở đây là `1000000000000000001`, tài khoản chính, và `1000000000000000002`, tài khoản phụ; hãy dùng ID của bạn). Một tên miền, `zalo.example.com`, với tiền tố đường dẫn cho mỗi tài khoản: `https://zalo.example.com/a/<ownId>/mcp`. Khóa lưu trên đĩa được dẫn xuất từ một **mật khẩu lưu trữ** mà systemd trao cho service (`LoadCredentialEncrypted=`), nên bản sao lưu mở được trên máy mới chỉ với mật khẩu đó.

Mọi tệp ở đây là đúng những gì `za fleet generate --base-port 3901 --domain zalo.example.com` ghi ra cho hai tài khoản này (bài test `tests/unit/config-samples.test.js` giữ chúng đúng từng byte), cộng thêm `mcp-config.json`, `journald.conf.d/zalo.conf` và `ufw.sh`.

## 1. Các thành phần ghép với nhau thế nào

```
internet ──443──> Caddy ──/a/<id>/*──> 127.0.0.1:3901  zalo-mcp@1000000000000000001  ─┐
                    │                  127.0.0.1:3902  zalo-mcp@1000000000000000002  ─┼─ one Zalo socket each
                    └─ /zalo/admin/*, /metrics, /status: 404                          │
admin ──ssh──> `za ...` (the CLI as user zalo, same home, same passphrase) ───────────┘
timers: zalo-fleet-check (5 min) · zalo-mcp-purge (hourly) · zalo-backup (nightly)
```

- Mỗi tài khoản là một instance systemd `zalo-mcp@<ownId>`, token và cổng nằm trong `/etc/zalo-mcp/accounts/<ownId>.env`, không có gì trên dòng lệnh.
- Mọi thứ các daemon ghi ra đều nằm dưới `/home/zalo/.zalo-agent-cli` (`ReadWritePaths` duy nhất của unit). CLI bạn chạy tay (`za`) dùng cùng thư mục, cùng `.env` và cùng mật khẩu lưu trữ.
- Dừng, khởi động và khởi động lại một tài khoản bằng `systemctl` hoặc `za fleet stop|start|restart` (lệnh này gọi systemctl cho unit). Không bao giờ chạy `zalo-agent mcp start` cạnh một unit.

## 2. Các tệp

| Tệp trong thư mục này | Đặt vào | Chủ sở hữu, quyền | Nội dung |
|---|---|---|---|
| `etc/systemd/system/zalo-mcp@.service` | cùng đường dẫn | root, 644 | mỗi tài khoản một daemon |
| `etc/systemd/system/zalo-mcp@.service.d/credentials.conf` | cùng đường dẫn | root, 644 | trao mật khẩu lưu trữ cho daemon |
| `etc/systemd/system/zalo-mcp-purge.service`, `etc/systemd/system/zalo-mcp-purge.timer` | cùng đường dẫn | root, 644 | dọn dẹp quota/retention hằng giờ cho các tài khoản đang dừng |
| `etc/systemd/system/zalo-mcp-purge.service.d/credentials.conf` | cùng đường dẫn | root, 644 | mật khẩu lưu trữ cho việc dọn dẹp |
| `etc/systemd/system/zalo-fleet-check.service`, `etc/systemd/system/zalo-fleet-check.timer` | cùng đường dẫn | root, 644 | `fleet status --check` mỗi 5 phút |
| `etc/systemd/system/zalo-backup.service`, `etc/systemd/system/zalo-backup.timer` | cùng đường dẫn | root, 644 | hằng đêm `db backup` + keyring + thư mục cấu hình vào `/var/backups/zalo` |
| `etc/systemd/system/zalo-backup.service.d/credentials.conf` | cùng đường dẫn | root, 644 | mật khẩu lưu trữ cho việc sao lưu |
| `etc/systemd/journald.conf.d/zalo.conf` | cùng đường dẫn | root, 644 | giới hạn journal (500 MB, một tháng) |
| `etc/polkit-1/rules.d/50-zalo-fleet.rules` | cùng đường dẫn | root, 644 | cho phép `zalo` chỉ start/stop/restart `zalo-mcp@*` |
| `etc/logrotate.d/zalo-policy-audit` | cùng đường dẫn | root, 644 | xoay vòng `policy-audit.log` hằng tuần |
| `etc/zalo-mcp/common.env` | cùng đường dẫn | root, 600 | thiết lập chung của mọi unit (bind, nhật ký, jitter, proxy tin cậy) |
| `etc/zalo-mcp/accounts/1000000000000000001.env`, `etc/zalo-mcp/accounts/1000000000000000002.env` | cùng đường dẫn | root, 600 | cổng, **token** và URL công khai của từng tài khoản |
| `etc/caddy/Caddyfile` | cùng đường dẫn | root, 644 | TLS, `/a/<id>/` cho mỗi tài khoản, admin và metrics trả 404 |
| `home/zalo/.zalo-agent-cli/.env` | `/home/zalo/.zalo-agent-cli/.env` | zalo, 600 | được mọi lệnh chạy dưới quyền zalo đọc (đường dẫn của máy đặt ở đây) |
| `home/zalo/.zalo-agent-cli/storage.json` | cùng đường dẫn | zalo, 600 | nhà cung cấp khóa: `passphrase` |
| `home/zalo/.zalo-agent-cli/mcp-config.json` | cùng đường dẫn | zalo, 600 | thiết lập MCP; presence: tài khoản chính luôn bật, tài khoản phụ theo yêu cầu |
| `usr/local/bin/za` | cùng đường dẫn | root, 755 | chạy CLI dưới quyền `zalo`, giống cách các unit chạy |
| `ufw.sh` | chạy một lần | | tường lửa: chỉ SSH, 80, 443 |

`fleet generate` ghi các tệp env của tài khoản với **token mới**; các tệp ở đây mang `CHANGE_ME_64_HEX_CHARACTERS`. Đừng sao chép chúng: hãy tự sinh token của bạn (bước 6).

## 3. Các bước

Chạy bằng người dùng quản trị của bạn qua SSH. `<ver>` là phiên bản engine chính xác bạn triển khai (`npm view @ardennguyen/zalo-agent-cli versions`).

1. **Máy chủ.** Ubuntu 24.04, Node 22 (22.19 trở lên) từ NodeSource, `sudo apt install caddy polkitd`, rồi tạo người dùng dịch vụ và cài engine (ghim phiên bản, không bao giờ `@latest`):
   ```bash
   sudo adduser --system --group --home /home/zalo zalo
   sudo npm install -g @ardennguyen/zalo-agent-cli@<ver>
   command -v zalo-agent          # /usr/bin/zalo-agent; nếu không, truyền --bin cho fleet generate
   ```
2. **Tường lửa.** `sudo sh ufw.sh` (giữ phiên SSH mở cho tới khi `ufw status` đúng). Các cổng engine và cổng QR vẫn chỉ ở 127.0.0.1.
3. **Wrapper `za` và các tệp home.**
   ```bash
   sudo install -m 755 usr/local/bin/za /usr/local/bin/za
   sudo install -d -m 700 -o zalo -g zalo /home/zalo/.zalo-agent-cli
   sudo install -m 600 -o zalo -g zalo home/zalo/.zalo-agent-cli/.env home/zalo/.zalo-agent-cli/storage.json home/zalo/.zalo-agent-cli/mcp-config.json /home/zalo/.zalo-agent-cli/
   ```
   Điền ID tài khoản thật vào `mcp-config.json` (khối `accounts`) khi bạn đã biết chúng.
4. **Mật khẩu lưu trữ.** Tạo một mật khẩu, lưu nó trong trình quản lý mật khẩu (đó là cách duy nhất để mở bản sao lưu ở nơi khác), và lưu nó ở dạng mã hóa cho systemd. Nó không bao giờ nằm dạng rõ trong một tệp:
   ```bash
   openssl rand -base64 32                       # chép nó vào trình quản lý mật khẩu
   sudo install -d -m 755 /etc/zalo-mcp
   sudo -v && systemd-ask-password -n "Storage passphrase:" \
     | sudo systemd-creds encrypt --with-key=host --name=zalo-storage-passphrase - /etc/zalo-mcp/storage-passphrase.cred
   sudo chmod 600 /etc/zalo-mcp/storage-passphrase.cred
   ```
   Các drop-in credential (`credentials.conf`) và `za` đọc nó qua `LoadCredentialEncrypted=`; systemd giải mã nó cho mỗi lần chạy vào `$CREDENTIALS_DIRECTORY`, nơi nhà cung cấp passphrase tìm thấy nó. (Vì sao không dùng nhà cung cấp `systemd-creds`: trên systemd 255, bản Ubuntu 24.04 đi kèm, chỉ root mới giải mã được bằng host key; `systemd-creds --user` cho người dùng dịch vụ chỉ có từ bản 256.)
5. **Các tài khoản.** Hoặc chuyển chúng từ máy khác ([MIGRATE.md](MIGRATE.md)), hoặc đăng nhập mới, mỗi tài khoản một lần, bằng trang QR qua đường hầm SSH:
   ```bash
   # trên máy trạm của bạn:  ssh -L 18927:127.0.0.1:18927 admin@your-vps     rồi mở http://localhost:18927/qr
   za login
   za account list
   za account security status --all              # mọi tệp đều được niêm phong bằng mật khẩu lưu trữ
   ```
6. **Sinh các tệp fleet** cho các tài khoản máy này chạy, với cổng gốc và tên miền ở trên, rồi cài những gì nó in ra (kèm đường dẫn):
   ```bash
   za fleet generate --out /tmp/fleet --base-port 3901 --domain zalo.example.com
   ```
   Nó liệt kê các lệnh cài đặt theo thứ tự (tệp env, unit, các drop-in, `.env` và `storage.json` trong home mà bạn đã cài, `za`, polkit, logrotate, `/var/backups/zalo`, Caddyfile). Sau đó `sudo rm -r /tmp/fleet`. Cài `etc/systemd/journald.conf.d/zalo.conf` từ thư mục này và `sudo systemctl restart systemd-journald`.
7. **Khởi động.**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now zalo-mcp@1000000000000000001 zalo-mcp@1000000000000000002
   sudo systemctl enable --now zalo-mcp-purge.timer zalo-fleet-check.timer zalo-backup.timer
   journalctl -u zalo-mcp@1000000000000000001 -f     # cho tới khi thấy "account <id>: connecting -> connected"
   ```
8. **Client.** Token của mỗi tài khoản là `ZALO_MCP_AUTH_TOKEN` trong tệp env của nó (`sudo grep TOKEN /etc/zalo-mcp/accounts/<id>.env`). Claude Code:
   ```json
   { "mcpServers": { "zalo-main": { "type": "http", "url": "https://zalo.example.com/a/1000000000000000001/mcp",
       "headers": { "Authorization": "Bearer ${ZALO_MCP_TOKEN}" } } } }
   ```
9. **Admin token** (chỉ khi có console gọi admin API): `za policy token --rotate`, giữ nó ngoài VPS. Admin API chỉ trả lời trên loopback: `ssh -L 3901:127.0.0.1:3901 admin@your-vps`, rồi `http://127.0.0.1:3901/zalo/admin/...`.

## 4. Kiểm tra

```bash
curl -s https://zalo.example.com/a/1000000000000000001/health      # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' https://zalo.example.com/a/1000000000000000001/ready     # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://zalo.example.com/a/1000000000000000001/mcp   # 401 khi không có token
curl -s -o /dev/null -w '%{http_code}\n' https://zalo.example.com/a/1000000000000000001/zalo/admin/policy   # 404 từ internet
za fleet status                                                     # cả hai ok (hoặc idle)
systemctl list-timers 'zalo-*'                                      # ba timer
```

## 5. Vận hành

- **Dừng, khởi động, khởi động lại một tài khoản:** `sudo systemctl restart zalo-mcp@<id>` hoặc `za fleet restart <id>` (cả hai đều đi qua systemd). Khi một phiên khác của cùng phiên đăng nhập chiếm một tài khoản, tài khoản chính (always-on) kết thúc với mã thoát 3 và unit của nó cố ý nằm yên (`systemctl --failed`): hãy đọc `journalctl -u zalo-mcp@<id>`, đóng phiên kia, rồi khởi động nó. Tài khoản phụ (on-demand) thì nhường lại, vẫn chạy và từ chối yêu cầu cho đến khi `za --account <id> presence resume --yes`. Một phiên đăng nhập bị Zalo từ chối (`signed_out`) giữ cho cả hai daemon vẫn chạy; nó chỉ thoát mã 4 khi có `ZALO_EXIT_ON_SIGNED_OUT=1` (hoặc `ZALO_EXIT_ON_SIGNED_OUT_<id>=1`).
- **Tình trạng:** timer kiểm tra chạy `fleet status --check`; lỗi sẽ hiện trong `systemctl --failed` và `journalctl -u zalo-fleet-check`. Thêm `OnFailure=` vào `zalo-fleet-check.service` để được báo (mail, ntfy).
- **Hết hạn đăng nhập:** một lần đăng nhập QR kéo dài khoảng 90 ngày và Zalo không bao giờ gia hạn. `za fleet status` cho thấy thời gian còn lại ở cột `LOGIN ENDS` (`45d`, `10d!` từ khi còn 14 ngày, `ended`). Từ khi còn 14 ngày, timer kiểm tra ghi một dòng cảnh báo; khi còn 7 ngày trở xuống (hoặc đã hết hạn) nó **thất bại**, nên tài khoản hiện trong `systemctl --failed` và hook `OnFailure=` của bạn được gọi, kèm một dòng trong `journalctl -u zalo-fleet-check` dạng `<id>: session ends <date> (N day(s) left) - log in again by <date>: ...`. Mỗi daemon cũng gửi sự kiện `session_expiring` tới webhook của nó khi còn 14, 7, 3 và 1 ngày và khi đã hết hạn, và nếu bạn scrape `/metrics` qua loopback thì `zalo_session_days_left` kích hoạt các rule `ZaloSessionEndingSoon` / `ZaloSessionEndingNow` trong `docs/config-samples/monitoring/alert-rules.yml`. Để gia hạn, đăng nhập lại như ở bước 5 (`za --account <id> login`, trang QR qua cùng đường hầm SSH), rồi `za fleet restart <id>` (hoặc `sudo systemctl restart zalo-mcp@<id>`). Mã thiết bị giữ nguyên, nên hàng đợi ngoại tuyến của Zalo vẫn còn. Quá hạn, daemon vẫn chạy ở trạng thái `signed_out` cho đến khi bạn đăng nhập lại.
- **Nhật ký:** `journalctl -u 'zalo-mcp@*'`. `ZALO_LOG_LEVEL=info` trong `common.env`; không bao giờ dùng `debug` trên máy chủ (nó ghi cả nội dung tin nhắn).
- **Sao lưu:** hằng đêm vào `/var/backups/zalo`: `<id>-<time>.db` (`db backup` đã mã hóa), `<id>-<time>.keyring.json`, `config-<time>.tgz`; giữ 14 ngày. Hãy sao chép chúng ra khỏi máy. Không tệp nào mở được nếu thiếu mật khẩu lưu trữ trong trình quản lý mật khẩu của bạn. Khôi phục: một VPS mới cài đặt tới bước 4 với **cùng** mật khẩu lưu trữ, giải nén tar cấu hình vào `/home/zalo`, sao chép mỗi `.db` thành `accounts/<id>/zalo.db`, rồi làm bước 6.
- **Nâng cấp:** `sudo npm install -g @ardennguyen/zalo-agent-cli@<new>`, rồi khởi động lại một tài khoản, kiểm tra nó, rồi tới tài khoản kia (self-heal lấp khoảng thời gian khởi động lại).
- **Retention:** `za --account <id> policy set retention.media 180d` (hoặc `retention` trong `storage.json`); các daemon và timer dọn dẹp sẽ áp dụng.
- **Presence:** `mcp-config.json` giữ tài khoản chính luôn bật (webhook thời gian thực) và để tài khoản phụ chạy theo yêu cầu, mặc định của các daemon này: socket của nó đóng sau 5 phút rảnh và mở lại ở lần gọi tool, lần chờ hoặc yêu cầu `za` kế tiếp, và những gì đến trong lúc đó được lấy từ hàng đợi ngoại tuyến của Zalo (`catchUp: true`). `za presence status --account <id>` cho thấy trạng thái; `fleet status` hiển thị tài khoản đang nghỉ là `idle`. Đổi trực tiếp bằng `za --account <id> policy set presence.mode always-on`.

## 6. Điện thoại, ứng dụng máy tính và trình duyệt

Zalo chỉ giữ **một phiên đăng nhập web cho mỗi tài khoản**. Máy chủ chính là phiên web đó. Nếu ai đó đăng nhập cùng tài khoản vào **Zalo trên trình duyệt** bằng mã QR, Zalo sẽ đăng xuất máy chủ: lần đăng nhập bị từ chối, daemon vẫn chạy ở trạng thái `signed_out` (từ chối yêu cầu; `ZALO_EXIT_ON_SIGNED_OUT=1` cho nó thoát với mã 4 như trước) và tài khoản cần `za login` lại, rồi `sudo systemctl restart zalo-mcp@<id>`. **Điện thoại** và **ứng dụng Zalo trên máy tính** là các phiên đăng nhập riêng và hoạt động song song với máy chủ. Vì vậy: dùng điện thoại hoặc ứng dụng trên máy tính bên cạnh máy chủ, không bao giờ dùng trình duyệt. Mỗi lần `za login` thêm một mục mới vào danh sách thiết bị trên điện thoại (các mục web cũ hiện là đã đăng xuất); đăng nhập lại thì giữ nguyên mã thiết bị của tài khoản, nên những tin Zalo xếp hàng cho nó vẫn còn.

Hai bản sao của **cùng** một phiên đăng nhập đã lưu (VPS này và máy bạn chuyển nó từ đó sang) sẽ đá nhau ra (mã thoát 3; daemon on-demand thì nhường lại và từ chối yêu cầu cho đến khi `za presence resume --yes`). Mỗi tài khoản chỉ chạy ở một nơi.

## 7. Những gì vẫn cần kiểm tra thực tế trên VPS

- `systemd-run --pty/--pipe` với `LoadCredentialEncrypted=` (wrapper `za`) trên systemd 255, và việc `za` trả lại đúng mã thoát của lệnh (một lệnh có bảo vệ phải thoát với mã 2 khi không có `--yes`).
- Unit và các unit purge/backup đọc mật khẩu lưu trữ từ `$CREDENTIALS_DIRECTORY` dưới `User=zalo`.
- `za fleet stop|restart <id>` qua quy tắc polkit (đã cài polkitd, quy tắc JavaScript được đọc).
- Một lần chạy sao lưu hằng đêm, và khôi phục bản đó trên một VM thử nghiệm với mật khẩu lưu trữ.
- Caddyfile: `/a/<id>/mcp` stream được, `/a/<id>/events/wait` giữ kết nối 300 s, `/zalo/admin/*` trả 404.
