/**
 * One QR login, as `login` and `account login` both run it: the QR in the terminal and on the local page, who scanned
 * it, a decline, and what happens when a code expires.
 *
 * An expired code is not replaced on its own while someone is there to ask for one, as on Zalo Web: the page shows
 * "QR code expired" with a button, and the terminal waits for Enter. Nobody asking within `ASK_WINDOW_MS` ends the
 * login. With no one to ask (--json, or no terminal: an agent, a background `login --qr-url &`) the code is replaced at
 * once, up to `MAX_CODES` codes, and then the login ends. Either way it never waits forever.
 */

import { QR_EVENT } from "../zalo/enums.js";
import { loginWithQR } from "./zalo-client.js";
import { displayQR, getQRPath } from "../utils/qr-display.js";
import {
    QR_LINK_TTL_MS,
    getQrPage,
    noteQrExpired,
    noteQrOutcome,
    noteQrScanned,
    startQrServer,
} from "../utils/qr-http-server.js";
import { info, warning } from "../utils/output.js";
import { resolvePublicUrl } from "./deploy-policy.js";
import { loadMCPConfig } from "../mcp/mcp-config.js";

/** How many codes a login shows when nobody can be asked for a new one (Zalo's codes last 100 s each). */
export const MAX_CODES = 5;

/** How long an expired code waits for someone to ask for a new one. */
export const ASK_WINDOW_MS = 5 * 60_000;

/** Why a login ended without a scan; the commands print it instead of the bare "aborted". */
export class QrLoginTimedOut extends Error {
    constructor(message) {
        super(message);
        this.name = "QrLoginTimedOut";
    }
}

/**
 * The public address a login prints its QR link under: `--public-url`, else `ZALO_MCP_PUBLIC_URL`, else `publicUrl`
 * in mcp-config.json (no account is known before the scan, so no per-account layer, and not the deprecated
 * issuer names). Null keeps the localhost page.
 * @param {string|undefined} flag
 * @param {{env?: NodeJS.ProcessEnv, config?: object}} [o]
 * @returns {{publicUrl: string|null, source: string, error: string|null}}
 */
export function resolveLoginPublicUrl(flag, { env = process.env, config } = {}) {
    return resolvePublicUrl({ flag, env, config: config ?? loadMCPConfig(), aliases: false });
}

/**
 * Wait for Enter on the terminal, once. Returns a cancel function; stdin is released either way, so it never holds
 * the process open.
 * @param {() => void} onEnter
 * @param {NodeJS.ReadStream} [stdin]
 * @returns {() => void}
 */
export function onceEnter(onEnter, stdin = process.stdin) {
    const done = () => {
        stdin.removeListener("data", listener);
        stdin.pause();
    };
    const listener = () => {
        done();
        onEnter();
    };
    stdin.on("data", listener);
    stdin.resume();
    return done;
}

/**
 * Run a QR login to the end.
 * @param {object} p
 * @param {string|null} [p.proxy]
 * @param {boolean} [p.jsonMode] - print events as JSON lines
 * @param {number} [p.qrPort] - the page's first port
 * @param {boolean} [p.qrUrl] - offer the page to the LAN (--qr-url)
 * @param {string|null} [p.publicUrl] - the validated public address (resolvePublicUrl): the page is also at the
 *   one-time link `<publicUrl>/zalo/qr/<token>`, which is what is printed
 * @param {import("../utils/qr-http-server.js").QrPage} [p.qrPage] - the process's QR page; when an HTTP server
 *   already serves it (`mcp start --http`, `mounted`), the login uses that server's one-time link and starts none
 * @param {boolean} [p.interactive] - someone at a terminal can ask for a new code (default: a TTY and not --json)
 * @param {Function} [p.login] - `loginWithQR`, replaceable in tests
 * @param {Function} [p.waitForEnter] - `onceEnter`, replaceable in tests
 * @param {number} [p.maxCodes]
 * @param {number} [p.askWindowMs]
 * @returns {Promise<{ownId: string, finish: (outcome: "done"|"failed", message?: string) => Promise<void>}>} `finish`
 *   tells the page how the login ended and closes it once the page has seen it; on a failure the error is thrown with
 *   a `finish` property instead.
 */
export async function runQrLogin({
    proxy = null,
    jsonMode = false,
    qrPort = 18927,
    qrUrl = false,
    publicUrl = null,
    qrPage = getQrPage(),
    interactive = !jsonMode && Boolean(process.stdin.isTTY),
    login = loginWithQR,
    waitForEnter = onceEnter,
    maxCodes = MAX_CODES,
    askWindowMs = ASK_WINDOW_MS,
} = {}) {
    let server = null;
    let codes = 0;
    let timedOut = null;
    let pending = null; // the open "ask for a new code" offer: { cancel }

    const closeOffer = () => {
        if (!pending) return;
        pending.cancel();
        pending = null;
    };
    const finish = async (outcome, message = "") => {
        closeOffer();
        noteQrOutcome(outcome, message);
        if (server) await server.finish();
        server = null;
    };

    const openPage = () => {
        if (!qrPage.mounted) {
            return startQrServer(getQRPath(), qrPort, [qrPort, 8080, 3000, 9000], qrUrl, { publicUrl, qrPage });
        }
        // Served by the MCP HTTP server already: its one-time link, built from publicUrl or its local address.
        const link = qrPage.open({ qrImagePath: getQRPath() });
        if (jsonMode) {
            console.log(JSON.stringify({ event: "qr_page", url: link.url, imageUrl: link.imageUrl }));
        } else {
            info(`QR available at: ${link.url} (this login only)`);
        }
        // Its finish ends the link once the page has read how the login ended.
        return link;
    };

    const onEvent = (event) => {
        switch (event.type) {
            case QR_EVENT.QR_GENERATED:
                closeOffer();
                codes++;
                displayQR(event);
                // The QR is a login token, so the page binds loopback unless --qr-url asks for the LAN.
                if (!server) server = openPage();
                // The one-time link lives as long as a code is on screen.
                else qrPage.extend(QR_LINK_TTL_MS);
                break;

            case QR_EVENT.QR_SCANNED: {
                // What Zalo Web shows the moment the phone scans: the account's name.
                const name = event.data?.display_name || "unknown";
                noteQrScanned(event.data?.display_name || "");
                if (jsonMode) {
                    console.log(JSON.stringify({ event: "qr_scanned", name, avatar: event.data?.avatar || null }));
                } else {
                    info(`Scanned by ${name} — confirm on your phone to finish logging in.`);
                    if (event.data?.avatar) info(`Avatar: ${event.data.avatar}`);
                }
                break;
            }

            case QR_EVENT.QR_DECLINED:
                // The login rejects right after this; this is the immediate heads-up.
                if (jsonMode) console.log(JSON.stringify({ event: "qr_declined" }));
                else warning("Login declined on phone.");
                break;

            case QR_EVENT.QR_EXPIRED:
                onExpired(event.actions);
                break;

            default:
                break;
        }
    };

    // A callback login never replaces an expired code by itself: without an answer here it would wait forever.
    const onExpired = (actions) => {
        const retry = () => actions?.retry?.();
        const giveUp = (message) => {
            timedOut = message;
            actions?.abort?.();
        };
        if (jsonMode)
            console.log(JSON.stringify({ event: "qr_expired", codes, maxCodes: interactive ? null : maxCodes }));

        if (!interactive) {
            if (codes >= maxCodes) {
                giveUp(`the QR code expired ${codes} times without a scan. Run the login again.`);
                return;
            }
            if (!jsonMode) info(`QR expired — generating a new one (${codes + 1} of ${maxCodes})...`);
            retry();
            return;
        }

        // As on Zalo Web: wait for someone to ask, from the page or the terminal, and only for so long.
        let used = false;
        const once = () => {
            if (used) return;
            used = true;
            closeOffer();
            retry();
        };
        const stopEnter = waitForEnter(once);
        const timer = setTimeout(() => {
            if (used) return;
            used = true;
            closeOffer();
            noteQrExpired(null);
            giveUp(
                `the QR code expired and no new one was asked for within ${Math.round(askWindowMs / 60_000)} minutes. Run the login again.`,
            );
        }, askWindowMs);
        pending = {
            cancel: () => {
                clearTimeout(timer);
                stopEnter();
            },
        };
        noteQrExpired(once);
        qrPage.extend(askWindowMs);
        info('QR expired. Press Enter for a new one, or click "Get a new code" on the QR page.');
    };

    try {
        const { ownId } = await login(proxy, onEvent);
        closeOffer();
        return { ownId, finish };
    } catch (e) {
        closeOffer();
        const err = timedOut ? new QrLoginTimedOut(`Login timed out: ${timedOut}`) : e;
        err.finish = finish;
        throw err;
    }
}
