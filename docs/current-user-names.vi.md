# Danh tính người gửi và tên hiện tại

[English](current-user-names.md)

Trang này nói cách client gọi tên một người trong mọi đầu ra. Khi trang này và [command reference](../skill/references/command-reference.md) khác nhau, command reference là bản đúng.

## Cách gọi tên trong 3.0: alias trước tiên, ở mọi nơi

Mọi đầu ra gọi tên một người giống Zalo: **alias mà chủ tài khoản đặt cho họ**, rồi tên trong danh bạ (chỉ khi nơi
gọi truyền vào: client này không đọc danh sách danh bạ), rồi **tên liên hệ**, rồi tên Zalo, rồi tên hiển thị, rồi UID
(`src/core/contact-names.js`). Tên liên hệ là `displayName` của profile khi nó khác `zaloName`: danh sách bạn bè và các
lần đọc profile của Zalo trả về tên mà tài khoản biết người đó (khi không có alias, thường là tên trong danh bạ điện
thoại của chủ tài khoản), và đó là tên Zalo hiển thị cho chủ tài khoản. Daemon giữ các tên liên hệ này trong `zalo.db`
(`user_contact_names`), để tin nhắn, mention hay danh sách thành viên gọi tên người đó giống vậy mà không cần gọi Zalo,
và tiêu đề chat 1-1 đã lưu đổi theo khi tên liên hệ đổi. Quy tắc này áp dụng cho các dòng của `listen`, JSONL và webhook, bộ đệm MCP, notifier và
kết quả chờ, mọi phản hồi `zalo_*`, `msg history` / `msg search`, danh sách `conv`, các lệnh `friend` và
`group`, mention, tin được trích dẫn (`replyTo`), reaction, đang gõ và sự kiện nhóm.

| Trường | Có trên tin nhắn | Ý nghĩa |
|---|---|---|
| `senderName` | có | tên để hiển thị: alias của chủ tài khoản nếu có, không thì tên liên hệ, không thì tên mà tin mang theo, không nữa thì tên profile hiện tại. **Đổi nghĩa trong 3.0:** trước đây là tên mà tin mang theo |
| `senderAlias` | có | alias, hoặc `null` |
| `senderZaloName` | có | tên mà tin mang theo (bản lưu, không bao giờ bị ghi đè) |
| `senderDisplayName`, `senderDisplayNameSource` | có | tên hiện tại và nguồn của nó: `alias`, `phonebook`, `contact`, `zalo`, `display` hoặc `uid` |
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

## Tin nhắn khôi phục từ điện thoại

Lần khôi phục từ điện thoại (`zalo-agent sync`) phân giải từng người gửi trước khi lưu một lô: danh tính của chat 1-1
lấy từ bảng ánh xạ hội thoại, của người khác lấy bằng cách tra profile theo lô. Danh tính nhóm không bao giờ thành tên
người gửi, và không suy đoán danh tính từ nội dung tin hay tên hội thoại. Người gửi chưa phân giải được giữ nguyên ID
với tên rỗng và được thử lại ở lần khôi phục sau; lần khôi phục sau cũng có thể điền ID còn thiếu hoặc tên còn trống,
nhưng không bao giờ thay ID đã biết hay tên đã lưu.

## Ghi chú

- Tin khôi phục không mang tên gốc của người gửi sẽ nhận tên profile tại lúc khôi phục; tên trong quá khứ không được
  tái dựng.
- Tra cứu profile theo khả năng đáp ứng: khi không có alias hay profile, một người được hiển thị bằng ID.
- Hiển thị tên hiện tại gọi thêm alias và profile theo lô, không bao giờ một lần gọi cho mỗi tin, và không mở listener
  thứ hai.
- Các dòng đã có chỉ được bổ sung bởi lần khôi phục sau; khởi động lại MCP server hay đọc lịch sử không ghi lại chúng.
  Hãy sao lưu database tài khoản trước (`zalo-agent db backup -o <file>`); khôi phục cần chạm xác nhận trên điện thoại.
