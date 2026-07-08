/**
 * src/core/lock.js
 *
 * Cross-process locking mechanism for Zalo Agent CLI.
 * Ensures only one daemon writes to the SQLite database per account.
 */
import fs from "node:fs";
import path from "node:path";

const LOCK_FILE_NAME = "daemon.lock";

/**
 * Checks if a process is running given its PID.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
    try {
        // process.kill(pid, 0) throws an error if the process does not exist.
        // It does not actually kill the process.
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Checks the lock status for a given account directory.
 * @param {string} accountDir
 * @returns {{ locked: boolean, pid?: number, stale?: boolean }}
 */
export function checkLock(accountDir) {
    const lockPath = path.join(accountDir, LOCK_FILE_NAME);
    try {
        if (!fs.existsSync(lockPath)) {
            return { locked: false };
        }

        const pidStr = fs.readFileSync(lockPath, "utf8").trim();
        const pid = parseInt(pidStr, 10);

        if (Number.isNaN(pid)) {
            // Corrupted lock file
            return { locked: false, stale: true };
        }

        if (isProcessAlive(pid)) {
            return { locked: true, pid };
        } else {
            return { locked: false, stale: true, pid };
        }
    } catch (error) {
        // Handle unexpected read errors
        return { locked: false };
    }
}

/**
 * Acquires a lock for the given account directory.
 * @param {string} accountDir
 * @returns {boolean} True if lock was successfully acquired, false otherwise.
 */
export function acquireLock(accountDir) {
    const lockPath = path.join(accountDir, LOCK_FILE_NAME);

    // Ensure the account directory exists
    if (!fs.existsSync(accountDir)) {
        fs.mkdirSync(accountDir, { recursive: true });
    }

    // Check for existing lock and handle stale locks
    const status = checkLock(accountDir);
    if (status.locked) {
        return false;
    }

    if (status.stale) {
        try {
            // Double-check the pid to prevent race conditions during deletion
            const currentPidStr = fs.readFileSync(lockPath, "utf8").trim();
            const currentPid = parseInt(currentPidStr, 10);
            if (currentPid === status.pid || Number.isNaN(currentPid)) {
                fs.unlinkSync(lockPath);
            } else {
                return false; // Replaced by a different, likely alive process
            }
        } catch (e) {
            // Ignore ENOENT if already deleted by another process trying to acquire lock
        }
    }

    try {
        // 'wx' flag ensures it fails if the file already exists (atomic operation)
        fs.writeFileSync(lockPath, process.pid.toString(), { flag: "wx" });
        return true;
    } catch (e) {
        if (e.code === "EEXIST") {
            // Another process created it right after we checked/deleted
            return false;
        }
        throw e; // Other unexpected errors
    }
}

/**
 * Releases the lock for the given account directory.
 * @param {string} accountDir
 * @returns {boolean} True if successfully released, false otherwise.
 */
export function releaseLock(accountDir) {
    const lockPath = path.join(accountDir, LOCK_FILE_NAME);
    try {
        if (!fs.existsSync(lockPath)) return true;

        const pidStr = fs.readFileSync(lockPath, "utf8").trim();
        const pid = parseInt(pidStr, 10);

        // Only remove the lock if it belongs to the current process
        if (pid === process.pid) {
            fs.unlinkSync(lockPath);
            return true;
        }
        return false; // We don't own this lock
    } catch (e) {
        if (e.code === "ENOENT") return true;
        return false;
    }
}
