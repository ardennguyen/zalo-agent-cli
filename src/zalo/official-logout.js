/**
 * Zalo Web's own logout, call for call (plan items L13a-c and X1).
 *
 * Ending the session key is not the same as signing a device out. Until now `logout` sent the production
 * `GET api/login/logOut` and the staging `logoutV2`; both end only the key this process holds. The saved
 * login (the cookie) kept working, and the phone kept listing the device (measured 2026-09-30). The official
 * client signs out in six steps, observed in the captures and proven on a test account, where the saved
 * cookie was rejected afterwards:
 *
 *  1. `POST id.zalo.me/jr/logout-token`, form `continue`: answers a one-time token.
 *  2. `GET {profile}/api/social/profile/deactive`, AES `params` `{imei}`: the device stops being active.
 *  3. `POST stg-wpa.chat.zalo.me/api/v2/login/logOut`, AES `params` `{time (seconds), imei, computer_name}`.
 *  4. `POST id.zalo.me/account/logout`, form `token`: answers a page that lists the `setsid` URLs.
 *  5. `GET` each of those URLs (`jr.zaloapp.com`, `jr.chat.zalo.me`): they clear the session cookies on
 *     their domains.
 *  6. `GET id.zalo.me/account?continue=...`: the login page the browser lands on.
 *
 * The same six steps run whether local data is kept or deleted: that choice is local. The production
 * `GET logOut` is not part of them; the official client never sends it.
 *
 * A step that fails does not stop the ones that can still run (the key can be ended without the token, and
 * the token is useless without the key). Steps 4 and 5 need what step 1 and 4 return. What each step did is
 * returned; nothing here claims the device is signed out, that is for the caller's probe to find out.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { COMPUTER_NAME } from "./profile.js";

const require = createRequire(import.meta.url);
const zu = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));

const CHAT_ORIGIN = "https://chat.zalo.me";
const ID_ORIGIN = "https://id.zalo.me";
const V2_LOGOUT_URL = "https://stg-wpa.chat.zalo.me/api/v2/login/logOut";

/** The only hosts whose `setsid` URLs are followed: an address read out of a page is not trusted further. */
const SETSID_HOSTS = new Set(["jr.zaloapp.com", "jr.chat.zalo.me"]);

/**
 * Headers of a call the page's script makes (XHR/fetch). `Accept`, `Origin` and `Referer` are spelled exactly as
 * zca-js's request helper spells its own defaults: it merges by key, so a second spelling would be sent besides
 * the default and a real fetch joins the two into one garbled value.
 */
const SCRIPT_HEADERS = {
    Accept: "application/json, text/plain, */*",
    Origin: CHAT_ORIGIN,
    Referer: `${CHAT_ORIGIN}/`,
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
};

/** Headers of a page load the browser makes itself. */
const NAVIGATION_HEADERS = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    priority: "u=0, i",
    "upgrade-insecure-requests": "1",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
};

/**
 * One request of the sequence, reduced to what the caller reports.
 *
 * @param {object} ctx
 * @param {string} url
 * @param {object} init
 * @returns {Promise<{status: number, text: string}>}
 */
async function send(ctx, url, init) {
    const res = await zu.request(ctx, url, { redirect: "manual", ...init });
    return { status: res.status, text: await res.text().catch(() => "") };
}

/**
 * The `error_code` and message of an answer, when it is JSON.
 *
 * @param {string} text
 * @returns {{code: number|null, message: string, json: object|null}}
 */
function answerOf(text) {
    try {
        const json = JSON.parse(text);
        const code = Number(json?.error_code);
        return { code: Number.isFinite(code) ? code : null, message: String(json?.error_message ?? ""), json };
    } catch {
        return { code: null, message: "", json: null };
    }
}

/**
 * The `setsid` URLs a logout page lists, restricted to the known hosts over https.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function setsidUrlsOf(html) {
    const list = /listSetSidUrls\s*:\s*\[([^\]]*)\]/.exec(String(html));
    if (!list) return [];
    const urls = [];
    for (const m of list[1].matchAll(/"([^"]+)"/g)) {
        try {
            const url = new URL(m[1].replace(/\\\//g, "/"));
            if (url.protocol === "https:" && SETSID_HOSTS.has(url.hostname) && url.pathname === "/jr/setsid") {
                urls.push(url.toString());
            }
        } catch {
            /* not a URL: not followed */
        }
    }
    return urls;
}

/**
 * Run the official logout.
 *
 * @param {object} api - a logged-in zca-js API
 * @returns {Promise<{steps: Array<{id: string, ok: boolean, status?: number, error?: string}>}>}
 *   one entry per call made, in order; `setsid` appears once per URL
 */
export async function officialLogout(api) {
    const ctx = api.getContext();
    const steps = [];
    const run = async (id, fn) => {
        try {
            const r = await fn();
            steps.push({ id, ...r });
            return r;
        } catch (e) {
            const r = { ok: false, error: e?.message ?? String(e) };
            steps.push({ id, ...r });
            return r;
        }
    };

    // 1: the token that lets the id domain end its own session.
    let token = null;
    await run("logout-token", async () => {
        const { status, text } = await send(ctx, `${ID_ORIGIN}/jr/logout-token`, {
            method: "POST",
            headers: { ...SCRIPT_HEADERS, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ continue: `${CHAT_ORIGIN}/` }),
        });
        const a = answerOf(text);
        token = a.json?.data?.token ?? null;
        return token ? { ok: true, status } : { ok: false, status, error: a.message || "no token in the answer" };
    });

    // 2: the device stops counting as active, while the session key still works.
    await run("profile deactive", async () => {
        const params = zu.encodeAES(ctx.secretKey, JSON.stringify({ imei: ctx.imei }));
        const url = zu.makeURL(ctx, `${api.zpwServiceMap.profile[0]}/api/social/profile/deactive`, { params });
        const { status, text } = await send(ctx, url, { method: "GET", headers: SCRIPT_HEADERS });
        const a = answerOf(text);
        return status < 400 && (a.code === null || a.code === 0)
            ? { ok: true, status }
            : { ok: false, status, error: a.message || `HTTP ${status}` };
    });

    // 3: ends the session key (unix seconds, as the web sends it).
    await run("v2 logout", async () => {
        const params = zu.encodeAES(
            ctx.secretKey,
            JSON.stringify({ time: Math.floor(Date.now() / 1000), imei: ctx.imei, computer_name: COMPUTER_NAME }),
        );
        const { status, text } = await send(ctx, zu.makeURL(ctx, V2_LOGOUT_URL, {}), {
            method: "POST",
            headers: { ...SCRIPT_HEADERS, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ params }),
        });
        const a = answerOf(text);
        return status < 400 && (a.code === null || a.code === 0)
            ? { ok: true, status }
            : { ok: false, status, error: a.message || `HTTP ${status}` };
    });

    // 4: the id domain's own logout, which lists the other domains to clear.
    let setsid = [];
    if (token) {
        await run("account logout", async () => {
            const { status, text } = await send(ctx, `${ID_ORIGIN}/account/logout`, {
                method: "POST",
                headers: {
                    ...NAVIGATION_HEADERS,
                    "content-type": "application/x-www-form-urlencoded",
                    Origin: ID_ORIGIN,
                    Referer: `${ID_ORIGIN}/`,
                    "sec-fetch-site": "same-origin",
                },
                body: new URLSearchParams({ token }),
            });
            setsid = setsidUrlsOf(text);
            return status < 400 ? { ok: true, status } : { ok: false, status, error: `HTTP ${status}` };
        });
    } else {
        steps.push({ id: "account logout", ok: false, error: "skipped: step 1 gave no token" });
    }

    // 5: each listed domain clears its session cookie.
    for (const url of setsid) {
        await run(`setsid ${new URL(url).hostname}`, async () => {
            const { status } = await send(ctx, url, {
                method: "GET",
                headers: {
                    ...NAVIGATION_HEADERS,
                    Referer: `${ID_ORIGIN}/`,
                    "sec-fetch-site": "cross-site",
                    "sec-fetch-dest": "iframe",
                },
            });
            return status < 400 ? { ok: true, status } : { ok: false, status, error: `HTTP ${status}` };
        });
    }

    // 6: the login page the browser ends up on.
    await run("login page", async () => {
        const { status } = await send(ctx, `${ID_ORIGIN}/account?continue=${encodeURIComponent(`${CHAT_ORIGIN}/`)}`, {
            method: "GET",
            headers: { ...NAVIGATION_HEADERS, Referer: `${ID_ORIGIN}/`, "sec-fetch-site": "same-origin" },
        });
        return status < 400 ? { ok: true, status } : { ok: false, status, error: `HTTP ${status}` };
    });

    return { steps };
}
