/**
 * Load/save MCP-specific config from ~/.zalo-agent-cli/mcp-config.json.
 */

import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "../core/credentials.js";
import { writeFileAtomic } from "../zalo/kernel/atomic-file.js";
import { policyFor } from "../core/policy-layer.js";

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
        // Cached media (src/core/media-deliver.js, resolveMediaDelivery / resolveMediaLinkAuth in
        // src/core/deploy-policy.js). Unset (null) keys take the defaults named beside them.
        media: {
            downloadDir: null, // unset -> the same per-account dir every other command uses
            // zalo_view_media opens the file with this machine's viewer: unset = true on stdio, false over HTTP.
            autoOpen: null,
            // Per kind: "inline" (MCP image/audio content), "link" (/zalo/media/<token>) or "tempfile" (a private
            // decrypted copy). Unset: photo/gif/doodle/sticker/voice/audio inline, video/file link.
            deliver: null,
            inlineMaxBytes: null, // 5242880: larger media goes as a link
            allowDeliver: null, // ["inline","link","tempfile"]: what a call (or the defaults) may pick
            linkTtl: null, // "10m"
            tempfileTtl: null, // "10m"
            linkAuth: null, // "auto": "bearer" when publicUrl is another host, else "capability"
            linkRateLimit: null, // 60 requests a minute per client address
            capability: null, // {maxClients: 3, ttl: "15m"}: distinct client addresses a capability link serves
        },
        // Reverse proxies whose X-Forwarded-For is believed (e.g. ["127.0.0.1"]). Unset (null) means
        // ZALO_MCP_TRUSTED_PROXIES, else none: the client address is the socket's peer.
        trustedProxies: null,
        tls: {
            cert: null,
            key: null,
        },
        oauth: {
            clientId: null,
            clientSecret: null,
            issuerUrl: null, // deprecated name of publicUrl, still read
            clients: [],
        },
        webhookSecret: null,
        webhookBatchSize: 1, // events per webhook POST; 1 = each event alone, exactly as before the outbox
        webhookMaxAge: "24h", // an undelivered event older than this is dead-lettered, never silently dropped
        // Who confirms a guarded action (src/core/confirm-guard.js): "agent", "human" or "off". Unset (null) means
        // ZALO_MCP_CONFIRM_MODE, then the deprecated groupConfirm / ZALO_MCP_GROUP_CONFIRM, else "agent". It is not
        // defaulted to "agent" here: a default would hide a file's own groupConfirm: false.
        confirmMode: null,
        // What agents see of the account's hidden chats (src/core/deploy-policy.js): "exclude", "contentless" or
        // "include". Unset (null) means ZALO_MCP_HIDDEN_CHATS, else "exclude", as Zalo Web hides them until the PIN.
        hiddenChats: null,
        // Whether the hidden-chat tools take the PIN as an input. It puts the PIN in the MCP client's logs: for
        // non-AI clients only. Unset (null) means ZALO_MCP_ALLOW_PIN_ARGUMENT, else false.
        allowPinArgument: null,
        // The one address people and clients reach this server at, behind a reverse proxy or TLS terminator
        // (src/core/deploy-policy.js resolvePublicUrl): the MCP endpoint, the OAuth issuer, the one-time secure page
        // and the QR login page. An https URL with an optional base path (http only for localhost). Unset (null) means
        // --public-url / ZALO_MCP_PUBLIC_URL, then the deprecated oauth.issuerUrl, else the server's local address.
        publicUrl: null,
        // The one-time pages' delivery and the approve page's secret (src/core/approval.js). `secret`: "auto" (unset:
        // the approver password when one is set and the link reaches the agent), "pin", "password" or "none";
        // `deliver`: "result" (unset: the link is in the tool result), "webhook" (only to the webhook) or "both".
        // Unset (null) means ZALO_MCP_APPROVAL_SECRET / ZALO_MCP_APPROVAL_DELIVER, else the defaults above.
        approval: {
            secret: null,
            deliver: null,
        },
        // The admin API's own credential (src/core/admin-api.js; /zalo/admin/policy, /zalo/admin/usage), never the
        // agent's. `tokenFile`: a file holding the admin token (a systemd credential, a KMS-decrypted mount); unset
        // means ZALO_MCP_ADMIN_TOKEN_FILE, and `zalo-agent policy token --rotate` keeps one sealed in the key layer.
        // `clientCa`: a CA whose client certificates are admitted (mTLS; needs --cert/--key). Read at start.
        admin: {
            tokenFile: null,
            clientCa: null,
        },
        // On-demand presence (src/core/presence.js, resolved by src/core/presence-config.js): when the daemon holds the
        // account's one socket. Unset (null) keys take the defaults named beside them; the runtime policy beats them.
        presence: {
            mode: null, // "on-demand" (backends) or "always-on"; stdio MCP and a stdout listener are always-on
            idleTimeout: null, // "5m" with no demand before the socket parks (at least "30s")
            minConnected: null, // "60s": never parks sooner after connecting
            maxWakesPerHour: null, // 12: over it, the idle timeout doubles per wake (up to an hour)
            warmWait: null, // "10s": how long a cache read waits for a waking socket
            connectOnStart: null, // true: one catch-up at start, then park
            catchUpEvery: null, // "off": a periodic catch-up while parked ("6h" etc.)
            maxLeases: null, // 64 CRM leases per account
            leaseTtl: null, // "90s" when a lease names none
            leaseTtlMax: null, // "600s"
            waitHoldsSocket: null, // true: a pending wait holds the socket (a tier may turn it off)
            onKick: null, // "yield" (on-demand: let the account go until someone asks) or "exit" (code 3)
        },
        httpPort: null,
        host: null,
    };
}

/** The media block of two layers: its per-kind `deliver` map and `capability` limits merge key by key. */
function mergeMedia(base = {}, layer) {
    if (!layer || typeof layer !== "object") return { ...base };
    const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
    const out = { ...base, ...layer };
    for (const key of ["deliver", "capability"]) {
        if (obj(base?.[key]) && obj(layer[key])) out[key] = { ...base[key], ...layer[key] };
    }
    return out;
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
        media: mergeMedia(base.media, layer.media),
        tls: { ...base.tls, ...(layer.tls || {}) },
        approval: { ...base.approval, ...(layer.approval || {}) },
        admin: { ...base.admin, ...(layer.admin || {}) },
        presence: { ...base.presence, ...(layer.presence || {}) },
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
    // Atomic, and 0600: the file can hold a webhook or OAuth secret.
    writeFileAtomic(mcpConfigFile(), JSON.stringify(config, null, 2));
}

/**
 * The webhook delivery settings of one account: `ZALO_WEBHOOK_BATCH_SIZE[_<ownId>]` and
 * `ZALO_WEBHOOK_MAX_AGE[_<ownId>]` (under the live policy's `webhookBatchSize` / `webhookMaxAge`), else `webhookBatchSize` / `webhookMaxAge` from the MCP config
 * (`listen` has no config file and reads only the environment). A value that cannot be used falls
 * back to the default and is reported, so a typo is not mistaken for a working setting.
 *
 * @param {string} accountId
 * @param {object} [config] - Resolved MCP config, or none for `listen`
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ batchSize: number, maxAgeMs: number, warnings: string[] }}
 */
export function resolveWebhookDelivery(accountId, config = {}, env = process.env, policy = undefined) {
    const warnings = [];
    const defaults = getDefaultConfig();
    // The live policy (src/core/policy-store.js) is above the environment.
    const live = policy === undefined ? policyFor(accountId) : policy;

    const rawBatch =
        live?.webhookBatchSize ?? envForAccount("ZALO_WEBHOOK_BATCH_SIZE", accountId, env) ?? config?.webhookBatchSize;
    let batchSize = defaults.webhookBatchSize;
    if (rawBatch !== undefined && rawBatch !== null && rawBatch !== "") {
        const n = Number(rawBatch);
        if (Number.isInteger(n) && n >= 1 && n <= 100) batchSize = n;
        else warnings.push(`webhook batch size "${rawBatch}" is not a whole number from 1 to 100; using ${batchSize}`);
    }

    const rawAge =
        live?.webhookMaxAge ?? envForAccount("ZALO_WEBHOOK_MAX_AGE", accountId, env) ?? config?.webhookMaxAge;
    let maxAgeMs = parseDuration(defaults.webhookMaxAge);
    if (rawAge !== undefined && rawAge !== null && rawAge !== "") {
        const ms = parseDuration(rawAge);
        if (ms >= 60_000) maxAgeMs = ms;
        else
            warnings.push(
                `webhook max age "${rawAge}" is not a duration of at least 1m (e.g. 6h, 24h); using ${defaults.webhookMaxAge}`,
            );
    }
    return { batchSize, maxAgeMs, warnings };
}

/**
 * The webhook receiver of one account: the live policy's `webhook`, then the flag (`--webhook`), then
 * `ZALO_WEBHOOK_URL[_<ownId>]`, then `webhook` in the MCP config; null for none.
 *
 * @param {object} args
 * @param {string} args.accountId
 * @param {string|null} [args.flag]
 * @param {object} [args.config]
 * @param {NodeJS.ProcessEnv} [args.env]
 * @returns {string|null}
 */
export function resolveWebhookUrl({ accountId, flag = null, config = {}, env = process.env }) {
    const live = policyFor(accountId)?.webhook;
    return (
        (typeof live === "string" && live.trim()) ||
        flag?.trim() ||
        envForAccount("ZALO_WEBHOOK_URL", accountId, env) ||
        (typeof config?.webhook === "string" && config.webhook.trim()) ||
        null
    );
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
