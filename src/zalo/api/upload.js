/**
 * Attachments: local files uploaded to Zalo and the messages that carry them (spec-send 2, design 1.4).
 *
 * `sendAttachments(message, threadId, type)` is the half of `sendMessage` that `createApi` calls when
 * `message.attachments` is non-empty; `uploadAttachment(paths, threadId, type)` is the upload alone.
 *
 * What goes on the wire, as Zalo Web sends it (the legacy upload path, design 6.1 item 9):
 *
 * - Routing by lowercase extension: `jpg jpeg png webp` are photos (`photo_original/*`), `gif` its own path
 *   (`upthumb`, then `gif`), everything else, `mp4` included, a file (`asyncfile/*`).
 * - Limits from the login's `settings.features.sharefile`, all checked before the first request (the caption
 *   included): `max_file` (count), `max_size_share_file_v3` (MB), `restricted_ext_file` (denied extensions).
 * - Upload: `POST {file}/api/{message|group}/{photo_original|asyncfile}/upload?zpw_ver&zpw_type&params&type`, `type`
 *   2 for a user and 11 for a group, a multipart body with one part `chunkContent` (the chunk's bytes, named after
 *   the file). `params` per chunk: `{totalChunk, fileName, clientId, totalSize, imei, chunkId, toid|grid}`, without
 *   the `isE2EE: 0`/`jxl: 0` zca-js added (the Web's non-E2EE chunk builder has neither). The chunk size is
 *   `chunk_size_file` when it is a number of at least 64000, else 256000. At most three chunks are in flight; the
 *   last chunk goes once every other one has answered, so its reply is the one that says whether the upload
 *   finished. An inner `error_code` 1 on a chunk is Zalo's "already uploaded", an answer, not an error.
 * - A photo's reply carries its URLs. A file's does not: Zalo pushes them later in a 601 control (`file_done`,
 *   `video_done`; `photo_success` for a photo whose reply had none), which the listener hands to
 *   `ctx.uploadCallbacks.settle(fileId, {url, kind, data})` (kernel/session.js). A settlement that came before the
 *   wait is kept for it. While a file waits, a callback stands under its id in `ctx.uploadCallbacks` too, so zca-js's
 *   listener, which only calls the entry it finds with `{fileUrl, fileId}`, settles it as well. When nothing comes,
 *   the last chunk is sent again after the Web's size-bucketed delay (a valid reply carries the URL), and once more
 *   at the overall wait (120 s); the upload fails when that replay gives nothing, or at the latest
 *   {@link FINAL_REPLAY_GRACE_MS} later. No chunk request waits longer than {@link CHUNK_TIMEOUT_MS}.
 * - Send: `photo_original/send` with `{photoId, clientId, desc, width, height, rawUrl, thumbUrl, hdUrl,
 *   normalUrl|oriUrl, (layout), toid|grid, language, (extMsgProp), zsource, ttl, imei}`; `asyncfile/msg` with
 *   `{fileId, checksum, checksumSha, extension, totalSize, fileName, clientId, fType, fileCount, fdata, toid|grid,
 *   fileUrl, zsource, ttl, imei (to a user)}`, spelled `extension` as the Web does (zca-js sent `extention`).
 * - A caption rides on a single photo as its `desc`; otherwise it goes first, as its own text message through
 *   `s.api.sendMessage`. The reply is `{message, attachment}`, `attachment[i]` carrying the `cliMsgId` it was sent
 *   with, files in the order given and GIFs last.
 *
 * Every message clientId comes from the session's monotonic generator (`s.nextClientId()`), so no two sends of one
 * session share one: a photo's upload and its send use the same id, as the Web's do.
 *
 * Waits read the session clock (`s.now()`), checked every {@link TICK_MS}, so a test moves them by moving the clock.
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { imageSizeFromFile } from "image-size/fromFile";
import { THREAD_TYPE } from "../enums.js";
import { ZaloApiError } from "../errors.js";

/** The chunk size when the server names none we can use (the Web's fallback). */
export const DEFAULT_CHUNK_SIZE = 256000;

/** The smallest server chunk size the Web accepts; anything below falls back to {@link DEFAULT_CHUNK_SIZE}. */
export const MIN_CHUNK_SIZE = 64000;

/** Chunks of one file in flight at once. */
export const MAX_CHUNKS_IN_FLIGHT = 3;

/** How long to wait for the server's word on an uploaded file before giving up (the Web's default). */
export const DEFAULT_WAIT_MS = 120000;

/**
 * Seconds before the last chunk is sent again, by `floor(size / 30 MB)` (the Web's default
 * `upload_file_timeout_replay_last_chunk`).
 */
export const DEFAULT_REPLAY_SECONDS = Object.freeze([30, 35, 40, 45, 50, 60]);

/** The size step of {@link DEFAULT_REPLAY_SECONDS}. */
export const REPLAY_SIZE_STEP = 31457280;

/**
 * How long one chunk request may take before it fails. A multipart call has no timeout of its own (kernel
 * endpoint.js), so without this a chunk the server never answers would hold the upload forever.
 */
export const CHUNK_TIMEOUT_MS = 60000;

/**
 * How long past the overall wait the last replay may still answer before the upload fails whatever the replay is
 * doing (the replay's own request timeout is {@link CHUNK_TIMEOUT_MS}, so this is the same length).
 */
export const FINAL_REPLAY_GRACE_MS = CHUNK_TIMEOUT_MS;

/** How often a wait looks at the clock, in real milliseconds. */
export const TICK_MS = 100;

/** Extensions sent as a photo. */
const PHOTO_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);

/** How much of a file the checksum reads at a time. */
const READ_MD5_STEP = 2 * 1024 * 1024;

/**
 * The lowercase extension of a path, without the dot.
 *
 * @param {string} p
 * @returns {string}
 */
function extOf(p) {
    return path.extname(p).slice(1).toLowerCase();
}

/**
 * How a file travels: "photo", "gif" or "file", and the type name zca-js gave its upload result.
 *
 * @param {string} ext
 * @returns {{route: "photo"|"gif"|"file", fileType: "image"|"gif"|"video"|"others"}}
 */
function routeOf(ext) {
    if (PHOTO_EXTS.has(ext)) return { route: "photo", fileType: "image" };
    if (ext === "gif") return { route: "gif", fileType: "gif" };
    return { route: "file", fileType: ext === "mp4" ? "video" : "others" };
}

/**
 * The upload settings of the session, with the Web's defaults.
 *
 * @param {object} ctx
 * @returns {{maxFile: number|null, maxBytes: number|null, maxMb: number|null, denied: string[], chunkSize: number,
 *   waitMs: number, replaySeconds: number[], replay: boolean}}
 */
export function uploadSettings(ctx) {
    const share = ctx?.settings?.features?.sharefile ?? {};
    const retry = ctx?.settings?.features?.retry_upload_file_configs ?? {};
    const maxMb = Number(share.max_size_share_file_v3);
    const chunk = Number(share.chunk_size_file);
    const wait = parseInt(retry.upload_file_timeout_wait_ctrl_event, 10);
    const replaySeconds =
        Array.isArray(retry.upload_file_timeout_replay_last_chunk) && retry.upload_file_timeout_replay_last_chunk.length
            ? retry.upload_file_timeout_replay_last_chunk.map(Number)
            : [...DEFAULT_REPLAY_SECONDS];
    return {
        maxFile: Number.isFinite(Number(share.max_file)) ? Number(share.max_file) : null,
        maxMb: Number.isFinite(maxMb) ? maxMb : null,
        maxBytes: Number.isFinite(maxMb) ? maxMb * 1024 * 1024 : null,
        denied: Array.isArray(share.restricted_ext_file) ? share.restricted_ext_file.map(String) : [],
        chunkSize: Number.isFinite(chunk) && chunk >= MIN_CHUNK_SIZE ? Math.floor(chunk) : DEFAULT_CHUNK_SIZE,
        waitMs: Number.isFinite(wait) ? wait : DEFAULT_WAIT_MS,
        replaySeconds,
        replay: retry.enable_resend_lastchunk === undefined ? true : !!retry.enable_resend_lastchunk,
    };
}

/**
 * Milliseconds before the last chunk of a `size`-byte upload is sent again.
 *
 * @param {number} size
 * @param {number[]} [seconds] - the server's table
 * @returns {number}
 */
export function replayDelayMs(size, seconds = DEFAULT_REPLAY_SECONDS) {
    const i = Math.min(Math.floor(Math.max(0, Number(size) || 0) / REPLAY_SIZE_STEP), seconds.length - 1);
    return seconds[i] * 1000;
}

/**
 * An image's size and display dimensions: the session's `imageMetadataGetter` when the engine gave one, else
 * image-size with the EXIF 90-degree rotations (orientations 5-8) swapping width and height.
 *
 * @param {object} ctx
 * @param {string} file
 * @returns {Promise<{width: number, height: number, size: number}>}
 */
async function imageMeta(ctx, file) {
    const getter = ctx?.options?.imageMetadataGetter;
    if (typeof getter === "function") {
        const meta = await getter(file);
        if (!meta) throw new ZaloApiError("Failed to get image metadata");
        return meta;
    }
    const { size } = await stat(file);
    const dims = await imageSizeFromFile(file);
    const turned = dims.orientation >= 5 && dims.orientation <= 8;
    return { width: turned ? dims.height : dims.width, height: turned ? dims.width : dims.height, size };
}

/**
 * The MD5 of a file, lowercase hex, read in steps.
 *
 * @param {string} file
 * @param {number} size
 * @returns {Promise<string>}
 */
async function md5Of(file, size) {
    const hash = createHash("md5");
    const fh = await open(file, "r");
    try {
        const buf = Buffer.alloc(Math.min(READ_MD5_STEP, Math.max(1, size)));
        for (let at = 0; at < size;) {
            const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - at), at);
            if (bytesRead === 0) break;
            hash.update(buf.subarray(0, bytesRead));
            at += bytesRead;
        }
    } finally {
        await fh.close();
    }
    return hash.digest("hex");
}

/**
 * Bytes `[start, start + length)` of a file.
 *
 * @param {string} file
 * @param {number} start
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
async function readRange(file, start, length) {
    const fh = await open(file, "r");
    try {
        const buf = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
            const { bytesRead } = await fh.read(buf, got, length - got, start + got);
            if (bytesRead === 0) break;
            got += bytesRead;
        }
        return got === length ? buf : buf.subarray(0, got);
    } finally {
        await fh.close();
    }
}

/**
 * Look at every file before anything is sent: it exists, its extension is allowed, its size is within the limit.
 * Messages are the ones the engine has always shown.
 *
 * @param {object} ctx
 * @param {string[]} files
 * @param {ReturnType<typeof uploadSettings>} cfg
 * @returns {Promise<Array<{file: string, fileName: string, ext: string, size: number, route: string,
 *   fileType: string, width?: number, height?: number}>>}
 * @throws {ZaloApiError} for the first file that fails
 */
async function inspect(ctx, files, cfg) {
    const out = [];
    for (const file of files) {
        if (typeof file !== "string" || !file) throw new ZaloApiError("Invalid source type");
        let st;
        try {
            st = await stat(file);
        } catch {
            throw new ZaloApiError("File not found");
        }
        if (!st.isFile()) throw new ZaloApiError("File not found");
        const ext = extOf(file);
        const fileName = path.basename(file);
        if (cfg.denied.includes(ext)) throw new ZaloApiError(`File extension "${ext}" is not allowed`);
        const { route, fileType } = routeOf(ext);
        const item = { file, fileName, ext, size: st.size, route, fileType };
        if (route === "photo" || route === "gif") {
            const meta = await imageMeta(ctx, file);
            item.size = Number(meta.size ?? st.size);
            item.width = meta.width;
            item.height = meta.height;
        }
        if (cfg.maxBytes !== null && item.size > cfg.maxBytes) {
            throw new ZaloApiError(`File ${fileName} size exceed maximum size of ${cfg.maxMb}MB`);
        }
        if (item.size === 0) throw new ZaloApiError(`File ${fileName} is empty`);
        out.push(item);
    }
    return out;
}

/**
 * A thread's id as the upload and send params carry it.
 *
 * @param {string} threadId
 * @param {boolean} group
 * @returns {{toid: string}|{grid: string}}
 */
function threadParam(threadId, group) {
    return group ? { grid: String(threadId) } : { toid: String(threadId) };
}

/**
 * The endpoint of one upload chunk.
 *
 * @param {"photo"|"file"} route
 * @param {boolean} group
 * @returns {object}
 */
function chunkEndpoint(route, group) {
    const photo = route === "photo";
    return {
        host: "file",
        path: `/api/${group ? "group" : "message"}/${photo ? "photo_original" : "asyncfile"}/upload`,
        cmd: photo ? (group ? 11820 : 11772) : group ? 13000 : 11776,
        method: "multipart",
        body: (a) => a.params,
        query: () => ({ type: group ? 11 : 2 }),
        file: (a) => ({
            field: "chunkContent",
            filename: a.fileName,
            type: "application/octet-stream",
            bytes: a.bytes,
        }),
        reply: "session",
        okCodes: [1],
        timeoutMs: CHUNK_TIMEOUT_MS,
        transform: (data, _args, { code }) => ({ data: data && typeof data === "object" ? data : {}, code }),
    };
}

/** `POST {file}/api/{message|group}/photo_original/send`. */
const photoSendEndpoint = (group) => ({
    host: "file",
    path: `/api/${group ? "group" : "message"}/photo_original/send`,
    cmd: group ? 11826 : 11773,
    method: "post",
    body: (a) => a.params,
    reply: "session",
});

/** `POST {file}/api/{message|group}/asyncfile/msg`. */
const fileSendEndpoint = (group) => ({
    host: "file",
    path: `/api/${group ? "group" : "message"}/asyncfile/msg`,
    cmd: group ? 13001 : 11777,
    method: "post",
    body: (a) => a.params,
    reply: "session",
});

/** `POST {file}/api/message/upthumb`: a GIF's thumbnail, always on the user path. */
const UPTHUMB = Object.freeze({
    host: "file",
    path: "/api/message/upthumb",
    method: "multipart",
    body: (a) => a.params,
    file: (a) => ({ field: "fileContent", filename: "blob", type: "image/png", bytes: a.bytes }),
    reply: "session",
});

/** `POST {file}/api/{message|group}/gif`: a local GIF, sent whole as one chunk. */
const gifEndpoint = (group) => ({
    host: "file",
    path: `/api/${group ? "group" : "message"}/gif`,
    method: "multipart",
    body: (a) => a.params,
    query: () => ({ type: 1 }),
    file: (a) => ({ field: "chunkContent", filename: a.fileName, type: "application/octet-stream", bytes: a.bytes }),
    reply: "session",
});

/**
 * What a chunk reply says.
 *
 * @param {"photo"|"file"} route
 * @param {{data: object, code: number}} reply
 * @returns {{done: boolean, duplicate: boolean}}
 */
function chunkState(route, { data, code }) {
    const id = route === "photo" ? data.photoId : data.fileId;
    const has = id !== undefined && id !== null && String(id) !== "-1" && String(id) !== "";
    if (code === 1) return { done: false, duplicate: has };
    const finished = route === "photo" ? data.finished || data.isFinish : data.finished;
    return { done: !!finished && has, duplicate: false };
}

/**
 * Photo URLs from a chunk reply, a replayed chunk's reply, or a `photo_success` control, filling a missing one from
 * the others; null when there is no full set.
 *
 * @param {{normalUrl?: string, hdUrl?: string, thumbUrl?: string}} u
 * @returns {{normalUrl: string, hdUrl: string, thumbUrl: string}|null}
 */
function photoUrls(u) {
    const normalUrl = u?.normalUrl || u?.hdUrl;
    const thumbUrl = u?.thumbUrl;
    if (!normalUrl || !thumbUrl) return null;
    return { normalUrl, hdUrl: u.hdUrl || normalUrl, thumbUrl };
}

/**
 * The control's own `data` inside a settlement (our listener passes the whole control as the settlement's `data`;
 * zca-js's listener never makes a settlement, see {@link awaitUrls}), parsed when it came as a JSON string.
 *
 * @param {import("../kernel/session.js").UploadSettlement} settlement
 * @returns {object}
 */
function controlData(settlement) {
    const raw = settlement?.data;
    const content = raw && typeof raw === "object" ? (raw.content ?? raw) : {};
    let d = content?.data;
    if (typeof d === "string") {
        try {
            d = JSON.parse(d);
        } catch {
            d = null;
        }
    }
    return d && typeof d === "object" ? d : {};
}

/**
 * The URL(s) a settlement gives an upload, or null when it gives none.
 *
 * @param {"photo"|"file"} route
 * @param {import("../kernel/session.js").UploadSettlement} settlement
 * @returns {{fileUrl: string}|{normalUrl: string, hdUrl: string, thumbUrl: string}|null}
 */
function fromSettlement(route, settlement) {
    const d = controlData(settlement);
    if (route === "photo") return photoUrls({ normalUrl: d.org, hdUrl: d.hd, thumbUrl: d.thumb });
    const url = settlement?.url ?? (typeof d.url === "string" ? d.url : null);
    return typeof url === "string" && url ? { fileUrl: url } : null;
}

/**
 * The URL(s) a replayed last chunk's reply gives, or null when it is not a valid answer for this upload.
 *
 * @param {"photo"|"file"} route
 * @param {string} id - the photoId or fileId
 * @param {object} data
 * @returns {{fileUrl: string}|{normalUrl: string, hdUrl: string, thumbUrl: string}|null}
 */
function fromReplay(route, id, data) {
    if (route === "photo") return String(data?.photoId) === id ? photoUrls(data) : null;
    return String(data?.fileId) === id && typeof data?.url === "string" && data.url ? { fileUrl: data.url } : null;
}

/**
 * Wait for the server's word on an uploaded file: the listener's settlement, or a replayed last chunk.
 *
 * Two listeners can deliver the settlement. Ours calls `ctx.uploadCallbacks.settle(id, {url, kind, data})` with the
 * whole control; zca-js's knows only the Map and calls the function it finds under the id with `{fileUrl, fileId}`.
 * So while a file waits, a callback of ours stands under its id (when nothing else is registered there). The
 * callback takes only a `{fileUrl}` that is a non-empty string, and only for a file (a photo needs the whole set of
 * URLs, which only the control has). It acts one macrotask later: a listener that calls the Map entry and then
 * `settle()` (L2's order) is then answered by `settle()`, whose control reaches the waiter directly, and the callback
 * finds the wait over and does nothing, so no settlement is left in the registry's early cache.
 *
 * @param {import("../api.js").Session} s
 * @param {object} p
 * @param {"photo"|"file"} p.route
 * @param {string} p.id - the photoId or fileId the settlement comes under
 * @param {number} p.size - the file's size (it picks the replay delay)
 * @param {() => Promise<{data: object, code: number}>} p.replay - send the last chunk again
 * @param {ReturnType<typeof uploadSettings>} p.cfg
 * @param {string} p.fileName - for the error
 * @param {AbortSignal} [p.signal] - gives up waiting (the send failed elsewhere)
 * @returns {Promise<{fileUrl: string}|{normalUrl: string, hdUrl: string, thumbUrl: string}>}
 * @throws {ZaloApiError} code "UPLOAD_TIMEOUT" when nothing came within the wait and the last replay gave nothing,
 *   or {@link FINAL_REPLAY_GRACE_MS} after the wait whatever the last replay is doing
 */
function awaitUrls(s, { route, id, size, replay, cfg, fileName, signal }) {
    return new Promise((resolve, reject) => {
        const stop = new AbortController();
        const start = s.now();
        const replayAt = cfg.replay ? start + replayDelayMs(size, cfg.replaySeconds) : Infinity;
        const deadline = start + cfg.waitMs;
        const lastChance = deadline + (cfg.replay ? FINAL_REPLAY_GRACE_MS : 0);
        let finished = false;
        let replayed = false;
        let replayedLast = false;
        let timer = null;
        const bridge = (d) => {
            const url = d?.fileUrl;
            if (route !== "file" || typeof url !== "string" || !url) return;
            setImmediate(() => finish(resolve, { fileUrl: url }));
        };
        /** Stand under the id for zca-js's listener, unless something else is registered there. */
        const plant = () => {
            if (!finished && !s.uploads.has(id)) s.uploads.set(id, bridge);
        };
        const finish = (fn, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            stop.abort();
            signal?.removeEventListener("abort", onAbort);
            if (s.uploads.get(id) === bridge) s.uploads.delete(id);
            fn(value);
        };
        const onAbort = () => finish(reject, signal.reason ?? new Error("aborted"));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        const timeout = (cause) => {
            const err = new ZaloApiError(
                `Zalo did not confirm the upload of ${fileName} within ${Math.round(cfg.waitMs / 1000)} s`,
            );
            err.code = "UPLOAD_TIMEOUT";
            if (cause) err.cause = cause;
            return err;
        };
        const tryReplay = async (last) => {
            let urls = null;
            let failure = null;
            try {
                const reply = await replay();
                urls = fromReplay(route, id, reply.data);
            } catch (e) {
                failure = e;
            }
            if (urls) finish(resolve, urls);
            else if (last) finish(reject, timeout(failure));
        };

        const wait = () => {
            plant();
            s.uploads
                .waitFor(id, { signal: stop.signal })
                .then((settlement) => {
                    const urls = fromSettlement(route, settlement);
                    if (urls) finish(resolve, urls);
                    else if (!finished) wait(); // a control without what we need: keep waiting
                })
                .catch(() => {});
        };
        wait();

        const check = () => {
            if (finished) return;
            const now = s.now();
            if (now >= lastChance) {
                // The last replay never answered (or there is none): give up whatever it is doing.
                finish(reject, timeout(null));
                return;
            }
            if (now >= deadline && !replayedLast) {
                replayedLast = true;
                replayed = true; // the early replay, if it was still due, is this one
                tryReplay(true);
            }
            if (!replayed && now >= replayAt) {
                replayed = true;
                tryReplay(false);
            }
            plant(); // back in place should it have expired (a server wait longer than the registry's entry life)
            timer = setTimeout(check, TICK_MS);
        };
        check();
    });
}

/**
 * Upload one photo or file in chunks and learn its URL(s).
 *
 * @param {import("../api.js").Session} s
 * @param {object} item - from {@link inspect}
 * @param {{group: boolean, threadId: string, cfg: ReturnType<typeof uploadSettings>, signal?: AbortSignal}} where
 * @returns {Promise<{item: object, clientId: number, reply: object, urls: object|null, wait: Promise<object>|null}>}
 *   `wait` resolves to the URL(s) when they come later (a file, or a photo whose reply had none)
 */
async function uploadChunks(s, item, { group, threadId, cfg, signal }) {
    const route = item.route;
    const def = chunkEndpoint(route, group);
    const clientId = s.nextClientId();
    const totalChunk = Math.max(1, Math.ceil(item.size / cfg.chunkSize));
    const base = {
        totalChunk,
        fileName: item.fileName,
        clientId,
        totalSize: item.size,
        imei: s.ctx.imei,
        chunkId: 0,
        ...threadParam(threadId, group),
    };
    const argsOf = async (chunkId) => {
        const start = (chunkId - 1) * cfg.chunkSize;
        const bytes = await readRange(item.file, start, Math.min(cfg.chunkSize, item.size - start));
        return { params: { ...base, chunkId }, fileName: item.fileName, bytes };
    };
    // Chunks are read one after another, so they go out in chunkId order however the reads interleave.
    let reading = Promise.resolve();
    const post = async (chunkId) => {
        const read = reading.then(() => argsOf(chunkId));
        reading = read.catch(() => {});
        const args = await read;
        const reply = await s.call(def, args);
        return { ...reply, ...chunkState(route, reply), args };
    };

    // Every chunk but the last, at most MAX_CHUNKS_IN_FLIGHT at a time; a reply that already settles the
    // upload (finished, or "already uploaded") ends it early.
    let next = 1;
    let early = null;
    let failed = false;
    const worker = async () => {
        while (!failed && !early && next < totalChunk) {
            const chunkId = next++;
            try {
                const r = await post(chunkId);
                if (r.done || r.duplicate) early ??= r;
            } catch (e) {
                failed = true;
                throw e;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CHUNKS_IN_FLIGHT, totalChunk - 1) }, worker));
    const last = early ?? (await post(totalChunk));
    const data = last.data;

    if (!last.done && !last.duplicate) {
        throw new ZaloApiError(`Zalo did not finish the upload of ${item.fileName}`, last.code || null);
    }
    const id = String(route === "photo" ? data.photoId : data.fileId);
    const replay = () => s.call(def, last.args);

    if (route === "photo") {
        const urls = photoUrls(data);
        if (urls) return { item, clientId, reply: data, urls, wait: null };
    } else if (last.duplicate && typeof data.url === "string" && data.url) {
        return { item, clientId, reply: data, urls: { fileUrl: data.url }, wait: null };
    }
    if (last.duplicate) {
        // The Web, too, gives up on a duplicate it has no URL for (it would retry under a new clientId).
        throw new ZaloApiError(`Zalo reports ${item.fileName} as already uploaded but gave no URL for it`, 1);
    }
    const wait = awaitUrls(s, { route, id, size: item.size, replay, cfg, fileName: item.fileName, signal });
    wait.catch(() => {}); // awaited by the caller; never an unhandled rejection meanwhile
    return { item, clientId, reply: data, urls: null, wait };
}

/**
 * Upload every photo and file of a send, one file after another (a file's settlement wait does not hold up the
 * next upload), then wait for every URL.
 *
 * @param {import("../api.js").Session} s
 * @param {object[]} items
 * @param {{group: boolean, threadId: string, cfg: ReturnType<typeof uploadSettings>}} where
 * @returns {Promise<Array<{item: object, clientId: number, reply: object, urls: object}>>}
 */
async function uploadAll(s, items, where) {
    // A failure anywhere ends the other files' waits too, so no timer outlives the call.
    const giveUp = new AbortController();
    const at = { ...where, signal: giveUp.signal };
    const uploads = [];
    try {
        for (const item of items) uploads.push(await uploadChunks(s, item, at));
        for (const u of uploads) if (!u.urls) u.urls = await u.wait;
        for (const u of uploads) {
            if (u.item.route === "file") u.checksum = await md5Of(u.item.file, u.item.size);
        }
    } catch (e) {
        giveUp.abort(e);
        throw e;
    }
    return uploads;
}

/**
 * The result zca-js's `uploadAttachment` gave for one upload, which this module's `uploadAttachment` keeps.
 *
 * @param {object} u
 * @returns {object}
 */
function uploadResult(u) {
    const { item, reply, urls } = u;
    if (item.route === "photo") {
        return {
            fileType: "image",
            width: item.width,
            height: item.height,
            totalSize: item.size,
            hdSize: item.size,
            finished: reply.finished,
            normalUrl: urls.normalUrl,
            hdUrl: urls.hdUrl,
            thumbUrl: urls.thumbUrl,
            chunkId: reply.chunkId,
            photoId: reply.photoId,
            clientFileId: reply.clientFileId,
        };
    }
    return {
        fileType: item.fileType,
        ...reply,
        fileUrl: urls.fileUrl,
        fileId: String(reply.fileId),
        totalSize: item.size,
        fileName: item.fileName,
        checksum: u.checksum,
    };
}

/**
 * Stamp a send's reply with the clientId it went out with (Zalo answers only `msgId`).
 *
 * @param {unknown} reply
 * @param {number|string} clientId
 * @returns {object}
 */
function stamped(reply, clientId) {
    const out = reply && typeof reply === "object" ? reply : {};
    out.cliMsgId = String(clientId);
    return out;
}

/**
 * The upload calls, bound to one session handle.
 *
 * @param {import("../api.js").Session} s
 * @returns {{
 *   sendAttachments: (message: {msg?: string, attachments: string|string[], quote?: object, mentions?: object[],
 *     styles?: object[], urgency?: number, ttl?: number}, threadId: string, type?: number) =>
 *     Promise<{message: object|null, attachment: object[]}>,
 *   uploadAttachment: (sources: string|string[], threadId: string, type?: number) => Promise<object[]>,
 * }}
 */
export function uploadMethods(s) {
    /**
     * Refuse an empty list, too many files, or a missing thread before anything is read.
     *
     * @param {unknown} list
     * @param {string} threadId
     * @param {ReturnType<typeof uploadSettings>} cfg
     * @returns {string[]}
     */
    const checkList = (list, threadId, cfg) => {
        if (!threadId) throw new ZaloApiError("Missing threadId");
        const files = list === undefined || list === null ? [] : Array.isArray(list) ? list : [list];
        if (!files.length) throw new ZaloApiError("Missing sources");
        if (cfg.maxFile !== null && files.length > cfg.maxFile) {
            throw new ZaloApiError("Exceed maximum file of " + cfg.maxFile);
        }
        return files;
    };

    /**
     * Upload files to a conversation without sending them.
     *
     * @param {string|string[]} sources - local file paths
     * @param {string} threadId - the user or group the files are for
     * @param {number} [type] - 0 a user, 1 a group
     * @returns {Promise<object[]>} one result per file, in order: a photo's `{fileType: "image", width, height,
     *   totalSize, hdSize, finished, normalUrl, hdUrl, thumbUrl, chunkId, photoId, clientFileId}`, a file's upload
     *   reply plus `{fileType, fileUrl, fileId, totalSize, fileName, checksum}`
     */
    async function uploadAttachment(sources, threadId, type = THREAD_TYPE.USER) {
        const cfg = uploadSettings(s.ctx);
        const files = checkList(sources, threadId, cfg);
        const group = Number(type) === THREAD_TYPE.GROUP;
        // zca-js uploaded a GIF through this call as a plain file; so does this one.
        const items = (await inspect(s.ctx, files, cfg)).map((it) =>
            it.route === "gif" ? { ...it, route: "file", fileType: "others" } : it,
        );
        const uploads = await uploadAll(s, items, { group, threadId: String(threadId), cfg });
        return uploads.map(uploadResult);
    }

    /**
     * Send local files to a conversation, with an optional caption: the `attachments` half of `sendMessage`.
     *
     * @param {{msg?: string, attachments: string|string[], quote?: object, mentions?: object[], styles?: object[],
     *   urgency?: number, ttl?: number}} message - `attachments` are local file paths
     * @param {string} threadId - the user or group to send to
     * @param {number} [type] - 0 a user, 1 a group
     * @returns {Promise<{message: object|null, attachment: object[]}>} `message` is the caption's own send, when it
     *   went separately; `attachment[i]` the send of each file (`{msgId, cliMsgId}`), photos and files in the order
     *   given, then GIFs
     */
    async function sendAttachments(message, threadId, type = THREAD_TYPE.USER) {
        const cfg = uploadSettings(s.ctx);
        const files = checkList(message?.attachments, threadId, cfg);
        const group = Number(type) === THREAD_TYPE.GROUP;
        const thread = String(threadId);
        const items = await inspect(s.ctx, files, cfg);

        const caption = typeof message.msg === "string" ? message.msg : "";
        const asDesc = items.length === 1 && items[0].route === "photo";
        const responses = { message: null, attachment: [] };
        let desc = caption;
        if (caption.length > 0 && (!asDesc || message.quote)) {
            const text = { ...message };
            delete text.attachments;
            const sent = await s.api.sendMessage(text, threadId, type);
            responses.message = sent?.message ?? null;
            desc = "";
        }

        const where = { group, threadId: thread, cfg };
        const uploads = await uploadAll(
            s,
            items.filter((it) => it.route !== "gif"),
            where,
        );
        const gifs = [];
        for (const item of items.filter((it) => it.route === "gif")) {
            const clientId = s.nextClientId();
            const bytes = await readRange(item.file, 0, item.size);
            const thumb = await s.call(UPTHUMB, { params: { clientId, imei: s.ctx.imei }, bytes });
            gifs.push({ item, clientId, bytes, thumbUrl: thumb?.url, checksum: await md5Of(item.file, item.size) });
        }

        const photos = uploads.filter((u) => u.item.route === "photo");
        const layout = photos.length > 1 ? String(s.now()) : null;
        const language = s.ctx.language;
        for (const u of uploads) {
            const { item, clientId, urls } = u;
            let params;
            let def;
            if (item.route === "photo") {
                const index = photos.indexOf(u);
                params = {
                    photoId: u.reply.photoId,
                    clientId: String(clientId),
                    desc,
                    width: item.width,
                    height: item.height,
                    rawUrl: urls.normalUrl,
                    thumbUrl: urls.thumbUrl,
                    hdUrl: urls.hdUrl,
                    ...(group ? { oriUrl: urls.normalUrl } : { normalUrl: urls.normalUrl }),
                    ...(layout
                        ? { groupLayoutId: layout, idInGroup: index, isGroupLayout: 1, totalItemInGroup: photos.length }
                        : {}),
                    ...threadParam(thread, group),
                    language,
                    ...(layout ? { extMsgProp: JSON.stringify({ groupMediaMsg: { groupLayoutId: layout } }) } : {}),
                    zsource: -1,
                    ttl: 0,
                    imei: s.ctx.imei,
                };
                def = photoSendEndpoint(group);
            } else {
                params = {
                    fileId: String(u.reply.fileId),
                    checksum: u.checksum,
                    checksumSha: "",
                    extension: item.ext,
                    totalSize: item.size,
                    fileName: item.fileName,
                    clientId,
                    fType: 1,
                    fileCount: 0,
                    fdata: "{}",
                    ...threadParam(thread, group),
                    fileUrl: urls.fileUrl,
                    zsource: -1,
                    ttl: 0,
                    ...(group ? {} : { imei: s.ctx.imei }),
                };
                def = fileSendEndpoint(group);
            }
            responses.attachment.push(stamped(await s.call(def, { params }), clientId));
        }
        for (const g of gifs) {
            const params = {
                clientId: String(g.clientId),
                fileName: g.item.fileName,
                totalSize: g.item.size,
                width: g.item.width,
                height: g.item.height,
                msg: desc,
                type: 1,
                ttl: 0,
                ...(group ? { visibility: 0 } : {}),
                ...threadParam(thread, group),
                thumb: g.thumbUrl,
                checksum: g.checksum,
                totalChunk: 1,
                chunkId: 1,
            };
            const reply = await s.call(gifEndpoint(group), { params, fileName: g.item.fileName, bytes: g.bytes });
            responses.attachment.push(stamped(reply, g.clientId));
        }
        return responses;
    }

    return { sendAttachments, uploadAttachment };
}

/** Methods whose wire-upload.test.js differential passes: the switch answers these from our code. */
export const OWN_READY = new Set(["sendAttachments", "uploadAttachment"]);
