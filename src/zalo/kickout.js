/**
 * Why was this session ended? (plan item L12b)
 *
 * After a kick the official client asks Zalo for the reason:
 * `POST {aext}/api/session/kickout-info` with the form field `token`. It is a read: it changes nothing on the
 * server. The answer is shown to the person ("another device signed in") instead of a bare disconnect.
 *
 * Where the key comes from (read in the Web client's code, 2026-10-25): the login answers carry
 * `zcloud: {viewer_key, enk}`. The Web client keeps both; the viewer key is the form's `token`, and the answer is
 * sealed with `enk`, not with the session key (which a kick has just ended). Which cipher `enk` drives has not
 * been seen on the wire: zCloud's (a random IV in front) is tried first, then the session cipher's shape.
 * {@link kickoutKeysOf} reads the keys from the session the login built.
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
 * The keys the kickout lookup needs, as a login keeps them.
 *
 * @param {object} api - a zca-js API from {@link loginWithSession}
 * @returns {{viewerKey: string, enk: string}|null} null when the server gave this session none
 */
export function kickoutKeysOf(api) {
    const z = api?.getContext?.()?.zcloud;
    return z?.viewerKey && z?.enk ? { viewerKey: String(z.viewerKey), enk: String(z.enk) } : null;
}

/**
 * Open an answer sealed with `enk`: the zCloud cipher first, then the session cipher's shape.
 *
 * @returns {object|null}
 */
function openSealed(zu, data, enk) {
    try {
        return JSON.parse(decryptZCloud(data, enk));
    } catch {
        /* not that cipher */
    }
    try {
        const text = zu.decodeAES(enk, data);
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
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
