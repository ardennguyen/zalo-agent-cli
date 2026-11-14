/**
 * Renewing an account's saved login from its running daemon, before it ends (`mcp start --http` with a publicUrl).
 *
 * A QR login lasts about 90 days and nothing renews it but a new QR scan by the account's phone (./session-notice.js).
 * Within `session.renew.daysBefore` days of the end (default 7), the daemon opens a **renewal**: a one-time QR login
 * page at `<publicUrl>/zalo/qr/<token>`, served on its own HTTP port and valid for `session.renew.linkTtl` (default
 * 24h). Its `session_expiring` events carry the link (`renewUrl`, `renewExpiresAt`) while it is open; when the link
 * runs out a new one is opened, with a new event, until the login is renewed or has ended and been renewed.
 *
 * - **The page** makes a fresh Zalo QR when it is opened (codes last about 100 s; an expired one waits for "Get a
 *   new code", then for a reload), says which account it renews (its name and id), and needs nothing but the scan and
 *   the confirmation on the phone.
 * - **The login** presents the account's saved browser and device id, as a re-login does, so Zalo's offline queue
 *   survives (src/core/zalo-client.js `renewLoginWithQR`). A scan by another account is refused before its session is
 *   opened, and the page says so; the link stays open for the right phone.
 * - **On success** the daemon saves the credentials sealed under the account's keyring (the same path as `login`),
 *   logs in again with them in place, follows the new session (the socket, the tools, the channel), and sends
 *   `session_renewed`. The link then dies: one successful use.
 * - **Protection.** A 128-bit token (src/utils/qr-http-server.js `QrPage`), kept in memory only (a restart opens a new
 *   link and the old one is dead), never logged (the access log masks `/zalo/qr/<token>`); `no-store`, `nosniff`,
 *   `no-referrer`, a nonce CSP and no framing; at most {@link PAGE_HITS_PER_MIN} requests a minute on a link and
 *   {@link LOGINS_PER_HOUR} QR logins started an hour.
 *
 * Settings: `session.renew` `{enabled, daysBefore, linkTtl}` in mcp-config.json (and `accounts.<ownId>.session`),
 * `ZALO_SESSION_RENEW[_<ownId>]` (`off` disables it), `ZALO_SESSION_RENEW_DAYS[_<ownId>]`, and the runtime policy's
 * `session.renew.*` on top. `zalo-agent session renew` opens one by hand.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QrPage } from "../utils/qr-http-server.js";
import { QR_EVENT } from "../zalo/enums.js";
import { durationMs } from "./deploy-policy.js";
import { policyValue } from "./policy-layer.js";
import { envForAccount } from "../mcp/mcp-config.js";

/** The settings a renewal runs with when nothing sets them. */
export const RENEW_DEFAULTS = Object.freeze({ enabled: true, daysBefore: 7, linkTtlMs: 24 * 3_600_000 });

/** The largest `daysBefore`: the first `session_expiring` threshold. */
export const RENEW_MAX_DAYS = 14;

/** The shortest and longest `linkTtl`. */
export const RENEW_MIN_TTL_MS = 10 * 60_000;
export const RENEW_MAX_TTL_MS = 7 * 86_400_000;

/** Requests one renewal link answers a minute (the page polls every 1.5 s: 40). */
export const PAGE_HITS_PER_MIN = 120;

/** QR logins one renewal starts an hour (each shows a code for about 100 s). */
export const LOGINS_PER_HOUR = 12;

/** How long an expired code waits for "Get a new code" before its login ends (a reload starts a new one). */
export const ASK_WINDOW_MS = 5 * 60_000;

/** How long after a renewal the old session's kick is expected (the new login replaces it). */
export const KICK_GRACE_MS = 60_000;

/** The account folder's file for the code on screen (0600, removed when the login ends). */
export const RENEW_IMAGE_FILE = "renew-qr.png";

const OFF = ["0", "false", "off", "no"];
const ON = ["1", "true", "on", "yes"];

/** A boolean setting, or undefined when the value is not one. */
function boolOf(v) {
    if (v === true || v === false) return v;
    const t = String(v ?? "")
        .trim()
        .toLowerCase();
    if (ON.includes(t)) return true;
    if (OFF.includes(t)) return false;
    return undefined;
}

/**
 * One account's renewal settings, layered like the other runtime settings: defaults < mcp-config.json
 * (`session.renew`, then `accounts.<ownId>.session.renew`, already merged into `config`) < environment
 * (`ZALO_SESSION_RENEW[_<ownId>]`, `ZALO_SESSION_RENEW_DAYS[_<ownId>]`) < the runtime policy (`session.renew.*`).
 * A value that cannot be used is left out, with a warning.
 *
 * @param {object} o
 * @param {object} [o.config] - the merged MCP config
 * @param {string|null} [o.accountId]
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {(key: string) => unknown} [o.policy] - one policy key (dotted)
 * @returns {{enabled: boolean, daysBefore: number, linkTtlMs: number,
 *   sources: {enabled: string, daysBefore: string, linkTtl: string}, warnings: string[]}}
 */
export function resolveRenewSettings({
    config = {},
    accountId = null,
    env = process.env,
    policy = (key) => policyValue(accountId, key),
} = {}) {
    const out = { ...RENEW_DEFAULTS };
    const sources = { enabled: "default", daysBefore: "default", linkTtl: "default" };
    const warnings = [];
    const set = {
        enabled: (v, src) => {
            const b = boolOf(v);
            if (b === undefined) return warnings.push(`session.renew.enabled from ${src} is not on or off; ignored`);
            out.enabled = b;
            sources.enabled = src;
        },
        daysBefore: (v, src) => {
            const n = typeof v === "number" ? v : Number(String(v).trim());
            if (!Number.isInteger(n) || n < 1 || n > RENEW_MAX_DAYS)
                return warnings.push(
                    `session.renew.daysBefore from ${src} is not a whole number from 1 to 14; ignored`,
                );
            out.daysBefore = n;
            sources.daysBefore = src;
        },
        linkTtl: (v, src) => {
            const ms = durationMs(v);
            if (!ms || ms < RENEW_MIN_TTL_MS || ms > RENEW_MAX_TTL_MS)
                return warnings.push(`session.renew.linkTtl from ${src} is not a duration from 10m to 7d; ignored`);
            out.linkTtlMs = ms;
            sources.linkTtl = src;
        },
    };
    const given = (v) => v !== undefined && v !== null && v !== "";
    const block = config?.session?.renew;
    if (block && typeof block === "object") {
        for (const key of ["enabled", "daysBefore", "linkTtl"]) if (given(block[key])) set[key](block[key], "config");
    }
    const envOn = envForAccount("ZALO_SESSION_RENEW", accountId, env);
    if (given(envOn)) set.enabled(envOn, "ZALO_SESSION_RENEW");
    const envDays = envForAccount("ZALO_SESSION_RENEW_DAYS", accountId, env);
    if (given(envDays)) set.daysBefore(envDays, "ZALO_SESSION_RENEW_DAYS");
    for (const key of ["enabled", "daysBefore", "linkTtl"]) {
        let v;
        try {
            v = policy(`session.renew.${key}`);
        } catch {
            v = undefined;
        }
        if (given(v)) set[key](v, "policy");
    }
    return { ...out, sources, warnings };
}

/**
 * Whether a login end is within the renewal window: `daysBefore` days or fewer left, or ended.
 *
 * @param {{daysLeft: number, expired: boolean}|null} expiry
 * @param {number} daysBefore
 * @returns {boolean}
 */
export function inRenewWindow(expiry, daysBefore) {
    if (!expiry) return false;
    return Boolean(expiry.expired) || expiry.daysLeft <= daysBefore;
}

/** What an event says when no renewal link can be opened here: no public address. */
export const RENEW_HINT_NO_PUBLIC_URL =
    "set publicUrl (or ZALO_MCP_PUBLIC_URL) on this `mcp start --http` server and it opens a renewal link by itself";

/**
 * The `session_renewed` event.
 *
 * @param {string} accountId
 * @param {{expiresAt: string, daysLeft: number}|null} expiry - the new login's end
 * @param {{deviceKept?: boolean, at?: number}} [o]
 * @returns {{event: "session_renewed", accountId: string, expiresAt: string|null, daysLeft: number|null,
 *   deviceKept: boolean, at: string}}
 */
export function sessionRenewedEvent(accountId, expiry, { deviceKept = true, at = Date.now() } = {}) {
    return {
        event: "session_renewed",
        accountId: String(accountId),
        expiresAt: expiry?.expiresAt ?? null,
        daysLeft: Number.isFinite(expiry?.daysLeft) ? expiry.daysLeft : null,
        deviceKept: Boolean(deviceKept),
        at: new Date(at).toISOString(),
    };
}

/**
 * One line for a person.
 *
 * @param {{accountId: string, expiresAt?: string|null, daysLeft?: number|null, deviceKept?: boolean}} e
 * @returns {string}
 */
export function describeSessionRenewed(e) {
    const end = e.expiresAt ? `; it now ends on ${String(e.expiresAt).slice(0, 10)} (${e.daysLeft} day(s))` : "";
    const device = e.deviceKept
        ? "the device id was kept, so Zalo's offline queue carries on"
        : "Zalo gave it a new device id: what arrived before it is restored by `zalo-agent sync`";
    return `account ${e.accountId}: the saved login was renewed by QR${end}; ${device}`;
}

/**
 * One `session_renewed` event as the MCP buffer carries it (a system event, as `session_expiring`).
 *
 * @param {object} e
 * @returns {object}
 */
export function sessionRenewedSystemEvent(e) {
    const rest = { ...e };
    delete rest.event;
    return { type: "session_renewed", ...rest, text: describeSessionRenewed(e) };
}

/**
 * Save a renewal's credentials the way `login` does: sealed under the account's keyring (which also moves the
 * account folder's login-end marker, so the `session_expiring` thresholds count again), and the kick marker cleared.
 *
 * @param {object} o
 * @param {string} o.ownId
 * @param {object} o.creds - `{imei, cookie, userAgent, language}`
 * @param {number} [o.now]
 * @param {object} o.deps - `{saveCredentials, readSavedDevice, loginDeviceChange, clearKickMarker, kickFile,
 *   getAccountDir}` (src/core/credentials.js, device-since.js, kick-marker.js)
 * @returns {{deviceKept: boolean}}
 */
export function saveRenewedLogin({ ownId, creds, now = Date.now(), deps }) {
    const device = deps.loginDeviceChange(deps.readSavedDevice(ownId), creds.imei);
    deps.saveCredentials(ownId, creds, { now });
    try {
        deps.clearKickMarker(deps.kickFile(deps.getAccountDir(ownId)));
    } catch {
        /* no marker */
    }
    return { deviceKept: !device?.newDevice };
}

/**
 * Switch a running daemon to a renewal's new session: signed out or yielded, presence comes back with it
 * (./daemon-presence.js `signIn`); parked (on-demand), the socket host keeps it for the next wake; otherwise the socket
 * host starts its socket on it now, closing the old one.
 *
 * @param {object} api - the new session
 * @param {{signIn: (api: object) => boolean, presence: {state: string}}} daemonPresence
 * @param {{adopt: (api: object) => void, start: (api: object) => unknown}} socketHost
 * @returns {"signed-in"|"adopted"|"started"}
 */
export function switchToRenewedSession(api, daemonPresence, socketHost) {
    if (daemonPresence.signIn(api)) return "signed-in";
    if (daemonPresence.presence.state === "parked") {
        socketHost.adopt(api);
        return "adopted";
    }
    socketHost.start(api);
    return "started";
}

/** What the renewal page says, in place of the login page's texts. */
export const RENEW_PAGE_TEXT = Object.freeze({
    en: Object.freeze({
        documentTitle: "Renew the Zalo login",
        title: "Renew the login with QR",
        sub: "Scan this code with the Zalo app of the account below.",
        note: "Open Zalo on this account's phone, tap the QR scanner, and point it at this code.",
        confirmNote: "Tap Confirm in the Zalo app to renew the login.",
        doneTitle: "The login is renewed",
        doneSub: "You can close this page. The server uses the new login now.",
        expiredGone: "Reload this page for a new code.",
        failedTitle: "The login was not renewed",
        failedSub: "Reload this page for a new code.",
        goneTitle: "This renewal link has ended",
        goneSub: "If the login still needs renewing, ask the server for a new link.",
    }),
    vi: Object.freeze({
        documentTitle: "Gia hạn đăng nhập Zalo",
        title: "Gia hạn đăng nhập bằng mã QR",
        sub: "Quét mã này bằng ứng dụng Zalo của tài khoản bên dưới.",
        note: "Mở Zalo trên điện thoại của tài khoản này, chọn quét mã QR và hướng camera vào mã này.",
        confirmNote: "Nhấn Xác nhận trong ứng dụng Zalo để gia hạn đăng nhập.",
        doneTitle: "Đã gia hạn đăng nhập",
        doneSub: "Bạn có thể đóng trang này. Máy chủ đang dùng lần đăng nhập mới.",
        expiredGone: "Tải lại trang này để có mã mới.",
        failedTitle: "Chưa gia hạn được đăng nhập",
        failedSub: "Tải lại trang này để có mã mới.",
        goneTitle: "Liên kết gia hạn này đã kết thúc",
        goneSub: "Nếu vẫn cần gia hạn đăng nhập, hãy yêu cầu máy chủ tạo liên kết mới.",
    }),
});

/** What the page says when a phone of another account scanned. */
export const WRONG_ACCOUNT_MESSAGE =
    "The phone that scanned is logged in to another Zalo account. Nothing was changed: scan with this account's phone.";

/**
 * A daemon's renewal: its link, its page, the QR logins it runs, and when it opens a new link.
 *
 * @param {object} args
 * @param {string} args.ownId
 * @param {string} args.accountDir
 * @param {string|null} args.publicUrl - the validated public address; null: no link can be opened here
 * @param {() => {enabled: boolean, daysBefore: number, linkTtlMs: number}} args.settings - read at every look
 * @param {() => string} [args.accountLabel] - what the page shows as the account: its name and id, never more
 * @param {(o: {onEvent: (event: object) => void}) => Promise<{creds: object}>} args.login - one QR login for this
 *   account (src/core/zalo-client.js `renewLoginWithQR`); throws `code: "WRONG_ACCOUNT"` for another account's scan
 * @param {(o: {creds: object}) => Promise<void>} args.onRenewed - save and switch to the new login; a throw shows on
 *   the page and keeps the link
 * @param {() => void} [args.onConfirming] - the phone scanned: the new login may replace the old session from now on
 * @param {(line: string) => void} [args.log] - never given the link
 * @param {() => number} [args.now]
 * @param {{setTimeout: Function, clearTimeout: Function}} [args.timers]
 * @returns {object}
 */
export function createSessionRenewal({
    ownId,
    accountDir,
    publicUrl,
    settings,
    accountLabel = () => String(ownId),
    login,
    onRenewed,
    onConfirming = () => {},
    log = () => {},
    now = Date.now,
    timers = { setTimeout, clearTimeout },
}) {
    const imagePath = join(accountDir, RENEW_IMAGE_FILE);
    const page = new QrPage({ now, processLogin: false, variant: { text: RENEW_PAGE_TEXT, account: "" } });
    page.configure({ publicUrl, mounted: true });
    let link = null; // {token, url, expiresAt, finish}
    let flow = null; // the QR login running on the link
    let succeeded = false; // the link was used: it serves its outcome, then it dies
    let renewing = false; // between the scan and the switch: a kick of the old session is expected
    let kickUntil = 0;
    let expiryTimer = null;
    let wake = null; // the watch's look, called when a link runs out
    let hits = [];
    let starts = [];

    const later = (fn, ms) => {
        const t = timers.setTimeout(fn, ms);
        t?.unref?.();
        return t;
    };
    const removeImage = () => {
        try {
            rmSync(imagePath, { force: true });
        } catch {
            /* already gone */
        }
    };
    const live = () => Boolean(link) && page.token === link.token && now() < link.expiresAt;

    function close(why) {
        if (expiryTimer) timers.clearTimeout(expiryTimer);
        expiryTimer = null;
        cancelFlow();
        if (link && page.token === link.token) page.revoke();
        if (link) log(`renewal link closed (${why})`);
        link = null;
        succeeded = false;
        removeImage();
    }

    function issue(why) {
        const { linkTtlMs } = settings();
        if (expiryTimer) timers.clearTimeout(expiryTimer);
        cancelFlow();
        succeeded = false;
        removeImage();
        page.variant.account = accountLabel();
        page.noteRestart();
        const opened = page.open({ qrImagePath: imagePath, ttlMs: linkTtlMs });
        link = { token: opened.token, url: opened.url, expiresAt: opened.expiresAt, finish: opened.finish };
        hits = [];
        // A new link (and event) as soon as this one runs out, not at the next hourly look.
        expiryTimer = later(() => {
            expiryTimer = null;
            try {
                wake?.();
            } catch {
                /* the next hourly look */
            }
        }, linkTtlMs + 1000);
        log(`renewal link opened (${why}), valid until ${new Date(link.expiresAt).toISOString()}`);
        return link;
    }

    function cancelFlow() {
        const f = flow;
        if (!f) return;
        flow = null;
        renewing = false;
        if (f.askTimer) timers.clearTimeout(f.askTimer);
        try {
            f.actions?.abort?.();
        } catch {
            /* ended */
        }
    }

    const fields = () =>
        live() ? { renewUrl: link.url, renewExpiresAt: new Date(link.expiresAt).toISOString() } : null;

    function allowStart() {
        const cut = now() - 3_600_000;
        starts = starts.filter((t) => t > cut);
        if (starts.length >= LOGINS_PER_HOUR) return false;
        starts.push(now());
        return true;
    }

    function allowHit() {
        const cut = now() - 60_000;
        hits = hits.filter((t) => t > cut);
        if (hits.length >= PAGE_HITS_PER_MIN) return false;
        hits.push(now());
        return true;
    }

    function onEvent(f, event) {
        if (flow !== f) return;
        switch (event?.type) {
            case QR_EVENT.QR_GENERATED: {
                if (f.askTimer) timers.clearTimeout(f.askTimer);
                f.askTimer = null;
                const image = event.data?.image;
                if (image) {
                    try {
                        writeFileSync(imagePath, Buffer.from(String(image), "base64"), { mode: 0o600 });
                    } catch (e) {
                        log(`renewal: the code could not be written (${e.message})`);
                    }
                }
                page.noteLayer(event.data?.layer === 2 ? 2 : 1);
                break;
            }
            case QR_EVENT.QR_SCANNED:
                // The name the phone shows goes to the page only, never to the log.
                page.noteScanned(event.data?.display_name || "");
                renewing = true;
                try {
                    onConfirming();
                } catch {
                    /* best effort */
                }
                break;
            case QR_EVENT.QR_EXPIRED: {
                renewing = false;
                f.actions = event.actions ?? null;
                let used = false;
                page.noteExpired(() => {
                    if (used || flow !== f) return;
                    used = true;
                    if (f.askTimer) timers.clearTimeout(f.askTimer);
                    f.askTimer = null;
                    event.actions?.retry?.();
                });
                // Nobody asked: this login ends, and the next visit (or "Get a new code") starts a new one.
                f.askTimer = later(() => {
                    if (used || flow !== f) return;
                    used = true;
                    f.idle = true;
                    event.actions?.abort?.();
                }, ASK_WINDOW_MS);
                break;
            }
            default:
                break;
        }
    }

    function startFlow() {
        if (flow || succeeded || !live()) return;
        removeImage();
        page.noteRestart();
        if (!allowStart()) {
            page.noteOutcome("failed", "Too many codes were asked for in the last hour. Try again later.");
            return;
        }
        const f = { actions: null, askTimer: null, idle: false };
        flow = f;
        log("renewal: a QR login started on the renewal link");
        Promise.resolve()
            .then(() => login({ onEvent: (e) => onEvent(f, e) }))
            .then(
                (r) => done(f, r),
                (e) => failed(f, e),
            );
    }

    async function done(f, result) {
        if (flow !== f) return;
        if (f.askTimer) timers.clearTimeout(f.askTimer);
        renewing = true;
        try {
            await onRenewed({ creds: result.creds });
        } catch (e) {
            flow = null;
            renewing = false;
            kickUntil = now() + KICK_GRACE_MS;
            log(`renewal: the new login could not be used here: ${e?.message ?? e}`);
            page.noteOutcome("failed", "The new login could not be used on this server. See its log.");
            return;
        }
        flow = null;
        renewing = false;
        kickUntil = now() + KICK_GRACE_MS;
        succeeded = true;
        page.noteOutcome("done");
        removeImage();
        log("renewal: the login was renewed; the link is used");
        // One use: the page reads how it ended, then the link dies.
        const used = link;
        await used?.finish?.({ graceMs: 10_000 });
        if (link === used) close("used");
    }

    function failed(f, e) {
        if (flow !== f) return;
        flow = null;
        renewing = false;
        if (f.askTimer) timers.clearTimeout(f.askTimer);
        removeImage();
        if (e?.code === "WRONG_ACCOUNT") {
            log("renewal: a scan by another account was refused; nothing was changed");
            page.noteOutcome("failed", WRONG_ACCOUNT_MESSAGE);
        } else if (f.idle || e?.name === "QrLoginAborted") {
            // An expired code nobody asked to replace: the button (or a reload) starts a new login.
            page.noteExpired(() => startFlow());
        } else if (e?.name === "QrLoginDeclined") {
            log("renewal: the login was declined on the phone");
            page.noteOutcome("failed", "The login was declined on the phone.");
        } else {
            log(`renewal: the QR login failed: ${e?.message ?? e}`);
            page.noteOutcome("failed", "The login did not go through.");
        }
    }

    return {
        /**
         * The watch's look (./session-notice.js): open a link when the login is within the window and none is open,
         * close one the login has left (renewed). Never throws.
         *
         * @param {{expiresAt: string, daysLeft: number, expired: boolean}|null} expiry
         * @returns {{issued: boolean, fields: {renewUrl: string, renewExpiresAt: string}|null,
         *   hint: string|null}|null} null outside the window or when renewal is off
         */
        tick(expiry) {
            let s;
            try {
                s = settings();
            } catch {
                return null;
            }
            if (!s.enabled || !inRenewWindow(expiry, s.daysBefore)) {
                if (link && !flow && !succeeded) close(s.enabled ? "the login is no longer due" : "renewal is off");
                return null;
            }
            if (!publicUrl) return { issued: false, fields: null, hint: RENEW_HINT_NO_PUBLIC_URL };
            if (live() || flow || succeeded) return { issued: false, fields: fields(), hint: null };
            issue(
                link
                    ? "the last link ran out"
                    : expiry.expired
                      ? "the login has ended"
                      : `the login ends in ${expiry.daysLeft} day(s)`,
            );
            return { issued: true, fields: fields(), hint: null };
        },

        /**
         * Open a link by hand (`zalo-agent session renew`), whatever the window and `enabled` say; the open one is
         * returned as it is unless `fresh`.
         *
         * @param {{fresh?: boolean}} [o]
         * @returns {{issued: boolean, renewUrl: string, renewExpiresAt: string}}
         * @throws {Error} with `code: "NO_PUBLIC_URL"` when there is no public address
         */
        openNow({ fresh = false } = {}) {
            if (!publicUrl) {
                const err = new Error(
                    "this server has no public address, so a renewal link cannot reach a phone: set publicUrl " +
                        "(or ZALO_MCP_PUBLIC_URL) and restart it, or log in by hand (`zalo-agent login`)",
                );
                err.code = "NO_PUBLIC_URL";
                throw err;
            }
            let issued = false;
            if (fresh || !live() || succeeded) {
                if (!flow || fresh) {
                    issue("asked for by hand");
                    issued = true;
                }
            }
            return { issued, ...fields() };
        },

        /** The link fields for an event while a link is open, else null. */
        fields,

        /** For `/status` and `fleet status`: whether a link is open, until when, and whether a scan is on. */
        status() {
            if (!live()) return null;
            return { open: true, expiresAt: new Date(link.expiresAt).toISOString(), scanning: Boolean(flow) };
        },

        /** Whether a kick of the current session is the renewal's own new login (the scan up to a minute after). */
        expectingKick: () => renewing || now() < kickUntil,

        /** The watch's look, called when a link runs out. */
        setWake(fn) {
            wake = typeof fn === "function" ? fn : null;
        },

        /**
         * The `/zalo/qr/<token>` route for this renewal's link. False for any other path (the caller goes on).
         *
         * @param {import("http").IncomingMessage} req
         * @param {import("http").ServerResponse} res
         * @returns {Promise<boolean>}
         */
        async handle(req, res) {
            if (!link || !page.owns(req.url)) return false;
            if (!allowHit()) {
                res.writeHead(429, {
                    "Content-Type": "text/plain",
                    "Cache-Control": "no-store, max-age=0",
                    "X-Content-Type-Options": "nosniff",
                    "Referrer-Policy": "no-referrer",
                    "Retry-After": "60",
                });
                res.end("Too many requests. Wait a minute.");
                return true;
            }
            const rest = String(req.url ?? "")
                .split("?")[0]
                .replace(/^\/zalo\/qr\/[^/]*/, "");
            // Opening the page asks for a fresh code (they last about 100 s): a login starts if none runs.
            if ((rest === "" || rest === "/") && req.method === "GET" && live()) startFlow();
            return page.handle(req, res);
        },

        /** The daemon is stopping. */
        stop() {
            close("the server stopped");
        },
    };
}
