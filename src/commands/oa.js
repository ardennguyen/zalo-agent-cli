/**
 * Official Account (OA) commands: Zalo's official OA API (OAuth v4, OpenAPI v2.0/v3.0).
 * Independent from the personal-account session; uses the OA's own access token (~/.zalo-agent/).
 *
 * This file holds the account-level commands (login, refresh, setup, whoami) and calls each area's register
 * function: src/commands/oa/{messages,users,content,gmf,calls}.js, plus `oa listen` and `oa init`.
 */

import { registerOAListenCommand } from "./oa-listen.js";
import { registerOAInitCommand } from "./oa-init.js";
import { registerMessagesCommands } from "./oa/messages.js";
import { registerUsersCommands } from "./oa/users.js";
import { registerContentCommands } from "./oa/content.js";
import { registerGmfCommands } from "./oa/gmf.js";
import { registerCallsCommands } from "./oa/calls.js";
import { saveOACreds, loadOACreds, getOAProfile } from "../core/oa-client.js";
import { startOAuthLogin, openInBrowser, refreshStoredToken } from "../core/oa/oauth.js";
import { success, error, info, output } from "../utils/output.js";

/**
 * `oa whoami`'s lines for one OA profile (the `v2.0/oa/getoa` data, field names as Zalo's OA docs give them).
 *
 * The package tier and verification decide which OA APIs work (-224 "upgrade the package", -221 "the OA must be
 * verified"), so both are shown.
 *
 * @param {object} d - the profile data
 * @returns {string[]}
 */
export function describeOAProfile(d = {}) {
    const has = (v) => v !== null && v !== undefined && v !== "";
    const id = d.oa_id ?? d.oaid;
    const lines = [`OA: ${d.name || "N/A"} (ID: ${has(id) ? id : "N/A"})`];
    if (d.oa_alias) lines.push(`Alias: ${d.oa_alias}`);
    if (d.description) lines.push(`Description: ${d.description}`);
    if (has(d.is_verified)) lines.push(`Verified: ${d.is_verified ? "yes" : "no"}`);
    if (has(d.oa_type)) {
        const kind = { 2: "business", 4: "government" }[d.oa_type];
        lines.push(`Type: ${d.oa_type}${kind ? ` (${kind})` : ""}`);
    }
    if (d.cate_name) lines.push(`Category: ${d.cate_name}`);
    if (has(d.num_follower)) lines.push(`Followers: ${d.num_follower}`);
    if (d.package_name) {
        const until = d.package_valid_through_date ? ` (valid through ${d.package_valid_through_date})` : "";
        lines.push(`Package: ${d.package_name}${until}`);
    }
    if (d.package_auto_renew_date) lines.push(`Auto-renews: ${d.package_auto_renew_date}`);
    const zca = d.linked_zca ?? d.linked_ZCA;
    if (has(zca)) lines.push(`Linked ZCA: ${zca}`);
    return lines;
}

/** "25h" from an `expires_in` string of seconds. */
function hours(expiresIn) {
    const s = Number(expiresIn);
    return Number.isFinite(s) && s > 0 ? `${Math.round(s / 3600)}h` : "unknown time";
}

/**
 * Register the `oa` command group.
 * @param {import("commander").Command} program
 */
export function registerOACommands(program) {
    const oa = program.command("oa").description("Zalo Official Account API commands (official API, OAuth)");
    const json = () => program.opts().json;

    // ─── Login & Auth ───────────────────────────────────────────────

    oa.command("login")
        .description("Log in to a Zalo OA via OAuth v4 with PKCE (opens the browser, waits on a local callback)")
        .requiredOption("--app-id <id>", "Zalo App ID from developers.zalo.me")
        .requiredOption("--secret <key>", "Zalo App Secret Key")
        .option("-p, --port <port>", "Callback server port", "3456")
        .option("--callback-host <host>", "Public callback base for a VPS (e.g. https://your-vps.com)")
        .option("--oa-id <id>", "OA identifier for multi-OA support", "default")
        .action(async (opts) => {
            const flow = startOAuthLogin({
                appId: opts.appId,
                secretKey: opts.secret,
                port: Number(opts.port),
                callbackHost: opts.callbackHost,
                oaId: opts.oaId,
                onListening: ({ bindHost, port }) => {
                    if (!json()) info(`Waiting for the callback on ${bindHost}:${port}...`);
                },
            });
            if (!json()) {
                info(opts.callbackHost ? "VPS mode: open this URL in your local browser:" : "Opening the browser...");
                info(`Auth URL:\n  ${flow.authUrl}\n`);
            }
            if (!opts.callbackHost) openInBrowser(flow.authUrl);
            try {
                const { tokenData, oaId } = await flow.done;
                const shownId = oaId || opts.oaId;
                output({ ok: true, oaId: shownId, expires_in: tokenData.expires_in }, json(), () => {
                    success(`OA logged in (OA ID: ${shownId})`);
                    info(`Token expires in ${hours(tokenData.expires_in)}; 'oa refresh' renews it`);
                });
            } catch (e) {
                error(e.message);
            }
        });

    oa.command("refresh")
        .description("Refresh the OA access token with the stored refresh token (single use; serialized)")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(async (opts) => {
            try {
                const r = await refreshStoredToken(opts.oaId);
                output({ ok: true, expires_in: r.expiresIn, expiresAt: r.expiresAt }, json(), () =>
                    success(
                        `Token refreshed. Expires in ${hours(r.expiresIn)}${r.expiresAt ? ` (${r.expiresAt})` : ""}`,
                    ),
                );
            } catch (e) {
                error(e.message);
            }
        });

    oa.command("setup <access-token>")
        .description("Manually set OA access token (skip OAuth)")
        .option("--oa-id <id>", "OA identifier for multi-OA support", "default")
        .action(async (accessToken, opts) => {
            try {
                // A hand-set token's lifetime is unknown: drop the stored expiry rather than show a wrong one.
                saveOACreds({ accessToken, expiresIn: null, expiresAt: null }, opts.oaId);
                output({ ok: true, oaId: opts.oaId }, json(), () => success(`OA token saved for "${opts.oaId}"`));
            } catch (e) {
                error(e.message);
            }
        });

    oa.command("whoami")
        .description("Show the OA's profile: verification, type, category, package")
        .option("--oa-id <id>", "OA identifier", "default")
        .action(async (opts) => {
            try {
                const result = await getOAProfile(opts.oaId);
                output(result, json(), () => {
                    for (const line of describeOAProfile(result.data || result)) info(line);
                    const expiresAt = loadOACreds(opts.oaId)?.expiresAt;
                    if (expiresAt) info(`Token expires: ${expiresAt}`);
                });
            } catch (e) {
                error(e.message);
            }
        });

    // ─── Areas ───────────────────────────────────────────────────────

    registerMessagesCommands(oa);
    registerUsersCommands(oa);
    registerContentCommands(oa);
    registerGmfCommands(oa);
    registerCallsCommands(oa);

    // ─── Webhook Listener ────────────────────────────────────────────

    registerOAListenCommand(oa, program);

    // ─── Guided Setup ────────────────────────────────────────────────

    registerOAInitCommand(oa, program);
}
