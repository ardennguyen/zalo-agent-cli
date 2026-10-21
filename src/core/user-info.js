/**
 * Batched profile lookups that notice a rate limit instead of hammering through it.
 *
 * `getUserInfo` (names for user ids) and `/api/gid/decrypt` (opaque 1-1 ids to
 * user ids) take at most 100 / 50 ids per request. A restore of a busy account
 * (100,000 messages in 90 days, thousands of non-friend conversations) asks for
 * thousands of ids, so it sends dozens of these requests back to back, and
 * Zalo answers with a "limit reached" error. The old loops swallowed that
 * error with a fixed message and went on to the next batch, so every remaining
 * batch failed the same way, the real error text was never written anywhere,
 * and the next restore started from zero again.
 *
 * This runs the batches one at a time with a short gap, retries a rate-limit
 * answer with a growing wait, stops the whole lookup after a rate limit that
 * persists (or after several failures in a row, whatever their text), and
 * writes what Zalo actually said -- code and message -- through `log`. The
 * callers keep their contract: a lookup that gives up leaves the names it did
 * not get blank or as ids, and nothing here throws.
 */

/** Wait between two requests of one lookup. */
export const DEFAULT_GAP_MS = 300;
/** Waits before each retry of a rate-limited batch. */
export const DEFAULT_BACKOFF_MS = Object.freeze([2000, 5000, 15000]);
/** Consecutive failed batches (any error) after which the rest are not attempted. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** What a rate-limit answer reads like. Zalo's wording was not captured, so this is deliberately loose. */
const RATE_LIMIT_TEXT = /limit|giới hạn|too many|quá nhiều|frequen|tần suất|rate|throttl|try again later/i;
/** Codes Zalo uses for "too many requests" elsewhere in this CLI (friend requests: 221). */
const RATE_LIMIT_CODES = new Set([221, 429]);

let sink = null;

/**
 * Where lookups write their diagnostics when the caller passes no `log`.
 * Daemons point this at their log; one-shot commands leave it unset and stay quiet.
 *
 * @param {((message: string) => void)|null} fn
 */
export function setUserInfoLogger(fn) {
    sink = typeof fn === "function" ? fn : null;
}

/**
 * Write one diagnostic line to the registered sink, if any.
 *
 * @param {string} message
 */
export function userInfoLog(message) {
    sink?.(message);
}

/**
 * The error as Zalo reported it: its code and its message.
 *
 * @param {unknown} e
 * @returns {string} e.g. `code 221: Quá giới hạn`, or just the message
 */
export function describeLookupError(e) {
    const message = e?.message || String(e);
    const code = e?.code ?? message.match(/\((-?\d+)\)\s*$/)?.[1];
    return code !== undefined && code !== null && code !== "" ? `code ${code}: ${message}` : message;
}

/**
 * Whether an error looks like Zalo refusing because too many lookups were made.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export function isRateLimitError(e) {
    if (RATE_LIMIT_CODES.has(Number(e?.code))) return true;
    return RATE_LIMIT_TEXT.test(String(e?.message || e || ""));
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pacing = { gapMs: DEFAULT_GAP_MS, backoffMs: DEFAULT_BACKOFF_MS, sleep: realSleep };

/**
 * Override the module's pacing defaults (a test seam: the real gaps and back-offs are seconds).
 *
 * @param {{gapMs?: number, backoffMs?: readonly number[], sleep?: (ms: number) => Promise<void>}} [overrides]
 *   call with nothing to restore the defaults
 */
export function configureUserInfo(overrides = {}) {
    pacing.gapMs = overrides.gapMs ?? DEFAULT_GAP_MS;
    pacing.backoffMs = overrides.backoffMs ?? DEFAULT_BACKOFF_MS;
    pacing.sleep = overrides.sleep ?? realSleep;
}

/**
 * Call `call(batch)` for each slice of `ids`, paced, retried and bounded.
 *
 * @template T
 * @param {string[]} ids - already de-duplicated by the caller
 * @param {object} opts
 * @param {number} opts.batchSize - ids per request
 * @param {(batch: string[]) => Promise<T>} opts.call - one request
 * @param {string} [opts.label] - prefix for the log lines
 * @param {(message: string) => void} [opts.log] - defaults to the daemon sink, else silent
 * @param {number} [opts.gapMs] - wait between requests
 * @param {readonly number[]} [opts.backoffMs] - waits before each retry of a rate-limited batch
 * @param {number} [opts.maxConsecutiveFailures]
 * @param {(ms: number) => Promise<void>} [opts.sleep] - test seam
 * @returns {Promise<{results: T[], batches: number, failed: number, skippedIds: number,
 *   stoppedBy: null|"rate-limit"|"repeated-failures", retries: number}>}
 */
export async function runPacedBatches(ids, opts) {
    const {
        batchSize,
        call,
        label = "user-info",
        gapMs = pacing.gapMs,
        backoffMs = pacing.backoffMs,
        maxConsecutiveFailures = MAX_CONSECUTIVE_FAILURES,
        sleep = pacing.sleep,
    } = opts;
    const log = typeof opts.log === "function" ? opts.log : (m) => sink?.(m);
    const list = Array.isArray(ids) ? ids : [];
    const total = Math.ceil(list.length / batchSize);
    const out = { results: [], batches: total, failed: 0, skippedIds: 0, stoppedBy: null, retries: 0 };
    let consecutive = 0;

    for (let b = 0; b < total; b++) {
        const batch = list.slice(b * batchSize, (b + 1) * batchSize);
        if (b > 0 && gapMs > 0) await sleep(gapMs);
        for (let attempt = 0; ; attempt++) {
            try {
                out.results.push(await call(batch));
                consecutive = 0;
                break;
            } catch (e) {
                const limited = isRateLimitError(e);
                log(
                    `${label}: batch ${b + 1}/${total} (${batch.length} id(s)) failed: ${describeLookupError(e)}` +
                        (limited ? " [looks like a rate limit]" : ""),
                );
                if (limited && attempt < backoffMs.length) {
                    out.retries++;
                    log(`${label}: waiting ${backoffMs[attempt]}ms, then retrying batch ${b + 1}/${total}`);
                    await sleep(backoffMs[attempt]);
                    continue;
                }
                out.failed++;
                consecutive++;
                if (limited) out.stoppedBy = "rate-limit";
                else if (consecutive >= maxConsecutiveFailures) out.stoppedBy = "repeated-failures";
                break;
            }
        }
        if (out.stoppedBy) {
            out.skippedIds = list.length - (b + 1) * batchSize;
            if (out.skippedIds < 0) out.skippedIds = 0;
            log(
                `${label}: stopped after batch ${b + 1}/${total} (${
                    out.stoppedBy === "rate-limit"
                        ? "Zalo is limiting these lookups"
                        : `${consecutive} failed batches in a row`
                }); ${out.skippedIds} id(s) in later batches were not looked up this time`,
            );
            break;
        }
    }
    if (total > 1 && !out.stoppedBy && (out.failed || out.retries)) {
        log(`${label}: finished ${total} batch(es), ${out.failed} failed, ${out.retries} retried`);
    }
    return out;
}
