/**
 * src/core/lock.js — daemon.lock, the "one db writer per account" guard.
 *
 * Every state the lock file can be in is exercised here: absent, held by a
 * live process, held by a dead process (stale), corrupt, and owned by
 * someone else. These paths gate `account remove` and `logout --purge`, so
 * a false "not locked" would let a destructive command delete files out
 * from under a running listener.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkLock, acquireLock, releaseLock, processStartTicks, parseLockText } from "../../src/core/lock.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-lock-test-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A PID that is guaranteed not to be running. */
const DEAD_PID = 2147483647;

let n = 0;
let dir;
const lockPath = () => join(dir, "daemon.lock");
/** The lock file's first line: the owner's PID (later lines identify that process further). */
const ownerLine = () => readFileSync(lockPath(), "utf-8").split(/\r?\n/)[0].trim();

beforeEach(() => {
    dir = join(ROOT, `acct-${n++}`);
    mkdirSync(dir, { recursive: true });
});

describe("checkLock", () => {
    it("reports unlocked when no lock file exists", () => {
        assert.deepEqual(checkLock(dir), { locked: false });
    });

    it("reports unlocked for a directory that does not exist at all", () => {
        assert.deepEqual(checkLock(join(ROOT, "no-such-dir")), { locked: false });
    });

    it("reports locked with the PID when the owner is alive", () => {
        writeFileSync(lockPath(), String(process.pid), "utf-8");
        assert.deepEqual(checkLock(dir), { locked: true, pid: process.pid });
    });

    it("reports stale (not locked) when the owner is dead", () => {
        writeFileSync(lockPath(), String(DEAD_PID), "utf-8");
        assert.deepEqual(checkLock(dir), { locked: false, stale: true, pid: DEAD_PID });
    });

    it("treats a non-numeric lock file as stale rather than locked", () => {
        writeFileSync(lockPath(), "not-a-pid", "utf-8");
        assert.deepEqual(checkLock(dir), { locked: false, stale: true });
    });

    it("tolerates surrounding whitespace in the lock file", () => {
        writeFileSync(lockPath(), `  ${process.pid}\n`, "utf-8");
        assert.deepEqual(checkLock(dir), { locked: true, pid: process.pid });
    });

    it("treats an empty lock file as stale", () => {
        writeFileSync(lockPath(), "", "utf-8");
        assert.deepEqual(checkLock(dir), { locked: false, stale: true });
    });
});

describe("acquireLock", () => {
    it("creates the account directory if it is missing", () => {
        const fresh = join(ROOT, "created-on-demand");
        assert.equal(existsSync(fresh), false);
        assert.equal(acquireLock(fresh), true);
        assert.equal(existsSync(join(fresh, "daemon.lock")), true);
    });

    it("writes this process's PID", () => {
        acquireLock(dir);
        assert.equal(ownerLine(), String(process.pid));
    });

    it("refuses when another live process holds the lock", () => {
        // A live PID that is not us: the parent process.
        const other = process.ppid && process.ppid !== process.pid ? process.ppid : process.pid;
        writeFileSync(lockPath(), String(other), "utf-8");
        assert.equal(acquireLock(dir), false);
        assert.equal(ownerLine(), String(other), "the incumbent lock must be preserved");
    });

    it("reclaims a stale lock left by a dead process", () => {
        writeFileSync(lockPath(), String(DEAD_PID), "utf-8");
        assert.equal(acquireLock(dir), true);
        assert.equal(ownerLine(), String(process.pid));
    });

    it("reclaims a corrupt lock file", () => {
        writeFileSync(lockPath(), "garbage", "utf-8");
        assert.equal(acquireLock(dir), true);
        assert.equal(ownerLine(), String(process.pid));
    });

    it("is not re-entrant — a second acquire in the same process fails", () => {
        assert.equal(acquireLock(dir), true);
        assert.equal(acquireLock(dir), false, "our own live PID must read as locked");
    });
});

describe("releaseLock", () => {
    it("removes a lock this process owns", () => {
        acquireLock(dir);
        assert.equal(releaseLock(dir), true);
        assert.equal(existsSync(lockPath()), false);
    });

    it("is a no-op returning true when there is no lock", () => {
        assert.equal(releaseLock(dir), true);
    });

    it("refuses to release a lock owned by another process", () => {
        writeFileSync(lockPath(), String(DEAD_PID), "utf-8");
        assert.equal(releaseLock(dir), false);
        assert.equal(existsSync(lockPath()), true, "another process's lock must not be deleted");
    });

    it("acquire → release → acquire round-trips", () => {
        assert.equal(acquireLock(dir), true);
        assert.equal(releaseLock(dir), true);
        assert.equal(acquireLock(dir), true);
    });
});

/**
 * A fake /proc tree: one process entry, the boot id and the boot time. The comm field has a space and a ")" on
 * purpose -- the start time is field 22 counted after the LAST ")".
 */
function fakeProc({ pid, startTicks, comm = "zalo-agent fleet) x", boot = "boot-a", btimeSec }) {
    const root = join(ROOT, `proc-${n++}`);
    mkdirSync(join(root, String(pid)), { recursive: true });
    mkdirSync(join(root, "sys", "kernel", "random"), { recursive: true });
    const middle = Array(18).fill("0").join(" "); // fields 4..21
    writeFileSync(join(root, String(pid), "stat"), `${pid} (${comm}) S ${middle} ${startTicks} 123 456\n`);
    writeFileSync(join(root, "sys", "kernel", "random", "boot_id"), `${boot}\n`);
    writeFileSync(join(root, "stat"), `cpu  1 2 3\nbtime ${btimeSec}\nprocesses 9\n`);
    return root;
}

/** Every PID in these tests is "alive": the identity check alone has to tell a reused PID from the owner. */
const alive = () => true;
const REUSED = 47;
const nowSec = () => Math.floor(Date.now() / 1000);

describe("daemon.lock survives PID reuse (container restart)", () => {
    it("reads field 22 after the last ')' of /proc/<pid>/stat", () => {
        const procRoot = fakeProc({ pid: REUSED, startTicks: 987654, btimeSec: nowSec() - 3600 });
        assert.equal(processStartTicks(REUSED, procRoot), "987654");
        assert.equal(processStartTicks(REUSED + 1, procRoot), null, "no such process");
    });

    it("treats a lock whose PID now belongs to another zalo-agent process as stale, and takes it over", () => {
        // The old daemon was PID 47 started at tick 1000; after the restart PID 47 is a different process.
        const procRoot = fakeProc({ pid: REUSED, startTicks: 5000, btimeSec: nowSec() - 3600 });
        writeFileSync(lockPath(), `${REUSED}\nstart=1000\nboot=boot-a\n`, "utf-8");
        assert.deepEqual(checkLock(dir, { procRoot, alive }), { locked: false, stale: true, pid: REUSED });
        assert.equal(acquireLock(dir, { procRoot, alive }), true);
        assert.equal(ownerLine(), String(process.pid));
    });

    it("refuses while the recorded process is still the live owner", () => {
        const procRoot = fakeProc({ pid: REUSED, startTicks: 1000, btimeSec: nowSec() - 3600 });
        const text = `${REUSED}\nstart=1000\nboot=boot-a\n`;
        writeFileSync(lockPath(), text, "utf-8");
        assert.deepEqual(checkLock(dir, { procRoot, alive }), { locked: true, pid: REUSED });
        assert.equal(acquireLock(dir, { procRoot, alive }), false);
        assert.equal(readFileSync(lockPath(), "utf-8"), text, "the live owner's lock must be preserved");
    });

    it("treats a lock from another boot as stale even when the start time happens to match", () => {
        const procRoot = fakeProc({ pid: REUSED, startTicks: 1000, boot: "boot-b", btimeSec: nowSec() - 3600 });
        writeFileSync(lockPath(), `${REUSED}\nstart=1000\nboot=boot-a\n`, "utf-8");
        assert.equal(checkLock(dir, { procRoot, alive }).locked, false);
    });

    it("treats an older PID-only lock as stale when its PID's process started after the file was written", () => {
        // Booted 3 h ago; the lock was written 2 h ago; PID 47 started 10 min ago.
        const procRoot = fakeProc({ pid: REUSED, startTicks: (3 * 3600 - 600) * 100, btimeSec: nowSec() - 3 * 3600 });
        writeFileSync(lockPath(), String(REUSED), "utf-8");
        utimesSync(lockPath(), nowSec() - 7200, nowSec() - 7200);
        assert.deepEqual(checkLock(dir, { procRoot, alive }), { locked: false, stale: true, pid: REUSED });
    });

    it("keeps an older PID-only lock held when its PID's process started before the file was written", () => {
        // Booted 3 h ago; PID 47 started 2.5 h ago and wrote the lock 2 h ago.
        const procRoot = fakeProc({ pid: REUSED, startTicks: 1800 * 100, btimeSec: nowSec() - 3 * 3600 });
        writeFileSync(lockPath(), String(REUSED), "utf-8");
        utimesSync(lockPath(), nowSec() - 7200, nowSec() - 7200);
        assert.deepEqual(checkLock(dir, { procRoot, alive }), { locked: true, pid: REUSED });
    });

    it("falls back to the PID alone where /proc has no entry (Windows, macOS)", () => {
        const procRoot = join(ROOT, "no-proc-here");
        writeFileSync(lockPath(), `${REUSED}\nstart=1000\n`, "utf-8");
        assert.deepEqual(checkLock(dir, { procRoot, alive }), { locked: true, pid: REUSED });
        assert.deepEqual(checkLock(dir, { procRoot, alive: () => false }), { locked: false, stale: true, pid: REUSED });
    });

    it("keeps the PID on the first line so older versions still find the owner", () => {
        assert.equal(acquireLock(dir), true);
        const text = readFileSync(lockPath(), "utf-8");
        assert.equal(parseInt(text, 10), process.pid);
        assert.equal(parseLockText(text).pid, process.pid);
    });
});
