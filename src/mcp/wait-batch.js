/**
 * The batch settings of a "wait for messages" call (`limit`, `settleMs`), apart from ./wait-result.js so the
 * message buffer can clamp them without loading the alias book (and through it the account database).
 */

/** Longest a call waits for company after the first message. */
export const MAX_SETTLE_MS = 5000;

/**
 * Clamp the caller's batch settings. No `limit` (or an unusable one) is null: every message already waiting, up to
 * what the buffer holds (`limits.bufferMaxSize`); a `limit` is a bound with no cap of its own. An unusable
 * `settleMs` is 0 (no settling).
 *
 * @param {{ limit?: unknown, settleMs?: unknown }} [raw]
 * @returns {{ limit: number|null, settleMs: number }}
 */
export function batchParams({ limit, settleMs } = {}) {
    const l = Number(limit);
    const s = Number(settleMs);
    return {
        limit:
            limit !== undefined && limit !== null && limit !== "" && Number.isFinite(l) && l >= 1
                ? Math.floor(l)
                : null,
        settleMs: Number.isFinite(s) && s > 0 ? Math.min(MAX_SETTLE_MS, Math.floor(s)) : 0,
    };
}
