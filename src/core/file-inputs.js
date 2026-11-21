/**
 * A file a caller hands the server, in one of four forms, turned into a path on this machine for the one call that
 * uses it:
 *
 * - a path on this machine (a string): for a caller on this machine (stdio, an HTTP client on loopback, the CLI), or
 *   any caller when the path is under one of `uploads.localPathRoots` (`uploads.localPaths` decides who else);
 * - `{fileId}`: a file uploaded earlier into the account's upload store (src/core/upload-store.js);
 * - `{url, name?}`: downloaded by the server (src/core/url-fetch.js: public addresses only, size cap, time limit);
 * - `{data, name, mimeType?}`: the bytes themselves, base64 (a `data:` URL works too), at most
 *   `uploads.inlineMaxBytes` for every `data` item of a call together.
 *
 * A fetched or decoded file goes into a private scratch folder, removed when the call ends; a stored one is used in
 * place. Resolution is all or nothing: one bad item refuses the call before anything is sent.
 */

import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { safeMediaName } from "./media-deliver.js";
import { FILE_ID_SHAPE, sizeText } from "./upload-store.js";
import { UrlFetchError, fetchUrlToFile, nameWithExtension } from "./url-fetch.js";

/** A refusal of a file item, with a code a test or a caller can tell apart. */
export class FileInputError extends Error {
    /**
     * @param {string} message
     * @param {string} code - REMOTE_PATH, LOCAL_PATHS_OFF, NOT_FOUND, UNKNOWN_FILE_ID, BAD_DATA, TOO_LARGE, URL, NO_STORE
     */
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

/**
 * What a remote caller should send instead of a path, with this server's limits.
 *
 * @param {{inlineMaxBytes: number, urlMaxBytes: number, maxBytes: number}} policy
 * @returns {string}
 */
export function remoteFileHelp(policy) {
    return (
        `Send the file itself instead: {"data": "<base64>", "name": "photo.jpg"} (up to ${sizeText(policy.inlineMaxBytes)} ` +
        `a call), {"url": "https://..."} (this server downloads it, up to ${sizeText(policy.urlMaxBytes)}), or ` +
        `{"fileId": "..."} after uploading it through zalo_file 'upload_begin' (a one-time upload link, up to ` +
        `${sizeText(policy.maxBytes)}).`
    );
}

/** True when `path` (resolved, symlinks followed) is inside `root`. */
function isUnder(path, root) {
    let real;
    let realRoot;
    try {
        real = realpathSync(path);
        realRoot = realpathSync(root);
    } catch {
        return false;
    }
    const rel = relative(realRoot, real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Whether this caller may name a path on this machine, and the refusal when not.
 *
 * @param {string} abs - the resolved path
 * @param {{remote: boolean, policy: object, label: string}} ctx
 * @returns {string|null} the refusal, or null when allowed
 */
function localPathRefusal(abs, { remote, policy, label }) {
    if ((policy.localPathRoots ?? []).some((root) => isUnder(abs, root))) return null;
    if (policy.localPaths === "any") return null;
    if (policy.localPaths === "loopback" && !remote) return null;
    if (policy.localPaths === "none") {
        return `${label} is a path on the machine this server runs on, and this server reads no paths from its callers (uploads.localPaths is "none"). ${remoteFileHelp(policy)}`;
    }
    return (
        `${label} is a path ("${abs}"), and this server runs on another machine than yours: it cannot read files ` +
        `from your machine, and it does not read its own disk for a remote caller. ${remoteFileHelp(policy)}`
    );
}

/** The base64 bytes of a `data` item (a bare base64 string or a `data:` URL), and the type a `data:` URL names. */
function decodeData(raw, label, budget) {
    let text = String(raw ?? "");
    let mime = null;
    const dataUrl = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(text);
    if (dataUrl) {
        mime = dataUrl[1] || null;
        text = text.slice(dataUrl[0].length);
    }
    text = text.replace(/\s+/g, "");
    if (!text || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) {
        throw new FileInputError(`${label}.data is not base64`, "BAD_DATA");
    }
    if (Math.floor((text.length * 3) / 4) > budget + 2) {
        throw new FileInputError(
            `${label}.data is over what is left of the ${sizeText(budget)} a call may carry inline: send a larger file ` +
                "as a url or upload it with zalo_file 'upload_begin' and pass its fileId",
            "TOO_LARGE",
        );
    }
    const bytes = Buffer.from(text, text.includes("-") || text.includes("_") ? "base64url" : "base64");
    if (!bytes.length) throw new FileInputError(`${label}.data is empty`, "BAD_DATA");
    return { bytes, mime };
}

/**
 * Turn file items into paths on this machine.
 *
 * @param {Array<string|{fileId?: string, url?: string, data?: string, name?: string, mimeType?: string}>} items
 * @param {object} ctx
 * @param {import("./upload-store.js").UploadStore|null} ctx.store - the account's store (null: none on this server)
 * @param {object} ctx.policy - resolveUploads()
 * @param {boolean} ctx.remote - the caller is not on this machine
 * @param {string} [ctx.label] - how the refusal names the input ("files", "video.source")
 * @param {Function} [ctx.lookup] - dns.lookup's shape (tests)
 * @returns {Promise<{files: Array<{path: string, name: string, mimeType: string|null, size: number,
 *   from: "path"|"fileId"|"url"|"data"}>, cleanup: () => void}>}
 * @throws {FileInputError}
 */
export async function materializeFiles(items, { store, policy, remote, label = "files", lookup }) {
    const files = [];
    let scratch = null;
    const scratchDir = () => {
        if (!store) {
            throw new FileInputError(
                "this server keeps no upload store, so it takes files only as paths on its own machine",
                "NO_STORE",
            );
        }
        scratch ??= store.scratch();
        return scratch.dir;
    };
    // Each item in its own folder, so two items of the same name do not overwrite each other.
    let n = 0;
    const itemDir = () => {
        const dir = join(scratchDir(), String(n++));
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    };
    const cleanup = () => scratch?.remove();
    let inlineLeft = policy.inlineMaxBytes;
    try {
        for (const [i, item] of items.entries()) {
            const where = items.length === 1 ? label : `${label}[${i}]`;
            if (typeof item === "string") {
                const raw = item.trim();
                if (/^https?:\/\//i.test(raw)) {
                    throw new FileInputError(
                        `${where} is a URL given as a path: pass it as {"url": "${raw.slice(0, 200)}"} for this server to download it`,
                        "NOT_FOUND",
                    );
                }
                const abs = resolve(raw);
                const refusal = localPathRefusal(abs, { remote, policy, label: where });
                if (refusal) throw new FileInputError(refusal, remote ? "REMOTE_PATH" : "LOCAL_PATHS_OFF");
                if (!existsSync(abs) || !statSync(abs).isFile()) {
                    throw new FileInputError(
                        `File not found on the machine this server runs on: ${abs}` +
                            (remote ? `. ${remoteFileHelp(policy)}` : ""),
                        "NOT_FOUND",
                    );
                }
                files.push({
                    path: abs,
                    name: abs.split(/[\\/]/).pop(),
                    mimeType: null,
                    size: statSync(abs).size,
                    from: "path",
                });
                continue;
            }
            if (!item || typeof item !== "object") throw new FileInputError(`${where} is not a file`, "BAD_DATA");
            if (item.fileId !== undefined) {
                const id = String(item.fileId).trim();
                const got = FILE_ID_SHAPE.test(id) && store ? store.get(id) : null;
                if (!got) {
                    const waiting = FILE_ID_SHAPE.test(id) && store ? store.pending(id) : null;
                    const known = FILE_ID_SHAPE.test(id) && store ? store.status(id) : null;
                    throw new FileInputError(
                        waiting
                            ? `${where}.fileId ${id} has an upload link that was not used yet: upload the file to it first`
                            : known?.status === "consumed"
                              ? `${where}.fileId ${id} was already sent (message ${known.sent.msgIds.join(", ") || "-"}) ` +
                                "and removed: a sent upload is not kept. Forward that message, or upload the file again"
                              : `${where}.fileId ${id} is unknown or has expired (uploads are kept ${Math.round(policy.ttlMs / 3_600_000)} h): upload the file again`,
                        "UNKNOWN_FILE_ID",
                    );
                }
                files.push({
                    path: got.path,
                    name: got.name,
                    mimeType: got.mimeType,
                    size: got.size,
                    from: "fileId",
                    fileId: id,
                });
                continue;
            }
            if (item.url !== undefined) {
                const dir = itemDir();
                try {
                    const got = await fetchUrlToFile(item.url, {
                        dir,
                        maxBytes: policy.urlMaxBytes,
                        timeoutMs: policy.urlTimeoutMs,
                        allowPrivate: policy.allowPrivateUrls === true,
                        name: item.name ?? null,
                        ...(lookup ? { lookup } : {}),
                    });
                    files.push({ path: got.path, name: got.name, mimeType: got.mimeType, size: got.size, from: "url" });
                } catch (e) {
                    if (e instanceof UrlFetchError) throw new FileInputError(`${where}.url: ${e.message}`, "URL");
                    throw e;
                }
                continue;
            }
            if (item.data !== undefined) {
                const { bytes, mime } = decodeData(item.data, where, inlineLeft);
                if (bytes.length > inlineLeft) {
                    throw new FileInputError(
                        `${where}.data is over what is left of the ${sizeText(policy.inlineMaxBytes)} a call may carry ` +
                            "inline: send a larger file as a url or upload it with zalo_file 'upload_begin' and pass its fileId",
                        "TOO_LARGE",
                    );
                }
                inlineLeft -= bytes.length;
                const mimeType = item.mimeType || mime || null;
                const name = safeMediaName(nameWithExtension(String(item.name ?? "file"), mimeType), "file");
                const dir = itemDir();
                const path = join(dir, name);
                writeFileSync(path, bytes, { mode: 0o600 });
                files.push({ path, name, mimeType, size: bytes.length, from: "data" });
                continue;
            }
            throw new FileInputError(`${where} names no file: give fileId, url or data`, "BAD_DATA");
        }
    } catch (e) {
        cleanup();
        throw e;
    }
    return { files, cleanup };
}

/**
 * Run `fn` with the items as paths, and remove what was fetched or decoded for it afterwards, whatever happens.
 *
 * @template T
 * @param {Array<string|object>} items
 * @param {Parameters<typeof materializeFiles>[1]} ctx
 * @param {(files: Awaited<ReturnType<typeof materializeFiles>>["files"]) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withFiles(items, ctx, fn) {
    const { files, cleanup } = await materializeFiles(items, ctx);
    try {
        return await fn(files);
    } finally {
        cleanup();
    }
}
