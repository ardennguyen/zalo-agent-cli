/**
 * A stand-in for a logged-in zca-js session, for the tests of the web-call tables (reads and writes): the api's
 * requests land in `calls` through zca-js's own HTTP seam (`ctx.options.polyfill`), so what is under test is what
 * goes out on the wire. Keys, ids and hosts are throwaway constants (AGENTS.md §12).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const zcaRequire = createRequire(require.resolve("zca-js"));
export const { encodeAES, decodeAES } = zcaRequire("./utils.cjs");

export const SESSION_KEY = Buffer.alloc(16, 0x11).toString("base64");
export const IMEI = "test-imei-0000";

/** The service-map keys the web client's domain manager knows (module `pUq9`), plus the ones the tables use. */
export const SERVICE_KEYS = new Set([
    "ai_features",
    "alias",
    "chat",
    "conversation",
    "file",
    "friend",
    "friend_board",
    "group",
    "group_cloud_message",
    "label",
    "group_board",
    "boards",
    "profile",
    "reaction",
    "recent_search",
    "sticker",
    "sync_action",
    "emoji_stt",
    "banner",
]);

/** The base URL the harness gives a service-map key. */
export function host(key) {
    return `https://${key.replace(/_/g, "-")}.test.invalid`;
}

/** A fetch response. */
export const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
});

/** A reply in the session envelope, around `data`. */
export const sessionOk = (data) =>
    response({
        error_code: 0,
        error_message: "Successful.",
        data: encodeAES(SESSION_KEY, JSON.stringify({ error_code: 0, error_message: "", data })),
    });

/** A logged-in-looking api whose every request lands in `calls`; `reply` answers them. */
export function harness(reply = () => sessionOk({ ok: true })) {
    const calls = [];
    const ctx = {
        secretKey: SESSION_KEY,
        imei: IMEI,
        userAgent: "zalo-agent-cli-offline-test",
        language: "vi",
        uid: "1001",
        API_VERSION: 694,
        API_TYPE: 30,
        options: {
            logging: false,
            agent: undefined,
            async polyfill(url, init = {}) {
                const u = new URL(url);
                const call = {
                    origin: u.origin,
                    path: u.pathname,
                    method: init.method || "GET",
                    headers: { ...(init.headers || {}) },
                    query: Object.fromEntries(u.searchParams),
                    form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null,
                };
                calls.push(call);
                return reply(call);
            },
        },
    };
    const zpwServiceMap = Object.fromEntries([...SERVICE_KEYS].map((k) => [k, [host(k)]]));
    return { api: { zpwServiceMap, getContext: () => ctx }, calls };
}

/** The JSON a request encrypted into `params`, wherever it sent it. */
export function sent(call) {
    const enc = call.method === "POST" ? call.form?.params : call.query.params;
    if (typeof enc !== "string") throw new Error("the call carries no params");
    return JSON.parse(decodeAES(SESSION_KEY, enc));
}
