/**
 * The one way the `oa …` and `zbs …` commands talk to Zalo's official APIs, and where their credentials live.
 *
 * - Base URLs: OpenAPI v2.0 / v3.0 (`openapi.zalo.me`), ZBS (`business.openapi.zalo.me`) and OAuth
 *   (`oauth.zaloapp.com/v4/oa/…`), as Zalo's OA and ZBS docs give them.
 * - Credentials: `<oa dir>/oa-credentials.json` (default `~/.zalo-agent`, or ZALO_OA_DIR / `--oa-dir`), one record
 *   per OA id (`default` unless `--oa-id` names another): `{ appId, secretKey, accessToken, refreshToken,
 *   expiresIn, expiresAt, oaId, updatedAt, … }`. Written atomically under a lock at 0600. Kept apart from the
 *   personal-account credentials in `~/.zalo-agent-cli/` on purpose.
 * - {@link oaRequest}: the access token goes in the `access_token` header (never the query), the HTTP status and
 *   content type are checked before the body is read, a Zalo error becomes an {@link OAError} carrying the docs'
 *   meaning, and an expired token (-216/-220, ZBS -124) is refreshed once under a lock and the call retried once.
 * - {@link uploadForm}: a multipart upload with the file's base name and MIME type, checked against the
 *   documented size and type limits before anything is sent.
 *
 * Nothing here prints: callers report through src/utils/output.js.
 */

import fs from "node:fs";
import { createHmac } from "node:crypto";
import { Blob } from "node:buffer";
import { basename, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { withFileLock, writeFileAtomic } from "../../zalo/kernel/atomic-file.js";

/** Zalo OpenAPI v2.0 (getoa, tags, uploads, conversations, articles, …). */
export const OPENAPI_V2 = "https://openapi.zalo.me/v2.0";
/** Zalo OpenAPI v3.0 (CS messages, users, quota, GMF, calls, …). */
export const OPENAPI_V3 = "https://openapi.zalo.me/v3.0";
/** ZBS Template Message API. */
export const ZBS_BASE = "https://business.openapi.zalo.me";
/** Where the OA admin grants the app permission (the browser half of OAuth v4). */
export const OAUTH_PERMISSION_URL = "https://oauth.zaloapp.com/v4/oa/permission";
/** Code → token and refresh → token (POST, form-urlencoded, `secret_key` header). */
export const OAUTH_TOKEN_URL = "https://oauth.zaloapp.com/v4/oa/access_token";

/** The command that configures an OA, quoted wherever credentials are missing. */
export const LOGIN_HINT = "zalo-agent oa login --app-id <id> --secret <key>";

// ─── Errors ──────────────────────────────────────────────────────────

/**
 * Zalo's OA error table (OA docs "Mã lỗi Official Account API"): `[meaning, what to do]`.
 * The same table covers ZBS sends by UID (the ZBS docs refer to it).
 */
export const OA_ERRORS = Object.freeze({
    "-32": [
        "rate limit reached: the app (4,000 requests/minute) or the OA's package limit",
        "slow down and retry in the next minute",
    ],
    "-100": ["attachment_id expired (uploads are kept 7 days)", "upload the file again for a new id"],
    "-200": ["sending the message failed", "retry later"],
    "-201": ["a parameter is invalid", "check the request's parameters"],
    "-204": ["the Official Account was deleted", "check the OA at oa.zalo.me/manage/oa"],
    "-205": ["the Official Account does not exist", "check the OA id"],
    "-209": [
        "the app is not activated, so this API is not supported",
        "activate the app in its settings on developers.zalo.me",
    ],
    "-210": ["a parameter exceeds its allowed limit", "check the parameter limits"],
    "-211": ["the feature's quota is used up", "check the feature's limits before retrying"],
    "-212": ["the app has not registered this API", "register it under the app's Official Account API settings"],
    "-213": ["the user does not follow the OA", "check which messages this user may receive"],
    "-214": ["the article is still being processed", "wait and call again"],
    "-216": ["the access token is invalid", "run `zalo-agent oa refresh`, or log in again"],
    "-217": ["the user blocked follow invitations from the OA", ""],
    "-218": ["the limit of messages to this user is reached", "see the receive limits per user"],
    "-219": ["the app was removed or disabled", "check the app's status and your admin rights"],
    "-220": ["the access token expired or was removed", "run `zalo-agent oa refresh`, or log in again"],
    "-221": ["the OA must be verified to use this feature", "submit the OA's verification at oa.zalo.me/manage/cert"],
    "-223": [
        "the OA has not granted the app this API, or reached its article quota for the period",
        "grant the permission in the app's OA settings, or check the publishing quota",
    ],
    "-224": ["the OA's package does not include this feature", "upgrade the OA's service package"],
    "-227": ["the user is banned or inactive for more than 45 days", ""],
    "-230": [
        "the user has not interacted with the OA in the past 7 days",
        // Zalo's OA docs, "Các tương tác của người dùng với OA"
        "the OA may message a user only after the user follows it, messages it, accepts a call from it, taps " +
            "Message on its profile, taps its call button, or taps a menu item with an oa.query action; to reach " +
            "them now, send a ZBS template (zbs uid / zbs send)",
    ],
    "-232": [
        "the user has not interacted with the OA, or the last interaction expired",
        "see Zalo's OA messaging policy",
    ],
    "-233": ["the message type is invalid or not supported", "check the message type"],
    "-234": ["this message type cannot be sent at night (22:00-07:00)", "send it in the daytime"],
    "-235": ["this API is not supported for this type of OA", "check the OA type and the API's conditions"],
    "-237": ["the GMF group chat expired", "renew the group's service"],
    "-238": ["asset_id is already used or disabled", "pick a valid asset_id (`oa group quota`)"],
    "-240": ["the v2 message API was shut down", "use the v3 message API"],
    "-241": ["the package's free asset_id is already used", "pick another asset_id"],
    "-242": [
        "invalid appsecret_proof",
        "it is computed from the saved app secret key: run `oa setup` with the app's current secret key (a reset key invalidates it)",
    ],
    "-244": ["the user restricted this message type from the OA", ""],
    "-248": ["violates Zalo's platform standards", "see go.zalo.me/oa-policy"],
    "-249": [
        "the template does not support sending by UID",
        "use a template that supports UID sends (custom, rating, payment request, voucher)",
    ],
    "-320": ["the app must be linked to a Zalo Cloud Account for paid features", "link the app to a ZCA"],
    "-321": ["the linked Zalo Cloud Account is out of money or cannot be charged", "top up the ZCA"],
    "-403": ["the OA does not own this group chat", "check the OA's groups (`oa group list`)"],
    "-1340": ["form not found", ""],
    "-1341": ["the OA has no access to this form", ""],
});

/** Zalo's ZBS error table (ZBS docs "Bảng mã lỗi"): `[meaning, what to do]`. Consulted before the OA table for ZBS URLs. */
export const ZBS_ERRORS = Object.freeze({
    "-1091": ["this template cannot be edited (not in Reject status, or created in the admin tool)", ""],
    "-112": ["template data type is not defined", "use a documented data type"],
    "-1132": ["the template must contain at least one button", "add a button"],
    "-109": ["invalid template id", "check the template id"],
    "-110": ["the recipient's Zalo version is not supported", ""],
    "-111": ["template data is empty", ""],
    "-1121": ["a parameter exceeds its maximum length", "check the parameter limits"],
    "-1122": ["template data is missing a parameter", "add the missing parameter"],
    "-1123": ["the QR code cannot be generated", ""],
    "-1124": ["a parameter has an invalid format", "send the parameter in its documented format"],
    "-113": ["invalid button", ""],
    "-1131": ["invalid button link format", "check the link for the button type"],
    "-116": ["invalid parameter text", ""],
    "-117": [
        "the OA or app has no permission to use this template",
        "check the app id / OA id the template belongs to",
    ],
    "-121": ["the template body is empty", ""],
    "-122": ["the request body is not valid JSON", ""],
    "-130": ["the template content exceeds the character limit", ""],
    "-131": ["the template is not approved", ""],
    "-132": ["invalid parameter", ""],
    "-100": ["unknown error", "retry later"],
    "-101": ["invalid application", "check the app id"],
    "-103": ["the application is not activated", "activate it on developers.zalo.me"],
    "-104": ["invalid app secret key", "check the app's secret key"],
    "-106": ["method not supported", ""],
    "-107": ["invalid message id", ""],
    "-108": ["invalid phone number", "use 84xxxxxxxxx or 0xxxxxxxxx"],
    "-115": ["the ZBS account balance is insufficient", "top up the ZBS account"],
    "-118": ["the Zalo account does not exist or is disabled", ""],
    "-120": ["the OA's package does not include this feature", "buy an OA package"],
    "-1202": ["the OA has no permission to use this media resource", ""],
    "-124": ["the access token is invalid", "run `zalo-agent oa refresh`, or log in again"],
    "-1241": [
        "invalid appsecret_proof",
        "it is computed from the saved app secret key: run `oa setup` with the app's current secret key (a reset key invalidates it)",
    ],
    "-125": ["invalid Official Account id", ""],
    "-126": ["the development-mode wallet is out of balance", ""],
    "-127": ["test templates can only be sent to the OA's admins", ""],
    "-133": ["this message cannot be sent at night (22:00-07:00 Vietnam time)", ""],
    "-135": ["the OA may not send by phone number (not verified, or on the free plan)", ""],
    "-1351": ["the OA may not send by phone number (blocked for violations)", ""],
    "-136": ["a ZBS account association is required", "link the app to a ZBS account"],
    "-137": ["charging the ZBS account failed", "check the ZBS account balance"],
    "-138": ["the app has no permission to use this feature", "check the app's API registration"],
    "-1381": ["the extension has no permission to use the OA's ZBS account", ""],
    "-139": ["the user refused this type of template message", ""],
    "-140": ["the user is not eligible for this template type under the current policy", ""],
    "-141": ["the user refused messages from the OA by phone number", ""],
    "-142": ["the RSA key does not exist", "create the RSA key first"],
    "-143": ["the RSA key already exists", "fetch the existing RSA key"],
    "-144": ["the OA's daily quota for phone-number messages is used up", "check `zbs quota`"],
    "-1441": ["the OA exceeded its monthly promotion quota", "check `zbs quota`"],
    "-145": ["the OA may not send this type of template content", ""],
    "-147": ["the template's daily quota is used up", ""],
    "-1471": ["the monthly limit of promotion messages to this user is reached", ""],
    "-1472": ["the daily limit of promotion messages to this user is reached", ""],
    "-148": ["journey token missing", ""],
    "-149": ["invalid journey token", ""],
    "-1491": ["the journey token type does not match the template", ""],
    "-150": ["the journey token expired", ""],
    "-151": ["not an E2EE template", ""],
    "-152": ["getting the E2EE key failed", ""],
    "-153": ["invalid data", "see the create/edit template docs"],
    "-158": ["the uploaded file exceeds the allowed size", ""],
    "-159": ["the uploaded file's format is not allowed", ""],
    "-160": ["the daily quota of template create/edit or uploads is used up", ""],
    "-161": ["sending_mode has an invalid value", ""],
    "-162": ["this template type cannot be sent on this endpoint (over-quota mode does not take tag 1/2)", ""],
});

/** The codes that mean "this access token no longer works": refreshed once, then retried once. */
const TOKEN_EXPIRED = new Set([-216, -220]);
/** ZBS's own "access token invalid". */
const ZBS_TOKEN_INVALID = -124;

/**
 * A failed OA/ZBS call. `code` is Zalo's numeric error code, or a string for a failure before Zalo answered:
 * `http_<status>` (non-2xx or non-JSON answer), `network`, `not_configured`, `upload_too_large`,
 * `upload_type`, `upload_missing`, `token_refresh`.
 */
export class OAError extends Error {
    /**
     * @param {string} message
     * @param {{ code: number|string, data?: any, meaning?: string, hint?: string, status?: number, rateLimit?: object }} info
     */
    constructor(message, { code, data, meaning, hint, status, rateLimit } = {}) {
        super(message);
        this.name = "OAError";
        this.code = code;
        if (data !== undefined) this.data = data;
        if (meaning) this.meaning = meaning;
        if (hint) this.hint = hint;
        if (status !== undefined) this.status = status;
        if (rateLimit) this.rateLimit = rateLimit;
    }
}

/**
 * The docs' meaning of a Zalo error code, for a call to `url` (ZBS URLs read the ZBS table first, then the OA one).
 *
 * @param {number|string} code
 * @param {string} [url]
 * @returns {{ meaning: string, hint: string }|null}
 */
export function describeOAError(code, url = "") {
    const key = String(code);
    // Send-by-UID sits on the OA API, and ZBS's error table sends its sending-condition errors to the OA table:
    // there the OA meaning wins, the ZBS table only fills in codes the OA table lacks.
    const row = isZbsUrl(url)
        ? ZBS_ERRORS[key] || OA_ERRORS[key]
        : OA_ERRORS[key] || (isZbsEndpoint(url) ? ZBS_ERRORS[key] : undefined);
    return row ? { meaning: row[0], hint: row[1] } : null;
}

function isZbsUrl(url) {
    return String(url).startsWith(ZBS_BASE);
}

/** A ZBS endpoint: the ZBS host, or the send-by-UID template endpoint ZBS documents on the OA API. */
function isZbsEndpoint(url) {
    return isZbsUrl(url) || String(url).startsWith(`${OPENAPI_V3}/oa/message/template`);
}

/** The endpoint's path for messages: never the query, which may carry data. */
function endpointOf(url) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return String(url);
    }
}

/** `X-RateLimit-Limit` / `X-RateLimit-Remain` (OA docs "Giới hạn tốc độ gọi API"), as numbers, or null. */
function rateLimitOf(res) {
    const limit = res.headers?.get?.("x-ratelimit-limit");
    const remain = res.headers?.get?.("x-ratelimit-remain");
    if (limit === null && remain === null) return null;
    if (limit === undefined && remain === undefined) return null;
    const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
    return { limit: n(limit), remain: n(remain) };
}

/**
 * JSON.parse reviver: an integer too large for a JS number (Zalo's docs type product, beneficiary and ZCA ids as
 * `long`) is kept as its exact digits, a string, instead of being rounded.
 *
 * @param {string} _key
 * @param {any} value
 * @param {{ source?: string }} [context] - the value's source text (JSON.parse source access)
 * @returns {any}
 */
export function keepLongIntegers(_key, value, context) {
    if (typeof value === "number" && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? "")) {
        return context.source;
    }
    return value;
}

/**
 * Read a fetch Response as Zalo JSON: a non-2xx status, an HTML/non-JSON body or an unparsable body throws
 * OAError `http_<status>` naming the endpoint (so a wrong path reads "HTTP 404", not a JSON SyntaxError).
 *
 * @param {Response} res
 * @param {string} url - the URL that was called (for the message)
 * @returns {Promise<any>} the parsed body
 */
export async function readZaloJson(res, url) {
    const status = res.status;
    const type = res.headers?.get?.("content-type") || "";
    const text = await res.text();
    const where = endpointOf(url);
    let parsed;
    let parsedOk = false;
    if (!/html|xml/i.test(type)) {
        try {
            parsed = JSON.parse(text, keepLongIntegers);
            parsedOk = parsed !== null && typeof parsed === "object";
        } catch {
            parsedOk = false;
        }
    }
    if (!res.ok || !parsedOk) {
        const why = !res.ok ? `HTTP ${status}` : `HTTP ${status} with a non-JSON body (${type || "no content type"})`;
        const extra = status === 404 ? " (no such endpoint)" : "";
        throw new OAError(`${where} answered ${why}${extra}`, {
            code: `http_${status}`,
            status,
            data: parsedOk ? parsed : undefined,
            rateLimit: rateLimitOf(res) ?? undefined,
        });
    }
    return parsed;
}

// ─── Credentials ─────────────────────────────────────────────────────

/**
 * Resolve the Official Account data directory (defaults to ~/.zalo-agent, or ZALO_OA_DIR).
 * @returns {string}
 */
export function getOADataDir() {
    return process.env.ZALO_OA_DIR ? resolve(process.env.ZALO_OA_DIR) : join(homedir(), ".zalo-agent");
}

/**
 * Path of the shared OA credentials file.
 * @returns {string}
 */
export function getOACredsFile() {
    return join(getOADataDir(), "oa-credentials.json");
}

function ensureDir() {
    const dir = getOADataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Merge `data` into one OA's stored record (read-modify-write under a lock, replaced atomically at 0600).
 * A key set to `null` is removed.
 *
 * @param {object} data - fields to set
 * @param {string} [oaId]
 */
export function saveOACreds(data, oaId = "default") {
    ensureDir();
    const credsFile = getOACredsFile();
    withFileLock(`${credsFile}.lock`, () => {
        let creds = {};
        if (fs.existsSync(credsFile)) {
            creds = JSON.parse(fs.readFileSync(credsFile, "utf8"));
        }
        const next = { ...creds[oaId], ...data, updatedAt: new Date().toISOString() };
        for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
        creds[oaId] = next;
        writeFileAtomic(credsFile, JSON.stringify(creds, null, 2));
    });
}

/**
 * Save an OA access token (keeps the record's other fields).
 * @param {string} accessToken
 * @param {string} [oaId]
 */
export function saveOAToken(accessToken, oaId = "default") {
    saveOACreds({ accessToken }, oaId);
}

/**
 * Load one OA's stored record.
 * @param {string} [oaId]
 * @returns {object|null}
 */
export function loadOACreds(oaId = "default") {
    const credsFile = getOACredsFile();
    if (!fs.existsSync(credsFile)) return null;
    const creds = JSON.parse(fs.readFileSync(credsFile, "utf8"));
    return creds[oaId] || null;
}

/**
 * Load one OA's access token.
 * @param {string} [oaId]
 * @returns {string|null}
 */
export function loadOAToken(oaId = "default") {
    return loadOACreds(oaId)?.accessToken || null;
}

/**
 * The fields to store for a token answer from the OAuth endpoint: `expires_in` is a string of seconds in the docs
 * (`"90000"`, 25 h); `expiresAt` is when the access token stops working.
 *
 * @param {{ access_token: string, refresh_token?: string, expires_in?: string|number }} tokenData
 * @param {number} [now]
 * @returns {{ accessToken: string, refreshToken?: string, expiresIn?: string|number, expiresAt?: string }}
 */
export function tokenFields(tokenData, now = Date.now()) {
    const fields = { accessToken: tokenData.access_token };
    if (tokenData.refresh_token) fields.refreshToken = tokenData.refresh_token;
    if (tokenData.expires_in !== undefined && tokenData.expires_in !== null) {
        fields.expiresIn = tokenData.expires_in;
        const secs = Number(tokenData.expires_in);
        if (Number.isFinite(secs) && secs > 0) fields.expiresAt = new Date(now + secs * 1000).toISOString();
    }
    return fields;
}

/**
 * The stored access token, or OAError `not_configured`.
 * @param {string} [oaId]
 * @returns {string}
 */
export function getToken(oaId = "default") {
    const creds = loadOACreds(oaId);
    if (!creds?.accessToken) {
        throw new OAError(`OA not configured. Run: ${LOGIN_HINT}`, { code: "not_configured" });
    }
    return creds.accessToken;
}

// ─── Requests ────────────────────────────────────────────────────────

/**
 * Build the request URL: `data` becomes `?data=<JSON>` (the v2/v3 GET convention), `query` plain params
 * (undefined/null skipped).
 *
 * @param {string} url
 * @param {{ data?: object, query?: Record<string, any> }} [parts]
 * @returns {string}
 */
export function buildUrl(url, { data, query } = {}) {
    const u = new URL(url);
    if (data !== undefined) u.searchParams.set("data", JSON.stringify(data));
    if (query) {
        for (const [k, v] of Object.entries(query)) {
            if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
        }
    }
    return u.toString();
}

/**
 * Call one OA/ZBS endpoint and return Zalo's parsed JSON.
 *
 * - `access_token` header from `token`, or else the stored token of `oaId`;
 * - `data` → `?data=<JSON>`, `query` → plain query params, `body` → JSON body, `form` → multipart `FormData`;
 * - a non-2xx or non-JSON answer throws OAError `http_<status>`; `error !== 0` throws OAError with Zalo's code,
 *   message and `data`, plus the docs' `meaning` and `hint`;
 * - on -216/-220 (and ZBS -124) with a stored token and refresh credentials, refreshes once under a lock and retries
 *   once; never loops. An explicit `token` is never refreshed.
 * - with the stored token and the app's secret key at hand, sends `appsecret_proof` (see {@link appSecretProof}), so
 *   an app that turned on that check (error -242, ZBS -1241) keeps working.
 *
 * The result carries a non-enumerable `rateLimit` (`{ limit, remain }` from `X-RateLimit-Limit` /
 * `X-RateLimit-Remain`) when Zalo sent those headers; it does not appear in JSON output.
 *
 * @param {object} req
 * @param {string} [req.method] - default GET
 * @param {string} req.url - absolute URL (use OPENAPI_V2 / OPENAPI_V3 / ZBS_BASE)
 * @param {object} [req.data]
 * @param {Record<string, any>} [req.query]
 * @param {any} [req.body]
 * @param {FormData} [req.form]
 * @param {string} [req.oaId] - default "default"
 * @param {string} [req.token] - use this token instead of the stored one
 * @param {Record<string, string>} [req.headers] - extra headers a doc lists beside `access_token` (e.g. an article
 *   video's `token`, ZBS `journey_token`); they cannot replace `access_token`
 * @returns {Promise<any>}
 */
export async function oaRequest({
    method = "GET",
    url,
    data,
    query,
    body,
    form,
    oaId = "default",
    token,
    headers,
} = {}) {
    if (!url) throw new TypeError("oaRequest: url is required");
    const explicit = Boolean(token);
    const useToken = token || getToken(oaId);
    // The proof binds the token to the app: only for the stored token, whose app's secret is the stored one.
    const secret = explicit ? undefined : loadOACreds(oaId)?.secretKey;
    try {
        return await sendOnce({ method, url, data, query, body, form, token: useToken, extra: headers, secret });
    } catch (e) {
        if (explicit || !(e instanceof OAError) || !isTokenExpiry(e.code, url)) throw e;
        const creds = loadOACreds(oaId);
        if (!creds?.refreshToken || !creds?.appId || !creds?.secretKey) throw e;
        const { refreshStoredToken } = await import("./oauth.js");
        const fresh = await refreshStoredToken(oaId, { staleToken: useToken });
        return sendOnce({ method, url, data, query, body, form, token: fresh.accessToken, extra: headers, secret });
    }
}

function isTokenExpiry(code, url) {
    return TOKEN_EXPIRED.has(code) || (code === ZBS_TOKEN_INVALID && isZbsUrl(url));
}

/**
 * `appsecret_proof`: hex HMAC-SHA256 of the access token keyed with the app's secret key. Zalo's OA docs name it only
 * in error -242 ("appsecret_proof is invalid") and ZBS -1241; Zalo's own PHP and Java SDKs compute it this way and send
 * it as a request header.
 *
 * @param {string} accessToken
 * @param {string} secretKey - the app's secret key
 * @returns {string} 64 hex characters
 */
export function appSecretProof(accessToken, secretKey) {
    return createHmac("sha256", String(secretKey)).update(String(accessToken), "utf8").digest("hex");
}

async function sendOnce({ method, url, data, query, body, form, token, extra, secret }) {
    const target = buildUrl(url, { data, query });
    const headers = { ...(extra ?? {}), access_token: token };
    if (secret && token) headers.appsecret_proof = appSecretProof(token, secret);
    const opts = { method, headers };
    if (form !== undefined) {
        opts.body = form; // fetch sets the multipart boundary
    } else if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }
    let res;
    try {
        res = await fetch(target, opts);
    } catch (e) {
        throw new OAError(`${endpointOf(url)} could not be reached: ${e.message}`, { code: "network" });
    }
    const json = await readZaloJson(res, url);
    const rateLimit = rateLimitOf(res);
    if (json.error !== undefined && json.error !== 0 && json.error !== "0") {
        const code = Number(json.error);
        const doc = describeOAError(code, url);
        const said = json.message || json.error_description || json.error_name || "";
        const text =
            `${isZbsEndpoint(url) ? "ZBS" : "OA"} API error ${code}` +
            (said ? `: ${said}` : "") +
            (doc ? ` (${doc.meaning})` : "") +
            (doc?.hint ? `. ${doc.hint[0].toUpperCase()}${doc.hint.slice(1)}` : "");
        throw new OAError(text, {
            code,
            data: json,
            meaning: doc?.meaning,
            hint: doc?.hint || undefined,
            rateLimit: rateLimit ?? undefined,
        });
    }
    if (rateLimit) Object.defineProperty(json, "rateLimit", { value: rateLimit, enumerable: false });
    return json;
}

// ─── Uploads ─────────────────────────────────────────────────────────

const MB = 1024 * 1024;

/**
 * The documented OA upload limits (OA docs "Upload hình ảnh / file / ảnh GIF"): `maxBytes` and allowed extensions.
 * "1MB"/"5MB" are read as MiB.
 */
export const UPLOAD_LIMITS = Object.freeze({
    image: Object.freeze({ maxBytes: 1 * MB, types: Object.freeze(["jpg", "jpeg", "png"]) }),
    file: Object.freeze({ maxBytes: 5 * MB, types: Object.freeze(["pdf", "doc", "docx", "csv"]) }),
    gif: Object.freeze({ maxBytes: 5 * MB, types: Object.freeze(["gif"]) }),
});

/** MIME types by extension, for the multipart part. */
export const MIME_TYPES = Object.freeze({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    csv: "text/csv",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
});

/**
 * MIME type for a file name (application/octet-stream when unknown).
 * @param {string} filePath
 * @returns {string}
 */
export function mimeTypeOf(filePath) {
    return MIME_TYPES[extname(filePath).slice(1).toLowerCase()] || "application/octet-stream";
}

/**
 * Upload one file as `multipart/form-data` to an OA/ZBS endpoint: the part is named `field`, carries the file's
 * base name (Windows or POSIX path) and its MIME type, and the file is checked against `maxBytes` and `types`
 * (extensions, case-insensitive) before anything is sent.
 *
 * @param {string} url - e.g. `${OPENAPI_V2}/oa/upload/image`
 * @param {string} filePath
 * @param {object} [opts]
 * @param {string} [opts.field] - default "file"
 * @param {number} [opts.maxBytes]
 * @param {string[]} [opts.types] - allowed extensions without the dot
 * @param {string} [opts.oaId]
 * @param {Record<string, string>} [opts.fields] - extra text fields to append
 * @param {string} [opts.token]
 * @returns {Promise<any>} Zalo's JSON
 */
export async function uploadForm(
    url,
    filePath,
    { field = "file", maxBytes, types, oaId = "default", fields, token } = {},
) {
    const name = basename(String(filePath).replace(/\\/g, "/"));
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        throw new OAError(`No such file: ${filePath}`, { code: "upload_missing" });
    }
    if (!stat.isFile()) throw new OAError(`Not a file: ${filePath}`, { code: "upload_missing" });
    const ext = extname(name).slice(1).toLowerCase();
    if (types?.length && !types.includes(ext)) {
        throw new OAError(`${name}: Zalo accepts only ${types.join(", ")} here`, { code: "upload_type" });
    }
    if (maxBytes && stat.size > maxBytes) {
        throw new OAError(`${name} is ${formatBytes(stat.size)}; Zalo's limit here is ${formatBytes(maxBytes)}`, {
            code: "upload_too_large",
        });
    }
    const blob = new Blob([fs.readFileSync(filePath)], { type: mimeTypeOf(name) });
    const form = new globalThis.FormData();
    for (const [k, v] of Object.entries(fields || {})) form.append(k, String(v));
    form.append(field, blob, name);
    return oaRequest({ method: "POST", url, form, oaId, token });
}

function formatBytes(n) {
    if (n >= MB) return `${(n / MB).toFixed(n % MB ? 2 : 0)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
}
