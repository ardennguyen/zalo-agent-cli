/**
 * The account's upload store: files a caller handed the server ahead of the call that uses them (POST /zalo/files, a
 * zalo_file upload link, zalo_file 'upload', `zalo-agent file put`), named by an unguessable `fileId`.
 *
 * Layout, under `<accountDir>/uploads/` (inside the account's folder, so a deployment that keeps the account's data
 * on a volume keeps these with it and counts them in its storage):
 *
 *   <fileId>/meta.json      {fileId, name, mimeType, size, createdAt, expiresAt}
 *   <fileId>/f/<name>       the file, under the caller's own name (Zalo shows a sent file by its name)
 *   .partial/<random>       an upload still arriving; moved into place once complete
 *   .tmp/<random>/<name>    a file one call fetched or decoded (a `url` or `data` item), removed when the call ends
 *
 * Folders are 0700 and files 0600. A file is kept until `uploads.ttl` after it arrived (24 h), then swept; the store
 * holds at most `uploads.quota` (two files of the account's Zalo limit) at once, and an upload that would go over it
 * is refused. A file a send used goes as soon as its message is recorded (`markSent`, `reapSent`). Nothing here is
 * ever sent anywhere by itself: a file leaves only when a send names its fileId.
 */

import { randomBytes } from "node:crypto";
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { safeMediaName } from "./media-deliver.js";

/** A fileId: `f_` and 18 random bytes, base64url (24 characters). */
export const FILE_ID_SHAPE = /^f_[A-Za-z0-9_-]{24}$/;
/** An upload link's token: 24 random bytes, base64url. */
export const UPLOAD_TOKEN_SHAPE = /^[A-Za-z0-9_-]{32}$/;
/** A partial upload or a call's scratch folder older than this is left over from a crash. */
const STALE_SCRATCH_MS = 6 * 3_600_000;

/** A refusal of an upload, with a code the HTTP route maps to a status. */
export class UploadError extends Error {
    /**
     * @param {string} message
     * @param {string} code - TOO_LARGE, QUOTA, EMPTY, NOT_FOUND, ABORTED
     */
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

/** "12.3 MB". */
export function sizeText(n) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = Number(n) || 0;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** A new fileId. */
export function newFileId() {
    return `f_${randomBytes(18).toString("base64url")}`;
}

/** The folder an account's uploads live in. */
export function uploadsDirOf(accountDir) {
    return join(accountDir, "uploads");
}

/**
 * One account's upload store.
 */
export class UploadStore {
    /**
     * @param {string} dir - `<accountDir>/uploads`
     * @param {{now?: () => number}} [opts]
     */
    constructor(dir, { now = Date.now } = {}) {
        this.dir = dir;
        this.now = now;
        /** token -> {fileId, name, mimeType, maxBytes, ttlMs, expiresAt, used} of the upload links handed out */
        this.links = new Map();
        /** Bytes of uploads under way, counted against the quota before they land. */
        this.inflight = 0;
        /** The timer of {@link UploadStore#watchSent}, while sent files wait for their record. */
        this.watching = null;
    }

    #ensure() {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }

    #meta(fileId) {
        if (!FILE_ID_SHAPE.test(String(fileId ?? ""))) return null;
        try {
            return JSON.parse(readFileSync(join(this.dir, fileId, "meta.json"), "utf8"));
        } catch {
            return null;
        }
    }

    #remove(fileId) {
        try {
            rmSync(join(this.dir, fileId), { recursive: true, force: true });
        } catch {
            /* the next sweep tries again */
        }
    }

    /** The public view of a stored file, with its state: `stored`, `sent` (waiting for its record) or `consumed`. */
    #view(m) {
        const c = m.consumed ?? null;
        return {
            fileId: m.fileId,
            name: m.name,
            mimeType: m.mimeType ?? null,
            size: m.size,
            createdAt: new Date(m.createdAt).toISOString(),
            expiresAt: new Date(m.expiresAt).toISOString(),
            status: !c ? "stored" : c.removedAt ? "consumed" : "sent",
            ...(c
                ? {
                      sent: {
                          at: new Date(c.at).toISOString(),
                          msgIds: c.msgIds,
                          ...(c.threadId ? { threadId: c.threadId } : {}),
                          ...(c.removedAt
                              ? { removedAt: new Date(c.removedAt).toISOString(), removedBecause: c.reason }
                              : {}),
                      },
                  }
                : {}),
        };
    }

    #writeMeta(m) {
        try {
            writeFileSync(join(this.dir, m.fileId, "meta.json"), JSON.stringify(m), { mode: 0o600 });
        } catch {
            /* gone meanwhile */
        }
    }

    /** Remove a sent file's bytes and keep its record (a tombstone) until it would have expired. */
    #consume(m, reason) {
        try {
            rmSync(join(this.dir, m.fileId, "f"), { recursive: true, force: true });
        } catch {
            /* the next reap tries again */
        }
        m.consumed = { ...m.consumed, removedAt: this.now(), reason };
        this.#writeMeta(m);
    }

    /**
     * A stored file with its path, or null when the id is unknown or its time is up (then it is removed).
     *
     * @param {string} fileId
     * @returns {{fileId: string, name: string, mimeType: string|null, size: number, path: string,
     *   createdAt: string, expiresAt: string}|null}
     */
    get(fileId) {
        const m = this.#meta(fileId);
        if (!m || m.consumed?.removedAt) return null;
        const path = join(this.dir, fileId, "f", m.name);
        if (m.expiresAt <= this.now() || !existsSync(path)) {
            this.#remove(fileId);
            return null;
        }
        return { ...this.#view(m), path };
    }

    /**
     * Every stored file, newest first (expired ones are swept first).
     *
     * @returns {object[]}
     */
    list() {
        this.sweep();
        const out = [];
        for (const id of this.#ids()) {
            const m = this.#meta(id);
            if (m) out.push(this.#view(m));
        }
        return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }

    #ids() {
        try {
            return readdirSync(this.dir).filter((n) => FILE_ID_SHAPE.test(n));
        } catch {
            return [];
        }
    }

    /**
     * Delete a stored file.
     *
     * @param {string} fileId
     * @returns {boolean} whether there was one
     */
    delete(fileId) {
        const m = this.#meta(fileId);
        if (!m || m.consumed?.removedAt) return false;
        this.#remove(fileId);
        return true;
    }

    /**
     * The bytes and files the store holds now (expired ones still on disk included until swept).
     *
     * @returns {{bytes: number, files: number}}
     */
    usage() {
        let bytes = 0;
        let files = 0;
        for (const id of this.#ids()) {
            const m = this.#meta(id);
            if (!m || m.consumed?.removedAt) continue;
            bytes += Number(m.size) || 0;
            files++;
        }
        return { bytes, files };
    }

    /**
     * What is known of a fileId: its view (any state), or null when it never existed or its record is gone.
     *
     * @param {string} fileId
     * @returns {object|null}
     */
    status(fileId) {
        const m = this.#meta(fileId);
        if (!m) return null;
        if (m.expiresAt <= this.now()) {
            this.#remove(fileId);
            return null;
        }
        return this.#view(m);
    }

    /**
     * Mark stored files as sent by a message: they go as soon as the message is recorded (`reapSent`), or at once
     * when there is nothing to record (an avatar, a product photo, an official upload). A send that failed marks
     * nothing, so the caller can retry with the same fileId until it expires.
     *
     * @param {string} fileId
     * @param {{msgIds?: string[], threadId?: string|null, needsRecord?: boolean}} [sent]
     * @returns {boolean} whether the fileId was a stored file
     */
    markSent(fileId, { msgIds = [], threadId = null, needsRecord = true } = {}) {
        const m = this.#meta(fileId);
        if (!m || m.consumed?.removedAt) return false;
        const ids = [...new Set([...(m.consumed?.msgIds ?? []), ...msgIds.filter(Boolean).map(String)])];
        m.consumed = { at: this.now(), msgIds: ids, threadId: threadId === null ? null : String(threadId) };
        if (!needsRecord || !ids.length) this.#consume(m, "used");
        else this.#writeMeta(m);
        return true;
    }

    /**
     * Remove the bytes of sent files whose messages are recorded (`isRecorded(msgId)` for each), or that waited
     * `recordWaitMs` without it.
     *
     * @param {(msgId: string) => boolean} isRecorded
     * @param {number} recordWaitMs
     * @returns {{removed: number, waiting: number}}
     */
    reapSent(isRecorded, recordWaitMs) {
        let removed = 0;
        let waiting = 0;
        for (const id of this.#ids()) {
            const m = this.#meta(id);
            const c = m?.consumed;
            if (!c || c.removedAt) continue;
            let recorded = false;
            try {
                recorded = c.msgIds.every((msgId) => isRecorded(msgId));
            } catch {
                recorded = false;
            }
            if (recorded) {
                this.#consume(m, "recorded");
                removed++;
            } else if (this.now() - c.at >= recordWaitMs) {
                this.#consume(m, "not recorded in time");
                removed++;
            } else waiting++;
        }
        return { removed, waiting };
    }

    /**
     * Reap sent files every `intervalMs` until none is waiting (a send just marked some). The timer never keeps the
     * process alive; a daemon's sweeper reaps whatever a short-lived process left.
     *
     * @param {(msgId: string) => boolean} isRecorded
     * @param {number} recordWaitMs
     * @param {number} [intervalMs]
     */
    watchSent(isRecorded, recordWaitMs, intervalMs = 2000) {
        if (this.watching) return;
        const tick = () => {
            const { waiting } = this.reapSent(isRecorded, recordWaitMs);
            if (!waiting) {
                clearInterval(this.watching);
                this.watching = null;
            }
        };
        this.watching = setInterval(tick, intervalMs);
        this.watching.unref?.();
        tick();
    }

    /**
     * Remove expired files, upload links whose time is up, and scratch a crash left behind.
     *
     * @returns {number} files removed
     */
    sweep() {
        const t = this.now();
        let removed = 0;
        for (const id of this.#ids()) {
            const m = this.#meta(id);
            if (!m || m.expiresAt <= t) {
                this.#remove(id);
                removed++;
            }
        }
        for (const [token, l] of this.links) if (l.expiresAt <= t) this.links.delete(token);
        for (const sub of [".partial", ".tmp"]) {
            const root = join(this.dir, sub);
            let names = [];
            try {
                names = readdirSync(root);
            } catch {
                continue;
            }
            for (const n of names) {
                try {
                    if (t - statSync(join(root, n)).mtimeMs > STALE_SCRATCH_MS)
                        rmSync(join(root, n), { recursive: true, force: true });
                } catch {
                    /* gone meanwhile */
                }
            }
        }
        return removed;
    }

    /**
     * Store a file from a stream (an HTTP body) or a buffer, under the size cap and the quota.
     *
     * @param {import("node:stream").Readable|Buffer} source
     * @param {object} spec
     * @param {string} spec.name - the caller's name for it
     * @param {string|null} [spec.mimeType]
     * @param {number} spec.maxBytes - this file's cap
     * @param {number} spec.quotaBytes - the store's cap
     * @param {number} spec.ttlMs
     * @param {string} [spec.fileId] - the id an upload link promised
     * @param {number|null} [spec.declaredSize] - Content-Length, refused at once when over a cap
     * @returns {Promise<object>} the stored file's public view
     * @throws {UploadError}
     */
    async save(
        source,
        { name, mimeType = null, maxBytes, quotaBytes, ttlMs, fileId = newFileId(), declaredSize = null },
    ) {
        this.sweep();
        this.#ensure();
        const room = Math.max(0, quotaBytes - this.usage().bytes - this.inflight);
        const cap = Math.min(maxBytes, room);
        const over = (n) =>
            n > maxBytes
                ? new UploadError(`the file is over the ${sizeText(maxBytes)} limit for one upload`, "TOO_LARGE")
                : new UploadError(
                      `the account's upload store is full (${sizeText(quotaBytes)}; ${sizeText(room)} free): delete ` +
                          "files with zalo_file 'delete' or wait for them to expire",
                      "QUOTA",
                  );
        if (Number.isFinite(declaredSize) && declaredSize > cap) {
            if (!Buffer.isBuffer(source)) {
                source.on?.("error", () => {}); // a stream not read on may still fail (its file removed): ignored
                source.pause?.(); // not read on: the caller answers and closes
            }
            throw over(declaredSize);
        }
        const partialDir = join(this.dir, ".partial");
        mkdirSync(partialDir, { recursive: true, mode: 0o700 });
        const partial = join(partialDir, randomBytes(12).toString("base64url"));
        let size = 0;
        const reserve = Number.isFinite(declaredSize) ? declaredSize : 0;
        this.inflight += reserve;
        try {
            if (Buffer.isBuffer(source)) {
                if (source.length > cap) throw over(source.length);
                writeFileSync(partial, source, { mode: 0o600 });
                size = source.length;
            } else {
                size = await new Promise((resolve, reject) => {
                    const out = createWriteStream(partial, { mode: 0o600 });
                    let n = 0;
                    let settled = false;
                    const fail = (e) => {
                        if (settled) return;
                        settled = true;
                        source.unpipe?.(out);
                        source.on?.("error", () => {});
                        source.pause?.(); // stop reading at the cap: a large body is never read to its end
                        out.destroy();
                        reject(e);
                    };
                    source.on("data", (chunk) => {
                        n += chunk.length;
                        if (n > cap) fail(over(n));
                    });
                    source.on("aborted", () => fail(new UploadError("the upload broke off", "ABORTED")));
                    source.on("error", (e) => fail(new UploadError(`the upload broke off: ${e.message}`, "ABORTED")));
                    out.on("error", fail);
                    out.on("finish", () => {
                        if (settled) return;
                        settled = true;
                        resolve(n);
                    });
                    source.pipe(out);
                });
            }
            if (size === 0) throw new UploadError("the upload is empty", "EMPTY");
            const safe = safeMediaName(name, "upload");
            const target = join(this.dir, fileId);
            mkdirSync(join(target, "f"), { recursive: true, mode: 0o700 });
            renameSync(partial, join(target, "f", safe));
            const t = this.now();
            const meta = { fileId, name: safe, mimeType: mimeType || null, size, createdAt: t, expiresAt: t + ttlMs };
            writeFileSync(join(target, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
            return this.#view(meta);
        } catch (e) {
            try {
                rmSync(partial, { force: true });
            } catch {
                /* swept later */
            }
            throw e;
        } finally {
            this.inflight -= reserve;
        }
    }

    /**
     * Hand out a one-time upload link: its token admits one upload (PUT or POST) until `linkTtlMs`, and the file it
     * brings is stored under the fileId returned now.
     *
     * @param {{name?: string|null, mimeType?: string|null, maxBytes: number, ttlMs: number, linkTtlMs: number}} spec
     * @returns {{token: string, fileId: string, expiresAt: number}}
     */
    beginUpload({ name = null, mimeType = null, maxBytes, ttlMs, linkTtlMs }) {
        this.sweep();
        const token = randomBytes(24).toString("base64url");
        const fileId = newFileId();
        const expiresAt = this.now() + linkTtlMs;
        this.links.set(token, { fileId, name, mimeType, maxBytes, ttlMs, expiresAt, used: false });
        return { token, fileId, expiresAt };
    }

    /**
     * Take an upload link's token for the upload now arriving: once only.
     *
     * @param {string} token
     * @returns {{link: object}|{gone: string}|{unknown: true}}
     */
    takeUploadLink(token) {
        if (!UPLOAD_TOKEN_SHAPE.test(String(token ?? ""))) return { unknown: true };
        const link = this.links.get(token);
        if (!link) return { unknown: true };
        if (link.used) return { gone: "this upload link was already used" };
        if (link.expiresAt <= this.now()) {
            this.links.delete(token);
            return { gone: "this upload link has expired: ask for a new one" };
        }
        link.used = true;
        return { link };
    }

    /**
     * Give a link back when its upload failed before anything was stored, so the caller can try again.
     *
     * @param {string} token
     */
    releaseUploadLink(token) {
        const link = this.links.get(token);
        if (link) link.used = false;
    }

    /**
     * Whether an upload link promised this fileId and is still waiting for its file.
     *
     * @param {string} fileId
     * @returns {{expiresAt: number}|null}
     */
    pending(fileId) {
        for (const l of this.links.values()) {
            if (l.fileId === fileId && !l.used && l.expiresAt > this.now()) return { expiresAt: l.expiresAt };
        }
        return null;
    }

    /**
     * A private scratch folder for one call (a fetched or decoded file), removed by the returned function.
     *
     * @returns {{dir: string, remove: () => void}}
     */
    scratch() {
        const root = join(this.dir, ".tmp");
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const dir = mkdtempSync(join(root, "c-"));
        return {
            dir,
            remove: () => {
                try {
                    rmSync(dir, { recursive: true, force: true });
                } catch {
                    /* swept later */
                }
            },
        };
    }
}

const stores = new Map();

/**
 * The process's store for one account folder (upload links live in memory, so one per folder).
 *
 * @param {string} accountDir
 * @returns {UploadStore}
 */
export function getUploadStore(accountDir) {
    const dir = uploadsDirOf(accountDir);
    let s = stores.get(dir);
    if (!s) {
        s = new UploadStore(dir);
        stores.set(dir, s);
    }
    return s;
}

/**
 * Sweep the account's store now and every `intervalMs` (a daemon). The timer never keeps the process alive.
 *
 * @param {string} accountDir
 * @param {{intervalMs?: number, reap?: {isRecorded: (msgId: string) => boolean, recordWaitMs: () => number}|null}}
 *   [opts] - `reap`: also remove sent files whose messages are recorded
 * @returns {() => void} stop
 */
export function startUploadSweeper(accountDir, { intervalMs = 10 * 60_000, reap = null } = {}) {
    const store = getUploadStore(accountDir);
    const sweep = () => {
        try {
            store.sweep();
            if (reap) store.reapSent(reap.isRecorded, reap.recordWaitMs());
        } catch (e) {
            console.error(`[uploads] sweep failed: ${e?.message ?? e}`);
        }
    };
    sweep();
    const timer = setInterval(sweep, intervalMs);
    timer.unref?.();
    // Sent uploads are looked at more often: they go as soon as their message is recorded.
    const reaper = reap
        ? setInterval(() => {
              try {
                  store.reapSent(reap.isRecorded, reap.recordWaitMs());
              } catch (e) {
                  console.error(`[uploads] reap failed: ${e?.message ?? e}`);
              }
          }, 30_000)
        : null;
    reaper?.unref?.();
    return () => {
        clearInterval(timer);
        if (reaper) clearInterval(reaper);
    };
}
