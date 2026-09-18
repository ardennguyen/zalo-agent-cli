/**
 * Multi-account registry at ~/.zalo-agent-cli/accounts.json
 * Maps each account to its own proxy (1:1) and tracks active account.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { CONFIG_DIR, deleteCredentials } from "./credentials.js";
import { checkLock } from "./lock.js";

const ACCOUNTS_FILE = `${CONFIG_DIR}/accounts.json`;

function ensureDir() {
    mkdirSync(CONFIG_DIR, { recursive: true });
}

function load() {
    if (!existsSync(ACCOUNTS_FILE)) return [];
    try {
        return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf-8"));
    } catch {
        return [];
    }
}

function save(accounts) {
    ensureDir();
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), "utf-8");
    chmodSync(ACCOUNTS_FILE, 0o600);
}

/** List all registered accounts. */
export function listAccounts() {
    return load();
}

/** Get currently active account or null. */
export function getActive() {
    return load().find((a) => a.active) || null;
}

/** Set an account as active (deactivates others). Returns false if not found. */
export function setActive(ownId) {
    const accounts = load();
    let found = false;
    for (const a of accounts) {
        if (a.ownId === ownId) {
            a.active = true;
            found = true;
        } else {
            a.active = false;
        }
    }
    if (found) save(accounts);
    return found;
}

/**
 * Register a new account or update existing — either way, the account just
 * logged into always becomes the active one and every other entry is
 * deactivated to match.
 *
 * (Previously, re-logging into an account that was *already* registered
 * left `active` untouched on every entry — so logging back into account B,
 * while account A was still flagged active from an earlier session, would
 * silently leave A as the "active" account in accounts.json. Since each CLI
 * invocation is its own process, the next command — logout included — would
 * then auto-login into and operate on A, not the B you'd just authenticated
 * as. `account switch` already did this correctly via an explicit
 * `setActive()` call after login; this brings plain `login`/`account login`
 * in line with it.)
 */
export function addAccount(ownId, name = "", proxy = null) {
    const accounts = load();
    const existing = accounts.find((a) => a.ownId === ownId);
    for (const a of accounts) a.active = a.ownId === ownId;
    if (existing) {
        existing.name = name || existing.name || "";
        existing.proxy = proxy;
    } else {
        accounts.push({ ownId, name, proxy, active: true });
    }
    save(accounts);
}

/**
 * Remove this account's entire per-account data directory —
 * ~/.zalo-agent-cli/accounts/<ownId>/ — not just the chat cache: zalo.db,
 * media/, the sync/ subfolder (RSA keys + any old sync dumps), and
 * daemon.lock. Credentials themselves live elsewhere, under
 * CREDENTIALS_DIR, and are handled separately (see removeAccount below).
 *
 * Refuses to touch the directory while a `listen` daemon actively holds
 * its lock (deleting a directory a running process has files open in can
 * fail outright on Windows, and is asking for trouble even where it
 * "succeeds") — reports the PID instead so the caller can decide.
 *
 * Shared by `logout --purge` (scoped to whichever account is active) and
 * `account remove <id>` (scoped to an explicit account), so both commands
 * wipe local data the same way.
 * @param {string} ownId
 * @returns {{wiped: boolean, skippedLocked?: {pid: number}}}
 */
export function wipeAccountDir(ownId) {
    const accountDir = join(CONFIG_DIR, "accounts", ownId);
    if (!existsSync(accountDir)) return { wiped: false };

    const lockStatus = checkLock(accountDir);
    if (lockStatus.locked) {
        return { wiped: false, skippedLocked: { pid: lockStatus.pid } };
    }

    rmSync(accountDir, { recursive: true, force: true });
    return { wiped: true };
}

/**
 * Fully remove an account from this machine: wipes its local data
 * directory (see wipeAccountDir), deletes its credentials file, and drops
 * it from the registry (activating the first remaining account, if any,
 * when the removed one was active). Aborts entirely — leaving credentials
 * and the registry entry untouched — if a `listen` daemon still holds the
 * lock on that account's data directory, so credentials are never deleted
 * out from under a running process.
 * @param {string} ownId
 * @returns {{removed: boolean, wiped?: boolean, skippedLocked?: {pid: number}}}
 */
export function removeAccount(ownId) {
    const accounts = load();
    if (!accounts.some((a) => a.ownId === ownId)) return { removed: false };

    const { wiped, skippedLocked } = wipeAccountDir(ownId);
    if (skippedLocked) {
        return { removed: false, skippedLocked };
    }

    const filtered = accounts.filter((a) => a.ownId !== ownId);
    // If removed was active, activate first remaining
    if (filtered.length && !filtered.some((a) => a.active)) {
        filtered[0].active = true;
    }
    save(filtered);
    deleteCredentials(ownId);
    return { removed: true, wiped };
}

/** Get account by ownId. */
export function getAccount(ownId) {
    return load().find((a) => a.ownId === ownId) || null;
}

/** Get proxy URL for a specific account. */
export function getProxyFor(ownId) {
    const acc = getAccount(ownId);
    return acc?.proxy || null;
}
