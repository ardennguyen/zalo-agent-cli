# Use case e: a SaaS host with KMS keys per tenant

[Tiếng Việt](README.vi.md) · The VPS underneath: [c-vps-few-accounts](../c-vps-few-accounts/README.md) · Keys: [docs/security.md](../../../security.md)

A host (one shard of a SaaS) running many customers' accounts, each a `zalo-mcp@<ownId>` unit as in [c](../c-vps-few-accounts/README.md), with the key provider **`kms`**: each account's keyring is wrapped by a cloud KMS key the host reaches through its instance role, a different key per tenant. This set is a **design to start from**, not yet run end to end: the KMS backends have not been checked against the live services.

## 1. The files

| File in this folder | What it is |
|---|---|
| `etc/systemd/system/zalo-mcp@.service`, `etc/systemd/system/zalo-mcp-purge.service`, `etc/systemd/system/zalo-mcp-purge.timer`, `etc/systemd/system/zalo-fleet-check.service`, `etc/systemd/system/zalo-fleet-check.timer`, `etc/systemd/system/zalo-backup.service`, `etc/systemd/system/zalo-backup.timer` | what `fleet generate --provider kms` writes: no credential drop-in (the instance role is the credential) |
| `etc/systemd/journald.conf.d/zalo.conf`, `etc/logrotate.d/zalo-policy-audit`, `etc/polkit-1/rules.d/50-zalo-fleet.rules`, `ufw.sh` | as in c |
| `etc/zalo-mcp/common.env` | generated, as in c |
| `etc/zalo-mcp/accounts/1000000000000000001.env`, `etc/zalo-mcp/accounts/1000000000000000002.env` | generated, plus `ZALO_KMS_KEY`: the tenant's key for that account |
| `etc/caddy/Caddyfile` | generated: `/a/<id>/` per account, admin API and metrics 404 |
| `home/zalo/.zalo-agent-cli/.env` | generated |
| `home/zalo/.zalo-agent-cli/storage.json` | `"provider": "kms"`, the backend and a default key id; retention 90 days of messages, 30 of media |
| `home/zalo/.zalo-agent-cli/mcp-config.json` | the multi-account settings (per-account ports, webhooks, presence) |
| `home/zalo/.zalo-agent-cli/tenants/tenant-a.json` | a tenant's policy dropped as plain JSON: tenant quota, presence caps, retention; the daemon checks and seals it on pickup |
| `usr/local/bin/za` | the CLI as `zalo` (no credential line: KMS needs none) |

## 2. Steps

1. A host as in c steps 1 and 2, with an instance role (AWS) or workload identity allowed to `Encrypt`/`Decrypt` with the tenants' keys, and the SDK installed beside the engine (`sudo npm install -g @aws-sdk/client-kms`; GCP, Azure and Vault have their own).
2. `za fleet generate --out /tmp/fleet --provider kms --base-port 3901 --domain zalo.example.com`, install as it prints, then add `ZALO_KMS_KEY` to each account's env file.
3. Accounts are added by QR (the controller of [d](../d-crm-backend/README.md), or `za login` over an SSH tunnel). Then `za --account <id> account security provider kms --backend aws --key <tenant key>` wraps that account's keyring under its tenant's key (it also makes that key the default in `storage.json`: set the default back before the next tenant).
4. Tenants: drop `tenants/<tenantId>.json` into `/home/zalo/.zalo-agent-cli/tenants/` (owned by zalo); the users and their accounts through the admin API or `za policy set accounts ... --user <id>`.
5. Start as in c step 7.

## 3. Verify

```bash
za account security status --all          # provider kms, the key id per account
za fleet status
curl -s https://zalo.example.com/a/1000000000000000001/health
```

## 4. Limits today

- **Per-tenant key in the account env only.** `storage.json` holds one key per machine; a different key per account comes from `ZALO_KMS_KEY` in that account's env file, which the daemon reads. The purge, backup and `za` runs do not read account env files: check on a test account that they open a keyring wrapped by a tenant key (the KMS answer names the key) before relying on them.
- **One host's view.** Each host has its own `fleet.json`, admin token and `tenants/` folder; a tenant on several hosts is summed by the console (`/zalo/admin/usage` per host). No placement or account-move tooling yet.
- **Admin credential per host.** One admin token per host; for several tenants' consoles use mTLS (`ZALO_MCP_ADMIN_CLIENT_CA`).
- **Presence.** On-demand by default, always-on per paid tier (`presence.alwaysOn.maxPerUser` in the tenant file). The daemons follow it once on-demand presence is switched on.
- **One web login per account.** A customer's own QR login into Zalo Web signs the server out; the phone and Zalo PC coexist. Tell customers: phone or Zalo PC, not Zalo Web.
