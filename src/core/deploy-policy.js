/**
 * Per-deployment policy for the MCP server, read the way `confirmMode` is (src/core/confirm-guard.js): highest first,
 * the live runtime policy (src/core/policy-store.js, read through ./policy-layer.js on every call), the per-account
 * environment variable (`<NAME>_<ownId>`), then the environment variable, then mcp-config.json, then the default. A value that is not one of the allowed ones is reported once (on stderr) and skipped.
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

import { policyFor } from "./policy-layer.js";

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
function layers(envName, configValue, configName, env, accountId, policyValue) {
    const scoped = accountId ? `${envName}_${accountId}` : null;
    return [
        [policyValue, `policy:${configName}`],
        ...(scoped ? [[env?.[scoped], scoped]] : []),
        [env?.[envName], envName],
        [configValue, configName],
    ];
}

/**
 * The live policy (src/core/policy-store.js) of one account, as a resolver's top layer; `policy` given explicitly
 * (null for none) wins, which is how the tests pin it.
 */
function livePolicy(policy, accountId) {
    return policy === undefined ? policyFor(accountId) : policy;
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
export function resolveHiddenChats({ config, env = process.env, accountId, policy } = {}) {
    const live = livePolicy(policy, accountId);
    for (const [value, source] of layers(
        "ZALO_MCP_HIDDEN_CHATS",
        config?.hiddenChats,
        "hiddenChats",
        env,
        accountId,
        live?.hiddenChats,
    )) {
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
export function resolveAllowPinArgument({ config, env = process.env, accountId, policy } = {}) {
    for (const [value, source] of layers(
        "ZALO_MCP_ALLOW_PIN_ARGUMENT",
        config?.allowPinArgument,
        "allowPinArgument",
        env,
        accountId,
        livePolicy(policy, accountId)?.allowPinArgument,
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
export function resolveApproval({ config, env = process.env, accountId, policy } = {}) {
    const live = livePolicy(policy, accountId)?.approval;
    const pick = (envName, configValue, configName, allowed, fallback) => {
        const top = configName === "approval.secret" ? live?.secret : live?.deliver;
        for (const [value, source] of layers(envName, configValue, configName, env, accountId, top)) {
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

// ── Media delivery (zalo_view_media, `msg media`, /zalo/media/<token>) ─────────────────────────────────────────────

/** How a cached photo, voice message, video or file reaches the caller. */
export const MEDIA_DELIVER_MODES = Object.freeze(["inline", "link", "tempfile"]);
/** The media kinds a message carries, as the cache types them. */
export const MEDIA_KINDS = Object.freeze(["photo", "gif", "doodle", "sticker", "voice", "audio", "video", "file"]);
/** The default mode per kind: pictures and voice inline (up to inlineMaxBytes), video and files as a link. */
export const DEFAULT_MEDIA_DELIVER = Object.freeze({
    photo: "inline",
    gif: "inline",
    doodle: "inline",
    sticker: "inline",
    voice: "inline",
    audio: "inline",
    video: "link",
    file: "link",
});
/** Who may fetch a media link: the MCP bearer token, or the link alone (`auto`: by where the link points). */
export const MEDIA_LINK_AUTHS = Object.freeze(["auto", "bearer", "capability"]);
/** The defaults of the `media.*` limits. */
export const MEDIA_DEFAULTS = Object.freeze({
    inlineMaxBytes: 5 * 1024 * 1024,
    linkTtlMs: 10 * 60_000,
    tempfileTtlMs: 10 * 60_000,
    linkRateLimit: 60,
    capabilityMaxClients: 3,
    capabilityTtlMs: 15 * 60_000,
});

/**
 * A duration as `"10m"`, `"30s"`, `"1h"`, `"500ms"` or a number of milliseconds; null when it is not one.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function durationMs(value) {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
    const m = /^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/i.exec(String(value ?? ""));
    if (!m) return null;
    const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] || "ms").toLowerCase()];
    const n = Number(m[1]) * unit;
    return n > 0 ? n : null;
}

/** The account's own `media` block in mcp-config.json (`accounts.<ownId>.media`), when there is one. */
function accountMedia(config, accountId) {
    const id = accountId ? String(accountId).trim() : "";
    const block = id && config?.accounts && typeof config.accounts === "object" ? config.accounts[id] : null;
    return block?.media && typeof block.media === "object" ? block.media : null;
}

/**
 * Read a per-kind mode list: `"link"` (every kind) or `"photo=inline,video=link"`; an object in mcp-config.json.
 * Unknown kinds and modes are reported once and skipped.
 */
function deliverMap(value, source) {
    if (value === undefined || value === null || value === "") return null;
    const out = {};
    const put = (kind, mode) => {
        const k = String(kind).trim().toLowerCase();
        const m = String(mode ?? "")
            .trim()
            .toLowerCase();
        if (!MEDIA_KINDS.includes(k)) return warnOnce(`${source}.${k}`, kind, `one of ${MEDIA_KINDS.join(", ")}`);
        if (!MEDIA_DELIVER_MODES.includes(m)) return warnOnce(`${source}.${k}`, mode, "inline, link or tempfile");
        out[k] = m;
    };
    if (typeof value === "object") {
        for (const [k, m] of Object.entries(value)) put(k, m);
        return out;
    }
    const text = String(value).trim();
    if (!text.includes("=")) {
        const m = text.toLowerCase();
        if (!MEDIA_DELIVER_MODES.includes(m)) {
            warnOnce(source, value, "inline, link, tempfile or a list like photo=inline,video=link");
            return null;
        }
        for (const k of MEDIA_KINDS) out[k] = m;
        return out;
    }
    for (const pair of text.split(",")) {
        const [k, m] = pair.split("=");
        if (k?.trim()) put(k, m);
    }
    return out;
}

/**
 * How cached media is delivered, and the limits around it (`media.*` in mcp-config.json). Per kind, highest first:
 * `ZALO_MCP_MEDIA_DELIVER_<ownId>`, `ZALO_MCP_MEDIA_DELIVER`, `accounts.<ownId>.media.deliver`, `media.deliver`, then
 * {@link DEFAULT_MEDIA_DELIVER}. A per-call choice (`deliver` on zalo_view_media, `--deliver` on `msg media`) beats
 * all of these; `allowDeliver` caps what any of them may pick.
 *
 * @param {object} [sources]
 * @param {{media?: object, accounts?: object}|null} [sources.config]
 * @param {NodeJS.ProcessEnv} [sources.env]
 * @param {string} [sources.accountId]
 * @returns {{deliver: Record<string, string>, deliverSource: Record<string, string>, allowDeliver: string[],
 *   inlineMaxBytes: number, linkTtlMs: number, tempfileTtlMs: number, linkRateLimit: number,
 *   autoOpen: boolean|null}}
 */
export function resolveMediaDelivery({ config, env = process.env, accountId, policy } = {}) {
    const own = accountMedia(config, accountId);
    const live = livePolicy(policy, accountId)?.media;
    const media = { ...(config?.media || {}), ...(own || {}), ...(live || {}) };
    const id = accountId ? String(accountId).trim() : "";
    const deliver = { ...DEFAULT_MEDIA_DELIVER };
    const deliverSource = Object.fromEntries(MEDIA_KINDS.map((k) => [k, "default"]));
    // Lowest first, so a higher layer overwrites only the kinds it names.
    const layered = [
        [config?.media?.deliver, "media.deliver"],
        [own?.deliver, `accounts.${id}.media.deliver`],
        [env?.ZALO_MCP_MEDIA_DELIVER, "ZALO_MCP_MEDIA_DELIVER"],
        ...(id ? [[env?.[`ZALO_MCP_MEDIA_DELIVER_${id}`], `ZALO_MCP_MEDIA_DELIVER_${id}`]] : []),
        [live?.deliver, "policy:media.deliver"],
    ];
    for (const [value, source] of layered) {
        const map = deliverMap(value, source);
        if (!map) continue;
        for (const [k, m] of Object.entries(map)) {
            deliver[k] = m;
            deliverSource[k] = source;
        }
    }
    let allowDeliver = [...MEDIA_DELIVER_MODES];
    if (Array.isArray(media.allowDeliver)) {
        const listed = media.allowDeliver.map((m) => String(m).trim().toLowerCase());
        const bad = listed.filter((m) => !MEDIA_DELIVER_MODES.includes(m));
        if (bad.length) warnOnce("media.allowDeliver", bad.join(","), "inline, link or tempfile");
        const kept = MEDIA_DELIVER_MODES.filter((m) => listed.includes(m));
        if (kept.length) allowDeliver = kept;
        else warnOnce("media.allowDeliver", "[]", "a list with at least one mode");
    }
    const positive = (value, name, fallback) => {
        if (value === undefined || value === null || value === "") return fallback;
        const n = Number(value);
        if (Number.isInteger(n) && n > 0) return n;
        warnOnce(name, value, "a positive whole number");
        return fallback;
    };
    const duration = (value, name, fallback) => {
        if (value === undefined || value === null || value === "") return fallback;
        const ms = durationMs(value);
        if (ms && ms >= 1000) return ms;
        warnOnce(name, value, 'a duration of at least 1s (e.g. "10m")');
        return fallback;
    };
    const autoOpen = media.autoOpen === true ? true : media.autoOpen === false ? false : null;
    return {
        deliver,
        deliverSource,
        allowDeliver,
        inlineMaxBytes: positive(media.inlineMaxBytes, "media.inlineMaxBytes", MEDIA_DEFAULTS.inlineMaxBytes),
        linkTtlMs: duration(media.linkTtl, "media.linkTtl", MEDIA_DEFAULTS.linkTtlMs),
        tempfileTtlMs: duration(media.tempfileTtl, "media.tempfileTtl", MEDIA_DEFAULTS.tempfileTtlMs),
        linkRateLimit: positive(media.linkRateLimit, "media.linkRateLimit", MEDIA_DEFAULTS.linkRateLimit),
        autoOpen,
    };
}

/**
 * True for a URL whose host is this machine (localhost, 127.0.0.1, [::1]).
 *
 * @param {unknown} url
 * @returns {boolean}
 */
export function isLoopbackUrl(url) {
    try {
        return LOOPBACK_HOSTS.has(new URL(String(url)).hostname.toLowerCase());
    } catch {
        return false;
    }
}

/**
 * Who may fetch a media link (`media.linkAuth`), and how far a capability link travels off this machine.
 *
 * - `bearer`: the request must carry the MCP server's own Authorization (`--auth` / `ZALO_MCP_AUTH_TOKEN` / an OAuth
 *   access token) as well as the link. The default when publicUrl is set to a host other than this machine.
 * - `capability`: the link alone admits. The default on loopback. Off loopback, one link serves at most
 *   `media.capability.maxClients` distinct client addresses (3), each admitted for `media.capability.ttl` (15m) from
 *   its first request: a load balancer, a reconnect on a new network, a video player's range requests.
 *
 * Highest first: `ZALO_MCP_MEDIA_LINK_AUTH_<ownId>`, `ZALO_MCP_MEDIA_LINK_AUTH`, `accounts.<ownId>.media.linkAuth`,
 * `media.linkAuth`, then `auto`. The capability limits read `accounts.<ownId>.media.capability` over
 * `media.capability`, so a deployment (or a SaaS tier) can raise them per account.
 *
 * @param {object} [sources]
 * @param {{media?: object, accounts?: object}|null} [sources.config]
 * @param {NodeJS.ProcessEnv} [sources.env]
 * @param {string} [sources.accountId]
 * @param {string|null} [sources.publicUrl] - where links point (resolvePublicUrl), for `auto`
 * @returns {{linkAuth: "bearer"|"capability", configured: string, source: string, maxClients: number,
 *   clientTtlMs: number}}
 */
export function resolveMediaLinkAuth({ config, env = process.env, accountId, publicUrl = null, policy } = {}) {
    const own = accountMedia(config, accountId);
    const live = livePolicy(policy, accountId)?.media;
    const id = accountId ? String(accountId).trim() : "";
    let configured = "auto";
    let source = "default";
    for (const [value, src] of [
        [live?.linkAuth, "policy:media.linkAuth"],
        ...(id ? [[env?.[`ZALO_MCP_MEDIA_LINK_AUTH_${id}`], `ZALO_MCP_MEDIA_LINK_AUTH_${id}`]] : []),
        [env?.ZALO_MCP_MEDIA_LINK_AUTH, "ZALO_MCP_MEDIA_LINK_AUTH"],
        [own?.linkAuth, `accounts.${id}.media.linkAuth`],
        [config?.media?.linkAuth, "media.linkAuth"],
    ]) {
        const v = String(value ?? "")
            .trim()
            .toLowerCase();
        if (!v) continue;
        if (MEDIA_LINK_AUTHS.includes(v)) {
            configured = v;
            source = src;
            break;
        }
        warnOnce(src, value, "auto, bearer or capability");
    }
    const linkAuth =
        configured === "auto" ? (publicUrl && !isLoopbackUrl(publicUrl) ? "bearer" : "capability") : configured;
    const cap = { ...(config?.media?.capability || {}), ...(own?.capability || {}), ...(live?.capability || {}) };
    let maxClients = MEDIA_DEFAULTS.capabilityMaxClients;
    if (cap.maxClients !== undefined && cap.maxClients !== null && cap.maxClients !== "") {
        const n = Number(cap.maxClients);
        if (Number.isInteger(n) && n >= 1) maxClients = n;
        else warnOnce("media.capability.maxClients", cap.maxClients, "a whole number of at least 1");
    }
    let clientTtlMs = MEDIA_DEFAULTS.capabilityTtlMs;
    if (cap.ttl !== undefined && cap.ttl !== null && cap.ttl !== "") {
        const ms = durationMs(cap.ttl);
        if (ms && ms >= 1000) clientTtlMs = ms;
        else warnOnce("media.capability.ttl", cap.ttl, 'a duration of at least 1s (e.g. "15m")');
    }
    return { linkAuth, configured, source, maxClients, clientTtlMs };
}

/**
 * The reverse proxies whose `X-Forwarded-For` this server believes (`trustedProxies`, `ZALO_MCP_TRUSTED_PROXIES` as
 * a comma list). Empty by default: the client address is the socket's peer, as for every other route. List the
 * proxy's own address (e.g. `127.0.0.1`) when one sits in front, or the media links' per-client limits see one
 * client. `loopback` stands for 127.0.0.1 and ::1.
 *
 * @param {object} [sources]
 * @param {{trustedProxies?: unknown}|null} [sources.config]
 * @param {NodeJS.ProcessEnv} [sources.env]
 * @param {string} [sources.accountId]
 * @returns {string[]}
 */
export function resolveTrustedProxies({ config, env = process.env, accountId } = {}) {
    for (const [value] of layers(
        "ZALO_MCP_TRUSTED_PROXIES",
        config?.trustedProxies,
        "trustedProxies",
        env,
        accountId,
    )) {
        if (value === undefined || value === null || value === "") continue;
        const list = Array.isArray(value) ? value : String(value).split(",");
        return list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    }
    return [];
}
