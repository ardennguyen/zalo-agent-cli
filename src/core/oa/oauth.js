/**
 * OAuth v4 for an Official Account, as Zalo's OA docs ("Xác thực và ủy quyền cho ứng dụng") describe it:
 *
 * 1. A fresh `code_verifier` per request (43 characters of upper case, lower case and digits), and
 *    `code_challenge = Base64(SHA-256(ASCII(code_verifier)))` without padding (URL-safe alphabet, as PKCE has it).
 * 2. The permission URL with `app_id`, `redirect_uri`, `code_challenge` and a `state` that pairs the answer with
 *    its verifier (the parameter shape of the docs' `/v4/permission` page).
 * 3. The callback receives `?code=…&oa_id=…`; the code is single use and valid 10 minutes.
 * 4. POST `oauth.zaloapp.com/v4/oa/access_token`, form-urlencoded, header `secret_key`, body `code`, `app_id`,
 *    `grant_type=authorization_code`, `code_verifier`. The answer is `{ access_token, refresh_token, expires_in }`
 *    (`expires_in` a string of seconds: 25 h).
 * 5. Refresh: same URL and header, body `refresh_token`, `app_id`, `grant_type=refresh_token`. The refresh token is
 *    single use (3 months); the answer carries a new one and the old access token stops working at once. So a
 *    refresh is serialized under a file lock, re-reads the stored token inside the lock, and saves the new pair
 *    before anything uses it.
 *
 * The Social API's user login is the same flow on `oauth.zaloapp.com/v4/permission` and `/v4/access_token`
 * (src/core/social/client.js): the token, exchange and callback helpers take those URLs, extra headers (DPoP) and
 * a save function.
 */

import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { dirname } from "node:path";
import {
    OAUTH_PERMISSION_URL,
    OAUTH_TOKEN_URL,
    LOGIN_HINT,
    OAError,
    getOACredsFile,
    loadOACreds,
    saveOACreds,
    tokenFields,
    readZaloJson,
} from "./transport.js";

const VERIFIER_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A new PKCE code verifier: 43 characters, with at least one upper-case letter, lower-case letter and digit
 * (the docs' format).
 * @returns {string}
 */
export function createCodeVerifier() {
    for (;;) {
        let v = "";
        for (let i = 0; i < 43; i++) v += VERIFIER_CHARS[randomInt(VERIFIER_CHARS.length)];
        if (/[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v)) return v;
    }
}

/**
 * `code_challenge` for a verifier: SHA-256 of its ASCII bytes, Base64 (URL-safe) without padding.
 * @param {string} verifier
 * @returns {string}
 */
export function codeChallengeFor(verifier) {
    return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * A random `state` for one authorization request.
 * @returns {string}
 */
export function createState() {
    return randomBytes(16).toString("hex");
}

/**
 * The OA permission URL the admin opens.
 *
 * @param {string} appId
 * @param {string} [redirectUri] - the app's callback URL
 * @param {{ codeChallenge?: string, state?: string }} [pkce]
 * @returns {string}
 */
export function getOAuthUrl(
    appId,
    redirectUri = "http://localhost:3456/callback",
    { codeChallenge, state, permissionUrl = OAUTH_PERMISSION_URL } = {},
) {
    const params = new URLSearchParams({ app_id: appId, redirect_uri: redirectUri });
    if (codeChallenge) params.set("code_challenge", codeChallenge);
    if (state) params.set("state", state);
    return `${permissionUrl}?${params}`;
}

/**
 * Where a token request goes and what it adds: the OA token URL by default; the Social API's user token URL and a
 * DPoP header when its caller says so.
 *
 * @typedef {{ url?: string, headers?: Record<string, string> }} TokenEndpoint
 */

async function postToken(secretKey, fields, { url = OAUTH_TOKEN_URL, headers = {} } = {}) {
    let res;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", secret_key: secretKey },
            body: new URLSearchParams(fields),
        });
    } catch (e) {
        throw new OAError(`${url} could not be reached: ${e.message}`, { code: "network" });
    }
    const reply = await readZaloJson(res, url);
    // The docs' examples say `expires_in`, their field tables `expire_in`: read either.
    if (reply.expires_in === undefined && reply.expire_in !== undefined) reply.expires_in = reply.expire_in;
    return reply;
}

/**
 * Exchange an authorization code for tokens. Returns the endpoint's JSON as is (an OAuth error is in its
 * `error` / `error_name` / `error_description`); a non-2xx or non-JSON answer throws OAError `http_<status>`.
 *
 * @param {string} code
 * @param {string} appId
 * @param {string} secretKey
 * @param {string} [codeVerifier] - required when the permission URL carried a code_challenge
 * @param {TokenEndpoint} [endpoint] - default: the OA token URL
 * @returns {Promise<object>}
 */
export async function exchangeCode(code, appId, secretKey, codeVerifier, endpoint) {
    const fields = { code, app_id: appId, grant_type: "authorization_code" };
    if (codeVerifier) fields.code_verifier = codeVerifier;
    return postToken(secretKey, fields, endpoint);
}

/**
 * One raw refresh request (no lock, nothing saved): prefer {@link refreshStoredToken}.
 *
 * @param {string} refreshToken
 * @param {string} appId
 * @param {string} secretKey
 * @param {TokenEndpoint} [endpoint] - default: the OA token URL
 * @returns {Promise<object>}
 */
export async function refreshAccessToken(refreshToken, appId, secretKey, endpoint) {
    return postToken(secretKey, { refresh_token: refreshToken, app_id: appId, grant_type: "refresh_token" }, endpoint);
}

/** The text of an OAuth error answer, or null when the answer is a token. */
export function tokenErrorText(tokenData) {
    if (tokenData?.access_token && !tokenData.error) return null;
    if (tokenData?.error === undefined || tokenData.error === 0)
        return tokenData?.access_token ? null : "no access_token";
    return `${tokenData.error}: ${tokenData.error_description || tokenData.error_reason || tokenData.error_name || "unknown"}`;
}

// ─── Locked refresh ──────────────────────────────────────────────────

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === "EPERM";
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run async `fn` holding an exclusive lock file (O_EXCL, holder's pid inside; a dead holder's or an over-age lock
 * is taken over).
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {{ timeoutMs?: number, staleMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function withAsyncFileLock(lockPath, fn, { timeoutMs = 60_000, staleMs = 120_000 } = {}) {
    fs.mkdirSync(dirname(lockPath), { recursive: true });
    const mine = JSON.stringify({ pid: process.pid, at: Date.now(), n: randomBytes(4).toString("hex") });
    const started = Date.now();
    for (;;) {
        try {
            fs.writeFileSync(lockPath, mine, { flag: "wx", mode: 0o600 });
            break;
        } catch (e) {
            if (e.code !== "EEXIST" && e.code !== "EPERM" && e.code !== "EBUSY") throw e;
        }
        let seen = null;
        let holder = null;
        try {
            seen = fs.readFileSync(lockPath, "utf8");
            holder = JSON.parse(seen)?.pid ?? null;
        } catch {
            /* torn or just released */
        }
        let age = 0;
        try {
            age = Date.now() - fs.statSync(lockPath).mtimeMs;
        } catch {
            continue;
        }
        if ((holder !== null && !alive(holder)) || age > staleMs) {
            try {
                if (fs.readFileSync(lockPath, "utf8") === seen) fs.unlinkSync(lockPath);
            } catch {
                /* someone else took it over */
            }
            continue;
        }
        if (Date.now() - started > timeoutMs) {
            throw new OAError(`could not lock ${lockPath}: held by pid ${holder ?? "unknown"}`, {
                code: "token_refresh",
            });
        }
        await sleep(20 + Math.floor(Math.random() * 30));
    }
    try {
        return await fn();
    } finally {
        try {
            if (fs.readFileSync(lockPath, "utf8") === mine) fs.unlinkSync(lockPath);
        } catch {
            /* already gone */
        }
    }
}

/**
 * Refresh one OA's stored access token, serialized across processes.
 *
 * Inside the lock the stored record is read again: when `staleToken` is given and the stored access token is no
 * longer it, another process already refreshed and its token is returned without a second refresh. Otherwise one
 * refresh request is made and the new refresh token, access token, `expiresIn` and `expiresAt` are saved before
 * the result is returned.
 *
 * @param {string} [oaId]
 * @param {{ staleToken?: string }} [opts]
 * @returns {Promise<object>} the stored record after the refresh, plus `refreshed` (false when another process did it)
 */
export async function refreshStoredToken(oaId = "default", { staleToken } = {}) {
    return withAsyncFileLock(`${getOACredsFile()}.${encodeURIComponent(oaId)}.refresh.lock`, async () => {
        const creds = loadOACreds(oaId);
        if (staleToken && creds?.accessToken && creds.accessToken !== staleToken) {
            return { ...creds, refreshed: false };
        }
        if (!creds?.refreshToken || !creds?.appId || !creds?.secretKey) {
            throw new OAError(`Missing refresh credentials. Run: ${LOGIN_HINT}`, { code: "not_configured" });
        }
        const tokenData = await refreshAccessToken(creds.refreshToken, creds.appId, creds.secretKey);
        const failed = tokenErrorText(tokenData);
        if (failed) {
            throw new OAError(
                `Refresh error ${failed}. A refresh token is single use and lasts 3 months; if it expired, run: ${LOGIN_HINT}`,
                { code: typeof tokenData?.error === "number" ? tokenData.error : "token_refresh", data: tokenData },
            );
        }
        const fields = tokenFields(tokenData);
        saveRefreshed(fields, oaId);
        return { ...creds, ...fields, refreshed: true };
    });
}

/** Save the new pair; retried once, because the old refresh token is already spent. */
function saveRefreshed(fields, oaId) {
    try {
        saveOACreds(fields, oaId);
    } catch {
        try {
            saveOACreds(fields, oaId);
        } catch (e) {
            throw new OAError(
                `The token was refreshed but could not be saved (${e.message}); the old refresh token is spent, so run: ${LOGIN_HINT}`,
                { code: "token_refresh" },
            );
        }
    }
}

// ─── Browser and callback ────────────────────────────────────────────

/**
 * Escape text for an HTML page.
 * @param {any} text
 * @returns {string}
 */
export function escapeHtml(text) {
    return String(text).replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
}

/**
 * How to open `url` in the default browser on `platform`, without a shell (so `&` in the URL is not a command
 * separator and Windows' `start` cannot take the URL for a window title).
 *
 * @param {string} url
 * @param {string} [platform]
 * @returns {[string, string[]]} file and arguments for execFile
 */
export function browserCommand(url, platform = process.platform) {
    if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
    if (platform === "darwin") return ["open", [url]];
    return ["xdg-open", [url]];
}

/**
 * Open `url` in the default browser; failures are ignored (the URL is printed for the user anyway).
 * @param {string} url
 */
export function openInBrowser(url) {
    const [file, args] = browserCommand(url);
    try {
        execFile(file, args, () => {}).on?.("error", () => {});
    } catch {
        /* no browser: the URL is printed */
    }
}

/**
 * Run the OAuth callback half: a one-shot HTTP server on `/callback` that checks `state`, exchanges the code with
 * the verifier, saves the credentials and closes. The server binds 127.0.0.1 unless `callbackHost` names a public
 * host (then 0.0.0.0). The timer is cleared on every outcome, so a finished login exits at once.
 *
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.secretKey
 * @param {number} [opts.port] - default 3456
 * @param {string} [opts.callbackHost] - e.g. https://example.com (VPS mode)
 * @param {string} [opts.oaId] - the record to save into (default "default")
 * @param {number} [opts.timeoutMs] - default 2 minutes
 * @param {(info: { authUrl: string, bindHost: string, port: number }) => void} [opts.onListening]
 * @param {string} [opts.permissionUrl] - default: the OA permission URL (the Social API passes its own)
 * @param {() => TokenEndpoint} [opts.tokenEndpoint] - built at exchange time (a DPoP proof is fresh); default OA
 * @param {(tokenData: object, ctx: { appId: string, secretKey: string, returnedOaId: string|null }) => object} [opts.save]
 *   - stores the answer and returns what was saved; default: the OA record `oaId`
 * @returns {{ authUrl: string, redirectUri: string, done: Promise<{ tokenData: object, oaId: string|null, saved: object }> }}
 */
export function startOAuthLogin({
    appId,
    secretKey,
    port = 3456,
    callbackHost,
    oaId = "default",
    timeoutMs = 120_000,
    onListening,
    permissionUrl,
    tokenEndpoint,
    save,
}) {
    const callbackBase = callbackHost ? callbackHost.replace(/\/+$/, "") : `http://localhost:${port}`;
    const redirectUri = `${callbackBase}/callback`;
    const verifier = createCodeVerifier();
    const state = createState();
    const authUrl = getOAuthUrl(appId, redirectUri, {
        codeChallenge: codeChallengeFor(verifier),
        state,
        permissionUrl,
    });
    const bindHost = callbackHost ? "0.0.0.0" : "127.0.0.1";

    const done = new Promise((resolveDone, rejectDone) => {
        let timer = null;
        let settled = false;
        const page = (res, status, title, text) => {
            res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p>`);
        };
        const finish = (err, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            server.close();
            server.closeIdleConnections?.();
            if (err) rejectDone(err);
            else resolveDone(value);
        };
        const server = createServer(async (req, res) => {
            if (settled || !req.url?.startsWith("/callback")) {
                res.writeHead(404);
                res.end();
                return;
            }
            const url = new URL(req.url, `http://localhost:${port}`);
            const code = url.searchParams.get("code");
            const returnedState = url.searchParams.get("state");
            const returnedOaId = url.searchParams.get("oa_id");
            // Zalo echoes `state` on the redirect; one that is present and differs is someone else's answer.
            if (returnedState !== null && returnedState !== state) {
                page(res, 400, "Login failed", "The state does not match this login. Start the login again.");
                return finish(new Error("OAuth state mismatch: the callback is not the answer to this login"));
            }
            if (!code) {
                const msg = url.searchParams.get("error_description") || "No authorization code received";
                page(res, 400, "Login failed", msg);
                return finish(new Error(msg));
            }
            try {
                const tokenData = await exchangeCode(code, appId, secretKey, verifier, tokenEndpoint?.());
                const failed = tokenErrorText(tokenData);
                if (failed) throw new Error(`Token error ${failed}`);
                let saved;
                if (save) {
                    saved = save(tokenData, { appId, secretKey, returnedOaId });
                } else {
                    saved = { appId, secretKey, ...tokenFields(tokenData), oaId: returnedOaId || oaId };
                    saveOACreds(saved, oaId);
                }
                page(res, 200, "Login successful!", "You can close this tab and return to the terminal.");
                finish(null, { tokenData, oaId: returnedOaId, saved });
            } catch (e) {
                page(res, 500, "Login failed", e.message);
                finish(e);
            }
        });
        server.on("error", (e) => finish(e));
        server.listen(Number(port), bindHost, () => onListening?.({ authUrl, bindHost, port: Number(port) }));
        timer = setTimeout(
            () => finish(new Error(`Login timed out (${Math.round(timeoutMs / 60000)} min). Try again.`)),
            timeoutMs,
        );
    });
    return { authUrl, redirectUri, done };
}
