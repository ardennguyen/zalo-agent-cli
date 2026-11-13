/**
 * How a long-running daemon (`listen`, `mcp start`) keeps its one socket alive.
 *
 * `listen` and `mcp start` are two entry points to the same socket, so this is
 * written once and both call it (AGENTS.md section 13: any asymmetry between
 * them is a defect). Before it, each carried its own copy of a recovery ladder:
 * let the listener retry, then on `closed` log in again after 5 s, once more after
 * 30 s, then exit. That ladder reconnected on a duplicate-session close until
 * its retries ran out, which evicted the other session again and again, and it
 * ran the same way for every cause.
 *
 * Now the socket supervisor (src/zalo/socket.js) owns the socket and this owns
 * what the daemon does around it:
 *
 *  - **kicked**: another session took the account. The daemon ends with its own
 *    exit code and does not come back by itself.
 *  - **session refused, or stuck**: the socket cannot be kept alive on this
 *    session. Log in again, and only then. A login that Zalo refuses three times
 *    in a row ends the daemon with its own exit code; a login that fails because
 *    the network is down is asked again, slowly, for as long as it takes.
 *  - **maintenance**: a login that fails because Zalo is in maintenance waits for
 *    the maintenance gate instead of retrying.
 *  - everything else (drops, silence, sleep) is the supervisor's.
 */
import { classifyServerError, errorCodeOf } from "../zalo/errors.js";
import { EXIT_CODE } from "./exit-codes.js";
import { checkMaintenance, maintenanceKeysOf, waitOutMaintenance } from "../zalo/maintenance.js";
import { lookupKickout } from "../zalo/kickout.js";
import { loadAnomalyState, saveAnomalyState } from "../zalo/anomaly-store.js";
import { clearKickMarker, writeKickMarker } from "./kick-marker.js";
import { createAnomalyHistory, createRetryEngine, resolveSocketSettings } from "../zalo/retry.js";
import { superviseListener } from "../zalo/socket.js";

export { EXIT_CODE };

/**
 * The fetch the account's own calls use (the session's `polyfill`: carries its proxy and its browser headers), or undefined
 * for the global one.
 *
 * @param {object} [api] - a session object
 * @returns {typeof fetch|undefined}
 */
function fetchOf(api) {
    try {
        const f = api?.getContext?.()?.options?.polyfill;
        return typeof f === "function" ? f : undefined;
    } catch {
        return undefined;
    }
}

/**
 * What a refused saved login says, when the library gives no number. The same words
 * `autoLogin` uses to tell a revoked session from a network failure.
 */
export const REVOKED_LOGIN = /đăng nhập thất bại|login failed|zpw_sek|kh[oô]ng đúng|600/i;

/** A refused login that is asked for this many times in a row ends the daemon. */
export const MAX_REFUSED_LOGINS = 3;

/**
 * What a failed login means, in words the daemon can act on.
 *
 * @param {unknown} err
 * @returns {"kicked"|"maintenance"|"refused"|"other"}
 */
export function classifyLoginFailure(err) {
    const c = classifyServerError(errorCodeOf(err));
    if (c.kind === "kicked") return "kicked";
    if (c.kind === "maintenance") return "maintenance";
    if (c.kind === "session-invalid" || c.kind === "invalid-account") return "refused";
    // No number: a refused login only says so in words, and so does a dead network.
    return REVOKED_LOGIN.test(String(err?.message ?? "")) ? "refused" : "other";
}

/** The longest a kicked daemon waits for Zalo to say why before it exits. */
export const KICK_REASON_WAIT_MS = 5000;

const sleepFor = (ms, signal) =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });

/**
 * @param {object} opts
 * @param {(level: "info"|"warn"|"error", message: string) => void} opts.log
 * @param {() => Promise<object>} opts.relogin - clear the old session, log in, attach the daemon's handlers
 *   to the new API, and return it
 * @param {() => void} opts.onKicked - end the daemon: release the lock, exit with `EXIT_CODE.KICKED`
 * @param {(err: unknown) => void} opts.onRevoked - end the daemon: release the lock, exit with `EXIT_CODE.SESSION_REVOKED`
 * @param {() => boolean} opts.isStopping
 * @param {{noteSocketState: (state: string) => void}} [opts.health]
 * @param {string} [opts.anomalyFile] - where the retry history is kept between runs
 * @param {string} [opts.kickFile] - where a kick that ends the daemon is recorded (cleared on the next connect)
 * @param {object} [opts.supervisorOptions] - extra options for every supervisor (timing, probe, clock)
 * @param {Function} [opts.supervise] - `(api, options) => supervisor`; replaceable for tests
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [opts.sleep]
 * @param {(keys: {bkt?: number, sptMtn?: number}) => Promise<{state: string, code: number|null}>} [opts.checkGate] -
 *   the maintenance question, given the disaster-recovery numbers the last session's login learned
 * @param {number} [opts.kickReasonWaitMs] - how long a kick waits for its reason before `onKicked`
 * @param {(info: {via: string, reason: unknown}) => boolean} [opts.yieldOnKick] - on-demand presence
 *   (./presence.js `noteKicked`): true lets the socket go and keeps the daemon up (`yielded`) instead of `onKicked`
 * @param {() => void} [opts.onParking] - called once a park is past the point of no return, before the supervisor
 *   stops: the daemon marks the coming close as planned (`lifecycle.noteParking()`, health `idle`)
 * @returns {{start: (api: object) => object, adopt: (api: object) => void, halt: () => Promise<void>,
 *   stop: () => Promise<void>, current: () => object|null, reloginNow: (why: string) => Promise<void>,
 *   park: Function, wake: Function, isParked: () => boolean, isParking: () => boolean}}
 */
export function createSocketHost({
    log,
    relogin,
    onKicked,
    onRevoked,
    isStopping,
    health,
    anomalyFile,
    kickFile,
    supervisorOptions = {},
    supervise = superviseListener,
    sleep = sleepFor,
    checkGate = (keys, fetchFn) => checkMaintenance({ ...keys, fetchFn }),
    kickReasonWaitMs = KICK_REASON_WAIT_MS,
    yieldOnKick = null,
    onParking = null,
}) {
    let supervisor = null;
    // The session the last supervisor ran on: a wake starts the next one on it (a relogin replaces it).
    let currentApi = null;
    // On-demand presence: no supervisor on purpose (parked, or yielded to another session after a kick).
    let parked = false;
    let parking = false;
    // What the last session's login learned about maintenance; the question carries it, as Zalo's own app's does.
    let gateKeys = {};
    // The account's own fetch (its proxy, when it has one): the gate's question leaves the way the account's traffic does.
    let gateFetch;
    // A 71 from the gate while logging in: the next supervisor keeps asking, as Zalo's own app does.
    let noticeWindow = null;
    let reloginRunning = false;
    const abort = new AbortController();

    // One history for the whole life of the daemon: a new login builds a new supervisor, and the
    // week of errors must not start over with it.
    const settings = resolveSocketSettings();
    const anomaly = createAnomalyHistory({
        kalpha: settings.anomalous_error_kalpha,
        state: anomalyFile ? loadAnomalyState(anomalyFile) : undefined,
        save: anomalyFile ? (state) => saveAnomalyState(anomalyFile, state) : undefined,
    });
    // The pace of asking for a login again: the same table and spreading as the socket's own retries.
    const loginEngine = createRetryEngine({ settings, anomaly });

    const seconds = (ms) => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

    function wire(sup) {
        sup.on("state", ({ state }) => health?.noteSocketState?.(state));
        sup.on("retrying", ({ key, delayMs, round, rotate, attempt }) => {
            log(
                "warn",
                `Reconnecting in ${seconds(delayMs)} (reason ${key}, attempt ${attempt}${round === 2 ? ", round 2" : ""}${rotate ? ", next endpoint" : ""})`,
            );
        });
        sup.on("kicked", ({ via, reason }) => {
            if (isStopping()) return;
            log(
                "error",
                `Another Zalo session took this account (${via}). Not reconnecting: that would evict it in turn.`,
            );
            const end = (info) => {
                if (kickFile) writeKickMarker(kickFile, { via, reason: info ?? null });
                if (yieldTo({ via, reason: info ?? null }, sup)) return;
                onKicked();
            };
            if (!reason) return end(null);
            // Let Zalo's answer to "why" reach the log before the process ends, but never wait long for it.
            let timer;
            const waited = new Promise((resolve) => {
                timer = setTimeout(resolve, kickReasonWaitMs, null);
                timer.unref?.();
            });
            Promise.race([reason, waited])
                .catch(() => null)
                .then((info) => {
                    clearTimeout(timer);
                    end(info);
                });
        });
        if (kickFile) sup.on("connected", () => clearKickMarker(kickFile));
        sup.on("kickout-info", ({ info }) => {
            const words = [info?.title, info?.text].filter(Boolean).join(": ");
            log(
                "info",
                words
                    ? `Zalo says why: ${words}${info.at ? ` (at ${info.at})` : ""}`
                    : `Zalo says why: ${JSON.stringify(info)}`,
            );
        });
        sup.on("session-invalid", ({ kind, code }) => {
            log("warn", `Zalo refused this session (${kind}, code ${code}). Logging in again.`);
            void reloginNow(`session-invalid:${code}`);
        });
        sup.on("stuck", ({ attempts }) => {
            log("warn", `No usable socket after ${attempts} tries. Logging in again in case the session was refused.`);
            void reloginNow("stuck");
        });
        sup.on("maintenance", ({ state }) => {
            if (state === "in-maintenance") log("warn", "Zalo is in maintenance. Waiting for it to come back.");
            else log("info", `Maintenance gate: ${state}.`);
        });
        sup.on("resume", () => log("info", "The machine woke up; checking the socket."));
    }

    /**
     * On-demand: let the socket go after a kick instead of ending the daemon, when presence says so. The kicked
     * supervisor is disposed (it never retries a kick anyway); nothing reconnects until a wake.
     *
     * @returns {boolean} whether the daemon yielded (false: the caller ends it as always)
     */
    function yieldTo(info, sup) {
        let yielded = false;
        try {
            yielded = Boolean(yieldOnKick?.(info));
        } catch (e) {
            log("warn", `The presence hook failed on a kick (${e?.message ?? e}); ending as always.`);
        }
        if (!yielded) return false;
        if (supervisor === sup) supervisor = null;
        sup?.dispose?.();
        parked = true;
        log(
            "warn",
            "Yielded the account to the other session of this login. The socket stays closed, and every request is " +
                "refused, until you close the other session and confirm: zalo-agent presence resume --yes",
        );
        return true;
    }

    /** Take over a (new) API: replace the old supervisor and start the new one. */
    function start(api) {
        currentApi = api;
        parked = false;
        const old = supervisor;
        if (old) {
            // The old session's socket is closed, not just forgotten: a socket left open beside the
            // new one is a second connection on the account.
            old.stop()
                .catch(() => {})
                .finally(() => old.dispose());
        }
        gateKeys = maintenanceKeysOf(api);
        gateFetch = fetchOf(api);
        supervisor = supervise(api, {
            anomaly,
            maintenance: { check: () => checkGate(gateKeys, gateFetch) },
            // Why a kick happened: the lookup needs the keys this session's login kept (L12b).
            kickoutInfo: () => lookupKickout(api),
            ...supervisorOptions,
        });
        wire(supervisor);
        supervisor.start();
        if (noticeWindow) {
            supervisor.continueChecking?.(noticeWindow);
            noticeWindow = null;
        }
        return supervisor;
    }

    /**
     * Log in again. Returns when a new supervisor is running, or when the daemon has been ended
     * (kicked, refused) or is stopping. Never runs twice at once.
     */
    async function reloginNow(why) {
        if (reloginRunning || isStopping()) return;
        reloginRunning = true;
        let refused = 0;
        try {
            for (;;) {
                if (isStopping()) return;
                const wait = loginEngine.next("internal").delayMs;
                log("info", `Logging in again in ${seconds(wait)} (${why}).`);
                await sleep(wait, abort.signal);
                if (isStopping() || abort.signal.aborted) return;
                try {
                    const api = await relogin();
                    loginEngine.resetAll();
                    log("info", "Logged in again. Restarting the socket.");
                    start(api);
                    return;
                } catch (err) {
                    const kind = classifyLoginFailure(err);
                    if (kind === "kicked") {
                        log("error", "Zalo answered the login with a kick: another session holds the account.");
                        if (yieldTo({ via: "login", reason: null }, null)) return;
                        onKicked();
                        return;
                    }
                    if (kind === "maintenance") {
                        log("warn", "Zalo is in maintenance: waiting for it instead of retrying.");
                        health?.noteSocketState?.("maintenance");
                        const gate = await waitOutMaintenance({
                            check: () => checkGate(gateKeys, gateFetch),
                            sleep,
                            signal: abort.signal,
                        });
                        if (gate.state === "notice") noticeWindow = gate.window ?? null;
                        loginEngine.resetAll();
                        continue;
                    }
                    if (kind === "refused") {
                        refused += 1;
                        log(
                            "error",
                            `The login was refused (${refused} of ${MAX_REFUSED_LOGINS}): ${err?.message ?? err}`,
                        );
                        if (refused >= MAX_REFUSED_LOGINS) {
                            onRevoked(err);
                            return;
                        }
                    } else {
                        refused = 0;
                        log("warn", `The login failed (${err?.message ?? err}); asking again.`);
                    }
                }
            }
        } finally {
            reloginRunning = false;
        }
    }

    /**
     * Park (on-demand presence): close the socket on purpose and keep everything else (session, lock, HTTP port,
     * daemon channel, timers). The close is a requested one, so the supervisor goes to `stopped` and retries nothing.
     *
     * @param {object} [o]
     * @param {() => boolean} [o.aborted] - a hold arrived: give up before the point of no return
     * @param {() => Promise<void>|void} [o.prepare] - flush the delivered receipts, wait for a running stage, stamp
     *   coverage (the daemon's part, step 2 and 4 of the plan's appendix A)
     * @returns {Promise<boolean>} whether the socket is parked now
     */
    async function park({ aborted = () => false, prepare } = {}) {
        if (parked) return true;
        if (parking || reloginRunning || isStopping()) return false;
        // No supervisor and not parked: a wake that was still waiting (a connect slot) is called off.
        if (!supervisor) {
            parked = true;
            return true;
        }
        parking = true;
        try {
            await prepare?.();
            if (aborted() || isStopping() || !supervisor) return false;
            onParking?.();
            const sup = supervisor;
            supervisor = null;
            parked = true;
            try {
                await sup.stop();
            } finally {
                sup.dispose();
            }
            log("info", "Parked: the socket is closed until something needs it.");
            return true;
        } finally {
            parking = false;
        }
    }

    /**
     * Wake (on-demand presence): a new supervisor on the current session, with the same anomaly history and kick
     * wiring. A dead session is found by that supervisor and goes the existing way (session-invalid, relogin).
     *
     * @returns {object|null} the running supervisor
     */
    function wake() {
        if (isStopping()) return null;
        if (!parked && supervisor) return supervisor;
        if (!currentApi) return null;
        return start(currentApi);
    }

    /**
     * Take the session without opening its socket (on-demand presence starts parked; the first wake opens it).
     *
     * @param {object} api
     */
    function adopt(api) {
        currentApi = api;
        if (!supervisor) parked = true;
    }

    /**
     * Let the socket go for good on this session (Zalo refuses the saved login: signed out). No onParking, no
     * retry; a wake does nothing until a new session is adopted or started.
     *
     * @returns {Promise<void>}
     */
    async function halt() {
        const sup = supervisor;
        supervisor = null;
        parked = true;
        currentApi = null;
        if (!sup) return;
        try {
            await sup.stop();
        } catch {
            /* already closed */
        } finally {
            sup.dispose();
        }
    }

    return {
        start,
        adopt,
        halt,
        reloginNow,
        park,
        wake,
        isParked: () => parked,
        isParking: () => parking,
        current: () => supervisor,
        /** Whether another session took the account: the close that follows a kick is not a drop to retry. */
        kicked: () => Boolean(supervisor?.status?.().kickedVia),
        /** Stop for good: cancel any wait, close the socket. */
        async stop() {
            abort.abort();
            if (supervisor) await supervisor.stop();
        },
    };
}
