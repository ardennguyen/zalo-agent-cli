/**
 * The session's cookie jar (spec-kernel 13, option A): tough-cookie's `CookieJar`, so the on-disk format of every
 * saved login stays exactly what it is (tough-cookie's serialized jar), and cookies follow RFC 6265 the way a
 * browser's do.
 *
 * Credentials exist on disk in three shapes, all of which load:
 *   - the serialized jar `{version, storeType, ..., cookies: [...]}` (what a login writes back),
 *   - a bare array of serialized cookies (what the QR login returns),
 *   - a browser-extension export: `name` instead of `key`, domains with a leading dot.
 *
 * Two behaviors differ from zca-js's jar handling, and both follow the browser (spec-kernel D5, D6):
 *   - the `Cookie` header is computed for the full request URL (domain and path), not for its origin only;
 *   - a `Set-Cookie` is stored against the URL of the request that received it, so a cookie with no `Domain`
 *     attribute is kept as a host-only cookie of that host (zca-js filed it under host `null` and never sent it).
 *
 * Nothing here logs: a cookie value is a credential.
 */
import { Cookie, CookieJar } from "tough-cookie";

/** Where a saved cookie with no domain at all is filed (what every saved login was made for). */
const DEFAULT_COOKIE_HOST = "chat.zalo.me";

/**
 * An empty jar.
 *
 * @returns {CookieJar}
 */
export function newJar() {
    return new CookieJar();
}

/**
 * Load a saved jar in any of the three shapes. The input is never modified. An entry that cannot be read is
 * skipped (one damaged cookie must not cost the whole login).
 *
 * @param {object|object[]|null|undefined} saved - `{cookies: [...]}`, a bare array, or nothing
 * @returns {CookieJar}
 */
export function loadJar(saved) {
    const jar = new CookieJar();
    const list = Array.isArray(saved) ? saved : Array.isArray(saved?.cookies) ? saved.cookies : [];
    for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        const rawDomain = typeof entry.domain === "string" ? entry.domain : "";
        const dotted = rawDomain.startsWith(".");
        const domain = dotted ? rawDomain.slice(1) : rawDomain;
        try {
            const cookie = Cookie.fromJSON({ ...entry, key: entry.key ?? entry.name, domain: domain || null });
            if (!cookie || !cookie.key) continue;
            // A leading dot is the old way of saying "this domain and its subdomains".
            if (dotted) cookie.hostOnly = false;
            jar.setCookieSync(cookie, `https://${domain || DEFAULT_COOKIE_HOST}/`);
        } catch {
            /* a cookie the jar refuses is skipped, never logged: its value is a credential */
        }
    }
    return jar;
}

/**
 * The serialized form of a jar, as saved credentials hold it.
 *
 * @param {CookieJar} jar
 * @returns {{cookies: object[]}} tough-cookie's serialized jar (`cookies` plus its own settings)
 */
export function saveJar(jar) {
    return jar.toJSON();
}

/**
 * The `Cookie` header a browser would send to this URL.
 *
 * @param {CookieJar|null|undefined} jar
 * @param {string} url - the full request URL
 * @returns {string} "" when no cookie applies
 */
export function cookieHeader(jar, url) {
    if (!jar) return "";
    try {
        return jar.getCookieStringSync(String(url));
    } catch {
        return "";
    }
}

/**
 * The raw `Set-Cookie` values of a response. Uses `getSetCookie()` where the response has it; otherwise splits the
 * joined header at commas that start a new cookie (never inside an `Expires` date).
 *
 * @param {{headers?: {getSetCookie?: Function, get?: Function}}} response
 * @returns {string[]}
 */
export function setCookiesOf(response) {
    const headers = response?.headers;
    if (!headers) return [];
    if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
    const joined = typeof headers.get === "function" ? headers.get("set-cookie") : null;
    if (!joined) return [];
    return String(joined)
        .split(/,(?=\s*[^;,=\s]+=)/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Store every `Set-Cookie` of a response, against the URL the request went to. A cookie the jar refuses (another
 * site's domain, a public suffix) is dropped, as a browser drops it.
 *
 * @param {CookieJar|null|undefined} jar
 * @param {string} url - the request URL
 * @param {object} response
 * @returns {number} how many cookies were stored
 */
export function storeSetCookies(jar, url, response) {
    if (!jar) return 0;
    let stored = 0;
    for (const raw of setCookiesOf(response)) {
        try {
            if (jar.setCookieSync(raw, String(url))) stored++;
        } catch {
            /* refused, as a browser would; never logged */
        }
    }
    return stored;
}
