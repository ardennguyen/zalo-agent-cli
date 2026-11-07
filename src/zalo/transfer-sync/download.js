/**
 * Downloading the batches a phone prepared (plan item Y3).
 *
 * Every `upload_batch` the phone sends carries a signed `msgUrl`. Until now each was fetched late, one at a time,
 * with no timeout and no retry, and one that failed was skipped without a word, so a shard quietly lost data. The
 * official client starts a download the moment the batch is announced, runs two at once, gives each 60 s, retries
 * a failure three times one second apart, and tells a missing batch (404) from a server fault (5xx) from a
 * network fault, so the scope can be failed with its reason instead of dropped.
 *
 * The downloader is a small queue: {@link BatchDownloader.start} begins (or joins) the download of a URL, and
 * {@link BatchDownloader.get} returns its bytes, throwing a {@link BatchDownloadError} that says why not.
 */

/** The official client's settings. */
export const DOWNLOAD_DEFAULTS = Object.freeze({ concurrent: 2, timeoutMs: 60_000, retries: 3, retryDelayMs: 1_000 });

/** Why a download failed. */
export const DOWNLOAD_FAILURE = Object.freeze({
    NOT_FOUND: "not-found",
    SERVER: "server",
    REFUSED: "refused",
    TIMEOUT: "timeout",
    NETWORK: "network",
});

/** A download that did not work. */
export class BatchDownloadError extends Error {
    /**
     * @param {string} kind - one of {@link DOWNLOAD_FAILURE}
     * @param {string} message
     * @param {number|null} [status] - the HTTP status, when there was one
     */
    constructor(kind, message, status = null) {
        super(message);
        this.name = "BatchDownloadError";
        this.kind = kind;
        this.status = status;
    }
}

/** Only these are worth asking again: a missing or refused batch will be just as missing a second later. */
const RETRYABLE = new Set([DOWNLOAD_FAILURE.SERVER, DOWNLOAD_FAILURE.TIMEOUT, DOWNLOAD_FAILURE.NETWORK]);

/**
 * One attempt.
 *
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {number} timeoutMs
 * @returns {Promise<Buffer>}
 * @throws {BatchDownloadError}
 */
async function attempt(url, fetchImpl, timeoutMs) {
    let res;
    try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        if (e?.name === "TimeoutError" || e?.name === "AbortError") {
            throw new BatchDownloadError(
                DOWNLOAD_FAILURE.TIMEOUT,
                `no answer within ${Math.round(timeoutMs / 1000)} s`,
            );
        }
        throw new BatchDownloadError(DOWNLOAD_FAILURE.NETWORK, e?.message || String(e));
    }
    if (res.status === 404) {
        throw new BatchDownloadError(DOWNLOAD_FAILURE.NOT_FOUND, "the batch is no longer there (404)", 404);
    }
    if (res.status >= 500) {
        throw new BatchDownloadError(DOWNLOAD_FAILURE.SERVER, `the download server failed (${res.status})`, res.status);
    }
    if (!res.ok) {
        throw new BatchDownloadError(DOWNLOAD_FAILURE.REFUSED, `the download was refused (${res.status})`, res.status);
    }
    try {
        return Buffer.from(await res.arrayBuffer());
    } catch (e) {
        throw e?.name === "TimeoutError" || e?.name === "AbortError"
            ? new BatchDownloadError(
                  DOWNLOAD_FAILURE.TIMEOUT,
                  `the body did not arrive within ${Math.round(timeoutMs / 1000)} s`,
              )
            : new BatchDownloadError(DOWNLOAD_FAILURE.NETWORK, e?.message || String(e));
    }
}

/**
 * A queue of batch downloads.
 *
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.concurrent] - downloads in flight at once
 * @param {number} [opts.timeoutMs] - per attempt
 * @param {number} [opts.retries] - extra attempts after the first
 * @param {number} [opts.retryDelayMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {{start: (url: string) => Promise<Buffer>, get: (url: string) => Promise<Buffer>, pending: () => number}}
 */
export function createBatchDownloader({
    fetchImpl = (...a) => fetch(...a),
    concurrent = DOWNLOAD_DEFAULTS.concurrent,
    timeoutMs = DOWNLOAD_DEFAULTS.timeoutMs,
    retries = DOWNLOAD_DEFAULTS.retries,
    retryDelayMs = DOWNLOAD_DEFAULTS.retryDelayMs,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
    const jobs = new Map();
    const waiting = [];
    let running = 0;

    const pump = () => {
        while (running < concurrent && waiting.length) {
            const job = waiting.shift();
            running++;
            run(job.url)
                .then(job.resolve, job.reject)
                .finally(() => {
                    running--;
                    pump();
                });
        }
    };

    async function run(url) {
        for (let n = 0; ; n++) {
            try {
                return await attempt(url, fetchImpl, timeoutMs);
            } catch (e) {
                if (!(e instanceof BatchDownloadError) || !RETRYABLE.has(e.kind) || n >= retries) throw e;
                await sleep(retryDelayMs);
            }
        }
    }

    function start(url) {
        const known = jobs.get(url);
        if (known) return known;
        const promise = new Promise((resolve, reject) => waiting.push({ url, resolve, reject }));
        // A download nobody has asked for yet may fail; that is reported when it is asked for, not as an
        // unhandled rejection of its own.
        promise.catch(() => {});
        jobs.set(url, promise);
        pump();
        return promise;
    }

    return {
        start,
        /**
         * The bytes of `url`, starting the download if it has not been started. The download is forgotten
         * here, so a batch's bytes are not kept for the rest of the run once they have been used.
         */
        get(url) {
            const promise = start(url);
            jobs.delete(url);
            return promise;
        },
        /** How many downloads are running or waiting. */
        pending: () => running + waiting.length,
    };
}
