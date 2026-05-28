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
- **1 WebSocket/account:** Cannot coexist with browser Zalo on same account
- **Event dedup:** Built-in msgId tracking
