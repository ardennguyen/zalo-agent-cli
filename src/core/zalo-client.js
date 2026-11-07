/**
 * The CLI's session holder: one logged-in session per process, swapped on account switch, made from the active
 * account's saved login (src/zalo/client.js makes it; this module supplies the account's paths and keeps it).
 */

import { join } from "node:path";
import { getActive } from "./accounts.js";
import { CONFIG_DIR, getAccountDir, loadCredentials, saveCredentials } from "./credentials.js";
import { loadTestFakeSession, resolveTestFakeApi } from "./test-fake-session.js";
import { attachLoginSession } from "./keystore/index.js";
import { info } from "../utils/output.js";
import { generateDeviceFingerprint } from "../zalo/device-fingerprint.js";
import { secChUaFor } from "../zalo/headers.js";
import { API_VERSION_INVALID, resolveQrFlow } from "../zalo/profile.js";
import { createTrustStore } from "../zalo/trust-store.js";
import { createDrStore, stopUpkeep } from "../zalo/login.js";
import { buildSessionOptions, openQrSession, openSession } from "../zalo/client.js";

let _api = null;
let _ownId = null;

/** Get the current API instance or throw. */
export function getApi() {
    if (!_api) throw new Error("Not logged in. Run: zalo-agent login");
    return _api;
}

/** Get current owner ID. */
export function getOwnId() {
    return _ownId;
}

/** Check if logged in. */
export function isLoggedIn() {
    return _api !== null;
}

/**
 * The session options every session of this process is built with ({@link buildSessionOptions}). Suppresses the
 * session's logs in JSON mode.
 *
 * @param {string|null} proxyUrl
 * @returns {object}
 * @throws {Error} when ZALO_API_VERSION is invalid -- before any request is made
 */
function buildOptions(proxyUrl) {
    return buildSessionOptions(proxyUrl, { logging: !process.env.ZALO_JSON_MODE });
}

/** Where an account's server settings are kept: `accounts/<ownId>/dr-config.json`. */
const drStoreFor = (id) => (id ? createDrStore(join(getAccountDir(id), "dr-config.json")) : null);

/**
 * Whether two serialized cookie jars hold the same cookies: name, value, domain, path and expiry. Access
 * times are ignored, they change on every use.
 */
function sameCookies(a, b) {
    const flat = (jar) =>
        JSON.stringify(
            (jar?.cookies ?? (Array.isArray(jar) ? jar : []))
                .map((c) => [
                    c.key ?? c.name,
                    c.value,
                    String(c.domain ?? "").replace(/^./, ""),
                    c.path,
                    c.expires ?? null,
                ])
                .sort(),
        );
    return flat(a) === flat(b);
}

/**
 * Write the session's cookie jar back to the saved credentials when the login changed it (plan item L8).
 * Zalo may rotate cookies; a login that kept the rotated ones would otherwise be repeated with stale ones.
 * Never fatal, and never writes when nothing changed.
 *
 * @param {string|null} ownId
 * @param {object} creds - the credentials the login started from
 * @param {object} api - the session
 * @returns {boolean} whether credentials were rewritten
 */
function persistCookies(ownId, creds, api) {
    if (!ownId || !creds?.cookie) return false;
    try {
        const jar = JSON.parse(JSON.stringify(api.getContext().cookie));
        if (sameCookies(jar, creds.cookie)) return false;
        saveCredentials(ownId, { ...creds, cookie: jar });
        return true;
    } catch {
        return false;
    }
}

/** Set the active API + ownId (used after login). */
function setSession(api, ownId) {
    _api = api;
    _ownId = ownId;
}

/** Clear current session. */
export function clearSession() {
    stopUpkeep(_api);
    _api = null;
    _ownId = null;
}

/**
 * Login with saved credentials + proxy.
 * @param {object} creds - {imei, cookie, userAgent, language?}
 * @param {string|null} proxyUrl
 * @param {{ownId?: string|null}} [opts] - the account the credentials belong to, when the caller knows it: it
 *   locates the stored server settings the first server-info call carries, and the credentials that are
 *   rewritten when the login changed the cookies
 * @returns {object} - {api, ownId}
 */
export async function loginWithCredentials(creds, proxyUrl = null, { ownId: knownId = null } = {}) {
    const zaloOptions = buildOptions(proxyUrl);
    const api = await openSession(creds, { zaloOptions, ownId: knownId, drStoreFor });
    const ownId = api.getOwnId?.() || null;
    setSession(api, ownId);
    // The key layer gets the live login: the data key opens (dkey layer), and what is still plaintext is sealed.
    attachLoginSession(ownId, api);
    persistCookies(knownId, creds, api);
    return { api, ownId };
}

/**
 * Try a saved login once and keep nothing of it: no session is set, no timers run, no credentials are
 * rewritten. `logout` uses it to find out whether Zalo still accepts the login it has just signed out.
 *
 * @param {object} creds - {imei, cookie, userAgent, language?}
 * @param {string|null} [proxyUrl]
 * @param {{ownId?: string|null}} [opts]
 * @returns {Promise<{ownId: string|null}>} when Zalo accepted the login
 * @throws {Error} when Zalo (or the network) did not
 */
export async function probeSavedLogin(creds, proxyUrl = null, { ownId = null } = {}) {
    const zaloOptions = buildOptions(proxyUrl);
    const api = await openSession(creds, { zaloOptions, ownId, drStoreFor, upkeep: false });
    return { ownId: api.getOwnId?.() || null };
}

/**
 * Login via QR code with optional proxy: the official Web sequence (src/zalo/qr-login.js), then our own login with
 * the session it produced. `ZALO_QR_FLOW=legacy` (the previous engine's flow) was removed in 3.0.0 and is refused here,
 * before any request.
 *
 * @param {string|null} proxyUrl
 * @param {function} [onQrEvent] - called with every QR event (generated, scanned, declined, expired)
 * @returns {Promise<{api: object, ownId: string|null}>}
 * @throws {Error} with `.code === QR_FLOW_INVALID` when ZALO_QR_FLOW is set to anything but `official`
 */
export async function loginWithQR(proxyUrl = null, onQrEvent = null) {
    resolveQrFlow();
    // Throws on a bad ZALO_API_VERSION, also before any request.
    const zaloOptions = buildOptions(proxyUrl);

    // Zalo's server reads the sec-ch-ua Client Hints headers (not the User-Agent header) to fill in the
    // "Thiết bị" device label on the phone's QR-confirm screen. A varied, coherent User-Agent is picked once, at
    // the initial QR login; the hints are derived from it (src/zalo/headers.js), and it persists for this account
    // afterward via the saved credentials' userAgent field (extractCredentials()/loginWithCredentials()).
    const fingerprint = generateDeviceFingerprint();
    const platform = secChUaFor(fingerprint.userAgent)?.secChUaPlatform ?? "unknown";
    info(`Using device fingerprint: Chrome (${platform.replace(/"/g, "")})`);

    const api = await openQrSession({
        zaloOptions,
        userAgent: fingerprint.userAgent,
        onEvent: onQrEvent,
        trustStore: createTrustStore(getAccountDir),
        drStoreFor,
    });
    const ownId = api.getOwnId?.() || null;
    setSession(api, ownId);
    attachLoginSession(ownId, api);
    return { api, ownId };
}

/**
 * Extract credentials from current session for saving.
 * @returns {object} - {imei, cookie, userAgent, language}
 */
export function extractCredentials() {
    const api = getApi();
    const ctx = api.getContext();
    return {
        imei: ctx.imei,
        cookie: ctx.cookie,
        userAgent: ctx.userAgent,
        language: ctx.language,
    };
}

/**
 * Auto-login using active account from registry.
 * Called before commands that need authentication.
 * @param {boolean} jsonMode - suppress output in JSON mode
 */
export async function autoLogin(jsonMode = false) {
    if (_api) return; // Already logged in

    // Offline tests only: a fake session instead of a login. Refused (throws) outside the test sandbox --
    // the guard and why it cannot be reached in normal use are in src/core/test-fake-session.js.
    const fakeModule = resolveTestFakeApi({ configDir: CONFIG_DIR });
    if (fakeModule) {
        const fake = await loadTestFakeSession(fakeModule);
        setSession(fake.api, fake.ownId ?? null);
        return;
    }

    const active = getActive();
    if (!active) return;

    const creds = loadCredentials(active.ownId);
    if (!creds) return;

    try {
        await loginWithCredentials(creds, active.proxy || null, { ownId: active.ownId });
        if (!jsonMode) {
            info(`Auto-login: ${active.name || active.ownId}`);
        }
    } catch (e) {
        // A revoked session is by far the most common cause, and the bare
        // upstream message ("Đăng nhập thất bại") sends people looking for a
        // bug that isn't there.
        //
        // Measured 2026-09-20: this CLI authenticates as a WEB client — the
        // same device class as Zalo Web. Zalo permits one such session per
        // account, so logging into Zalo Web revokes this one *server-side*,
        // instantly and silently. The credential file on disk is left
        // byte-identical; only the server rejects it. The reverse is also
        // true: `zalo-agent login` logs Zalo Web out. The phone app is a
        // different device class and is unaffected.
        //
        // Saying only "Not logged in. Run: zalo-agent login" is actively
        // unhelpful here: that advice works, but it will log the user's
        // browser out again, and they will loop.
        // A bad ZALO_API_VERSION is a local setting, never a revoked session,
        // even when the value happens to contain "600".
        const revoked =
            e?.code !== API_VERSION_INVALID &&
            /đăng nhập thất bại|login failed|zpw_sek|kh[oô]ng đúng|600/i.test(e.message || "");
        console.error(`AutoLogin failed: ${e.message}`);
        if (revoked) {
            console.error(
                "  This session was revoked. Usually Zalo Web or another PC client signed in\n" +
                    "  on this account (only one such session is allowed at a time), or the\n" +
                    "  session was signed out from the phone's list of logged-in devices.\n" +
                    "  Running `zalo-agent login` will restore the CLI; if another web session\n" +
                    "  is active, it will sign that one out. The phone app is unaffected.",
            );
        }
    }
}
