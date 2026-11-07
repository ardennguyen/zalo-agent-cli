/**
 * Per-deployment policy for the MCP server, read the way `confirmMode` is (src/core/confirm-guard.js): highest first,
 * the per-account environment variable (`<NAME>_<ownId>`), then the environment variable, then mcp-config.json, then
 * the default. A value that is not one of the allowed ones is reported once (on stderr) and skipped.
 *
 * - `hiddenChats` (`ZALO_MCP_HIDDEN_CHATS`): what the MCP server shows of the account's hidden conversations.
 *   `exclude` (default) leaves them out of every list, search, history and event, as Zalo Web does until the PIN is
 *   typed; `contentless` also leaves them out of lists, but an event in one is still passed on as
 *   `{event, hidden: true}` with no thread id and no content (Web's unread dot); `include` shows them like any other
 *   conversation, which hands them to the agent: an owner's explicit choice.
 * - `allowPinArgument` (`ZALO_MCP_ALLOW_PIN_ARGUMENT`): the hidden-chat tools accept the PIN as a `pin` input. Off by
 *   default: an input is written to the MCP client's logs and the model's context. For non-AI clients only.
 * - `pinPage.publicBaseUrl` (`ZALO_MCP_PIN_PAGE_URL`): the address a person's browser reaches this server's secure
 *   input page at, behind a reverse proxy or TLS terminator (src/core/secure-page.js).
 *
 * The CLI does not read these: it follows its own flags (`--include-hidden`, `--pin-stdin`).
 */

/** The hiddenChats policies. */
export const HIDDEN_CHAT_MODES = Object.freeze(["exclude", "contentless", "include"]);

const TRUE = ["1", "true", "on", "yes"];
const FALSE = ["0", "false", "off", "no"];
const warned = new Set();

function warnOnce(source, value, allowed) {
    const key = `${source}=${value}`;
    if (warned.has(key)) return;
    warned.add(key);
    console.error(`[policy] ${source} "${value}" is not ${allowed}; ignoring it`);
}

/**
 * The places one setting is read from, highest first.
 *
 * @param {string} envName - e.g. ZALO_MCP_HIDDEN_CHATS
 * @param {unknown} configValue - the mcp-config.json value
 * @param {string} configName - its key, for `source`
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [accountId]
 * @returns {Array<[unknown, string]>}
 */
function layers(envName, configValue, configName, env, accountId) {
    const scoped = accountId ? `${envName}_${accountId}` : null;
    return [...(scoped ? [[env?.[scoped], scoped]] : []), [env?.[envName], envName], [configValue, configName]];
}

/**
 * The deployment's hiddenChats policy, and where it came from.
 *
 * @param {object} [sources]
 * @param {{hiddenChats?: unknown}|null} [sources.config]
 * @param {NodeJS.ProcessEnv} [sources.env]
 * @param {string} [sources.accountId]
 * @returns {{mode: "exclude"|"contentless"|"include", source: string}}
 */
export function resolveHiddenChats({ config, env = process.env, accountId } = {}) {
    for (const [value, source] of layers("ZALO_MCP_HIDDEN_CHATS", config?.hiddenChats, "hiddenChats", env, accountId)) {
        const mode = String(value ?? "")
            .trim()
            .toLowerCase();
        if (!mode) continue;
        if (HIDDEN_CHAT_MODES.includes(mode)) return { mode, source };
        warnOnce(source, value, "exclude, contentless or include");
    }
    return { mode: "exclude", source: "default" };
}

/**
 * Whether the hidden-chat tools take the PIN as an input (`allowPinArgument`), and where that came from.
 *
 * @param {object} [sources]
 * @param {{allowPinArgument?: unknown}|null} [sources.config]
 * @param {NodeJS.ProcessEnv} [sources.env]
 * @param {string} [sources.accountId]
 * @returns {{allowed: boolean, source: string}}
 */
export function resolveAllowPinArgument({ config, env = process.env, accountId } = {}) {
    for (const [value, source] of layers(
        "ZALO_MCP_ALLOW_PIN_ARGUMENT",
        config?.allowPinArgument,
        "allowPinArgument",
        env,
        accountId,
    )) {
        if (value === undefined || value === null || value === "") continue;
        if (value === true || value === false) return { allowed: value, source };
        const v = String(value).trim().toLowerCase();
        if (TRUE.includes(v)) return { allowed: true, source };
        if (FALSE.includes(v)) return { allowed: false, source };
        warnOnce(source, value, "true or false");
    }
    return { allowed: false, source: "default" };
}

/**
 * The secure input page's public base URL (`pinPage.publicBaseUrl`), or null for the local address. Only http(s)
 * URLs are taken; a trailing slash is dropped.
 *
 * @param {object} [sources]
 * @param {{pinPage?: {publicBaseUrl?: unknown}}|null} [sources.config]
 * @param {NodeJS.ProcessEnv} [sources.env]
 * @param {string} [sources.accountId]
 * @returns {{publicBaseUrl: string|null, source: string}}
 */
export function resolvePinPage({ config, env = process.env, accountId } = {}) {
    for (const [value, source] of layers(
        "ZALO_MCP_PIN_PAGE_URL",
        config?.pinPage?.publicBaseUrl,
        "pinPage.publicBaseUrl",
        env,
        accountId,
    )) {
        const text = String(value ?? "").trim();
        if (!text) continue;
        let url;
        try {
            url = new URL(text);
        } catch {
            url = null;
        }
        if (url && (url.protocol === "https:" || url.protocol === "http:") && !url.search && !url.hash) {
            return { publicBaseUrl: text.replace(/\/+$/, ""), source };
        }
        warnOnce(source, value, "an http(s) URL without a query");
    }
    return { publicBaseUrl: null, source: "default" };
}
