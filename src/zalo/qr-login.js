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
 *  3. `POST /account/authen/qr/generate`, form `{continue, cliGenQR, v}`: the QR image and its `code`.
 *  4. `POST /account/authen/qr/waiting-scan`, form `{continue, code, v}`: a long poll, asked again until the
 *     phone scans (error 8 means "not yet").
 *  5. `POST /account/authen/qr/waiting-confirm`, form `{continue, code, v}`: a long poll, asked again until the
 *     phone confirms. The official client also sends `bundle` (the trusted-device module's proof); this
 *     client cannot produce it and leaves it out, as the September login did. Whether Zalo accepts that is
 *     what a live login shows.
 *  6. `GET /account/checksession?continue=...` and the redirects it starts: `jr.zaloapp.com/jr/syncsession`,
 *     `jr.chat.zalo.me/jr/pushsession` (which sets `zpw_sek`), and the chat page.
 *
 * The session this returns is a cookie jar; {@link loginWithSession} turns it into a logged-in API. Events
 * keep the shape zca-js's callbacks had, so the commands that show the QR did not change.
 *
 * Until a QR login with this sequence has been seen to work live, `ZALO_QR_FLOW=official` selects it and
 * the zca-js flow stays the default (see `loginWithQR` in src/core/zalo-client.js).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { LoginQRCallbackEventType, Zalo, ZaloApiError, ZaloApiLoginQRAborted, ZaloApiLoginQRDeclined } from "zca-js";
import { withBrowserHeaders } from "./headers.js";

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
async function attempt(ctx, { controller, emit, actions, qrPath, lifetimeMs, state }) {
    const { signal } = controller;
    ctx.cookie = new Zalo().parseCookies([]); // an empty jar of zca-js's own kind

    // 1: the login page, and the build number in its script name.
    const page = await zu.request(ctx, PAGE_URL, {
        method: "GET",
        headers: { ...NAVIGATION_HEADERS, Referer: CHAT, "sec-fetch-site": "same-site" },
        signal,
    });
    const v = buildOf(await page.text());
    if (!v) throw new ZaloApiError("Cannot get API login version");

    // 2 and 3: what the page asks before it shows a QR, and the QR.
    await post(ctx, "/account/logininfo", { continue: CHAT, v }, signal);
    const generated = await post(ctx, "/account/authen/qr/generate", { continue: CHAT, cliGenQR: "1", v }, signal);
    const qr = generated?.data;
    if (!qr?.code || !qr?.image) {
        throw new ZaloApiError(`Unable to generate QRCode\nResponse: ${JSON.stringify(generated, null, 2)}`);
    }
    const image = String(qr.image).replace(/^data:image\/png;base64,/, "");
    emit({
        type: LoginQRCallbackEventType.QRCodeGenerated,
        data: { ...qr, image },
        actions: {
            async saveToFile(path = qrPath) {
                await writeFile(path, image, "base64");
            },
            ...actions,
        },
    });

    // A QR the caller already retried or aborted has no expiry to announce.
    if (signal.aborted) return new Promise(() => {});
    state.timer = setTimeout(() => {
        controller.abort();
        emit({ type: LoginQRCallbackEventType.QRCodeExpired, data: null, actions });
    }, lifetimeMs);

    // 4: the phone scans.
    const scanned = await longPoll(
        ctx,
        "/account/authen/qr/waiting-scan",
        { continue: CHAT, code: qr.code, v },
        signal,
    );
    if (!scanned?.data) throw new ZaloApiError("Cannot get scan result");
    emit({ type: LoginQRCallbackEventType.QRCodeScanned, data: scanned.data, actions });

    // 5: the phone confirms (or declines). No `bundle`: see the file header.
    const confirmed = await longPoll(
        ctx,
        "/account/authen/qr/waiting-confirm",
        { continue: CHAT, code: qr.code, v },
        signal,
    );
    clearTimeout(state.timer);
    if (!confirmed) throw new ZaloApiError("Cannot get confirm result");
    if (confirmed.error_code === DECLINED) {
        emit({ type: LoginQRCallbackEventType.QRCodeDeclined, data: { code: qr.code }, actions });
        throw new ZaloApiLoginQRDeclined();
    }
    if (confirmed.error_code !== 0) {
        throw new ZaloApiError(`An error has occurred.\nResponse: ${JSON.stringify(confirmed, null, 2)}`);
    }

    // 6: the id domain hands the session to the chat domain through two redirects. The request helper follows
    // them itself, one hop at a time, so that the cookie each hop sets is kept.
    const session = await zu.request(ctx, `${ID}/account/checksession?continue=${CONTINUE_QUERY}`, {
        method: "GET",
        redirect: "manual",
        headers: { ...NAVIGATION_HEADERS, Referer: PAGE_URL, "sec-fetch-site": "same-origin" },
        signal,
    });
    if (!session) throw new ZaloApiError("Cannot get session, login failed");
    await session.text().catch(() => "");

    return { cookies: ctx.cookie.toJSON().cookies, displayName: scanned.data.display_name ?? null };
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
 * @returns {Promise<{cookies: object[], imei: string, userAgent: string, language: string}>}
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
            attempt(ctx, { ...mine, emit, actions, qrPath, lifetimeMs }).then(
                (result) => {
                    clearTimeout(mine.state.timer);
                    if (mine.superseded) return;
                    const imei = zu.generateZaloUUID(userAgent);
                    onEvent?.({
                        type: LoginQRCallbackEventType.GotLoginInfo,
                        data: { cookie: result.cookies, imei, userAgent },
                        actions: null,
                    });
                    resolve({ cookies: result.cookies, imei, userAgent, language: "vi" });
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
