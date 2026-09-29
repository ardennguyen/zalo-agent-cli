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

/**
 * Install the fake server as globalThis.fetch.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.omit] - service keys to leave out of the login's service map
 * @returns {{
 *   requests: Array<{method: string, host: string, path: string, query: object, params: object|null}>,
 *   calls: (pathPart: string) => Array<object>,
 *   route: (pathSuffix: string, handler: (req: object) => unknown) => void,
 *   clearRoutes: () => void,
 *   uninstall: () => void,
 * }}
 *   `requests` records EVERY request, the npm probe included, with `params`
 *   decrypted. A route handler's return value becomes the response's `data`.
 */
export function installFakeZalo({ omit = [] } = {}) {
    const requests = [];
    const routes = new Map();
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

    async function handle(input, init = {}) {
        const url = new URL(String(input));
        const req = {
            method: String(init.method || "GET").toUpperCase(),
            host: url.host,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            params: null,
        };
        requests.push(req);

        // zca-js asks npm whether it is current on every login.
        if (url.host === "registry.npmjs.org") return reply({}, 404);

        if (url.pathname === "/api/login/getLoginInfo") {
            const keyer = new zu.ParamsEncryptor({ type: 30, imei: "derive", firstLaunchTime: 1 });
            keyer.zcid = url.searchParams.get("zcid");
            keyer.zcid_ext = url.searchParams.get("zcid_ext");
            keyer.createEncryptKey();
            const loginInfo = {
                uid: FAKE.ownId,
                zpw_enk: FAKE.sessionKey,
                zpw_service_map_v3: serviceMap,
                zpw_ws: ["wss://ws.zalo.invalid/"],
                send2me_id: "1000000000000000001",
            };
            const payload = JSON.stringify({ error_code: 0, error_message: "", data: loginInfo });
            return reply({
                error_code: 0,
                error_message: "",
                data: zu.ParamsEncryptor.encodeAES(keyer.getEncryptKey(), payload, "base64", false),
            });
        }

        if (url.pathname === "/api/login/getServerInfo") {
            return reply({ error_code: 0, error_message: "", data: { settings: SETTINGS, extra_ver: {} } });
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
        clearRoutes: () => routes.clear(),
        uninstall: () => {
            globalThis.fetch = previous;
        },
    };
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
