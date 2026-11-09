# Use case d: Zalo accounts as the backend of a CRM

[Tiếng Việt](README.vi.md) · The VPS underneath: [c-vps-few-accounts](../c-vps-few-accounts/README.md) · Background: [docs/deployment.md §5.6](../../../deployment.md)

The set of [use case c](../c-vps-few-accounts/README.md) (one VPS, a systemd unit per account, the passphrase provider, `za`), plus what a CRM needs: every incoming message **pushed** to the CRM's webhook, signed; sends over `POST /mcp`; approve and PIN pages delivered to the CRM, not the agent; the **admin API** (runtime policy, usage, export) and the **fleet controller** (QR add, start/stop, guarded logout and removal, `account_state` events) on an admin host only the CRM's address reaches.

## 1. The files

Everything from c, the same bytes (the test holds them), except the files marked **own**:

| File in this folder | What it is |
|---|---|
| `etc/systemd/system/zalo-mcp@.service`, `etc/systemd/system/zalo-mcp@.service.d/credentials.conf` | one daemon per account, and its passphrase |
| `etc/systemd/system/zalo-mcp-purge.service`, `etc/systemd/system/zalo-mcp-purge.timer`, `etc/systemd/system/zalo-mcp-purge.service.d/credentials.conf` | hourly purge |
| `etc/systemd/system/zalo-fleet-check.service`, `etc/systemd/system/zalo-fleet-check.timer` | `fleet status --check` every 5 minutes |
| `etc/systemd/system/zalo-backup.service`, `etc/systemd/system/zalo-backup.timer`, `etc/systemd/system/zalo-backup.service.d/credentials.conf` | nightly backup |
| `etc/systemd/system/zalo-fleet-controller.service`, `etc/systemd/system/zalo-fleet-controller.service.d/credentials.conf` | the fleet controller (`fleet serve`) on 127.0.0.1:3899, and its passphrase (a QR add seals the new login) |
| `etc/systemd/journald.conf.d/zalo.conf`, `etc/logrotate.d/zalo-policy-audit` | journal cap, audit log rotation |
| `etc/polkit-1/rules.d/50-zalo-fleet.rules` | lets `zalo` (the controller, `za fleet ...`) start/stop/restart `zalo-mcp@*` |
| `etc/zalo-mcp/common.env` | **own**: c's, plus the admin token file, `ZALO_MCP_APPROVAL_DELIVER=webhook`, the controller's port, QR flows, webhook, public URL and the accounts' proxy host (`ZALO_FLEET_DOMAIN`) |
| `etc/zalo-mcp/accounts/1000000000000000001.env`, `etc/zalo-mcp/accounts/1000000000000000002.env` | **own**: c's, plus each account's webhook URL and its own signing secret |
| `etc/caddy/Caddyfile` | **own**: the public host (MCP, media, QR pages) and the admin host (`/a/<id>/zalo/admin/*`, `/fleet/zalo/admin/*`), the latter for the CRM's address only |
| `home/zalo/.zalo-agent-cli/.env`, `home/zalo/.zalo-agent-cli/storage.json` | c's |
| `home/zalo/.zalo-agent-cli/mcp-config.json` | **own**: c's, with `approval.deliver: "webhook"` and `admin.tokenFile` |
| `usr/local/bin/za`, `ufw.sh` | c's |
| `clients/crm-webhook-receiver.mjs`, `clients/crm_webhook_receiver.py` | receivers that verify `X-Zalo-Signature` over the raw body and read a batch (tested against the real sender) |
| `clients/crm-send-message.sh` | a send as JSON-RPC over `POST /mcp` |
| `clients/admin-policy.sh` | the console: read and PATCH a policy with `If-Match`, read usage |

## 2. Steps

1. Do [c](../c-vps-few-accounts/README.md) steps 1 to 5 (host, firewall, `za`, passphrase, accounts).
2. Generate the fleet files as in c step 6, then use **this folder's** `common.env`, account env files and Caddyfile in place of the generated ones, keeping the generated tokens: copy each account's `ZALO_MCP_AUTH_TOKEN` line into the file from here. Set the webhook URL and a **different** secret per account (`openssl rand -hex 32`), the CRM's real egress address instead of `198.51.100.7`, and your hostnames.
3. The env folder must belong to the service user, because a QR add writes the new account's env file there:
   ```bash
   sudo chown -R zalo:zalo /etc/zalo-mcp/accounts && sudo chmod 700 /etc/zalo-mcp/accounts
   ```
4. The admin token (one per host, never an agent's token):
   ```bash
   openssl rand -hex 32 | sudo install -m 600 -o zalo -g zalo /dev/stdin /etc/zalo-mcp/admin-token
   ```
   Give the same value to the CRM's console (its secret store). Or `za policy token --rotate` and leave `ZALO_MCP_ADMIN_TOKEN_FILE` unset.
5. The controller: install its unit and drop-in, then start everything:
   ```bash
   sudo install -m 644 etc/systemd/system/zalo-fleet-controller.service /etc/systemd/system/
   sudo install -D -m 644 etc/systemd/system/zalo-fleet-controller.service.d/credentials.conf /etc/systemd/system/zalo-fleet-controller.service.d/credentials.conf
   sudo systemctl daemon-reload
   sudo systemctl enable --now zalo-mcp@1000000000000000001 zalo-mcp@1000000000000000002 zalo-fleet-controller
   sudo systemctl enable --now zalo-mcp-purge.timer zalo-fleet-check.timer zalo-backup.timer
   ```
6. The CRM side: run a receiver (`clients/crm-webhook-receiver.mjs` or `clients/crm_webhook_receiver.py`): verify the signature over the raw body, answer 2xx at once, de-duplicate on `accountId` + message id. Sends: `clients/crm-send-message.sh`. Policy and usage: `clients/admin-policy.sh` against `https://admin.zalo.example.com/a/<id>`. Accounts: the controller under `https://admin.zalo.example.com/fleet/zalo/admin/accounts`.

## 3. Verify

```bash
curl -s https://zalo.example.com/a/1000000000000000001/health
curl -s -o /dev/null -w '%{http_code}\n' https://zalo.example.com/a/1000000000000000001/zalo/admin/policy   # 404: never on the public host
# from the CRM's address:
ZALO_ADMIN_URL=https://admin.zalo.example.com/a/1000000000000000001 ZALO_ADMIN_TOKEN_FILE=... ./clients/admin-policy.sh get
curl -s -H "Authorization: Bearer $(cat admin-token)" https://admin.zalo.example.com/fleet/zalo/admin/accounts
za mcp webhook status --account 1000000000000000001     # the outbox: pending, dead, last success
```

## 4. Presence, real time and the user's own Zalo

- **Presence** (`mcp-config.json`, the policy, or `ZALO_PRESENCE_MODE` per account): `on-demand` is the default for a server; the socket closes after `idleTimeout` and opens on the next tool call, wait, CLI request or **CRM lease** (`POST /zalo/presence/leases`). What arrived meanwhile is posted after the reconnect, flagged `catchUp: true`. `always-on` is real-time delivery, the paid tier: at most `presence.alwaysOn.maxPerUser` (1) per user, the oldest demoted when a new one goes over. `listen -d` reads the same `presence` block.
- **Yielded.** A second copy of the same login (another machine, a second browser tab of the same login) takes the socket: the daemon stays up, `account_state: yielded`, and refuses requests with `YIELDED`. Nothing takes the account back on its own: once the user has closed the other session, the CRM confirms with `POST https://admin.zalo.example.com/fleet/zalo/admin/accounts/<id>/presence/resume` (or `za --account <id> presence resume --yes`).
- **One web login per account.** A customer who logs the same account into **Zalo Web** by QR signs the server out (the daemon stays up, `account_state: signed_out`, and refuses requests with `SIGNED_OUT`): add it again by QR through the controller, which restarts the daemon (`restarted: "relogin"`). Each QR login adds a new entry to the phone's device list (older web entries show as logged out); a re-login keeps the device id, so the queued messages survive. The **phone** and the **Zalo PC app** coexist with the server. Tell users: phone or Zalo PC, not Zalo Web.
- **The login ends after about 90 days.** Zalo never renews a QR login, so the CRM should warn the user well before the date. `GET /fleet/zalo/admin/accounts` carries `session: {expiresAt, daysLeft, expired}` per account (show `daysLeft`), and the controller's SSE (`GET /fleet/zalo/admin/events`) and webhook (`ZALO_FLEET_WEBHOOK`) send a `session_expiring` event `{accountId, expiresAt, daysLeft, expired, threshold, ...}` at 14, 7, 3 and 1 days left and once ended (each account's own webhook gets it too). Renew with the controller's QR add (`POST /fleet/zalo/admin/accounts/qr {userId}`): the user scans, the controller restarts the daemon (`restarted: "relogin"`), and the date moves 90 days on. As in c, `fleet status` shows `LOGIN ENDS`, the check timer fails at 7 days or fewer, and `zalo_session_days_left` drives the `ZaloSessionEndingSoon` / `ZaloSessionEndingNow` alert rules. Past the date the account goes `account_state: signed_out` and refuses requests with `SIGNED_OUT` until that QR add.
- A QR-added account gets its env file from the controller: its port, a new token and its `ZALO_MCP_PUBLIC_URL` (`https://<ZALO_FLEET_DOMAIN>/a/<id>`, as `fleet generate --domain` writes it; `fleet serve --domain` does the same). Add its `/a/<id>/` blocks to the Caddyfile (both hosts) and reload Caddy. `common.env` trusts the proxy (`ZALO_MCP_TRUSTED_PROXIES`); on a host whose shared env does not, the controller writes `ZALO_MCP_TRUSTED_PROXIES=127.0.0.1` into the new account's env file and says so at start.

## 5. What is pending

Tracked in the presence and lifecycle plan: the CRM export import command, users and tenants across several hosts.
