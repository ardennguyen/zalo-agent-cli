/**
 * `account_state`: one word for where an account stands, said once per change, the same from every place that shows
 * it (the webhook, the MCP buffer, `/status`, `fleet status`, the fleet controller's SSE).
 *
 *   stopped        no process for the account (the controller says this one: a daemon cannot)
 *   idle           the daemon runs and its socket is parked (on-demand presence): it wakes on demand
 *   connecting     a socket is being opened (a start, a wake, a drop being retried)
 *   connected      the socket is up
 *   kicked         another session took the account (said just before exit 3)
 *   yielded        on-demand: another session of the same login took the socket; the daemon stays up and refuses
 *                  every request (YIELDED) until the user confirms `presence resume`
 *   login_needed   Zalo refused the session (while the daemon logs in again)
 *   signed_out     Zalo keeps refusing the saved login (another browser took the web login): the daemon stays up and
 *                  refuses every request (SIGNED_OUT) until the account is added again by QR
 *   maintenance    Zalo is in maintenance; the daemon waits for it
 *
 * Events carry ids only, never a name: `{event: "account_state", accountId, state, previous, at, detail}`.
 */

/** Every account state. */
export const ACCOUNT_STATES = Object.freeze([
    "stopped",
    "idle",
    "connecting",
    "connected",
    "kicked",
    "yielded",
    "login_needed",
    "signed_out",
    "maintenance",
]);

/** A supervisor state (src/zalo/socket.js) as an account state, or null when it says nothing new. */
const FROM_SUPERVISOR = Object.freeze({
    connecting: "connecting",
    retrying: "connecting",
    offline: "connecting",
    connected: "connected",
    kicked: "kicked",
    "session-invalid": "login_needed",
    maintenance: "maintenance",
});

/** A daemon's health socket state (src/core/daemon-health.js) as an account state. */
const FROM_HEALTH = Object.freeze({
    starting: "connecting",
    connecting: "connecting",
    down: "connecting",
    up: "connected",
    idle: "idle",
    kicked: "kicked",
    relogin: "login_needed",
    yielded: "yielded",
    "signed-out": "signed_out",
    maintenance: "maintenance",
    stopping: "stopped",
});

/**
 * The account state a daemon's health snapshot says (for the fleet controller and `fleet status`).
 *
 * @param {{socket?: {state?: string}}|null} health - null when no daemon answered
 * @param {{running?: boolean}} [o]
 * @returns {string}
 */
export function accountStateOfHealth(health, { running = true } = {}) {
    if (!running) return "stopped";
    return FROM_HEALTH[health?.socket?.state] ?? "connecting";
}

/**
 * One daemon's tracker: feed it what happens, it says each change once.
 *
 * @param {object} args
 * @param {string} args.accountId
 * @param {(event: object) => void} args.emit - the webhook, the MCP buffer, the log
 * @param {() => number} [args.now]
 * @param {() => object} [args.detail] - extra detail every event carries (e.g. `{presence: "on-demand"}`)
 * @returns {{noteSocketState: (s: string) => void, note: (state: string, detail?: object) => boolean,
 *   current: () => {state: string|null, since: string|null}}}
 */
export function createAccountStateTracker({ accountId, emit, now = Date.now, detail = () => ({}) }) {
    let state = null;
    let since = null;
    const note = (next, extra = {}) => {
        if (!ACCOUNT_STATES.includes(next) || next === state) return false;
        const previous = state;
        state = next;
        since = now();
        const event = {
            event: "account_state",
            accountId: String(accountId),
            state: next,
            previous,
            at: new Date(since).toISOString(),
            detail: { ...detail(), ...extra },
        };
        try {
            emit(event);
        } catch {
            /* a failing receiver never takes the daemon down */
        }
        return true;
    };
    return {
        /** A supervisor state; `stopped` (a park or a shutdown) says nothing here. */
        noteSocketState(s) {
            const mapped = FROM_SUPERVISOR[s];
            if (mapped) note(mapped);
        },
        note,
        current: () => ({ state, since: since === null ? null : new Date(since).toISOString() }),
    };
}

/**
 * Which `account_state` events go into the MCP buffer that `zalo_wait_for_message` and `mcp wait` read. A park, and
 * the wake that ends it, are on-demand presence doing its job: they still reach the webhook, the log and `/status`,
 * but in the buffer every wait on a parked account was answered by the `connecting -> connected` of the wake it caused
 * itself, before the catch-up had delivered a single message. A drop, a kick, a yield, a sign-out, and a wake that
 * fails (`login_needed`) still go in.
 *
 * @returns {(event: {state: string}) => boolean} true: push this one
 */
export function createBufferStateFilter() {
    let waking = false; // since a park, until the wake reaches connected or fails
    return (event) => {
        const routine =
            event.state === "idle" || (waking && (event.state === "connecting" || event.state === "connected"));
        if (event.state === "idle") waking = true;
        else if (event.state !== "connecting") waking = false;
        return !routine;
    };
}

/**
 * One `account_state` event as the MCP buffer carries it (a system event, as `storage_quota`).
 *
 * @param {object} e
 * @returns {object}
 */
export function accountStateSystemEvent(e) {
    const rest = { ...e };
    delete rest.event;
    return { type: "account_state", ...rest, text: describeAccountState(e) };
}

/**
 * One line for a person.
 *
 * @param {{accountId: string, state: string, previous?: string|null, detail?: object}} e
 * @returns {string}
 */
export function describeAccountState(e) {
    const why = e.detail?.exitCode ? ` (exit ${e.detail.exitCode})` : e.detail?.reason ? ` (${e.detail.reason})` : "";
    const advice = ACCOUNT_STATE_ADVICE[e.state] ? `. ${ACCOUNT_STATE_ADVICE[e.state]}` : "";
    return `account ${e.accountId}: ${e.previous ?? "start"} -> ${e.state}${why}${advice}`;
}

/** What a person does about the two states nothing recovers from on its own. */
export const ACCOUNT_STATE_ADVICE = Object.freeze({
    yielded:
        "Another session of this login holds the account; close it, then confirm with `zalo-agent presence resume " +
        "--yes` (or the admin API / MCP). Requests are refused until then",
    signed_out:
        "Another browser or device took the web login; add the account again by QR. Requests are refused until then",
});
