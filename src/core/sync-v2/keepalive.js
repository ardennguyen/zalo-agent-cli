/**
 * WebSocket heartbeat for the long idle windows in the socket stages.
 *
 * WHY THIS EXISTS, and why it is not `api.keepAlive()`
 * ---------------------------------------------------
 * zca-js exposes `api.keepAlive()`, which looks like the obvious instrument and
 * is the wrong one: it is an HTTP GET to `<chat host>/keepalive`
 * (`apis/keepAlive.js`). It touches the session, never the socket, so it cannot
 * keep a WebSocket flow warm.
 *
 * What actually keeps this socket warm is Zalo's own application-level ping --
 * `cmd 2 / subCmd 1` carrying `{eventId}`, which the server echoes back
 * verbatim. zca-js already sends it, on an interval the server hands out at
 * login (`settings.features.socket.ping_interval`, measured at **180000 ms**
 * for this account -- the same value a captured Zalo Web session used).
 *
 * So the socket is not unpinged. It is pinged every three minutes, which leaves
 * two problems this module fixes:
 *
 *   1. **Three minutes is the whole idle window.** A restore waiting on the
 *      phone sends nothing and receives nothing for up to the full wait budget,
 *      so the flow can sit silent right up to the server's own liveness bound
 *      with no margin. One late ping means six minutes of silence.
 *   2. **The interval is armed once, on the cipher-key frame, and never
 *      re-phased.** `setInterval` also queues catch-up work when the event loop
 *      blocks -- and the decode/store phase does block it.
 *
 * This sends the same frame Zalo Web sends, on a shorter interval, using a
 * self-rescheduling timer (no catch-up burst after a blocked loop), and counts
 * the echoes so a caller can say how long the socket had been silent before it
 * dropped. It never closes the socket on its own: a missed echo is evidence,
 * not a verdict.
 */

/** Zalo's heartbeat frame: `cmd 2 / subCmd 1`, body `{eventId}`. */
export const PING_CMD = 2;
export const PING_SUBCMD = 1;

/** What the server advises, and what zca-js and Zalo Web both use. */
export const SERVER_PING_INTERVAL_MS = 180000;

/**
 * A third of the server's own interval: three chances to keep the flow warm
 * inside the window the server itself still considers alive, instead of one.
 */
export const DEFAULT_KEEPALIVE_MS = 60000;

/** Never ping faster than this, whatever a caller asks for. */
export const MIN_KEEPALIVE_MS = 15000;

/**
 * Clamp a requested heartbeat interval into a sane range.
 *
 * @param {number|undefined} ms - requested interval
 * @returns {number} a finite interval between MIN_KEEPALIVE_MS and the server's own
 */
export function resolveKeepAliveInterval(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_KEEPALIVE_MS;
    return Math.min(SERVER_PING_INTERVAL_MS, Math.max(MIN_KEEPALIVE_MS, ms));
}

/**
 * The ping payload, in the shape `Listener.sendWs` expects.
 *
 * @param {number} [now=Date.now()] - the eventId the server echoes back
 * @returns {{version: number, cmd: number, subCmd: number, data: {eventId: number}}}
 */
export function pingPayload(now = Date.now()) {
    return { version: 1, cmd: PING_CMD, subCmd: PING_SUBCMD, data: { eventId: now } };
}

/**
 * True for a raw frame that is a `cmd 2 / subCmd 1` heartbeat echo.
 *
 * @param {Buffer} buf - a raw socket frame
 * @returns {boolean}
 */
export function isPingEcho(buf) {
    return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt16LE(1) === PING_CMD && buf[3] === PING_SUBCMD;
}

/**
 * Start pinging a listener's socket until the returned stop function is called.
 *
 * The timer is unref'd, so it can never hold the process open, and it stops
 * rescheduling once the socket is gone -- `sendWs` is a silent no-op on a null
 * socket, so a running timer on a dead wire would just spin.
 *
 * @param {object} listener - a zca-js Listener (needs `sendWs` and `ws`)
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] - heartbeat interval; clamped
 * @param {(info: {sent: number, echoed: number}) => void} [opts.onPing] - called after each ping
 * @param {() => number} [opts.now=Date.now] - injectable clock
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers] - injectable scheduler
 * @returns {{stop: () => void, stats: () => {sent: number, echoed: number, intervalMs: number, silentMs: number}}}
 */
export function startKeepAlive(listener, opts = {}) {
    const intervalMs = resolveKeepAliveInterval(opts.intervalMs);
    const now = typeof opts.now === "function" ? opts.now : Date.now;
    const timers = opts.timers || { setTimeout, clearTimeout };
    const onPing = typeof opts.onPing === "function" ? opts.onPing : () => {};

    let sent = 0;
    let echoed = 0;
    let lastEchoAt = now();
    let handle = null;
    let stopped = false;

    // The echo tap goes on the RAW socket, and a reconnect replaces that object
    // -- so the tap follows the socket rather than being pinned to the one that
    // was there at startup. Without this a keepalive held across a reconnect
    // would keep pinging (sendWs reads `listener.ws` fresh) while silently
    // counting no echoes at all, which is exactly the signal it exists to give.
    const onFrame = (buf) => {
        if (!isPingEcho(buf)) return;
        echoed++;
        lastEchoAt = now();
    };
    let tapped = null;
    const retap = () => {
        const ws = listener?.ws;
        if (ws === tapped) return;
        try {
            tapped?.off?.("message", onFrame);
        } catch {
            /* the old socket is gone; nothing to detach */
        }
        tapped = ws || null;
        try {
            tapped?.on?.("message", onFrame);
        } catch {
            /* a socket shape without events still gets pinged, just uncounted */
        }
    };
    retap();

    const tick = () => {
        if (stopped) return;
        // A closed socket cannot be kept alive, and zca-js nulls `ws` on close,
        // so an absent socket is just as dead as a CLOSING/CLOSED one.
        if (!listener?.ws || listener.ws.readyState > 1) return;
        retap();
        try {
            listener.sendWs(pingPayload(now()), false);
            sent++;
            onPing({ sent, echoed });
        } catch {
            /* a send on a dying socket is not worth failing the run over */
        }
        schedule();
    };

    // setTimeout chaining, not setInterval: a blocked event loop must not queue
    // a burst of catch-up pings the moment it frees up.
    const schedule = () => {
        handle = timers.setTimeout(tick, intervalMs);
        if (typeof handle?.unref === "function") handle.unref();
    };
    schedule();

    return {
        stop() {
            stopped = true;
            if (handle) timers.clearTimeout(handle);
            handle = null;
            try {
                tapped?.off?.("message", onFrame);
            } catch {
                /* already torn down */
            }
            tapped = null;
        },
        stats() {
            return { sent, echoed, intervalMs, silentMs: now() - lastEchoAt };
        },
    };
}
