/**
 * The runtime policy's schema: every key the policy store (./policy-store.js) takes, how its value is checked, and the
 * keys it refuses because they only take effect at a restart.
 *
 * A policy document is nested JSON, keyed like mcp-config.json and storage.json (`{"media": {"linkAuth": "bearer"}}`);
 * a key is named by its dotted path (`media.linkAuth`) in the CLI, the admin API's errors and the audit log. A leaf
 * whose value is itself an object (`media.deliver`) is one key.
 *
 * Secrets never go in a policy (a webhook signing secret, tokens, key material): those keys are refused like the
 * restart-only ones, so a policy file and the audit log never hold one.
 */
import {
    APPROVAL_DELIVERIES,
    APPROVAL_SECRETS,
    HIDDEN_CHAT_MODES,
    MEDIA_DELIVER_MODES,
    MEDIA_KINDS,
    MEDIA_LINK_AUTHS,
    durationMs,
} from "./deploy-policy.js";

const CONFIRM_MODES = ["agent", "human", "off"];
const TRUE = ["1", "true", "on", "yes"];
const FALSE = ["0", "false", "off", "no"];
const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/**
 * A storage size: a whole number of bytes, or `"2GB"`, `"500MB"`, `"1.5TB"` (1 KB = 1024 bytes); `"unlimited"` is
 * no limit (an explicit one, which beats a lower layer's limit). Null when it is not one.
 *
 * @param {unknown} value
 * @returns {number|"unlimited"|null}
 */
export function parseBytes(value) {
    if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
    const text = String(value ?? "")
        .trim()
        .toLowerCase();
    if (text === "unlimited") return "unlimited";
    const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/.exec(text);
    if (!m) return null;
    const n = Math.floor(Number(m[1]) * UNITS[m[2] || "b"]);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * A number of days, `"30d"` (or a bare whole number); null when it is not one.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseDays(value) {
    const m = /^\s*(\d+)\s*d?\s*$/i.exec(String(value ?? ""));
    if (!m) return null;
    const n = Number(m[1]);
    return n >= 1 && n <= 36500 ? n : null;
}

/** `keep`, or a number of days. */
function keepOrDays(value) {
    if (
        String(value ?? "")
            .trim()
            .toLowerCase() === "keep"
    )
        return { value: "keep" };
    const d = parseDays(value);
    return d ? { value: `${d}d` } : { error: 'is not "keep" or a number of days (e.g. "90d")' };
}

const oneOf = (allowed) => (value) => {
    const v = String(value ?? "")
        .trim()
        .toLowerCase();
    return allowed.includes(v) ? { value: v } : { error: `is not one of ${allowed.join(", ")}` };
};
const bool = (value) => {
    if (value === true || value === false) return { value };
    const v = String(value ?? "")
        .trim()
        .toLowerCase();
    if (TRUE.includes(v)) return { value: true };
    if (FALSE.includes(v)) return { value: false };
    return { error: "is not true or false" };
};
const wholeNumber =
    (min, max = Number.MAX_SAFE_INTEGER) =>
    (value) => {
        const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
        return Number.isInteger(n) && n >= min && n <= max
            ? { value: n }
            : { error: `is not a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : " up"}` };
    };
const duration = (minMs) => (value) => {
    const ms = durationMs(value);
    return ms && ms >= minMs
        ? { value: typeof value === "number" ? value : String(value).trim() }
        : {
              error: `is not a duration of at least ${minMs >= 60_000 ? `${minMs / 60_000}m` : `${minMs / 1000}s`} (e.g. "10m")`,
          };
};
const bytes = (value) => {
    const b = parseBytes(value);
    return b === null ? { error: 'is not a size (bytes, or e.g. "2GB", or "unlimited")' } : { value };
};
const deliverMap = (value) => {
    if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (MEDIA_DELIVER_MODES.includes(v)) return { value: v };
        const out = {};
        for (const pair of v.split(",")) {
            const [k, m] = pair.split("=").map((s) => s?.trim());
            if (!MEDIA_KINDS.includes(k) || !MEDIA_DELIVER_MODES.includes(m))
                return { error: `"${pair}" is not <kind>=<inline|link|tempfile>` };
            out[k] = m;
        }
        return { value: out };
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        return { error: "is not a mode or a {kind: mode} object" };
    const out = {};
    for (const [k, m] of Object.entries(value)) {
        const mode = String(m ?? "")
            .trim()
            .toLowerCase();
        if (!MEDIA_KINDS.includes(k)) return { error: `names an unknown media kind "${k}"` };
        if (!MEDIA_DELIVER_MODES.includes(mode)) return { error: `.${k} is not inline, link or tempfile` };
        out[k] = mode;
    }
    return { value: out };
};
const modeList = (value) => {
    const list = Array.isArray(value) ? value : String(value ?? "").split(",");
    const modes = list.map((m) => String(m).trim().toLowerCase()).filter(Boolean);
    if (!modes.length || modes.some((m) => !MEDIA_DELIVER_MODES.includes(m)))
        return { error: "is not a list of inline, link, tempfile" };
    return { value: [...new Set(modes)] };
};
const webhookUrl = (value) => {
    try {
        const u = new URL(String(value));
        if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "is not an http(s) URL" };
        return { value: String(value).trim() };
    } catch {
        return { error: "is not an absolute URL" };
    }
};
const fraction = (value) => {
    const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
    return n > 0 && n <= 1 ? { value: n } : { error: "is not a fraction above 0 and at most 1 (e.g. 0.8)" };
};
const accountIds = (value) => {
    const list = Array.isArray(value) ? value : String(value ?? "").split(",");
    const ids = list.map((s) => String(s).trim()).filter(Boolean);
    if (ids.some((id) => !/^[1-9][0-9]{0,30}$/.test(id))) return { error: "is not a list of account ids" };
    return { value: [...new Set(ids)] };
};

/**
 * Every policy key: its check, and where it may be set (`tenant`: only in a tenant's file).
 * The values are read by the same resolvers that read mcp-config.json and storage.json, with the policy on top.
 */
export const POLICY_KEYS = Object.freeze({
    confirmMode: { check: oneOf(CONFIRM_MODES) },
    hiddenChats: { check: oneOf(HIDDEN_CHAT_MODES) },
    allowPinArgument: { check: bool },
    "approval.secret": { check: oneOf(APPROVAL_SECRETS) },
    "approval.deliver": { check: oneOf(APPROVAL_DELIVERIES) },
    "media.deliver": { check: deliverMap },
    "media.inlineMaxBytes": { check: wholeNumber(1) },
    "media.allowDeliver": { check: modeList },
    "media.linkTtl": { check: duration(1000) },
    "media.tempfileTtl": { check: duration(1000) },
    "media.linkAuth": { check: oneOf(MEDIA_LINK_AUTHS) },
    "media.linkRateLimit": { check: wholeNumber(1) },
    "media.capability.maxClients": { check: wholeNumber(1) },
    "media.capability.ttl": { check: duration(1000) },
    "media.autoOpen": { check: bool },
    webhook: { check: webhookUrl },
    webhookBatchSize: { check: wholeNumber(1, 100) },
    webhookMaxAge: { check: duration(60_000) },
    "quota.account.limit": { check: bytes },
    "quota.tenant.limit": { check: bytes, tenant: true },
    "quota.tenant.accounts": { check: accountIds, tenant: true },
    "quota.graceDays": { check: wholeNumber(0, 3650) },
    "quota.warnAt": { check: fraction },
    "quota.purgeOrder": { check: oneOf(["media-first"]) },
    "retention.messages": { check: keepOrDays },
    "retention.media": { check: keepOrDays },
    "retention.outboxDead": {
        check: (v) =>
            parseDays(v) ? { value: `${parseDays(v)}d` } : { error: 'is not a number of days (e.g. "30d")' },
    },
    "retention.purgeEvery": { check: duration(60_000) },
});

/**
 * Keys a running server cannot change: they are read once at start (the port, the address, TLS, the key provider)
 * or they are secrets, which never go in a policy. A change to one is refused with `restartRequired`.
 */
export const RESTART_KEYS = Object.freeze([
    "httpPort",
    "host",
    "publicUrl",
    "tls",
    "oauth",
    "trustedProxies",
    "admin",
    "webhookSecret",
    "media.downloadDir",
    "provider",
    "dkeyLayer",
    "dpapi",
    "kms",
    "passphrase",
    "systemdCreds",
    "keychain",
    "secretService",
    "env",
    "accounts",
]);

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isBranch = (path) => Object.keys(POLICY_KEYS).some((k) => k.startsWith(`${path}.`));
const restartKeyOf = (path) => RESTART_KEYS.find((k) => path === k || path.startsWith(`${k}.`)) ?? null;

/**
 * A nested policy as `{dotted: value}` leaves; a value of null is kept (it means "remove" in a patch).
 *
 * @param {object} policy
 * @returns {Record<string, unknown>}
 */
export function flattenPolicy(policy) {
    const out = {};
    const walk = (obj, prefix) => {
        for (const [k, v] of Object.entries(obj ?? {})) {
            const path = prefix ? `${prefix}.${k}` : k;
            if (!POLICY_KEYS[path] && isPlainObject(v) && (isBranch(path) || restartKeyOf(path) === null))
                walk(v, path);
            else out[path] = v;
        }
    };
    walk(policy, "");
    return out;
}

/**
 * Leaves back into a nested policy.
 *
 * @param {Record<string, unknown>} flat
 * @returns {object}
 */
export function nestPolicy(flat) {
    const out = {};
    for (const [path, value] of Object.entries(flat)) {
        const parts = path.split(".");
        let node = out;
        for (const p of parts.slice(0, -1)) node = node[p] = isPlainObject(node[p]) ? node[p] : {};
        node[parts.at(-1)] = value;
    }
    return out;
}

/**
 * Check a policy (nested), for an account's file or a tenant's. Values are normalized (`"BEARER"` → `"bearer"`).
 *
 * @param {unknown} policy
 * @param {{scope?: "account"|"tenant", allowNull?: boolean}} [opts] - `allowNull`: a patch, where null removes a key
 * @returns {{policy: object, errors: Array<{key: string, error: string}>, restartRequired: string[]}}
 */
export function validatePolicy(policy, { scope = "account", allowNull = false } = {}) {
    const errors = [];
    const restartRequired = [];
    if (!isPlainObject(policy)) {
        return { policy: {}, errors: [{ key: "", error: "the policy must be a JSON object" }], restartRequired };
    }
    const clean = {};
    for (const [key, value] of Object.entries(flattenPolicy(policy))) {
        const restart = restartKeyOf(key);
        if (restart) {
            restartRequired.push(key);
            continue;
        }
        const spec = POLICY_KEYS[key];
        if (!spec) {
            errors.push({ key, error: "is not a policy key" });
            continue;
        }
        if (spec.tenant && scope !== "tenant") {
            errors.push({ key, error: "is set in a tenant's policy only" });
            continue;
        }
        if (value === null) {
            if (allowNull) clean[key] = null;
            else errors.push({ key, error: "is null (leave the key out instead)" });
            continue;
        }
        const r = spec.check(value);
        if (r.error) errors.push({ key, error: r.error });
        else clean[key] = r.value;
    }
    return { policy: nestPolicy(clean), errors, restartRequired };
}

/**
 * One value as the CLI takes it (`policy set <key> <value>`): JSON when it parses (a number, an object, a list,
 * `true`), else the text itself.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseCliValue(text) {
    const t = String(text ?? "").trim();
    try {
        return JSON.parse(t);
    } catch {
        return t;
    }
}

/**
 * A JSON merge patch (RFC 7396) of two nested policies: null removes a key, an object merges, anything else replaces.
 *
 * @param {object} base
 * @param {object} patch
 * @returns {object}
 */
export function mergePolicy(base, patch) {
    const flat = { ...flattenPolicy(base) };
    for (const [key, value] of Object.entries(flattenPolicy(patch))) {
        if (value === null) delete flat[key];
        else flat[key] = value;
    }
    return nestPolicy(flat);
}

/**
 * The dotted keys whose value differs between two policies.
 *
 * @param {object} a
 * @param {object} b
 * @returns {string[]}
 */
export function changedKeys(a, b) {
    const fa = flattenPolicy(a ?? {});
    const fb = flattenPolicy(b ?? {});
    return [...new Set([...Object.keys(fa), ...Object.keys(fb)])]
        .filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k]))
        .sort();
}

/**
 * One key's value in a nested policy, or undefined.
 *
 * @param {object|null|undefined} policy
 * @param {string} key - dotted
 * @returns {unknown}
 */
export function policyGet(policy, key) {
    let node = policy;
    for (const p of key.split(".")) {
        if (!isPlainObject(node)) return undefined;
        node = node[p];
    }
    return node;
}
