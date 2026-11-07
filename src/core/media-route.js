/**
 * `/zalo/media/<token>`: a media link (src/core/media-deliver.js) served from the sealed file, a range at a time.
 *
 * - Mounted on the MCP HTTP server (`mcp start --http`), before its bearer check: a `bearer` link checks the server's
 *   own Authorization here, a `capability` link is admitted by its token (and, off loopback, by the client window of
 *   MediaLinks#admit). Under stdio, a 127.0.0.1 listener is started on first use, as for the secure page.
 * - GET and HEAD, one byte range (`206`, or `416` with `Content-Range: bytes *\/<size>`); several ranges get the whole
 *   file (`200`). Only the chunks a range needs are decrypted.
 * - Every answer: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
 *   `Content-Security-Policy: default-src 'none'; sandbox`. A type off the allow-list is sent as
 *   `application/octet-stream` with `Content-Disposition: attachment`.
 * - Per client address: `media.linkRateLimit` requests a minute and 10 unknown or ended tokens a minute, then `429`; at
 *   most 4 streams at once per link.
 * - The access log line has the path with the token masked, the status, the bytes and the time: never the token, the
 *   query, an Authorization or a Referer.
 * - The client address is the connection's peer; `X-Forwarded-For` only when the peer is a trusted proxy
 *   (`trustedProxies`, src/core/deploy-policy.js).
 */
import http from "node:http";
import { openMedia } from "./keystore/media-seal.js";
import {
    MEDIA_PATH_PREFIX,
    MEDIA_TOKEN_SHAPE,
    SAFE_MEDIA_MIME,
    getMediaLinks,
    maskMediaPath,
    safeMediaName,
} from "./media-deliver.js";

/** Streams one link may have open at once. */
export const MAX_STREAMS_PER_LINK = 4;
/** Unknown or ended tokens one client address may try in a minute. */
export const BAD_TOKENS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;
const PATH_SHAPE = /^\/zalo\/media\/([^/?#]*)\/?(?:[?#].*)?$/;

/**
 * An address as one spelling: lower case, no brackets, an IPv4-mapped IPv6 address as plain IPv4.
 *
 * @param {unknown} address
 * @returns {string}
 */
export function normalizeIp(address) {
    let s = String(address ?? "")
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "");
    if (s.startsWith("::ffff:") && s.includes(".")) s = s.slice(7);
    return s;
}

/**
 * True for this machine's own addresses (127.0.0.0/8, ::1).
 *
 * @param {unknown} address
 * @returns {boolean}
 */
export function isLoopbackIp(address) {
    const ip = normalizeIp(address);
    return ip === "::1" || /^127\./.test(ip);
}

function trusted(ip, list) {
    return list.includes(ip) || (list.includes("loopback") && isLoopbackIp(ip));
}

/**
 * The client's address: the connection's peer, or, when that peer is a trusted proxy, the right-most
 * `X-Forwarded-For` entry that is not itself a trusted proxy.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {string[]} [trustedProxies]
 * @returns {string}
 */
export function clientIpOf(req, trustedProxies = []) {
    const peer = normalizeIp(req.socket?.remoteAddress);
    if (!trustedProxies.length || !trusted(peer, trustedProxies)) return peer;
    const header = req.headers?.["x-forwarded-for"];
    const hops = (Array.isArray(header) ? header.join(",") : String(header ?? ""))
        .split(",")
        .map(normalizeIp)
        .filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
        if (!trusted(hops[i], trustedProxies)) return hops[i];
    }
    return hops[0] || peer;
}

/** Per-address request and bad-token counters of one MediaLinks, in fixed one-minute windows. */
const limiters = new WeakMap();

function limiterOf(links) {
    let l = limiters.get(links);
    if (!l) {
        l = new Map();
        limiters.set(links, l);
    }
    return l;
}

function windowFor(map, ip, now) {
    let w = map.get(ip);
    if (!w || now - w.start >= WINDOW_MS) {
        if (map.size > 10_000) {
            for (const [k, v] of map) if (now - v.start >= WINDOW_MS) map.delete(k);
        }
        w = { start: now, requests: 0, bad: 0 };
        map.set(ip, w);
    }
    return w;
}

/**
 * Parse a `Range` header against a size.
 *
 * @param {unknown} header
 * @param {number} size
 * @returns {null | "unsatisfiable" | {start: number, end: number}} null: serve the whole file
 */
export function parseRange(header, size) {
    if (header === undefined || header === null || header === "") return null;
    const m = /^\s*bytes\s*=\s*(.+)$/i.exec(String(header));
    if (!m || m[1].includes(",")) return null;
    const r = /^\s*(\d*)\s*-\s*(\d*)\s*$/.exec(m[1]);
    if (!r || (r[1] === "" && r[2] === "")) return null;
    if (r[1] === "") {
        const n = Number(r[2]);
        if (n === 0 || size === 0) return "unsatisfiable";
        return { start: Math.max(0, size - n), end: size - 1 };
    }
    const start = Number(r[1]);
    const end = r[2] === "" ? size - 1 : Math.min(Number(r[2]), size - 1);
    if (start >= size || start > end) return "unsatisfiable";
    return { start, end };
}

/** The headers every answer of this route carries. */
const BASE_HEADERS = Object.freeze({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; sandbox",
});

function contentDisposition(kind, name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Answer a request for a media link, if it is one.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {object} [opts]
 * @param {import("./media-deliver.js").MediaLinks} [opts.links]
 * @param {((req: import("node:http").IncomingMessage) => boolean)|null} [opts.authorize] - the server's own bearer
 *   check; null when the server checks none
 * @param {() => number} [opts.now]
 * @returns {Promise<boolean>} false when the path is not a media link
 */
export async function handleMediaRequest(req, res, { links = getMediaLinks(), authorize = null, now = Date.now } = {}) {
    const m = PATH_SHAPE.exec(req.url || "");
    if (!m) return false;
    const started = now();
    let bytes = 0;
    let logged = false;
    const logLine = () => {
        if (logged) return;
        logged = true;
        links.log(
            `[media] ${req.method} ${maskMediaPath(String(req.url).split("?")[0])} -> ${res.statusCode} ${bytes}B ${now() - started}ms`,
        );
    };
    res.on("finish", logLine);
    res.on("close", logLine);
    const fail = (status, text, extra = {}) => {
        if (res.headersSent) return true;
        res.writeHead(status, {
            ...BASE_HEADERS,
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": Buffer.byteLength(text),
            ...extra,
        });
        res.end(req.method === "HEAD" ? undefined : text);
        return true;
    };

    if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "Method not allowed\n", { Allow: "GET, HEAD" });
    const ip = clientIpOf(req, links.trustedProxies || []);
    const w = windowFor(limiterOf(links), ip, now());
    w.requests++;
    if (w.requests > links.rateLimit || w.bad >= BAD_TOKENS_PER_MINUTE) {
        return fail(429, "Too many requests\n", {
            "Retry-After": String(Math.ceil((w.start + WINDOW_MS - now()) / 1000)),
        });
    }
    // A server whose links need its bearer token says 401 before it says anything about the token.
    const needsBearer = links.linkAuth === "bearer" && links.bearerAvailable;
    const authed = () => (authorize ? authorize(req) === true : false);
    const unauthorized = () => fail(401, "Unauthorized\n", { "WWW-Authenticate": 'Bearer realm="zalo-media"' });
    if (needsBearer && !authed()) return unauthorized();

    let token = "";
    try {
        token = decodeURIComponent(m[1] || "");
    } catch {
        /* malformed escape: not a token */
    }
    const found = MEDIA_TOKEN_SHAPE.test(token) ? links.lookup(token) : { unknown: true };
    if (found.unknown) {
        w.bad++;
        return fail(404, "Not found\n");
    }
    if (found.gone) {
        w.bad++;
        return fail(410, `This link has ended: ${found.gone}.\n`);
    }
    const link = found.link;
    if (link.auth === "bearer" && !needsBearer && !authed()) return unauthorized();
    if (!links.admit(link, ip)) return fail(403, "This link is in use from other addresses.\n");
    if (link.streams.size >= MAX_STREAMS_PER_LINK) {
        return fail(429, "Too many downloads of this link at once\n", { "Retry-After": "5" });
    }

    let media;
    try {
        media = openMedia(link.file, link.scope, { msgId: link.msgId });
    } catch (e) {
        links.log(`[media] a linked file could not be read: ${e?.code || e?.message || e}`);
        return fail(500, "This media cannot be read.\n");
    }
    const size = media.size;
    const range = parseRange(req.headers.range, size);
    if (range === "unsatisfiable") {
        media.close();
        return fail(416, "Range not satisfiable\n", { "Content-Range": `bytes */${size}` });
    }
    const safe = SAFE_MEDIA_MIME.has(link.mime);
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, {
        ...BASE_HEADERS,
        "Content-Type": safe ? link.mime : "application/octet-stream",
        "Content-Disposition": contentDisposition(safe ? "inline" : "attachment", safeMediaName(link.name)),
        "Accept-Ranges": "bytes",
        "Content-Length": length,
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === "HEAD" || length === 0) {
        media.close();
        res.end();
        return true;
    }
    const stream = media.stream({ start, end });
    link.streams.add(stream);
    stream.on("data", (chunk) => (bytes += chunk.length));
    stream.on("error", (e) => {
        links.log(`[media] a linked file failed mid-stream: ${e?.code || e?.message || e}`);
        res.destroy();
    });
    res.on("close", () => {
        link.streams.delete(stream);
        stream.destroy();
    });
    stream.pipe(res);
    return true;
}

/**
 * Serve the links on a 127.0.0.1 listener when no HTTP server mounts the route (stdio). Idempotent.
 *
 * @param {import("./media-deliver.js").MediaLinks} [links]
 * @returns {Promise<void>}
 */
export async function ensureMediaServed(links = getMediaLinks()) {
    if (links.mounted || links.listener) return;
    const server = http.createServer((req, res) => {
        handleMediaRequest(req, res, { links })
            .then((handled) => {
                if (!handled && !res.headersSent) {
                    res.writeHead(404, { ...BASE_HEADERS, "Content-Type": "text/plain" });
                    res.end("Not found\n");
                }
            })
            .catch(() => {
                if (!res.headersSent) res.writeHead(500, BASE_HEADERS).end();
            });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    server.unref();
    links.listener = server;
    links.localBaseUrl = `http://127.0.0.1:${server.address().port}`;
}

/**
 * Stop the stdio listener (tests, shutdown).
 *
 * @param {import("./media-deliver.js").MediaLinks} [links]
 * @returns {Promise<void>}
 */
export async function closeMediaListener(links = getMediaLinks()) {
    const l = links.listener;
    links.listener = null;
    if (l) await new Promise((resolve) => l.close(() => resolve()));
}

export { MEDIA_PATH_PREFIX };
