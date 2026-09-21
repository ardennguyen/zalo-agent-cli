# Listen Mode — Real-Time Event Monitoring

WebSocket-based event listener with auto-reconnect. Production-safe for months.

## Usage
```bash
zalo-agent listen                                          # Default: messages + friends
zalo-agent listen --filter user --no-self                  # DM only, no self
zalo-agent listen --filter group                           # Groups only
zalo-agent listen --events message,friend,group,reaction   # All event types
zalo-agent listen --auto-accept                            # Auto-accept friend requests
```

## Options
| Flag | Description | Default |
|------|-------------|---------|
| `-e, --events <types>` | message,friend,group,reaction | message,friend |
| `-f, --filter <type>` | user, group, all | all |
| `-w, --webhook <url>` | POST events as JSON to URL | — |
| `--no-self` | Hide your own messages from the OUTPUT (they are still cached) | false |
| `--auto-accept` | Auto-accept friend requests | false |
| `--save <dir>` | Save as JSONL (1 file/thread) | — |

> The default for `-e/--events` is `message,friend` — **`group` and `reaction` events are not printed/forwarded unless you ask for them explicitly.**
>
> **Your own messages are captured.** `zca-js` defaults `selfListen` to off, which drops every event your account authored — from your phone, from Zalo Web, from this CLI — before any handler runs. It is on now, so the cache holds both sides of a conversation instead of only what other people said. `--no-self` hides them from stdout/webhook/JSONL; it does not keep them out of `zalo.db`.
>
> `--events` controls what you **see** (stdout, JSONL, webhook), not what is **stored**. Reactions, recalls, delivery receipts, board changes and "you left this group" are written to `zalo.db` on every run, because none of them can be recovered afterwards — the mobile sync payload has no reaction field at all. Earlier builds gated the writes too, so a default `zalo-agent listen` silently discarded every reaction it saw.

## Side Effects (always on)

`listen` is not read-only. On every run it also:

- **Writes to the local SQLite cache** — every received message is inserted into `~/.zalo-agent-cli/accounts/<ownId>/zalo.db` (tables: `messages`, `threads`, `contacts`, `reactions`, `board_items`, `reminders`, `cloud_items`, `conv_state`, `sync_state`, `sync_gaps`). This is what makes `zalo-agent msg history <id>` fast and able to return more than the ~20 messages the Zalo API hands back. Writes go through the same `core/live-store.js` a running mobile sync uses, so a row captured live is byte-for-byte the row a restore would have written — including the shared type vocabulary (`photo`, not `chat.photo`).
- **Applies both kinds of removal** — Zalo has two, they arrive on different channels, and both are applied to the message they name rather than stored as new ones:

  | | Zalo | Arrives as | Names its target by |
  |---|---|---|---|
  | Recall for everyone | *Thu hồi* (`msg undo`) | the `undo` event | `content.globalMsgId`, else `content.cliMsgId` |
  | Delete for me only | *Xoá ở phía tôi* (`msg delete`) | a `message` event with `msgType: chat.delete` | `content[0].globalDelMsgId`, else `clientDelMsgId` |

  Either way the row becomes the same tombstone the phone itself keeps (`type = deleted`, `text = [deleted]`), the kind is recorded in `raw_data.removedAs`, and `originalType` records what was removed — mirroring the phone's `params.original_type`. `cliMsgId` is preserved, because `msg delete`, `msg undo` and `conv delete` all need it. **Downloaded media goes with the message**: `has_attachment` is cleared, `mediaPrunedAt` is set so no later `sync-media` re-fetches it, and the local file is deleted — the phone strips every CDN reference from a removed message, so keeping our copy would mean holding the one thing that was withdrawn.
- **Records the state that only exists here** — a reaction (`reactions`, keyed on `(msgId, userId, icon)`: Zalo **accumulates**, so one person holding three different icons on one message is three reactions and all three are displayed. A reaction is named by `content.rMsg[].gMsgID`, not by the event's own `msgId`, which identifies the notification. Un-reacting is **all-or-nothing** — the frame is `rIcon: ""` with `rType: -1`, a sentinel rather than a type, and the app offers no way to drop one of several icons — so a removal clears that person's reactions on that message), a delivery/read receipt (`msgStatus`, forward-only: a late "delivered" cannot undo a "seen"), a board change (flags the conversation for the next `sync-boards`), and leaving or being removed from a group (`threads.leftAt`, which is what makes `conv forget --orphans` able to find it).
- **Does not rename your conversations** — a live message carries the *sender's* display name, which is not the conversation's name. A group has exactly one name and no message carries it, so the listener leaves naming to `sync-mobile --transfer` / `sync-boards` (which read it from `getGroupInfo`) and to the MCP server's thread index. It only fills a name in when the two genuinely coincide: a 1-1 message written by the contact that 1-1 is with. A deliberate alias is never overwritten.
- **Auto-downloads media** — attachments land in `~/.zalo-agent-cli/accounts/<ownId>/media/<conversation>/<date>-<HH-mm>_<msgIdTail>_<kind>.<ext>`, fetched by the same downloader `sync-media` uses (per-request deadline, one expired-link renewal attempt, backoff on throttling) and recorded in the row's `localPath`. `listen`, `msg history`, `mcp start` and every sync command share one folder per conversation.
- **Holds an exclusive lock** — `daemon.lock` in the account directory. A second `listen` for the same account is refused, and `account remove` / `logout --purge` refuse while the lock is held. A stale lock (dead PID) is detected and reclaimed automatically.
- **Attempts a gap backfill** — it records connect/disconnect timestamps, and on startup or after a reconnect, if the last known-connected time is more than ~30s old, it automatically triggers the legacy mobile-sync mechanism. **That endpoint has been retired by Zalo, so the automatic backfill recovers nothing** — it reports `legacy-retired` and moves on. Rewiring it to `sync-mobile --transfer` (the path that actually works) is open work. After real downtime, run `zalo-agent sync-mobile --transfer` by hand: stop the listener first (it holds `daemon.lock`), then confirm the prompt on the phone.

## Delivery and read state (`msgStatus`)

`messages.msgStatus` holds Zalo's own `MessageStatus`: `3` sent, `4` received, `5` seen (`0` unspecified; `1`/`2` are transient states the phone never stores). Two rules make it readable:

- **NULL means "we were never told", not "unread".** With Zalo's *Hiện trạng thái "Đã xem"* privacy toggle off, the *seen* signal is suppressed in both directions: an outgoing message can still reach `4` (received) but will never reach `5`. Measured on a real account, outgoing `5` stops dead at the date the toggle was switched off while outgoing `4` keeps flowing. Never render a missing `5` as "they haven't read it".
- **Its meaning depends on direction.** On an incoming message, `5` is *your own* local read state and is unaffected by the toggle. On an outgoing one, `5` would mean the other side read it. Same column, two meanings — a consumer needs the direction to interpret it.

Sources: the mobile sync (per message) and the live `delivered_messages` / `seen_messages` receipts, applied forward-only. The listener does **not** write the live `status` field into this column — that is a different, undocumented enum, which reported `1` ("failed") for messages that had just been sent successfully.

## Webhook Integration
Forward events to n8n, Make, Zapier, or custom endpoint:
```bash
zalo-agent listen --webhook http://n8n.local/webhook/zalo --no-self
```

Each event = 1 POST request with JSON body:
```json
{"event":"message","msgId":"...","threadId":"...","content":"Hello","isSelf":false}
{"event":"friend_request","threadId":"...","data":{"fromUid":"...","message":"Hi"}}
{"event":"group_join","threadId":"...","data":{...}}
{"event":"reaction","threadId":"...","data":{...}}
{"event":"undo","threadId":"...","msgId":"<the RECALLED message>","isSelf":false,"applied":true}
{"event":"deleted_for_me","threadId":"...","msgId":"<the DELETED message>","applied":true}
{"event":"board_changed","threadId":"...","type":"new_pin_topic"}
{"event":"thread_gone","threadId":"..."}
```
Route by `event` field in webhook receiver.

## JSONL Save Mode
```bash
zalo-agent listen --save ./zalo-logs
```
Creates 1 `.jsonl` file per thread. Each line = 1 event JSON. Good for analysis/archival.

## JSON Pipe Mode
```bash
zalo-agent --json listen --no-self | while IFS= read -r line; do
  echo "$line" | jq -r '.content // empty'
done
```

## Production Deployment (pm2)
```bash
npm install -g pm2

# Start
pm2 start "zalo-agent listen --webhook http://n8n.local/webhook/zalo --no-self" \
  --name zalo-listener

# Monitor
pm2 logs zalo-listener
pm2 status

# Auto-start on reboot
pm2 startup && pm2 save
```

## Combining Listen + Send
Both use the same WebSocket connection on the same account:
```bash
# Terminal 1: Listen (background)
zalo-agent listen --webhook http://localhost:3000/events &

# Terminal 2: Send (same account)
zalo-agent msg send <ID> "reply"
```

## Reliability
- **Auto-reconnect:** Reconnects on WebSocket drop
- **Auto re-login:** Re-authenticates on session expiry
- **1 WebSocket/account:** Cannot coexist with browser Zalo, or with `mcp start`, on the same account
- **Event dedup:** in the cache only — `messages.msgId` is the primary key, so a redelivered message updates its row instead of duplicating it. The stdout/JSONL/webhook sinks have no dedup, so a webhook receiver must tolerate seeing the same `msgId` twice
- **Gap recording:** Connection gaps are recorded in `sync_gaps`. The **automatic** backfill that follows uses the retired endpoint and recovers nothing — recovering a real gap means running `sync-mobile --transfer` by hand (see Side Effects above). Don't tell a user their gap was filled automatically

## `listen` vs `mcp start`

Both open the account's single WebSocket, so they cannot run at the same time for one account. Pick by consumer:

| | `listen` | `mcp start` |
|---|---|---|
| Consumer | Webhook endpoint, JSONL files, shell pipeline | An MCP client (Claude Code, Cursor, …) |
| Delivery | Push — one POST/line per event | Pull — agent calls `zalo_get_messages` with a cursor |
| Persistence | Writes every message to `zalo.db` (+ JSONL with `--save`) | **Also writes every message to the same `zalo.db`**, plus an in-memory ring buffer for incremental polling |
| Filtering | `-f/--filter`, `--no-self` | `watchThreads` globs + noise filter in `mcp-config.json` — these filter the *buffer*, not the cache |
| Sending | Separate `msg send` command | `zalo_send_message` tool |
| Lock | Holds `daemon.lock` | Holds `daemon.lock` too |

Both hold the account's `daemon.lock`, so starting one while the other runs is refused with a clear message instead of letting Zalo silently kill one of the two sockets. Pick one per account: `mcp start` is now a superset for storage — it keeps the same durable cache `listen` does, so an agent gets both durable history (`zalo_get_history`, `msg history`) and live polling from one process.
