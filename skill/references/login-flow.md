# Login Flow — Step by Step

## Method 1: QR Code (Interactive)
Requires human with Zalo mobile app. Server must have at least 1 open port.

### Step-by-step
```bash
# 1. Determine IP
SERVER_IP=$(curl -s ifconfig.me || curl -s ipinfo.io/ip || hostname -I | awk '{print $1}')
echo "Server IP: $SERVER_IP"

# 2. Start login (BACKGROUND — never foreground)
zalo-agent login --qr-url &

# 3. Wait for QR server to start
sleep 5

# 4. Tell user the URL
echo "Open http://$SERVER_IP:18927/qr in browser"
echo "Scan with Zalo app > QR Scanner (NOT camera). Each code lasts about 100 seconds."

# 5. After user confirms scan, verify
zalo-agent status
```

### Port Selection
QR HTTP server auto-tries: 18927 → 8080 → 3000 → 9000. First available wins. Override the first choice with `-q, --qr-port <port>`.
Firewall must allow at least one of these ports for remote access.

**Behind a reverse proxy:** `--public-url <url>` (or `ZALO_MCP_PUBLIC_URL` / `publicUrl` in `mcp-config.json`) prints the page as `<url>/zalo/qr/<one-time token>` instead of an IP and port; the proxy routes `/zalo/qr/` to the QR port (https, or http on localhost). The `fleet generate --domain` Caddyfile already does. Each login gets its own page and token.

### QR events surfaced during login
| Event | What the CLI does |
|-------|-------------------|
| generated | Prints the QR (terminal ASCII + browser URL), saves `~/.zalo-agent-cli/qr.png` |
| scanned | Prints the scanning account's display name and avatar URL, prompts to confirm on the phone |
| declined | Fails immediately with "Login declined on phone" (`QRCodeDeclined` / `qr_declined` in `--json`) |
| second QR | on an account with a trusted device: after the first scan the QR is replaced by a new one to scan once more (`event: "qr"` with `layer: 2` in `--json`; the browser page says so too) |
| expired | With `--json` or no terminal: a fresh QR at once, up to 5 codes, then `login_error` (`Login timed out: …`). At a terminal: waits for Enter or the page's "Get a new code", up to 5 minutes |

### Auto sync at login ("sync messages to this device")
After every QR login, `zalo-agent login` reads the phone's answer and says whether **sync messages** was ticked on the QR confirmation screen. The answer is a control in the account's control queues (`603_1`, `603_0`); they are read as Zalo Web reads them, from the cursor `listen` saved and page by page, then from the start, because a re-login that keeps the device id keeps the queue and the answer is at its end. `--verbose` lists the queues read and every control seen (never the key):

| Phone | What `login` does |
|-------|-------------------|
| Ticked | Restores the history at once with the short-lived key the phone sent; the phone does **not** ask for the "ĐỒNG BỘ NGAY" tap (`--sync-days <n>` for a recent window; `--no-sync` only reports) |
| Not ticked | Starts nothing. On a new device id it prints the run that restores what this login does not have: `zalo-agent sync --from <date>` (asks for a tap) |
| Ticked, but the key is over two minutes old by the time the socket is up | Same as not ticked (`late`) |
| An offer for the Zalo PC app only | Same as not ticked (`other-client`) |
| A `listen`/`mcp` daemon holds the account | Reads nothing (a second socket would fight the daemon); prints the `sync` command |

`--sync` is the older spelling of the default, kept for scripts. No daemon ever starts this restore on its own.

With `--json` the outcome is one line, `{"event": "login_auto_sync", "status": ...}`, where `status` is one of:

| `status` | Meaning |
|----------|---------|
| `restored` | Ticked; restored with the phone's key (`ageMs`, `reason`) |
| `declined` | Ticked, but `--no-sync` was given (`command`: the restore to run later) |
| `none` | Not ticked, on a new device id (`command`) |
| `late` | Ticked too long ago to use the key (`command`) |
| `other-client` | The offer was for the Zalo PC app (`command`) |
| `same-device` | Not ticked, but the login kept its device id: nothing needs restoring unless the next daemon start reports a gap (`offer`) |
| `daemon-running` | A `listen`/`mcp` daemon holds the account; nothing read (`command`) |
| `unknown` | The offer could not be checked (no socket) (`command`) |
| `failed` | The restore started and failed |

With `--verbose --json` the same line also carries `pulls` (the control queues read: queue, start point, pages, why) and `controls` (act type, act, `pc`, whether it carried a key, its age; never the key itself).

### Device id across re-logins
Zalo keeps the offline queue (what arrives while no client is connected) **per device id** (imei). Zalo Web keeps one per browser across logout and login; `zalo-agent login` (and `account login`) does the same for an account whose saved login is still on this machine: it presents the saved user agent again, and when the account that confirms the QR has a device id saved here, it logs in with that imei. The line after "Logged in" says `Device: the same device id ...` (`--json`: `newDevice: false` and `device` in `login_success`). A first login here, a login after `logout` (it deletes the saved login), an unreadable saved login, or a different account gets a **new device id** (`Device: a new device id ... (no saved login for this account here: ...)`).

The saved credentials record **`deviceSince`**: when this device id came into use (stamped whenever the imei changes, by every login path; a login saved before 3.0 uses its file's last write time). Zalo's own `first_time_login_device`, when the login settings carry it, counts too (the later of the two). A daemon's coverage never starts before that time: nothing from before it can come from Zalo's queue for this device, so the next `listen`/`mcp` start keeps that window as a pending **`new-device`** gap and names the `zalo-agent sync --from <date>` run that closes it, unless a phone-backed restore that finished after the login already reached back past it. Tick "sync messages" at the QR to avoid the extra step.

**What the phone shows (measured):** each QR login adds a new entry to the phone's list of logged-in devices, and the older entries of this CLI are logged out. That is expected: the offline queue survives a re-login because the device id is kept, not because the list entry is.

### Troubleshooting
| Issue | Fix |
|-------|-----|
| QR won't scan | Use browser QR (`--qr-url`), NOT terminal ASCII |
| Port blocked | Open port in firewall: `ufw allow 18927` |
| QR expired | At a terminal: press Enter, or click "Get a new code" on the page (the login ends after 5 min without one). In the background or with `--json`, up to 5 codes are shown, then the login ends with `Login timed out: …`: re-run `zalo-agent login --qr-url &` |
| Already logged in | `zalo-agent logout` first |
| Wrong QR scanner | Must use **Zalo app → QR Scanner**, NOT phone camera |
| Declined on phone | Login exits immediately with "Login declined on phone" (does not hang until the QR expires); the page says "Login failed" too — just re-run `zalo-agent login --qr-url &` |
| `Device: a new device id ...` after a re-login | Expected after `logout`, on a first login here, or when the saved login could not be read. Messages from before the login are not in Zalo's queue for this device: tick "sync messages" at the QR next time, or run the `zalo-agent sync --from <date>` it printed (tap on the phone) |
| Daemon log: `pending (new-device)` | The daemon started on a device id newer than its last stored message; run the printed `zalo-agent sync --from <date>` |
| Daemon log or webhook: `queue_overflow` | Zalo dropped part of its offline queue while the account was away. Groups are repaired from Zalo's group store without a tap when possible; 1-1 messages need `zalo-agent sync --from <date>` (tap on the phone) |
| `login` says "not ticked" although it was | Run `zalo-agent login --verbose` (or `--verbose --json`) to see the control queues read and every control found; a `listen`/`mcp` daemon holding the account means nothing was read |
| Daemon refuses everything with `SIGNED_OUT`; `account_state` `signed_out` | Zalo revoked the login, usually because someone logged into **Zalo Web** with this account (one web login per account, below). The daemon stays up and never retries: add the account again by QR (`zalo-agent login`, or the fleet controller's QR add), and use the phone or Zalo PC instead of Zalo Web from then on |
| Daemon refuses everything with `YIELDED`; `account_state` `yielded` | On-demand daemon: another session of the **same saved login** took the socket (a second copy of these credentials running elsewhere; close 3000). Stop the other copy, then `zalo-agent presence resume --yes` |

## Method 2: Headless (Credentials File)
No human interaction. For automation, CI, server migration.

```bash
# Export from logged-in account
zalo-agent account export -o creds.json --yes

# Login on new machine
zalo-agent login --credentials ./creds.json

# With proxy
zalo-agent login --credentials ./creds.json -p "http://user:pass@host:port"
```

### Credential Security
- Credentials managed entirely by `zalo-agent` CLI — this skill never reads credential contents directly
- `chmod 600 creds.json` — restrict file permissions
- Never commit to git (add to .gitignore)
- Treat credential files as secrets — contains session tokens
- Each file = 1 device identity

## Method 3: Multi-Account
```bash
# Add accounts with unique proxies (1:1 mapping required)
zalo-agent account login -p "http://user:pass@proxy1:port" -n "Account 1"
zalo-agent account login -p "http://user:pass@proxy2:port" -n "Account 2"

# List all registered accounts and their numeric IDs
zalo-agent account list

# Run any command or daemon for a specific account without changing accounts.json (safe for concurrent live accounts)
zalo-agent mcp start --account <ownerId>
zalo-agent listen --account <ownerId>
zalo-agent --account <ownerId> msg send <threadId> "Hello" --json
ZALO_ACCOUNT=<ownerId> zalo-agent conv recent --json

# Or switch the default active account in accounts.json
zalo-agent account switch <ownerId>
```

## Proxy Support
Formats: `http://user:pass@host:port`, `socks5://user:pass@host:port`
Tested: IPRoyal residential, datacenter proxies.
Rule: 1 unique proxy per account — shared proxies risk ban.

## Logging Out & Removing Accounts

Pick by how much you want gone. All four are distinct:

| Command | Zalo session | Saved credentials | Local cache (`zalo.db`, `media/`) | Registry entry |
|---------|:---:|:---:|:---:|:---:|
| `logout` | device signed out | **deleted** | kept | kept |
| `logout --keep-session` | key ended only | **deleted** | kept | kept |
| `logout --no-remote` | not contacted | **deleted** | kept | kept |
| `logout --delete-history` | device signed out | **deleted** | **deleted** | kept |
| `logout --purge` | device signed out | **deleted** | **deleted** | **removed** |
| `account remove <ownerId>` | device signed out (if that account is active) | **deleted** | **deleted** | **removed** |

- **Every `logout` is a real logout on this device**: the saved credentials are deleted, so the next command needs a new QR login. The chat cache is kept for that next login unless `--delete-history` or `--purge` removes it.
- **What a logout does at Zalo**: it runs the six calls Zalo Web makes when you sign out (a one-time token from `id.zalo.me`, the profile `deactive` call, the `v2` logout, `id.zalo.me`'s own logout, the `setsid` hops, the login page), then tries the saved login once. "Signed out" is printed only when Zalo refuses that login; a login that still works is a warning, and a check that could not be made (no network, no saved login) is said to be unverified. Before v3.0 the calls were the production `GET /api/login/logOut` and `logoutV2`, which end only the session *key* (measured 2026-09-30: with the credentials kept, the next command logged straight back in); `--keep-session` keeps that behavior, and then the login ends at Zalo only when the web session is removed from the phone's list of logged-in devices.
- **A new web login signs the previous web session out** — Zalo allows one per account (see below).
- **Stopping a daemon is not a logout.** Ctrl+C on `listen`/`mcp start` is the "close the browser and reopen" case: the credentials stay, the next start logs back in, and self-heal catches up what arrived meanwhile from Zalo's offline queue.
- `logout` (every form) and `account remove` **refuse before changing anything** while a `listen`/`mcp` daemon holds that account's `daemon.lock`, naming the PID. Stop the daemon first.
- `zalo-agent account devices` lists the sessions Zalo currently has linked to the active account (read-only). After a default logout, check that this session is gone; a `--keep-session` logout leaves it listed until it is removed from the phone.

- **The companion-device identity.** The official QR login makes this CLI a trusted companion device of the account (the phone's linked-device list shows it; `account devices` marks the entry `<- this CLI`). Its identity is `accounts/<ownerId>/trusted-device.json` (0600, a secret). `logout` and `logout --delete-history` **keep** it; `logout --purge` and `account remove` **delete** it with the account's folder, and both say so. Zalo keeps listing a deleted identity's entry on the phone until it is removed there. Measured in 3.0: each QR login still shows as a new entry in the phone's list, with the CLI's older entries logged out (see "Device id across re-logins" above).

After a purge, `~/.zalo-agent-cli/credentials/` is empty, `accounts.json` is `[]`, and `accounts/<ownId>/` is gone.

> **What a purge does NOT remove:** a custom `media.downloadDir` set in `mcp-config.json`. By default the **MCP server** downloads attachments into `accounts/<ownId>/media/<threadId>/`, like every other command, and a purge removes that with the rest of the account directory; a custom root sits outside it, so its media survives every command in the table above. If a user purges for privacy reasons and set one, tell them, and delete that directory by hand. Official Account credentials at `~/.zalo-agent/oa-credentials.json` are also untouched — a different directory entirely.

## One web session per account

Zalo keeps **one web login per account**, and this CLI occupies it (measured 2026-09-20, rechecked for 3.0):

- **A QR login into Zalo Web logs the server out.** It revokes the CLI's login server-side at once, even with no CLI process running; the next API call fails with `Đăng nhập thất bại`. **Use the phone or Zalo PC beside the server, never Zalo Web.**
- The reverse also holds: `zalo-agent login` signs Zalo Web out.
- The **phone app and Zalo PC are unaffected**: they are separate session types and coexist with the CLI.
- Revocation is server-side, so the credential file on disk is unchanged. `status` is a local check and will still report `loggedIn: true` against a dead session — use `whoami` to probe liveness.
- **A running daemon whose login is revoked stays up `signed_out`** (3.0): it lets the socket go, never retries, emits an `account_state` event with `state: "signed_out"`, refuses every request with `SIGNED_OUT` ("add the account again by QR"), and keeps its HTTP API, `/status` and the fleet controller's QR re-add working. `ZALO_EXIT_ON_SIGNED_OUT=1` restores the 2.x behavior (exit 4). This applies to both `listen` and `mcp start`, on-demand or always-on.
- One login also means **one socket**: `listen`, `mcp start` and `sync-mobile` cannot run side by side on one account (a running daemon serves uploads, `sync` stages and history on its own socket). When a second copy of the same saved login takes the socket (close code 3000), an on-demand daemon **yields**: it stays up, refuses requests with `YIELDED`, and takes the account back only on `zalo-agent presence resume --yes`. An always-on daemon (or `presence.onKick: "exit"`) exits 3 and leaves `kicked.json`.
