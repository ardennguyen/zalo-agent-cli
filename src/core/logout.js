/**
 * End a Zalo session at Zalo's servers, the way Zalo Web does.
 *
 * Zalo Web's logout is `GET https://wpa.chat.zalo.me/api/login/logOut` (cmd
 * 11135): the common params plus `{time, client_version, type, imei,
 * computer_name}` as a PLAIN query string. The web builds it with `_get()`, which
 * URL-encodes the object as-is — no AES `params=` — and `time` is unix seconds.
 *
 * The web also calls `logoutV2` — POST /api/v2/login/logOut on whatever
 * `getDevDomainV3()` returns, which live is the staging host `stg-wpa` — but only
 * as an extra step behind a server flag. Our patched zca-js implements that one,
 * and until 2026-09-30 it was the only call `logout` and `account remove` made.
 * The session survived it (tier 5). docs/agent-notes.md has how that went
 * unnoticed; the short version is that "ended" was claimed without looking.
 *
 * So "ended" is claimed here only after Zalo rejects a follow-up call —
 * `fetchAccountInfo`, the same call `whoami` makes — with the session error Zalo
 * answered right after a proven logout on 2026-09-19. Anything else is reported
 * as what it is.
 *
 * v3.0 (plan items L13a-c, X1): the default logout is now the official client's six steps
 * (src/zalo/official-logout.js), which sign the DEVICE out: afterwards the saved cookie is rejected
 * and the phone stops listing it. What is described above is the `keepSession` path
 * (`logout --keep-session`): it ends the session key and nothing more, as before.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { getAccountDir, deleteCredentials } from "./credentials.js";
import { checkLock } from "./lock.js";
import { COMPUTER_NAME } from "../zalo/profile.js";
import { errorCodeOf } from "../zalo/errors.js";
import { officialLogout } from "../zalo/official-logout.js";

const require = createRequire(import.meta.url);

/** Zalo Web's logout endpoint: the auth domain, not a service-map host. */
export const PRODUCTION_LOGOUT_URL = "https://wpa.chat.zalo.me/api/login/logOut";

/**
 * Error codes that mean "this session is no longer valid". 600 ("zpw_sek bị
 * thiếu hoặc không đúng") is what Zalo returned on the first authenticated call
 * after a proven logout. Only codes actually observed belong here: guessing more
 * would let an unrelated failure read as proof of logout.
 */
const SESSION_REJECTED = new Set([600]);

let _utils = null;
/** zca-js internals, located the same way ./sync-v2/board.js does. */
function zcaUtils() {
    if (_utils) return _utils;
    _utils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return _utils;
}

/**
 * Send Zalo Web's production logout.
 *
 * @param {object} api - a logged-in zca-js API
 * @returns {Promise<*>} the response's `data`, decoded if it arrives encrypted
 * @throws {Error} carrying `.code` when Zalo answers with a non-zero error_code
 */
async function productionLogout(api) {
    const zu = zcaUtils();
    const call = zu.apiFactory()((_api, ctx, utils) => async () => {
        const url = utils.makeURL(PRODUCTION_LOGOUT_URL, {
            time: Math.floor(Date.now() / 1000),
            client_version: ctx.API_VERSION,
            type: ctx.API_TYPE,
            imei: ctx.imei,
            computer_name: COMPUTER_NAME,
        });
        const resp = await utils.request(url, { method: "GET" });
        // Nobody has captured this call's response. logoutV2 answered in plain
        // JSON, so read it unencrypted; if `data` turns out to be an encrypted
        // string, decode it and honour an error code inside it.
        const data = await utils.resolve(resp, undefined, false);
        if (typeof data !== "string" || !data) return data;
        let inner;
        try {
            inner = JSON.parse(zu.decodeAES(ctx.secretKey, data));
        } catch {
            return data; // not an encrypted payload
        }
        if (inner?.error_code !== undefined && Number(inner.error_code) !== 0) {
            throw Object.assign(new Error(inner.error_message || `error_code ${inner.error_code}`), {
                code: inner.error_code,
            });
        }
        return inner?.data ?? inner;
    })(api.getContext(), api);
    return call();
}

/** Whether a failed login attempt is Zalo saying "this login is no longer valid". */
function loginRefused(e) {
    return errorCodeOf(e) === 600 || /đăng nhập thất bại|login failed|zpw_sek/i.test(String(e?.message ?? ""));
}

/**
 * Try the saved login once, in a new login of its own.
 *
 * @param {{creds: object, proxy?: string|null, ownId?: string|null}} saved
 * @returns {Promise<"revoked"|"still-valid"|"unverified">} revoked: Zalo refused the saved login; still-valid: it
 *   logged in; unverified: the attempt failed for another reason (no network, a timeout), which proves nothing
 */
async function probeSavedLogin(saved) {
    try {
        const { probeSavedLogin: login } = await import("./zalo-client.js");
        await login(saved.creds, saved.proxy ?? null, { ownId: saved.ownId ?? null });
        return "still-valid";
    } catch (e) {
        return loginRefused(e) ? "revoked" : "unverified";
    }
}

/**
 * Probe the session key with the call `whoami` makes, with zca-js's logging off for this one call.
 *
 * @param {object} api
 * @returns {Promise<{verdict: "ended"|"still-answers"|"unverified", probeError?: string}>}
 */
async function probeSessionKey(api) {
    // The probe is expected to fail after a working logout, and zca-js logs
    // that failure with a raw stack trace (measured 2026-09-30: an empty reply,
    // "Failed to parse response data", every time). Its logger reads
    // ctx.options.logging on each call, so silence it for this call only.
    const options = typeof api.getContext === "function" ? api.getContext()?.options : null;
    const logging = options?.logging;
    if (options) options.logging = false;
    try {
        await api.fetchAccountInfo();
        return { verdict: "still-answers" };
    } catch (e) {
        if (SESSION_REJECTED.has(Number(e?.code))) return { verdict: "ended" };
        return { verdict: "unverified", probeError: e.message };
    } finally {
        if (options) options.logging = logging;
    }
}

/**
 * Sign this device out at Zalo, the way the official client does (plan items L13a-c, X1).
 *
 * Runs the six steps of src/zalo/official-logout.js, then looks: the session key is probed with
 * `fetchAccountInfo`, and, when the saved login is given, it is tried in a new login. "Signed out" is claimed
 * only for a saved login Zalo then refuses. With `keepSession` it is the old key-only logout instead.
 *
 * @param {object} api - a logged-in zca-js API
 * @param {object} [opts]
 * @param {boolean} [opts.keepSession] - only end this session's key (the pre-v3.0 behavior)
 * @param {{creds: object, proxy?: string|null, ownId?: string|null}|null} [opts.savedLogin] - the saved login to
 *   test afterwards; without it the result says the device sign-out could not be verified
 * @param {(saved: object) => Promise<"revoked"|"still-valid"|"unverified">} [opts.probeLogin] - replaces the
 *   default login attempt (tests)
 * @returns {Promise<object>} `{mode: "official", steps, key, login}` -- or the key-only result of
 *   {@link keySessionLogout} with `mode: "key-only"`
 */
export async function serverLogout(api, { keepSession = false, savedLogin = null, probeLogin = probeSavedLogin } = {}) {
    if (keepSession) return { mode: "key-only", ...(await keySessionLogout(api)) };

    const { steps } = await officialLogout(api);
    const key = await probeSessionKey(api);
    const login = savedLogin ? await probeLogin(savedLogin) : "unverified";
    return { mode: "official", steps, key, login };
}

/**
 * End this session's KEY at Zalo's servers (the pre-v3.0 logout, `--keep-session`).
 *
 * The production logout runs FIRST, while the session key is still valid, then
 * the optional staging `logoutV2` (best-effort), then a `fetchAccountInfo`
 * probe. Order matters: measured live 2026-09-30, running `logoutV2` first
 * kills the in-process session key, and the production call then answers
 * "Invalid Param". Sent first, the production call succeeds ("Successful.").
 *
 * What this does NOT do, also measured 2026-09-30: end the login. Both calls
 * end only this device's session key. The saved login (cookie) still
 * auto-logs-in on the next command, and the web session stays listed on the
 * phone as signed in until it is removed from the phone's device list. So the
 * `logout` command deletes the local credentials on top of this, and points
 * the user at the phone for a server-side revoke. This helper only reports what
 * the server calls did; it never claims the login ended.
 *
 * @param {object} api - a logged-in zca-js API
 * @returns {Promise<{
 *   v2: {ok: boolean, error?: string},
 *   production: {ok: boolean, error?: string, code?: number|null},
 *   verdict: "ended"|"still-answers"|"unverified",
 *   probeError?: string,
 * }>}
 */
export async function keySessionLogout(api) {
    const result = { v2: null, production: null, verdict: "unverified" };

    try {
        await productionLogout(api);
        result.production = { ok: true };
    } catch (e) {
        result.production = { ok: false, error: e.message, code: e.code ?? null };
    }

    if (typeof api.logoutV2 === "function") {
        try {
            await api.logoutV2();
            result.v2 = { ok: true };
        } catch (e) {
            result.v2 = { ok: false, error: e.message };
        }
    } else {
        result.v2 = { ok: false, error: "logoutV2 is not available (unpatched zca-js)" };
    }

    Object.assign(result, await probeSessionKey(api));
    return result;
}

/** zca-js's words for a reply with no body — what the probe got after every successful logout. */
const EMPTY_REPLY = /Failed to parse response data/;

/**
 * Delete the local chat cache (zalo.db + WAL/SHM sidecars) and downloaded media
 * for one account. Mirrors Zalo Web's "Xóa lịch sử trò chuyện khi đăng xuất"
 * checkbox — a purely local operation there too (a z_cleardata localStorage
 * flag consumed by the web's own deleteAllData(), no server call), so no
 * network round trip here either.
 *
 * @param {string} ownId
 * @returns {{dbDeleted: boolean, mediaDeleted: boolean}}
 */
export function deleteLocalHistory(ownId) {
    const accountDir = getAccountDir(ownId);
    let dbDeleted = false;
    let mediaDeleted = false;
    if (existsSync(accountDir)) {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            const p = join(accountDir, `zalo.db${suffix}`);
            if (existsSync(p)) {
                rmSync(p, { force: true });
                dbDeleted = true;
            }
        }
        const mediaDir = join(accountDir, "media");
        if (existsSync(mediaDir)) {
            rmSync(mediaDir, { recursive: true, force: true });
            mediaDeleted = true;
        }
    }
    return { dbDeleted, mediaDeleted };
}

/**
 * The PID of the `listen`/`mcp` daemon holding this account's `daemon.lock`, or
 * null. `logout` checks this before anything else: with a daemon up, the server
 * logout would end the session that daemon is using, and deleting the
 * credentials would leave it unable to re-auth.
 *
 * @param {string} ownId
 * @returns {number|null}
 */
export function lockHolder(ownId) {
    const lock = checkLock(getAccountDir(ownId));
    return lock.locked ? lock.pid : null;
}

/**
 * Whether `logout` needs a live session at all — decided before the entry
 * point's auto-login. It does not with `--no-remote` (no server call), nor
 * while a daemon holds the account (logout then refuses, changing nothing).
 * Measured 2026-09-30: both used to log in first, contacting Zalo for nothing.
 *
 * @param {{remote?: boolean}} opts - the `logout` Commander options
 * @param {{ownId: string}|null} active - the active account, if any
 * @returns {boolean}
 */
export function logoutNeedsSession(opts, active) {
    if (opts?.remote === false) return false;
    if (active?.ownId && lockHolder(active.ownId) !== null) return false;
    return true;
}

/**
 * Finish a real (non-purge) logout on this machine: delete the saved
 * credentials so nothing auto-logs-in, keeping the chat cache unless
 * `deleteHistory` is set. This is what makes `logout` a logout rather than a
 * pause — without it the next command logs straight back in from the saved
 * cookie (measured 2026-09-30).
 *
 * Guarded by the account's `daemon.lock`, the same way `removeAccount` guards
 * the credential delete: pulling credentials out from under a running
 * `listen`/`mcp` daemon would leave it unable to re-auth after a drop. When a
 * daemon holds the lock nothing is deleted and `blockedPid` names it.
 *
 * @param {string} ownId
 * @param {{deleteHistory?: boolean}} [opts]
 * @returns {{blockedPid: number} | {credentialsDeleted: boolean, history: {dbDeleted: boolean, mediaDeleted: boolean}}}
 */
export function finishLocalLogout(ownId, { deleteHistory = false } = {}) {
    const holder = lockHolder(ownId);
    if (holder !== null) return { blockedPid: holder };

    const history = deleteHistory ? deleteLocalHistory(ownId) : { dbDeleted: false, mediaDeleted: false };
    const credentialsDeleted = deleteCredentials(ownId);
    return { credentialsDeleted, history };
}

/**
 * What to tell the user about a serverLogout result, one line per fact.
 *
 * "Ended" is printed only for a verified end. A session that still answers is a
 * warning, never a success line — printing success unconditionally is exactly
 * how the staging-only logout passed for correct.
 *
 * @param {Awaited<ReturnType<typeof serverLogout>>} r - serverLogout's result
 * @returns {{level: "success"|"warning"|"info", text: string}[]}
 */
export function describeLogout(r) {
    if (r.mode === "official") return describeOfficialLogout(r);
    const lines = [];
    if (!r.production.ok) {
        lines.push({ level: "warning", text: `Zalo's logout call failed: ${r.production.error}` });
        if (!r.v2.ok) lines.push({ level: "info", text: `The secondary logoutV2 call failed too: ${r.v2.error}` });
    }
    if (r.verdict === "ended") {
        lines.push({
            level: "success",
            text: "Zalo ended this session's key — the next call on it was rejected.",
        });
    } else if (r.verdict === "still-answers") {
        lines.push({
            level: "warning",
            text: "Zalo accepted the logout, but this session still answers — it may still be valid at Zalo.",
        });
    } else if (r.production.ok && EMPTY_REPLY.test(String(r.probeError))) {
        // Not proof (an empty reply can have other causes), so not a success
        // line; but it is what every successful logout produced in testing.
        lines.push({
            level: "info",
            text: "Zalo accepted the logout, and the next call on this session came back empty, as it did after every successful logout in testing: this session's key is most likely gone.",
        });
    } else {
        lines.push({ level: "info", text: `Logout sent; could not confirm the session key died: ${r.probeError}` });
    }
    return lines;
}

/**
 * The lines for an official logout: what failed, then what was found out. "Signed out" is a success line only
 * for a saved login that Zalo then refused.
 *
 * @param {{steps: Array<{id: string, ok: boolean, error?: string}>, key: {verdict: string, probeError?: string},
 *   login: "revoked"|"still-valid"|"unverified"}} r
 * @returns {{level: "success"|"warning"|"info", text: string}[]}
 */
function describeOfficialLogout(r) {
    const lines = [];
    for (const s of r.steps.filter((x) => !x.ok)) {
        lines.push({ level: "warning", text: `Logout step "${s.id}" failed: ${s.error ?? "no answer"}` });
    }
    if (r.login === "revoked") {
        lines.push({
            level: "success",
            text: "Signed this device out at Zalo — a new login with the saved session was refused.",
        });
    } else if (r.login === "still-valid") {
        lines.push({
            level: "warning",
            text: "Zalo accepted the logout calls, but the saved login still works — this device may still be signed in. Remove it from your phone's list of logged-in devices.",
        });
    } else if (r.key.verdict === "ended") {
        lines.push({
            level: "info",
            text: "Zalo ended this session's key — the next call on it was rejected. Whether the saved login was refused could not be checked.",
        });
    } else if (r.key.verdict === "still-answers") {
        lines.push({
            level: "warning",
            text: "Zalo accepted the logout calls, but this session still answers — it may still be valid at Zalo.",
        });
    } else {
        lines.push({
            level: "info",
            text: `Logout sent; could not confirm that Zalo signed this device out${r.key.probeError ? `: ${r.key.probeError}` : ""}.`,
        });
    }
    return lines;
}

/**
 * Print a serverLogout result through the caller's output helpers.
 *
 * @param {Awaited<ReturnType<typeof serverLogout>>} r - serverLogout's result
 * @param {{success: Function, warning: Function, info: Function}} out - src/utils/output.js helpers
 */
export function reportLogout(r, out) {
    for (const { level, text } of describeLogout(r)) out[level](text);
}
