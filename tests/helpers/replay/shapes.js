/**
 * What the official Zalo Web client sends, written by hand as shapes: call
 * order, hosts, paths, and the NAMES (and a few fixed values) of query keys,
 * form keys and frame fields. No ids, tokens, cookies or captured payloads.
 *
 * These are the facts the v3.0 work is checked against. They were verified on
 * the wire against the Zalo Web client at version 694; a shape here changes
 * only when the official client is seen to change, and the diff is reviewed.
 * A shape says what the official client does, never what our code does today:
 * the tests that use them pin today's differences separately.
 */

/**
 * The boot of a logged-in Web client, the calls that carry our identity.
 * The socket upgrade follows `login-info` within about a second; it is not an
 * HTTP call and is not listed.
 *
 * Both server-info calls carry the server's disaster-recovery settings the
 * client stored from an earlier answer (`sp_mtn`, `bkt`), or -1 and -1 when it
 * has stored none. The first adds `viewerKey` when one is stored; the second
 * adds `floatMenuPos`. So only the NAMES of these keys are fixed here.
 *
 * @type {import("./replay.js").CallShape[]}
 */
export const WEB_BOOT = [
    {
        id: "server-info (first)",
        method: "GET",
        host: "wpa.chat.zalo.me",
        path: "/api/login/getServerInfo",
        query: { required: ["imei", "type", "client_version", "computer_name", "signkey", "sp_mtn", "bkt"] },
    },
    {
        id: "login-info",
        method: "GET",
        host: "wpa.chat.zalo.me",
        path: "/api/login/getLoginInfo",
        query: {
            required: ["zcid", "zcid_ext", "params", "type", "client_version", "signkey"],
            equals: { enc_ver: "v2" },
            // The login calls announce the version as client_version; the
            // zpw_ver / zpw_type pair belongs to the API calls after login.
            forbidden: ["zpw_ver", "zpw_type"],
        },
    },
    {
        id: "server-info (second)",
        method: "GET",
        host: "wpa.chat.zalo.me",
        path: "/api/login/getServerInfo",
        query: {
            required: ["imei", "type", "client_version", "computer_name", "signkey", "sp_mtn", "bkt", "floatMenuPos"],
        },
    },
];

/**
 * The QR login on id.zalo.me, in order. Every call carries `continue` (the
 * chat origin) and `v` (the id page's build number, taken from its script
 * name). There is no `verify-client` call.
 *
 * @type {import("./replay.js").CallShape[]}
 */
export const WEB_QR_LOGIN = [
    { id: "id page", method: "GET", host: "id.zalo.me", path: "/account", query: { required: ["continue"] } },
    {
        id: "logininfo",
        method: "POST",
        host: "id.zalo.me",
        pathEndsWith: "/logininfo",
        form: { required: ["continue", "v"] },
    },
    {
        id: "qr generate",
        method: "POST",
        host: "id.zalo.me",
        pathEndsWith: "/authen/qr/generate",
        form: { required: ["continue", "v", "cliGenQR"] },
    },
    {
        id: "waiting-scan",
        method: "POST",
        host: "id.zalo.me",
        pathEndsWith: "/authen/qr/waiting-scan",
        repeats: true, // a long poll: asked again until the phone scans
        form: { required: ["continue", "v", "code"] },
    },
    {
        id: "waiting-confirm",
        method: "POST",
        host: "id.zalo.me",
        pathEndsWith: "/authen/qr/waiting-confirm",
        repeats: true, // a long poll: asked again until the phone confirms
        form: { required: ["continue", "v", "code", "bundle"] },
    },
    {
        id: "checksession",
        method: "GET",
        host: "id.zalo.me",
        pathEndsWith: "/checksession",
        query: { required: ["continue"] },
    },
    {
        id: "syncsession",
        method: "GET",
        host: "jr.zaloapp.com",
        path: "/jr/syncsession",
        query: { required: ["token"] },
    },
    {
        id: "pushsession",
        method: "GET",
        host: "jr.chat.zalo.me",
        path: "/jr/pushsession",
        query: { required: ["token", "continue"] },
    },
];

/**
 * The calls no verified Web login makes.
 *
 * @type {Array<{host: string, path: string}>}
 */
export const WEB_QR_LOGIN_FORBIDDEN = [{ host: "id.zalo.me", path: "/verify-client" }];

/**
 * The official logout, in order. The same calls whether local data is kept or
 * deleted: that choice is local. The profile host is the service-map `profile`
 * host; the logout host is the staging `stg-wpa` host.
 *
 * @type {import("./replay.js").CallShape[]}
 */
export const WEB_LOGOUT = [
    {
        id: "logout-token",
        method: "POST",
        host: "id.zalo.me",
        path: "/jr/logout-token",
        form: { required: ["continue"] },
    },
    {
        id: "profile deactive",
        method: "GET",
        host: "service:profile",
        path: "/api/social/profile/deactive",
        query: { required: ["params"] },
    },
    {
        id: "v2 logout",
        method: "POST",
        host: "stg-wpa.chat.zalo.me",
        path: "/api/v2/login/logOut",
        form: { required: ["params"] },
    },
    {
        id: "account logout",
        method: "POST",
        host: "id.zalo.me",
        path: "/account/logout",
        form: { required: ["token"] },
    },
    {
        id: "setsid (zaloapp)",
        method: "GET",
        host: "jr.zaloapp.com",
        path: "/jr/setsid",
        query: { required: ["token"] },
    },
    { id: "setsid (chat)", method: "GET", host: "jr.chat.zalo.me", path: "/jr/setsid", query: { required: ["token"] } },
    { id: "login page", method: "GET", host: "id.zalo.me", path: "/account", query: { required: ["continue"] } },
];

/** There is no production `GET /api/login/logOut` in the official client. */
export const WEB_LOGOUT_FORBIDDEN = [{ host: "wpa.chat.zalo.me", path: "/api/login/logOut" }];

/**
 * Socket frame bodies the official client sends, by command.
 *
 * @type {Record<string, import("./replay.js").BodyShape>}
 */
export const WEB_FRAMES = {
    /** A transfer-sync request (cmd 590): the body of the frame, as `{data, reqId}`. */
    590: {
        required: ["data", "reqId"],
        nested: {
            data: {
                required: [
                    "syncId",
                    "syncType",
                    "ek",
                    "ik",
                    "toDevice",
                    "tempKey",
                    "deviceName",
                    "req",
                    "ver",
                    "ussidx",
                ],
                equals: { syncType: 0, toDevice: 0, tempKey: "" },
                nested: { req: { required: ["type", "priority", "queries", "batchSize"] } },
            },
        },
    },
    /** A transfer-sync dispose (cmd 591). */
    591: {
        required: ["data", "reqId"],
        nested: { data: { required: ["syncId", "toDevice", "reason"], equals: { toDevice: 0 } } },
    },
    /** A connect-time queue pull (cmds 510, 511, 515, 517, 518, 603, 610, 611). */
    pull: { required: ["first", "reqId", "lastId", "preIds"] },
    /** The key-id request sent at connect (cmd 564). */
    564: { required: ["data"], nested: { data: { equals: { platformType: 1 } } } },
    /** The queue-state request sent at connect (cmd 577). */
    577: { required: ["oneone", "group"] },
    /** The action-queue request sent at connect (cmd 537). */
    537: { required: ["lastId", "maxItem"] },
};
