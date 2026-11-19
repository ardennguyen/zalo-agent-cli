/**
 * src/core/lock.js
 *
 * Cross-process locking mechanism for Zalo Agent CLI.
 * Ensures only one daemon writes to the SQLite database per account.
 *
 * The lock file holds the owner's PID on its first line, then `key=value` lines that identify that process beyond
 * its PID: `start` (the process start time, field 22 of /proc/<pid>/stat) and `boot` (the kernel boot id). A PID
 * alone is not proof of ownership: after a container restart, or a reboot, the same PID can belong to a different
 * process, even another zalo-agent one, and a lock judged only by "is that PID alive" then refuses every start for
 * good. Where /proc exists, a lock counts as held only when the PID is alive AND it is still the same process; a lock
 * written without the extra lines (an older version) counts as stale when its PID's process started after the file
 * was written. Where there is no /proc (Windows, macOS), the PID alone decides, as before.
 *
 * The first line stays a bare PID so older versions reading the file still find the owner.
 */
import fs from "node:fs";
import path from "node:path";

const LOCK_FILE_NAME = "daemon.lock";

/** Clock ticks per second for /proc/<pid>/stat start times; 100 on every mainstream Linux build. */
const CLK_TCK = 100;

/** Slack (ms) when comparing a process start time with a lock file's mtime: tick and filesystem granularity, and a clock
 * step (time sync at boot) between the write and the check. A reused PID belongs to a process started long after. */
const START_SLACK_MS = 60_000;

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
    } catch {
        return false;
    }
}

/**
 * Reads a /proc file, or null where it does not exist (not Linux) or cannot be read.
 * @param {string} file
 * @param {string} [procRoot]
 * @returns {string|null}
 */
function readProc(file, procRoot) {
    try {
        return fs.readFileSync(path.join(procRoot, file), "utf8");
    } catch {
        return null;
    }
}

/**
 * The start time of a process, in clock ticks since boot (field 22 of /proc/<pid>/stat), or null where /proc is
 * not available or the process does not exist.
 * @param {number} pid
 * @param {string} [procRoot] - "/proc"; tests point it at a fake tree.
 * @returns {string|null}
 */
export function processStartTicks(pid, procRoot = "/proc") {
    const stat = readProc(`${pid}/stat`, procRoot);
    if (!stat) return null;
    // Field 2 (comm) is in parentheses and may itself contain spaces or ")", so count fields after the last ")".
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat
        .slice(close + 1)
        .trim()
        .split(/\s+/);
    // After comm, fields[0] is field 3 (state), so field 22 is fields[19].
    const start = fields[19];
    return start && /^[0-9]+$/.test(start) ? start : null;
}

/**
 * The kernel boot id, or null where /proc is not available.
 * @param {string} [procRoot]
 * @returns {string|null}
 */
function bootId(procRoot = "/proc") {
    const id = readProc("sys/kernel/random/boot_id", procRoot);
    return id ? id.trim() || null : null;
}

/**
 * The boot time (ms since epoch) from /proc/stat's `btime`, or null.
 * @param {string} [procRoot]
 * @returns {number|null}
 */
function bootTimeMs(procRoot = "/proc") {
    const stat = readProc("stat", procRoot);
    const m = stat && /^btime\s+([0-9]+)/m.exec(stat);
    return m ? Number(m[1]) * 1000 : null;
}

/**
 * Parses a lock file's text.
 * @param {string} text
 * @returns {{pid: number, start: string|null, boot: string|null}}
 */
export function parseLockText(text) {
    const lines = String(text).trim().split(/\r?\n/);
    const pid = parseInt(lines[0], 10);
    const fields = {};
    for (const line of lines.slice(1)) {
        const eq = line.indexOf("=");
        if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return { pid, start: fields.start || null, boot: fields.boot || null };
}

/**
 * The lock file text for a process: the PID, then its start time and boot id where /proc has them.
 * @param {number} pid
 * @param {{procRoot?: string}} [opts]
 * @returns {string}
 */
export function lockTextFor(pid, { procRoot = "/proc" } = {}) {
    const lines = [String(pid)];
    const start = processStartTicks(pid, procRoot);
    if (start) lines.push(`start=${start}`);
    const boot = bootId(procRoot);
    if (boot) lines.push(`boot=${boot}`);
    return `${lines.join("\n")}\n`;
}

/**
 * Whether the process a lock (or channel descriptor) names is still the one that wrote it.
 *
 * - The PID must be alive.
 * - Where /proc exists: a recorded boot id must match this boot, and a recorded start time must match the live
 *   process's; with no recorded start time (written by an older version), a process that started after the file was
 *   written (`writtenAtMs`) is a different one that reused the PID.
 * - Where /proc does not exist, a live PID is enough.
 *
 * @param {{pid: number, start?: string|null, boot?: string|null}} rec
 * @param {{writtenAtMs?: number|null, procRoot?: string, alive?: (pid: number) => boolean}} [opts]
 * @returns {boolean}
 */
export function isRecordedProcessAlive(rec, { writtenAtMs = null, procRoot = "/proc", alive = isProcessAlive } = {}) {
    const pid = Number(rec?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (!alive(pid)) return false;
    const liveStart = processStartTicks(pid, procRoot);
    if (liveStart === null) return true; // no /proc for this PID: the PID alone decides
    if (rec.boot) {
        const boot = bootId(procRoot);
        if (boot && boot !== rec.boot) return false;
    }
    if (rec.start) return String(rec.start) === liveStart;
    if (writtenAtMs !== null && writtenAtMs !== undefined) {
        const btime = bootTimeMs(procRoot);
        if (btime !== null) {
            const startedAtMs = btime + (Number(liveStart) * 1000) / CLK_TCK;
            if (startedAtMs > writtenAtMs + START_SLACK_MS) return false;
        }
    }
    return true;
}

/**
 * Checks the lock status for a given account directory.
 * @param {string} accountDir
 * @param {{procRoot?: string, alive?: (pid: number) => boolean}} [opts] - test seams
 * @returns {{ locked: boolean, pid?: number, stale?: boolean }}
 */
export function checkLock(accountDir, opts = {}) {
    const lockPath = path.join(accountDir, LOCK_FILE_NAME);
    try {
        if (!fs.existsSync(lockPath)) {
            return { locked: false };
        }

        const rec = parseLockText(fs.readFileSync(lockPath, "utf8"));
        const pid = rec.pid;

        if (Number.isNaN(pid)) {
            // Corrupted lock file
            return { locked: false, stale: true };
        }

        let writtenAtMs = null;
        try {
            writtenAtMs = fs.statSync(lockPath).mtimeMs;
        } catch {
            /* removed meanwhile: judged on the PID */
        }
        if (isRecordedProcessAlive(rec, { ...opts, writtenAtMs })) {
            return { locked: true, pid };
        } else {
            return { locked: false, stale: true, pid };
        }
    } catch {
        // Handle unexpected read errors
        return { locked: false };
    }
}

/**
 * Acquires a lock for the given account directory.
 * @param {string} accountDir
 * @param {{procRoot?: string, alive?: (pid: number) => boolean}} [opts] - test seams
 * @returns {boolean} True if lock was successfully acquired, false otherwise.
 */
export function acquireLock(accountDir, opts = {}) {
    const lockPath = path.join(accountDir, LOCK_FILE_NAME);

    // Ensure the account directory exists
    if (!fs.existsSync(accountDir)) {
        fs.mkdirSync(accountDir, { recursive: true });
    }

    // Check for existing lock and handle stale locks
    const status = checkLock(accountDir, opts);
    if (status.locked) {
        return false;
    }

    if (status.stale) {
        try {
            // Double-check the pid to prevent race conditions during deletion
            const currentPid = parseLockText(fs.readFileSync(lockPath, "utf8")).pid;
            if (currentPid === status.pid || Number.isNaN(currentPid)) {
                fs.unlinkSync(lockPath);
            } else {
                return false; // Replaced by a different, likely alive process
            }
        } catch {
            // Ignore ENOENT if already deleted by another process trying to acquire lock
        }
    }

    try {
        // 'wx' flag ensures it fails if the file already exists (atomic operation)
        fs.writeFileSync(lockPath, lockTextFor(process.pid, opts), { flag: "wx" });
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

        const pid = parseLockText(fs.readFileSync(lockPath, "utf8")).pid;

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
