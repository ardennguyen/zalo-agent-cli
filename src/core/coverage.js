/**
 * How complete the local message cache is, in the terms the daemon already
 * records it in: coverage gaps.
 *
 * A gap is a window in which this account's socket was down (`listen` and
 * `mcp start` file one through src/core/listener-lifecycle.js), so whatever
 * arrived in it may be missing from zalo.db. The self-heal closes what Zalo's
 * offline queue still holds; what it cannot reach stays `pending` until a
 * phone-backed `zalo-agent sync` covers it. This module reads that bookkeeping
 * and says it in plain words, with the exact `sync --from` run that restores
 * the gaps — the same advice `listen` prints, from src/core/sync-v2/gap-advice.js.
 *
 * Read-only: nothing here writes zalo.db or contacts Zalo.
 */

import { getPendingSyncGaps, countSyncGaps } from "./db.js";
import { describeGap } from "./sync-v2/gap-advice.js";

/**
 * The coverage report for the account whose db is open.
 *
 * `command` restores every pending gap in one run: gaps are listed oldest
 * first, and a restore resolves each gap lying wholly inside its window, so
 * the window has to start on the oldest gap's (UTC) day — which is how
 * `describeGap` dates it. A later date would run, succeed, and leave the
 * older gaps pending.
 *
 * Throws "Database not initialized" when no db is open, as db.js does.
 *
 * @returns {{
 *   pendingCount: number,
 *   resolvedCount: number,
 *   pending: Array<{id: number, reason: string, from: string, to: string, fromTs: number, toTs: number,
 *     span: string, recordedAt: string|null, command: string}>,
 *   command: string|null,
 *   hint: string
 * }}
 */
export function coverageReport() {
    const rows = getPendingSyncGaps();
    const { resolved } = countSyncGaps();

    const pending = rows.map((g) => {
        const advice = describeGap({
            fromTs: g.fromTs,
            toTs: g.toTs,
            reason: g.reason || undefined,
            pendingGaps: rows,
        });
        return {
            id: g.id,
            reason: advice.reason,
            from: advice.from,
            to: advice.to,
            fromTs: Number(g.fromTs) || 0,
            toTs: Number(g.toTs) || 0,
            span: advice.span,
            recordedAt: g.createdAt ? new Date(Number(g.createdAt)).toISOString() : null,
            // Restores this gap alone (and any later one).
            command: advice.command,
        };
    });

    if (rows.length === 0) {
        return {
            pendingCount: 0,
            resolvedCount: resolved,
            pending,
            command: null,
            hint:
                "No coverage gap is pending: no window in which this account's connection to Zalo was down is " +
                "waiting to be restored.",
        };
    }

    const oldest = describeGap({ ...rows[0], reason: rows[0].reason || undefined, pendingGaps: rows });
    const command = oldest.allCommand ?? oldest.command;
    return {
        pendingCount: rows.length,
        resolvedCount: resolved,
        pending,
        command,
        hint:
            `${rows.length} coverage gap(s) pending: windows in which this account's connection to Zalo was down, ` +
            "so messages from them may be missing from the local cache. " +
            `\`${command}\` restores them from the owner's phone — the phone asks for a tap on "ĐỒNG BỘ NGAY" — ` +
            "and a run that completes resolves every gap that starts on or after that date. Nothing has to be " +
            "stopped first: a running `mcp start` or `listen` performs the restore on its own socket.",
    };
}
