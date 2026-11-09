/**
 * The batch settings of a "wait for messages" call (`limit`, `settleMs`), apart from ./wait-result.js so the
 * message buffer can clamp them without loading the alias book (and through it the account database).
 */

/** Most messages one call returns. */
export const MAX_BATCH = 100;
/** Longest a call waits for company after the first message. */
export const MAX_SETTLE_MS = 5000;

/**
 * Clamp the caller's batch settings; anything unusable is the default (one message, no settling).
 *
 * @param {{ limit?: unknown, settleMs?: unknown }} [raw]
 * @returns {{ limit: number, settleMs: number }}
 */
export function batchParams({ limit, settleMs } = {}) {
    const l = Number(limit);
    const s = Number(settleMs);
    return {
        limit: Number.isFinite(l) && l >= 1 ? Math.min(MAX_BATCH, Math.floor(l)) : 1,
        settleMs: Number.isFinite(s) && s > 0 ? Math.min(MAX_SETTLE_MS, Math.floor(s)) : 0,
    };
}
