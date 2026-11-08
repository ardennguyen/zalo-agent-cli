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
import { nextReqId } from "../../zalo/req-id.js";
import { controlQueuesFrom } from "../../zalo/queues/offline-queue.js";
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

/** The control queues to read when the handshake names none: what every handshake seen so far named. */
export const DEFAULT_CONTROL_QUEUES = Object.freeze([
    Object.freeze({ cmd: 603, subCmd: 1, queueName: "603_1" }),
    Object.freeze({ cmd: 603, subCmd: 0, queueName: "603_0" }),
]);

/** Pages read from a saved cursor, and from the start of a queue (50 controls a page). */
const CURSOR_PAGES = 20;
const START_PAGES = 40;

/**
 * Ask a control queue for one page and wait for its answer: the answer to this request (by `reqId`), or one that
 * carries no `reqId` at all. Nothing else reads the control queue while a login looks at it.
 *
 * @returns {Promise<object|null>} the answer's body, or null when none came in `timeoutMs`
 */
function askPage(listener, tap, queue, data, timeoutMs) {
    return new Promise((resolve) => {
        let off = () => {};
        const timer = setTimeout(() => {
            off();
            resolve(null);
        }, timeoutMs);
        off = tap.on(queue.cmd, (frame) => {
            if (frame.subCmd !== queue.subCmd) return;
            const reqId = frame.data?.reqId;
            if (reqId !== undefined && reqId !== null && String(reqId) !== data.reqId) return;
            clearTimeout(timer);
            off();
            resolve(frame.body || {});
        });
        try {
            listener.sendWs({ version: 1, cmd: queue.cmd, subCmd: queue.subCmd, data });
        } catch {
            clearTimeout(timer);
            off();
            resolve(null);
        }
    });
}

/**
 * Read one control queue from a cursor (or from its start: `lastId` null), page by page while the server says
 * `more`, as Zalo Web's `doGetOffline` / `onGotOffline` do. The pages reach the caller through the tap; this only
 * drives the paging. It moves no saved cursor and acknowledges nothing (a read does not consume a control).
 *
 * @returns {Promise<{pages: number, reason: "drained"|"found"|"timeout"|"stalled"|"page-cap"|"reset"|"error"}>}
 */
async function readControlQueue({ listener, tap, queue, lastId, maxPages, pageTimeoutMs, found }) {
    let cursor = lastId === null || lastId === undefined ? null : String(lastId);
    let first = true;
    let pages = 0;
    while (pages < maxPages) {
        const data = { first, reqId: nextReqId(), lastId: cursor, preIds: [] };
        const body = await askPage(listener, tap, queue, data, pageTimeoutMs);
        if (!body) return { pages, reason: "timeout" };
        pages++;
        if (Number(body.error_code)) return { pages, reason: "error" };
        const d = body.data || {};
        const reset = d.resetLastActionId;
        if (reset !== undefined && reset !== null && reset !== "" && reset !== 0 && reset !== "0") {
            return { pages, reason: "reset" };
        }
        if (found()) return { pages, reason: "found" };
        if (!Number(d.more)) return { pages, reason: "drained" };
        const next = d.lastActionId;
        // A cursor that does not move would ask for the same page forever.
        if (next === undefined || next === null || String(next) === cursor) return { pages, reason: "stalled" };
        cursor = String(next);
        first = false;
    }
    return { pages, reason: "page-cap" };
}

/**
 * What `login --verbose` shows of each control seen while looking for the offer: its queue, act type, act, `pc`,
 * whether it carries a key, and its age. Never the key itself.
 *
 * @param {Array<{queue: string, control: object}>} entries - in the order they arrived
 * @param {number} now
 * @returns {Array<{queue: string, actionId: string|null, actType: string|null, act: string|null, pc: unknown,
 *   hasKey: boolean, ageMs: number|null}>} one per distinct control (by queue and action id)
 */
export function describeLoginControls(entries, now) {
    const out = [];
    const seen = new Set();
    for (const { queue, control } of Array.isArray(entries) ? entries : []) {
        const content = control?.content;
        if (!content || typeof content !== "object") continue;
        const rawId = control.actionId ?? control.controlId ?? null;
        const actionId = rawId === null || rawId === undefined ? null : String(rawId);
        if (actionId !== null) {
            const id = `${queue}:${actionId}`;
            if (seen.has(id)) continue;
            seen.add(id);
        }
        let data = content.data;
        if (typeof data === "string") {
            try {
                data = JSON.parse(data);
            } catch {
                data = null;
            }
        }
        const ts = Number(content.ts);
        out.push({
            queue,
            actionId,
            actType: typeof content.act_type === "string" ? content.act_type : null,
            act: typeof content.act === "string" ? content.act : null,
            pc: data && typeof data === "object" && "pc" in data ? data.pc : null,
            hasKey: typeof data?.temp_key === "string" && data.temp_key !== "",
            ageMs: Number.isFinite(ts) && ts > 0 ? now - ts : null,
        });
    }
    return out;
}

/**
 * Open the socket of a fresh login, read the key the phone offered, and restore with it.
 *
 * Where the offer is: the phone puts it in the control queues at the QR confirmation, before this socket exists, so
 * it is read from the queues (a live `601` push is taken too, if one comes). A QR re-login that keeps the device id
 * (src/zalo/qr-login.js `deviceImeiFor`) keeps the control queue with everything it held, so the offer is at its END.
 * Each queue is therefore read the way Zalo Web reads it: from the cursor this account saved (`cursorOf`, the one
 * `listen` keeps), page by page while the server says `more`; a queue with no saved cursor, or one the cursor did not
 * find it in, is read from its start the same way. (A single page asked without a cursor found the offer while every
 * QR login made a new device; on a kept device that page is the oldest one, and the offer was never seen.)
 *
 * @param {object} api - a logged-in session
 * @param {string} ownId
 * @param {object} [opts]
 * @param {number|null} [opts.days] - restrict the restore to the last N days (default: full history)
 * @param {number} [opts.waitMs] - the restore's wait budget
 * @param {(e: {phase: string, detail?: string}) => void} [opts.onStatus]
 * @param {number} [opts.connectTimeoutMs]
 * @param {number} [opts.authWaitMs] - how long to wait for the handshake that names the control queues
 * @param {number} [opts.pageTimeoutMs] - how long one page is given to answer (a cold control queue once took more
 *   than 10 s, live)
 * @param {number} [opts.pullWaitMs] - a last wait for a live push when the queues held no offer
 * @param {(queueName: string) => (string|{id: string}|null)} [opts.cursorOf] - the saved cursor of a control queue
 * @param {(o: object) => Promise<object>} [opts.restore] - the restore, replaceable in a test
 * @param {boolean} [opts.restoreWhenTicked=true] - false only reports what the phone offered (`login --no-sync`)
 * @param {() => number} [opts.now]
 * @returns {Promise<{offered: boolean, status: "ticked"|"late"|"other-client"|"none"|"no-socket", ageMs?: number,
 *   reason?: string, result?: object, controls?: ReturnType<typeof describeLoginControls>,
 *   pulls?: Array<{queue: string, from: "cursor"|"start", pages: number, reason: string}>}>} `offered` true when a
 *   restore ran with the phone's key; `status` says what the phone offered (`no-socket`: the socket could not be
 *   opened, so nothing is known); `controls` and `pulls` say what was seen and asked (`login --verbose`)
 */
export async function autoSyncAfterLogin(
    api,
    ownId,
    {
        days = null,
        waitMs,
        onStatus = () => {},
        connectTimeoutMs = 30_000,
        authWaitMs = 5000,
        pageTimeoutMs = 15_000,
        pullWaitMs = 1500,
        cursorOf = () => null,
        restore = (o) => new SyncV2(api, ownId).restore(o),
        restoreWhenTicked = true,
        now = () => Date.now(),
    } = {},
) {
    const tap = createSocketTap();
    tap.attach(api.listener);
    const entries = [];
    const collect = (frame) => {
        const queue = `${frame.cmd}_${frame.subCmd}`;
        for (const control of frame.data?.controls ?? []) entries.push({ queue, control });
    };
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
    const pulls = [];
    try {
        const read = () =>
            classifyLoginOffer(
                entries.map((e) => e.control),
                { now: now() },
            );
        const ticked = () => read().status === "ticked";
        // The handshake names the control queues (`ctrl_qCmds`); a request sent before it waits for it anyway.
        for (let waited = 0; !tap.auth() && waited < authWaitMs; waited += 50) {
            await new Promise((r) => setTimeout(r, 50));
        }
        const named = controlQueuesFrom(tap.auth()?.ctrl_qCmds);
        const queues = named.length ? named : DEFAULT_CONTROL_QUEUES;
        for (const queue of queues) {
            if (ticked()) break;
            let saved = null;
            try {
                const c = cursorOf(queue.queueName);
                saved = typeof c === "string" ? c : (c?.id ?? null);
            } catch {
                saved = null;
            }
            const plan = [["start", null, START_PAGES]];
            if (saved) plan.unshift(["cursor", saved, CURSOR_PAGES]);
            for (const [from, lastId, maxPages] of plan) {
                if (ticked()) break;
                const r = await readControlQueue({
                    listener: api.listener,
                    tap,
                    queue,
                    lastId,
                    maxPages,
                    pageTimeoutMs,
                    found: ticked,
                });
                pulls.push({ queue: queue.queueName, from, pages: r.pages, reason: r.reason });
            }
        }
        if (!ticked()) await new Promise((r) => setTimeout(r, pullWaitMs));
        const offer = read();
        const diag = { controls: describeLoginControls(entries, now()), pulls };
        if (offer.status !== "ticked") {
            const reason = {
                late: `the phone offered auto sync ${Math.round((offer.ageMs ?? 0) / 1000)} s ago, too long ago to use without a tap`,
                "other-client": "the phone's auto sync offer was for the Zalo PC app, not this client",
                none: "auto sync was not ticked on the phone at the QR confirmation",
            }[offer.status];
            return { offered: false, status: offer.status, ageMs: offer.ageMs, reason, ...diag };
        }
        if (!restoreWhenTicked) {
            return {
                offered: false,
                status: "ticked",
                ageMs: offer.ageMs,
                reason: "auto sync was ticked on the phone, and declined here (--no-sync)",
                ...diag,
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
        return { offered: true, status: "ticked", ageMs: offer.ageMs, result, ...diag };
    } finally {
        try {
            api.listener.stop();
        } catch {
            /* already closed */
        }
    }
}
