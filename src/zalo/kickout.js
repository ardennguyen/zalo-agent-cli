/**
 * Why was this session ended? (plan item L12b)
 *
 * After a kick the official client asks Zalo for the reason:
 * `POST {aext}/api/session/kickout-info` with the form field `token`. It is a
 * read: it changes nothing on the server. The answer is shown to the person
 * ("another device signed in") instead of a bare disconnect.
 *
 * The call needs the session's `token` (the viewer key the Web client holds). A
 * client that has none cannot ask, and says so rather than guessing one: this
 * function is given the token by whoever has it and returns null when it cannot
 * learn the reason, for any cause. A kick has already been handled by the time
 * this runs, so failing here is never an error worth raising.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let utils = null;

/** zca-js internals, located the same way ../core/logout.js does. */
function zcaUtils() {
    utils ??= require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return utils;
}

/**
 * Ask Zalo why the session ended.
 *
 * @param {object} api - a zca-js API (its session may already be refused)
 * @param {string} token - the session's viewer key
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object|null>} what Zalo said, or null when the reason could not be learned
 */
export async function fetchKickoutInfo(api, token, { timeoutMs = 5000 } = {}) {
    if (!token || typeof token !== "string") return null;
    try {
        const zu = zcaUtils();
        const ctx = api.getContext();
        const host = ctx.loginInfo?.zpw_service_map_v3?.aext?.[0];
        if (!host) return null;
        const url = zu.makeURL(ctx, `${host}/api/session/kickout-info`, {});
        const res = await zu.request(ctx, url, {
            method: "POST",
            body: new URLSearchParams({ token }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const body = JSON.parse(await res.text());
        if (body?.error_code !== undefined && Number(body.error_code) !== 0) return null;
        let data = body?.data;
        if (typeof data === "string" && data !== "") {
            const inner = JSON.parse(zu.decodeAES(ctx.secretKey, data));
            if (inner?.error_code !== undefined && Number(inner.error_code) !== 0) return null;
            data = inner?.data ?? inner;
        }
        return data && typeof data === "object" ? data : null;
    } catch {
        return null;
    }
}
