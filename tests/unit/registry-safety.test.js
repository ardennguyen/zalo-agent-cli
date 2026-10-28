/**
 * The shared files that used to be read-modify-written with a plain writeFileSync: the account
 * registry (accounts.json) and credentials. Two writers lost each other's change, a reader could see
 * a half-written file and take it for "no accounts", and a damaged registry was silently replaced by
 * one of a single account.
 *
 * The concurrency tests run real processes (tests/helpers/registry-worker.mjs) against a throwaway
 * config directory; each was red against the old code before the fix.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR, CREDENTIALS_DIR, loadCredentials, saveCredentials } from "../../src/core/credentials.js";
import {
    RegistryError,
    addAccount,
    getAccount,
    listAccounts,
    removeAccount,
    setActive,
    updateAccountName,
} from "../../src/core/accounts.js";
import { sleepSync, sweepStaleTemps, withFileLock, writeFileAtomic } from "../../src/utils/atomic-file.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

const WORKER = join(import.meta.dirname, "..", "helpers", "registry-worker.mjs");
const FILE = join(SANDBOX_CONFIG_DIR, "accounts.json");
const seed = (n = 3) =>
    writeFileSync(
        FILE,
        JSON.stringify(
            Array.from({ length: n }, (_, i) => ({
                ownId: String(1000 + i),
                name: `n${i}`,
                proxy: null,
                active: i === 0,
            })),
        ),
    );

beforeEach(() => {
    rmSync(SANDBOX_CONFIG_DIR, { recursive: true, force: true });
    mkdirSync(SANDBOX_CONFIG_DIR, { recursive: true });
});

/** Run the worker and resolve its JSON line. */
function work(...args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WORKER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => {
            if (code !== 0) return reject(new Error(`worker ${args.join(" ")} exited ${code}: ${err}`));
            resolve(JSON.parse(out.trim().split("\n").pop()));
        });
    });
}

describe("writeFileAtomic", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "zalo-atomic-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("writes the content, replaces an existing file and leaves no temp file behind", () => {
        const f = join(dir, "a.json");
        writeFileAtomic(f, "one");
        writeFileAtomic(f, "two");
        assert.equal(readFileSync(f, "utf8"), "two");
        assert.deepEqual(readdirSync(dir), ["a.json"]);
    });

    it("creates the directory, and writes a large file whole", () => {
        const f = join(dir, "deep", "er", "big.json");
        const data = "x".repeat(3_000_000);
        writeFileAtomic(f, data);
        assert.equal(statSync(f).size, data.length);
    });

    it(
        "creates the file with the mode asked for, so a secret is never readable by others",
        { skip: process.platform === "win32" },
        () => {
            const f = join(dir, "secret.json");
            writeFileAtomic(f, "s");
            assert.equal(statSync(f).mode & 0o777, 0o600);
            writeFileAtomic(f, "s", { mode: 0o640 });
            assert.equal(statSync(f).mode & 0o777, 0o640);
        },
    );

    it("a failed replace leaves the original intact and no temp file", () => {
        const target = join(dir, "target");
        mkdirSync(target); // a directory cannot be replaced by a file
        assert.throws(() => writeFileAtomic(target, "x"));
        assert.ok(statSync(target).isDirectory());
        assert.deepEqual(readdirSync(dir), ["target"]);
    });

    it("a reader never sees a partial file while another process rewrites it", async () => {
        const f = join(dir, "r.json");
        writeFileAtomic(f, JSON.stringify({ n: 0, pad: "p".repeat(200_000) }));
        const writer = spawn(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import { writeFileAtomic } from ${JSON.stringify(new URL("../../src/utils/atomic-file.js", import.meta.url).href)};
                 for (let n = 1; n <= 200; n++) writeFileAtomic(${JSON.stringify(f)}, JSON.stringify({ n, pad: "p".repeat(200000) }));`,
            ],
            { stdio: "ignore" },
        );
        const done = new Promise((r) => writer.on("close", r));
        let reads = 0;
        let torn = 0;
        while (writer.exitCode === null) {
            try {
                JSON.parse(readFileSync(f, "utf8"));
                reads++;
            } catch (e) {
                if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) torn++; // a Windows open-during-rename is not a torn read
            }
            await new Promise((r) => setImmediate(r));
        }
        await done;
        assert.equal(torn, 0, `${torn} of ${reads + torn} reads saw a partial file`);
    });
});

describe("sweepStaleTemps", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "zalo-sweep-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("removes the temp file of a writer that was killed, and only that", () => {
        const target = join(dir, "accounts.json");
        const dead = 2 ** 22 + 777;
        const stale = `${target}.${dead}.deadbeef.tmp`;
        const mine = `${target}.${process.pid}.cafef00d.tmp`;
        const other = join(dir, `other.json.${dead}.deadbeef.tmp`);
        const unrelated = `${target}.bak`;
        for (const f of [stale, mine, other, unrelated, target]) writeFileSync(f, "x");
        assert.equal(sweepStaleTemps(target), 1);
        assert.deepEqual(
            readdirSync(dir).sort(),
            [
                "accounts.json",
                "accounts.json.bak",
                `accounts.json.${process.pid}.cafef00d.tmp`,
                `other.json.${dead}.deadbeef.tmp`,
            ].sort(),
        );
    });

    it("a change to the registry sweeps the temp files a killed writer left", () => {
        seed(2);
        const stale = `${FILE}.${2 ** 22 + 778}.deadbeef.tmp`;
        writeFileSync(stale, "half a registry");
        const staleBak = `${FILE}.bak.${2 ** 22 + 779}.deadbeef.tmp`;
        writeFileSync(staleBak, "half a backup");
        setActive("1001");
        assert.equal(existsSync(stale), false);
        assert.equal(existsSync(staleBak), false, "the backup's temp file too");
    });

    it("an unreadable directory is nothing to sweep, not an error", () => {
        assert.equal(sweepStaleTemps(join(dir, "no", "such", "accounts.json")), 0);
    });
});

describe("withFileLock", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "zalo-lock-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const lock = () => join(dir, "x.lock");

    it("runs fn, returns its value and releases the lock", () => {
        assert.equal(
            withFileLock(lock(), () => 42),
            42,
        );
        assert.equal(existsSync(lock()), false);
    });

    it("releases the lock when fn throws", () => {
        assert.throws(
            () =>
                withFileLock(lock(), () => {
                    throw new Error("boom");
                }),
            /boom/,
        );
        assert.equal(existsSync(lock()), false);
    });

    it("six processes incrementing one counter lose no update", async () => {
        const counter = join(dir, "counter");
        writeFileSync(counter, "0");
        const each = 60;
        await Promise.all(Array.from({ length: 6 }, () => work("counter", dir, counter, String(each))));
        assert.equal(Number(readFileSync(counter, "utf8")), 6 * each);
        assert.equal(existsSync(join(dir, "counter.lock")), false);
    });

    it("takes over a lock whose holder is dead", () => {
        writeFileSync(lock(), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
        assert.equal(
            withFileLock(lock(), () => "ok", { timeoutMs: 500 }),
            "ok",
        );
    });

    it("takes over a lock older than staleMs even when its pid looks alive", () => {
        writeFileSync(lock(), JSON.stringify({ pid: process.pid, at: 0 }));
        const old = new Date(Date.now() - 60_000);
        utimesSync(lock(), old, old); // mtime is what age is judged by
        assert.equal(
            withFileLock(lock(), () => "ok", { staleMs: 1000, timeoutMs: 500 }),
            "ok",
        );
    });

    it("waits for a live holder, then gives up with a message that names it", () => {
        writeFileSync(lock(), JSON.stringify({ pid: process.pid, at: Date.now() }));
        const t0 = Date.now();
        assert.throws(
            () => withFileLock(lock(), () => {}, { timeoutMs: 200, staleMs: 60_000 }),
            (e) => {
                assert.match(e.message, /could not lock/);
                assert.match(e.message, new RegExp(`pid ${process.pid}`));
                return true;
            },
        );
        assert.ok(Date.now() - t0 >= 200);
        assert.equal(existsSync(lock()), true, "a live holder's lock is not removed");
    });

    it("does not remove a lock somebody else took over while fn ran", () => {
        withFileLock(lock(), () => {
            writeFileSync(lock(), JSON.stringify({ pid: 999999, at: 1 }));
        });
        assert.equal(readFileSync(lock(), "utf8").includes("999999"), true);
    });

    it("sleepSync actually waits", () => {
        const t0 = Date.now();
        sleepSync(60);
        assert.ok(Date.now() - t0 >= 55);
    });
});

describe("the registry under concurrent writers", () => {
    it("six processes renaming their own accounts at once lose no rename and corrupt nothing", async () => {
        const per = 20;
        const writers = 6;
        const total = per * writers;
        writeFileSync(
            FILE,
            JSON.stringify(
                Array.from({ length: total }, (_, i) => ({
                    ownId: String(1000 + i),
                    name: `n${i}`,
                    proxy: null,
                    active: i === 0,
                })),
            ),
        );
        const jobs = Array.from({ length: writers }, (_, w) =>
            work("writer", SANDBOX_CONFIG_DIR, String(1000 + w * per), String(per), "2500", "40"),
        );
        const readers = [
            work("reader", SANDBOX_CONFIG_DIR, "2500", String(total)),
            work("reader", SANDBOX_CONFIG_DIR, "2500", String(total)),
        ];
        const results = await Promise.all([...jobs, ...readers]);

        const w = results.slice(0, writers);
        const r = results.slice(writers);
        // Liveness, not fairness: under this much contention a writer can wait a while for the lock, and every
        // writer must have written at least once.
        assert.ok(
            w.every((x) => Object.keys(x.last).length >= 1),
            `every writer renamed at least once (renames: ${w.map((x) => Object.keys(x.last).length)})`,
        );
        // A write that was refused is the contract under load (a cosmetic refresh is skipped, not queued without
        // end; on Windows a rename can lose a race with a reader that has the file open). The test is about what
        // it must never be: a lost rename or a corrupt registry, which the checks below make. So refusals only have
        // to be rare: a lock that does not work would refuse most of them.
        for (const x of w) {
            assert.ok(x.failed <= Math.ceil(x.writes * 0.1), `a writer was refused ${x.failed} of ${x.writes} writes`);
        }
        assert.deepEqual(
            r.map((x) => x.bad),
            [0, 0],
            "no reader saw a short, empty or unreadable registry",
        );

        const final = JSON.parse(readFileSync(FILE, "utf8"));
        assert.equal(final.length, total, "no account was lost");
        const byId = Object.fromEntries(final.map((a) => [a.ownId, a.name]));
        for (const x of w) {
            for (const [id, name] of Object.entries(x.last)) {
                assert.equal(byId[id], name, `account ${id}: the last rename its only writer made was lost`);
            }
        }
        assert.equal(existsSync(`${FILE}.lock`), false, "the lock is released");
        assert.deepEqual(
            readdirSync(SANDBOX_CONFIG_DIR).filter((f) => f.endsWith(".tmp")),
            [],
            "no temp file is left",
        );
    });

    it("accounts added by different processes at once all end up registered", async () => {
        await Promise.all(Array.from({ length: 12 }, (_, i) => work("adder", SANDBOX_CONFIG_DIR, String(5000 + i))));
        const ids = JSON.parse(readFileSync(FILE, "utf8"))
            .map((a) => a.ownId)
            .sort();
        assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => String(5000 + i)).sort());
        assert.equal(
            JSON.parse(readFileSync(FILE, "utf8")).filter((a) => a.active).length,
            1,
            "exactly one account is active",
        );
    });
});

describe("a registry that exists but cannot be read", () => {
    const err = [];
    let realError;
    beforeEach(() => {
        err.length = 0;
        realError = console.error;
        console.error = (...a) => err.push(a.join(" "));
    });
    afterEach(() => {
        console.error = realError;
    });

    for (const [label, content] of [
        ["not JSON", "]]not json[["],
        ["empty (a write that was cut off)", ""],
        ["JSON that is not a list", '{"ownId":"1"}'],
        ["a truncated list", '[{"ownId":"1000","name":"n'],
    ]) {
        it(`${label}: reads fail loudly, writes refuse, and the file is untouched`, () => {
            writeFileSync(FILE, content);
            assert.throws(() => listAccounts(), RegistryError);
            assert.throws(() => getAccount("1000"), /cannot be read as the account list/);
            assert.throws(() => addAccount("2000", "x", null), RegistryError);
            assert.throws(() => setActive("1000"), RegistryError);
            assert.equal(
                readFileSync(FILE, "utf8"),
                content,
                "login must not replace a damaged registry with one of a single account",
            );
            assert.equal(existsSync(`${FILE}.lock`), false);
        });
    }

    it("the error says what to do", () => {
        writeFileSync(FILE, "garbage");
        assert.throws(
            () => listAccounts(),
            (e) => e.name === "RegistryError" && /left untouched/.test(e.message) && /move it aside/.test(e.message),
        );
    });

    it("a missing file is a fresh machine: no accounts, no error", () => {
        assert.deepEqual(listAccounts(), []);
        addAccount("2000", "x", null);
        assert.equal(listAccounts().length, 1);
    });

    it("falls back to the last good copy, says so once, and the next change repairs the file", () => {
        seed(3);
        addAccount("2000", "Two", null); // writes accounts.json.bak holding the 3-account registry
        assert.ok(existsSync(`${FILE}.bak`));
        writeFileSync(FILE, "]]damaged[[");

        assert.equal(listAccounts().length, 3, "read from the .bak");
        assert.equal(listAccounts().length, 3);
        assert.equal(err.filter((l) => /last good copy/.test(l)).length, 1, "warned once, not on every read");

        setActive("1001");
        const repaired = JSON.parse(readFileSync(FILE, "utf8"));
        assert.equal(repaired.length, 3);
        assert.equal(repaired.find((a) => a.active).ownId, "1001");
        const kept = readdirSync(SANDBOX_CONFIG_DIR).filter((f) => f.startsWith("accounts.json.corrupt-"));
        assert.equal(kept.length, 1, "the damaged file is kept for forensics");
        assert.equal(readFileSync(join(SANDBOX_CONFIG_DIR, kept[0]), "utf8"), "]]damaged[[");
    });

    it("updateAccountName on a damaged registry is a logged no-op, never a thrown error (a daemon calls it)", () => {
        writeFileSync(FILE, "garbage");
        assert.equal(updateAccountName("1000", "New"), false);
        assert.ok(err.some((l) => /could not update the cached name of 1000/.test(l)));
        assert.equal(readFileSync(FILE, "utf8"), "garbage");
    });
});

describe("registry writes keep the previous good copy", () => {
    it("every change leaves the registry as it was before it in accounts.json.bak", () => {
        seed(2);
        setActive("1001");
        const before = JSON.parse(readFileSync(`${FILE}.bak`, "utf8"));
        assert.equal(before.find((a) => a.active).ownId, "1000");
        assert.equal(JSON.parse(readFileSync(FILE, "utf8")).find((a) => a.active).ownId, "1001");
    });

    it("a damaged current file is never copied over the good backup", () => {
        seed(2);
        setActive("1001"); // .bak = the seeded registry
        const good = readFileSync(`${FILE}.bak`, "utf8");
        writeFileSync(FILE, "damaged");
        setActive("1000"); // repairs from .bak
        assert.equal(readFileSync(`${FILE}.bak`, "utf8"), good, "the backup still holds the last GOOD registry");
    });

    it("removeAccount drops the entry, activates another, and survives the new write path", () => {
        seed(3);
        assert.deepEqual(removeAccount("1000").removed, true);
        const rest = listAccounts();
        assert.deepEqual(
            rest.map((a) => a.ownId),
            ["1001", "1002"],
        );
        assert.equal(rest.filter((a) => a.active).length, 1);
    });

    it("an unchanged name takes no lock and writes nothing", () => {
        seed(2);
        const before = statSync(FILE).mtimeMs;
        assert.equal(updateAccountName("1000", "n0"), false);
        assert.equal(updateAccountName("9999", "x"), false);
        assert.equal(statSync(FILE).mtimeMs, before);
        assert.equal(existsSync(`${FILE}.bak`), false);
    });
});

describe("the registry lock", () => {
    it("a name a daemon already has is answered without waiting for a busy registry", () => {
        seed(2);
        writeFileSync(`${FILE}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
        const t0 = Date.now();
        assert.equal(updateAccountName("1000", "n0"), false);
        assert.ok(Date.now() - t0 < 500, "no lock wait on the no-change path");
    });

    it("a change made while another process holds the lock gives up after seconds, and says so, instead of hanging", () => {
        seed(2);
        writeFileSync(`${FILE}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
        const lines = [];
        const real = console.error;
        console.error = (...a) => lines.push(a.join(" "));
        try {
            const t0 = Date.now();
            assert.equal(updateAccountName("1000", "Changed"), false);
            const took = Date.now() - t0;
            assert.ok(took >= 2800 && took < 8000, `gave up after the 3 s a daemon waits, not ${took} ms`);
        } finally {
            console.error = real;
        }
        assert.ok(lines.some((l) => /could not update the cached name of 1000: could not lock/.test(l)));
        assert.equal(JSON.parse(readFileSync(FILE, "utf8"))[0].name, "n0", "nothing was written");
    });
});

describe("credentials are written atomically and never readable by others", () => {
    it("saveCredentials leaves exactly the file, mode 0600, and it loads back", () => {
        const creds = { imei: "i", cookie: {}, userAgent: "UA", language: "vi" };
        const p = saveCredentials("1000", creds);
        assert.deepEqual(loadCredentials("1000"), creds);
        assert.deepEqual(
            readdirSync(CREDENTIALS_DIR).filter((f) => f.includes(".tmp")),
            [],
        );
        if (process.platform !== "win32") assert.equal(statSync(p).mode & 0o777, 0o600);
        saveCredentials("1000", { ...creds, imei: "j" });
        assert.equal(loadCredentials("1000").imei, "j");
    });
});
