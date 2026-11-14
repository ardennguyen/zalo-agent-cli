/**
 * Turn what the fake Zalo recorded, and what an engine returned or threw, into plain data that two engines can be
 * compared on and that a golden file can hold.
 *
 * What is dropped is only what cannot be the same twice: a multipart boundary, the socket's port and
 * `sec-websocket-key`, the `t` stamp on the socket URL. Everything else stays, so a difference in it is seen.
 */
import { createHash } from "node:crypto";

/**
 * The request headers the comparison looks at, lower-cased. The browser-hint headers (`sec-ch-ua*`,
 * `sec-fetch-*`, `priority`) are added by the engine's shared fetch wrapper for both engines alike, so they are
 * left out; the ones the two engines set themselves are in.
 */
export const PICKED_HEADERS = Object.freeze([
    "accept",
    "accept-encoding",
    "accept-language",
    "content-type",
    "cookie",
    "origin",
    "referer",
    "user-agent",
]);

/** Upgrade headers that differ on every connection and say nothing about the client. */
const VOLATILE_UPGRADE_HEADERS = new Set(["host", "sec-websocket-key"]);

/**
 * True for a json-bigint BigNumber (bignumber.js), as a JSON parser that keeps integers past 2^53 hands them out.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function isBigNumber(v) {
    return !!v && typeof v === "object" && (v._isBigNumber === true || v.constructor?.name === "BigNumber");
}

/**
 * A deep, plain copy of any value an engine hands out: big numbers and bigints become their digits, class
 * instances become their own enumerable fields, `undefined` fields and functions are dropped, a Buffer becomes
 * `{type: "Buffer", base64}`, an Error `{message, code?}`, a Date its ISO string.
 *
 * @param {unknown} v
 * @returns {unknown}
 */
export function normalizeValue(v) {
    if (v === null || v === undefined) return v;
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function" || typeof v === "symbol") return undefined;
    if (typeof v !== "object") return v;
    if (isBigNumber(v)) return v.toFixed();
    if (Buffer.isBuffer(v) || v instanceof Uint8Array)
        return { type: "Buffer", base64: Buffer.from(v).toString("base64") };
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
    if (v instanceof Error) return normalizeError(v);
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : normalizeValue(x)));
    if (v instanceof Map) return normalizeValue(Object.fromEntries(v));
    if (v instanceof Set) return normalizeValue([...v]);
    const out = {};
    for (const [k, x] of Object.entries(v)) {
        const n = normalizeValue(x);
        if (n !== undefined) out[k] = n;
    }
    return out;
}

/**
 * The value a call returned, as compared: {@link normalizeValue}.
 *
 * @param {unknown} v
 * @returns {unknown}
 */
export function normalizeResult(v) {
    return normalizeValue(v);
}

/**
 * What a thrown error is compared on: its message and its code (null when it has none).
 *
 * @param {unknown} e
 * @returns {{message: string, code: number|string|null}}
 */
export function normalizeError(e) {
    const code = e && typeof e === "object" && "code" in e ? e.code : null;
    return {
        message: String(e && typeof e === "object" && "message" in e ? e.message : e),
        code: code === undefined ? null : typeof code === "bigint" ? code.toString() : code,
    };
}

/**
 * A multipart content type with its boundary replaced, since every body draws a new one.
 *
 * @param {string|undefined} type
 * @returns {string|undefined}
 */
function stableContentType(type) {
    if (typeof type !== "string") return type;
    return type.replace(/(boundary=)("[^"]*"|[^;\s]+)/i, "$1<boundary>");
}

/**
 * One recorded request (tests/unit/fake-zalo-session.js) as the harness compares it.
 *
 * @param {object} req - an entry of `fake.requests`
 * @param {{reverseHost?: (host: string) => string|null}} [fake] - names the service key of a fake host
 * @returns {{method: string, service: string, path: string, queryOrder: string[], query: object,
 *   params: unknown, paramsOrder: string[]|null, rawParams: string|null, headers: object,
 *   form: object|null, formOrder: string[]|null,
 *   parts: Array<{name: string|null, filename: string|null, type: string|null, size: number, sha256: string}>|null,
 *   body: string|null}}
 *   `service` is the service-map key (the host itself when it is no fake service host); `query` and `form` leave
 *   `params` out, since `params` holds its decrypted value; `body` is a body that is neither a form nor
 *   multipart, as text
 */
export function normalizeRequest(req, fake = {}) {
    const query = { ...req.query };
    delete query.params;
    const params = normalizeValue(req.params ?? null);
    const headers = {};
    for (const name of PICKED_HEADERS) {
        const value = req.headers?.[name];
        if (value !== undefined) headers[name] = name === "content-type" ? stableContentType(value) : value;
    }
    let form = null;
    if (req.form) {
        form = { ...req.form };
        delete form.params;
    }
    const raw = req.rawBody ?? null;
    return {
        method: req.method,
        service: fake.reverseHost?.(req.host) ?? req.host,
        path: req.path,
        queryOrder: [...(req.queryOrder ?? Object.keys(req.query ?? {}))],
        query,
        params,
        paramsOrder: params && typeof params === "object" && !Array.isArray(params) ? Object.keys(params) : null,
        rawParams: req.rawParams ?? null,
        headers,
        form,
        formOrder: req.form ? Object.keys(req.form) : null,
        parts: req.parts
            ? req.parts.map((p) => ({
                  name: p.name,
                  filename: p.filename,
                  type: p.type,
                  size: p.bytes.length,
                  sha256: createHash("sha256").update(p.bytes).digest("hex"),
              }))
            : null,
        body: raw && !req.form && !req.parts ? raw.toString("utf8") : null,
    };
}

/**
 * A socket upgrade as compared: the request path with its `t` stamp blanked, and the headers minus the two that
 * change on every connection (`host` carries the fake's port, `sec-websocket-key` is random). `names` keeps the
 * header names in their own spelling and order, so a misspelled header is seen even where the value matches.
 *
 * @param {{url: string, headers: object, rawHeaders?: string[]}} conn - a connection of the fake socket
 * @returns {{url: string, headers: object, names: string[]}}
 */
export function normalizeUpgrade(conn) {
    const url = new URL(conn.url, "ws://fake.invalid");
    if (url.searchParams.has("t")) url.searchParams.set("t", "<t>");
    const headers = {};
    for (const [k, v] of Object.entries(conn.headers ?? {})) if (!VOLATILE_UPGRADE_HEADERS.has(k)) headers[k] = v;
    const names = [];
    const raw = conn.rawHeaders ?? [];
    for (let i = 0; i < raw.length; i += 2) {
        if (!VOLATILE_UPGRADE_HEADERS.has(raw[i].toLowerCase())) names.push(raw[i]);
    }
    return { url: `${url.pathname}${url.search}`, headers, names };
}

/** A request id of the client's pulls: `req_<n>` from a counter the whole process shares. */
const REQ_ID = /("(?:reqId|req_id)"\s*:\s*")req_\d+(")/g;

/**
 * A frame a client sent, as compared: its header fields, the parsed body, and the bytes as hex.
 *
 * The number in a `reqId`/`req_id` of the `req_<n>` form is masked (`req_<n>`): it comes from one counter
 * (src/zalo/pulls.js) that both listeners of a pair share, so it differs by who asked first, not by engine. The
 * key, its place and its form are still compared.
 *
 * @param {{cmd: number, sub: number, data: object|null, raw?: Buffer}} frame - an entry of the fake socket's
 *   `received`
 * @returns {{version: number|null, cmd: number, sub: number, data: unknown, bytes: string|null}}
 */
export function normalizeFrame(frame) {
    const data = normalizeValue(frame.data);
    for (const key of ["reqId", "req_id"]) {
        if (data && typeof data === "object" && typeof data[key] === "string" && /^req_\d+$/.test(data[key])) {
            data[key] = "req_<n>";
        }
    }
    let bytes = null;
    if (frame.raw) {
        const body = frame.raw.subarray(4).toString("utf8").replace(REQ_ID, "$1req_<n>$2");
        bytes = Buffer.concat([frame.raw.subarray(0, 4), Buffer.from(body, "utf8")]).toString("hex");
    }
    return { version: frame.raw ? frame.raw[0] : null, cmd: frame.cmd, sub: frame.sub, data, bytes };
}
