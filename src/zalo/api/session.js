/**
 * The session's own calls: the keepalive and the account's profile.
 *
 * - `keepAlive()`: `GET {chat}/keepalive?zpw_ver&zpw_type&params`, `params` = sealed `{imei}` (Zalo Web, command
 *   11770). The reply is plain: its `data` is not sealed. The engine reads only `config_vesion` (Zalo's spelling).
 * - `fetchAccountInfo()`: `GET {profile}/api/social/profile/me-v2?zpw_ver&zpw_type&params&os&browser`, `params` =
 *   sealed `{avatar_size, imei}`, `os` and `browser` the numbers of the saved User-Agent (plan item L6). A session
 *   reply.
 */
import { AVATAR_SIZE, browserCodeOf, osCodeOf } from "../profile.js";

/** `GET {chat}/keepalive`. */
export const KEEP_ALIVE = Object.freeze({
    host: "chat",
    path: "/keepalive",
    cmd: 11770,
    method: "get",
    body: (_args, ctx) => ({ imei: ctx.imei }),
    reply: "plain",
});

/** `GET {profile}/api/social/profile/me-v2`. */
export const ME_V2 = Object.freeze({
    host: "profile",
    path: "/api/social/profile/me-v2",
    method: "get",
    body: (_args, ctx) => ({ avatar_size: AVATAR_SIZE, imei: ctx.imei }),
    query: (_args, ctx) => ({ os: osCodeOf(ctx.userAgent), browser: browserCodeOf(ctx.userAgent) }),
    reply: "session",
});

/**
 * The session calls, bound to one session handle.
 *
 * @param {import("../api.js").Session} s
 * @returns {{keepAlive: () => Promise<{config_vesion?: number}>, fetchAccountInfo: () => Promise<object>}}
 */
export function sessionMethods(s) {
    return {
        /** Tell Zalo this session is still here; answers the server's config version. */
        keepAlive: () => s.call(KEEP_ALIVE, {}),
        /** The logged-in account's own profile. */
        fetchAccountInfo: () => s.call(ME_V2, {}),
    };
}

/** Methods whose wire-kernel.test.js comparison passes: the switch answers these from our code. */
export const OWN_READY = new Set(["keepAlive", "fetchAccountInfo"]);
