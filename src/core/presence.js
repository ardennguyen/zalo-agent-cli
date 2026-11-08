/**
 * On-demand presence: when a daemon holds its account's one Zalo socket, and when it lets it go.
 *
 * A daemon whose consumers come and go (a CRM backend, an MCP server reached over HTTP) does not need the socket
 * while nobody asks for anything. Holding it anyway keeps the account's one web session busy, so the user's own Zalo
 * Web or PC clashes with it, and a fleet of hundreds stays connected for nobody. This module decides; the socket host
 * (./socket-host.js `park()` / `wake()`) executes. It never touches a socket itself and imports nothing from
 * `src/zalo/` (AGENTS.md section 13: the supervisor owns every retry, and only the socket host starts one).
 *
 *  - **Holds.** Anything that needs the socket opens a hold (an MCP tool call, a wait, a CRM lease, a CLI request
 *    routed to the daemon, a stage, the start-up catch-up, a catch-up pulse) and closes it when done. A hold may carry
 *    a time to live. While any hold is open the socket is held; a hold opened while parked wakes it.
 *  - **Park.** After `idleTimeout` with no hold, and never sooner than `minConnected` after the socket came up, the
 *    socket parks. A hold opened while the park is under way aborts it; one opened after it wakes the socket again. A
 *    wake that is still retrying when every hold has closed parks too, so the supervisor stops retrying for nobody.
 *  - **Hysteresis.** More than `maxWakesPerHour` wakes in a rolling hour doubles the idle timeout per wake over the
 *    limit, up to an hour; a quiet hour brings it back.
 *  - **Always-on** is the same machine with one permanent hold, so there is one code path.
 *  - **Yielded.** In on-demand mode a kick (another session of the SAME login took the socket: a second copy of these
 *    credentials, or a second tab of one browser) can end in `yielded` instead of the daemon's exit: the socket is let
 *    go and nothing takes it back on its own. Every hold is refused while yielded (`refusal()`, code `YIELDED`): a tool
 *    call, a lease, a CLI request, a wait. Only an explicit `resume()` (the user confirmed the other session is
 *    closed: `presence resume --yes`, the admin API, MCP) wakes it again (owner decision 2026-11-08).
 *  - **Signed out.** Zalo refuses the saved login (the user QR-logged into Zalo Web elsewhere, which takes the one web
 *    login): `signed-out`. Every hold is refused (code `SIGNED_OUT`), nothing retries, and the daemon stays up so its
 *    API, its status and a QR re-add keep working. Only a new login (a restart after the QR) ends it.
 *  - **Metering.** Connected time and the time waits held the socket are counted for usage (owner decision 2).
 *
 * `listen` and `mcp start` both drive it through ./daemon-presence.js (one wiring, so the two cannot differ).
 */

/** The presence modes. */
export const PRESENCE_MODES = Object.freeze(["on-demand", "always-on"]);

/** What a kick does in on-demand mode: end the daemon (exit 3, as always-on), or let the socket go and wait. */
export const KICK_ACTIONS = Object.freeze(["yield", "exit"]);

/** The presence states. `account_state` maps them (./account-state.js). */
export const PRESENCE_STATES = Object.freeze([
    "parked",
    "waking",
    "connected",
    "parking",
    "yielded",
    "signed-out",
    "stopped",
]);

/** What a refused hold says, per state: the error code and the words a person reads. */
export const REFUSALS = Object.freeze({
    yielded: {
        code: "YIELDED",
        message:
            "Another session of this login holds this account's socket (a second copy of these credentials, or a " +
            "second tab of the same browser). Close it, then confirm with `zalo-agent presence resume --yes`, the " +
            "admin API (POST /zalo/admin/presence/resume) or MCP (zalo_profile action presence_resume); nothing " +
            "takes the account back on its own.",
    },
    "signed-out": {
        code: "SIGNED_OUT",
        message:
            "Zalo refuses this account's saved login: another browser or device took the web login (a Zalo Web QR " +
            "login elsewhere). Add the account again by QR (`zalo-agent login`, or the fleet controller's QR add).",
    },
});

/** The shortest idle timeout a setting may ask for. */
export const MIN_IDLE_TIMEOUT_MS = 30_000;

/** The longest the hysteresis stretches the idle timeout. */
export const MAX_STRETCH_MS = 60 * 60_000;

/** The window the wake count is taken over. */
export const WAKE_WINDOW_MS = 60 * 60_000;

/** A pulse or start-up hold that never hears "caught up" is released after this long. */
export const CATCH_UP_HOLD_MAX_MS = 5 * 60_000;

/** The built-in settings (owner decisions 2026-11-08: pulse off, connect on start). */
export const PRESENCE_DEFAULTS = Object.freeze({
    mode: "on-demand",
    idleTimeoutMs: 5 * 60_000,
    minConnectedMs: 60_000,
    maxWakesPerHour: 12,
    warmWaitMs: 10_000,
    connectOnStart: true,
    catchUpEveryMs: 0,
    maxLeases: 64,
    leaseTtlMs: 90_000,
    leaseTtlMaxMs: 600_000,
    waitHoldsSocket: true,
    onKick: "yield",
});

/**
 * The hold kinds. `metered`: its held time is counted on its own (`waitHeldMs`). No kind wakes a yielded or signed-out
 * socket: only `resume()` does (yielded), or a new login (signed out).
 */
export const HOLD_KINDS = Object.freeze({
    "always-on": {},
    tool: {},
    wait: { metered: true },
    lease: {},
    channel: {},
    manual: {},
    stage: {},
    start: {},
    pulse: {},
    receipts: {},
});

/** A failed or aborted park is not tried again sooner than this (a host that cannot park now must not spin). */
export const PARK_RETRY_MS = 15_000;

const realClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
    },
    clearTimeout: (t) => clearTimeout(t),
};

/**
 * A deterministic offset in `[0, periodMs)` for one account, so a fleet's pulses are spread over the period instead
 * of firing together (FNV-1a of the id).
 *
 * @param {string} ownId
 * @param {number} periodMs
 * @returns {number}
 */
export function pulseOffsetMs(ownId, periodMs) {
    if (!(periodMs > 0)) return 0;
    let h = 0x811c9dc5;
    for (const ch of String(ownId ?? "")) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % Math.floor(periodMs);
}

/**
 * The idle timeout after the hysteresis: doubled per wake over the limit in the last hour, at most an hour (or the
 * base, when the base is longer).
 *
 * @param {number} baseMs
 * @param {number} wakesLastHour
 * @param {number} maxWakesPerHour
 * @returns {number}
 */
export function stretchedIdleMs(baseMs, wakesLastHour, maxWakesPerHour) {
    const over = Math.max(0, wakesLastHour - maxWakesPerHour);
    if (!over) return baseMs;
    return Math.max(baseMs, Math.min(baseMs * 2 ** Math.min(over, 30), MAX_STRETCH_MS));
}

/**
 * Normalize settings over the defaults (numbers in milliseconds; an idle timeout under the floor is raised to it).
 *
 * @param {object} [s]
 * @returns {typeof PRESENCE_DEFAULTS}
 */
export function normalizePresenceSettings(s = {}) {
    const out = { ...PRESENCE_DEFAULTS };
    for (const [k, v] of Object.entries(s ?? {})) if (k in out && v !== undefined && v !== null) out[k] = v;
    if (!PRESENCE_MODES.includes(out.mode)) out.mode = PRESENCE_DEFAULTS.mode;
    if (!KICK_ACTIONS.includes(out.onKick)) out.onKick = PRESENCE_DEFAULTS.onKick;
    out.idleTimeoutMs = Math.max(MIN_IDLE_TIMEOUT_MS, Number(out.idleTimeoutMs) || PRESENCE_DEFAULTS.idleTimeoutMs);
    out.minConnectedMs = Math.max(0, Number(out.minConnectedMs) || 0);
    out.maxWakesPerHour = Math.max(1, Math.floor(Number(out.maxWakesPerHour) || PRESENCE_DEFAULTS.maxWakesPerHour));
    out.catchUpEveryMs = Math.max(0, Number(out.catchUpEveryMs) || 0);
    return out;
}

/**
 * Build one daemon's presence.
 *
 * @param {object} args
 * @param {string} args.ownId - for the pulse offset only
 * @param {{wake: (why: string) => unknown, park: (opts: {aborted: () => boolean}) => Promise<boolean>}} args.host -
 *   the socket host's side: `wake` starts a supervisor on the current session; `park` stops it (resolving false when
 *   it was aborted or could not park now)
 * @param {object} [args.settings] - see {@link PRESENCE_DEFAULTS}
 * @param {{now: () => number, setTimeout: Function, clearTimeout: Function}} [args.clock]
 * @param {() => number} [args.random] - the pulse jitter
 * @param {(state: string, previous: string, detail: object) => void} [args.onState]
 * @param {(line: string) => void} [args.log]
 * @returns {object}
 */
export function createPresence({
    ownId,
    host,
    settings = {},
    clock = realClock,
    random = Math.random,
    onState = () => {},
    log = () => {},
}) {
    let cfg = normalizePresenceSettings(settings);
    let state = "parked";
    let started = false;
    let socket = null;
    const holds = new Map();
    let nextHoldId = 1;
    let lastHoldEnd = clock.now();
    let connectedAt = null;
    let wakeStartedAt = null;
    let parkedAt = null;
    let yieldedAt = null;
    let lastWakeMs = null;
    let lastCatchUpMs = null;
    let wakes = [];
    let idleTimer = null;
    let pulseTimer = null;
    let alwaysOnHold = null;
    let parkPromise = null;
    // A park that failed or was aborted is not asked again before this time.
    let parkRetryAt = 0;
    // A wake's (or a reconnect's) catch-up has not reported done yet.
    let catchUpPending = false;
    // Callers waiting for the socket (waitReady), checked on every state change and catch-up.
    const waiters = new Set();
    const meter = { connectedMs: 0, waitHeldMs: 0, wakes: 0, parks: 0, yields: 0 };

    const now = () => clock.now();
    const pruneWakes = () => {
        const cut = now() - WAKE_WINDOW_MS;
        wakes = wakes.filter((t) => t > cut);
    };
    const effectiveIdleMs = () => {
        pruneWakes();
        return stretchedIdleMs(cfg.idleTimeoutMs, wakes.length, cfg.maxWakesPerHour);
    };

    function setState(next, detail = {}) {
        if (state === next) return;
        const previous = state;
        if (previous === "connected" && connectedAt !== null) meter.connectedMs += now() - connectedAt;
        state = next;
        if (next === "connected") connectedAt = now();
        else if (previous === "connected") connectedAt = null;
        try {
            onState(next, previous, { mode: cfg.mode, ...detail });
        } catch (e) {
            log(`presence: a state hook failed: ${e?.message ?? e}`);
        }
        settleWaiters();
        schedule();
    }

    /** Whether the socket is up (and, when asked, its catch-up done). */
    const isReady = (caughtUp) => state === "connected" && (!caughtUp || !catchUpPending);

    function settleWaiters() {
        for (const w of [...waiters]) {
            if (isReady(w.caughtUp)) w.done(true);
            else if (REFUSALS[state] || state === "stopped") w.done(false);
        }
    }

    function clearIdle() {
        if (idleTimer) clock.clearTimeout(idleTimer);
        idleTimer = null;
    }

    /** (Re)arm the idle clock, or disarm it. */
    function schedule() {
        clearIdle();
        if (!started || holds.size > 0) return;
        if (state !== "connected" && state !== "waking") return;
        let due = Math.max(lastHoldEnd + effectiveIdleMs(), parkRetryAt);
        if (state === "connected" && connectedAt !== null) due = Math.max(due, connectedAt + cfg.minConnectedMs);
        idleTimer = clock.setTimeout(onIdle, Math.max(0, due - now()));
    }

    function onIdle() {
        idleTimer = null;
        if (holds.size > 0 || (state !== "connected" && state !== "waking")) return;
        let due = Math.max(lastHoldEnd + effectiveIdleMs(), parkRetryAt);
        if (state === "connected" && connectedAt !== null) due = Math.max(due, connectedAt + cfg.minConnectedMs);
        if (now() < due) return schedule();
        void park("idle");
    }

    async function park(why) {
        if (parkPromise) return parkPromise;
        if (state !== "connected" && state !== "waking") return false;
        const from = state;
        setState("parking", { reason: why });
        parkPromise = (async () => {
            let ok = false;
            try {
                ok = await host.park({ aborted: () => holds.size > 0 });
            } catch (e) {
                log(`presence: the park failed: ${e?.message ?? e}`);
                ok = false;
            }
            parkPromise = null;
            if (state !== "parking") return ok; // stopped, yielded or signed out meanwhile
            if (!ok) {
                parkRetryAt = now() + PARK_RETRY_MS;
                setState(from === "connected" && socket === "connected" ? "connected" : "waking", {
                    reason: "aborted",
                });
                return false;
            }
            meter.parks++;
            parkedAt = now();
            setState("parked", { reason: why });
            log(`presence: parked (${why})`);
            if (holds.size > 0) wake(firstHoldKind());
            return true;
        })();
        return parkPromise;
    }

    function firstHoldKind() {
        for (const h of holds.values()) return h.kind;
        return "manual";
    }

    function wake(why) {
        if (state !== "parked" && state !== "yielded") return false;
        catchUpPending = true;
        pruneWakes();
        wakes.push(now());
        meter.wakes++;
        wakeStartedAt = now();
        yieldedAt = null;
        setState("waking", { reason: why });
        log(`presence: waking (${why})`);
        try {
            host.wake(why);
        } catch (e) {
            log(`presence: the wake failed: ${e?.message ?? e}`);
        }
        return true;
    }

    function release(id) {
        const h = holds.get(id);
        if (!h) return false;
        if (h.timer) clock.clearTimeout(h.timer);
        holds.delete(id);
        if (HOLD_KINDS[h.kind]?.metered) meter.waitHeldMs += now() - h.openedAt;
        if (holds.size === 0) {
            lastHoldEnd = now();
            schedule();
        }
        return true;
    }

    function armExpiry(h, ttlMs) {
        if (h.timer) clock.clearTimeout(h.timer);
        h.timer = null;
        h.expiresAt = null;
        if (ttlMs > 0) {
            h.expiresAt = now() + ttlMs;
            h.timer = clock.setTimeout(() => release(h.id), ttlMs);
        }
    }

    const noop = (kind) => ({ id: null, kind, held: false, release: () => false, renew: () => false });

    /**
     * Open a hold.
     *
     * @param {string} kind - one of {@link HOLD_KINDS}
     * @param {{ttlMs?: number}} [opts]
     * @returns {{id: number|null, kind: string, held: boolean, release: () => boolean, renew: (ttlMs?: number) => boolean,
     *   expiresAt?: number|null}}
     */
    function hold(kind, { ttlMs = 0 } = {}) {
        if (!HOLD_KINDS[kind]) throw new Error(`unknown presence hold kind "${kind}"`);
        if (state === "stopped") return noop(kind);
        // Yielded or signed out: nothing takes the account back on its own (owner decision 2026-11-08).
        if (REFUSALS[state]) return { ...noop(kind), refused: REFUSALS[state].code };
        // A long-poll that does not hold the socket (a tier with waitHoldsSocket off) only waits for the next connect.
        if (kind === "wait" && !cfg.waitHoldsSocket) return noop(kind);
        return openHold(kind, ttlMs);
    }

    function openHold(kind, ttlMs) {
        const h = { id: nextHoldId++, kind, openedAt: now(), expiresAt: null, timer: null };
        holds.set(h.id, h);
        armExpiry(h, ttlMs);
        clearIdle();
        if (started && state === "parked") wake(kind);
        return {
            id: h.id,
            kind,
            held: true,
            get expiresAt() {
                return h.expiresAt;
            },
            release: () => release(h.id),
            renew: (ms = ttlMs) => {
                if (!holds.has(h.id)) return false;
                armExpiry(h, ms);
                return true;
            },
        };
    }

    function releaseKinds(kinds) {
        for (const h of [...holds.values()]) if (kinds.includes(h.kind)) release(h.id);
    }

    function catchUpHold(kind) {
        if ([...holds.values()].some((h) => h.kind === kind)) return null;
        return hold(kind, { ttlMs: CATCH_UP_HOLD_MAX_MS });
    }

    function applyMode() {
        if (cfg.mode === "always-on") {
            if (!alwaysOnHold) alwaysOnHold = hold("always-on");
        } else if (alwaysOnHold) {
            const h = alwaysOnHold;
            alwaysOnHold = null;
            h.release();
        }
    }

    function armPulse(first) {
        if (pulseTimer) clock.clearTimeout(pulseTimer);
        pulseTimer = null;
        const period = cfg.catchUpEveryMs;
        if (!started || !(period > 0)) return;
        const jitter = (random() * 2 - 1) * 0.1 * period;
        const delay = first ? pulseOffsetMs(ownId, period) : Math.max(1000, Math.round(period + jitter));
        pulseTimer = clock.setTimeout(() => {
            pulseTimer = null;
            if (state === "parked") catchUpHold("pulse");
            armPulse(false);
        }, delay);
    }

    const api = {
        /** Begin: the always-on hold, or the start-up catch-up, or stay parked. */
        start() {
            if (started) return;
            started = true;
            applyMode();
            if (cfg.mode !== "always-on" && cfg.connectOnStart) catchUpHold("start");
            if (holds.size > 0) wake(firstHoldKind());
            else {
                parkedAt = now();
                try {
                    onState("parked", "parked", { mode: cfg.mode, reason: "start" });
                } catch {
                    /* a hook failure is not presence's */
                }
            }
            armPulse(true);
        },

        hold,

        /**
         * What the supervisor says (its `state` event): `connected` ends a wake; a drop while connected is a wake again.
         *
         * @param {string} s - a supervisor state
         */
        noteSocketState(s) {
            socket = s;
            if (s === "connected") {
                if (state === "waking") {
                    if (wakeStartedAt !== null) lastWakeMs = now() - wakeStartedAt;
                    wakeStartedAt = null;
                    setState("connected");
                }
                return;
            }
            if (["connecting", "retrying", "offline", "maintenance", "session-invalid"].includes(s)) {
                if (state === "connected") {
                    wakeStartedAt = now();
                    catchUpPending = true;
                    setState("waking", { socket: s });
                }
            }
        },

        /** The catch-up after a handshake is done: the start-up and pulse holds end. */
        noteCatchUpDone({ ms } = {}) {
            if (typeof ms === "number") lastCatchUpMs = ms;
            catchUpPending = false;
            releaseKinds(["start", "pulse"]);
            settleWaiters();
        },

        /**
         * Wait until the socket is up (and its catch-up done, with `caughtUp`), at most `timeoutMs`.
         *
         * @param {{timeoutMs?: number, caughtUp?: boolean}} [o]
         * @returns {Promise<boolean>} whether it is ready
         */
        waitReady({ timeoutMs = cfg.warmWaitMs, caughtUp = false } = {}) {
            if (isReady(caughtUp)) return Promise.resolve(true);
            if (REFUSALS[state] || state === "stopped" || !(timeoutMs > 0)) return Promise.resolve(false);
            return new Promise((resolve) => {
                const w = {
                    caughtUp,
                    timer: null,
                    done: (ready) => {
                        if (!waiters.delete(w)) return;
                        clock.clearTimeout(w.timer);
                        resolve(ready);
                    },
                };
                waiters.add(w);
                w.timer = clock.setTimeout(() => w.done(isReady(caughtUp)), timeoutMs);
            });
        },

        /** Whether the last wake's catch-up is still running. */
        get catchingUp() {
            return catchUpPending;
        },

        /**
         * Why a hold would be refused now: `{code, message, state}` while yielded (`YIELDED`) or signed out
         * (`SIGNED_OUT`), else null.
         *
         * @returns {{code: string, message: string, state: string}|null}
         */
        refusal() {
            return REFUSALS[state] ? { ...REFUSALS[state], state } : null;
        },

        /**
         * The user confirmed the other session is closed: take the account back, with a short manual hold so it parks
         * again after the idle timeout when nothing else needs it. Only from `yielded`.
         *
         * @param {{ttlMs?: number}} [o]
         * @returns {{resumed: boolean, state: string, reason?: string}}
         */
        resume({ ttlMs = cfg.minConnectedMs || 60_000 } = {}) {
            if (state !== "yielded") {
                return {
                    resumed: false,
                    state,
                    reason:
                        state === "signed-out"
                            ? REFUSALS["signed-out"].message
                            : "the account is not yielded: there is nothing to resume",
                };
            }
            log("presence: resumed on the user's confirmation");
            openHold("manual", ttlMs);
            wake("resume");
            return { resumed: true, state };
        },

        /**
         * Zalo refuses the saved login: every hold ends, nothing retries, and every new hold is refused until a new
         * login (the daemon stays up).
         */
        noteSignedOut() {
            if (state === "stopped" || state === "signed-out") return;
            clearIdle();
            if (pulseTimer) clock.clearTimeout(pulseTimer);
            pulseTimer = null;
            for (const h of holds.values()) if (h.timer) clock.clearTimeout(h.timer);
            holds.clear();
            alwaysOnHold = null;
            catchUpPending = false;
            setState("signed-out", { reason: "login refused" });
            log("presence: signed out (Zalo refuses the saved login); waiting for a new login");
        },

        /**
         * Another session took the account. In on-demand mode with `onKick: "yield"` the socket is let go and the
         * daemon stays up; otherwise the caller ends the daemon (exit 3) as always.
         *
         * @returns {"yield"|"exit"}
         */
        noteKicked() {
            if (cfg.mode !== "on-demand" || cfg.onKick !== "yield" || state === "stopped") return "exit";
            meter.yields++;
            yieldedAt = now();
            // Background holds end here; the rest stay open but wake nothing until a resume.
            releaseKinds(["start", "pulse", "stage", "receipts"]);
            catchUpPending = false;
            setState("yielded", { reason: "kicked" });
            log("presence: another session took the account; yielded until the user confirms a resume");
            return "yield";
        },

        /** Park now (a manual override), still not before `minConnected`. @returns {Promise<boolean>} */
        async parkNow() {
            if (state !== "connected" && state !== "waking") return false;
            if (state === "connected" && connectedAt !== null && now() - connectedAt < cfg.minConnectedMs) return false;
            const manual = [...holds.values()].filter((h) => h.kind === "manual");
            for (const h of manual) release(h.id);
            if (holds.size > 0) return false;
            return park("manual");
        },

        /** Wake now (a manual override): a short manual hold, released after the idle timeout's own clock. */
        wakeNow({ ttlMs = cfg.minConnectedMs || 60_000 } = {}) {
            const h = hold("manual", { ttlMs });
            return { woke: state === "waking", hold: h, ...(h.refused ? { refused: h.refused } : {}) };
        },

        /**
         * Change the settings while running (a policy change). A switch to always-on adds the permanent hold at once;
         * a switch to on-demand removes it and starts the idle clock.
         *
         * @param {object} next
         */
        update(next) {
            const before = cfg.mode;
            cfg = normalizePresenceSettings({ ...cfg, ...next });
            if (started && state !== "signed-out" && state !== "stopped") {
                applyMode();
                if (before !== cfg.mode) log(`presence: mode ${before} -> ${cfg.mode}`);
                armPulse(true);
            }
            schedule();
        },

        /** Stop for good (the daemon is shutting down): every timer, every hold. */
        stop() {
            clearIdle();
            if (pulseTimer) clock.clearTimeout(pulseTimer);
            pulseTimer = null;
            for (const h of holds.values()) if (h.timer) clock.clearTimeout(h.timer);
            holds.clear();
            setState("stopped");
            for (const w of [...waiters]) w.done(false);
        },

        /** @returns {string} */
        get state() {
            return state;
        },

        /** @returns {typeof PRESENCE_DEFAULTS} */
        get settings() {
            return { ...cfg };
        },

        /** Whether a hold of this kind is open. */
        holding: (kind) => [...holds.values()].some((h) => !kind || h.kind === kind),

        /** For `/status`, `GET /zalo/presence` and `/metrics`. No holder ids, only counts. */
        snapshot() {
            const t = now();
            const byKind = {};
            for (const h of holds.values()) byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
            let waitHeldMs = meter.waitHeldMs;
            for (const h of holds.values()) if (HOLD_KINDS[h.kind]?.metered) waitHeldMs += t - h.openedAt;
            const idleMs = effectiveIdleMs();
            let idleAt = null;
            if (holds.size === 0 && (state === "connected" || state === "waking")) {
                idleAt = lastHoldEnd + idleMs;
                if (state === "connected" && connectedAt !== null)
                    idleAt = Math.max(idleAt, connectedAt + cfg.minConnectedMs);
            }
            return {
                mode: cfg.mode,
                state,
                socket,
                holds: byKind,
                idleAt: idleAt === null ? null : new Date(idleAt).toISOString(),
                idleTimeoutMs: idleMs,
                wakesLastHour: wakes.length,
                parkedAt: state === "parked" && parkedAt !== null ? new Date(parkedAt).toISOString() : null,
                yieldedAt: yieldedAt === null ? null : new Date(yieldedAt).toISOString(),
                catchUp: catchUpPending,
                lastWakeMs,
                lastCatchUpMs,
                meter: {
                    connectedMs:
                        meter.connectedMs + (state === "connected" && connectedAt !== null ? t - connectedAt : 0),
                    waitHeldMs,
                    wakes: meter.wakes,
                    parks: meter.parks,
                    yields: meter.yields,
                },
            };
        },
    };
    return api;
}
