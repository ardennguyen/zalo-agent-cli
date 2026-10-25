/**
 * The Web login, as the official Zalo Web client does it (plan items L2a-e, L5, L6, L7).
 *
 * zca-js's own `Zalo.login()` asks `getLoginInfo` first, `getServerInfo` second, probes the npm registry
 * on the way, announces `zpw_ver`/`zpw_type` where the official client does not, always encrypts, and has
 * no timeout and no retry. This module does the login the verified way and hands the finished session to
 * zca-js's own `API` class, so every API call, the listener and all the factories stay exactly as they are:
 *
 *  1. `getServerInfo`, carrying the stored disaster-recovery values (`sp_mtn`, `bkt`; -1 and -1 when nothing
 *     is stored) and, when one is stored, the `viewerKey`; its `signkey` covers every field.
 *  2. `getLoginInfo` with `enc_ver=v2` and no `zpw_ver`/`zpw_type` (the login calls announce the version as
 *     `client_version`). Encrypted unless the server's `authen.encryption.enable` says otherwise; an answer of
 *     error 19000 switches encryption off and asks again. HTTP 500-504 is asked again every 10 s for up to 120 s.
 *  3. `getServerInfo` again, now with `floatMenuPos`: its answer is the session's settings.
 *
 * Every request has a 10 s timeout. `checkUpdate` is off: the official client asks nobody whether it is current.
 *
 * Nothing here knows about files except through the `store` the caller passes (see {@link createDrStore}).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { API, Zalo, ZaloApiError } from "zca-js";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { errorCodeOf } from "./errors.js";
import { AVATAR_SIZE, COMPUTER_NAME, browserCodeOf, osCodeOf } from "./profile.js";
import { withBrowserHeaders } from "./headers.js";
import { startUpkeep } from "./upkeep.js";
import { installOfficialPulls } from "./pulls.js";

const require = createRequire(import.meta.url);
const zcaDir = dirname(require.resolve("zca-js"));
const zu = require(join(zcaDir, "utils.cjs"));
const { createContext } = require(join(zcaDir, "context.cjs"));

/** The upkeep (hourly settings refresh, keepalive) of each live session, so a session can end it. */
const upkeeps = new WeakMap();

const LOGIN_HOST = "https://wpa.chat.zalo.me";

/** How long one login call may take before it is given up on. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** HTTP statuses of a server that is there but not well: `getLoginInfo` is asked again for these. */
const RETRY_STATUS = new Set([500, 501, 502, 503, 504]);

/** Retry pause and total budget for those statuses. */
export const RETRY_EVERY_MS = 10_000;
export const RETRY_FOR_MS = 120_000;

/** The server's answer to an encrypted request it will not take encrypted. */
const ENCRYPTION_OFF = 19000;

/** An HTTP status that means another session took this account. */
const KICKED_STATUS = 600;

/**
 * The disaster-recovery values a `getServerInfo` answer carries.
 *
 * @param {object|undefined} settings - the answer's `settings` (Zalo spells the key `setttings`)
 * @returns {{supportMaintenance: number, bucketId: number}|null} null when the answer holds none
 */
export function drConfigOf(settings) {
    const dr = settings?.features?.dr_config;
    if (!dr || typeof dr !== "object") return null;
    const supportMaintenance = Number(dr.supportMaintenance);
    const bucketId = Number(dr.bucketId);
    if (!Number.isFinite(supportMaintenance) || !Number.isFinite(bucketId)) return null;
    return { supportMaintenance, bucketId };
}

/**
 * A small file that remembers the disaster-recovery values between logins, as the official client keeps them
 * in its local storage. No identity and no credential: two numbers and a time.
 *
 * @param {string} file
 * @returns {{load: () => ({supportMaintenance: number, bucketId: number}|null), save: (dr: object) => boolean}}
 */
export function createDrStore(file) {
    return {
        load() {
            try {
                return drConfigOf({ features: { dr_config: JSON.parse(readFileSync(file, "utf8")) } });
            } catch {
                return null;
            }
        },
        save(dr) {
            try {
                writeFileAtomic(file, JSON.stringify({ ...dr, savedAt: Date.now() }), { mode: 0o600 });
                return true;
            } catch {
                return false;
            }
        },
    };
}

/**
 * The query of a `getServerInfo` call, `signkey` last and computed over every other field.
 *
 * @param {object} p
 * @param {string} p.imei
 * @param {number} p.apiType
 * @param {number} p.apiVersion
 * @param {{supportMaintenance: number, bucketId: number}|null} [p.dr] - stored values, or none
 * @param {string|null} [p.viewerKey]
 * @param {boolean} [p.floatMenuPos] - true for the second call of a boot
 * @returns {Record<string, string|number|null>}
 */
export function buildServerInfoQuery({ imei, apiType, apiVersion, dr = null, viewerKey = null, floatMenuPos = false }) {
    const q = {
        imei,
        type: apiType,
        client_version: apiVersion,
        computer_name: COMPUTER_NAME,
        sp_mtn: dr ? dr.supportMaintenance : -1,
        bkt: dr ? dr.bucketId : -1,
    };
    if (viewerKey) q.viewerKey = viewerKey;
    if (floatMenuPos) q.floatMenuPos = null;
    q.signkey = zu.getSignKey("getserverinfo", q);
    return q;
}

/** @param {string} base @param {Record<string, unknown>} query */
function urlOf(base, query) {
    const url = new URL(base);
    for (const [k, v] of Object.entries(query)) url.searchParams.append(k, String(v));
    return url.toString();
}

/**
 * One HTTP call with a timeout, raised as a plain error that says what timed out.
 *
 * @param {object} ctx
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function timedRequest(ctx, url, timeoutMs) {
    try {
        return await zu.request(ctx, url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        if (e?.name === "TimeoutError" || e?.name === "AbortError") {
            throw new ZaloApiError(
                `Zalo did not answer within ${Math.round(timeoutMs / 1000)} s: ${new URL(url).pathname}`,
            );
        }
        throw e;
    }
}

/**
 * Whether the server wants login parameters encrypted.
 *
 * @param {object|undefined} settings
 * @param {boolean} current - what is in force until the server says otherwise
 * @returns {boolean}
 */
export function encryptionFrom(settings, current = true) {
    const enc = settings?.authen?.encryption;
    return enc ? !!enc.enable : current;
}

/**
 * Ask `getServerInfo`.
 *
 * @param {object} ctx
 * @param {object} opts - see {@link buildServerInfoQuery}; plus `timeoutMs`
 * @returns {Promise<{settings: object|undefined, extra_ver: unknown, raw: object}>}
 * @throws {Error} with `.code` 600 when another session took the account
 */
export async function fetchServerInfo(ctx, { timeoutMs = REQUEST_TIMEOUT_MS, ...query }) {
    const q = buildServerInfoQuery({ imei: ctx.imei, apiType: ctx.API_TYPE, apiVersion: ctx.API_VERSION, ...query });
    const response = await timedRequest(ctx, urlOf(`${LOGIN_HOST}/api/login/getServerInfo`, q), timeoutMs);
    if (response.status === KICKED_STATUS) throw new ZaloApiError("Failed to fetch server info: kicked", KICKED_STATUS);
    if (!response.ok) throw new ZaloApiError("Failed to fetch server info: " + response.statusText);
    const data = await response.json();
    if (data.data === undefined || data.data === null) {
        throw new ZaloApiError("Failed to fetch server info: " + data.error_message, errorCodeOf(data));
    }
    return { settings: data.data.setttings || data.data.settings, extra_ver: data.data.extra_ver, raw: data.data };
}

/**
 * The query of a `getLoginInfo` call and the key its answer is sealed with.
 *
 * @param {object} ctx
 * @param {boolean} encrypt
 * @returns {{query: Record<string, string|number>, enk: string|null}}
 */
function buildLoginQuery(ctx, encrypt) {
    const data = { computer_name: COMPUTER_NAME, imei: ctx.imei, language: ctx.language, ts: Date.now() };
    const params = {};
    let enk = null;
    if (encrypt) {
        const encryptor = new zu.ParamsEncryptor({ type: ctx.API_TYPE, imei: data.imei, firstLaunchTime: Date.now() });
        enk = encryptor.getEncryptKey();
        const sealed = zu.ParamsEncryptor.encodeAES(enk, JSON.stringify(data), "base64", false);
        const extra = encryptor.getParams();
        if (!extra) enk = null;
        else Object.assign(params, extra, { params: sealed });
    }
    if (enk === null) Object.assign(params, data);
    params.type = ctx.API_TYPE;
    params.client_version = ctx.API_VERSION;
    params.signkey = zu.getSignKey("getlogininfo", params);
    params.nretry = 0;
    return { query: params, enk };
}

/**
 * Ask `getLoginInfo`: encrypted unless told otherwise, unencrypted after an answer of 19000, again every
 * {@link RETRY_EVERY_MS} while the server answers 500-504 (for up to {@link RETRY_FOR_MS}).
 *
 * @param {object} ctx
 * @param {object} opts
 * @param {boolean} opts.encrypt
 * @param {(ms: number) => Promise<void>} opts.sleep
 * @param {number} opts.timeoutMs
 * @param {number} opts.retryEveryMs
 * @param {number} opts.retryForMs
 * @returns {Promise<object>} the login data (`uid`, `zpw_enk`, `zpw_service_map_v3`, `zpw_ws`, ...)
 */
async function fetchLoginInfo(ctx, { encrypt, sleep, timeoutMs, retryEveryMs, retryForMs }) {
    let waited = 0;
    let encrypted = encrypt;
    for (;;) {
        const { query, enk } = buildLoginQuery(ctx, encrypted);
        const response = await timedRequest(ctx, urlOf(`${LOGIN_HOST}/api/login/getLoginInfo`, query), timeoutMs);
        if (response.status === KICKED_STATUS)
            throw new ZaloApiError("Failed to fetch login info: kicked", KICKED_STATUS);
        if (RETRY_STATUS.has(response.status)) {
            if (waited + retryEveryMs > retryForMs) {
                throw new ZaloApiError("Failed to fetch login info: " + (response.statusText || response.status));
            }
            await sleep(retryEveryMs);
            waited += retryEveryMs;
            continue;
        }
        if (!response.ok) throw new ZaloApiError("Failed to fetch login info: " + response.statusText);
        const body = await response.json();
        if (body?.error_code === ENCRYPTION_OFF && encrypted) {
            encrypted = false;
            continue;
        }
        const { login, inner } = unseal(body, enk);
        if (!login) {
            const said = inner?.error_message || body?.error_message;
            throw new ZaloApiError(
                `Đăng nhập thất bại${said ? `: ${said}` : ""}`,
                errorCodeOf(inner) ?? errorCodeOf(body),
            );
        }
        return login;
    }
}

/**
 * The login data inside an answer, decrypted when it was asked for encrypted.
 *
 * What is inside is either the login data itself or an envelope `{error_code, error_message, data}`. A saved
 * login Zalo refuses comes back as an envelope with an error and no data: that is a refusal with its own code,
 * never login data.
 *
 * @param {{data?: unknown}} body
 * @param {string|null} enk
 * @returns {{login: object|null, inner: {error_code?: number, error_message?: string}|null}} `inner` is the
 *   envelope when there was one
 */
function unseal(body, enk) {
    const none = { login: null, inner: null };
    let opened = body?.data;
    if (opened === undefined || opened === null) return none;
    if (enk) {
        opened = zu.decryptResp(enk, opened);
        if (opened === undefined || opened === null || typeof opened === "string") return none;
    } else if (typeof opened === "string") {
        try {
            opened = JSON.parse(opened);
        } catch {
            return none;
        }
    }
    if (typeof opened !== "object") return none;
    if ("data" in opened || "error_code" in opened) {
        return opened.data ? { login: opened.data, inner: opened } : { login: null, inner: opened };
    }
    return { login: opened, inner: null };
}

/**
 * Log in with a saved session and return the zca-js API object.
 *
 * @param {{imei: string, cookie: unknown, userAgent: string, language?: string}} creds
 * @param {object} opts
 * @param {number} opts.apiType
 * @param {number} opts.apiVersion
 * @param {object} [opts.zaloOptions] - the zca-js options (`selfListen`, `polyfill`, `agent`, `logging`, ...)
 * @param {(ownId: string|null) => ({load: Function, save: Function}|null)} [opts.drStoreFor] - where the
 *   disaster-recovery values of an account live; asked with `opts.ownId` before the login (the first call
 *   carries what was stored) and with the id the server returns once it is known (the values are saved there)
 * @param {string|null} [opts.ownId] - the account this session is believed to belong to
 * @param {string|null} [opts.viewerKey]
 * @param {(ms: number) => Promise<void>} [opts.sleep] - injectable for tests
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retryEveryMs]
 * @param {number} [opts.retryForMs]
 * @param {boolean} [opts.upkeep] - start the timers of {@link startUpkeep} (default true)
 * @returns {Promise<InstanceType<typeof API>>}
 * @throws {Error} `Missing required params` for an incomplete session; `Đăng nhập thất bại` when the server
 *   refuses it (with the server's code on `.code`)
 */
export async function loginWithSession(
    creds,
    {
        apiType,
        apiVersion,
        zaloOptions = {},
        drStoreFor = null,
        ownId = null,
        viewerKey = null,
        sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
        timeoutMs = REQUEST_TIMEOUT_MS,
        retryEveryMs = RETRY_EVERY_MS,
        retryForMs = RETRY_FOR_MS,
        upkeep = true,
    },
) {
    if (!creds?.imei || !creds.cookie || !creds.userAgent) throw new ZaloApiError("Missing required params");

    const ctx = createContext(apiType, apiVersion);
    Object.assign(ctx.options, zaloOptions);
    ctx.options.checkUpdate = false;
    ctx.options.polyfill = withBrowserHeaders(ctx.options.polyfill, creds.userAgent);
    ctx.imei = creds.imei;
    ctx.cookie = new Zalo(zaloOptions).parseCookies(structuredClone(creds.cookie));
    ctx.userAgent = creds.userAgent;
    ctx.language = creds.language || "vi";

    const stored = drStoreFor?.(ownId)?.load() ?? null;
    const first = await fetchServerInfo(ctx, { timeoutMs, dr: stored, viewerKey });
    const encrypt = encryptionFrom(first.settings, true);
    const dr1 = drConfigOf(first.settings);

    const loginInfo = await fetchLoginInfo(ctx, { encrypt, sleep, timeoutMs, retryEveryMs, retryForMs });

    const second = await fetchServerInfo(ctx, { timeoutMs, dr: dr1 ?? stored, floatMenuPos: true });
    const dr = drConfigOf(second.settings) ?? dr1;
    if (dr) drStoreFor?.(String(loginInfo.uid ?? ownId ?? ""))?.save(dr);

    ctx.secretKey = loginInfo.zpw_enk;
    ctx.uid = loginInfo.uid;
    ctx.settings = second.settings;
    ctx.extraVer = second.extra_ver;
    // The viewer key and cipher the kickout lookup needs (L12b). Kept out of every log.
    // Zalo's answers have carried the pair in the login info and, in the Web client's code, beside the settings.
    const zc = loginInfo.zcloud?.viewer_key && loginInfo.zcloud?.enk ? loginInfo.zcloud : second.raw?.zcloud;
    if (zc?.viewer_key && zc?.enk) ctx.zcloud = { viewerKey: zc.viewer_key, enk: zc.enk };
    ctx.loginInfo = loginInfo;
    if (!ctx.secretKey) throw new ZaloApiError("Khởi tạo ngữ cảnh thất bại.");

    const api = new API(ctx, loginInfo.zpw_service_map_v3, loginInfo.zpw_ws);
    installOfficialProfileCall(api, ctx);
    installOfficialPulls(api.listener);
    if (upkeep) {
        const uid = String(loginInfo.uid ?? ownId ?? "");
        upkeeps.set(
            api,
            startUpkeep(ctx, {
                keepAlive: () => api.keepAlive(),
                refreshSettings: async () => {
                    const store = drStoreFor?.(uid) ?? null;
                    const fresh = await fetchServerInfo(ctx, {
                        timeoutMs,
                        dr: store?.load() ?? null,
                        floatMenuPos: true,
                    });
                    ctx.settings = fresh.settings;
                    ctx.extraVer = fresh.extra_ver;
                    const latest = drConfigOf(fresh.settings);
                    if (latest) store?.save(latest);
                },
            }),
        );
    }
    return api;
}

/**
 * End the timers of a session made by {@link loginWithSession}. Safe to call twice or on any other object.
 *
 * @param {object|null|undefined} api
 */
export function stopUpkeep(api) {
    if (!api) return;
    upkeeps.get(api)?.stop();
    upkeeps.delete(api);
}

/**
 * Replace zca-js's `fetchAccountInfo` with the profile call the Web client makes: `me-v2` with its AES
 * `params` ({avatar_size, imei}) and the `os` and `browser` numbers of the saved User-Agent (plan item L6).
 *
 * @param {object} api
 * @param {object} ctx
 */
function installOfficialProfileCall(api, ctx) {
    const base = `${api.zpwServiceMap.profile[0]}/api/social/profile/me-v2`;
    api.fetchAccountInfo = async function fetchAccountInfo() {
        const params = zu.encodeAES(ctx.secretKey, JSON.stringify({ avatar_size: AVATAR_SIZE, imei: ctx.imei }));
        if (!params) throw new ZaloApiError("Failed to encrypt params");
        const url = zu.makeURL(ctx, base, {
            params,
            os: osCodeOf(ctx.userAgent),
            browser: browserCodeOf(ctx.userAgent),
        });
        const response = await zu.request(ctx, url, { method: "GET" });
        return zu.resolveResponse(ctx, response);
    };
}
