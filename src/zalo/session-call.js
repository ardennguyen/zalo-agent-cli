/**
 * Zalo requests the engine builds by hand on the session envelope.
 *
 * Some requests Zalo Web makes have no endpoint module of their own (message pin/unpin), and for others the engine
 * needs to send exactly what the web sends (`forwardMessage`'s decorLog `st`). They are built here on the kernel's
 * bound helpers (src/zalo/kernel/bound.js): `makeURL` (`zpw_ver`/`zpw_type` first), the session cipher, the
 * transport (headers, cookies), and the reply decoding in `resolve`, which throws a `ZaloApiError` carrying Zalo's
 * error code. Only the path and the params are the caller's.
 */
import { boundUtils } from "./kernel/bound.js";

/**
 * Run one request with a logged-in session's context and its bound helpers.
 *
 * Refuses a context without a session key up front, with an error that holds nothing of the context.
 *
 * @template T
 * @param {object} api - a logged-in session
 * @param {(ctx: object, utils: import("./kernel/bound.js").BoundUtils) => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function customCall(api, body) {
    const ctx = api.getContext();
    if (!ctx?.secretKey) throw new Error("Not logged in. Run: zalo-agent login");
    return body(ctx, boundUtils(api));
}

/**
 * Encrypt `params` into the query string and GET `base`.
 *
 * @param {import("./kernel/bound.js").BoundUtils} utils - the helpers `customCall` hands its body
 * @param {string} base - endpoint URL without a query
 * @param {object} params
 * @returns {Promise<unknown>} the decoded `data`
 */
export async function getWithParams(utils, base, params) {
    const enc = utils.encodeAES(JSON.stringify(params));
    if (!enc) throw new Error("Failed to encrypt params");
    return utils.resolve(await utils.request(utils.makeURL(base, { params: enc }), { method: "GET" }));
}

/**
 * Encrypt `params` into a form body and POST it to `base`.
 *
 * @param {import("./kernel/bound.js").BoundUtils} utils - the helpers `customCall` hands its body
 * @param {string} base - endpoint URL without a query
 * @param {object} params
 * @returns {Promise<unknown>} the decoded `data`
 */
export async function postWithParams(utils, base, params) {
    const enc = utils.encodeAES(JSON.stringify(params));
    if (!enc) throw new Error("Failed to encrypt params");
    const body = new URLSearchParams({ params: enc });
    return utils.resolve(await utils.request(utils.makeURL(base), { method: "POST", body }));
}
