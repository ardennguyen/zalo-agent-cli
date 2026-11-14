/**
 * Fetch the media that a transfer-sync only ever gave us references to.
 *
 * The sync stream carries no file bytes — just CDN URLs on `attach.href` /
 * `attach.thumb`. A chat app indexes those references at sync time and
 * fetches lazily when you scroll to the message. This module is the
 * deliberate, batched version of that fetch.
 *
 * Expiry is the interesting part. A Zalo CDN URL is signed with a lifetime
 * tied to the message's age; once it lapses the server answers 200 with a JSON
 * error body (`{"err_code":"1","message":"Invalid signature"}`) rather than an
 * HTTP error, so "did this work" cannot be read off the status code alone.
 * A lapsed link is not renewed here, because Zalo never renews one to download
 * it: a gone file is remembered as gone, and renewlink (cmd 12094) only clones
 * a file into a forward's destination. Called per download it answered
 * "invalid parameters" every time, and with no deadline of its own one hung
 * call could hold a worker forever. Past expiry the bytes exist solely on the
 * sending device or in zCloud.
 *
 * Every wait is bounded. Each request runs against its own deadline that
 * fires even if the fetch underneath ignores its abort signal, the backoff
 * sleep wakes on an abort, and a caller's signal stops the run between files
 * and cuts the in-flight requests short, leaving what was not saved pending
 * for the next run.
 *
 * That body sniff has to stay narrow, though. Reading a text response as
 * guilty until proven innocent silently discarded every `.csv`/`.txt`/`.md`
 * attachment this tool ever fetched, and reported the loss as rate limiting —
 * so the rule is: a 200 is the file unless the body says otherwise about
 * itself, and what the summary tells the user is what the response actually
 * showed, never what the catch-all branch happened to be called.
 */
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
    getAttachmentMessages,
    setMessageLocalPath,
    getDownloadedMediaBefore,
    clearMessageLocalPath,
    getThreadNames,
    markMediaGone,
} from "../db.js";
import { lookupCloudBackup, messageZKey } from "./zcloud.js";
import { pastCdnWindow } from "./media-age.js";
import { createDownloadFetch } from "../../zalo/download-fetch.js";
import { fetchCloudBlob } from "../../zalo/zcloud.js";
import { ALGO_BLOCK, CloudKeyError, decryptCloudBlob } from "../../zalo/zcloud-e2ee.js";
import { readSealedJson, writeSealedJson } from "../keystore/index.js";
import { scopeOfDir } from "../keystore/keyring.js";
import { mediaPlainSize, writeSealedMedia } from "../keystore/media-seal.js";
import { openDeadLinks } from "./dead-links.js";

/** Kinds that point at a byte stream worth saving. */
export const DOWNLOADABLE_KINDS = new Set(["photo", "video", "file", "gif", "voice", "audio", "doodle"]);

/** Kinds whose thumbnail is still the picture, when no full-size link exists. */
const THUMB_IS_THE_PICTURE = new Set(["photo", "doodle", "gif"]);

/**
 * Characters a filename must not contain on Windows or POSIX. Kept as a set
 * and checked per character rather than as a regex character class: the
 * control-character range has to be written as an escape, and a regex
 * literal containing one gets rewritten to raw bytes by the formatter,
 * which turns this source file into a binary blob.
 */
// The first nine are the characters Windows forbids in a filename. The rest
// are the ones cmd.exe INTERPRETS: a downloaded file gets handed to
// openFile(), whose Windows branch goes through a shell, so a Zalo-supplied
// name like `holiday&calc.exe.jpg` used to survive sanitising and then split
// at the & inside `start "" <path>`. None of them is meaningful in a
// filename, so replacing them costs nothing.
const UNSAFE_CHARS = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|", "&", "^", "%", "`", "!", "$"]);

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

/**
 * The JPEG twin of a JPEG XL photo URL, the form Zalo serves to a client that cannot decode JPEG XL:
 * `…/jxl/…/x.jxl?jxlstatus=1` becomes `…/jpg/…/x.jpg`. A JPEG XL file opens in almost no viewer and no model, so the
 * CLI always takes the JPEG. An end-to-end encrypted session's URL keeps its form; any other URL is returned unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
export function jpegUrl(url) {
    if (typeof url !== "string" || !/^https?:\/\/.*\/jxl\/.*\.jxl/.test(url)) return url;
    let u;
    try {
        u = new URL(url);
    } catch {
        return url;
    }
    u.searchParams.delete("jxlstatus");
    u.search = decodeURIComponent(u.search);
    if (url.includes("?e2esession")) return u.href;
    return u.href.replace("/jxl/", "/jpg/").replace(".jxl", ".jpg");
}

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
 * Every reason a download can end in, the verdict it belongs to, and how to
 * name it to a human.
 *
 * The verdicts are deliberately four, not three. `throttled` used to be the
 * catch-all, so a summary built on it claimed "almost certainly rate limiting"
 * about a 403 the code had explicitly documented as ambiguous — advice that
 * sends someone off to wait and retry forever when the signature has in fact
 * lapsed. `unknown` is that catch-all, named honestly: retried exactly like
 * `throttled`, reported as what it is.
 *
 * - `expired`   the object is gone; only 404/410 or a lapsed-signature body
 * - `throttled` the server said, in so many words, to slow down
 * - `unknown`   the response did not say, or there was no response
 * - `failed`    something on our side went wrong after the fetch
 */
export const DOWNLOAD_REASONS = {
    "not-found": { verdict: "expired", label: "HTTP 404/410" },
    "lapsed-signature": { verdict: "expired", label: "a lapsed-signature body" },
    "rate-limited": { verdict: "throttled", label: "HTTP 429" },
    "server-error": { verdict: "throttled", label: "HTTP 5xx" },
    "server-busy": { verdict: "throttled", label: "a server-busy body" },
    forbidden: { verdict: "unknown", label: "HTTP 403" },
    "unexpected-status": { verdict: "unknown", label: "an unexpected HTTP status" },
    "unreadable-body": { verdict: "unknown", label: "an unrecognized body" },
    "empty-body": { verdict: "unknown", label: "an empty body" },
    network: { verdict: "unknown", label: "no response at all" },
    timeout: { verdict: "unknown", label: "no answer before the deadline" },
    dead: { verdict: "dead", label: "known dead (404/410 on an earlier run)" },
    // Sorted by the clock, with no request: past the CDN's window (./media-age.js).
    "old-in-zcloud": { verdict: "old", label: "past the CDN's window, kept in zCloud" },
    "old-gone": { verdict: "old", label: "past the CDN's window, not in zCloud" },
    // The zCloud source (opt-in, with the account's cloud key).
    "cloud-no-key": { verdict: "cloud", label: "in zCloud, but no cloud key was given" },
    "cloud-not-found": { verdict: "cloud", label: "zCloud has no download for it" },
    "cloud-decrypt": { verdict: "cloud", label: "did not open with the cloud key" },
    "cloud-unsupported": { verdict: "cloud", label: "a block-encrypted zCloud item, not supported" },
};

/**
 * Render a run's reason tally for one verdict, commonest first.
 *
 * This is what lets a summary say what actually happened — "HTTP 403 ×3" —
 * instead of inferring a cause the classifier never established.
 *
 * @param {Record<string, number>} [reasons] - `stats.reasons` from a download run
 * @param {"expired"|"throttled"|"unknown"|"failed"|"dead"|"old"|"cloud"} verdict
 * @returns {string} e.g. `HTTP 403 ×3, no response at all ×2`; empty when nothing matched
 */
export function describeDownloadReasons(reasons, verdict) {
    return Object.entries(reasons || {})
        .filter(([code]) => DOWNLOAD_REASONS[code]?.verdict === verdict)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([code, n]) => `${DOWNLOAD_REASONS[code].label} ×${n}`)
        .join(", ");
}

/**
 * Fields that mark a JSON body as an error envelope rather than a payload.
 * Compared lower-cased, so `errCode` and `err_code` are one entry.
 */
const ERROR_KEYS = new Set(["err_code", "errcode", "error_code", "errorcode", "err", "error", "err_msg", "errmsg"]);

/** Phrases a CDN or gateway error page says about itself. */
const ERROR_PHRASES = /invalid\s*signature|expired|too\s*many|rate\s*limit|busy|try\s*again/i;

/**
 * Longest body still credible as a bare status page. Past this it is a
 * document, and a document that merely contains the word "busy" is not an
 * error — which is the whole reason the phrase test is bounded.
 */
const MAX_ERROR_PAGE_BYTES = 1024;

/**
 * Does a 200 body identify *itself* as an error, or is it simply the file?
 *
 * The default has to be "it is the file". Inverting it is what made this
 * module throw away every text attachment it ever downloaded: the sniff below
 * exists to catch Zalo's 200-plus-JSON expiry envelope, but it was reached for
 * any `text/…` response, and an ordinary CSV matches none of the error
 * patterns — so it fell through to the catch-all and was discarded as
 * throttling. Measured 2026-09-29: two healthy 149-byte `data.csv`
 * attachments, stuck across four runs at three different concurrencies,
 * both served 200 with `content-type: text/csv` and the full bytes present.
 *
 * @param {string} text - the decoded head of the body
 * @param {number} byteLength - the body's full length
 * @param {string} disposition - the response's content-disposition, lower-cased
 * @returns {boolean}
 */
function looksLikeErrorBody(text, byteLength, disposition) {
    // The server naming a file it is handing over settles it outright.
    if (disposition.includes("attachment") || disposition.includes("filename")) return false;

    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return Object.keys(parsed).some((k) => ERROR_KEYS.has(k.toLowerCase()));
            }
        } catch {
            // Truncated at 400 bytes, or never JSON to begin with. Either way
            // it is not an envelope we can read, so fall through.
        }
    }
    return byteLength <= MAX_ERROR_PAGE_BYTES && ERROR_PHRASES.test(trimmed);
}

/**
 * Classify a non-file response: is the media gone, are we being told to slow
 * down, or does the response simply not say?
 *
 * This distinction matters more than it looks. Treating throttling as expiry
 * tells someone their photos are permanently lost when they are sitting on the
 * CDN untouched — a real run reported 4,894 "expired" links, and a single
 * request minutes later pulled one of them down as a 25 MB video. Only a
 * signal that genuinely means "this object no longer exists" may be called
 * expired; everything else is retryable.
 *
 * The converse is just as costly, which is why `unknown` exists. Zalo answers
 * 403 both for a lapsed signature and under load, so calling it throttling
 * sends someone to wait and retry when nothing but a fresh mobile sync can
 * renew that link. Retrying is still the right first move — hence the same
 * retry policy — but the summary must not claim to know which it was.
 *
 * @param {number} status - HTTP status as received
 * @param {string|null} contentType
 * @param {Buffer} head - the body, of which only the first 400 bytes are read
 * @param {string|null} [contentDisposition] - the file the server says it is handing over
 * @returns {{verdict: "ok"|"expired"|"throttled"|"unknown", code: string|null}}
 *   `code` keys into {@link DOWNLOAD_REASONS}; it is null only for `ok`
 */
function classifyResponse(status, contentType, head, contentDisposition) {
    // Explicit rate limiting, and the 5xx family, are the two the server
    // genuinely told us about.
    if (status === 429) return { verdict: "throttled", code: "rate-limited" };
    if (status >= 500) return { verdict: "throttled", code: "server-error" };
    // 404/410 are the only statuses that mean the object is gone. 403 is NOT:
    // Zalo returns it both for a lapsed signature and under load, and nothing
    // in the response distinguishes them — so it is neither, it is unknown.
    if (status === 404 || status === 410) return { verdict: "expired", code: "not-found" };
    if (status === 403) return { verdict: "unknown", code: "forbidden" };
    if (status !== 200) return { verdict: "unknown", code: "unexpected-status" };

    const ct = String(contentType || "").toLowerCase();
    // A binary content-type is never one of Zalo's error envelopes, so it does
    // not even need reading. Everything else is *read*, not condemned.
    if (!ct.includes("json") && !ct.includes("text/")) return { verdict: "ok", code: null };
    const text = head.toString("utf8", 0, Math.min(head.length, 400));
    const disposition = String(contentDisposition || "").toLowerCase();
    if (!looksLikeErrorBody(text, head.length, disposition)) return { verdict: "ok", code: null };

    // The documented lapsed-signature body. Anything vaguer (a bare err_code)
    // is retryable rather than terminal — and unexplained rather than throttled.
    if (/invalid\s*signature|expired/i.test(text)) return { verdict: "expired", code: "lapsed-signature" };
    if (/too\s*many|rate\s*limit|busy|try\s*again/i.test(text)) return { verdict: "throttled", code: "server-busy" };
    return { verdict: "unknown", code: "unreadable-body" };
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
 * Consecutive retryable responses before the run stops entirely. Pushing on
 * past this point neither recovers files nor does the account any favours.
 *
 * Both `throttled` and `unknown` count toward it: retrying is the right first
 * move for either, and splitting the counters changed the reporting, not the
 * policy.
 */
export const THROTTLE_GIVE_UP = 25;

/**
 * Fetch a URL, returning the bytes or why it failed.
 *
 * `retryable` drives the backoff and the give-up streak; `verdict` and `code`
 * exist so the caller can report what was observed rather than guess at it.
 *
 * The deadline is enforced twice. The request gets an abort signal, which
 * cuts DNS, connect, headers and the body short; and the wait itself races a
 * timer, so a fetch that ignores its signal (a proxy layer, a stand-in) still
 * returns on time instead of holding its worker forever.
 *
 * @param {string} url
 * @param {number} timeoutMs - hard deadline covering the whole exchange: DNS, connect, headers AND body
 * @param {typeof fetch} [fetchImpl]
 * @param {AbortSignal} [runSignal] - the run's stop signal: aborting it ends the exchange at once
 * @returns {Promise<{ok: boolean, buf?: Buffer, contentType?: string|null,
 *   retryable?: boolean, expired?: boolean, aborted?: boolean, verdict?: string, code?: string,
 *   status?: number, reason?: string}>}
 */
async function fetchBytes(url, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, fetchImpl = (...a) => fetch(...a), runSignal) {
    if (runSignal?.aborted) return { ok: false, aborted: true, reason: "stopped" };
    let res;
    let buf;
    let ct;
    let disposition;
    // One controller for the whole exchange: a server that sends headers
    // promptly and then stops writing the body is a stall like any other.
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { name: "TimeoutError" }));
    }, timeoutMs);
    const onStop = () => ctl.abort(Object.assign(new Error("stopped"), { name: "AbortError" }));
    runSignal?.addEventListener("abort", onStop, { once: true });
    const deadline = new Promise((_, reject) => {
        ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true });
    });
    deadline.catch(() => {});
    try {
        const exchange = (async () => {
            res = await fetchImpl(url, { signal: ctl.signal, redirect: "follow" });
            // Reading the body must be guarded too, not just the request. A
            // connection dropped mid-body throws here ("terminated" from undici),
            // and with this outside the try it escaped the worker and aborted an
            // entire ten-thousand-file run over one flaky read.
            const body = Buffer.from(await res.arrayBuffer());
            ct = res.headers.get("content-type");
            disposition = res.headers.get("content-disposition");
            return body;
        })();
        // An exchange abandoned at the deadline may still reject later; that is not an error of the run.
        exchange.catch(() => {});
        buf = await Promise.race([exchange, deadline]);
    } catch (e) {
        if (runSignal?.aborted && !timedOut) return { ok: false, aborted: true, reason: "stopped" };
        const timeout = timedOut || e?.name === "TimeoutError";
        const why = timeout ? `timed out after ${timeoutMs}ms` : e?.message || String(e);
        // No response at all: nothing was observed, so nothing is claimed.
        return {
            ok: false,
            retryable: true,
            verdict: "unknown",
            code: timeout ? "timeout" : "network",
            status: 0,
            reason: `network: ${why}`,
        };
    } finally {
        clearTimeout(timer);
        runSignal?.removeEventListener("abort", onStop);
    }
    const { verdict, code } = classifyResponse(res.status, ct, buf, disposition);
    const status = res.status;
    if (verdict === "expired") {
        return { ok: false, retryable: false, expired: true, verdict, code, status, reason: `gone (HTTP ${status})` };
    }
    if (verdict !== "ok") {
        return { ok: false, retryable: true, verdict, code, status, reason: `${verdict}: ${code} (HTTP ${status})` };
    }
    // A 200 of the right shape carrying no bytes tells us nothing either.
    if (!buf.length) {
        return {
            ok: false,
            retryable: true,
            verdict: "unknown",
            code: "empty-body",
            status,
            reason: `unknown: empty-body (HTTP ${status})`,
        };
    }
    return { ok: true, buf, contentType: ct };
}

/**
 * Wait `ms`, or less when `signal` aborts first. Never rejects.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function pause(ms, signal) {
    if (!(ms > 0) || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(t);
            signal?.removeEventListener("abort", done);
            resolve();
        };
        const t = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
    });
}

/**
 * Run `task(signal)` under a deadline and the run's stop signal. The wait races the deadline, so a task that ignores
 * its signal still returns on time.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} task
 * @param {number} timeoutMs
 * @param {AbortSignal} [runSignal]
 * @returns {Promise<{value?: T, error?: any, timedOut?: boolean, aborted?: boolean}>}
 */
async function bounded(task, timeoutMs, runSignal) {
    if (runSignal?.aborted) return { aborted: true };
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { name: "TimeoutError" }));
    }, timeoutMs);
    const onStop = () => ctl.abort(Object.assign(new Error("stopped"), { name: "AbortError" }));
    runSignal?.addEventListener("abort", onStop, { once: true });
    const deadline = new Promise((_, reject) => {
        ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true });
    });
    deadline.catch(() => {});
    try {
        const work = Promise.resolve().then(() => task(ctl.signal));
        work.catch(() => {});
        return { value: await Promise.race([work, deadline]) };
    } catch (e) {
        if (runSignal?.aborted && !timedOut) return { aborted: true };
        if (timedOut) return { timedOut: true };
        return { error: e };
    } finally {
        clearTimeout(timer);
        runSignal?.removeEventListener("abort", onStop);
    }
}

/**
 * Fetch one file from zCloud and open it: the item's download URL, its blob, and the blob decrypted with the account's
 * cloud key (`algoversion` 1). The key is used here and nowhere else; it is never written or logged.
 *
 * @param {object} args
 * @param {object} args.item - the local zCloud index row (`cloud_items`)
 * @param {boolean} args.cloudConversation - My Cloud: the item is not encrypted
 * @param {{privateKey?: import("node:crypto").KeyObject|null, fetchBlob: Function}} args.cloud
 * @param {number} args.timeoutMs
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ok: true, buf: Buffer, contentType: string|null} |
 *   {ok: false, aborted?: boolean, code: string, reason: string}>}
 */
async function fetchFromCloud({ item, cloudConversation, cloud, timeoutMs, signal }) {
    let raw = {};
    try {
        raw = JSON.parse(item?.raw_data || "{}");
    } catch {
        raw = {};
    }
    const fromRow = item?.encryptKey
        ? { encryptKey: item.encryptKey, algoVersion: item.algoVersion ?? undefined }
        : null;
    const encryptInfo = raw.encryptInfo ? { algoVersion: item?.algoVersion ?? undefined, ...raw.encryptInfo } : fromRow;
    const encrypted = !cloudConversation && Boolean(encryptInfo?.encryptKey);
    if (encrypted && String(encryptInfo.algoVersion ?? "") === ALGO_BLOCK) {
        return { ok: false, code: "cloud-unsupported", reason: "zCloud: block-encrypted item (algoversion 2)" };
    }
    if (encrypted && !cloud.privateKey) {
        return { ok: false, code: "cloud-no-key", reason: "zCloud: encrypted, and no cloud key was given" };
    }
    const r = await bounded(
        (sig) => cloud.fetchBlob({ noiseId: item.noiseId, encryptInfo, cloudConversation }, { signal: sig }),
        timeoutMs,
        signal,
    );
    if (r.aborted) return { ok: false, aborted: true, code: "stopped", reason: "stopped" };
    if (r.timedOut) return { ok: false, code: "timeout", reason: `zCloud: timed out after ${timeoutMs}ms` };
    if (r.error) {
        const e = r.error;
        const notFound = e?.code === 404 || /NOT_FOUND_DOWNLOAD_URL/.test(String(e?.message));
        return {
            ok: false,
            code: notFound ? "cloud-not-found" : "network",
            reason: `zCloud: ${e?.message || String(e)}`,
        };
    }
    const blob = r.value;
    let buf = Buffer.from(blob?.bytes ?? []);
    if (blob?.encrypted) {
        if (String(blob.algoVersion ?? "") === ALGO_BLOCK) {
            return { ok: false, code: "cloud-unsupported", reason: "zCloud: block-encrypted item (algoversion 2)" };
        }
        try {
            buf = decryptCloudBlob(buf, blob.wrappedKey, blob.algoVersion, cloud.privateKey);
        } catch (e) {
            return {
                ok: false,
                code: "cloud-decrypt",
                reason: `zCloud: ${e instanceof CloudKeyError ? e.message : "the item did not decrypt"}`,
            };
        }
    }
    if (!buf.length) return { ok: false, code: "cloud-not-found", reason: "zCloud: an empty blob" };
    return { ok: true, buf, contentType: blob?.contentType ?? null };
}

/** The sealed-file spec of the conversation index. */
const MEDIA_INDEX_SPEC = Object.freeze({ kind: "media-index", use: "data" });

/**
 * Write `<mediaRoot>/_conversations.json`: the id -> name map for the folders
 * beside it, sealed (kind `media-index`, the account's data key): names are
 * content. Best-effort by design -- a media run must never fail because an
 * index could not be written.
 *
 * @param {string} mediaRoot
 * @param {Map<string,{name:string,type:string}>} names
 * @param {{id: string, dir: string}} scope - the account
 */
function writeConversationIndex(mediaRoot, names, scope) {
    try {
        fs.mkdirSync(mediaRoot, { recursive: true });
        const file = join(mediaRoot, "_conversations.json");
        let existing = {};
        try {
            // A plaintext index (2.x) is sealed in place on the way.
            existing = readSealedJson(file, scope, MEDIA_INDEX_SPEC) || {};
        } catch {
            /* first run, or an unreadable index (another account's, in a shared root) we are about to replace */
        }
        // Merge rather than replace: a run scoped to one thread must not drop
        // the names of conversations it did not look at.
        for (const [id, meta] of names) {
            if (meta?.name) existing[String(id)] = { name: meta.name, type: meta.type || null };
        }
        writeSealedJson(file, scope, MEDIA_INDEX_SPEC, existing);
    } catch {
        /* an index is a convenience, never a reason to fail a download run */
    }
}

/**
 * Download the attachments recorded by a transfer sync.
 *
 * @param {object} opts
 * @param {object} [opts.api] - logged-in session; its context gives the downloads the account's proxy, User-Agent
 *   and Referer. Without one the downloads use the plain global fetch
 * @param {typeof fetch} [opts.fetchImpl] - the fetch the downloads use (tests); default: the account's own
 * @param {string} opts.accountDir - the account's data dir (media lands under `<dir>/media`)
 * @param {string} [opts.threadId] - restrict to one thread
 * @param {string[]} [opts.msgIds] - restrict to these messages: a caller after one message's media names it
 *   instead of hoping it is among the newest `limit` rows of its thread
 * @param {Set<string>|string[]} [opts.kinds] - restrict to these attachment kinds
 * @param {number} [opts.limit=-1] - opt-in bound on the messages considered; -1 (default): every one still missing its file
 * @param {number} [opts.since] / @param {number} [opts.until] - epoch ms bounds
 * @param {number} [opts.concurrency=2] - parallel downloads. Two, not more: the CDN answers a burst with 403 and 429
 *   long before it runs short of bandwidth
 * @param {number} [opts.maxFiles] - download at most this many files in this run; the rest are counted in
 *   `deferred` and stay pending for the next run. Unset: all of them
 * @param {number} [opts.maxBytes] - skip attachments larger than this
 * @param {boolean} [opts.thumbs=false] - also save thumbnails
 * @param {boolean} [opts.dryRun=false] - report what would be fetched, write nothing
 * @param {Map<string,{name:string,type:string}>} [opts.threadNames] - threadId -> display name;
 *   omit it to read the local cache, which is what keeps every caller's folders identical
 * @param {boolean} [opts.includePruned=false] - re-fetch media that was deliberately pruned
 * @param {string} [opts.mediaRoot] - override the media root (defaults to <accountDir>/media)
 * @param {number} [opts.backoffBaseMs=1000] - base for the exponential backoff on throttling;
 *   0 disables the pause (tests)
 * @param {number} [opts.timeoutMs=60000] - per-request deadline over the whole exchange; without one a stalled
 *   connection blocks its worker indefinitely
 * @param {boolean} [opts.allAges=false] - ask the CDN for files past its window too. By default a file whose message
 *   is older than the window (./media-age.js: 14 days, 7 for a file over 100 MB; My Cloud exempt) gets no request: it
 *   is counted `oldInCloud` when the local zCloud index lists it, else `oldGone` (and its row is marked gone, so the
 *   automatic queue skips it from then on)
 * @param {{privateKey?: import("node:crypto").KeyObject|null, fetchBlob?: Function}|null} [opts.cloud] - the zCloud
 *   source, opt-in: a file past the window that the index lists is fetched from zCloud and decrypted with
 *   `privateKey`; a fresh file whose CDN download failed is tried there too. `fetchBlob(item, {signal})` is the
 *   blob fetch (tests); default: the account's own. Rows already marked gone are looked at again
 * @param {string} [opts.ownId] - the account (its chat with itself is My Cloud); default: the account folder's id
 * @param {number} [opts.now] - the clock (tests)
 * @param {boolean} [opts.retryDead=false] - ask again for links remembered as dead (404/410 on an earlier run);
 *   by default they are skipped without a request and counted in `dead`
 * @param {object} [opts.deadLinks] - the dead-link list to use (tests); default: the account's own
 *   (`<accountDir>/media/_dead-links.json`, ./dead-links.js)
 * @param {AbortSignal} [opts.signal] - stops the run: no new file is started, the requests in flight are cut short,
 *   and everything not saved stays pending for the next run (`interrupted` is then true)
 * @param {(msgId: string, zKey?: string|null) => {found: boolean}} [opts.cloudLookup] - whether the local zCloud index lists a message's
 *   backup (defaults to {@link lookupCloudBackup}); a file that is gone from the CDN and listed there is counted in
 *   `cloudBacked`: it exists, but the copy is end-to-end encrypted under the account's cloud key, which this client never holds
 * @param {(p: object) => void} [opts.onProgress] - `saved` per file written, `fail` per failure, `throttled` per
 *   backoff, and `attempted` once per file finished either way (`{attempted, total, downloaded, failed, dead, bytes}`), so a
 *   run whose files all fail still shows it is moving
 * @returns {Promise<{considered:number, attempted:number, downloaded:number, skipped:number, failed:number, dead:number,
 *   expired:number, cloudBacked:number, throttled:number, unknown:number, renewed:number, bytes:number,
 *   abortedEarly:boolean, interrupted:boolean, deferred:number, reasons:Record<string,number>, failures:Array<object>}>}
 *   `renewed` is always 0 (no link is renewed; kept so a reader of the result keeps its shape).
 *   `throttled` counts only responses that said to slow down; `unknown` counts the retryable
 *   failures that explained nothing. `reasons` tallies the observed codes — pass it to
 *   {@link describeDownloadReasons} rather than inferring a cause from a bucket.
 */
export async function downloadSyncedMedia(opts = {}) {
    const {
        api,
        accountDir,
        threadId,
        msgIds,
        limit = -1,
        since,
        until,
        concurrency = 2,
        maxFiles,
        maxBytes,
        thumbs = false,
        dryRun = false,
        threadNames,
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        includePruned = false,
        mediaRoot: mediaRootOpt,
        backoffBaseMs = 1000,
        signal,
        retryDead = false,
        allAges = false,
        cloud = null,
        onProgress = () => {},
    } = opts;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const kinds = opts.kinds ? new Set(opts.kinds) : DOWNLOADABLE_KINDS;

    // One definition of a conversation's folder. A caller holding a fresher map
    // passes it; everyone else gets the cache's, so the listener, `msg history`
    // and a sync file the same conversation in one place instead of three
    // (sender name / thread id / real name).
    const names = threadNames || getThreadNames();

    const rows = getAttachmentMessages({
        threadId,
        msgIds,
        since,
        until,
        limit,
        onlyMissing: true,
        includePruned,
        // A row sorted as gone is looked at again only by a run that can say something new about it.
        includeGone: allAges || Boolean(cloud),
    });
    const jobs = [];
    for (const row of rows) {
        let index = 0;
        for (const att of attachmentsOf(row)) {
            // The full file, else the HD one, else (for a picture with nothing better) the thumbnail: a row counts as
            // having an attachment when any of these is there, so taking only `url` left such rows pending forever.
            const url = jpegUrl(
                att.url || att.hdUrl || (thumbs || THUMB_IS_THE_PICTURE.has(att.kind) ? att.thumbUrl : null),
            );
            if (!url || !kinds.has(att.kind)) continue;
            if (maxBytes && att.size && att.size > maxBytes) continue;
            jobs.push({ row, att, url, index: index++ });
            if (thumbs && att.thumbUrl && att.url) {
                jobs.push({ row, att: { ...att, kind: att.kind, isThumb: true }, url: att.thumbUrl, index: index++ });
            }
        }
    }

    // A cap on the run, not on what is pending: what it leaves out is still missing a localPath, so the next run
    // (or `sync-media`) picks it up. Counted so the caller can say how much is left.
    const deferred = Number.isFinite(maxFiles) && maxFiles > 0 && jobs.length > maxFiles ? jobs.length - maxFiles : 0;
    if (deferred > 0) jobs.length = maxFiles;

    const stats = {
        considered: jobs.length,
        // Finished either way: saved, failed or skipped. What a progress line counts.
        attempted: 0,
        deferred,
        downloaded: 0,
        skipped: 0,
        failed: 0,
        // Links remembered as dead (404/410 on an earlier run): skipped without a request, not counted as failed.
        dead: 0,
        // Past the CDN's window by the clock, sorted with no request: listed in the zCloud index, or not (gone).
        oldInCloud: 0,
        oldGone: 0,
        // Saved from zCloud (the opt-in source), and zCloud attempts that failed.
        fromCloud: 0,
        cloudFailed: 0,
        expired: 0,
        // Of the files that are gone, the ones the local zCloud index lists: the cloud holds a copy this client cannot open.
        cloudBacked: 0,
        // Only responses that said so: 429, 5xx, or a body asking us to wait.
        throttled: 0,
        // Everything retryable that explained nothing — 403 above all, which
        // Zalo returns for a lapsed signature and under load alike. Kept apart
        // from `throttled` so the summary can stop guessing which it was.
        unknown: 0,
        renewed: 0,
        bytes: 0,
        abortedEarly: false,
        // Stopped by the caller's signal; what was not saved is still pending.
        interrupted: false,
        // code -> count over the jobs that ultimately failed, for the summary.
        reasons: {},
        failures: [],
    };
    if (!jobs.length || dryRun) {
        if (dryRun) onProgress({ phase: "dry-run", detail: `${jobs.length} attachment(s) would be fetched` });
        return stats;
    }

    // Explicit mediaRootOpt or global ZALO_MEDIA_DIR (--media-dir) overrides the
    // per-account default (<accountDir>/media).
    // The account's own fetch: its proxy, its User-Agent and the Referer Zalo expects (plan item ZP-01).
    const download = opts.fetchImpl ?? createDownloadFetch(api);
    const isInCloudIndex = (row) => {
        try {
            return Boolean((opts.cloudLookup ?? lookupCloudBackup)(row.msgId, messageZKey(row))?.found);
        } catch {
            return false; // no local index to ask (no database open): not a verdict
        }
    };
    const configuredRoot = mediaRootOpt || process.env.ZALO_MEDIA_DIR;
    const mediaRoot = configuredRoot ? resolve(configuredRoot) : resolve(accountDir, "media");

    // Folders are ids, so without this the media tree is unreadable by a human.
    // Written before any download, so an interrupted run still leaves an index.
    // Every file is sealed for the account the folder names (keystore/media-seal.js).
    const scope = scopeOfDir(resolve(accountDir));
    writeConversationIndex(mediaRoot, names, scope);
    // Always the account's own media folder, never a shared override root: the list is the account's alone.
    const deadLinks = opts.deadLinks ?? openDeadLinks(resolve(accountDir, "media"), scope);
    const ownId = opts.ownId ?? scope.id;
    const cloudSource = cloud
        ? {
              privateKey: cloud.privateKey ?? null,
              fetchBlob:
                  cloud.fetchBlob ??
                  ((item, o = {}) => fetchCloudBlob(api, item, { fetch: download, signal: o.signal })),
          }
        : null;
    const cloudItemOf = (row) => {
        try {
            const hit = (opts.cloudLookup ?? lookupCloudBackup)(row.msgId, messageZKey(row));
            return hit?.found ? (hit.item ?? {}) : null;
        } catch {
            return null; // no local index to ask: not a verdict
        }
    };
    const tally = (code) => {
        stats.reasons[code] = (stats.reasons[code] || 0) + 1;
    };
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
        await pause(wait, signal);
    };

    const worker = async () => {
        for (;;) {
            if (stopAll || cursor >= jobs.length) return;
            if (signal?.aborted) {
                stats.interrupted = true;
                return;
            }
            const job = jobs[cursor++];
            if (!job) return;
            let finished = true;
            try {
                finished = (await runJob(job)) !== "stopped";
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
            if (!finished) {
                stats.interrupted = true;
                return;
            }
            stats.attempted++;
            onProgress({
                phase: "attempted",
                attempted: stats.attempted,
                total: jobs.length,
                downloaded: stats.downloaded,
                failed: stats.failed,
                dead: stats.dead,
                oldInCloud: stats.oldInCloud,
                oldGone: stats.oldGone,
                bytes: stats.bytes,
            });
        }
    };

    const runJob = async (job) => {
        {
            const { row, att, url } = job;
            // The thread id, never the conversation name. A name is remote data:
            // it can hold a path separator, a shell metacharacter, a reserved
            // Windows device name, a right-to-left override, or 200 characters
            // of emoji, and it CHANGES when someone renames the group -- which
            // orphans every file already filed under the old spelling. An id is
            // digits, stable for the life of the conversation, and needs no
            // sanitising. `_conversations.json` at the media root carries the
            // id -> name mapping a human needs to find anything.
            const dir = join(mediaRoot, String(row.threadId));

            const primary = !att.isThumb && job.index === 0;
            const myCloud = String(row.threadId) === String(ownId);
            const cloudFail = (r) => {
                stats.cloudFailed++;
                stats.failed++;
                tally(r.code);
                if (stats.failures.length < 20) {
                    stats.failures.push({
                        msgId: row.msgId,
                        kind: att.kind,
                        reason: r.reason,
                        code: r.code,
                        status: null,
                    });
                }
                onProgress({ phase: "fail", msgId: row.msgId, kind: att.kind, detail: r.reason });
            };

            let got;
            let source = "cdn";
            if (!allAges && pastCdnWindow(row, att, { now, ownId })) {
                // Past the CDN's window: no request to it, as Zalo sends none. Sorted locally.
                const item = cloudItemOf(row);
                if (!item) {
                    stats.oldGone++;
                    stats.skipped++;
                    tally("old-gone");
                    if (primary) {
                        try {
                            markMediaGone(row.msgId, now);
                        } catch {
                            /* a missing row is not worth failing the run over */
                        }
                    }
                    return;
                }
                if (!cloudSource) {
                    stats.oldInCloud++;
                    stats.skipped++;
                    tally("old-in-zcloud");
                    return;
                }
                got = await fetchFromCloud({ item, cloudConversation: myCloud, cloud: cloudSource, timeoutMs, signal });
                if (got.aborted) return "stopped";
                if (!got.ok) {
                    cloudFail(got);
                    return;
                }
                source = "cloud";
            } else {
                // Answered 404/410 on an earlier run: gone, so not asked again. Keyed by the link, so a new link a
                // later sync hands out for the same message is tried normally.
                if (!retryDead && deadLinks.has(url)) {
                    stats.dead++;
                    stats.skipped++;
                    tally("dead");
                    return;
                }
                got = await fetchBytes(url, timeoutMs, download, signal);
                // Stopped mid-request: not a failure, and the row stays pending.
                if (got.aborted) return "stopped";
                // Only a status that says the object no longer exists is remembered; a lapsed-signature body, a
                // timeout or a 5xx says nothing that lasts.
                if (got.code === "not-found") deadLinks.add(url);
                // The CDN failed a fresh file: zCloud next, when the run has the source and the index lists the file.
                if (!got.ok && cloudSource) {
                    const item = cloudItemOf(row);
                    if (item) {
                        const fromCloud = await fetchFromCloud({
                            item,
                            cloudConversation: myCloud,
                            cloud: cloudSource,
                            timeoutMs,
                            signal,
                        });
                        if (fromCloud.aborted) return "stopped";
                        if (fromCloud.ok) {
                            got = fromCloud;
                            source = "cloud";
                        } else {
                            stats.cloudFailed++;
                            tally(fromCloud.code);
                        }
                    }
                }
            }
            const wasGone = !got.ok && Boolean(got.expired);
            if (wasGone) stats.expired++;

            if (!got.ok) {
                if (wasGone && isInCloudIndex(row)) stats.cloudBacked++;
                // Tally what was actually observed, so the summary reports it
                // rather than inferring a cause from the bucket it landed in.
                if (got.code) stats.reasons[got.code] = (stats.reasons[got.code] || 0) + 1;
                // `retryable` covers exactly what used to set `throttled`, so
                // the backoff and give-up behave as before; only the counters
                // below tell a genuine 429/5xx apart from an unexplained 403.
                if (got.retryable) {
                    if (got.verdict === "throttled") stats.throttled++;
                    else stats.unknown++;
                    throttleStreak++;
                    if (throttleStreak >= THROTTLE_GIVE_UP) {
                        stopAll = true;
                        stats.abortedEarly = true;
                        stats.failed++;
                        return;
                    }
                    await backoff();
                } else {
                    throttleStreak = 0;
                }
                stats.failed++;
                if (stats.failures.length < 20) {
                    stats.failures.push({
                        msgId: row.msgId,
                        kind: att.kind,
                        reason: got.reason,
                        code: got.code || null,
                        status: got.status ?? null,
                    });
                }
                onProgress({ phase: "fail", msgId: row.msgId, kind: att.kind, detail: got.reason });
                return;
            }

            const ext = guessExt(att, url, got.contentType);
            const path = destPath(dir, row, att, ext, job.index);
            try {
                fs.mkdirSync(dirname(path), { recursive: true });
                // Sealed and atomic: never a plaintext byte on disk, never half a file. A key that cannot be had
                // fails the write (fail closed).
                writeSealedMedia(
                    path,
                    scope,
                    {
                        msgId: row.msgId,
                        att: job.index,
                        thumb: Boolean(att.isThumb),
                        mime: got.contentType ? String(got.contentType).split(";")[0].trim() : null,
                        ext,
                    },
                    got.buf,
                );
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
            if (source === "cloud") stats.fromCloud++;
            stats.bytes += got.buf.length;
            onProgress({
                phase: "saved",
                msgId: row.msgId,
                kind: att.kind,
                bytes: got.buf.length,
                done: stats.downloaded,
                total: jobs.length,
                source,
                path,
            });
        }
    };

    try {
        await Promise.all(Array.from({ length: Math.max(1, Math.min(16, concurrency)) }, worker));
    } finally {
        deadLinks.flush();
    }
    // A stop that landed after the last file finished interrupted nothing.
    if (stats.attempted >= jobs.length) stats.interrupted = false;
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
            fs.statSync(row.localPath);
            // The plaintext size, from the sealed header (no key needed).
            size = mediaPlainSize(row.localPath) ?? 0;
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
