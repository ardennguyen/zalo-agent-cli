# Danh tính người gửi và tên hiện tại

[English](current-user-names.md)

Trang này nói cách client gọi tên một người trong mọi đầu ra (3.0), rồi đến thay đổi ở bản 2.x đã đưa vào tên hiện tại ([PR #2](https://github.com/ardennguyen/zalo-agent-cli/pull/2)), giữ lại làm lịch sử. Khi trang này và [command reference](../skill/references/command-reference.md) khác nhau, command reference là bản đúng.

## Cách gọi tên trong 3.0: alias trước tiên, ở mọi nơi

Mọi đầu ra gọi tên một người giống ứng dụng Zalo: **alias mà chủ tài khoản đặt cho họ**, rồi tên trong danh bạ (chỉ
khi nơi gọi truyền vào: client này không đọc danh bạ), rồi tên Zalo, rồi tên hiển thị, rồi UID
(`src/core/contact-names.js`). Quy tắc này áp dụng cho các dòng của `listen`, JSONL và webhook, bộ đệm MCP, notifier và
kết quả chờ, mọi phản hồi `zalo_*`, `msg history` / `msg search`, danh sách `conv`, các lệnh `friend` và
`group`, mention, tin được trích dẫn (`replyTo`), reaction, đang gõ và sự kiện nhóm.

| Trường | Có trên tin nhắn | Ý nghĩa |
|---|---|---|
| `senderName` | có | tên để hiển thị: alias của chủ tài khoản nếu có, không thì tên mà tin mang theo, không nữa thì tên profile hiện tại. **Đổi nghĩa trong 3.0:** trước đây là tên mà tin mang theo |
| `senderAlias` | có | alias, hoặc `null` |
| `senderZaloName` | có | tên mà tin mang theo (bản lưu, không bao giờ bị ghi đè) |
| `senderDisplayName`, `senderDisplayNameSource` | có | tên hiện tại và nguồn của nó: `alias`, `phonebook`, `zalo`, `display` hoặc `uid` |
| `displayName` / `dName` / `dpn` / `inviterName` | một người, sự kiện `listen`, thành viên chờ duyệt, lời mời | cùng giá trị ưu tiên alias, nằm trong trường vốn có |
| `alias`, `zaloName` | một người | các giá trị gốc đặt bên cạnh |

**Dòng đã lưu không bao giờ bị ghi lại.** `zalo.db` giữ tên mà mỗi tin mang theo; alias chỉ được áp khi hiển thị hoặc
trả về. Chat 1-1 được đặt tiêu đề theo alias khi hiển thị; tiêu đề nhóm thì không bao giờ.

**Alias lấy từ đâu.** Daemon `listen` hoặc `mcp start` đọc danh sách alias của tài khoản lúc khởi động, đọc lại khoảng
1,5 giây sau control `alias` của Zalo (một alias được đặt, đổi hoặc xóa trên bất kỳ thiết bị nào) và mỗi 30 phút. Nó giữ
bản chụp trong cơ sở dữ liệu của tài khoản (`user_aliases`, có trong `db export`) để lệnh chạy một lần dùng mà không
cần gọi Zalo, và đặt lại tiêu đề các chat 1-1 đã lưu có alias vừa đổi. Một lần đọc lỗi hoặc thiếu không bao giờ thay bản
chụp (thiếu một mục nghĩa là chủ tài khoản đã xóa alias đó, nên chỉ lần đọc đầy đủ mới được tính). Control `profile` (tên
của chính tài khoản đổi trên thiết bị khác) khiến daemon đọc lại tên tài khoản. Tin nhắn 1-1 đến không tốn lần gọi alias
nào: bản chụp của daemon trả lời luôn.

Phần còn lại của trang là thay đổi ở bản 2.x đã đưa vào tên hiện tại, giữ làm lịch sử.

## Thay đổi ở bản 2.x (lịch sử)

Tin nhắn khôi phục từ điện thoại trước đây lưu ID người gửi dạng mã hóa và tên
rỗng. Sync hiện phân giải người gửi trước transaction SQLite của từng chunk,
tái sử dụng danh tính DM trong bảng ánh xạ hội thoại và cơ chế gọi profile theo
lô `gid/decrypt` + `getUserInfo` sẵn có cho những người còn lại. Danh tính nhóm
không được dùng làm tên người gửi. Cache theo lần chạy tránh gọi lặp, kể cả khi
tra cứu thất bại. ID chưa phân giải được giữ nguyên với tên rỗng; không suy đoán
danh tính từ nội dung tin hoặc tên hội thoại.

Upsert tin nhắn hiện có thể bổ sung ID dạng số cho người gửi đang thiếu/chỉ có
ID mã hóa và điền tên còn trống khi tin được khôi phục lại. Giữ nguyên danh tính
dạng số đã biết, tên không rỗng, dấu thu hồi, đường dẫn file và trạng thái nhận/đọc
không giảm.

Tên hiển thị hiện tại được tách khỏi tên lưu trên tin nhắn:

- `senderName` khi đó giữ nguyên tên lịch sử/được ghi nhận lần đầu (trong 3.0 giá trị này là `senderZaloName`). Lịch sử từ điện
  thoại không có tên gốc chỉ có thể điền tên còn trống bằng profile tại lúc
  khôi phục; không thể tái dựng tên ở thời điểm gửi trong quá khứ.
- `senderDisplayName` được tra lúc đọc theo UID: alias riêng của tài khoản,
  rồi `zaloName` của profile, rồi UID. `senderDisplayNameSource` khi đó là `alias`,
  `zalo` hoặc `uid` (3.0 thêm `phonebook` và `display`). Không dùng `displayName` có thể chứa bí danh để thay thế
  `zaloName` trong thứ tự này.
- MCP đọc buffer/lịch sử và CLI đọc lịch sử trả thêm các trường trên. CLI dạng
  văn bản hiển thị tên hiện tại. Lượt đọc không sửa SQLite hoặc tên lịch sử
  trong buffer.
- Tên hiện tại khi đó được tra mới theo từng tài khoản, có phân trang alias và
  chia lô profile 100 UID (trong 3.0, daemon giữ một bản chụp alias đầy đủ, được
  thay bằng mỗi lần đọc đầy đủ, xem ở trên). Bỏ toàn bộ snapshot alias không hoàn chỉnh/thất bại;
  profile không khả dụng thì fallback UID thay vì tên lịch sử đã cũ.
- Sync cập nhật tên chat 1-1 đã cache, gồm cả người chưa kết bạn nằm ngoài
  khoảng tin đang khôi phục, không đổi thứ tự hoạt động. Danh sách hội thoại,
  thread và tìm kiếm DM qua MCP cũng làm mới tên. Tên nhóm không bị thay bằng
  alias của thành viên.

## Kiểm tra (2.x)

- Đã phát hành trong bản 2.x qua [PR #2](https://github.com/ardennguyen/zalo-agent-cli/pull/2).
- Test hồi quy: `tests/unit/sync-v2-senders.test.js`, gồm kết quả lịch sử MCP từ
  SQLite và bảo vệ trước danh tính người gửi mâu thuẫn.
- Kiểm tra bắt buộc: `npm run format`, `npm run lint`, `npm run format:check`, `npm test`.
- Đã pass toàn bộ trên Node 24.11.0: 1.922 test đạt, 4 bỏ qua, 0 lỗi
  (`npm test -- --test-concurrency=4`). Test daemon loopback cần chạy ngoài
  sandbox chặn socket. Format và lint không có warning đều đạt.
- Chưa sync tài khoản thật, sửa database production, cập nhật wrapper hoặc
  deploy. Test offline dùng danh tính giả và database cô lập.

## Vận hành và giới hạn

Không cần migration schema. Tin cũ được bổ sung danh tính khi chạy khôi phục
tin nhắn từ điện thoại bằng engine đã sửa. Restart MCP hoặc đọc lịch sử không
tự sửa các dòng cũ. Sao lưu database tài khoản (`zalo-agent db backup -o <file>`; từ 3.0 database được
mã hóa khi lưu) trước khi khôi phục vận hành và dùng tùy chọn `sync-mobile` trong `skill/references/command-reference.md`;
khôi phục cần xác nhận trên điện thoại.

Tra cứu profile theo khả năng đáp ứng. UID đã phân giải dùng chính ID để hiển
thị khi alias/profile không khả dụng. Người gửi còn mã hóa được thử lại trong
lần khôi phục sau, không gọi lại cho từng tin. Việc hiển thị tên hiện tại gọi
thêm REST alias/profile theo lô thay vì từng tin, không tạo listener hoặc thêm
credential tài khoản. Chưa đo rate limit hoặc tải của API thật.
Wrapper tiếp tục dùng engine đã phát hành được ghim phiên bản, cho đến khi quy
trình phát hành/cập nhật thông thường cài phiên bản chứa bản sửa.

Tài liệu hiện có: `README.md`, `docs/deployment.vi.md` (`docs/deployment.md`), `docs/agent-notes.md` và
`skill/references/command-reference.md`.
