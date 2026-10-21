/**
 * Start-up spreading inside the daemon (src/core/startup-gate.js): the jitter before login and the cap on
 * daemons logging in at once. A fleet restarting together used to do all of its logins and list loads in the
 * same instant, and only a supervisor could prevent it.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createStartupGate, resolveStartupSettings } from "../../src/core/startup-gate.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zalo-gate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const slotDir = () => join(dir, "login-slots");
const slotFiles = () => (existsSync(slotDir()) ? readdirSync(slotDir()).sort() : []);
const settings = (o = {}) => ({ jitterSec: 0, slots: 0, waitSec: 5, holdSec: 300, warnings: [], ...o });
const WORKER = join(import.meta.dirname, "..", "helpers", "slot-worker.mjs");
const work = (...args) =>
    new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [WORKER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (err += d));
        c.on("close", (code) =>
            code === 0
                ? resolve(JSON.parse(out.trim().split("\n").pop()))
                : reject(new Error(`worker exited ${code}: ${err}`)),
        );
    });

describe("settings", () => {
    it("default to no delay and no cap", () => {
        const s = resolveStartupSettings({ env: {} });
        assert.deepEqual([s.jitterSec, s.slots, s.waitSec, s.warnings], [0, 0, 900, []]);
    });

    it("read ZALO_START_JITTER, ZALO_LOGIN_SLOTS and ZALO_LOGIN_SLOT_WAIT, the per-account name first", () => {
        const env = {
            ZALO_START_JITTER: "30",
            ZALO_LOGIN_SLOTS: "3",
            ZALO_LOGIN_SLOT_WAIT: "60",
            ZALO_LOGIN_SLOTS_1001: "1",
        };
        const mine = resolveStartupSettings({ env, ownId: "1001" });
        assert.deepEqual([mine.jitterSec, mine.slots, mine.waitSec], [30, 1, 60]);
        assert.equal(resolveStartupSettings({ env, ownId: "1002" }).slots, 3);
    });

    it("an unusable value is reported and replaced by the default, not obeyed", () => {
        const s = resolveStartupSettings({
            env: { ZALO_START_JITTER: "soon", ZALO_LOGIN_SLOTS: "-2", ZALO_LOGIN_SLOT_WAIT: "0" },
        });
        assert.deepEqual([s.jitterSec, s.slots, s.waitSec], [0, 0, 900]);
        assert.equal(s.warnings.length, 3);
        assert.match(s.warnings[0], /ZALO_START_JITTER="soon" is not a whole number from 0 to 600/);
        for (const bad of ["601", "1.5", "-1"])
            assert.equal(resolveStartupSettings({ env: { ZALO_START_JITTER: bad } }).jitterSec, 0, bad);
        for (const bad of ["65", "x"])
            assert.equal(resolveStartupSettings({ env: { ZALO_LOGIN_SLOTS: bad } }).slots, 0, bad);
    });
});

describe("the jitter", () => {
    it("waits a random time up to the maximum, and says so", async () => {
        const slept = [];
        const lines = [];
        const gate = createStartupGate({
            configDir: dir,
            ownId: "1",
            settings: settings({ jitterSec: 30 }),
            random: () => 0.5,
            sleep: async (ms) => void slept.push(ms),
            log: (l) => lines.push(l),
        });
        const r = await gate.enter();
        assert.deepEqual(slept, [15_000]);
        assert.equal(r.jitteredMs, 15_000);
        assert.match(lines[0], /start-up jitter: waiting 15\.0s of up to 30s before logging in/);
    });

    it("covers the whole range, and never exceeds it (the maximum itself is allowed)", async () => {
        const waits = [];
        for (const r of [0, 0.25, 0.999999]) {
            const gate = createStartupGate({
                configDir: dir,
                ownId: "1",
                settings: settings({ jitterSec: 10 }),
                random: () => r,
                sleep: async (ms) => void waits.push(ms),
            });
            await gate.enter();
        }
        assert.equal(waits[0], 0);
        assert.equal(waits[1], 2500);
        assert.ok(waits[2] <= 10_000 && waits[2] > 9_990);
    });

    it("with no jitter and no cap it waits for nothing and creates nothing", async () => {
        let slept = false;
        const gate = createStartupGate({
            configDir: dir,
            ownId: "1",
            settings: settings(),
            sleep: async () => (slept = true),
        });
        assert.deepEqual(await gate.enter(), { jitteredMs: 0, waitedMs: 0, slot: null, timedOut: false });
        assert.equal(slept, false);
        assert.equal(existsSync(slotDir()), false);
    });
});

describe("the login slots", () => {
    it("hands out as many slots as the cap, then makes the next one wait until one is given back", async () => {
        const mk = (id) =>
            createStartupGate({
                configDir: dir,
                ownId: id,
                settings: settings({ slots: 2, waitSec: 30 }),
                random: () => 0,
                sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
            });
        const a = mk("a");
        const b = mk("b");
        const c = mk("c");
        assert.equal((await a.enter()).slot, 0);
        assert.equal((await b.enter()).slot, 1);
        assert.deepEqual(slotFiles(), ["slot-0", "slot-1"]);

        let cIn = false;
        const waiting = c.enter().then((r) => ((cIn = true), r));
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(cIn, false, "the third daemon is held back");
        a.leave();
        const got = await waiting;
        assert.equal(got.slot, 0, "and takes the slot the first gave back");
        assert.ok(got.waitedMs >= 100);
        b.leave();
        c.leave();
        assert.deepEqual(slotFiles(), []);
    });

    it("announces that it is waiting, once, and when it got a slot", async () => {
        const lines = [];
        const holder = createStartupGate({ configDir: dir, ownId: "h", settings: settings({ slots: 1 }) });
        await holder.enter();
        const waiter = createStartupGate({
            configDir: dir,
            ownId: "w",
            settings: settings({ slots: 1, waitSec: 30 }),
            log: (l) => lines.push(l),
            random: () => 0,
            sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 15))),
        });
        const p = waiter.enter();
        await new Promise((r) => setTimeout(r, 100));
        holder.leave();
        await p;
        assert.equal(lines.filter((l) => /waiting for a login slot/.test(l)).length, 1);
        assert.ok(lines.some((l) => /got login slot 1 of 1 after/.test(l)));
        waiter.leave();
    });

    it("leave() is safe to call twice or without entering, and removes only its own slot", async () => {
        const a = createStartupGate({ configDir: dir, ownId: "a", settings: settings({ slots: 2 }) });
        const b = createStartupGate({ configDir: dir, ownId: "b", settings: settings({ slots: 2 }) });
        a.leave();
        await a.enter();
        await b.enter();
        a.leave();
        a.leave();
        assert.deepEqual(slotFiles(), ["slot-1"], "b's slot is still b's");
        b.leave();
        assert.deepEqual(slotFiles(), []);
    });

    it("a daemon that was stuck long enough to be taken over does not free the slot of whoever took it", async () => {
        const stuck = createStartupGate({ configDir: dir, ownId: "stuck", settings: settings({ slots: 1 }) });
        await stuck.enter();
        // Judged dead and replaced while it was stuck: the file is another daemon's now.
        const taker = JSON.stringify({ pid: process.pid, ownId: "taker", at: Date.now() });
        writeFileSync(join(slotDir(), "slot-0"), taker);
        stuck.leave();
        assert.equal(readFileSync(join(slotDir(), "slot-0"), "utf8"), taker, "the new holder keeps its slot");
    });

    it("a slot whose daemon died is taken over", async () => {
        const gate = createStartupGate({ configDir: dir, ownId: "a", settings: settings({ slots: 1 }) });
        await gate.enter(); // creates the directory
        gate.leave();
        writeFileSync(
            join(slotDir(), "slot-0"),
            JSON.stringify({ pid: 2 ** 22 + 4242, ownId: "ghost", at: Date.now() }),
        );
        const r = await gate.enter();
        assert.equal(r.slot, 0);
        assert.equal(r.timedOut, false);
        gate.leave();
    });

    it("a slot held far too long is taken over even if its pid looks alive", async () => {
        const gate = createStartupGate({ configDir: dir, ownId: "a", settings: settings({ slots: 1, holdSec: 1 }) });
        await gate.enter();
        gate.leave();
        writeFileSync(join(slotDir(), "slot-0"), JSON.stringify({ pid: process.pid, ownId: "stuck", at: 0 }));
        const old = new Date(Date.now() - 60_000);
        utimesSync(join(slotDir(), "slot-0"), old, old);
        assert.equal((await gate.enter()).slot, 0);
        gate.leave();
    });

    it("gives up waiting after the limit and goes ahead, saying why: a stuck slot must not keep an account offline", async () => {
        const holder = createStartupGate({ configDir: dir, ownId: "h", settings: settings({ slots: 1 }) });
        await holder.enter();
        const lines = [];
        const waiter = createStartupGate({
            configDir: dir,
            ownId: "w",
            settings: settings({ slots: 1, waitSec: 1 }),
            log: (l) => lines.push(l),
            random: () => 0,
            sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
        });
        const t0 = Date.now();
        const r = await waiter.enter();
        assert.equal(r.timedOut, true);
        assert.equal(r.slot, null);
        assert.ok(Date.now() - t0 >= 900 && Date.now() - t0 < 5000);
        assert.ok(lines.some((l) => /no login slot free after 1s .* logging in anyway/.test(l)));
        assert.deepEqual(slotFiles(), ["slot-0"], "the holder's slot was left alone");
        holder.leave();
        waiter.leave();
    });
});

describe("across real processes", () => {
    it("six daemons starting at once, two slots: never more than two inside, and all get through", async () => {
        writeFileSync(join(dir, "concurrency.json"), JSON.stringify({ active: 0, max: 0 }));
        const results = await Promise.all(
            Array.from({ length: 6 }, (_, i) => work("hold", dir, "2", "300", String(1000 + i))),
        );
        const { max } = JSON.parse(readFileSync(join(dir, "concurrency.json"), "utf8"));
        assert.equal(results.length, 6);
        assert.ok(max <= 2, `at most 2 were logging in at once, saw ${max}`);
        assert.equal(max, 2, "and the cap was actually reached, so the test saw contention");
        assert.deepEqual(slotFiles(), [], "every slot was given back");
    });

    it("with no cap the same six all run together (what the cap prevents)", async () => {
        writeFileSync(join(dir, "concurrency.json"), JSON.stringify({ active: 0, max: 0 }));
        await Promise.all(Array.from({ length: 6 }, (_, i) => work("hold", dir, "0", "600", String(1000 + i))));
        const { max } = JSON.parse(readFileSync(join(dir, "concurrency.json"), "utf8"));
        assert.ok(max >= 3, `uncapped they overlap (saw ${max})`);
    });

    it("a daemon that exits while holding a slot does not leave it behind", async () => {
        const r = await work("die", dir, "1", "1001");
        assert.equal(r.slot, 0);
        assert.deepEqual(slotFiles(), [], "the exit hook gave it back");
        // And the next daemon is not kept waiting for it.
        writeFileSync(join(dir, "concurrency.json"), JSON.stringify({ active: 0, max: 0 }));
        const t0 = Date.now();
        assert.equal((await work("hold", dir, "1", "10", "1002")).slot, 0);
        assert.ok(Date.now() - t0 < 10_000);
    });
});
