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
| expired | Auto-retries with a fresh QR |

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

# Switch active
zalo-agent account switch <ownerId>

# List all
zalo-agent account list
```

## Proxy Support
Formats: `http://user:pass@host:port`, `socks5://user:pass@host:port`
Tested: IPRoyal residential, datacenter proxies.
Rule: 1 unique proxy per account — shared proxies risk ban.

## Logging Out & Removing Accounts

Pick by how much you want gone. All four are distinct:

| Command | Server session | Credentials | Local cache (`zalo.db`, `media/`) | Registry entry |
|---------|:---:|:---:|:---:|:---:|
| `logout` | invalidated | kept | kept | kept |
| `logout --no-remote` | left valid (local-only) | kept | kept | kept |
| `logout --delete-history` | invalidated | kept | **deleted** | kept |
| `logout --purge` | invalidated | **deleted** | **deleted** | **removed** |
| `account remove <ownerId>` | invalidated (if that account is active) | **deleted** | **deleted** | **removed** |

- `logout` (default) performs a real server-side `logoutV2()` — a later authenticated request fails with error 600. `--no-remote` restores the old local-only behavior, leaving the cookie valid indefinitely.
- `--purge` and `account remove` **abort** if a `listen` daemon still holds that account's `daemon.lock`, reporting the PID. Stop the daemon first.
- `zalo-agent account devices` lists the sessions Zalo currently has linked to the active account (read-only) — useful to confirm a logout actually took effect on the server side.

After a purge, `~/.zalo-agent-cli/credentials/` is empty, `accounts.json` is `[]`, and `accounts/<ownId>/` is gone.
