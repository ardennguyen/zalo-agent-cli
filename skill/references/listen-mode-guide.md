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
| `--no-self` | Exclude self-sent messages | false |
| `--auto-accept` | Auto-accept friend requests | false |
| `--save <dir>` | Save as JSONL (1 file/thread) | — |

> The default for `-e/--events` is `message,friend` — **`group` and `reaction` events are not emitted unless you ask for them explicitly.**

## Side Effects (always on)

`listen` is not read-only. On every run it also:

- **Writes to the local SQLite cache** — every received message is inserted into `~/.zalo-agent-cli/accounts/<ownId>/zalo.db` (tables: `messages`, `threads`, `contacts`, `sync_state`, `sync_gaps`). This is what makes `zalo-agent msg history <id>` fast and able to return more than the ~20 messages the Zalo API hands back.
- **Auto-downloads media** — images, audio, and video land in `~/.zalo-agent-cli/accounts/<ownId>/media/`, organized per thread with date/sender in the filename.
- **Holds an exclusive lock** — `daemon.lock` in the account directory. A second `listen` for the same account is refused, and `account remove` / `logout --purge` refuse while the lock is held. A stale lock (dead PID) is detected and reclaimed automatically.
- **Backfills gaps** — it records connect/disconnect timestamps, and on startup or after a reconnect, if the last known-connected time is more than ~30s old, it automatically triggers the same mobile-sync mechanism as `zalo-agent sync-mobile` to pull whatever the phone has that the daemon missed.

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
- **Event dedup:** Built-in msgId tracking
- **Gap recovery:** Connection gaps are recorded in `sync_gaps` and backfilled from the phone via mobile sync

## `listen` vs `mcp start`

Both open the account's single WebSocket, so they cannot run at the same time for one account. Pick by consumer:

| | `listen` | `mcp start` |
|---|---|---|
| Consumer | Webhook endpoint, JSONL files, shell pipeline | An MCP client (Claude Code, Cursor, …) |
| Delivery | Push — one POST/line per event | Pull — agent calls `zalo_get_messages` with a cursor |
| Persistence | Writes every message to `zalo.db` + JSONL | In-memory ring buffer only (lost on restart) |
| Filtering | `-f/--filter`, `--no-self` | `watchThreads` globs + noise filter in `mcp-config.json` |
| Sending | Separate `msg send` command | `zalo_send_message` tool |

If an agent needs both durable archival and MCP tool access, run `mcp start` and use `zalo_get_history` / `msg history` for anything older than the buffer.
