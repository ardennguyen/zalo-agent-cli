# Use case a: one person, one desktop, stdio MCP

[Tiếng Việt](README.vi.md) · Install: [INSTALLATION.md](../../../../INSTALLATION.md) · Settings: [docs/configuration.md](../../../configuration.md)

Claude Desktop or Claude Code on your own Windows or macOS machine starts the MCP server itself, over stdio, for one or two of your Zalo accounts. Nothing listens on the network; nothing runs when the client is closed.

## 1. The files

| File in this folder | Goes to | What it is |
|---|---|---|
| `home/.zalo-agent-cli/mcp-config.json` | `~/.zalo-agent-cli/mcp-config.json` (Windows `%USERPROFILE%\.zalo-agent-cli\`) | optional: thread filters, media, confirm mode; presence always-on (stdio stays connected) |
| `home/.zalo-agent-cli/storage.windows.json` | `~/.zalo-agent-cli/storage.json` on Windows | optional: the default (DPAPI, your Windows user) spelled out |
| `home/.zalo-agent-cli/storage.macos.json` | `~/.zalo-agent-cli/storage.json` on macOS | optional: the default (the login keychain) spelled out |
| `home/.zalo-agent-cli/.env` | `~/.zalo-agent-cli/.env` | optional: settings every command reads |
| `clients/claude-code.json` | your project's `.mcp.json` (or `claude mcp add`) | Claude Code, through the `zalo-mcp` wrapper |
| `clients/claude-desktop.json` | `claude_desktop_config.json` | Claude Desktop, one entry per account |

Claude Desktop's file: Windows `%APPDATA%\Claude\claude_desktop_config.json`, macOS `~/Library/Application Support/Claude/claude_desktop_config.json`.

## 2. Steps

1. Install Node 22.19 or later and the engine: `npm install -g @ardennguyen/zalo-agent-cli` (or the `zalo-mcp` wrapper's installer, [INSTALLATION.md](../../../../INSTALLATION.md)).
2. Log in from a normal terminal (never an Administrator or `sudo` shell): `zalo-agent login`, scan the QR with the Zalo app, then `zalo-agent account list` for the account id.
3. Optional: copy `mcp-config.json`, the `storage.*.json` for your system (renamed `storage.json`) and `.env` into `~/.zalo-agent-cli/`.
4. Put the client file in place with your account id instead of `1000000000000000001`. On macOS, Claude Desktop does not see your shell's PATH: give `command` the full path `command -v zalo-agent` prints (for example `/opt/homebrew/bin/zalo-agent`).
5. Restart the client and ask it to list your recent Zalo conversations.

A second account: a second entry with its own `--account`. Each account is one server process.

## 3. Verify

```bash
zalo-agent account list                 # the account, active
zalo-agent account security status      # the files sealed by DPAPI / the keychain
zalo-agent mcp start --account 1000000000000000001 --status   # only while the client runs it
```

## 4. The phone, Zalo PC and Zalo Web

Zalo keeps **one web login per account**, and this server is it. Logging the same account into **Zalo Web** (chat.zalo.me) by QR signs the server out: its login is refused, and every tool call answers `SIGNED_OUT` until you run `zalo-agent login` again (scan the QR) and restart the client. The **phone** and the **Zalo PC app** are separate logins and work beside it. Use the phone or Zalo PC, not Zalo Web.

Each QR login adds a new entry to the phone's device list (the older web entries show as logged out). A re-login of the same account keeps its device id, so the messages Zalo queued for it while it was away still arrive.

Do not run the same account in two clients at once either (Claude Desktop and Claude Code both starting `--account <same id>`): the second start finds the account in use.

## 5. When the login is about to end

The QR login lasts about 90 days and Zalo never renews it. You are told ahead of time: `zalo-agent login` and every server start print the end date, `mcp start --status` warns from 14 days left, and the agent itself sees a `session_expiring` system event (with a `text`, in `zalo_get_messages` / `zalo_wait_for_message`) at 14, 7, 3 and 1 days left and once it has ended; a `webhook`, if you set one, gets the same event. To renew: `zalo-agent --account <id> login` (or `zalo-agent login` for your only account), scan the QR, then restart the client so it starts the server again. The device id stays the same, so messages queued while it was away still arrive. Miss the date and every tool call answers `SIGNED_OUT` until you log in again.
