/**
 * Zalo requests built on zca-js's own session envelope.
 *
 * Some requests Zalo Web makes have no zca-js function at all (message
 * pin/unpin), and for others zca-js cannot send what the web sends
 * (`forwardMessage` hardcodes the decorLog's `st` to 1). `patches/` is not the
 * place for new endpoints, so these are built here on zca-js's `apiFactory`,
 * which hands over the same pieces every zca-js call uses: `makeURL` (adds
 * zpw_ver/zpw_type), the session AES, the cookie and header handling in
 * `request`, and the response decoding in `resolve` -- which throws a
 * ZaloApiError carrying Zalo's error code. Only the path and the params are
 * ours. This is the pattern src/core/sync-v2/board.js established.
 *
 * zca-js's internals are located the way board.js and gid.js locate them.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let _utils = null;

/**
 * zca-js's internal utils: apiFactory, makeURL, encodeAES, request, resolve.
 *
 * @returns {object}
 */
export function zcaUtils() {
    if (_utils) return _utils;
    _utils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return _utils;
}

/**
 * Run one request with a logged-in session's context and zca-js's bound utils.
 *
 * Refuses a context without a session key up front: zca-js's own check would
 * put the whole context -- imei and cookies included -- into its error text.
 *
 * @template T
 * @param {object} api - a logged-in zca-js API
 * @param {(ctx: object, utils: object) => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function customCall(api, body) {
    const ctx = api.getContext();
    if (!ctx?.secretKey) throw new Error("Not logged in. Run: zalo-agent login");
    return zcaUtils().apiFactory()((_api, context, utils) => () => body(context, utils))(ctx, api)();
}

/**
 * Encrypt `params` into the query string and GET `base`.
 *
 * @param {object} utils - the utils `customCall` hands its body
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
 * @param {object} utils - the utils `customCall` hands its body
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
