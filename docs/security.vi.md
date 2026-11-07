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

**Bằng chứng chỉnh sửa (row MAC).** Mỗi dòng tin nhắn còn mang một MAC: HMAC-SHA256 (cắt còn 16 byte) trên id, cuộc trò chuyện, người gửi, tên người gửi, thời gian, loại, nội dung, dữ liệu gốc và trạng thái của nó, với khóa con `row-mac` của khóa data, khóa này không bao giờ được xuất ra. MAC nằm trong bảng riêng (`message_macs`) và do trigger SQL giữ, nên mọi bên ghi (listener, sync, phần tải của `msg history`, bản đánh dấu khi thu hồi) đều được bao phủ. Người có khóa cơ sở dữ liệu (một bản sao lưu được khôi phục, một công cụ SQLCipher) đọc được các dòng nhưng không thể thêm hoặc sửa tin nhắn mà không bị lộ: kết nối không có hàm MAC của ứng dụng không ghi được tin nhắn nào, và dòng bị sửa theo cách khác sẽ không qua được bước kiểm tra. Các thao tác trên một tin nhắn trong bộ nhớ đệm (trích dẫn, chuyển tiếp, xóa, thu hồi, thả cảm xúc, ghim, `msg media` / `zalo_view_media`) từ chối dòng không qua kiểm tra ("failed its integrity check"), trừ khi `rowMac.verifyOnRead` trong `storage.json` là `off`; `zalo-agent db verify` kiểm tra mọi dòng (khoảng 18 µs một dòng: 400.000 tin nhắn trong khoảng 7 giây). Các lần đọc hàng loạt (lịch sử, tìm kiếm) không kiểm tra. Các dòng đã lưu trước 3.0.0 được niêm phong một lần, bởi lệnh đầu tiên mở cơ sở dữ liệu (khoảng 50.000 dòng mỗi giây); một dấu (bản thân nó là một MAC) ghi nhận việc này, nên dòng nào xuất hiện sau đó mà không có MAC là một phát hiện, không bao giờ được niêm phong lặng lẽ. Chi phí: thêm khoảng 20 µs cho mỗi tin nhắn được ghi.

**Hàng đợi webhook** `accounts/<ownId>/webhook-outbox.db` (các sự kiện đang chờ, hoặc bị bên nhận webhook từ chối: có nội dung tin nhắn) được mã hóa cùng cách, dưới khóa con riêng của khóa data (`outbox`). `mcp webhook status` / `list` / `retry` / `purge` đọc nó bằng khóa đó.

**Media đã tải về** (mọi file trong `accounts/<ownId>/media/`, `--media-dir` / `ZALO_MEDIA_DIR` và `media.downloadDir`) là một hộp chia khối: chuỗi nhận dạng `ZACMEDIA`, phần đầu (tài khoản, mã tin nhắn, kích thước, loại), hai ô khóa, rồi các khối 64 KiB, mỗi khối mã hóa AES-256-GCM bằng một khóa ngẫu nhiên riêng cho từng file. Khóa riêng đó được bọc dưới khóa con `media` của khóa data của tài khoản. Phần đầu được gắn vào mọi khối và mọi lần bọc khóa, nên phần đầu bị sửa, khối bị đảo, cắt bớt hay thêm vào, hoặc file bị đặt thay cho file của tin nhắn khác đều không mở được. Đọc được bất kỳ đoạn byte nào mà không phải giải mã phần còn lại (phụ phí 0,02%). Tên file không đổi. `_conversations.json` cạnh các thư mục (mã hội thoại sang tên) là một file niêm phong như các file ở trên. Thư mục gốc tùy chỉnh nằm ngoài `accounts/<ownId>/` cũng được niêm phong bằng khóa của tài khoản, nên sau `account remove` không còn đọc được (crypto-shred).

**Đọc lại media** không bao giờ giải mã bộ nhớ đệm tại chỗ. `zalo_view_media` và `msg media` trả nó theo một trong ba cách (`media.deliver`): inline (các byte nằm trong kết quả dưới dạng nội dung image hoặc audio của MCP, không có gì trên đĩa), link (`/zalo/media/<token>`: giải mã từng khoảng byte khi gửi, token chỉ nằm trong bộ nhớ, 10 phút, hết hiệu lực khi đăng xuất, bị đá, ẩn trò chuyện, rekey hoặc khởi động lại, `bearer` hay `capability` theo `media.linkAuth`; xem [deployment.vi.md §5.6](deployment.vi.md)), hoặc tempfile: một bản giải mã trong thư mục riêng (`<config-dir>/tmp/media/`, 0700 / 0600), bị xóa sau `media.tempfileTtl` (10 phút), khi thoát, hoặc bởi lượt dọn mà daemon đang chạy làm mỗi phút, và chỉ cho bên gọi trên cùng máy. Tempfile là bản rõ trên đĩa trong mấy phút đó; `media.allowDeliver` có thể cấm nó.

Mỗi file nhỏ là một hộp: chuỗi nhận dạng `ZACSEAL`, phiên bản, phần đầu JSON (tài khoản, loại file, mã khóa, nonce) và bản mã AES-256-GCM. Phần đầu được xác thực cùng bản mã, nên một byte bị sửa, một file bị chép đè sang tài khoản khác hay đặt thay cho loại file khác đều không mở được.

**Chưa được niêm phong**, và lý do:

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

`"rowMac": {"verifyOnRead": "actions"}` (mặc định) khiến các thao tác kiểm tra dòng mà chúng tác động; `"off"` bỏ qua bước đó (`db verify` vẫn tìm ra các dòng này). Các file mẫu đặt giá trị này một cách tường minh.

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
- **Media** do 2.x tải về vẫn đọc được và được niêm phong tại chỗ: ở lần đọc đầu tiên, bởi `account security migrate`, và bởi `listen` / `mcp start` đang chạy ở chế độ nền (50 file mỗi 30 giây, bắt đầu một phút sau khi khởi động). Mỗi file được ghi bản niêm phong bên cạnh, đẩy xuống đĩa và kiểm tra, hoán đổi vào chỗ, và chỉ khi đó bản thuần mới bị ghi đè bằng số 0 rồi xóa; tiến trình chết ở bước nào cũng còn một bản đọc được. Đo trên Windows 11: khoảng 40 MB/giây (300 MB trong 7,7 giây). Trong một thư mục media dùng chung cho nhiều tài khoản (`--media-dir`, `media.downloadDir`), chỉ các file thuần mà tin nhắn của tài khoản này trỏ tới mới được niêm phong bằng khóa của nó; file của tài khoản khác không bao giờ bị động tới. Media tải mới được ghi ở dạng niêm phong (file tạm, đẩy xuống đĩa, đổi tên).
- `account security status [ownerId] [--all]`: bộ cung cấp khóa, lớp dkey (cấu hình / đang áp dụng), phiên bản và ngày của keyring, file nào đã niêm phong, số đếm media (`sealed`, `plaintext`, `unreadable`, `staleKey`), và cơ sở dữ liệu tin nhắn cùng hàng đợi webhook ở trạng thái `encrypted` (kèm mã khóa mở được nó), `plaintext`, `locked` hay `absent`. Không bao giờ in khóa.
- `account security migrate [ownerId] [--all]`: niêm phong những gì còn thuần, mã hóa cơ sở dữ liệu tin nhắn và hàng đợi webhook, niêm phong media, và áp dụng cấu hình dkey ngay.
- `account security rekey [ownerId]`: khóa mới, niêm phong lại mọi file, mã hóa lại cơ sở dữ liệu tin nhắn cùng hàng đợi webhook tại chỗ, và bọc lại khóa của từng file media (chỉ ô khóa 76 byte được ghi lại, vào ô mà khóa cũ không dùng, nên tiến trình chết giữa chừng vẫn để lại lần bọc cũ còn hiệu lực; bản thân media không bao giờ bị mã hóa lại: khoảng 6 ms mỗi file trên Windows, phần lớn là thời gian đẩy xuống đĩa) dưới khóa data mới (`PRAGMA rekey`, khoảng 2 giây cho bộ nhớ đệm 50 MB, gồm cả `-wal`). Khóa cũ ở lại trong keyring, dạng đã nghỉ (retired), cho tới khi mọi file và mọi cơ sở dữ liệu xong: trong lúc đó cơ sở dữ liệu vẫn mở được bằng khóa đã nghỉ, và một lần rekey bị ngắt (tiến trình chết, một kho lưu trữ lỗi) chỉ cần chạy lại là hoàn tất. Cơ sở dữ liệu đã ở dưới khóa hiện tại thì được để nguyên. Sau đó MAC của các dòng tin nhắn được tính lại dưới khóa `row-mac` mới (dòng có MAC không do khóa nào của tài khoản tạo ra thì được giữ nguyên, vẫn là một phát hiện của `db verify`). Kết quả trả về liệt kê từng cơ sở dữ liệu và việc nó đã ở dưới khóa mới hay chưa.
- `account security provider <tên> [ownerId]`: bọc lại khóa cho bộ cung cấp khác (không chạm vào file) và đặt nó làm mặc định.
- **Không có đường quay về văn bản thuần.** `account export --yes` vẫn ghi phiên đăng nhập ra file JSON y như trước (thiếu `--yes` thì không ghi gì và thoát mã 2): đó là cách có chủ đích để chuyển phiên sang máy khác; hãy coi file đó như chính phiên đăng nhập.

Trừ `status`, các lệnh đều từ chối khi một daemon `listen` / `mcp start` đang giữ tài khoản (nó giữ khóa trong bộ nhớ).

## 7. Vận hành server

- **Việc xóa theo hạn mức và thời gian lưu giữ** xóa các dòng khi `secure_delete` đang bật (các trang được giải phóng bị ghi đè số 0) rồi checkpoint WAL; file media bị xóa thì bị xóa hẳn (nó đã được niêm phong: không có khóa của tài khoản thì các byte đó cũng vô nghĩa). Lưu ý thường lệ vẫn đúng: SSD, hệ thống file copy-on-write, bản sao lưu và snapshot có thể còn giữ các khối cũ.
- **Chính sách chạy và admin API.** `policy.json` (theo tài khoản) và `tenants/<tenantId>.json` được niêm phong bằng khóa boot như các tệp nhỏ khác; tệp thả vào dạng JSON thường được daemon đang chạy kiểm tra và niêm phong tại chỗ. Admin API (`/zalo/admin/`) dùng thông tin xác thực riêng, không bao giờ là của agent: token admin chỉ giữ SHA-256 (`policy token --rotate`, niêm phong trong `admin/admin-token.json`, có keyring riêng), tệp token do bộ cung cấp điền (`ZALO_MCP_ADMIN_TOKEN_FILE`), hoặc chứng chỉ client (`ZALO_MCP_ADMIN_CLIENT_CA`). Bí mật không bao giờ là khóa chính sách, và `policy-audit.log` chỉ chứa khóa và rev.

- **Tài khoản dịch vụ riêng**, không bao giờ là root hay Administrator, sở hữu một mình thư mục cấu hình (`UMask=0077`). Đăng nhập, chuyển đổi và chạy đều bằng tài khoản đó.
- **Mã hóa ổ đĩa** (BitLocker, LUKS, mã hóa volume của nhà cung cấp cloud) bên dưới tất cả: việc hủy bản cơ sở dữ liệu thuần cũ chỉ là cố gắng tốt nhất (SSD hay hệ thống file copy-on-write có thể giữ khối cũ, bản sao lưu và snapshot trước đó cũng vậy), và log ở mức `debug` có nội dung tin nhắn.
- **Sao lưu:** giữ `accounts/<ownId>/keyring.json` trong cùng bản sao lưu với `credentials/` và `zalo.db`. `zalo-agent db backup --out <file>` ghi ra một bản sao đã mã hóa và đã kiểm tra của cơ sở dữ liệu tin nhắn ngay khi daemon đang chạy (`sqlite3 .backup` không mở được nó); `db export --out <file> --plaintext --yes` ghi ra một bản đã giải mã, tức là toàn bộ lịch sử tin nhắn ở dạng đọc được, trừ chat ẩn: `db query` và `db export` loại chúng ra, trừ khi có `--include-hidden` và mã PIN chat ẩn. Bản sao lưu vẫn giữ chúng (đó là bản để khôi phục, mã hóa dưới khóa của tài khoản). Thiếu keyring thì không mở được cả thông tin đăng nhập lẫn cơ sở dữ liệu tin nhắn; thiếu bộ cung cấp khóa (cùng máy với DPAPI/systemd-creds, cùng khóa KMS, cùng passphrase) cũng vậy. Hãy coi phương án khôi phục sau thảm họa là một lần đăng nhập QR mới, hoặc dùng khóa KMS mà nơi khôi phục truy cập được.
- `account remove` / `logout --purge` xóa keyring cùng tài khoản, kèm mục tương ứng trong keychain / Secret Service.

## 8. Khi bị lộ

1. **Thu hồi thiết bị trên điện thoại** (Zalo → Cài đặt → Tài khoản và bảo mật → thiết bị đã đăng nhập). Việc này kết thúc phiên ở phía Zalo; không gì trên server làm thay được.
2. `zalo-agent logout --purge` (hoặc `account remove`) trên mọi máy từng giữ tài khoản: xóa thông tin đăng nhập, dữ liệu và keyring.
3. Nếu máy tiếp tục được dùng: đăng nhập QR mới, rồi `account security rekey` (khóa mới) và, nếu bí mật của bộ cung cấp khóa có thể đã lộ, `account security provider` sang bộ mới (khóa KMS mới, passphrase mới).
4. Thay mọi thứ khác máy đó từng giữ: bearer token MCP, bí mật webhook, token OA.
5. Nhớ giới hạn của lớp dkey ở đây: dkey không đổi khi thu hồi thiết bị, nên dữ liệu bị chép cùng một phiên đăng nhập còn dùng được vẫn đọc được với người có cả hai.
