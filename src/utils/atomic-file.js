/**
 * Two small guarantees for the files that more than one process shares or that must never be half
 * written: an atomic replace, and a cross-process lock for read-modify-write.
 *
 * `accounts.json` is written by every login, `account` command and name refresh, and a fleet of
 * daemons refreshes names concurrently. It used to be read, changed in memory and written back with a
 * plain `writeFileSync`: two writers silently lost each other's change, a reader could see a file
 * the writer had truncated and not yet filled (and took it for "no accounts"), and a crash mid-write
 * left JSON that the next `login` replaced with a one-account registry. Credentials had the same
 * truncate-then-write window, plus a moment at default permissions before `chmod`.
 *
 *  - {@link writeFileAtomic}: write a temp file beside the target, flush it, rename it over the
 *    target. A reader sees the old file or the new one, never a mix; a crash leaves the old one.
 *  - {@link withFileLock}: `O_EXCL` lock file with the holder's pid; a lock whose holder died, or that
 *    is older than any real critical section, is taken over.
 *
 * Both are synchronous because their callers are (the registry API is sync throughout).
 */

import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** Errors a rename can raise on Windows while another process has the target open for reading. */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

/** How long a rename keeps being retried before the error is surfaced (antivirus and indexers can hold a file for seconds). */
const RENAME_RETRY_MS = 5000;

/**
 * Block this thread for `ms` without spinning.
 * @param {number} ms
 */
export function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Replace `file` with `data` so no reader and no crash ever sees a partial write.
 *
 * The temp file is created exclusively with `mode` (so a secret is never readable by others, not
 * even briefly), flushed to disk, then renamed over the target. On Windows a rename can fail while a
 * reader (or an antivirus scan) has the target open, so it is retried with a growing pause for up to
 * five seconds (a reader holds the file for microseconds, but a tight loop of them can keep one in the way).
 *
 * @param {string} file
 * @param {string|Buffer} data
 * @param {{ mode?: number, durable?: boolean }} [options] - `mode`: file mode of the result (default 0o600).
 *   `durable: false` skips the flush to disk for a copy that is only a convenience (the registry's `.bak`)
 */
export function writeFileAtomic(file, data, { mode = 0o600, durable = true } = {}) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(tmp, "wx", mode);
    try {
        writeSync(fd, data);
        if (durable) fsyncSync(fd);
    } catch (e) {
        closeSync(fd);
        try {
            unlinkSync(tmp);
        } catch {
            /* nothing to clean */
        }
        throw e;
    }
    closeSync(fd);

    const giveUpAt = Date.now() + RENAME_RETRY_MS;
    for (let attempt = 0; ; attempt++) {
        try {
            renameSync(tmp, file);
            return;
        } catch (e) {
            if (!TRANSIENT.has(e.code) || Date.now() >= giveUpAt) {
                try {
                    unlinkSync(tmp);
                } catch {
                    /* already gone */
                }
                throw e;
            }
            sleepSync(Math.min(250, 10 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 40));
        }
    }
}

/**
 * Delete the temp files that `writeFileAtomic(file, ...)` left when its process was killed between
 * creating the temp file and renaming it. Only a temp file whose pid is dead is removed.
 *
 * @param {string} file - The target the temp files belong to
 * @returns {number} How many were removed
 */
export function sweepStaleTemps(file) {
    const prefix = `${basename(file)}.`;
    let removed = 0;
    try {
        for (const name of readdirSync(dirname(file))) {
            const m = name.startsWith(prefix) && /^(\d+)\.[0-9a-f]{8}\.tmp$/.exec(name.slice(prefix.length));
            if (!m || alive(Number(m[1]))) continue;
            try {
                unlinkSync(join(dirname(file), name));
                removed++;
            } catch {
                /* gone already */
            }
        }
    } catch {
        /* directory unreadable: nothing to sweep */
    }
    return removed;
}

/** @param {number} pid */
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM: it exists, owned by someone else.
        return e.code === "EPERM";
    }
}

/**
 * Run `fn` while holding an exclusive lock on `lockPath`.
 *
 * A held lock is waited for, up to `timeoutMs`. It is taken over when its holder is dead or when it
 * is older than `staleMs` (a read-modify-write of a small file takes milliseconds, so anything older
 * is a crashed holder, or a pid the OS reused). The lock is released when `fn` returns or throws.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 * @returns {T}
 */
export function withFileLock(lockPath, fn, { timeoutMs = 10_000, staleMs = 30_000 } = {}) {
    mkdirSync(dirname(lockPath), { recursive: true });
    const started = Date.now();
    const mine = JSON.stringify({ pid: process.pid, at: Date.now() });

    for (;;) {
        try {
            const fd = openSync(lockPath, "wx", 0o600);
            try {
                writeSync(fd, mine);
            } finally {
                closeSync(fd);
            }
            break;
        } catch (e) {
            if (e.code !== "EEXIST" && !(process.platform === "win32" && TRANSIENT.has(e.code))) throw e;
        }

        // Held. Is the holder gone?
        let seen = null;
        let holder = null;
        try {
            seen = readFileSync(lockPath, "utf8");
            holder = JSON.parse(seen)?.pid ?? null;
        } catch {
            /* released meanwhile, or torn: judged by age below */
        }
        let age = 0;
        try {
            age = Date.now() - statSync(lockPath).mtimeMs;
        } catch {
            continue; // released between the two looks: try to take it
        }
        if ((holder !== null && !alive(holder)) || age > staleMs) {
            try {
                // Only remove what was judged stale: a lock freed and retaken meanwhile is a live one.
                if (readFileSync(lockPath, "utf8") === seen) unlinkSync(lockPath);
            } catch {
                /* someone else got there first */
            }
            continue;
        }

        if (Date.now() - started > timeoutMs) {
            throw new Error(
                `could not lock ${lockPath} within ${Math.round(timeoutMs / 1000)}s: held by pid ${holder ?? "unknown"}. ` +
                    "If that process is gone, delete the lock file.",
            );
        }
        // Short polls: a critical section is a few milliseconds, so a long wait leaves the lock idle.
        sleepSync(2 + Math.floor(Math.random() * 8));
    }

    try {
        return fn();
    } finally {
        try {
            // Never remove a lock another process took over while this one was stuck.
            if (readFileSync(lockPath, "utf8") === mine) unlinkSync(lockPath);
        } catch {
            /* already gone */
        }
    }
}
