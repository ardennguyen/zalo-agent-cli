/**
 * Zalo client wrapper — direct zca-js API calls with proxy support.
 * Manages a single Zalo instance per process. Swap on account switch.
 */

import fs from "fs";
import { basename } from "node:path";
import { imageSizeFromFile } from "image-size/fromFile";
import { Zalo } from "zca-js";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import { getActive } from "./accounts.js";
import { loadCredentials } from "./credentials.js";
import { info } from "../utils/output.js";
import { generateDeviceFingerprint } from "../utils/device-fingerprint.js";

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
 */
function createProxyFetch(proxyUrl) {
    const dispatcher = new ProxyAgent(proxyUrl);
    return (url, init = {}) => fetch(url, { ...init, dispatcher });
}

/** Create a Zalo instance with optional proxy. Suppress logs in JSON mode. */
function createZalo(proxyUrl) {
    const opts = {
        // Suppress zca-js internal INFO logs when --json to keep stdout clean
        logging: !process.env.ZALO_JSON_MODE,
        imageMetadataGetter: readImageMetadata,
    };
    if (proxyUrl) {
        // HttpsProxyAgent for WebSocket (ws lib), ProxyAgent dispatcher for HTTP fetch
        opts.agent = new HttpsProxyAgent(proxyUrl);
        opts.polyfill = createProxyFetch(proxyUrl);
    }
    return new Zalo(opts);
}

/** Set the active API + ownId (used after login). */
function setSession(api, ownId) {
    _api = api;
    _ownId = ownId;
}

/** Clear current session. */
export function clearSession() {
    _api = null;
    _ownId = null;
}

/**
 * Login with saved credentials + proxy.
 * @param {object} creds - {imei, cookie, userAgent, language?}
 * @param {string|null} proxyUrl
 * @returns {object} - {api, ownId}
 */
export async function loginWithCredentials(creds, proxyUrl = null) {
    const zalo = createZalo(proxyUrl);
    const api = await zalo.login(creds);
    const ownId = api.getOwnId?.() || null;
    setSession(api, ownId);
    return { api, ownId };
}

/**
 * Login via QR code with optional proxy.
 * @param {string|null} proxyUrl
 * @param {function} onQrGenerated - callback(qrData) when QR is ready
 * @returns {object} - {api, ownId}
 */
export async function loginWithQR(proxyUrl = null, onQrEvent = null) {
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
        await loginWithCredentials(creds, active.proxy || null);
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
        const revoked = /đăng nhập thất bại|login failed|zpw_sek|kh[oô]ng đúng|600/i.test(e.message || "");
        console.error(`AutoLogin failed: ${e.message}`);
        if (revoked) {
            console.error(
                "  This session was revoked, which normally means Zalo Web or another PC\n" +
                    "  client signed in on this account — only one such session is allowed at a\n" +
                    "  time. Running `zalo-agent login` will restore the CLI, but it will sign\n" +
                    "  that other session out. The phone app is unaffected either way.",
            );
        }
    }
}
