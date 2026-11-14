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
 *   as either `disconnected` (the supervisor retries) or `closed` (we
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
 * A parked window (on-demand presence, ./presence.js): planned, not a drop. Self-heal closes it on the next handshake
 * from Zalo's offline queue; nothing alarms on it.
 */
export const IDLE_GAP_REASON = "idle";

/** What a parked window becomes when the offline queue no longer holds all of it: a real gap, alarmed on. */
export const IDLE_EVICTED_REASON = "idle-evicted";

/** The sync_state key holding when the socket was last parked (ms). */
export const PARKED_AT_KEY = "presenceParkedAt";

/**
 * Whether a pending gap is one to warn about: every gap but a planned idle window.
 *
 * @param {{reason?: string}} gap
 * @returns {boolean}
 */
export const isAlarmingGap = (gap) => String(gap?.reason ?? "") !== IDLE_GAP_REASON;

/**
 * How many pending gaps are worth a warning (health, `fleet status`): planned idle windows are not.
 *
 * @param {Array<{reason?: string}>} gaps
 * @returns {number}
 */
export function alarmingGapCount(gaps) {
    return (gaps ?? []).filter(isAlarmingGap).length;
}

/**
 * The reason for the start-up gap: a crash or stop while parked left `lastConnectedAt` at the park stamp, and that
 * window is a planned one.
 *
 * @param {{lastConnectedAt: number|null, parkedAt: number|null}} s
 * @returns {"idle"|"startup-gap"}
 */
export function startupGapReason({ lastConnectedAt, parkedAt }) {
    return parkedAt && lastConnectedAt && Number(parkedAt) === Number(lastConnectedAt)
        ? IDLE_GAP_REASON
        : "startup-gap";
}

/**
 * @param {object} opts
 * @param {import("./sync.js").SyncManager} opts.syncManager - owns the persisted watermarks
 * @param {(fromTs: number, reason: string) => boolean} opts.reportGap - files and announces a gap;
 *   returns whether one was actually filed, exactly as listen.js's reportGap does
 * @param {(key: string, value: unknown) => void} [opts.setState] - sync_state writer (the park stamp)
 * @param {(key: string) => void} [opts.deleteState] - sync_state remover
 * @param {() => number} [opts.now]
 * @returns {{noteDown: () => void, noteUp: () => void, heartbeat: () => void,
 *   setStopping: () => void, isStopping: () => boolean, isDown: () => boolean,
 *   noteParking: () => void, noteWake: () => void, isParked: () => boolean}}
 */
export function createGapTracker({ syncManager, reportGap, setState, deleteState, now = Date.now }) {
    let downSince = null;
    let stopping = false;
    let lastHeartbeatAt = 0;
    // On-demand presence: the socket was closed on purpose at this time; the window until the wake is planned.
    let parkedAt = null;

    return {
        /** A drop was observed. Idempotent until the next noteUp(). A close while parking or parked is not one. */
        noteDown() {
            if (stopping || parkedAt !== null) return;
            if (downSince === null) downSince = now();
            syncManager.markDisconnected();
        },

        /** The socket is up. Files the outage window, if there was one, BEFORE claiming coverage. */
        noteUp() {
            if (stopping) return;
            // An up without a noteWake() (a wake the daemon did not announce): the parked window is still filed.
            if (parkedAt !== null) this.noteWake();
            if (downSince !== null) {
                reportGap(downSince, "reconnect-gap");
                downSince = null;
            }
            syncManager.markConnected();
        },

        /**
         * The socket is about to be parked: coverage is good up to now, and the coming close (1000, requested) is
         * planned. Called before the supervisor stops, as setStopping() is before a shutdown.
         */
        noteParking() {
            if (stopping) return;
            // A drop that was still open when the park began is filed now: the parked window must not swallow it.
            if (downSince !== null) {
                reportGap(downSince, "reconnect-gap");
                downSince = null;
            }
            parkedAt = now();
            syncManager.markConnected();
            try {
                setState?.(PARKED_AT_KEY, syncManager.getLastConnectedAt?.() ?? parkedAt);
            } catch {
                /* the stamp only names the reason of a later start-up gap */
            }
        },

        /**
         * A wake is starting: the parked window is filed as a planned gap (`idle`), which the handshake's self-heal
         * closes where Zalo's offline queue still covers it. noteUp() then claims coverage as usual.
         */
        noteWake() {
            if (stopping || parkedAt === null) return;
            const from = parkedAt;
            parkedAt = null;
            reportGap(from, IDLE_GAP_REASON);
            try {
                deleteState?.(PARKED_AT_KEY);
            } catch {
                /* see noteParking */
            }
        },

        isParked() {
            return parkedAt !== null;
        },

        /** Re-stamp the coverage watermark, but only while actually connected. */
        heartbeat() {
            if (stopping || downSince !== null || parkedAt !== null) return;
            const t = now();
            if (t - lastHeartbeatAt < HEARTBEAT_MS) return;
            lastHeartbeatAt = t;
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
