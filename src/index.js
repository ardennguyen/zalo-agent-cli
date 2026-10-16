#!/usr/bin/env node

/**
 * zalo-agent-cli — CLI for Zalo automation with multi-account + proxy support.
 * Entry point: registers all command groups via Commander.js.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { registerLoginCommands } from "./commands/login.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
import { registerMsgCommands } from "./commands/msg.js";
import { registerFriendCommands } from "./commands/friend.js";
import { registerGroupCommands } from "./commands/group.js";
import { registerConvCommands } from "./commands/conv.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerProfileCommands } from "./commands/profile.js";
import { registerPollCommands } from "./commands/poll.js";
import { registerReminderCommands } from "./commands/reminder.js";
import { registerAutoReplyCommands } from "./commands/auto-reply.js";
import { registerQuickMsgCommands } from "./commands/quick-msg.js";
import { registerLabelCommands } from "./commands/label.js";
import { registerCatalogCommands } from "./commands/catalog.js";
import { registerListenCommand } from "./commands/listen.js";
import { registerOACommands } from "./commands/oa.js";
import { registerMCPCommands } from "./commands/mcp.js";
import { registerSyncCommands } from "./commands/sync.js";
import { autoLogin } from "./core/zalo-client.js";
import { getActive, setPinnedAccount } from "./core/accounts.js";
import { parseAccountId, selectDaemonAccount } from "./core/daemon-account.js";
import { configureStoragePaths } from "./core/credentials.js";
import { logoutNeedsSession } from "./core/logout.js";
import { checkForUpdates, selfUpdate } from "./utils/update-check.js";
import { applyCachedThreadType } from "./utils/thread-type.js";
import { success, error, warning } from "./utils/output.js";

const DISCLAIMER =
    "This tool uses unofficial Zalo APIs (zca-js) — your account may be banned. Use at your own risk. | Tool này dùng API Zalo không chính thức (zca-js) — account có thể bị ban. Tự chịu trách nhiệm.";

const program = new Command();

program
    .name("zalo-agent")
    .description("CLI tool for Zalo automation — multi-account, proxy, bank transfers, QR payments")
    .version(pkg.version)
    .option("--json", "Output results as JSON (machine-readable)")
    .option(
        "--account <id>",
        "Pin this command to an exact registered account ID without changing the active account (env: ZALO_ACCOUNT)",
        parseAccountId,
    )
    .option("--env-file <path>", "Load environment variables from a .env file (env: ZALO_ENV_FILE)")
    .option("--config-dir <dir>", "Config directory (default: ~/.zalo-agent-cli, env: ZALO_CONFIG_DIR)")
    .option(
        "--credentials-dir <dir>",
        "Credentials directory (default: <config-dir>/credentials, env: ZALO_CREDENTIALS_DIR)",
    )
    .option(
        "--data-dir <dir>",
        "Per-account database and runtime directory (default: <config-dir>/accounts, env: ZALO_DATA_DIR)",
    )
    .option("--media-dir <dir>", "Downloaded media directory (default: <data-dir>/<ownId>/media, env: ZALO_MEDIA_DIR)")
    .option("--oa-dir <dir>", "Official Account credentials directory (default: ~/.zalo-agent, env: ZALO_OA_DIR)")
    .hook("preAction", async (thisCommand, actionCommand) => {
        const globalOpts = program.opts();
        configureStoragePaths({
            envFile: globalOpts.envFile,
            configDir: globalOpts.configDir,
            credentialsDir: globalOpts.credentialsDir,
            dataDir: globalOpts.dataDir,
            mediaDir: globalOpts.mediaDir,
            oaDir: globalOpts.oaDir,
        });
        const cmdName = thisCommand.args?.[0] || thisCommand.name();
        // Suppress zca-js internal logs in JSON mode to keep stdout clean for piping
        if (globalOpts.json || cmdName === "mcp") {
            // Suppress zca-js stdout logs: JSON mode needs clean output, MCP uses stdout as transport
            process.env.ZALO_JSON_MODE = "1";
        } else if (cmdName !== "oa") {
            // OA commands use official Zalo API — no disclaimer needed
            warning(DISCLAIMER);
            console.log();
        }
        // Pin the target account for this invocation when --account or ZALO_ACCOUNT is set,
        // without changing the global active entry in accounts.json. Daemons (`listen`, `mcp`)
        // perform their own selection and lock acquisition inside their command actions.
        const envAccount = process.env.ZALO_ACCOUNT?.trim() || undefined;
        const requestedAccount = actionCommand.opts()?.account ?? globalOpts.account ?? envAccount;
        if (
            requestedAccount !== undefined &&
            !["mcp", "listen", "oa", "update", "help", "version", "login"].includes(cmdName)
        ) {
            try {
                const pinned = selectDaemonAccount(requestedAccount);
                setPinnedAccount(pinned.ownId);
            } catch (e) {
                error(e.message);
                process.exit(1);
            }
        }
        // Auto-login before any command that needs it (skip for login/account/oa
        // commands, and for a logout that will not call Zalo at all).
        // Daemons authenticate their pinned identity after acquiring its lock.
        const skipAutoLogin =
            ["login", "account", "help", "version", "update", "oa", "mcp", "listen"].includes(cmdName) ||
            (cmdName === "logout" && !logoutNeedsSession(actionCommand.opts(), getActive()));
        if (!skipAutoLogin) {
            await autoLogin(program.opts().json);
        }
        // Non-blocking update check (skip for update command itself)
        if (cmdName !== "update") {
            checkForUpdates(pkg.version, program.opts().json);
        }
        // Every command taking `--type` defaults it to 0 (1-1), which is wrong
        // for every group and silently so. The cache knows which is which.
        applyCachedThreadType(actionCommand);
    });

// Self-update command
program
    .command("update")
    .description("Update zalo-agent-cli to the latest version")
    .action(() => {
        const ok = selfUpdate();
        if (ok) success(`Updated to latest version`);
        else error("Update failed. Try manually: npm install -g @ardennguyen/zalo-agent-cli@latest");
    });

// Register all command groups
registerLoginCommands(program);
registerMsgCommands(program);
registerFriendCommands(program);
registerGroupCommands(program);
registerConvCommands(program);
registerAccountCommands(program);
registerProfileCommands(program);
registerPollCommands(program);
registerReminderCommands(program);
registerAutoReplyCommands(program);
registerQuickMsgCommands(program);
registerLabelCommands(program);
registerCatalogCommands(program);
registerListenCommand(program);
registerOACommands(program);
registerMCPCommands(program);
registerSyncCommands(program);

program.parse();
