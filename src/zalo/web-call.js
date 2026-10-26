/**
 * One call to Zalo Web's HTTP API, built and sent the way zca-js's own endpoints are, for the tables of reads
 * (./reads.js) and writes (./writes.js).
 *
 * A table entry names a service-map host, a path and a body. The body is JSON, AES-encrypted with the session key into
 * `params` (in the query of a GET, in the form body of a POST), beside `zpw_ver` and `zpw_type`; the reply is the
 * ordinary session envelope. Two kinds of entry differ: `method: "query"` sends a plain unencrypted query, and
 * `reply: "plain"` reads a reply whose `data` is not encrypted (the login host's questions).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let utilsCache = null;
function zcaUtils() {
    if (!utilsCache) utilsCache = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return utilsCache;
}

/** Where login and settings questions go: Zalo Web's `authDomain`. */
const AUTH_DOMAIN = "https://wpa.chat.zalo.me";

/** An argument as a list: a list stays one, nothing is empty, a lone value is its own list. */
export const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
/** A number argument with a default for an absent or empty one. */
export const num = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
/** One declared argument of a table entry. */
export const arg = (name, type, desc, required = false) => ({ name, type, desc, required });

/** Raised for an unknown name, a missing argument or a host the account lacks, before any request is made. */
export class CallUsageError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "CallUsageError";
    }
}

/** Zalo's own error, from a plain reply. */
export class CallError extends Error {
    /**
     * @param {string} message
     * @param {number} code - Zalo's error_code
     */
    constructor(message, code) {
        super(message);
        this.name = "CallError";
        this.code = code;
    }
}

/** The service-map base URL of a host. */
function baseOf(api, host) {
    if (host === "auth") return AUTH_DOMAIN;
    const v = api?.zpwServiceMap?.[host];
    const url = Array.isArray(v) ? v[0] : v;
    if (!url) throw new CallUsageError(`this account's service map has no "${host}" host`);
    return String(url).replace(/\/+$/, "");
}

/** Run `fn(ctx, utils)` inside zca-js's authenticated envelope, synchronously for a builder. */
function withZca(api, fn) {
    return zcaUtils().apiFactory()((_api, ctx, utils) => fn(ctx, utils))(api.getContext(), api);
}

/**
 * Build the request of a table entry without sending it.
 *
 * @param {object} api - logged-in zca-js api
 * @param {object} def - the entry: host, path, method, args, body, headers, extraQuery, reply, okCodes
 * @param {string} name - the entry's name, for messages
 * @param {object} [args]
 * @returns {{method: "GET"|"POST", url: string, body?: URLSearchParams, headers: Record<string,string>,
 *   json: object|string|null, def: object}} `json` is what is encrypted into `params`, before encryption
 * @throws {CallUsageError} for a missing required argument or a host the account's service map lacks
 */
export function buildCall(api, def, name, args = {}) {
    for (const a of def.args) {
        if (a.required && (args[a.name] === undefined || args[a.name] === null || args[a.name] === "")) {
            throw new CallUsageError(`"${name}" needs "${a.name}" (${a.desc})`);
        }
    }
    return withZca(api, (ctx, utils) => {
        const base = `${baseOf(api, def.host)}${def.path}`;
        const body = def.body ? def.body(args, ctx) : null;
        const headers = def.headers ? def.headers(args) : {};
        if (def.method === "query") {
            const query = {};
            for (const [k, v] of Object.entries(body || {})) query[k] = String(v);
            return { method: "GET", url: utils.makeURL(base, query), headers, json: body, def };
        }
        const extra = def.extraQuery ? def.extraQuery(args) : {};
        if (body === null) return { method: "GET", url: utils.makeURL(base, extra), headers, json: null, def };
        const text = typeof body === "string" ? body : JSON.stringify(body);
        const params = utils.encodeAES(text);
        if (params === null || params === undefined) throw new Error("could not encrypt the request's params");
        if (def.method === "post") {
            return {
                method: "POST",
                url: utils.makeURL(base, extra),
                body: new URLSearchParams({ params }),
                headers,
                json: body,
                def,
            };
        }
        return { method: "GET", url: utils.makeURL(base, { ...extra, params }), headers, json: body, def };
    });
}

/**
 * Send a built request and decode the reply.
 *
 * @param {object} api - logged-in zca-js api
 * @param {ReturnType<typeof buildCall>} req
 * @returns {Promise<any>} the reply's data
 * @throws {Error} Zalo's own error (code in `.code`) when the reply is one
 */
export async function runCall(api, req) {
    const init = { method: req.method };
    if (req.body) init.body = req.body;
    if (Object.keys(req.headers).length) init.headers = req.headers;
    return withZca(api, async (_ctx, utils) => {
        const resp = await utils.request(req.url, init);
        if (req.def.reply !== "plain") return utils.resolve(resp);
        // A plain reply: `{error_code, error_message, data}` with `data` unencrypted (the login host's questions).
        const body = await resp.json();
        const code = Number(body?.error_code ?? 0);
        if (code !== 0 && !(req.def.okCodes || []).includes(code)) {
            throw new CallError(body?.error_message || `error ${code}`, code);
        }
        return body?.data ?? null;
    });
}
