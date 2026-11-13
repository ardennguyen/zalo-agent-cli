/**
 * Making a session: the options a session is built with (proxy, image metadata, what is announced), a login from a
 * saved login, and a QR login.
 *
 * The caller keeps the session and the paths: where a login's server settings (`drStoreFor`) and companion-device
 * identity (`trustStore`) live are the caller's to hand in. The CLI's single-session holder is
 * src/core/zalo-client.js.
 */

import fs from "node:fs";
import { basename } from "node:path";
import { imageSizeFromFile } from "image-size/fromFile";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { API_TYPE, resolveApiVersion } from "./profile.js";
import { qrLogin } from "./qr-login.js";
import { loginWithSession } from "./login.js";

/**
 * Read image dimensions for the session's `imageMetadataGetter`.
 *
 * The engine has no image library of its own and asks the caller for this. It
 * is consumed for the inline-image upload paths —
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
 * Throws rather than returning null: a falsy return would become a
 * generic ZaloApiError, which tells the user nothing about which file was
 * the problem or why.
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
 * The session options a session is built with: what the client announces, whether the session logs, what it delivers,
 * and the proxy when there is one.
 *
 * @param {string|null} proxyUrl
 * @param {object} [opts]
 * @param {boolean} [opts.logging=true] - the session's own logging (the CLI turns it off in JSON mode)
 * @param {object} [opts.env] - where ZALO_API_VERSION is read, `process.env` by default (./profile.js)
 * @returns {object}
 * @throws {Error} when ZALO_API_VERSION is invalid -- before any request is made
 */
export function buildSessionOptions(proxyUrl, { logging = true, env } = {}) {
    const opts = {
        // What the client announces, from the protocol profile (./profile.js).
        // The login builds every URL's zpw_ver and the login calls'
        // client_version from these.
        apiType: API_TYPE,
        apiVersion: env === undefined ? resolveApiVersion() : resolveApiVersion(env),
        // The session's logging (the protocol layer writes nothing either way)
        logging,
        imageMetadataGetter: readImageMetadata,
        // Deliver our own traffic too. Off would be
        // right for a bot that would otherwise answer itself, and wrong for a
        // local cache: without it, everything the owner sends -- from their
        // phone, from Zalo in a browser, from this CLI -- is dropped before any handler
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

/**
 * Log in with a saved login: the session object, logged in, with its upkeep timers running unless `upkeep` is false.
 *
 * @param {object} creds - {imei, cookie, userAgent, language?}
 * @param {object} opts
 * @param {object} opts.zaloOptions - from {@link buildSessionOptions}
 * @param {string|null} [opts.ownId] - the account the login belongs to, when the caller knows it
 * @param {((ownId: string|null) => object|null)|null} [opts.drStoreFor] - where an account's server settings are
 *   kept (`createDrStore(<file>)` of ./login.js); the caller owns the path
 * @param {boolean} [opts.upkeep] - false: no timers (a one-off probe)
 * @returns {Promise<object>} the session object
 */
export function openSession(creds, { zaloOptions, ownId = null, drStoreFor = null, upkeep } = {}) {
    return loginWithSession(creds, {
        apiType: zaloOptions.apiType,
        apiVersion: zaloOptions.apiVersion,
        zaloOptions,
        ownId,
        drStoreFor,
        ...(upkeep === undefined ? {} : { upkeep }),
    });
}

/**
 * Log in by QR code, Zalo's own QR sequence (./qr-login.js), then open the session it produced.
 *
 * @param {object} opts
 * @param {object} opts.zaloOptions - from {@link buildSessionOptions}
 * @param {string} opts.userAgent - the browser this client presents (./device-fingerprint.js picks one)
 * @param {Function|null} [opts.onEvent] - called with every QR event (generated, scanned, declined, expired)
 * @param {object} opts.trustStore - where the companion-device identity is kept (`createTrustStore` of
 *   ./trust-store.js)
 * @param {((ownId: string|null) => object|null)|null} [opts.drStoreFor] - see {@link openSession}
 * @param {((uid: string) => ({imei: string, userAgent: string}|null))|null} [opts.deviceFor] - the device id already
 *   used here for an account, to log in with again (see `qrLogin`)
 * @returns {Promise<object>} the session object
 */
export async function openQrSession({
    zaloOptions,
    userAgent,
    onEvent = null,
    trustStore,
    drStoreFor = null,
    deviceFor = null,
}) {
    const session = await qrLogin({
        userAgent,
        zaloOptions,
        apiType: zaloOptions.apiType,
        apiVersion: zaloOptions.apiVersion,
        onEvent,
        trustStore,
        deviceFor,
    });
    return loginWithSession(
        { imei: session.imei, cookie: session.cookies, userAgent: session.userAgent, language: session.language },
        {
            apiType: zaloOptions.apiType,
            apiVersion: zaloOptions.apiVersion,
            zaloOptions,
            drStoreFor,
        },
    );
}
