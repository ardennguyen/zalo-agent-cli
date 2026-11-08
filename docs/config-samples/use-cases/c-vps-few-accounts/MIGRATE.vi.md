# Chuyển hai tài khoản từ thư mục home Windows 2.5.9 sang VPS

[English](MIGRATE.md) · Cài đặt VPS: [README.md](README.md)

Cách này giữ lại **lịch sử tin nhắn và media** cùng **danh tính thiết bị** của mỗi tài khoản (điện thoại vẫn thấy cùng một thiết bị). Nó làm được vì thư mục home 2.5.9 là **văn bản thuần (plaintext)**: không có gì trong đó gắn với Windows, và VPS niêm phong nó bằng mật khẩu lưu trữ của chính VPS ở lần chạy đầu tiên.

> [!CAUTION]
> **Hai bản sao của cùng một phiên đăng nhập đã lưu không bao giờ được chạy cùng lúc.** Sau khi sao chép, thư mục home trên Windows và VPS giữ cùng một phiên đăng nhập; ngay khi cả hai kết nối, hai socket sẽ đá nhau ra (mã thoát 3) và cứ thế lặp lại. Hãy dừng mọi thứ trên Windows trước, và không bao giờ khởi động lại listener nào cho các tài khoản này ở đó nữa.

## 1. Trước khi bắt đầu

- VPS đã được cài đặt tới bước 4 của [README.md](README.md): người dùng `zalo`, engine, `za`, `storage.json` (`"provider": "passphrase"`) và `/etc/zalo-mcp/storage-passphrase.cred`. Đừng đăng nhập trên VPS: các tài khoản đến từ Windows.
- Dung lượng trống trên VPS: khoảng 1,1 lần kích thước hai thư mục tài khoản (quá trình mã hóa ghi một bản sao trước khi thay thế cơ sở dữ liệu).
- **Không chạy lệnh 3.0 nào trên Windows trước khi sao chép.** Một lệnh 3.0 sẽ niêm phong các tệp bằng Windows DPAPI, và tệp được niêm phong bằng DPAPI không mở được trên máy khác. Kiểm tra bản Windows đang chạy: `zalo-agent --version` phải in ra `2.5.9`.

## 2. Nếu Windows đã chạy 3.0

Khi đó các tệp đã được niêm phong bằng DPAPI. Hãy bọc lại chúng bằng **cùng** mật khẩu lưu trữ với VPS, trên Windows, **trước khi** sao chép:

```powershell
# một tệp chứa mật khẩu lưu trữ của VPS, chỉ bạn đọc được; xóa nó ngay sau đó
zalo-agent account security provider passphrase --passphrase-file C:\Users\<you>\zalo-pass.txt
Remove-Item C:\Users\<you>\zalo-pass.txt
zalo-agent account security status --all          # provider: passphrase, cho cả hai tài khoản
```

Giờ keyring được bọc bằng mật khẩu lưu trữ thay vì DPAPI, nên các thư mục được sao chép sẽ mở được trên VPS. Sau đó tiếp tục với mục 3.

## 3. Sao chép

1. **Dừng mọi thứ trên Windows** đang dùng các tài khoản này: `zalo-agent listen --stop`, `zalo-agent mcp start --stop` cho từng tài khoản, thoát Claude Desktop, Claude Code và mọi service `zalo-mcp`, và đóng mọi tab Zalo Web. Sao lưu nguyên trạng `%USERPROFILE%\.zalo-agent-cli`.
2. **Chỉ đóng gói những gì cần chuyển** (PowerShell; `tar` có sẵn từ Windows 10 trở đi). Thay hai ID bằng ID của bạn:
   ```powershell
   cd $env:USERPROFILE\.zalo-agent-cli
   tar -czf $env:USERPROFILE\zalo-move.tgz `
     --exclude=daemon.lock --exclude=daemon-channel.json --exclude=qr.png `
     accounts.json credentials\cred_1000000000000000001.json credentials\cred_1000000000000000002.json `
     accounts\1000000000000000001 accounts\1000000000000000002
   ```
   Đừng lấy `mcp-config.json` (nó có thể chứa đường dẫn Windows): VPS dùng tệp từ thư mục này.
3. **Mã hóa nó** trước khi rời khỏi máy (nó chứa hai phiên đăng nhập đang sống và mọi tin nhắn ở dạng rõ): `7z a -p -mhe=on zalo-move.7z zalo-move.tgz` (hoặc `age -p`), rồi xóa `zalo-move.tgz`.
4. **Sao chép nó** lên VPS: `scp zalo-move.7z admin@your-vps:/tmp/`.

## 4. Giải nén và niêm phong trên VPS

```bash
cd /tmp && 7z x zalo-move.7z && rm zalo-move.7z
sudo tar -xzf /tmp/zalo-move.tgz -C /home/zalo/.zalo-agent-cli
sudo chown -R zalo:zalo /home/zalo/.zalo-agent-cli && sudo chmod -R go-rwx /home/zalo/.zalo-agent-cli
shred -u /tmp/zalo-move.tgz
za account list                                   # cả hai tài khoản
za account security migrate --all                 # niêm phong mọi tệp và mã hóa zalo.db (khoảng 1 s mỗi 20 MB)
za account security status --all                  # mọi thứ đã niêm phong / mã hóa, provider passphrase
```

`tar` từ Windows ghi đường dẫn dấu gạch ngược thành gạch xuôi; nếu `za account list` không hiện gì, hãy kiểm tra `accounts.json` đã nằm trong `/home/zalo/.zalo-agent-cli/`, không phải trong một thư mục con.

Sau đó tiếp tục với bước 6 của [README.md](README.md) (`za fleet generate`, cài đặt, khởi động).

## 5. Sau khi chuyển

- **Trên Windows, bỏ các phiên đăng nhập đã lưu mà không kết thúc chúng** (một lệnh `logout` thường sẽ kết thúc chính phiên mà VPS đang dùng):
  ```powershell
  zalo-agent logout --no-remote --account 1000000000000000001
  zalo-agent logout --no-remote --account 1000000000000000002
  ```
  Sau đó xóa tệp nén đã mã hóa và, khi VPS đã chạy được vài ngày, xóa các thư mục cũ trên Windows.
- **Zalo có thể yêu cầu xác minh một phiên đăng nhập di chuyển** từ địa chỉ gia đình sang địa chỉ datacenter. Nếu một unit kết thúc với mã thoát 4 (`journalctl -u zalo-mcp@<id>` báo phiên đăng nhập bị từ chối), hãy đăng nhập lại tài khoản đó trên VPS bằng `za login` (QR qua đường hầm SSH); lịch sử của nó vẫn còn.
- **Tiếp tục dùng điện thoại hoặc Zalo PC** bên cạnh máy chủ. Đăng nhập tài khoản vào **Zalo Web** sẽ đăng xuất máy chủ (một phiên đăng nhập web cho mỗi tài khoản).

## 6. Các cách khác, và vì sao không dùng

| Cách | Lịch sử | Thiết bị | Khi nào |
|---|---|---|---|
| Sao chép thư mục home 2.5.9 (trang này) | giữ lại | giữ nguyên | mặc định |
| `account export` trên Windows, `za login --credentials <file>` trên VPS | **không giữ lại** (`sync` xác nhận trên điện thoại khôi phục ít hơn nhiều so với kho dữ liệu của PC) | giữ nguyên | tài khoản phụ không cần lịch sử |
| Đăng nhập QR mới trên VPS, rồi thả `zalo.db` và `media/` cũ vào thư mục tài khoản mới trước lần khởi động đầu tiên, và `za account security migrate --all` | giữ lại | mới | bạn muốn một mục thiết bị mới |
| Nâng cấp Windows lên 3.0, rồi sao chép | chỉ sau mục 2 | giữ nguyên | tránh |
