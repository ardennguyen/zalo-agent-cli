/**
 * What a logged-in Web client does on a timer (plan items L2e and L9), and nothing else.
 *
 *  - **Settings refresh, hourly.** The official client asks `getServerInfo` again every hour, so a long-lived
 *    process follows the server's settings (retry tables, keepalive, maintenance) instead of the ones it
 *    logged in with.
 *  - **HTTP keepalive, only when the server asks for it.** When `settings.keepalive` says `alway_keepalive` or
 *    gives a `keepalive_duration`, `keepAlive()` is called that often (120 s when the duration is 0). It is
 *    reset by every other request, which counts as proof the session is in use, and stops once nothing but
 *    keepalives has gone out for `time_deactive` seconds (300 when unset); the next request starts it again.
 *    The captured session's settings asked for neither, so by default no keepalive traffic is added.
 *
 * Both timers are unref'd: they never keep a process alive. Failures are swallowed: a missed refresh is
 * retried an hour later, a missed keepalive on the next tick.
 */

const HOUR_MS = 3_600_000;
const DEFAULT_KEEPALIVE_S = 120;
const DEFAULT_DEACTIVE_S = 300;

/**
 * The keepalive schedule the settings ask for.
 *
 * @param {object|undefined} settings
 * @returns {{on: boolean, everyMs: number, idleMs: number}}
 */
export function keepAliveSchedule(settings) {
    const k = settings?.keepalive ?? {};
    const duration = Number(k.keepalive_duration);
    return {
        on: !!Number(k.alway_keepalive) || duration > 0,
        everyMs: (duration > 0 ? duration : DEFAULT_KEEPALIVE_S) * 1000,
        idleMs: (Number(k.time_deactive) > 0 ? Number(k.time_deactive) : DEFAULT_DEACTIVE_S) * 1000,
    };
}

/**
 * Start the timers for one session.
 *
 * @param {object} ctx - the zca-js context; `ctx.settings` is read on every tick and `ctx.options.polyfill`
 *   is wrapped to observe requests
 * @param {object} deps
 * @param {() => Promise<unknown>} deps.keepAlive - one keepalive call
 * @param {() => Promise<unknown>} deps.refreshSettings - one settings refresh
 * @param {() => number} [deps.now]
 * @param {{setInterval: Function, clearInterval: Function}} [deps.timers]
 * @returns {{stop: () => void}}
 */
export function startUpkeep(ctx, { keepAlive, refreshSettings, now = Date.now, timers = globalThis }) {
    let lastRequest = now();
    let quiet = false; // true while a keepalive of our own is in flight: it is not proof of use
    let keepTimer = null;
    let stopped = false;

    const unref = (t) => {
        t?.unref?.();
        return t;
    };

    const stopKeepAlive = () => {
        if (keepTimer !== null) timers.clearInterval(keepTimer);
        keepTimer = null;
    };

    // The version of the server's configuration, as the last keepalive answered it. A change means the settings
    // this session holds are out of date, so they are asked for again at once instead of at the next hour.
    let configVersion = null;

    const refresh = () =>
        refreshSettings()
            .then(() => {
                // A new schedule applies from the next start of the keepalive timer.
                stopKeepAlive();
                startKeepAlive();
            })
            .catch(() => {});

    const tick = async () => {
        if (stopped) return;
        if (now() - lastRequest >= keepAliveSchedule(ctx.settings).idleMs) return stopKeepAlive();
        quiet = true;
        let changed = false;
        try {
            const answer = await keepAlive();
            const seen = Number(answer?.config_vesion);
            if (Number.isFinite(seen)) {
                changed = configVersion !== null && seen !== configVersion;
                configVersion = seen;
            }
        } catch {
            /* the next tick tries again */
        } finally {
            quiet = false;
        }
        if (changed && !stopped) await refresh();
    };

    const startKeepAlive = () => {
        const s = keepAliveSchedule(ctx.settings);
        if (!s.on || keepTimer !== null || stopped) return;
        keepTimer = unref(timers.setInterval(tick, s.everyMs));
    };

    const inner = ctx.options.polyfill;
    ctx.options.polyfill = (...args) => {
        if (!quiet) {
            lastRequest = now();
            startKeepAlive();
        }
        return inner(...args);
    };

    const refreshTimer = unref(
        timers.setInterval(() => {
            if (!stopped) void refresh();
        }, HOUR_MS),
    );
    startKeepAlive();

    return {
        stop() {
            stopped = true;
            timers.clearInterval(refreshTimer);
            stopKeepAlive();
        },
    };
}
