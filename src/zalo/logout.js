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
 * as an extra step behind a server flag (`sendLogoutV2` in ./official-logout.js),
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
 * (./official-logout.js), which sign the DEVICE out: afterwards the saved cookie is rejected
 * and the phone stops listing it. What is described above is the `keepSession` path
 * (`logout --keep-session`): it ends the session key and nothing more, as before.
 *
 * Trying the saved login afterwards needs a new session, which the caller makes: `serverLogout` takes it as
 * `probeLogin`. The CLI's local side of a logout (credentials, history, the report) is src/core/logout.js.
 */
import { COMPUTER_NAME } from "./profile.js";
import { errorCodeOf } from "./errors.js";
import { boundUtils } from "./kernel/bound.js";
import { officialLogout, sendLogoutV2 } from "./official-logout.js";

/** Zalo Web's logout endpoint: the auth domain, not a service-map host. */
export const PRODUCTION_LOGOUT_URL = "https://wpa.chat.zalo.me/api/login/logOut";

/**
 * Error codes that mean "this session is no longer valid". 600 ("zpw_sek bị
 * thiếu hoặc không đúng") is what Zalo returned on the first authenticated call
 * after a proven logout. Only codes actually observed belong here: guessing more
 * would let an unrelated failure read as proof of logout.
 */
const SESSION_REJECTED = new Set([600]);

/**
 * Send Zalo Web's production logout.
 *
 * @param {object} api - a logged-in session API
 * @returns {Promise<*>} the response's `data`, decoded if it arrives encrypted
 * @throws {Error} carrying `.code` when Zalo answers with a non-zero error_code
 */
async function productionLogout(api) {
    const utils = boundUtils(api);
    const ctx = api.getContext();
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
    const opened = utils.decodeAES(data);
    if (opened === null) return data; // not an encrypted payload
    let inner;
    try {
        inner = JSON.parse(opened);
    } catch {
        return data;
    }
    if (inner?.error_code !== undefined && Number(inner.error_code) !== 0) {
        throw Object.assign(new Error(inner.error_message || `error_code ${inner.error_code}`), {
            code: inner.error_code,
        });
    }
    return inner?.data ?? inner;
}

/**
 * Codes with which Zalo refuses a login that is no longer valid: 600 (another session took it) and 102 ("the
 * session key was improperly submitted or has timed out", what the saved cookie got right after an official
 * logout, observed live 2026-10-25).
 */
const LOGIN_REFUSED = new Set([600, 102]);

/**
 * Whether a failed login attempt is Zalo saying "this login is no longer valid".
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export function isLoginRefused(e) {
    return (
        LOGIN_REFUSED.has(errorCodeOf(e)) || /đăng nhập thất bại|login failed|zpw_sek/i.test(String(e?.message ?? ""))
    );
}

/**
 * Probe the session key with the call `whoami` makes. The probe is expected to fail after a working logout
 * (measured 2026-09-30: an empty reply, "Failed to parse response data", every time); the protocol layer writes
 * nothing to stdout, so the failure is only reported, never printed.
 *
 * @param {object} api
 * @returns {Promise<{verdict: "ended"|"still-answers"|"unverified", probeError?: string}>}
 */
async function probeSessionKey(api) {
    try {
        await api.fetchAccountInfo();
        return { verdict: "still-answers" };
    } catch (e) {
        if (SESSION_REJECTED.has(Number(e?.code))) return { verdict: "ended" };
        return { verdict: "unverified", probeError: e.message };
    }
}

/**
 * Sign this device out at Zalo, the way the official client does (plan items L13a-c, X1).
 *
 * Runs the six steps of src/zalo/official-logout.js, then looks: the session key is probed with
 * `fetchAccountInfo`, and, when the saved login is given, it is tried in a new login. "Signed out" is claimed
 * only for a saved login Zalo then refuses. With `keepSession` it is the old key-only logout instead.
 *
 * @param {object} api - a logged-in session API
 * @param {object} [opts]
 * @param {boolean} [opts.keepSession] - only end this session's key (the pre-v3.0 behavior)
 * @param {{creds: object, proxy?: string|null, ownId?: string|null}|null} [opts.savedLogin] - the saved login to
 *   test afterwards; without it the result says the device sign-out could not be verified
 * @param {(saved: object) => Promise<"revoked"|"still-valid"|"unverified">} opts.probeLogin - tries the saved
 *   login in a new login of its own (the caller's: it owns how a session is made); `savedLogin` is handed to it
 * @returns {Promise<object>} `{mode: "official", steps, key, login}` -- or the key-only result of
 *   {@link keySessionLogout} with `mode: "key-only"`
 */
export async function serverLogout(api, { keepSession = false, savedLogin = null, probeLogin } = {}) {
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
 * the optional staging `logoutV2` (best-effort; Zalo Web's form: `params` sealed
 * with the session key, `time` in unix seconds), then a `fetchAccountInfo`
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
 * @param {object} api - a logged-in session API
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

    try {
        await sendLogoutV2(api);
        result.v2 = { ok: true };
    } catch (e) {
        result.v2 = { ok: false, error: e.message };
    }

    Object.assign(result, await probeSessionKey(api));
    return result;
}
