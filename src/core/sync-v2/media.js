/**
 * Fetch the media that a transfer-sync only ever gave us references to.
 *
 * The sync stream carries no file bytes — just CDN URLs on `attach.href` /
 * `attach.thumb`. Zalo Web does the same thing: it indexes those references at
 * sync time and fetches lazily when you scroll to the message. This module is
 * the deliberate, batched version of that fetch.
 *
 * Expiry is the interesting part. A Zalo CDN URL is signed with a lifetime
 * tied to the message's age; once it lapses the server answers 200 with a JSON
 * error body (`{"err_code":"1","message":"Invalid signature"}`) rather than an
 * HTTP error, so "did this work" cannot be read off the status code alone.
 * When a URL has lapsed we retry once through renewlink (cmd 12094), which
 * works only while Zalo still holds the file. Past that the bytes exist solely
 * on the sending device or in zCloud.
 */
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAttachmentMessages, setMessageLocalPath, getDownloadedMediaBefore, clearMessageLocalPath } from "../db.js";
import { extractRenewedUrls, makeRenewLink } from "./renewlink.js";

/** Kinds that point at a byte stream worth saving. */
export const DOWNLOADABLE_KINDS = new Set(["photo", "video", "file", "gif", "voice", "audio", "doodle"]);

/**
 * Characters a filename must not contain on Windows or POSIX. Kept as a set
 * and checked per character rather than as a regex character class: the
 * control-character range has to be written as an escape, and a regex
 * literal containing one gets rewritten to raw bytes by the formatter,
 * which turns this source file into a binary blob.
 */
const UNSAFE_CHARS = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|"]);

/**
 * Make a string safe to use as a file or folder name.
 *
 * @param {string} name
 * @returns {string} never empty, never longer than 80 characters
 */
export function sanitize(name) {
    let out = "";
    for (const ch of String(name ?? "")) {
        out += UNSAFE_CHARS.has(ch) || ch.codePointAt(0) < 0x20 ? "_" : ch;
    }
    return out.trim().slice(0, 80) || "unknown";
}

const DEFAULT_EXT = { photo: "jpg", video: "mp4", gif: "gif", voice: "mp3", audio: "mp3", doodle: "jpg", file: "bin" };
const CONTENT_TYPE_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
};

/** Extension from the filename, then the URL, then content-type, then the kind. */
function guessExt(att, url, contentType) {
    if (att.ext) return String(att.ext).replace(/^\./, "").toLowerCase().slice(0, 8);
    if (att.fileName && /\.([A-Za-z0-9]{1,8})$/.test(att.fileName)) return RegExp.$1.toLowerCase();
    const inUrl = /\.([A-Za-z0-9]{2,5})(?:\?|$)/.exec(String(url || "").split("#")[0]);
    if (inUrl) return inUrl[1].toLowerCase();
    if (contentType) {
        const ct = contentType.split(";")[0].trim().toLowerCase();
        if (CONTENT_TYPE_EXT[ct]) return CONTENT_TYPE_EXT[ct];
    }
    return DEFAULT_EXT[att.kind] || "bin";
}

/**
 * Classify a non-file response: is the media gone, or are we just being told
 * to slow down?
 *
 * This distinction matters more than it looks. Treating throttling as expiry
 * tells someone their photos are permanently lost when they are sitting on the
 * CDN untouched — a real run reported 4,894 "expired" links, and a single
 * request minutes later pulled one of them down as a 25 MB video. Only a
 * signal that genuinely means "this object no longer exists" may be called
 * expired; everything else is retryable.
 *
 * @returns {"ok"|"expired"|"throttled"}
 */
function classifyResponse(status, contentType, head) {
    // Explicit rate limiting, and the 5xx family, are always retryable.
    if (status === 429 || status >= 500) return "throttled";
    // 404/410 are the only statuses that mean the object is gone. 403 is NOT:
    // Zalo returns it both for a lapsed signature and under load.
    if (status === 404 || status === 410) return "expired";
    if (status === 403) return "throttled";
    if (status !== 200) return "throttled";

    const ct = String(contentType || "").toLowerCase();
    if (!ct.includes("json") && !ct.includes("text/")) return "ok";
    const text = head.toString("utf8", 0, Math.min(head.length, 400));
    // The documented lapsed-signature body. Anything vaguer (a bare err_code,
    // a rate-limit notice) is treated as retryable rather than terminal.
    if (/invalid\s*signature|expired/i.test(text)) return "expired";
    if (/too\s*many|rate\s*limit|busy|try\s*again/i.test(text)) return "throttled";
    return "throttled";
}

/** Per-attachment destination path. */
function destPath(baseDir, row, att, ext, index) {
    const d = new Date(Number(row.timestamp) || 0);
    const stamp = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace(/[T:]/g, "-") : "unknown";
    const idPart = String(row.msgId || "noid").slice(-10);
    const name = att.fileName ? sanitize(att.fileName.replace(/\.[^.]*$/, "")) : att.kind;
    const suffix = index > 0 ? `_${index}` : "";
    return join(baseDir, `${stamp}_${idPart}${suffix}_${name}.${ext}`);
}

/** Read a row's attachments back out of raw_data. */
function attachmentsOf(row) {
    try {
        const raw = JSON.parse(row.raw_data || "{}");
        return Array.isArray(raw.attachments) ? raw.attachments : [];
    } catch {
        return [];
    }
}

/**
 * Default per-request deadline. Without one a stalled connection blocks its
 * worker forever: `fetch()` has no built-in timeout, so four hung requests
 * silently froze an entire download with the process still alive and healthy.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

/**
 * Consecutive throttled responses before the run stops entirely. Pushing on
 * past this point neither recovers files nor does the account any favours.
 */
export const THROTTLE_GIVE_UP = 25;

/**
 * Fetch a URL, returning the bytes or a reason it failed.
 *
 * @param {string} url
 * @param {number} timeoutMs - hard deadline covering headers AND body
 */
async function fetchBytes(url, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    let res;
    let buf;
    let ct;
    // One signal for the whole exchange: a server that sends headers promptly
    // and then stops writing the body is exactly the stall this guards against.
    const signal = AbortSignal.timeout(timeoutMs);
    try {
        res = await fetch(url, { signal, redirect: "follow" });
        // Reading the body must be guarded too, not just the request. A
        // connection dropped mid-body throws here ("terminated" from undici),
        // and with this outside the try it escaped the worker and aborted an
        // entire ten-thousand-file run over one flaky read.
        buf = Buffer.from(await res.arrayBuffer());
        ct = res.headers.get("content-type");
    } catch (e) {
        const why =
            e?.name === "TimeoutError" || e?.name === "AbortError"
                ? `timed out after ${timeoutMs}ms`
                : e?.message || String(e);
        return { ok: false, throttled: true, reason: `network: ${why}` };
    }
    const verdict = classifyResponse(res.status, ct, buf);
    if (verdict === "expired") return { ok: false, expired: true, reason: `gone (HTTP ${res.status})` };
    if (verdict === "throttled") return { ok: false, throttled: true, reason: `throttled (HTTP ${res.status})` };
    if (!buf.length) return { ok: false, throttled: true, reason: "empty body" };
    return { ok: true, buf, contentType: ct };
}

/**
 * Download the attachments recorded by a transfer sync.
 *
 * @param {object} opts
 * @param {object} [opts.api] - logged-in zca-js api; without it expired URLs cannot be renewed
 * @param {string} opts.accountDir - the account's data dir (media lands under `<dir>/media`)
 * @param {string} [opts.threadId] - restrict to one thread
 * @param {Set<string>|string[]} [opts.kinds] - restrict to these attachment kinds
 * @param {number} [opts.limit=500] - max messages to consider
 * @param {number} [opts.since] / @param {number} [opts.until] - epoch ms bounds
 * @param {number} [opts.concurrency=4]
 * @param {number} [opts.maxBytes] - skip attachments larger than this
 * @param {boolean} [opts.thumbs=false] - also save thumbnails
 * @param {boolean} [opts.dryRun=false] - report what would be fetched, write nothing
 * @param {Map<string,{name:string,type:string}>} [opts.threadNames] - threadId -> display name
 * @param {boolean} [opts.includePruned=false] - re-fetch media that was deliberately pruned
 * @param {number} [opts.backoffBaseMs=1000] - base for the exponential backoff on throttling;
 *   0 disables the pause (tests)
 * @param {number} [opts.timeoutMs=60000] - per-request deadline; without one a stalled
 *   connection blocks its worker indefinitely
 * @param {(req: object) => Promise<object>} [opts.renewLink] - pre-built renewal caller;
 *   defaults to one derived from `api`. Injectable so the renewal path can be
 *   exercised without round-tripping Zalo's request crypto.
 * @param {(p: object) => void} [opts.onProgress]
 * @returns {Promise<{considered:number, downloaded:number, skipped:number, failed:number, expired:number, renewed:number, bytes:number, failures:Array<object>}>}
 */
export async function downloadSyncedMedia(opts = {}) {
    const {
        api,
        accountDir,
        threadId,
        limit = 500,
        since,
        until,
        concurrency = 4,
        maxBytes,
        thumbs = false,
        dryRun = false,
        threadNames,
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        includePruned = false,
        backoffBaseMs = 1000,
        onProgress = () => {},
    } = opts;
    const kinds = opts.kinds ? new Set(opts.kinds) : DOWNLOADABLE_KINDS;

    const rows = getAttachmentMessages({ threadId, since, until, limit, onlyMissing: true, includePruned });
    const jobs = [];
    for (const row of rows) {
        let index = 0;
        for (const att of attachmentsOf(row)) {
            const url = att.url || (thumbs ? att.thumbUrl : null);
            if (!url || !kinds.has(att.kind)) continue;
            if (maxBytes && att.size && att.size > maxBytes) continue;
            jobs.push({ row, att, url, index: index++ });
            if (thumbs && att.thumbUrl && att.url) {
                jobs.push({ row, att: { ...att, kind: att.kind, isThumb: true }, url: att.thumbUrl, index: index++ });
            }
        }
    }

    const stats = {
        considered: jobs.length,
        downloaded: 0,
        skipped: 0,
        failed: 0,
        expired: 0,
        throttled: 0,
        renewed: 0,
        bytes: 0,
        abortedEarly: false,
        failures: [],
    };
    if (!jobs.length || dryRun) {
        if (dryRun) onProgress({ phase: "dry-run", detail: `${jobs.length} attachment(s) would be fetched` });
        return stats;
    }

    let renewLink = opts.renewLink || null;
    if (!renewLink && api) {
        try {
            renewLink = makeRenewLink(api);
        } catch (e) {
            onProgress({ phase: "warn", detail: `renewlink unavailable (${e.message}); expired URLs will be skipped` });
        }
    }

    const mediaRoot = resolve(accountDir, "media");
    let cursor = 0;
    // Consecutive throttled responses across all workers. Zalo starts dropping
    // connections under sustained load, and charging on through nine thousand
    // attachments marking each one failed is both useless and the surest way to
    // get an account flagged -- so the run backs off and then gives up.
    let throttleStreak = 0;
    let stopAll = false;
    const backoff = async () => {
        const wait = Math.min(30000, backoffBaseMs * 2 ** Math.min(throttleStreak, 5));
        onProgress({ phase: "throttled", detail: `backing off ${Math.round(wait / 1000)}s`, streak: throttleStreak });
        await new Promise((r) => setTimeout(r, wait));
    };

    const worker = async () => {
        for (;;) {
            if (stopAll) return;
            const job = jobs[cursor++];
            if (!job) return;
            try {
                await runJob(job);
            } catch (e) {
                // Belt and braces: whatever goes wrong with one attachment, the
                // other nine thousand still get their chance.
                stats.failed++;
                if (stats.failures.length < 20) {
                    stats.failures.push({
                        msgId: job.row?.msgId,
                        kind: job.att?.kind,
                        reason: e?.message || String(e),
                    });
                }
            }
        }
    };

    const runJob = async (job) => {
        {
            const { row, att, url } = job;
            const folder = threadNames?.get(String(row.threadId))?.name || row.threadId;
            const dir = join(mediaRoot, sanitize(folder));

            let got = await fetchBytes(url, timeoutMs);

            // One renewal attempt: only helps while Zalo still holds the file.
            if (!got.ok && got.expired && renewLink) {
                stats.expired++;
                try {
                    const resp = await renewLink({
                        threadId: row.threadId,
                        threadType: threadNames?.get(String(row.threadId))?.type,
                        msgType: JSON.parse(row.raw_data || "{}").msgType,
                        msgInfo: { normalUrl: att.url, hdUrl: att.hdUrl, thumbUrl: att.thumbUrl },
                        clientId: JSON.parse(row.raw_data || "{}").cliMsgId,
                    });
                    const fresh = extractRenewedUrls(resp);
                    const next = fresh?.normalUrl || fresh?.hdUrl || fresh?.thumbUrl;
                    if (next) {
                        got = await fetchBytes(next, timeoutMs);
                        if (got.ok) stats.renewed++;
                    }
                } catch (e) {
                    got = { ok: false, reason: `renew failed: ${e.message}` };
                }
            } else if (!got.ok && got.expired) {
                stats.expired++;
            }

            if (!got.ok) {
                if (got.throttled) {
                    stats.throttled++;
                    throttleStreak++;
                    if (throttleStreak >= THROTTLE_GIVE_UP) {
                        stopAll = true;
                        stats.abortedEarly = true;
                        return;
                    }
                    await backoff();
                } else {
                    throttleStreak = 0;
                }
                stats.failed++;
                if (stats.failures.length < 20) {
                    stats.failures.push({ msgId: row.msgId, kind: att.kind, reason: got.reason });
                }
                onProgress({ phase: "fail", msgId: row.msgId, kind: att.kind, detail: got.reason });
                return;
            }

            const ext = guessExt(att, url, got.contentType);
            const path = destPath(dir, row, att, ext, job.index);
            try {
                fs.mkdirSync(dirname(path), { recursive: true });
                fs.writeFileSync(path, got.buf);
            } catch (e) {
                stats.failed++;
                onProgress({ phase: "fail", msgId: row.msgId, detail: `write: ${e.message}` });
                return;
            }
            // Only the primary attachment claims the row's localPath.
            if (!att.isThumb && job.index === 0) {
                try {
                    setMessageLocalPath(row.msgId, path);
                } catch {
                    /* a missing row is not worth failing the download over */
                }
            }
            throttleStreak = 0;
            stats.downloaded++;
            stats.bytes += got.buf.length;
            onProgress({
                phase: "saved",
                msgId: row.msgId,
                kind: att.kind,
                bytes: got.buf.length,
                done: stats.downloaded,
                total: jobs.length,
                path,
            });
        }
    };

    await Promise.all(Array.from({ length: Math.max(1, Math.min(16, concurrency)) }, worker));
    return stats;
}

/**
 * Delete downloaded media for messages older than a cutoff.
 *
 * Only files this tool recorded are touched: the candidate list comes from rows
 * that actually carry a `localPath`, so nothing outside the media directory is
 * ever considered. Clearing `localPath` afterwards puts the row back in the
 * download queue, so pruning is a space decision, not a permanent one -- the
 * file can be refetched later if its link is still alive.
 *
 * The message row itself is never deleted. Losing the text of a conversation to
 * reclaim disk space is not a trade anyone asked for.
 *
 * @param {object} opts
 * @param {number} opts.olderThanDays - delete media attached to messages older than this
 * @param {boolean} [opts.all=false] - delete every downloaded file regardless of age
 * @param {string} [opts.threadId] - restrict to one thread
 * @param {boolean} [opts.dryRun=false] - report what would go, delete nothing
 * @param {number} [opts.now=Date.now()] - injectable for tests
 * @param {(p: object) => void} [opts.onProgress]
 * @returns {Promise<{considered:number, deleted:number, missing:number, failed:number, bytes:number, cutoff:number, failures:Array<object>}>}
 */
export async function pruneDownloadedMedia(opts = {}) {
    const { olderThanDays, threadId, all = false, dryRun = false, now = Date.now(), onProgress = () => {} } = opts;
    const days = Number(olderThanDays);
    const stats = { considered: 0, deleted: 0, missing: 0, failed: 0, bytes: 0, cutoff: 0, all: false, failures: [] };
    // Two distinct modes. `all` is explicit rather than "a cutoff of now",
    // so no arithmetic slip on a date can quietly become delete-everything.
    if (!all && (!Number.isFinite(days) || days <= 0)) return stats;

    const cutoff = all ? null : now - days * 86400000;
    stats.all = Boolean(all);
    stats.cutoff = cutoff === null ? 0 : cutoff;
    const rows = getDownloadedMediaBefore(cutoff, threadId || null);
    stats.considered = rows.length;

    for (const row of rows) {
        let size = 0;
        try {
            size = fs.statSync(row.localPath).size;
        } catch {
            // Already gone from disk -- still worth clearing the stale pointer.
            stats.missing++;
            if (!dryRun) {
                try {
                    clearMessageLocalPath(row.msgId, now);
                } catch {
                    /* the row may have been removed since */
                }
            }
            continue;
        }
        if (dryRun) {
            stats.bytes += size;
            continue;
        }
        try {
            fs.rmSync(row.localPath, { force: true });
            clearMessageLocalPath(row.msgId, now);
            stats.deleted++;
            stats.bytes += size;
            onProgress({ phase: "pruned", msgId: row.msgId, path: row.localPath, bytes: size });
        } catch (e) {
            stats.failed++;
            if (stats.failures.length < 20) stats.failures.push({ msgId: row.msgId, reason: e.message });
        }
    }
    return stats;
}
