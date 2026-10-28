/**
 * The fetch the restore's batch downloads and the media downloads go through (plan item ZP-01).
 *
 * Both used the global `fetch` with no headers at all: undici's default User-Agent, no `Referer`, and, for an account
 * with a proxy, a direct connection from this machine's own address while the session, the socket and the zCloud calls
 * went through the proxy. Zalo Web's sync worker sends a `User-Agent` and a `Referer` to the batch host, and a full
 * browser header set (no cookie) to the CDN. This is the same fetch with those headers, over the same proxy and the same
 * User-Agent as the account's session.
 *
 * It carries no cookie: neither the batch host nor the CDN is given the session (the batch URL and the media URLs are
 * signed), exactly as the Web client's download requests are.
 */
import { withBrowserHeaders } from "./headers.js";

/** The page the Web client's requests come from. */
export const WEB_REFERER = "https://chat.zalo.me/";

/**
 * A fetch for downloads, in the account's own identity.
 *
 * @param {object|null|undefined} api - a logged-in zca-js api; anything without a usable context gets the plain
 *   global fetch (a unit test's stand-in, a run with no session)
 * @param {typeof fetch} [fallback] - what to call when the account has no fetch of its own
 * @returns {typeof fetch}
 */
export function createDownloadFetch(api, fallback = (...a) => fetch(...a)) {
    let ctx = null;
    try {
        ctx = typeof api?.getContext === "function" ? api.getContext() : null;
    } catch {
        ctx = null;
    }
    const userAgent = ctx?.userAgent;
    if (!userAgent) return fallback;
    // The account's own fetch: the proxy-aware one when a proxy is configured, zca-js's default otherwise.
    const inner = typeof ctx?.options?.polyfill === "function" ? ctx.options.polyfill : fallback;
    const identified = (input, init = {}) => {
        const headers = { ...(init.headers ?? {}) };
        const have = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
        if (!have.has("user-agent")) headers["user-agent"] = userAgent;
        if (!have.has("referer")) headers.referer = WEB_REFERER;
        return inner(input, { ...init, headers });
    };
    return withBrowserHeaders(identified, userAgent);
}
