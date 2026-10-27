/**
 * When the saved login stops working by itself.
 *
 * The chat session's cookie, `zpw_sek`, is set once, by `jr.chat.zalo.me/jr/pushsession` at login, with a life of about
 * 90 days. In every captured Zalo Web session (eight of them, from a few minutes to a long idle one) no API answer set
 * it again, and the Web client's own `exta/rnw` renewal call has no caller in any bundle. So nothing extends it: a
 * login is good until `creation + max-age`, and a daemon running past that needs a new QR login. This reads that date
 * from the saved cookie jar, so it can be shown before it arrives instead of after.
 *
 * Only a date comes out of here: never a cookie's value.
 */
import { loadCredentials } from "./credentials.js";

/** The cookie that carries the chat session. */
export const SESSION_COOKIE = "zpw_sek";

/** From this many days before the end, a daemon's health says so. */
export const EXPIRY_WARN_DAYS = 14;

const DAY_MS = 86_400_000;

/**
 * The cookie list of a saved jar: the serialized tough-cookie form `{cookies: [...]}`, or a bare array.
 *
 * @param {unknown} jar
 * @returns {object[]}
 */
function cookiesOf(jar) {
    const list = Array.isArray(jar) ? jar : jar?.cookies;
    return Array.isArray(list) ? list.filter((c) => c && typeof c === "object") : [];
}

/**
 * When one saved cookie ends: its absolute `expires` when it has one, otherwise `creation + maxAge`.
 *
 * @param {object} cookie - a serialized tough-cookie
 * @returns {number|null} milliseconds since the epoch
 */
function endOf(cookie) {
    const expires = cookie.expires ? Date.parse(cookie.expires) : NaN;
    if (Number.isFinite(expires)) return expires;
    const created = Date.parse(cookie.creation);
    const maxAge = Number(cookie.maxAge);
    return Number.isFinite(created) && Number.isFinite(maxAge) && maxAge > 0 ? created + maxAge * 1000 : null;
}

/**
 * The end of the saved chat session.
 *
 * @param {unknown} jar - the saved cookie jar (`credentials.cookie`)
 * @param {() => number} [now] - milliseconds
 * @returns {{expiresAt: string, daysLeft: number, expired: boolean}|null} null when the jar holds no session cookie
 *   with a known end
 */
export function sessionExpiryOf(jar, now = Date.now) {
    const ends = cookiesOf(jar)
        .filter((c) => c.key === SESSION_COOKIE)
        .map(endOf)
        .filter((t) => t !== null);
    if (!ends.length) return null;
    const end = Math.min(...ends);
    return {
        expiresAt: new Date(end).toISOString(),
        daysLeft: Math.floor((end - now()) / DAY_MS),
        expired: end <= now(),
    };
}

/**
 * The end of one account's saved session, read from its credentials file.
 *
 * @param {string} ownId
 * @param {() => number} [now]
 * @returns {{expiresAt: string, daysLeft: number, expired: boolean}|null}
 */
export function sessionExpiryFor(ownId, now = Date.now) {
    try {
        return sessionExpiryOf(loadCredentials(ownId)?.cookie, now);
    } catch {
        return null;
    }
}

/**
 * One line for a person: when the session ends, and what to do when it is close.
 *
 * @param {{expiresAt: string, daysLeft: number, expired: boolean}|null} expiry
 * @returns {string|null}
 */
export function describeSessionExpiry(expiry) {
    if (!expiry) return null;
    const date = expiry.expiresAt.slice(0, 10);
    if (expiry.expired) return `The saved session ended on ${date}: log in again with a QR code.`;
    if (expiry.daysLeft <= EXPIRY_WARN_DAYS) {
        return `The saved session ends on ${date} (${expiry.daysLeft} day(s) left): plan a new QR login before then.`;
    }
    return `The saved session is good until ${date} (${expiry.daysLeft} days).`;
}
