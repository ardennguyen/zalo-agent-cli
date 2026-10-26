/**
 * Why was this session ended? (plan item L12b)
 *
 * After a kick the official client asks Zalo for the reason:
 * `POST {aext}/api/session/kickout-info` with the form field `token`. It is a read: it changes nothing on the
 * server. The answer is shown to the person ("you logged in on a different browser") instead of a bare disconnect.
 *
 * Where the key comes from (read in the Web client's code and seen live, 2026-10-26): the **getLoginInfo** answer
 * carries `auth_ext_info: {viewer_key, enk}`, and the Web client keeps both (`setDataKeyGetKickoutInfo`). The viewer
 * key (334 characters) is the form's `token`; the answer is sealed with `enk` (24 characters, a base64 AES-128 key)
 * in the session cipher's shape (zero IV), and opens to `{error_code, error_message, data: {kickoutSrc, kickoutTs}}`.
 * The zCloud key pair (`zcloud`, 216 characters) is a different key and gets error 112, which is how the first
 * attempt at this went wrong. `kickoutTs` is the moment the session was replaced, in seconds.
 *
 * What `kickoutSrc` means is the server's own table, `settings.features.kick_out_config[src]`: a title and a text in
 * English and Vietnamese. {@link describeKickout} reads it.
 *
 * A client that has no keys cannot ask, and says so rather than guessing: this function returns null when it
 * cannot learn the reason, for any cause. A kick has already been handled by the time it runs, so failing here is
 * never an error worth raising.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { decryptZCloud } from "../core/sync-v2/zcloud-cipher.js";

const require = createRequire(import.meta.url);
let utils = null;

/** zca-js internals, located the same way ../core/logout.js does. */
function zcaUtils() {
    utils ??= require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return utils;
}

/**
 * The keys the kickout lookup needs, as the login kept them.
 *
 * @param {object} api - a zca-js API from {@link loginWithSession}
 * @returns {{viewerKey: string, enk: string}|null} null when the server gave this session none
 */
export function kickoutKeysOf(api) {
    const z = api?.getContext?.()?.kickout;
    return z?.viewerKey && z?.enk ? { viewerKey: String(z.viewerKey), enk: String(z.enk) } : null;
}

/**
 * Open an answer sealed with `enk`: the session cipher's shape first (what Zalo does, seen live), then zCloud's.
 *
 * @returns {object|null}
 */
function openSealed(zu, data, enk) {
    try {
        const text = zu.decodeAES(enk, data);
        if (text) return JSON.parse(text);
    } catch {
        /* not that cipher */
    }
    try {
        return JSON.parse(decryptZCloud(data, enk));
    } catch {
        return null;
    }
}

/**
 * The words for a kick, from the server's own table.
 *
 * @param {{kickoutSrc?: number, kickoutTs?: number}|null} info - what {@link fetchKickoutInfo} returned
 * @param {object} [settings] - the session's `settings` (`features.kick_out_config`)
 * @param {"en"|"vi"} [lang]
 * @returns {{src: number|null, at: string|null, title: string|null, text: string|null}} fields the server did not
 *   describe are null
 */
export function describeKickout(info, settings, lang = "en") {
    const cfg = settings?.features?.kick_out_config?.[String(info?.kickoutSrc)];
    const pick = (v) => (v && typeof v === "object" ? (v[lang] ?? v.en ?? null) : null);
    const ts = Number(info?.kickoutTs);
    return {
        src:
            Number.isFinite(Number(info?.kickoutSrc)) && info?.kickoutSrc !== undefined
                ? Number(info.kickoutSrc)
                : null,
        at: ts > 0 ? new Date(ts * 1000).toISOString() : null,
        title: pick(cfg?.title),
        text: Array.isArray(cfg?.content) ? cfg.content.map(pick).filter(Boolean).join(" ") || null : null,
    };
}

/**
 * Ask Zalo why the session ended.
 *
 * @param {object} api - a zca-js API (its session may already be refused)
 * @param {{viewerKey: string, enk: string}|null} keys - from {@link kickoutKeysOf}
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object|null>} what Zalo said, or null when the reason could not be learned
 */
export async function fetchKickoutInfo(api, keys, { timeoutMs = 5000 } = {}) {
    if (!keys || typeof keys.viewerKey !== "string" || !keys.viewerKey || typeof keys.enk !== "string" || !keys.enk) {
        return null;
    }
    try {
        const zu = zcaUtils();
        const ctx = api.getContext();
        const host = ctx.loginInfo?.zpw_service_map_v3?.aext?.[0];
        if (!host) return null;
        const url = zu.makeURL(ctx, `${host}/api/session/kickout-info`, {});
        const res = await zu.request(ctx, url, {
            method: "POST",
            body: new URLSearchParams({ token: keys.viewerKey }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const body = JSON.parse(await res.text());
        if (body?.error_code !== undefined && Number(body.error_code) !== 0) return null;
        let data = body?.data;
        if (typeof data === "string" && data !== "") {
            // Sealed with `enk`, which a refused session key does not affect.
            const inner = openSealed(zu, data, keys.enk);
            if (!inner || typeof inner !== "object") return null;
            if (inner.error_code !== undefined && Number(inner.error_code) !== 0) return null;
            data = inner.data ?? inner;
        }
        return data && typeof data === "object" ? data : null;
    } catch {
        return null;
    }
}

/**
 * Ask Zalo why the session ended, with the keys the login kept, and add the server's own words for it.
 *
 * @param {object} api - a zca-js API from {@link loginWithSession}
 * @returns {Promise<object|null>} `{kickoutSrc, kickoutTs, src, at, title, text}`, or null when the reason could not
 *   be learned
 */
export async function lookupKickout(api) {
    const info = await fetchKickoutInfo(api, kickoutKeysOf(api));
    if (!info) return info;
    let settings;
    try {
        settings = api.getContext?.()?.settings;
    } catch {
        /* no settings: the numbers alone are shown */
    }
    return { ...info, ...describeKickout(info, settings) };
}
