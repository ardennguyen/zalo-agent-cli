/**
 * `social`: Zalo's Social API (official): a Zalo user logs in to your app, and the app reads that user's name and
 * avatar (src/core/social/client.js). Independent from the personal account and from the OA; the login is stored per
 * profile in `<oa dir>/social-credentials.json`.
 */

import {
    PICTURE_SIZES,
    ME_FIELDS,
    getMe,
    loadSocialCreds,
    refreshSocialToken,
    saveSocialCreds,
    startSocialLogin,
} from "../core/social/client.js";
import { openInBrowser } from "../core/oa/oauth.js";
import { success, error, info, warning, output } from "../utils/output.js";

const PROFILE = ["--profile <name>", "Which stored user login to use (several users or apps)", "default"];

/**
 * The human lines for a `/me` answer.
 * @param {object} me
 * @returns {string[]}
 */
export function describeMe(me = {}) {
    const lines = [`User: ${me.name ?? "N/A"} (app-scoped ID: ${me.id ?? "N/A"})`];
    const avatar = me.picture?.data?.url;
    if (avatar) lines.push(`Avatar: ${avatar}`);
    if (me.is_sensitive !== undefined) {
        lines.push(
            `Sensitive account: ${me.is_sensitive ? "yes (handle this user's data as the law requires)" : "no"}`,
        );
    }
    return lines;
}

/**
 * What `social status` reports about one stored login (never the tokens).
 * @param {object|null} creds
 * @param {number} [now]
 * @returns {object}
 */
export function loginStatus(creds, now = Date.now()) {
    if (!creds) return { loggedIn: false };
    const at = (iso) => (iso ? Date.parse(iso) : NaN);
    return {
        loggedIn: Boolean(creds.accessToken),
        appId: creds.appId ?? null,
        accessTokenExpiresAt: creds.expiresAt ?? null,
        accessTokenValid: Number.isFinite(at(creds.expiresAt)) ? at(creds.expiresAt) > now : null,
        loginExpiresAt: creds.refreshExpiresAt ?? null,
        loginValid: Number.isFinite(at(creds.refreshExpiresAt)) ? at(creds.refreshExpiresAt) > now : null,
        dpop: Boolean(creds.dpopKey),
    };
}

/**
 * Register the `social` command group.
 * @param {import("commander").Command} program
 */
export function registerSocialCommands(program) {
    const social = program
        .command("social")
        .description("Zalo Social API (official, OAuth v4): a user's login to your app, and their name and avatar");
    const json = () => program.opts().json;

    social
        .command("setup")
        .description("Save the app's ID and secret key for user logins (from developers.zalo.me → the app)")
        .requiredOption("--app-id <id>", "Zalo App ID")
        .requiredOption("--secret <key>", "Zalo App Secret Key")
        .option(...PROFILE)
        .action((opts) => {
            try {
                saveSocialCreds({ appId: opts.appId, secretKey: opts.secret }, opts.profile);
                output({ ok: true, profile: opts.profile }, json(), () =>
                    success(`App saved for profile "${opts.profile}". Next: zalo-agent social login`),
                );
            } catch (e) {
                error(e.message);
            }
        });

    social
        .command("login")
        .description(
            "Log a Zalo user in to the app: OAuth v4 with PKCE and state (opens the browser, waits on a local " +
                "callback). The app's callback URL (developers.zalo.me → the app → Đăng nhập → Web) must be " +
                "http://localhost:<port>/callback, or <callback-host>/callback",
        )
        .option("--app-id <id>", "Zalo App ID (default: the one `social setup` saved)")
        .option("--secret <key>", "Zalo App Secret Key (default: the saved one)")
        .option("-p, --port <port>", "Callback server port", "3457")
        .option("--callback-host <host>", "Public callback base for a VPS (e.g. https://your-vps.com)")
        .option("--dpop", "Bind the tokens to a new key pair (DPoP): a stolen token is useless without the key")
        .option(...PROFILE)
        .action(async (opts) => {
            const saved = loadSocialCreds(opts.profile) ?? {};
            const appId = opts.appId ?? saved.appId;
            const secretKey = opts.secret ?? saved.secretKey;
            if (!appId || !secretKey) {
                error(
                    "No app: pass --app-id and --secret, or run: zalo-agent social setup --app-id <id> --secret <key>",
                );
                return;
            }
            const flow = startSocialLogin({
                appId,
                secretKey,
                profile: opts.profile,
                port: Number(opts.port),
                callbackHost: opts.callbackHost,
                dpop: Boolean(opts.dpop),
                onListening: ({ bindHost, port }) => {
                    if (!json()) info(`Waiting for the callback on ${bindHost}:${port}...`);
                },
            });
            if (!json()) {
                info(opts.callbackHost ? "VPS mode: open this URL in your local browser:" : "Opening the browser...");
                info(`Login URL:\n  ${flow.authUrl}\n`);
            }
            if (!opts.callbackHost) openInBrowser(flow.authUrl);
            try {
                const { saved: login } = await flow.done;
                let me = null;
                try {
                    me = await getMe({ profile: opts.profile });
                } catch (e) {
                    if (!json()) warning(`Logged in, but /me failed: ${e.message}`);
                }
                output(
                    {
                        ok: true,
                        profile: opts.profile,
                        ...loginStatus(login),
                        user: me ? { id: me.id, name: me.name } : null,
                    },
                    json(),
                    () => {
                        success(`User logged in (profile "${opts.profile}")${login.dpopKey ? " with DPoP" : ""}`);
                        if (me) for (const line of describeMe(me)) info(line);
                        info("The access token lasts 1 hour and renews itself; the login lasts at most 30 days.");
                    },
                );
            } catch (e) {
                error(e.message);
            }
        });

    social
        .command("refresh")
        .description("Renew the user's access token now (the refresh token is single use; serialized)")
        .option(...PROFILE)
        .action(async (opts) => {
            try {
                const r = await refreshSocialToken(opts.profile);
                output({ ok: true, ...loginStatus(r) }, json(), () =>
                    success(`Token refreshed until ${r.expiresAt ?? "unknown"}; the login ends ${r.refreshExpiresAt}`),
                );
            } catch (e) {
                error(e.message);
            }
        });

    social
        .command("me")
        .description("The logged-in user's app-scoped ID, name and avatar (graph.zalo.me/v2.0/me)")
        .option("--fields <list>", `Comma-separated: ${ME_FIELDS.join(", ")}`, "id,name,picture")
        .option("--picture <size>", `Avatar size: ${PICTURE_SIZES.join(", ")} (default: Zalo's smallest)`)
        .option(...PROFILE)
        .action(async (opts) => {
            try {
                const fields = String(opts.fields)
                    .split(",")
                    .map((f) => f.trim())
                    .filter(Boolean);
                const me = await getMe({ fields, pictureSize: opts.picture, profile: opts.profile });
                output(me, json(), () => describeMe(me).forEach((line) => info(line)));
            } catch (e) {
                error(e.message);
            }
        });

    social
        .command("status")
        .description("Whether a user is logged in, and until when (no tokens are shown)")
        .option(...PROFILE)
        .action((opts) => {
            try {
                const s = loginStatus(loadSocialCreds(opts.profile));
                output({ profile: opts.profile, ...s }, json(), () => {
                    if (!s.loggedIn) return info(`No user login for profile "${opts.profile}"`);
                    info(`App: ${s.appId}`);
                    info(
                        `Access token until: ${s.accessTokenExpiresAt ?? "unknown"}${s.accessTokenValid === false ? " (expired: renews on the next call)" : ""}`,
                    );
                    info(
                        `Login until: ${s.loginExpiresAt ?? "unknown"}${s.loginValid === false ? " (ended: log in again)" : ""}`,
                    );
                    info(`DPoP: ${s.dpop ? "on" : "off"}`);
                });
            } catch (e) {
                error(e.message);
            }
        });

    social
        .command("logout")
        .description("Forget the user's tokens on this machine (the app's ID and secret stay)")
        .option(...PROFILE)
        .action((opts) => {
            try {
                const fields = ["accessToken", "refreshToken", "expiresIn", "expiresAt", "refreshExpiresAt", "dpopKey"];
                saveSocialCreds(Object.fromEntries(fields.map((k) => [k, null])), opts.profile);
                output({ ok: true, profile: opts.profile }, json(), () =>
                    success(`User tokens removed for profile "${opts.profile}"`),
                );
            } catch (e) {
                error(e.message);
            }
        });
}
