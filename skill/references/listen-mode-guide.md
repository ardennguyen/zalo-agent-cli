# Listen Mode — Real-Time Event Monitoring

WebSocket-based event listener with auto-reconnect. Production-safe for months.

## Usage
```bash
zalo-agent listen                                          # Default: messages + friends
zalo-agent listen --filter user --no-self                  # DM only, no self
zalo-agent listen --filter group                           # Groups only
zalo-agent listen --events message,friend,group,reaction,read   # All event types
zalo-agent listen --auto-accept                            # Auto-accept friend requests
```

## Options
| Flag | Description | Default |
|------|-------------|---------|
| `-e, --events <types>` | message,friend,group,reaction,read | message,friend |
| `-f, --filter <type>` | user, group, all | all |
| `-w, --webhook <url>` | POST events as JSON to URL | — |
| `--no-self` | Hide your own messages from the OUTPUT (they are still cached) | false |
| `--auto-accept` | Auto-accept friend requests | false |
| `--save <dir>` | Save as JSONL (1 file/thread) | — |

> The default for `-e/--events` is `message,friend` — **`group`, `reaction` and `read` events are not printed/forwarded unless you ask for them explicitly.**
>
> **Your own messages are captured.** `zca-js` defaults `selfListen` to off, which drops every event your account authored — from your phone, from Zalo Web, from this CLI — before any handler runs. It is on now, so the cache holds both sides of a conversation instead of only what other people said. `--no-self` hides them from stdout/webhook/JSONL; it does not keep them out of `zalo.db`.
>
> `--events` controls what you **see** (stdout, JSONL, webhook), not what is **stored**. Reactions, recalls, delivery receipts, board changes, read state reported by your other devices and "you left this group" are written to `zalo.db` on every run, because none of them can be recovered afterwards — the mobile sync payload has no reaction field at all. Earlier builds gated the writes too, so a default `zalo-agent listen` silently discarded every reaction it saw.

## Side Effects (always on)

`listen` is not read-only. On every run it also:

- **Writes to the local SQLite cache** — every received message is inserted into `~/.zalo-agent-cli/accounts/<ownId>/zalo.db` (tables: `messages`, `threads`, `contacts`, `reactions`, `board_items`, `reminders`, `cloud_items`, `conv_state`, `sync_state`, `sync_gaps`). This is what makes `zalo-agent msg history <id>` fast and able to return more than the ~20 messages the Zalo API hands back. Writes go through the same `core/live-store.js` a running mobile sync uses, so a row captured live is byte-for-byte the row a restore would have written — including the shared type vocabulary (`photo`, not `chat.photo`).
- **Applies both kinds of removal** — Zalo has two, they arrive on different channels, and both are applied to the message they name rather than stored as new ones:

  | | Zalo | Arrives as | Names its target by |
  |---|---|---|---|
  | Recall for everyone | *Thu hồi* (`msg undo`) | the `undo` event | `content.globalMsgId`, else `content.cliMsgId` |
  | Delete for me only | *Xoá ở phía tôi* (`msg delete`) | a `message` event with `msgType: chat.delete` | `content[0].globalDelMsgId`, else `clientDelMsgId` |

  Either way the row becomes the same tombstone the phone itself keeps (`type = deleted`, `text = [deleted]`), the kind is recorded in `raw_data.removedAs`, and `originalType` records what was removed — mirroring the phone's `params.original_type`. `cliMsgId` is preserved, because `msg delete`, `msg undo` and `conv delete` all need it. **Downloaded media goes with the message**: `has_attachment` is cleared, `mediaPrunedAt` is set so no later `sync-media` re-fetches it, and the local file is deleted — the phone strips every CDN reference from a removed message, so keeping our copy would mean holding the one thing that was withdrawn.
- **Records the state that only exists here** — a reaction (`reactions`, keyed on `(msgId, userId, icon)`: Zalo **accumulates**, so one person holding three different icons on one message is three reactions and all three are displayed. A reaction is named by `content.rMsg[].gMsgID`, not by the event's own `msgId`, which identifies the notification. Existing reactions are **retrievable** with `zalo-agent sync-reactions` (socket cmd 610/611, the same channel Zalo Web asks on every connect) — a transfer sync cannot restore them, but the socket can. Un-reacting is **all-or-nothing** — the frame is `rIcon: ""` with `rType: -1`, a sentinel rather than a type, and the app offers no way to drop one of several icons — so a removal clears that person's reactions on that message), a delivery/read receipt (`msgStatus`, forward-only: a late "delivered" cannot undo a "seen"), a board change (flags the conversation for the next `sync-boards`), and leaving or being removed from a group (`threads.leftAt`, which is what makes `conv forget --orphans` able to find it).
- **Keeps read state in step with your other devices** — when the account reads a conversation anywhere (the phone, Zalo Web, `conv read`), Zalo reports it on the socket as a `clearUnreads` row naming the conversation and the newest message read: on cmd 504 (1-1) or 524 (group), and as a field of every chat envelope and offline-queue page. zca-js drops all of it. The listener stores it as the conversation's read watermark, `conv_state.lastReadMsgId` / `lastReadTs`, which only moves forward — the same read is reported more than once, and an offline page can arrive after a newer push. A row reporting a folder or the message-request box as seen is not a conversation read and is skipped, as Zalo Web skips it. An unread mark set or cleared on another device (the cmd 601 `mark_unread` control) updates `conv_state.unreadMarked`. `--events read` prints both, as `read` and `unread_mark` events, each naming the socket `cmd` that carried it. Not yet measured live: which cmd a read on the phone arrives on, and whether `conv read` is echoed back to the listener.
- **Does not rename your conversations** — a live message carries the *sender's* display name, which is not the conversation's name. A group has exactly one name and no message carries it, so the listener leaves naming to `sync` / `sync-mobile` / `sync-boards` (which read it from `getGroupInfo`) and to the MCP server's thread index. It only fills a name in when the two genuinely coincide: a 1-1 message written by the contact that 1-1 is with. A deliberate alias is never overwritten.
- **Auto-downloads media** — attachments land in `~/.zalo-agent-cli/accounts/<ownId>/media/<threadId>/<date>-<HH-mm>_<msgIdTail>_<kind>.<ext>`, fetched by the same downloader `sync-media` uses (per-request deadline, one expired-link renewal attempt, backoff on throttling) and recorded in the row's `localPath`. `listen`, `msg history`, `mcp start` and every sync command share one folder per conversation.
- **Holds an exclusive lock** — `daemon.lock` in the account directory. A second `listen` for the same account is refused, and `account remove` / `logout --purge` refuse while the lock is held. A stale lock (dead PID) is detected and reclaimed automatically.
- **Records coverage gaps, then heals them itself** — it records connect/disconnect timestamps, and on startup (for the time since the last known-connected moment, anything of a second or more) or after a reconnect, it files the window in `sync_gaps`. Then, as Zalo Web does on every connect, it asks Zalo's offline message queues on its own socket for everything after the newest message it stored, and writes what comes back insert-if-absent (shown as `[catch-up]`). No phone tap, and live capture continues throughout. A gap is resolved only for the window that catch-up actually covered; whatever it cannot reach stays pending and is printed with the exact command that restores it, e.g. `zalo-agent sync --from 2026-09-25` (dated from the gap's own start; if older gaps are still pending it also names the single wider run that clears them all). That command is the phone-backed restore, which the daemon never starts on its own — no daemon restart should buzz the owner's phone unprompted. Run it by hand and **leave the listener running**: `sync` performs the restore on the daemon's own socket over its loopback channel. Just confirm the prompt on the phone; a completed run resolves the gap automatically. `--no-self-heal` turns the catch-up off (gaps are then only recorded and reported).

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
- **1 WebSocket/account:** Cannot coexist with browser Zalo, or with `mcp start`, on the same account. `msg send-file`/`send-image` and `zalo-agent sync` do not need a second one — a running daemon does that work on this socket and keeps listening
- **Event dedup:** in the cache only — `messages.msgId` is the primary key, so a redelivered message updates its row instead of duplicating it. The stdout/JSONL/webhook sinks have no dedup, so a webhook receiver must tolerate seeing the same `msgId` twice
- **Gap recording:** Connection gaps are recorded in `sync_gaps`, and the daemon **heals what it can itself**: on every connect it pulls Zalo's offline message queues and resolves a gap for the window that catch-up actually covered (see Side Effects above). What it cannot reach — a queue Zalo dropped or reset, or anything from before this login — stays `pending`, printed with the `zalo-agent sync --from <date>` run that closes it; that run is phone-backed and is never started automatically. Don't tell a user a gap was filled unless it shows as resolved. A pending gap stays `pending` until a completed `sync` covering it resolves it

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
