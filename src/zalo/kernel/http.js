/**
 * The transport every Zalo call goes through: URLs, headers, cookies, redirects, timeouts, and the reply envelope.
 *
 * Wire facts this follows (spec-kernel 6-8; Zalo Web's HTTP client `fBUP`), with the points where the previous engine differed:
 *
 * - URL (D1): `zpw_ver` and `zpw_type` come first, then the endpoint's own parameters in insertion order, each value
 *   escaped with `encodeURIComponent`. The login host's calls carry no version pair (`{version: false}`).
 * - Headers of an API call (an XHR): `Accept: application/json, text/plain, * / *` (no spaces), `Origin:
 *   https://chat.zalo.me`, `Referer: https://chat.zalo.me/`, `User-Agent`, `Accept-Language`, and `Content-Type:
 *   application/x-www-form-urlencoded` on a form POST only (D2). `Accept-Encoding` is left to fetch (D4). Names are
 *   compared without regard to case, so a caller's `origin` replaces the default `Origin` instead of joining it.
 * - Cookies (D5, D6): the `Cookie` header is the jar's answer for the full URL; every `Set-Cookie` is stored against
 *   the URL of the request that received it.
 * - Redirects (D7): `follow: "jar"` follows them here, as a browser navigation does: at most 10 hops, a relative
 *   `Location` resolved against the current URL, 301/302/303 become a GET without a body, 307/308 keep both, every
 *   hop's cookies stored, each hop sent with navigation headers. The `Referer` stays the page that started the
 *   navigation (cut to its origin on a cross-origin hop) and `sec-fetch-site` is the initiator's relation to each
 *   hop, never better than an earlier hop's, as the Fetch standard has it.
 * - Timeout: 10 s unless the caller says otherwise (Web's default); `timeoutMs: 0` waits as long as it takes.
 * - The reply: HTTP 2xx, outer `error_code` 0, then (for a session reply) the `data` opened with the session key and
 *   its inner `error_code` 0; the answer is the inner `data`. Errors are thrown as `ZaloApiError(message, code)`.
 *
 * The fetch called is always `ctx.options.polyfill` (the proxy fetch, the browser-header wrapper, upkeep's activity
 * tracker and every test fake sit behind it). Nothing here writes to stdout or logs a cookie, key or id.
 */
import { Blob } from "node:buffer";
import { ZaloApiError } from "../errors.js";
import { openSession, sealSession } from "./cipher.js";
import { cookieHeader, newJar, storeSetCookies } from "./cookies.js";
import { ACCEPT_LANGUAGE } from "../profile.js";

/** Zalo Web's default request timeout. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** The most redirects a navigation follows. */
export const MAX_REDIRECTS = 10;

/** Where Zalo Web's page lives: the origin of every API call it makes. */
const CHAT_ORIGIN = "https://chat.zalo.me";

/** The `Accept-Language` of every call, from the client's identity in `src/zalo/profile.js` (spec-kernel D3). */
export { ACCEPT_LANGUAGE };

/** Headers of an XHR from the chat page. */
const XHR_HEADERS = Object.freeze({
    accept: "application/json, text/plain, */*",
    origin: CHAT_ORIGIN,
    referer: `${CHAT_ORIGIN}/`,
});

/** Headers of a page load (and of each hop of a redirect it follows). */
export const NAVIGATION_HEADERS = Object.freeze({
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    priority: "u=0, i",
    "upgrade-insecure-requests": "1",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
});

const FORM_TYPE = "application/x-www-form-urlencoded";
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * A URL with Zalo's common query first.
 *
 * @param {{API_VERSION?: number, API_TYPE?: number}} ctx
 * @param {string} base - a URL, possibly with a query already
 * @param {Record<string, unknown>} [params] - appended in order; `undefined` values are left out, `null` is "null"
 * @param {{version?: boolean}} [opts] - `version: false` for the login host's calls
 * @returns {string}
 */
export function buildUrl(ctx, base, params = {}, { version = true } = {}) {
    const url = new URL(base);
    const pairs = [...url.searchParams.entries()];
    const has = (name) => pairs.some(([k]) => k === name);
    const head = [];
    if (version) {
        if (!has("zpw_ver")) head.push(["zpw_ver", String(ctx.API_VERSION)]);
        if (!has("zpw_type")) head.push(["zpw_type", String(ctx.API_TYPE)]);
    }
    const tail = [];
    for (const [k, v] of Object.entries(params ?? {})) {
        if (v === undefined) continue;
        tail.push([k, String(v)]);
    }
    url.search = "";
    const query = [...head, ...pairs, ...tail]
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
    return query ? `${url.toString()}?${query}` : url.toString();
}

/**
 * Seal request params with the session key.
 *
 * @param {{secretKey?: string|null}} ctx
 * @param {object|string} value - an object is JSON-encoded
 * @returns {string} base64
 * @throws {Error} when the session has no key (not logged in), or the key does not seal
 */
export function sealParams(ctx, value) {
    if (!ctx?.secretKey) throw new Error("Not logged in. Run: zalo-agent login");
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const sealed = sealSession(ctx.secretKey, text);
    if (sealed === null) throw new ZaloApiError("Failed to encrypt params");
    return sealed;
}

/**
 * A multipart body: one file part plus plain fields. fetch writes the `multipart/form-data` content type and its
 * boundary itself.
 *
 * @param {{field: string, filename: string, type?: string, bytes: Uint8Array|ArrayBuffer|Blob}} file
 * @param {Record<string, string|number>} [fields]
 * @returns {FormData}
 */
export function multipartBody(file, fields = {}) {
    const form = new globalThis.FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    const blob =
        file.bytes instanceof Blob
            ? file.bytes
            : new Blob([file.bytes], { type: file.type || "application/octet-stream" });
    form.append(file.field, blob, file.filename);
    return form;
}

/**
 * Headers as a plain object of lowercase names.
 *
 * @param {Record<string, unknown>|Headers|null|undefined} headers
 * @returns {Record<string, string>}
 */
export function lowerHeaders(headers) {
    const out = {};
    if (!headers) return out;
    const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
    for (const [k, v] of entries) if (v !== undefined && v !== null) out[String(k).toLowerCase()] = String(v);
    return out;
}

/** Whether a body is a URL-encoded form: a FormData or binary body gets its own content type. */
function isForm(body) {
    return body instanceof URLSearchParams || typeof body === "string";
}

/** The registrable part of a host, for the hosts Zalo uses (zalo.me, zaloapp.com, zdn.vn). */
const siteOf = (host) => host.split(".").slice(-2).join(".");

/** "same-origin", "same-site", "cross-site" (or "none" without an initiator) of a URL as seen from an origin. */
function relation(fromOrigin, url) {
    if (!fromOrigin) return "none";
    const from = new URL(fromOrigin);
    const to = new URL(url);
    if (from.origin === to.origin) return "same-origin";
    return from.protocol === to.protocol && siteOf(from.hostname) === siteOf(to.hostname) ? "same-site" : "cross-site";
}

const SITE_RANK = { none: 0, "same-origin": 1, "same-site": 2, "cross-site": 3 };

/** The `Referer` a navigation hop carries: the initiator's full URL same-origin, its origin otherwise. */
function referrerFor(initiator, url) {
    if (!initiator) return null;
    const from = new URL(initiator);
    const to = new URL(url);
    if (from.origin === to.origin) return from.toString();
    if (from.protocol === "https:" && to.protocol === "http:") return null;
    return `${from.origin}/`;
}

/**
 * The headers of one request.
 *
 * @param {object} ctx
 * @param {string} url
 * @param {string} method
 * @param {unknown} body
 * @param {Record<string, string>} caller - lowercase names
 * @param {"xhr"|"navigate"} kind
 * @returns {Record<string, string>}
 */
function headersFor(ctx, url, method, body, caller, kind) {
    const out = { ...(kind === "navigate" ? NAVIGATION_HEADERS : XHR_HEADERS) };
    if (method !== "GET" && method !== "HEAD" && isForm(body)) out["content-type"] = FORM_TYPE;
    out["accept-language"] = ACCEPT_LANGUAGE;
    out["user-agent"] = String(ctx.userAgent);
    const cookie = cookieHeader(ctx.cookie, url);
    if (cookie) out.cookie = cookie;
    return { ...out, ...caller };
}

/**
 * One HTTP request on a session: default headers, the jar in and out, a timeout, and (on request) redirects
 * followed as a browser follows a navigation.
 *
 * @param {object} ctx - the session (`userAgent`, `cookie`, `options.polyfill`)
 * @param {string} url
 * @param {object} [init]
 * @param {string} [init.method] - GET unless given
 * @param {Record<string, string>|Headers} [init.headers] - over the defaults, by name in any case
 * @param {URLSearchParams|FormData|string|Uint8Array} [init.body]
 * @param {AbortSignal} [init.signal]
 * @param {number} [init.timeoutMs] - 10 s by default; 0 for none
 * @param {"auto"|"manual"|"jar"} [init.follow] - "auto" lets fetch follow (the default); "manual" returns a 3xx as
 *   it is; "jar" follows here, hop by hop, keeping every hop's cookies
 * @param {"xhr"|"navigate"} [init.kind] - which default header set (an API call by default)
 * @returns {Promise<Response>}
 * @throws {ZaloApiError} on a timeout ("Zalo did not answer within N s: <path>", `.timeout` true), a redirect loop,
 *   or a session with no User-Agent
 */
export async function httpRequest(ctx, url, init = {}) {
    const {
        method: givenMethod = "GET",
        headers: givenHeaders,
        body: givenBody,
        signal: callerSignal,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        follow = "auto",
        kind = "xhr",
    } = init;
    if (!ctx?.userAgent) throw new ZaloApiError("User agent is not available");
    if (!ctx.cookie) ctx.cookie = newJar();
    const fetchFn = ctx.options?.polyfill ?? globalThis.fetch;

    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
    const signal =
        timeoutSignal && callerSignal
            ? AbortSignal.any([callerSignal, timeoutSignal])
            : (timeoutSignal ?? callerSignal);

    const callerHeaders = lowerHeaders(givenHeaders);
    let method = String(givenMethod).toUpperCase();
    let body = givenBody;
    let current = String(url);
    let headers = headersFor(ctx, current, method, body, callerHeaders, kind);
    const initiator = headers.referer ?? null;
    const initiatorOrigin = initiator ? new URL(initiator).origin : null;
    let site = relation(initiatorOrigin, current);

    for (let hop = 0; ; hop++) {
        const req = { method, headers };
        if (signal) req.signal = signal;
        if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") req.body = body;
        if (follow === "manual" || follow === "jar") req.redirect = "manual";
        else if (init.redirect) req.redirect = init.redirect;
        let res;
        try {
            res = await fetchFn(current, req);
        } catch (e) {
            if (timeoutSignal?.aborted && !callerSignal?.aborted) {
                const err = new ZaloApiError(
                    `Zalo did not answer within ${Math.round(timeoutMs / 1000)} s: ${new URL(current).pathname}`,
                );
                err.timeout = true;
                throw err;
            }
            throw e;
        }
        storeSetCookies(ctx.cookie, current, res);
        const location = res?.headers?.get?.("location");
        if (follow !== "jar" || !REDIRECT_STATUS.has(res.status) || !location) return res;
        if (hop + 1 > MAX_REDIRECTS) throw new ZaloApiError(`Too many redirects (more than ${MAX_REDIRECTS})`);
        try {
            await res.body?.cancel();
        } catch {
            /* nothing to release */
        }

        const next = new URL(location, current).toString();
        const keep = res.status === 307 || res.status === 308;
        if (!keep) {
            method = method === "HEAD" ? "HEAD" : "GET";
            body = undefined;
        }
        const rank = relation(initiatorOrigin, next);
        if (SITE_RANK[rank] > SITE_RANK[site]) site = rank;
        const carried = { ...callerHeaders };
        for (const name of ["referer", "origin", "sec-fetch-site", "cookie", "content-length"]) delete carried[name];
        if (!keep) delete carried["content-type"];
        headers = headersFor(ctx, next, method, body, carried, "navigate");
        const referer = referrerFor(initiator, next);
        if (referer) headers.referer = referer;
        else delete headers.referer;
        headers["sec-fetch-site"] = site;
        if (keep && method !== "GET" && method !== "HEAD" && initiatorOrigin) headers.origin = initiatorOrigin;
        current = next;
    }
}

/** The body of a response as text, from fakes that have only `json()` too. */
async function textOf(response) {
    if (typeof response.text === "function") return response.text();
    return JSON.stringify(await response.json());
}

/** Whether a reply's code says "no error" (Zalo writes 0; a missing code is not a success). */
const isZero = (code) => code !== undefined && code !== null && Number(code) === 0;

/**
 * Decode Zalo's reply envelope.
 *
 * @param {object} ctx - the session (its `secretKey` opens a session reply)
 * @param {Response} response
 * @param {object} [opts]
 * @param {boolean} [opts.encrypted] - a session reply (default) or a plain one, whose `data` is not sealed
 * @param {number[]} [opts.okCodes] - non-zero codes that are an answer, not an error
 * @param {Record<string|number, unknown>|null} [opts.emptyOn] - a code that means "nothing", with the value to return
 * @param {(text: string) => unknown} [opts.parse] - parses the opened text (lossless id parsing); JSON.parse otherwise
 * @param {boolean} [opts.envelope] - return `{data, code, message}` instead of the data alone
 * @returns {Promise<any>}
 * @throws {ZaloApiError} `HTTP <status>` (code null, `.status` set) for a non-2xx; Zalo's message and code for an
 *   outer or inner error, with that envelope's `data` on `.data` when it had one; "Failed to parse response data"
 *   (no code) when the body or `data` does not open
 */
export async function decodeReply(ctx, response, opts = {}) {
    const { encrypted = true, okCodes = [], emptyOn = null, parse = JSON.parse, envelope = false } = opts;
    if (!response?.ok) {
        const err = new ZaloApiError(`HTTP ${response?.status}`, null);
        err.status = response?.status ?? null;
        throw err;
    }
    const answer = (data, code, message) => (envelope ? { data, code, message } : data);
    const settle = (env) => {
        const code = env?.error_code;
        if (isZero(code)) return null;
        const n = Number(code);
        const message = env?.error_message ?? "";
        if (emptyOn && Object.hasOwn(emptyOn, String(n))) {
            return { value: answer(structuredClone(emptyOn[String(n)]), n, message) };
        }
        if (okCodes.includes(n)) return { value: answer(env?.data ?? null, n, message) };
        throw new ZaloApiError(
            env?.error_message ?? `Zalo answered error ${code}`,
            Number.isFinite(n) ? n : null,
            env?.data ?? undefined,
        );
    };

    let outer;
    try {
        outer = JSON.parse(await textOf(response));
    } catch {
        throw new ZaloApiError("Failed to parse response data");
    }
    const first = settle(outer);
    if (first) return first.value;
    if (!encrypted) return answer(outer?.data, 0, outer?.error_message ?? "");

    const opened = openSession(ctx?.secretKey, outer?.data);
    let inner;
    try {
        if (opened === null) throw new Error("does not open");
        inner = parse(opened);
    } catch {
        throw new ZaloApiError("Failed to parse response data");
    }
    const second = settle(inner);
    if (second) return second.value;
    return answer(inner?.data, 0, inner?.error_message ?? "");
}
