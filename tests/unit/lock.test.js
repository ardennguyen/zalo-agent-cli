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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkLock, acquireLock, releaseLock } from "../../src/core/lock.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-lock-test-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A PID that is guaranteed not to be running. */
const DEAD_PID = 2147483647;

let n = 0;
let dir;
const lockPath = () => join(dir, "daemon.lock");

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
        assert.equal(readFileSync(lockPath(), "utf-8").trim(), String(process.pid));
    });

    it("refuses when another live process holds the lock", () => {
        // A live PID that is not us: the parent process.
        const other = process.ppid && process.ppid !== process.pid ? process.ppid : process.pid;
        writeFileSync(lockPath(), String(other), "utf-8");
        assert.equal(acquireLock(dir), false);
        assert.equal(readFileSync(lockPath(), "utf-8").trim(), String(other), "the incumbent lock must be preserved");
    });

    it("reclaims a stale lock left by a dead process", () => {
        writeFileSync(lockPath(), String(DEAD_PID), "utf-8");
        assert.equal(acquireLock(dir), true);
        assert.equal(readFileSync(lockPath(), "utf-8").trim(), String(process.pid));
    });

    it("reclaims a corrupt lock file", () => {
        writeFileSync(lockPath(), "garbage", "utf-8");
        assert.equal(acquireLock(dir), true);
        assert.equal(readFileSync(lockPath(), "utf-8").trim(), String(process.pid));
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
