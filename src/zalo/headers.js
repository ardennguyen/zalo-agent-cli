/**
 * The headers a browser adds to every XHR it makes, which zca-js leaves out (plan item L7).
 *
 * zca-js sends `Accept`, `Accept-Language`, `Content-Type`, `Cookie`, `Origin`, `Referer` and `User-Agent`.
 * A real browser also sends the Client Hints that match its User-Agent, the three `sec-fetch-*` headers
 * and, in Chromium, `priority`. All of these come from the captured Web client; the capture's other extras
 * (`cache-control`, `pragma`, `dnt`) were DevTools and user settings, not the client, and are not sent.
 *
 * Everything is derived from the saved User-Agent, so a session always presents ONE coherent browser. A
 * User-Agent that is not Chromium (an older login made with a Firefox one) gets the `sec-fetch-*` headers
 * only: Firefox sends no Client Hints, and claiming some would be the oddity this module exists to remove.
 */

/**
 * The Client Hints a Chromium User-Agent implies.
 *
 * @param {string} userAgent
 * @returns {{secChUa: string, secChUaPlatform: string, secChUaMobile: string}|null} null for a User-Agent
 *   that is not Chromium-based
 */
export function secChUaFor(userAgent) {
    const ua = String(userAgent ?? "");
    const chrome = /Chrome\/(\d+)/.exec(ua);
    if (!chrome) return null;
    const major = chrome[1];
    const edge = /Edg\/(\d+)/.exec(ua);
    const brand = edge ? `"Microsoft Edge";v="${edge[1]}"` : `"Google Chrome";v="${major}"`;
    // The shape real Chromium sends: the engine, the browser, and the GREASE filler entry.
    const secChUa = `"Chromium";v="${major}", ${brand}, "Not?A_Brand";v="99"`;
    let platform = '"Windows"';
    if (/Android/i.test(ua)) platform = '"Android"';
    else if (/Macintosh|Mac OS X/i.test(ua)) platform = '"macOS"';
    else if (/Linux|X11/i.test(ua)) platform = '"Linux"';
    return { secChUa, secChUaPlatform: platform, secChUaMobile: /Mobile/i.test(ua) ? "?1" : "?0" };
}

/**
 * `sec-fetch-site` for a request from chat.zalo.me: same-site inside zalo.me, cross-site everywhere else.
 *
 * @param {string} url
 * @returns {"same-site"|"cross-site"}
 */
export function fetchSiteOf(url) {
    const host = new URL(url).hostname;
    return host === "zalo.me" || host.endsWith(".zalo.me") ? "same-site" : "cross-site";
}

/**
 * The headers to add to one request.
 *
 * @param {string} userAgent
 * @param {string} url
 * @returns {Record<string, string>}
 */
export function browserHeadersFor(userAgent, url) {
    const hints = secChUaFor(userAgent);
    const out = {};
    if (hints) {
        out.priority = "u=1, i";
        out["sec-ch-ua"] = hints.secChUa;
        out["sec-ch-ua-mobile"] = hints.secChUaMobile;
        out["sec-ch-ua-platform"] = hints.secChUaPlatform;
    }
    out["sec-fetch-dest"] = "empty";
    out["sec-fetch-mode"] = "cors";
    out["sec-fetch-site"] = fetchSiteOf(url);
    return out;
}

/**
 * Wrap a fetch so every request carries the browser headers it lacks. A header the caller already set (in
 * any letter case) is never replaced.
 *
 * @param {typeof fetch} inner - the fetch to call, the proxy-aware one when a proxy is configured
 * @param {string} userAgent
 * @returns {typeof fetch}
 */
export function withBrowserHeaders(inner, userAgent) {
    return (input, init = {}) => {
        const extra = browserHeadersFor(userAgent, String(input));
        const given = init.headers;
        let headers;
        if (given instanceof Headers) {
            headers = new Headers(given);
            for (const [k, v] of Object.entries(extra)) if (!headers.has(k)) headers.set(k, v);
        } else {
            headers = { ...(given ?? {}) };
            const have = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
            for (const [k, v] of Object.entries(extra)) if (!have.has(k)) headers[k] = v;
        }
        return inner(input, { ...init, headers });
    };
}
