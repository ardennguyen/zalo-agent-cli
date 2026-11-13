/**
 * One call to Zalo's HTTP API, for the tables of reads (./reads.js) and writes (./writes.js), built and sent by
 * the kernel's table runner (./kernel/endpoint.js).
 *
 * A table entry names a service-map host, a path and a body. The body is JSON, AES-encrypted with the session key into
 * `params` (in the query of a GET, in the form body of a POST), beside `zpw_ver` and `zpw_type`; the reply is the
 * ordinary session envelope. Two kinds of entry differ: `method: "query"` sends a plain unencrypted query, and
 * `reply: "plain"` reads a reply whose `data` is not encrypted (the login host's questions).
 */
import { CallUsageError, buildRequest, hostOf, sendRequest } from "./kernel/endpoint.js";
import { httpRequest } from "./kernel/http.js";

export { CallUsageError };

/** An argument as a list: a list stays one, nothing is empty, a lone value is its own list. */
export const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
/** A number argument with a default for an absent or empty one. */
export const num = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
/**
 * One declared argument of a table entry. `values` names the numbers of an enum Zalo expects (`{accept: 1}`):
 * a name is accepted wherever the number is.
 */
export const arg = (name, type, desc, required = false, values = undefined) => ({
    name,
    type,
    desc,
    required,
    ...(values && { values }),
});

/**
 * An enum argument as the number Zalo expects: a number stays, a name is looked up (case-insensitively).
 *
 * @param {number|string|undefined} v
 * @param {Record<string, number>} values
 * @param {number} [fallback] - for an absent value
 * @returns {number}
 * @throws {CallUsageError} for a name the enum does not have
 */
export function enumNum(v, values, fallback) {
    if (v === undefined || v === null || v === "") return fallback;
    if (typeof v === "number" || /^-?\d+$/.test(String(v))) return Number(v);
    const hit = Object.entries(values).find(([k]) => k.toLowerCase() === String(v).toLowerCase());
    if (!hit) throw new CallUsageError(`"${v}" is not one of: ${Object.keys(values).join(", ")}`);
    return hit[1];
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

/**
 * Build the request of a table entry without sending it.
 *
 * @param {object} api - a logged-in session
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
    const ctx = api.getContext();
    return buildRequest(ctx, `${hostOf(api?.zpwServiceMap, def.host)}${def.path}`, def, args);
}

/**
 * Send a built request and decode the reply.
 *
 * @param {object} api - a logged-in session
 * @param {ReturnType<typeof buildCall>} req
 * @returns {Promise<any>} the reply's data
 * @throws {Error} Zalo's own error (code in `.code`) when the reply is one
 */
export async function runCall(api, req) {
    const ctx = api.getContext();
    if (req.def.reply !== "plain") return sendRequest(ctx, req);
    // A plain reply: `{error_code, error_message, data}` with `data` unencrypted (the login host's questions).
    const init = { method: req.method, headers: req.headers };
    if (req.body) init.body = req.body;
    const resp = await httpRequest(ctx, req.url, init);
    const body = await resp.json();
    const code = Number(body?.error_code ?? 0);
    if (code !== 0 && !(req.def.okCodes || []).includes(code)) {
        throw new CallError(body?.error_message || `error ${code}`, code);
    }
    return body?.data ?? null;
}
