/**
 * An offline stand-in for Zalo's login and REST servers, driven through the
 * REAL zca-js login flow, the real API factories and the real CLI commands.
 *
 * Not a test file (no `.test.js`), so `npm test` does not run it on its own.
 * A test that imports it reaches `src/core/credentials.js` and must import
 * `../helpers/sandbox.js` FIRST.
 *
 * ## How it intercepts the network
 *
 * zca-js reaches the network only through `ctx.options.polyfill`. With no
 * proxy configured, that is whatever `globalThis.fetch` was at the moment the
 * login context was created (`createContext()` in zca-js `dist/context.js`).
 * Installing `handle()` as globalThis.fetch before `loginWithCredentials()`
 * therefore routes every request of that session through here: zca-js's npm
 * version probe, `getLoginInfo`, `getServerInfo`, and every API call made on
 * the session afterwards. A request nothing here answers gets an HTTP 404 --
 * which is also exactly what the real server says to a retired endpoint.
 *
 * ## Why no socket can open
 *
 * The WebSocket URL handed out at login points at a reserved `.invalid` host,
 * and `listener.start()` is replaced after login with a refusal, delivered as
 * the listener's "error" event (or thrown, when nothing listens for one). A
 * code path that would have opened a socket fails loudly instead.
 *
 * ## The login cipher
 *
 * zca-js encrypts getLoginInfo's response key from the `zcid` and `zcid_ext`
 * it sends in the query (`ParamsEncryptor` in zca-js `dist/utils.js`), so this
 * derives the same key the real server does. Every later response is sealed
 * with a throwaway session key. Every id here is fake.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { loginWithCredentials } from "../../src/core/zalo-client.js";
import { addAccount } from "../../src/core/accounts.js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { _resetErrorLatch } from "../../src/utils/output.js";

const require = createRequire(import.meta.url);
const zu = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));

/** Fake identities. The uid is deliberately past 2^53, as real Zalo uids are. */
export const FAKE = Object.freeze({
    ownId: "1234567890123456789",
    imei: "00000000-0000-4000-8000-00000000fake-0123456789abcdef0123456789abcdef",
    sessionKey: Buffer.alloc(16, 7).toString("base64"),
});

/** What `saveCredentials()` would hold for the fake account. */
export const FAKE_CREDENTIALS = Object.freeze({
    imei: FAKE.imei,
    cookie: [{ key: "zpw_sek", value: "offline-test-cookie", domain: "chat.zalo.me", path: "/" }],
    userAgent: "Mozilla/5.0 (offline test)",
    language: "vi",
});

/**
 * Every service key a zca-js factory reads while the API object is being
 * built, plus the ones this repo's own custom calls use. A key missing here
 * makes `new API()` throw inside login.
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

/**
 * The fake host for a service key.
 *
 * @param {string} key - a zpw_service_map_v3 key, e.g. "group_cloud_message"
 * @returns {string} e.g. "group-cloud-message.zalo.invalid"
 */
export function serviceHost(key) {
    return `${key.replace(/_/g, "-")}.zalo.invalid`;
}

/** The subset of server settings zca-js reads while building a session. */
const SETTINGS = {
    features: {
        sharefile: {
            max_file: 10,
            max_size_share_file_v3: 1024,
            chunk_size_file: 3145728,
            restricted_ext_file: ["exe"],
            big_file_domain_list: [],
        },
        socket: { retries: {}, ping_interval: 60000, close_and_retry_codes: [], rotate_error_codes: [] },
    },
    keepalive: { alway_keepalive: 0, keepalive_duration: 0, time_deactive: 0 },
};

/** Deep-merge plain objects; arrays and scalars in `over` replace the base value. */
function mergeSettings(base, over) {
    const out = structuredClone(base);
    for (const [k, v] of Object.entries(over ?? {})) {
        out[k] =
            v &&
            typeof v === "object" &&
            !Array.isArray(v) &&
            out[k] &&
            typeof out[k] === "object" &&
            !Array.isArray(out[k])
                ? mergeSettings(out[k], v)
                : structuredClone(v);
    }
    return out;
}

/**
 * Install the fake server as globalThis.fetch.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.omit] - service keys to leave out of the login's service map
 * @param {string[]} [opts.wsUrls] - the WebSocket endpoints handed out at login. The default is a
 *   reserved `.invalid` host nothing can reach; tests/helpers/fake-zalo passes the URL of a real
 *   local socket here.
 * @param {object} [opts.settings] - merged (objects deep, everything else replaced) over the
 *   server settings getServerInfo returns, e.g. `{features: {socket: {retries: {...}}}}`
 * @param {{error_code: number, error_message?: string}} [opts.loginError] - answer getLoginInfo
 *   with this error instead of a session
 * @param {Array<object>} [opts.loginScript] - answers for the next getLoginInfo calls, consumed in order
 *   (see `scripted` below, plus `{sealedEnvelope}`: that envelope, sealed as a real answer is); once it runs
 *   out the normal answer is given
 * @param {Array<object>} [opts.serverInfoScript] - the same for getServerInfo
 * @param {Record<string, string>} [opts.serverInfoHeaders] - response headers of every getServerInfo answer
 *   (e.g. a `set-cookie`)
 * @returns {{
 *   requests: Array<{method: string, host: string, path: string, query: object, params: object|null,
 *     headers: object, form: object|null}>,
 *   calls: (pathPart: string) => Array<object>,
 *   route: (pathSuffix: string, handler: (req: object) => unknown) => void,
 *   rawRoute: (match: (req: object) => boolean, handler: (req: object) => Response) => void,
 *   clearRoutes: () => void,
 *   uninstall: () => void,
 * }}
 *   `requests` records EVERY request, the npm probe included, with `params`
 *   decrypted. A route handler's return value becomes the response's `data`. A raw route answers the
 *   requests its `match` accepts with the `Response` its handler returns, unsealed: for the id.zalo.me
 *   and jr.* pages, which are not Zalo API calls.
 */
export function installFakeZalo({
    omit = [],
    wsUrls = ["wss://ws.zalo.invalid/"],
    settings = {},
    loginError = null,
    loginScript = [],
    serverInfoScript = [],
    serverInfoHeaders = {},
} = {}) {
    const requests = [];
    const routes = new Map();
    const rawRoutes = [];
    const previous = globalThis.fetch;
    const serviceMap = Object.fromEntries(
        SERVICES.filter((k) => !omit.includes(k)).map((k) => [k, [`https://${serviceHost(k)}`]]),
    );

    const reply = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const sealed = (data) =>
        reply({
            error_code: 0,
            error_message: "Successful.",
            data: zu.encodeAES(FAKE.sessionKey, JSON.stringify({ error_code: 0, error_message: "Successful.", data })),
        });

    /**
     * One scripted answer: `{status}` an HTTP status with an empty body, `{body}` a JSON body, `{hang: true}`
     * never answers (until the request is aborted, as a stuck server would).
     */
    async function scripted(step, init) {
        if (step.hang) {
            await new Promise((_, reject) => {
                init.signal?.addEventListener("abort", () => reject(init.signal.reason));
            });
        }
        if (step.status) return reply({}, step.status);
        return reply(step.body);
    }

    /**
     * What a real fetch does with a redirect unless told `redirect: "manual"`: follow it itself, hop by hop,
     * and hand back only the last answer, so the cookies the earlier hops set never reach the caller.
     */
    async function handle(input, init = {}) {
        let res = await handleOnce(input, init);
        for (
            let hops = 0;
            hops < 10 && init.redirect !== "manual" && [301, 302, 303, 307, 308].includes(res.status);
            hops++
        ) {
            const next = new URL(res.headers.get("location"), String(input));
            res = await handleOnce(next, { ...init, method: "GET", body: undefined });
            input = next;
        }
        return res;
    }

    async function handleOnce(input, init = {}) {
        const url = new URL(String(input));
        const req = {
            method: String(init.method || "GET").toUpperCase(),
            host: url.host,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            params: null,
            headers: Object.fromEntries(new Headers(init.headers ?? {})),
            form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null,
        };
        Object.defineProperty(req, "signal", { value: init.signal, enumerable: false });
        requests.push(req);

        for (const raw of rawRoutes) if (raw.match(req)) return raw.handler(req);

        // zca-js asks npm whether it is current on every login.
        if (url.host === "registry.npmjs.org") return reply({}, 404);

        if (url.pathname === "/api/login/getLoginInfo") {
            const step = loginScript.shift();
            if (step?.sealedEnvelope) {
                // an envelope sealed with the key the request asked for, as Zalo answers a login it refuses
                const keyer = new zu.ParamsEncryptor({ type: 30, imei: "derive", firstLaunchTime: 1 });
                keyer.zcid = url.searchParams.get("zcid");
                keyer.zcid_ext = url.searchParams.get("zcid_ext");
                keyer.createEncryptKey();
                return reply({
                    error_code: 0,
                    error_message: "",
                    data: zu.ParamsEncryptor.encodeAES(
                        keyer.getEncryptKey(),
                        JSON.stringify(step.sealedEnvelope),
                        "base64",
                        false,
                    ),
                });
            }
            if (step) return scripted(step, init);
            if (loginError) {
                return reply({
                    error_code: loginError.error_code,
                    error_message: loginError.error_message ?? "",
                    data: null,
                });
            }
            const loginInfo = {
                uid: FAKE.ownId,
                zpw_enk: FAKE.sessionKey,
                zpw_service_map_v3: serviceMap,
                zpw_ws: wsUrls,
                send2me_id: "1000000000000000001",
            };
            // A request without zcid was sent unencrypted: answer it the same way.
            if (!url.searchParams.get("zcid")) return reply({ error_code: 0, error_message: "", data: loginInfo });
            const keyer = new zu.ParamsEncryptor({ type: 30, imei: "derive", firstLaunchTime: 1 });
            keyer.zcid = url.searchParams.get("zcid");
            keyer.zcid_ext = url.searchParams.get("zcid_ext");
            keyer.createEncryptKey();
            const payload = JSON.stringify({ error_code: 0, error_message: "", data: loginInfo });
            return reply({
                error_code: 0,
                error_message: "",
                data: zu.ParamsEncryptor.encodeAES(keyer.getEncryptKey(), payload, "base64", false),
            });
        }

        if (url.pathname === "/api/login/getServerInfo") {
            const step = serverInfoScript.shift();
            if (step) return scripted(step, init);
            return new Response(
                JSON.stringify({
                    error_code: 0,
                    error_message: "",
                    data: { settings: mergeSettings(SETTINGS, settings), extra_ver: {} },
                }),
                { status: 200, headers: { "content-type": "application/json", ...serverInfoHeaders } },
            );
        }

        const enc =
            url.searchParams.get("params") ?? (init.body instanceof URLSearchParams ? init.body.get("params") : null);
        if (enc) req.params = JSON.parse(zu.decodeAES(FAKE.sessionKey, enc));

        for (const [suffix, handler] of routes) {
            if (url.pathname.endsWith(suffix)) return sealed(await handler(req));
        }
        return reply({ error_code: 404, error_message: "Not Found" }, 404);
    }

    globalThis.fetch = handle;
    return {
        requests,
        calls: (pathPart) => requests.filter((r) => r.path.includes(pathPart)),
        route: (pathSuffix, handler) => routes.set(pathSuffix, handler),
        rawRoute: (match, handler) => rawRoutes.push({ match, handler }),
        clearRoutes: () => {
            routes.clear();
            rawRoutes.length = 0;
        },
        uninstall: () => {
            globalThis.fetch = previous;
        },
    };
}

/**
 * Make the fake answer the official logout's calls the way Zalo does: a token, the page that lists the
 * `setsid` URLs, and plain 200s for everything else on the id and jr domains. Returns what it served so a test
 * can say what it expects.
 *
 * @param {ReturnType<typeof installFakeZalo>} fake
 * @param {{token?: string, setsid?: string[]|null}} [opts] - `token: null` makes step 1 fail; `setsid` is the
 *   list the logout page names
 * @returns {{token: string|null, setsid: string[]}}
 */
export function serveOfficialLogout(
    fake,
    {
        token = "tok-offline-1",
        setsid = ["https://jr.zaloapp.com/jr/setsid?token=t1", "https://jr.chat.zalo.me/jr/setsid?token=t1"],
    } = {},
) {
    const html = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    fake.rawRoute(
        (r) => r.host === "id.zalo.me" && r.path === "/jr/logout-token",
        () =>
            new Response(JSON.stringify(token ? { error_code: 0, data: { token } } : { error_code: 1, data: null }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
    );
    fake.rawRoute(
        (r) => r.host === "id.zalo.me" && r.path === "/account/logout",
        () => {
            // Zalo's page writes the slashes escaped, as a script literal does.
            const listed = setsid.map((u) => `"${u.replaceAll("/", "\\/")}"`).join(",");
            return html(`<script>window.__d = { listSetSidUrls: [${listed}] };</script>`);
        },
    );
    fake.rawRoute(
        (r) => r.host === "id.zalo.me" || r.host === "jr.zaloapp.com" || r.host === "jr.chat.zalo.me",
        () => html("ok"),
    );
    fake.route("/api/social/profile/deactive", () => ({}));
    fake.route("/api/v2/login/logOut", () => ({}));
    return { token, setsid };
}

/**
 * Make the fake answer the id.zalo.me QR login the way Zalo does: the login page with its build number, the
 * QR, the two long polls, and the three-hop redirect that ends in the `zpw_sek` cookie.
 *
 * @param {ReturnType<typeof installFakeZalo>} fake
 * @param {object} [opts]
 * @param {Array<number|"hang">} [opts.scan] - answers of successive waiting-scan calls: an `error_code`
 *   (8 = not yet, 0 = scanned) or `"hang"` (never answers until aborted); the last one repeats
 * @param {Array<number|"hang">} [opts.confirm] - the same for waiting-confirm (0 = confirmed, -13 = declined)
 * @returns {{generated: number}} how many QR codes were generated
 */
export function serveQrLogin(fake, { scan = [8, 0], confirm = [0] } = {}) {
    const state = { generated: 0 };
    const json = (body) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const redirect = (location, extra = {}) => new Response(null, { status: 302, headers: { location, ...extra } });
    const poll = (script, data) => {
        let i = 0;
        return async (req) => {
            const step = script[Math.min(i++, script.length - 1)];
            if (step === "hang") {
                await new Promise((_, reject) => {
                    req.signal?.addEventListener("abort", () => reject(req.signal.reason));
                });
            }
            return json(step === 0 ? { error_code: 0, data } : { error_code: step, data: null });
        };
    };
    const route = (method, host, path, handler) =>
        fake.rawRoute((r) => r.method === method && r.host === host && r.path === path, handler);

    route(
        "GET",
        "id.zalo.me",
        "/account",
        () => new Response('<script src="https://stc-zlogin.zdn.vn/main-2606161423.js"></script>', { status: 200 }),
    );
    route("POST", "id.zalo.me", "/account/logininfo", () => json({ error_code: 0, data: {} }));
    route("POST", "id.zalo.me", "/account/authen/qr/generate", () => {
        state.generated++;
        return json({
            error_code: 0,
            data: { code: `qr-code-${state.generated}`, image: "data:image/png;base64,iVBORw0KGgo=" },
        });
    });
    route(
        "POST",
        "id.zalo.me",
        "/account/authen/qr/waiting-scan",
        poll(scan, { display_name: "Fake Person", avatar: "https://avatar.invalid/a.png" }),
    );
    route("POST", "id.zalo.me", "/account/authen/qr/waiting-confirm", poll(confirm, {}));
    route("GET", "id.zalo.me", "/account/checksession", () =>
        redirect("https://jr.zaloapp.com/jr/syncsession?token=fake-t1&continue=https%3A%2F%2Fchat.zalo.me%2F"),
    );
    route("GET", "jr.zaloapp.com", "/jr/syncsession", () =>
        redirect("https://jr.chat.zalo.me/jr/pushsession?token=fake-t2&continue=https%3A%2F%2Fchat.zalo.me%2F"),
    );
    route("GET", "jr.chat.zalo.me", "/jr/pushsession", () =>
        redirect("https://chat.zalo.me/", {
            "set-cookie": "zpw_sek=fake-sek-from-pushsession; Domain=chat.zalo.me; Path=/; HttpOnly; Secure",
        }),
    );
    route("GET", "chat.zalo.me", "/", () => new Response("<html></html>", { status: 200 }));
    return state;
}

/**
 * Register the fake account and log in through the real `loginWithCredentials`,
 * so `getApi()` returns a real zca-js API whose transport is the fake server.
 * Install the fake server first.
 *
 * @returns {Promise<object>} the zca-js API, with `listener.start` disabled
 */
export async function loginFake() {
    addAccount(FAKE.ownId, "Offline test account");
    // A logged-in account has its data dir. Without it every command's
    // initDb() fails quietly and its cache reads AND writes are skipped, so a
    // "wrote nothing" assertion could not fail.
    mkdirSync(join(CONFIG_DIR, "accounts", FAKE.ownId), { recursive: true });
    const { api } = await loginWithCredentials(structuredClone(FAKE_CREDENTIALS));
    api.listener.start = () => {
        const refusal = new Error("fake-zalo: offline tests never open a socket");
        // Fail the way a real connect failure does, through the listener's
        // "error" event, so a caller's own error handler (and its timers) run.
        // With no handler registered, throw: that must never pass silently.
        if (api.listener.listenerCount("error") === 0) throw refusal;
        queueMicrotask(() => api.listener.emit("error", refusal));
    };
    return api;
}

/**
 * Answer `msg history`'s socket scan from canned pages instead of a socket.
 *
 * On a session from {@link loginFake}: `start()` announces "connected", each
 * `requestOldMessages()` answers with the next page as an "old_messages" event
 * (an empty page once the pages run out, which ends the scan), and `stop()`
 * does nothing. Frames take the listener's own shape, `{threadId, type, data}`.
 *
 * @param {object} api - the API {@link loginFake} returned
 * @param {Array<Array<object>>} pages
 * @returns {{requests: Array<{threadType: number, lastId: string|null}>, restore: () => void}}
 *   `restore()` puts back the socket refusal
 */
export function serveOldMessages(api, pages) {
    const queue = [...pages];
    const requests = [];
    const saved = { start: api.listener.start, stop: api.listener.stop, request: api.listener.requestOldMessages };
    api.listener.start = () => queueMicrotask(() => api.listener.emit("connected"));
    api.listener.stop = () => {};
    api.listener.requestOldMessages = (threadType, lastId) => {
        requests.push({ threadType, lastId });
        queueMicrotask(() => api.listener.emit("old_messages", queue.shift() ?? [], threadType));
    };
    return {
        requests,
        restore: () => {
            api.listener.start = saved.start;
            api.listener.stop = saved.stop;
            api.listener.requestOldMessages = saved.request;
        },
    };
}

/** Thrown by the stubbed process.exit so execution stops where a real exit would. */
class ExitSignal extends Error {}

/**
 * Run one CLI command in-process, the way `src/index.js` would dispatch it.
 *
 * Output printed after the first `process.exit()` is dropped, because a real
 * exit would have ended the process there -- the stub has to unwind through
 * the command's own catch blocks instead.
 *
 * @param {(program: Command) => void} register - e.g. registerGroupCommands
 * @param {string[]} argv - arguments after the binary name
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null}>}
 */
export async function runCommand(register, argv) {
    const program = new Command();
    program.exitOverride();
    program.option("--json", "Output results as JSON (machine-readable)");
    register(program);
    _resetErrorLatch();

    const out = [];
    const err = [];
    let exitCode = null;
    const saved = { log: console.log, error: console.error, exit: process.exit };
    console.log = (...a) => {
        if (exitCode === null) out.push(a.join(" "));
    };
    console.error = (...a) => {
        if (exitCode === null) err.push(a.join(" "));
    };
    process.exit = (code = 0) => {
        if (exitCode === null) exitCode = code;
        throw new ExitSignal(`process.exit(${code})`);
    };
    try {
        await program.parseAsync(["node", "zalo-agent", ...argv]);
    } catch (e) {
        if (!(e instanceof ExitSignal)) throw e;
    } finally {
        console.log = saved.log;
        console.error = saved.error;
        process.exit = saved.exit;
    }
    return { stdout: out.join("\n"), stderr: err.join("\n"), exitCode };
}
