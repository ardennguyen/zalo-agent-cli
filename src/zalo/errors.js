/**
 * What Zalo's error numbers mean, in one place (plan item L4).
 *
 * Four number spaces meet in a Zalo client, and they used to be handled by
 * matching words in an error message:
 *
 *   - **server codes**: the `error_code` of an HTTP answer or of a socket frame
 *     (70 maintenance, 600 kicked out, 102 session timeout, ...);
 *   - **socket error codes**: what the client itself raises about its own
 *     socket (a missing pong, an auth timeout, ...), numbered 5001 and up;
 *   - **close codes**: the WebSocket close code (1000 normal, 1006 abnormal,
 *     3000 and up are Zalo's);
 *   - **retry keys**: the names under which the server's retry table is keyed.
 *
 * Each is a table here, and `classifyServerError` turns a server code into what
 * the caller should DO about it, so no caller decides from a message again.
 */

/** Socket error codes the client raises about its own socket. */
export const SOCKET_ERROR = Object.freeze({
    KICKOUT: 600,
    UNKNOWN: 5000,
    WSS_ERROR: 5001,
    UNZIP: 5002,
    INVALID_DATA: 5003,
    INVALID_CMD: 5004,
    INVALID_CONFIG: 5005,
    UNCLEAN_CLOSE: 5006,
    INVALID_AUTH_DATA: 5007,
    KEY_INVALID: 5008,
    DECRYPT_FAILED: 5009,
    INVALID_GET_OFFLINE: 5010,
    PING_TIMEOUT: 5011,
    ESTABLISH_TIMEOUT: 5012,
    PING_PONG: 5013,
    OFFLINE_TIMEOUT: 5014,
    AUTH_TIMEOUT: 5015,
    ABNORMAL_STOP_PING: 5016,
    OFFLINE_CTRL_TIMEOUT: 5017,
    INVALID_GET_CTRL_OFFLINE: 5018,
    CLOSE_TIMEOUT: 5019,
    RECONNECT_ESTABLISH_TIMEOUT: 5020,
});

/** WebSocket close codes: the standard ones and Zalo's own (3000 and up). */
export const CLOSE_CODE = Object.freeze({
    NORMAL: 1000,
    GOING_AWAY: 1001,
    PROTOCOL_ERROR: 1002,
    UNSUPPORTED_DATA: 1003,
    NO_STATUS: 1005,
    ABNORMAL: 1006,
    INVALID_PAYLOAD: 1007,
    POLICY_VIOLATION: 1008,
    MESSAGE_TOO_BIG: 1009,
    MANDATORY_EXTENSION: 1010,
    INTERNAL_ERROR: 1011,
    SERVER_RESTART: 1012,
    TRY_AGAIN_LATER: 1013,
    TLS_HANDSHAKE_FAIL: 1015,
    NOT_AUTHENTICATED: 3000,
    READ_MAX_CONNECTION: 3001,
    NOT_FOUND_WORKER: 3002,
    KICK_CONNECTION: 3003,
});

/**
 * The retry keys. A key is either a number (a close or error code, looked up
 * as its decimal string in the server's retry table) or a name. The numbers
 * after the names are what the official client logs them as.
 */
export const RETRY_KEY = Object.freeze({
    MANUAL: "manual",
    INTERNAL: "internal", // 5021: a close code 1001-1015
    INTERVAL_CHECK: "interval_check", // 5022
    CANNOT_REACH_SERVER: 4001, // a 1006 whose probe worked
    NO_NETWORK: "no_network", // 5024
    SWAP_ENDPOINT: 4002, // the endpoint went back to the first one
    SYSTEM_RESUME: "system_resume", // 5026: the machine woke up
});

/** The numbers the official client logs the named retry keys as. */
export const RETRY_KEY_NUMBER = Object.freeze({
    internal: 5021,
    interval_check: 5022,
    cannot_reach_server: 5023,
    no_network: 5024,
    swap_endpoint: 5025,
    system_resume: 5026,
});

/**
 * What the caller should do about a server `error_code`.
 *
 * - `maintenance`: Zalo is in maintenance; wait, do not retry on a ladder
 * - `maintenance-notice`: a maintenance window was announced but has not started
 * - `kicked`: another session took this account; end, never reconnect
 * - `session-invalid`: this session is no longer valid; log in again
 * - `invalid-account`: the account itself is refused; log in again will not help
 * - `retry`: ask again after a delay
 * - `encryption-off`: the server turned parameter encryption off; resend unencrypted
 * - `stop-retry`: the server says stop asking
 * - `up-to-date`: not an error (the update check's "nothing newer")
 *
 * @typedef {"maintenance"|"maintenance-notice"|"kicked"|"session-invalid"|"invalid-account"|"retry"|"encryption-off"|"stop-retry"|"up-to-date"} ErrorKind
 */
const SERVER_ERRORS = new Map([
    [70, { name: "MAINTENANCE", kind: "maintenance" }],
    // 71 is accepted by the maintenance poller beside 0 and 70. The official
    // client treats it as maintenance too; what separates it from 70 is not
    // known, so it is kept apart and polled slowly rather than blocked on.
    [71, { name: "MAINTENANCE_NOTICE", kind: "maintenance-notice" }],
    [102, { name: "SESSION_TIMEOUT", kind: "session-invalid" }],
    [112, { name: "SERVER_STOP", kind: "retry" }],
    [210, { name: "INVALID_ACCOUNT", kind: "invalid-account" }],
    [212, { name: "INVALID_ACCOUNT", kind: "invalid-account" }],
    [600, { name: "KICKED_OUT", kind: "kicked" }],
    [19000, { name: "ENCRYPTION_DISABLED", kind: "encryption-off" }],
    [-69, { name: "STOP_RETRY", kind: "stop-retry" }],
    [1001, { name: "UP_TO_DATE", kind: "up-to-date" }],
]);

/**
 * Classify a server `error_code`.
 *
 * @param {number|string|null|undefined} code
 * @returns {{code: number|null, name: string, kind: ErrorKind|"unknown"}}
 *   `kind` is "unknown" for a code this table does not name: the caller decides,
 *   and should treat it as an ordinary failure, not as a state
 */
export function classifyServerError(code) {
    const n = typeof code === "string" && code.trim() !== "" ? Number(code) : code;
    if (typeof n !== "number" || !Number.isFinite(n)) return { code: null, name: "NONE", kind: "unknown" };
    const known = SERVER_ERRORS.get(n);
    return known ? { code: n, ...known } : { code: n, name: "UNKNOWN", kind: "unknown" };
}

/**
 * The code an error carries, whichever way the library reports it.
 *
 * zca-js's `ZaloApiError` puts the server's code on `.code`; a hand-built error
 * may use `.error_code`; a code can also be the only thing a message says.
 *
 * @param {unknown} err
 * @returns {number|null}
 */
export function errorCodeOf(err) {
    if (!err || typeof err !== "object") return null;
    for (const key of ["code", "error_code", "errorCode"]) {
        const v = err[key];
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v);
    }
    return null;
}

/** Exit codes a long-running command ends with when it must not be restarted blindly. */
export const EXIT_CODE = Object.freeze({
    /** Another session took the account. A supervisor must not restart this on its own. */
    KICKED: 3,
    /** The saved login was refused and logging in again did not help. */
    SESSION_REVOKED: 4,
});
