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
import { getAttachmentMessages, setMessageLocalPath } from "../db.js";
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
 * A Zalo CDN URL that has lapsed answers 200 with a short JSON error body
 * instead of failing the request, so the body has to be inspected.
 */
function looksExpired(status, contentType, head) {
    if (status === 403 || status === 404 || status === 410) return true;
    if (status !== 200) return false;
    const ct = String(contentType || "").toLowerCase();
    if (!ct.includes("json") && !ct.includes("text/")) return false;
    const text = head.toString("utf8", 0, Math.min(head.length, 400));
    return /err_code|invalid signature|expired|not\s*found/i.test(text);
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

/** Fetch a URL, returning the bytes or a reason it failed. */
async function fetchBytes(url, signal) {
    let res;
    let buf;
    let ct;
    try {
        res = await fetch(url, { signal, redirect: "follow" });
        // Reading the body must be guarded too, not just the request. A
        // connection dropped mid-body throws here ("terminated" from undici),
        // and with this outside the try it escaped the worker and aborted an
        // entire ten-thousand-file run over one flaky read.
        buf = Buffer.from(await res.arrayBuffer());
        ct = res.headers.get("content-type");
    } catch (e) {
        return { ok: false, reason: `network: ${e.message || e}` };
    }
    if (looksExpired(res.status, ct, buf)) return { ok: false, expired: true, reason: "expired url" };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    if (!buf.length) return { ok: false, reason: "empty body" };
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
        onProgress = () => {},
    } = opts;
    const kinds = opts.kinds ? new Set(opts.kinds) : DOWNLOADABLE_KINDS;

    const rows = getAttachmentMessages({ threadId, since, until, limit, onlyMissing: true });
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
        renewed: 0,
        bytes: 0,
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
    const worker = async () => {
        for (;;) {
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

            let got = await fetchBytes(url);

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
                        got = await fetchBytes(next);
                        if (got.ok) stats.renewed++;
                    }
                } catch (e) {
                    got = { ok: false, reason: `renew failed: ${e.message}` };
                }
            } else if (!got.ok && got.expired) {
                stats.expired++;
            }

            if (!got.ok) {
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
