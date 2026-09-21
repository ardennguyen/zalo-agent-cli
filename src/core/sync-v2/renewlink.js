/**
 * Refresh an expired media URL — the same call Zalo Web makes when a photo,
 * video or file in the timeline has aged past its signed URL.
 *
 *   POST {fileDomain}/api/message/renewlink   (cmd 12094)
 *     params = AES({ toId, msgType, msgInfo, clientId, imei, isGroup })
 *     msgInfo = JSON({ normalUrl, hdUrl, thumbUrl, oriUrl, isE2EE, isOriginal })
 *
 * Zalo media lives in three places, and this covers only the first:
 *
 *   1. Zalo's CDN — the `href`/`thumb` in the sync payload. The signature has
 *      a lifetime tied to the message's age; while the server still holds the
 *      file, renewlink hands back fresh URLs. That is this module.
 *   2. zCloud (personal cloud) — a per-message E2EE backup, looked up by msgId.
 *      See ./zcloud.js.
 *   3. The sending device itself. No server path exists; the phone's own
 *      re-upload hints (`fileUrlToRenew`, `video_url_to_renew`) ride along in
 *      the sync payload and are preserved on the attachment record, but only
 *      the Zalo mobile client can act on them.
 *
 * Built on zca-js's apiFactory so the authenticated envelope matches what the
 * file service expects, the same way ./gid.js reaches /api/gid/decrypt.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let _utils = null;
function zcaUtils() {
    if (_utils) return _utils;
    _utils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return _utils;
}

/**
 * Zalo Web strips its internal `jxl` marker before sending a URL back for
 * renewal. Our URLs come straight off the wire and normally have none, so this
 * is defensive rather than load-bearing.
 */
function removeJxlProtocol(url) {
    if (typeof url !== "string") return url;
    return url.replace(/^jxl:\/\//i, "").replace(/\/jxl\//i, "/");
}

/** Group threads (and the self-chat) take the group form of the request. */
function isGroupThread(threadType) {
    return threadType === "group";
}

/**
 * Build a renewlink caller bound to this session.
 *
 * @param {object} api - logged-in zca-js api
 * @returns {(req: object) => Promise<object>}
 */
export function makeRenewLink(api) {
    const zu = zcaUtils();
    const base = `${api.zpwServiceMap.file[0]}/api/message/renewlink`;
    return zu.apiFactory()((_api, ctx, utils) => async ({ threadId, threadType, msgType, msgInfo, clientId }) => {
        const info = {
            ...msgInfo,
            normalUrl: removeJxlProtocol(msgInfo.normalUrl),
            hdUrl: removeJxlProtocol(msgInfo.hdUrl),
            thumbUrl: removeJxlProtocol(msgInfo.thumbUrl),
            oriUrl: removeJxlProtocol(msgInfo.oriUrl),
            isE2EE: 0,
            isOriginal: 0,
        };
        for (const k of Object.keys(info)) if (info[k] === undefined) delete info[k];

        const params = {
            toId: String(threadId),
            msgType: Number(msgType) || 0,
            msgInfo: JSON.stringify(info),
            clientId: String(clientId || Date.now()),
            imei: ctx.imei,
            isGroup: isGroupThread(threadType) ? 1 : 0,
        };
        const enc = utils.encodeAES(JSON.stringify(params));
        if (!enc) throw new Error("failed to encrypt renewlink params");
        const resp = await utils.request(utils.makeURL(base), {
            method: "POST",
            body: new URLSearchParams({ params: enc }),
        });
        return utils.resolve(resp);
    })(api.getContext(), api);
}

/**
 * Pull refreshed URLs out of a renewlink response.
 *
 * The response envelope is not documented anywhere and Zalo has more than one
 * shape for "here is the message again", so this reads defensively: it accepts
 * the URL bag at the top level, under `data`, or nested one level deeper, and
 * returns null when it finds nothing it recognises rather than guessing.
 *
 * @param {object} resp
 * @returns {{normalUrl?: string, hdUrl?: string, thumbUrl?: string, oriUrl?: string}|null}
 */
export function extractRenewedUrls(resp) {
    const KEYS = ["normalUrl", "hdUrl", "thumbUrl", "oriUrl", "url", "href"];
    const candidates = [resp, resp?.data, resp?.data?.data, resp?.data?.msgInfo, resp?.msgInfo];
    for (let c of candidates) {
        if (typeof c === "string") {
            try {
                c = JSON.parse(c);
            } catch {
                continue;
            }
        }
        if (!c || typeof c !== "object") continue;
        const found = {};
        for (const k of KEYS) if (typeof c[k] === "string" && /^https?:\/\//.test(c[k])) found[k] = c[k];
        if (Object.keys(found).length) {
            // `url`/`href` are aliases for the main download link.
            if (!found.normalUrl && (found.url || found.href)) found.normalUrl = found.url || found.href;
            delete found.url;
            delete found.href;
            return found;
        }
    }
    return null;
}
