# Use case e: a SaaS host with KMS keys per tenant

[Tiếng Việt](README.vi.md) · The VPS underneath: [c-vps-few-accounts](../c-vps-few-accounts/README.md) · Keys: [docs/security.md](../../../security.md)

A host (one shard of a SaaS) running many customers' accounts, each a `zalo-mcp@<ownId>` unit as in [c](../c-vps-few-accounts/README.md), with the key provider **`kms`**: each account's keyring is wrapped by a cloud KMS key the host reaches through its instance role, a different key per tenant. This set is a **design to start from**, not yet run end to end: the KMS backends have not been checked against the live services.

## 1. The files

| File in this folder | What it is |
|---|---|
| `etc/systemd/system/zalo-mcp@.service`, `etc/systemd/system/zalo-mcp-purge.service`, `etc/systemd/system/zalo-mcp-purge.timer`, `etc/systemd/system/zalo-fleet-check.service`, `etc/systemd/system/zalo-fleet-check.timer`, `etc/systemd/system/zalo-backup.service`, `etc/systemd/system/zalo-backup.timer` | what `fleet generate --provider kms` writes: no credential drop-in (the instance role is the credential) |
| `etc/systemd/journald.conf.d/zalo.conf`, `etc/logrotate.d/zalo-policy-audit`, `etc/polkit-1/rules.d/50-zalo-fleet.rules`, `ufw.sh` | as in c |
| `etc/zalo-mcp/common.env` | generated, as in c |
| `etc/zalo-mcp/accounts/1000000000000000001.env`, `etc/zalo-mcp/accounts/1000000000000000002.env` | generated, as in c (no key in them: see `storage.json`) |
| `etc/caddy/Caddyfile` | generated: `/a/<id>/` per account, admin API and metrics 404 |
| `home/zalo/.zalo-agent-cli/.env` | generated |
| `home/zalo/.zalo-agent-cli/storage.json` | `"provider": "kms"`, the backend, a default key id, and **each account's tenant key** under `accounts.<id>.kms.key`; retention 90 days of messages, 30 of media |
| `home/zalo/.zalo-agent-cli/mcp-config.json` | the multi-account settings (per-account ports, webhooks, presence) |
| `home/zalo/.zalo-agent-cli/tenants/tenant-a.json` | a tenant's policy dropped as plain JSON: tenant quota, presence caps, retention; the daemon checks and seals it on pickup |
| `usr/local/bin/za` | the CLI as `zalo` (no credential line: KMS needs none) |

## 2. Steps

1. A host as in c steps 1 and 2, with an instance role (AWS) or workload identity allowed to `Encrypt`/`Decrypt` with the tenants' keys, and the SDK installed beside the engine (`sudo npm install -g @aws-sdk/client-kms`; GCP, Azure and Vault have their own).
2. `za fleet generate --out /tmp/fleet --provider kms --base-port 3901 --domain zalo.example.com`, install as it prints, then use **this folder's** `storage.json` (your default key and one `accounts.<id>.kms.key` per account you already know).
3. Accounts are added by QR (the controller of [d](../d-crm-backend/README.md), or `za login` over an SSH tunnel). Then `za account security provider kms <id> --backend aws --key <tenant key>` (the account id as the argument: without it every account is moved) wraps that account's keyring under its tenant's key and writes the key to `accounts.<id>.kms` in `storage.json`; the default key stays as it was. Stop the account's unit first, start it after.
4. Tenants: drop `tenants/<tenantId>.json` into `/home/zalo/.zalo-agent-cli/tenants/` (owned by zalo); the users and their accounts through the admin API or `za policy set accounts ... --user <id>`.
5. Start as in c step 7.

## 3. Verify

```bash
za account security status --all          # provider kms, the key id per account (each its tenant's)
za fleet status
curl -s https://zalo.example.com/a/1000000000000000001/health
```

## 4. Limits today

- **Where the tenant key lives.** Each keyring records the key that wraps it, and that key opens it in every process: the daemon, `za`, the purge and the backup unit, whatever the default in `storage.json` or `ZALO_KMS_KEY` says. `accounts.<id>.kms` in `storage.json` is the key a new keyring of that account (a re-added login) is made under; it beats the default and `ZALO_KMS_KEY`. Do not put `ZALO_KMS_KEY` in an account env file: only that account's daemon reads it.
- **One host's view.** Each host has its own `fleet.json`, admin token and `tenants/` folder; a tenant on several hosts is summed by the console (`/zalo/admin/usage` per host). No placement or account-move tooling yet.
- **Admin credential per host.** One admin token per host; for several tenants' consoles use mTLS (`ZALO_MCP_ADMIN_CLIENT_CA`).
- **Presence.** On-demand by default (the socket parks after 5 idle minutes and wakes on the next call, wait or CRM lease), always-on per paid tier (`presence.alwaysOn.maxPerUser` in the tenant file; over the cap the oldest always-on account is demoted). `ZALO_CONNECT_SLOTS=16` in `common.env` spreads the wakes.
- **One web login per account.** A customer's own QR login into Zalo in a browser signs the server out; the phone and the Zalo desktop app coexist. Tell customers: phone or desktop app, not a browser.
- **The login ends after about 90 days.** Zalo never renews a QR login, so the console must ask the customer to scan again before the date. As in [d](../d-crm-backend/README.md): show `session.daysLeft` from the controller's `GET /zalo/admin/accounts`, listen for `session_expiring` on its SSE (`GET /zalo/admin/events`) or webhook (`ZALO_FLEET_WEBHOOK`), or on each account's webhook (at 14, 7, 3 and 1 days left and once ended), and renew with the controller's QR add (`POST /zalo/admin/accounts/qr {userId}`), which restarts the daemon (`restarted: "relogin"`). On the host, `fleet status` shows `LOGIN ENDS`, the check timer fails at 7 days or fewer, and `zalo_session_days_left` drives the `ZaloSessionEndingSoon` / `ZaloSessionEndingNow` alert rules. Past the date the account is `signed_out` and refuses requests with `SIGNED_OUT` until it is added again.
