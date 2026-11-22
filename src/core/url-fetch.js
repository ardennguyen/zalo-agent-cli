/**
 * Download a file a caller names by URL (a `url` file item, `--url` on the CLI) into a folder of this server, with
 * the guards a server that fetches on someone else's behalf needs:
 *
 * - only http and https, on their usual ports or any other, never with credentials in the URL;
 * - no private, loopback, link-local, carrier-grade NAT, multicast, documentation or other reserved address, checked
 *   on every address the name resolves to, and the connection made to the address that was checked (a name that
 *   resolves differently a moment later cannot point the request elsewhere). `allowPrivate` lifts it (a LAN
 *   deployment that fetches from its own network);
 * - at most 5 redirects, each checked the same way;
 * - a size cap, checked against Content-Length first and counted while the body streams, and a time limit on the
 *   whole download;
 * - a web page (text/html) is refused unless the URL names an .html file: a login wall or an error page is not the
 *   file the caller meant.
 *
 * No proxy is used: the account's Zalo proxy is for Zalo, and a caller's URL is not Zalo.
 */

import { createWriteStream, rmSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { safeMediaName } from "./media-deliver.js";

/** Redirects followed at most. */
export const MAX_REDIRECTS = 5;

/** Addresses a URL may not reach: private, loopback, link-local, CGNAT, multicast, reserved, documentation. */
const BLOCKED = new net.BlockList();
for (const [net4, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
]) {
    BLOCKED.addSubnet(net4, prefix, "ipv4");
}
for (const [net6, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
]) {
    BLOCKED.addSubnet(net6, prefix, "ipv6");
}

/** An IPv4 address carried inside an IPv6 one (mapped, IPv4-compatible, NAT64, 6to4), or null. */
function embeddedIpv4(ip) {
    const g = expandIpv6(ip.toLowerCase());
    if (!g) return null;
    const v4 = (a, b) => [a >> 8, a & 255, b >> 8, b & 255].join(".");
    const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
    if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:a.b.c.d
    if (zero(0, 6)) return v4(g[6], g[7]); // ::a.b.c.d (and :: / ::1, which land in 0.0.0.0/8)
    if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]); // 64:ff9b::/96
    if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4
    return null;
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function expandIpv6(s) {
    if (!net.isIPv6(s)) return null;
    let text = s.split("%")[0];
    const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (v4) {
        const p = v4[1].split(".").map(Number);
        text = `${text.slice(0, -v4[1].length)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
    }
    const [head, tail] = text.split("::");
    const h = head ? head.split(":") : [];
    const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
    const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill("0");
    const all = [...h, ...fill, ...t];
    return all.length === 8 ? all.map((g) => parseInt(g || "0", 16)) : null;
}

/**
 * True for an address a fetched URL may reach: a public unicast address.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isPublicAddress(ip) {
    const s = String(ip ?? "")
        .trim()
        .replace(/^\[|\]$/g, "");
    const family = net.isIP(s);
    if (family === 4) return !BLOCKED.check(s, "ipv4");
    if (family === 6) {
        const v4 = embeddedIpv4(s);
        if (v4 && net.isIPv4(v4)) return !BLOCKED.check(v4, "ipv4");
        return !BLOCKED.check(s.split("%")[0], "ipv6");
    }
    return false;
}

/** A refusal of a URL item, with a code a test or a caller can tell apart. */
export class UrlFetchError extends Error {
    /**
     * @param {string} message
     * @param {string} code - BAD_URL, BLOCKED_ADDRESS, TOO_LARGE, TIMEOUT, HTTP_STATUS, WEB_PAGE, NETWORK
     */
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

/** The URL checked for its shape: http(s), a host, no credentials. */
function checkShape(raw) {
    let u;
    try {
        u = new URL(String(raw));
    } catch {
        throw new UrlFetchError(`"${String(raw).slice(0, 200)}" is not an absolute URL`, "BAD_URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
        throw new UrlFetchError(`only http and https URLs are fetched (got ${u.protocol})`, "BAD_URL");
    if (u.username || u.password) throw new UrlFetchError("a URL with a user name or password is refused", "BAD_URL");
    if (!u.hostname) throw new UrlFetchError("the URL has no host", "BAD_URL");
    return u;
}

/** A `lookup` for http(s).request that refuses a name resolving to any address that is not public. */
function guardedLookup(permitted, resolver) {
    return (hostname, options, callback) => {
        const opts = typeof options === "object" && options ? options : {};
        resolver(hostname, { all: true, family: opts.family || 0 }, (err, addresses) => {
            if (err) return callback(err);
            const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
            if (!list.length) return callback(new UrlFetchError(`${hostname} has no address`, "NETWORK"));
            const bad = list.find((a) => !permitted(a.address));
            if (bad) {
                return callback(
                    new UrlFetchError(
                        `${hostname} resolves to ${bad.address}, a private or reserved address: only public ` +
                            "addresses are fetched",
                        "BLOCKED_ADDRESS",
                    ),
                );
            }
            if (opts.all) return callback(null, list);
            return callback(null, list[0].address, list[0].family);
        });
    };
}

/** A file name from Content-Disposition, else the URL's last path segment. */
function nameOf(res, url, fallback) {
    const cd = String(res.headers["content-disposition"] ?? "");
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
    if (star) {
        try {
            return decodeURIComponent(star[1].trim());
        } catch {
            /* fall through */
        }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/.exec(cd);
    if (plain) return plain[1].trim();
    const seg = url.pathname.split("/").filter(Boolean).pop();
    if (seg) {
        try {
            return decodeURIComponent(seg);
        } catch {
            return seg;
        }
    }
    return fallback;
}

/** An extension for a type, when a name has none. */
const EXT_FOR = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "text/plain": "txt",
    "text/csv": "csv",
};

/**
 * A file name with an extension: its own, or one from the content type.
 *
 * @param {string} name
 * @param {string|null} mime
 * @returns {string}
 */
export function nameWithExtension(name, mime) {
    if (/\.[A-Za-z0-9]{1,8}$/.test(name)) return name;
    const ext = mime ? EXT_FOR[mime] : null;
    return ext ? `${name}.${ext}` : name;
}

/**
 * Download `url` into `dir` (which exists), under the guards above.
 *
 * @param {string} rawUrl
 * @param {object} opts
 * @param {string} opts.dir - the folder the file is written to
 * @param {number} opts.maxBytes
 * @param {number} opts.timeoutMs - for the whole download, redirects included
 * @param {boolean|((ip: string) => boolean)} [opts.allowPrivate] - private addresses too (a predicate: those it
 *   accepts)
 * @param {string|null} [opts.name] - the caller's name for it; else Content-Disposition or the URL's own
 * @param {Function} [opts.lookup] - dns.lookup's shape (tests)
 * @returns {Promise<{path: string, name: string, mimeType: string|null, size: number, url: string}>}
 * @throws {UrlFetchError}
 */
export async function fetchUrlToFile(
    rawUrl,
    { dir, maxBytes, timeoutMs, allowPrivate = false, name = null, lookup = dnsLookup },
) {
    const deadline = Date.now() + timeoutMs;
    // A public address always; a private one when allowed (true, or a test's predicate on the address).
    const permitted = (ip) =>
        isPublicAddress(ip) || (typeof allowPrivate === "function" ? allowPrivate(ip) === true : allowPrivate === true);
    let url = checkShape(rawUrl);
    for (let hop = 0; ; hop++) {
        const host = url.hostname.replace(/^\[|\]$/g, "");
        if (net.isIP(host) && !permitted(host)) {
            throw new UrlFetchError(
                `${host} is a private or reserved address: only public addresses are fetched`,
                "BLOCKED_ADDRESS",
            );
        }
        const res = await request(url, { deadline, permitted, lookup });
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (hop >= MAX_REDIRECTS) throw new UrlFetchError(`more than ${MAX_REDIRECTS} redirects`, "NETWORK");
            let next;
            try {
                next = new URL(res.headers.location, url);
            } catch {
                throw new UrlFetchError("a redirect to an invalid URL", "BAD_URL");
            }
            url = checkShape(next.href);
            continue;
        }
        if (status < 200 || status >= 300) {
            res.resume();
            throw new UrlFetchError(`the URL answered HTTP ${status}`, "HTTP_STATUS");
        }
        const mime =
            String(res.headers["content-type"] ?? "")
                .split(";")[0]
                .trim()
                .toLowerCase() || null;
        const fileName = safeMediaName(nameWithExtension(name || nameOf(res, url, "download"), mime), "download");
        if (mime === "text/html" && !/\.html?$/i.test(fileName)) {
            res.resume();
            throw new UrlFetchError(
                "the URL returned a web page (text/html), not a file: give the file's own download link",
                "WEB_PAGE",
            );
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
            res.resume();
            throw new UrlFetchError(
                `the file is ${declared} bytes, over the ${maxBytes}-byte limit for a URL`,
                "TOO_LARGE",
            );
        }
        const path = join(dir, fileName);
        const size = await streamTo(res, path, { maxBytes, deadline });
        return {
            path,
            name: fileName,
            mimeType: mime && mime !== "application/octet-stream" ? mime : null,
            size,
            url: url.href,
        };
    }
}

/** One request, resolved with the response (its body unread), under the deadline. */
function request(url, { deadline, permitted, lookup }) {
    return new Promise((resolve, reject) => {
        const left = deadline - Date.now();
        if (left <= 0) return reject(new UrlFetchError("the download took too long", "TIMEOUT"));
        const mod = url.protocol === "https:" ? https : http;
        const req = mod.request(
            url,
            {
                method: "GET",
                agent: false,
                lookup: guardedLookup(permitted, lookup),
                headers: { "user-agent": "zalo-agent-cli file fetch", accept: "*/*" },
            },
            (res) => {
                clearTimeout(timer);
                resolve(res);
            },
        );
        const timer = setTimeout(() => {
            req.destroy(new UrlFetchError("the download took too long", "TIMEOUT"));
        }, left);
        req.on("error", (e) => {
            clearTimeout(timer);
            reject(
                e instanceof UrlFetchError
                    ? e
                    : new UrlFetchError(`the URL could not be fetched: ${e.message}`, "NETWORK"),
            );
        });
        req.end();
    });
}

/** Write a response body to a file, at most `maxBytes`, before the deadline; returns the bytes written. */
function streamTo(res, path, { maxBytes, deadline }) {
    return new Promise((resolve, reject) => {
        const out = createWriteStream(path, { mode: 0o600 });
        let size = 0;
        let done = false;
        const fail = (e) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            res.destroy();
            out.destroy();
            try {
                rmSync(path, { force: true });
            } catch {
                /* the folder is removed with the call */
            }
            reject(e);
        };
        const timer = setTimeout(
            () => fail(new UrlFetchError("the download took too long", "TIMEOUT")),
            Math.max(1, deadline - Date.now()),
        );
        res.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxBytes)
                fail(new UrlFetchError(`the file is over the ${maxBytes}-byte limit for a URL`, "TOO_LARGE"));
        });
        res.on("error", (e) => fail(new UrlFetchError(`the download broke off: ${e.message}`, "NETWORK")));
        res.on("aborted", () => fail(new UrlFetchError("the download broke off", "NETWORK")));
        out.on("error", (e) => fail(e));
        out.on("finish", () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(size);
        });
        res.pipe(out);
    });
}
