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
| `<CONFIG_DIR>/storage.json` | mọi lệnh đọc hay ghi phiên đăng nhập đã lưu | bộ cung cấp khóa và lớp dkey bảo vệ các file đã lưu (ở cấp trên cùng, hoặc theo từng tài khoản trong `accounts.<ownId>`, ví dụ khóa KMS của một tenant trong `accounts.<ownId>.kms.key`, mà mọi lệnh đều đọc), và `rowMac.verifyOnRead` (`actions` (mặc định) hoặc `off`: thao tác có kiểm tra tin nhắn trong bộ nhớ đệm mà nó tác động với row MAC của tin đó hay không) ([security.vi.md](security.vi.md)); `retention.*` và `quota.*` của bộ nhớ đệm (xem [Hạn mức dung lượng và thời gian lưu giữ](#hạn-mức-dung-lượng-và-thời-gian-lưu-giữ)) và `groups.onLeave` (xem [Rời nhóm](#rời-nhóm-groupsonleave)); không chứa bí mật |

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
| **chính sách** | theo tenant `<CONFIG_DIR>/tenants/<tenantId>.json` (cho tài khoản của các người dùng thuộc tenant và các tài khoản liệt kê trong `quota.tenant.accounts`), rồi theo người dùng `<CONFIG_DIR>/users/<userId>.json` (cho các tài khoản người đó sở hữu), rồi theo tài khoản `<accountDir>/policy.json` |

Chính sách nhận `confirmMode`, `hiddenChats`, `allowPinArgument`, `ownMyDocuments`, `routing.*`, `approval.*`, `media.deliver`, `media.inlineMaxBytes`,
`media.allowDeliver`, `media.linkTtl`, `media.tempfileTtl`, `media.linkAuth`, `media.linkRateLimit`,
`media.capability.*`, `media.autoOpen`, `webhook`, `webhookBatchSize`, `webhookMaxAge`, `quota.*`, `retention.*`,
`groups.onLeave`, `presence.*` và `session.renew.*` (`presence.alwaysOn.*` chỉ có trong chính sách của tenant hoặc người dùng;
`quota.tenant.*` chỉ có trong chính sách của tenant). Khóa chỉ đọc khi khởi động (`httpPort`, `host`, `publicUrl`, `tls`,
`oauth`, `trustedProxies`, `admin`, `media.downloadDir`, bộ cung cấp khóa và các tùy chọn của nó, `accounts`) và mọi bí
mật (`webhookSecret`) bị từ chối với `restartRequired`; khóa khác bị từ chối vì không biết. Các tệp được niêm phong bằng
khóa boot của tài khoản (của tenant và người dùng thì bằng `keyring.json` trong thư mục của chúng) và có số phiên bản
(`rev`) tăng sau mỗi lần đổi.

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
2. **`zalo-agent policy set|unset <key> [<value>] [--tenant <id>|--user <id>] [--if-match <rev>]`** (và `policy get
   [key] [--effective]`): đi qua daemon đang chạy của tài khoản (áp dụng ngay), nếu không thì ghi vào tệp cho lần khởi
   động sau.
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
| `quota.minFree` | `2GB` | dung lượng trống luôn chừa lại trên ổ đĩa chứa dữ liệu và media của tài khoản: số byte, hoặc `"2GB"`, hoặc `0` để tắt. `ZALO_STORAGE_MIN_FREE` thắng nó, rồi tới chính sách chạy, rồi `storage.json`. Xem [chừa chỗ trước khi tải](#chừa-chỗ-trước-khi-tải-quotaminfree) |
| `retention.messages` | `keep` | `keep`, hoặc `<N>d`: tin nhắn từ N ngày tuổi trở lên bị xóa |
| `retention.media` | `keep` | `keep`, hoặc `<N>d`: file media của tin nhắn từ N ngày tuổi trở lên bị xóa (tin nhắn vẫn giữ) |
| `retention.outboxDead` | `30d` | lượt gửi webhook đã chết bị xóa sau thời gian này |
| `retention.purgeEvery` | `6h` | daemon kiểm tra bao lâu một lần (ít nhất `1m`); `fleet purge` (chạy theo timer) yêu cầu daemon nào chưa kiểm tra trong khoảng gấp đôi thời gian này chạy ngay, và tự xóa cho tài khoản không có daemon |
| `quota.user.limit` | không có | trong chính sách tenant (mặc định cho mỗi người dùng) hoặc của người dùng: phần của người dùng, cộng trên các tài khoản nó sở hữu ở máy này; vượt mức thì mỗi tài khoản nhả phần của mình trong lượng vượt như với tenant (sự kiện mang `scope: "user"`, `userId`) |
| `retention.mediaTempCap` | không có | số byte, hoặc `"1GB"`: dung lượng tối đa của các bản giải mã tạm (`deliver: "tempfile"`); vượt mức thì bản cũ nhất bị xóa trước. Thư mục tạm là của cả máy, nên giới hạn tính bản tạm của mọi tài khoản |

**Vượt giới hạn thì vẫn tiếp tục lưu đệm.** Daemon gửi sự kiện `storage_quota` tới webhook (`listen` in ra, và
`mcp start` còn đưa chúng tới client MCP dưới dạng sự kiện hệ thống trong `zalo_get_messages` / `zalo_wait_for_message`):
`{event: "storage_quota", accountId, scope: "account"|"tenant", tenantId?, level, usedBytes, limitBytes, overSince,
purgeAt}` với `level` là `warn`, `over`, `grace_ending` (`daysLeft` 7 và 1), `purged` (`freedBytes`, `media`,
`messages`) và `ok` (đã về dưới giới hạn: nâng giới hạn hoặc gia hạn sẽ xóa đồng hồ ân hạn). Sau `quota.graceDays` nó
xóa media cũ nhất, rồi tin nhắn cũ nhất (kèm mục tìm kiếm, reaction và row MAC; các trang được `secure_delete` ghi
đè số 0 và WAL được checkpoint) cho tới khi dung lượng bằng hoặc dưới giới hạn; mỗi tài khoản của tenant nhường phần
vượt tương ứng với dung lượng của nó. Một lần xóa nâng mốc lưu giữ (retention floor) của cơ sở dữ liệu: không lần sync
hay lấy lịch sử nào lưu lại tin nhắn ở hoặc trước mốc đó. File cơ sở dữ liệu giữ nguyên kích thước (SQLite dùng lại
các trang đã giải phóng); dung lượng tính theo các trang đang dùng. `zalo-agent db usage` (và `zalo_profile` `usage` qua MCP) cho xem tất cả,
`db purge --dry-run` đếm những gì đến hạn, và `db purge --yes` chạy ngay (qua daemon nếu có daemon đang chạy).

#### Chừa chỗ trước khi tải (`quota.minFree`)

Trước một lần tải media (`sync-media`, bước media của `sync`, lần tải sau khi khôi phục, `zalo_view_media`) và trước
mỗi file được lưu, engine kiểm tra còn chỗ: ổ đĩa vẫn trống ít nhất `quota.minFree`, và tài khoản vẫn dưới
`quota.account.limit` khi có đặt giới hạn. Khi một trong hai sắp bị vượt, lần tải dừng lại và nói rõ lý do; các file
chưa lưu vẫn ở trạng thái chờ, và chạy lại đúng lệnh đó sẽ tải tiếp khi đã có chỗ (dọn bớt dung lượng, hoặc nâng giới
hạn). Lần khôi phục được đề nghị sau khi đăng nhập QR cũng bị bỏ qua như vậy khi không còn chỗ, và lệnh đăng nhập ghi
rõ lệnh `sync` để chạy sau. Đặt `quota.minFree` là `0` (hoặc `ZALO_STORAGE_MIN_FREE=0`) để tắt kiểm tra ổ đĩa.

Token admin: `zalo-agent policy token --rotate` tạo một token và hiện nó đúng một lần; chỉ SHA-256 của nó được giữ, niêm
phong trong `<CONFIG_DIR>/admin/admin-token.json`, và lần xoay mới làm token cũ hết hiệu lực ngay. Hoặc trỏ
`ZALO_MCP_ADMIN_TOKEN_FILE` (`admin.tokenFile`) tới tệp do bộ cung cấp của bạn điền (credential của systemd, mount giải
mã bằng KMS). `ZALO_MCP_ADMIN_TOKEN` chỉ dùng khi phát triển.

### Rời nhóm (`groups.onLeave`)

Khi tài khoản **rời** một nhóm, bị **xóa** hoặc bị **chặn** khỏi nhóm, hoặc nhóm bị **giải tán**, ứng dụng Zalo xóa
ngay lịch sử cục bộ của nhóm đó. Engine này cũng làm vậy theo mặc định:

| Giá trị | Điều gì xảy ra |
|---|---|
| `purge` (mặc định) | Ngay khi rời: tin nhắn của nhóm (kèm row MAC và mục tìm kiếm; `secure_delete` ghi đè trang bằng số 0), cảm xúc, mục bảng tin (ghim, ghi chú, bình chọn), nhắc hẹn, chỉ mục cloud và trạng thái hội thoại (ghim, đánh dấu chưa đọc, mốc đã đọc) bị xóa theo từng đợt giới hạn có nhường vòng lặp sự kiện, cùng media đã tải mà không hội thoại nào khác trỏ tới; link media và link export vào nhóm bị thu hồi. Nhóm biến mất khỏi `conv recent`, `zalo_list_conversations` và `zalo_search_threads`. |
| `keep` | Không xóa gì. Nhóm vẫn đọc được và được liệt kê kèm cờ: `gone: true`, `leftAt` (epoch ms), `goneReason` (`leave`, `removed`, `blocked`, `disbanded`) trong `conv recent`, `zalo_list_conversations`, `zalo_list_threads` và `zalo_search_threads`; `db export` chép các cột đó của `threads`. Gửi vào nhóm (`msg send` và các `msg send-*`, `zalo_send_message`) bị từ chối kèm lý do và ngày. Nhóm được giữ tuân theo thứ tự hạn mức/thời gian lưu giữ thông thường. |

Trong cả hai trường hợp nhóm giữ một **mốc xóa** (`threads.deleteMarkerAt`, như tombstone `deleteAllPrior` của Zalo):
không bên ghi nào -- listener, khôi phục từ điện thoại (`sync`), `msg history`, đồng bộ bù khi offline hay kéo từ cloud --
lưu lại tin nhắn của nhóm có thời điểm bằng hoặc trước mốc đó. Khi nhóm đã rời, các sự kiện nhóm sau đó bị bỏ qua cho
đến khi có một `join` nêu tên tài khoản này (quy tắc của Zalo); một tin nhắn chat có thời điểm sau khi rời, hoặc danh
sách hội thoại của một lần khôi phục có chứa nhóm, cũng chứng tỏ tài khoản đã quay lại. Vào lại nhóm không bao giờ mang
về những gì đã xóa.

Những gì được phát hiện: sự kiện `leave` / `remove_member` / `block_member` của chính mình (khi `listen` hoặc `mcp start`
đang chạy); `group leave` / `group disperse` của chính mình (và `zalo_group` `leave` / `disperse`) khi Zalo báo thành
công, **không cần listener đang chạy**, vẫn sau bước xác nhận thường lệ (`--yes`; `confirmMode` của MCP); nhóm bị giải
tán theo thông tin nhóm -- nhóm nằm trong `removedsGroup`, hoặc bị trả lỗi 161 (hoặc không phải thành viên) khi hỏi riêng
(`group info`, `group members`, `zalo_group` `info`, `zalo_get_group_members`, bộ nhớ tên hội thoại của MCP lúc khởi
động, bước lấy nhóm của `sync`). Mỗi lần rời là một sự kiện `group_gone`: `{event: "group_gone", accountId, threadId,
reason, leftAt, mode, source, purged: {messages, reactions, boardItems, reminders, cloudItems, convState, files,
filesShared, fileErrors, links}|null}` -- `listen` in ra và ghi vào JSONL và webhook, `mcp start` gửi tới webhook và bộ
đệm trực tiếp (một sự kiện hệ thống trong `zalo_get_messages` / `zalo_wait_for_message`).

Đây là khóa chính sách runtime **áp dụng ngay** (tenant < user < account), được đọc tại thời điểm mỗi lần rời nhóm,
không cần khởi động lại. Thấp nhất trước: mặc định, `storage.json` `groups.onLeave` rồi `accounts.<ownId>.groups.onLeave`,
`ZALO_GROUPS_ON_LEAVE[_<ownId>]`, rồi chính sách. **Chuyển `keep` -> `purge`** sẽ xóa các nhóm đã giữ tới nay ở lần kiểm
tra hạn mức/thời gian lưu giữ kế tiếp (`retention.purgeEvery`; `db purge`, hoặc `fleet purge` cho tài khoản đang dừng).
**Chuyển `purge` -> `keep`** chỉ áp dụng cho các lần rời nhóm sau này: **lịch sử đã xóa không bao giờ quay lại.**
`policy set` và admin API nói rõ điều này trong phản hồi (`notes`).

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
| `presence.catchUpEvery` | `off` | bắt kịp định kỳ khi đang tạm nghỉ (vd. `6h`) |
| `presence.maxLeases`, `presence.leaseTtl`, `presence.leaseTtlMax` | `64`, `90s`, `600s` | lease của CRM cho mỗi tài khoản |
| `presence.waitHoldsSocket` | `true` | một `zalo_wait_for_message` / `/events/wait` đang chờ giữ socket (một gói có thể tắt; thời gian giữ được tính) |
| `presence.onKick` | `yield` | chỉ on-demand: khi một phiên khác **của cùng lần đăng nhập** (một bản sao khác của thông tin đăng nhập này, một tab thứ hai của cùng trình duyệt) lấy socket, nhường lại và từ chối mọi yêu cầu cho đến khi người dùng xác nhận `presence resume` (`yield`), hoặc dừng daemon với mã 3 (`exit`) |
| `presence.alwaysOn.maxPerUser` | `1` | chính sách tenant hoặc người dùng: số tài khoản luôn-kết-nối mỗi người dùng |
| `presence.alwaysOn.maxPerTenant` | không | chính sách tenant: số tài khoản luôn-kết-nối mỗi tenant |
| `presence.alwaysOn.onCap` | `demote` | chính sách tenant hoặc người dùng: một lần ghi làm vượt giới hạn thì sao. `demote`: tài khoản luôn-kết-nối cũ nhất chuyển sang on-demand (bên dưới); `refuse`: lần ghi bị từ chối với `409 ALWAYS_ON_CAP` và không gì thay đổi. Hạ giới hạn thì vẫn hạ cấp ở cả hai chế độ |

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

### Giới hạn, quyền truy cập và bí mật cho một console

Các giới hạn chung mà một console (control plane, CRM) đặt cho từng tenant hoặc người dùng; engine không biết gói hay giá.

| Khóa | Đặt ở | Ý nghĩa |
|---|---|---|
| `limits.accountsPerUser` | tenant (mặc định cho mỗi người dùng) hoặc người dùng | số tài khoản tối đa một người dùng được sở hữu: lần ghi thêm một tài khoản nữa bị từ chối (`409 ACCOUNTS_PER_USER_LIMIT`), một lần thêm bằng QR cũng vậy, trước khi đăng nhập bắt đầu. Hạ giới hạn thì không xóa gì |
| `limits.usersPerTenant` | tenant | số người dùng tối đa của một tenant: người dùng mới hoặc chuyển vào khi đã đủ bị từ chối (`409 USERS_PER_TENANT_LIMIT`) |
| `media.store` | mọi nơi | `all` (mặc định), `none` (chỉ lưu chữ) hoặc danh sách loại (`["photo", "voice"]`): bộ tải media duy nhất không tải loại nào khác, dù cho listener, `sync-media`, một lần khôi phục hay `zalo_view_media` (trả `MEDIA_NOT_STORED`); các dòng tin nhắn vẫn được lưu như thường |

Các route của admin API (cùng thông tin xác thực admin; mọi lần từ chối có một `code` ổn định bên cạnh `error`):

- `GET /zalo/admin/policy/users`, `GET /zalo/admin/policy/tenants`: mọi người dùng (`userId`, `tenant`, `accounts`,
  `rev`) và mọi tenant (`tenantId`, `users`, `accounts`, `rev`, `file`). `DELETE /zalo/admin/policy/users/<userId>` và
  `DELETE /zalo/admin/policy/tenants/<tenantId>` xóa tệp, bị từ chối với `409 USER_HAS_ACCOUNTS` hoặc
  `409 TENANT_HAS_MEMBERS` khi còn thành viên (`404 USER_NOT_FOUND` / `TENANT_NOT_FOUND`).
- `/zalo/admin/access/<ownId>`: quyền truy cập và bí mật của tài khoản, trên fleet controller cũng như trên server của
  chính tài khoản. Daemon đang chạy nhận mỗi thay đổi ở yêu cầu kế tiếp.
  - `GET` (tất cả bên dưới cùng lúc, không bao giờ có bí mật hay hash); `GET .../oauth/clients`, `GET .../oauth/grants`,
    `DELETE .../oauth/grants/<grantId>`, `POST .../oauth/revoke-all` `{clientId?}`, `DELETE .../oauth/clients/<clientId>`
    (client đã đăng ký và các grant của nó; client cấu hình sẵn trả `409 CLIENT_CONFIGURED`). Client cấu hình sẵn là
    những client mà daemon của tài khoản phục vụ: client chính lấy từ môi trường của chính nó
    (`ZALO_MCP_OAUTH_CLIENT_ID[_<ownId>]`, kể cả `<env-dir>/<ownId>.env` của fleet) hoặc `mcp-config.json`, và `oauth.clients[]`.
    Mỗi client trong danh sách có `source`: `config`, `dynamic` (tự đăng ký) hoặc `account` (tạo tại đây).
  - `GET|PUT .../oauth/settings` (`{mode}`: `off`, `automatic` hoặc `specific`) -> `{mode, source, approverSet,
    publicUrl}`, cách các ứng dụng AI đăng nhập vào MCP server của tài khoản, được daemon đang chạy áp dụng ở yêu cầu kế
    tiếp (không cần khởi động lại). `off`: mọi route OAuth trả 404 như server chỉ dùng bearer; các grant đã cấp được giữ
    nhưng bị từ chối khi đang tắt, còn khóa API và bearer token vẫn dùng được. `automatic`: bật và công bố đăng ký client
    động (`/register`). `specific`: chỉ biết các client cấu hình sẵn và client tạo tại đây; `/register` trả 404. Mỗi kết
    nối vẫn phải được duyệt bằng mật khẩu người duyệt. `source` là `account` khi đã lưu một chế độ (`oauth-settings.json`
    trong thư mục tài khoản, 0600), ngược lại là `config`: `automatic` khi `oauth.allowDynamicRegistration` /
    `ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION` bật, nếu không thì `specific` khi có client cấu hình sẵn, nếu không thì `off`.
    Bật lên bị từ chối `409 APPROVER_REQUIRED` khi chưa có mật khẩu người duyệt và `409 PUBLIC_URL_REQUIRED` khi chưa có
    `publicUrl` (issuer phải cố định); chế độ khác trả `400 INVALID_OAUTH_MODE`. Các route OAuth có mặt trên mọi server có
    `publicUrl`, nên việc này chạy được cả trên daemon khởi động với OAuth tắt; server không có token `--auth` và không có
    client secret ký token bằng khóa riêng của nó (`oauth-signing-key.json`, 0600). Khi đã lưu một chế độ, kiểm tra bearer
    luôn bật, kể cả `off`.
  - `POST .../oauth/clients` (`{name, clientId?, redirectUris}`: tên 1-60 ký tự, id tùy chọn 3-64 ký tự
    `[A-Za-z0-9._-]`, nếu không có sẽ được tạo, và 1-10 URL callback https) -> `201 {clientId, clientSecret, name,
    redirectUris, createdAt}`: một client bí mật (`client_secret_post` hoặc `client_secret_basic` ở `/token`) mà secret chỉ
    hiện lần này; chỉ giữ SHA-256 của nó. `409 CLIENT_EXISTS` khi id đã dùng, `409 CLIENT_LIMIT` khi quá 50.
    `DELETE .../oauth/clients/<clientId>` xóa nó và các grant của nó.
  - `GET|POST .../api-keys` (`{label, expiresAt?}` -> `201 {keyId, label, createdAt, expiresAt, key}`: khóa, dạng
    `zak_<keyId>_<secret>`, chỉ hiện một lần; chỉ giữ SHA-256 của nó, niêm phong trong `api-keys.json`), `DELETE
    .../api-keys/<keyId>`. Một khóa là bearer cho MCP server của tài khoản bên cạnh `ZALO_MCP_AUTH_TOKEN` (khóa cũ, vẫn
    dùng được); khóa đầu tiên bật kiểm tra bearer cho server chưa có.
  - `GET|PUT .../webhook` (`{url}` hoặc `{url: null}`: khóa chính sách `webhook` của tài khoản), `POST|DELETE
    .../webhook/secret` (xoay: bí mật mới hiện một lần và ký lần gửi kế tiếp, đứng trước `ZALO_WEBHOOK_SECRET` và
    `webhookSecret`; xóa: quay về chúng), `POST .../webhook/test` (một sự kiện `webhook_test` có ký:
    `{delivered, status, signed, ms}`; `409 WEBHOOK_NOT_SET`).
  - `GET|PUT|DELETE .../approver` (`{password}`, ít nhất 8 ký tự, lưu dạng hash scrypt), `GET|DELETE .../cloud-key`
    (có lưu khóa zCloud hay không; xóa nó).
  - Mỗi thay đổi là một dòng nhật ký với tài khoản, một mã hành động (`apiKey.create`, `oauth.grant.revoke`,
    `webhook.secret.rotate`, ...) và id bị tác động, không bao giờ có giá trị.

Fleet controller có thêm `GET /zalo/admin/usage` (dung lượng của mọi tài khoản, cộng theo người dùng và tenant so với
giới hạn, và đĩa) và `GET /zalo/admin/routes` (id tài khoản -> port loopback và đường dẫn `/a/<id>`, các rewrite cho
OAuth discovery, các đường dẫn phải chặn, và với `--domain` là Caddyfile mà `fleet generate --domain` viết) cho một host
agent quản reverse proxy; bản thân controller không sửa cấu hình proxy nào. Một lần thêm bằng QR
(`POST /zalo/admin/accounts/qr`) bị từ chối trước khi đăng nhập bắt đầu với người dùng không tồn tại
(`404 USER_NOT_FOUND`), người dùng đã đủ `limits.accountsPerUser` (`409 ACCOUNTS_PER_USER_LIMIT`) hoặc thêm luôn-kết-nối
vượt một giới hạn kiểu refuse (`409 ALWAYS_ON_CAP`); `accountId` trong thân chỉ một tài khoản người dùng đã sở hữu (đăng
nhập lại), thì được qua.

**Ai chạy on-demand.** `mcp start --http` và `listen --daemon` theo `presence.mode` (mặc định on-demand); MCP stdio và
`listen` chạy tiền cảnh in ra stdout luôn là always-on dù khóa nói gì. Socket đang tạm nghỉ thức dậy khi có một lệnh gọi
công cụ MCP, một `zalo_wait_for_message` / `GET /events/wait`, một lease của CRM (`/zalo/presence/leases`), một yêu cầu
CLI chuyển qua daemon (gửi tệp, một bước `sync`, `mcp wait`) và `presence wake`; sau `idleTimeout` không có gì thì lại tạm
nghỉ. Những gì đến khi đang tạm nghỉ được lấy lại từ hàng đợi offline của Zalo ở lần kết nối kế tiếp, gắn `catchUp: true`
(cả webhook): thời gian thực là gói always-on. `--no-self-heal` cùng on-demand bị từ chối khi khởi động (bắt kịp là cách
khoảng tạm nghỉ quay lại). Thay đổi chính sách của một khóa `presence.*` áp dụng ngay.

**Công cụ khi đang thức.** Mỗi công cụ MCP có một lớp: `none` (gửi, tra cứu) chạy ngay bên cạnh lần thức; `fresh` (đọc
cache: `zalo_get_messages`, `zalo_get_history`, `zalo_search_messages`, `zalo_list_conversations`, `zalo_coverage`) chờ
tối đa `warmWait` cho kết nối và lần bắt kịp, rồi trả lời kèm khối `presence: {state, catchUp, coveredUntil}`; `socket`
(`zalo_sync`, `zalo_forward_message`, gửi kèm tệp hoặc video) chờ tối đa `warmWait`, rồi báo lỗi có thể thử lại `WARMING`
(`retryAfterSec`); `wait` (`zalo_wait_for_message`) giữ socket trong lúc chờ (`waitHoldsSocket`). Một yêu cầu CLI chuyển
qua daemon cư xử như lớp `socket`. Daemon không bao giờ tạm nghỉ giữa chừng một bước sync đang chạy.

**Đã nhường (yielded) và đã bị đăng xuất (signed out).** Zalo chỉ giữ một lần đăng nhập web cho mỗi tài khoản: đăng nhập
QR trên bất kỳ trình duyệt nào sẽ thu hồi lần trước, còn điện thoại và ứng dụng Zalo trên máy tính chạy song song với máy chủ được. **Đừng mở tài khoản trên
trình duyệt khi đã có máy chủ giữ nó**; hãy đọc và trả lời trên điện thoại hoặc ứng dụng trên máy tính. Có hai trạng thái không tự hồi phục, và trong cả hai daemon **vẫn chạy** (trạng thái, admin API, thêm lại bằng QR vẫn hoạt
động) và **từ chối** mọi lệnh gọi công cụ, lease, lệnh chờ và yêu cầu CLI:

| Trạng thái (`account_state`) | Khi nào | Từ chối | Kết thúc bằng |
|---|---|---|---|
| `yielded` | on-demand, `onKick: "yield"`: một phiên khác của cùng lần đăng nhập lấy socket (đóng 3000) | `YIELDED` | người dùng đóng phiên đó và xác nhận: `zalo-agent presence resume --yes`, `POST /zalo/admin/presence/resume`, `POST /zalo/admin/accounts/<ownId>/presence/resume` của fleet controller, hoặc MCP `zalo_profile` `presence_resume` (theo confirmMode) |
| `signed_out` (presence `signed-out`) | mọi chế độ: Zalo từ chối lần đăng nhập đã lưu ba lần (một trình duyệt khác đăng nhập Zalo bằng QR) | `SIGNED_OUT` | thêm lại tài khoản bằng QR (`zalo-agent login`, hoặc thêm bằng QR qua fleet controller, sẽ khởi động lại daemon) |

Cả hai được gửi tới webhook, bộ đệm MCP, `/status` (`socket.state` `yielded` / `signed-out`, kèm cảnh báo), `/metrics`
và `presence status`. Trước đây daemon bị đăng xuất dừng với mã 4; `ZALO_EXIT_ON_SIGNED_OUT=1` giữ cách dừng đó (unit
systemd với `RestartPreventExitStatus=3 4` vẫn giữ unit ở trạng thái dừng). Always-on vẫn dừng với mã 3 khi bị đá.

**Nhiều tài khoản thức cùng lúc.** `ZALO_CONNECT_SLOTS` (mặc định `0`, không giới hạn; mẫu fleet `16`) giới hạn số daemon
trên máy đang thức cùng lúc: một lần thức giữ một suất (`<CONFIG_DIR>/connect-slots/`) cho đến khi lần bắt kịp đầu tiên
xong, tối đa 60 giây; `ZALO_CONNECT_SLOT_WAIT` (giây, mặc định `120`) là thời gian một lần thức chờ suất trước khi cứ
tiếp tục. Cả hai có dạng `_<ownId>`. `/status` và `/metrics` có `lastWakeMs` / `lastCatchUpMs`
(`zalo_presence_last_wake_seconds`, `zalo_presence_last_catch_up_seconds`) và thời gian kết nối được tính.

### Nhiều agent dùng chung một tài khoản (`routing`)

Nhiều agent có thể dùng cùng lúc máy chủ MCP của một tài khoản (trợ lý chạy sẵn, một phiên Claude Code, một connector
của ứng dụng Claude). Khối `routing` đặt tên cho chúng, để máy chủ biết mỗi lời gọi đến từ agent nào, thêm **dấu** của
agent vào đầu những gì nó gửi, và ghi lại agent nào đã gửi tin nào. Đây là phần đầu của Message Router (Phân luồng phản
hồi); chưa có gì được phân luồng hay bị từ chối, và mọi người gọi vẫn thấy mọi tin nhắn.

```json
"routing": {
  "marks": "shown",
  "presenceWindow": "90s",
  "agents": [
    {"slug": "dev", "name": "Dev", "credential": "apikey:0123456789ab"},
    {"slug": "ai", "name": "AI", "kind": "companion", "credential": "apikey:ba9876543210", "mark": "🤖 AI:"},
    {"slug": "claude", "name": "Claude", "credential": "oauth:claude-app", "markDisplay": "owner"}
  ]
}
```

- **`credential`** gắn agent với một thông tin xác thực máy chủ vốn đã kiểm tra: `apikey:<keyId>` (một API key có tên;
  API `access` hoặc `mcp agents` liệt kê các id), `oauth:<clientId>` hoặc `oauth:<clientId>/<grantId>` (một connector,
  hoặc một lần cấp quyền của nó), `legacy` (token triển khai `--auth`), `open` (máy chủ không đòi token), `stdio` hoặc
  `stdio:<tên>` (máy chủ stdio cục bộ chạy với `ZALO_MCP_AGENT=<tên>`). Agent không bao giờ là cái tên người gọi tự gõ;
  `consumer` của tool chỉ là tên phụ (một nhãn, không phải ranh giới).
- **`mark`** (mặc định `🤖 <name>:`) được thêm vào đầu mọi văn bản và chú thích agent gửi bằng `zalo_send_message`, trừ
  khi văn bản đã bắt đầu bằng nó. **`marks`** (`shown`, mặc định, hoặc `hidden`) là thiết lập của tài khoản;
  **`markDisplay`** của agent ghi đè nó: `inherit` (mặc định), `everywhere`, `owner` (chỉ trong My Documents) hoặc
  `none`.
- **`delivery`**: `live` (mặc định) hoặc `onDemand` (mặc định cho connector OAuth): agent theo nhu cầu lâu không thấy
  hiện `onDemand`, không bao giờ là offline. **`enabled`**: `false` hiện agent là `disabled`.
- **`presenceWindow`** (mặc định `90s`, tối thiểu `10s`): agent được thấy gần đây như vậy, hoặc đang mở
  `zalo_wait_for_message`, là `listening`; `zalo_inbox` `status` đặt `away`.
- **Ai gửi gì** được giữ niêm phong trong `accounts/<ownId>/sent-by.json` (id và tên agent, không có nội dung; 30 ngày,
  5.000 lần gửi mới nhất). `zalo_get_history` và `zalo_search_messages` trả `sentBy: {agent, name, sub}` cho tin của
  chính tài khoản. Trạng thái hiện diện được ghi vào `accounts/<ownId>/agents-presence.json` (tên agent và thời gian).
- `routing.agents`, `routing.marks` và `routing.presenceWindow` trong policy đang chạy thắng tệp và đổi không cần khởi
  động lại (`routing.agents` chỉ trong policy riêng của tài khoản). Xem chúng bằng `zalo-agent mcp agents`, API admin
  `GET /access/<ownId>/agents`, hoặc, với vai trò agent, `zalo_inbox`.

**Phân luồng (giai đoạn 3-6).** Với `routing.enabled: true` mỗi tin đến có đúng một người xử lý, do engine quyết định
một lần (src/core/message-router.js) và gắn vào tin dưới dạng `route: {to, by, ruleId, observers, ownership}` (cả trong
webhook). Thứ tự: **tạm dừng khi chủ trả lời** (chủ tài khoản tự gửi từ điện thoại, PC hoặc web thì các agent dừng ở
cuộc trò chuyện đó trong `humanPause`, mặc định 15 phút), **lệnh gọi** (`@dev` hoặc từ của một luồng, từ chủ, ở đầu tin;
`#hashtag` ở bất kỳ đâu, từ bất kỳ ai nếu luồng cho phép; lệnh gọi được bỏ khỏi `text` và giữ trong `rawText`), **tập
trung** (sau một lệnh gọi sticky, các tin tiếp theo của chủ ở lại với agent đó tới `@end` hoặc `stickyTtl`), **trả lời
theo tin đã gửi** (trả lời một tin của agent thì quay lại agent đó, `affinityTtl`), **nhận việc** đang mở, rồi bảng
**luồng** (khớp đầu tiên: `threads`, `threadType`, `myDocuments`, `senders`, nhãn Zalo `labels`, `kinds`, khung giờ
`window`, `mentionsAccount` cho tin nhóm nhắc tới tài khoản hoặc @All), rồi **mặc định**. Nhận việc, tạm dừng và tập trung được giữ qua khởi động lại (niêm phong trong `routing-state.json`). Agent trực tiếp vắng lâu hơn `fallbackAfter` thì chuyển theo chuỗi `fallback` của luồng (agent
khác, `human` kèm thông báo trong My Documents, hoặc `{autoReply: text}`). Nhận việc, tạm dừng, trả lời theo tin, tập
trung và dự phòng cần `routing.claims: true`.

- Mỗi agent đọc tin của mình: `zalo_get_messages` và `zalo_wait_for_message` nhận `view: "mine"` (mặc định khi bật phân
  luồng) hoặc `"all"` (mỗi tin có `forMe`). Kết nối chưa gắn agent không nhận tin mới.
- **Chặn gửi:** agent gửi vào cuộc trò chuyện chủ đang trả lời bị từ chối với `HUMAN_ACTIVE`; vào cuộc agent khác đang
  giữ (hoặc trích tin agent khác sở hữu) với `CLAIMED`.
- **Nhân viên** `staff:<id>` với `channels` `console` (trả lời trong console) và/hoặc `zalo` (tin được chuyển tới Zalo của
  nhân viên; câu trả lời của họ được gửi lại cho khách từ tài khoản này kèm dấu của họ).
- **`@agents`** chủ gõ ở bất kỳ cuộc trò chuyện nào được trả lời trong My Documents của chủ.
- **Riêng tư theo agent** (`routing.isolation: true`): agent chỉ đọc các cuộc được phân cho nó hoặc nó đang giữ
  (`NOT_ROUTED` cho phần còn lại) và không gửi ra ngoài.
- `zalo_inbox` có thêm `claim`, `release`, `handoff`, `claims`, `route_test`; API admin trả lời cùng phép thử ở
  `POST /access/<ownId>/route-test`.
- **Bảng điều khiển xem bộ phân luồng đang chạy** (`POST /access/<ownId>/routing`, `{action, ...}`, do daemon của tài
  khoản trả lời; 409 `DAEMON_NOT_RUNNING` khi không có daemon): `events` (quyết định phân luồng, giữ cuộc, chuyển giao,
  chủ tạm dừng agent, lần gửi bị chặn; chỉ có id, không bao giờ có nội dung tin; 1.000 sự kiện mới nhất từ khi daemon
  chạy), `claims`, `release`, `assign` (cho một agent, một nhân viên hoặc `human`), `human` / `endHuman` (bắt đầu hoặc
  kết thúc lúc chủ tự trả lời), và hộp thư của nhân viên trả lời trong bảng điều khiển: `inbox`, `thread` (tin đã lưu của
  cuộc trò chuyện), `claim`, `unclaim`, `send` (gửi từ tài khoản này kèm dấu của nhân viên). Nhân viên chỉ thấy các cuộc
  được phân cho mình hoặc mình đang giữ (`NOT_ROUTED`). Fleet controller phát mỗi sự kiện mới trên
  `GET /zalo/admin/events` dưới tên `routing` (không gửi qua webhook admin).

### Gia hạn phiên đăng nhập đã lưu (`session.renew`)

Một lần đăng nhập QR kéo dài khoảng 90 ngày và Zalo không bao giờ tự gia hạn: chỉ một lần quét QR mới bằng điện thoại
của tài khoản mới gia hạn được. Một máy chủ `mcp start --http` có địa chỉ công khai (`publicUrl`, `--public-url`,
`ZALO_MCP_PUBLIC_URL[_<ownId>]`) tự lo việc này. Trong vòng `daysBefore` ngày trước khi hết hạn, nó mở một **liên kết
gia hạn**, trang đăng nhập QR dùng một lần tại `<publicUrl>/zalo/qr/<token>` trên chính cổng HTTP của nó, và đưa liên
kết vào các sự kiện `session_expiring` dưới tên `renewUrl` (kèm `renewExpiresAt`). Một liên kết sống `linkTtl`; khi hết,
một liên kết mới được mở và thêm một `session_expiring` mang nó được gửi, mặc định mỗi ngày, cho đến khi đăng nhập được
gia hạn. Sự kiện mốc 14 ngày vẫn được gửi, không kèm liên kết.

| Khóa (`session.renew.*`) | Mặc định | Ý nghĩa |
|---|---|---|
| `enabled` | `true` | `false` (hoặc `ZALO_SESSION_RENEW[_<ownId>]=off`): không mở liên kết; các sự kiện giữ như cũ |
| `daysBefore` | `7` | mở liên kết từ bấy nhiêu ngày trước khi hết hạn (1-14; `ZALO_SESSION_RENEW_DAYS[_<ownId>]`), và cả sau khi đã hết hạn |
| `linkTtl` | `"24h"` | thời gian sống của một liên kết (10m-7d) |

Các lớp: `mcp-config.json` `session.renew` < `accounts.<ownId>.session.renew` < biến môi trường < chính sách chạy
(`session.renew.*`, áp dụng ngay). `zalo-agent session renew [--account <id>] [--fresh]` mở một liên kết bằng tay.
Không có địa chỉ công khai thì không liên kết nào đến được điện thoại: sự kiện mang `renewHint` thay vào đó. `listen`
không phục vụ trang nào nên không mở liên kết.

Trang xin Zalo một mã mới khi được mở, cho biết nó gia hạn tài khoản nào (tên và id), và chỉ cần quét rồi xác nhận
trên điện thoại của tài khoản đó. Lần đăng nhập giữ device id đã lưu của tài khoản, nên hàng đợi offline của Zalo vẫn
tiếp tục. Một lần quét bằng **tài khoản khác** bị từ chối trước khi phiên của nó được mở, và trang nói rõ điều đó. Khi
thành công, máy chủ lưu lần đăng nhập mới, được niêm phong bằng keyring của tài khoản, chuyển sang nó **ngay tại chỗ**
(không khởi động lại; daemon đang `signed_out` hoặc `yielded` quay lại, daemon đang tạm nghỉ giữ nó cho lần thức kế
tiếp) và gửi `session_renewed` `{event, accountId, expiresAt, daysLeft, deviceKept, at}`; liên kết khi đó đã dùng xong.
Token là 128 bit ngẫu nhiên chỉ nằm trong bộ nhớ (khởi động lại thì mở liên kết mới, liên kết cũ chết) và không bao giờ
được ghi log; trang có `no-store`, `nosniff`, `no-referrer`, không cho nhúng khung, CSP theo nonce, tối đa 120 yêu cầu
mỗi phút (sau đó 429) và 12 lần đăng nhập QR mỗi giờ. `fleet status` hiện `renewing` ở cột LOGIN ENDS khi có liên kết
đang mở.

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
| `ZALO_OA_DIR` |  | thư mục credentials của các API chính thức. Mặc định `~/.zalo-agent` (không có `-cli`): `oa-credentials.json` (đăng nhập OA, mỗi `--oa-id` một bản ghi, `zbs` dùng chung) và `social-credentials.json` (đăng nhập Social API, mỗi `--profile` một bản ghi), cả hai ở quyền `0600` | `--oa-dir` |  |
| `ZALO_OA_APP_SECRET`, `ZALO_SOCIAL_APP_SECRET` |  | app secret cho `oa login` / `oa init`, và cho `social setup` / `social login`, khi không truyền `--secret` (cờ hiện ra trong danh sách tiến trình). Không có cả hai thì hỏi tại một dấu nhắc không hiện ký tự trong terminal | `--secret` |  |
| `ZALO_ACCOUNT` |  | tài khoản cho lệnh chạy một lần | `--account` |  |
| `ZALO_ENV_FILE` |  | thêm một `.env` để nạp | `--env-file` |  |
| `ZALO_MCP_HTTP_PORT` | có | phục vụ HTTP/HTTPS trên port này thay vì stdio | `--http` | `httpPort` |
| `ZALO_MCP_HOST` | có | địa chỉ bind. Mặc định `127.0.0.1` | `--host` | `host` |
| `ZALO_MCP_AUTH_TOKEN` | có | bearer token cho `/mcp` và `/events/wait` | `--auth` (hiện trong `ps`; nên dùng biến) |  |
| `ZALO_MCP_TLS_CERT`, `ZALO_MCP_TLS_KEY` | có | phục vụ HTTPS; có cả hai hoặc không có | `--cert`, `--key` | `tls.cert`, `tls.key` |
| `ZALO_MCP_OAUTH_CLIENT_ID`, `ZALO_MCP_OAUTH_CLIENT_SECRET` | có | OAuth client chính (§3.4). Đặt secret là bật OAuth; secret chỉ xác thực client đó tại `/token` và không phải bearer token (từ 3.0.1). `--auth` không bao giờ là client secret | `--client-id`, `--client-secret` | `oauth.clientId`, `oauth.clientSecret` |
| `ZALO_MCP_OAUTH_REDIRECT_URIS` | có | các callback URL của client chính, ngăn bởi dấu phẩy (`https://claude.ai/api/mcp/auth_callback`). So khớp chính xác, trừ URL `http://127.0.0.1`, `[::1]` hoặc `localhost` khớp với mọi port; chỉ `https`, hoặc `http` trên loopback | | `oauth.redirectUris` |
| `ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION` | có | `true` mở `/register` (RFC 7591) và bật OAuth: client tự đăng ký (Claude Code, MCP Inspector). Mặc định `false` | | `oauth.allowDynamicRegistration` |
| `ZALO_MCP_OAUTH_SECRETS_AS_BEARER` | có | `true` giữ hành vi 3.0.0: client secret đã cấu hình cũng dùng được làm bearer token cho `/mcp`. Mặc định `false` | | `oauth.secretsAsBearer` |
| `ZALO_MCP_PUBLIC_URL` | có | địa chỉ công khai duy nhất của server khi đứng sau reverse proxy hoặc TLS (`https://zalo.example.com`, có thể kèm base path như `https://zalo.example.com/a/<ownId>`): endpoint MCP, OAuth issuer, và link tới trang nhập bảo mật dùng một lần (`/zalo/secure/<token>`) và trang đăng nhập QR (`/zalo/qr/<token>`). Phải là `https`, trừ `http` trên `localhost`, `127.0.0.1` hoặc `[::1]`; không có query hay fragment; dấu `/` cuối bị bỏ. Giá trị sai quy tắc làm server từ chối khởi động. Không đặt: link dùng địa chỉ của chính server và chỉ metadata OAuth còn suy từ header `Host` của request | `--public-url` (`mcp start`, `login`, `account login`) | `publicUrl` |
| `ZALO_MCP_ISSUER_URL` | có | tên cũ (deprecated) của `ZALO_MCP_PUBLIC_URL`, vẫn được đọc sau mọi nguồn `publicUrl`, kèm một ghi chú mỗi tiến trình | `--issuer-url` (deprecated) | `oauth.issuerUrl` (deprecated) |
| `ZALO_WEBHOOK_URL` | có | POST mỗi tin nhắn đến tới đây | `-w`, `--webhook` | `webhook` |
| `ZALO_WEBHOOK_SECRET` | có | ký webhook (`Authorization: Bearer` + `X-Zalo-Signature: sha256=…`) | `--webhook-secret` (hiện trong `ps`) | `webhookSecret` |
| `ZALO_WEBHOOK_BATCH_SIZE` | có | số sự kiện mỗi POST webhook, 1–100. Mặc định 1: mỗi sự kiện một POST | | `webhookBatchSize` |
| `ZALO_WEBHOOK_MAX_AGE` | có | thời gian thử lại một sự kiện chưa giao được trước khi chuyển vào dead-letter (`6h`, `24h`; tối thiểu `1m`). Mặc định `24h` | | `webhookMaxAge` |
| `ZALO_MCP_CONFIRM_MODE` | có | ai xác nhận một thao tác không hoàn tác được của tool (thu hồi, xóa, rời nhóm, …): `agent` (mặc định; bên gọi gửi `confirm: true`), `human` (server tự hỏi người dùng: qua MCP form elicitation khi chạy stdio, còn lại qua một trang duyệt dùng một lần có link trong kết quả, dùng được cả qua HTTP) hoặc `off` (không hỏi; `zalo_write` vẫn cần `confirm`) | | `confirmMode` |
| `ZALO_MCP_HIDDEN_CHATS` | có | MCP server cho thấy gì về các cuộc trò chuyện ẩn: `exclude` (mặc định: bỏ khỏi mọi danh sách, tìm kiếm, lịch sử và sự kiện), `contentless` (bỏ khỏi danh sách; sự kiện trong đó chỉ đến dưới dạng `{event, hidden: true}`, không có thread id hay nội dung) hoặc `include` (hiện như mọi cuộc khác: giao chúng cho agent) | | `hiddenChats` |
| `ZALO_MCP_OWN_MY_DOCUMENTS` | có | `true` chuyển tin nhắn chính tài khoản gửi trong My Documents của mình (Cloud của tôi, `me`) tới agent: `zalo_get_messages`, `zalo_wait_for_message`, notifier và webhook, mỗi tin có `isSelf: true`, để chủ tài khoản trò chuyện với trợ lý ở đó. Mọi tin tự gửi khác vẫn bị bỏ, và tin trả lời của chính agent qua `zalo_send_message` không quay lại agent. Mặc định `false`: không tin tự gửi nào tới agent | | `ownMyDocuments` |
| `ZALO_MCP_AGENT` | không | Tên người gọi của máy chủ stdio cục bộ: là `stdio:<tên>` cho khối `routing` (chữ thường, số, `-`). Chưa đặt: `stdio` | | |
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
| `ZALO_SYNC_NAME_REFRESH_MAX` |  | giới hạn tùy chọn số tên DM không phải bạn bè mà một lần restore tra. Không đặt (mặc định) = tra tất cả, mỗi yêu cầu 500 id như Zalo; khi bị từ chối mã 221 thì dừng làm mới trong lần đó và tạm gác các id bị từ chối một giờ (hoặc đến `nextTs` của máy chủ) | | |
| `ZALO_SEND_FORMAT` |  | `markdown` hoặc `plain`: định dạng mặc định khi gửi tin chữ. Không đặt: `msg send` gửi nguyên văn (người gõ), `zalo_send_message` chuyển Markdown (mô hình viết). `--md`/`--markdown` hoặc `format` của tool, khi có, sẽ thắng | | |
| `ZALO_START_JITTER` | có | chờ một khoảng ngẫu nhiên tối đa chừng này giây (0–600, mặc định 0) trước khi đăng nhập, để một đội daemon khởi động lại cùng lúc không đăng nhập cùng lúc | | |
| `ZALO_CONNECT_SLOTS` | có | tối đa chừng này daemon trên máy cùng đánh thức socket đang tạm nghỉ một lúc (hiện diện on-demand; 0–64, mặc định 0, không giới hạn; mẫu fleet 16): một lần thức giữ suất cho đến khi lần bắt kịp đầu tiên xong, tối đa 60 giây. `ZALO_CONNECT_SLOT_WAIT` (giây, mặc định 120) là thời gian chờ tối đa trước khi cứ tiếp tục | | |
| `ZALO_EXIT_ON_SIGNED_OUT` | có | `1`: lần đăng nhập Zalo liên tục từ chối sẽ dừng daemon với mã 4, như trước 3.0 (`ZALO_EXIT_ON_SIGNED_OUT_<ownId>` cho riêng một tài khoản). Mặc định: daemon vẫn chạy ở trạng thái `signed_out` và từ chối yêu cầu cho đến khi tài khoản được thêm lại bằng QR | | |
| `ZALO_SESSION_RENEW`, `ZALO_SESSION_RENEW_DAYS` | có | `off` tắt liên kết gia hạn; số ngày trước khi đăng nhập hết hạn thì mở liên kết (1-14, mặc định 7). Nằm giữa các tệp và chính sách chạy (xem [gia hạn phiên đăng nhập đã lưu](#gia-hạn-phiên-đăng-nhập-đã-lưu-sessionrenew)) | | `session.renew.enabled`, `session.renew.daysBefore` |
| `ZALO_PRESENCE_MODE`, `ZALO_PRESENCE_IDLE_TIMEOUT` | có | `on-demand` hoặc `always-on`; thời gian rảnh trước khi socket tạm đóng (`5m`, tối thiểu `30s`). Nằm giữa các tệp và chính sách chạy (xem [hiện diện theo nhu cầu](#người-dùng-giới-hạn-luôn-kết-nối-và-hiện-diện-theo-nhu-cầu)) | | `presence.mode`, `presence.idleTimeout` |
| `ZALO_LOGIN_SLOTS` | có | tối đa chừng này daemon trên máy cùng đăng nhập và nạp danh sách một lúc (0–64; mặc định 0, không giới hạn); phần còn lại chờ một slot. `ZALO_LOGIN_SLOT_WAIT` (giây, mặc định 900) là thời gian chờ tối đa trước khi cứ tiếp tục | | |
| `ZALO_FLEET_CONTROLLER_PORT` |  | port mà `fleet serve` dùng khi không có `--http`. Mặc định `3899` | `fleet serve --http` | |
| `ZALO_FLEET_DOMAIN` |  | tên miền proxy của `fleet generate --domain`: tài khoản thêm bằng QR qua `fleet serve` được ghi `ZALO_MCP_PUBLIC_URL=https://<host>/a/<ownId>` vào file env của nó | `fleet serve --domain` | |
| `ZALO_FLEET_QR_FLOWS` |  | số lần đăng nhập QR fleet controller chạy cùng lúc (vượt thì `429`). Mặc định `4` | | |
| `ZALO_FLEET_JOBS` |  | số tác vụ tài khoản (đồng bộ, tải tệp đính kèm, dọn dữ liệu) fleet controller chạy cùng lúc (vượt thì `429 JOBS_BUSY`). Mặc định `2` | | |
| `ZALO_FLEET_SUPERVISOR` |  | `systemd` hoặc `spawn`: ai khởi động, dừng và khởi động lại từng tài khoản cho `fleet start\|stop\|restart` và `fleet serve`. Không đặt: systemd với tài khoản có unit `zalo-mcp@<ownId>` đã nạp và đang chạy, lỗi hoặc được bật, còn lại thì tự spawn daemon. `common.env` do `fleet generate` tạo đặt `systemd` | | |
| `ZALO_FLEET_WEBHOOK`, `ZALO_FLEET_WEBHOOK_SECRET` |  | webhook admin của fleet controller: mọi sự kiện `account_state` và sự kiện thêm bằng QR được POST dạng JSON, ký giống webhook của daemon (`Authorization: Bearer` + `X-Zalo-Signature`) khi có secret | | |
| `ZALO_LOG_LEVEL` | có | `error`, `warn`, `info` (mặc định) hoặc `debug` (thêm một dòng cho mỗi HTTP request và mỗi tin nhắn) | `--log-level` | |
| `ZALO_LOG_FORMAT` | có | `text` (mặc định, mỗi dòng có thời gian) hoặc `json` (mỗi dòng một đối tượng) | | |
| `ZALO_LOG_MAX_SIZE`, `ZALO_LOG_KEEP` | có | xoay `daemon.log` khi đạt dung lượng này (mặc định `50m`, tối thiểu `4k`) và giữ chừng này file (mặc định 3) | | |
| `ZALO_AGENT_NO_UPDATE_CHECK` |  | giá trị bất kỳ: không bao giờ chạy kiểm tra cập nhật `npm view` | | |
| `ZALO_API_VERSION` |  | phiên bản giao thức báo cho Zalo. Mặc định 695 | | |
| `ZALO_QR_FLOW` |  | cách `login` đăng nhập bằng QR: `official` (mặc định: đúng trình tự đăng nhập của Zalo, không gọi `verify-client`, `continue=https://chat.zalo.me/`, chuyển hướng qua `jr.zaloapp.com` và `jr.chat.zalo.me`, kèm mã QR thứ hai mà tài khoản có thiết bị tin cậy phải quét, khiến client này thành một thiết bị tin cậy đi kèm), là cách đăng nhập QR duy nhất. `legacy` đã bị bỏ ở 3.0.0; nó và mọi giá trị khác bị từ chối trước khi liên hệ Zalo | | |
| `ZALO_NET_PROBE` |  | thứ daemon hỏi để biết mạng còn hoạt động hay không khi socket đang đứt (mỗi 10 giây): một URL, mặc định là một trang nhẹ của công cụ tìm kiếm toàn cầu, hoặc `off` để coi như mạng luôn hoạt động và không liên hệ nơi nào ngoài Zalo | | |
| `ZALO_STORAGE_PROVIDER` |  | bộ cung cấp khóa bảo vệ các file đã lưu trên đĩa: `dpapi`, `keychain`, `secret-service`, `systemd-creds`, `kms`, `passphrase`, `env`. Mặc định theo nền tảng; server Linux không có desktop keyring phải đặt. Xem [security.vi.md](security.vi.md) | | |
| `ZALO_RETENTION_MESSAGES`, `ZALO_RETENTION_MEDIA` | có | `keep` hoặc `<N>d`: quy tắc theo tuổi của bộ nhớ đệm, đè lên `retention.messages` / `retention.media` của `storage.json` (xem mục Hạn mức dung lượng và thời gian lưu giữ) | | |
| `ZALO_STORAGE_MIN_FREE` |  | dung lượng trống mà một lần tải chừa lại trên ổ đĩa (mặc định `2GB`, `0` để tắt), đè lên `quota.minFree` của chính sách chạy và của `storage.json` (xem mục Chừa chỗ trước khi tải) | | |
| `ZALO_GROUPS_ON_LEAVE` | có | `purge` (mặc định) hoặc `keep`: lịch sử cục bộ của nhóm đã rời, bị xóa, bị chặn hoặc bị giải tán sẽ ra sao, đè lên `groups.onLeave` của `storage.json` (xem mục Rời nhóm) | | |
| `ZALO_STORAGE_DKEY_LAYER` |  | `1` / `0`: khóa thêm mọi thứ không cần cho việc đăng nhập bằng `dkey` của lần đăng nhập. Mặc định tắt | | |
| `ZALO_DPAPI_SCOPE`, `ZALO_SYSTEMD_CREDS_WITH_KEY`, `ZALO_KMS_BACKEND`, `ZALO_KMS_KEY`, `ZALO_STORAGE_PASSPHRASE_FILE`, `ZALO_STORAGE_KEY` |  | tùy chọn của bộ cung cấp khóa đã chọn (`ZALO_STORAGE_KEY`: khóa của bộ `env`, yếu theo thiết kế). Backend KMS `vault` còn đọc `VAULT_ADDR`, `VAULT_TOKEN` và `VAULT_NAMESPACE` khi `storage.json` không ghi chúng | | |

### API chính thức (`oa`, `zbs`, `social`)

Các API chính thức không có khóa `mcp-config.json` nào; biến môi trường của chúng chỉ có `ZALO_OA_DIR`, các app secret dưới đây và `ZALO_OA_SECRET`. Các thiết lập khác là cờ dòng lệnh, còn đăng nhập là các file trong thư mục `ZALO_OA_DIR` (ở trên, tạo với quyền `0700`), tách khỏi `~/.zalo-agent-cli/` của tài khoản cá nhân.

- `oa login` / `oa init` lưu App ID, secret key và token của OA vào `oa-credentials.json` theo `--oa-id` (mặc định `default`); mọi lệnh gọi OA và ZBS sau đó gửi kèm `appsecret_proof`, tính từ secret key đó, nên sau khi đặt lại secret key của app hãy đăng nhập lại với khóa mới (`oa login` hoặc `oa init`). App secret lấy từ `--secret`, nếu không thì biến môi trường `ZALO_OA_APP_SECRET`, nếu không nữa thì hỏi tại một dấu nhắc không hiện ký tự (khi chạy trong terminal): biến môi trường hoặc dấu nhắc giữ nó khỏi danh sách tiến trình và lịch sử shell.
- `oa login` và `social login` chờ callback 5 phút (`--timeout <giây>`, từ 10 đến 3600). Chỉ câu trả lời cho đúng lần đăng nhập này mới kết thúc nó: request mang `state` khác, hoặc không có `state` khi bắt buộc, hoặc không có code, nhận `400` và lần đăng nhập vẫn tiếp tục chờ. `social login` bắt buộc callback có `state`; `oa login` vẫn nhận callback không có `state`, vì ví dụ trong tài liệu OA của Zalo không có. Một request lấy token bỏ cuộc sau 30 giây.
- `social setup` và `social login` đọc app secret từ `--secret`, nếu không thì `ZALO_SOCIAL_APP_SECRET`, nếu không nữa thì (chỉ `social setup`) hỏi tại dấu nhắc không hiện ký tự; `social login` sau đó dùng secret đã lưu.
- `social login` lưu một đăng nhập người dùng Social API vào `social-credentials.json` theo `--profile` (mặc định `default`); `--dpop` gắn token với một cặp khóa (mỗi proof mang một `jti` ngẫu nhiên).
- `oa listen` phục vụ webhook OA và ZBS: `--port` (mặc định 3000; engine không đọc `ZALO_OA_WEBHOOK_PORT`), `--path` (mặc định `/webhook`), `--secret <OA secret key>` hoặc, tốt hơn cho một dịch vụ, biến môi trường `ZALO_OA_SECRET` (cờ hiện ra trong danh sách tiến trình) để kiểm tra `X-ZEvent-Signature` (`--no-verify` bỏ qua bước này), `--app-id` cho sự kiện không có `app_id` trong body (mặc định: App ID đã lưu), và xác thực domain bằng `--verify-file <file.html>` (phục vụ nguyên văn theo tên file) hoặc `--verify-meta '<meta …>'` (chèn vào phần head của trang chủ). Chạy `oa init` không kèm cờ sẽ hỏi các khóa một cách tương tác, nên chúng không nằm trong lịch sử shell.

### Các khóa của `mcp-config.json`

| Khóa | Mặc định | Ý nghĩa |
|---|---|---|
| `watchThreads` | `["dm:*", "group:*"]` | hội thoại nào được đưa vào bộ đệm: `dm:*`, `group:*`, `dm:<id>`, `group:<id>` |
| `triggerKeywords` | `["@bot"]` | từ khóa đánh dấu tin cần chú ý |
| `limits.autoDigestThreshold` | 50 | số tin chưa đọc vượt mức này thì tool trả bản tóm tắt |
| `limits.bufferMaxAge` | `"2h"` | tin nằm trong bộ đệm live bao lâu |
| `limits.bufferMaxSize` | 500 | số tin giữ trong bộ đệm live **cho mỗi thread** |
| `media.downloadDir` | `null` | thư mục gốc media của máy chủ này (file trong đó được niêm phong bằng khóa media của tài khoản, như thư mục mặc định) |
| `media.autoOpen` | không đặt (= `true` khi stdio, `false` khi HTTP) | `zalo_view_media` mở file bằng trình xem của máy này (qua tempfile). Qua HTTP thì không bao giờ mở |
| `media.deliver` | photo, gif, doodle, sticker, voice, audio `inline`; video, file `link` | theo từng loại: `inline`, `link` hoặc `tempfile` (xem `ZALO_MCP_MEDIA_DELIVER`). Inline lớn hơn `inlineMaxBytes`, hoặc kiểu client không hiển thị được, chuyển thành link. Kiểu tệp được đọc từ chính các byte của tệp, không theo kiểu máy chủ tệp của Zalo khai báo: ảnh gửi inline khi là JPEG, PNG, GIF hoặc WebP (ảnh JPEG XL gửi inline bằng bản JPEG mà Zalo phục vụ, hoặc đi dạng link khi không có bản đó; HEIC/HEIF và AVIF đi dạng link), âm thanh khi là MP3, WAV, AAC, MP4, Ogg, WebM hoặc FLAC (AMR đi dạng link); tệp mà byte không cho biết kiểu đi dạng link; tempfile cho client ở máy khác chuyển thành link |
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
| `oauth.clientId`, `.clientSecret`, `.redirectUris` | `null`, `null`, `[]` | OAuth client chính (§3.4 "OAuth cho connector từ xa"). Có secret thì là client bảo mật (confidential); không secret mà có `redirectUris` thì là client công khai (chỉ PKCE). Cả hai đều bật OAuth |
| `oauth.clients[]` | `[]` | thêm OAuth client: mỗi mục `{clientId, clientSecret?, redirectUris?}` |
| `oauth.allowDynamicRegistration` | chưa đặt (= `false`) | xem `ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION` |
| `oauth.secretsAsBearer` | chưa đặt (= `false`) | xem `ZALO_MCP_OAUTH_SECRETS_AS_BEARER` |
| `oauth.accessTokenTtl`, `.refreshTokenTtl` | chưa đặt (= `1h`, `30d`) | thời hạn token OAuth; của refresh token là trượt (mỗi lần refresh tính lại từ đầu). Tối thiểu `1m` |
| `oauth.issuerUrl` | `null` | tên cũ (deprecated) của `publicUrl`, vẫn được đọc khi không nguồn `publicUrl` nào được đặt |
| `confirmMode` | chưa đặt (= `agent`) | `agent`, `human` hoặc `off`: ai xác nhận một thao tác không hoàn tác được của tool. Đặt `agent` cho AI agent; `human` để server tự hỏi người dùng |
| `hiddenChats` | chưa đặt (= `exclude`) | `exclude`, `contentless` hoặc `include`: agent thấy gì về trò chuyện ẩn (xem biến ở trên) |
| `ownMyDocuments` | chưa đặt (= `false`) | `true` chuyển tin của chủ tài khoản trong My Documents của mình tới agent, có `isSelf: true` (xem biến ở trên) |
| `routing` | chưa đặt (không có agent, hiện dấu, `90s`) | `{agents, marks, presenceWindow}`: các agent dùng chung tài khoản, gắn với thông tin xác thực, và dấu của chúng (§1 "Nhiều agent dùng chung một tài khoản") |
| `allowPinArgument` | chưa đặt (= `false`) | `true` cho các tool trò chuyện ẩn nhận PIN qua input; khi đó PIN nằm trong log của client |
| `approval.secret` | không đặt (= `auto`) | `auto`, `pin`, `password` hoặc `none`: trang duyệt hỏi thêm gì ngoài một cú bấm (xem biến ở trên) |
| `approval.deliver` | không đặt (= `result`) | `result`, `webhook` hoặc `both`: link của trang dùng một lần được gửi đi đâu |
| `groupConfirm` | | đã lỗi thời: `false` nghĩa là `confirmMode: "off"` khi chưa đặt chế độ xác nhận |
| `admin.tokenFile` | `null` | xem `ZALO_MCP_ADMIN_TOKEN_FILE` |
| `admin.clientCa` | `null` | xem `ZALO_MCP_ADMIN_CLIENT_CA` |
| `presence.mode`, `.idleTimeout`, `.minConnected`, `.maxWakesPerHour`, `.warmWait`, `.connectOnStart`, `.catchUpEvery`, `.maxLeases`, `.leaseTtl`, `.leaseTtlMax`, `.waitHoldsSocket`, `.onKick` | xem [Người dùng, giới hạn luôn-kết-nối và hiện diện theo nhu cầu](#người-dùng-giới-hạn-luôn-kết-nối-và-hiện-diện-theo-nhu-cầu) | hiện diện theo nhu cầu của `mcp start --http` / `listen --daemon`; theo từng tài khoản trong `accounts.<ownId>.presence`; chính sách chạy thắng nó |
| `session.renew.enabled`, `.daysBefore`, `.linkTtl` | không đặt (= `true`, `7`, `"24h"`) | liên kết gia hạn mà máy chủ `mcp start --http` có `publicUrl` mở trước khi phiên đăng nhập đã lưu hết hạn (xem [gia hạn phiên đăng nhập đã lưu](#gia-hạn-phiên-đăng-nhập-đã-lưu-sessionrenew)) |
| `accounts.<ownId>` | | bất kỳ khóa nào ở trên, cho một tài khoản |

Khóa không có trong bảng này bị bỏ qua mà không báo. (Khóa `mode` trong các tệp cũ được chấp nhận nhưng không bao giờ được đọc.)

### Các khóa của `storage.json`

`<CONFIG_DIR>/storage.json` được **mọi** lệnh đọc, không chỉ máy chủ MCP: nó chọn cách niêm phong các tệp đã lưu, cơ sở dữ liệu tin nhắn và media, đồng thời đặt quy tắc hạn mức, lưu giữ và rời nhóm của bộ nhớ đệm cục bộ. Tệp không chứa bí mật nào. Mẫu cho từng nền tảng: [`storage/`](config-samples/storage/).

| Khóa | Mặc định | Ý nghĩa |
|---|---|---|
| `provider` | theo nền tảng: `dpapi` (Windows), `keychain` (macOS), `secret-service` (Linux desktop) | `dpapi`, `keychain`, `secret-service`, `systemd-creds`, `kms`, `passphrase` hoặc `env` (`ZALO_STORAGE_PROVIDER` được ưu tiên). Server Linux không có desktop keyring bắt buộc phải đặt; không bao giờ lùi về lưu dạng rõ. Trên VPS: `passphrase`, do systemd trao qua `LoadCredentialEncrypted=` ([security.vi.md](security.vi.md)) |
| `dkeyLayer` | `false` | khóa thêm mọi thứ không cần cho việc đăng nhập bằng khóa Zalo trả về ở mỗi lần đăng nhập (`ZALO_STORAGE_DKEY_LAYER`); khi đó dữ liệu cục bộ chỉ mở được sau khi đăng nhập |
| `dpapi.scope` | `CurrentUser` | hoặc `LocalMachine` (dịch vụ Windows) (`ZALO_DPAPI_SCOPE`) |
| `systemdCreds.withKey`, `systemdCreds.user` | `auto` | `host`, `tpm2`, `host+tpm2` hoặc `auto` (`ZALO_SYSTEMD_CREDS_WITH_KEY`); `user: true` cho unit có `User=` (cần systemd 256) |
| `kms.backend`, `kms.key` | | `aws`, `gcp`, `azure` hoặc `vault`, và id của khóa (`ZALO_KMS_BACKEND`, `ZALO_KMS_KEY`); SDK của dịch vụ đám mây là peer dependency tùy chọn, bạn tự cài |
| `passphrase.file` | | tệp chứa passphrase (`ZALO_STORAGE_PASSPHRASE_FILE`); dưới systemd, `$CREDENTIALS_DIRECTORY/zalo-storage-passphrase` được tự tìm thấy mà không cần đặt gì |
| `env.variable` | `ZALO_STORAGE_KEY` | biến chứa khóa của bộ `env` (yếu: bị cảnh báo ở mỗi lần khởi động) |
| `accounts.<ownId>.<mục của bộ cung cấp>`, `accounts.<ownId>.dkeyLayer` | | đặt riêng cho một tài khoản, ví dụ khóa KMS của một tenant (`accounts.<ownId>.kms.key`): thắng cả cấp trên cùng **lẫn** biến môi trường cho tài khoản đó, nên daemon, `za`, unit purge và unit sao lưu đều mở được keyring của nó. `account security provider kms <ownId> --key <id>` ghi khóa này |
| `rowMac.verifyOnRead` | `actions` | `off`: trích dẫn, chuyển tiếp, xóa, thu hồi, thả cảm xúc, ghim và `msg media` không còn kiểm tra MAC của dòng tin trong cache trước |
| `quota.*`, `retention.*` | không giới hạn, `minFree` `2GB`, `keep` | hạn mức dung lượng, phần đĩa chừa trống và quy tắc theo tuổi, đặt riêng theo tài khoản dưới `accounts.<ownId>`: [Hạn mức dung lượng và thời gian lưu giữ](#hạn-mức-dung-lượng-và-thời-gian-lưu-giữ) |
| `groups.onLeave` | `purge` | lịch sử cục bộ của nhóm đã rời sẽ ra sao, đặt riêng dưới `accounts.<ownId>.groups`: [Rời nhóm](#rời-nhóm-groupsonleave) |

`storage.json` không phải JSON hợp lệ sẽ chặn mọi lệnh cần khóa (một cài đặt có thể làm yếu lớp bảo vệ không bao giờ được đoán). Các khóa của bộ cung cấp chỉ được đọc khi khởi động: chính sách chạy từ chối chúng với `restartRequired`.

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
# port, địa chỉ bind và token nằm trong một tệp chỉ bạn đọc được:
install -m 600 docs/config-samples/env/loopback-server.env ~/.zalo-agent-cli/loopback.env
sed -i "s/CHANGE_ME_64_HEX_CHARACTERS/$(openssl rand -hex 32)/" ~/.zalo-agent-cli/loopback.env
zalo-agent --env-file ~/.zalo-agent-cli/loopback.env mcp start --account 1000000000000000001
```

- Tệp: [`env/loopback-server.env`](config-samples/env/loopback-server.env). Token không nằm trên dòng lệnh, nơi `ps` và lịch sử shell sẽ hiện nó.

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
- **Xác thực:** bearer token cho script và backend; OAuth 2.1 cho các connector từ xa đòi hỏi nó (bên dưới). Đặt `ZALO_MCP_PUBLIC_URL` (hoặc `publicUrl`) là địa chỉ `https://` công khai: OAuth issuer, endpoint MCP và mọi link tới trang dùng một lần đều được dựng từ đó. Nếu không, link dùng địa chỉ của chính server, còn metadata OAuth và header `WWW-Authenticate` được dựng từ header `Host` của request (`X-Forwarded-Host` / `X-Forwarded-Proto` chỉ được tin khi đến từ một proxy trong `trustedProxies`); khi OAuth bật và server nghe ngoài loopback, server từ chối khởi động nếu thiếu nó. (`ZALO_MCP_ISSUER_URL`, `--issuer-url` và `oauth.issuerUrl` là tên cũ của nó từ 2.x, vẫn dùng được.)
- HTTPS gốc (`--cert` / `--key`) không qua proxy chạy được, nhưng engine **còn cố nghe thêm port 443** bên cạnh port của bạn. Nên dùng proxy.
- Thêm những gì engine không có: danh sách IP được phép tại proxy, và log không bao giờ ghi header `Authorization`. Engine chỉ giới hạn tốc độ request ở các endpoint OAuth. Máy chủ trả `Access-Control-Allow-Origin: *` cho hầu hết origin (trừ câu trả lời `/register` có chứa client secret); xóa hoặc thay header này tại proxy nếu không muốn trình duyệt gọi.

#### OAuth cho connector từ xa (Claude.ai, Claude Desktop, Gemini)

OAuth **tắt trừ khi bạn bật** (từ 3.0.1): server chỉ có `--auth` / `ZALO_MCP_AUTH_TOKEN` phục vụ bearer token và trả `404` cho mọi route OAuth, kể cả các tài liệu discovery. OAuth bật khi có một client được cấu hình (`ZALO_MCP_OAUTH_CLIENT_SECRET`, `oauth.redirectUris`, hoặc một mục `oauth.clients[]`) hoặc khi bật đăng ký động.

**Trước lần kết nối đầu tiên**

1. Địa chỉ công khai: `ZALO_MCP_PUBLIC_URL=https://zalo.example.com`. Đó là issuer, và endpoint MCP là `<publicUrl>/mcp`. Base path cũng được (`https://zalo.example.com/a/<ownId>`): server trả lời cả các URL discovery chèn đường dẫn (`/.well-known/oauth-authorization-server/a/<ownId>`), và Caddyfile nhiều tài khoản (`fleet generate --domain`) chuyển chúng từ gốc host vào tài khoản.
2. Một secret của server để ký token: bearer token (`ZALO_MCP_AUTH_TOKEN`), nếu không có thì client secret đầu tiên. Khóa ký được dẫn xuất từ nó theo từng tài khoản, nên token của tài khoản này bị tài khoản khác từ chối. Đổi nó là đăng xuất mọi OAuth client.
3. Mật khẩu người duyệt: `zalo-agent mcp approver set --account <ownId>`. Mỗi lần kết nối mở một trang dùng một lần trên server này trong trình duyệt của người đang kết nối; trang cho biết client nào xin quyền và sẽ quay về đâu, rồi hỏi mật khẩu này (với `approval.secret: "pin"` thì hỏi PIN chat ẩn). Chỉ sau khi bấm **Approve** client mới nhận được code. Chưa đặt bí mật người duyệt thì `/authorize` từ chối và nói rõ lý do.

**Client tĩnh hay đăng ký động**

- **Client tĩnh** (khuyên dùng): bạn chọn id và secret, đưa cả hai cho connector, và liệt kê callback URL của connector. Một client: `ZALO_MCP_OAUTH_CLIENT_ID`, `ZALO_MCP_OAUTH_CLIENT_SECRET`, `ZALO_MCP_OAUTH_REDIRECT_URIS`. Nhiều hơn: `oauth.clients[]` trong `mcp-config.json`, mỗi mục `{clientId, clientSecret, redirectUris}`. Secret chỉ xác thực đúng client của nó tại `/token`: nó không phải bearer token cho `/mcp` (`oauth.secretsAsBearer: true` khôi phục hành vi 3.0.0). Client có `redirectUris` mà không có secret là client công khai.
- **Đăng ký động** (`ZALO_MCP_OAUTH_DYNAMIC_REGISTRATION=true`): connector tự đăng ký tại `/register` (RFC 7591) và nhận một client riêng, công khai trừ khi nó xin secret; secret đó ngẫu nhiên theo từng client và chỉ được lưu dạng hash. Bắt buộc có `redirect_uris`. Tối đa 100 client (client chưa từng dùng bị bỏ sau một ngày khi danh sách đầy) và 10 lần đăng ký mỗi giờ cho mỗi địa chỉ; đăng ký vẫn còn sau khi khởi động lại. Mỗi lần kết nối vẫn cần bạn duyệt.
- Redirect URI so khớp chính xác. Chỉ `https`, hoặc `http` trên `127.0.0.1`, `[::1]` hay `localhost`, nơi mọi port đều khớp (RFC 8252). `javascript:`, scheme tùy chỉnh và `http` ở nơi khác bị từ chối.

**Custom connector của Claude.ai, và Claude Desktop** (Claude Desktop dùng các connector của tài khoản Claude):

1. Trên server: `ZALO_MCP_OAUTH_CLIENT_ID=zalo-connector`, `ZALO_MCP_OAUTH_CLIENT_SECRET=<openssl rand -hex 20>`, `ZALO_MCP_OAUTH_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback`; khởi động lại.
2. Trong Claude: Settings → Connectors → Add custom connector. URL `https://zalo.example.com/mcp`; trong Advanced settings, điền OAuth Client ID và Client Secret ở trên. (Nếu bật đăng ký động thì để trống cả hai.)
3. Connect. Một tab mở trang duyệt của server này: nhập mật khẩu người duyệt, bấm Approve. Claude quay lại cuộc trò chuyện đã kết nối.

**Gemini** (custom MCP connector của Gemini Enterprise, Connected Apps):

1. Trên server, một client cho Gemini với callback mà form thiết lập của nó hiển thị (của Google là `https://vertexaisearch.cloud.google.com/oauth-redirect`), ví dụ trong `oauth.clients[]`: `{"clientId": "gemini", "clientSecret": "<ngẫu nhiên>", "redirectUris": ["https://vertexaisearch.cloud.google.com/oauth-redirect"]}`.
2. Trong form của Gemini: MCP URL `https://zalo.example.com/mcp`, authorization URL `https://zalo.example.com/authorize`, token URL `https://zalo.example.com/token`, client id và secret, scope `mcp:tools` (hoặc `ACCESS_VIEW_MANAGE_MCP_CONTENT` nếu nó yêu cầu scope đó).
3. Authorize: trang duyệt mở ra; nhập mật khẩu người duyệt, bấm Approve.

**Giao thức.** Authorization code với PKCE chỉ `S256` (`plain` và thiếu challenge bị từ chối); gửi lại `redirect_uri` tại `/token`; `iss` trong câu trả lời authorization (RFC 9207); `resource` (RFC 8707) nếu có phải là `<publicUrl>/mcp`. Scope: `mcp:tools`, `offline_access`, `ACCESS_VIEW_MANAGE_MCP_CONTENT`; scope nào cũng cấp toàn bộ tool của tài khoản này, không có scope hẹp hơn. `client_credentials` dành cho client bảo mật tự hành động (một backend). Route: `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register` (khi bật), `/revoke`. Không có OpenID Connect (`/.well-known/openid-configuration` là `404`). `/register`, `/authorize`, `/token` và `/revoke` bị giới hạn tốc độ theo địa chỉ client (`429` kèm `Retry-After`).

**Thời hạn token và thu hồi.** Access token sống 1 giờ (`oauth.accessTokenTtl`) và mang issuer cùng audience, cả hai đều được kiểm tra. Refresh token sống 30 ngày kể từ lần dùng cuối (`oauth.refreshTokenTtl`) và được xoay vòng mỗi lần refresh; một refresh token dùng hai lần sẽ thu hồi toàn bộ kết nối đó, và connector phải được cấp quyền lại. Để kết thúc một kết nối: `POST /revoke` (RFC 7009) kèm token và thông tin xác thực của client; hoặc bỏ client khỏi cấu hình rồi khởi động lại (token của nó ngừng hoạt động ngay); hoặc, khi server đã dừng, xóa `<thư mục tài khoản>/oauth-state.json` (mọi kết nối và đăng ký OAuth). File đó (`0600`) giữ các client đã đăng ký và một bản ghi cho mỗi kết nối, chỉ có hash; authorization code nằm trong bộ nhớ và không còn sau khi khởi động lại.

**Nâng cấp từ 3.0.0.** `--auth` một mình không còn bật OAuth, và client secret OAuth không còn mặc định lấy giá trị của nó: đặt `ZALO_MCP_OAUTH_CLIENT_SECRET` (và các redirect URI của nó) để giữ connector. Đăng ký động mặc định tắt. Client secret không còn là bearer token. Token do 3.0.0 cấp không còn được chấp nhận: mọi connector phải cấp quyền lại, qua trang duyệt.

### 3.5 Backend cho CRM

CRM cần ba thứ từ một tài khoản: **nghe** tin mới, **gửi**, và **bắt kịp** sau thời gian CRM ngừng. Đó là ba cơ chế khác nhau.

**Nghe: đẩy bằng webhook.** Tệp: [`env/crm-backend.env`](config-samples/env/crm-backend.env), [`mcp-config/crm-backend.json`](config-samples/mcp-config/crm-backend.json).

- `mcp start` gửi `{event: "message", accountId, msgId, threadId, threadType, senderId, senderName, text, timestamp, type, attachment, replyTo}` cho mỗi tin qua được `watchThreads`. `listen -w` gửi dạng khác, phong phú hơn (`{accountId, event, msgId, threadId, type, isSelf, uidFrom, dName, msgType, content, …}`) và cả sự kiện bạn bè, nhóm, reaction, đã đọc. Chọn một cách cho mỗi tài khoản.
- Mỗi lần gửi kèm `Authorization: Bearer <secret>` và `X-Zalo-Signature: sha256=<HMAC-SHA256 dạng hex của body gốc>`. Xác minh chữ ký trên **byte gốc**: [`clients/crm-webhook-receiver.mjs`](config-samples/clients/crm-webhook-receiver.mjs) (Node) và [`clients/crm_webhook_receiver.py`](config-samples/clients/crm_webhook_receiver.py) (Python) làm đúng việc đó.
- **Giao nhận bền vững, đúng thứ tự, ít nhất một lần.** Mỗi sự kiện được ghi vào `webhook-outbox.db` trong thư mục tài khoản trước khi gửi, nên bên nhận hỏng, chậm (mỗi POST có 10 giây) hoặc trả khác 2xx chỉ tạo ra tồn đọng chứ không mất tin: bên gửi thử lại với thời gian chờ 1 giây nhân đôi đến 5 phút, giữ mọi sự kiện phía sau sự kiện đang lỗi để không đảo thứ tự, và tiếp tục sau khi khởi động lại hoặc bị sập. Payload bị bên nhận từ chối vì sai định dạng (400, 413, 422) được chuyển vào **dead-letter**, sự kiện chưa giao quá `ZALO_WEBHOOK_MAX_AGE` (24 giờ) cũng vậy. Theo dõi bằng `zalo-agent mcp webhook status`, xem bằng `mcp webhook list --dead`, đưa trở lại hàng đợi bằng `mcp webhook retry`.
- **Trả 2xx ngay, xử lý sau, và loại trùng theo id tin nhắn.** Ít nhất một lần nghĩa là một tin có thể đến hai lần (sập sau khi bạn trả lời nhưng trước khi bên gửi kịp ghi nhận). Mỗi POST có `X-Zalo-Attempt` và `X-Zalo-Delivery: <đầu>-<cuối>` (số thứ tự trong outbox).
- **Gộp (batch).** Với `ZALO_WEBHOOK_BATCH_SIZE=10`, tối đa mười sự kiện đang chờ đi chung một POST dạng `{"event":"batch","accountId":…,"count":N,"events":[…]}`, chữ ký tính trên toàn bộ body; một sự kiện đơn lẻ vẫn là payload thường. Các bộ nhận mẫu xử lý được cả hai. Bật khi tồn đọng hoặc nhiều tài khoản khiến một POST mỗi tin là quá nhiều.
- **Sự kiện hệ thống** đi qua cùng webhook (chỉ id và số đếm, không bao giờ có tên): `account_state` (trạng thái của tài khoản: `stopped`, `idle`, `connecting`, `connected`, `kicked`, `yielded`, `login_needed`, `signed_out`, `maintenance`; xem [hiện diện theo nhu cầu](#người-dùng-giới-hạn-luôn-kết-nối-và-hiện-diện-theo-nhu-cầu)), `storage_quota` ([hạn mức](#hạn-mức-dung-lượng-và-thời-gian-lưu-giữ)), `group_gone` ([rời nhóm](#rời-nhóm-groupsonleave)), `queue_overflow` (Zalo đã bỏ một phần hàng đợi offline: `{event, accountId, fromTs, toTs, queues, direct, groups, pending, command}`; tin nhắn nhóm được đọc lại từ kho cloud của nhóm, khoảng trống 1-1 vẫn chờ xử lý kèm lệnh `sync --from` để khôi phục), `session_expiring` (phiên đăng nhập đã lưu tự hết hạn khoảng 90 ngày sau lần đăng nhập QR và không gì gia hạn nó: `{event, accountId, expiresAt, daysLeft, expired, threshold, command, at}`, gửi một lần cho mỗi mốc vượt qua, còn 14, 7, 3 và 1 ngày, và `threshold: 0` khi đã hết hạn, được nhớ qua các lần khởi động lại; gia hạn bằng một lần đăng nhập QR, `zalo-agent --account <id> login` rồi khởi động lại daemon, hoặc thêm bằng QR qua fleet controller, vẫn giữ device id; khi đã hết hạn thì `account_state` `signed_out` theo sau; khi có `publicUrl`, từ 7 ngày trước khi hết hạn nó mang một liên kết gia hạn dùng một lần, `renewUrl` kèm `renewExpiresAt`, và được gửi lại với mỗi liên kết mới, xem [gia hạn phiên đăng nhập đã lưu](#gia-hạn-phiên-đăng-nhập-đã-lưu-sessionrenew)), `session_renewed` (điện thoại đã gia hạn đăng nhập qua liên kết đó và máy chủ đang dùng nó: `{event, accountId, expiresAt, daysLeft, deviceKept, at}`) và, với `approval.deliver: "webhook"`, `approval_requested`. Tin nhắn đến khi socket đang tạm nghỉ được gửi ở lần kết nối kế tiếp với `catchUp: true`. Hãy định tuyến theo `event` và bỏ qua sự kiện bạn không biết.

**Nghe: kéo.** `GET /events/wait?timeout=55&since=<cursor>` trả về mọi tin đang chờ trong bộ đệm (`&limit=<n>` giới hạn số tin), hoặc `{"status":"timeout"}`, kèm cursor để tiếp tục. Phản hồi có `messages` (đúng thứ tự), `count`, `hasMore` và `cursor` là của tin **cuối**, nên `since=<cursor>` tiếp tục đúng chỗ lô vừa kết thúc; `message` là tin đầu. **Thay đổi không tương thích ở 3.0.0:** trước đây mặc định là một tin mỗi lần gọi; client chỉ đọc `message` rồi đi tiếp từ `cursor` giờ sẽ bỏ sót phần còn lại của lô: hãy đọc `messages`, hoặc gửi `limit=1`. Khi có `limit`, để xả một đống tồn, gọi lại ngay khi `hasMore` còn true; `settle=200` (ms, tối đa 5000) chờ thêm chừng đó sau tin đầu tiên để một đợt tin đến dồn vào một phản hồi. `limit` và `settleMs` cũng có ở tool `zalo_wait_for_message` và ở `mcp wait --limit --settle`. Bộ đệm phía sau giữ tối đa `limits.bufferMaxSize` tin cho mỗi thread trong `limits.bufferMaxAge` (mẫu CRM nâng cả hai lên 2.000 và 6 giờ). Quá mức đó, đọc cache bằng `zalo_get_history` / `zalo_get_messages`.

**Gửi.** Một lời gọi JSON-RPC tới `POST /mcp`: [`clients/crm-send-message.sh`](config-samples/clients/crm-send-message.sh). Gửi `Accept: application/json, text/event-stream` (thiếu một trong hai, máy chủ trả 406); phản hồi là một dòng SSE `data:`, và gửi thành công trả về `{"success":true,"msgId":…,"cliMsgId":…,"threadType":…}`. `threadId` là id người dùng cho tin nhắn riêng hoặc id nhóm cho nhóm. Mỗi request `/mcp` dựng một máy chủ mới với đủ 38 tool, tốn vài mili giây CPU: ổn cho CRM, và là lý do một tài khoản chạm trần khoảng 60–170 request/giây (xem [`docs/deployment.vi.md`](deployment.vi.md) §1.4).

**Bắt kịp.** Sau thời gian ngừng, hỏi những gì đã lỡ: `zalo_get_history` theo từng thread, hoặc `zalo-agent sync --from <date>` (có thể yêu cầu chủ tài khoản xác nhận trên điện thoại).

**Trò chuyện ẩn và trang nhập bảo mật.** Các cuộc trò chuyện ẩn của tài khoản bị bỏ khỏi mọi thứ CRM đọc (`hiddenChats: "exclude"`); `contentless` gửi sự kiện webhook `{event: "message", hidden: true, accountId}` không có thread id hay nội dung, như chấm chưa đọc mà Zalo hiện. Mọi thứ một người phải gõ hoặc duyệt (mã PIN trò chuyện ẩn, một lần duyệt của `confirmMode: "human"`) là một trang dùng một lần trên chính port của server, `/zalo/secure/<token>`: kết quả của tool có `secureUrl`, `ticketExpiresAt` (5 phút) và `retryWith.ticket`; CRM hiện link cho chủ tài khoản và gọi lại với `ticket` khi họ làm xong. Cho `/zalo/secure/` đi qua cùng proxy với `/mcp` và đặt `publicUrl` là địa chỉ công khai của nó (link không bao giờ được dựng từ header `Host` của request). Trang không cần bearer token (token của nó là chìa khóa), gửi `Cache-Control: no-store`, không tải gì từ nơi khác, và token bị che trong log request. Xem [`docs/deployment.vi.md`](deployment.vi.md) §5.5.

**Duyệt ngay trong giao diện của CRM.** Với `approval.deliver: "webhook"` link không bao giờ đi qua agent: server POST `{event: "approval_requested", accountId, kind, action, wouldDo, target, secureUrl, expiresAt, approverSecret}` tới webhook (xếp hàng và ký như sự kiện tin nhắn), CRM hiện `wouldDo` và link cho một người, còn kết quả của tool chỉ có `{confirmationRequired hoặc pinRequired: true, approvalPending: true, ticket, ticketExpiresAt, deliveredTo: "webhook"}`. CRM gọi lại với `ticket` đó khi người kia làm xong; ticket không phải token của trang, nên không gì trong kết quả mở được trang. Khi link buộc phải đi qua agent, hãy đặt mật khẩu người duyệt (`zalo-agent mcp approver set`) hoặc `approval.secret: "pin"`, để trang hỏi điều chỉ người đó biết.

### 3.6 Nhiều tài khoản

Một tài khoản là một tiến trình, một WebSocket, một tệp SQLite và một port: không có chế độ nhiều tài khoản trong một tiến trình. Chạy **một instance systemd cho mỗi tài khoản** với tệp env riêng:

- [`systemd/zalo-mcp@.service`](config-samples/systemd/zalo-mcp@.service): tên instance chính là id tài khoản; token và port lấy từ `/etc/zalo-mcp/accounts/<id>.env`, nên không có gì bí mật trên dòng lệnh. Các instance giãn thời điểm khởi động ngay trong daemon (`ZALO_START_JITTER=30` trong `common.env`: mỗi lần khởi động đều đăng nhập và nạp danh sách của tài khoản; cả đàn khởi động cùng lúc là thời điểm nặng nhất) và mỗi instance bị giới hạn 600 MB (instance nhàn rỗi khoảng 100 MB). `ReadWritePaths` duy nhất của nó là thư mục cấu hình của user dịch vụ; passphrase của bộ cung cấp khóa đến từ drop-in [`systemd/credentials.conf`](config-samples/systemd/credentials.conf) (`LoadCredentialEncrypted=`).
- [`systemd/common.env`](config-samples/systemd/common.env) cho phần chung của các unit (chỉ các unit đọc: không đặt đường dẫn ở đây), [`env/account.env`](config-samples/env/account.env) cho từng tài khoản (token, port và `ZALO_MCP_PUBLIC_URL`), và [`systemd/home.env`](config-samples/systemd/home.env), tức `~/.zalo-agent-cli/.env` của user dịch vụ: mọi lệnh đều đọc nó, nên các đường dẫn của máy (`ZALO_DATA_DIR`, `ZALO_MEDIA_DIR`) đặt ở đây và lệnh CLI chạy tay mở đúng các file mà unit dùng.
- [`systemd/za`](config-samples/systemd/za): chạy CLI dưới user dịch vụ, cùng home, `common.env` và credential như các unit; [`systemd/zalo-fleet-check.*`](config-samples/systemd/zalo-fleet-check.service) (`fleet status --check` mỗi 5 phút) và [`systemd/zalo-backup.*`](config-samples/systemd/zalo-backup.service) (`db backup` mỗi đêm); [`systemd/zalo-policy-audit.logrotate`](config-samples/systemd/zalo-policy-audit.logrotate).
- [`systemd/zalo-mcp-purge.service`](config-samples/systemd/zalo-mcp-purge.service) và [`systemd/zalo-mcp-purge.timer`](config-samples/systemd/zalo-mcp-purge.timer): chạy `fleet purge --yes` mỗi giờ, để tài khoản có daemon đang dừng vẫn được xóa theo hạn mức và thời gian lưu giữ (dưới `daemon.lock` của nó), và daemon có lịch riêng bị trễ được yêu cầu chạy ngay.
- **`zalo-agent fleet generate --out <dir>`** ghi toàn bộ những thứ trên cho các tài khoản được nêu tên, hoặc mọi tài khoản đã đăng ký (unit, timer, file env với token tự sinh cho từng tài khoản, `storage.json`, drop-in, `za`, bảng port, và với `--domain` thì Caddyfile và URL công khai của từng tài khoản), rồi in các bước cài đặt; `fleet status` cho xem mọi daemon trong một bảng, `fleet start` / `restart` khởi động theo từng lô được xáo trộn, và `fleet restart --unhealthy` chỉ khởi động lại những cái đang chết (xem [`docs/deployment.vi.md`](deployment.vi.md) §4.8).
- **`zalo-agent fleet serve`** là fleet controller cho CRM hoặc console: một admin API cho mỗi máy (`/zalo/admin/accounts`: liệt kê, kèm `name` và `phone` Zalo của chính tài khoản như daemon đọc lần gần nhất, khởi động, dừng, khởi động lại, presence wake/park/resume, đăng xuất và gỡ tài khoản có xác nhận, thêm tài khoản mới bằng QR, tác vụ tài khoản (`/zalo/admin/accounts/<ownId>/jobs`: đồng bộ, tải tệp đính kèm, dọn dữ liệu, chạy bằng chính CLI này), luồng SSE `account_state` ở `GET /zalo/admin/events`), chỉ nhận thông tin xác thực admin, trên `ZALO_FLEET_CONTROLLER_PORT` (mặc định 3899), cùng `ZALO_FLEET_SUPERVISOR`, `ZALO_FLEET_DOMAIN`, `ZALO_FLEET_QR_FLOWS`, `ZALO_FLEET_JOBS` và `ZALO_FLEET_WEBHOOK[_SECRET]` ở bảng trên; unit mẫu [`systemd/zalo-fleet-controller.service`](config-samples/systemd/zalo-fleet-controller.service). Với hiện diện theo nhu cầu, `ZALO_CONNECT_SLOTS` (mẫu đặt 16) giữ cho nhiều tài khoản không thức cùng lúc.
- Một kế hoạch port, ví dụ `3900 + n`, ghi trong một bảng (`fleet ports` giữ bảng đó giúp bạn). Sau một tên miền: [`proxy/Caddyfile.multi-account`](config-samples/proxy/Caddyfile.multi-account) định tuyến `/a/<ownId>/…` tới đúng port; dùng bearer token, mỗi tài khoản một token.
- Cho mỗi tài khoản **proxy riêng** khi đăng nhập (`zalo-agent login --proxy …`) và dấu vân tay thiết bị riêng (tự động): hàng trăm tài khoản từ một địa chỉ là điều khiến tài khoản bị khóa.
- Cài đặt chung trong `mcp-config.json`, khác biệt theo tài khoản trong khối `accounts` của nó ([`mcp-config/multi-account.json`](config-samples/mcp-config/multi-account.json)).
- Đọc §1.4 và §3 của [`docs/deployment.vi.md`](deployment.vi.md) trước khi vượt quá vài chục tài khoản.
- Bộ file đầy đủ theo từng trường hợp sử dụng (desktop, LAN, VPS, CRM, SaaS), mỗi bộ có README: [`config-samples/use-cases/`](config-samples/use-cases/).

---

## 4. Danh sách kiểm tra trước khi mở một port

| Kiểm tra | Lý do |
|---|---|
| đã đặt token (`ZALO_MCP_AUTH_TOKEN`), 32+ byte ngẫu nhiên | không có token, máy chủ phục vụ bất kỳ ai tới được, và chỉ nói điều đó trong log |
| token nằm trong tệp env quyền `0600`, không nằm trong cờ | cờ hiện trong `ps` và `/proc/<pid>/cmdline`; dòng log của daemon có che, `ps` thì không |
| `ZALO_MCP_HOST` là `127.0.0.1` sau proxy, hoặc một địa chỉ LAN cụ thể | `0.0.0.0` nghe trên mọi giao diện, kể cả giao diện công khai |
| TLS kết thúc tại proxy, hoặc đã đặt `--cert`/`--key` | bearer token qua HTTP thường đọc được trên đường truyền |
| proxy không ghi `Authorization` và không đệm `/events/wait` | token lọt vào log; long-poll bị cắt theo timeout của proxy |
| `GET /health` và `GET /ready` là hai route duy nhất không cần xác thực | chúng chỉ cho biết tiến trình có trả lời không và có phục vụ được tài khoản không (`/ready` trả 200 khi socket đang kết nối hoặc tạm nghỉ, 503 khi mất kết nối, đã nhường hoặc đã bị đăng xuất), không nói gì về bản thân tài khoản. `/status` và `/metrics` nằm sau token: đừng công bố chúng qua proxy |
| mỗi tài khoản một tiến trình, không bao giờ hai cho cùng tài khoản, và không đăng nhập trên trình duyệt cho tài khoản mà máy chủ đang giữ | phiên thứ hai của cùng lần đăng nhập đóng phiên thứ nhất (mã 3000); đăng nhập Zalo trên trình duyệt bằng QR thu hồi lần đăng nhập của máy chủ (`signed_out`). Điện thoại và ứng dụng Zalo trên máy tính thì không sao |

## 5. Kiểm tra một mô hình đã chạy đúng

```bash
# lên rồi, và token được thực thi (mong đợi 200, 401, 401):
curl -s -o /dev/null -w '%{http_code}\n' http://HOST:PORT/health
# tài khoản phục vụ được (200 khi kết nối hoặc tạm nghỉ; 503 khi mất kết nối, đã nhường hoặc bị đăng xuất), chi tiết nằm sau token:
curl -s -o /dev/null -w '%{http_code}\n' http://HOST:PORT/ready
curl -s -H "Authorization: Bearer $TOKEN" http://HOST:PORT/status | head -c 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://HOST:PORT/mcp
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://HOST:PORT/mcp -H 'Authorization: Bearer wrong'

# các tool được phục vụ (mong đợi 38 tên):
curl -s http://HOST:PORT/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -o '"name":"zalo_[a-z_]*"' | wc -l

# daemon, log và socket của nó:
zalo-agent mcp start --account 1000000000000000001 --status
tail -f ~/.zalo-agent-cli/accounts/1000000000000000001/daemon.log   # khi chạy với -d
```

## Ghi chú

- Biểu mẫu custom connector của Claude từng cắt ngắn client secret dài 64 ký tự (khi đó yêu cầu token thất bại với `invalid_client`): hãy giữ `ZALO_MCP_OAUTH_CLIENT_SECRET` từ 40 ký tự trở xuống, ví dụ `openssl rand -hex 20`.
