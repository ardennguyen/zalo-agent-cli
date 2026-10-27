/**
 * The QR login, as the official Zalo Web client does it (plan item L15).
 *
 * zca-js's `loginQR` differs from what the captured client sends: it announces `continue=https://zalo.me/pc`
 * to three calls, makes a `verify-client` call the official client never makes, leaves out `cliGenQR`, and
 * ends with a request to `jr/userinfo`. This is the verified sequence instead, all on `id.zalo.me` until the
 * last hop:
 *
 *  1. `GET /account?continue=https://chat.zalo.me/`: the login page; its script name carries the build `v`.
 *  2. `POST /account/logininfo`, form `{continue, v}`.
 *  3. `POST /account/authen/qr/generate`, form `{continue, cliGenQR, v}`: the first QR (an image the server draws)
 *     and its `code`. `cliGenQR=1` says the client can make a QR itself, which this client can (see below).
 *  4. `POST /account/authen/qr/waiting-scan`, form `{continue, code, v}`: a long poll, asked again until the
 *     phone scans (error 8 means "not yet").
 *  5. An account that has a trusted device answers that scan with `status 4`, `new_qr_supported`, and a new `code`
 *     and `token`, no name: the phone must scan a second QR, which the client makes itself from that token with
 *     the page's trusted-device module (./trust-wasm.js, ./qr-image.js). This is the QR that is "swapped" on the
 *     login page after the first scan. The long poll is then asked again on the new code, and its answer carries
 *     the name and `link_data`, which the module turns into a proof of this device.
 *  6. `POST /account/authen/qr/waiting-confirm`, form `{continue, code, bundle, v}`: a long poll, asked again
 *     until the phone confirms. `bundle` is the proof (base64 of `{encLinkMetaData, encAccSign, encDeviceSign,
 *     encCompPubKey}`); an account without a trusted device has none and confirms the first QR, with no bundle.
 *  7. `GET /account/checksession?continue=...` and the redirects it starts: `jr.zaloapp.com/jr/syncsession`,
 *     `jr.chat.zalo.me/jr/pushsession` (which sets `zpw_sek`), and the chat page.
 *
 * The session this returns is a cookie jar; {@link loginWithSession} turns it into a logged-in API. Events
 * keep the shape zca-js's callbacks had, so the commands that show the QR did not change; the second QR is one
 * more `QRCodeGenerated` event, with `data.layer` 2.
 *
 * Why the first version of this sequence failed on 2026-10-27, after it worked on 2026-10-25: the phone answered
 * "QR is not valid" to it twice, and the scan answer carried no name. The captured Web login shows the step it was
 * missing: the scan of the first QR is answered with `status 4` and a new code, and the page makes and shows a second
 * QR. That version took the answer for the scan and confirmed on the first code. Why it was not asked for on the 25th
 * is not known. See `docs/agent-notes.md`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { LoginQRCallbackEventType, Zalo, ZaloApiError, ZaloApiLoginQRAborted, ZaloApiLoginQRDeclined } from "zca-js";
import { withBrowserHeaders } from "./headers.js";
import { qrPng } from "./qr-image.js";
import { TRUST_PLATFORM_WEB, loadTrustWasm, wasmUrlOf } from "./trust-wasm.js";

const require = createRequire(import.meta.url);
const zcaDir = dirname(require.resolve("zca-js"));
const zu = require(join(zcaDir, "utils.cjs"));
const { createContext } = require(join(zcaDir, "context.cjs"));

const ID = "https://id.zalo.me";
const CHAT = "https://chat.zalo.me/";
const CONTINUE_QUERY = encodeURIComponent(CHAT);
const PAGE_URL = `${ID}/account?continue=${CONTINUE_QUERY}`;

/** The build number sits in the page's script name. */
const BUILD_PATTERN = /https:\/\/stc-zlogin\.zdn\.vn\/main-([\d.]+)\.js/;

/**
 * What the server answers a first scan with when the account has a trusted device: `status` 4, and a second code.
 */
const SECOND_LAYER_STATUS = 4;

/** Zalo's answer when a saved device identity is refused (the phone side was reset): link as a new device. */
const RELINK_REFUSED = -21;

/** The wasm files already fetched, by URL: they are 400 KB and the build changes about monthly. */
const wasmCache = new Map();

/** A QR code is shown for this long before a new one is made. */
export const QR_LIFETIME_MS = 100_000;

/** Zalo's answer to a long poll that has nothing yet. */
const NOT_YET = 8;

/** Zalo's answer when the phone declined. */
const DECLINED = -13;

/**
 * Headers of a call the page's script makes to its own origin.
 *
 * `Accept`, `Origin` and `Referer` are spelled exactly as zca-js's request helper spells its own defaults:
 * it merges by key, so a second spelling would be sent besides the default and a real fetch joins the two
 * into one garbled value.
 */
const POST_HEADERS = {
    Accept: "application/json, text/plain, */*",
    "content-type": "application/x-www-form-urlencoded",
    Origin: ID,
    Referer: PAGE_URL,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
};

/** Headers of a page load (and of the redirects it starts). */
const NAVIGATION_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    priority: "u=0, i",
    "upgrade-insecure-requests": "1",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
};

/**
 * The login page's build number.
 *
 * @param {string} html
 * @returns {string|null}
 */
export function buildOf(html) {
    return BUILD_PATTERN.exec(String(html))?.[1] ?? null;
}

/**
 * The login page's script, as a URL.
 *
 * @param {string} html
 * @returns {string|null}
 */
export function scriptUrlOf(html) {
    return BUILD_PATTERN.exec(String(html))?.[0] ?? null;
}

/**
 * Whether a scan answer asks for the second QR.
 *
 * @param {object|null|undefined} data
 * @returns {boolean}
 */
export function wantsSecondQr(data) {
    return data?.status === SECOND_LAYER_STATUS && data?.new_qr_supported === true && !!data?.token && !!data?.code;
}

/**
 * The trusted-device module of the login page, ready to call: the page's script names the wasm file, and both are
 * fetched as the page would.
 *
 * @param {object} ctx
 * @param {string} scriptUrl
 * @param {AbortSignal} [signal]
 */
export async function loadTrustFromPage(ctx, scriptUrl, signal) {
    const common = {
        method: "GET",
        signal,
        headers: { Accept: "*/*", Referer: `${ID}/`, "sec-fetch-site": "cross-site" },
    };
    const script = await zu.request(ctx, scriptUrl, {
        ...common,
        headers: { ...common.headers, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
    });
    const wasmUrl = wasmUrlOf(await script.text());
    if (!wasmUrl) throw new ZaloApiError("The login page names no trusted-device module (its layout changed)");
    if (!wasmCache.has(wasmUrl)) {
        const wasm = await zu.request(ctx, wasmUrl, {
            ...common,
            headers: { ...common.headers, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
        });
        wasmCache.set(wasmUrl, Buffer.from(await wasm.arrayBuffer()));
    }
    return loadTrustWasm(wasmCache.get(wasmUrl));
}

/**
 * One long-poll or JSON POST on the id domain.
 *
 * @param {object} ctx
 * @param {string} path
 * @param {Record<string, string>} fields
 * @param {AbortSignal} [signal]
 * @returns {Promise<{error_code?: number, error_message?: string, data?: any}>}
 */
async function post(ctx, path, fields, signal) {
    const res = await zu.request(ctx, `${ID}${path}`, {
        method: "POST",
        headers: POST_HEADERS,
        body: new URLSearchParams(fields),
        signal,
    });
    return res.json();
}

/**
 * Ask a long poll again for as long as the answer is "not yet".
 *
 * @param {object} ctx
 * @param {string} path
 * @param {Record<string, string>} fields
 * @param {AbortSignal} signal
 */
async function longPoll(ctx, path, fields, signal) {
    for (;;) {
        const answer = await post(ctx, path, fields, signal);
        if (answer?.error_code !== NOT_YET) return answer;
    }
}

/**
 * Run one QR login attempt to the end (or until it is aborted).
 *
 * @param {object} ctx
 * @param {object} p
 * @param {AbortController} p.controller
 * @param {(event: object) => void} p.emit
 * @param {{retry: Function, abort: Function}} p.actions
 * @param {string} p.qrPath
 * @param {number} p.lifetimeMs
 * @param {{timer: any}} p.state - holds the expiry timer so the caller can clear it
 * @returns {Promise<{cookies: object[]}>}
 */
async function attempt(ctx, { controller, emit, actions, qrPath, lifetimeMs, state, loadTrust, trustStore }) {
    const { signal } = controller;
    ctx.cookie = new Zalo().parseCookies([]); // an empty jar of zca-js's own kind

    // 1: the login page, and the build number in its script name.
    const page = await zu.request(ctx, PAGE_URL, {
        method: "GET",
        headers: { ...NAVIGATION_HEADERS, Referer: CHAT, "sec-fetch-site": "same-site" },
        signal,
    });
    const html = await page.text();
    const v = buildOf(html);
    if (!v) throw new ZaloApiError("Cannot get API login version");
    const scriptUrl = scriptUrlOf(html);

    // A QR is shown for `lifetimeMs`, then the attempt ends and the caller is told it expired.
    const armExpiry = () => {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => {
            controller.abort();
            emit({ type: LoginQRCallbackEventType.QRCodeExpired, data: null, actions });
        }, lifetimeMs);
    };
    const show = (qr, image, layer) =>
        emit({
            type: LoginQRCallbackEventType.QRCodeGenerated,
            data: { ...qr, image, layer },
            actions: {
                async saveToFile(path = qrPath) {
                    await writeFile(path, image, "base64");
                },
                ...actions,
            },
        });

    // 2 and 3: what the page asks before it shows a QR, and the first QR.
    await post(ctx, "/account/logininfo", { continue: CHAT, v }, signal);
    const generated = await post(ctx, "/account/authen/qr/generate", { continue: CHAT, cliGenQR: "1", v }, signal);
    const qr = generated?.data;
    if (!qr?.code || !qr?.image) {
        throw new ZaloApiError(`Unable to generate QRCode\nResponse: ${JSON.stringify(generated, null, 2)}`);
    }
    show(qr, String(qr.image).replace(/^data:image\/png;base64,/, ""), 1);

    // A QR the caller already retried or aborted has no expiry to announce.
    if (signal.aborted) return new Promise(() => {});
    armExpiry();

    // 4: the phone scans.
    let code = qr.code;
    let scanned = await longPoll(ctx, "/account/authen/qr/waiting-scan", { continue: CHAT, code, v }, signal);
    if (!scanned?.data) throw new ZaloApiError(`Cannot get scan result\nResponse: ${JSON.stringify(scanned)}`);

    // 5: an account with a trusted device asks for a second QR, which this client makes.
    let link = null;
    if (wantsSecondQr(scanned.data)) {
        const first = scanned.data;
        if (!scriptUrl) throw new ZaloApiError("Cannot find the login script (the trusted-device module is in it)");
        const trust = await loadTrust(ctx, scriptUrl, signal);
        const saved = trustStore?.load(first.chatUid, first.master_id) ?? null;
        const identity = saved
            ? { publicKey: saved.publicKey, privateKey: saved.privateKey }
            : trust.generateIdentity();
        const secret = saved ? saved.linkingSecret : trust.generateLinkingSecret();
        const relinkId = saved
            ? trust.getRelinkId({
                  primaryKey: saved.primaryPublicIdentityKey,
                  publicKey: saved.publicKey,
                  secret,
                  linkingTimestamp: saved.linkingTimestamp,
              })
            : undefined;
        const text = trust.generateLinkingQr({
            publicKey: identity.publicKey,
            secret: saved ? undefined : secret,
            qrToken: first.token,
            timestamp: Date.now(),
            platform: TRUST_PLATFORM_WEB,
            relinkId,
        });
        show(first, qrPng(text).toString("base64"), 2);
        if (signal.aborted) return new Promise(() => {});
        armExpiry();

        code = first.code;
        scanned = await longPoll(ctx, "/account/authen/qr/waiting-scan", { continue: CHAT, code, v }, signal);
        if (scanned?.error_code === RELINK_REFUSED && saved) {
            trustStore.clear(first.chatUid);
            throw new ZaloApiError("The saved device identity was refused by the phone; it was cleared. Log in again.");
        }
        if (!scanned?.data) throw new ZaloApiError(`Cannot get scan result\nResponse: ${JSON.stringify(scanned)}`);
        if (!scanned.data.link_data) throw new ZaloApiError("The phone's answer to the second QR carried no link data");
        const proof = trust.createLinkingProof({
            publicKey: identity.publicKey,
            privateKey: identity.privateKey,
            secret,
            primaryLinkingData: new Uint8Array(Buffer.from(scanned.data.link_data.enc_link_data, "base64")),
            linkingHmac: new Uint8Array(Buffer.from(scanned.data.link_data.enc_link_hmac, "base64")),
            platform: TRUST_PLATFORM_WEB,
        });
        link = { uid: first.chatUid, identity, secret, proof };
    }
    emit({ type: LoginQRCallbackEventType.QRCodeScanned, data: scanned.data, actions });

    // 6: the phone confirms (or declines); with a proof, the proof goes with it.
    const confirmFields = { continue: CHAT, code };
    if (link) {
        const b64 = (bytes) => Buffer.from(bytes).toString("base64");
        confirmFields.bundle = b64(
            Buffer.from(
                JSON.stringify({
                    encLinkMetaData: b64(link.proof.linkingMetadata),
                    encAccSign: b64(link.proof.accountSignature),
                    encDeviceSign: b64(link.proof.deviceSignature),
                    encCompPubKey: b64(link.identity.publicKey),
                }),
            ),
        );
    }
    confirmFields.v = v;
    const confirmed = await longPoll(ctx, "/account/authen/qr/waiting-confirm", confirmFields, signal);
    clearTimeout(state.timer);
    if (!confirmed) throw new ZaloApiError("Cannot get confirm result");
    if (confirmed.error_code === DECLINED) {
        emit({ type: LoginQRCallbackEventType.QRCodeDeclined, data: { code }, actions });
        throw new ZaloApiLoginQRDeclined();
    }
    if (confirmed.error_code !== 0) {
        throw new ZaloApiError(`An error has occurred.\nResponse: ${JSON.stringify(confirmed, null, 2)}`);
    }

    // 7: the id domain hands the session to the chat domain through two redirects. The request helper follows
    // them itself, one hop at a time, so that the cookie each hop sets is kept.
    const session = await zu.request(ctx, `${ID}/account/checksession?continue=${CONTINUE_QUERY}`, {
        method: "GET",
        redirect: "manual",
        headers: { ...NAVIGATION_HEADERS, Referer: PAGE_URL, "sec-fetch-site": "same-origin" },
        signal,
    });
    if (!session) throw new ZaloApiError("Cannot get session, login failed");
    await session.text().catch(() => "");

    // The identity is kept only once the login went through, so a failed one leaves no half-linked device behind.
    let trusted = null;
    if (link) {
        trusted = {
            uid: link.uid,
            masterId: link.proof.masterId,
            companionId: link.proof.companionId,
            linkId: link.proof.linkId,
            linkingTimestamp: link.proof.linkingTimestamp,
            publicKey: link.identity.publicKey,
            privateKey: link.identity.privateKey,
            linkingSecret: link.secret,
            primaryPublicIdentityKey: link.proof.primaryPublicIdentityKey,
            devices: confirmed.data?.devices ?? null,
        };
        trustStore?.save(trusted);
    }
    return {
        cookies: ctx.cookie.toJSON().cookies,
        displayName: scanned.data.display_name ?? null,
        trusted: trusted ? { uid: trusted.uid, masterId: trusted.masterId, companionId: trusted.companionId } : null,
    };
}

/**
 * Log in by QR with the official sequence and return the session it produced.
 *
 * @param {object} p
 * @param {string} p.userAgent - the browser identity of this login, kept for every later call
 * @param {object} [p.zaloOptions] - the zca-js options (`polyfill`, `agent`, `logging`, ...)
 * @param {number} p.apiType
 * @param {number} p.apiVersion
 * @param {(event: object) => void} [p.onEvent] - zca-js-shaped events (QRCodeGenerated, Scanned, Expired, Declined)
 * @param {string} [p.qrPath] - where `saveToFile()` writes by default
 * @param {number} [p.lifetimeMs] - how long a QR is shown before it expires
 * @param {Function} [p.loadTrust] - `(ctx, scriptUrl, signal) => trust module`, the page's by default
 * @param {{load: Function, save: Function, clear: Function}|null} [p.trustStore] - where the device identity is kept
 * @returns {Promise<{cookies: object[], imei: string, userAgent: string, language: string, trusted: object|null}>}
 * @throws {ZaloApiLoginQRDeclined|ZaloApiLoginQRAborted|ZaloApiError}
 */
export function qrLogin({
    userAgent,
    zaloOptions = {},
    apiType,
    apiVersion,
    onEvent = null,
    qrPath = "qr.png",
    lifetimeMs = QR_LIFETIME_MS,
    loadTrust = loadTrustFromPage,
    trustStore = null,
}) {
    return new Promise((resolve, reject) => {
        let current = null;

        const stop = () => {
            if (!current) return;
            clearTimeout(current.state.timer);
            current.controller.abort();
            current.superseded = true;
        };
        const emit = (event) => onEvent?.(event);
        const actions = {
            retry: () => {
                stop();
                start();
            },
            abort: () => {
                stop();
                reject(new ZaloApiLoginQRAborted());
            },
        };

        const start = () => {
            const ctx = createContext(apiType, apiVersion);
            Object.assign(ctx.options, zaloOptions);
            ctx.options.checkUpdate = false;
            ctx.options.polyfill = withBrowserHeaders(ctx.options.polyfill, userAgent);
            ctx.userAgent = userAgent;
            const mine = { controller: new AbortController(), state: { timer: null }, superseded: false };
            current = mine;
            attempt(ctx, { ...mine, emit, actions, qrPath, lifetimeMs, loadTrust, trustStore }).then(
                (result) => {
                    clearTimeout(mine.state.timer);
                    if (mine.superseded) return;
                    const imei = zu.generateZaloUUID(userAgent);
                    onEvent?.({
                        type: LoginQRCallbackEventType.GotLoginInfo,
                        data: { cookie: result.cookies, imei, userAgent },
                        actions: null,
                    });
                    resolve({
                        cookies: result.cookies,
                        imei,
                        userAgent,
                        language: "vi",
                        trusted: result.trusted,
                    });
                },
                (error) => {
                    clearTimeout(mine.state.timer);
                    // A QR that expired (or was retried or aborted) aborts its own requests: that is not a failure.
                    if (mine.superseded) return;
                    if (error?.name === "AbortError" || error?.name === "TimeoutError") return;
                    reject(error);
                },
            );
        };

        start();
    });
}
