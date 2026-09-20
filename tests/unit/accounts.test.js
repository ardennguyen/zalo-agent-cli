/**
 * src/core/accounts.js — multi-account registry, per-account data wipe,
 * and the lock-aware removal path shared by `account remove` and
 * `logout --purge`.
 *
 * This is the module that decides whether a destructive command actually
 * deletes someone's credentials, so the lock-refusal paths are covered as
 * carefully as the happy ones.
 */

import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, saveCredentials, loadCredentials } from "../../src/core/credentials.js";
import {
    listAccounts,
    getActive,
    setActive,
    addAccount,
    getAccount,
    getProxyFor,
    wipeAccountDir,
    removeAccount,
} from "../../src/core/accounts.js";

const A = "1000000000000000001";
const B = "2000000000000000002";
const C = "3000000000000000003";
const CREDS = { imei: "imei", cookie: {}, userAgent: "UA", language: "vi" };

const ACCOUNTS_FILE = join(SANDBOX_CONFIG_DIR, "accounts.json");
const accountDir = (id) => join(SANDBOX_CONFIG_DIR, "accounts", id);

function reset() {
    rmSync(SANDBOX_CONFIG_DIR, { recursive: true, force: true });
    mkdirSync(SANDBOX_CONFIG_DIR, { recursive: true });
}

/** Populate a realistic per-account data dir: db, media, sync keys. */
function seedAccountData(id) {
    const dir = accountDir(id);
    mkdirSync(join(dir, "media"), { recursive: true });
    mkdirSync(join(dir, "sync"), { recursive: true });
    writeFileSync(join(dir, "zalo.db"), "sqlite-ish", "utf-8");
    writeFileSync(join(dir, "media", "photo.jpg"), "jpeg-ish", "utf-8");
    writeFileSync(join(dir, "sync", "key.pem"), "rsa-ish", "utf-8");
    return dir;
}

describe("accounts — sandboxing", () => {
    it("operates inside the test sandbox", () => assertSandboxed(CONFIG_DIR));
});

describe("registry CRUD", () => {
    beforeEach(reset);

    it("listAccounts returns [] when the registry file does not exist", () => {
        assert.deepEqual(listAccounts(), []);
    });

    it("listAccounts returns [] (does not throw) on a corrupt registry", () => {
        writeFileSync(ACCOUNTS_FILE, "]]not json[[", "utf-8");
        assert.deepEqual(listAccounts(), []);
    });

    it("getActive returns null on an empty registry", () => {
        assert.equal(getActive(), null);
    });

    it("addAccount registers and activates a first account", () => {
        addAccount(A, "Alpha", null);
        assert.deepEqual(listAccounts(), [{ ownId: A, name: "Alpha", proxy: null, active: true }]);
        assert.equal(getActive().ownId, A);
    });

    it("addAccount deactivates every other account — the newest login wins", () => {
        addAccount(A, "Alpha");
        addAccount(B, "Beta");
        const all = listAccounts();
        assert.equal(all.find((a) => a.ownId === A).active, false);
        assert.equal(all.find((a) => a.ownId === B).active, true);
        assert.equal(getActive().ownId, B);
    });

    it("re-adding an already-registered account reactivates it (the regression accounts.js documents)", () => {
        addAccount(A, "Alpha");
        addAccount(B, "Beta"); // A is now inactive
        addAccount(A, "Alpha"); // log back into A
        assert.equal(getActive().ownId, A, "logging back in must make that account active again");
        assert.equal(listAccounts().filter((a) => a.active).length, 1, "exactly one account may be active");
    });

    it("re-adding does not duplicate the registry entry", () => {
        addAccount(A, "Alpha");
        addAccount(A, "Alpha Renamed");
        assert.equal(listAccounts().length, 1);
        assert.equal(getAccount(A).name, "Alpha Renamed");
    });

    it("re-adding with an empty name preserves the previous label", () => {
        addAccount(A, "Alpha");
        addAccount(A, "");
        assert.equal(getAccount(A).name, "Alpha");
    });

    it("re-adding overwrites proxy — including clearing it back to null", () => {
        addAccount(A, "Alpha", "http://user:pw@host:8080");
        assert.equal(getProxyFor(A), "http://user:pw@host:8080");
        addAccount(A, "Alpha", null);
        assert.equal(getProxyFor(A), null);
    });

    it("getProxyFor returns null for an unknown account", () => {
        assert.equal(getProxyFor("unknown"), null);
    });

    it("getAccount returns null for an unknown account", () => {
        assert.equal(getAccount("unknown"), null);
    });

    it("setActive switches the active flag and returns true", () => {
        addAccount(A, "Alpha");
        addAccount(B, "Beta");
        assert.equal(setActive(A), true);
        assert.equal(getActive().ownId, A);
        assert.equal(listAccounts().filter((a) => a.active).length, 1);
    });

    it("setActive returns false and changes nothing for an unknown account", () => {
        addAccount(A, "Alpha");
        assert.equal(setActive("nope"), false);
        assert.equal(getActive().ownId, A);
    });

    it(
        "writes accounts.json with 0600 permissions",
        { skip: process.platform === "win32" ? "POSIX mode bits are not meaningful on Windows" : false },
        () => {
            addAccount(A, "Alpha");
            assert.equal(statSync(ACCOUNTS_FILE).mode & 0o777, 0o600);
        },
    );
});

describe("wipeAccountDir", () => {
    beforeEach(reset);

    it("returns {wiped:false} when there is no data directory", () => {
        assert.deepEqual(wipeAccountDir(A), { wiped: false });
    });

    it("removes db, media and sync keys together", () => {
        const dir = seedAccountData(A);
        assert.deepEqual(wipeAccountDir(A), { wiped: true });
        assert.equal(existsSync(dir), false);
    });

    it("refuses and reports the PID while a live daemon holds the lock", () => {
        const dir = seedAccountData(A);
        writeFileSync(join(dir, "daemon.lock"), String(process.pid), "utf-8");

        const res = wipeAccountDir(A);
        assert.equal(res.wiped, false);
        assert.equal(res.skippedLocked.pid, process.pid);
        assert.equal(existsSync(join(dir, "zalo.db")), true, "data must survive a refused wipe");
    });

    it("reclaims a stale lock left by a dead process", () => {
        const dir = seedAccountData(A);
        // PID 0x7FFFFFFF is not a live process on any platform this runs on.
        writeFileSync(join(dir, "daemon.lock"), "2147483647", "utf-8");
        assert.deepEqual(wipeAccountDir(A), { wiped: true });
        assert.equal(existsSync(dir), false);
    });

    it("only touches the named account's directory", () => {
        seedAccountData(A);
        const dirB = seedAccountData(B);
        wipeAccountDir(A);
        assert.equal(existsSync(dirB), true);
    });
});

describe("removeAccount", () => {
    beforeEach(reset);

    it("returns {removed:false} for an unregistered account", () => {
        assert.deepEqual(removeAccount(A), { removed: false });
    });

    it("wipes data, deletes credentials, and drops the registry entry", () => {
        addAccount(A, "Alpha");
        saveCredentials(A, CREDS);
        const dir = seedAccountData(A);

        assert.deepEqual(removeAccount(A), { removed: true, wiped: true });
        assert.equal(existsSync(dir), false);
        assert.equal(loadCredentials(A), null);
        assert.deepEqual(listAccounts(), []);
    });

    it("promotes the first remaining account when the removed one was active", () => {
        addAccount(A, "Alpha");
        addAccount(B, "Beta"); // B active
        addAccount(C, "Gamma"); // C active
        removeAccount(C);

        const all = listAccounts();
        assert.equal(all.length, 2);
        assert.equal(all.filter((a) => a.active).length, 1);
        assert.equal(getActive().ownId, A, "first remaining entry is promoted");
    });

    it("leaves the active flag alone when an inactive account is removed", () => {
        addAccount(A, "Alpha");
        addAccount(B, "Beta"); // B active
        removeAccount(A);
        assert.equal(getActive().ownId, B);
    });

    it("aborts entirely — credentials and registry intact — while a daemon holds the lock", () => {
        addAccount(A, "Alpha");
        saveCredentials(A, CREDS);
        const dir = seedAccountData(A);
        writeFileSync(join(dir, "daemon.lock"), String(process.pid), "utf-8");

        const res = removeAccount(A);
        assert.equal(res.removed, false);
        assert.equal(res.skippedLocked.pid, process.pid);
        assert.notEqual(loadCredentials(A), null, "credentials must not be pulled out from under a running daemon");
        assert.equal(listAccounts().length, 1, "registry entry must survive a refused removal");
        assert.equal(existsSync(join(dir, "zalo.db")), true);
    });

    it("succeeds with wiped:false when the account has no local data directory", () => {
        addAccount(A, "Alpha");
        saveCredentials(A, CREDS);
        assert.deepEqual(removeAccount(A), { removed: true, wiped: false });
        assert.equal(loadCredentials(A), null);
    });

    it("leaves other accounts' credentials untouched", () => {
        addAccount(A, "Alpha");
        addAccount(B, "Beta");
        saveCredentials(A, CREDS);
        saveCredentials(B, { ...CREDS, imei: "beta" });
        removeAccount(A);
        assert.equal(loadCredentials(B).imei, "beta");
    });

    it("leaves no imei or cookie residue anywhere under CONFIG_DIR after removal", () => {
        addAccount(A, "Alpha");
        saveCredentials(A, { imei: "SECRET-IMEI-VALUE", cookie: { k: "SECRET-COOKIE" }, userAgent: "UA" });
        seedAccountData(A);
        removeAccount(A);

        const leftovers = [];
        const walk = (dir) => {
            if (!existsSync(dir)) return;
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else {
                    const text = readFileSync(p, "utf-8");
                    if (text.includes("SECRET-IMEI-VALUE") || text.includes("SECRET-COOKIE")) leftovers.push(p);
                }
            }
        };
        walk(SANDBOX_CONFIG_DIR);
        assert.deepEqual(leftovers, [], "purged credentials must leave no plaintext residue");
    });
});
