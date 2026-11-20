/**
 * `zalo-agent mcp agents`: the account's agents (the Message Router's `routing.agents`), each one's effective mark and
 * presence as its running daemon last wrote it, and the account's MCP credentials with the agent each is bound to.
 * The operator's view of what `zalo_inbox` `agents` answers an agent; the access API serves the same report
 * (`GET /access/<ownId>/agents`). Read-only: agents are set through the policy (`policy set routing.agents …`) or
 * mcp-config.json's `routing` block.
 */

import { join } from "node:path";
import { selectDaemonAccount } from "../core/daemon-account.js";
import { getAccountDir } from "../core/credentials.js";
import { listApiKeys } from "../core/api-keys.js";
import { agentsReport } from "../mcp/agents.js";
import { OAUTH_STATE_FILE, configuredOAuthClients, createOAuthStore } from "../mcp/mcp-oauth.js";
import { loadMCPConfig, resolveAccountMCPConfig } from "../mcp/mcp-config.js";
import { error, info, output } from "../utils/output.js";

/**
 * The account's MCP credentials as agents are bound to them: its API keys and OAuth clients.
 *
 * @param {string} dir - the account folder
 * @param {object} config - the account's MCP config
 * @returns {Array<{credential: string, label: string|null, kind: string}>}
 */
export function accountCredentials(dir, config) {
    const keys = listApiKeys(dir).map((k) => ({
        credential: `apikey:${k.keyId}`,
        label: k.label,
        kind: "mcp-key",
        expired: k.expired,
    }));
    const configured = [...configuredOAuthClients(config?.oauth ?? null).clients.values()].map((c) => ({
        credential: `oauth:${c.clientId}`,
        label: c.name ?? c.clientId,
        kind: "mcp-oauth",
    }));
    let stored = [];
    try {
        stored = createOAuthStore({ file: join(dir, OAUTH_STATE_FILE) })
            .listClients()
            .map((c) => ({ credential: `oauth:${c.clientId}`, label: c.name ?? c.clientId, kind: "mcp-oauth" }));
    } catch {
        /* no OAuth state on this account */
    }
    return [...keys, ...configured, ...stored];
}

/**
 * Register `mcp agents`.
 *
 * @param {import("commander").Command} mcp - the `mcp` command
 * @param {import("commander").Command} program - the root, for `--json` and `--account`
 */
export function registerMCPAgentsCommand(mcp, program) {
    mcp.command("agents")
        .description(
            "The account's agents (routing.agents): name, mark, delivery and presence as the running daemon last " +
                "saw it, and the MCP credentials (API keys, OAuth clients) with the agent each is bound to",
        )
        .option("--account <id>", "Account (default: the active one)")
        .option("--config <path>", "The MCP config file (default: the usual mcp-config.json)")
        .action(async (opts) => {
            const json = program.opts().json;
            let ownId;
            try {
                const requested =
                    opts.account ?? program.opts().account ?? (process.env.ZALO_ACCOUNT?.trim() || undefined);
                ownId = selectDaemonAccount(requested).ownId;
            } catch (e) {
                error(`Account selection failed: ${e.message}`);
                process.exit(1);
            }
            const dir = getAccountDir(ownId);
            const { config } = resolveAccountMCPConfig(loadMCPConfig(opts.config), {
                accountId: ownId,
                accountDir: dir,
                explicitConfigPath: opts.config,
            });
            const report = agentsReport({
                accountId: ownId,
                accountDir: dir,
                config,
                credentials: accountCredentials(dir, config),
            });
            output(report, json, () => {
                if (!report.agents.length) info("No agents: set routing.agents in the policy or mcp-config.json.");
                for (const a of report.agents) {
                    const p = a.presence;
                    info(
                        `${a.slug}  ${a.name}  [${a.kind}]  ${a.credential}  mark: ${a.marksShown ? a.effectiveMark : "(hidden)"}` +
                            `  ${p.state}${p.lastSeen ? ` (last seen ${p.lastSeen})` : ""}${a.enabled ? "" : "  disabled"}`,
                    );
                }
                const free = report.credentials.filter((c) => !c.agent);
                if (free.length)
                    info(`Not bound to an agent: ${free.map((c) => `${c.credential} (${c.label ?? "-"})`).join(", ")}`);
                info(`Marks: ${report.marks}; listening = seen within ${report.presenceWindowSec} s.`);
            });
        });
}
