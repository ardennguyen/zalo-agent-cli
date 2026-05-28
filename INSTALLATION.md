# Zalo MCP Server & CLI Installation Guide

This document combines the deployment instructions, configuration examples, and walkthrough details for configuring the Zalo Model Context Protocol (MCP) server.

---

# 🤖 Zalo Model Context Protocol (MCP) Server & CLI (README)

This package provides a self-contained, isolated **Model Context Protocol (MCP)** server and command-line interface (CLI) to automate Zalo personal accounts and Zalo Official Accounts (OA) API v3.0. It allows AI agents (like Claude Code, Cursor, and others) to interact directly with Zalo.

---

## 🚀 Quick Start (Initialization)

To keep your host system clean and isolated, all dependencies are installed locally:
*   **Node.js dependencies** are installed inside a local `node_modules/` folder.
*   **Python dependencies** (optional, for PDF generation and reporting) are isolated inside a local virtual environment (`venv/`).

### 1. Run the Installer
Run the setup script for your operating system to automatically verify requirements and perform local installations. 

During setup, you will be prompted to select the port configurations:
*   **Zalo OA Webhook Port** (Default: `3000`)
*   **Zalo MCP HTTP Port** (Default: `3847` — only required if you run the MCP in HTTP/remote mode instead of stdio mode)

#### Automatic/Interactive:
*   **Windows**: Double-click `init.bat` or run in PowerShell/CMD:
    ```bash
    .\init.bat
    ```
*   **macOS / Linux**: Run in your terminal:
    ```bash
    chmod +x init.sh
    ./init.sh
    ```

#### Non-interactive (Automation/CI):
You can pass the ports as command-line arguments to skip the interactive prompt:
```bash
# Windows
.\init.bat --oa-port 3000 --mcp-port 3847

# macOS / Linux
./init.sh --oa-port 3000 --mcp-port 3847
```

---

## 🔑 Authentication Flows

All authentication details are kept strictly local and secure on your machine.

### A. Personal Zalo Account (Unofficial API)
To log in with a personal Zalo account:
1. Run the login command:
   ```bash
   npm run login
   ```
2. A QR code will print in your terminal.
3. Open the **Zalo app on your mobile phone** and scan the QR code using the **Zalo QR Scanner** (do not use your phone's default camera app).
4. Confirm the login on your phone.

> [!IMPORTANT]
> **Credential Storage Location:**  
> Your personal session credentials are encrypted and stored at:  
> *   `~/.zalo-agent-cli/` (with safe `0600` permissions).  
>
> **Safety Notice:** This is an unofficial API. While the library implements stealth measures, there is a risk of account ban. Do not use your primary personal account for heavy spam.

---

### B. Zalo Official Account (OA) (Official API v3.0)
To log in with a Zalo Official Account (secure, official API):
1. Run the Official Account initialization wizard:
   ```bash
   npx zalo-agent oa init --app-id <YOUR_APP_ID> --secret <YOUR_APP_SECRET>
   ```
2. Follow the prompt to authorize the app via your browser.
3. If you are deploying on a headless VPS, you can run:
   ```bash
   npx zalo-agent oa login --app-id <YOUR_APP_ID> --secret <YOUR_APP_SECRET> --callback-host https://your-domain.com
   ```

> [!IMPORTANT]
> **Credential Storage Location:**  
> Your Zalo OA Access Token and Refresh Token are stored at:  
> *   `~/.zalo-agent/oa-credentials.json` (with safe `0600` permissions).  
>
> OA Access Tokens expire after 25 hours. You can refresh them anytime by running:
> ```bash
> npx zalo-agent oa refresh
> ```

---

## 🤖 AI Agent Integration (MCP)

To hook up this Zalo MCP server to your AI clients, configure them to run this server in stdio mode:

### 1. Claude Code
Add the following block to your `mcpServers` configuration in `~/.claude/settings.json` (or `%USERPROFILE%\.gemini\antigravity\mcp_config.json`):

```json
{
  "mcpServers": {
    "zalo": {
      "command": "node",
      "args": ["V:/zalo_mcp_deploy/mcp-server.js"],
      "cwd": "V:/zalo_mcp_deploy"
    }
  }
}
```

### 2. Cursor / Other Clients
Add a new MCP server in your editor settings:
*   **Name:** `zalo`
*   **Type:** `stdio`
*   **Command:** `node V:/zalo_mcp_deploy/mcp-server.js`

---

## 🛠️ Updating & Fail-Safe Fallbacks

If a new version of the Zalo automation engine is released, or if you want to pull updates for Node.js modules or Python packages safely:

*   **Windows**: Run `update.bat`
*   **macOS / Linux**: Run `./update.sh`

### 🔒 NPM Registry Fail-Safe
If the `zalo-agent-cli` package is ever removed or unpublished from the global npm registry:
1. Open `package.json`.
2. Change the dependency definition from:
   ```json
   "zalo-agent-cli": "^1.6.2"
   ```
   to pull directly from the GitHub repository:
   ```json
   "zalo-agent-cli": "github:ardennguyen/zalo-agent-cli"
   ```
3. Re-run `init.bat` (or `./init.sh`). It will cleanly pull the source code directly from GitHub, install it in `node_modules`, and resolve normally.

---

## 🧰 CLI Command Reference

Once initialized, you can run any of these commands locally using `npx zalo-agent <command>`. Append `--json` to any command for clean machine-readable outputs.

### Personal Account Commands
| Command | Description |
|:---|:---|
| `npx zalo-agent status` | Check current connection and login status |
| `npx zalo-agent msg send <threadId> "text"` | Send text message (DM) |
| `npx zalo-agent msg send <threadId> "text" -t 1` | Send text message to a group |
| `npx zalo-agent msg send-image <threadId> <path>` | Send an image |
| `npx zalo-agent msg send-file <threadId> <path>` | Send a file (PDF, zip, etc.) |
| `npx zalo-agent msg undo <msgId> <threadId>` | Recall/delete a message for everyone |
| `npx zalo-agent friend search "Name/Phone"` | Find friends |
| `npx zalo-agent friend list` | List all friends |
| `npx zalo-agent group list` | List all joined groups |
| `npx zalo-agent group members <groupId>` | List group members |
| `npx zalo-agent listen` | Run real-time message listener |
| `npx zalo-agent listen --webhook <url>` | Forward real-time messages to a webhook URL |
| `npx zalo-agent msg send-qr-transfer <id> <bank>` | Send a VietQR payment template |

### Official Account (OA) Commands
| Command | Description |
|:---|:---|
| `npx zalo-agent oa whoami` | View Official Account profile details |
| `npx zalo-agent oa msg text <userId> "text"` | Send official text message to a follower |
| `npx zalo-agent oa follower list` | List all Official Account followers |
| `npx zalo-agent oa upload image <path>` | Upload image to Zalo server (returns ID) |
| `npx zalo-agent oa listen -p <port>` | Start a local webhook listener on the specified port |

---

## 📦 How to Package for Others

If you want to share this Zalo MCP setup with another user:
1. Zip **only** the following minimal files (do **NOT** include `node_modules/`, `venv/`, `.env`, or `.git/`):
   *   `package.json`
   *   `package-lock.json`
   *   `mcp-server.js`
   *   `requirements.txt`
   *   `init.bat` / `init.sh`
   *   `update.bat` / `update.sh`
   *   `README.md`
   *   `WALKTHROUGH.md`
2. Send the ZIP to the user.
3. They will extract it and double-click `init.bat` (or run `./init.sh`). It will fetch everything cleanly, keeping their system isolated.

---

# Walkthrough: Zalo MCP Deployment Packaging (WALKTHROUGH)

This section walks through the final clean, consumer-ready state of the packaged Zalo MCP integration folder.

## 🛠️ Components Created & Cleaned

### 1. File Cleanups
We removed all the developer source code and tooling configuration files from the cloned repository. The following items were deleted:
*   `src/`, `docs/`, `skill/`, `assets/`, `.github/` (Directories)
*   `eslint.config.js`, `.prettierrc`, `CHANGELOG.md`, `CONTRIBUTING.md`, `DISCLAIMER.md`, `LICENSE`, `RELEASING.md`, `TEST.md` (Files)

This leaves a clean distribution workspace containing only 12 core files and 3 subdirectories.

### 2. Package Configuration
*   `package.json`: Converted from a package builder setup to a standard consumer setup. It defines a dependency on the compiled `"zalo-agent-cli": "github:ardennguyen/zalo-agent-cli"` package.
*   `init.bat`: Windows batch script that checks Node, runs `npm install` (creating local `node_modules`), checks Python, and creates a local `venv` using `call` prefixes to correctly support path shims.
*   `init.sh`: Equivalent bash script for macOS and Linux.
*   `update.bat` & `update.sh`: Safe updates for dependencies.
*   `mcp-server.js`: Loads environment configs and runs `zalo-agent mcp start`.
*   `README.md`: Full bilingual deployment guide.

---

## 🧪 Verification Results

1.  **Node.js Clean Install**: Re-running the initialization script after cleaning the directory successfully downloaded the compiled `zalo-agent-cli` library from npm and set it up inside `node_modules`.
2.  **Isolated CLI Verification**: Checked that the local binary works:
    ```bash
    npx zalo-agent --version
    ```
    Output:
    ```
    1.6.2
    ```
    This confirms the environment resolves correctly, is fully functional, and remains completely isolated from the global system.
