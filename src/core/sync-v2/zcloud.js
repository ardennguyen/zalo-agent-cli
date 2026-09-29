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
 *   4. -205 / -1 mean the key is stale. Zalo Web reloads its key on those codes;
 *      here a key that was not fetched for this very request is refreshed once
 *      through getCloudViewerKey and the call retried once.
 *
 * zCLOUD IS A PARTIAL SOURCE. It can confirm that an item is in the cloud; it
 * can never show that an item does not exist. It only ever holds what fit under
 * the quota and the per-file limit, for opted-in services, from the opt-in date
 * onward — and never disappearing (TTL) messages or disallowed types or
 * conversations (the client records those reasons as ttl_message, not_allow_types,
 * not_allow_convs). Everything else exists only on the local-cache path, which
 * for this CLI is the phone-backed transfer-sync-v2 restore and zalo.db. So:
 * only queue entries whose action is `add` are recorded as cloud items, a walk is
 * `complete` only when the server says it has nothing more, and a lookup miss is
 * reported as inconclusive ({@link lookupCloudBackup}).
 *
 * THE E2EE BOUNDARY. Each item's `encryptInfo` (its per-item key and media
 * metadata) is end-to-end encrypted per client. It is stored exactly as received
 * and never decrypted here; the routing fields in `msgInfo` (ids, timestamps,
 * types) are plain and are the only ones read. Handling E2EE keys needs separate
 * scoping with Arden before anyone works on it.
 *
 * Reconstructed from Zalo Web's bundle (build 826674fb31d2af1b2b59, captured
 * 2026-09-29; modules tP1L, 98yS, 1LoH, UwMY, u4F8). The request shapes are
 * unit-tested against that client's own cipher, but this module's tests do not
 * talk to the live server.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getCloudItemByMsgId, upsertCloudItem } from "../db.js";
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
    verify: "/cloudmedia/queue/pc/verify",
    downloadUrls: "/cloudmedia/downloadurls/pc/v1",
    usage: "/cloudmedia/info/pc/v2/usage",
    settings: "/cloudmedia/info/pc/v1/cloud-settings",
};

/** Reply codes the client accepts as success. */
const OK_CODES = new Set([0, -904]);
/** cloud_viewer_expired, invalid_cloud_viewer_key: the codes that reload the key. */
const VIEWER_KEY_ERRORS = new Set([-1, -205]);
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
     */
    constructor(message, code = null) {
        super(message);
        this.name = "ZCloudError";
        this.code = code;
    }
}

/** Pick a service-map domain, tolerating a map that lacks it. */
function domain(api, key) {
    const v = api?.zpwServiceMap?.[key];
    const url = Array.isArray(v) ? v[0] : v;
    if (!url) throw new Error(`service map has no "${key}" domain (account may not have zCloud enabled)`);
    return String(url).replace(/\/+$/, "");
}

/** The zCloud media domain, with Zalo Web's own fallback. */
function cloudDomain(api) {
    const v = api?.zpwServiceMap?.zcloud;
    const url = Array.isArray(v) ? v[0] : v;
    return String(url || ZCLOUD_DOMAIN).replace(/\/+$/, "");
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
    let data;
    try {
        data = await withZca(api, async (_ctx, utils) => {
            const resp = await utils.request(utils.makeURL(`${AUTH_DOMAIN}${PATH.viewerKey}`), { method: "GET" });
            return utils.resolve(resp);
        });
    } catch (e) {
        throw new ZCloudError(`getCloudViewerKey failed: ${e?.message || e}`, e?.code ?? null);
    }
    if (typeof data === "string") {
        try {
            data = JSON.parse(data);
        } catch {
            data = null;
        }
    }
    const key = keyPair(data, "getCloudViewerKey");
    if (!key) {
        throw new ZCloudError(
            "Zalo returned no zCloud viewer key for this account (no zCloud subscription, or it has lapsed)",
        );
    }
    keyCache.set(api.getContext(), key);
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
    const fromLogin = keyPair(ctx?.loginInfo?.zcloud, "loginInfo");
    if (fromLogin) {
        keyCache.set(ctx, fromLogin);
        return { key: fromLogin, fetched: false };
    }
    return { key: await getCloudViewerKey(api), fetched: true };
}

// ── the zCloud transport ────────────────────────────────────────────────────

/** Unwrap a zCloud reply: accept 0 / -904, decrypt `data` with enk. */
async function decodeZCloudReply(resp, enk) {
    if (!resp?.ok) throw new ZCloudError(`zCloud request failed with HTTP ${resp?.status}`, resp?.status ?? null);
    let body;
    try {
        body = await resp.json();
    } catch {
        throw new ZCloudError("zCloud reply is not JSON");
    }
    const code = Number(body?.error_code);
    if (!OK_CODES.has(code)) {
        const msg = body?.error_message || "no message";
        throw new ZCloudError(`zCloud error ${body?.error_code}: ${msg}`, Number.isFinite(code) ? code : null);
    }
    if (body.data === undefined || body.data === null || body.data === "") return null;
    let text;
    try {
        text = decryptZCloud(body.data, enk);
    } catch (e) {
        throw new ZCloudError(`zCloud reply could not be decrypted with the viewer key's enk (${e.message})`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new ZCloudError("zCloud reply decrypted to something that is not JSON");
    }
}

/** One GET to zCloud with a given key pair, exactly as Zalo Web builds it. */
function sendZCloud(api, path, params, key) {
    return withZca(api, async (_ctx, utils) => {
        let url = utils.makeURL(`${cloudDomain(api)}${path}`);
        if (params) url += `&params=${encodeZCloudParams(params, key.enk)}`;
        const resp = await utils.request(url, { method: "GET", headers: { "cloud-viewer-key": key.viewerKey } });
        return decodeZCloudReply(resp, key.enk);
    });
}

/**
 * GET a zCloud endpoint, refreshing a stale viewer key once.
 *
 * @param {object} api
 * @param {string} path
 * @param {object|null} [params] - encrypted into `params` with enk; omitted when null
 * @returns {Promise<any>} the decrypted payload
 */
async function zcloudGet(api, path, params = null) {
    const { key, fetched } = await resolveCloudKey(api);
    try {
        return await sendZCloud(api, path, params, key);
    } catch (e) {
        if (!VIEWER_KEY_ERRORS.has(e?.code) || fetched) throw e;
        let fresh;
        try {
            fresh = await getCloudViewerKey(api);
        } catch (refreshErr) {
            throw new ZCloudError(`${e.message}; refreshing the viewer key failed: ${refreshErr.message}`, e.code);
        }
        return sendZCloud(api, path, params, fresh);
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

/**
 * Turn cloud noiseIds into signed download URLs, 100 ids per request.
 *
 * The blob behind a URL is end-to-end encrypted per client; nothing here
 * downloads or decrypts it. An id with no URL is `unresolved` — the client's
 * NOT_FOUND_DOWNLOAD_URL — which is not evidence the media is gone elsewhere.
 *
 * @param {object} api
 * @param {string|string[]} noiseIds
 * @returns {Promise<{urls: Record<string, string>, unresolved: string[]}|null>} null when given no ids
 */
export async function fetchCloudDownloadUrl(api, noiseIds) {
    const ids = [...new Set((Array.isArray(noiseIds) ? noiseIds : [noiseIds]).filter(Boolean).map(String))];
    if (!ids.length) return null;
    const urls = {};
    for (let i = 0; i < ids.length; i += DOWNLOAD_URL_BATCH) {
        const batch = ids.slice(i, i + DOWNLOAD_URL_BATCH);
        const reply = await zcloudGet(api, PATH.downloadUrls, { list_noise_ids: batch });
        const map = reply?.download_urls || {};
        for (const id of batch) if (typeof map[id] === "string" && map[id]) urls[id] = map[id];
    }
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
 * Over-quota is `usage > quota`, the client's own rule. `opt_in` is read as a
 * bit set over the client's service enum (media 1, mycloud 2, backup 4).
 *
 * @param {object} [usage] - getCloudUsage() reply
 * @param {object} [settings] - getCloudSettings() reply
 * @returns {{plan: string|null, planCode: number|null, quotaBytes: number|null, usageBytes: number|null,
 *   freeBytes: number|null, overQuota: boolean|null, serviceUsage: object|null, perFileLimitBytes: number|null,
 *   myCloudPerFileLimitBytes: number|null, optIn: {media: boolean, mycloud: boolean, backup: boolean}|null}}
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
        perFileLimitBytes: finiteOrNull(settings?.cloud_media_file_size_limit),
        myCloudPerFileLimitBytes: finiteOrNull(settings?.my_cloud_file_size_limit),
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
    const enc = item.encryptInfo || {};
    const media = item.mediaInfo || {};
    const msg = item.msgInfo || {};
    return {
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

/** Only an `add` entry — or an entry that names no action — says the item is clouded. */
function confirmsPresence(item) {
    const a = item?.action;
    return a === undefined || a === null || Number(a) === 1;
}

/** The logged-in account's id, when the api can say. */
function ownIdOf(api) {
    try {
        return api?.getOwnId?.() || api?.getContext?.()?.uid || null;
    } catch {
        return null;
    }
}

/**
 * Walk the cloud verify queue and record the items it says are in the cloud.
 *
 * This is the CLI's stand-in for what Zalo Web does when it receives a cmd 621
 * `mycloudMedia` event: page through the queue by `lastNoiseId` while the reply
 * says `hasMore`. Entries whose action is not `add` (remove, del_thread,
 * reset_cloud, temp, duplicate) are not cloud items and are only counted in
 * `skipped`; a recall, for instance, arrives as a remove entry for a chat.undo.
 *
 * @param {object} opts
 * @param {object} [opts.api]
 * @param {string} [opts.lastNoiseId=""] - resume cursor; "" starts from the top
 * @param {number} [opts.pageSize=300] - consulted only when a reply carries no
 *   `hasMore`; the verify request itself has no page-size parameter
 * @param {number} [opts.maxPages=50]
 * @param {string} [opts.ownId] - the account id; defaults to the api's
 * @param {(p: object) => void} [opts.onProgress]
 * @param {(params: object) => Promise<object>} [opts.verify] - injected caller (tests)
 * @returns {Promise<{items:number, pages:number, lastNoiseId:string|null, failed:number, failures:Array<object>,
 *   complete:boolean, skipped:Record<string, number>}>}
 */
export async function syncCloudIndex(opts = {}) {
    const { api, pageSize = 300, maxPages = 50, onProgress = () => {} } = opts;
    // `complete`: the server said it had nothing further. False means the
    // walk stopped on --pages (or on a cursor it could not advance) and
    // lastNoiseId is where to resume.
    const stats = { items: 0, pages: 0, lastNoiseId: null, failed: 0, failures: [], complete: false, skipped: {} };
    const verify = opts.verify || (api ? (params) => verifyCloudQueue(api, params) : null);
    if (!verify) return stats;
    const ownId = opts.ownId ?? ownIdOf(api);

    let cursor = opts.lastNoiseId || "";
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
        for (const raw of items) {
            if (!confirmsPresence(raw)) {
                const name = ACTION[Number(raw.action)] || `action_${raw.action}`;
                stats.skipped[name] = (stats.skipped[name] || 0) + 1;
                continue;
            }
            const row = normalizeCloudItem(raw, ownId);
            if (!row) continue;
            try {
                upsertCloudItem(row);
                stats.items++;
            } catch (e) {
                stats.failed++;
                if (stats.failures.length < 20) stats.failures.push({ noiseId: row.noiseId, reason: e.message });
            }
        }
        onProgress({ phase: "cloud-page", page: stats.pages, items: stats.items });

        const next = nextCursor(resp, items);
        const more = moreFlag(resp);
        const stuck = !next || next === cursor;
        if (more === null) {
            // No hasMore: fall back to the shape of the page. A short page, a
            // missing cursor, or one that did not move means nothing further.
            if (!items.length || items.length < pageSize || stuck) {
                stats.lastNoiseId = next || cursor || null;
                stats.complete = true;
                break;
            }
        } else if (!more) {
            stats.lastNoiseId = next || cursor || null;
            stats.complete = true;
            break;
        } else if (stuck) {
            // The server says there is more but gave no cursor to reach it.
            stats.lastNoiseId = cursor || null;
            stats.failed++;
            stats.failures.push({ page, reason: "zCloud reported more pages but did not advance lastNoiseId" });
            break;
        }
        cursor = String(next);
        stats.lastNoiseId = cursor;
    }
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
