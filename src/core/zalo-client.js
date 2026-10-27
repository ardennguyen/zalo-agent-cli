/**
 * Zalo client wrapper — direct zca-js API calls with proxy support.
 * Manages a single Zalo instance per process. Swap on account switch.
 */

import fs from "fs";
import { basename, join } from "node:path";
import { imageSizeFromFile } from "image-size/fromFile";
import { Zalo } from "zca-js";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { getActive } from "./accounts.js";
import { getAccountDir, loadCredentials, saveCredentials } from "./credentials.js";
import { info } from "../utils/output.js";
import { generateDeviceFingerprint } from "../utils/device-fingerprint.js";
import { API_TYPE, API_VERSION_INVALID, resolveApiVersion, resolveQrFlow } from "../zalo/profile.js";
import { qrLogin } from "../zalo/qr-login.js";
import { createDrStore, loginWithSession, stopUpkeep } from "../zalo/login.js";

/**
 * Read image dimensions for zca-js's `imageMetadataGetter`.
 *
 * zca-js 2.0.0 dropped its `sharp` dependency and now requires callers to
 * supply this. It is consumed for the inline-image upload paths —
 * jpg/jpeg/png/webp via getImageMetaData(), gif via getGifMetaData() — and
 * the width/height go straight into the upload params the recipient's
 * client uses to lay the message out.
 *
 * Two deliberate choices here:
 *
 * 1. **Dimensions come from `image-size`, not hand-rolled header parsing.**
 *    Zalo restricts only executables (`restricted_ext_file` is exe, cmd,
 *    bat, …), so a user can hand `send-image` a bmp, tiff, heic or avif.
 *    Parsing four formats by hand and returning null for the rest turned an
 *    unusual input into an opaque "Failed to get image metadata". image-size
 *    is pure JS with zero dependencies and covers ~20 formats.
 *
 * 2. **EXIF orientation is applied.** image-size *reports* `orientation` but
 *    does not act on it. Orientations 5–8 are the 90° rotations, where the
 *    stored dimensions are transposed relative to how the image displays —
 *    the common case being a phone photo. Sending stored dimensions there
 *    makes the recipient's layout box the wrong way round, so they are
 *    swapped.
 *
 * Throws rather than returning null: zca-js turns a falsy return into a
 * generic ZaloApiError, which tells the user nothing about which file was
 * the problem or why.
 *
 * Exported for testing; not part of the CLI's public surface.
 *
 * @param {string} filePath
 * @returns {Promise<{width: number, height: number, size: number}>}
 * @throws {Error} when the file is unreadable or is not a recognized image
 */
export async function readImageMetadata(filePath) {
    const stat = await fs.promises.stat(filePath);

    let dims;
    try {
        // Reads incrementally rather than slurping the file, which matters
        // because Zalo permits attachments up to 1 GB.
        dims = await imageSizeFromFile(filePath);
    } catch (e) {
        throw new Error(
            `Could not read image dimensions from "${basename(filePath)}": ${e.message}. ` +
                `Zalo renders jpg/jpeg/png/webp/gif inline; other formats are sent as file attachments.`,
        );
    }

    if (!dims || !dims.width || !dims.height) {
        throw new Error(`Could not read image dimensions from "${basename(filePath)}": no usable size in the header.`);
    }

    // EXIF orientations 5-8 rotate by 90°, transposing width and height.
    const transposed = dims.orientation >= 5 && dims.orientation <= 8;

    return {
        width: transposed ? dims.height : dims.width,
        height: transposed ? dims.width : dims.height,
        size: stat.size,
    };
}

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
 * Create a proxy-aware fetch that uses undici ProxyAgent dispatcher.
 * Native Node.js fetch ignores the `agent` option — must use `dispatcher`.
 *
 * The fetch is undici's own, not the global one: Node bundles its own undici (7.30 in Node 24.22), the package
 * here is another (8.x), and a dispatcher from one handed to the fetch of the other fails every request with
 * "invalid onRequestStart method". A proxied account could not log in at all.
 *
 * @param {string} proxyUrl
 * @returns {typeof fetch}
 */
export function createProxyFetch(proxyUrl) {
    const dispatcher = new ProxyAgent(proxyUrl);
    return (url, init = {}) => undiciFetch(url, { ...init, dispatcher });
}

/**
 * The zca-js options every session of this process is built with: what Zalo Web announces, how we log, what
 * we deliver, and the proxy when there is one. Suppresses logs in JSON mode.
 *
 * @param {string|null} proxyUrl
 * @returns {object}
 * @throws {Error} when ZALO_API_VERSION is invalid -- before any request is made
 */
function buildOptions(proxyUrl) {
    const opts = {
        // What Zalo Web announces, from the protocol profile (src/zalo/profile.js).
        // zca-js builds every URL's zpw_ver and the login calls' client_version
        // from these (createContext in its dist/context.js); left unset, it
        // announces 685.
        apiType: API_TYPE,
        apiVersion: resolveApiVersion(),
        // Suppress zca-js internal INFO logs when --json to keep stdout clean
        logging: !process.env.ZALO_JSON_MODE,
        imageMetadataGetter: readImageMetadata,
        // Deliver our own traffic too. zca-js defaults this off, which is
        // right for a bot that would otherwise answer itself, and wrong for a
        // local cache: without it, everything the owner sends -- from their
        // phone, from Zalo Web, from this CLI -- is dropped before any handler
        // sees it, so every conversation in zalo.db holds one side of itself.
        // It also made the new delivery receipts inert, since a receipt updates
        // the row of a message WE sent and that row was never written.
        // `listen --no-self` still hides self messages from stdout/webhook/JSONL.
        selfListen: true,
    };
    if (proxyUrl) {
        // HttpsProxyAgent for WebSocket (ws lib), ProxyAgent dispatcher for HTTP fetch
        opts.agent = new HttpsProxyAgent(proxyUrl);
        opts.polyfill = createProxyFetch(proxyUrl);
    }
    return opts;
}

/** A zca-js instance, for the QR login (the saved-session login is our own, src/zalo/login.js). */
function createZalo(proxyUrl) {
    return new Zalo(buildOptions(proxyUrl));
}

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
    const api = await loginWithSession(creds, {
        apiType: zaloOptions.apiType,
        apiVersion: zaloOptions.apiVersion,
        zaloOptions,
        ownId: knownId,
        drStoreFor: (id) => (id ? createDrStore(join(getAccountDir(id), "dr-config.json")) : null),
    });
    const ownId = api.getOwnId?.() || null;
    setSession(api, ownId);
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
    const api = await loginWithSession(creds, {
        apiType: zaloOptions.apiType,
        apiVersion: zaloOptions.apiVersion,
        zaloOptions,
        ownId,
        drStoreFor: (id) => (id ? createDrStore(join(getAccountDir(id), "dr-config.json")) : null),
        upkeep: false,
    });
    return { ownId: api.getOwnId?.() || null };
}

/**
 * Login via QR code with optional proxy.
 * @param {string|null} proxyUrl
 * @param {function} onQrGenerated - callback(qrData) when QR is ready
 * @returns {object} - {api, ownId}
 */
export async function loginWithQR(proxyUrl = null, onQrEvent = null) {
    const flow = resolveQrFlow();
    const zalo = createZalo(proxyUrl);

    // Zalo's server reads the sec-ch-ua Client Hints headers (not the
    // User-Agent header) to fill in the "Thiết bị" device label on the
    // phone's QR-confirm screen. zca-js's own default is internally
    // inconsistent — a Firefox User-Agent alongside hardcoded Chrome
    // Client Hints, a combination no real browser produces, and identical
    // across every zca-js install. Generating a coherent, varied
    // fingerprint here (once, at initial QR login) fixes both: the device
    // label becomes accurate, and it's no longer a fixed, correlatable
    // signal shared by every user of this tool. It persists automatically
    // for this account afterward via the saved credentials' userAgent
    // field — see extractCredentials()/loginWithCredentials() below.
    const fingerprint = generateDeviceFingerprint();
    info(`Using device fingerprint: Chrome (${fingerprint.secChUaPlatform.replace(/"/g, "")})`);

    if (flow === "official") {
        // The verified Web sequence (src/zalo/qr-login.js), then our own login with the session it produced.
        const zaloOptions = buildOptions(proxyUrl);
        const session = await qrLogin({
            userAgent: fingerprint.userAgent,
            zaloOptions,
            apiType: zaloOptions.apiType,
            apiVersion: zaloOptions.apiVersion,
            onEvent: onQrEvent,
        });
        const api = await loginWithSession(
            { imei: session.imei, cookie: session.cookies, userAgent: session.userAgent, language: session.language },
            {
                apiType: zaloOptions.apiType,
                apiVersion: zaloOptions.apiVersion,
                zaloOptions,
                drStoreFor: (id) => (id ? createDrStore(join(getAccountDir(id), "dr-config.json")) : null),
            },
        );
        const ownId = api.getOwnId?.() || null;
        setSession(api, ownId);
        return { api, ownId };
    }

    const api = await zalo.loginQR(
        {
            userAgent: fingerprint.userAgent,
            secChUa: fingerprint.secChUa,
            secChUaPlatform: fingerprint.secChUaPlatform,
            secChUaMobile: fingerprint.secChUaMobile,
        },
        (event) => {
            // Forward every event type (QRCodeGenerated, QRCodeScanned,
            // QRCodeDeclined, QRCodeExpired) — not just QRCodeGenerated,
            // which is all this used to pass through (hence the old
            // "onQrGenerated" name). Callers that only care about the QR
            // image (account.js's `account login`) are unaffected: they
            // already call displayQR(event) unconditionally, which no-ops
            // on event types without an image.
            if (onQrEvent) {
                onQrEvent(event);
            }
        },
    );

    const ownId = api.getOwnId?.() || null;
    setSession(api, ownId);
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
