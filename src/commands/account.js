/**
 * Account commands — multi-account management with per-account proxy.
 * Includes export for headless/CI credential transfer.
 */

import { writeFileSync, chmodSync } from "fs";
import { resolve } from "path";
import {
    loginWithQR,
    loginWithCredentials,
    extractCredentials,
    clearSession,
    getApi,
    autoLogin,
    isLoggedIn,
} from "../core/zalo-client.js";
import { saveCredentials, loadCredentials } from "../core/credentials.js";
import { listAccounts, getActive, setActive, addAccount, removeAccount, getAccount } from "../core/accounts.js";
import { maskProxy } from "../utils/proxy-helpers.js";
import { displayQR, getQRPath } from "../utils/qr-display.js";
import { startQrServer } from "../utils/qr-http-server.js";
import { success, error, info, warning, output } from "../utils/output.js";

export function registerAccountCommands(program) {
    const account = program.command("account").description("Manage multiple Zalo accounts with proxy");

    account
        .command("list")
        .description("List all registered accounts")
        .action(() => {
            const accounts = listAccounts();
            const safe = accounts.map((a) => ({ ...a, proxy: maskProxy(a.proxy) }));
            output(safe, program.opts().json, () => {
                if (!accounts.length) {
                    info("No accounts. Use: zalo-agent account login");
                    return;
                }
                console.log(`  ${"Active".padEnd(8)} ${"Owner ID".padEnd(22)} ${"Name".padEnd(20)} Proxy`);
                console.log(`  ${"─".repeat(75)}`);
                for (const a of accounts) {
                    const marker = a.active ? "  ★" : "   ";
                    console.log(
                        `  ${marker.padEnd(8)} ${a.ownId.padEnd(22)} ${(a.name || "").padEnd(20)} ${maskProxy(a.proxy)}`,
                    );
                }
            });
        });

    account
        .command("login")
        .description("Login a new Zalo account via QR code")
        .option("-p, --proxy <url>", "Dedicated proxy URL for this account")
        .option("-n, --name <label>", "Friendly label", "")
        .option("--qr-url", "Start local HTTP server to view QR in browser (for VPS/headless)")
        .action(async (opts) => {
            if (opts.proxy) info(`Using proxy: ${maskProxy(opts.proxy)}`);
            info("Generating QR code... Scan with Zalo mobile app.");

            let qrServer = null;
            try {
                const { ownId } = await loginWithQR(opts.proxy, (event) => {
                    displayQR(event);
                    if (!qrServer) {
                        qrServer = startQrServer(getQRPath());
                    }
                });

                // Fetch display name from Zalo profile
                let displayName = opts.name || "";
                try {
                    const { getApi } = await import("../core/zalo-client.js");
                    const accountInfo = await getApi().fetchAccountInfo();
                    displayName = accountInfo?.profile?.displayName || displayName || ownId;
                } catch {}

                const creds = extractCredentials();
                saveCredentials(ownId, creds);
                addAccount(ownId, displayName, opts.proxy);
                success(
                    `Account logged in: ${displayName} (${ownId})${opts.proxy ? ` via ${maskProxy(opts.proxy)}` : ""}`,
                );
            } catch (e) {
                error(`Login failed: ${e.message}`);
            } finally {
                if (qrServer) qrServer.close();
            }
        });

    account
        .command("switch <ownerId>")
        .description("Switch active account (restarts connection with account proxy)")
        .action(async (ownerId) => {
            let acc = getAccount(ownerId);
            if (!acc) {
                const all = listAccounts();
                const matches = all.filter((a) => a.ownId.includes(ownerId) || (a.name || "").includes(ownerId));
                if (matches.length === 1) {
                    ownerId = matches[0].ownId;
                    acc = matches[0];
                } else {
                    error(`Account not found: ${ownerId}`);
                    return;
                }
            }

            const creds = loadCredentials(ownerId);
            if (!creds) {
                error(`No credentials for ${ownerId}. Re-login needed.`);
                return;
            }

            info(`Switching to ${ownerId} (${acc?.name || ""})`);
            if (acc?.proxy) info(`Proxy: ${maskProxy(acc.proxy)}`);

            clearSession();
            try {
                await loginWithCredentials(creds, acc?.proxy || null);
                setActive(ownerId);
                success(`Switched to ${ownerId}`);
            } catch (e) {
                error(`Switch failed: ${e.message}`);
            }
        });

    account
        .command("remove <ownerId>")
        .description(
            "Fully remove an account from this machine: invalidates its server-side session (if it's the active/logged-in one), wipes its local data directory (db, media, sync keys, daemon.lock), deletes its credentials, and drops it from the registry",
        )
        .action(async (ownerId) => {
            const acc = getAccount(ownerId);
            if (!acc) {
                error(`Account not found: ${ownerId}`);
                return;
            }

            // Best-effort remote session invalidation, mirroring what
            // `logout` does — same reverse-engineered logoutV2() call. Only
            // attempted when the account being removed is the currently
            // active one, since that's the only case where autoLogin() can
            // give us a live API session to invalidate through; a
            // non-active account's server-side session (if any) is left
            // alone, same as this command always did.
            if (getActive()?.ownId === ownerId) {
                await autoLogin(program.opts().json);
                if (isLoggedIn()) {
                    try {
                        await getApi().logoutV2();
                        info(`Server session invalidated for ${ownerId}`);
                    } catch (e) {
                        warning(
                            `Could not confirm server-side logout for ${ownerId} (continuing with local removal): ${e.message}`,
                        );
                    }
                } else {
                    warning(`Could not establish a session to invalidate remotely for ${ownerId} (continuing with local removal)`);
                }
                clearSession();
            }

            const { removed, wiped, skippedLocked } = removeAccount(ownerId);
            if (skippedLocked) {
                warning(
                    `Removal aborted: a "listen" daemon (pid ${skippedLocked.pid}) is still running for ${ownerId}. Stop it, then re-run.`,
                );
                info("Credentials and account registration were left untouched.");
                return;
            }
            if (removed) {
                success(`Account ${ownerId} removed${wiped ? " — local data deleted" : ""}`);
            } else {
                error(`Account not found: ${ownerId}`);
            }
        });

    account
        .command("info")
        .description("Show currently active account")
        .action(() => {
            const active = getActive();
            const safe = active ? { ...active, proxy: maskProxy(active.proxy) } : null;
            output(safe, program.opts().json, () => {
                if (!active) {
                    info("No active account.");
                    return;
                }
                console.log(`  Owner ID: ${active.ownId}`);
                console.log(`  Name:     ${active.name || "-"}`);
                console.log(`  Proxy:    ${maskProxy(active.proxy)}`);
                console.log(`  Active:   yes`);
            });
        });

    account
        .command("export [ownerId]")
        .description("Export account credentials for transfer to another machine")
        .option("-o, --output <path>", "Output file path", "./zalo-creds.json")
        .action((ownerId, opts) => {
            const acc = ownerId ? getAccount(ownerId) : getActive();
            if (!acc) {
                error("No account found to export.");
                return;
            }

            const creds = loadCredentials(acc.ownId);
            if (!creds) {
                error(`No credentials for ${acc.ownId}.`);
                return;
            }

            const exportData = {
                ...creds,
                proxy: acc.proxy || null,
                ownId: acc.ownId,
                name: acc.name || "",
            };

            const outPath = resolve(opts.output);
            writeFileSync(outPath, JSON.stringify(exportData, null, 2), "utf-8");
            chmodSync(outPath, 0o600);

            success(`Exported to ${outPath}`);
            warning("This file contains login credentials. Keep it secure and do not commit to git.");
            info(`Import on another machine: zalo-agent login --credentials ${opts.output}`);
        });

    account
        .command("devices")
        .description("List devices/sessions currently linked to this account (read-only)")
        .action(async () => {
            try {
                // "account" subcommands are excluded from the preAction
                // autoLogin hook (they run their own explicit login/switch
                // flows), so trigger it here — same pattern mcp.js uses.
                await autoLogin(program.opts().json);
                // getListDevice() returns { devices: {...} } directly —
                // zca-js's resolveResponse() unwraps result.data itself
                // when called with no callback, so there's no extra .data
                // layer to destructure here (confirmed against the real
                // API: destructuring .data silently produced undefined).
                const result = await getApi().getListDevice();
                const devices = result?.devices;
                const companions = devices?.companions || [];
                output({ devices }, program.opts().json, () => {
                    if (!devices) {
                        info("No device data returned.");
                        return;
                    }
                    console.log(`  This session (master): ${devices.masterId}`);
                    console.log(`  Last updated:          ${new Date(devices.lastUpdateTs).toLocaleString()}`);
                    if (!companions.length) {
                        info("No other devices/sessions linked to this account.");
                    } else {
                        console.log(`  Other linked sessions (${companions.length}):`);
                        for (const c of companions) {
                            console.log(`    - ${JSON.stringify(c)}`);
                        }
                    }
                });
            } catch (e) {
                error(`Failed to list devices: ${e.message}`);
            }
        });
}
