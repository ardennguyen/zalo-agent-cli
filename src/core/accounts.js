/**
 * Multi-account registry at ~/.zalo-agent-cli/accounts.json
 * Maps each account to its own proxy (1:1) and tracks active account.
 *
 * A fleet of daemons and the `account` / `login` commands share this one file, so it is written the
 * way a shared file must be (src/utils/atomic-file.js):
 *  - every change is read-modify-write under a lock file (`accounts.json.lock`), so two writers no
 *    longer lose each other's change;
 *  - every write is a temp file renamed over the target, so a reader never sees a half-written
 *    registry and a crash leaves the previous one;
 *  - the previous good registry is kept as `accounts.json.bak`;
 *  - a file that exists but cannot be read is an ERROR, never "no accounts": the next `login` used
 *    to replace it with a registry of one. Reads fall back to the `.bak`; with none, nothing is
 *    touched and the message says what to do.
 */

import { readFileSync, existsSync, mkdirSync, rmSync, renameSync } from "fs";
import { join } from "path";
import { CONFIG_DIR, getAccountDir, deleteCredentials } from "./credentials.js";
import { checkLock } from "./lock.js";
import { sleepSync, sweepStaleTemps, withFileLock, writeFileAtomic } from "../utils/atomic-file.js";

function accountsFile() {
    return join(CONFIG_DIR, "accounts.json");
}

function ensureDir() {
    mkdirSync(CONFIG_DIR, { recursive: true });
}

/** The registry exists but cannot be used as the account list. Nothing has been changed. */
export class RegistryError extends Error {
    constructor(message) {
        super(message);
        this.name = "RegistryError";
    }
}

/** Errors a read can raise on Windows for the instant a writer's rename replaces the file. */
const TRANSIENT_READ = new Set(["EPERM", "EBUSY", "EACCES", "ENOENT"]);

/** @param {string} text @returns {object[]} */
function parseRegistry(text) {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error("it is not a JSON array of accounts");
    return data;
}

/** @param {string} file */
function readFileRetrying(file) {
    for (let attempt = 0; ; attempt++) {
        try {
            return readFileSync(file, "utf-8");
        } catch (e) {
            if (!TRANSIENT_READ.has(e.code) || attempt >= 5) throw e;
            sleepSync(10);
        }
    }
}

let _warnedBackup = false;

/**
 * Read the registry.
 *
 * @returns {{ accounts: object[], source: "missing"|"file"|"backup" }}
 * @throws {RegistryError} when the file exists but is not a usable account list and there is no good backup
 */
function readRegistry() {
    const file = accountsFile();
    if (!existsSync(file)) return { accounts: [], source: "missing" };

    let problem;
    // A writer from before atomic writes can leave a half-written file for an instant: look again.
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return { accounts: parseRegistry(readFileRetrying(file)), source: "file" };
        } catch (e) {
            problem = e;
            if (attempt < 2) sleepSync(20);
        }
    }

    const backup = `${file}.bak`;
    try {
        const accounts = parseRegistry(readFileSync(backup, "utf-8"));
        if (!_warnedBackup) {
            _warnedBackup = true;
            console.error(
                `[accounts] ${file} is unreadable (${problem.message}); using its last good copy, ${backup}. ` +
                    "The next change to the registry replaces the damaged file and keeps it as accounts.json.corrupt-*.",
            );
        }
        return { accounts, source: "backup" };
    } catch {
        throw new RegistryError(
            `${file} exists but cannot be read as the account list (${problem.message}). It was left untouched. ` +
                "Fix it, or move it aside to start with no accounts.",
        );
    }
}

function load() {
    return readRegistry().accounts;
}

/** Write the registry atomically, keeping the previous good one as accounts.json.bak. */
function save(accounts) {
    ensureDir();
    const file = accountsFile();
    try {
        const current = readFileSync(file, "utf-8");
        parseRegistry(current);
        writeFileAtomic(`${file}.bak`, current, { durable: false });
    } catch {
        /* no current registry worth keeping */
    }
    writeFileAtomic(file, JSON.stringify(accounts, null, 2));
}

/**
 * Change the registry: lock, read the CURRENT contents, apply `fn`, write if it says it changed
 * something. `fn` gets the account array and returns `{ changed, value }`.
 *
 * @template T
 * @param {(accounts: object[]) => { changed: boolean, value: T }} fn
 * @param {{ timeoutMs?: number }} [lockOptions]
 * @returns {T}
 */
function mutate(fn, lockOptions) {
    ensureDir();
    return withFileLock(
        `${accountsFile()}.lock`,
        () => {
            const { accounts, source } = readRegistry();
            const result = fn(accounts);
            if (result.changed) {
                if (source === "backup") {
                    // Keep the damaged file for whoever wants to know what happened to it.
                    try {
                        renameSync(accountsFile(), `${accountsFile()}.corrupt-${Date.now()}`);
                    } catch {
                        /* it is replaced either way */
                    }
                }
                save(accounts);
                // A writer killed between creating its temp file and renaming it leaves that file behind.
                sweepStaleTemps(accountsFile());
                sweepStaleTemps(`${accountsFile()}.bak`);
            }
            return result.value;
        },
        lockOptions,
    );
}

let _pinnedAccountId = null;

/**
 * Pin this process's target account ID without modifying accounts.json on disk.
 * Used when `--account <id>` or `ZALO_ACCOUNT` is passed to a CLI command.
 * @param {string|null|undefined} ownId
 */
export function setPinnedAccount(ownId) {
    _pinnedAccountId = ownId ? String(ownId) : null;
}

/**
 * Return the process-pinned account ID if set, or null.
 * @returns {string|null}
 */
export function getPinnedAccountId() {
    return _pinnedAccountId;
}

/** List all registered accounts. */
export function listAccounts() {
    return load();
}

/** Get currently active (or process-pinned) account or null. */
export function getActive() {
    const accounts = load();
    if (_pinnedAccountId !== null) {
        return accounts.find((a) => a.ownId === _pinnedAccountId) || null;
    }
    return accounts.find((a) => a.active) || null;
}

/** Set an account as active (deactivates others). Returns false if not found. */
export function setActive(ownId) {
    return mutate((accounts) => {
        let found = false;
        for (const a of accounts) {
            if (a.ownId === ownId) {
                a.active = true;
                found = true;
            } else {
                a.active = false;
            }
        }
        return { changed: found, value: found };
    });
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
    mutate((accounts) => {
        const existing = accounts.find((a) => a.ownId === ownId);
        for (const a of accounts) a.active = a.ownId === ownId;
        if (existing) {
            existing.name = name || existing.name || "";
            existing.proxy = proxy;
        } else {
            accounts.push({ ownId, name, proxy, active: true });
        }
        return { changed: true, value: undefined };
    });
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
    const accountDir = getAccountDir(ownId);
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

    mutate((current) => {
        const filtered = current.filter((a) => a.ownId !== ownId);
        // If removed was active, activate first remaining
        if (filtered.length && !filtered.some((a) => a.active)) {
            filtered[0].active = true;
        }
        // The array is edited in place: `mutate` writes the one it handed us.
        current.splice(0, current.length, ...filtered);
        return { changed: true, value: undefined };
    });
    deleteCredentials(ownId);
    return { removed: true, wiped };
}

/**
 * Update the cached display name for a registered account in accounts.json
 * without changing which account is active or touching proxy settings.
 *
 * @param {string|null|undefined} ownId
 * @param {string|null|undefined} name
 * @param {{ lockTimeoutMs?: number }} [opts] - how long to wait for the registry's lock before giving up on this
 *   cosmetic refresh (3 s: a daemon calls this from event handlers); a test that is about lost writes, not about
 *   timing, waits longer
 * @returns {boolean} true when an existing account's name was changed
 */
export function updateAccountName(ownId, name, { lockTimeoutMs = 3000 } = {}) {
    const id = ownId ? String(ownId).trim() : "";
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!id || !trimmed) return false;
    // The common case, a daemon re-reading a name it already has, takes no lock and writes nothing.
    const unchanged = (accounts) => {
        const existing = accounts.find((a) => a.ownId === id);
        return !existing || existing.name === trimmed;
    };
    try {
        if (unchanged(load())) return false;
        return mutate(
            (accounts) => {
                if (unchanged(accounts)) return { changed: false, value: false };
                accounts.find((a) => a.ownId === id).name = trimmed;
                return { changed: true, value: true };
            },
            // Daemons call this from event handlers: a busy registry costs a missed cosmetic refresh,
            // not seconds of a blocked event loop.
            { timeoutMs: lockTimeoutMs },
        );
    } catch (e) {
        // A cached display name is not worth a daemon: say so and carry on.
        console.error(`[accounts] could not update the cached name of ${id}: ${e.message}`);
        return false;
    }
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
