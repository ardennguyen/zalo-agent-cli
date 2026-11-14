/**
 * Zalo Social API: a Zalo user's login to an app, and what the app may read about that user. Per Zalo's Social docs
 * ("User Access Token V4", "Thông tin tên, ảnh đại diện", "Cơ chế hết hạn của User Refresh Token", "Mã lỗi",
 * "Demonstrating Proof-of-Possession"):
 *
 * - Login: `oauth.zaloapp.com/v4/permission?app_id&redirect_uri&code_challenge&state` (PKCE, state required), then
 *   POST `oauth.zaloapp.com/v4/access_token` (form, header `secret_key`, `code`, `app_id`,
 *   `grant_type=authorization_code`, `code_verifier`). The code is single use, valid 10 minutes.
 * - Tokens: the access token lasts 1 hour; the refresh token at most 30 days, and a refreshed one inherits what is
 *   left of the one it replaced, so the login must be redone at most 30 days after it was made.
 * - Data: GET `graph.zalo.me/v2.0/me?fields=id,name,picture` with the `access_token` header. `id` is the user's id
 *   for this app only. `picture.type(small|normal|large)` asks for a bigger avatar.
 * - DPoP is optional; once a login used it, every call and refresh must carry a proof from the same key.
 *
 * Independent of the OA: its own app login, stored in `<oa dir>/social-credentials.json` (0600) per profile.
 */

import fs from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../../zalo/kernel/atomic-file.js";
import { OAError, appSecretProof, getOADataDir, readZaloJson } from "../oa/transport.js";
import { refreshAccessToken, startOAuthLogin, tokenErrorText, withAsyncFileLock } from "../oa/oauth.js";
import { createDpopKey, dpopProof } from "./dpop.js";

export const SOCIAL_PERMISSION_URL = "https://oauth.zaloapp.com/v4/permission";
export const SOCIAL_TOKEN_URL = "https://oauth.zaloapp.com/v4/access_token";
export const GRAPH_V2 = "https://graph.zalo.me/v2.0";

/** The longest a user login lasts: the refresh token's 30 days (720 h). */
export const REFRESH_LIFETIME_MS = 30 * 24 * 3600 * 1000;

const LOGIN_HINT = "zalo-agent social login";

/** Zalo's Social API error table ("Mã lỗi"): code → [meaning, what to do]. */
export const SOCIAL_ERRORS = Object.freeze({
    "-501": [
        "personal information is limited: the request's IP address is outside Vietnam",
        "call from a Vietnamese IP",
    ],
    100: ["invalid parameter", "check the fields asked for"],
    110: ["invalid user id", ""],
    111: ["cannot resolve a valid user id", ""],
    112: ["the app is not linked to any Official Account", "link the app to an OA in its settings"],
    210: ["the user is not visible to this app", "the user may have revoked the app's access: log in again"],
    289: ["reading friend requests needs the read_requests permission", ""],
    452: ["the session key is invalid (wrong format, or the user revoked it)", `log in again: ${LOGIN_HINT}`],
    2004: ["sending requests is temporarily disabled for this app", ""],
    2500: ["syntax error", ""],
    10000: ["the call failed", "try again"],
    10001: ["this method is not supported by the API", ""],
    10002: ["unknown exception", "try again"],
    10003: ["the item does not exist", ""],
    11004: ["the app id is disabled or banned", "check the app's status at developers.zalo.me"],
    12000: ["the app's quota is used up", ""],
    12001: ["the friend list asked for is too large (at most 50)", ""],
    12002: ["the app's daily quota is used up", "wait for tomorrow"],
    12003: ["the app's weekly quota is used up", ""],
    12004: ["the app's monthly quota is used up", ""],
    12006: ["the user has not used the app in 30 days", ""],
    12007: ["do not disturb: the user has not talked to this friend in 30 days", ""],
    12008: ["the recipient reached their quota (1 message per 3 days)", ""],
    12009: ["the sender and recipient are not friends", ""],
    12010: ["the app's daily quota for this user is used up", ""],
    12011: ["the friend does not use the app", ""],
    12012: ["the friend uses the app", ""],
});

/** Codes after which one refresh and one retry are worth it: an invalid session key, or an expired token. */
const SESSION_EXPIRED = new Set([452, -216, -220]);

// ─── Credentials ─────────────────────────────────────────────────────

/** @returns {string} the Social credentials file */
export function getSocialCredsFile() {
    return join(getOADataDir(), "social-credentials.json");
}

/**
 * Merge `data` into one profile's record (under a lock, replaced atomically at 0600). A key set to `null` is removed.
 * @param {object} data
 * @param {string} [profile]
 */
export function saveSocialCreds(data, profile = "default") {
    const file = getSocialCredsFile();
    fs.mkdirSync(getOADataDir(), { recursive: true });
    withFileLock(`${file}.lock`, () => {
        const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
        const next = { ...all[profile], ...data, updatedAt: new Date().toISOString() };
        for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
        all[profile] = next;
        writeFileAtomic(file, JSON.stringify(all, null, 2));
    });
}

/**
 * @param {string} [profile]
 * @returns {object|null}
 */
export function loadSocialCreds(profile = "default") {
    const file = getSocialCredsFile();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"))[profile] || null;
}

/**
 * The fields to store for a token answer. The refresh token's end: `refresh_token_expires_in` when Zalo sends it;
 * else, on a login, 30 days on; on a refresh, the end already stored (a refreshed token inherits it).
 *
 * @param {object} tokenData - `{ access_token, refresh_token, expires_in, refresh_token_expires_in? }`
 * @param {{ now?: number, inheritedEnd?: string }} [opts]
 * @returns {object}
 */
export function socialTokenFields(tokenData, { now = Date.now(), inheritedEnd } = {}) {
    const fields = { accessToken: tokenData.access_token };
    if (tokenData.refresh_token) fields.refreshToken = tokenData.refresh_token;
    const secs = Number(tokenData.expires_in ?? tokenData.expire_in);
    if (Number.isFinite(secs) && secs > 0) {
        fields.expiresIn = tokenData.expires_in ?? tokenData.expire_in;
        fields.expiresAt = new Date(now + secs * 1000).toISOString();
    }
    const refreshSecs = Number(tokenData.refresh_token_expires_in);
    if (Number.isFinite(refreshSecs) && refreshSecs > 0) {
        fields.refreshExpiresAt = new Date(now + refreshSecs * 1000).toISOString();
    } else {
        fields.refreshExpiresAt = inheritedEnd ?? new Date(now + REFRESH_LIFETIME_MS).toISOString();
    }
    return fields;
}

// ─── Login and refresh ───────────────────────────────────────────────

/** A token endpoint for one request: the Social token URL, with a fresh DPoP proof when the login uses one. */
function tokenEndpoint(dpopKey) {
    return {
        url: SOCIAL_TOKEN_URL,
        headers: dpopKey ? { DPoP: dpopProof({ method: "POST", url: SOCIAL_TOKEN_URL, key: dpopKey }) } : {},
    };
}

/**
 * Start a user login: the permission URL to open, and a promise for the saved login. The callback server binds
 * 127.0.0.1 (or 0.0.0.0 with `callbackHost`), checks `state`, exchanges the code with the verifier, and saves the
 * tokens (plus the DPoP key when `dpop` is set) in the profile.
 *
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.secretKey
 * @param {string} [opts.profile]
 * @param {number} [opts.port] - default 3457
 * @param {string} [opts.callbackHost]
 * @param {boolean} [opts.dpop] - bind the tokens to a new key pair
 * @param {number} [opts.timeoutMs]
 * @param {(info: { authUrl: string, bindHost: string, port: number }) => void} [opts.onListening]
 * @returns {{ authUrl: string, redirectUri: string, done: Promise<{ saved: object }> }}
 */
export function startSocialLogin({ appId, secretKey, profile = "default", port = 3457, callbackHost, dpop, ...rest }) {
    const dpopKey = dpop ? createDpopKey() : null;
    return startOAuthLogin({
        ...rest,
        appId,
        secretKey,
        port,
        callbackHost,
        permissionUrl: SOCIAL_PERMISSION_URL,
        tokenEndpoint: () => tokenEndpoint(dpopKey),
        save: (tokenData) => {
            const saved = { appId, secretKey, ...socialTokenFields(tokenData), dpopKey };
            saveSocialCreds(saved, profile);
            return saved;
        },
    });
}

/**
 * Refresh one profile's user token, serialized across processes; the new pair is saved before it is used. When
 * `staleToken` is given and the stored token already differs, another process refreshed: its token is returned.
 *
 * @param {string} [profile]
 * @param {{ staleToken?: string }} [opts]
 * @returns {Promise<object>} the stored record after the refresh, plus `refreshed`
 */
export async function refreshSocialToken(profile = "default", { staleToken } = {}) {
    return withAsyncFileLock(`${getSocialCredsFile()}.${encodeURIComponent(profile)}.refresh.lock`, async () => {
        const creds = loadSocialCreds(profile);
        if (staleToken && creds?.accessToken && creds.accessToken !== staleToken) return { ...creds, refreshed: false };
        if (!creds?.refreshToken || !creds?.appId || !creds?.secretKey) {
            throw new OAError(`No user login to refresh. Run: ${LOGIN_HINT}`, { code: "not_configured" });
        }
        if (creds.refreshExpiresAt && Date.parse(creds.refreshExpiresAt) <= Date.now()) {
            throw new OAError(`The login expired (a user login lasts at most 30 days). Run: ${LOGIN_HINT}`, {
                code: "login_expired",
            });
        }
        const tokenData = await refreshAccessToken(
            creds.refreshToken,
            creds.appId,
            creds.secretKey,
            tokenEndpoint(creds.dpopKey),
        );
        const failed = tokenErrorText(tokenData);
        if (failed) {
            throw new OAError(`Refresh error ${failed}. If the 30-day login ended, run: ${LOGIN_HINT}`, {
                code: typeof tokenData?.error === "number" ? tokenData.error : "token_refresh",
                data: tokenData,
            });
        }
        const fields = socialTokenFields(tokenData, { inheritedEnd: creds.refreshExpiresAt });
        saveSocialCreds(fields, profile);
        return { ...creds, ...fields, refreshed: true };
    });
}

// ─── Calls ───────────────────────────────────────────────────────────

/**
 * What a Social error code means, from the docs' table.
 * @param {number|string} code
 * @returns {{ meaning: string, hint: string }|null}
 */
export function describeSocialError(code) {
    const row = SOCIAL_ERRORS[String(code)];
    return row ? { meaning: row[0], hint: row[1] } : null;
}

async function callOnce(url, creds) {
    const headers = { access_token: creds.accessToken };
    if (creds.secretKey) headers.appsecret_proof = appSecretProof(creds.accessToken, creds.secretKey);
    if (creds.dpopKey) headers.DPoP = dpopProof({ method: "GET", url, key: creds.dpopKey });
    let res;
    try {
        res = await fetch(url, { method: "GET", headers });
    } catch (e) {
        throw new OAError(`${new URL(url).host} could not be reached: ${e.message}`, { code: "network" });
    }
    const json = await readZaloJson(res, url);
    if (json.error !== undefined && json.error !== 0 && json.error !== "0") {
        const code = Number(json.error);
        const doc = describeSocialError(code);
        const text =
            `Social API error ${code}` +
            (json.message ? `: ${json.message}` : "") +
            (doc ? ` (${doc.meaning})` : "") +
            (doc?.hint ? `. ${doc.hint[0].toUpperCase()}${doc.hint.slice(1)}` : "");
        throw new OAError(text, { code, data: json, meaning: doc?.meaning, hint: doc?.hint || undefined });
    }
    return json;
}

/**
 * GET one Social API endpoint with the profile's stored token; an expired session is refreshed once and the call
 * retried once.
 *
 * @param {string} path - e.g. "/me"
 * @param {{ query?: Record<string, string>, profile?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function socialGet(path, { query = {}, profile = "default" } = {}) {
    const creds = loadSocialCreds(profile);
    if (!creds?.accessToken) {
        throw new OAError(`No user login for profile "${profile}". Run: ${LOGIN_HINT}`, { code: "not_configured" });
    }
    const url = `${GRAPH_V2}${path}?${new URLSearchParams(query)}`;
    try {
        return await callOnce(url, creds);
    } catch (e) {
        if (!(e instanceof OAError) || !SESSION_EXPIRED.has(e.code) || !creds.refreshToken) throw e;
        const fresh = await refreshSocialToken(profile, { staleToken: creds.accessToken });
        return callOnce(url, fresh);
    }
}

/** The fields `/me` documents. */
export const ME_FIELDS = Object.freeze(["id", "name", "picture", "is_sensitive"]);
/** Avatar sizes `picture.type(…)` accepts. */
export const PICTURE_SIZES = Object.freeze(["small", "normal", "large"]);

/**
 * The logged-in user (`GET graph.zalo.me/v2.0/me`): `id` (this app's id for the user), `name`, `picture.data.url`,
 * and `is_sensitive` when asked (an account the law requires special handling for: minors, deceased, …).
 *
 * @param {{ fields?: string[], pictureSize?: string, profile?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function getMe({ fields = ["id", "name", "picture"], pictureSize, profile } = {}) {
    const unknown = fields.filter((f) => !ME_FIELDS.includes(f));
    if (unknown.length) {
        throw new OAError(`Unknown field ${unknown.join(", ")}; /me documents ${ME_FIELDS.join(", ")}`, {
            code: "invalid_input",
        });
    }
    if (pictureSize !== undefined && !PICTURE_SIZES.includes(pictureSize)) {
        throw new OAError(`--picture must be ${PICTURE_SIZES.join(", ")}`, { code: "invalid_input" });
    }
    const asked = fields.map((f) => (f === "picture" && pictureSize ? `picture.type(${pictureSize})` : f));
    return socialGet("/me", { query: { fields: asked.join(",") }, profile });
}
