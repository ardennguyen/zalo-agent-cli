/**
 * zCloud ("Cloud của tôi") and the per-conversation media store.
 *
 * This is the SECOND place Zalo keeps media, and it is reached by a completely
 * different route from transfer-sync-v2. The sync stream (cmd 590/601) carries
 * message rows with CDN references; none of it knows about the cloud. The
 * cloud has its own boot event and its own REST surface:
 *
 *   cmd 621 `mycloudMedia`  -- "your cloud index may be stale, go verify"
 *     {pageSize, lastNoiseId, forceVerify, onboardingCompleted, ...}
 *     Zalo Web throttles acting on this to once per 30 minutes.
 *
 *   {zcloud}/cloudmedia/queue/pc/verify      (12740) -- walk the cloud index,
 *                                                       paged by lastNoiseId
 *   {zcloud}/api/getCloudViewerKey           (12741) -- the account's cloud key
 *   {zcloud}/cloudmedia/downloadurls/pc/v1   (12743) -- noiseId -> signed URL
 *   {media_store}/api/mediastore/list        (11841) -- media in a conversation
 *   {media_store_send2me}/api/media/oneone/list (12220) -- media in the self-chat
 *
 * Domains come from zca-js's `zpwServiceMap`, which does carry `zcloud`,
 * `media_store` and `media_store_send2me` even though zca-js exposes no API
 * for them.
 *
 * SCOPE — read this before trusting the module:
 *
 *   Implemented and unit-tested: request construction, pagination, response
 *   normalization, and persistence of the cloud index.
 *
 *   NOT implemented: decrypting a downloaded cloud blob. Each item carries its
 *   own `encryptInfo.encryptKey` and the account holds a cloud viewer key, but
 *   the scheme that combines them is not something this module can determine
 *   without a live cloud item to test against, and shipping a guess would
 *   produce corrupt files. {@link fetchCloudDownloadUrl} therefore returns the
 *   signed URL and the key material and stops there.
 *
 * Every endpoint here is reconstructed from Zalo Web's bundle and has NOT been
 * exercised against a live account by this module's tests.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { upsertCloudItem } from "../db.js";

const require = createRequire(import.meta.url);

let _utils = null;
function zcaUtils() {
    if (_utils) return _utils;
    _utils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return _utils;
}

/** Zalo's media_type filter on the media-store listing. */
export const MEDIA_TYPE = { all: 0, image: 1, video: 2, file: 3, link: 4 };

/** Pick a service-map domain, tolerating a map that lacks it. */
function domain(api, key) {
    const v = api?.zpwServiceMap?.[key];
    const url = Array.isArray(v) ? v[0] : v;
    if (!url) throw new Error(`service map has no "${key}" domain (account may not have zCloud enabled)`);
    return String(url).replace(/\/+$/, "");
}

/** Build an authenticated GET(params=AES(...)) caller for one endpoint. */
function makeGet(api, base) {
    const zu = zcaUtils();
    return zu.apiFactory()((_api, ctx, utils) => async (params) => {
        const enc = utils.encodeAES(JSON.stringify({ ...params, imei: ctx.imei }));
        if (!enc) throw new Error("failed to encrypt params");
        const resp = await utils.request(utils.makeURL(base, { params: enc }), { method: "GET" });
        return utils.resolve(resp);
    })(api.getContext(), api);
}

/** Build an authenticated POST(params=AES(...)) caller for one endpoint. */
function makePost(api, base) {
    const zu = zcaUtils();
    return zu.apiFactory()((_api, ctx, utils) => async (params) => {
        const enc = utils.encodeAES(JSON.stringify({ ...params, imei: ctx.imei }));
        if (!enc) throw new Error("failed to encrypt params");
        const resp = await utils.request(utils.makeURL(base), {
            method: "POST",
            body: new URLSearchParams({ params: enc }),
        });
        return utils.resolve(resp);
    })(api.getContext(), api);
}

/**
 * The account's cloud viewer key. Needed before any cloud blob can be read;
 * on its own it is not sufficient (see the scope note above).
 *
 * @param {object} api
 * @returns {Promise<object>} the raw response — shape unverified
 */
export async function getCloudViewerKey(api) {
    return makeGet(api, `${domain(api, "zcloud")}/api/getCloudViewerKey`)({});
}

/**
 * Turn cloud noiseIds into signed download URLs.
 *
 * @param {object} api
 * @param {string[]} noiseIds
 * @returns {Promise<object>} the raw response — shape unverified
 */
export async function fetchCloudDownloadUrl(api, noiseIds) {
    const ids = (Array.isArray(noiseIds) ? noiseIds : [noiseIds]).filter(Boolean).map(String);
    if (!ids.length) return null;
    return makePost(api, `${domain(api, "zcloud")}/cloudmedia/downloadurls/pc/v1`)({ noiseIds: ids });
}

/**
 * Normalize one cloud-queue item into a `cloud_items` row.
 *
 * Zalo nests the interesting parts under `encryptInfo` / `mediaInfo` /
 * `msgInfo`, and different callers hand back slightly different envelopes, so
 * each field is read from the places it is known to appear.
 *
 * @param {object} item
 * @returns {object|null}
 */
export function normalizeCloudItem(item) {
    const noiseId = item?.noiseId ?? item?.zKey ?? item?.id;
    if (!noiseId) return null;
    const enc = item.encryptInfo || {};
    const media = item.mediaInfo || {};
    const msg = item.msgInfo || {};
    return {
        noiseId: String(noiseId),
        threadId: msg.toUid ?? msg.convId ?? item.threadId ?? null,
        msgId: msg.msgId ?? item.msgId ?? null,
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

/** Cloud listings arrive under one of several keys. */
function itemsOf(resp) {
    if (Array.isArray(resp)) return resp;
    for (const k of ["items", "list", "data", "medias", "queue"]) {
        const v = resp?.[k];
        if (Array.isArray(v)) return v;
    }
    for (const k of ["items", "list", "medias"]) {
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

/**
 * Walk the cloud verify queue and record everything it reports.
 *
 * This is the CLI's stand-in for what Zalo Web does when it receives a cmd 621
 * `mycloudMedia` event: page through the cloud index by `lastNoiseId` and
 * reconcile it locally.
 *
 * @param {object} opts
 * @param {object} opts.api
 * @param {string} [opts.lastNoiseId=""] - resume cursor; "" starts from the top
 * @param {number} [opts.pageSize=300] - Zalo Web uses 300
 * @param {number} [opts.maxPages=50]
 * @param {(p: object) => void} [opts.onProgress]
 * @param {(params: object) => Promise<object>} [opts.verify] - injected caller (tests)
 * @returns {Promise<{items:number, pages:number, lastNoiseId:string|null, failed:number, failures:Array<object>}>}
 */
export async function syncCloudIndex(opts = {}) {
    const { api, pageSize = 300, maxPages = 50, onProgress = () => {} } = opts;
    // `complete`: the server said it had nothing further. False means the
    // walk stopped on --pages and lastNoiseId is where to resume.
    const stats = { items: 0, pages: 0, lastNoiseId: null, failed: 0, failures: [], complete: false };
    const verify = opts.verify || (api ? makePost(api, `${domain(api, "zcloud")}/cloudmedia/queue/pc/verify`) : null);
    if (!verify) return stats;

    let cursor = opts.lastNoiseId || "";
    for (let page = 0; page < maxPages; page++) {
        let resp;
        try {
            resp = await verify({ lastNoiseId: cursor, pageSize });
        } catch (e) {
            stats.failed++;
            stats.failures.push({ page, reason: e?.message || String(e) });
            break;
        }
        const items = itemsOf(resp);
        stats.pages++;
        for (const raw of items) {
            const row = normalizeCloudItem(raw);
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
        // Stop on a short page, a missing cursor, or a cursor that did not move
        // — any of those means the server has nothing further to give.
        if (!items.length || items.length < pageSize || !next || next === cursor) {
            stats.lastNoiseId = next || cursor || null;
            stats.complete = true;
            break;
        }
        cursor = String(next);
        stats.lastNoiseId = cursor;
    }
    return stats;
}

/**
 * List the media Zalo holds server-side for one conversation.
 *
 * Independent of the message sync: this enumerates a conversation's media even
 * for messages that were never synced. The self-chat ("Cloud của tôi") uses a
 * different domain and path, which is what `isSelfChat` selects.
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
