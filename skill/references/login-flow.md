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
echo "Scan with Zalo app > QR Scanner (NOT camera). Expires in 60 seconds."

# 5. After user confirms scan, verify
zalo-agent status
```

### Port Selection
QR HTTP server auto-tries: 18927 → 8080 → 3000 → 9000. First available wins. Override the first choice with `-q, --qr-port <port>`.
Firewall must allow at least one of these ports for remote access.

### QR events surfaced during login
| Event | What the CLI does |
|-------|-------------------|
| generated | Prints the QR (terminal ASCII + browser URL), saves `~/.zalo-agent-cli/qr.png` |
| scanned | Prints the scanning account's display name and avatar URL, prompts to confirm on the phone |
| declined | Fails immediately with "Login declined on phone" (`QRCodeDeclined` / `qr_declined` in `--json`) |
| second QR | the default flow (`ZALO_QR_FLOW=legacy` turns it off), on an account with a trusted device: after the first scan the QR is replaced by a new one to scan once more (`event: "qr"` with `layer: 2` in `--json`; the browser page says so too) |
| expired | Auto-retries with a fresh QR |

### Auto sync at login (`--sync`)
Tick **auto sync** on the phone's QR confirmation screen, and run `zalo-agent login --sync` (add `--sync-days <n>` for a recent window). The phone sends a short-lived key with the login; the restore starts at once with it and the phone does **not** ask for the "ĐỒNG BỘ NGAY" tap. If auto sync was not ticked, or the key is more than two minutes old, nothing is started: run `zalo-agent sync` as usual. `--sync` is never started by a daemon on its own.

### Troubleshooting
| Issue | Fix |
|-------|-----|
| QR won't scan | Use browser QR (`--qr-url`), NOT terminal ASCII |
| Port blocked | Open port in firewall: `ufw allow 18927` |
| QR expired | Re-run `zalo-agent login --qr-url &` |
| Already logged in | `zalo-agent logout` first |
| Wrong QR scanner | Must use **Zalo app → QR Scanner**, NOT phone camera |
| Declined on phone | Login exits immediately with "Login declined on phone" (does not hang until the 60s QR timeout) — just re-run `zalo-agent login --qr-url &` |

## Method 2: Headless (Credentials File)
No human interaction. For automation, CI, server migration.

```bash
# Export from logged-in account
zalo-agent account export -o creds.json

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

After a purge, `~/.zalo-agent-cli/credentials/` is empty, `accounts.json` is `[]`, and `accounts/<ownId>/` is gone.

> **What a purge does NOT remove:** a custom `media.downloadDir` set in `mcp-config.json`. By default the **MCP server** downloads attachments into `accounts/<ownId>/media/<threadId>/`, like every other command, and a purge removes that with the rest of the account directory; a custom root sits outside it, so its media survives every command in the table above. If a user purges for privacy reasons and set one, tell them, and delete that directory by hand. Official Account credentials at `~/.zalo-agent/oa-credentials.json` are also untouched — a different directory entirely.

## One web session per account

Zalo allows a single web session per account, and this CLI occupies it (measured 2026-09-20):

- Signing into Zalo Web, or another PC client, **revokes the CLI's session server-side instantly** — even with no CLI process running. The next API call fails with `Đăng nhập thất bại`.
- The reverse also holds: `zalo-agent login` signs Zalo Web out.
- The **phone app is unaffected** — it is a separate session type.
- Revocation is server-side, so the credential file on disk is unchanged. `status` is a local check and will still report `loggedIn: true` against a dead session — use `whoami` to probe liveness.
- This is also why `listen`, `mcp start`, and `sync-mobile` cannot run concurrently on one account. A duplicate closes the socket with code 3000, which is fatal by design.
