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
 * - `publicUrl` (`--public-url`, `ZALO_MCP_PUBLIC_URL`): the one address people and clients reach this server at, behind
 *   a reverse proxy or TLS terminator: the MCP endpoint, the OAuth issuer, the one-time secure page
 *   (src/core/secure-page.js) and the QR login page (src/utils/qr-http-server.js). See resolvePublicUrl.
 * - `approval.secret` (`ZALO_MCP_APPROVAL_SECRET`) and `approval.deliver` (`ZALO_MCP_APPROVAL_DELIVER`): what the approve
 *   page asks besides a click, and where a page's link goes (resolveApproval, src/core/approval.js).
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

/** The deprecated names of `publicUrl`, as they were released in 2.x for the OAuth issuer alone. */
export const PUBLIC_URL_ALIASES = Object.freeze(["--issuer-url", "ZALO_MCP_ISSUER_URL", "oauth.issuerUrl"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
let aliasNoted = false;

/**
 * Check one public URL: an absolute http(s) URL with an optional base path and nothing else. Returns it normalized
 * (lower-case host, default port dropped, trailing slashes trimmed), or why it cannot be used.
 *
 * - No user name or password, no query, no fragment.
 * - A base path is allowed (`https://example.com/zalo`), for a proxy that mounts this server under a prefix and strips
 *   it; links are then `<publicUrl>/zalo/secure/<token>` and the OAuth issuer is the URL as given. No `.` or `..`
 *   segment and no empty one.
 * - https only, except for localhost, 127.0.0.1 and [::1], which may be http (a browser on this machine): a link to a
 *   public host over http would carry one-time tokens and OAuth codes in clear.
 *
 * @param {unknown} value
 * @returns {{url: string|null, error: string|null}}
 */
export function validatePublicUrl(value) {
    const text = String(value ?? "").trim();
    if (!text) return { url: null, error: null };
    const refuse = (why) => ({ url: null, error: `"${text}" ${why}` });
    if (/[?#]/.test(text)) return refuse("has a query or fragment; give the address only (https://host[/base-path])");
    let url;
    try {
        url = new URL(text);
    } catch {
        return refuse("is not an absolute URL (https://host[/base-path])");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return refuse("is not an http(s) URL");
    if (url.username || url.password) return refuse("carries a user name or password");
    const raw = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/\/+$/, "");
    if (
        raw &&
        raw
            .split("/")
            .slice(1)
            .some((seg) => seg === "" || seg === "." || seg === "..")
    )
        return refuse("has an empty, . or .. path segment");
    if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()))
        return refuse(
            "is http on a host other than this machine: use https (the links carry one-time tokens); http is allowed only for localhost, 127.0.0.1 and [::1]",
        );
    return { url: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, error: null };
}

/**
 * The one public address of this server (`publicUrl`), and where it came from. Highest first: the `--public-url` flag,
 * `ZALO_MCP_PUBLIC_URL_<ownId>`, `ZALO_MCP_PUBLIC_URL`, the account's block in mcp-config.json
 * (`accounts.<ownId>.publicUrl`), `publicUrl`, then the deprecated 2.x names in the same order (`--issuer-url`,
 * `ZALO_MCP_ISSUER_URL[_<ownId>]`, `oauth.issuerUrl`), which print a note once per process.
 *
 * The first value set decides: one that does not pass validatePublicUrl is an `error` for the caller to refuse,
 * never a silent fall-through to a lower layer or to the local address. Unset, `publicUrl` is null: links use the
 * server's local address, and only the OAuth metadata still infers its origin from the request.
 *
 * @param {object} [sources]
 * @param {string|null} [sources.flag] - `--public-url`
 * @param {string|null} [sources.issuerFlag] - `--issuer-url` (deprecated alias)
 * @param {{publicUrl?: unknown, oauth?: {issuerUrl?: unknown}, accounts?: object}|null} [sources.config]
 * @param {NodeJS.ProcessEnv} [sources.env]
 * @param {string} [sources.accountId]
 * @param {(line: string) => void} [sources.note] - where the deprecation note goes (stderr)
 * @param {boolean} [sources.aliases] - read the deprecated names too (default); `login` does not, as they only ever
 *   named the OAuth issuer and a proxy built for them does not route the QR page
 * @returns {{publicUrl: string|null, source: string, error: string|null, deprecated: boolean}}
 */
export function resolvePublicUrl({
    flag,
    issuerFlag,
    config,
    env = process.env,
    accountId,
    note = (line) => console.error(line),
    aliases = true,
} = {}) {
    const id = accountId ? String(accountId).trim() : "";
    const block = id && config?.accounts && typeof config.accounts === "object" ? config.accounts[id] : null;
    const scoped = (name) => (id ? [[env?.[`${name}_${id}`], `${name}_${id}`]] : []);
    const current = [
        [flag, "--public-url"],
        ...scoped("ZALO_MCP_PUBLIC_URL"),
        [env?.ZALO_MCP_PUBLIC_URL, "ZALO_MCP_PUBLIC_URL"],
        ...(block ? [[block.publicUrl, `accounts.${id}.publicUrl`]] : []),
        [config?.publicUrl, "publicUrl"],
    ];
    const legacy = [
        [issuerFlag, "--issuer-url"],
        ...scoped("ZALO_MCP_ISSUER_URL"),
        [env?.ZALO_MCP_ISSUER_URL, "ZALO_MCP_ISSUER_URL"],
        ...(block ? [[block.oauth?.issuerUrl, `accounts.${id}.oauth.issuerUrl`]] : []),
        [config?.oauth?.issuerUrl, "oauth.issuerUrl"],
    ];
    for (const [layer, deprecated] of [
        [current, false],
        [aliases ? legacy : [], true],
    ]) {
        for (const [value, source] of layer) {
            if (value === undefined || value === null || String(value).trim() === "") continue;
            const { url, error } = validatePublicUrl(value);
            if (deprecated && !aliasNoted) {
                aliasNoted = true;
                note(
                    `[config] ${source} is a deprecated name of publicUrl (--public-url, ZALO_MCP_PUBLIC_URL): ` +
                        "one address now serves the MCP endpoint, the OAuth issuer and the one-time pages. It still works.",
                );
            }
            if (error) return { publicUrl: null, source, error: `${source} ${error}`, deprecated };
            return { publicUrl: url, source, error: null, deprecated };
        }
    }
    return { publicUrl: null, source: "default", error: null, deprecated: false };
}

/** Forget that the deprecation note was printed (tests). */
export function resetPublicUrlNote() {
    aliasNoted = false;
}

/** What a person must type on an approve page (confirmMode "human") besides pressing Approve. */
export const APPROVAL_SECRETS = Object.freeze(["auto", "pin", "password", "none"]);
/** Where the link of a one-time page goes. */
export const APPROVAL_DELIVERIES = Object.freeze(["result", "webhook", "both"]);

/**
 * How the one-time pages reach a person, and what the approve page asks of them (`approval.secret`,
 * `approval.deliver`), and where each came from.
 *
 * - `secret` (`ZALO_MCP_APPROVAL_SECRET`): `pin` (the hidden-chat PIN, checked as the PIN page checks it, with its
 *   lockout), `password` (the approver password set with `mcp approver set`, kept only as a salted scrypt hash), `none`
 *   (a click approves: an agent that can open the link can approve its own action), or `auto` (the default: the
 *   approver password when one is set and the link travels through the agent, else nothing).
 * - `deliver` (`ZALO_MCP_APPROVAL_DELIVER`): `result` (the default: the link is in the tool result), `webhook` (the link
 *   is POSTed to the MCP webhook as an `approval_requested` event and the tool result carries none), or `both`.
 *
 * @param {object} [sources]
 * @param {{approval?: {secret?: unknown, deliver?: unknown}}|null} [sources.config]
 * @param {NodeJS.ProcessEnv} [sources.env]
 * @param {string} [sources.accountId]
 * @returns {{secret: "auto"|"pin"|"password"|"none", secretSource: string, deliver: "result"|"webhook"|"both", deliverSource: string}}
 */
export function resolveApproval({ config, env = process.env, accountId } = {}) {
    const pick = (envName, configValue, configName, allowed, fallback) => {
        for (const [value, source] of layers(envName, configValue, configName, env, accountId)) {
            const v = String(value ?? "")
                .trim()
                .toLowerCase();
            if (!v) continue;
            if (allowed.includes(v)) return [v, source];
            warnOnce(source, value, allowed.join(", "));
        }
        return [fallback, "default"];
    };
    const [secret, secretSource] = pick(
        "ZALO_MCP_APPROVAL_SECRET",
        config?.approval?.secret,
        "approval.secret",
        APPROVAL_SECRETS,
        "auto",
    );
    const [deliver, deliverSource] = pick(
        "ZALO_MCP_APPROVAL_DELIVER",
        config?.approval?.deliver,
        "approval.deliver",
        APPROVAL_DELIVERIES,
        "result",
    );
    return { secret, secretSource, deliver, deliverSource };
}
