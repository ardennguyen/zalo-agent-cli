/**
 * A logged-in session that never touches the network.
 *
 * Preloaded into a child `node src/index.js …` through
 * `NODE_OPTIONS=--import=<this file's URL>` (see ./offline-cli.js). It replaces
 * `globalThis.fetch` with a stub server that answers the two login calls
 * (`getServerInfo`, `getLoginInfo`), so the CLI's own login (src/zalo/login.js)
 * runs for real and builds the engine's real session object (src/zalo/api.js); the CLI
 * then runs its actual action code and the engine builds its actual requests.
 * Every request -- the area methods' and the custom calls this repo builds on
 * the session's bound helpers -- goes through `globalThis.fetch`, which here:
 *
 *   1. decrypts `params` with a throwaway session key, exactly as the server would,
 *   2. appends `{method, service, path, query, params}` as one JSON line to ZALO_OFFLINE_LOG, together with
 *      what the wire-diff harness compares: `url`, `queryOrder`, `rawParams` (the encrypted string),
 *      `headers` (lower-cased), `form` (a urlencoded body's fields), and `parts` (a multipart body's parts
 *      as `{name, filename, type, size, sha256}`),
 *   3. answers with a canned success (overridable per path).
 *
 * Any request to a host that is not the stub's own throws, so no code path can
 * reach the real network even by accident. Nothing here opens a socket or
 * reads real credentials; the ids and key are made up. The login calls are
 * answered but not logged: the log holds the commands' own requests.
 *
 * Environment:
 *   ZALO_OFFLINE_LOG        file that receives one JSON line per request (required)
 *   ZALO_OFFLINE_UID        uid of the fake session
 *   ZALO_OFFLINE_SEND2ME    `loginInfo.send2me_id`; "none" leaves the field out
 *   ZALO_OFFLINE_RESPONSES  optional JSON file mapping a request path to its answer:
 *                             <data>                                  answer with this data
 *                             { "__error": { "code": n, "message": s } }  answer with a Zalo error
 *                             { "__sequence": [answer, answer, …] }   one per call, last one repeats
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { openSession, sealSession } from "../../../src/zalo/kernel/cipher.js";
import { deriveEnk, sealLogin } from "../../../src/zalo/kernel/login-cipher.js";
import { parseMultipart, readBody } from "../../helpers/wire-diff/body.js";

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
 * Every service key the engine resolves, mapped to a host that names it. A
 * missing key fails only the call that needs it.
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
 * @returns {unknown} what the session's reply decoding should hand back as `data`
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
    const body = { error_code: 0, error_message: "Successful.", data: sealSession(KEY, JSON.stringify(inner)) };
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
    const headers = Object.fromEntries(new Headers(init.headers ?? {}));
    const body = await readBody(init.body);
    if (body.contentType && !headers["content-type"]) headers["content-type"] = body.contentType;
    const type = headers["content-type"] ?? "";
    const form =
        body.bytes && /^application\/x-www-form-urlencoded/i.test(type)
            ? Object.fromEntries(new URLSearchParams(body.bytes.toString("utf8")))
            : null;
    const parts =
        body.bytes && /^multipart\//i.test(type)
            ? (parseMultipart(body.bytes, type) ?? []).map((p) => ({
                  name: p.name,
                  filename: p.filename,
                  type: p.type,
                  size: p.bytes.length,
                  sha256: createHash("sha256").update(p.bytes).digest("hex"),
              }))
            : null;
    let enc = null;
    if (typeof form?.params === "string") enc = form.params;
    if (!enc && u.searchParams.get("params")) enc = u.searchParams.get("params");
    const rawParams = enc;
    let params = enc ? openSession(KEY, enc) : null;
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
            JSON.stringify({
                method: init.method || "GET",
                service,
                path: u.pathname,
                query,
                params,
                url: String(url),
                queryOrder: [...u.searchParams.keys()],
                rawParams,
                headers,
                form,
                parts,
            }) + "\n",
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

/** The server settings the session reads: the socket's retry table, and `sharefile` for uploads. */
const SETTINGS = {
    features: {
        sharefile: { max_file: 10, max_size_share_file_v3: 1024, chunk_size_file: 3145728, restricted_ext_file: [] },
        socket: { retries: {}, close_and_retry_codes: [], rotate_error_codes: [], ping_interval: 60000 },
    },
};

const json = (body) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** The stub server: the login calls, then the stub services; anything else is refused. */
globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/login/getServerInfo") {
        return json({ error_code: 0, error_message: "", data: { settings: SETTINGS, extra_ver: {} } });
    }
    if (u.pathname === "/api/login/getLoginInfo") {
        // The answer is sealed with a key derived from zcid and zcid_ext: derive the same one.
        const enk = deriveEnk(u.searchParams.get("zcid"), u.searchParams.get("zcid_ext"));
        const loginInfo = {
            uid: UID,
            zpw_enk: KEY,
            zpw_service_map_v3: SERVICE_MAP,
            zpw_ws: ["wss://ws.offline.invalid/"],
            ...(SEND2ME && SEND2ME !== "none" ? { send2me_id: SEND2ME } : {}),
        };
        const payload = { error_code: 0, error_message: "", data: loginInfo };
        return json({ error_code: 0, error_message: "", data: sealLogin(enk, payload) });
    }
    if (u.hostname.endsWith(".offline.invalid")) return offlineFetch(url, init);
    throw new Error(`offline test session: refusing to fetch ${url}`);
};
