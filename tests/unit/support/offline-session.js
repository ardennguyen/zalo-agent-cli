/**
 * A logged-in zca-js session that never touches the network.
 *
 * Preloaded into a child `node src/index.js …` through
 * `NODE_OPTIONS=--import=<this file's URL>` (see ./offline-cli.js). It replaces
 * `Zalo.prototype.login` with one that builds zca-js's real `API` on a stub
 * context, so the CLI runs its actual action code and zca-js builds its actual
 * requests. Every request -- zca-js's own and the custom calls this repo builds
 * on zca-js's `apiFactory` -- goes through `ctx.options.polyfill`, which here:
 *
 *   1. decrypts `params` with a throwaway session key, exactly as the server would,
 *   2. appends `{method, service, path, params}` as one JSON line to ZALO_OFFLINE_LOG,
 *   3. answers with a canned success (overridable per path).
 *
 * `globalThis.fetch` is replaced with a function that throws, so no code path
 * can reach the real network even by accident. Nothing here logs in, opens a
 * socket, or reads real credentials; the ids and key are made up.
 *
 * Environment:
 *   ZALO_OFFLINE_LOG        file that receives one JSON line per request (required)
 *   ZALO_OFFLINE_UID        uid of the fake session
 *   ZALO_OFFLINE_SEND2ME    `loginInfo.send2me_id`; "none" leaves the field out
 *   ZALO_OFFLINE_RESPONSES  optional JSON file mapping a request path to its answer:
 *                             <data>                                  answer with this data
 *                             { "__error": { "code": n, "message": s } }  answer with a Zalo error
 *                             { "__sequence": [answer, answer, …] }   one per call, last one repeats
 *   ZALO_OFFLINE_UNPATCHED  "1" strips the cliMsgId patches/zca-js+2.2.0.patch
 *                           stamps onto a send result, to reproduce an install
 *                           where the patch did not apply (upstream returns only
 *                           {msgId})
 */
import { appendFileSync, readFileSync } from "node:fs";
import { Zalo, API } from "zca-js";

const DIST = new URL(".", import.meta.resolve("zca-js"));
const { createContext } = await import(new URL("context.js", DIST).href);
const { encodeAES, decodeAES } = await import(new URL("utils.js", DIST).href);

/** Throwaway 128-bit session key. Only this process and its log ever see it. */
const KEY = Buffer.alloc(16, 7).toString("base64");

const LOG = process.env.ZALO_OFFLINE_LOG;
const UID = process.env.ZALO_OFFLINE_UID || "100000000000000001";
const SEND2ME = process.env.ZALO_OFFLINE_SEND2ME;

/** Per-path response overrides, read once. */
const OVERRIDES = (() => {
    const file = process.env.ZALO_OFFLINE_RESPONSES;
    if (!file) return {};
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return {};
    }
})();

/**
 * Every service key zca-js or this repo resolves, mapped to a host that names
 * it. zca-js reads `zpwServiceMap.<key>[0]` in each factory at construction
 * time, so a missing key fails the whole login, not just one call.
 */
const SERVICES = [
    "aext",
    "alias",
    "auto_reply",
    "catalog",
    "chat",
    "conversation",
    "file",
    "friend",
    "friend_board",
    "group",
    "group_board",
    "group_cloud_message",
    "group_poll",
    "label",
    "profile",
    "quick_message",
    "reaction",
    "sticker",
    "zavi",
    "zcloud",
    "zimsg",
];
const SERVICE_MAP = Object.fromEntries(SERVICES.map((k) => [k, [`https://${k.replace(/_/g, "-")}.offline.invalid`]]));

let nextId = 8000000000001;
const newMsgId = () => String(nextId++);

/**
 * The canned answer for one request, before any override.
 *
 * @param {string} path
 * @param {object|null} params - the decrypted request params
 * @returns {unknown} what zca-js's `resolve()` should hand back as `data`
 */
function cannedData(path, params) {
    if (/\/api\/(message\/sms|group\/sendmsg|group\/mention|group\/quote|message\/quote)$/.test(path)) {
        return { msgId: newMsgId() };
    }
    if (/\/api\/(message|group)\/reaction$/.test(path)) return { msgIds: [Number(newMsgId())] };
    if (/\/api\/(message|group)\/mforward$/.test(path)) {
        const targets = params?.grids || params?.toIds || [];
        return { success: targets.map((t) => ({ clientId: t.clientId, msgId: newMsgId() })), failed: [] };
    }
    if (path.endsWith("/api/board/topic/createv2")) {
        return {
            id: "910000001",
            type: params?.type,
            params: params?.params,
            createTime: 1700000900000,
            editTime: 1700000900000,
        };
    }
    if (path.endsWith("/api/board/pin/list")) return { items: [], boardVersion: 1 };
    if (path.endsWith("/api/board/unpinv2")) return "";
    if (path.endsWith("/api/friendboard/list")) return { data: [], version: 1 };
    if (path.endsWith("/api/friendboard/create")) {
        return { data: { id: "920000001", type: 2, params: params?.topic?.params }, version: 2 };
    }
    if (path.endsWith("/api/friendboard/multi_unpin")) return { data: null, version: 3 };
    if (path.endsWith("/api/gid/decrypt")) return {};
    return { __unexpected: path };
}

/** Wrap `data` the way Zalo does: an outer envelope around a session-encrypted inner one. */
function envelope(data, error) {
    const inner = error
        ? { error_code: error.code ?? 1, error_message: error.message ?? "offline stub error" }
        : { error_code: 0, error_message: "", data };
    const body = { error_code: 0, error_message: "Successful.", data: encodeAES(KEY, JSON.stringify(inner)) };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * The stub network: record, then answer.
 *
 * @param {string} url
 * @param {object} [init]
 * @returns {Promise<Response>}
 */
async function offlineFetch(url, init = {}) {
    const u = new URL(url);
    let enc = null;
    if (init.body instanceof URLSearchParams) enc = init.body.get("params");
    if (!enc && u.searchParams.get("params")) enc = u.searchParams.get("params");
    let params = enc ? decodeAES(KEY, enc) : null;
    try {
        params = params ? JSON.parse(params) : params;
    } catch {
        /* keep the plaintext string */
    }
    const service = u.hostname.replace(/\.offline\.invalid$/, "").replace(/-/g, "_");
    const query = Object.fromEntries([...u.searchParams.entries()].filter(([k]) => k !== "params"));
    if (LOG) {
        appendFileSync(
            LOG,
            JSON.stringify({ method: init.method || "GET", service, path: u.pathname, query, params }) + "\n",
        );
    }
    const call = (calls.get(u.pathname) || 0) + 1;
    calls.set(u.pathname, call);
    let answer = OVERRIDES[u.pathname];
    if (answer && typeof answer === "object" && Array.isArray(answer.__sequence)) {
        answer = answer.__sequence[Math.min(call, answer.__sequence.length) - 1];
    }
    if (answer && typeof answer === "object" && answer.__error) return envelope(null, answer.__error);
    return envelope(answer !== undefined ? answer : cannedData(u.pathname, params));
}

/** How many times each path has been called in this process, for `__sequence`. */
const calls = new Map();

globalThis.fetch = async (url) => {
    throw new Error(`offline test session: refusing to fetch ${url}`);
};

Zalo.prototype.login = async function offlineLogin(credentials) {
    const ctx = createContext(this.options.apiType, this.options.apiVersion);
    Object.assign(ctx.options, this.options);
    ctx.options.polyfill = offlineFetch;
    ctx.options.checkUpdate = false;
    ctx.imei = credentials.imei;
    ctx.userAgent = credentials.userAgent;
    ctx.language = credentials.language || "vi";
    ctx.cookie = { getCookieString: async () => "", getCookieStringSync: () => "", setCookie: async () => {} };
    ctx.secretKey = KEY;
    ctx.uid = UID;
    // Only what zca-js reads while constructing the API: the Listener walks
    // `socket.retries` in its constructor, send/upload read `sharefile`.
    ctx.settings = {
        features: {
            sharefile: {
                max_file: 10,
                max_size_share_file_v3: 1024,
                chunk_size_file: 3145728,
                restricted_ext_file: [],
            },
            socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 60000 },
        },
    };
    ctx.loginInfo = {
        uid: UID,
        zpw_service_map_v3: SERVICE_MAP,
        ...(SEND2ME && SEND2ME !== "none" ? { send2me_id: SEND2ME } : {}),
    };
    const api = new API(ctx, SERVICE_MAP, ["wss://ws.offline.invalid/"]);
    if (process.env.ZALO_OFFLINE_UNPATCHED === "1") {
        const patchedSend = api.sendMessage;
        api.sendMessage = async (...args) => {
            const result = await patchedSend(...args);
            if (result?.message) delete result.message.cliMsgId;
            return result;
        };
    }
    return api;
};
