/**
 * Load/save MCP-specific config from ~/.zalo-agent-cli/mcp-config.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "../core/credentials.js";

const MCP_CONFIG_FILE = join(CONFIG_DIR, "mcp-config.json");

/** Default MCP config — sensible defaults for local development */
export function getDefaultConfig() {
    return {
        watchThreads: ["dm:*", "group:*"],
        mode: "manual",
        triggerKeywords: ["@bot"],
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
    };
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
        const raw = readFileSync(configPath || MCP_CONFIG_FILE, "utf-8");
        const saved = JSON.parse(raw);
        // Shallow merge: saved values override defaults
        return {
            ...defaults,
            ...saved,
            notify: { ...defaults.notify, ...saved.notify },
            limits: { ...defaults.limits, ...saved.limits },
            media: { ...defaults.media, ...saved.media },
        };
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
    const file = configPath || MCP_CONFIG_FILE;
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
 * Save MCP config to disk.
 * @param {object} config
 */
export function saveMCPConfig(config) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
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
