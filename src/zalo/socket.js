/**
 * The socket supervisor: keeps one chat socket alive the way the official Zalo
 * Web client does, and stops where it stops (plan items L3, L10, L11, L12, X2).
 *
 * It drives a zca-js `Listener` that is started WITHOUT its own retry: zca-js
 * keeps parsing frames and emitting events; this decides when the socket is
 * dead, when to try again, and when never to.
 *
 * **Dead-socket detection.** A ping goes out right after the key frame and then
 * every `ping_interval` (zca-js sends the periodic ones). Each ping must be
 * echoed within 5 s. A missed echo is not an immediate drop: the ping is asked
 * again after the server's `5013` delay, up to its `max`, and only then is the
 * socket closed and retried under key `5011`. No echo at all for
 * `ping_max_timeout` closes it under `5016`. A socket that does not open in
 * `establish_timeout` (5012) or does not authenticate in `timeout_authen`
 * (5015) is closed and retried the same way.
 *
 * **Retry.** Every close is turned into a retry key by the official client's
 * rules (`_onClose`): 1006 asks a network probe first (it worked: key 4001; it
 * did not: wait for the interval check), 1000 that nobody asked for waits for
 * the interval check, 1001-1015 is `internal`, anything else is retried under
 * its own code. The delay and the endpoint rotation come from `./retry.js`.
 *
 * **Interval check.** Every 10 s while the socket is not open and nothing is
 * scheduled: probe the network, and if it answers, retry. The same tick notices
 * a sleep (a clock that jumped) and asks the socket whether it survived.
 *
 * **A kick is terminal.** The duplicate-session frame (`cmd 3000`), a frame
 * with `error_code 600`, or an HTTP 600 reported by the caller ends the
 * supervisor in the `kicked` state: no reconnect, nothing scheduled. Taking the
 * account back is a person's decision (`takeover()`), never a retry: two
 * clients that each reconnect on a kick evict each other forever.
 *
 * **Maintenance.** An error 70 reported by the caller parks the supervisor
 * until Zalo's maintenance gate says the service is back; no retry ladder runs
 * meanwhile.
 *
 * Differences from the official client, all on the slow side: the retry counters
 * start over only after a connection has stayed authenticated for `stableMs`
 * (the official client resets them at authentication), and a close that nobody
 * asked for and that carries no error is brought back by the interval check
 * instead of staying down.
 */
import { EventEmitter } from "node:events";
import { CLOSE_CODE, RETRY_KEY, SOCKET_ERROR, classifyServerError } from "./errors.js";
import { checkMaintenance, waitOutMaintenance } from "./maintenance.js";
import { createAnomalyHistory, createRetryEngine, resolveSocketSettings } from "./retry.js";

/** The fixed timings of the official client. Every one can be overridden, which tests do. */
export const DEFAULT_TIMING = Object.freeze({
    /** How long a ping may go unechoed before the socket is suspected. */
    pingTimeoutMs: 5000,
    /** How often a closed socket's network is checked, and the beat the clock-jump check rides on. */
    intervalCheckMs: 10_000,
    /** A gap between two beats longer than this means the machine slept. */
    resumeGapMs: 25_000,
    /** How long a connection must stay authenticated before its retry counters start over. */
    stableMs: 60_000,
    /** The size above which a frame is not parsed just to look for an error code. */
    peekLimitBytes: 4096,
});

/** The wait between two questions to the maintenance gate is the poller's own; this only adapts `setTimeout`. */
function abortableSleep(clock) {
    return (ms, signal) =>
        new Promise((resolve) => {
            if (signal?.aborted) return resolve();
            const timer = clock.setTimeout(resolve, ms);
            signal?.addEventListener(
                "abort",
                () => {
                    clock.clearTimeout(timer);
                    resolve();
                },
                { once: true },
            );
        });
}

/**
 * Is the network reachable? One GET; any answer at all counts, because the
 * question is "can this machine reach the internet", not "is Zalo healthy".
 *
 * The target is `ZALO_NET_PROBE`: a URL, or `off` to assume the network is
 * always up (for a machine that must not contact anything but Zalo). The
 * official client asks a global search engine.
 *
 * @param {object} [env]
 * @param {typeof fetch} [fetchFn]
 * @returns {() => Promise<boolean>}
 */
export function createNetworkProbe(env = process.env, fetchFn = fetch) {
    const target = (env.ZALO_NET_PROBE ?? "").trim();
    if (target.toLowerCase() === "off") return async () => true;
    const url = target || "https://www.google.com/generate_204";
    return async () => {
        try {
            await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(5000) });
            return true;
        } catch {
            return false;
        }
    };
}

const globalClock = Object.freeze({
    now: () => Date.now(),
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (...a) => globalThis.clearTimeout(...a),
    setInterval: (...a) => globalThis.setInterval(...a),
    clearInterval: (...a) => globalThis.clearInterval(...a),
});

/**
 * @typedef {"idle"|"connecting"|"connected"|"retrying"|"offline"|"maintenance"|"kicked"|"session-invalid"|"stopped"} SupervisorState
 */

/**
 * Supervises one zca-js Listener.
 *
 * Events: `state` `{state, previous}`; `connected` (the key frame arrived: the socket is usable);
 * `disconnected` `{code, reason, wasConnected, requested}`; `retrying` `{key, delayMs, round, rotate, attempt}`;
 * `kicked` `{via}`; `kickout-info` `{info}` (the reason, when it could be fetched); `session-invalid` `{kind, code}`;
 * `maintenance` `{state}`; `resume`; `fault` `{message}` (a problem inside the supervisor that did not stop it).
 */
export class SocketSupervisor extends EventEmitter {
    /**
     * @param {object} opts
     * @param {object} opts.listener - a zca-js Listener, not started
     * @param {object} [opts.settings] - from `resolveSocketSettings`
     * @param {number} [opts.endpoints] - how many socket endpoints exist (default: `listener.urls.length`)
     * @param {object} [opts.engine] - a retry engine, built from `settings` when omitted
     * @param {object} [opts.anomaly] - the retry history, in-memory when omitted
     * @param {() => Promise<boolean>} [opts.probe] - is the network up
     * @param {object} [opts.clock] - `{now, setTimeout, clearTimeout, setInterval, clearInterval}`
     * @param {() => number} [opts.random]
     * @param {object} [opts.timing] - overrides of {@link DEFAULT_TIMING}
     * @param {() => Promise<unknown>} [opts.kickoutInfo] - fetches the reason for a kick, best effort
     * @param {{check?: Function, sleep?: Function}} [opts.maintenance] - the gate, replaceable for tests
     * @param {(level: string, message: string) => void} [opts.log]
     */
    constructor({
        listener,
        settings = resolveSocketSettings(),
        endpoints,
        engine,
        anomaly,
        probe = createNetworkProbe(),
        clock = globalClock,
        random = Math.random,
        timing = {},
        kickoutInfo,
        maintenance = {},
        log = () => {},
    }) {
        super();
        this.listener = listener;
        this.settings = settings;
        this.clock = clock;
        this.timing = { ...DEFAULT_TIMING, ...timing };
        this.probe = probe;
        this.log = log;
        this.kickoutInfo = kickoutInfo;
        this.maintenance = {
            check: maintenance.check ?? (() => checkMaintenance()),
            sleep: maintenance.sleep ?? abortableSleep(clock),
        };
        this.endpoints = endpoints ?? (Array.isArray(listener.urls) ? listener.urls.length : 1);
        this.engine =
            engine ??
            createRetryEngine({
                settings,
                anomaly: anomaly ?? createAnomalyHistory({ kalpha: settings.anomalous_error_kalpha, now: clock.now }),
                random,
                endpoints: this.endpoints,
            });

        /** @type {SupervisorState} */
        this._state = "idle";
        this._timers = {};
        this._endpointIndex = 0;
        this._stopping = false;
        this._started = false;
        this._kickedVia = null;
        this._retryAfterClose = null;
        this._retryAttempts = 0;
        this._lastPingId = null;
        this._lastPong = 0;
        this._connectedAt = 0;
        this._lastTick = 0;
        this._lastCloseCode = null;
        this._maintenanceAbort = null;
        this._disposed = false;

        this._onOpen = () => this._handleOpen();
        this._onKey = () => this._handleKey();
        this._onDisconnected = (code, reason) => this._handleDisconnected(code, reason);
        // zca-js raises `error` for every socket error and a close always follows; an emitter with
        // no `error` listener throws, so one is always there. The close is what is acted on.
        this._onListenerError = (e) => this.log("debug", `socket error: ${e?.message ?? e?.type ?? "unknown"}`);
        listener.on("connected", this._onOpen);
        listener.on("cipher_key", this._onKey);
        listener.on("disconnected", this._onDisconnected);
        listener.on("error", this._onListenerError);

        // Pings are sent by zca-js (and by this class right after the key frame); watching them go out is how
        // an echo is told from silence. The wrapper changes nothing about what is sent.
        this._originalSendWs = listener.sendWs;
        listener.sendWs = (payload, ...rest) => {
            if (payload?.cmd === 2 && payload?.subCmd === 1) this._notePingSent(payload?.data?.eventId);
            return this._originalSendWs.call(listener, payload, ...rest);
        };
    }

    /** @returns {SupervisorState} */
    get state() {
        return this._state;
    }

    /** What the supervisor is doing, for health and logs. */
    status() {
        return {
            state: this._state,
            endpointIndex: this._endpointIndex,
            retryAttempts: this._retryAttempts,
            lastCloseCode: this._lastCloseCode,
            connectedSince: this._state === "connected" ? this._connectedAt : null,
            lastPongAt: this._lastPong || null,
            kickedVia: this._kickedVia,
            retry: this.engine.snapshot(),
        };
    }

    /** Open the socket and keep it open. Does nothing if already running or ended for good. */
    start() {
        if (this._disposed || this._started) return;
        this._started = true;
        this._stopping = false;
        this._lastTick = this.clock.now();
        this._timers.interval = this.clock.setInterval(() => this._tick(), this.timing.intervalCheckMs);
        this._timers.interval.unref?.();
        this._connect();
    }

    /**
     * Close the socket and stop for good. Resolves once the socket is gone.
     *
     * @returns {Promise<void>}
     */
    stop() {
        if (this._stopping && this._state === "stopped") return Promise.resolve();
        this._stopping = true;
        this._maintenanceAbort?.abort();
        this._clearTimers();
        this._clearInterval();
        if (!this.listener.ws) {
            this._setState("stopped");
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const done = () => resolve();
            this.once("state", done);
            this._closeSocket();
        });
    }

    /**
     * Take the account back after a kick: a deliberate act, never an automatic one.
     *
     * @returns {boolean} whether the supervisor was kicked and has started again
     */
    takeover() {
        if (this._state !== "kicked") return false;
        this._kickedVia = null;
        this._started = false;
        this._stopping = false;
        this._clearInterval();
        this.engine.resetAll();
        this._setState("idle");
        this.start();
        return true;
    }

    /** Stop listening to the listener. The supervisor cannot be used afterwards. */
    dispose() {
        this._disposed = true;
        this._clearTimers();
        this._clearInterval();
        this._maintenanceAbort?.abort();
        this.listener.off("connected", this._onOpen);
        this.listener.off("cipher_key", this._onKey);
        this.listener.off("disconnected", this._onDisconnected);
        this.listener.off("error", this._onListenerError);
        this.listener.sendWs = this._originalSendWs;
    }

    /**
     * Tell the supervisor about a server error code seen outside the socket (an HTTP answer, a
     * login). A kick ends it, a refused session or account parks it for the caller to log in again,
     * and maintenance holds it back until Zalo is up.
     *
     * @param {number|string} code
     * @returns {ReturnType<typeof classifyServerError>} what the code means
     */
    reportServerError(code) {
        const c = classifyServerError(code);
        if (c.kind === "kicked") this._kick("http-600");
        else if (c.kind === "session-invalid" || c.kind === "invalid-account") this._sessionInvalid(c);
        else if (c.kind === "maintenance") this._enterMaintenance();
        return c;
    }

    // ---- state ---------------------------------------------------------------------------------

    _setState(next) {
        if (this._state === next) return;
        const previous = this._state;
        this._state = next;
        this.emit("state", { state: next, previous });
    }

    /** False once the supervisor has ended for good or is held for another decision. */
    _live() {
        return (
            !this._stopping && !this._disposed && !["kicked", "session-invalid", "maintenance"].includes(this._state)
        );
    }

    _clearTimer(name) {
        if (this._timers[name]) {
            this.clock.clearTimeout(this._timers[name]);
            this._timers[name] = null;
        }
    }

    _clearTimers() {
        for (const name of ["establish", "auth", "ping", "pingRetry", "retry", "stable", "close", "resetEndpoint"]) {
            this._clearTimer(name);
        }
    }

    _clearInterval() {
        if (this._timers.interval) {
            this.clock.clearInterval(this._timers.interval);
            this._timers.interval = null;
        }
    }

    // ---- connecting ----------------------------------------------------------------------------

    _applyEndpoint() {
        const urls = this.listener.urls;
        if (!Array.isArray(urls) || urls.length === 0) return;
        const next = new URL(urls[Math.min(this._endpointIndex, urls.length - 1)]);
        const current = new URL(this.listener.wsURL);
        for (const [k, v] of current.searchParams) next.searchParams.set(k, v);
        next.searchParams.set("t", String(this.clock.now()));
        this.listener.wsURL = next.toString();
    }

    _connect() {
        if (!this._live()) return;
        if (this.listener.ws) {
            // The previous socket has not finished closing; try again once it has.
            this._retryAfterClose = RETRY_KEY.INTERNAL;
            this._closeSocket();
            return;
        }
        this._applyEndpoint();
        this._setState("connecting");
        this._timers.establish = this.clock.setTimeout(
            () => this._handleSocketError(SOCKET_ERROR.ESTABLISH_TIMEOUT),
            this.settings.establish_timeout,
        );
        try {
            this.listener.start();
        } catch (e) {
            this._clearTimer("establish");
            this.log("warn", `could not start the socket: ${e.message}`);
            this._scheduleRetry(SOCKET_ERROR.WSS_ERROR);
        }
    }

    _handleOpen() {
        if (!this._live()) return;
        this._clearTimer("establish");
        this._timers.auth = this.clock.setTimeout(
            () => this._handleSocketError(SOCKET_ERROR.AUTH_TIMEOUT),
            this.settings.timeout_authen,
        );
        this.listener.ws?.on("message", (raw) => this._tap(raw));
    }

    _handleKey() {
        if (!this._live()) return;
        this._clearTimer("auth");
        this._connectedAt = this.clock.now();
        this._lastPong = this._connectedAt;
        this._retryAttempts = 0;
        this._setState("connected");
        this._timers.stable = this.clock.setTimeout(() => {
            this._timers.stable = null;
            this.engine.resetAll();
        }, this.timing.stableMs);
        this.emit("connected");
        this._sendPing();
    }

    // ---- ping ----------------------------------------------------------------------------------

    _sendPing() {
        if (this._state !== "connected" || !this.listener.ws) return;
        try {
            this.listener.sendWs({ version: 1, cmd: 2, subCmd: 1, data: { eventId: this.clock.now() } }, false);
        } catch (e) {
            this.log("debug", `ping not sent: ${e.message}`);
        }
    }

    _notePingSent(eventId) {
        this._lastPingId = eventId ?? null;
        if (this._timers.ping || this._state !== "connected") return;
        this._timers.ping = this.clock.setTimeout(() => {
            this._timers.ping = null;
            if (this._state === "connected") this._handleSocketError(SOCKET_ERROR.PING_TIMEOUT);
        }, this.timing.pingTimeoutMs);
    }

    _onPong(top) {
        const id = echoedId(top);
        // An echo whose id cannot be read still answers the one ping that is outstanding.
        if (id !== undefined && this._lastPingId !== null && id !== this._lastPingId) return;
        this._clearTimer("ping");
        this._clearTimer("pingRetry");
        this._lastPong = this.clock.now();
        this.engine.resetKeys([SOCKET_ERROR.PING_PONG, SOCKET_ERROR.PING_TIMEOUT]);
    }

    // ---- frames --------------------------------------------------------------------------------

    _tap(raw) {
        if (!Buffer.isBuffer(raw) || raw.length < 4) return;
        const version = raw[0];
        const cmd = raw.readUInt16LE(1);
        const sub = raw[3];
        if (cmd === 3000 && version === 1 && sub === 0) {
            if (this.settings.kickout_on_max !== false) this._kick("frame-3000");
            return;
        }
        if (cmd !== 2 && raw.length > this.timing.peekLimitBytes) return;
        const top = safeJson(raw.subarray(4).toString("utf8"));
        if (!top) return;
        if (cmd === 2 && sub === 1) return this._onPong(top);
        const code = Number(top.error_code);
        if (!Number.isFinite(code) || code === 0) return;
        const c = classifyServerError(code);
        if (c.kind === "kicked" && this.settings.logout_on_err_kick !== false) this._kick("error-600");
    }

    // ---- errors the client raises about its own socket -----------------------------------------

    _handleSocketError(code) {
        if (!this._live()) return;
        this.log("debug", `socket error ${code}`);
        const list = this.settings.close_and_retry_codes ?? [];
        if (list.includes(code) || list.includes(String(code))) return this._closeAndRetry(code);
        switch (code) {
            case SOCKET_ERROR.PING_TIMEOUT: {
                // Ask again before giving up: a slow echo is not a dead socket. The server's 5013 entry says how often.
                const again = this.engine.attempt(SOCKET_ERROR.PING_PONG);
                if (!again) return this._closeAndRetry(SOCKET_ERROR.PING_TIMEOUT);
                this._timers.pingRetry = this.clock.setTimeout(() => {
                    this._timers.pingRetry = null;
                    this._sendPing();
                }, again.delayMs);
                return;
            }
            case SOCKET_ERROR.ESTABLISH_TIMEOUT:
                this.probe().catch(() => {}); // the answer is only for the log; the retry does not wait for it
                return this._closeAndRetry(SOCKET_ERROR.ESTABLISH_TIMEOUT);
            case SOCKET_ERROR.INVALID_CONFIG:
                this.log("error", "the server sent an unusable socket configuration; not retrying");
                this.stop();
                return;
            default:
                return;
        }
    }

    _closeAndRetry(code) {
        this._retryAfterClose = code;
        if (!this._closeSocket()) {
            this._retryAfterClose = null;
            this._scheduleRetry(code);
        }
    }

    /** Close the socket now; terminate it if the close handshake hangs. @returns {boolean} whether there was a socket */
    _closeSocket() {
        const ws = this.listener.ws;
        if (!ws) return false;
        try {
            ws.close(CLOSE_CODE.NORMAL);
        } catch {
            /* closing a socket that is already going away is fine */
        }
        this._clearTimer("close");
        this._timers.close = this.clock.setTimeout(() => {
            this._timers.close = null;
            try {
                ws.terminate?.();
            } catch {
                /* already gone */
            }
        }, this.settings.close_timeout);
        return true;
    }

    // ---- closes --------------------------------------------------------------------------------

    _handleDisconnected(code, reason) {
        const wasConnected = this._state === "connected";
        this._lastCloseCode = code;
        for (const name of ["establish", "auth", "ping", "pingRetry", "stable", "close"]) this._clearTimer(name);
        this.emit("disconnected", { code, reason: String(reason ?? ""), wasConnected, requested: this._stopping });
        if (this._stopping) return this._setState("stopped");
        if (this._kickedVia || ["kicked", "session-invalid", "maintenance"].includes(this._state)) return;

        const key = this._retryAfterClose;
        this._retryAfterClose = null;
        if (key !== null) return this._scheduleRetry(key);

        if (code === CLOSE_CODE.ABNORMAL) {
            this._setState("offline");
            this.probe()
                .then((up) => {
                    if (!this._live() || this.listener.ws) return;
                    if (up) this._scheduleRetry(RETRY_KEY.CANNOT_REACH_SERVER);
                })
                .catch(() => {});
            return;
        }
        if (code === CLOSE_CODE.NORMAL) {
            // Nobody asked for this close. The interval check brings the socket back.
            this._setState("offline");
            return;
        }
        if (code > CLOSE_CODE.NORMAL && code <= CLOSE_CODE.TLS_HANDSHAKE_FAIL)
            return this._scheduleRetry(RETRY_KEY.INTERNAL);
        // Zalo's own codes and anything unknown are retried under their own key; a key the
        // server's table does not describe waits the default delay.
        this._scheduleRetry(code);
    }

    // ---- retry ---------------------------------------------------------------------------------

    _scheduleRetry(key) {
        if (!this._live()) return;
        if (this._timers.retry) return; // one at a time, as the official client
        const next = this.engine.next(key);
        if (next.rotate) this._rotateEndpoint();
        this._setState("retrying");
        this._retryAttempts += 1;
        this.emit("retrying", {
            key,
            delayMs: Math.round(next.delayMs),
            round: next.round,
            rotate: next.rotate,
            attempt: this._retryAttempts,
        });
        this._timers.retry = this.clock.setTimeout(() => {
            this._timers.retry = null;
            this._connect();
        }, next.delayMs);
    }

    _rotateEndpoint() {
        this._endpointIndex = Math.min(this._endpointIndex + 1, Math.max(0, this.endpoints - 1));
        if (this.settings.reset_endpoint && !this._timers.resetEndpoint) {
            this._timers.resetEndpoint = this.clock.setTimeout(() => {
                this._timers.resetEndpoint = null;
                if (this._endpointIndex === 0) return;
                this._endpointIndex = 0;
                this.engine.resetRotation();
                if (this._live()) this._closeAndRetry(RETRY_KEY.SWAP_ENDPOINT);
            }, this.settings.reset_endpoint);
        }
    }

    // ---- the interval check --------------------------------------------------------------------

    _tick() {
        const now = this.clock.now();
        const gap = now - this._lastTick;
        this._lastTick = now;
        if (!this._live()) return;

        if (gap > this.timing.resumeGapMs) this._handleResume();

        if (this._state === "connected" && now - this._lastPong > this.settings.ping_max_timeout) {
            this._handleSocketError(SOCKET_ERROR.ABNORMAL_STOP_PING);
            return;
        }
        if (!this.listener.ws && !this._timers.retry && this._state !== "connecting") {
            this.probe()
                .then((up) => {
                    if (up && this._live() && !this.listener.ws && !this._timers.retry) {
                        this._scheduleRetry(RETRY_KEY.INTERVAL_CHECK);
                    }
                })
                .catch(() => {});
        }
    }

    _handleResume() {
        this.emit("resume");
        if (this._state === "connected") return this._sendPing(); // a socket that slept may be half open
        if (!this.listener.ws && !this._timers.retry) this._scheduleRetry(RETRY_KEY.SYSTEM_RESUME);
    }

    // ---- the ends ------------------------------------------------------------------------------

    _kick(via) {
        if (this._kickedVia) return;
        this._kickedVia = via;
        this._clearTimers();
        this._maintenanceAbort?.abort();
        this._setState("kicked");
        this.emit("kicked", { via });
        this._closeSocket();
        if (typeof this.kickoutInfo === "function") {
            Promise.resolve()
                .then(() => this.kickoutInfo())
                .then((info) => {
                    if (info !== undefined && info !== null) this.emit("kickout-info", { info });
                })
                .catch((e) => this.log("debug", `kickout reason unavailable: ${e.message}`));
        }
    }

    _sessionInvalid(c) {
        if (["kicked", "session-invalid"].includes(this._state)) return;
        this._clearTimers();
        this._setState("session-invalid");
        this.emit("session-invalid", { kind: c.kind, code: c.code });
        this._closeSocket();
    }

    async _enterMaintenance() {
        if (this._state === "maintenance" || !this._live()) return;
        this._clearTimers();
        this._setState("maintenance");
        this.emit("maintenance", { state: "in-maintenance" });
        this._closeSocket();
        this._maintenanceAbort = new AbortController();
        const result = await waitOutMaintenance({
            check: this.maintenance.check,
            sleep: this.maintenance.sleep,
            onPoll: (state) => this.log("info", `maintenance gate: ${state}`),
            signal: this._maintenanceAbort.signal,
        });
        this._maintenanceAbort = null;
        if (this._stopping || this._disposed || this._state !== "maintenance") return;
        this.emit("maintenance", { state: result.state === "ok" ? "over" : result.state });
        this.engine.resetAll();
        this._setState("idle");
        if (this.listener.ws) {
            this._retryAfterClose = RETRY_KEY.INTERVAL_CHECK;
            return;
        }
        this._connect();
    }
}

/**
 * The id of the ping an echo answers. The official client reads it from the top of the frame body;
 * it is also looked for in `data`, as an object or as JSON text, and one level inside that.
 *
 * @param {object} top - the parsed frame body
 * @returns {number|string|undefined}
 */
function echoedId(top) {
    if (top?.eventId !== undefined) return top.eventId;
    const data = typeof top?.data === "string" ? safeJson(top.data) : top?.data;
    return data?.eventId ?? data?.data?.eventId;
}

/** Parse JSON, or null. */
function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Supervise the listener of a logged-in zca-js API.
 *
 * @param {object} api - a logged-in zca-js API
 * @param {object} [opts] - anything {@link SocketSupervisor} takes; `settings` defaults to the server's
 *   socket settings from this login, resolved over the defaults
 * @returns {SocketSupervisor}
 */
export function superviseListener(api, opts = {}) {
    const serverSocket = api.getContext?.()?.settings?.features?.socket;
    return new SocketSupervisor({
        listener: api.listener,
        settings: resolveSocketSettings(serverSocket),
        ...opts,
    });
}
