/**
 * The protocol profile: every value that says "who we are" to Zalo, in one place.
 *
 * Until now these were scattered: the announced version and type in
 * `core/zalo-client.js`, the computer name as a literal in `core/logout.js`
 * (and, separately, inside zca-js), the device label inside `core/sync-v2`,
 * and the browser presets in `utils/device-fingerprint.js`. A version bump
 * meant hunting for all of them. Everything that identifies this client now
 * reads from here, so changing the identity is one edit and one test.
 *
 * What lives here is deliberately small: only values the code announces to
 * Zalo today. Server-driven settings (retry tables, keepalive intervals, the
 * maintenance switch) are read from `getServerInfo` by the items that use
 * them and are not duplicated here.
 *
 * The announced version is {@link DEFAULT_API_VERSION}. v3.0 moves it to the
 * official Web client's current version as its own step (plan item L1), behind
 * the replay harness, so this module changes nothing on the wire by itself.
 */

/** The Web client class this CLI announces as: `zpw_type` and `type`. */
export const API_TYPE = 30;

/**
 * The protocol version announced when `ZALO_API_VERSION` is not set:
 * `zpw_ver` on every HTTP and WebSocket URL and `client_version` in the login
 * calls. zca-js defaults to 685; the live Zalo Web client was on 691 when this
 * was last moved.
 */
export const DEFAULT_API_VERSION = 691;

/** The `computer_name` Zalo Web sends in its login, server-info and logout calls. */
export const COMPUTER_NAME = "Web";

/**
 * The device name shown for a phone-backed sync. It stays recognizable on
 * purpose: this client does not pretend to be a browser or a mobile app.
 */
export const DEVICE_LABEL = "zalo-agent-cli";

/** Marks a bad ZALO_API_VERSION, so callers do not mistake it for a revoked session. */
export const API_VERSION_INVALID = "ZALO_API_VERSION_INVALID";

/**
 * The protocol version to announce: `ZALO_API_VERSION` when set (a rollback
 * switch, for example 685 for zca-js's own default), otherwise
 * {@link DEFAULT_API_VERSION}. An empty or blank value counts as unset.
 *
 * @param {object} [env] - the environment to read, `process.env` by default
 * @returns {number}
 * @throws {Error} with `.code === API_VERSION_INVALID` when the variable is set
 *   to anything but a positive whole number
 */
export function resolveApiVersion(env = process.env) {
    const raw = env.ZALO_API_VERSION;
    const value = raw === undefined ? "" : String(raw).trim();
    if (value === "") return DEFAULT_API_VERSION;
    const n = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(n)) {
        const err = new Error(
            `ZALO_API_VERSION must be a positive whole number -- the protocol version to announce, ` +
                `e.g. 685 to roll back from ${DEFAULT_API_VERSION} -- but it is "${raw}". Fix or unset it.`,
        );
        err.code = API_VERSION_INVALID;
        throw err;
    }
    return n;
}

/** Chrome builds the QR-login fingerprint may announce. Newest first. */
export const CHROME_VERSIONS = Object.freeze(["131.0.0.0", "130.0.0.0", "129.0.0.0", "128.0.0.0"]);

/**
 * Operating systems the fingerprint may claim. Chrome only, on purpose: other
 * browsers send no Client Hints, and the phone's device label is read from
 * those hints, so straying from Chrome would trade one oddity for another.
 */
export const UA_PLATFORMS = Object.freeze([
    Object.freeze({ token: "Windows NT 10.0; Win64; x64", hint: '"Windows"' }),
    Object.freeze({ token: "Macintosh; Intel Mac OS X 10_15_7", hint: '"macOS"' }),
]);

/**
 * The browser User-Agent for a platform and Chrome build, in the exact shape
 * Chrome sends.
 *
 * @param {{token: string}} platform - an entry of {@link UA_PLATFORMS}
 * @param {string} chromeVersion - an entry of {@link CHROME_VERSIONS}
 * @returns {string}
 */
export function buildUserAgent(platform, chromeVersion) {
    return `Mozilla/5.0 (${platform.token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

/**
 * The profile as one frozen object, for callers that want to log or assert
 * all of it at once.
 *
 * @param {object} [env] - the environment to read, `process.env` by default
 * @returns {Readonly<{apiType: number, apiVersion: number, computerName: string, deviceLabel: string}>}
 * @throws {Error} when `ZALO_API_VERSION` is invalid (see {@link resolveApiVersion})
 */
export function getProfile(env = process.env) {
    return Object.freeze({
        apiType: API_TYPE,
        apiVersion: resolveApiVersion(env),
        computerName: COMPUTER_NAME,
        deviceLabel: DEVICE_LABEL,
    });
}
