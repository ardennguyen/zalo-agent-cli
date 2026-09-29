/**
 * Coverage bookkeeping for a long-running Zalo socket.
 *
 * `listen` and `mcp start` are two entry points to the SAME socket, so any
 * asymmetry between them is a defect rather than a difference. They had one:
 * `listen` tracked coverage gaps and `mcp start` did not track anything at all.
 * An agent-driven install that only ever ran `mcp start` therefore had zero loss
 * detection, and because `mcp start` never wrote `lastConnectedAt`, a later
 * `listen` computed its startup gap from whenever *listen* had last run and
 * filed a bogus one clamped to 14 days over a window that was fully covered.
 *
 * This module is the single definition of that bookkeeping. It owns the state
 * and the rules; the caller owns the printing.
 *
 * What the rules are, and why:
 *
 * - **Down-ness is observed, never inferred from a counter.** A drop reaches us
 *   as either `disconnected` (zca-js retries internally) or `closed` (we
 *   re-login). Gap filing used to be gated on a counter incremented only in
 *   `closed`, and `closed` never fires for a code on the server's
 *   close_and_retry_codes list — which is precisely the set of *recoverable*
 *   closes. So the common path filed nothing and then asserted coverage over
 *   the outage.
 * - **First drop wins.** A socket that flaps several times before one
 *   `connected` is one outage, and the gap must span the whole of it.
 *   `noteDown()` is idempotent until the next `noteUp()`.
 * - **The heartbeat may not claim coverage while down.** `markConnected()` means
 *   "coverage is good up to now"; stamping it on a bare timer kept advancing
 *   `lastConnectedAt` through an outage, so a crash mid-drop erased it.
 * - **A deliberate stop is not a drop.** `listener.stop()` closes with 1000,
 *   which is indistinguishable from a real failure.
 */

/** How often a healthy socket re-stamps its coverage watermark. */
export const HEARTBEAT_MS = 60 * 1000;

/**
 * @param {object} opts
 * @param {import("./sync.js").SyncManager} opts.syncManager - owns the persisted watermarks
 * @param {(fromTs: number, reason: string) => boolean} opts.reportGap - files and announces a gap;
 *   returns whether one was actually filed, exactly as listen.js's reportGap does
 * @returns {{noteDown: () => void, noteUp: () => void, heartbeat: () => void,
 *   setStopping: () => void, isStopping: () => boolean, isDown: () => boolean}}
 */
export function createGapTracker({ syncManager, reportGap }) {
    let downSince = null;
    let stopping = false;
    let lastHeartbeatAt = 0;

    return {
        /** A drop was observed. Idempotent until the next noteUp(). */
        noteDown() {
            if (stopping) return;
            if (downSince === null) downSince = Date.now();
            syncManager.markDisconnected();
        },

        /** The socket is up. Files the outage window, if there was one, BEFORE claiming coverage. */
        noteUp() {
            if (stopping) return;
            if (downSince !== null) {
                reportGap(downSince, "reconnect-gap");
                downSince = null;
            }
            syncManager.markConnected();
        },

        /** Re-stamp the coverage watermark, but only while actually connected. */
        heartbeat() {
            if (stopping || downSince !== null) return;
            const now = Date.now();
            if (now - lastHeartbeatAt < HEARTBEAT_MS) return;
            lastHeartbeatAt = now;
            syncManager.markConnected();
        },

        /** Called first on shutdown, so a deliberate close is not mistaken for a drop. */
        setStopping() {
            stopping = true;
        },

        isStopping() {
            return stopping;
        },

        isDown() {
            return downSince !== null;
        },
    };
}
