/**
 * Retrieve existing reactions from Zalo's server over the socket.
 *
 * Reactions are the one thing a transfer sync cannot restore — the Sync2
 * payload has no reaction field — which this project long read as "a reaction
 * not captured live is gone for good". That conclusion was wrong: Zalo Web
 * fetches them over the SAME socket with cmd 610 (1-1) and cmd 611 (group),
 * and fires both within ~1.4s of every connect (see the boot capture in
 * agent/work/transfer-sync-v2). Measured live on a real account, one request
 * pair returned 28 DM and 50 group reactions with full detail — target msgId,
 * icon, rType and the reacting user — while the local cache held one row.
 *
 * zca-js already speaks the request (`listener.requestOldReactions`) and emits
 * the objects (`old_reactions`), so no patch is needed. Two things it does not
 * do, which is why this module exists:
 *
 *  1. It surfaces neither `lastActionId` nor `more`, so a caller using only the
 *     event gets exactly one page and cannot tell whether more exist. The
 *     server said `more: 1` for groups on the very first probe. We read those
 *     fields off the raw socket, the same way SyncV2 taps cmd 601.
 *  2. Its old-reactions handler omits the `JSON.parse(content)` its live
 *     handler performs, so `content` arrives as a string.
 *     `storeLiveReaction` absorbs both forms.
 */

import { decodeFrame } from "./index.js";
import { storeLiveReaction } from "../live-store.js";

/** zca-js ThreadType values. */
const THREAD_USER = 0;
const THREAD_GROUP = 1;

/** Socket commands carrying the reaction backlog. */
const CMD_DM = 610;
const CMD_GROUP = 611;

/** Default per-request deadline. A queue that has nothing to say says nothing. */
export const DEFAULT_TIMEOUT_MS = 15000;

/** Pages per thread type. The server pages with `more`; this is the runaway stop. */
export const DEFAULT_MAX_PAGES = 20;

/**
 * Drain the reaction backlog for both thread types and store what comes back.
 *
 * The caller owns the socket: it must hold `daemon.lock`, start the listener
 * and stop it afterwards — same contract as {@link backfillOverSocket}.
 *
 * @param {object} opts
 * @param {import("zca-js").Listener} opts.listener - a started zca-js listener
 * @param {number} [opts.timeoutMs=15000] - per-page deadline
 * @param {number} [opts.maxPages=20] - cap per thread type
 * @param {boolean} [opts.applyRemovals=true] - apply backlog entries with an empty
 *   icon (un-reacts). ON by default, because the backlog is an ordered ACTION
 *   LOG, not a snapshot of current state: it replays adds and removals in
 *   sequence, so skipping the removals leaves reactions the user already took
 *   off. Measured — one message came back with four reaction events where the
 *   app showed one; replaying in order reproduced the one.
 * @param {(p: object) => void} [opts.onProgress]
 * @returns {Promise<{pages: number, received: number, stored: number, changed: number,
 *   skippedRemovals: number, byType: object, truncated: boolean}>}
 */
export async function drainReactions(opts = {}) {
    const {
        listener,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxPages = DEFAULT_MAX_PAGES,
        applyRemovals = true,
        onProgress = () => {},
    } = opts;
    if (!listener) throw new Error("drainReactions needs a started listener");

    const stats = {
        pages: 0,
        received: 0,
        stored: 0,
        changed: 0,
        skippedRemovals: 0,
        byType: { dm: 0, group: 0 },
        truncated: false,
    };

    // The raw tap is the only place `more` and `lastActionId` exist. Without it
    // a drain stops after one page and reports success.
    const envelopes = [];
    const onRaw = (buf) => {
        if (!(buf instanceof Buffer) || buf.length < 4) return;
        const cmd = buf.readUInt16LE(1);
        if (cmd !== CMD_DM && cmd !== CMD_GROUP) return;
        try {
            const parsed = JSON.parse(buf.subarray(4).toString("utf8"));
            if (typeof parsed.data !== "string") return;
            // decodeFrame is the repo's own mirror of zca-js's decodeEventData;
            // the library does not export its internals.
            const data = decodeFrame(parsed, listener.cipherKey)?.data;
            envelopes.push({ cmd, lastActionId: data?.lastActionId, more: Number(data?.more) || 0 });
        } catch {
            /* a frame we cannot read is not a frame we need */
        }
    };

    /** One request/response round for a thread type. */
    const page = (threadType, anchor) =>
        new Promise((resolve) => {
            const cmd = threadType === THREAD_USER ? CMD_DM : CMD_GROUP;
            let settled = false;
            const before = envelopes.length;

            const finish = (objs) => {
                if (settled) return;
                settled = true;
                listener.removeListener("old_reactions", handler);
                clearTimeout(timer);
                // Match the envelope to this round by command.
                const env = envelopes.slice(before).find((e) => e.cmd === cmd) || {};
                resolve({ objs, more: env.more || 0, lastActionId: env.lastActionId });
            };

            const handler = (objs, isGroup) => {
                const want = threadType === THREAD_GROUP;
                if (isGroup !== want) return; // the other type's answer
                // The envelope can land after the event; give it a tick.
                setTimeout(() => finish(objs || []), 50);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);

            listener.on("old_reactions", handler);
            try {
                listener.requestOldReactions(threadType, anchor ?? null);
            } catch (e) {
                onProgress({ phase: "warn", detail: `request failed: ${e.message}` });
                finish(null);
            }
        });

    listener.ws?.on("message", onRaw);
    try {
        for (const threadType of [THREAD_USER, THREAD_GROUP]) {
            const label = threadType === THREAD_USER ? "dm" : "group";
            let anchor = null;
            for (let p = 0; p < maxPages; p++) {
                const { objs, more, lastActionId } = await page(threadType, anchor);
                if (objs === null) {
                    onProgress({ phase: "timeout", type: label, detail: `no answer within ${timeoutMs}ms` });
                    break;
                }
                stats.pages++;
                stats.received += objs.length;
                for (const r of objs) {
                    const icon = reactionIcon(r);
                    if (!icon && !applyRemovals) {
                        stats.skippedRemovals++;
                        continue;
                    }
                    const res = storeLiveReaction(r);
                    if (res.stored) {
                        stats.stored++;
                        stats.changed += res.changed || 0;
                        stats.byType[label]++;
                    }
                }
                onProgress({
                    phase: "page",
                    type: label,
                    page: p + 1,
                    received: objs.length,
                    stored: stats.stored,
                    more,
                });
                // `more` is the server's own "there is another page"; without a
                // fresh anchor we would re-request the same one forever.
                if (!more || !lastActionId || String(lastActionId) === String(anchor)) break;
                anchor = String(lastActionId);
                if (p === maxPages - 1) stats.truncated = true;
            }
        }
    } finally {
        try {
            listener.ws?.off?.("message", onRaw);
        } catch {
            /* the socket may already be gone */
        }
    }

    return stats;
}

/**
 * The icon on a reaction object, whichever form its content arrived in.
 *
 * @param {object} reaction
 * @returns {string}
 */
function reactionIcon(reaction) {
    const c = reaction?.data?.content;
    if (typeof c === "string") {
        try {
            return JSON.parse(c)?.rIcon ?? "";
        } catch {
            return "";
        }
    }
    return c?.rIcon ?? "";
}
