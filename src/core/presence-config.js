/**
 * One account's presence settings (src/core/presence.js), layered like every other runtime setting:
 * built-in defaults < files (`mcp-config.json` `presence`, then `accounts.<ownId>.presence`) < environment
 * (`ZALO_PRESENCE_MODE[_<ownId>]`, `ZALO_PRESENCE_IDLE_TIMEOUT[_<ownId>]`) < policy (tenant < user < account, from
 * ./policy-layer.js). Presence keys are live: a daemon reads them again on a policy change.
 *
 * The role decides first: a process whose only consumer is its own stdout (stdio MCP, a foreground `listen` printing
 * events) is always-on whatever the settings say. `listen` and `mcp start` both resolve through here (WP3).
 */
import { durationMs } from "./deploy-policy.js";
import { policyFor } from "./policy-layer.js";
import { PRESENCE_DEFAULTS, normalizePresenceSettings } from "./presence.js";
import { envForAccount } from "../mcp/mcp-config.js";

/** The `presence` keys in mcp-config.json and the policy, and the setting each one fills. */
export const PRESENCE_KEYS = Object.freeze({
    mode: "mode",
    idleTimeout: "idleTimeoutMs",
    minConnected: "minConnectedMs",
    maxWakesPerHour: "maxWakesPerHour",
    warmWait: "warmWaitMs",
    connectOnStart: "connectOnStart",
    catchUpEvery: "catchUpEveryMs",
    maxLeases: "maxLeases",
    leaseTtl: "leaseTtlMs",
    leaseTtlMax: "leaseTtlMaxMs",
    waitHoldsSocket: "waitHoldsSocket",
    onKick: "onKick",
});

const MS_KEYS = new Set([
    "idleTimeoutMs",
    "minConnectedMs",
    "warmWaitMs",
    "catchUpEveryMs",
    "leaseTtlMs",
    "leaseTtlMaxMs",
]);

/** One layer's `presence` block into settings (unknown or unusable values are left out). */
function fromBlock(block) {
    const out = {};
    if (!block || typeof block !== "object") return out;
    for (const [key, setting] of Object.entries(PRESENCE_KEYS)) {
        const v = block[key];
        if (v === undefined || v === null || v === "") continue;
        if (setting === "catchUpEveryMs" && String(v).trim().toLowerCase() === "off") out[setting] = 0;
        else if (MS_KEYS.has(setting)) {
            const ms = durationMs(v);
            if (ms) out[setting] = ms;
        } else if (typeof PRESENCE_DEFAULTS[setting] === "boolean") {
            const t = String(v).trim().toLowerCase();
            if (v === true || ["1", "true", "on", "yes"].includes(t)) out[setting] = true;
            else if (v === false || ["0", "false", "off", "no"].includes(t)) out[setting] = false;
        } else if (typeof PRESENCE_DEFAULTS[setting] === "number") {
            const n = Number(v);
            if (Number.isInteger(n) && n > 0) out[setting] = n;
        } else out[setting] = String(v).trim().toLowerCase();
    }
    return out;
}

/**
 * @param {object} args
 * @param {object} [args.config] - the merged MCP config (its `presence` block and `accounts.<ownId>.presence`)
 * @param {string} [args.accountId]
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {"stdio"|"http"|"stdout"|"webhook"} [args.transport] - who reads this daemon: `stdio` and `stdout` force
 *   always-on (the plan's section 2.1)
 * @returns {{settings: object, forced: string|null, sources: Record<string, string>}}
 */
export function resolvePresenceSettings({ config = {}, accountId, env = process.env, transport = "http" } = {}) {
    const sources = {};
    const layers = [];
    const id = accountId ? String(accountId).trim() : "";
    layers.push(["mcp-config.json", fromBlock(config?.presence)]);
    if (id) layers.push([`mcp-config.json accounts.${id}`, fromBlock(config?.accounts?.[id]?.presence)]);
    layers.push([
        "environment",
        fromBlock({
            mode: envForAccount("ZALO_PRESENCE_MODE", id, env),
            idleTimeout: envForAccount("ZALO_PRESENCE_IDLE_TIMEOUT", id, env),
        }),
    ]);
    layers.push(["policy", fromBlock(policyFor(id)?.presence)]);
    const merged = {};
    for (const [name, values] of layers) {
        for (const [k, v] of Object.entries(values)) {
            merged[k] = v;
            sources[k] = name;
        }
    }
    let forced = null;
    if (transport === "stdio" || transport === "stdout") {
        forced = transport === "stdio" ? "stdio MCP lives with its client" : "a foreground listener prints to stdout";
        merged.mode = "always-on";
        sources.mode = "role";
    }
    return { settings: normalizePresenceSettings(merged), forced, sources };
}
