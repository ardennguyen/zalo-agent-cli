# Use case b: an HTTP MCP server on your desktop or LAN

[Tiếng Việt](README.vi.md) · Settings: [docs/configuration.md](../../../configuration.md) · Servers on the internet: [c-vps-few-accounts](../c-vps-few-accounts/README.md)

One long-running MCP server per account on a Windows or macOS machine, reached over HTTP by AI clients on the same machine (loopback) or the same LAN. It keeps running when no client is open, and comes back after a reboot as a Windows service or a launchd agent.

## 1. The files

| File in this folder | Goes to | What it is |
|---|---|---|
| `server-loopback.env` | `~/.zalo-agent-cli/server.env` | clients on this machine only (127.0.0.1) |
| `server-lan.env` | `~/.zalo-agent-cli/server.env` | clients on the LAN (the LAN address, firewalled to the subnet) |
| `home/.zalo-agent-cli/mcp-config.json` | `~/.zalo-agent-cli/mcp-config.json` | thread filters, media, presence on-demand |
| `home/.zalo-agent-cli/storage.windows.json` | `~/.zalo-agent-cli/storage.json` on Windows | optional: DPAPI CurrentUser, the default |
| `home/.zalo-agent-cli/storage.macos.json` | `~/.zalo-agent-cli/storage.json` on macOS | optional: the keychain, the default |
| `home/.zalo-agent-cli/.env` | `~/.zalo-agent-cli/.env` | optional: settings every command reads |
| `windows/zalo-mcp-service.xml` | next to `zalo-mcp-service.exe` (WinSW) | Windows service, graceful Ctrl+C stop |
| `macos/com.example.zalo-mcp.plist` | `~/Library/LaunchAgents/` | launchd agent of your user |
| `clients/claude-code-http-lan.json` | the client's `.mcp.json` | Claude Code over HTTP with the bearer token |

Pick one of the two `server-*.env` files and copy it as `server.env`. The token goes **only** in that file (mode 600, or only your user on Windows), never on a command line.

## 2. Steps

1. Install and log in as in [a-desktop-stdio](../a-desktop-stdio/README.md) (a normal shell, never elevated).
2. Make the token: `openssl rand -hex 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) and put it in `server.env` as `ZALO_MCP_AUTH_TOKEN`.
3. Try it in the foreground first:
   ```bash
   zalo-agent --env-file ~/.zalo-agent-cli/server.env mcp start --account 1000000000000000001
   ```
   Stop with Ctrl+C.
4. Run it for good:
   - **Windows:** WinSW (`zalo-mcp-service.xml`, your user as the service account, not LocalSystem): `.\zalo-mcp-service.exe install`, then `start`.
   - **macOS:** edit the paths in the plist (`CHANGE_ME_USER`, `command -v zalo-agent`), then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.zalo-mcp.plist`.
   - Or, without a service manager: `zalo-agent --env-file ... mcp start --account <id> -d` (stops at logout or reboot).
5. On the LAN, open the port to the subnet only: Windows `New-NetFirewallRule -DisplayName "Zalo MCP" -Direction Inbound -Protocol TCP -LocalPort 3847 -RemoteAddress 192.168.1.0/24 -Action Allow`; macOS's application firewall asks on first start.
6. Point the client at it with `clients/claude-code-http-lan.json` (`ZALO_MCP_TOKEN` in the client's environment).

## 3. Verify

```bash
curl -s http://127.0.0.1:3847/health                                        # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://192.168.1.20:3847/mcp   # 401 without the token
zalo-agent mcp start --account 1000000000000000001 --status
```

On plain http off loopback the server hands out no media links (they carry one-time tokens and need https): pictures come inline, other media as a temp file. For links on the LAN, give it a certificate (`ZALO_MCP_TLS_CERT` / `ZALO_MCP_TLS_KEY` in `server.env`).

## 4. The phone, Zalo PC and Zalo Web

Zalo keeps **one web login per account**, and this server is it. A QR login into **Zalo Web** signs the server out (the service then stops with "login refused" and needs `zalo-agent login` again). The **phone** and the **Zalo PC app** work beside it. Use those, not Zalo Web. And run each account in one place only: a second copy of the same login (another machine, or `mcp start` beside the service) kicks this one off.
