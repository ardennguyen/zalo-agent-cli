/**
 * Uploads into the account's store (src/core/upload-store.js) over the MCP server's own HTTP port, for a caller on
 * another machine that has a file too large to send inline:
 *
 *   POST /zalo/files               the raw file as the body; the server's own Authorization (the bearer token or OAuth
 *                                  access token the MCP endpoint takes); `?name=` or `X-File-Name` (percent-encoded)
 *                                  names it, Content-Type types it
 *   PUT|POST /zalo/files/u/<token> the same, admitted by the one-time token of a zalo_file 'upload_begin' link instead
 *                                  of a bearer (a sandbox with curl, and no token, can use it); the file is stored
 *                                  under the fileId that link promised
 *
 * Both answer `201 {fileId, name, mimeType, size, createdAt, expiresAt}`, or 401, 404 (unknown link), 410 (a link used
 * or expired), 413 (over `uploads.maxBytes`), 507 (the store is full: `uploads.quota`), 400 (empty). The body is read
 * as a stream and never parsed; a refusal closes the connection so a large body is not read to its end.
 */

import { UPLOAD_TOKEN_SHAPE, UploadError } from "./upload-store.js";

/** The path prefix of the upload routes. */
export const UPLOAD_PATH_PREFIX = "/zalo/files";
const PATH_SHAPE = /^\/zalo\/files(?:\/u\/([^/?#]*))?\/?(?:\?.*)?$/;

/**
 * A request path with an upload token masked, for logs.
 *
 * @param {unknown} url
 * @returns {string}
 */
export function maskUploadPath(url) {
    return String(url ?? "").replace(/\/zalo\/files\/u\/[^/?#\s]*/g, "/zalo/files/u/***");
}

const STATUS = { TOO_LARGE: 413, QUOTA: 507, EMPTY: 400, ABORTED: 400 };

function send(res, status, body, { close = false } = {}) {
    if (res.headersSent) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(close ? { Connection: "close" } : {}),
    });
    res.end(text);
}

/** The name the caller gave the file: `?name=`, else `X-File-Name` (percent-encoded), else null. */
function nameOf(req) {
    let raw = null;
    try {
        raw = new URL(req.url, "http://x").searchParams.get("name");
    } catch {
        /* no query */
    }
    if (!raw && req.headers["x-file-name"]) {
        try {
            raw = decodeURIComponent(String(req.headers["x-file-name"]));
        } catch {
            raw = String(req.headers["x-file-name"]);
        }
    }
    return raw && raw.trim() ? raw.trim() : null;
}

/** Content-Type without parameters, unless it says nothing (octet-stream, form posts). */
function mimeOf(req) {
    const t = String(req.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
    if (!t || t === "application/octet-stream" || t === "application/x-www-form-urlencoded") return null;
    return t;
}

/**
 * Answer an upload request, if it is one.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {object} deps
 * @param {() => import("./upload-store.js").UploadStore|null} deps.store - the account's store
 * @param {() => object} deps.policy - resolveUploads() for the account, read on every request
 * @param {((req: import("node:http").IncomingMessage) => boolean)|null} deps.authorize - the server's own bearer
 *   check; null when the server checks none
 * @param {(line: string) => void} [deps.log]
 * @returns {Promise<boolean>} false when the path is not an upload route
 */
export async function handleUploadRequest(req, res, { store, policy, authorize, log = () => {} }) {
    const m = PATH_SHAPE.exec(req.url || "");
    if (!m) return false;
    const token = m[1] === undefined ? null : m[1];
    const close = { close: true };
    const allowed = token === null ? ["POST"] : ["PUT", "POST"];
    if (!allowed.includes(req.method)) {
        res.setHeader("Allow", allowed.join(", "));
        send(res, 405, { error: "method_not_allowed" }, close);
        return true;
    }
    const s = store();
    if (!s) {
        send(res, 503, { error: "this server keeps no upload store" }, close);
        return true;
    }
    const p = policy();
    let link = null;
    if (token === null) {
        if (authorize && !authorize(req)) {
            res.setHeader("WWW-Authenticate", 'Bearer realm="zalo-mcp"');
            send(res, 401, { error: "unauthorized", error_description: "A bearer token is required" }, close);
            return true;
        }
    } else {
        const found = UPLOAD_TOKEN_SHAPE.test(token) ? s.takeUploadLink(token) : { unknown: true };
        if (found.unknown) {
            send(res, 404, { error: "not_found", error_description: "No such upload link" }, close);
            return true;
        }
        if (found.gone) {
            send(res, 410, { error: "gone", error_description: found.gone }, close);
            return true;
        }
        link = found.link;
    }
    const declared = req.headers["content-length"] === undefined ? null : Number(req.headers["content-length"]);
    try {
        const saved = await s.save(req, {
            name: nameOf(req) || link?.name || "upload",
            mimeType: mimeOf(req) || link?.mimeType || null,
            maxBytes: Math.min(p.maxBytes, link?.maxBytes ?? Number.MAX_SAFE_INTEGER),
            quotaBytes: p.quotaBytes,
            ttlMs: link?.ttlMs ?? p.ttlMs,
            declaredSize: Number.isFinite(declared) ? declared : null,
            ...(link ? { fileId: link.fileId } : {}),
        });
        log(`[uploads] stored ${saved.size} bytes as ${saved.fileId}${link ? " (upload link)" : ""}`);
        send(res, 201, saved);
    } catch (e) {
        if (link) s.releaseUploadLink(token);
        if (e instanceof UploadError) {
            send(res, STATUS[e.code] ?? 400, { error: e.code.toLowerCase(), error_description: e.message }, close);
        } else {
            log(`[uploads] an upload failed: ${e?.message ?? e}`);
            send(res, 500, { error: "upload_failed" }, close);
        }
    }
    return true;
}
