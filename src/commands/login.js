/**
 * Login commands — QR login, credential login, logout, status, whoami.
 */

import { readFileSync, unlinkSync } from "fs";
import { LoginQRCallbackEventType } from "zca-js";
import {
    loginWithQR,
    loginWithCredentials,
    extractCredentials,
    clearSession,
    isLoggedIn,
    getApi,
    getOwnId,
} from "../core/zalo-client.js";
import { saveCredentials, loadCredentials } from "../core/credentials.js";
import { addAccount, getActive, removeAccount } from "../core/accounts.js";
import { serverLogout, reportLogout, finishLocalLogout, lockHolder } from "../core/logout.js";
import { maskProxy } from "../utils/proxy-helpers.js";
import { displayQR, getQRPath } from "../utils/qr-display.js";
import { startQrServer } from "../utils/qr-http-server.js";
import { success, error, info, warning, output } from "../utils/output.js";
import { parseIntOption } from "../utils/parse-options.js";

export function registerLoginCommands(program) {
    program
        .command("login")
        .description("Login to Zalo via QR code scan or from exported credentials")
        .option("-p, --proxy <url>", "Proxy URL (http/https/socks5://[user:pass@]host:port)")
        .option("-n, --name <label>", "Friendly name for this account", "")
        .option("--qr-url", "Start local HTTP server to view QR in browser (for VPS/headless)")
        .option("-q, --qr-port <port>", "Port for QR HTTP server (default: 18927)", parseIntOption)
        .option("--credentials <path>", "Login from exported credentials file (skip QR)")
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
                    saveCredentials(ownId, creds);
                    addAccount(ownId, displayName, proxy);
                    success(`Logged in as ${displayName} (${ownId})`);
                } catch (e) {
                    error(`Login from credentials failed: ${e.message}`);
                    process.exit(1);
                }
                return;
            }

            // QR-based login
            const jsonMode = program.opts().json;
            if (opts.proxy) info(`Using proxy: ${maskProxy(opts.proxy)}`);
            if (!jsonMode) info("Generating QR code... Scan with Zalo mobile app.");

            let qrServer = null;
            try {
                const { ownId } = await loginWithQR(opts.proxy, (event) => {
                    switch (event.type) {
                        case LoginQRCallbackEventType.QRCodeGenerated:
                            displayQR(event);
                            // The QR is a login token, so the HTTP view binds
                            // loopback unless --qr-url explicitly asks for LAN
                            // exposure (the VPS/headless case the flag exists
                            // for). It used to bind 0.0.0.0 unconditionally,
                            // handing anyone on the network a usable login QR
                            // on every `zalo-agent login`.
                            if (!qrServer) {
                                qrServer = startQrServer(
                                    getQRPath(),
                                    opts.qrPort || 18927,
                                    [opts.qrPort || 18927, 8080, 3000, 9000],
                                    Boolean(opts.qrUrl),
                                );
                            }
                            break;

                        case LoginQRCallbackEventType.QRCodeScanned: {
                            // Mirrors what real Zalo Web shows the instant the
                            // phone scans: the account's name (and avatar URL,
                            // since we don't inline-fetch/render images here)
                            // — zca-js already hands this through in
                            // event.data, it was just never surfaced.
                            const name = event.data?.display_name || "unknown";
                            if (jsonMode) {
                                console.log(
                                    JSON.stringify({
                                        event: "qr_scanned",
                                        name,
                                        avatar: event.data?.avatar || null,
                                    }),
                                );
                            } else {
                                info(`Scanned by ${name} — confirm on your phone to finish logging in.`);
                                if (event.data?.avatar) info(`Avatar: ${event.data.avatar}`);
                            }
                            break;
                        }

                        case LoginQRCallbackEventType.QRCodeDeclined:
                            // The zca-js patch now rejects loginQR()'s promise
                            // right after firing this event, so the catch
                            // block below reports the terminal failure — this
                            // is just the immediate heads-up, matching how
                            // real Zalo Web reacts the instant you decline.
                            if (jsonMode) {
                                console.log(JSON.stringify({ event: "qr_declined" }));
                            } else {
                                warning("Login declined on phone.");
                            }
                            break;

                        case LoginQRCallbackEventType.QRCodeExpired:
                            // Without this, a callback-style login (which is
                            // what this CLI always uses) never calls
                            // actions.retry()/abort() itself, so zca-js just
                            // leaves the QR expired and the whole login hangs
                            // forever instead of refreshing — auto-retry here
                            // matches upstream zca-js's own no-callback
                            // default behavior.
                            if (jsonMode) {
                                console.log(JSON.stringify({ event: "qr_expired" }));
                            } else {
                                info("QR expired — generating a new one...");
                            }
                            event.actions?.retry?.();
                            break;

                        default:
                            break;
                    }
                });

                // Fetch display name from Zalo profile
                let displayName = opts.name || "";
                try {
                    const accountInfo = await getApi().fetchAccountInfo();
                    displayName = accountInfo?.profile?.displayName || displayName || ownId;
                } catch {}

                const creds = extractCredentials();
                saveCredentials(ownId, creds);
                addAccount(ownId, displayName, opts.proxy);

                if (jsonMode) {
                    console.log(JSON.stringify({ event: "login_success", ownId, name: displayName }));
                } else {
                    success(`Logged in as ${displayName} (${ownId})`);
                }
            } catch (e) {
                if (jsonMode) {
                    console.log(JSON.stringify({ event: "login_error", message: e.message }));
                } else {
                    error(`Login failed: ${e.message}`);
                }
                process.exit(1);
            } finally {
                if (qrServer) qrServer.close();
            }
        });

    program
        .command("logout")
        .description(
            "Log out: end the session and delete this device's saved credentials, so the next command needs a new QR login. Chat history is kept unless --delete-history or --purge.",
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
                warning(
                    `A "listen"/"mcp" daemon (pid ${holder}) is running for this account. Stop it, then re-run logout — nothing was changed.`,
                );
                return;
            }

            // Ask Zalo to end the session (production logout first, then the
            // optional logoutV2) and report honestly — src/core/logout.js.
            // Measured live 2026-09-30: these calls end only this device's
            // session KEY, never the login. The saved credentials would
            // auto-log-in on the next command, so a real logout deletes them
            // too (below); the web session is revoked at Zalo only from the
            // phone's device list.
            if (opts.remote !== false && isLoggedIn()) {
                reportLogout(await serverLogout(getApi()), { success, warning, info });
            }

            clearSession();

            if (!active) {
                success("Logged out.");
                return;
            }

            // --purge: remove the whole account (creds + all local data +
            // registry entry) via the shared removeAccount(), which aborts
            // rather than pull credentials out from under a running daemon.
            if (opts.purge) {
                try {
                    const { wiped, skippedLocked } = removeAccount(active.ownId);
                    if (skippedLocked) {
                        warning(
                            `Purge aborted: a "listen"/"mcp" daemon (pid ${skippedLocked.pid}) is still running for this account. Stop it, then re-run --purge.`,
                        );
                        info("Credentials and account registration were left untouched.");
                        return;
                    }
                    try {
                        unlinkSync(getQRPath());
                    } catch {}
                    success(
                        `Logged out and purged ${active.name || active.ownId} — ${wiped ? "local account data deleted" : "no local account data found to delete"}.`,
                    );
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
                warning(
                    `A "listen"/"mcp" daemon (pid ${outcome.blockedPid}) is still running for this account, so the credentials were kept — the next command would auto-login.`,
                );
                info("Stop the daemon and re-run logout to delete the saved credentials.");
                return;
            }

            try {
                unlinkSync(getQRPath());
            } catch {}
            const who = active.name || active.ownId;
            const historyGone = opts.deleteHistory && (outcome.history.dbDeleted || outcome.history.mediaDeleted);
            if (outcome.credentialsDeleted) {
                success(
                    `Logged out ${who} — saved credentials${historyGone ? " and local chat history" : ""} deleted; the next command needs a new QR login.`,
                );
            } else {
                success(
                    `Logged out ${who} — ${historyGone ? "local chat history deleted; " : ""}no saved credentials were found to delete.`,
                );
            }
            info(
                "This ends the session on this device only. To sign it out at Zalo, remove it from your phone's list of logged-in devices.",
            );
        });

    program
        .command("status")
        .description("Show current login status")
        .action(() => {
            const active = getActive();
            const data = {
                loggedIn: isLoggedIn(),
                ownId: getOwnId(),
                activeAccount: active
                    ? { ownId: active.ownId, name: active.name, proxy: maskProxy(active.proxy) }
                    : null,
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
            });
        });

    program
        .command("whoami")
        .description("Show current user profile")
        .action(async () => {
            try {
                const api = getApi();
                const accountInfo = await api.fetchAccountInfo();
                output(accountInfo, program.opts().json, () => {
                    const p = accountInfo?.profile || {};
                    info(`Name: ${p.displayName || "?"}`);
                    info(`ID: ${p.userId || getOwnId()}`);
                    info(`Phone: ${p.phoneNumber || "?"}`);
                });
            } catch (e) {
                error(e.message);
                // No profile is a failure: scripts and the live suite read the exit code.
                process.exitCode = 1;
            }
        });
}
