/**
 * Cached media reaches a caller in one of three ways (`media.deliver`, src/core/deploy-policy.js):
 *
 * - **inline**: the plaintext itself, as MCP image or audio content, for pictures and voice up to `inlineMaxBytes`.
 * - **link**: `<publicUrl>/zalo/media/<token>`, served from the sealed file a range at a time (src/core/media-route.js).
 *   A token is 128 random bits held in this process's memory only, bound to {account, message, file}, alive for
 *   `linkTtl`; revoked on logout or kick, when its chat is hidden, on a rekey, and with the process.
 * - **tempfile**: a private decrypted copy under `<CONFIG_DIR>/tmp/media/<random>/` (folder 0700, file 0600), deleted
 *   after `tempfileTtl` by a timer, on exit, or by the sweep at the next start; only for a caller on this machine.
 *
 * {@link chooseDelivery} turns the policy, the call's own choice and where the caller sits into one mode.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { CONFIG_DIR } from "./credentials.js";
import { decryptMediaToFile, mediaFileState, readMediaFile, readMediaHeader } from "./keystore/media-seal.js";
import { onRekey } from "./keystore/index.js";
import { isLoopbackUrl, MEDIA_DEFAULTS, validatePublicUrl } from "./deploy-policy.js";

// ── Modes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The kinds that can go inline, and as which MCP content type. */
export const INLINE_KINDS = Object.freeze({
    photo: "image",
    gif: "image",
    doodle: "image",
    sticker: "image",
    voice: "audio",
    audio: "audio",
});

const IMAGE_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
const AUDIO_MIME = {
    aac: "audio/aac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    mpeg: "audio/mpeg",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    oga: "audio/ogg",
    wav: "audio/wav",
    webm: "audio/webm",
    amr: "audio/amr",
};
const VIDEO_MIME = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };

/** The types a link serves as themselves (shown in the browser); anything else is a download. */
export const SAFE_MEDIA_MIME = Object.freeze(
    new Set([...Object.values(IMAGE_MIME), ...Object.values(AUDIO_MIME), ...Object.values(VIDEO_MIME)]),
);

/**
 * The media type of a cached file, from its sealed header's `mime` and `ext` (or the file name), lower-cased and
 * without parameters; `application/octet-stream` when nothing says.
 *
 * @param {{mime?: string|null, ext?: string|null}|null} meta
 * @param {string} [file]
 * @returns {string}
 */
export function mediaMime(meta, file = "") {
    const declared = String(meta?.mime ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
    if (/^[a-z]+\/[a-z0-9.+-]+$/.test(declared) && declared !== "application/octet-stream") return declared;
    const ext = String(meta?.ext || extname(file) || "")
        .replace(/^\./, "")
        .toLowerCase();
    return IMAGE_MIME[ext] || AUDIO_MIME[ext] || VIDEO_MIME[ext] || "application/octet-stream";
}

/**
 * Pick how one piece of media is delivered.
 *
 * Order: the call's own `deliver` (refused when `allowDeliver` does not list it), else a tempfile when the viewer is
 * to be opened (stdio only), else the policy's mode for the kind. Then what cannot work is moved, with a note: inline
 * for a kind that is not a picture or voice, or larger than `inlineMaxBytes`, or of an unknown type, goes as a link; a
 * tempfile for a client on another machine goes as a link (the path means nothing there). A mode `allowDeliver`
 * forbids falls back to the first allowed one that can work.
 *
 * @param {object} args
 * @param {string} args.kind - photo, gif, doodle, sticker, voice, audio, video or file
 * @param {number|null} args.size - plaintext bytes
 * @param {string|null} [args.mime]
 * @param {string|null} [args.requested] - the call's `deliver`
 * @param {boolean|undefined} [args.open] - the call's `open` (undefined: the policy's autoOpen)
 * @param {ReturnType<import("./deploy-policy.js").resolveMediaDelivery>} args.policy
 * @param {boolean} args.stdio - the caller is the stdio client (this machine)
 * @param {boolean} [args.clientLoopback] - over HTTP: the client connects from this machine
 * @returns {{mode: "inline"|"link"|"tempfile", open: boolean, notes: string[]} | {error: string}}
 */
export function chooseDelivery({ kind, size, mime = null, requested = null, open, policy, stdio, clientLoopback }) {
    const allowed = policy.allowDeliver;
    const notes = [];
    const local = stdio || clientLoopback === true;
    const inlineOk = () =>
        Boolean(INLINE_KINDS[kind]) &&
        Number.isFinite(size) &&
        size <= policy.inlineMaxBytes &&
        (!mime || mime.startsWith(`${INLINE_KINDS[kind]}/`));
    let mode = null;
    if (requested) {
        if (!allowed.includes(requested)) {
            return {
                error: `deliver "${requested}" is not allowed on this server (media.allowDeliver: ${allowed.join(", ")})`,
            };
        }
        mode = requested;
    }
    let wantOpen = open ?? (requested ? false : (policy.autoOpen ?? stdio));
    if (wantOpen && !stdio) {
        if (open === true) notes.push("open works only for a stdio server on the viewer's own machine; not opened");
        wantOpen = false;
    }
    if (!mode && wantOpen && allowed.includes("tempfile")) mode = "tempfile";
    if (!mode) mode = policy.deliver[kind] || "link";
    if (wantOpen && mode !== "tempfile") {
        if (open === true) notes.push('open needs deliver "tempfile"; not opened');
        wantOpen = false;
    }
    if (mode === "inline" && !inlineOk()) {
        notes.push(
            !INLINE_KINDS[kind]
                ? `a ${kind} cannot go inline; sent as a link`
                : size > policy.inlineMaxBytes
                  ? `${size} bytes is over media.inlineMaxBytes (${policy.inlineMaxBytes}); sent as a link`
                  : `its type (${mime}) cannot go inline; sent as a link`,
        );
        mode = "link";
    }
    if (mode === "tempfile" && !local) {
        notes.push("a tempfile path means nothing to a client on another machine; sent as a link");
        mode = "link";
        wantOpen = false;
    }
    if (!allowed.includes(mode)) {
        const usable = ["link", "inline", "tempfile"].find(
            (m) => allowed.includes(m) && (m !== "inline" || inlineOk()) && (m !== "tempfile" || local),
        );
        if (!usable) {
            return {
                error: `no delivery allowed on this server can carry this ${kind} (media.allowDeliver: ${allowed.join(", ")})`,
            };
        }
        notes.push(`"${mode}" is not allowed on this server; sent as ${usable}`);
        mode = usable;
        if (mode !== "tempfile") wantOpen = false;
    }
    return { mode, open: Boolean(wantOpen && mode === "tempfile"), notes };
}

/**
 * MCP content for inline media: `{type: "image"|"audio", data, mimeType}`.
 *
 * @param {Buffer} bytes
 * @param {string} kind
 * @param {string} mime
 * @returns {{type: "image"|"audio", data: string, mimeType: string}}
 */
export function inlineContent(bytes, kind, mime) {
    return { type: INLINE_KINDS[kind] || "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime };
}

/**
 * A file name safe for a header or a folder: no path, no control or reserved character, at most 120 characters.
 *
 * @param {unknown} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function safeMediaName(name, fallback = "media") {
    const clean = basename(String(name ?? ""))
        .replace(/[\p{Cc}<>:"/\\|?*]+/gu, "_")
        .replace(/^[.\s]+|[.\s]+$/g, "")
        .slice(-120);
    return clean || fallback;
}

// ── Tempfiles ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** How long a decrypted copy lives by default. */
export const TEMPFILE_TTL_MS = MEDIA_DEFAULTS.tempfileTtlMs;

const liveTemp = new Set();
let exitHooked = false;
let sweeper = null;

/** The folder decrypted copies go to. */
export function mediaTempRoot() {
    return join(CONFIG_DIR, "tmp", "media");
}

function removeDir(dir) {
    liveTemp.delete(dir);
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* already gone, or held by a viewer (Windows): the sweep retries */
    }
}

/**
 * Delete decrypted copies older than the TTL (left by a crash or another process, or still held open when their timer
 * fired).
 *
 * @param {number} [ttlMs]
 * @param {number} [now]
 * @returns {number} folders removed
 */
export function sweepMediaTemp(ttlMs = TEMPFILE_TTL_MS, now = Date.now()) {
    let removed = 0;
    let names = [];
    try {
        names = readdirSync(mediaTempRoot());
    } catch {
        return 0;
    }
    for (const n of names) {
        const dir = join(mediaTempRoot(), n);
        try {
            if (now - statSync(dir).mtimeMs < ttlMs) continue;
        } catch {
            continue;
        }
        removeDir(dir);
        removed++;
    }
    return removed;
}

/**
 * Sweep the tempfile folder now and then every `intervalMs` (a daemon: copies a CLI process left behind expire on
 * time). The timer never keeps the process alive.
 *
 * @param {{ttlMs?: number, intervalMs?: number}} [opts]
 * @returns {() => void} stop
 */
export function startTempfileSweeper({ ttlMs = TEMPFILE_TTL_MS, intervalMs = 60_000 } = {}) {
    sweepMediaTemp(ttlMs);
    if (sweeper) clearInterval(sweeper);
    sweeper = setInterval(() => sweepMediaTemp(ttlMs), intervalMs);
    sweeper.unref?.();
    return () => {
        clearInterval(sweeper);
        sweeper = null;
    };
}

/**
 * Decrypt a sealed media file to a private temporary copy.
 *
 * @param {string} file - the sealed file (`localPath`)
 * @param {{id: string, dir: string}} scope - the account
 * @param {{msgId?: string|null, name?: string, ttlMs?: number, keepOnExit?: boolean}} [opts] - `name`: the copy's
 *   file name (default: the sealed file's own, so an upload keeps it); `ttlMs` 0 keeps it until
 *   {@link removeMediaTemp} or exit; `keepOnExit`: a CLI process hands the path to its user and exits, so the copy
 *   outlives it and the next sweep (a daemon's, or the next call's) removes it once it is older than the TTL
 * @returns {{path: string, dir: string, expiresAt: number|null}}
 */
export function decryptToTempfile(
    file,
    scope,
    { msgId = null, name, ttlMs = TEMPFILE_TTL_MS, keepOnExit = false } = {},
) {
    sweepMediaTemp(ttlMs || TEMPFILE_TTL_MS);
    mkdirSync(mediaTempRoot(), { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(mediaTempRoot(), "m-"));
    if (!keepOnExit) {
        liveTemp.add(dir);
        if (!exitHooked) {
            exitHooked = true;
            process.once("exit", () => {
                for (const d of [...liveTemp]) removeDir(d);
            });
        }
    }
    const path = join(dir, safeMediaName(name || basename(file)));
    try {
        decryptMediaToFile(file, path, scope, { msgId });
    } catch (e) {
        removeDir(dir);
        throw e;
    }
    let expiresAt = null;
    if (ttlMs > 0) {
        expiresAt = Date.now() + ttlMs;
        if (!keepOnExit) setTimeout(() => removeDir(dir), ttlMs).unref?.();
    }
    return { path, dir, expiresAt };
}

/**
 * Delete a decrypted copy now (an upload is done with it).
 *
 * @param {{dir: string}|null|undefined} copy
 */
export function removeMediaTemp(copy) {
    if (copy?.dir) removeDir(copy.dir);
}

// ── Links ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The path prefix of a media link. */
export const MEDIA_PATH_PREFIX = "/zalo/media/";
/** A token: 16 random bytes, base64url (22 characters). */
export const MEDIA_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;
/** Most live links kept at once; the oldest goes first. */
const MAX_LINKS = 2000;
/** How long a used-up, expired or revoked link is remembered, so a request for it says 410 rather than 404. */
const TOMBSTONE_MS = 30 * 60_000;

/**
 * A request path or URL with any media token replaced, for logs; the query after it goes too.
 *
 * @param {unknown} url
 * @returns {string}
 */
export function maskMediaPath(url) {
    return String(url ?? "").replace(/\/zalo\/media\/[^/?#\s]*(?:\?[^#\s]*)?/g, "/zalo/media/***");
}

/**
 * The media links of one process: where they point, who may fetch them, and which are alive.
 */
export class MediaLinks {
    /**
     * @param {{now?: () => number}} [opts]
     */
    constructor({ now = Date.now } = {}) {
        this.now = now;
        /** @type {Map<string, object>} */
        this.links = new Map();
        /** token -> {reason, until} */
        this.tombstones = new Map();
        this.publicUrl = null;
        this.localBaseUrl = null;
        this.mounted = false;
        this.listener = null;
        /** Whether the server the links are mounted on checks a bearer token (an `--auth`/OAuth secret is set). */
        this.bearerAvailable = false;
        this.linkAuth = "capability";
        this.maxClients = MEDIA_DEFAULTS.capabilityMaxClients;
        this.clientTtlMs = MEDIA_DEFAULTS.capabilityTtlMs;
        this.ttlMs = MEDIA_DEFAULTS.linkTtlMs;
        this.rateLimit = MEDIA_DEFAULTS.linkRateLimit;
        this.trustedProxies = [];
        this.log = (line) => console.error(line);
        this.warnedNoBearer = false;
    }

    /**
     * Settings from `mcp start` / `listen`: where links point and the policy they are issued under.
     *
     * @param {object} [o]
     * @returns {this}
     */
    configure(o = {}) {
        for (const key of [
            "publicUrl",
            "bearerAvailable",
            "linkAuth",
            "maxClients",
            "clientTtlMs",
            "ttlMs",
            "rateLimit",
            "trustedProxies",
            "log",
        ]) {
            if (o[key] !== undefined) this[key] = o[key];
        }
        if (o.localBaseUrl !== undefined) {
            this.localBaseUrl = o.localBaseUrl;
            this.mounted = Boolean(o.localBaseUrl);
        }
        return this;
    }

    /** The base URL links are built on: publicUrl, else this server's local address. Never a request's Host. */
    base() {
        return this.publicUrl || this.localBaseUrl;
    }

    #prune() {
        const t = this.now();
        for (const [token, link] of this.links) {
            if (link.expiresAt <= t) this.#bury(token, "expired");
        }
        for (const [token, stone] of this.tombstones) {
            if (stone.until <= t) this.tombstones.delete(token);
        }
        while (this.links.size >= MAX_LINKS) this.#bury(this.links.keys().next().value, "replaced by newer links");
    }

    #bury(token, reason) {
        const link = this.links.get(token);
        this.links.delete(token);
        if (link) {
            for (const stream of link.streams) stream.destroy();
            link.streams.clear();
        }
        this.tombstones.set(token, { reason, until: this.now() + TOMBSTONE_MS });
    }

    /**
     * Issue a link to one cached file. The caller has already checked the message (its thread, its hidden state).
     *
     * @param {object} spec
     * @param {string} spec.accountId
     * @param {string} spec.msgId
     * @param {string|null} [spec.threadId]
     * @param {string} spec.file - the sealed file
     * @param {{id: string, dir: string}} spec.scope
     * @param {string} spec.mime
     * @param {string} spec.name - the download name
     * @param {number|null} [spec.size]
     * @param {number} [spec.ttlMs]
     * @returns {{token: string, url: string, expiresAt: number, auth: "bearer"|"capability"}}
     * @throws {Error} when there is no address a link can use (http to another host)
     */
    issue({ accountId, msgId, threadId = null, file, scope, mime, name, size = null, ttlMs }) {
        const base = this.base();
        if (!base) throw new Error("media links are not served by this process");
        const { url: checked, error } = validatePublicUrl(base);
        if (error) {
            throw new Error(
                `a media link needs https off this machine, and links here would be ${base}: set publicUrl to an ` +
                    "https address (or serve TLS), or ask for inline or tempfile",
            );
        }
        this.#prune();
        let auth = this.linkAuth === "bearer" ? "bearer" : "capability";
        if (auth === "bearer" && !this.bearerAvailable) {
            // No --auth/OAuth secret on this server: there is nothing to check, so the link's own limits apply.
            if (!this.warnedNoBearer) {
                this.warnedNoBearer = true;
                this.log("[media] linkAuth is bearer but this server has no --auth token: links are capability links");
            }
            auth = "capability";
        }
        const token = randomBytes(16).toString("base64url");
        const t = this.now();
        const link = {
            token,
            accountId: String(accountId ?? ""),
            msgId: String(msgId),
            threadId: threadId === null || threadId === undefined ? null : String(threadId),
            file,
            scope,
            mime,
            name,
            size,
            auth,
            // A capability link that leaves this machine serves a bounded set of client addresses.
            offLoopback: !isLoopbackUrl(checked),
            maxClients: this.maxClients,
            clientTtlMs: this.clientTtlMs,
            clients: new Map(),
            streams: new Set(),
            createdAt: t,
            expiresAt: t + (ttlMs || this.ttlMs),
        };
        this.links.set(token, link);
        return { token, url: `${checked}${MEDIA_PATH_PREFIX}${token}`, expiresAt: link.expiresAt, auth };
    }

    /**
     * The live link of a token, or why there is none.
     *
     * @param {string} token
     * @returns {{link: object} | {gone: string} | {unknown: true}}
     */
    lookup(token) {
        this.#prune();
        const link = this.links.get(token);
        if (link) return { link };
        const stone = this.tombstones.get(token);
        if (stone) return { gone: stone.reason };
        return { unknown: true };
    }

    /**
     * Admit a client address to a link: always on loopback or for a bearer link; for a capability link off loopback,
     * an address already admitted within its window, or a new one while fewer than `maxClients` windows are open.
     *
     * @param {object} link
     * @param {string} ip
     * @returns {boolean}
     */
    admit(link, ip) {
        if (link.auth !== "capability" || !link.offLoopback) return true;
        const t = this.now();
        for (const [addr, since] of link.clients) {
            if (since + link.clientTtlMs <= t) link.clients.delete(addr);
        }
        if (link.clients.has(ip)) return true;
        if (link.clients.size >= link.maxClients) return false;
        link.clients.set(ip, t);
        return true;
    }

    /**
     * Revoke every link (logout, kick, rekey, shutdown).
     *
     * @param {string} [reason]
     * @returns {number} links revoked
     */
    revokeAll(reason = "revoked") {
        return this.revokeWhere(() => true, reason);
    }

    /**
     * Revoke the links that match.
     *
     * @param {(link: object) => boolean} match
     * @param {string} [reason]
     * @returns {number} links revoked
     */
    revokeWhere(match, reason = "revoked") {
        let n = 0;
        for (const [token, link] of [...this.links]) {
            if (match(link)) {
                this.#bury(token, reason);
                n++;
            }
        }
        return n;
    }

    /**
     * Revoke the links into one conversation (it was hidden).
     *
     * @param {string} threadId
     * @param {string} [reason]
     * @returns {number}
     */
    revokeThread(threadId, reason = "its chat was hidden") {
        return this.revokeWhere((l) => l.threadId !== null && l.threadId === String(threadId), reason);
    }
}

let current = null;

/** The process's media links (one per process: tokens live in memory). */
export function getMediaLinks() {
    if (!current) current = new MediaLinks();
    return current;
}

/** Test seam: use this one instead (null resets). */
export function setMediaLinks(links) {
    current = links;
}

// A rekey replaces the key the files are sealed with: a link issued before it is revoked with the old key.
onRekey(() => {
    current?.revokeAll("the account was rekeyed");
});

// ── One cached file, delivered ───────────────────────────────────────────────────────────────────────────────────────

/**
 * What a cached media file is, without its key: the plaintext size and type from a sealed file's header (or the file
 * itself for a 2.x plaintext one), and the name it downloads as.
 *
 * @param {string} file
 * @returns {{size: number, mime: string, name: string}}
 * @throws {Error} when the file is not there
 */
export function mediaInfo(file) {
    const state = mediaFileState(file);
    if (state === "absent") throw new Error("the cached media file is missing");
    if (state === "sealed") {
        const { meta } = readMediaHeader(file);
        return { size: Number(meta.size), mime: mediaMime(meta, file), name: safeMediaName(basename(file)) };
    }
    return { size: statSync(file).size, mime: mediaMime({}, file), name: safeMediaName(basename(file)) };
}

/**
 * Deliver one cached file in a chosen mode.
 *
 * @param {object} args
 * @param {"inline"|"link"|"tempfile"} args.mode
 * @param {string} args.file - the sealed file
 * @param {{id: string, dir: string}} args.scope
 * @param {string} args.msgId
 * @param {string|null} [args.threadId]
 * @param {string} [args.accountId]
 * @param {{size: number, mime: string, name: string}} [args.info] - {@link mediaInfo}, when already read
 * @param {{tempfileTtlMs?: number, linkTtlMs?: number}} [args.policy]
 * @param {MediaLinks} [args.links]
 * @param {(links: MediaLinks) => Promise<void>} [args.ensureServed] - start the stdio listener (src/core/media-route.js)
 * @param {boolean} [args.keepOnExit] - a tempfile for a CLI process that exits right after
 * @returns {Promise<{mode: string, size: number, mimeType: string, name: string, bytes?: Buffer, url?: string,
 *   auth?: string, path?: string, expiresAt?: number|null}>}
 */
export async function deliverCachedMedia({
    mode,
    file,
    scope,
    msgId,
    threadId = null,
    accountId = "",
    info,
    policy = {},
    links = getMediaLinks(),
    ensureServed = null,
    keepOnExit = false,
}) {
    const meta = info ?? mediaInfo(file);
    const base = { mode, size: meta.size, mimeType: meta.mime, name: meta.name };
    if (mode === "inline") return { ...base, bytes: readMediaFile(file, scope, { msgId }) };
    if (mode === "link") {
        if (ensureServed) await ensureServed(links);
        const link = links.issue({
            accountId,
            msgId,
            threadId,
            file,
            scope,
            mime: meta.mime,
            name: meta.name,
            size: meta.size,
            ttlMs: policy.linkTtlMs,
        });
        return { ...base, url: link.url, auth: link.auth, expiresAt: link.expiresAt };
    }
    const copy = decryptToTempfile(file, scope, {
        msgId,
        ttlMs: policy.tempfileTtlMs ?? TEMPFILE_TTL_MS,
        keepOnExit,
    });
    return { ...base, path: copy.path, expiresAt: copy.expiresAt };
}

/**
 * A link to the cached media of one message, for a daemon asked over its channel (`msg media --deliver link`).
 *
 * @param {object} args
 * @param {object|null} args.row - the cached message (getMessageById)
 * @param {{id: string, dir: string}} args.scope
 * @param {string} args.accountId
 * @param {{isHidden: (threadId: string) => boolean}|null} [args.hidden] - hidden chats to refuse (null: none)
 * @param {MediaLinks} [args.links]
 * @param {(links: MediaLinks) => Promise<void>} [args.ensureServed]
 * @param {{linkTtlMs?: number}} [args.policy]
 * @returns {Promise<{url: string, expiresAt: number, auth: string, mimeType: string, size: number}>}
 */
export async function linkForCachedMessage({
    row,
    scope,
    accountId,
    hidden = null,
    links = getMediaLinks(),
    ensureServed = null,
    policy = {},
}) {
    if (!row) throw new Error("that message is not in the local cache");
    if (hidden?.isHidden(row.threadId)) throw new Error("that message is in a hidden chat");
    if (!row.localPath || mediaFileState(row.localPath) === "absent") {
        throw new Error(`message ${row.msgId} has no downloaded media (zalo-agent sync-media -T ${row.threadId})`);
    }
    const out = await deliverCachedMedia({
        mode: "link",
        file: row.localPath,
        scope,
        msgId: row.msgId,
        threadId: row.threadId,
        accountId,
        policy,
        links,
        ensureServed,
    });
    return { url: out.url, expiresAt: out.expiresAt, auth: out.auth, mimeType: out.mimeType, size: out.size };
}
