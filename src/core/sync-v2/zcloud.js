/**
 * zCloud ("Cloud của tôi") and the per-conversation media store.
 *
 * This is the SECOND place Zalo keeps media, and it is reached by a completely
 * different route from transfer-sync-v2. The sync stream (cmd 590/601) carries
 * message rows with CDN references; none of it knows about the cloud. The
 * cloud has its own boot event and its own REST surface, authenticated
 * differently from every other Zalo endpoint:
 *
 *   cmd 621 `mycloudMedia`  -- "your cloud index may be stale, go verify"
 *     Zalo Web throttles acting on this to once per 30 minutes.
 *
 *   GET {auth}/api/getCloudViewerKey                   (12741) -- {viewer_key, enk}, no params
 *   GET {zcloud}/cloudmedia/queue/pc/verify            (12740) -- the cloud queue, paged by lastNoiseId
 *   GET {zcloud}/cloudmedia/downloadurls/pc/v1         (12743) -- noiseId -> signed URL, 100 per call
 *   GET {zcloud}/cloudmedia/info/pc/v2/usage           (12749) -- plan, quota, usage
 *   GET {zcloud}/cloudmedia/info/pc/v1/cloud-settings  (12756) -- per-file limit, opt-in
 *   {media_store}/api/mediastore/list                  (11841) -- media in a conversation
 *   {media_store_send2me}/api/media/oneone/list        (12220) -- media in the self-chat
 *
 * {auth} is https://wpa.chat.zalo.me, the host zca-js logs in against. {zcloud}
 * is the service map's `zcloud` entry, falling back to https://zcld.chat.zalo.me
 * exactly as Zalo Web does. "verify_v2" (12761, chosen by the web when the plan
 * is zcloud) is the same path; the client strips the command id before sending,
 * so it never reaches the wire.
 *
 * HOW zCLOUD SIGNS IN — the handshake `sync-cloud` used to skip, which is why it
 * failed with "Invalid CloudViewerKey" (-205, the client's INVALID_VIEWERKEY):
 *
 *   1. The account's {viewer_key, enk}: from ctx.loginInfo.zcloud when it carries
 *      both, otherwise from getCloudViewerKey (a session-encrypted reply).
 *   2. viewer_key travels as the HTTP header `cloud-viewer-key` on every call.
 *   3. `params` is encrypted with enk, not the session key (./zcloud-cipher.js).
 *      Replies are {error_code, data}; 0 and -904 are success and `data` is the
 *      payload itself, encrypted with enk.
 *   4. -205 / -1 mean the key is stale. Zalo Web's transport drops its key on those codes and
 *      fails that request (the next call fetches a new one). Here the cached key is dropped too,
 *      and a key that was not fetched for this very request is fetched once through
 *      getCloudViewerKey and the GET repeated once: one extra request, so that a stale key from
 *      the login does not fail the first call of a run.
 *   5. Other failures follow the web client's retry rules: server code 112, a dropped connection,
 *      an unreadable reply and an HTTP 4xx/5xx are retried after 0, 5, 5 and 10 s (a 4xx/5xx
 *      also moves to the service map's next zCloud domain); -201 and anything else fail at once.
 *
 * zCLOUD IS A PARTIAL SOURCE. It can confirm that an item is in the cloud; it
 * can never show that an item does not exist. It only ever holds what fit under
 * the quota and the per-file limit, for opted-in services, from the opt-in date
 * onward — and never disappearing (TTL) messages or disallowed types or
 * conversations (the client records those reasons as ttl_message, not_allow_types,
 * not_allow_convs). Everything else exists only on the local-cache path, which
 * for this CLI is the phone-backed transfer-sync-v2 restore and zalo.db. So:
 * only queue entries whose action is `add` are recorded as cloud items (`remove`,
 * `del_thread` and `reset_cloud` are applied to the index, so a recall or a cleared
 * conversation takes its items out; `temp` and `duplicate` change nothing), a walk is
 * `complete` only when the server says it has nothing more, and a lookup miss is
 * reported as inconclusive ({@link lookupCloudBackup}).
 *
 * THE E2EE BOUNDARY. Each item's `encryptInfo` (its per-item key and media
 * metadata) is end-to-end encrypted per client: the per-item key is wrapped for a
 * key that comes from the owner's own cloud PIN, which this client never holds. It
 * is stored exactly as received and never decrypted here; the routing fields in
 * `msgInfo` (ids, timestamps, types) and the version numbers in `encryptInfo` are
 * plain and are the only ones read. Acquiring that key, and with it downloading and
 * decrypting blobs, is out of scope for this client (decision D8 of the 3.0 plan).
 *
 * Reconstructed from Zalo Web's bundle (build 826674fb31d2af1b2b59, captured
 * 2026-09-29; modules tP1L, 98yS, 1LoH, UwMY, u4F8). The request shapes are
 * unit-tested against that client's own cipher, but this module's tests do not
 * talk to the live server.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
    backfillCloudZKeys,
    getCloudItemByMsgId,
    removeCloudItemsBefore,
    removeCloudItemsByZKey,
    removeCloudItemsExcept,
    sweepCloudItemsNotSeenSince,
    upsertCloudItem,
} from "../db.js";
import { decryptZCloud, encodeZCloudParams } from "./zcloud-cipher.js";

const require = createRequire(import.meta.url);

let _utils = null;
function zcaUtils() {
    if (_utils) return _utils;
    _utils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return _utils;
}

/** Zalo's media_type filter on the media-store listing. */
export const MEDIA_TYPE = { all: 0, image: 1, video: 2, file: 3, link: 4 };

/** Where the viewer key is issued: Zalo Web's authDomain, zca-js's login host. */
const AUTH_DOMAIN = "https://wpa.chat.zalo.me";
/** Zalo Web's fallback when the service map lacks `zcloud` (getMediaCloudDomain). */
const ZCLOUD_DOMAIN = "https://zcld.chat.zalo.me";

const PATH = {
    viewerKey: "/api/getCloudViewerKey",
    familyViewerKey: "/api/getFamilyViewerKey",
    verify: "/cloudmedia/queue/pc/verify",
    downloadUrls: "/cloudmedia/downloadurls/pc/v1",
    usage: "/cloudmedia/info/pc/v2/usage",
    myCloudUsage: "/cloudmedia/info/pc/v1/usage-mycloud",
    familyUsage: "/cloudmedia/info/pc/v1/family-usage",
    settings: "/cloudmedia/info/pc/v1/cloud-settings",
    subscription: "/zalocloud/cloudinfopcweb/v1/info",
};

/** Reply codes the client accepts as success. */
const OK_CODES = new Set([0, -904]);
/** cloud_viewer_expired, invalid_cloud_viewer_key: the codes that reload the key. */
const VIEWER_KEY_ERRORS = new Set([-1, -205]);
/**
 * The one server code the web client's retry list names (the rest of it is transport: timeouts, no network, bad
 * data). Every other code fails at once, -201 (over the limit) among them.
 */
const RETRY_ERROR_CODES = new Set([112]);
/** Waits before each retry, as the web client's (0, 5, 5, 10 s). */
let retryDelaysMs = [0, 5000, 5000, 10000];

/**
 * Change how long zCloud calls wait between retries (tests set zeros).
 *
 * @param {{delaysMs?: number[]}} opts
 */
export function configureZCloudRetry({ delaysMs } = {}) {
    if (Array.isArray(delaysMs)) retryDelaysMs = delaysMs;
}
/** Zalo Web asks for download URLs this many noise ids at a time. */
const DOWNLOAD_URL_BATCH = 100;
/** verify `loadType`: oldest_to_newest, what the web's own walk sends. */
const LOAD_OLDEST_TO_NEWEST = 1;
/** verify `tracking_source`: Unknown, the client's default (a telemetry tag). */
const TRACKING_UNKNOWN = 0;
/** msgInfo.destType for a group; users are 3, pages 5. */
const DEST_TYPE_GROUP = 6;
/** Queue entry actions. Only `add` says an item is in the cloud. */
const ACTION = { 1: "add", 2: "remove", 3: "del_thread", 4: "temp", 5: "reset_cloud", 6: "duplicate" };
/** usage.plan values. */
const PLAN = { [-1]: "free", 0: "zcloud", 69: "free_after_grace_period", 100: "grace_period" };

/** A zCloud or viewer-key failure, carrying the server's error_code when there is one. */
export class ZCloudError extends Error {
    /**
     * @param {string} message - never contains key material
     * @param {number|null} [code] - Zalo error_code or HTTP status
     * @param {{http?: boolean, transient?: boolean, payload?: any}} [extra] - http: `code` is an HTTP status;
     *   transient: worth retrying; payload: the decrypted body of an error reply, when it had one
     */
    constructor(message, code = null, extra = {}) {
        super(message);
        this.name = "ZCloudError";
        this.code = code;
        this.http = !!extra.http;
        this.transient = !!extra.transient;
        if (extra.payload !== undefined) this.payload = extra.payload;
    }
}

/** Pick a service-map domain, tolerating a map that lacks it. */
function domain(api, key) {
    const v = api?.zpwServiceMap?.[key];
    const url = Array.isArray(v) ? v[0] : v;
    if (!url) throw new Error(`service map has no "${key}" domain (account may not have zCloud enabled)`);
    return String(url).replace(/\/+$/, "");
}

/** The zCloud media domains, in the service map's order, with Zalo Web's own fallback when it names none. */
function cloudDomains(api) {
    const v = api?.zpwServiceMap?.zcloud;
    const urls = (Array.isArray(v) ? v : [v]).filter(Boolean).map((u) => String(u).replace(/\/+$/, ""));
    return urls.length ? urls : [ZCLOUD_DOMAIN];
}

/** Run `fn(ctx, utils)` inside zca-js's authenticated request envelope. */
function withZca(api, fn) {
    return zcaUtils().apiFactory()((_api, ctx, utils) => fn(ctx, utils))(api.getContext(), api);
}

/** Build an authenticated GET(params=AES(...)) caller for one session-cipher endpoint. */
function makeGet(api, base) {
    const zu = zcaUtils();
    return zu.apiFactory()((_api, ctx, utils) => async (params) => {
        const enc = utils.encodeAES(JSON.stringify({ ...params, imei: ctx.imei }));
        if (!enc) throw new Error("failed to encrypt params");
        const resp = await utils.request(utils.makeURL(base, { params: enc }), { method: "GET" });
        return utils.resolve(resp);
    })(api.getContext(), api);
}

// ── the viewer key ──────────────────────────────────────────────────────────

/** Resolved keys, per session context. Never logged, never persisted. */
const keyCache = new WeakMap();
/** Sessions whose login-info key the server has refused once; they fetch their key instead. */
const loginKeyRefused = new WeakSet();

/** A usable {viewer_key, enk} pair, or null. */
function keyPair(obj, source) {
    const viewerKey = obj?.viewer_key;
    const enk = obj?.enk;
    if (typeof viewerKey !== "string" || !viewerKey || typeof enk !== "string" || !enk) return null;
    return { viewerKey, enk, source };
}

/**
 * Fetch the account's zCloud viewer key pair from the auth domain.
 *
 * `GET https://wpa.chat.zalo.me/api/getCloudViewerKey?zpw_ver&zpw_type`, no
 * params, answered in the ordinary session envelope. The result also replaces
 * the key this session uses for later zCloud calls.
 *
 * @param {object} api - logged-in zca-js api
 * @returns {Promise<{viewerKey: string, enk: string, source: "getCloudViewerKey"}>}
 * @throws {ZCloudError} when the call fails or yields no key (no subscription)
 */
export async function getCloudViewerKey(api) {
    const key = await fetchViewerKey(api, PATH.viewerKey, "getCloudViewerKey");
    keyCache.set(api.getContext(), key);
    return key;
}

/** The family plan's viewer key, kept apart from the account's own: `GET /api/getFamilyViewerKey`, same envelope. */
const familyKeyCache = new WeakMap();

/**
 * Fetch the family plan's zCloud viewer key pair. A read; it replaces only the family key kept for this session.
 *
 * @param {object} api - logged-in zca-js api
 * @returns {Promise<{viewerKey: string, enk: string, source: "getFamilyViewerKey"}>}
 * @throws {ZCloudError} when the call fails or yields no key (no family plan)
 */
export async function getFamilyViewerKey(api) {
    const key = await fetchViewerKey(api, PATH.familyViewerKey, "getFamilyViewerKey");
    familyKeyCache.set(api.getContext(), key);
    return key;
}

/** One session-encrypted key request to the auth domain. */
async function fetchViewerKey(api, path, source) {
    let data;
    try {
        data = await withZca(api, async (_ctx, utils) => {
            const resp = await utils.request(utils.makeURL(`${AUTH_DOMAIN}${path}`), { method: "GET" });
            return utils.resolve(resp);
        });
    } catch (e) {
        throw new ZCloudError(`${source} failed: ${e?.message || e}`, e?.code ?? null);
    }
    if (typeof data === "string") {
        try {
            data = JSON.parse(data);
        } catch {
            data = null;
        }
    }
    const key = keyPair(data, source);
    if (!key) {
        throw new ZCloudError(
            "Zalo returned no zCloud viewer key for this account (no zCloud subscription, or it has lapsed)",
        );
    }
    return key;
}

/**
 * The key pair to use now: this session's cached one, else the login info's
 * `zcloud` field, else a fresh getCloudViewerKey.
 *
 * @returns {Promise<{key: object, fetched: boolean}>} fetched: true when this call went to the network
 */
async function resolveCloudKey(api) {
    const ctx = api.getContext();
    const cached = keyCache.get(ctx);
    if (cached) return { key: cached, fetched: false };
    // The login's key is only ever tried until the server has refused a key: after that it is known stale.
    const fromLogin = loginKeyRefused.has(ctx) ? null : keyPair(ctx?.loginInfo?.zcloud, "loginInfo");
    if (fromLogin) {
        keyCache.set(ctx, fromLogin);
        return { key: fromLogin, fetched: false };
    }
    return { key: await getCloudViewerKey(api), fetched: true };
}

// ── the zCloud transport ────────────────────────────────────────────────────

/** Unwrap a zCloud reply: accept 0 / -904, decrypt `data` with enk. */
async function decodeZCloudReply(resp, enk) {
    if (!resp?.ok) {
        throw new ZCloudError(`zCloud request failed with HTTP ${resp?.status}`, resp?.status ?? null, {
            http: true,
            transient: true,
        });
    }
    let body;
    try {
        body = await resp.json();
    } catch {
        throw new ZCloudError("zCloud reply is not JSON", null, { transient: true });
    }
    const code = Number(body?.error_code);
    if (!OK_CODES.has(code)) {
        const msg = body?.error_message || "no message";
        // An error reply can carry its own detail, encrypted like any other payload.
        let payload;
        if (body?.data) {
            try {
                payload = JSON.parse(decryptZCloud(body.data, enk));
            } catch {
                payload = undefined;
            }
        }
        throw new ZCloudError(`zCloud error ${body?.error_code}: ${msg}`, Number.isFinite(code) ? code : null, {
            transient: RETRY_ERROR_CODES.has(code),
            payload,
        });
    }
    if (body.data === undefined || body.data === null || body.data === "") return null;
    let text;
    try {
        text = decryptZCloud(body.data, enk);
    } catch (e) {
        throw new ZCloudError(`zCloud reply could not be decrypted with the viewer key's enk (${e.message})`, null, {
            transient: true,
        });
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new ZCloudError("zCloud reply decrypted to something that is not JSON", null, { transient: true });
    }
}

/** One GET to zCloud with a given key pair, exactly as Zalo Web builds it. */
function sendZCloud(api, path, params, key, base) {
    return withZca(api, async (_ctx, utils) => {
        let url = utils.makeURL(`${base}${path}`);
        if (params) url += `&params=${encodeZCloudParams(params, key.enk)}`;
        const resp = await utils.request(url, { method: "GET", headers: { "cloud-viewer-key": key.viewerKey } });
        return decodeZCloudReply(resp, key.enk);
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET a zCloud endpoint the way the web client's transport does.
 *
 * - A stale viewer key (-1 / -205) is dropped from the cache. A key that was not fetched for this very request is
 *   then fetched once and the call repeated (the web client stops at the reload; the repeat is a GET, so it costs
 *   nothing but one request).
 * - Transient failures are retried after 0, 5, 5 and 10 s: server code 112, a dropped or unreachable connection, a
 *   reply that is not valid data, and an HTTP 4xx/5xx, which also moves to the next zCloud domain of the service map.
 * - Server code -201 fails at once, and so does everything else.
 *
 * @param {object} api
 * @param {string} path
 * @param {object|null} [params] - encrypted into `params` with enk; omitted when null
 * @returns {Promise<any>} the decrypted payload
 */
async function zcloudGet(api, path, params = null) {
    const ctx = api.getContext();
    let { key, fetched } = await resolveCloudKey(api);
    const bases = cloudDomains(api);
    let base = 0;
    for (let retry = 0; ; retry++) {
        try {
            return await sendZCloud(api, path, params, key, bases[base % bases.length]);
        } catch (e) {
            if (e instanceof ZCloudError && !e.http && VIEWER_KEY_ERRORS.has(e.code)) {
                keyCache.delete(ctx);
                loginKeyRefused.add(ctx);
                if (fetched) throw e;
                try {
                    key = await getCloudViewerKey(api);
                } catch (refreshErr) {
                    throw new ZCloudError(
                        `${e.message}; refreshing the viewer key failed: ${refreshErr.message}`,
                        e.code,
                    );
                }
                fetched = true;
                retry--;
                continue;
            }
            // Anything that is not a ZCloudError never reached a reply: the connection dropped or timed out.
            const transient = !(e instanceof ZCloudError) || e.transient;
            if (!transient || retry >= retryDelaysMs.length) throw e;
            if (e instanceof ZCloudError && e.http) base++;
            if (retryDelaysMs[retry] > 0) await sleep(retryDelaysMs[retry]);
        }
    }
}

// ── endpoints ───────────────────────────────────────────────────────────────

/**
 * One page of the zCloud queue.
 *
 * @param {object} api
 * @param {object} [page]
 * @param {string} [page.lastNoiseId=""] - cursor; "" starts from the top
 * @param {number} [page.loadType=1] - 1 oldest_to_newest, 0 newest_to_oldest
 * @param {string[]} [page.listNoiseIds=[]]
 * @param {number} [page.trackingSource=0] - telemetry tag; 0 Unknown
 * @returns {Promise<{mediaItems?: object[], lastNoiseId?: string, hasMore?: number|boolean}|null>}
 */
export async function verifyCloudQueue(api, page = {}) {
    const {
        lastNoiseId = "",
        loadType = LOAD_OLDEST_TO_NEWEST,
        listNoiseIds = [],
        trackingSource = TRACKING_UNKNOWN,
    } = page;
    return zcloudGet(api, PATH.verify, {
        lastNoiseId: String(lastNoiseId ?? ""),
        loadType,
        listNoiseIds,
        tracking_source: trackingSource,
    });
}

/** How long a resolved download URL is reused (the web client's in-memory cache). */
let urlCacheMs = 60_000;
/** Ids asked for within this window share requests (the web client's microbatch). */
let urlWindowMs = 500;
/** This many callers waiting end the window early; so does a full request's worth of ids. */
const URL_FLUSH_AT = 50;

/**
 * Change the download-URL cache and batching windows (tests use short ones).
 *
 * @param {{cacheMs?: number, windowMs?: number}} opts
 */
export function configureZCloudDownloads({ cacheMs, windowMs } = {}) {
    if (Number.isFinite(cacheMs)) urlCacheMs = cacheMs;
    if (Number.isFinite(windowMs)) urlWindowMs = windowMs;
}

/** Per session: resolved URLs `Map<noiseId, {url, at}>`, and the ids waiting for the next request. */
const urlCaches = new WeakMap();
const urlQueues = new WeakMap();

/** Send the waiting ids, 100 to a request, and settle everyone who asked for them. */
async function flushDownloadUrls(api, queue) {
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = null;
    const waiting = [...queue.waiting];
    queue.waiting = new Map();
    queue.callers = 0;
    const cache = urlCaches.get(api.getContext());
    for (let i = 0; i < waiting.length; i += DOWNLOAD_URL_BATCH) {
        const chunk = waiting.slice(i, i + DOWNLOAD_URL_BATCH);
        let map = {};
        try {
            map =
                (await zcloudGet(api, PATH.downloadUrls, { list_noise_ids: chunk.map(([id]) => id) }))?.download_urls ||
                {};
        } catch (e) {
            for (const [, askers] of chunk) for (const a of askers) a.reject(e);
            continue;
        }
        for (const [id, askers] of chunk) {
            const url = typeof map[id] === "string" && map[id] ? map[id] : null;
            if (url) cache.set(id, { url, at: Date.now() });
            for (const a of askers) a.resolve(url);
        }
    }
}

/** Ask for these ids' URLs; resolves to one answer per id, in order: the URL, or null when Zalo has none. */
function queueDownloadUrls(api, ids) {
    const ctx = api.getContext();
    let queue = urlQueues.get(ctx);
    if (!queue) urlQueues.set(ctx, (queue = { waiting: new Map(), callers: 0, timer: null }));
    const asked = ids.map(
        (id) =>
            new Promise((resolve, reject) => {
                const askers = queue.waiting.get(id) || [];
                askers.push({ resolve, reject });
                queue.waiting.set(id, askers);
            }),
    );
    queue.callers++;
    if (urlWindowMs <= 0 || queue.callers >= URL_FLUSH_AT || queue.waiting.size >= DOWNLOAD_URL_BATCH) {
        void flushDownloadUrls(api, queue);
    } else if (!queue.timer) {
        queue.timer = setTimeout(() => void flushDownloadUrls(api, queue), urlWindowMs);
    }
    return Promise.all(asked);
}

/**
 * Turn cloud noiseIds into signed download URLs.
 *
 * Calls made close together share requests (a 500 ms window, ended early by 50 waiting ids; 100 ids to a request),
 * and a URL is reused for 60 s, as the web client does. The blob behind a URL is end-to-end encrypted per client;
 * nothing here downloads or decrypts it. An id with no URL is `unresolved` — the client's NOT_FOUND_DOWNLOAD_URL —
 * which is not evidence the media is gone elsewhere.
 *
 * @param {object} api
 * @param {string|string[]} noiseIds
 * @returns {Promise<{urls: Record<string, string>, unresolved: string[]}|null>} null when given no ids
 */
export async function fetchCloudDownloadUrl(api, noiseIds) {
    const ids = [...new Set((Array.isArray(noiseIds) ? noiseIds : [noiseIds]).filter(Boolean).map(String))];
    if (!ids.length) return null;
    const ctx = api.getContext();
    let cache = urlCaches.get(ctx);
    if (!cache) urlCaches.set(ctx, (cache = new Map()));
    const urls = {};
    const now = Date.now();
    const missing = [];
    for (const id of ids) {
        const hit = cache.get(id);
        if (hit && now - hit.at < urlCacheMs) urls[id] = hit.url;
        else missing.push(id);
    }
    const answers = missing.length ? await queueDownloadUrls(api, missing) : [];
    missing.forEach((id, k) => {
        if (answers[k]) urls[id] = answers[k];
    });
    return { urls, unresolved: ids.filter((id) => !urls[id]) };
}

/**
 * The account's zCloud usage: `{plan, quota, usage, service_usage}` in bytes.
 *
 * @param {object} api
 * @returns {Promise<object|null>}
 */
export async function getCloudUsage(api) {
    return zcloudGet(api, PATH.usage);
}

/**
 * What the account's own cloud uses (`usage-mycloud`), a read. The web client asks for it at boot.
 *
 * @param {object} api
 * @returns {Promise<object|null>}
 */
export async function getMyCloudUsage(api) {
    return zcloudGet(api, PATH.myCloudUsage);
}

/**
 * What the family plan uses (`family-usage`), a read. The web client asks for it at boot and shows nothing when it
 * fails; a caller here gets the error.
 *
 * @param {object} api
 * @returns {Promise<object|null>}
 */
export async function getFamilyUsage(api) {
    return zcloudGet(api, PATH.familyUsage);
}

/**
 * The zCloud subscription (`cloudinfopcweb`, command 12754): package, billing gateway, status and expiry, and the
 * migration state. Zalo Web asks for it only on a paid plan; a free account gets an empty or refused answer.
 *
 * @param {object} api
 * @returns {Promise<object|null>}
 */
export async function getCloudSubscription(api) {
    return zcloudGet(api, PATH.subscription);
}

/**
 * The account's zCloud settings: per-file size limits, `enable_offload`, `opt_in`.
 *
 * @param {object} api
 * @returns {Promise<object|null>}
 */
export async function getCloudSettings(api) {
    return zcloudGet(api, PATH.settings);
}

const finiteOrNull = (v) =>
    v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

/**
 * Reduce the usage and settings replies to what the CLI reports.
 *
 * The two `...PerFileLimitRaw` values are the settings' numbers as sent: no Web or PC client reads them, so their unit
 * is not defined anywhere we can read (live: 100 on a free account, probably megabytes; 2147483640 on a paid one, a
 * "no practical limit" number). They are not bytes.
 *
 * Over-quota is `usage > quota`, the client's own rule. `opt_in` is read as a
 * bit set over the client's service enum (media 1, mycloud 2, backup 4).
 *
 * @param {object} [usage] - getCloudUsage() reply
 * @param {object} [settings] - getCloudSettings() reply
 * @returns {{plan: string|null, planCode: number|null, quotaBytes: number|null, usageBytes: number|null,
 *   freeBytes: number|null, overQuota: boolean|null, serviceUsage: object|null, perFileLimitRaw: number|null,
 *   myCloudPerFileLimitRaw: number|null, optIn: {media: boolean, mycloud: boolean, backup: boolean}|null}}
 */
export function summarizeCloudQuota(usage = {}, settings = {}) {
    const quota = finiteOrNull(usage?.quota);
    const used = finiteOrNull(usage?.usage);
    const planCode = finiteOrNull(usage?.plan);
    const optIn = finiteOrNull(settings?.opt_in);
    const both = quota !== null && used !== null;
    return {
        plan: planCode === null ? null : (PLAN[planCode] ?? `unknown(${planCode})`),
        planCode,
        quotaBytes: quota,
        usageBytes: used,
        freeBytes: both ? Math.max(0, quota - used) : null,
        overQuota: both ? used > quota : null,
        serviceUsage: usage?.service_usage ?? null,
        perFileLimitRaw: finiteOrNull(settings?.cloud_media_file_size_limit),
        myCloudPerFileLimitRaw: finiteOrNull(settings?.my_cloud_file_size_limit),
        optIn: optIn === null ? null : { media: !!(optIn & 1), mycloud: !!(optIn & 2), backup: !!(optIn & 4) },
    };
}

/**
 * Quota, usage and the per-file limit, read from zCloud.
 *
 * @param {object} api
 * @returns {Promise<ReturnType<typeof summarizeCloudQuota>>}
 */
export async function getCloudQuota(api) {
    // Sequential on purpose: two concurrent first calls would each fetch a key.
    const usage = await getCloudUsage(api);
    const settings = await getCloudSettings(api);
    return summarizeCloudQuota(usage, settings);
}

// ── the cloud index ─────────────────────────────────────────────────────────

/**
 * The conversation an item belongs to, derived the way Zalo Web does
 * (getToIdFromCloudItem): a group item belongs to destId; a DM to whichever
 * side is not the account itself.
 */
function conversationOf(msg, ownId) {
    if (msg?.destId === undefined || msg?.destId === null) return null;
    const dest = String(msg.destId);
    if (Number(msg.destType) === DEST_TYPE_GROUP) return dest;
    if (ownId && dest === String(ownId) && msg.srcId !== undefined && msg.srcId !== null) return String(msg.srcId);
    return dest;
}

/** Zalo's id for a message as the queue keys it: `cliMsgId_conversation_sender`, a 0 standing for the account. */
function zKeyOf(cliMsgId, conversation, sender, ownId) {
    const own = ownId ? String(ownId) : "";
    const s = String(sender) === "0" ? own : String(sender);
    const c = String(conversation) === "0" ? own : String(conversation);
    return `${cliMsgId}_${c}_${s}`;
}

/**
 * The key Zalo Web gives a queue item (getZCloudKeyFromCloudItem), in this database's conversation spelling (a
 * group's id without the web's `g` prefix). Null when the item names no client message id.
 *
 * @param {object} item
 * @param {string|null} [ownId]
 * @returns {string|null}
 */
export function cloudKeyOf(item, ownId = null) {
    const msg = item?.msgInfo;
    if (!msg || msg.cliMsgId === undefined || msg.cliMsgId === null || msg.cliMsgId === "") return null;
    const conv = conversationOf(msg, ownId);
    if (conv === null || msg.srcId === undefined || msg.srcId === null) return null;
    return zKeyOf(msg.cliMsgId, conv, msg.srcId, ownId);
}

/** Delete-message types in an `orgMsgs` entry that name a group (TYPE_DELETE_CHAT_GROUP and its _CONVERSATION twin). */
const DELETE_GROUP_TYPES = new Set([3, 4]);

/**
 * The messages a `remove` entry removes from the cloud, as keys (getZCloudKeyFromDelItem). The entry's
 * `msgInfo.extInfo.orgMsgs` lists them as `{type, uidTo, uidFrom, clientDelMsgId}`.
 *
 * @param {object} item
 * @param {string|null} [ownId]
 * @returns {string[]}
 */
export function removalKeysOf(item, ownId = null) {
    const keys = [];
    for (const org of item?.msgInfo?.extInfo?.orgMsgs || []) {
        if (!org || org.clientDelMsgId === undefined || org.clientDelMsgId === null) continue;
        const { type, uidTo, uidFrom, clientDelMsgId } = org;
        let to = String(uidTo);
        if (!DELETE_GROUP_TYPES.has(Number(type)) && ownId && to === String(ownId)) to = String(uidFrom);
        keys.push(zKeyOf(clientDelMsgId, to, uidFrom, ownId));
    }
    return keys;
}

/**
 * Which conversation a `del_thread` entry cleared, and when (getDelThreadCondition): the first `orgMsgs` entry's
 * `uidTo`, or the group for a `group.leave`; the cut is the entry's client timestamp.
 *
 * @param {object} item
 * @returns {{threadId: string|null, deletedAt: number}}
 */
export function threadClearOf(item) {
    const msg = item?.msgInfo || {};
    const org =
        msg.msgType === "group.leave" ? { uidTo: msg.destId, clientDelMsgId: msg.ts } : msg.extInfo?.orgMsgs?.[0];
    const threadId = org?.uidTo === undefined || org?.uidTo === null ? null : String(org.uidTo);
    return { threadId, deletedAt: Number(item?.cliTs || org?.clientDelMsgId || item?.ts || 0) };
}

/**
 * Normalize one cloud-queue item into a `cloud_items` row.
 *
 * The live item shape is `{noiseId, action, msgInfo: {cliMsgId, glbMsgId,
 * msgType, srcId, destId, destType, ts, …}, mediaInfo: {mediaSize}, encryptInfo,
 * ts}`. Older envelopes are still read from the places they were seen.
 * `encryptInfo` is end-to-end encrypted and is kept opaque.
 *
 * @param {object} item
 * @param {string|null} [ownId] - the logged-in account, to resolve a DM's conversation
 * @returns {object|null}
 */
export function normalizeCloudItem(item, ownId = null) {
    const noiseId = item?.noiseId ?? item?.zKey ?? item?.id;
    if (!noiseId) return null;
    // The blob's key and versions are the item's top-level encryptInfo. `mediaInfo.mediaExtInfo.encryptInfo` wraps a
    // different key (the one for the file-name and thumbnail metadata) and is kept only in raw_data, verbatim.
    const enc = item.encryptInfo || {};
    const media = item.mediaInfo || {};
    const msg = item.msgInfo || {};
    return {
        zKey: cloudKeyOf(item, ownId),
        keyVersion: enc.keyVersion ?? null,
        algoVersion: enc.algoVersion ?? null,
        noiseId: String(noiseId),
        threadId: conversationOf(msg, ownId) ?? msg.toUid ?? msg.convId ?? item.threadId ?? null,
        msgId: msg.glbMsgId ?? msg.msgId ?? item.msgId ?? null,
        msgType: msg.msgType ?? item.msgType ?? null,
        mediaType: media.mediaType ?? item.mediaType ?? null,
        cloudUrl: enc.cloudUrl ?? item.cloudUrl ?? null,
        encryptKey: enc.encryptKey ?? null,
        checksum: media.checksum ?? item.checksum ?? null,
        mediaSize: media.mediaSize ?? item.mediaSize ?? null,
        timestamp: msg.ts ?? msg.timestamp ?? item.ts ?? null,
        raw_data: item,
    };
}

/** Cloud listings arrive under one of several keys; the verify queue uses `mediaItems`. */
function itemsOf(resp) {
    if (Array.isArray(resp)) return resp;
    for (const k of ["mediaItems", "items", "list", "data", "medias", "queue"]) {
        const v = resp?.[k];
        if (Array.isArray(v)) return v;
    }
    for (const k of ["mediaItems", "items", "list", "medias"]) {
        const v = resp?.data?.[k];
        if (Array.isArray(v)) return v;
    }
    return [];
}

/** The paging cursor a listing hands back for the next call. */
function nextCursor(resp, items) {
    const d = resp?.data ?? resp;
    return (
        d?.lastNoiseId ??
        d?.nextNoiseId ??
        d?.last_id ??
        d?.lastId ??
        (items.length ? (items[items.length - 1]?.noiseId ?? items[items.length - 1]?.id) : null) ??
        null
    );
}

/** The verify reply's `hasMore`, or null when the reply carries none. */
function moreFlag(resp) {
    const v = resp?.hasMore ?? resp?.data?.hasMore;
    if (v === undefined || v === null) return null;
    return v === true || Number(v) > 0;
}

/** The logged-in account's id, when the api can say. */
function ownIdOf(api) {
    try {
        return api?.getOwnId?.() || api?.getContext?.()?.uid || null;
    } catch {
        return null;
    }
}

/** The account's self chat ("Cloud của tôi"), the one conversation a reset spares; its id is not always the own id. */
function selfChatIdOf(api, ownId) {
    try {
        return api?.getContext?.()?.loginInfo?.send2me_id || ownId || null;
    } catch {
        return ownId || null;
    }
}

/** An entry's time as Zalo Web orders and compares them: the message's own, else the entry's. */
const entryTs = (item) => Number(item?.msgInfo?.ts ?? item?.ts ?? 0) || 0;

/**
 * Apply one page of the queue to the local index, the way Zalo Web's walker does (`verifyFromId`):
 *
 * 1. The newest `reset_cloud` on the page empties the index except the self chat, and every entry on the page that
 *    is older than it (self chat aside) is dropped unread.
 * 2. What is left is read oldest first and applied in three groups, in this order: `add` entries are recorded,
 *    `remove` entries delete the messages they name, `del_thread` entries delete a conversation's older items.
 * 3. `temp` and `duplicate` entries change nothing (the web client does nothing with them either).
 *
 * @param {object[]} items - the page's entries
 * @param {object} [opts]
 * @param {string|null} [opts.ownId]
 * @param {string|null} [opts.selfChatId]
 * @param {number} [opts.seenAt] - stamped on every recorded item (a full walk sweeps on it)
 * @returns {{added:number, removed:number, threadsCleared:number, resets:number, dropped:number,
 *   failures:Array<object>, skipped:Record<string, number>}}
 */
export function applyQueuePage(items, opts = {}) {
    const { ownId = null, seenAt } = opts;
    const selfChatId = opts.selfChatId ?? ownId;
    const out = { added: 0, removed: 0, threadsCleared: 0, resets: 0, dropped: 0, failures: [], skipped: {} };
    const spare = [selfChatId, ownId].filter(Boolean).map(String);

    const newestFirst = [...items].filter(Boolean).sort((a, b) => entryTs(b) - entryTs(a));
    const reset = newestFirst.find((i) => Number(i.action) === 5);
    let live = newestFirst;
    if (reset) {
        out.resets++;
        removeCloudItemsExcept(spare);
        const cut = Number(reset.ts ?? entryTs(reset));
        live = newestFirst.filter((i) => {
            const keep = spare.includes(conversationOf(i.msgInfo, ownId)) || Number(i.ts ?? entryTs(i)) > cut;
            if (!keep) out.dropped++;
            return keep;
        });
    }

    const adds = [];
    const removes = [];
    const clears = [];
    for (const item of live.reverse()) {
        const action = item.action === undefined || item.action === null ? 1 : Number(item.action);
        if (action === 1) adds.push(item);
        else if (action === 2) removes.push(item);
        else if (action === 3) clears.push(item);
        else if (action !== 5) {
            const name = ACTION[action] || `action_${item.action}`;
            out.skipped[name] = (out.skipped[name] || 0) + 1;
        }
    }

    for (const raw of adds) {
        const row = normalizeCloudItem(raw, ownId);
        if (!row) continue;
        try {
            upsertCloudItem({ ...row, seenAt });
            out.added++;
        } catch (e) {
            if (out.failures.length < 20) out.failures.push({ noiseId: row.noiseId, reason: e.message });
        }
    }
    for (const raw of removes) out.removed += removeCloudItemsByZKey(removalKeysOf(raw, ownId));
    for (const raw of clears) {
        const { threadId, deletedAt } = threadClearOf(raw);
        if (!threadId) continue;
        const n = removeCloudItemsBefore(threadId, deletedAt);
        out.removed += n;
        out.threadsCleared++;
    }
    return out;
}

/**
 * Walk the cloud verify queue and keep the local index equal to what it says.
 *
 * This is the CLI's stand-in for what Zalo Web does when it receives a cmd 621 `mycloudMedia` event: page through
 * the queue by `lastNoiseId` while the reply says `hasMore`, applying each page as it arrives
 * ({@link applyQueuePage}: adds are recorded, removals, cleared conversations and resets are applied). A recall, for
 * instance, arrives as a remove entry for a chat.undo, and the item it names is deleted here.
 *
 * `full` walks from the top and, when the server says it is done, deletes every item that no page listed: the
 * mark-and-sweep that corrects an index the incremental walks left stale. It never deletes before the walk has
 * finished, so an interrupted full walk loses nothing.
 *
 * @param {object} opts
 * @param {object} [opts.api]
 * @param {string} [opts.lastNoiseId=""] - resume cursor; "" starts from the top
 * @param {boolean} [opts.full=false] - start from the top and sweep what no page listed
 * @param {number} [opts.pageSize=300] - consulted only when a reply carries no
 *   `hasMore`; the verify request itself has no page-size parameter
 * @param {number} [opts.maxPages=50]
 * @param {string} [opts.ownId] - the account id; defaults to the api's
 * @param {string} [opts.selfChatId] - the self chat's id; defaults to the login's `send2me_id`
 * @param {(p: object) => void} [opts.onProgress]
 * @param {(p: {cursor: string, page: number, complete: boolean}) => void} [opts.onPage] - after each page is applied:
 *   where a later walk may resume (persist it here, so a killed walk still moves forward)
 * @param {(params: object) => Promise<object>} [opts.verify] - injected caller (tests)
 * @returns {Promise<{items:number, removed:number, threadsCleared:number, resets:number, swept:number, pages:number,
 *   lastNoiseId:string|null, failed:number, failures:Array<object>, complete:boolean, skipped:Record<string, number>}>}
 */
export async function syncCloudIndex(opts = {}) {
    const { api, pageSize = 300, maxPages = 50, onProgress = () => {}, onPage = () => {}, full = false } = opts;
    // `complete`: the server said it had nothing further. False means the
    // walk stopped on --pages (or on a cursor it could not advance) and
    // lastNoiseId is where to resume.
    const stats = {
        items: 0,
        removed: 0,
        threadsCleared: 0,
        resets: 0,
        swept: 0,
        pages: 0,
        lastNoiseId: null,
        failed: 0,
        failures: [],
        complete: false,
        skipped: {},
    };
    const verify = opts.verify || (api ? (params) => verifyCloudQueue(api, params) : null);
    if (!verify) return stats;
    const ownId = opts.ownId ?? ownIdOf(api);
    const selfChatId = opts.selfChatId ?? selfChatIdOf(api, ownId);
    const startedAt = Date.now();
    // Rows recorded before the key existed cannot be found by a remove entry until they have it.
    backfillCloudZKeys((raw) => cloudKeyOf(raw, ownId));

    let cursor = full ? "" : opts.lastNoiseId || "";
    for (let page = 0; page < maxPages; page++) {
        let resp;
        try {
            resp = await verify({ lastNoiseId: cursor, loadType: LOAD_OLDEST_TO_NEWEST, listNoiseIds: [] });
        } catch (e) {
            stats.failed++;
            stats.failures.push({ page, reason: e?.message || String(e) });
            break;
        }
        const items = itemsOf(resp);
        stats.pages++;
        const applied = applyQueuePage(items, { ownId, selfChatId, seenAt: startedAt });
        stats.items += applied.added;
        stats.removed += applied.removed;
        stats.threadsCleared += applied.threadsCleared;
        stats.resets += applied.resets;
        for (const [name, n] of Object.entries(applied.skipped)) stats.skipped[name] = (stats.skipped[name] || 0) + n;
        if (applied.failures.length) {
            stats.failed += applied.failures.length;
            for (const f of applied.failures) if (stats.failures.length < 20) stats.failures.push(f);
        }
        onProgress({ phase: "cloud-page", page: stats.pages, items: stats.items, removed: stats.removed });

        const next = nextCursor(resp, items);
        const more = moreFlag(resp);
        const stuck = !next || next === cursor;
        let done = false;
        if (more === null) {
            // No hasMore: fall back to the shape of the page. A short page, a
            // missing cursor, or one that did not move means nothing further.
            if (!items.length || items.length < pageSize || stuck) {
                stats.lastNoiseId = next || cursor || null;
                done = true;
            }
        } else if (!more) {
            stats.lastNoiseId = next || cursor || null;
            done = true;
        } else if (stuck) {
            // The server says there is more but gave no cursor to reach it.
            stats.lastNoiseId = cursor || null;
            stats.failed++;
            stats.failures.push({ page, reason: "zCloud reported more pages but did not advance lastNoiseId" });
            break;
        }
        if (done) {
            stats.complete = true;
            if (stats.lastNoiseId) onPage({ cursor: String(stats.lastNoiseId), page: stats.pages, complete: true });
            break;
        }
        cursor = String(next);
        stats.lastNoiseId = cursor;
        onPage({ cursor, page: stats.pages, complete: false });
    }
    if (full && stats.complete && !stats.failed) stats.swept = sweepCloudItemsNotSeenSince(startedAt);
    return stats;
}

/**
 * What the local cloud index can say about one message's media.
 *
 * A hit confirms a zCloud backup existed as of the last `sync-cloud`. A miss is
 * never proof of absence: zCloud is a partial source, and the message may live
 * only on the local-cache path. Callers must not turn `found: false` into "gone".
 *
 * @param {string} msgId - the message's global id
 * @returns {{found: true, conclusive: true, item: object} | {found: false, conclusive: false, reason: string}}
 */
export function lookupCloudBackup(msgId) {
    const item = msgId === undefined || msgId === null || msgId === "" ? null : getCloudItemByMsgId(String(msgId));
    if (item) return { found: true, conclusive: true, item };
    return {
        found: false,
        conclusive: false,
        reason:
            "not in the local zCloud index, which proves nothing: zCloud never holds disappearing (TTL) " +
            "messages, disallowed types or conversations, anything over the quota or the per-file limit, or " +
            "anything from before the account opted in, and the index is only as fresh as the last sync-cloud",
    };
}

/**
 * List the media Zalo holds server-side for one conversation.
 *
 * Independent of the message sync: this enumerates a conversation's media even
 * for messages that were never synced. The self-chat ("Cloud của tôi") uses a
 * different domain and path, which is what `isSelfChat` selects. These are
 * session-cipher endpoints, not zCloud ones.
 *
 * @param {object} opts
 * @param {object} opts.api
 * @param {string} opts.threadId
 * @param {boolean} [opts.isSelfChat=false]
 * @param {number} [opts.mediaType=0] - see {@link MEDIA_TYPE}
 * @param {number} [opts.limit=50] - per page
 * @param {number} [opts.maxPages=20]
 * @param {(params: object) => Promise<object>} [opts.list] - injected caller (tests)
 * @returns {Promise<{items:Array<object>, pages:number, failed:number, failures:Array<object>}>}
 */
export async function listConversationMedia(opts = {}) {
    const { api, threadId, isSelfChat = false, mediaType = 0, limit = 50, maxPages = 20 } = opts;
    const out = { items: [], pages: 0, failed: 0, failures: [] };

    let list = opts.list;
    if (!list && api) {
        list = isSelfChat
            ? makeGet(api, `${domain(api, "media_store_send2me")}/api/media/oneone/list`)
            : makeGet(api, `${domain(api, "media_store")}/api/mediastore/list`);
    }
    if (!list) return out;

    let lastId = null;
    let lastFetchId = null;
    for (let page = 0; page < maxPages; page++) {
        // Field names mirror Zalo Web's getMediaFromConversation().
        const params = { media_type: mediaType, limit };
        if (!isSelfChat) params.group_id = String(threadId);
        if (lastId) params.last_id = lastId;
        if (lastFetchId) params.lastFetchId = lastFetchId;

        let resp;
        try {
            resp = await list(params);
        } catch (e) {
            out.failed++;
            out.failures.push({ page, reason: e?.message || String(e) });
            break;
        }
        const items = itemsOf(resp);
        out.pages++;
        out.items.push(...items);
        if (!items.length || items.length < limit) break;

        const d = resp?.data ?? resp;
        const nextId = d?.last_id ?? d?.lastId ?? items[items.length - 1]?.id ?? null;
        const nextFetch = d?.lastFetchId ?? null;
        if ((!nextId || nextId === lastId) && (!nextFetch || nextFetch === lastFetchId)) break;
        lastId = nextId;
        lastFetchId = nextFetch;
    }
    return out;
}
