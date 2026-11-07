/**
 * Picks a randomized, plausible browser User-Agent for the one-time QR login handshake.
 *
 * Why this exists: a User-Agent that is byte-identical on every install is a correlatable signal, and Zalo's server
 * reads the Client Hints that go with it for the "Thiết bị" device label on the phone's QR-confirm screen. Only
 * the User-Agent is chosen here. The Client Hints of every request (the QR login's and the session's after it) are
 * derived from it by `src/zalo/headers.js` (`secChUaFor`), so they always match. The legacy QR flow, which needed
 * the hints handed over as separate fields, was removed in 3.0.0.
 *
 * Scope: this only matters for the INITIAL QR-login handshake. Once logged in, the chosen userAgent is persisted
 * in that account's credentials file (see extractCredentials()/loginWithCredentials() in zalo-client.js) and
 * reused for every later API call, so a fresh, plausible choice made once here, at first login, is enough. Logging
 * into the same account again later (after a full logout, not just a session resume) gets a fresh one, as a real
 * user occasionally updating their browser would.
 */

import { CHROME_VERSIONS, UA_PLATFORMS, buildUserAgent } from "./profile.js";

/**
 * Chrome-only presets, built from the protocol profile (src/zalo/profile.js), which owns the Chrome builds and
 * platforms. Not Firefox or Safari: those send no Client Hints, and Zalo's device label is read from them.
 * Varying the version and the OS is enough to avoid every install presenting an identical fingerprint.
 */
const PRESETS = UA_PLATFORMS.flatMap((platform) => CHROME_VERSIONS.map((v) => buildUserAgent(platform, v)));

/**
 * Pick a random fingerprint for a fresh QR login.
 *
 * @returns {{userAgent: string}}
 */
export function generateDeviceFingerprint() {
    return { userAgent: PRESETS[Math.floor(Math.random() * PRESETS.length)] };
}
