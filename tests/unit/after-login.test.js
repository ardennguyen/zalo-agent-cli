/**
 * What a `login --session-only` leaves for the account's daemon (src/core/after-login.js): the login writes the
 * person's choices and touches no socket; the daemon, on its handshake, reads the phone's "sync messages" offer and
 * restores only when it was ticked (with the offer's key, so the phone does not ask), fetches the zCloud key, clears
 * each step once done, keeps a failed one for the next start, and never runs a step twice.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAccountDir } from "../../src/core/credentials.js";
import { createStageLock } from "../../src/core/daemon-channel.js";
import { afterLoginPath, attachAfterLogin, readAfterLogin, writeAfterLogin } from "../../src/core/after-login.js";
import { afterQrLogin } from "../../src/commands/login.js";

const SRC = join(import.meta.dirname, "..", "..", "src");
const NOW = Date.UTC(2026, 10, 26, 8, 0, 0);
const KEY = "t".repeat(64);
let n = 0;
/** A fresh account folder (repeated-digit ids: fakes by the no-real-ids convention). */
function account() {
    const ownId = String(1000000000000000700n + BigInt(n++));
    mkdirSync(getAccountDir(ownId), { recursive: true });
    return { ownId, dir: getAccountDir(ownId) };
}

before(() => assertSandboxed(SANDBOX_CONFIG_DIR));

const offerControl = ({ ts = NOW - 2000, pc = 0 } = {}) => ({
    actionId: "41",
    content: {
        act: "transfer_after_login",
        act_type: "transfer_sync2",
        ts,
        data: JSON.stringify({ temp_key: KEY, imei: null, pc }),
    },
});

/**
 * A daemon's tap and socket: every control-queue page asked is answered with `controls` (on the first page) and
 * "no more"; `sent` counts the requests.
 */
function fakeDaemonSocket({ controls = [], answer = true } = {}) {
    const subs = new Map();
    const tap = {
        on(cmd, fn) {
            if (!subs.has(cmd)) subs.set(cmd, new Set());
            subs.get(cmd).add(fn);
            return () => subs.get(cmd)?.delete(fn);
        },
        emit(cmd, frame) {
            for (const fn of [...(subs.get(cmd) ?? [])]) fn(frame);
        },
        auth: () => ({}),
    };
    const sent = [];
    let first = true;
    const listener = {
        sendWs(payload) {
            sent.push(payload);
            if (!answer || payload.cmd !== 603) return;
            const frame = {
                cmd: 603,
                subCmd: payload.subCmd,
                data: { reqId: payload.data.reqId, controls: first ? controls : [] },
                body: { error_code: 0, data: { more: 0 } },
            };
            first = false;
            setImmediate(() => tap.emit(603, frame));
        },
    };
    return { tap, listener, sent };
}

function daemonRig({ controls, answer, restoreFails = 0, keyFails = 0, wanted = true, clock = { t: NOW } } = {}) {
    const acc = account();
    const sock = fakeDaemonSocket({ controls, answer });
    const calls = { restore: [], obtain: 0 };
    let rf = restoreFails;
    let kf = keyFails;
    const handle = attachAfterLogin({
        tap: sock.tap,
        getApi: () => ({ listener: sock.listener }),
        accountDir: acc.dir,
        ownId: acc.ownId,
        lock: createStageLock(),
        restore: async (params, _onEvent, _signal, internal) => {
            calls.restore.push({ params, internal });
            if (rf-- > 0) throw new Error("socket closed");
            return { reason: "complete", messagesSaved: 3 };
        },
        cursorOf: () => null,
        keySteps: {
            stored: async () => false,
            wanted: async () => wanted,
            obtain: async () => {
                calls.obtain++;
                if (kf-- > 0) throw new Error("no answer from the phone");
                return { keyVersion: 2 };
            },
        },
        offerTiming: { authWaitMs: 0, pageTimeoutMs: 100, pullWaitMs: 0 },
        delayMs: 0,
        now: () => clock.t,
    });
    return { ...acc, ...sock, calls, handle, clock };
}

describe("the login with --session-only leaves the steps to the daemon", () => {
    it("writes what the person chose (0600) and runs neither socket step", async () => {
        const { ownId, dir } = account();
        const ran = [];
        const steps = {
            watchLoginOffer: async () => ran.push("offer"),
            fetchCloudKeyAfterLogin: async () => ran.push("cloud-key"),
        };
        await afterQrLogin(
            ownId,
            { sessionOnly: true, syncDays: 7 },
            { newDevice: true, jsonMode: true, loginAt: NOW },
            steps,
        );
        assert.deepEqual(ran, [], "no socket step in the login process");
        const left = JSON.parse(readFileSync(afterLoginPath(dir), "utf8"));
        assert.deepEqual(left, { v: 1, at: NOW, newDevice: true, offer: { restore: true, days: 7 }, cloudKey: true });
        if (process.platform !== "win32") assert.equal(statSync(afterLoginPath(dir)).mode & 0o777, 0o600);
        assert.ok(!readFileSync(afterLoginPath(dir), "utf8").includes(KEY));
    });

    it("--no-sync and --no-cloud-key are kept as the person's choice", async () => {
        const { ownId, dir } = account();
        await afterQrLogin(
            ownId,
            { sessionOnly: true, sync: false, cloudKey: false },
            { newDevice: false, jsonMode: true, loginAt: NOW },
            { watchLoginOffer: async () => {}, fetchCloudKeyAfterLogin: async () => {} },
        );
        const left = readAfterLogin(dir);
        assert.deepEqual(left.offer, { restore: false, days: null });
        assert.equal(left.cloudKey, undefined);
    });

    it("a person's own login does both steps itself and removes what a --session-only login left", async () => {
        const { ownId, dir } = account();
        writeAfterLogin(dir, { at: NOW });
        const ran = [];
        await afterQrLogin(
            ownId,
            {},
            { newDevice: false, jsonMode: true, loginAt: NOW },
            {
                watchLoginOffer: async () => ran.push("offer"),
                fetchCloudKeyAfterLogin: async () => ran.push("cloud-key"),
            },
        );
        assert.deepEqual(ran, ["offer", "cloud-key"]);
        assert.equal(existsSync(afterLoginPath(dir)), false);
    });
});

describe("the daemon finishes what the login left", () => {
    it("ticked: restores once with the offer's key and the login's days, fetches the key, and clears the file", async () => {
        const r = daemonRig({ controls: [offerControl()] });
        writeAfterLogin(r.dir, { at: NOW, days: 30 });
        const out = await r.handle.run();
        assert.deepEqual(out, { offer: "restored", cloudKey: "fetched" });
        assert.equal(r.calls.restore.length, 1);
        assert.deepEqual(r.calls.restore[0].params, { days: 30 });
        assert.equal(r.calls.restore[0].internal.tempKey, KEY, "the phone's key: no second confirmation");
        assert.equal(r.calls.obtain, 1);
        assert.equal(existsSync(afterLoginPath(r.dir)), false);
        // Never twice.
        assert.equal(await r.handle.run(), null);
        assert.equal(r.calls.restore.length, 1);
        assert.equal(r.calls.obtain, 1);
    });

    it("not ticked: no restore; the key is still fetched", async () => {
        const r = daemonRig({ controls: [] });
        writeAfterLogin(r.dir, { at: NOW });
        const out = await r.handle.run();
        assert.deepEqual(out, { offer: "none", cloudKey: "fetched" });
        assert.equal(r.calls.restore.length, 0);
        assert.equal(existsSync(afterLoginPath(r.dir)), false);
    });

    it("ticked but the login said --no-sync: no restore", async () => {
        const r = daemonRig({ controls: [offerControl()] });
        writeAfterLogin(r.dir, { at: NOW, restore: false, cloudKey: false });
        assert.deepEqual(await r.handle.run(), { offer: "declined" });
        assert.equal(r.calls.restore.length, 0);
        assert.equal(r.calls.obtain, 0, "--no-cloud-key: no key step");
    });

    it("a key too old to spare the phone's tap starts nothing (the daemon never prompts the phone itself)", async () => {
        const r = daemonRig({ controls: [offerControl({ ts: NOW - 10 * 60_000 })] });
        writeAfterLogin(r.dir, { at: NOW, cloudKey: false });
        assert.deepEqual(await r.handle.run(), { offer: "late" });
        assert.equal(r.calls.restore.length, 0);
        assert.equal(existsSync(afterLoginPath(r.dir)), false);
    });

    it("a step that fails is kept for the next start, the other is cleared; neither is repeated once done", async () => {
        const r = daemonRig({ controls: [offerControl()], restoreFails: 1, keyFails: 1 });
        writeAfterLogin(r.dir, { at: NOW });
        assert.deepEqual(await r.handle.run(), { offer: "failed", cloudKey: "failed" });
        assert.ok(readAfterLogin(r.dir).offer && readAfterLogin(r.dir).cloudKey, "both kept");
        // The next start, still within the key's life: both done, then cleared.
        assert.deepEqual(await r.handle.run(), { offer: "restored", cloudKey: "fetched" });
        assert.equal(r.calls.restore.length, 2);
        assert.equal(r.calls.obtain, 2);
        assert.equal(existsSync(afterLoginPath(r.dir)), false);
        assert.equal(await r.handle.run(), null);
        assert.equal(r.calls.restore.length, 2);
    });

    it("only the failed step is retried: a done key is not fetched again", async () => {
        const r = daemonRig({ controls: [offerControl()], restoreFails: 1 });
        writeAfterLogin(r.dir, { at: NOW });
        assert.deepEqual(await r.handle.run(), { offer: "failed", cloudKey: "fetched" });
        assert.deepEqual(Object.keys(readAfterLogin(r.dir)).sort(), ["at", "newDevice", "offer", "v"]);
        assert.deepEqual(await r.handle.run(), { offer: "restored" });
        assert.equal(r.calls.obtain, 1);
    });

    it("queues that do not answer leave the offer step for the next start", async () => {
        const r = daemonRig({ answer: false });
        writeAfterLogin(r.dir, { at: NOW, cloudKey: false });
        assert.deepEqual(await r.handle.run(), { offer: "unread" });
        assert.ok(readAfterLogin(r.dir)?.offer);
        assert.equal(r.calls.restore.length, 0);
    });

    it("runs on the daemon's handshake, once even when two handshakes come together", async () => {
        const r = daemonRig({ controls: [offerControl()] });
        writeAfterLogin(r.dir, { at: NOW });
        r.tap.emit(1, { cmd: 1, subCmd: 1, data: {} });
        r.tap.emit(1, { cmd: 1, subCmd: 1, data: {} });
        const deadline = Date.now() + 3000;
        while (existsSync(afterLoginPath(r.dir)) && Date.now() < deadline) await new Promise((x) => setTimeout(x, 5));
        await new Promise((x) => setTimeout(x, 20));
        assert.equal(existsSync(afterLoginPath(r.dir)), false);
        assert.equal(r.calls.restore.length, 1);
        assert.equal(r.calls.obtain, 1);
    });

    it("both daemons attach it: `listen` and `mcp start` (AGENTS.md section 13)", () => {
        for (const f of ["commands/listen.js", "commands/mcp.js"]) {
            assert.match(readFileSync(join(SRC, f), "utf8"), /attachAfterLogin\(\{/, f);
        }
    });
});
