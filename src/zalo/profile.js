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
 * The announced version is {@link DEFAULT_API_VERSION}, the Zalo Web client's own
 * current version.
 */

/** The Web client class this CLI announces as: `zpw_type` and `type`. */
export const API_TYPE = 30;

/**
 * The protocol version announced when `ZALO_API_VERSION` is not set:
 * `zpw_ver` on every HTTP and WebSocket URL and `client_version` in the login
 * calls. zca-js defaults to 685; the live Zalo Web client was on 694 when this
 * was last moved.
 */
export const DEFAULT_API_VERSION = 694;

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

/** Marks a bad ZALO_QR_FLOW, so callers can tell it from a failed login. */
export const QR_FLOW_INVALID = "ZALO_QR_FLOW_INVALID";

/**
 * Which QR login runs: `legacy` (zca-js's own, the default) or `official` (the verified Web sequence,
 * src/zalo/qr-login.js). The official one becomes the default once a login with it has been seen to work live.
 *
 * @param {object} [env] - the environment to read, `process.env` by default
 * @returns {"legacy"|"official"}
 * @throws {Error} with `.code === QR_FLOW_INVALID` for any other value
 */
export function resolveQrFlow(env = process.env) {
    const raw = env.ZALO_QR_FLOW;
    const value = raw === undefined ? "" : String(raw).trim().toLowerCase();
    if (value === "") return "legacy";
    if (value === "legacy" || value === "official") return value;
    const err = new Error(`ZALO_QR_FLOW must be "legacy" or "official", but it is "${raw}". Fix or unset it.`);
    err.code = QR_FLOW_INVALID;
    throw err;
}

/** Chrome builds the QR-login fingerprint may announce. Newest first: the current stable and the three before it. */
export const CHROME_VERSIONS = Object.freeze(["155.0.0.0", "154.0.0.0", "153.0.0.0", "152.0.0.0"]);

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
 * Zalo's number for the browser a User-Agent names (the `browser` parameter of the profile call).
 *
 * @param {string} userAgent
 * @returns {number} 1 Opera, 2 Firefox, 3 Safari, 4 Internet Explorer, 5 Edge, 6 Chrome, 0 anything else
 */
export function browserCodeOf(userAgent) {
    const ua = String(userAgent ?? "");
    if (/OPR\/|Opera/.test(ua)) return 1;
    if (/Edg(e|A|iOS)?\//.test(ua)) return 5;
    if (/MSIE |Trident\//.test(ua)) return 4;
    if (/Firefox\//.test(ua)) return 2;
    if (/Chrome\/|Chromium\//.test(ua)) return 6;
    if (/Safari\//.test(ua)) return 3;
    return 0;
}

/**
 * Zalo's number for the operating system a User-Agent names (the `os` parameter of the profile call).
 *
 * @param {string} userAgent
 * @returns {number} 1 Windows Phone, 2 Android, 3 iPad, 4 iPhone, 5 iPod, 6 macOS, 7 Windows, 8 Linux, 0 anything else
 */
export function osCodeOf(userAgent) {
    const ua = String(userAgent ?? "");
    if (/windows phone/i.test(ua)) return 1;
    if (/android/i.test(ua)) return 2;
    if (/iPad/i.test(ua)) return 3;
    if (/iPhone/i.test(ua)) return 4;
    if (/iPod/i.test(ua)) return 5;
    if (/Macintosh|Mac OS X/i.test(ua)) return 6;
    if (/Windows/i.test(ua)) return 7;
    if (/Linux/i.test(ua)) return 8;
    return 0;
}

/** The `avatar_size` the Web client asks every profile and list call for. */
export const AVATAR_SIZE = 160;

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
