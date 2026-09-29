/**
 * End a Zalo session at Zalo's servers, the way Zalo Web does.
 *
 * Zalo Web's logout is `GET https://wpa.chat.zalo.me/api/login/logOut` (cmd
 * 11135): the common params plus `{time, client_version, type, imei,
 * computer_name}` as a PLAIN query string. The web builds it with `_get()`, which
 * URL-encodes the object as-is — no AES `params=` — and `time` is unix seconds.
 *
 * The web also calls `logoutV2` — POST /api/v2/login/logOut on whatever
 * `getDevDomainV3()` returns, which live is the staging host `stg-wpa` — but only
 * as an extra step behind a server flag. Our patched zca-js implements that one,
 * and until 2026-09-30 it was the only call `logout` and `account remove` made.
 * The session survived it (tier 5). docs/agent-notes.md has how that went
 * unnoticed; the short version is that "ended" was claimed without looking.
 *
 * So "ended" is claimed here only after Zalo rejects a follow-up call —
 * `fetchAccountInfo`, the same call `whoami` makes — with the session error Zalo
 * answered right after a proven logout on 2026-09-19. Anything else is reported
 * as what it is.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Zalo Web's logout endpoint: the auth domain, not a service-map host. */
export const PRODUCTION_LOGOUT_URL = "https://wpa.chat.zalo.me/api/login/logOut";

/**
 * Error codes that mean "this session is no longer valid". 600 ("zpw_sek bị
 * thiếu hoặc không đúng") is what Zalo returned on the first authenticated call
 * after a proven logout. Only codes actually observed belong here: guessing more
 * would let an unrelated failure read as proof of logout.
 */
const SESSION_REJECTED = new Set([600]);

let _utils = null;
/** zca-js internals, located the same way ./sync-v2/board.js does. */
function zcaUtils() {
    if (_utils) return _utils;
    _utils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));
    return _utils;
}

/**
 * Send Zalo Web's production logout.
 *
 * @param {object} api - a logged-in zca-js API
 * @returns {Promise<*>} the response's `data`, decoded if it arrives encrypted
 * @throws {Error} carrying `.code` when Zalo answers with a non-zero error_code
 */
async function productionLogout(api) {
    const zu = zcaUtils();
    const call = zu.apiFactory()((_api, ctx, utils) => async () => {
        const url = utils.makeURL(PRODUCTION_LOGOUT_URL, {
            time: Math.floor(Date.now() / 1000),
            client_version: ctx.API_VERSION,
            type: ctx.API_TYPE,
            imei: ctx.imei,
            computer_name: "Web",
        });
        const resp = await utils.request(url, { method: "GET" });
        // Nobody has captured this call's response. logoutV2 answered in plain
        // JSON, so read it unencrypted; if `data` turns out to be an encrypted
        // string, decode it and honour an error code inside it.
        const data = await utils.resolve(resp, undefined, false);
        if (typeof data !== "string" || !data) return data;
        let inner;
        try {
            inner = JSON.parse(zu.decodeAES(ctx.secretKey, data));
        } catch {
            return data; // not an encrypted payload
        }
        if (inner?.error_code !== undefined && Number(inner.error_code) !== 0) {
            throw Object.assign(new Error(inner.error_message || `error_code ${inner.error_code}`), {
                code: inner.error_code,
            });
        }
        return inner?.data ?? inner;
    })(api.getContext(), api);
    return call();
}

/**
 * End this session at Zalo's servers.
 *
 * Runs the staging `logoutV2` first, while the session is still valid (the web's
 * optional extra step, best-effort), then the production logout, then asks
 * `fetchAccountInfo` whether the session survived.
 *
 * @param {object} api - a logged-in zca-js API
 * @returns {Promise<{
 *   v2: {ok: boolean, error?: string},
 *   production: {ok: boolean, error?: string, code?: number|null},
 *   verdict: "ended"|"still-answers"|"unverified",
 *   probeError?: string,
 * }>}
 */
export async function serverLogout(api) {
    const result = { v2: null, production: null, verdict: "unverified" };

    if (typeof api.logoutV2 === "function") {
        try {
            await api.logoutV2();
            result.v2 = { ok: true };
        } catch (e) {
            result.v2 = { ok: false, error: e.message };
        }
    } else {
        result.v2 = { ok: false, error: "logoutV2 is not available (unpatched zca-js)" };
    }

    try {
        await productionLogout(api);
        result.production = { ok: true };
    } catch (e) {
        result.production = { ok: false, error: e.message, code: e.code ?? null };
    }

    try {
        await api.fetchAccountInfo();
        result.verdict = "still-answers";
    } catch (e) {
        if (SESSION_REJECTED.has(Number(e?.code))) result.verdict = "ended";
        else result.probeError = e.message;
    }

    return result;
}

/**
 * What to tell the user about a serverLogout result, one line per fact.
 *
 * "Ended" is printed only for a verified end. A session that still answers is a
 * warning, never a success line — printing success unconditionally is exactly
 * how the staging-only logout passed for correct.
 *
 * @param {Awaited<ReturnType<typeof serverLogout>>} r - serverLogout's result
 * @returns {{level: "success"|"warning"|"info", text: string}[]}
 */
export function describeLogout(r) {
    const lines = [];
    if (!r.production.ok) {
        lines.push({ level: "warning", text: `Zalo's logout call failed: ${r.production.error}` });
        if (!r.v2.ok) lines.push({ level: "info", text: `The secondary logoutV2 call failed too: ${r.v2.error}` });
    }
    if (r.verdict === "ended") {
        lines.push({
            level: "success",
            text: "Server session ended — verified: Zalo rejected the next call on this session.",
        });
    } else if (r.verdict === "still-answers") {
        lines.push({
            level: "warning",
            text: "Zalo accepted the logout, but this session still answers — it may still be valid at Zalo.",
        });
    } else {
        lines.push({ level: "info", text: `Logout sent; could not verify the session ended: ${r.probeError}` });
    }
    return lines;
}

/**
 * Print a serverLogout result through the caller's output helpers.
 *
 * @param {Awaited<ReturnType<typeof serverLogout>>} r - serverLogout's result
 * @param {{success: Function, warning: Function, info: Function}} out - src/utils/output.js helpers
 */
export function reportLogout(r, out) {
    for (const { level, text } of describeLogout(r)) out[level](text);
}
