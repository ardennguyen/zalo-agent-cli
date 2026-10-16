/**
 * Load/save MCP-specific config from ~/.zalo-agent-cli/mcp-config.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "../core/credentials.js";

function mcpConfigFile() {
    return join(CONFIG_DIR, "mcp-config.json");
}

/** Default MCP config — sensible defaults for local development */
export function getDefaultConfig() {
    return {
        watchThreads: ["dm:*", "group:*"],
        mode: "manual",
        triggerKeywords: ["@bot"],
        webhook: null,
        notify: {
            enabled: false,
            thread: null,
            on: ["dm"],
            cooldown: "5m",
        },
        limits: {
            maxMessagesPerPoll: 20,
            autoDigestThreshold: 50,
            bufferMaxAge: "2h",
            bufferMaxSize: 500,
        },
        media: {
            downloadDir: null, // unset -> the same per-account dir every other command uses
            autoOpen: true,
        },
        tls: {
            cert: null,
            key: null,
        },
        oauth: {
            clientId: null,
            clientSecret: null,
            issuerUrl: null,
            clients: [],
        },
        webhookSecret: null,
        httpPort: null,
        host: null,
    };
}

/**
 * Deep-merge an override layer over a base MCP config object.
 * @param {object} base
 * @param {object} layer
 * @returns {object}
 */
export function mergeMCPConfigLayer(base, layer) {
    if (!layer || typeof layer !== "object") return base;
    return {
        ...base,
        ...layer,
        notify: { ...base.notify, ...(layer.notify || {}) },
        limits: { ...base.limits, ...(layer.limits || {}) },
        media: { ...base.media, ...(layer.media || {}) },
        tls: { ...base.tls, ...(layer.tls || {}) },
        oauth: {
            ...base.oauth,
            ...(layer.oauth || {}),
            clients: Array.isArray(layer.oauth?.clients)
                ? layer.oauth.clients
                : Array.isArray(base.oauth?.clients)
                  ? base.oauth.clients
                  : [],
        },
    };
}

/**
 * Resolve an environment variable with per-account priority:
 * checks `<baseKey>_<accountId>` first (when `accountId` is provided), then `<baseKey>`.
 *
 * @param {string} baseKey - Base environment variable name (e.g. "ZALO_MCP_AUTH_TOKEN")
 * @param {string|null|undefined} accountId - Zalo account ID (`ownId`)
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment dictionary
 * @returns {string|null} Trimmed non-empty string, or null
 */
export function envForAccount(baseKey, accountId, env = process.env) {
    if (accountId !== undefined && accountId !== null && String(accountId).trim()) {
        const scoped = env?.[`${baseKey}_${String(accountId).trim()}`];
        if (typeof scoped === "string" && scoped.trim()) {
            return scoped.trim();
        }
    }
    const globalVal = env?.[baseKey];
    if (typeof globalVal === "string" && globalVal.trim()) {
        return globalVal.trim();
    }
    return null;
}

/**
 * Load MCP config from disk, merged with defaults.
 *
 * `configPath` exists because `mcp start --config <path>` has always accepted a
 * path and this function has always ignored it: the flag was declared, parsed,
 * and then dropped, so anyone pointing at a second config got the default one
 * and no warning. Callers that pass nothing keep the old behaviour exactly.
 *
 * @param {string} [configPath] - explicit config file; defaults to CONFIG_DIR/mcp-config.json
 * @returns {object} MCP config
 */
export function loadMCPConfig(configPath) {
    const defaults = getDefaultConfig();
    try {
        const raw = readFileSync(configPath || mcpConfigFile(), "utf-8");
        const saved = JSON.parse(raw);
        return mergeMCPConfigLayer(defaults, saved);
    } catch {
        // File doesn't exist or invalid JSON — use defaults
        return defaults;
    }
}

/**
 * Read the MCP config the way `mcp start` needs it: as loadMCPConfig does, but
 * saying when the file it was pointed at could not be used.
 *
 * loadMCPConfig answers a missing `--config` file, or a config that is not
 * valid JSON, with the defaults -- and the defaults watch every thread. A
 * server meant to see one group then buffers every DM for its bots, and says
 * nothing. Only the default file being absent is a normal state (nothing has
 * been configured yet); anything else is a `problem` for the caller to refuse.
 *
 * @param {string} [configPath] - explicit config file; defaults to CONFIG_DIR/mcp-config.json
 * @returns {{config: object, problem: string|null}}
 */
export function readMCPConfig(configPath) {
    const file = configPath || mcpConfigFile();
    let raw;
    try {
        raw = readFileSync(file, "utf-8");
    } catch (e) {
        if (!configPath && e.code === "ENOENT") return { config: getDefaultConfig(), problem: null };
        return { config: getDefaultConfig(), problem: `cannot read the config file ${file} (${e.code || e.message})` };
    }
    try {
        JSON.parse(raw);
    } catch (e) {
        return { config: getDefaultConfig(), problem: `the config file ${file} is not valid JSON (${e.message})` };
    }
    return { config: loadMCPConfig(configPath), problem: null };
}

/**
 * Resolve per-account MCP config overrides for `--account <ownId>`:
 * 1. `baseConfig.accounts?.[accountId]` inside the main `mcp-config.json`
 * 2. `<accountDir>/mcp-config.json` (when `explicitConfigPath` is not set and the file exists)
 *
 * If `<accountDir>/mcp-config.json` exists but is unreadable or invalid JSON, returns `problem`
 * so `mcp start` refuses rather than falling back to defaults.
 *
 * @param {object} baseConfig - Config returned by `readMCPConfig`
 * @param {{ accountId?: string|null, accountDir?: string|null, explicitConfigPath?: string|null }} [opts]
 * @returns {{ config: object, problem: string|null }}
 */
export function resolveAccountMCPConfig(baseConfig, { accountId, accountDir, explicitConfigPath } = {}) {
    let merged = baseConfig || getDefaultConfig();
    const id = accountId !== undefined && accountId !== null ? String(accountId).trim() : "";
    if (id && merged.accounts && typeof merged.accounts === "object" && merged.accounts[id]) {
        merged = mergeMCPConfigLayer(merged, merged.accounts[id]);
    }
    if (!explicitConfigPath && accountDir) {
        const perAccountFile = join(accountDir, "mcp-config.json");
        let raw = null;
        try {
            raw = readFileSync(perAccountFile, "utf-8");
        } catch (e) {
            if (e.code !== "ENOENT") {
                return {
                    config: merged,
                    problem: `cannot read the per-account config file ${perAccountFile} (${e.code || e.message})`,
                };
            }
        }
        if (raw !== null) {
            try {
                const parsed = JSON.parse(raw);
                merged = mergeMCPConfigLayer(merged, parsed);
            } catch (e) {
                return {
                    config: merged,
                    problem: `the per-account config file ${perAccountFile} is not valid JSON (${e.message})`,
                };
            }
        }
    }
    return { config: merged, problem: null };
}

/**
 * Save MCP config to disk.
 * @param {object} config
 */
export function saveMCPConfig(config) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(mcpConfigFile(), JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Parse duration string (e.g. "2h", "5m", "30s") to milliseconds.
 * @param {string|number} duration
 * @returns {number} Milliseconds
 */
export function parseDuration(duration) {
    if (typeof duration === "number") return duration;
    const match = String(duration).match(/^(\d+)\s*(h|m|s|ms)?$/i);
    if (!match) return 0;
    const value = parseInt(match[1], 10);
    const unit = (match[2] || "ms").toLowerCase();
    const multipliers = { h: 3600000, m: 60000, s: 1000, ms: 1 };
    return value * (multipliers[unit] || 1);
}
