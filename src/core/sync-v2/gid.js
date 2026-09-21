/**
 * Tier-3 conversation-id resolution — the same path Zalo Web uses for peers not
 * in the local friend/group cache.
 *
 * A synced conversation is keyed by an opaque "global noised id". Friends and
 * current groups are resolved from their lists (both carry `globalId`). Everyone
 * else — non-friend 1-1s, OA/bot accounts — falls back to Zalo's profile server:
 *
 *   GET {profileDomain}/api/gid/decrypt   (cmd 12054)
 *     params = AES({ globalUids: JSON.stringify([id, …]) })
 *     -> { <globalNoisedId>: <userId> }
 *
 * We then batch `getUserInfo(userIds)` for display names. Left groups have no
 * per-item endpoint server-side, so they stay unresolved (matches Zalo Web).
 *
 * Built on zca-js's own request/crypto (`apiFactory` + bound `utils`) so the
 * authenticated envelope is exactly what the profile API expects; zca-js is
 * located via `require.resolve` so this survives whatever node_modules layout.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let _utils = null;
/** zca-js's internal utils (apiFactory/makeURL/encodeAES/request), located robustly. */
function zcaUtils() {
    if (_utils) return _utils;
    _utils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return _utils;
}

const GID_BATCH = 50;
const NAME_BATCH = 100;

/** Build the authenticated `/api/gid/decrypt` caller bound to this session. */
function makeGidDecrypt(api) {
    const zu = zcaUtils();
    const base = `${api.zpwServiceMap.profile[0]}/api/gid/decrypt`;
    return zu.apiFactory()((_api, ctx, utils) => async (globalIds) => {
        const enc = utils.encodeAES(JSON.stringify({ globalUids: JSON.stringify(globalIds), imei: ctx.imei }));
        if (!enc) throw new Error("failed to encrypt gid params");
        const resp = await utils.request(utils.makeURL(base, { params: enc }), { method: "GET" });
        const result = await utils.resolve(resp);
        // response shape: resolve() -> { data: { <globalId>: <userId> } } (or the map directly)
        return result && typeof result.data === "object" ? result.data : result || {};
    })(api.getContext(), api);
}

/**
 * Resolve opaque 1-1 global-noised ids to real numeric user ids + names.
 *
 * @param {object} api - logged-in zca-js api
 * @param {string[]} globalIds - the 32-char ids (partition without the `oneone/` prefix)
 * @param {(m: string) => void} [log]
 * @returns {Promise<Map<string, {id: string, name: string}>>} globalId -> {id, name}
 */
export async function resolveNonFriendDms(api, globalIds, log = () => {}) {
    const out = new Map();
    if (!globalIds || !globalIds.length) return out;

    // 1. globalId -> userId via /api/gid/decrypt (cmd 12054), batched.
    let gidDecrypt;
    try {
        gidDecrypt = makeGidDecrypt(api);
    } catch (e) {
        log(`gid/decrypt unavailable (${e.message}); non-friend 1-1s stay opaque`);
        return out;
    }
    const idToUser = new Map();
    for (let i = 0; i < globalIds.length; i += GID_BATCH) {
        const batch = globalIds.slice(i, i + GID_BATCH);
        let map;
        try {
            map = await gidDecrypt(batch);
        } catch (e) {
            log(`gid/decrypt batch failed (${e.message})`);
            continue;
        }
        for (const [gid, uid] of Object.entries(map || {})) if (uid) idToUser.set(gid, String(uid));
    }
    if (!idToUser.size) return out;

    // 2. userId -> display name via getUserInfo (batched). Best-effort.
    const names = new Map();
    const uids = [...new Set([...idToUser.values()])];
    for (let i = 0; i < uids.length; i += NAME_BATCH) {
        const batch = uids.slice(i, i + NAME_BATCH);
        try {
            const info = await api.getUserInfo(batch);
            for (const bag of [info?.changed_profiles, info?.unchanged_profiles]) {
                for (const [uid, p] of Object.entries(bag || {})) {
                    if (!names.has(uid) && p) names.set(uid, p.displayName || p.zaloName || "");
                }
            }
        } catch (e) {
            log(`getUserInfo batch failed (${e.message}); some names may be blank`);
        }
    }

    for (const [gid, uid] of idToUser) out.set(gid, { id: uid, name: names.get(uid) || "" });
    return out;
}
