/**
 * Auto sync after a QR login (plan item Y8).
 *
 * When the person ticks "auto sync" on the phone while confirming a QR login, the phone puts a
 * `transfer_sync2 / transfer_after_login` control in the account's control queue, `{temp_key, imei, pc}`. Zalo Web
 * takes the latest one of those that is for the web (`pc` 0) and has a key, and sends the key as `tempKey` in its
 * conversation request: the phone then does not ask for a tap (measured live, 2026-10-26: the request went out 15
 * seconds after the login and the phone showed no prompt; a key 765 seconds old got the prompt as usual).
 *
 * `zalo-agent login` always looks for that control after a QR login and says whether the box was ticked. The tick IS
 * the person's consent, given on the phone at the login itself, so a ticked offer is restored at once with its key, as
 * Zalo Web does (`--no-sync` declines; `--sync` is the older spelling of the default). This is the only restore that
 * starts without a `sync` someone typed, and it never runs in a daemon (AGENTS.md section 13). The key is short-lived,
 * so it is read from the control queue the moment the socket is up.
 */
import { createSocketTap } from "../../zalo/listener/socket-tap.js";
import { buildPull } from "../../zalo/pulls.js";
import { SyncV2 } from "./index.js";

/** The control that carries the key. */
export const TRANSFER_AFTER_LOGIN = "transfer_after_login";

/** A key older than this is not used: the phone stops honoring it long before 765 s. */
export const AUTO_SYNC_MAX_AGE_MS = 120_000;

/** `pc` of a control meant for the web client (the PC app is 1). */
const FOR_WEB = 0;

/**
 * What the controls say about the phone's "sync messages to this device" box at the QR confirmation.
 *
 * - `ticked`: a `transfer_after_login` for the web (`pc` 0) with a key, recent enough to use (`tempKey`, `ageMs`).
 * - `late`: the same, but older than `maxAgeMs` (the phone asks for a tap again by then; Zalo Web drops it after 10 s).
 * - `other-client`: only offers for the PC app (`pc` not 0), which this client must not use.
 * - `none`: no offer at all: the box was not ticked.
 *
 * @param {object[]} controls - `controls[]` entries of 601/603 frames
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.maxAgeMs]
 * @returns {{status: "ticked"|"late"|"other-client"|"none", tempKey?: string, ageMs?: number}}
 */
export function classifyLoginOffer(controls, { now = Date.now(), maxAgeMs = AUTO_SYNC_MAX_AGE_MS } = {}) {
    let best = null;
    let otherClient = false;
    for (const c of Array.isArray(controls) ? controls : []) {
        const content = c?.content;
        if (content?.act !== TRANSFER_AFTER_LOGIN) continue;
        let data;
        try {
            data = typeof content.data === "string" ? JSON.parse(content.data) : content.data;
        } catch {
            continue;
        }
        if (typeof data?.temp_key !== "string" || data.temp_key === "") continue;
        const ts = Number(content.ts);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        if (data.pc !== FOR_WEB) {
            otherClient = true;
            continue;
        }
        if (!best || ts > best.ts) best = { ts, tempKey: data.temp_key };
    }
    if (!best) return { status: otherClient ? "other-client" : "none" };
    const ageMs = now - best.ts;
    return ageMs <= maxAgeMs ? { status: "ticked", tempKey: best.tempKey, ageMs } : { status: "late", ageMs };
}

/**
 * Zalo Web's own rule for which control to use: the latest `transfer_after_login` whose data has a key and is for the
 * web, and (Web: within 10 s; here, within `maxAgeMs`) recent.
 *
 * @param {object[]} controls - `controls[]` entries of 601/603 frames: `{actionId, content: {act, data, ts}}`
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.maxAgeMs]
 * @returns {{tempKey: string, ageMs: number}|null}
 */
export function pickTransferAfterLogin(controls, opts = {}) {
    const offer = classifyLoginOffer(controls, opts);
    return offer.status === "ticked" ? { tempKey: offer.tempKey, ageMs: offer.ageMs } : null;
}

/**
 * Open the socket of a fresh login, read the key the phone offered, and restore with it.
 *
 * @param {object} api - a logged-in session
 * @param {string} ownId
 * @param {object} [opts]
 * @param {number|null} [opts.days] - restrict the restore to the last N days (default: full history)
 * @param {number} [opts.waitMs] - the restore's wait budget
 * @param {(e: {phase: string, detail?: string}) => void} [opts.onStatus]
 * @param {number} [opts.connectTimeoutMs]
 * @param {number} [opts.pullWaitMs] - how long each control-queue pull is given to answer
 * @param {(o: object) => Promise<object>} [opts.restore] - the restore, replaceable in a test
 * @param {boolean} [opts.restoreWhenTicked=true] - false only reports what the phone offered (`login --no-sync`)
 * @param {() => number} [opts.now]
 * @returns {Promise<{offered: boolean, status: "ticked"|"late"|"other-client"|"none"|"no-socket", ageMs?: number,
 *   reason?: string, result?: object}>} `offered` true when a restore ran with the phone's key; `status` says what
 *   the phone offered (`no-socket`: the socket could not be opened, so nothing is known)
 */
export async function autoSyncAfterLogin(
    api,
    ownId,
    {
        days = null,
        waitMs,
        onStatus = () => {},
        connectTimeoutMs = 30_000,
        pullWaitMs = 1500,
        restore = (o) => new SyncV2(api, ownId).restore(o),
        restoreWhenTicked = true,
        now = () => Date.now(),
    } = {},
) {
    const tap = createSocketTap();
    tap.attach(api.listener);
    const controls = [];
    const collect = (frame) => controls.push(...(frame.data?.controls ?? []));
    tap.on(601, collect);
    tap.on(603, collect);
    const connected = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), connectTimeoutMs);
        api.listener.once("connected", () => {
            clearTimeout(timer);
            resolve({ ok: true });
        });
        api.listener.once("error", (e) => {
            clearTimeout(timer);
            resolve({ ok: false, reason: e?.message || "socket error" });
        });
        api.listener.start({ retryOnClose: false });
    });
    if (!connected.ok) {
        return { offered: false, status: "no-socket", reason: `could not open the socket (${connected.reason})` };
    }
    try {
        const read = () => classifyLoginOffer(controls, { now: now() });
        let offer = read();
        // The control is usually already in the queue by the time the socket is up: ask for it, both queues.
        for (const sub of [1, 0]) {
            if (offer.status === "ticked") break;
            api.listener.sendWs(buildPull(603, sub));
            await new Promise((r) => setTimeout(r, pullWaitMs));
            offer = read();
        }
        if (offer.status !== "ticked") {
            const reason = {
                late: `the phone offered auto sync ${Math.round((offer.ageMs ?? 0) / 1000)} s ago, too long ago to use without a tap`,
                "other-client": "the phone's auto sync offer was for the Zalo PC app, not this client",
                none: "auto sync was not ticked on the phone at the QR confirmation",
            }[offer.status];
            return { offered: false, status: offer.status, ageMs: offer.ageMs, reason };
        }
        if (!restoreWhenTicked) {
            return {
                offered: false,
                status: "ticked",
                ageMs: offer.ageMs,
                reason: "auto sync was ticked on the phone, and declined here (--no-sync)",
            };
        }
        onStatus({
            phase: "info",
            detail: `the phone offered auto sync ${(offer.ageMs / 1000).toFixed(0)} s ago; using its key, no tap needed`,
        });
        const result = await restore({
            days,
            tempKey: offer.tempKey,
            waitMs,
            onStatus,
            keepAlive: true,
        });
        return { offered: true, status: "ticked", ageMs: offer.ageMs, result };
    } finally {
        try {
            api.listener.stop();
        } catch {
            /* already closed */
        }
    }
}
