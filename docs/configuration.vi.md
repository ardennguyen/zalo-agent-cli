# Sổ tay cấu hình — `.env`, `mcp-config.json` và các mô hình triển khai nên dùng

> **Trạng thái:** đã đối chiếu với `zalo-agent-cli` `2.5.6`. Mọi tệp nêu ở đây đều có sẵn để sao chép trong [`docs/config-samples/`](config-samples/), và `tests/unit/config-samples.test.js` buộc từng tệp khớp với mã nguồn: mọi khóa `mcp-config.json` đều là khóa trình nạp thực sự gộp, mọi biến môi trường đều được một tệp nguồn đọc, và bộ nhận CRM xác minh được chữ ký do chính bộ gửi webhook tạo ra. Bản tiếng Anh: [`configuration.md`](configuration.md).

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

### Thứ tự ưu tiên

**Các tệp môi trường** được gộp mà không ghi đè: nguồn đầu tiên định nghĩa một tên là thắng, theo thứ tự: môi trường tiến trình thật, `--env-file`, `./.env`, `<CONFIG_DIR>/.env`. (`zalo-mcp/.env` được launcher nạp theo cùng cách: chỉ điền các tên chưa có.)

**Một cài đặt** được xác định theo từng tài khoản, cao nhất trước:

1. cờ dòng lệnh (`--http`, `--host`, `--auth`, `--webhook`, …)
2. `TEN_<ownId>` trong môi trường, ví dụ `ZALO_MCP_HTTP_PORT_1000000000000000001`
3. `TEN` trong môi trường
4. `mcp-config.json`, lớp sau đè lớp trước: tệp nền, rồi khối `accounts.<ownId>` của nó, rồi `<accountDir>/mcp-config.json`
5. giá trị mặc định có sẵn

[`env/multi-account.env`](config-samples/env/multi-account.env) minh họa quy tắc 2 thắng 3 trong một tệp.

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
| `ZALO_MCP_ISSUER_URL` | có | địa chỉ `https://` công khai mà metadata OAuth công bố | `--issuer-url` | `oauth.issuerUrl` |
| `ZALO_WEBHOOK_URL` | có | POST mỗi tin nhắn đến tới đây | `-w`, `--webhook` | `webhook` |
| `ZALO_WEBHOOK_SECRET` | có | ký webhook (`Authorization: Bearer` + `X-Zalo-Signature: sha256=…`) | `--webhook-secret` (hiện trong `ps`) | `webhookSecret` |
| `ZALO_WEBHOOK_BATCH_SIZE` | có | số sự kiện mỗi POST webhook, 1–100. Mặc định 1: mỗi sự kiện một POST | | `webhookBatchSize` |
| `ZALO_WEBHOOK_MAX_AGE` | có | thời gian thử lại một sự kiện chưa giao được trước khi chuyển vào dead-letter (`6h`, `24h`; tối thiểu `1m`). Mặc định `24h` | | `webhookMaxAge` |
| `ZALO_MCP_GROUP_CONFIRM` |  | `0` cho phép `zalo_group` rời nhóm / xóa thành viên mà không cần `confirm: true` | | `groupConfirm` |
| `ZALO_SYNC_NAME_REFRESH_MAX` |  | số tên DM không phải bạn bè mà một lần restore được tra. Mặc định 500 | | |
| `ZALO_START_JITTER` | có | chờ một khoảng ngẫu nhiên tối đa chừng này giây (0–600, mặc định 0) trước khi đăng nhập, để một đội daemon khởi động lại cùng lúc không đăng nhập cùng lúc | | |
| `ZALO_LOGIN_SLOTS` | có | tối đa chừng này daemon trên máy cùng đăng nhập và nạp danh sách một lúc (0–64; mặc định 0, không giới hạn); phần còn lại chờ một slot. `ZALO_LOGIN_SLOT_WAIT` (giây, mặc định 900) là thời gian chờ tối đa trước khi cứ tiếp tục | | |
| `ZALO_LOG_LEVEL` | có | `error`, `warn`, `info` (mặc định) hoặc `debug` (thêm một dòng cho mỗi HTTP request và mỗi tin nhắn) | `--log-level` | |
| `ZALO_LOG_FORMAT` |  | `text` (mặc định, mỗi dòng có thời gian) hoặc `json` (mỗi dòng một đối tượng) | | |
| `ZALO_LOG_MAX_SIZE`, `ZALO_LOG_KEEP` |  | xoay `daemon.log` khi đạt dung lượng này (mặc định `50m`, tối thiểu `4k`) và giữ chừng này file (mặc định 3) | | |
| `ZALO_AGENT_NO_UPDATE_CHECK` |  | giá trị bất kỳ: không bao giờ chạy kiểm tra cập nhật `npm view` | | |
| `ZALO_API_VERSION` |  | phiên bản giao thức báo cho Zalo. Mặc định 694 | | |
| `ZALO_QR_FLOW` |  | cách `login` đăng nhập bằng QR: `official` (mặc định: đúng trình tự Zalo Web, không gọi `verify-client`, `continue=https://chat.zalo.me/`, chuyển hướng qua `jr.zaloapp.com` và `jr.chat.zalo.me`, kèm mã QR thứ hai mà tài khoản có thiết bị tin cậy phải quét, khiến client này thành một thiết bị tin cậy đi kèm) hoặc `legacy` (của zca-js). Giá trị khác bị từ chối trước khi liên hệ Zalo | | |
| `ZALO_NET_PROBE` |  | thứ daemon hỏi để biết mạng còn hoạt động hay không khi socket đang đứt (mỗi 10 giây): một URL, mặc định là một trang nhẹ của công cụ tìm kiếm toàn cầu, hoặc `off` để coi như mạng luôn hoạt động và không liên hệ nơi nào ngoài Zalo | | |

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
| `media.downloadDir` | `null` | thư mục gốc media của máy chủ này |
| `media.autoOpen` | `true` | tự mở media đã tải trên máy này; đặt `false` trên máy chủ |
| `notify.enabled`, `.thread`, `.on`, `.cooldown` | tắt | báo vào một nhóm Zalo khi agent vắng mặt |
| `webhook`, `webhookSecret` | `null` | đẩy mỗi tin tới một URL, có ký (nên dùng `ZALO_WEBHOOK_SECRET`) |
| `webhookBatchSize` | `1` | số sự kiện mỗi POST webhook (1–100) |
| `webhookMaxAge` | `"24h"` | sự kiện webhook chưa giao quá thời gian này sẽ chuyển vào dead-letter |
| `httpPort`, `host` | `null` | port HTTP và địa chỉ bind |
| `tls.cert`, `tls.key` | `null` | HTTPS |
| `oauth.clientId`, `.clientSecret`, `.issuerUrl`, `.clients[]` | | các consumer OAuth 2.0; `clients[]` là danh sách `{clientId, clientSecret}` |
| `groupConfirm` | `true` | `zalo_group` cần `confirm: true` trước `leave` / `remove_member` |
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
- **Xác thực:** bearer token cho script và backend; OAuth 2.0 cho các connector từ xa đòi hỏi nó. Đặt `ZALO_MCP_ISSUER_URL` là địa chỉ `https://` công khai. Nếu không, metadata OAuth và header `WWW-Authenticate` được dựng từ chính các header `X-Forwarded-Host` / `Host` của request, mà client nào cũng đặt được. Nhiều consumer: liệt kê trong `oauth.clients[]` của `mcp-config.json`.
- HTTPS gốc (`--cert` / `--key`) không qua proxy chạy được, nhưng engine **còn cố nghe thêm port 443** bên cạnh port của bạn. Nên dùng proxy.
- Thêm những gì engine không có: danh sách IP được phép tại proxy, giới hạn tốc độ, và log không bao giờ ghi header `Authorization`. Máy chủ trả `Access-Control-Allow-Origin: *` cho mọi origin; xóa hoặc thay header này tại proxy nếu không muốn trình duyệt gọi.

### 3.5 Backend cho CRM

CRM cần ba thứ từ một tài khoản: **nghe** tin mới, **gửi**, và **bắt kịp** sau thời gian CRM ngừng. Đó là ba cơ chế khác nhau.

**Nghe: đẩy bằng webhook.** Tệp: [`env/crm-backend.env`](config-samples/env/crm-backend.env), [`mcp-config/crm-backend.json`](config-samples/mcp-config/crm-backend.json).

- `mcp start` gửi `{event: "message", accountId, id, threadId, threadType, senderId, senderName, text, timestamp, type, attachment, replyTo}` cho mỗi tin qua được `watchThreads`. `listen -w` gửi dạng khác, phong phú hơn (`{accountId, event, msgId, threadId, type, isSelf, uidFrom, dName, msgType, content, …}`) và cả sự kiện bạn bè, nhóm, reaction, đã đọc. Chọn một cách cho mỗi tài khoản.
- Mỗi lần gửi kèm `Authorization: Bearer <secret>` và `X-Zalo-Signature: sha256=<HMAC-SHA256 dạng hex của body gốc>`. Xác minh chữ ký trên **byte gốc**: [`clients/crm-webhook-receiver.mjs`](config-samples/clients/crm-webhook-receiver.mjs) (Node) và [`clients/crm_webhook_receiver.py`](config-samples/clients/crm_webhook_receiver.py) (Python) làm đúng việc đó.
- **Giao nhận bền vững, đúng thứ tự, ít nhất một lần.** Mỗi sự kiện được ghi vào `webhook-outbox.db` trong thư mục tài khoản trước khi gửi, nên bên nhận hỏng, chậm (mỗi POST có 10 giây) hoặc trả khác 2xx chỉ tạo ra tồn đọng chứ không mất tin: bên gửi thử lại với thời gian chờ 1 giây nhân đôi đến 5 phút, giữ mọi sự kiện phía sau sự kiện đang lỗi để không đảo thứ tự, và tiếp tục sau khi khởi động lại hoặc bị sập. Payload bị bên nhận từ chối vì sai định dạng (400, 413, 422) được chuyển vào **dead-letter**, sự kiện chưa giao quá `ZALO_WEBHOOK_MAX_AGE` (24 giờ) cũng vậy. Theo dõi bằng `zalo-agent mcp webhook status`, xem bằng `mcp webhook list --dead`, đưa trở lại hàng đợi bằng `mcp webhook retry`.
- **Trả 2xx ngay, xử lý sau, và loại trùng theo id tin nhắn.** Ít nhất một lần nghĩa là một tin có thể đến hai lần (sập sau khi bạn trả lời nhưng trước khi bên gửi kịp ghi nhận). Mỗi POST có `X-Zalo-Attempt` và `X-Zalo-Delivery: <đầu>-<cuối>` (số thứ tự trong outbox).
- **Gộp (batch).** Với `ZALO_WEBHOOK_BATCH_SIZE=10`, tối đa mười sự kiện đang chờ đi chung một POST dạng `{"event":"batch","accountId":…,"count":N,"events":[…]}`, chữ ký tính trên toàn bộ body; một sự kiện đơn lẻ vẫn là payload thường. Các bộ nhận mẫu xử lý được cả hai. Bật khi tồn đọng hoặc nhiều tài khoản khiến một POST mỗi tin là quá nhiều.

**Nghe: kéo.** `GET /events/wait?timeout=55&since=<cursor>&limit=50` trả về tối đa `limit` tin đang có trong bộ đệm mỗi lần gọi (mặc định 1, tối đa 100), hoặc `{"status":"timeout"}`, kèm cursor để tiếp tục. Phản hồi có `messages` (đúng thứ tự), `count`, `hasMore` và `cursor` là của tin **cuối**, nên `since=<cursor>` tiếp tục đúng chỗ lô vừa kết thúc; `message` vẫn là tin đầu, nên client không gửi `limit` vẫn thấy đúng như trước. Để xả một đống tồn, gọi lại ngay khi `hasMore` còn true; `settle=200` (ms, tối đa 5000) chờ thêm chừng đó sau tin đầu tiên để một đợt tin đến dồn vào một phản hồi. `limit` và `settleMs` cũng có ở tool `zalo_wait_for_message` và ở `mcp wait --limit --settle`. Bộ đệm phía sau giữ tối đa `limits.bufferMaxSize` tin cho mỗi thread trong `limits.bufferMaxAge` (mẫu CRM nâng cả hai lên 2.000 và 6 giờ). Quá mức đó, đọc cache bằng `zalo_get_history` / `zalo_get_messages`.

**Gửi.** Một lời gọi JSON-RPC tới `POST /mcp`: [`clients/crm-send-message.sh`](config-samples/clients/crm-send-message.sh). Gửi `Accept: application/json, text/event-stream` (thiếu một trong hai, máy chủ trả 406); phản hồi là một dòng SSE `data:`, và gửi thành công trả về `{"success":true,"messageId":…,"cliMsgId":…,"threadType":…}`. `threadId` là id người dùng cho tin nhắn riêng hoặc id nhóm cho nhóm. Mỗi request `/mcp` dựng một máy chủ mới với đủ 25 tool, tốn vài mili giây CPU: ổn cho CRM, và là lý do một tài khoản chạm trần khoảng 60–170 request/giây (xem [`docs/deployment.vi.md`](deployment.vi.md) §1.4).

**Bắt kịp.** Sau thời gian ngừng, hỏi những gì đã lỡ: `zalo_get_history` theo từng thread, hoặc `zalo-agent sync --from <date>` (có thể yêu cầu chủ tài khoản xác nhận trên điện thoại).

### 3.6 Nhiều tài khoản

Một tài khoản là một tiến trình, một WebSocket, một tệp SQLite và một port: không có chế độ nhiều tài khoản trong một tiến trình. Chạy **một instance systemd cho mỗi tài khoản** với tệp env riêng:

- [`systemd/zalo-mcp@.service`](config-samples/systemd/zalo-mcp@.service): tên instance chính là id tài khoản; token và port lấy từ `/etc/zalo-mcp/accounts/<id>.env`, nên không có gì bí mật trên dòng lệnh. Các instance khởi động lệch nhau trong 30 giây (mỗi lần khởi động đều đăng nhập và nạp danh sách của tài khoản; cả đàn khởi động cùng lúc là thời điểm nặng nhất) và mỗi instance bị giới hạn 600 MB (instance nhàn rỗi khoảng 100 MB).
- [`systemd/common.env`](config-samples/systemd/common.env) cho phần chung, [`env/account.env`](config-samples/env/account.env) cho từng tài khoản.
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

# các tool được phục vụ (mong đợi 25 tên):
curl -s http://HOST:PORT/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -o '"name":"zalo_[a-z_]*"' | wc -l

# daemon, log và socket của nó:
zalo-agent mcp start --account 1000000000000000001 --status
tail -f ~/.zalo-agent-cli/accounts/1000000000000000001/daemon.log   # khi chạy với -d
```
