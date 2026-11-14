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
import { registerReadCommands } from "./commands/read.js";
import { registerWriteCommands } from "./commands/write.js";
import { registerCatalogCommands } from "./commands/catalog.js";
import { registerBankCommands } from "./commands/bank.js";
import { registerListenCommand } from "./commands/listen.js";
import { registerOACommands } from "./commands/oa.js";
import { registerZbsCommands } from "./commands/zbs.js";
import { registerMCPCommands } from "./commands/mcp.js";
import { registerFleetCommands } from "./commands/fleet.js";
import { registerSyncCommands } from "./commands/sync.js";
import { registerCloudCommands } from "./commands/cloud.js";
import { registerDbCommands } from "./commands/db.js";
import { registerPolicyCommands } from "./commands/policy.js";
import { registerPresenceCommands } from "./commands/presence.js";
// The runtime policy's store registers itself as the resolvers' top layer (src/core/policy-layer.js).
import "./core/policy-store.js";
import { autoLogin } from "./core/zalo-client.js";
import { getActive, setPinnedAccount } from "./core/accounts.js";
import { parseAccountId, selectDaemonAccount } from "./core/daemon-account.js";
import { configureStoragePaths } from "./core/credentials.js";
import { logoutNeedsSession } from "./core/logout.js";
import { checkForUpdates, selfUpdate } from "./utils/update-check.js";
import { applyCachedThreadType } from "./utils/thread-type.js";
import { attachDaemonLogIfChild } from "./core/daemon-channel.js";
import { success, error, warning, setReplyContext } from "./utils/output.js";
import { enforceCliGuard } from "./core/confirm-guard.js";
import { TEST_FAKE_API_REFUSED } from "./core/test-fake-session.js";

attachDaemonLogIfChild();

const DISCLAIMER =
    "This tool uses unofficial Zalo APIs — your account may be banned. Use at your own risk. | Tool này dùng API Zalo không chính thức — account có thể bị ban. Tự chịu trách nhiệm.";

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
        // What a --json reply names when Zalo's answer is empty (src/utils/output.js jsonReply).
        setReplyContext(actionCommand);
        // JSON mode keeps stdout clean for piping, and MCP uses stdout as its transport
        if (globalOpts.json || cmdName === "mcp") {
            // Every human-facing line goes elsewhere (src/utils/output.js reads this)
            process.env.ZALO_JSON_MODE = "1";
        } else if (cmdName !== "oa" && cmdName !== "zbs") {
            // OA and ZBS commands use official Zalo APIs — no disclaimer needed
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
            !["mcp", "listen", "oa", "zbs", "update", "help", "version", "login", "fleet"].includes(cmdName)
        ) {
            try {
                const pinned = selectDaemonAccount(requestedAccount);
                setPinnedAccount(pinned.ownId);
            } catch (e) {
                error(e.message);
                process.exit(1);
            }
        }
        // A destructive command without --yes stops here (exit 2), and --dry-run reports it (exit 0): both
        // before the login below, so neither can send anything (src/core/confirm-guard.js).
        enforceCliGuard(actionCommand, { json: Boolean(globalOpts.json) });
        // A command's own check of its arguments that must refuse before any login (`conv hidden-pin <pin>`, whose
        // PIN argument was removed: it would sit in the shell history).
        actionCommand.zaloPreflight?.(actionCommand, { json: Boolean(globalOpts.json) });
        // Auto-login before any command that needs it (skip for login/account/oa
        // commands, and for a logout that will not call Zalo at all).
        // Daemons authenticate their pinned identity after acquiring its lock.
        const skipAutoLogin =
            ["login", "account", "help", "version", "update", "oa", "zbs", "mcp", "listen", "fleet"].includes(
                cmdName,
            ) ||
            // A command that only reads the local cache (`msg search`) needs no session.
            actionCommand.zaloLocalOnly === true ||
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
registerReadCommands(program);
registerWriteCommands(program);
registerCatalogCommands(program);
registerBankCommands(program);
registerListenCommand(program);
registerOACommands(program);
registerZbsCommands(program);
registerMCPCommands(program);
registerFleetCommands(program);
registerSyncCommands(program);
registerCloudCommands(program);
registerDbCommands(program);
registerPolicyCommands(program);
registerPresenceCommands(program);

// parseAsync, so a registry that exists but cannot be read (src/core/accounts.js) reaches the user as a
// message, not as a stack trace from inside a command; so does a refused test-only fake session
// (src/core/test-fake-session.js), and so does a saved file the key layer cannot open (src/core/keystore/: no
// provider, wrong key, the dkey layer locked). Anything else is rethrown exactly as before.
program.parseAsync().catch((e) => {
    if (
        e?.name === "RegistryError" ||
        e?.code === TEST_FAKE_API_REFUSED ||
        e?.name === "KeystoreError" ||
        e?.name === "SealError"
    ) {
        error(e.message);
        process.exit(1);
    }
    throw e;
});
