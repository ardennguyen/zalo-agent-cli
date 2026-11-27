/**
 * Batched profile lookups that notice a rate limit instead of hammering through it.
 *
 * `getUserInfo` (names for user ids) and `/api/gid/decrypt` (opaque 1-1 ids to
 * user ids) take at most 100 / 50 ids per request. A restore of a busy account
 * (100,000 messages in 90 days, thousands of non-friend conversations) asks for
 * thousands of ids, so it sends dozens of these requests back to back, and
 * Zalo answers with a "limit reached" error (code 221).
 *
 * This runs the batches one at a time with a short gap and writes what Zalo
 * actually said -- code and message -- through `log`. A rate-limit answer is
 * not retried: retrying each batch after 2, 5 and 15 s cost a restore some 22 s
 * per batch and kept Zalo's limit hot (seen live: 67 batches, ~25 minutes).
 * It starts a cool-down for the whole process instead (`LOOKUP_COOL_DOWN_MS`):
 * until it ends every lookup returns at once without asking, and the callers
 * leave the names they did not get to be filled in later. That is said once,
 * not per batch. Several failures in a row of any other kind stop one lookup;
 * an aborted `signal` stops it between requests. The callers keep their
 * contract: a lookup that gives up leaves the names it did not get blank or as
 * ids, and nothing here throws.
 */

/** Wait between two requests of one lookup. */
export const DEFAULT_GAP_MS = 300;
/** How long lookups rest, process-wide, after Zalo said it is limiting them. */
export const LOOKUP_COOL_DOWN_MS = 10 * 60_000;
/** Consecutive failed batches (any error) after which the rest are not attempted. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** What a rate-limit answer reads like. Zalo's wording was not captured, so this is deliberately loose. */
const RATE_LIMIT_TEXT = /limit|giới hạn|too many|quá nhiều|vượt quá|frequen|tần suất|rate|throttl|try again later/i;
/** Codes Zalo uses for "too many requests" (getUserInfo and friend requests: 221). */
const RATE_LIMIT_CODES = new Set([221, 429]);

let sink = null;

/** When the process-wide cool-down ends (ms); 0 for none. */
let coolUntil = 0;

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
 * The error as Zalo reported it: its code and its message. A request that never got an answer (fetch's bare "fetch
 * failed") says why, from its `cause`: the socket error and its code.
 *
 * @param {unknown} e
 * @returns {string} e.g. `code 221: Quá giới hạn`, `fetch failed (ECONNRESET: other side closed)`, or the message
 */
export function describeLookupError(e) {
    const message = e?.message || String(e);
    const why = networkCause(e);
    if (why) return `${message} (${why})`;
    const code = e?.code ?? message.match(/\((-?\d+)\)\s*$/)?.[1];
    return code !== undefined && code !== null && code !== "" ? `code ${code}: ${message}` : message;
}

/** Socket and DNS error codes of a request that may simply be sent again: nothing was answered. */
const TRANSIENT_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_SOCKET",
    "UND_ERR_CLOSED",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
]);

/**
 * Why fetch failed, from the error's `cause` chain: `<code>: <message>`, or null when it is not a network failure.
 *
 * @param {unknown} e
 * @returns {string|null}
 */
export function networkCause(e) {
    if (!(e instanceof TypeError) || !/fetch failed/i.test(String(e.message))) return null;
    let c = e.cause;
    for (let depth = 0; c?.cause && !c.code && depth < 4; depth++) c = c.cause;
    if (!c) return "no cause given";
    const code = c.code ? String(c.code) : "";
    const text = c.message ? String(c.message) : "";
    return [code, text].filter(Boolean).join(": ") || String(c);
}

/**
 * Whether a failed request never got an answer from Zalo (a reset or refused connection, a connect or read timeout, a
 * DNS hiccup), so asking once more is safe and likely to work. A reply Zalo did give (an error code, a rate limit) is
 * not.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export function isTransientNetworkError(e) {
    if (isRateLimitError(e)) return false;
    if (e?.timeout === true) return true;
    if (!(e instanceof TypeError) || !/fetch failed/i.test(String(e.message))) return false;
    let c = e.cause;
    for (let depth = 0; c && depth < 5; depth++, c = c.cause) {
        if (TRANSIENT_CODES.has(String(c.code))) return true;
        if (/other side closed|socket hang up|terminated/i.test(String(c.message))) return true;
    }
    // fetch failed without a cause we know: no answer came either way.
    return true;
}

/** Pauses before a request that got no answer is sent again. */
export const NETWORK_RETRY_DELAYS_MS = Object.freeze([1_000, 3_000]);

/**
 * Run `fn`, and again after each pause while it fails without an answer from Zalo ({@link isTransientNetworkError}).
 * Any other failure is thrown at once.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [o]
 * @param {readonly number[]} [o.delays]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {(e: unknown, attempt: number) => void} [o.onRetry]
 * @returns {Promise<T>}
 */
export async function retryOnNetworkError(fn, { delays = NETWORK_RETRY_DELAYS_MS, sleep, onRetry } = {}) {
    const wait = sleep ?? ((ms) => pacing.sleep(ms));
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (attempt >= delays.length || !isTransientNetworkError(e)) throw e;
            onRetry?.(e, attempt + 1);
            await wait(delays[attempt]);
        }
    }
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

const pacing = { gapMs: DEFAULT_GAP_MS, sleep: realSleep, now: () => Date.now() };

/**
 * Override the module's pacing defaults (a test seam: the real gap is hundreds of ms).
 *
 * @param {{gapMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number}} [overrides]
 *   call with nothing to restore the defaults
 */
export function configureUserInfo(overrides = {}) {
    pacing.gapMs = overrides.gapMs ?? DEFAULT_GAP_MS;
    pacing.sleep = overrides.sleep ?? realSleep;
    pacing.now = overrides.now ?? (() => Date.now());
}

/**
 * Whether lookups are resting after a rate limit.
 *
 * @returns {boolean}
 */
export function lookupsCoolingDown() {
    return coolUntil > pacing.now();
}

/**
 * Start (or extend) the cool-down; say so once, when it starts.
 *
 * @param {string} why - what Zalo said
 * @param {(m: string) => void} [log]
 * @returns {boolean} true when it was not already running
 */
export function noteLookupRateLimit(why, log = (m) => sink?.(m)) {
    const fresh = !lookupsCoolingDown();
    coolUntil = pacing.now() + LOOKUP_COOL_DOWN_MS;
    if (fresh) {
        log(
            `names deferred: Zalo is limiting lookups (${why}); none are asked for until ` +
                `${new Date(coolUntil).toISOString()}, and the names left blank are filled in later`,
        );
    }
    return fresh;
}

/** End the cool-down (a test seam). */
export function resetLookupCoolDown() {
    coolUntil = 0;
}

/**
 * Call `call(batch)` for each slice of `ids`, paced and bounded.
 *
 * @template T
 * @param {string[]} ids - already de-duplicated by the caller
 * @param {object} opts
 * @param {number} opts.batchSize - ids per request
 * @param {(batch: string[]) => Promise<T>} opts.call - one request
 * @param {string} [opts.label] - prefix for the log lines
 * @param {(message: string) => void} [opts.log] - defaults to the daemon sink, else silent
 * @param {number} [opts.gapMs] - wait between requests
 * @param {number} [opts.maxConsecutiveFailures]
 * @param {(ms: number) => Promise<void>} [opts.sleep] - test seam
 * @param {AbortSignal} [opts.signal] - stops the lookup between requests
 * @returns {Promise<{results: T[], batches: number, failed: number, skippedIds: number,
 *   stoppedBy: null|"rate-limit"|"cooling-down"|"repeated-failures"|"cancelled", retries: number}>} `retries` stays
 *   0 (a rate limit is never retried; kept for callers that read it)
 */
export async function runPacedBatches(ids, opts) {
    const {
        batchSize,
        call,
        label = "user-info",
        gapMs = pacing.gapMs,
        maxConsecutiveFailures = MAX_CONSECUTIVE_FAILURES,
        sleep = pacing.sleep,
        signal,
    } = opts;
    const log = typeof opts.log === "function" ? opts.log : (m) => sink?.(m);
    const list = Array.isArray(ids) ? ids : [];
    const total = Math.ceil(list.length / batchSize);
    const out = { results: [], batches: total, failed: 0, skippedIds: 0, stoppedBy: null, retries: 0 };
    let consecutive = 0;

    for (let b = 0; b < total; b++) {
        if (b > 0 && gapMs > 0) await sleep(gapMs);
        // Cancelled, or resting after a rate limit: nothing more is asked, and nothing is said per batch.
        const why = signal?.aborted ? "cancelled" : lookupsCoolingDown() ? "cooling-down" : null;
        if (why) {
            out.stoppedBy = why;
            out.skippedIds = list.length - b * batchSize;
            break;
        }
        const batch = list.slice(b * batchSize, (b + 1) * batchSize);
        try {
            // A batch that got no answer at all (a reset connection, a timeout) is sent again before it counts as
            // failed: a lookup must not give up on a network blip.
            out.results.push(await retryOnNetworkError(() => call(batch), { sleep }));
            consecutive = 0;
        } catch (e) {
            out.failed++;
            if (isRateLimitError(e)) {
                // Never retried: the cool-down starts, said once for the whole process.
                out.stoppedBy = "rate-limit";
                out.skippedIds = Math.max(0, list.length - (b + 1) * batchSize);
                noteLookupRateLimit(`${label}: ${describeLookupError(e)}`, log);
                break;
            }
            log(`${label}: batch ${b + 1}/${total} (${batch.length} id(s)) failed: ${describeLookupError(e)}`);
            consecutive++;
            if (consecutive >= maxConsecutiveFailures) {
                out.stoppedBy = "repeated-failures";
                out.skippedIds = Math.max(0, list.length - (b + 1) * batchSize);
                log(
                    `${label}: stopped after batch ${b + 1}/${total} (${consecutive} failed batches in a row); ` +
                        `${out.skippedIds} id(s) in later batches were not looked up this time`,
                );
                break;
            }
        }
    }
    if (total > 1 && !out.stoppedBy && out.failed) {
        log(`${label}: finished ${total} batch(es), ${out.failed} failed`);
    }
    return out;
}
