# Mã hóa dữ liệu trên đĩa, và bảo mật khi triển khai server hoặc SaaS

[English](security.md)

Từ 3.0.0, các file chứa bí mật được mã hóa trên đĩa. Trang này nói rõ file nào được mã hóa, mã hóa thế nào, bảo vệ được gì và không bảo vệ được gì, nên dùng bộ cung cấp khóa nào ở đâu, và cần làm gì khi bị lộ. Vận hành dịch vụ (systemd, sao lưu, giám sát) xem [deployment.vi.md](deployment.vi.md).

## 1. File nào được niêm phong

| File | Chứa gì | Khóa |
|---|---|---|
| `credentials/cred_<ownId>.json` | phiên đăng nhập đã lưu: cookie, imei, user agent (đọc được là chiếm được tài khoản) | boot |
| `accounts/<ownId>/trusted-device.json` | khóa riêng và bí mật liên kết của thiết bị mà CLI trở thành khi đăng nhập QR chính thức | boot |
| `accounts/<ownId>/sync/open-sessions.json` | mã phiên trên điện thoại của một lần khôi phục lịch sử | data |
| `accounts/<ownId>/voice-text.json` | văn bản chuyển từ tin nhắn thoại | data |

**Cơ sở dữ liệu tin nhắn** `accounts/<ownId>/zalo.db` (tin nhắn, hội thoại, danh bạ, chỉ mục tìm kiếm) được mã hóa toàn bộ bằng SQLCipher v4 (AES-256-CBC kèm HMAC-SHA512 cho từng trang, `cipher=sqlcipher, legacy=4`), với khóa là một khóa con 256 bit thô của khóa **data** của tài khoản (`sqlcipher`), và bật `secure_delete` để dòng bị xóa được ghi đè. Nhật ký ghi trước (`zalo.db-wal`) cũng được mã hóa theo từng trang. Mở không có khóa, bằng `sqlite3`, `better-sqlite3`, DB Browser for SQLite hay một bot, sẽ gặp `file is not a database`.

**Hàng đợi webhook** `accounts/<ownId>/webhook-outbox.db` (các sự kiện đang chờ, hoặc bị bên nhận webhook từ chối: có nội dung tin nhắn) được mã hóa cùng cách, dưới khóa con riêng của khóa data (`outbox`). `mcp webhook status` / `list` / `retry` / `purge` đọc nó bằng khóa đó.

Mỗi file nhỏ là một hộp: chuỗi nhận dạng `ZACSEAL`, phiên bản, phần đầu JSON (tài khoản, loại file, mã khóa, nonce) và bản mã AES-256-GCM. Phần đầu được xác thực cùng bản mã, nên một byte bị sửa, một file bị chép đè sang tài khoản khác hay đặt thay cho loại file khác đều không mở được.

**Chưa được niêm phong**, và lý do:

- `media/`: phần còn lại của giai đoạn 2 chuyển nó sang media mã hóa trên cùng các khóa này. Trong lúc chờ, nó được bảo vệ bằng quyền file (§4.2 của deployment, `UMask=0077`) và mã hóa ổ đĩa — điều bắt buộc với hội thoại của công ty.
- `daemon.log` ở mức `debug` ghi mỗi tin nhắn một dòng, kèm nội dung. Giữ mức log `info` khi điều đó quan trọng, và để log trên ổ đã mã hóa.
- `mcp-config.json`, file `accounts/<ownId>.env` của fleet: cấu hình do người vận hành viết và systemd đọc. Hạn chế để bí mật trong đó: dùng biến môi trường từ `LoadCredential=` của systemd hoặc trình quản lý bí mật.
- `daemon-channel.json`: token loopback tạo lại mỗi lần daemon khởi động (0600); bản chép vô dụng khi daemon dừng.
- `dr-config.json`, `sock-anomaly.json`, `kicked.json`, `unknown-acts.json`, `hidden-pin-lockout.json`: số, thời điểm, mã lỗi, không có bí mật. `hidden-threads.json` chứa mã các hội thoại ẩn (không có PIN): giai đoạn 2.
- `~/.zalo-agent/oa-credentials.json` của Official Account: API riêng, thư mục riêng, chưa thuộc phạm vi bản này.

## 2. Cách sắp xếp khóa

```
bộ cung cấp khóa (DPAPI / keychain / Secret Service / systemd-creds / KMS / passphrase / env)
  └─ khóa chủ                         accounts/<ownId>/keyring.json, provider.wrapped
       ├─ khóa boot                   mở những gì cần để đăng nhập: phiên đã lưu, danh tính thiết bị
       └─ khóa data                   mọi thứ còn lại, và các khóa con của giai đoạn 2 (sqlcipher, media, row-mac, outbox)
            └─ lớp dkey (tùy chọn)    được bọc thêm bằng khóa dẫn xuất từ dkey của tài khoản
```

- **Mỗi tài khoản một keyring**, nằm trong thư mục của tài khoản. Xóa tài khoản (`account remove`, `logout --purge`) là xóa khóa của nó, nên bản sao file đã niêm phong còn sót ở đâu đó (bản sao lưu, ảnh đĩa) chỉ còn là dữ liệu vô nghĩa. Một SaaS có thể cho mỗi khách hàng một khóa KMS riêng; `rekey` hay đổi `provider` chỉ chạm tới một tài khoản.
- **Khóa chỉ được lưu ở dạng đã bọc.** Keyring không chứa khóa thô; khóa đã mở chỉ nằm trong bộ nhớ tiến trình, không bao giờ được ghi log hay ghi ra file. `account security status` cho thấy mã khóa và ngày tạo, không bao giờ cho thấy khóa.
- **Thất bại thì đóng.** Không có bộ cung cấp khóa, sai khóa, file bị sửa: lệnh dừng và nói lý do. Không bao giờ lùi về văn bản thuần hay về khóa để cạnh dữ liệu. CLI 2.x không đọc được file đã niêm phong.
- **Chi phí.** Bộ cung cấp khóa chạy một lần cho mỗi tài khoản trong mỗi tiến trình. Đo trên Windows 11: mở khóa DPAPI qua Windows PowerShell mất khoảng 0,4 giây (0,5 giây với PowerShell 7); các file sau đó trong cùng tiến trình chỉ tốn micro giây. Daemon trả chi phí này một lần khi khởi động.

## 3. Bảo vệ được gì, và không bảo vệ được gì

Mã hóa trên đĩa bảo vệ dữ liệu **khi nằm yên**: ổ đĩa hay ảnh máy bị đánh cắp, bản sao lưu bị lộ, file bị chép khỏi máy, một người dùng khác (không phải quản trị) trên cùng máy đọc file không thuộc về họ. Nó cũng biến "xóa tài khoản" thành "dữ liệu không đọc được ở bất cứ đâu", vì khóa đi theo tài khoản.

Nó **không** bảo vệ trước việc tài khoản hệ điều hành mà dịch vụ chạy dưới quyền bị chiếm khi đang chạy. Bất cứ thứ gì chạy dưới quyền đó đều có thể xin khóa từ bộ cung cấp khóa đúng như CLI làm (DPAPI, keychain, systemd-creds, vai trò KMS của máy): mã độc trong phiên desktop, một shell trên server, một thư viện phụ thuộc bị cài cắm. Quản trị viên/root cũng làm được như vậy (DPAPI LocalMachine, khóa host của systemd, bộ nhớ tiến trình). Lớp dkey thu hẹp điều này một chút (khóa data còn cần một lần đăng nhập) nhưng không đóng được: kẻ chạy dưới quyền dịch vụ có thể đăng nhập như dịch vụ. Mã hóa trên đĩa chỉ là một lớp; các lớp khác là tài khoản dịch vụ riêng, quyền tối thiểu, vá lỗi và giám sát.

## 4. Chọn bộ cung cấp khóa

Mặc định được chọn theo nền tảng. Đổi trong `<config-dir>/storage.json` (hoặc `ZALO_STORAGE_PROVIDER`), rồi chạy `account security provider <tên>` để chuyển các keyring đã có. Các file mẫu theo từng kiểu triển khai nằm trong [`docs/config-samples/storage/`](config-samples/storage/): `windows.json`, `windows-service.json`, `macos.json`, `linux-server.json`, `saas-kms.json`.

| Ở đâu | Bộ cung cấp | Ghi chú |
|---|---|---|
| Windows desktop | `dpapi` (mặc định, CurrentUser) | Gắn với người dùng Windows: người dùng khác, hay cùng các file đó trên máy khác, đều không mở được. |
| Windows Server, chạy dịch vụ | `dpapi`, CurrentUser, dưới một **tài khoản dịch vụ riêng** (gMSA hoặc virtual account) | Đăng nhập QR *bằng chính tài khoản đó* (hoặc chạy `account security provider dpapi` dưới quyền nó), nếu không dịch vụ sẽ không mở được những gì quản trị viên đã niêm phong. Chỉ dùng `--scope LocalMachine` khi nhiều danh tính cần dùng chung file: khi đó mọi tiến trình trên máy đều mở được. |
| macOS | `keychain` (mặc định) | Một khóa mã hóa khóa ngẫu nhiên trong login keychain; lần đầu keychain có thể hỏi cho phép truy cập. |
| Linux desktop | `secret-service` (mặc định khi có session bus và `secret-tool`) | GNOME Keyring / KWallet. Keyring đang khóa sẽ được báo rõ. |
| Linux server | `systemd-creds` | `systemd-creds encrypt` với khóa host và/hoặc TPM2 (`"systemdCreds": {"withKey": "tpm2"}`). Cần root, hoặc `"user": true` với systemd 256+ cho dịch vụ người dùng. Không có desktop keyring và không cấu hình gì thì CLI **từ chối** và nêu tên các lựa chọn này. |
| Linux server, không có systemd-creds | `passphrase` | scrypt từ passphrase trong file (`"passphrase": {"file": "/path"}`; dưới systemd, `LoadCredential=zalo-storage-passphrase:/path` được tự nhận từ `$CREDENTIALS_DIRECTORY` mà không cần cấu hình) hoặc gõ khi được hỏi (desktop). File passphrase nằm cạnh dữ liệu thì không bảo vệ gì: để nó trên volume khác hoặc trong trình quản lý dịch vụ. |
| Cloud, SaaS | `kms` | AWS KMS, Google Cloud KMS, Azure Key Vault, HashiCorp Vault transit, truy cập bằng danh tính của máy (instance role, workload identity, managed identity, Vault agent). Dùng một khóa cho mỗi khách hàng (hoặc mỗi tài khoản), chỉ cho danh tính của dịch vụ quyền giải mã, và giữ nhật ký kiểm toán: mỗi lần mở khóa là một lệnh gọi KMS được ghi lại. Vô hiệu hóa khóa là tiêu hủy dữ liệu bằng mật mã. Cài SDK cạnh CLI (`npm i -g @aws-sdk/client-kms`, `@google-cloud/kms`, hoặc `@azure/identity @azure/keyvault-keys`; Vault không cần). **Bản này chưa được kiểm chứng với các dịch vụ thật**: các lệnh gọi theo đúng mô tả của từng SDK và được kiểm thử bằng bản giả. |
| Các trường hợp khác | `env` | Khóa (32 byte ngẫu nhiên, base64) trong `ZALO_STORAGE_KEY`. Chỉ dùng khi cấu hình rõ, và mỗi lần khởi động đều có cảnh báo: khóa chỉ an toàn bằng môi trường tiến trình và file đặt nó, mà trên đa số máy thì gần như văn bản thuần nằm cạnh dữ liệu. |

`storage.json` (không chứa bí mật):

```json
{
  "provider": "kms",
  "kms": { "backend": "aws", "key": "arn:aws:kms:<region>:<account>:key/<id>", "region": "<region>" },
  "dkeyLayer": false,
  "accounts": { "<ownId>": { "dkeyLayer": true } }
}
```

Biến môi trường (ưu tiên hơn file, nên file env riêng của từng tài khoản trong fleet có thể đặt riêng một tài khoản): `ZALO_STORAGE_PROVIDER`, `ZALO_STORAGE_DKEY_LAYER` (`1`/`0`), `ZALO_DPAPI_SCOPE`, `ZALO_SYSTEMD_CREDS_WITH_KEY`, `ZALO_KMS_BACKEND`, `ZALO_KMS_KEY`, `ZALO_STORAGE_PASSPHRASE_FILE`, `ZALO_STORAGE_KEY` (chỉ cho `env`). Với Vault: `VAULT_ADDR`, `VAULT_TOKEN` (hoặc `"kms": {"tokenFile": …}`), `VAULT_NAMESPACE`.

## 5. Lớp dkey (tùy chọn, mặc định tắt)

Phản hồi đăng nhập của Zalo có `dkey`, một hằng số 32 ký tự cho mỗi tài khoản mà Zalo PC dùng để mở các cơ sở dữ liệu tin nhắn đã mã hóa của nó. Với `"dkeyLayer": true` (hoặc `ZALO_STORAGE_DKEY_LAYER=1`), **khóa data** của tài khoản được bọc thêm một lần bằng khóa dẫn xuất từ dkey (HKDF-SHA256, muối riêng cho từng tài khoản): muốn mở cần **cả** bộ cung cấp khóa của máy **và** một lần đăng nhập còn hiệu lực. dkey không bao giờ được lưu hay ghi log; chỉ khóa dẫn xuất được giữ trong bộ nhớ.

- **Thêm được gì:** một ổ đĩa bị chép, kể cả kèm bí mật của bộ cung cấp khóa (khóa chủ DPAPI bị đánh cắp, passphrase bị lộ), vẫn không đọc được dữ liệu nếu không đăng nhập Zalo bằng chính tài khoản đó.
- **Phải trả gì:** không đọc được khi ngoại tuyến. Daemon chạy lâu (`listen`, `mcp start`, fleet) mở khóa một lần sau khi đăng nhập và giữ khóa trong bộ nhớ. Lệnh chạy một lần mà đọc dữ liệu cục bộ sẽ đăng nhập trước (đa số đã làm vậy); khi không liên lạc được với Zalo (mất mạng, Zalo lỗi) lệnh báo rằng dữ liệu đang bị khóa và vì sao.
- **Không bao phủ:** phiên đăng nhập đã lưu và danh tính thiết bị vẫn chỉ nằm dưới khóa boot, vì chúng phải mở được *trước* lần đăng nhập mang dkey về. Zalo PC cũng vậy: cookie phiên được hệ điều hành bảo vệ (DPAPI), còn cơ sở dữ liệu thì bằng dkey.
- **dkey là hằng số của tài khoản do Zalo giữ.** Đăng xuất một thiết bị từ điện thoại hay đăng nhập QR lại không làm nó thay đổi. Nó bảo vệ trước người không có tài khoản, không bảo vệ trước Zalo hay người đã nắm được tài khoản.
- Bật hay tắt có hiệu lực ở lần đăng nhập kế tiếp của tài khoản (hoặc `account security migrate`, lệnh này đăng nhập một lần).

## 6. Chuyển đổi và các lệnh

- **Lần chạy đầu của 3.0.0:** lệnh nào đọc một file còn ở dạng văn bản thuần sẽ niêm phong nó tại chỗ; mỗi lần đăng nhập niêm phong phần còn lại của tài khoản. Quy trình: ghi bản niêm phong bên cạnh, đọc lại và mở thử, so sánh, rồi mới đổi tên đè lên bản thuần — tiến trình chết ở bước nào cũng còn một bản đọc được. Chạy lại bao nhiêu lần cũng vậy.
- **Cơ sở dữ liệu tin nhắn** được mã hóa bởi lệnh 3.0.0 đầu tiên mở nó để ghi (mọi lệnh đọc bộ nhớ đệm đều vậy). Quy trình: đẩy hết nhật ký vào file chính và giữ khóa ghi, chép sang `zalo.db.encrypting`, mã hóa bản chép tại chỗ rồi kiểm tra (`quick_check`, số dòng của từng bảng, không còn phần đầu dạng thuần), đổi tên thành `zalo.db.encrypted`, hoán đổi vào chỗ, và chỉ khi đó mới ghi đè bản thuần bằng số 0 rồi xóa, cùng `-wal` và `-shm` của nó. **Không giữ lại bản thuần nào.** Tiến trình chết ở bước nào thì lần mở sau sẽ hoàn tất hoặc hoàn tác, nên luôn còn đúng một cơ sở dữ liệu đọc được. Mất khoảng 1 giây cho mỗi 20 MB (bộ nhớ đệm 190 MB mất 10 giây, đo trên Windows 11), cần dung lượng trống khoảng 1,1 lần cơ sở dữ liệu, và có thông báo trên stderr. Lệnh từ chối khi một tiến trình khác đang giữ `daemon.lock` của tài khoản (hãy dừng daemon phiên bản cũ trước), và trên Windows việc hoán đổi thất bại khi có tiến trình khác đang mở `zalo.db`, lệnh sẽ nói rõ. Lệnh chỉ đọc không bao giờ chuyển đổi: nó dừng với `PLAINTEXT` và chỉ tới `account security migrate`.
- **Hàng đợi webhook** được mã hóa bởi tiến trình 3.0.0 đầu tiên mở nó để ghi (daemon có `-w`, `mcp webhook retry` / `purge`, hoặc `account security migrate`). Hàng đợi không có sự kiện nào đang chờ hay bị loại chỉ chứa bộ đếm: nó được ghi đè, xóa và tạo lại ở dạng mã hóa. Hàng đợi còn tồn đọng được chép, mã hóa và kiểm tra như cơ sở dữ liệu tin nhắn, nên không mất sự kiện nào. `mcp webhook status` và `list` chỉ đọc: gặp hàng đợi còn thuần, chúng dừng với `PLAINTEXT` và chỉ tới `account security migrate`.
- `account security status [ownerId] [--all]`: bộ cung cấp khóa, lớp dkey (cấu hình / đang áp dụng), phiên bản và ngày của keyring, file nào đã niêm phong, và cơ sở dữ liệu tin nhắn cùng hàng đợi webhook ở trạng thái `encrypted` (kèm mã khóa mở được nó), `plaintext`, `locked` hay `absent`. Không bao giờ in khóa.
- `account security migrate [ownerId] [--all]`: niêm phong những gì còn thuần, mã hóa cơ sở dữ liệu tin nhắn và hàng đợi webhook, và áp dụng cấu hình dkey ngay.
- `account security rekey [ownerId]`: khóa mới, niêm phong lại mọi file và mã hóa lại cơ sở dữ liệu tin nhắn cùng hàng đợi webhook tại chỗ dưới khóa data mới (`PRAGMA rekey`, khoảng 2 giây cho bộ nhớ đệm 50 MB, gồm cả `-wal`). Khóa cũ ở lại trong keyring, dạng đã nghỉ (retired), cho tới khi mọi file và mọi cơ sở dữ liệu xong: trong lúc đó cơ sở dữ liệu vẫn mở được bằng khóa đã nghỉ, và một lần rekey bị ngắt (tiến trình chết, một kho lưu trữ lỗi) chỉ cần chạy lại là hoàn tất. Cơ sở dữ liệu đã ở dưới khóa hiện tại thì được để nguyên. Kết quả trả về liệt kê từng cơ sở dữ liệu và việc nó đã ở dưới khóa mới hay chưa.
- `account security provider <tên> [ownerId]`: bọc lại khóa cho bộ cung cấp khác (không chạm vào file) và đặt nó làm mặc định.
- **Không có đường quay về văn bản thuần.** `account export --yes` vẫn ghi phiên đăng nhập ra file JSON y như trước (thiếu `--yes` thì không ghi gì và thoát mã 2): đó là cách có chủ đích để chuyển phiên sang máy khác; hãy coi file đó như chính phiên đăng nhập.

Trừ `status`, các lệnh đều từ chối khi một daemon `listen` / `mcp start` đang giữ tài khoản (nó giữ khóa trong bộ nhớ).

## 7. Vận hành server

- **Tài khoản dịch vụ riêng**, không bao giờ là root hay Administrator, sở hữu một mình thư mục cấu hình (`UMask=0077`). Đăng nhập, chuyển đổi và chạy đều bằng tài khoản đó.
- **Mã hóa ổ đĩa** (BitLocker, LUKS, mã hóa volume của nhà cung cấp cloud) bên dưới tất cả: media chưa được mã hóa, việc hủy bản cơ sở dữ liệu thuần cũ chỉ là cố gắng tốt nhất (SSD hay hệ thống file copy-on-write có thể giữ khối cũ, bản sao lưu và snapshot trước đó cũng vậy), và log ở mức `debug` có nội dung tin nhắn.
- **Sao lưu:** giữ `accounts/<ownId>/keyring.json` trong cùng bản sao lưu với `credentials/` và `zalo.db`. Thiếu keyring thì không mở được cả thông tin đăng nhập lẫn cơ sở dữ liệu tin nhắn; thiếu bộ cung cấp khóa (cùng máy với DPAPI/systemd-creds, cùng khóa KMS, cùng passphrase) cũng vậy. Hãy coi phương án khôi phục sau thảm họa là một lần đăng nhập QR mới, hoặc dùng khóa KMS mà nơi khôi phục truy cập được.
- `account remove` / `logout --purge` xóa keyring cùng tài khoản, kèm mục tương ứng trong keychain / Secret Service.

## 8. Khi bị lộ

1. **Thu hồi thiết bị trên điện thoại** (Zalo → Cài đặt → Tài khoản và bảo mật → thiết bị đã đăng nhập). Việc này kết thúc phiên ở phía Zalo; không gì trên server làm thay được.
2. `zalo-agent logout --purge` (hoặc `account remove`) trên mọi máy từng giữ tài khoản: xóa thông tin đăng nhập, dữ liệu và keyring.
3. Nếu máy tiếp tục được dùng: đăng nhập QR mới, rồi `account security rekey` (khóa mới) và, nếu bí mật của bộ cung cấp khóa có thể đã lộ, `account security provider` sang bộ mới (khóa KMS mới, passphrase mới).
4. Thay mọi thứ khác máy đó từng giữ: bearer token MCP, bí mật webhook, token OA.
5. Nhớ giới hạn của lớp dkey ở đây: dkey không đổi khi thu hồi thiết bị, nên dữ liệu bị chép cùng một phiên đăng nhập còn dùng được vẫn đọc được với người có cả hai.
