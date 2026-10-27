# Configuration cookbook — `.env`, `mcp-config.json` and the setups worth running

> **Status:** verified against `zalo-agent-cli` `2.5.6`. Every file shown here exists, ready to copy, under [`docs/config-samples/`](config-samples/), and `tests/unit/config-samples.test.js` holds each one to the code: every `mcp-config.json` key is one the loader merges, every environment variable is one a source file reads, and the CRM receiver verifies a signature produced by the real webhook sender. Vietnamese: [`configuration.vi.md`](configuration.vi.md).

Two kinds of file configure a server, and they answer different questions:

| File | Holds | Format |
|---|---|---|
| `.env` | **Where and how this process runs**: storage directories, host, port, tokens, TLS, webhook URL and secret. Anything per machine or per account, and anything secret | `NAME=value` lines |
| `mcp-config.json` | **What the server watches and how it behaves**: which threads, buffer sizes, notifications, OAuth consumers, per-account overrides | JSON |

Secrets belong in `.env` (mode `0600`), not in `mcp-config.json`, and never on the command line: **a flag is visible to every user on the machine in `ps`**, an environment variable is not.

---

## 1. Where each file lives, and who reads it

| Location | Read by | Use it for |
|---|---|---|
| `<CONFIG_DIR>/.env` — default `~/.zalo-agent-cli/.env` | **every** `zalo-agent` / `zalo-mcp` command on the machine, from any directory | per-machine settings: data directories, `ZALO_AGENT_NO_UPDATE_CHECK`, defaults for all accounts. [`env/config-dir.env`](config-samples/env/config-dir.env) |
| `--env-file <path>` (or `ZALO_ENV_FILE`) | that one command | a service's own file: `/etc/zalo-mcp/<name>.env`, a container's `--env-file`. [`env/lan-server.env`](config-samples/env/lan-server.env), [`env/internet-server.env`](config-samples/env/internet-server.env), [`env/crm-backend.env`](config-samples/env/crm-backend.env) |
| `./.env` in the working directory | any `zalo-agent` started from that directory | avoid: it silently changes behavior depending on where you `cd`. Never put secrets here |
| `zalo-mcp/.env` in the wrapper's folder | the `zalo-mcp` launcher, before it starts the engine | **ports only**: [`env/wrapper-folder.env`](config-samples/env/wrapper-folder.env) |
| a systemd `EnvironmentFile=`, a shell `export`, a container's `-e` | the process as a real environment variable | the same names; these always win over every file above |
| `<CONFIG_DIR>/mcp-config.json` | `mcp start` (and `mcp wait` / the tools it serves) | the shared base for every account on the machine |
| `mcp start --config <path>` | that server | a second config for one service. It must exist and be valid JSON, or the server **refuses to start** (a missing file would otherwise mean "watch every thread"). It replaces the base file and the per-account file below |
| `accounts.<ownId>` block inside `mcp-config.json` | the server for that account | per-account overrides in one file: [`mcp-config/multi-account.json`](config-samples/mcp-config/multi-account.json) |
| `<accountDir>/mcp-config.json` — `~/.zalo-agent-cli/accounts/<ownId>/` | the server for that account | a per-account file; refused at start if present but unreadable |

### Precedence

**Environment files** are merged without overwriting: the first source that defines a name wins, in this order: the real process environment, `--env-file`, `./.env`, `<CONFIG_DIR>/.env`. (`zalo-mcp/.env` is loaded by the launcher the same way: it fills names that are not already set.)

**A setting** is resolved per account, highest first:

1. the command-line flag (`--http`, `--host`, `--auth`, `--webhook`, …)
2. `NAME_<ownId>` in the environment, e.g. `ZALO_MCP_HTTP_PORT_1000000000000000001`
3. `NAME` in the environment
4. `mcp-config.json`, later layers over earlier: the base file, then its `accounts.<ownId>` block, then `<accountDir>/mcp-config.json`
5. the built-in default

[`env/multi-account.env`](config-samples/env/multi-account.env) shows rule 2 over 3 in one file.

---

## 2. Reference

### Environment variables

`_<ownId>` in the third column means the name also exists with the account's id appended (rule 2 above).

| Variable | `_<ownId>` | Meaning | Flag | `mcp-config.json` |
|---|:-:|---|---|---|
| `ZALO_CONFIG_DIR` |  | root: `accounts.json`, `mcp-config.json`, credentials. Default `~/.zalo-agent-cli` | `--config-dir` |  |
| `ZALO_CREDENTIALS_DIR` |  | credential files. Default `<CONFIG_DIR>/credentials` | `--credentials-dir` |  |
| `ZALO_DATA_DIR` (alias `ZALO_DB_DIR`) |  | per-account databases and runtime files. Default `<CONFIG_DIR>/accounts` | `--data-dir` |  |
| `ZALO_MEDIA_DIR` |  | downloaded media root | `--media-dir` | `media.downloadDir` (MCP server only) |
| `ZALO_OA_DIR` |  | Official Account credentials. Default `~/.zalo-agent` | `--oa-dir` |  |
| `ZALO_ACCOUNT` |  | account for one-shot commands | `--account` |  |
| `ZALO_ENV_FILE` |  | an extra `.env` to load | `--env-file` |  |
| `ZALO_MCP_HTTP_PORT` | yes | serve HTTP/HTTPS on this port instead of stdio | `--http` | `httpPort` |
| `ZALO_MCP_HOST` | yes | bind address. Default `127.0.0.1` | `--host` | `host` |
| `ZALO_MCP_AUTH_TOKEN` | yes | bearer token for `/mcp` and `/events/wait` | `--auth` (visible in `ps`; prefer the variable) |  |
| `ZALO_MCP_TLS_CERT`, `ZALO_MCP_TLS_KEY` | yes | serve HTTPS; both or neither | `--cert`, `--key` | `tls.cert`, `tls.key` |
| `ZALO_MCP_OAUTH_CLIENT_ID`, `ZALO_MCP_OAUTH_CLIENT_SECRET` | yes | the primary OAuth client (the secret also works as a bearer token) | `--client-id`, `--client-secret` | `oauth.clientId`, `oauth.clientSecret` |
| `ZALO_MCP_ISSUER_URL` | yes | the public `https://` address OAuth metadata advertises | `--issuer-url` | `oauth.issuerUrl` |
| `ZALO_WEBHOOK_URL` | yes | POST each incoming message here | `-w`, `--webhook` | `webhook` |
| `ZALO_WEBHOOK_SECRET` | yes | sign the webhook (`Authorization: Bearer` + `X-Zalo-Signature: sha256=…`) | `--webhook-secret` (visible in `ps`) | `webhookSecret` |
| `ZALO_WEBHOOK_BATCH_SIZE` | yes | events per webhook POST, 1–100. The default, 1, sends each event alone | | `webhookBatchSize` |
| `ZALO_WEBHOOK_MAX_AGE` | yes | how long an undelivered event is retried before it is dead-lettered (`6h`, `24h`; at least `1m`). Default `24h` | | `webhookMaxAge` |
| `ZALO_MCP_GROUP_CONFIRM` |  | `0` lets `zalo_group` leave / remove members without `confirm: true` | | `groupConfirm` |
| `ZALO_SYNC_NAME_REFRESH_MAX` |  | non-friend DM names one sync restore may look up. Default 500 | | |
| `ZALO_START_JITTER` | yes | wait a random time up to this many seconds (0–600, default 0) before logging in, so a fleet restarting together does not log in together | | |
| `ZALO_LOGIN_SLOTS` | yes | at most this many daemons on the machine logging in and loading their lists at once (0–64; default 0, no cap); the rest wait for a slot. `ZALO_LOGIN_SLOT_WAIT` (seconds, default 900) is how long one waits before going ahead anyway | | |
| `ZALO_LOG_LEVEL` | yes | `error`, `warn`, `info` (default) or `debug` (adds a line per HTTP request and per message) | `--log-level` | |
| `ZALO_LOG_FORMAT` |  | `text` (default, timestamped lines) or `json` (one object per line) | | |
| `ZALO_LOG_MAX_SIZE`, `ZALO_LOG_KEEP` |  | rotate `daemon.log` at this size (default `50m`, at least `4k`) and keep this many files (default 3) | | |
| `ZALO_AGENT_NO_UPDATE_CHECK` |  | any value: never run the `npm view` update check | | |
| `ZALO_API_VERSION` |  | protocol version announced to Zalo. Default 694 | | |
| `ZALO_QR_FLOW` |  | which QR login `login` uses: `official` (default: the sequence Zalo Web makes, no `verify-client`, `continue=https://chat.zalo.me/`, the redirects through `jr.zaloapp.com` and `jr.chat.zalo.me`, and the second QR an account with a trusted device is asked to scan, which makes this client a trusted companion device) or `legacy` (zca-js's own). Any other value is refused before Zalo is contacted | | |
| `ZALO_NET_PROBE` |  | what a daemon asks to learn whether the network is up while its socket is down (every 10 s): a URL, default a global search engine's lightweight page, or `off` to assume the network is always up and contact nothing but Zalo | | |

`oa listen` takes its port from `--port` (default 3000). The engine does not read `ZALO_OA_WEBHOOK_PORT`, although older copies of the wrapper's `.env.example` listed it.

### `mcp-config.json` keys

| Key | Default | Meaning |
|---|---|---|
| `watchThreads` | `["dm:*", "group:*"]` | which conversations are buffered: `dm:*`, `group:*`, `dm:<id>`, `group:<id>` |
| `triggerKeywords` | `["@bot"]` | words that mark a message as needing attention |
| `limits.maxMessagesPerPoll` | 20 | most messages one `zalo_get_messages` returns |
| `limits.autoDigestThreshold` | 50 | unread count above which tools return a digest |
| `limits.bufferMaxAge` | `"2h"` | how long a message stays in the live buffer |
| `limits.bufferMaxSize` | 500 | messages kept **per thread** in the live buffer |
| `media.downloadDir` | `null` | media root for this server |
| `media.autoOpen` | `true` | open downloaded media on this machine; set `false` on a server |
| `notify.enabled`, `.thread`, `.on`, `.cooldown` | off | notify a Zalo group when the agent is away |
| `webhook`, `webhookSecret` | `null` | push each message to a URL, signed (prefer `ZALO_WEBHOOK_SECRET`) |
| `webhookBatchSize` | `1` | events per webhook POST (1–100) |
| `webhookMaxAge` | `"24h"` | an undelivered webhook event older than this is dead-lettered |
| `httpPort`, `host` | `null` | HTTP port and bind address |
| `tls.cert`, `tls.key` | `null` | HTTPS |
| `oauth.clientId`, `.clientSecret`, `.issuerUrl`, `.clients[]` | | OAuth 2.0 consumers; `clients[]` is a list of `{clientId, clientSecret}` |
| `groupConfirm` | `true` | `zalo_group` needs `confirm: true` before `leave` / `remove_member` |
| `accounts.<ownId>` | | any of the above, for one account |

A key that is not in this table is ignored without a message. (The `mode` key in older files is accepted and never read.)

---

## 3. Recommended setups

Each setup lists the files and the commands. Replace `1000000000000000001` with the account id from `zalo-agent account list`, and every `CHANGE_ME…` with a value from `openssl rand -hex 32`.

### 3.1 Local · AI agent · stdio

For Claude Code, Claude Desktop or Cursor on the machine that holds the account. No port, no token: the client starts the server and talks to it over stdin/stdout.

- Files: none required. Optional [`mcp-config/local-agent.json`](config-samples/mcp-config/local-agent.json) at `~/.zalo-agent-cli/mcp-config.json`.
- Client: [`clients/claude-code-stdio.json`](config-samples/clients/claude-code-stdio.json) (`~/.claude/settings.json`, or the client's equivalent).
- Several accounts: one server entry per account, each with its own `--account`.

### 3.2 Local · same machine · HTTP on loopback

For a backend, n8n or a container on the same host that cannot use stdio.

```bash
ZALO_MCP_HTTP_PORT=3847 ZALO_MCP_AUTH_TOKEN=CHANGE_ME_64_HEX_CHARACTERS \
  zalo-agent mcp start --account 1000000000000000001
```

- The default bind is `127.0.0.1`: nothing off the machine can connect. **Still set a token**: any local user, and any web page in a browser on the machine, can otherwise reach it (the server answers every origin).
- A Docker container reaches a loopback-bound server through `host.docker.internal` on Docker Desktop (Windows, macOS). On Linux, give the container `--add-host=host.docker.internal:host-gateway` and bind to the Docker bridge address (`ZALO_MCP_HOST=172.17.0.1`) rather than `0.0.0.0`.
- Use [`env/crm-backend.env`](config-samples/env/crm-backend.env) as the starting point and remove the webhook lines if you do not need them.

### 3.3 LAN · AI agents and a CRM on other machines

```bash
zalo-agent --env-file /etc/zalo-mcp/lan.env mcp start --account 1000000000000000001
```

- Files: [`env/lan-server.env`](config-samples/env/lan-server.env) and, if you want one, [`mcp-config/lan.json`](config-samples/mcp-config/lan.json).
- Bind to the LAN address (`ZALO_MCP_HOST=192.168.1.20`), not `0.0.0.0` on a multi-homed host. **The token is mandatory**: without one the server prints `WARNING: no --auth token` and serves anyone who can reach the port.
- Firewall the port to the subnet as well (`ufw allow from 192.168.1.0/24 to any port 3847`).
- HTTP on a trusted LAN is acceptable; if the LAN is shared, add TLS with `ZALO_MCP_TLS_CERT` / `ZALO_MCP_TLS_KEY` (a certificate from your own CA or `mkcert`).
- A client uses `http://192.168.1.20:3847/mcp` with `Authorization: Bearer <token>`.

### 3.4 Internet · AI agents (claude.ai connectors, remote agents)

Keep the engine on loopback and put a TLS reverse proxy in front of it.

- Files: [`env/internet-server.env`](config-samples/env/internet-server.env), [`mcp-config/internet.json`](config-samples/mcp-config/internet.json), and one proxy sample: [`proxy/Caddyfile.internet`](config-samples/proxy/Caddyfile.internet) or [`proxy/nginx.internet.conf`](config-samples/proxy/nginx.internet.conf).
- The proxy must not buffer responses and must allow reads of at least 310 s: `/events/wait` holds a request for up to 300 s. Both samples are tested for it.
- **Authentication:** a bearer token for scripts and backends; OAuth 2.0 for remote connectors that insist on it. Set `ZALO_MCP_ISSUER_URL` to the public `https://` address. Without it the OAuth metadata and the `WWW-Authenticate` header are built from the request's own `X-Forwarded-Host` / `Host` headers, which any client can set. More than one consumer: list them in `oauth.clients[]` in `mcp-config.json`.
- Native HTTPS (`--cert` / `--key`) without a proxy works, but the engine **also tries to listen on port 443** next to your port. Prefer the proxy.
- Add what the engine does not have: an IP allow-list at the proxy, rate limiting, and a log that never records the `Authorization` header. The server answers every origin with `Access-Control-Allow-Origin: *`; strip or replace the header at the proxy if browsers should not call it.

### 3.5 Backend for a CRM

A CRM needs three things from an account: to **hear** new messages, to **send**, and to **catch up** after its own downtime. They are three different mechanisms.

**Hear: push by webhook.** Files: [`env/crm-backend.env`](config-samples/env/crm-backend.env), [`mcp-config/crm-backend.json`](config-samples/mcp-config/crm-backend.json).

- `mcp start` posts `{event: "message", accountId, id, threadId, threadType, senderId, senderName, text, timestamp, type, attachment, replyTo}` for each message that passes `watchThreads`. `listen -w` posts a different, richer shape (`{accountId, event, msgId, threadId, type, isSelf, uidFrom, dName, msgType, content, …}`) and also friend, group, reaction and read events. Pick one per account.
- Every delivery carries `Authorization: Bearer <secret>` and `X-Zalo-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. Verify the signature over the **raw** bytes: [`clients/crm-webhook-receiver.mjs`](config-samples/clients/crm-webhook-receiver.mjs) (Node) and [`clients/crm_webhook_receiver.py`](config-samples/clients/crm_webhook_receiver.py) (Python) do.
- **Delivery is durable, ordered and at least once.** Each event is written to `webhook-outbox.db` in the account directory before anything sends it, so a receiver that is down, slow (a POST has 10 seconds) or answering anything but 2xx costs a backlog, not messages: the sender retries with waits of 1 s doubling to 5 min, holds everything behind a failing event so order is kept, and carries on after a restart or crash. A payload the receiver refuses as malformed (400, 413, 422) is parked as a **dead letter**, and so is any event still undelivered after `ZALO_WEBHOOK_MAX_AGE` (24 h). Watch it with `zalo-agent mcp webhook status`, look with `mcp webhook list --dead`, and put events back with `mcp webhook retry`.
- **Acknowledge with 2xx at once, do the work afterwards, and de-duplicate on the message id.** At least once means a message can arrive twice (a crash after your reply, before the sender noted it). Every POST has `X-Zalo-Attempt`, and `X-Zalo-Delivery: <first>-<last>` (outbox numbers).
- **Batching.** With `ZALO_WEBHOOK_BATCH_SIZE=10` up to ten queued events go in one POST as `{"event":"batch","accountId":…,"count":N,"events":[…]}`, signed over the whole body; a lone event is still the plain payload. The sample receivers handle both. Turn it on when a backlog or many accounts make one POST per message too many.

**Hear: pull.** `GET /events/wait?timeout=55&since=<cursor>&limit=50` returns up to `limit` buffered messages per call (default 1, at most 100), or `{"status":"timeout"}`, with a cursor to resume from. The reply has `messages` (in order), `count`, `hasMore` and `cursor`, the **last** message's, so `since=<cursor>` continues exactly where the batch ended; `message` is still the first, so a client that sends no `limit` sees what it always did. Drain a backlog by calling again at once while `hasMore` is true; `settle=200` (ms, at most 5000) waits that long after the first message so a burst lands in one reply. The same `limit` and `settleMs` exist on the `zalo_wait_for_message` tool and as `mcp wait --limit --settle`. The buffer behind it holds up to `limits.bufferMaxSize` messages per thread for `limits.bufferMaxAge` (the CRM sample raises both to 2,000 and 6 h). Past that, read the cache with `zalo_get_history` / `zalo_get_messages`.

**Send.** A JSON-RPC call to `POST /mcp`: [`clients/crm-send-message.sh`](config-samples/clients/crm-send-message.sh). Send `Accept: application/json, text/event-stream` (without both the server answers 406); the reply is one SSE `data:` line, and a successful send returns `{"success":true,"messageId":…,"cliMsgId":…,"threadType":…}`. `threadId` is a user id for a direct message or a group id for a group. Each `/mcp` request builds a fresh server with all 25 tools, which costs a few milliseconds of CPU: fine for a CRM, and the reason one account tops out at roughly 60–170 requests/s (see [`docs/deployment.md`](deployment.md) §1.4).

**Catch up.** After downtime, ask for what was missed: `zalo_get_history` per thread, or `zalo-agent sync --from <date>` (which can ask the owner's phone to confirm).

### 3.6 Many accounts

One account is one process, one WebSocket, one SQLite file and one port: there is no multi-account mode inside a process. Run one **systemd instance per account** with its own env file:

- [`systemd/zalo-mcp@.service`](config-samples/systemd/zalo-mcp@.service): the instance name is the account id; the token and port come from `/etc/zalo-mcp/accounts/<id>.env`, so nothing secret is on the command line. Instances start staggered over 30 s (every start logs in and loads the account's lists; a fleet starting together is its heaviest moment) and each is capped at 600 MB (an idle one is about 100 MB).
- [`systemd/common.env`](config-samples/systemd/common.env) for what all share, [`env/account.env`](config-samples/env/account.env) per account.
- **`zalo-agent fleet generate --out <dir>`** writes all of the above for every registered account (unit, env files with a generated token each, port table, optionally the Caddyfile); `fleet status` shows every daemon in one table, `fleet start` / `restart` bring them up in shuffled batches, and `fleet restart --unhealthy` restarts only the ones that are down (see [`docs/deployment.md`](deployment.md) §4.8).
- A port plan, e.g. `3900 + n`, kept in one table (`fleet ports` keeps it for you). Behind one hostname: [`proxy/Caddyfile.multi-account`](config-samples/proxy/Caddyfile.multi-account) routes `/a/<ownId>/…` to the right port; use bearer tokens, one per account.
- Give each account **its own proxy** at login (`zalo-agent login --proxy …`) and its own device fingerprint (automatic): hundreds of accounts from one address is what gets accounts banned.
- Shared settings in `mcp-config.json`, per-account differences in its `accounts` block ([`mcp-config/multi-account.json`](config-samples/mcp-config/multi-account.json)).
- Read §1.4 of [`docs/deployment.md`](deployment.md) and the scaling notes in `docs/agent-notes.md` before going past a few dozen accounts.

---

## 4. Checklist before exposing a port

| Check | Why |
|---|---|
| a token is set (`ZALO_MCP_AUTH_TOKEN`), 32+ random bytes | with none, the server serves anyone who can reach it, and says so only in the log |
| the token is in an env file at `0600`, not in a flag | a flag shows in `ps` and `/proc/<pid>/cmdline`; the daemon's own log line masks it, `ps` does not |
| `ZALO_MCP_HOST` is `127.0.0.1` behind a proxy, a specific LAN address otherwise | `0.0.0.0` listens on every interface, including a public one |
| TLS terminates at the proxy, or `--cert`/`--key` are set | a bearer token over plain HTTP is readable on the wire |
| the proxy does not log `Authorization` and does not buffer `/events/wait` | tokens in logs; long-polls cut at the proxy's timeout |
| `GET /health` and `GET /ready` are the only unauthenticated routes | they say whether the process answers and whether the Zalo socket is up, nothing about the account. `/status` and `/metrics` are behind the token: do not publish them through the proxy |
| one process per account, never two for the same account | a second session closes the first (code 3000) |

## 5. Verify a setup

```bash
# up, and the token is enforced (expect 200, 401, 401):
curl -s -o /dev/null -w '%{http_code}\n' http://HOST:PORT/health
# the Zalo socket is up (200; 503 while it is down), and the detail is behind the token:
curl -s -o /dev/null -w '%{http_code}\n' http://HOST:PORT/ready
curl -s -H "Authorization: Bearer $TOKEN" http://HOST:PORT/status | head -c 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://HOST:PORT/mcp
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://HOST:PORT/mcp -H 'Authorization: Bearer wrong'

# the tools are served (expect 25 names):
curl -s http://HOST:PORT/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -o '"name":"zalo_[a-z_]*"' | wc -l

# the daemon, its log and its socket:
zalo-agent mcp start --account 1000000000000000001 --status
tail -f ~/.zalo-agent-cli/accounts/1000000000000000001/daemon.log   # when started with -d
```
