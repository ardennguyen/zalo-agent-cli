/**
 * The Web's `sync_action` media reports (D31, research row ZP-13), built and kept unwired.
 *
 * What Zalo Web does (read in its bundle, 2026-11-06): when the person opens a media message (`onInteractMedia`), it
 * tells the `sync_action` host that this media was taken on this device, so the account's other devices can pull the
 * list (`pullSyncResource`) and fetch the same files. Each entry is `{fromUid, destId, isGroup, cmi}`: the sender (the
 * account itself for its own messages), the conversation without the group prefix, 1 for a group, and the client
 * message id as a number. Entries are de-duplicated on `fromUid_destId_cmi`, sent at most 50 per request through
 * `POST /api/sync_action/media` (`{syncList: JSON, imei}`, cmd 16213; this client's `sync-action-media` write), with a
 * trailing throttle (`syncActionMedia.submitActionThrottle`), and put back for a retry when the request fails. It runs
 * only when the server's `syncActionMedia.enable` is on and the person has automatic downloads turned on. The Web's
 * own automatic downloads report nothing: only an opened media message does.
 *
 * Why nothing calls this yet: the endpoint answers an empty list (verified), but what a non-empty list makes the
 * account's other devices do has never been captured, and this client's only "opened" media path (`zalo_view_media`)
 * downloads a whole conversation's pending media rather than one item. Until a capture of the Web opening media shows
 * the request and its effect, this module is the tested half: the entry, the gate and the batching.
 */
import { callWrite } from "../zalo/writes.js";

/** The Web's batch size. */
export const BATCH_MAX = 50;
/** The throttle used when the server names none (the paid account's setting, 2026-10-28). */
export const DEFAULT_THROTTLE_MS = 5000;

/**
 * The server's switch for these reports, from the login answer's `settings.features.syncActionMedia`.
 *
 * @param {object} api
 * @returns {{enable: boolean, throttleMs: number}} `enable` is false when the setting is missing
 */
export function syncActionSettings(api) {
    let s = null;
    try {
        s = api?.getContext?.()?.settings?.features?.syncActionMedia ?? null;
    } catch {
        s = null;
    }
    const throttle = Number(s?.submitActionThrottle);
    return {
        enable: Boolean(s) && Number(s.enable) === 1,
        throttleMs: Number.isFinite(throttle) && throttle > 0 ? throttle : DEFAULT_THROTTLE_MS,
    };
}

/**
 * One report entry, as the Web builds it (`convertMediaDataToSubmit`).
 *
 * @param {{threadId: string, isGroup: boolean, senderId?: string|null, cliMsgId: string|number}} msg
 * @param {string} ownId - stands in for the sender of the account's own messages
 * @returns {{fromUid: string, destId: string, isGroup: 0|1, cmi: number}|null} null without a usable client message id
 *   or conversation
 */
export function syncActionItem(msg, ownId) {
    const cmi = Number.parseInt(String(msg?.cliMsgId ?? ""), 10);
    if (!Number.isFinite(cmi) || cmi <= 0) return null;
    let destId = String(msg?.threadId ?? "");
    if (!destId) return null;
    if (msg.isGroup && destId.startsWith("g")) destId = destId.slice(1);
    const sender = msg.senderId === undefined || msg.senderId === null ? "0" : String(msg.senderId);
    return {
        fromUid: sender !== "0" && sender !== "" ? sender : String(ownId),
        destId,
        isGroup: msg.isGroup ? 1 : 0,
        cmi,
    };
}

const keyOf = (e) => `${e.fromUid}_${e.destId}_${e.cmi}`;

/**
 * A batching reporter: entries are queued (de-duplicated), and sent at most {@link BATCH_MAX} per request once
 * `throttleMs` has passed since the last entry was added. A failed request puts its entries back and is tried again
 * after `retryMs`, once at a time.
 *
 * @param {object} args
 * @param {(items: object[]) => Promise<unknown>} args.submit - sends one batch
 * @param {number} [args.throttleMs]
 * @param {number} [args.retryMs=30000]
 * @param {() => boolean} [args.enabled] - checked before every request; false keeps the queue and sends nothing
 * @param {(line: string) => void} [args.log]
 * @param {typeof setTimeout} [args.setTimer]
 * @param {typeof clearTimeout} [args.clearTimer]
 * @returns {{add: (items: object[]) => number, flush: () => Promise<number>, pending: () => number, stop: () => void}}
 *   `add` returns how many entries were new; `flush` sends everything queued now and returns how many were sent
 */
export function createSyncActionReporter({
    submit,
    throttleMs = DEFAULT_THROTTLE_MS,
    retryMs = 30000,
    enabled = () => true,
    log = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    const queue = [];
    const keys = new Set();
    let timer = null;
    let sending = null;

    const schedule = (ms) => {
        if (timer) clearTimer(timer);
        timer = setTimer(() => {
            timer = null;
            void flush();
        }, ms);
        timer?.unref?.();
    };

    async function sendOne() {
        const batch = queue.splice(0, BATCH_MAX);
        for (const e of batch) keys.delete(keyOf(e));
        try {
            await submit(batch);
            return batch.length;
        } catch (e) {
            add(batch, { quiet: true });
            try {
                log(`sync_action: a report of ${batch.length} item(s) failed (${e?.message || e}); retrying later`);
            } catch {
                /* a broken logger changes nothing */
            }
            schedule(retryMs);
            return -1;
        }
    }

    async function flush() {
        if (sending) return sending;
        sending = (async () => {
            let sent = 0;
            try {
                if (!enabled()) return 0;
                while (queue.length) {
                    const n = await sendOne();
                    if (n < 0) break;
                    sent += n;
                }
            } finally {
                sending = null;
            }
            return sent;
        })();
        return sending;
    }

    function add(items, { quiet = false } = {}) {
        let fresh = 0;
        for (const e of Array.isArray(items) ? items : []) {
            if (!e) continue;
            const k = keyOf(e);
            if (keys.has(k)) continue;
            keys.add(k);
            queue.push(e);
            fresh++;
        }
        if (fresh && !quiet) schedule(throttleMs);
        return fresh;
    }

    return {
        add: (items) => add(items),
        flush,
        pending: () => queue.length,
        stop() {
            if (timer) clearTimer(timer);
            timer = null;
        },
    };
}

/**
 * The `submit` that sends a batch through this client's `sync-action-media` write.
 *
 * @param {object} api
 * @returns {(items: object[]) => Promise<unknown>}
 */
export function submitThrough(api) {
    return (items) => callWrite(api, "sync-action-media", { actions: items });
}
