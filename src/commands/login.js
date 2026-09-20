/**
 * Login commands — QR login, credential login, logout, status, whoami.
 */

import { readFileSync, unlinkSync, existsSync, rmSync } from "fs";
import { join } from "path";
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
import { saveCredentials, CONFIG_DIR } from "../core/credentials.js";
import { addAccount, getActive, removeAccount } from "../core/accounts.js";
import { maskProxy } from "../utils/proxy-helpers.js";
import { displayQR, getQRPath } from "../utils/qr-display.js";
import { startQrServer } from "../utils/qr-http-server.js";
import { success, error, info, warning, output } from "../utils/output.js";
import { parseIntOption } from "../utils/parse-options.js";

/**
 * Delete the local chat cache (zalo.db + WAL/SHM sidecars) and downloaded
 * media for one account. Mirrors Zalo Web's "Xóa lịch sử trò chuyện khi
 * đăng xuất" (delete chat history on logout) checkbox — confirmed by
 * reverse-engineering to be a purely local operation there too (a
 * z_cleardata localStorage flag consumed by the web client's own
 * deleteAllData(), no server call involved), so this needs no network
 * round trip on the CLI side either.
 * @param {string} ownId
 * @returns {{dbDeleted: boolean, mediaDeleted: boolean}}
 */
function deleteLocalHistory(ownId) {
    const accountDir = join(CONFIG_DIR, "accounts", ownId);
    let dbDeleted = false;
    let mediaDeleted = false;

    if (existsSync(accountDir)) {
        // zalo.db plus its WAL-mode sidecar files (-wal, -shm), if present.
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            const p = join(accountDir, `zalo.db${suffix}`);
            if (existsSync(p)) {
                rmSync(p, { force: true });
                dbDeleted = true;
            }
        }

        const mediaDir = join(accountDir, "media");
        if (existsSync(mediaDir)) {
            rmSync(mediaDir, { recursive: true, force: true });
            mediaDeleted = true;
        }
    }

    return { dbDeleted, mediaDeleted };
}

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
        .description("Logout current account, matching Zalo Web's logout dialog options")
        .option(
            "--purge",
            "Fully remove this account from this machine: deletes saved credentials (must QR login again) plus all local data (chat cache, media, sync keys) — implies --delete-history and then some",
        )
        .option(
            "--delete-history",
            'Also delete the local chat cache (zalo.db + downloaded media) for this account — mirrors the web app\'s "Delete chat history on logout" checkbox. Superseded by --purge, which wipes more than just this.',
        )
        .option(
            "--no-remote",
            "Skip real server-side session invalidation (local-only logout, previous default behavior)",
        )
        .action(async (opts) => {
            const active = getActive();

            // Real server-side session invalidation. This actually ends the
            // session at Zalo's servers — confirmed live via
            // `https://wpa.chat.zalo.me/api/v2/login/logOut`, which returns
            // {error_code:0, error_message:"Successful.", data:1} on
            // success, and a follow-up authenticated call right after fails
            // with error_code 600 "zpw_sek bị thiếu hoặc không đúng" —
            // proof the session is genuinely dead, not a no-op. Unlike the
            // old clearSession()-only logout, which just forgot the
            // in-memory handle and left the exported credentials/cookie
            // valid indefinitely. Best-effort: if it fails (network error,
            // Zalo changes the endpoint), don't block the local logout on it.
            if (opts.remote !== false && isLoggedIn()) {
                try {
                    const ctx = getApi().getContext();
                    await getApi().logoutV2();
                    info(`Server session invalidated for imei ${ctx.imei.slice(0, 8)}…`);
                } catch (e) {
                    warning(`Could not confirm server-side logout (continuing with local logout): ${e.message}`);
                }
            }

            clearSession();

            let historyMsg = "";
            let purgeBlockedPid = null;
            let purgeError = null;
            if (opts.purge && active) {
                // --purge means "remove this account from this machine" —
                // the same shared removeAccount() logic `account remove
                // <id>` uses (wipes the whole per-account directory: db,
                // media, sync keys, lock file — then deletes credentials
                // and drops the accounts.json entry), just scoped
                // implicitly to whichever account is active instead of an
                // explicit ID.
                try {
                    const { wiped, skippedLocked } = removeAccount(active.ownId);
                    if (skippedLocked) {
                        // Don't pull credentials out from under a daemon
                        // that's still actively using them against an
                        // un-wiped db — that would leave it running on an
                        // orphaned session with no way to re-auth. The
                        // whole purge aborts, not just the file wipe.
                        purgeBlockedPid = skippedLocked.pid;
                    } else {
                        historyMsg = wiped
                            ? " — local account data deleted"
                            : " — no local account data found to delete";
                    }
                } catch (e) {
                    // Don't let a filesystem-level failure here (locked
                    // file, permissions, AV scanner, whatever) crash the
                    // whole process with a raw stack trace.
                    purgeError = e;
                }
            } else if (opts.deleteHistory && active) {
                const { dbDeleted, mediaDeleted } = deleteLocalHistory(active.ownId);
                if (dbDeleted || mediaDeleted) {
                    historyMsg = " — local chat history deleted";
                } else {
                    historyMsg = " — no local chat history found to delete";
                }
            }

            if (opts.purge && active && purgeBlockedPid !== null) {
                warning(
                    `Purge aborted: a "listen" daemon (pid ${purgeBlockedPid}) is still running for this account. Stop it, then re-run --purge.`,
                );
                info("Credentials and account registration were left untouched.");
            } else if (opts.purge && active && purgeError) {
                // The local account-data wipe may have already run/reported
                // above; report this failure the same way and let the user
                // retry or clean up manually.
                error(`Purge failed while removing account data/credentials: ${purgeError.message}`);
                warning("State may be partially removed — check with: zalo-agent account list");
            } else if (opts.purge && active) {
                // Also remove QR image
                try {
                    unlinkSync(getQRPath());
                } catch {}
                success(`Logged out and purged credentials for ${active.name || active.ownId}${historyMsg}`);
            } else {
                success(`Logged out (credentials kept — will auto-login on next command)${historyMsg}`);
                if (active) info(`To fully remove: zalo-agent account remove ${active.ownId}`);
            }
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
                    if (active)
                        info(`Active account: ${active.name || active.ownId} (will auto-login on next command)`);
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
            }
        });
}
