/**
 * Cross-platform lock file guard for per-account database access.
 *
 * Prevents two concurrent `zalo-agent listen` processes from writing to
 * the same zalo.db, which could corrupt the database or cause Zalo bans.
 *
 * The lock file is stored at: ~/.zalo-agent-cli/accounts/<ownId>/zalo.lock
 */

import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { accountDir } from "./db.js";

/**
 * Attempt to acquire the lock for a given account.
 * @param {string} ownId
 * @returns {{ acquired: boolean, pid?: number }} acquired=true if we got the lock,
 *   or false with the competing process's PID.
 */
export function acquireLock(ownId) {
    const lockPath = _lockPath(ownId);

    // Check for a stale lock from a dead process
    if (existsSync(lockPath)) {
        try {
            const existing = JSON.parse(readFileSync(lockPath, "utf-8"));
            const pid = existing.pid;
            // Check if that process is still alive
            if (_processAlive(pid)) {
                return { acquired: false, pid };
            }
            // Stale lock — remove it
            unlinkSync(lockPath);
        } catch {
            // Unreadable lock — remove it
            try { unlinkSync(lockPath); } catch { /* ignore */ }
        }
    }

    // Write our own lock
    try {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), "utf-8");
        return { acquired: true };
    } catch {
        return { acquired: false };
    }
}

/**
 * Release the lock for a given account.
 * @param {string} ownId
 */
export function releaseLock(ownId) {
    const lockPath = _lockPath(ownId);
    try { unlinkSync(lockPath); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _lockPath(ownId) {
    return join(accountDir(ownId), "zalo.lock");
}

/**
 * Check if a process with the given PID is still running.
 * @param {number} pid
 * @returns {boolean}
 */
function _processAlive(pid) {
    try {
        // Signal 0 = check existence without sending a real signal
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
