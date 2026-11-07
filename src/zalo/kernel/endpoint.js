/**
 * The table runner: one endpoint definition in, one Zalo call out. Every area module (`src/zalo/api/*.js`) and the
 * web-call tables (`reads.js`, `writes.js`) describe their calls as data and run them through here.
 *
 * An endpoint definition (design 1.2):
 *
 * ```
 * { host, path, cmd,                       // service-map key (or a list, first present wins), path, Web command id
 *   method: "get"|"post"|"query"|"multipart",
 *   paramsFirst: true,                      // GET only: `params` before zpw_ver and zpw_type
 *   body(args, ctx) -> object|string|null,  // sealed with the session key into `params`
 *   query(args, ctx) -> object,             // plain query keys after zpw_ver, zpw_type, params (`extraQuery` too)
 *   file(args) -> {field, filename, type, bytes},   // multipart only
 *   fields(args) -> object,                 // multipart only: plain form fields before the file
 *   headers(args) -> object,                // over the transport's defaults
 *   reply: "session"|"plain",
 *   okCodes: [n...],                        // inner codes that are an answer, not an error
 *   emptyOn: {code: value},                 // a code that means "nothing", and what to return for it
 *   bigIdKeys: [key...],                    // parse the reply losslessly for these keys (json-ids.js)
 *   timeoutMs,                              // 10 s by default; none for a multipart body
 *   swapHosts: true,                        // an HTTP 4xx/5xx moves on to the service map's next host (Web's
 *                                           // switchDomain), once per host the map lists
 *   transform(data, args, {code, message}) -> value }
 * ```
 *
 * The wire shape: a GET puts `params` in the query (`zpw_ver`, `zpw_type`, `params`, then `query`); a POST sends
 * `params` as a URL-encoded form; a multipart call puts `params` in the query and the file in the body; `query`
 * sends the body's keys as a plain, unsealed query.
 */
import { ZaloApiError } from "../errors.js";
import { buildUrl, decodeReply, httpRequest, multipartBody, sealParams } from "./http.js";

/** Where login and settings questions go: Zalo Web's `authDomain`. */
export const AUTH_DOMAIN = "https://wpa.chat.zalo.me";

/** Raised for an unknown name, a missing argument or a host the account lacks, before any request is made. */
export class CallUsageError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "CallUsageError";
    }
}

/**
 * The base URL of a service-map key, without a trailing slash.
 *
 * @param {Record<string, string|string[]>|null|undefined} serviceMap
 * @param {string|string[]} key - a key, or keys to try in order (`["group_poll", "group"]`); "auth" is Web's
 *   `authDomain`
 * @returns {string}
 * @throws {CallUsageError} naming the key when the map has none of them
 */
export function hostOf(serviceMap, key) {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
        if (k === "auth") return AUTH_DOMAIN;
        const v = serviceMap?.[k];
        const url = Array.isArray(v) ? v[0] : v;
        if (url) return String(url).replace(/\/+$/, "");
    }
    throw new CallUsageError(`this account's service map has no "${keys.join('" or "')}" host`);
}

/**
 * Every base URL a service-map key names, in the map's order, without trailing slashes: the hosts Zalo Web's
 * `switchDomain` moves through after an HTTP 4xx/5xx. The first present key wins, as in {@link hostOf}.
 *
 * @param {Record<string, string|string[]>|null|undefined} serviceMap
 * @param {string|string[]} key
 * @returns {string[]} at least one
 * @throws {CallUsageError} naming the key when the map has none of them
 */
export function hostsOf(serviceMap, key) {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
        if (k === "auth") return [AUTH_DOMAIN];
        const v = serviceMap?.[k];
        const urls = (Array.isArray(v) ? v : [v]).filter(Boolean).map((u) => String(u).replace(/\/+$/, ""));
        if (urls.length) return [...new Set(urls)];
    }
    throw new CallUsageError(`this account's service map has no "${keys.join('" or "')}" host`);
}

/** Whether an error is an HTTP 4xx/5xx answer (decodeReply's `HTTP <status>`), the case Web's switchDomain handles. */
function isHttpFailure(e) {
    const status = Number(e?.status);
    return e instanceof ZaloApiError && status >= 400 && status < 600;
}

/**
 * Build the request of a definition without sending it.
 *
 * @param {object} ctx - the session
 * @param {string} base - the full endpoint URL (host and path), no query
 * @param {object} def - the definition
 * @param {object} [args]
 * @returns {{method: "GET"|"POST", url: string, body?: URLSearchParams|FormData, headers: Record<string, string>,
 *   json: object|string|null, def: object}} `json` is what was sealed into `params`, before sealing
 */
export function buildRequest(ctx, base, def, args = {}) {
    const body = def.body ? def.body(args, ctx) : null;
    const headers = def.headers ? def.headers(args) : {};
    const queryFn = def.query ?? def.extraQuery;
    const extra = queryFn ? queryFn(args, ctx) : {};
    const method = def.method ?? "get";

    if (method === "query") {
        const plain = {};
        for (const [k, v] of Object.entries(body || {})) plain[k] = String(v);
        return { method: "GET", url: buildUrl(ctx, base, { ...plain, ...extra }), headers, json: body, def };
    }
    if (body === null || body === undefined) {
        if (method === "post") {
            return { method: "POST", url: buildUrl(ctx, base, extra), headers, json: null, def };
        }
        return { method: "GET", url: buildUrl(ctx, base, extra), headers, json: null, def };
    }
    const params = sealParams(ctx, body);
    if (method === "post") {
        return {
            method: "POST",
            url: buildUrl(ctx, base, extra),
            body: new URLSearchParams({ params }),
            headers,
            json: body,
            def,
        };
    }
    if (method === "multipart") {
        if (!def.file) throw new CallUsageError("a multipart endpoint needs a file");
        const form = multipartBody(def.file(args), def.fields ? def.fields(args) : {});
        return { method: "POST", url: buildUrl(ctx, base, { params, ...extra }), body: form, headers, json: body, def };
    }
    if (def.paramsFirst) {
        const query = { params, zpw_ver: ctx.API_VERSION, zpw_type: ctx.API_TYPE, ...extra };
        return { method: "GET", url: buildUrl(ctx, base, query, { version: false }), headers, json: body, def };
    }
    return { method: "GET", url: buildUrl(ctx, base, { params, ...extra }), headers, json: body, def };
}

/** The lossless parser for a definition's `bigIdKeys` (json-ids.js, loaded only when an endpoint asks for it). */
async function parserFor(def) {
    if (!def.bigIdKeys?.length) return JSON.parse;
    let mod;
    try {
        mod = await import("./json-ids.js");
    } catch (e) {
        throw new ZaloApiError(`bigIdKeys needs src/zalo/kernel/json-ids.js: ${e?.message ?? e}`);
    }
    return (text) => JSON.parse(mod.preParse(text, def.bigIdKeys));
}

/**
 * Send a built request and decode its reply as its definition says.
 *
 * @param {object} ctx - the session
 * @param {ReturnType<typeof buildRequest>} req
 * @param {object} [args] - handed to `transform`
 * @returns {Promise<any>}
 * @throws {ZaloApiError} Zalo's own error, with its code on `.code`
 */
export async function sendRequest(ctx, req, args = {}) {
    const def = req.def;
    const init = { method: req.method, headers: req.headers };
    if (req.body !== undefined) init.body = req.body;
    init.timeoutMs = def.timeoutMs ?? (def.method === "multipart" ? 0 : undefined);
    if (init.timeoutMs === undefined) delete init.timeoutMs;
    const res = await httpRequest(ctx, req.url, init);
    const reply = await decodeReply(ctx, res, {
        encrypted: def.reply !== "plain",
        okCodes: def.okCodes ?? [],
        emptyOn: def.emptyOn ?? null,
        parse: await parserFor(def),
        envelope: true,
    });
    return def.transform ? def.transform(reply.data, args, { code: reply.code, message: reply.message }) : reply.data;
}

/**
 * Run one endpoint definition.
 *
 * @param {{ctx?: object, host?: Function, api?: object}|object} target - a session handle `s` (`s.ctx`, `s.host`)
 *   or a logged-in api (`getContext()`, `zpwServiceMap`)
 * @param {object} def - the definition (see the module comment)
 * @param {object} [args]
 * @returns {Promise<any>}
 * @throws {CallUsageError} for a host the account lacks; {@link ZaloApiError} for Zalo's own error
 */
export async function callEndpoint(target, def, args = {}) {
    const ctx = target?.ctx ?? target?.getContext?.();
    if (!ctx) throw new Error("Not logged in. Run: zalo-agent login");
    const map = target.zpwServiceMap ?? target.api?.zpwServiceMap ?? ctx.loginInfo?.zpw_service_map_v3;
    if (def.swapHosts) {
        const bases = typeof target.hosts === "function" ? target.hosts(def.host) : hostsOf(map, def.host);
        let last;
        for (const base of bases) {
            try {
                return await sendRequest(ctx, buildRequest(ctx, `${base}${def.path}`, def, args), args);
            } catch (e) {
                if (!isHttpFailure(e)) throw e;
                last = e;
            }
        }
        if (bases.length > 1) last.message = `${last.message} (on each of the ${bases.length} hosts tried)`;
        throw last;
    }
    const base = typeof target.host === "function" ? target.host(def.host) : hostOf(map, def.host);
    const req = buildRequest(ctx, `${base}${def.path}`, def, args);
    return sendRequest(ctx, req, args);
}
