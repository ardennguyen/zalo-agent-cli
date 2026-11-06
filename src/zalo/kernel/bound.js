/**
 * The four helpers the engine's own hand-built calls use, bound to one session: build a URL, seal params, send a
 * request, decode the reply. A drop-in for what those calls took from zca-js's `apiFactory` (spec-kernel 9), so
 * each caller changes one line.
 *
 * The session must be logged in (have its key): a session without one is refused with a plain "not logged in"
 * error, which never carries the context (zca-js put the whole context, imei and cookies included, into its text).
 */
import { openSession } from "./cipher.js";
import { buildUrl, decodeReply, httpRequest, sealParams } from "./http.js";

/**
 * @typedef {object} BoundUtils
 * @property {(base: string, params?: Record<string, unknown>) => string} makeURL - adds `zpw_ver`/`zpw_type` first
 * @property {(text: string) => string} encodeAES - seals text with the session key
 * @property {(data: string) => string|null} decodeAES - opens what the session key sealed
 * @property {(url: string, init?: object) => Promise<Response>} request - the session's transport; no timeout
 *   unless `init.timeoutMs` says so; a caller's `redirect: "manual"` has the redirects followed here, hop by hop
 * @property {(res: Response, cb?: Function, isEncrypted?: boolean) => Promise<any>} resolve - the reply's data
 */

/**
 * The helpers of one logged-in session.
 *
 * @param {{getContext: () => object}} api
 * @returns {BoundUtils}
 * @throws {Error} "Not logged in" when the session has no key
 */
export function boundUtils(api) {
    const ctx = api?.getContext?.();
    if (!ctx?.secretKey) throw new Error("Not logged in. Run: zalo-agent login");
    return {
        makeURL: (base, params = {}) => buildUrl(ctx, base, params),
        encodeAES: (text) => sealParams(ctx, text),
        decodeAES: (data) => openSession(ctx.secretKey, data),
        request: (url, init = {}) => {
            const { redirect, ...rest } = init;
            const follow = rest.follow ?? (redirect === "manual" ? "jar" : "auto");
            return httpRequest(ctx, url, { timeoutMs: 0, ...rest, follow });
        },
        resolve: async (res, cb, isEncrypted = true) => {
            const data = await decodeReply(ctx, res, { encrypted: isEncrypted !== false });
            return cb ? cb({ data, error: null }) : data;
        },
    };
}
