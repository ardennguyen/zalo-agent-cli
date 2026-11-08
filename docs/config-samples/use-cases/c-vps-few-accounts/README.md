# Use case c: one Linux VPS, one admin, a few accounts

[Tiếng Việt](README.vi.md) · Moving accounts from a Windows 2.5.9 home: [MIGRATE.md](MIGRATE.md) · Background: [docs/deployment.md](../../../deployment.md)

One Ubuntu 24.04 VPS (Node 22.19+, Caddy, ufw), one service user `zalo`, one admin who logs in over SSH, and two Zalo accounts (here `1000000000000000001`, the main one, and `1000000000000000002`, a companion; use your own ids). One hostname, `zalo.example.com`, with a path prefix per account: `https://zalo.example.com/a/<ownId>/mcp`. Keys at rest come from a **storage passphrase** that systemd hands to the service (`LoadCredentialEncrypted=`), so a backup opens on a new machine with that passphrase.

Every file here is what `za fleet generate --base-port 3901 --domain zalo.example.com` writes for these two accounts (the test `tests/unit/config-samples.test.js` holds them byte for byte), plus `mcp-config.json`, `journald.conf.d/zalo.conf` and `ufw.sh`.

## 1. How it fits together

```
internet ──443──> Caddy ──/a/<id>/*──> 127.0.0.1:3901  zalo-mcp@1000000000000000001  ─┐
                    │                  127.0.0.1:3902  zalo-mcp@1000000000000000002  ─┼─ one Zalo socket each
                    └─ /zalo/admin/*, /metrics, /status: 404                          │
admin ──ssh──> `za ...` (the CLI as user zalo, same home, same passphrase) ───────────┘
timers: zalo-fleet-check (5 min) · zalo-mcp-purge (hourly) · zalo-backup (nightly)
```

- Each account is one systemd instance `zalo-mcp@<ownId>`, its token and port in `/etc/zalo-mcp/accounts/<ownId>.env`, nothing on a command line.
- Everything the daemons write lives under `/home/zalo/.zalo-agent-cli` (the unit's only `ReadWritePaths`). The CLI you run by hand (`za`) uses the same folder, the same `.env` and the same passphrase.
- Stop, start and restart an account with `systemctl` or `za fleet stop|start|restart` (which calls systemctl for a unit). Never `zalo-agent mcp start` beside a unit.

## 2. The files

| File in this folder | Goes to | Owner, mode | What it is |
|---|---|---|---|
| `etc/systemd/system/zalo-mcp@.service` | same path | root, 644 | one daemon per account |
| `etc/systemd/system/zalo-mcp@.service.d/credentials.conf` | same path | root, 644 | hands the daemon the storage passphrase |
| `etc/systemd/system/zalo-mcp-purge.service`, `etc/systemd/system/zalo-mcp-purge.timer` | same path | root, 644 | hourly quota/retention purge for stopped accounts |
| `etc/systemd/system/zalo-mcp-purge.service.d/credentials.conf` | same path | root, 644 | the passphrase for the purge |
| `etc/systemd/system/zalo-fleet-check.service`, `etc/systemd/system/zalo-fleet-check.timer` | same path | root, 644 | `fleet status --check` every 5 minutes |
| `etc/systemd/system/zalo-backup.service`, `etc/systemd/system/zalo-backup.timer` | same path | root, 644 | nightly `db backup` + keyrings + config dir into `/var/backups/zalo` |
| `etc/systemd/system/zalo-backup.service.d/credentials.conf` | same path | root, 644 | the passphrase for the backup |
| `etc/systemd/journald.conf.d/zalo.conf` | same path | root, 644 | journal cap (500 MB, a month) |
| `etc/polkit-1/rules.d/50-zalo-fleet.rules` | same path | root, 644 | lets `zalo` start/stop/restart `zalo-mcp@*` only |
| `etc/logrotate.d/zalo-policy-audit` | same path | root, 644 | weekly rotation of `policy-audit.log` |
| `etc/zalo-mcp/common.env` | same path | root, 600 | settings of every unit (bind, logs, jitter, trusted proxy) |
| `etc/zalo-mcp/accounts/1000000000000000001.env`, `etc/zalo-mcp/accounts/1000000000000000002.env` | same path | root, 600 | port, **token** and public URL per account |
| `etc/caddy/Caddyfile` | same path | root, 644 | TLS, `/a/<id>/` per account, admin and metrics 404 |
| `home/zalo/.zalo-agent-cli/.env` | `/home/zalo/.zalo-agent-cli/.env` | zalo, 600 | read by every command run as zalo (machine paths go here) |
| `home/zalo/.zalo-agent-cli/storage.json` | same path | zalo, 600 | key provider: `passphrase` |
| `home/zalo/.zalo-agent-cli/mcp-config.json` | same path | zalo, 600 | MCP settings; presence: main always-on, companion on-demand |
| `usr/local/bin/za` | same path | root, 755 | run the CLI as `zalo`, the way the units do |
| `ufw.sh` | run once | | firewall: SSH, 80, 443 only |

`fleet generate` writes the account env files with **new tokens**; the ones here carry `CHANGE_ME_64_HEX_CHARACTERS`. Do not copy them: generate your own (step 6).

## 3. Steps

Run as your admin user over SSH. `<ver>` is the exact engine version you deploy (`npm view @ardennguyen/zalo-agent-cli versions`).

1. **Host.** Ubuntu 24.04, Node 22 (22.19 or later) from NodeSource, `sudo apt install caddy polkitd`, then the service user and the engine (pinned, never `@latest`):
   ```bash
   sudo adduser --system --group --home /home/zalo zalo
   sudo npm install -g @ardennguyen/zalo-agent-cli@<ver>
   command -v zalo-agent          # /usr/bin/zalo-agent; if not, pass --bin to fleet generate
   ```
2. **Firewall.** `sudo sh ufw.sh` (keep your SSH session open until `ufw status` is right). The engine ports and the QR port stay on 127.0.0.1.
3. **The `za` wrapper and the home files.**
   ```bash
   sudo install -m 755 usr/local/bin/za /usr/local/bin/za
   sudo install -d -m 700 -o zalo -g zalo /home/zalo/.zalo-agent-cli
   sudo install -m 600 -o zalo -g zalo home/zalo/.zalo-agent-cli/.env home/zalo/.zalo-agent-cli/storage.json home/zalo/.zalo-agent-cli/mcp-config.json /home/zalo/.zalo-agent-cli/
   ```
   Put your real account ids in `mcp-config.json` (`accounts` block) once you know them.
4. **The storage passphrase.** Make one, keep it in your password manager (it is the only way to open a backup elsewhere), and store it encrypted for systemd. It never goes in a file in clear:
   ```bash
   openssl rand -base64 32                       # copy it into your password manager
   sudo install -d -m 755 /etc/zalo-mcp
   sudo -v && systemd-ask-password -n "Storage passphrase:" \
     | sudo systemd-creds encrypt --with-key=host --name=zalo-storage-passphrase - /etc/zalo-mcp/storage-passphrase.cred
   sudo chmod 600 /etc/zalo-mcp/storage-passphrase.cred
   ```
   The credential drop-ins (`credentials.conf`) and `za` read it through `LoadCredentialEncrypted=`; systemd decrypts it for each run into `$CREDENTIALS_DIRECTORY`, where the passphrase provider finds it. (Why not the `systemd-creds` provider: on systemd 255, which Ubuntu 24.04 ships, only root can decrypt with the host key; `systemd-creds --user` for a service user arrived in 256.)
5. **The accounts.** Either move them from another machine ([MIGRATE.md](MIGRATE.md)), or log in fresh, once per account, with the QR page over an SSH tunnel:
   ```bash
   # on your workstation:  ssh -L 18927:127.0.0.1:18927 admin@your-vps     then open http://localhost:18927/qr
   za login
   za account list
   za account security status --all              # every file sealed under the passphrase
   ```
6. **Generate the fleet files** for the accounts this machine runs, with the base port and hostname above, then install what it prints (paths included):
   ```bash
   za fleet generate --out /tmp/fleet --base-port 3901 --domain zalo.example.com
   ```
   It lists the install commands in order (env files, units, the drop-ins, the home `.env` and `storage.json` you already installed, `za`, polkit, logrotate, `/var/backups/zalo`, the Caddyfile). Then `sudo rm -r /tmp/fleet`. Install `etc/systemd/journald.conf.d/zalo.conf` from this folder and `sudo systemctl restart systemd-journald`.
7. **Start.**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now zalo-mcp@1000000000000000001 zalo-mcp@1000000000000000002
   sudo systemctl enable --now zalo-mcp-purge.timer zalo-fleet-check.timer zalo-backup.timer
   journalctl -u zalo-mcp@1000000000000000001 -f     # until "account <id>: connecting -> connected"
   ```
8. **Clients.** Each account's token is `ZALO_MCP_AUTH_TOKEN` in its env file (`sudo grep TOKEN /etc/zalo-mcp/accounts/<id>.env`). Claude Code:
   ```json
   { "mcpServers": { "zalo-main": { "type": "http", "url": "https://zalo.example.com/a/1000000000000000001/mcp",
       "headers": { "Authorization": "Bearer ${ZALO_MCP_TOKEN}" } } } }
   ```
9. **Admin token** (only if a console will call the admin API): `za policy token --rotate`, keep it off the VPS. The admin API answers only on loopback: `ssh -L 3901:127.0.0.1:3901 admin@your-vps`, then `http://127.0.0.1:3901/zalo/admin/...`.

## 4. Verify

```bash
curl -s https://zalo.example.com/a/1000000000000000001/health      # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' https://zalo.example.com/a/1000000000000000001/ready     # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://zalo.example.com/a/1000000000000000001/mcp   # 401 without the token
curl -s -o /dev/null -w '%{http_code}\n' https://zalo.example.com/a/1000000000000000001/zalo/admin/policy   # 404 from the internet
za fleet status                                                     # both ok (or idle)
systemctl list-timers 'zalo-*'                                      # the three timers
```

## 5. Operate

- **Stop, start, restart one account:** `sudo systemctl restart zalo-mcp@<id>` or `za fleet restart <id>` (both go through systemd). When another session of the same login takes an account, the main one (always-on) ends with exit 3 and its unit stays down on purpose (`systemctl --failed`): read `journalctl -u zalo-mcp@<id>`, close the other session, then start it. The companion (on-demand) yields instead and stays up refusing requests until `za --account <id> presence resume --yes`. A login Zalo refuses (`signed_out`) keeps either daemon up; it exits 4 only with `ZALO_EXIT_ON_SIGNED_OUT=1` (or `ZALO_EXIT_ON_SIGNED_OUT_<id>=1`).
- **Health:** the check timer runs `fleet status --check`; a failure shows in `systemctl --failed` and `journalctl -u zalo-fleet-check`. Add `OnFailure=` to `zalo-fleet-check.service` to be told (mail, ntfy).
- **Logs:** `journalctl -u 'zalo-mcp@*'`. `ZALO_LOG_LEVEL=info` in `common.env`; never `debug` on a server (it logs message text).
- **Backups:** nightly into `/var/backups/zalo`: `<id>-<time>.db` (encrypted `db backup`), `<id>-<time>.keyring.json`, `config-<time>.tgz`; 14 days kept. Copy them off the machine. None opens without the passphrase from your password manager. Restore: a new VPS set up through step 4 with the **same** passphrase, the config tar unpacked into `/home/zalo`, each `.db` copied to `accounts/<id>/zalo.db`, then step 6.
- **Upgrade:** `sudo npm install -g @ardennguyen/zalo-agent-cli@<new>`, then restart one account, check it, then the other (self-heal fills the restart window).
- **Retention:** `za --account <id> policy set retention.media 180d` (or `retention` in `storage.json`); the daemons and the purge timer apply it.
- **Presence:** `mcp-config.json` keeps the main account always-on (real-time webhooks) and lets the companion run on-demand, the default for these daemons: its socket closes after 5 idle minutes and reopens on the next tool call, wait or `za` request, and what arrived meanwhile comes from Zalo's offline queue (`catchUp: true`). `za presence status --account <id>` shows it; `fleet status` shows a parked account as `idle`. Change it live with `za --account <id> policy set presence.mode always-on`.

## 6. The phone, Zalo PC and Zalo Web

Zalo keeps **one web login per account**. The server is that web login. If someone logs the same account into **Zalo Web** (chat.zalo.me) with a QR code, Zalo signs the server out: its login is refused, the daemon stays up as `signed_out` (refusing requests; `ZALO_EXIT_ON_SIGNED_OUT=1` makes it exit 4 instead) and the account needs a new `za login`, then `sudo systemctl restart zalo-mcp@<id>`. The **phone** and the **Zalo PC app** are separate logins and work beside the server. So: use the phone or Zalo PC next to the server, never Zalo Web. Each `za login` adds a new entry to the phone's device list (the older web entries show as logged out); a re-login keeps the account's device id, so the messages Zalo queued for it survive.

Two copies of the **same** saved login (this VPS and the machine you moved it from) kick each other off (exit 3; an on-demand daemon yields instead and refuses requests until `za presence resume --yes`). Run each account in one place only.

## 7. What still needs a live check on the VPS

- `systemd-run --pty/--pipe` with `LoadCredentialEncrypted=` (the `za` wrapper) on systemd 255, and that `za` passes the command's exit code back (a guarded command must exit 2 without `--yes`).
- The unit and the purge/backup units reading the passphrase from `$CREDENTIALS_DIRECTORY` under `User=zalo`.
- `za fleet stop|restart <id>` through the polkit rule (polkitd installed, JavaScript rules read).
- One nightly backup run, and a restore of it on a scratch VM with the passphrase.
- The Caddyfile: `/a/<id>/mcp` streams, `/a/<id>/events/wait` holds 300 s, `/zalo/admin/*` is 404.
