/**
 * Account commands — multi-account management with per-account proxy.
 * Includes export for headless/CI credential transfer.
 */

import { writeFileSync, chmodSync, existsSync } from "fs";
import { resolve, join } from "path";
import {
    loginWithCredentials,
    extractCredentials,
    clearSession,
    getApi,
    autoLogin,
    isLoggedIn,
} from "../core/zalo-client.js";
import { saveCredentials, loadCredentials, getAccountDir } from "../core/credentials.js";
import { initDb, summarizeCloudItems } from "../core/db.js";
import { describeAccountStatus, readAccountStatus } from "../core/account-status.js";
import { describeDevices, summarizeCompanion } from "../core/account-devices.js";
import { createTrustStore } from "../zalo/trust-store.js";
import { listAccounts, getActive, setActive, addAccount, removeAccount, getAccount } from "../core/accounts.js";
import { serverLogout, reportLogout, lockHolder, describeTrustedDevice } from "../core/logout.js";
import { maskProxy } from "../utils/proxy-helpers.js";
import { resolveLoginPublicUrl, runQrLogin } from "../core/qr-login-flow.js";
import { clearKickMarker, kickFile } from "../core/kick-marker.js";
import { success, error, info, warning, output } from "../utils/output.js";
import { guardSubcommand } from "../core/confirm-guard.js";
import { changeProvider, hasKeyring, migrateAccount, rekeyAccount, securityStatus } from "../core/keystore/index.js";
// Registers the encrypted stores' rekey handlers: a rekey without them would drop the key zalo.db is under.
import { fullSecurityStatus, migrateStores, storesStatus } from "../core/keystore/stores.js";
import { mediaStatus } from "../core/media-store.js";
import { PROVIDER_NAMES, readStorageFile, writeStorageFile } from "../core/keystore/config.js";
import { inTestSandbox } from "../core/keystore/providers.js";

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
        .option(
            "--public-url <url>",
            "Print the QR page as <url>/zalo/qr/<one-time token>, for a reverse proxy that routes /zalo/qr/ to the QR port (https, or http on localhost; or ZALO_MCP_PUBLIC_URL / publicUrl in mcp-config.json)",
        )
        .action(async (opts) => {
            const pub = resolveLoginPublicUrl(opts.publicUrl);
            if (pub.error) {
                error(`Invalid public URL: ${pub.error}.`);
                process.exit(1);
            }
            if (opts.proxy) info(`Using proxy: ${maskProxy(opts.proxy)}`);
            info("Generating QR code... Scan with Zalo mobile app.");

            let login = null;
            try {
                // The same QR flow as `login`: the page says how it ended, and an expired code is offered again.
                login = await runQrLogin({
                    proxy: opts.proxy,
                    jsonMode: process.env.ZALO_JSON_MODE === "1",
                    qrUrl: Boolean(opts.qrUrl),
                    publicUrl: pub.publicUrl,
                });
                const { ownId } = login;

                // Fetch display name from Zalo profile
                let displayName = opts.name || "";
                try {
                    const { getApi } = await import("../core/zalo-client.js");
                    const accountInfo = await getApi().fetchAccountInfo();
                    displayName = accountInfo?.profile?.displayName || displayName || ownId;
                } catch {}

                const creds = extractCredentials();
                saveCredentials(ownId, creds);
                // A new login ends a kick: `fleet status` stops saying `kicked` before the daemon is back.
                clearKickMarker(kickFile(getAccountDir(ownId)));
                addAccount(ownId, displayName, opts.proxy);
                success(
                    `Account logged in: ${displayName} (${ownId})${opts.proxy ? ` via ${maskProxy(opts.proxy)}` : ""}`,
                );
                await login.finish("done");
            } catch (e) {
                error(`Login failed: ${e.message}`);
                await (login?.finish ?? e.finish)?.("failed", e.message);
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
                await loginWithCredentials(creds, acc?.proxy || null, { ownId: ownerId });
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

            // Refuse before touching anything while a daemon holds the account,
            // as `logout` does: the server logout below would end the session
            // that daemon is using, and removeAccount() would then abort,
            // leaving a half-logged-out account behind.
            const holder = lockHolder(ownerId);
            if (holder !== null) {
                error(
                    `Removal aborted: a "listen"/"mcp" daemon (pid ${holder}) is still running for ${ownerId}. Stop it, then re-run — nothing was changed.`,
                );
                return;
            }

            // End the server-side session too, exactly as `logout` does
            // (src/core/logout.js). Only attempted when the account being
            // removed is the currently active one, since that's the only
            // case where autoLogin() can give us a live API session to end;
            // a non-active account's server-side session (if any) is left
            // alone, same as this command always did.
            let remote = null;
            if (getActive()?.ownId === ownerId) {
                await autoLogin(program.opts().json);
                if (isLoggedIn()) {
                    const saved = loadCredentials(ownerId);
                    remote = await serverLogout(getApi(), {
                        savedLogin: saved ? { creds: saved, proxy: acc.proxy || null, ownId: ownerId } : null,
                    });
                    reportLogout(remote, { success, warning, info });
                } else {
                    warning(
                        `Could not establish a session to invalidate remotely for ${ownerId} (continuing with local removal)`,
                    );
                }
                clearSession();
            }

            const trustNote = describeTrustedDevice(ownerId, "deleted");
            const { removed, wiped, skippedLocked } = removeAccount(ownerId);
            if (skippedLocked) {
                error(
                    `Removal aborted: a "listen" daemon (pid ${skippedLocked.pid}) is still running for ${ownerId}. Stop it, then re-run.`,
                );
                info("Credentials and account registration were left untouched.");
                return;
            }
            if (removed) {
                output({ removed: true, ownId: ownerId, localDataDeleted: wiped, remote }, program.opts().json, () => {
                    success(`Account ${ownerId} removed${wiped ? " — local data deleted" : ""}`);
                    if (trustNote && wiped) info(trustNote);
                });
            } else {
                error(`Account not found: ${ownerId}`);
            }
        });

    account
        .command("info")
        .description("Show currently active account")
        .action(() => {
            const active = getActive();
            // No active account is an answer, not a failure; --json says so with an object, never a bare null.
            const safe = active ? { ...active, proxy: maskProxy(active.proxy) } : { active: null };
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

            // Never the credentials themselves on stdout: the file holds them.
            output({ exported: true, ownId: acc.ownId, file: outPath }, program.opts().json, () => {
                success(`Exported to ${outPath}`);
                warning("This file contains login credentials. Keep it secure and do not commit to git.");
                info(`Import on another machine: zalo-agent login --credentials ${opts.output}`);
            });
        });

    account
        .command("status")
        .description(
            "Show the account's plans (read-only): the zBusiness package, the zCloud plan with its usage and limits",
        )
        .action(async () => {
            try {
                // Like `devices`: "account" subcommands skip the preAction login, so do it here.
                await autoLogin(program.opts().json);
                const ownId = getActive()?.ownId ?? null;
                // The local index is read only when this machine has a database for the account: asking must not
                // create one.
                let dbFile = null;
                if (ownId) {
                    const file = join(getAccountDir(ownId), "zalo.db");
                    if (existsSync(file)) dbFile = file;
                }
                if (dbFile) initDb(dbFile);
                const status = await readAccountStatus(getApi(), {
                    ownId,
                    localIndex: () => (dbFile ? summarizeCloudItems() : null),
                });
                output(status, program.opts().json, () => {
                    for (const line of describeAccountStatus(status)) info(line);
                });
                if (!status.sources.length) process.exitCode = 1;
            } catch (e) {
                error(`Failed to read the account's plans: ${e.message}`);
                process.exitCode = 1;
            }
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
                // the session's reply decoding unwraps result.data itself,
                // so there's no extra .data
                // layer to destructure here (confirmed against the real
                // API: destructuring .data silently produced undefined).
                const result = await getApi().getListDevice();
                const devices = result?.devices;
                // Which entry is this CLI: the companion identity saved by the official QR login, if there is one.
                const saved = createTrustStore(getAccountDir).load(String(getApi().getOwnId()));
                const mine = { companionId: saved?.companionId ?? null };
                const companions = (devices?.companions || []).map((c) => summarizeCompanion(c, mine));
                output({ devices, companions }, program.opts().json, () => {
                    for (const line of describeDevices(devices, mine)) console.log(`  ${line}`);
                });
            } catch (e) {
                error(`Failed to list devices: ${e.message}`);
            }
        });
    registerSecurityCommands(account, program);

    // It ends the session and deletes the account's data: --yes to act, --dry-run to preview (src/core/confirm-guard.js).
    guardSubcommand(account, "remove", "account.remove", { target: (ownerId) => ({ ownerId }) });
    // It writes the login out in plaintext: --yes to write it, --dry-run to preview.
    guardSubcommand(account, "export", "account.export", {
        target: (ownerId, opts) => ({ ownerId, output: resolve(opts.output) }),
    });
}

/**
 * The account(s) a security command acts on: the one named, else the active one, else (with `all`) every registered
 * account.
 *
 * @param {string|undefined} ownerId
 * @param {{all?: boolean}} [opts]
 * @returns {string[]}
 */
function targetAccounts(ownerId, { all = false } = {}) {
    if (ownerId) {
        if (!getAccount(ownerId)) throw new Error(`Account not found: ${ownerId}`);
        return [ownerId];
    }
    if (all) return listAccounts().map((a) => a.ownId);
    const active = getActive();
    if (!active) throw new Error("No active account: name one, or log in first");
    return [active.ownId];
}

/** Refuse while a daemon holds the account: it keeps the account's keys in memory and would write under old ones. */
function refuseWhileDaemon(ownId) {
    const holder = lockHolder(ownId);
    if (holder !== null) {
        throw new Error(
            `a "listen"/"mcp" daemon (pid ${holder}) is running for ${ownId}: stop it first, then re-run (nothing was changed)`,
        );
    }
}

/**
 * Log in to one account for the key layer (the dkey layer needs a live login), then let the session go.
 *
 * @param {string} ownId
 */
async function loginForKeys(ownId) {
    const creds = loadCredentials(ownId);
    if (!creds) throw new Error(`no saved login for ${ownId}: log in first`);
    const acc = getAccount(ownId);
    clearSession();
    try {
        // loginWithCredentials hands the live login to the key layer (src/core/zalo-client.js).
        await loginWithCredentials(creds, acc?.proxy || null, { ownId });
    } catch (e) {
        throw new Error(
            `the dkey layer needs a live login and Zalo could not be reached or refused it (${e.message}); the account's data stays locked until it can`,
        );
    } finally {
        clearSession();
    }
}

/** Whether a step for this account needs the dkey of a live login. */
function needsLogin(ownId) {
    const s = securityStatus(ownId);
    return Boolean(s.dkeyLayer.configured || s.dkeyLayer.active) && !s.dkeyLayer.unlockedInThisProcess;
}

/**
 * `account security …`: the at-rest protection of the account's files (src/core/keystore/, docs/security.md).
 *
 * @param {import("commander").Command} account
 * @param {import("commander").Command} program
 */
function registerSecurityCommands(account, program) {
    const security = account
        .command("security")
        .description("At-rest protection of the account's saved files: status, migrate, rekey, provider");
    const json = () => program.opts().json;
    const fail = (e) => {
        error(e.message);
        process.exitCode = 1;
    };

    security
        .command("status [ownerId]")
        .description(
            "Show how the account's files are protected: key provider, dkey layer, keyring version, which files are sealed and whether the message database is encrypted (never key material)",
        )
        .option("--all", "Every registered account")
        .action((ownerId, opts) => {
            try {
                const reports = targetAccounts(ownerId, opts).map((id) => fullSecurityStatus(id));
                output(opts.all ? { accounts: reports } : reports[0], json(), () => {
                    for (const r of reports) describeSecurity(r);
                });
            } catch (e) {
                fail(e);
            }
        });

    security
        .command("migrate [ownerId]")
        .description(
            "Seal every file still in plaintext and encrypt the message database (each verified before the plaintext is removed), and apply the dkey layer setting; idempotent",
        )
        .option("--all", "Every registered account")
        .action(async (ownerId, opts) => {
            try {
                const results = [];
                for (const id of targetAccounts(ownerId, opts)) {
                    refuseWhileDaemon(id);
                    let files = migrateAccount(id);
                    let login = null;
                    if (hasKeyring(id) && needsLogin(id)) {
                        try {
                            await loginForKeys(id);
                            login = "done";
                            files = migrateAccount(id);
                        } catch (e) {
                            login = e.message;
                        }
                    }
                    // The databases after the login: with the dkey layer on, their key opens only then.
                    files = [...files, ...migrateStores(id)];
                    if (files.some((f) => f.result === "failed" || f.result === "locked")) process.exitCode = 1;
                    results.push({ ownId: id, files, login, dkeyLayer: securityStatus(id).dkeyLayer });
                }
                output(opts.all ? { accounts: results } : results[0], json(), () => {
                    for (const r of results) {
                        info(`Account ${r.ownId}`);
                        for (const f of r.files) {
                            const n = f.sealed ? ` (${f.sealed} file(s))` : "";
                            const line = `  ${f.kind.padEnd(24)} ${f.result}${n}${f.error ? `: ${f.error}` : ""}`;
                            if (f.result === "failed" || f.result === "locked") warning(line);
                            else console.log(line);
                        }
                        if (r.login && r.login !== "done") warning(`  ${r.login}`);
                    }
                });
            } catch (e) {
                fail(e);
            }
        });

    security
        .command("rekey [ownerId]")
        .description(
            "Make new keys for the account, re-seal every file and re-encrypt the message database under them (the old keys are kept until it is done)",
        )
        .action(async (ownerId) => {
            try {
                const [id] = targetAccounts(ownerId);
                refuseWhileDaemon(id);
                if (needsLogin(id)) await loginForKeys(id);
                // The encrypted stores re-encrypt themselves in rekeyAccount (their handlers, registered by
                // keystore/stores.js); this reports where each one ended up.
                const res = rekeyAccount(id);
                const databases = storesStatus(id).map((d) => ({
                    kind: d.kind,
                    state: d.state,
                    ...(d.state === "encrypted" ? { currentKey: d.currentKey } : {}),
                }));
                const m = mediaStatus(id);
                const media = {
                    sealed: m.sealed,
                    staleKey: m.staleKey,
                    plaintext: m.plaintext,
                    unreadable: m.unreadable,
                };
                output(
                    { ownId: id, rekeyed: true, resealed: res.resealed, keys: res.keys, databases, media },
                    json(),
                    () => {
                        success(`Account ${id}: new keys, ${res.resealed} file(s) re-sealed`);
                        for (const d of databases) {
                            info(`  ${d.kind}: ${d.state}${d.currentKey ? ", under the new key" : ""}`);
                        }
                        info(`  media: ${media.sealed} file(s) sealed, ${media.staleKey} not under the new key`);
                    },
                );
            } catch (e) {
                fail(e);
            }
        });

    security
        .command("provider <name> [ownerId]")
        .description(
            `Protect the keyring with another key provider (${PROVIDER_NAMES.filter((p) => p !== "test").join(", ")}): re-wraps the keys of the account (default: every account with a keyring) and makes it the default for new ones`,
        )
        .option("--scope <scope>", "dpapi: CurrentUser (default) or LocalMachine")
        .option("--backend <backend>", "kms: aws, gcp, azure or vault")
        .option("--key <key>", "kms: the key ARN/id, key name, key URL or transit key name")
        .option("--with-key <mode>", "systemd-creds: auto, host, tpm2 or host+tpm2")
        .option("--passphrase-file <path>", "passphrase: read it from this file instead of asking")
        .action((name, ownerId, opts) => {
            try {
                // `test` is the offline sandbox's own provider, refused anywhere else (src/core/keystore/providers.js).
                if (!PROVIDER_NAMES.includes(name) || (name === "test" && !inTestSandbox())) {
                    throw new Error(`unknown key provider "${name}"`);
                }
                const extra = {
                    ...(opts.scope ? { scope: opts.scope } : {}),
                    ...(opts.backend ? { backend: opts.backend } : {}),
                    ...(opts.key ? { key: opts.key } : {}),
                    ...(opts.withKey ? { withKey: opts.withKey } : {}),
                    ...(opts.passphraseFile ? { file: resolve(opts.passphraseFile) } : {}),
                };
                const ids = ownerId
                    ? targetAccounts(ownerId)
                    : listAccounts()
                          .map((a) => a.ownId)
                          .filter((id) => hasKeyring(id));
                ids.forEach(refuseWhileDaemon);
                const changed = ids.map((id) => ({ ownId: id, ...changeProvider(id, name, extra) }));
                // New keyrings follow: the provider and its (non-secret) options go into storage.json.
                const settings = readStorageFile();
                const section = {
                    dpapi: "dpapi",
                    "systemd-creds": "systemdCreds",
                    kms: "kms",
                    passphrase: "passphrase",
                }[name];
                const next = { ...settings, provider: name };
                if (section && Object.keys(extra).length) next[section] = { ...(settings[section] ?? {}), ...extra };
                writeStorageFile(next);
                output({ provider: name, accounts: changed }, json(), () => {
                    for (const c of changed) success(`Account ${c.ownId}: keyring moved from ${c.from} to ${c.to}`);
                    info(`New accounts use "${name}" (storage.json)`);
                });
            } catch (e) {
                fail(e);
            }
        });
}

/** The human form of `account security status`. */
function describeSecurity(r) {
    info(`Account ${r.ownId}`);
    if (r.keyringError) warning(`  Keyring: ${r.keyringError}`);
    if (r.configError) warning(`  storage.json: ${r.configError}`);
    console.log(
        `  Keyring:    ${r.keyring ? `version ${r.keyring.version}, created ${r.keyring.createdAt}` : "none yet (made on the first seal)"}`,
    );
    if (r.keyring?.rekeyInProgress) warning("  A rekey did not finish: run `account security rekey` again");
    const configured =
        r.configuredProvider && r.provider && r.configuredProvider !== r.provider.name
            ? ` (configured: ${r.configuredProvider})`
            : "";
    console.log(`  Provider:   ${r.provider ? JSON.stringify(r.provider) : "-"}${configured}`);
    const pending =
        r.dkeyLayer.configured !== r.dkeyLayer.active
            ? ` (configured ${r.dkeyLayer.configured ? "on" : "off"}: applied at the next login)`
            : "";
    console.log(`  dkey layer: ${r.dkeyLayer.active ? "on" : "off"}${pending}`);
    for (const f of r.files) {
        const counts =
            f.kind === "media"
                ? `  (${f.sealed} sealed, ${f.plaintext} plaintext${f.unreadable ? `, ${f.unreadable} unreadable` : ""}` +
                  `${f.staleKey ? `, ${f.staleKey} under an old key` : ""}${f.capped ? ", counted up to 50,000" : ""})`
                : "";
        console.log(`  ${f.kind.padEnd(24)} ${f.state.padEnd(10)} ${f.key} key${counts}`);
    }
    if (r.plaintextFiles) warning(`  ${r.plaintextFiles} file(s) still plaintext: run "account security migrate"`);
}
