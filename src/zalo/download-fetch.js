/**
 * The fetch the restore's batch downloads and the media downloads go through (plan item ZP-01).
 *
 * Both used the global `fetch` with no headers at all: undici's default User-Agent, no `Referer`, and, for an account
 * with a proxy, a direct connection from this machine's own address while the session, the socket and the zCloud calls
 * went through the proxy. The batch host expects a `User-Agent` and a `Referer`, and the CDN a full browser header set
 * (no cookie). This is the same fetch with those headers, over the same proxy and the same User-Agent as the
 * account's session.
 *
 * It carries no cookie: neither the batch host nor the CDN is given the session (the batch URL and the media URLs are
 * signed).
 */
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import { withBrowserHeaders } from "./headers.js";

/** The `Referer` the download requests carry. */
export const WEB_REFERER = "https://chat.zalo.me/";

/**
 * The given headers plus `connection: close`, in the shape they came in (a `Headers` or a plain object).
 *
 * @param {HeadersInit|undefined} headers
 * @returns {HeadersInit}
 */
function closingHeaders(headers) {
    if (headers instanceof Headers) {
        const h = new Headers(headers);
        h.set("connection", "close");
        return h;
    }
    const h = { ...(headers ?? {}) };
    for (const k of Object.keys(h)) if (k.toLowerCase() === "connection") delete h[k];
    h.connection = "close";
    return h;
}

/**
 * One request on a connection of its own: a new dispatcher (the proxy's, when there is one), so no pooled socket is
 * reused, and `connection: close`, so the socket is not kept after it. What a download asks again with after a request
 * that got no answer at all: the pooled socket it went out on may be one the other side had already closed.
 *
 * The fetch is the `undici` package's, matched with its own dispatcher (a dispatcher handed to the fetch of the
 * undici Node bundles fails every request; see `createProxyFetch` in ./client.js).
 *
 * @param {string|URL} url
 * @param {RequestInit & {freshConnection?: boolean}} [init] - `freshConnection` is dropped
 * @param {string|null} [proxyUrl] - the account's proxy, or none
 * @returns {Promise<Response>}
 */
export function fetchOnFreshConnection(url, init = {}, proxyUrl = null) {
    const rest = { ...init };
    delete rest.freshConnection;
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent();
    return undiciFetch(url, { ...rest, headers: closingHeaders(rest.headers), dispatcher });
}

/**
 * The plain fetch, except that a request marked `freshConnection` goes out on a connection of its own.
 *
 * @param {string|URL} url
 * @param {RequestInit & {freshConnection?: boolean}} [init]
 * @returns {Promise<Response>}
 */
function plainFetch(url, init = {}) {
    if (init.freshConnection) return fetchOnFreshConnection(url, init);
    return fetch(url, init);
}

/**
 * A fetch for downloads, in the account's own identity.
 *
 * A request whose init carries `freshConnection: true` goes out on a connection of its own (see
 * {@link fetchOnFreshConnection}): through the account's proxy fetch, which honors the flag, or, with no proxy, on a
 * new direct connection with the same identity headers.
 *
 * @param {object|null|undefined} api - a logged-in session; anything without a usable context gets the plain
 *   global fetch (a unit test's stand-in, a run with no session)
 * @param {typeof fetch} [fallback] - what to call when the account has no fetch of its own
 * @returns {typeof fetch}
 */
export function createDownloadFetch(api, fallback = plainFetch) {
    let ctx = null;
    try {
        ctx = typeof api?.getContext === "function" ? api.getContext() : null;
    } catch {
        ctx = null;
    }
    const userAgent = ctx?.userAgent;
    if (!userAgent) return fallback;
    // The account's own fetch: the proxy-aware one when a proxy is configured, the session's default otherwise.
    const session = typeof ctx?.options?.polyfill === "function" ? ctx.options.polyfill : fallback;
    // A proxied session's fetch is the proxy fetch (./client.js), which opens its own connection for the flag; without
    // a proxy (`options.agent` is set only with one) the session's fetch is the global one, which would ignore it.
    const proxied = Boolean(ctx?.options?.agent);
    const inner = (input, init = {}) =>
        init.freshConnection && !proxied ? fetchOnFreshConnection(input, init) : session(input, init);
    const identified = (input, init = {}) => {
        const headers = { ...(init.headers ?? {}) };
        const have = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
        if (!have.has("user-agent")) headers["user-agent"] = userAgent;
        if (!have.has("referer")) headers.referer = WEB_REFERER;
        return inner(input, { ...init, headers });
    };
    return withBrowserHeaders(identified, userAgent);
}
