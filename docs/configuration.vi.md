# Sổ tay cấu hình — `.env`, `mcp-config.json` và các mô hình triển khai nên dùng

> **Trạng thái:** đã đối chiếu với `zalo-agent-cli` `3.0.0`. Mọi tệp nêu ở đây đều có sẵn để sao chép trong [`docs/config-samples/`](config-samples/), và `tests/unit/config-samples.test.js` buộc từng tệp khớp với mã nguồn: mọi khóa `mcp-config.json` đều là khóa trình nạp thực sự gộp, mọi biến môi trường đều được một tệp nguồn đọc, và bộ nhận CRM xác minh được chữ ký do chính bộ gửi webhook tạo ra. Bản tiếng Anh: [`configuration.md`](configuration.md).

Hai loại tệp cấu hình một máy chủ, trả lời hai câu hỏi khác nhau:

| Tệp | Chứa | Định dạng |
|---|---|---|
| `.env` | **Tiến trình chạy ở đâu và thế nào**: thư mục lưu trữ, host, port, token, TLS, URL và khóa webhook. Mọi thứ theo máy, theo tài khoản, và mọi thứ bí mật | các dòng `TEN=giá_trị` |
| `mcp-config.json` | **Máy chủ theo dõi gì và hành xử ra sao**: thread nào, kích thước bộ đệm, thông báo, các consumer OAuth, ghi đè theo tài khoản | JSON |

Bí mật đặt trong `.env` (quyền `0600`), không đặt trong `mcp-config.json`, và không bao giờ đặt trên dòng lệnh: **cờ dòng lệnh hiện cho mọi người dùng trên máy trong `ps`**, biến môi trường thì không.

---

## 1. Mỗi tệp nằm ở đâu và ai đọc nó

| Vị trí | Ai đọc | Dùng cho |
|---|---|---|
| `<CONFIG_DIR>/.env` — mặc định `~/.zalo-agent-cli/.env` | **mọi** lệnh `zalo-agent` / `zalo-mcp` trên máy, từ bất kỳ thư mục nào | cài đặt theo máy: thư mục dữ liệu, `ZALO_AGENT_NO_UPDATE_CHECK`, mặc định cho mọi tài khoản. [`env/config-dir.env`](config-samples/env/config-dir.env) |
| `--env-file <path>` (hoặc `ZALO_ENV_FILE`) | đúng lệnh đó | tệp riêng của một dịch vụ: `/etc/zalo-mcp/<tên>.env`, `--env-file` của container. [`env/lan-server.env`](config-samples/env/lan-server.env), [`env/internet-server.env`](config-samples/env/internet-server.env), [`env/crm-backend.env`](config-samples/env/crm-backend.env) |
| `./.env` trong thư mục làm việc | mọi `zalo-agent` chạy từ thư mục đó | nên tránh: nó lặng lẽ đổi hành vi tùy bạn `cd` đi đâu. Không đặt bí mật ở đây |
| `zalo-mcp/.env` trong thư mục của wrapper | launcher `zalo-mcp`, trước khi khởi động engine | **chỉ port**: [`env/wrapper-folder.env`](config-samples/env/wrapper-folder.env) |
| `EnvironmentFile=` của systemd, `export` trong shell, `-e` của container | tiến trình, như biến môi trường thật | cùng các tên đó; luôn thắng mọi tệp ở trên |
| `<CONFIG_DIR>/mcp-config.json` | `mcp start` (và `mcp wait` / các tool nó phục vụ) | nền chung cho mọi tài khoản trên máy |
| `mcp start --config <path>` | máy chủ đó | cấu hình thứ hai cho một dịch vụ. Phải tồn tại và là JSON hợp lệ, nếu không máy chủ **từ chối khởi động** (thiếu tệp sẽ có nghĩa "theo dõi mọi thread"). Nó thay thế tệp nền và tệp theo tài khoản bên dưới |
| khối `accounts.<ownId>` trong `mcp-config.json` | máy chủ của tài khoản đó | ghi đè theo tài khoản trong một tệp: [`mcp-config/multi-account.json`](config-samples/mcp-config/multi-account.json) |
| `<accountDir>/mcp-config.json` — `~/.zalo-agent-cli/accounts/<ownId>/` | máy chủ của tài khoản đó | tệp theo tài khoản; bị từ chối khi khởi động nếu có mà không đọc được |
| `<CONFIG_DIR>/storage.json` | mọi lệnh đọc hay ghi phiên đăng nhập đã lưu | bộ cung cấp khóa và lớp dkey bảo vệ các file đã lưu, và `rowMac.verifyOnRead` (`actions` (mặc định) hoặc `off`: thao tác có kiểm tra tin nhắn trong bộ nhớ đệm mà nó tác động với row MAC của tin đó hay không) ([security.vi.md](security.vi.md)); `retention.*` và `quota.*` của bộ nhớ đệm (xem mục Hạn mức dung lượng và thời gian lưu giữ); không chứa bí mật |

### Thứ tự ưu tiên

**Các tệp môi trường** được gộp mà không ghi đè: nguồn đầu tiên định nghĩa một tên là thắng, theo thứ tự: môi trường tiến trình thật, `--env-file`, `./.env`, `<CONFIG_DIR>/.env`. (`zalo-mcp/.env` được launcher nạp theo cùng cách: chỉ điền các tên chưa có.)

**Một cài đặt** được xác định theo từng tài khoản, cao nhất trước:

1. cờ dòng lệnh (`--http`, `--host`, `--auth`, `--webhook`, …)
2. `TEN_<ownId>` trong môi trường, ví dụ `ZALO_MCP_HTTP_PORT_1000000000000000001`
3. `TEN` trong môi trường
4. `mcp-config.json`, lớp sau đè lớp trước: tệp nền, rồi khối `accounts.<ownId>` của nó, rồi `<accountDir>/mcp-config.json`
5. giá trị mặc định có sẵn

[`env/multi-account.env`](config-samples/env/multi-account.env) minh họa quy tắc 2 thắng 3 trong một tệp.

### Chính sách chạy (đổi trực tiếp, không cần khởi động lại)

Trên tất cả các lớp trên là **chính sách chạy** (runtime policy): những cài đặt mà console hay người vận hành đổi trong lúc
máy chủ đang chạy. Tệp và biến môi trường chỉ được đọc một lần khi khởi động; chính sách được đọc lại ở mỗi lần gọi tool.

| Lớp (thấp nhất trước) | Ở đâu |
|---|---|
| mặc định có sẵn | mã nguồn |
| tệp | `mcp-config.json`, `storage.json` |
| môi trường | `.env`, `--env-file`, `EnvironmentFile` của systemd (chỉ để khởi động: port, địa chỉ bind, `publicUrl`, bộ cung cấp khóa, *tham chiếu* tới thông tin xác thực admin) |
| **chính sách** | theo tenant `<CONFIG_DIR>/tenants/<tenantId>.json` (cho các tài khoản liệt kê trong `quota.tenant.accounts`), rồi theo tài khoản `<accountDir>/policy.json` |

Chính sách nhận `confirmMode`, `hiddenChats`, `allowPinArgument`, `approval.*`, `media.deliver`, `media.inlineMaxBytes`,
`media.allowDeliver`, `media.linkTtl`, `media.tempfileTtl`, `media.linkAuth`, `media.linkRateLimit`,
`media.capability.*`, `media.autoOpen`, `webhook`, `webhookBatchSize`, `webhookMaxAge`, `quota.*` và `retention.*`. Khóa
chỉ đọc khi khởi động (`httpPort`, `host`, `publicUrl`, `tls`, `oauth`, `trustedProxies`, `admin`, bộ cung cấp khóa) và
mọi bí mật (`webhookSecret`) bị từ chối với `restartRequired`; khóa khác bị từ chối vì không biết. Các tệp được niêm
phong bằng khóa boot của tài khoản (của tenant thì bằng `<CONFIG_DIR>/tenants/keyring.json`) và có số phiên bản (`rev`)
tăng sau mỗi lần đổi.

Ba nơi ghi, cùng một cách kiểm tra:

1. **Admin API** trên máy chủ MCP HTTP: `GET|PUT|PATCH /zalo/admin/policy` (tài khoản này),
   `/zalo/admin/policy/<ownId>`, `/zalo/admin/policy/tenants/<tenantId>`, và `GET /zalo/admin/usage`. Nó dùng **thông tin
   xác thực riêng**, không bao giờ là của agent: `Authorization: Bearer <admin token>` hoặc chứng chỉ client
   (`admin.clientCa`). Bearer token MCP, secret OAuth và access token do máy chủ ký đều bị từ chối (401), nên agent không
   bao giờ tự đổi giới hạn của chính nó. `PATCH` là JSON merge patch (`null` xóa một khóa); `PUT` thay cả chính sách.
   `If-Match: "<rev>"` làm lệnh ghi có điều kiện: rev khác thì trả `412` và không đổi gì; phản hồi có `ETag: "<rev>"` và
   các cài đặt đang có hiệu lực. `400` nêu từng khóa sai; `422` liệt kê `restartRequired`. Khi chưa đặt thông tin xác thực
   admin nào thì API không tồn tại (`404`). Cùng thông tin xác thực đó khởi chạy việc xuất dữ liệu của tài khoản máy chủ
   này (`POST /zalo/admin/export/<ownId>`, [deployment.vi.md](deployment.vi.md) "Xuất dữ liệu của tôi"); link tải về theo
   các cài đặt link `media.*`.
2. **`zalo-agent policy set|unset <key> [<value>] [--tenant <id>] [--if-match <rev>]`**: đi qua daemon đang chạy của tài
   khoản (áp dụng ngay), nếu không thì ghi vào tệp cho lần khởi động sau.
3. **Thả tệp** bằng công cụ quản lý cấu hình: ghi tệp dạng JSON thường (`{"policy": {...}}`), ghi nguyên tử. Daemon đang
   chạy nhận trong vòng một giây, kiểm tra và niêm phong với rev kế tiếp. Tệp không hợp lệ được chuyển thành
   `policy.json.rejected` và ghi log, chính sách hợp lệ cuối cùng vẫn giữ nguyên. Daemon không khởi động với tệp chính
   sách không dùng được.

Mỗi thay đổi và mỗi lần từ chối là một dòng trong `<CONFIG_DIR>/policy-audit.log`: khi nào, ai, tệp nào, khóa nào, rev cũ
và mới. Không bao giờ ghi giá trị (URL webhook có thể chứa token) và không bao giờ ghi thông tin xác thực.

Tác dụng ngay của một thay đổi: `media.linkAuth` / `media.capability` thu hồi mọi link media đang mở; `hiddenChats` thu
hồi link vào các chat vừa bị ẩn; `webhook*` chuyển việc gửi sang nơi nhận hoặc cài đặt mới (sự kiện đang xếp hàng vẫn
còn); `quota.*` thấp hơn được kiểm tra ngay.

### Hạn mức dung lượng và thời gian lưu giữ

Daemon đang giữ một tài khoản (`listen` hoặc `mcp start`) đo dung lượng của nó (các trang đang dùng của cơ sở dữ liệu
tin nhắn, các file media, outbox webhook) sau mỗi `retention.purgeEvery` và áp dụng các quy tắc dưới đây. Thấp nhất
trước: mặc định, `storage.json` (cấp trên cùng, rồi `accounts.<ownId>`), `ZALO_RETENTION_MESSAGES[_<ownId>]` /
`ZALO_RETENTION_MEDIA[_<ownId>]`, rồi chính sách chạy.

| Khóa | Mặc định | Ý nghĩa |
|---|---|---|
| `quota.account.limit` | `null` (không giới hạn) | số byte, hoặc `"2GB"` (1 GB = 1024³ byte), hoặc `"unlimited"` (thắng giới hạn của lớp thấp hơn) |
| `quota.tenant.limit`, `quota.tenant.accounts` | không có | chỉ trong chính sách của tenant: một giới hạn chung cho các tài khoản được liệt kê. Trên một host, engine chỉ cộng các tài khoản nó chạy. Một tài khoản thành viên có daemon đang tắt được đo lại ở mỗi lần kiểm tra theo đúng cách daemon đo (số trang đang dùng của cơ sở dữ liệu, đọc bằng chính khóa của nó từ một bản sao tạm, cộng thư mục media), chứ không lấy con số daemon của nó để lại lần cuối; nếu cơ sở dữ liệu không mở được thì dùng kích thước file, và log của daemon ghi rõ đã dùng cách nào. Không ghi gì vào thư mục của tài khoản đó. Với tenant trải trên nhiều host thì console là nguồn sự thật (nó đọc `/zalo/admin/usage` và các sự kiện, rồi đẩy giới hạn cho từng tài khoản) |
| `quota.graceDays` | `45` | số ngày giữ lại sau khi vượt trước khi xóa |
| `quota.warnAt` | `0.8` | tỉ lệ của giới hạn thì gửi `warn` |
| `quota.purgeOrder` | `media-first` | file media cũ nhất trước, rồi tin nhắn cũ nhất |
| `retention.messages` | `keep` | `keep`, hoặc `<N>d`: tin nhắn từ N ngày tuổi trở lên bị xóa |
| `retention.media` | `keep` | `keep`, hoặc `<N>d`: file media của tin nhắn từ N ngày tuổi trở lên bị xóa (tin nhắn vẫn giữ) |
| `retention.outboxDead` | `30d` | lượt gửi webhook đã chết bị xóa sau thời gian này |
| `retention.purgeEvery` | `6h` | daemon kiểm tra bao lâu một lần (ít nhất `1m`); `fleet purge` (chạy theo timer) yêu cầu daemon nào chưa kiểm tra trong khoảng gấp đôi thời gian này chạy ngay, và tự xóa cho tài khoản không có daemon |

**Vượt giới hạn thì vẫn tiếp tục lưu đệm.** Daemon gửi sự kiện `storage_quota` tới webhook (`listen` in ra, và
`mcp start` còn đưa chúng tới client MCP dưới dạng sự kiện hệ thống trong `zalo_get_messages` / `zalo_wait_for_message`):
`{event: "storage_quota", accountId, scope: "account"|"tenant", tenantId?, level, usedBytes, limitBytes, overSince,
purgeAt}` với `level` là `warn`, `over`, `grace_ending` (`daysLeft` 7 và 1), `purged` (`freedBytes`, `media`,
`messages`) và `ok` (đã về dưới giới hạn: nâng giới hạn hoặc gia hạn sẽ xóa đồng hồ ân hạn). Sau `quota.graceDays` nó
xóa media cũ nhất, rồi tin nhắn cũ nhất (kèm mục tìm kiếm, reaction và row MAC; các trang được `secure_delete` ghi
đè số 0 và WAL được checkpoint) cho tới khi dung lượng bằng hoặc dưới giới hạn; mỗi tài khoản của tenant nhường phần
vượt tương ứng với dung lượng của nó. Một lần xóa nâng mốc lưu giữ (retention floor) của cơ sở dữ liệu: không lần sync
hay lấy lịch sử nào lưu lại tin nhắn ở hoặc trước mốc đó. File cơ sở dữ liệu giữ nguyên kích thước (SQLite dùng lại
các trang đã giải phóng); dung lượng tính theo các trang đang dùng. `zalo-agent db usage` cho xem tất cả,
`db purge --dry-run` đếm những gì đến hạn, và `db purge --yes` chạy ngay (qua daemon nếu có daemon đang chạy).

Token admin: `zalo-agent policy token --rotate` tạo một token và hiện nó đúng một lần; chỉ SHA-256 của nó được giữ, niêm
phong trong `<CONFIG_DIR>/admin/admin-token.json`, và lần xoay mới làm token cũ hết hiệu lực ngay. Hoặc trỏ
`ZALO_MCP_ADMIN_TOKEN_FILE` (`admin.tokenFile`) tới tệp do bộ cung cấp của bạn điền (credential của systemd, mount giải
mã bằng KMS). `ZALO_MCP_ADMIN_TOKEN` chỉ dùng khi phát triển.

### Người dùng, giới hạn luôn-kết-nối và hiện diện theo nhu cầu

Một triển khai là **tenant > người dùng > tài khoản**, bằng các id mờ do CRM cấp (chữ, số, `-`, `_`; không bao giờ là
tên hay email). Một người dùng nằm ở `<CONFIG_DIR>/users/<userId>.json` (niêm phong, có số phiên bản, như tệp của
tenant): tenant của họ (đúng một), các tài khoản họ sở hữu, và chính sách riêng. **Mỗi tài khoản có đúng một người dùng
sở hữu**; người khác truy cập qua CRM. Một lần ghi đặt một tài khoản dưới hai người dùng, hoặc dưới hai tenant (qua người
dùng, hoặc qua danh sách cũ `quota.tenant.accounts`), bị từ chối với `409 MEMBERSHIP` (trước đây hai tenant chỉ cảnh
báo). Tài khoản của một tenant là tài khoản của các người dùng của nó cộng danh sách cũ, nên hạn mức tính cho người sở
hữu. Thứ tự trong chính sách: tenant < người dùng < tài khoản.

Các khóa `presence` (trong `mcp-config.json` `presence`, `accounts.<ownId>.presence`, và chính sách, áp dụng ngay):

| Khóa | Mặc định | Ý nghĩa |
|---|---|---|
| `presence.mode` | `on-demand` (`always-on` với MCP stdio và `listen` chạy tiền cảnh in ra stdout) | `on-demand`: chỉ giữ socket khi có việc cần; `always-on`: thời gian thực |
| `presence.idleTimeout` | `5m` (tối thiểu `30s`) | không có nhu cầu trong khoảng này thì socket tạm nghỉ (park) |
| `presence.minConnected` | `60s` | không bao giờ tạm nghỉ sớm hơn sau khi kết nối |
| `presence.maxWakesPerHour` | `12` | vượt quá thì thời gian chờ nhân đôi mỗi lần thức (tối đa một giờ) |
| `presence.warmWait` | `10s` | một lệnh đọc cache chờ socket đang thức bao lâu |
| `presence.connectOnStart` | `true` | bắt kịp một lần khi khởi động, rồi tạm nghỉ |
| `presence.catchUpEvery` | `off` | bắt kịp định kỳ khi đang tạm nghỉ (vd. `6h`); tắt cho đến khi đo được thời gian Zalo giữ hàng đợi offline |
| `presence.maxLeases`, `presence.leaseTtl`, `presence.leaseTtlMax` | `64`, `90s`, `600s` | lease của CRM cho mỗi tài khoản |
| `presence.waitHoldsSocket` | `true` | một `zalo_wait_for_message` / `/events/wait` đang chờ giữ socket (một gói có thể tắt; thời gian giữ được tính) |
| `presence.onKick` | `yield` | chỉ on-demand: khi một phiên khác (Zalo Web của chính người dùng) lấy tài khoản, nhường cho đến khi có người cần (`yield`), hoặc dừng daemon với mã 3 (`exit`) |
| `presence.alwaysOn.maxPerUser` | `1` | chính sách tenant hoặc người dùng: số tài khoản luôn-kết-nối mỗi người dùng |
| `presence.alwaysOn.maxPerTenant` | không | chính sách tenant: số tài khoản luôn-kết-nối mỗi tenant |

`ZALO_PRESENCE_MODE[_<ownId>]` và `ZALO_PRESENCE_IDLE_TIMEOUT[_<ownId>]` nằm giữa các tệp và chính sách.

**Giới hạn hạ tài khoản cũ nhất.** Khi một lần ghi (tài khoản, người dùng hoặc tenant) làm một người dùng hay tenant
vượt giới hạn, hoặc giới hạn bị hạ, tài khoản trở thành luôn-kết-nối sớm nhất được đặt về `on-demand` (một lần ghi chính
sách cấp tài khoản bởi `presence-cap`, một dòng nhật ký `capDemoted`, và `demoted: [...]` trong phản hồi của admin
API). Việc kiểm tra chạy dưới một khóa của máy, nên hai lần ghi đồng thời không thể cùng vượt qua. Chỉ tính các tài khoản
trên máy này.

Admin API (thông tin xác thực riêng): `GET|PUT|PATCH /zalo/admin/policy/users/<userId>` với thân
`{tenant?, accounts?, policy?}`, và `GET /zalo/admin/presence/always-on` (tài khoản luôn-kết-nối theo người dùng và
tenant có giới hạn, so với giới hạn). CLI: `zalo-agent policy get|set|unset ... --user <userId>`; thành viên được đặt
bằng `policy set tenant <tenantId> --user <id>` và `policy set accounts <ownId,ownId> --user <id>`.

**Chưa bật:** `listen` và `mcp start` vẫn giữ socket liên tục. Lõi hiện diện, tạm nghỉ/thức, các route lease của CRM
(`/zalo/presence/leases`) và các thiết lập này đã có; một bản phát hành sau sẽ bật on-demand cho daemon HTTP và backend
(webhook và lệnh chờ khi đó đến sau lần kết nối kế tiếp, gắn `catchUp: true`; thời gian thực là gói always-on).

---

## 2. Tra cứu

### Biến môi trường

Dấu "có" ở cột `_<ownId>` nghĩa là tên đó còn tồn tại với id tài khoản nối vào cuối (quy tắc 2 ở trên).

| Biến | `_<ownId>` | Ý nghĩa | Cờ | `mcp-config.json` |
|---|:-:|---|---|---|
| `ZALO_CONFIG_DIR` |  | gốc: `accounts.json`, `mcp-config.json`, credentials. Mặc định `~/.zalo-agent-cli` | `--config-dir` |  |
| `ZALO_CREDENTIALS_DIR` |  | tệp credentials. Mặc định `<CONFIG_DIR>/credentials` | `--credentials-dir` |  |
| `ZALO_DATA_DIR` (bí danh `ZALO_DB_DIR`) |  | cơ sở dữ liệu và tệp chạy theo tài khoản. Mặc định `<CONFIG_DIR>/accounts` | `--data-dir` |  |
| `ZALO_MEDIA_DIR` |  | thư mục gốc media tải về | `--media-dir` | `media.downloadDir` (chỉ MCP server) |
| `ZALO_OA_DIR` |  | credentials Official Account. Mặc định `~/.zalo-agent` | `--oa-dir` |  |
| `ZALO_ACCOUNT` |  | tài khoản cho lệnh chạy một lần | `--account` |  |
| `ZALO_ENV_FILE` |  | thêm một `.env` để nạp | `--env-file` |  |
| `ZALO_MCP_HTTP_PORT` | có | phục vụ HTTP/HTTPS trên port này thay vì stdio | `--http` | `httpPort` |
| `ZALO_MCP_HOST` | có | địa chỉ bind. Mặc định `127.0.0.1` | `--host` | `host` |
| `ZALO_MCP_AUTH_TOKEN` | có | bearer token cho `/mcp` và `/events/wait` | `--auth` (hiện trong `ps`; nên dùng biến) |  |
| `ZALO_MCP_TLS_CERT`, `ZALO_MCP_TLS_KEY` | có | phục vụ HTTPS; có cả hai hoặc không có | `--cert`, `--key` | `tls.cert`, `tls.key` |
| `ZALO_MCP_OAUTH_CLIENT_ID`, `ZALO_MCP_OAUTH_CLIENT_SECRET` | có | OAuth client chính (secret cũng dùng được làm bearer token) | `--client-id`, `--client-secret` | `oauth.clientId`, `oauth.clientSecret` |
| `ZALO_MCP_PUBLIC_URL` | có | địa chỉ công khai duy nhất của server khi đứng sau reverse proxy hoặc TLS (`https://zalo.example.com`, có thể kèm base path như `https://zalo.example.com/a/<ownId>`): endpoint MCP, OAuth issuer, và link tới trang nhập bảo mật dùng một lần (`/zalo/secure/<token>`) và trang đăng nhập QR (`/zalo/qr/<token>`). Phải là `https`, trừ `http` trên `localhost`, `127.0.0.1` hoặc `[::1]`; không có query hay fragment; dấu `/` cuối bị bỏ. Giá trị sai quy tắc làm server từ chối khởi động. Không đặt: link dùng địa chỉ của chính server và chỉ metadata OAuth còn suy từ header `Host` của request | `--public-url` (`mcp start`, `login`, `account login`) | `publicUrl` |
| `ZALO_MCP_ISSUER_URL` | có | tên cũ (deprecated) của `ZALO_MCP_PUBLIC_URL`, vẫn được đọc sau mọi nguồn `publicUrl`, kèm một ghi chú mỗi tiến trình | `--issuer-url` (deprecated) | `oauth.issuerUrl` (deprecated) |
| `ZALO_WEBHOOK_URL` | có | POST mỗi tin nhắn đến tới đây | `-w`, `--webhook` | `webhook` |
| `ZALO_WEBHOOK_SECRET` | có | ký webhook (`Authorization: Bearer` + `X-Zalo-Signature: sha256=…`) | `--webhook-secret` (hiện trong `ps`) | `webhookSecret` |
| `ZALO_WEBHOOK_BATCH_SIZE` | có | số sự kiện mỗi POST webhook, 1–100. Mặc định 1: mỗi sự kiện một POST | | `webhookBatchSize` |
| `ZALO_WEBHOOK_MAX_AGE` | có | thời gian thử lại một sự kiện chưa giao được trước khi chuyển vào dead-letter (`6h`, `24h`; tối thiểu `1m`). Mặc định `24h` | | `webhookMaxAge` |
| `ZALO_MCP_CONFIRM_MODE` | có | ai xác nhận một thao tác không hoàn tác được của tool (thu hồi, xóa, rời nhóm, …): `agent` (mặc định; bên gọi gửi `confirm: true`), `human` (server tự hỏi người dùng: qua MCP form elicitation khi chạy stdio, còn lại qua một trang duyệt dùng một lần có link trong kết quả, dùng được cả qua HTTP) hoặc `off` (không hỏi; `zalo_write` vẫn cần `confirm`) | | `confirmMode` |
| `ZALO_MCP_HIDDEN_CHATS` | có | MCP server cho thấy gì về các cuộc trò chuyện ẩn: `exclude` (mặc định: bỏ khỏi mọi danh sách, tìm kiếm, lịch sử và sự kiện), `contentless` (bỏ khỏi danh sách; sự kiện trong đó chỉ đến dưới dạng `{event, hidden: true}`, không có thread id hay nội dung) hoặc `include` (hiện như mọi cuộc khác: giao chúng cho agent) | | `hiddenChats` |
| `ZALO_MCP_ALLOW_PIN_ARGUMENT` | có | `true` cho phép các tool trò chuyện ẩn nhận mã PIN qua input `pin`. Mặc định `false`: input bị ghi vào log của MCP client và ngữ cảnh của mô hình. Chỉ dành cho client không phải AI | | `allowPinArgument` |
| `ZALO_MCP_APPROVAL_SECRET` | có | trang duyệt (`confirmMode: "human"`) hỏi thêm gì ngoài một cú bấm, để một agent mở được link cũng không tự duyệt được hành động của chính nó: `pin` (mã PIN trò chuyện ẩn, có khóa tạm khi sai), `password` (mật khẩu người duyệt đặt bằng `zalo-agent mcp approver set`, chỉ lưu dạng băm scrypt có salt), `none` (bấm là duyệt: yếu hơn) hoặc `auto` (mặc định: mật khẩu người duyệt khi đã đặt và link đi qua agent, nếu không thì không hỏi gì và kết quả ghi `approverSecret: false`) | | `approval.secret` |
| `ZALO_MCP_APPROVAL_DELIVER` | có | link của trang duyệt hoặc trang PIN được gửi đi đâu: `result` (mặc định: trong kết quả của tool), `webhook` (chỉ gửi tới webhook MCP, dạng sự kiện `approval_requested`; kết quả của tool không có link) hoặc `both` | | `approval.deliver` |
| `ZALO_MCP_MEDIA_DELIVER` | có | cách `zalo_view_media` trả media đã lưu, cho mọi loại (`link`) hoặc theo từng loại (`photo=inline,video=link`): `inline` (nội dung image/audio của MCP), `link` (`<publicUrl>/zalo/media/<token>`) hoặc `tempfile` (bản giải mã riêng tư trên máy này). Ghi đè `media.deliver` theo từng loại; `deliver` của chính lời gọi được ưu tiên hơn | | `media.deliver` |
| `ZALO_MCP_MEDIA_LINK_AUTH` | có | ai được tải link media: `bearer` (yêu cầu kèm `Authorization` của máy chủ này: `--auth`, `ZALO_MCP_AUTH_TOKEN` hoặc token OAuth), `capability` (chỉ cần link, giới hạn `media.capability.maxClients` địa chỉ client khi ra ngoài máy này) hoặc `auto` (mặc định: `bearer` khi `publicUrl` là máy khác, ngược lại `capability`) | | `media.linkAuth` |
| `ZALO_MCP_ADMIN_TOKEN_FILE` | có | tệp chứa token của admin API (ít nhất 16 ký tự): credential của systemd, mount giải mã bằng KMS. Đọc khi khởi động. Admin API cũng nhận token niêm phong do `zalo-agent policy token --rotate` tạo | | `admin.tokenFile` |
| `ZALO_MCP_ADMIN_TOKEN` | có | chính token của admin API (khi phát triển; nên dùng tệp hoặc token niêm phong). Token của agent luôn bị từ chối ở đó, kể cả khi hai token trùng nhau | | |
| `ZALO_MCP_ADMIN_CLIENT_CA` | có | chứng chỉ CA (PEM): chứng chỉ client do CA này ký được vào admin API (mTLS). Cần `--cert`/`--key` | | `admin.clientCa` |
| `ZALO_MCP_TRUSTED_PROXIES` | có | danh sách địa chỉ reverse proxy (phân tách bằng dấu phẩy) mà `X-Forwarded-For` của nó được tin (`127.0.0.1`, hoặc `loopback`). Mặc định không có: địa chỉ client là đầu kia của kết nối | | `trustedProxies` |
| `ZALO_MCP_GROUP_CONFIRM` |  | đã lỗi thời: `0` nghĩa là chế độ `off`, `1` là `agent`; chế độ xác nhận đặt rõ được ưu tiên | | `groupConfirm` |
| `ZALO_SYNC_NAME_REFRESH_MAX` |  | số tên DM không phải bạn bè mà một lần restore được tra. Mặc định 500 | | |
| `ZALO_START_JITTER` | có | chờ một khoảng ngẫu nhiên tối đa chừng này giây (0–600, mặc định 0) trước khi đăng nhập, để một đội daemon khởi động lại cùng lúc không đăng nhập cùng lúc | | |
| `ZALO_LOGIN_SLOTS` | có | tối đa chừng này daemon trên máy cùng đăng nhập và nạp danh sách một lúc (0–64; mặc định 0, không giới hạn); phần còn lại chờ một slot. `ZALO_LOGIN_SLOT_WAIT` (giây, mặc định 900) là thời gian chờ tối đa trước khi cứ tiếp tục | | |
| `ZALO_LOG_LEVEL` | có | `error`, `warn`, `info` (mặc định) hoặc `debug` (thêm một dòng cho mỗi HTTP request và mỗi tin nhắn) | `--log-level` | |
| `ZALO_LOG_FORMAT` |  | `text` (mặc định, mỗi dòng có thời gian) hoặc `json` (mỗi dòng một đối tượng) | | |
| `ZALO_LOG_MAX_SIZE`, `ZALO_LOG_KEEP` |  | xoay `daemon.log` khi đạt dung lượng này (mặc định `50m`, tối thiểu `4k`) và giữ chừng này file (mặc định 3) | | |
| `ZALO_AGENT_NO_UPDATE_CHECK` |  | giá trị bất kỳ: không bao giờ chạy kiểm tra cập nhật `npm view` | | |
| `ZALO_API_VERSION` |  | phiên bản giao thức báo cho Zalo. Mặc định 695 | | |
| `ZALO_QR_FLOW` |  | cách `login` đăng nhập bằng QR: `official` (mặc định: đúng trình tự Zalo Web, không gọi `verify-client`, `continue=https://chat.zalo.me/`, chuyển hướng qua `jr.zaloapp.com` và `jr.chat.zalo.me`, kèm mã QR thứ hai mà tài khoản có thiết bị tin cậy phải quét, khiến client này thành một thiết bị tin cậy đi kèm), là cách đăng nhập QR duy nhất. `legacy` đã bị bỏ ở 3.0.0; nó và mọi giá trị khác bị từ chối trước khi liên hệ Zalo | | |
| `ZALO_NET_PROBE` |  | thứ daemon hỏi để biết mạng còn hoạt động hay không khi socket đang đứt (mỗi 10 giây): một URL, mặc định là một trang nhẹ của công cụ tìm kiếm toàn cầu, hoặc `off` để coi như mạng luôn hoạt động và không liên hệ nơi nào ngoài Zalo | | |
| `ZALO_STORAGE_PROVIDER` |  | bộ cung cấp khóa bảo vệ các file đã lưu trên đĩa: `dpapi`, `keychain`, `secret-service`, `systemd-creds`, `kms`, `passphrase`, `env`. Mặc định theo nền tảng; server Linux không có desktop keyring phải đặt. Xem [security.vi.md](security.vi.md) | | |
| `ZALO_RETENTION_MESSAGES`, `ZALO_RETENTION_MEDIA` | có | `keep` hoặc `<N>d`: quy tắc theo tuổi của bộ nhớ đệm, đè lên `retention.messages` / `retention.media` của `storage.json` (xem mục Hạn mức dung lượng và thời gian lưu giữ) | | |
| `ZALO_STORAGE_DKEY_LAYER` |  | `1` / `0`: khóa thêm mọi thứ không cần cho việc đăng nhập bằng `dkey` của lần đăng nhập. Mặc định tắt | | |
| `ZALO_DPAPI_SCOPE`, `ZALO_SYSTEMD_CREDS_WITH_KEY`, `ZALO_KMS_BACKEND`, `ZALO_KMS_KEY`, `ZALO_STORAGE_PASSPHRASE_FILE`, `ZALO_STORAGE_KEY` |  | tùy chọn của bộ cung cấp khóa đã chọn (`ZALO_STORAGE_KEY`: khóa của bộ `env`, yếu theo thiết kế) | | |

`oa listen` lấy port từ `--port` (mặc định 3000). Engine không đọc `ZALO_OA_WEBHOOK_PORT`, dù các bản cũ của `.env.example` trong wrapper có ghi biến này.

### Các khóa của `mcp-config.json`

| Khóa | Mặc định | Ý nghĩa |
|---|---|---|
| `watchThreads` | `["dm:*", "group:*"]` | hội thoại nào được đưa vào bộ đệm: `dm:*`, `group:*`, `dm:<id>`, `group:<id>` |
| `triggerKeywords` | `["@bot"]` | từ khóa đánh dấu tin cần chú ý |
| `limits.maxMessagesPerPoll` | 20 | số tin tối đa một lần `zalo_get_messages` trả về |
| `limits.autoDigestThreshold` | 50 | số tin chưa đọc vượt mức này thì tool trả bản tóm tắt |
| `limits.bufferMaxAge` | `"2h"` | tin nằm trong bộ đệm live bao lâu |
| `limits.bufferMaxSize` | 500 | số tin giữ trong bộ đệm live **cho mỗi thread** |
| `media.downloadDir` | `null` | thư mục gốc media của máy chủ này (file trong đó được niêm phong bằng khóa media của tài khoản, như thư mục mặc định) |
| `media.autoOpen` | không đặt (= `true` khi stdio, `false` khi HTTP) | `zalo_view_media` mở file bằng trình xem của máy này (qua tempfile). Qua HTTP thì không bao giờ mở |
| `media.deliver` | photo, gif, doodle, sticker, voice, audio `inline`; video, file `link` | theo từng loại: `inline`, `link` hoặc `tempfile` (xem `ZALO_MCP_MEDIA_DELIVER`). Inline lớn hơn `inlineMaxBytes`, hoặc kiểu client không hiển thị được, chuyển thành link; tempfile cho client ở máy khác chuyển thành link |
| `media.inlineMaxBytes` | `5242880` | ảnh hoặc tin nhắn thoại lớn nhất gửi inline (5 MB là khoảng 6,7 MB base64 trong ngữ cảnh của model) |
| `media.allowDeliver` | `["inline","link","tempfile"]` | các cách một lời gọi, hoặc mặc định, được chọn. Máy chủ CRM có thể bỏ `tempfile` |
| `media.linkTtl` | `"10m"` | link media dùng được bao lâu |
| `media.tempfileTtl` | `"10m"` | bản giải mã được giữ bao lâu trước khi bị xóa |
| `media.linkAuth` | không đặt (= `auto`) | `auto`, `bearer` hoặc `capability` (xem `ZALO_MCP_MEDIA_LINK_AUTH`) |
| `media.linkRateLimit` | `60` | số yêu cầu mỗi phút một địa chỉ client được gửi tới link media (và 10 token lạ mỗi phút), sau đó `429` |
| `media.capability.maxClients`, `.ttl` | `3`, `"15m"` | link capability ra ngoài máy này phục vụ tối đa chừng này địa chỉ client khác nhau, mỗi địa chỉ trong chừng này thời gian kể từ yêu cầu đầu tiên (load balancer, kết nối lại trên mạng khác, các yêu cầu range của trình phát video). Nâng theo tài khoản trong `accounts.<ownId>.media.capability` |
| `trustedProxies` | `null` (không có) | các reverse proxy mà `X-Forwarded-For` được tin (xem `ZALO_MCP_TRUSTED_PROXIES`). Ghi địa chỉ proxy của bạn, nếu không giới hạn theo client chỉ thấy một client |
| `notify.enabled`, `.thread`, `.on`, `.cooldown` | tắt | báo vào một nhóm Zalo khi agent vắng mặt |
| `webhook`, `webhookSecret` | `null` | đẩy mỗi tin tới một URL, có ký (nên dùng `ZALO_WEBHOOK_SECRET`) |
| `webhookBatchSize` | `1` | số sự kiện mỗi POST webhook (1–100) |
| `webhookMaxAge` | `"24h"` | sự kiện webhook chưa giao quá thời gian này sẽ chuyển vào dead-letter |
| `httpPort`, `host` | `null` | port HTTP và địa chỉ bind |
| `tls.cert`, `tls.key` | `null` | HTTPS |
| `publicUrl` | `null` | địa chỉ công khai duy nhất của server (xem `ZALO_MCP_PUBLIC_URL`): endpoint MCP, OAuth issuer, link trang bảo mật và trang QR. Theo tài khoản: `accounts.<ownId>.publicUrl` |
| `oauth.clientId`, `.clientSecret`, `.clients[]` | | các consumer OAuth 2.0; `clients[]` là danh sách `{clientId, clientSecret}` |
| `oauth.issuerUrl` | `null` | tên cũ (deprecated) của `publicUrl`, vẫn được đọc khi không nguồn `publicUrl` nào được đặt |
| `confirmMode` | chưa đặt (= `agent`) | `agent`, `human` hoặc `off`: ai xác nhận một thao tác không hoàn tác được của tool. Đặt `agent` cho AI agent; `human` để server tự hỏi người dùng |
| `hiddenChats` | chưa đặt (= `exclude`) | `exclude`, `contentless` hoặc `include`: agent thấy gì về trò chuyện ẩn (xem biến ở trên) |
| `allowPinArgument` | chưa đặt (= `false`) | `true` cho các tool trò chuyện ẩn nhận PIN qua input; khi đó PIN nằm trong log của client |
| `approval.secret` | không đặt (= `auto`) | `auto`, `pin`, `password` hoặc `none`: trang duyệt hỏi thêm gì ngoài một cú bấm (xem biến ở trên) |
| `approval.deliver` | không đặt (= `result`) | `result`, `webhook` hoặc `both`: link của trang dùng một lần được gửi đi đâu |
| `groupConfirm` | | đã lỗi thời: `false` nghĩa là `confirmMode: "off"` khi chưa đặt chế độ xác nhận |
| `admin.tokenFile` | `null` | xem `ZALO_MCP_ADMIN_TOKEN_FILE` |
| `admin.clientCa` | `null` | xem `ZALO_MCP_ADMIN_CLIENT_CA` |
| `accounts.<ownId>` | | bất kỳ khóa nào ở trên, cho một tài khoản |

Khóa không có trong bảng này bị bỏ qua mà không báo. (Khóa `mode` trong các tệp cũ được chấp nhận nhưng không bao giờ được đọc.)

---

## 3. Các mô hình nên dùng

Mỗi mô hình nêu các tệp và lệnh. Thay `1000000000000000001` bằng id tài khoản lấy từ `zalo-agent account list`, và mọi `CHANGE_ME…` bằng giá trị từ `openssl rand -hex 32`.

### 3.1 Trên máy · AI agent · stdio

Cho Claude Code, Claude Desktop hoặc Cursor trên chính máy giữ tài khoản. Không port, không token: client tự khởi động máy chủ và nói chuyện qua stdin/stdout.

- Tệp: không bắt buộc. Tùy chọn [`mcp-config/local-agent.json`](config-samples/mcp-config/local-agent.json) tại `~/.zalo-agent-cli/mcp-config.json`.
- Client: [`clients/claude-code-stdio.json`](config-samples/clients/claude-code-stdio.json) (`~/.claude/settings.json`, hoặc tệp tương đương của client).
- Nhiều tài khoản: mỗi tài khoản một mục máy chủ, mỗi mục có `--account` riêng.

### 3.2 Trên máy · cùng máy · HTTP trên loopback

Cho backend, n8n hoặc container chạy cùng máy mà không dùng được stdio.

```bash
ZALO_MCP_HTTP_PORT=3847 ZALO_MCP_AUTH_TOKEN=CHANGE_ME_64_HEX_CHARACTERS \
  zalo-agent mcp start --account 1000000000000000001
```

- Bind mặc định là `127.0.0.1`: không gì từ ngoài máy kết nối được. **Vẫn nên đặt token**: nếu không, bất kỳ người dùng cục bộ nào, và bất kỳ trang web nào trong trình duyệt trên máy, đều có thể chạm tới (máy chủ trả lời mọi origin).
- Container truy cập máy chủ bind loopback qua `host.docker.internal` trên Docker Desktop (Windows, macOS). Trên Linux, cho container `--add-host=host.docker.internal:host-gateway` và bind vào địa chỉ cầu Docker (`ZALO_MCP_HOST=172.17.0.1`) thay vì `0.0.0.0`.
- Lấy [`env/crm-backend.env`](config-samples/env/crm-backend.env) làm điểm xuất phát và bỏ các dòng webhook nếu không cần.

### 3.3 LAN · AI agent và CRM ở máy khác

```bash
zalo-agent --env-file /etc/zalo-mcp/lan.env mcp start --account 1000000000000000001
```

- Tệp: [`env/lan-server.env`](config-samples/env/lan-server.env) và, nếu muốn, [`mcp-config/lan.json`](config-samples/mcp-config/lan.json).
- Bind vào địa chỉ LAN (`ZALO_MCP_HOST=192.168.1.20`), không dùng `0.0.0.0` trên máy nhiều giao diện mạng. **Token là bắt buộc**: không có token, máy chủ in `WARNING: no --auth token` và phục vụ bất kỳ ai tới được port.
- Chặn port bằng firewall theo mạng con (`ufw allow from 192.168.1.0/24 to any port 3847`).
- HTTP trên LAN tin cậy là chấp nhận được; nếu LAN dùng chung, thêm TLS bằng `ZALO_MCP_TLS_CERT` / `ZALO_MCP_TLS_KEY` (chứng chỉ từ CA riêng hoặc `mkcert`).
- Client dùng `http://192.168.1.20:3847/mcp` với `Authorization: Bearer <token>`.

### 3.4 Internet · AI agent (claude.ai connector, agent từ xa)

Giữ engine trên loopback và đặt reverse proxy TLS phía trước.

- Tệp: [`env/internet-server.env`](config-samples/env/internet-server.env), [`mcp-config/internet.json`](config-samples/mcp-config/internet.json) và một mẫu proxy: [`proxy/Caddyfile.internet`](config-samples/proxy/Caddyfile.internet) hoặc [`proxy/nginx.internet.conf`](config-samples/proxy/nginx.internet.conf).
- Proxy không được đệm phản hồi và phải cho phép đọc tối thiểu 310 giây: `/events/wait` giữ một request tới 300 giây. Cả hai mẫu đều được kiểm thử điều này.
- **Xác thực:** bearer token cho script và backend; OAuth 2.0 cho các connector từ xa đòi hỏi nó. Đặt `ZALO_MCP_PUBLIC_URL` (hoặc `publicUrl`) là địa chỉ `https://` công khai: OAuth issuer, endpoint MCP và mọi link tới trang dùng một lần đều được dựng từ đó. Nếu không, link dùng địa chỉ của chính server, còn metadata OAuth và header `WWW-Authenticate` được dựng từ chính các header `X-Forwarded-Host` / `Host` của request, mà client nào cũng đặt được. (`ZALO_MCP_ISSUER_URL`, `--issuer-url` và `oauth.issuerUrl` là tên cũ của nó từ 2.x, vẫn dùng được.) Nhiều consumer: liệt kê trong `oauth.clients[]` của `mcp-config.json`.
- HTTPS gốc (`--cert` / `--key`) không qua proxy chạy được, nhưng engine **còn cố nghe thêm port 443** bên cạnh port của bạn. Nên dùng proxy.
- Thêm những gì engine không có: danh sách IP được phép tại proxy, giới hạn tốc độ, và log không bao giờ ghi header `Authorization`. Máy chủ trả `Access-Control-Allow-Origin: *` cho mọi origin; xóa hoặc thay header này tại proxy nếu không muốn trình duyệt gọi.

### 3.5 Backend cho CRM

CRM cần ba thứ từ một tài khoản: **nghe** tin mới, **gửi**, và **bắt kịp** sau thời gian CRM ngừng. Đó là ba cơ chế khác nhau.

**Nghe: đẩy bằng webhook.** Tệp: [`env/crm-backend.env`](config-samples/env/crm-backend.env), [`mcp-config/crm-backend.json`](config-samples/mcp-config/crm-backend.json).

- `mcp start` gửi `{event: "message", accountId, msgId, threadId, threadType, senderId, senderName, text, timestamp, type, attachment, replyTo}` cho mỗi tin qua được `watchThreads`. `listen -w` gửi dạng khác, phong phú hơn (`{accountId, event, msgId, threadId, type, isSelf, uidFrom, dName, msgType, content, …}`) và cả sự kiện bạn bè, nhóm, reaction, đã đọc. Chọn một cách cho mỗi tài khoản.
- Mỗi lần gửi kèm `Authorization: Bearer <secret>` và `X-Zalo-Signature: sha256=<HMAC-SHA256 dạng hex của body gốc>`. Xác minh chữ ký trên **byte gốc**: [`clients/crm-webhook-receiver.mjs`](config-samples/clients/crm-webhook-receiver.mjs) (Node) và [`clients/crm_webhook_receiver.py`](config-samples/clients/crm_webhook_receiver.py) (Python) làm đúng việc đó.
- **Giao nhận bền vững, đúng thứ tự, ít nhất một lần.** Mỗi sự kiện được ghi vào `webhook-outbox.db` trong thư mục tài khoản trước khi gửi, nên bên nhận hỏng, chậm (mỗi POST có 10 giây) hoặc trả khác 2xx chỉ tạo ra tồn đọng chứ không mất tin: bên gửi thử lại với thời gian chờ 1 giây nhân đôi đến 5 phút, giữ mọi sự kiện phía sau sự kiện đang lỗi để không đảo thứ tự, và tiếp tục sau khi khởi động lại hoặc bị sập. Payload bị bên nhận từ chối vì sai định dạng (400, 413, 422) được chuyển vào **dead-letter**, sự kiện chưa giao quá `ZALO_WEBHOOK_MAX_AGE` (24 giờ) cũng vậy. Theo dõi bằng `zalo-agent mcp webhook status`, xem bằng `mcp webhook list --dead`, đưa trở lại hàng đợi bằng `mcp webhook retry`.
- **Trả 2xx ngay, xử lý sau, và loại trùng theo id tin nhắn.** Ít nhất một lần nghĩa là một tin có thể đến hai lần (sập sau khi bạn trả lời nhưng trước khi bên gửi kịp ghi nhận). Mỗi POST có `X-Zalo-Attempt` và `X-Zalo-Delivery: <đầu>-<cuối>` (số thứ tự trong outbox).
- **Gộp (batch).** Với `ZALO_WEBHOOK_BATCH_SIZE=10`, tối đa mười sự kiện đang chờ đi chung một POST dạng `{"event":"batch","accountId":…,"count":N,"events":[…]}`, chữ ký tính trên toàn bộ body; một sự kiện đơn lẻ vẫn là payload thường. Các bộ nhận mẫu xử lý được cả hai. Bật khi tồn đọng hoặc nhiều tài khoản khiến một POST mỗi tin là quá nhiều.

**Nghe: kéo.** `GET /events/wait?timeout=55&since=<cursor>&limit=50` trả về tối đa `limit` tin đang có trong bộ đệm mỗi lần gọi (mặc định 1, tối đa 100), hoặc `{"status":"timeout"}`, kèm cursor để tiếp tục. Phản hồi có `messages` (đúng thứ tự), `count`, `hasMore` và `cursor` là của tin **cuối**, nên `since=<cursor>` tiếp tục đúng chỗ lô vừa kết thúc; `message` vẫn là tin đầu, nên client không gửi `limit` vẫn thấy đúng như trước. Để xả một đống tồn, gọi lại ngay khi `hasMore` còn true; `settle=200` (ms, tối đa 5000) chờ thêm chừng đó sau tin đầu tiên để một đợt tin đến dồn vào một phản hồi. `limit` và `settleMs` cũng có ở tool `zalo_wait_for_message` và ở `mcp wait --limit --settle`. Bộ đệm phía sau giữ tối đa `limits.bufferMaxSize` tin cho mỗi thread trong `limits.bufferMaxAge` (mẫu CRM nâng cả hai lên 2.000 và 6 giờ). Quá mức đó, đọc cache bằng `zalo_get_history` / `zalo_get_messages`.

**Gửi.** Một lời gọi JSON-RPC tới `POST /mcp`: [`clients/crm-send-message.sh`](config-samples/clients/crm-send-message.sh). Gửi `Accept: application/json, text/event-stream` (thiếu một trong hai, máy chủ trả 406); phản hồi là một dòng SSE `data:`, và gửi thành công trả về `{"success":true,"messageId":…,"cliMsgId":…,"threadType":…}`. `threadId` là id người dùng cho tin nhắn riêng hoặc id nhóm cho nhóm. Mỗi request `/mcp` dựng một máy chủ mới với đủ 36 tool, tốn vài mili giây CPU: ổn cho CRM, và là lý do một tài khoản chạm trần khoảng 60–170 request/giây (xem [`docs/deployment.vi.md`](deployment.vi.md) §1.4).

**Bắt kịp.** Sau thời gian ngừng, hỏi những gì đã lỡ: `zalo_get_history` theo từng thread, hoặc `zalo-agent sync --from <date>` (có thể yêu cầu chủ tài khoản xác nhận trên điện thoại).

**Trò chuyện ẩn và trang nhập bảo mật.** Các cuộc trò chuyện ẩn của tài khoản bị bỏ khỏi mọi thứ CRM đọc (`hiddenChats: "exclude"`); `contentless` gửi sự kiện webhook `{event: "message", hidden: true, accountId}` không có thread id hay nội dung, như chấm chưa đọc mà Zalo Web hiện. Mọi thứ một người phải gõ hoặc duyệt (mã PIN trò chuyện ẩn, một lần duyệt của `confirmMode: "human"`) là một trang dùng một lần trên chính port của server, `/zalo/secure/<token>`: kết quả của tool có `secureUrl`, `ticketExpiresAt` (5 phút) và `retryWith.ticket`; CRM hiện link cho chủ tài khoản và gọi lại với `ticket` khi họ làm xong. Cho `/zalo/secure/` đi qua cùng proxy với `/mcp` và đặt `publicUrl` là địa chỉ công khai của nó (link không bao giờ được dựng từ header `Host` của request). Trang không cần bearer token (token của nó là chìa khóa), gửi `Cache-Control: no-store`, không tải gì từ nơi khác, và token bị che trong log request. Xem [`docs/deployment.vi.md`](deployment.vi.md) §5.5.

**Duyệt ngay trong giao diện của CRM.** Với `approval.deliver: "webhook"` link không bao giờ đi qua agent: server POST `{event: "approval_requested", accountId, kind, action, wouldDo, target, secureUrl, expiresAt, approverSecret}` tới webhook (xếp hàng và ký như sự kiện tin nhắn), CRM hiện `wouldDo` và link cho một người, còn kết quả của tool chỉ có `{confirmationRequired hoặc pinRequired: true, approvalPending: true, ticket, ticketExpiresAt, deliveredTo: "webhook"}`. CRM gọi lại với `ticket` đó khi người kia làm xong; ticket không phải token của trang, nên không gì trong kết quả mở được trang. Khi link buộc phải đi qua agent, hãy đặt mật khẩu người duyệt (`zalo-agent mcp approver set`) hoặc `approval.secret: "pin"`, để trang hỏi điều chỉ người đó biết.

### 3.6 Nhiều tài khoản

Một tài khoản là một tiến trình, một WebSocket, một tệp SQLite và một port: không có chế độ nhiều tài khoản trong một tiến trình. Chạy **một instance systemd cho mỗi tài khoản** với tệp env riêng:

- [`systemd/zalo-mcp@.service`](config-samples/systemd/zalo-mcp@.service): tên instance chính là id tài khoản; token và port lấy từ `/etc/zalo-mcp/accounts/<id>.env`, nên không có gì bí mật trên dòng lệnh. Các instance khởi động lệch nhau trong 30 giây (mỗi lần khởi động đều đăng nhập và nạp danh sách của tài khoản; cả đàn khởi động cùng lúc là thời điểm nặng nhất) và mỗi instance bị giới hạn 600 MB (instance nhàn rỗi khoảng 100 MB).
- [`systemd/common.env`](config-samples/systemd/common.env) cho phần chung, [`env/account.env`](config-samples/env/account.env) cho từng tài khoản.
- [`systemd/zalo-mcp-purge.service`](config-samples/systemd/zalo-mcp-purge.service) và [`systemd/zalo-mcp-purge.timer`](config-samples/systemd/zalo-mcp-purge.timer): chạy `fleet purge --yes` mỗi giờ, để tài khoản có daemon đang dừng vẫn được xóa theo hạn mức và thời gian lưu giữ (dưới `daemon.lock` của nó), và daemon có lịch riêng bị trễ được yêu cầu chạy ngay.
- **`zalo-agent fleet generate --out <dir>`** ghi toàn bộ những thứ trên cho mọi tài khoản đã đăng ký (unit, file env với token tự sinh cho từng tài khoản, bảng port, tuỳ chọn cả Caddyfile); `fleet status` cho xem mọi daemon trong một bảng, `fleet start` / `restart` khởi động theo từng lô được xáo trộn, và `fleet restart --unhealthy` chỉ khởi động lại những cái đang chết (xem [`docs/deployment.vi.md`](deployment.vi.md) §4.8).
- Một kế hoạch port, ví dụ `3900 + n`, ghi trong một bảng (`fleet ports` giữ bảng đó giúp bạn). Sau một tên miền: [`proxy/Caddyfile.multi-account`](config-samples/proxy/Caddyfile.multi-account) định tuyến `/a/<ownId>/…` tới đúng port; dùng bearer token, mỗi tài khoản một token.
- Cho mỗi tài khoản **proxy riêng** khi đăng nhập (`zalo-agent login --proxy …`) và dấu vân tay thiết bị riêng (tự động): hàng trăm tài khoản từ một địa chỉ là điều khiến tài khoản bị khóa.
- Cài đặt chung trong `mcp-config.json`, khác biệt theo tài khoản trong khối `accounts` của nó ([`mcp-config/multi-account.json`](config-samples/mcp-config/multi-account.json)).
- Đọc §1.4 của [`docs/deployment.vi.md`](deployment.vi.md) trước khi vượt quá vài chục tài khoản.

---

## 4. Danh sách kiểm tra trước khi mở một port

| Kiểm tra | Lý do |
|---|---|
| đã đặt token (`ZALO_MCP_AUTH_TOKEN`), 32+ byte ngẫu nhiên | không có token, máy chủ phục vụ bất kỳ ai tới được, và chỉ nói điều đó trong log |
| token nằm trong tệp env quyền `0600`, không nằm trong cờ | cờ hiện trong `ps` và `/proc/<pid>/cmdline`; dòng log của daemon có che, `ps` thì không |
| `ZALO_MCP_HOST` là `127.0.0.1` sau proxy, hoặc một địa chỉ LAN cụ thể | `0.0.0.0` nghe trên mọi giao diện, kể cả giao diện công khai |
| TLS kết thúc tại proxy, hoặc đã đặt `--cert`/`--key` | bearer token qua HTTP thường đọc được trên đường truyền |
| proxy không ghi `Authorization` và không đệm `/events/wait` | token lọt vào log; long-poll bị cắt theo timeout của proxy |
| `GET /health` và `GET /ready` là hai route duy nhất không cần xác thực | chúng chỉ cho biết tiến trình có trả lời không và socket Zalo có đang kết nối không, không nói gì về tài khoản. `/status` và `/metrics` nằm sau token: đừng công bố chúng qua proxy |
| mỗi tài khoản một tiến trình, không bao giờ hai cho cùng tài khoản | phiên thứ hai đóng phiên thứ nhất (mã 3000) |

## 5. Kiểm tra một mô hình đã chạy đúng

```bash
# lên rồi, và token được thực thi (mong đợi 200, 401, 401):
curl -s -o /dev/null -w '%{http_code}\n' http://HOST:PORT/health
# socket Zalo đang kết nối (200; 503 khi đang mất), chi tiết nằm sau token:
curl -s -o /dev/null -w '%{http_code}\n' http://HOST:PORT/ready
curl -s -H "Authorization: Bearer $TOKEN" http://HOST:PORT/status | head -c 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://HOST:PORT/mcp
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://HOST:PORT/mcp -H 'Authorization: Bearer wrong'

# các tool được phục vụ (mong đợi 36 tên):
curl -s http://HOST:PORT/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -o '"name":"zalo_[a-z_]*"' | wc -l

# daemon, log và socket của nó:
zalo-agent mcp start --account 1000000000000000001 --status
tail -f ~/.zalo-agent-cli/accounts/1000000000000000001/daemon.log   # khi chạy với -d
```
