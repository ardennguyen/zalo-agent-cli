/**
 * Host health (./src/core/host-metrics.js): CPU from two reads of /proc/stat, a process's CPU from two reads of its
 * /proc/<pid>/stat (percent of one core), its resident memory, and memory from /proc/meminfo. A fake /proc stands in.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createHostMetrics, readProcess } from "../../src/core/host-metrics.js";

before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));

function fakeProc() {
    const files = new Map();
    const set = (path, text) => files.set(path, text);
    const read = (path) => {
        if (!files.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return files.get(path);
    };
    // utime, stime are fields 14 and 15 of /proc/<pid>/stat; the name may hold spaces and parentheses.
    const stat = (pid, ticks) =>
        set(
            `/proc/${pid}/stat`,
            `${pid} (node (zalo) x) S 1 1 1 0 -1 4194560 100 0 0 0 ${ticks} 0 0 0 20 0 11 0 100 0 0`,
        );
    return { set, read, stat };
}

describe("host metrics", () => {
    it("reads a process's CPU time and memory past a command name with spaces", () => {
        const p = fakeProc();
        p.stat(42, 250);
        p.set("/proc/42/status", "Name:\tnode\nVmRSS:\t  204800 kB\n");
        assert.deepEqual(readProcess(p.read, 42), { cpuSeconds: 2.5, rssBytes: 204800 * 1024 });
        assert.equal(readProcess(p.read, 43), null);
    });

    it("gives CPU percentages from the second snapshot on, and the memory in use", () => {
        const p = fakeProc();
        let t = 1_000_000;
        p.set("/proc/stat", "cpu  100 0 100 800 0 0 0 0 0 0\n");
        p.set("/proc/meminfo", "MemTotal:  4000000 kB\nMemAvailable:  1000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
        p.stat(42, 100);
        p.set("/proc/42/status", "VmRSS:\t1024 kB\n");
        const m = createHostMetrics({ read: p.read, now: () => t, cores: () => 2 });
        const first = m.snapshot([
            { name: "1000000000000000991", pid: 42 },
            { name: "1000000000000000992", pid: null },
        ]);
        assert.equal(first.cpu.usagePercent, null);
        assert.equal(first.processes[0].cpuPercent, null);
        assert.equal(first.memory.usedBytes, 3000000 * 1024);
        assert.equal(first.processes[1].rssBytes, null);

        // 5 s later: the machine was busy 300 of 1000 jiffies; the process used 1 s of CPU (20% of one core).
        t += 5000;
        p.set("/proc/stat", "cpu  250 0 250 1500 0 0 0 0 0 0\n");
        p.stat(42, 200);
        const second = m.snapshot([{ name: "1000000000000000991", pid: 42 }]);
        assert.equal(second.cpu.usagePercent, 30);
        assert.equal(second.cpu.cores, 2);
        assert.equal(second.processes[0].cpuPercent, 20);
        assert.equal(second.processes[0].rssBytes, 1024 * 1024);
    });
});
