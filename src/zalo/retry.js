/**
 * When to try again after a socket drop (plan items L11a-L11c).
 *
 * The Zalo server hands the client a retry table (`settings.features.socket`)
 * and the client turns it into delays. This is that arithmetic, kept free of
 * timers and sockets so it can be tested with a fixed clock and a fixed random
 * number.
 *
 * **Round 1.** The table maps a key (a close code, an error code or a name such
 * as `internal`) to `{times, max}`. `times` is one delay or a list; each retry
 * of the same key takes the next entry, staying on the last. `max` is how many
 * retries the key gets. A key the table does not list waits the last default
 * delay and is never counted: it is not an error to ask for a key the server did
 * not describe (the zca-js listener threw a TypeError there).
 *
 * **Endpoint rotation.** When a key's retries are spent and the server lists it
 * under `rotate_error_codes`, the next endpoint is tried and the key starts
 * over, as long as there is an endpoint left to rotate to.
 *
 * **Round 2.** When the retries are spent and there is nothing to rotate to, the
 * delays become Fibonacci: `fibo(n) * multiple`, capped at `max`. There is no
 * round 3: the client keeps trying, slowly, until told to stop.
 *
 * **Spreading.** Every delay is multiplied by `1 + noise + anomaly`:
 * `noise` is `retry_noise_factor` times a random number, so a thousand clients
 * dropped by one outage do not return in the same second; `anomaly` is
 * `exp(-kalpha * n)`, where n is how many EARLIER DAYS this key's error was
 * seen in the last week. An error that is new to this installation waits about
 * twice as long as one it has seen before; for the first week after install it
 * counts for nothing. The history is persisted so a restart does not forget it.
 */

/** The delays used when the server's table has no entry for a key. */
const DEFAULT_TIMES = [1000, 10000, 30000, 60000];

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const SAME_ERROR_RECORD_GAP_MS = 3_600_000;
const MAX_RECORDED_ERRORS = 100;

/**
 * What the client does when the server omits a socket setting.
 *
 * These are this client's own defaults, chosen to match how the official Web
 * client behaves, and they apply only to what the server leaves out: the
 * server's value always wins. The keys are the server's.
 */
export const DEFAULT_SOCKET_SETTINGS = Object.freeze({
    retries: Object.freeze({
        manual: { times: 1000 },
        interval_check: { times: 1000 },
        system_resume: { times: 3000 },
        swap_endpoint: { times: 1000 },
        4002: { times: 1000 },
        internal: { times: [2000, 3000, 5000, 8000], max: 8 },
        cannot_reach_server: { times: [2000, 3000, 5000, 8000], max: 8 },
        4001: { times: [2000, 3000, 5000, 8000], max: 8 },
        no_network: { times: [3000, 5000, 8000] },
        3000: { times: [2000, 3000, 5000, 8000], max: 8 },
        3002: { times: [2000, 3000, 5000, 8000] },
        5001: { times: [2000, 3000, 5000, 8000], max: 8 },
        5007: { times: [2000, 3000, 5000, 8000], max: 8 },
        5008: { times: [2000, 3000, 5000, 8000], max: 8 },
        5011: { times: [2000, 3000, 5000, 8000], max: 5 },
        5012: { times: 3000, max: 5 },
        5013: { times: 1000, max: 5 },
        5014: { times: [2000, 3000, 5000, 8000], max: 8 },
        5015: { times: [2000, 3000, 5000, 8000], max: 8 },
        5016: { times: 1000 },
        5017: { times: [2000, 3000, 5000, 8000], max: 8 },
    }),
    retries_round_2: Object.freeze({
        default: { multiple: 3000, max: 60000 },
        internal: { multiple: 2000, max: 60000 },
        cannot_reach_server: { multiple: 2000, max: 60000 },
        3000: { multiple: 2000, max: 60000 },
        4001: { multiple: 2000, max: 60000 },
        5001: { multiple: 2000, max: 60000 },
        5007: { multiple: 2000, max: 60000 },
        5008: { multiple: 2000, max: 60000 },
        5011: { multiple: 2000, max: 60000 },
        5012: { multiple: 3000, max: 60000 },
        5014: { multiple: 2000, max: 60000 },
        5015: { multiple: 2000, max: 60000 },
        5017: { multiple: 2000, max: 60000 },
    }),
    retry_noise_factor: 0.2,
    anomalous_error_kalpha: 0.46,
    close_and_retry_codes: Object.freeze([5008, 5007, 3003, 3000, 5014, 4002, 5015, 5016, 5017]),
    rotate_error_codes: Object.freeze([5011, 5012, 4001]),
    establish_timeout: 15000,
    timeout_authen: 15000,
    close_timeout: 5000,
    ping_interval: 180000,
    ping_max_timeout: 300000,
    reset_endpoint: 600000,
    kickout_on_max: true,
    logout_on_err_kick: true,
});

/**
 * The socket settings to use: the server's `features.socket` over the defaults.
 *
 * Plain values replace the default; the two retry tables merge entry by entry,
 * so a server that describes one key does not make every other key unknown.
 *
 * @param {object} [serverSocket] - `settings.features.socket` from getServerInfo
 * @returns {object} a new object with every key of DEFAULT_SOCKET_SETTINGS
 */
export function resolveSocketSettings(serverSocket = {}) {
    const out = structuredClone(DEFAULT_SOCKET_SETTINGS);
    for (const [key, value] of Object.entries(serverSocket ?? {})) {
        if ((key === "retries" || key === "retries_round_2") && value && typeof value === "object") {
            out[key] = { ...out[key], ...structuredClone(value) };
        } else if (value !== undefined && value !== null) {
            out[key] = structuredClone(value);
        }
    }
    return out;
}

/**
 * The Fibonacci number the round-2 delay is built from: 1, 2, 3, 5, 8, ...
 *
 * @param {number} n - 1 or more
 * @returns {number}
 */
export function fibo(n) {
    let a = 1;
    let b = 2;
    if (n <= 1) return 1;
    for (let i = 2; i < n; i++) [a, b] = [b, a + b];
    return b;
}

/**
 * The record of which errors this installation has seen in the last week.
 *
 * @param {object} opts
 * @param {object} [opts.state] - `{firstInstall, errors: [{code, time}]}` as saved before
 * @param {number} [opts.kalpha] - the server's `anomalous_error_kalpha`
 * @param {() => number} [opts.now]
 * @param {(state: object) => void} [opts.save] - called with the state after every change
 * @returns {{addError: (code: string|number) => boolean, computeAbnormalRate: (code: string|number) => number,
 *   state: () => object}}
 */
export function createAnomalyHistory({
    state,
    kalpha = DEFAULT_SOCKET_SETTINGS.anomalous_error_kalpha,
    now = () => Date.now(),
    save = () => {},
} = {}) {
    const data = {
        firstInstall: Number.isFinite(state?.firstInstall) ? state.firstInstall : now(),
        errors: Array.isArray(state?.errors) ? state.errors.filter((e) => e && now() - e.time < WEEK_MS) : [],
    };
    const lastSeen = new Map();
    const day = (t) => new Date(t).toDateString();

    return {
        /**
         * Record an error. The same code is recorded at most once an hour
         * (code 0, a plain start, always), and only the last 100 are kept.
         *
         * @param {string|number} code
         * @returns {boolean} whether it was recorded
         */
        addError(code) {
            if (typeof code !== "number" && typeof code !== "string") return false;
            const t = now();
            const prev = lastSeen.get(code);
            if (prev !== undefined && code !== 0 && t - prev < SAME_ERROR_RECORD_GAP_MS) return false;
            lastSeen.set(code, t);
            data.errors.push({ code, time: t });
            if (data.errors.length > MAX_RECORDED_ERRORS)
                data.errors.splice(0, data.errors.length - MAX_RECORDED_ERRORS);
            save(structuredClone(data));
            return true;
        },

        /**
         * How unusual an error is: 0 in the first week after install, then
         * `exp(-kalpha * n)` for n earlier days this code was seen in.
         *
         * @param {string|number} code
         * @returns {number} 0 to 1
         */
        computeAbnormalRate(code) {
            const t = now();
            if (data.firstInstall > t - WEEK_MS) return 0;
            const today = day(t);
            const earlierDays = data.errors.filter(
                (e) => e.code === code && t - e.time < WEEK_MS && day(e.time) !== today,
            ).length;
            return Math.exp(-kalpha * earlierDays);
        },

        state: () => structuredClone(data),
    };
}

/**
 * The retry engine for one socket.
 *
 * @param {object} opts
 * @param {object} [opts.settings] - from {@link resolveSocketSettings}
 * @param {ReturnType<typeof createAnomalyHistory>} [opts.anomaly]
 * @param {() => number} [opts.random] - 0 up to 1, `Math.random` by default
 * @param {number} [opts.endpoints] - how many socket endpoints the login handed out
 * @returns {{
 *   next: (key: string|number) => {delayMs: number, round: 1|2, rotate: boolean, base: number},
 *   attempt: (key: string|number) => {delayMs: number, base: number}|null,
 *   resetKeys: (keys: Array<string|number>) => void,
 *   resetAll: () => void,
 *   resetRotation: () => void,
 *   rotateCount: () => number,
 *   snapshot: () => object,
 * }}
 */
export function createRetryEngine({
    settings = resolveSocketSettings(),
    anomaly = createAnomalyHistory(),
    random = Math.random,
    endpoints = 1,
} = {}) {
    const round1 = new Map();
    const round2 = new Map();
    let rotated = 0;

    const keyOf = (k) => String(k);

    /** The next round-1 delay for a key, or null when its retries are spent. */
    function origin(key) {
        const entry = settings.retries[keyOf(key)];
        if (!entry) return DEFAULT_TIMES[DEFAULT_TIMES.length - 1];
        const count = round1.get(keyOf(key)) ?? 0;
        if (entry.max !== undefined && entry.max !== null && count >= entry.max) return null;
        round1.set(keyOf(key), count + 1);
        const times = entry.times;
        if (typeof times === "number") return times;
        const list = Array.isArray(times) ? times : DEFAULT_TIMES;
        return count < list.length ? list[count] : list[list.length - 1];
    }

    /** The next round-2 delay: Fibonacci, capped. */
    function secondRound(key) {
        const k = settings.retries_round_2[keyOf(key)] ? keyOf(key) : "default";
        const entry = settings.retries_round_2[k] ?? { multiple: 3000, max: 60000 };
        const count = (round2.get(k) ?? 0) + 1;
        round2.set(k, count);
        const base = fibo(count) * entry.multiple;
        return entry.max && base > entry.max ? entry.max : base;
    }

    function shouldRotate(key) {
        const list = settings.rotate_error_codes ?? [];
        if (!list.includes(key) && !list.includes(keyOf(key)) && !list.includes(Number(key))) return false;
        if (rotated >= endpoints - 1) return false;
        rotated += 1;
        return true;
    }

    /** `base * (1 + noise + anomaly)`, the spreading every delay gets. */
    function adjust(key, base) {
        const factor =
            typeof settings.retry_noise_factor === "number" && settings.retry_noise_factor > 0
                ? settings.retry_noise_factor
                : DEFAULT_SOCKET_SETTINGS.retry_noise_factor;
        return base * (1 + factor * random() + anomaly.computeAbnormalRate(key));
    }

    return {
        /**
         * The delay before the next try for a key, and whether to switch endpoint first.
         * Never refuses: round 2 has no end.
         *
         * @param {string|number} key
         * @returns {{delayMs: number, round: 1|2, rotate: boolean, base: number}}
         */
        next(key) {
            let rotate = false;
            let base = origin(key);
            let round = 1;
            if (base === null && shouldRotate(key)) {
                rotate = true;
                // A new endpoint gets a fresh round 1, but only if round 2 has not begun for this key.
                const r2 = settings.retries_round_2[keyOf(key)] ? keyOf(key) : "default";
                if ((round2.get(r2) ?? 0) === 0) {
                    round1.delete(keyOf(key));
                    round2.delete(keyOf(key));
                    base = origin(key);
                }
            }
            if (base === null) {
                round = 2;
                base = secondRound(key);
            }
            anomaly.addError(key);
            return { delayMs: adjust(key, base), round, rotate, base };
        },

        /**
         * One more round-1 delay for a key, or null when its retries are spent.
         * Unlike {@link next} this never falls into round 2 and never rotates: it is for the
         * waits that must stop (re-pinging a socket that did not answer) instead of going on forever.
         * It is not recorded as an error.
         *
         * @param {string|number} key
         * @returns {{delayMs: number, base: number}|null}
         */
        attempt(key) {
            const base = origin(key);
            return base === null ? null : { delayMs: adjust(key, base), base };
        },

        /** Start these keys over, in both rounds. */
        resetKeys(keys) {
            for (const k of keys) {
                round1.delete(keyOf(k));
                round2.delete(keyOf(k));
            }
        },

        /** Start every key over: a connection has proved itself. */
        resetAll() {
            round1.clear();
            round2.clear();
        },

        /** Back to the first endpoint (the rotation timer ran out). */
        resetRotation() {
            rotated = 0;
        },

        rotateCount: () => rotated,

        snapshot: () => ({
            round1: Object.fromEntries(round1),
            round2: Object.fromEntries(round2),
            rotated,
        }),
    };
}
