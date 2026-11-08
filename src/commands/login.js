/**
 * Login commands — QR login, credential login, logout, status, whoami.
 */

import { readFileSync, unlinkSync } from "fs";
import {
    loginWithCredentials,
    extractCredentials,
    clearSession,
    isLoggedIn,
    getApi,
    getOwnId,
} from "../core/zalo-client.js";
import { saveCredentials, loadCredentials, getAccountDir, readSavedDevice } from "../core/credentials.js";
import { describeLoginDevice, loginDeviceChange } from "../core/device-since.js";
import { addAccount, getActive, removeAccount, updateAccountName } from "../core/accounts.js";
import { getDaemonStatus } from "../core/daemon-channel.js";
import { describeSessionExpiry, sessionExpiryFor } from "../core/session-expiry.js";
import { serverLogout, reportLogout, finishLocalLogout, lockHolder, describeTrustedDevice } from "../core/logout.js";
import { maskProxy } from "../utils/proxy-helpers.js";
import { getQRPath } from "../utils/qr-display.js";
import { resolveLoginPublicUrl, runQrLogin } from "../core/qr-login-flow.js";
import { success, error, info, warning, output } from "../utils/output.js";
import { parseIntAtLeast, parseIntOption } from "../utils/parse-options.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { clearKickMarker, kickFile } from "../core/kick-marker.js";
import { guardSubcommand } from "../core/confirm-guard.js";

/**
 * The newest time this account was known connected, from its local cache, or null (no cache yet, or unreadable).
 * Read only; a cache that does not exist is not created.
 *
 * @param {string} ownId
 * @returns {Promise<number|null>}
 */
async function lastConnectedAtOf(ownId) {
    try {
        const { existsSync } = await import("fs");
        const { getAccountDbPath } = await import("../core/credentials.js");
        if (!existsSync(getAccountDbPath(ownId))) return null;
        const { SyncManager } = await import("../core/sync.js");
        return new SyncManager(getApi(), ownId).getLastConnectedAt();
    } catch {
        return null;
    }
}

/**
 * The command that restores what a new device does not have: from the last time the account was seen connected here,
 * or the whole history when nothing was ever cached here.
 *
 * @param {string} ownId
 * @returns {Promise<string>}
 */
async function restoreAdvice(ownId) {
    const since = await lastConnectedAtOf(ownId);
    if (!since) return "zalo-agent sync";
    const { syncFromDate } = await import("../core/sync-v2/gap-advice.js");
    return `zalo-agent sync --from ${syncFromDate(since)}`;
}

/**
 * After a QR login: look for the phone's "sync messages to this device" offer and say whether it was ticked. Ticked:
 * restore at once with the key the phone offered (no tap; the tick is the consent), unless `--no-sync`. Not ticked, or
 * too late to use: say which `sync` command restores what this login does not have.
 *
 * With a `listen`/`mcp` daemon holding the account nothing is opened: a second socket would fight it. The offer is
 * then not read, and the advice is printed instead.
 *
 * @param {string} ownId
 * @param {{sync?: boolean, syncDays?: number}} opts - `sync` false: `--no-sync`
 * @param {{newDevice: boolean, jsonMode: boolean}} ctx
 */
async function watchLoginOffer(ownId, opts, { newDevice, jsonMode }) {
    const { autoSyncAfterLogin } = await import("../core/sync-v2/auto-sync.js");
    const { resolveSyncWindow } = await import("../core/sync-v2/index.js");
    const { reportRestore } = await import("./sync.js");
    const accountDir = getAccountDir(ownId);
    const say = (status, line, extra = {}) => {
        if (jsonMode) console.log(JSON.stringify({ event: "login_auto_sync", status, ...extra }));
        else if (line) (status === "restored" || status === "same-device" ? info : warning)(line);
    };
    if (!acquireLock(accountDir)) {
        const advice = await restoreAdvice(ownId);
        say(
            "daemon-running",
            "A listen/mcp daemon holds this account, so the phone's auto sync offer was not read. " +
                `To restore what this login does not have: \`${advice}\` (it runs on the daemon's socket).`,
            { command: advice },
        );
        return;
    }
    try {
        const win = resolveSyncWindow(opts.syncDays, Date.now());
        const startedAt = Date.now();
        if (!jsonMode) info("Checking whether 'sync messages' was ticked on the phone...");
        const out = await autoSyncAfterLogin(getApi(), ownId, {
            days: opts.syncDays ?? null,
            restoreWhenTicked: opts.sync !== false,
            onStatus: ({ phase, detail }) => {
                if (jsonMode) return;
                if (phase === "confirm") warning(detail);
                else if (detail) info(`  ${detail}`);
            },
        });
        if (out.offered) {
            if (!jsonMode) info(`Auto sync was ticked on the phone: restored ${win.label} with its key (no tap).`);
            if (jsonMode) say("restored", null, { ageMs: out.ageMs, reason: out.result?.reason ?? null });
            else reportRestore(out.result, win, { startedAt, keep: [ownId] });
            return;
        }
        const advice = await restoreAdvice(ownId);
        if (out.status === "ticked") {
            say("declined", `Auto sync was ticked on the phone; not restored (--no-sync). Later: \`${advice}\`.`, {
                command: advice,
            });
        } else if (out.status === "no-socket") {
            say("unknown", `Could not check the phone's auto sync offer: ${out.reason}. To restore: \`${advice}\`.`, {
                command: advice,
            });
        } else if (!newDevice) {
            say(
                "same-device",
                `Auto sync was not ticked (${out.reason}). This login kept its device id, so nothing needs restoring ` +
                    `unless the next listen/mcp start reports a gap.`,
                { offer: out.status },
            );
        } else {
            say(
                out.status,
                `No auto sync: ${out.reason}. History from before this login is not on this device; ` +
                    `restore it with: \`${advice}\` (it asks for a tap on the phone).`,
                { command: advice },
            );
        }
    } catch (e) {
        say("failed", `Auto sync failed: ${e.message}. Run \`zalo-agent sync\` to restore.`);
    } finally {
        releaseLock(accountDir);
    }
}

export function registerLoginCommands(program) {
    program
        .command("login")
        .description("Login to Zalo via QR code scan or from exported credentials")
        .option("-p, --proxy <url>", "Proxy URL (http/https/socks5://[user:pass@]host:port)")
        .option("-n, --name <label>", "Friendly name for this account", "")
        .option("--qr-url", "Start local HTTP server to view QR in browser (for VPS/headless)")
        .option("-q, --qr-port <port>", "Port for QR HTTP server (default: 18927)", parseIntOption)
        .option(
            "--public-url <url>",
            "Print the QR page as <url>/zalo/qr/<one-time token>, for a reverse proxy that routes /zalo/qr/ to the QR port (https, or http on localhost; or ZALO_MCP_PUBLIC_URL / publicUrl in mcp-config.json)",
        )
        .option("--credentials <path>", "Login from exported credentials file (skip QR)")
        .option(
            "--sync",
            "After the QR login, restore message history at once when 'sync messages' was ticked on the phone (no tap). The default since 3.0.0; kept for scripts",
        )
        .option(
            "--no-sync",
            "Only report whether 'sync messages' was ticked on the phone; restore nothing (later: zalo-agent sync)",
        )
        .option("--sync-days <n>", "When restoring after the login: only the last N days", parseIntAtLeast(1))
        .action(async (opts) => {
            // Credential-based login (headless/CI)
            if (opts.credentials) {
                try {
                    const raw = JSON.parse(readFileSync(opts.credentials, "utf-8"));
                    const proxy = opts.proxy || raw.proxy || null;
                    if (proxy) info(`Using proxy: ${maskProxy(proxy)}`);

                    const { ownId } = await loginWithCredentials(raw, proxy);

                    let displayName = opts.name || raw.name || "";
                    try {
                        const accountInfo = await getApi().fetchAccountInfo();
                        displayName = accountInfo?.profile?.displayName || displayName || ownId;
                    } catch {}

                    const creds = extractCredentials();
                    const device = loginDeviceChange(readSavedDevice(ownId), creds.imei);
                    saveCredentials(ownId, creds);
                    // A new login ends a kick: `fleet status` stops saying `kicked` before the daemon is back.
                    clearKickMarker(kickFile(getAccountDir(ownId)));
                    addAccount(ownId, displayName, proxy);
                    success(`Logged in as ${displayName} (${ownId})`);
                    info(describeLoginDevice(device, Date.now()));
                } catch (e) {
                    error(`Login from credentials failed: ${e.message}`);
                    process.exit(1);
                }
                return;
            }

            // QR-based login
            const jsonMode = program.opts().json;
            const pub = resolveLoginPublicUrl(opts.publicUrl);
            if (pub.error) {
                error(`Invalid public URL: ${pub.error}.`);
                process.exit(1);
            }
            if (opts.proxy) info(`Using proxy: ${maskProxy(opts.proxy)}`);
            if (!jsonMode) info("Generating QR code... Scan with Zalo mobile app.");

            let login = null;
            try {
                login = await runQrLogin({
                    proxy: opts.proxy,
                    jsonMode,
                    qrPort: opts.qrPort || 18927,
                    qrUrl: Boolean(opts.qrUrl),
                    publicUrl: pub.publicUrl,
                });
                const { ownId } = login;

                // Fetch display name from Zalo profile
                let displayName = opts.name || "";
                try {
                    const accountInfo = await getApi().fetchAccountInfo();
                    displayName = accountInfo?.profile?.displayName || displayName || ownId;
                } catch {}

                const creds = extractCredentials();
                const loginAt = Date.now();
                // Taken before the save: whether this login kept the account's device id (src/core/device-since.js).
                const device = loginDeviceChange(readSavedDevice(ownId), creds.imei);
                saveCredentials(ownId, creds, { now: loginAt });
                clearKickMarker(kickFile(getAccountDir(ownId)));
                addAccount(ownId, displayName, opts.proxy);

                if (jsonMode) {
                    console.log(
                        JSON.stringify({
                            event: "login_success",
                            ownId,
                            name: displayName,
                            newDevice: device.newDevice,
                            device: device.reason,
                        }),
                    );
                } else {
                    success(`Logged in as ${displayName} (${ownId})`);
                    info(describeLoginDevice(device, loginAt));
                }
                // The QR page says so too, and closes once it has.
                await login.finish("done");
                await watchLoginOffer(ownId, opts, { newDevice: device.newDevice, jsonMode });
            } catch (e) {
                if (jsonMode) {
                    console.log(JSON.stringify({ event: "login_error", message: e.message }));
                } else {
                    error(`Login failed: ${e.message}`);
                }
                await (login?.finish ?? e.finish)?.("failed", e.message);
                process.exit(1);
            }
        });

    program
        .command("logout")
        .description(
            "Log out: sign this device out at Zalo (as Zalo Web does) and delete its saved credentials, so the next command needs a new QR login. Chat history is kept unless --delete-history or --purge.",
        )
        .option(
            "--keep-session",
            "Only end this process's session key, as before v3.0: the saved login stays valid at Zalo and the device stays in the phone's list (local credentials are still deleted)",
        )
        .option(
            "--purge",
            "Fully remove this account from this machine: saved credentials plus all local data (chat cache, media, sync keys) and the registry entry",
        )
        .option(
            "--delete-history",
            'Also delete the local chat cache (zalo.db + downloaded media) for this account — mirrors the web app\'s "Delete chat history on logout" checkbox',
        )
        .option("--no-remote", "Skip the server-side logout call (still deletes the saved credentials locally)")
        .action(async (opts) => {
            const active = getActive();

            // Refuse before touching anything while a daemon holds the account:
            // the server logout would end the session it is using, and the
            // credential delete would leave it unable to re-auth.
            const holder = active ? lockHolder(active.ownId) : null;
            if (holder !== null) {
                error(
                    `A "listen"/"mcp" daemon (pid ${holder}) is running for this account. Stop it, then re-run logout — nothing was changed.`,
                );
                return;
            }
            const jsonMode = program.opts().json;
            // What --json prints: what was ended and deleted, in place of the lines below.
            const done = { loggedOut: true, account: active?.ownId ?? null, remote: null };

            // Sign this device out at Zalo the way Zalo Web does (the six steps in
            // src/zalo/official-logout.js), then check that the saved login is
            // refused, and report honestly — src/core/logout.js. Measured
            // 2026-09-30: the older calls (kept behind --keep-session) end only the
            // session KEY, never the login; the official steps do end it.
            // The saved credentials are deleted below either way.
            if (opts.remote !== false && isLoggedIn()) {
                const creds = active ? loadCredentials(active.ownId) : null;
                done.remote = await serverLogout(getApi(), {
                    keepSession: Boolean(opts.keepSession),
                    savedLogin: creds ? { creds, proxy: active.proxy || null, ownId: active.ownId } : null,
                });
                reportLogout(done.remote, { success, warning, info });
            }

            clearSession();

            if (!active) {
                output(done, jsonMode, () => success("Logged out."));
                return;
            }

            // --purge: remove the whole account (creds + all local data +
            // registry entry) via the shared removeAccount(), which aborts
            // rather than pull credentials out from under a running daemon.
            if (opts.purge) {
                try {
                    // Asked before the folder goes: the identity is in it.
                    const trustNote = describeTrustedDevice(active.ownId, "deleted");
                    const { wiped, skippedLocked } = removeAccount(active.ownId);
                    if (skippedLocked) {
                        error(
                            `Purge aborted: a "listen"/"mcp" daemon (pid ${skippedLocked.pid}) is still running for this account. Stop it, then re-run --purge.`,
                        );
                        info("Credentials and account registration were left untouched.");
                        return;
                    }
                    try {
                        unlinkSync(getQRPath());
                    } catch {}
                    output({ ...done, purged: true, localDataDeleted: wiped }, jsonMode, () => {
                        success(
                            `Logged out and purged ${active.name || active.ownId} — ${wiped ? "local account data deleted" : "no local account data found to delete"}.`,
                        );
                        if (trustNote && wiped) info(trustNote);
                    });
                } catch (e) {
                    // A filesystem-level failure (locked file, permissions, AV
                    // scanner) must not crash the process with a raw stack trace.
                    error(`Purge failed while removing account data/credentials: ${e.message}`);
                    warning("State may be partially removed — check with: zalo-agent account list");
                }
                return;
            }

            // Default (and --delete-history): a real logout — delete the saved
            // credentials so nothing auto-logs-in, keeping the chat cache
            // unless --delete-history asks otherwise. Guarded by the daemon lock.
            const outcome = finishLocalLogout(active.ownId, { deleteHistory: Boolean(opts.deleteHistory) });
            if (outcome.blockedPid !== undefined) {
                error(
                    `A "listen"/"mcp" daemon (pid ${outcome.blockedPid}) is still running for this account, so the credentials were kept — the next command would auto-login.`,
                );
                info("Stop the daemon and re-run logout to delete the saved credentials.");
                return;
            }

            try {
                unlinkSync(getQRPath());
            } catch {}
            const who = active.name || active.ownId;
            const historyGone = Boolean(
                opts.deleteHistory && (outcome.history.dbDeleted || outcome.history.mediaDeleted),
            );
            const result = { ...done, credentialsDeleted: outcome.credentialsDeleted, historyDeleted: historyGone };
            output(result, jsonMode, () => {
                if (outcome.credentialsDeleted) {
                    success(
                        `Logged out ${who} — saved credentials${historyGone ? " and local chat history" : ""} deleted; the next command needs a new QR login.`,
                    );
                } else {
                    success(
                        `Logged out ${who} — ${historyGone ? "local chat history deleted; " : ""}no saved credentials were found to delete.`,
                    );
                }
                const trustNote = describeTrustedDevice(active.ownId, "kept");
                if (trustNote) info(trustNote);
                if (opts.keepSession || opts.remote === false) {
                    info(
                        "This ended the session on this device only. To sign it out at Zalo, remove it from your phone's list of logged-in devices.",
                    );
                }
            });
        });

    program
        .command("status")
        .description("Show current login status")
        .action(() => {
            const active = getActive();
            const daemon = active ? getDaemonStatus(getAccountDir(active.ownId)) : null;
            const data = {
                loggedIn: isLoggedIn(),
                ownId: getOwnId(),
                activeAccount: active
                    ? { ownId: active.ownId, name: active.name, proxy: maskProxy(active.proxy) }
                    : null,
                daemon,
            };
            output(data, program.opts().json, () => {
                if (data.loggedIn) {
                    success(`Logged in as ${data.ownId}`);
                    if (active) info(`Account: ${active.name || active.ownId} | Proxy: ${maskProxy(active.proxy)}`);
                } else {
                    info("Not logged in");
                    // After a real logout the account stays registered but its
                    // credentials are gone, so auto-login would fail.
                    if (active && loadCredentials(active.ownId))
                        info(`Active account: ${active.name || active.ownId} (will auto-login on next command)`);
                    else if (active)
                        info(`Account ${active.name || active.ownId} is logged out — run: zalo-agent login`);
                }
                if (daemon) {
                    if (daemon.running) {
                        info(
                            `Daemon: running (PID ${daemon.pid}${daemon.channelPort ? `, channel 127.0.0.1:${daemon.channelPort}` : ""})`,
                        );
                    } else {
                        info("Daemon: not running");
                    }
                }
            });
        });

    program
        .command("whoami")
        .description("Show current user profile")
        .action(async () => {
            try {
                const api = getApi();
                const accountInfo = await api.fetchAccountInfo();
                const p = accountInfo?.profile || {};
                updateAccountName(p.userId || getOwnId(), p.displayName || p.zaloName);
                // Nothing extends the saved login, so when it ends is worth knowing before it does.
                const sessionExpiry = sessionExpiryFor(p.userId || getOwnId());
                output({ ...accountInfo, sessionExpiry }, program.opts().json, () => {
                    info(`Name: ${p.displayName || "?"}`);
                    info(`ID: ${p.userId || getOwnId()}`);
                    info(`Phone: ${p.phoneNumber || "?"}`);
                    const sessionLine = describeSessionExpiry(sessionExpiry);
                    if (sessionLine) info(sessionLine);
                });
            } catch (e) {
                error(e.message);
                // No profile is a failure: scripts and the live suite read the exit code.
                process.exitCode = 1;
            }
        });
    // Every logout needs --yes, and --dry-run says what it would end and delete (src/core/confirm-guard.js).
    guardSubcommand(program, "logout", "logout", {
        target: (opts) => ({
            account: getActive()?.ownId ?? null,
            keepSession: Boolean(opts.keepSession),
            purge: Boolean(opts.purge),
            deleteHistory: Boolean(opts.deleteHistory),
            remote: opts.remote !== false,
        }),
    });
}
