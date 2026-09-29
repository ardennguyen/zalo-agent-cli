/**
 * What to tell the owner about a coverage gap the `listen` daemon just recorded.
 *
 * A gap is a window the daemon was not connected for, so whatever arrived in it
 * is missing from zalo.db. The daemon used to "attempt a mobile-sync backfill"
 * itself, over `pullMobileMsg`/`getCrossDB` — endpoints Zalo retired (MEASURED
 * 2026-09-20: still in Zalo Web's bundle, ZERO call sites across its 4,642
 * modules). That call cannot return history, so the daemon printed a hopeful
 * line and then went quiet, leaving the gap `pending` forever with nothing said.
 *
 * The working restore is `transfer-sync-v2` (socket cmd 590/591), which the
 * `zalo-agent sync` command runs. The daemon deliberately does NOT run it
 * itself — see the "How the daemon self-heals" note in
 * src/commands/listen.js. It closes what Zalo's offline queue still holds on
 * its own (src/core/self-heal.js), and reports the rest; this module builds
 * that report.
 *
 * Kept pure — timestamps in, strings out, no db and no clock of its own — so
 * the one thing that actually has to be right is checkable offline: the `--from`
 * date it prints must be early enough that the resulting run RESOLVES the gap.
 * `recordRestoreSuccess()` only clears a gap lying wholly inside the synced
 * window (`gap.fromTs >= win.from`), so a date even one day late would produce a
 * command that appears to work and silently leaves the gap pending.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The UTC calendar day a timestamp falls in, as `sync --from` accepts it.
 *
 * `resolveSyncWindow()` parses `--from` with `Date.parse()`, which reads a bare
 * `YYYY-MM-DD` as UTC midnight. Taking the day from `toISOString()` therefore
 * always yields a window start at or before `ts` — never after it, which is the
 * property gap resolution depends on.
 *
 * @param {number} ts - ms epoch
 * @returns {string} `YYYY-MM-DD`
 */
export function syncFromDate(ts) {
    return new Date(Math.max(0, Number(ts) || 0)).toISOString().slice(0, 10);
}

/**
 * Human-readable span, e.g. "3d 0h", "4h 12m", "45s".
 *
 * The daemon used to print gaps in bare minutes ("~4356m"), which is unreadable
 * at the sizes that actually matter — a gap worth backfilling is usually hours
 * or days.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatSpan(ms) {
    // Floor, not round: rounding a 23h40m remainder up would print "3d 24h".
    const n = Math.max(0, Number(ms) || 0);
    if (n < MINUTE_MS) return `${Math.floor(n / 1000)}s`;
    if (n < HOUR_MS) return `${Math.floor(n / MINUTE_MS)}m`;
    if (n < DAY_MS) return `${Math.floor(n / HOUR_MS)}h ${Math.floor((n % HOUR_MS) / MINUTE_MS)}m`;
    return `${Math.floor(n / DAY_MS)}d ${Math.floor((n % DAY_MS) / HOUR_MS)}h`;
}

/**
 * Describe one recorded coverage gap and the command that closes it.
 *
 * @param {object} args
 * @param {number} args.fromTs - start of the gap (ms epoch), as stored
 * @param {number} args.toTs - end of the gap (ms epoch), as stored
 * @param {string} [args.reason] - "startup-gap" | "reconnect-gap" | …
 * @param {Array<{fromTs: number|string}>} [args.pendingGaps] - every still-pending
 *   gap, this one included (i.e. `getPendingSyncGaps()` read after recording it)
 * @returns {{
 *   reason: string, span: string, from: string, to: string,
 *   command: string, sinceDate: string,
 *   pendingCount: number, olderPending: number, otherPending: number,
 *   allCommand: string|null, allSinceDate: string|null
 * }} `command` closes this gap; `allCommand` is non-null only when an older gap
 *   is still pending, and closes every pending gap in one run.
 */
export function describeGap({ fromTs, toTs, reason = "unknown", pendingGaps = [] } = {}) {
    const from = Number(fromTs) || 0;
    const to = Number(toTs) || 0;
    const sinceDate = syncFromDate(from);

    const starts = pendingGaps.map((g) => Number(g.fromTs) || 0).filter((n) => n > 0);
    const oldest = starts.length ? Math.min(...starts) : from;
    // Same UTC day is not "older": it would print the identical command twice.
    const allSinceDate = syncFromDate(oldest);
    const hasOlder = allSinceDate < sinceDate;

    return {
        reason,
        span: formatSpan(to - from),
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        sinceDate,
        command: `zalo-agent sync --from ${sinceDate}`,
        pendingCount: starts.length,
        olderPending: starts.filter((n) => syncFromDate(n) < sinceDate).length,
        // What the report actually counts. `olderPending` uses a different
        // denominator -- gaps needing an EARLIER window -- so pairing it with
        // `pendingCount` in one sentence prints arithmetic that cannot be made
        // to add up ("1 older gap(s) ... covers all 3", observed live when an
        // older pending gap sat on the same UTC day as this one).
        otherPending: Math.max(0, starts.length - 1),
        allCommand: hasOlder ? `zalo-agent sync --from ${allSinceDate}` : null,
        allSinceDate: hasOlder ? allSinceDate : null,
    };
}
