/**
 * What a daemon writes to daemon.log while it works, beyond the one-line events.
 *
 * Run directly, `zalo-agent sync` prints every phase as it happens. Run by a
 * daemon -- the same restore, started by `zalo-agent sync` over the loopback
 * channel or by the MCP tool `zalo_sync` -- the progress went to the CLI that
 * asked, or into a 20-event ring behind `zalo_sync_status`, and daemon.log got
 * "running the messages stage" and, much later, "finished" or "failed: <one
 * line>". When a 100,000-message restore died with close code 1006 or hit a
 * lookup limit, the log held nothing that said what the restore was doing, how
 * long it had been going, or whether the process had been too busy to answer
 * the socket's pings.
 *
 * Three small pieces fix that, each taking its `log` as an argument so a
 * daemon decides where lines go and tests can read them:
 *
 *   - createStageLogger: one stage's parameters, every progress phase with the
 *     time since it started, a periodic "still running" line, and the result
 *     or the failure with its code and cause.
 *   - startEventLoopMonitor: a stall of the event loop, in seconds. The restore
 *     decodes and stores on the same thread that answers the socket, and a
 *     blocked loop is the one cause of a bare close 1006 that nothing else
 *     records.
 *   - createSocketContext: what to say about the socket when it closes -- how
 *     long it was up, what stage was running, how bad the worst stall was.
 */

/** A stall shorter than this is not worth a line. */
export const DEFAULT_STALL_WARN_MS = 3000;

const seconds = (ms) => (ms / 1000).toFixed(1);

/** `1h02m03s`, `4m05s` or `7s`. */
export function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
    if (m) return `${m}m${String(s).padStart(2, "0")}s`;
    return `${s}s`;
}

/**
 * An error with everything that helps: its type, message, Zalo's code, the
 * cause chain and the top of the stack.
 *
 * @param {unknown} e
 * @returns {string}
 */
export function describeError(e) {
    if (!e || typeof e !== "object") return String(e);
    const parts = [`${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message ?? String(e)}`];
    if (e.code !== undefined && e.code !== null) parts.push(`(code ${e.code})`);
    let cause = e.cause;
    for (let depth = 0; cause && depth < 3; depth++, cause = cause.cause) {
        parts.push(
            `<- ${cause.name && cause.name !== "Error" ? `${cause.name}: ` : ""}${cause.message ?? String(cause)}`,
        );
    }
    const stack = String(e.stack || "")
        .split("\n")
        .slice(1, 4)
        .map((l) => l.trim())
        .filter(Boolean);
    return stack.length ? `${parts.join(" ")} [${stack.join(" | ")}]` : parts.join(" ");
}

/**
 * Scalar fields of a result as `key=value`, for the "finished" line.
 *
 * @param {unknown} result
 * @returns {string}
 */
export function summarizeResult(result) {
    if (!result || typeof result !== "object") return result === undefined ? "" : String(result);
    return Object.entries(result)
        .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v) && String(v).length <= 80)
        .slice(0, 14)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
}

/**
 * Start watching the event loop for stalls.
 *
 * @param {object} args
 * @param {(message: string) => void} args.log
 * @param {number} [args.warnMs] - stalls at least this long are logged
 * @param {number} [args.intervalMs]
 * @param {() => string} [args.context] - what to add to a stall line, e.g. the running stage
 * @param {() => number} [args.now] - test seam
 * @param {{setInterval: Function, clearInterval: Function}} [args.timers] - test seam
 * @returns {{stop: () => void, takeMax: () => number, tick: () => void}} `takeMax` returns
 *   the worst stall in ms since the last call and resets it; `tick` is exposed for tests
 */
export function startEventLoopMonitor({
    log,
    warnMs = DEFAULT_STALL_WARN_MS,
    intervalMs = 1000,
    context = () => "",
    now = Date.now,
    timers = { setInterval, clearInterval },
}) {
    let last = now();
    let max = 0;
    const tick = () => {
        const t = now();
        const stall = Math.max(0, t - last - intervalMs);
        last = t;
        if (stall > max) max = stall;
        if (stall >= warnMs) {
            const where = context();
            log(
                `event loop was blocked for ${seconds(stall)}s${where ? ` while ${where}` : ""}: ` +
                    "socket pings and reads were not served in that time",
            );
        }
    };
    const id = timers.setInterval(tick, intervalMs);
    id?.unref?.();
    return {
        tick,
        stop: () => timers.clearInterval(id),
        takeMax: () => {
            const m = max;
            max = 0;
            return m;
        },
    };
}

/**
 * Logging for one sync stage run.
 *
 * `live` events (a live message stored while the stage runs) can be one per
 * message, so they are counted and summarized, not printed one by one.
 *
 * @param {object} args
 * @param {string} args.stage - "messages", "reactions", "history"
 * @param {(message: string) => void} args.log
 * @param {number} [args.heartbeatMs] - how often a "still running" line is written
 * @param {number} [args.liveFlushMs] - how often the live-event count is written
 * @param {() => number} [args.now] - test seam
 * @param {{setInterval: Function, clearInterval: Function}} [args.timers] - test seam
 * @param {{takeMax: () => number}} [args.monitor] - event-loop monitor, for the worst stall per interval
 * @returns {{start: (params?: object) => void, event: (e: object) => void,
 *   finish: (result?: unknown) => void, fail: (error: unknown) => void, stop: () => void}}
 */
export function createStageLogger({
    stage,
    log,
    heartbeatMs = 60000,
    liveFlushMs = 30000,
    now = Date.now,
    timers = { setInterval, clearInterval },
    monitor = null,
}) {
    const tag = `[sync:${stage}]`;
    let startedAt = now();
    let lastEventAt = startedAt;
    let lastEvent = "";
    let liveCount = 0;
    let liveFlushedAt = startedAt;
    let timer = null;

    const elapsed = () => formatDuration(now() - startedAt);
    const flushLive = () => {
        if (!liveCount) return;
        log(`${tag} +${elapsed()} stored ${liveCount} live event(s) while running`);
        liveCount = 0;
        liveFlushedAt = now();
    };
    const heartbeat = () => {
        const quiet = now() - lastEventAt;
        const stall = monitor?.takeMax?.() ?? 0;
        log(
            `${tag} still running: +${elapsed()}, last progress ${formatDuration(quiet)} ago` +
                (lastEvent ? ` (${lastEvent})` : "") +
                (stall >= 1000 ? `, worst event-loop stall ${seconds(stall)}s` : ""),
        );
    };

    return {
        start(params = {}) {
            startedAt = now();
            lastEventAt = startedAt;
            liveFlushedAt = startedAt;
            const shown = Object.entries(params || {})
                .filter(([, v]) => v !== undefined && v !== null && typeof v !== "object")
                .map(([k, v]) => `${k}=${v}`)
                .join(" ");
            log(`${tag} started${shown ? ` (${shown})` : ""}`);
            timer = timers.setInterval(heartbeat, heartbeatMs);
            timer?.unref?.();
        },
        event(e) {
            const phase = String(e?.phase ?? "progress");
            lastEventAt = now();
            if (phase === "live") {
                liveCount++;
                if (now() - liveFlushedAt >= liveFlushMs) flushLive();
                return;
            }
            const detail = String(e?.detail ?? "");
            lastEvent = `${phase}${detail ? `: ${detail.slice(0, 80)}` : ""}`;
            log(`${tag} +${elapsed()} ${phase}${detail ? `: ${detail}` : ""}`);
        },
        finish(result) {
            flushLive();
            const summary = summarizeResult(result);
            log(`${tag} finished in ${elapsed()}${summary ? `: ${summary}` : ""}`);
        },
        fail(error) {
            flushLive();
            log(`${tag} failed after ${elapsed()}: ${describeError(error)}`);
        },
        stop() {
            if (timer) timers.clearInterval(timer);
            timer = null;
        },
    };
}

/**
 * What to say about the socket when it drops or closes.
 *
 * @param {object} args
 * @param {{current: () => ({stage: string, startedAt: number}|null)}} [args.lock] - the daemon's stage lock
 * @param {{takeMax: () => number}} [args.monitor] - event-loop monitor
 * @param {() => number} [args.now] - test seam
 * @returns {{markUp: () => void, describe: () => string}}
 */
export function createSocketContext({ lock = null, monitor = null, now = Date.now } = {}) {
    let upSince = null;
    return {
        markUp() {
            upSince = now();
        },
        describe() {
            const parts = [];
            parts.push(upSince === null ? "socket age unknown" : `socket was up ${formatDuration(now() - upSince)}`);
            const held = lock?.current?.();
            if (held) parts.push(`stage in progress: ${held.stage} for ${formatDuration(now() - held.startedAt)}`);
            const stall = monitor?.takeMax?.() ?? 0;
            if (stall >= 1000) parts.push(`worst event-loop stall since the last check ${seconds(stall)}s`);
            return parts.join("; ");
        },
    };
}
