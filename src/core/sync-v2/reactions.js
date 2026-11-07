/**
 * The reaction backlog (cmd 610/611), stored in this account's cache.
 *
 * The request and its paging are the protocol layer's (src/zalo/listener/reactions.js); this module hands it the
 * live-store writer, so every reaction the backlog returns lands in zalo.db the way a live one does.
 */

import { drainReactionBacklog, DEFAULT_MAX_PAGES, DEFAULT_TIMEOUT_MS } from "../../zalo/listener/reactions.js";
import { storeLiveReaction } from "../live-store.js";

export { DEFAULT_MAX_PAGES, DEFAULT_TIMEOUT_MS };

/** One backlog reaction into the cache. */
const storeBacklogReaction = (r) => storeLiveReaction(r, { source: "backlog" });

/**
 * Drain the reaction backlog for both thread types and store what comes back.
 *
 * The caller owns the socket: it must hold `daemon.lock`, start the listener and stop it afterwards. Options and
 * result are those of `drainReactionBacklog` (src/zalo/listener/reactions.js), without `store`.
 *
 * @param {object} opts
 * @returns {Promise<{pages: number, received: number, stored: number, changed: number,
 *   skippedRemovals: number, byType: object, truncated: boolean, unresolved: object[]}>}
 */
export function drainReactions(opts = {}) {
    return drainReactionBacklog({ ...opts, store: storeBacklogReaction });
}

/**
 * Replay reactions the drain could not place when they arrived.
 *
 * `drainReactions` hands these back rather than dropping them: the backlog
 * reaches further back than a windowed restore, so a reaction's target message
 * may only be written after the drain saw it. A caller that has since stored
 * more messages — `zalo-agent sync`, which restores before it drains — replays
 * them through here.
 *
 * This WRITES, so it belongs in whichever process owns the db: the CLI when it
 * holds the socket itself, the daemon when the stage runs through its channel.
 * Shared so the two paths cannot drift.
 *
 * @param {object[]} [unresolved] - `drainReactions()` stats.unresolved
 * @returns {number} how many were placed this time
 */
export function placeUnresolvedReactions(unresolved = []) {
    let placed = 0;
    for (const r of unresolved || []) {
        if (storeBacklogReaction(r).stored) placed++;
    }
    return placed;
}
