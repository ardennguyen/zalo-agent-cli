/**
 * Host health for the fleet controller's `GET /zalo/admin/host`: CPU and memory of the machine, and the CPU and memory
 * each account's daemon (and the controller itself) uses. CPU percentages come from the difference between two reads,
 * so the first answer after a start has `null` CPU figures and the next one (a console refreshing every few seconds)
 * has them. Linux reads `/proc`; elsewhere only what Node's `os` module knows is given (process figures are null).
 */
import { readFileSync } from "node:fs";
import os from "node:os";

/** Clock ticks per second of `/proc/<pid>/stat` times (USER_HZ; 100 on every Linux this runs on). */
const TICKS = 100;

/**
 * `/proc/stat`'s first line: total and idle jiffies.
 *
 * @param {(path: string) => string} read
 * @returns {{total: number, idle: number}|null}
 */
export function readCpuTotals(read) {
    try {
        const line = read("/proc/stat").split("\n")[0];
        const n = line.trim().split(/\s+/).slice(1).map(Number);
        if (n.length < 4 || n.some((v) => !Number.isFinite(v))) return null;
        const idle = n[3] + (n[4] ?? 0);
        return { total: n.reduce((a, b) => a + b, 0), idle };
    } catch {
        return null;
    }
}

/**
 * One process's CPU time (seconds) and resident memory (bytes) from `/proc/<pid>/stat` and `/proc/<pid>/status`.
 *
 * @param {(path: string) => string} read
 * @param {number} pid
 * @returns {{cpuSeconds: number, rssBytes: number|null}|null}
 */
export function readProcess(read, pid) {
    try {
        const stat = read(`/proc/${pid}/stat`);
        // The command name is in parentheses and may hold spaces: fields count from after the last ')'.
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const utime = Number(rest[11]);
        const stime = Number(rest[12]);
        let rssBytes = null;
        try {
            const m = /VmRSS:\s+(\d+)\s+kB/.exec(read(`/proc/${pid}/status`));
            if (m) rssBytes = Number(m[1]) * 1024;
        } catch {
            /* gone between the two reads */
        }
        if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
        return { cpuSeconds: (utime + stime) / TICKS, rssBytes };
    } catch {
        return null;
    }
}

/**
 * `MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree` from `/proc/meminfo` (bytes), or Node's view elsewhere.
 *
 * @param {(path: string) => string} read
 */
export function readMemory(read) {
    try {
        const text = read("/proc/meminfo");
        const kb = (k) => {
            const m = new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, "m").exec(text);
            return m ? Number(m[1]) * 1024 : null;
        };
        const total = kb("MemTotal");
        const available = kb("MemAvailable");
        const swapTotal = kb("SwapTotal");
        const swapFree = kb("SwapFree");
        if (total !== null && available !== null)
            return {
                totalBytes: total,
                usedBytes: total - available,
                availableBytes: available,
                swapTotalBytes: swapTotal,
                swapUsedBytes: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
            };
    } catch {
        /* not Linux */
    }
    return {
        totalBytes: os.totalmem(),
        usedBytes: os.totalmem() - os.freemem(),
        availableBytes: os.freemem(),
        swapTotalBytes: null,
        swapUsedBytes: null,
    };
}

/**
 * A sampler: each `snapshot()` reads the host and the given processes and compares CPU time with the previous call.
 *
 * @param {object} [o]
 * @param {(path: string) => string} [o.read]
 * @param {() => number} [o.now] - ms
 * @param {() => number} [o.cores]
 */
export function createHostMetrics({
    read = (p) => readFileSync(p, "utf8"),
    now = Date.now,
    cores = () => os.cpus().length,
} = {}) {
    let prevCpu = null;
    const prevProc = new Map(); // pid -> {cpuSeconds, at}

    /**
     * @param {Array<{name: string, pid: number|null}>} processes - each account daemon (name = account id) and others
     */
    function snapshot(processes = []) {
        const at = now();
        const cpu = readCpuTotals(read);
        let usagePercent = null;
        if (cpu && prevCpu && cpu.total > prevCpu.total) {
            const busy = cpu.total - prevCpu.total - (cpu.idle - prevCpu.idle);
            usagePercent = Math.round((busy / (cpu.total - prevCpu.total)) * 1000) / 10;
        }
        if (cpu) prevCpu = cpu;
        const n = cores();
        const seen = new Set();
        const procs = processes.map(({ name, pid }) => {
            if (!pid) return { name, pid: null, cpuPercent: null, rssBytes: null };
            seen.add(pid);
            const p = readProcess(read, pid);
            if (!p) return { name, pid, cpuPercent: null, rssBytes: null };
            const before = prevProc.get(pid);
            prevProc.set(pid, { cpuSeconds: p.cpuSeconds, at });
            // Percent of one core, like top: a busy process on two cores reads 200.
            const cpuPercent =
                before && at > before.at
                    ? Math.round(((p.cpuSeconds - before.cpuSeconds) / ((at - before.at) / 1000)) * 1000) / 10
                    : null;
            return {
                name,
                pid,
                cpuPercent: cpuPercent !== null && cpuPercent < 0 ? null : cpuPercent,
                rssBytes: p.rssBytes,
            };
        });
        for (const pid of prevProc.keys()) if (!seen.has(pid)) prevProc.delete(pid);
        const [load1, load5, load15] = os.loadavg();
        return {
            at: new Date(at).toISOString(),
            hostname: os.hostname(),
            uptimeSeconds: Math.round(os.uptime()),
            cpu: { cores: n, usagePercent, load1, load5, load15 },
            memory: readMemory(read),
            processes: procs,
        };
    }

    return { snapshot };
}
