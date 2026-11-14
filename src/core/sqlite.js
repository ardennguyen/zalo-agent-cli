/**
 * The one SQLite driver of the app, and the one way an account's database is opened.
 *
 * The driver is `better-sqlite3-multiple-ciphers`, a fork of `better-sqlite3` with the same API (it adds `key` /
 * `rekey`) and the SQLite3MultipleCiphers build of SQLite. Every module and test imports it from here, never the
 * package by name.
 *
 * {@link openDatabase} opens an account's database encrypted at rest: SQLCipher v4 (`cipher=sqlcipher, legacy=4`:
 * AES-256-CBC with an HMAC-SHA512 per page, so the file also opens in the standard SQLCipher tools with the key), keyed
 * with a raw 256-bit subkey of the account's data key (`getDataKey(ownId, "sqlcipher")`, no KDF), `secure_delete=ON`,
 * WAL. The account is the folder the file sits in (`accounts/<ownId>/zalo.db`), as for the keyring. A missing file is
 * created encrypted; there is no plaintext create path.
 *
 * A plaintext database (written by 2.x) is migrated by the first writer that opens it: checkpointed and held against
 * writers, copied, the copy encrypted in place (`PRAGMA rekey`, which SQLite3MC allows only out of WAL) and verified
 * (`quick_check`, the row count of every table, no plaintext header), then swapped in, and only then is the plaintext
 * overwritten with zeros and removed, with its `-wal` / `-shm`. No plaintext copy is kept. Each step leaves a state
 * the next open recognizes, so a crash at any point leaves one readable database:
 *
 *     <db>.encrypting      a copy being encrypted, never verified       → removed
 *     <db>.encrypted       the verified encrypted copy                  → swapped in if <db> is gone; dropped (and the
 *                                                                         migration redone) while <db> is still plaintext
 *     <db>.plaintext-old   the plaintext, moved aside for the swap      → shredded once <db> opens encrypted
 *
 * A read-only opener never migrates: it gets `KeystoreError` `PLAINTEXT`.
 *
 * `serialize()` returns the decrypted database in memory, so it is disabled on every handle opened here (and a test
 * forbids it in src/). `backup()` to a file is refused by SQLite3MC for an encrypted source; `VACUUM INTO` writes an
 * encrypted copy under the same key.
 */
import {
    closeSync,
    copyFileSync,
    existsSync,
    fstatSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readSync,
    renameSync,
    rmSync,
    statSync,
    statfsSync,
    writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { withFileLock } from "../zalo/kernel/atomic-file.js";
import { KeystoreError } from "./keystore/container.js";
import { deriveDataKey, readKeyring, scopeOfDir } from "./keystore/keyring.js";
import { checkLock } from "./lock.js";

export { Database };
export default Database;

/** The first 16 bytes of every plaintext SQLite database. An encrypted one starts with random bytes. */
export const PLAINTEXT_HEADER = Buffer.from("SQLite format 3\0", "latin1");

/** How long a writer waits for another one (better-sqlite3's default, kept explicit). */
const BUSY_TIMEOUT_MS = 5000;
/** Free disk a migration needs, as a multiple of the database (the copy, plus its journal while it is encrypted). */
const DISK_FACTOR = 1.1;

const ENCRYPTING = ".encrypting";
const ENCRYPTED = ".encrypted";
const PLAINTEXT_OLD = ".plaintext-old";

/**
 * What a database file is on disk, from its first 16 bytes (no key needed).
 *
 * @param {string} file
 * @returns {"absent"|"empty"|"plaintext"|"encrypted"}
 */
export function dbFileState(file) {
    let fd;
    try {
        fd = openSync(file, "r");
    } catch (e) {
        if (e.code === "ENOENT") return "absent";
        throw e;
    }
    try {
        const head = Buffer.alloc(PLAINTEXT_HEADER.length);
        const n = readSync(fd, head, 0, head.length, 0);
        if (n === 0) return "empty";
        return n === head.length && head.equals(PLAINTEXT_HEADER) ? "plaintext" : "encrypted";
    } finally {
        closeSync(fd);
    }
}

const inMemory = (file) => !file || file === ":memory:" || String(file).startsWith("file::memory:");

/**
 * The keys a database may be under, the current data key first, then the retired ones (a rekey that has not
 * finished). The caller must not log, store or return `key`.
 *
 * @param {{id: string, dir: string}} scope
 * @param {string} purpose
 * @param {{create?: boolean}} [opts] - false: never create a keyring (an existing encrypted file needs the one it was
 *   made with)
 * @returns {Array<{key: Buffer, keyId: string}>}
 */
function candidateKeys(scope, purpose, { create = true } = {}) {
    const ring = readKeyring(scope.dir);
    if (!ring && !create) {
        throw new KeystoreError(
            `account ${scope.id} has an encrypted database but no keyring (${resolve(scope.dir, "keyring.json")}): ` +
                "it cannot be opened without the keyring it was made with",
            "NO_KEYRING",
        );
    }
    const keys = [deriveDataKey(scope, purpose)];
    const retired = (readKeyring(scope.dir)?.retired ?? []).filter((k) => k.use === "data" && k.id !== keys[0].keyId);
    for (const k of retired) {
        try {
            keys.push(deriveDataKey(scope, purpose, { keyId: k.id }));
        } catch {
            /* a retired key that does not open is no candidate */
        }
    }
    return keys;
}

/** Apply the cipher settings and the key to a fresh connection. */
function applyKey(db, key) {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma("legacy = 4");
    db.pragma(`key = "x'${key.toString("hex")}'"`);
}

/**
 * Open a connection with one key: null when the key does not open the file (SQLITE_NOTADB).
 *
 * @returns {import("better-sqlite3-multiple-ciphers").Database|null}
 */
function tryKey(file, key, { readonly }) {
    const db = new Database(
        file,
        readonly ? { readonly: true, fileMustExist: true, timeout: BUSY_TIMEOUT_MS } : { timeout: BUSY_TIMEOUT_MS },
    );
    try {
        applyKey(db, key);
        // The first read is where a wrong key (or a file that is no database) shows.
        db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
        return db;
    } catch (e) {
        db.close();
        if (e.code === "SQLITE_NOTADB") return null;
        throw e;
    }
}

/** No plaintext ever leaves a handle opened here. */
function guard(db, file) {
    Object.defineProperty(db, "serialize", {
        value: () => {
            throw new Error(`serialize() is disabled for ${basename(file)}: it returns the database decrypted`);
        },
    });
    return db;
}

/**
 * Open (creating if needed) an account's database, encrypted. See the module comment.
 *
 * @param {string} file - `accounts/<ownId>/<name>.db`; `:memory:` gives a plain in-memory database
 * @param {object} [opts]
 * @param {string} [opts.purpose] - the data-key purpose (`sqlcipher` for zalo.db, `outbox` for the webhook outbox)
 * @param {boolean} [opts.readonly] - never creates, never migrates: a plaintext file is `KeystoreError` `PLAINTEXT`
 * @param {(line: string) => void} [opts.log] - progress of a migration (stderr by default)
 * @param {object} [opts.hooks] - tests: called between the migration's steps (see {@link migratePlaintextDatabase})
 * @param {string} [opts.accountDir] - the account whose key opens it, when the file is not in its folder (a copy
 *   made by `db backup` / `db export`); read-only use, it never creates a keyring there
 * @returns {import("better-sqlite3-multiple-ciphers").Database} with `keyId`: the data key it opened with
 * @throws {KeystoreError} `PLAINTEXT` (read-only on a plaintext file), `WRONG_KEY` (no key of the account opens it, or
 *   it is not a database), `IN_USE` (a migration that another process blocks), `NO_KEYRING`, and the key layer's own
 *   (`LOCKED`, `UNAVAILABLE`, …)
 */
export function openDatabase(file, { purpose = "sqlcipher", readonly = false, log, hooks, accountDir } = {}) {
    if (inMemory(file)) return new Database(file || ":memory:");
    const path = resolve(file);
    const scope = scopeOfDir(accountDir ?? dirname(path));
    if (!readonly) {
        mkdirSync(dirname(path), { recursive: true });
        if (hasLeftovers(path)) withMigrationLock(path, () => recoverMigration(path, { log }));
    }
    let state = dbFileState(path);
    if (state === "plaintext") {
        if (readonly) {
            throw new KeystoreError(
                `${path} is still plaintext (written by an older version): open it once with a 3.0 command that writes ` +
                    "(or run `zalo-agent account security migrate`) to encrypt it; a read-only open never does",
                "PLAINTEXT",
            );
        }
        migratePlaintextDatabase(path, { purpose, log, hooks });
        state = dbFileState(path);
    }
    const keys = candidateKeys(scope, purpose, { create: !readonly && !accountDir && state !== "encrypted" });
    for (const { key, keyId } of keys) {
        const db = tryKey(path, key, { readonly });
        if (!db) continue;
        // Temporary tables, sorts and statement journals stay in memory: a temp file would hold decrypted pages, and
        // every insert into messages (it has triggers: the row MAC, the search index) writes a statement journal,
        // which as a file cost about 45 µs per row on Windows.
        db.pragma("temp_store = MEMORY");
        if (!readonly) {
            db.pragma("journal_mode = WAL");
            db.pragma("secure_delete = ON");
        }
        Object.defineProperty(db, "keyId", { value: keyId });
        return guard(db, path);
    }
    throw new KeystoreError(
        `${path} does not open with any key of account ${scope.id}: it was encrypted under another keyring, or it is ` +
            "not a database",
        "WRONG_KEY",
    );
}

/**
 * The state of an account's database for `account security status`, never key material: `absent`, `plaintext`,
 * `encrypted` (with the key id that opens it and whether that is the current one), `locked` (the key cannot be had
 * here: dkey layer without a login, provider unavailable) or `unreadable` (no key of the account opens it).
 *
 * @param {string} file
 * @param {{purpose?: string}} [opts]
 * @returns {{state: string, keyId?: string, currentKey?: boolean, error?: string}}
 */
export function databaseState(file, { purpose = "sqlcipher" } = {}) {
    const path = resolve(file);
    const state = dbFileState(path);
    if (state === "absent" || state === "empty") return { state: "absent" };
    if (state === "plaintext") return { state: "plaintext" };
    let keys;
    try {
        keys = candidateKeys(scopeOfDir(dirname(path)), purpose, { create: false });
    } catch (e) {
        return { state: "locked", error: e.message };
    }
    for (const [i, { key, keyId }] of keys.entries()) {
        let db;
        try {
            db = tryKey(path, key, { readonly: true });
        } catch (e) {
            return { state: "unreadable", error: e.message };
        }
        if (!db) continue;
        db.close();
        return { state: "encrypted", keyId, currentKey: i === 0 };
    }
    return { state: "unreadable", error: "no key of the account opens it" };
}

/**
 * Re-encrypt a database under the account's current data key (a rekey's handler). Idempotent: a database already
 * under the current key is left alone, one under a retired key is rekeyed in place (it works in WAL), a plaintext or
 * absent one is not touched (a migration encrypts it under the current key).
 *
 * @param {string} file
 * @param {{purpose?: string}} [opts]
 * @returns {"absent"|"plaintext"|"current"|"rekeyed"}
 */
export function rekeyDatabase(file, { purpose = "sqlcipher" } = {}) {
    const path = resolve(file);
    const state = dbFileState(path);
    if (state === "absent" || state === "empty") return "absent";
    if (state === "plaintext") return "plaintext";
    const keys = candidateKeys(scopeOfDir(dirname(path)), purpose, { create: false });
    const [current] = keys;
    for (const { key, keyId } of keys) {
        const db = tryKey(path, key, { readonly: false });
        if (!db) continue;
        try {
            if (keyId === current.keyId) return "current";
            db.pragma(`rekey = "x'${current.key.toString("hex")}'"`);
        } finally {
            db.close();
        }
        const check = tryKey(path, current.key, { readonly: true });
        if (!check) throw new KeystoreError(`${path}: the rekey did not take; the old key still opens it`, "WRONG_KEY");
        check.close();
        return "rekeyed";
    }
    throw new KeystoreError(
        `${path} does not open with any key of account ${scopeOfDir(dirname(path)).id}`,
        "WRONG_KEY",
    );
}

function hasLeftovers(path) {
    return [ENCRYPTING, ENCRYPTED, PLAINTEXT_OLD].some((s) => existsSync(path + s));
}

function withMigrationLock(path, fn) {
    // A migration holds this for as long as it copies (about 15 s per 400 MB): wait for it, never judge it stale early.
    return withFileLock(`${path}.migrate.lock`, fn, { timeoutMs: 10 * 60_000, staleMs: 30 * 60_000 });
}

function removeDbFiles(path) {
    for (const s of ["", "-wal", "-shm", "-journal"]) rmSync(path + s, { force: true });
}

/**
 * Finish or undo what a migration that stopped part way left behind. See the module comment for the states.
 *
 * @param {string} path
 * @param {{log?: (line: string) => void}} [opts]
 */
export function recoverMigration(path, { log = (l) => console.error(l) } = {}) {
    removeDbFiles(path + ENCRYPTING);
    if (existsSync(path + ENCRYPTED)) {
        const state = dbFileState(path);
        if (state === "absent") {
            // Stopped between moving the plaintext aside and swapping the verified copy in.
            rmSync(`${path}-wal`, { force: true });
            rmSync(`${path}-shm`, { force: true });
            renameSync(path + ENCRYPTED, path);
            log(`[db] finished the encryption of ${path} that was interrupted`);
        } else {
            // The plaintext is still in place (and may have been written since): encrypt it again from the start.
            removeDbFiles(path + ENCRYPTED);
        }
    }
    if (existsSync(path + PLAINTEXT_OLD)) {
        const state = dbFileState(path);
        if (state === "encrypted") {
            shredFile(path + PLAINTEXT_OLD);
            rmSync(`${path}${PLAINTEXT_OLD}-wal`, { force: true });
            rmSync(`${path}${PLAINTEXT_OLD}-shm`, { force: true });
        } else if (state === "absent") {
            // Nothing was swapped in: put the plaintext back, to be migrated again.
            renameSync(path + PLAINTEXT_OLD, path);
        }
    }
}

/**
 * Overwrite a file with zeros, flush it, then remove it. Best effort against recovery from the disk (an SSD or a
 * copy-on-write filesystem may keep the old blocks); a process that still holds it (POSIX) reads zeros.
 *
 * @param {string} file
 */
export function shredFile(file) {
    let fd;
    try {
        fd = openSync(file, "r+");
    } catch (e) {
        if (e.code === "ENOENT") return;
        throw e;
    }
    try {
        const size = fstatSync(fd).size;
        const zeros = Buffer.alloc(Math.min(size, 1 << 20));
        for (let off = 0; off < size; off += zeros.length) {
            writeSync(fd, zeros, 0, Math.min(zeros.length, size - off), off);
        }
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    rmSync(file, { force: true });
}

/** Row count of every table of a connection, by name. */
function tableCounts(db) {
    const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => r.name);
    return Object.fromEntries(
        names.map((n) => [n, db.prepare(`SELECT count(*) AS n FROM "${n.replace(/"/g, '""')}"`).get().n]),
    );
}

/**
 * Encrypt a plaintext database in place, as the module comment describes. Refuses while another process holds the
 * account's `daemon.lock`, or when the disk cannot take the copy. Runs under a lock file, so two 3.0 processes never
 * migrate the same file at once (the second finds it done).
 *
 * @param {string} file
 * @param {object} [opts]
 * @param {string} [opts.purpose]
 * @param {(line: string) => void} [opts.log]
 * @param {{afterCopy?: Function, afterEncrypt?: Function, afterVerify?: Function, afterMoveAside?: Function,
 *   afterSwap?: Function}} [opts.hooks] - tests: an exception thrown from one stands for a crash at that point
 * @returns {{migrated: boolean, ms?: number, bytes?: number, tables?: Record<string, number>}}
 * @throws {KeystoreError} `IN_USE`, `NO_SPACE`, `WRONG_KEY` (the copy did not verify; the plaintext is untouched)
 */
export function migratePlaintextDatabase(
    file,
    { purpose = "sqlcipher", log = (l) => console.error(l), hooks = {} } = {},
) {
    const path = resolve(file);
    const dir = dirname(path);
    return withMigrationLock(path, () => {
        recoverMigration(path, { log });
        if (dbFileState(path) !== "plaintext") return { migrated: false };

        const holder = checkLock(dir);
        if (holder.locked && holder.pid !== process.pid) {
            throw new KeystoreError(
                `${path} is still plaintext and must be encrypted, but process ${holder.pid} holds this account ` +
                    "(daemon.lock): stop it (an older version cannot read the encrypted database), then run again",
                "IN_USE",
            );
        }
        const bytes = statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
        try {
            const fs = statfsSync(dir);
            const free = Number(fs.bavail) * Number(fs.bsize);
            if (free < bytes * DISK_FACTOR) {
                throw new KeystoreError(
                    `encrypting ${path} needs about ${Math.ceil((bytes * DISK_FACTOR) / 1e6)} MB free on its disk, ` +
                        `and ${Math.floor(free / 1e6)} MB are: free some space and run again (nothing was changed)`,
                    "NO_SPACE",
                );
            }
        } catch (e) {
            if (e instanceof KeystoreError) throw e;
            /* statfs unsupported here: the copy itself will fail cleanly if the disk is full */
        }
        // The key first: a locked or unavailable key stops here, before anything is touched.
        const { key } = deriveDataKey(scopeOfDir(dir), purpose);
        const started = Date.now();
        log(
            `[db] encrypting ${path} (${(bytes / 1e6).toFixed(1)} MB), once: the plaintext is removed after the ` +
                "encrypted copy is verified",
        );

        const tmp = path + ENCRYPTING;
        removeDbFiles(tmp);
        let src = new Database(path, { timeout: BUSY_TIMEOUT_MS });
        let tables;
        try {
            // Everything into the main file, then hold the write lock so nothing changes while it is copied.
            for (let attempt = 0; ; attempt++) {
                const [cp] = src.pragma("wal_checkpoint(TRUNCATE)");
                src.exec("BEGIN IMMEDIATE");
                const walLeft = existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
                if (!cp?.busy && walLeft === 0) break;
                src.exec("ROLLBACK");
                if (attempt >= 2) {
                    throw new KeystoreError(
                        `${path} is in use by another process (its write-ahead log cannot be emptied): stop it, then ` +
                            "run again (nothing was changed)",
                        "IN_USE",
                    );
                }
            }
            tables = tableCounts(src);
            copyFileSync(path, tmp);
            hooks.afterCopy?.(tmp);

            const enc = new Database(tmp, { timeout: BUSY_TIMEOUT_MS });
            try {
                // SQLite3MC encrypts a plaintext database only out of WAL.
                enc.pragma("journal_mode = DELETE");
                enc.pragma("cipher = 'sqlcipher'");
                enc.pragma("legacy = 4");
                enc.pragma(`rekey = "x'${key.toString("hex")}'"`);
                enc.pragma("journal_mode = WAL");
            } finally {
                enc.close();
            }
            hooks.afterEncrypt?.(tmp);

            const check = tryKey(tmp, key, { readonly: false });
            try {
                const problem = !check
                    ? "the key does not open it"
                    : check.pragma("quick_check", { simple: true }) !== "ok"
                      ? "quick_check failed"
                      : JSON.stringify(tableCounts(check)) !== JSON.stringify(tables)
                        ? "the row counts differ"
                        : dbFileState(tmp) !== "encrypted"
                          ? "the copy is still plaintext"
                          : null;
                if (problem) {
                    check?.close();
                    removeDbFiles(tmp);
                    throw new KeystoreError(
                        `encrypting ${path} did not verify (${problem}); the plaintext database was left as it was`,
                        "WRONG_KEY",
                    );
                }
            } finally {
                if (check?.open) check.close();
            }
            hooks.afterVerify?.(tmp);
            renameSync(tmp, path + ENCRYPTED);
        } finally {
            if (src.inTransaction) src.exec("ROLLBACK");
            src.close();
            src = null;
        }

        // The swap. Windows refuses to move a file another process holds open (an older version still running).
        try {
            renameSync(path, path + PLAINTEXT_OLD);
        } catch (e) {
            removeDbFiles(path + ENCRYPTED);
            throw new KeystoreError(
                `${path} could not be swapped for its encrypted copy (${e.code ?? e.message}): another process (an ` +
                    "older version?) holds it open. Stop it, then run again; the plaintext database was left as it was",
                "IN_USE",
            );
        }
        hooks.afterMoveAside?.();
        rmSync(`${path}-wal`, { force: true });
        rmSync(`${path}-shm`, { force: true });
        renameSync(path + ENCRYPTED, path);
        hooks.afterSwap?.();
        shredFile(path + PLAINTEXT_OLD);
        const ms = Date.now() - started;
        log(`[db] ${path} is encrypted (${(ms / 1000).toFixed(1)} s)`);
        return { migrated: true, ms, bytes, tables };
    });
}
