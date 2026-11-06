/**
 * Intended differences between zca-js and our engine for the kernel area: one row per difference, each also recorded
 * in golden/kernel.js. Owned by package K1 (rows written by K2 when tests/unit/wire-kernel.test.js moved onto the
 * shared harness); no other package edits this file. Row shape and matching rules: tests/helpers/wire-diff/compare.js.
 * Every row says why, naming the Web method it follows.
 *
 * `keepAlive#http500` and the `kernel*` names are case names of wire-kernel.test.js: the bound helpers are not
 * methods of the session object, and an HTTP 500 is the one keepAlive case whose message differs.
 */
import { isDeepStrictEqual } from "node:util";

/** What the Web's me-v2 sends in the query besides the common params (spec-kernel L6). */
const isCode = (v) => typeof v === "string" && /^\d+$/.test(v);

/** @type {Array<{method: string, field: string, zca: unknown, own: unknown, why: string, when?: Function}>} */
export default [
    {
        method: "fetchAccountInfo",
        field: "queryOrder",
        zca: ["zpw_ver", "zpw_type"],
        own: ["zpw_ver", "zpw_type", "params", "os", "browser"],
        why: "L6: the Web's getMeV2 asks me-v2 with sealed params, then os and browser; zca-js sends no params",
    },
    {
        method: "fetchAccountInfo",
        field: "params",
        zca: null,
        own: (v) => isDeepStrictEqual(Object.keys(v ?? {}), ["avatar_size", "imei"]) && v.avatar_size === 160,
        why: "L6: the Web's getMeV2 seals {avatar_size: 160, imei}",
    },
    {
        method: "fetchAccountInfo",
        field: "paramsOrder",
        zca: null,
        own: ["avatar_size", "imei"],
        why: "L6: the Web's getMeV2 key order",
    },
    {
        method: "fetchAccountInfo",
        field: "query.os",
        zca: undefined,
        own: isCode,
        why: "L6: the Web's getMeV2 sends the os code src/zalo/profile.js derives from the User-Agent",
    },
    {
        method: "fetchAccountInfo",
        field: "query.browser",
        zca: undefined,
        own: isCode,
        why: "L6: the Web's getMeV2 sends the browser code src/zalo/profile.js derives from the User-Agent",
    },
    {
        method: "keepAlive#http500",
        field: "error.message",
        zca: "Request failed with status code 500",
        own: "HTTP 500",
        why: "our transport names the status itself (spec-kernel 9); the code stays null on both, never a Zalo code",
    },
    {
        method: "kernelMakeURL",
        field: "result.order",
        zca: "params,grid,zpw_ver,zpw_type",
        own: "zpw_ver,zpw_type,params,grid",
        why: "D1: the Web's _getCommonParams puts zpw_ver and zpw_type first; the same names and values otherwise",
    },
];
