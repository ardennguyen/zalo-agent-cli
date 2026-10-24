/**
 * The socket supervisor (src/zalo/socket.js), against the fake Zalo: a real
 * WebSocket server on 127.0.0.1 and the real zca-js listener.
 *
 * Every timing is a few milliseconds so the suite stays fast; what each test
 * checks is the behavior of the official client the supervisor follows:
 * dead-socket detection, the close-code policy, retry and endpoint rotation,
 * the terminal kick, the maintenance hold, and the interval check.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it as nodeIt, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { SocketSupervisor, createNetworkProbe, superviseListener } from "../../src/zalo/socket.js";
import { resolveSocketSettings } from "../../src/zalo/retry.js";
import { ok, startFakeZalo } from "../helpers/fake-zalo/index.js";

/** Every test here has its own deadline: a hang must fail one test, not stall the whole file. */
const it = (name, fn) => nodeIt(name, { timeout: 20_000 }, fn);

/** Settings with every delay a few milliseconds, and no noise (the tests pass random 0). */
const FAST = {
    retries: {
        internal: { times: [15, 25], max: 2 },
        4001: { times: [15], max: 1 },
        5011: { times: [15], max: 3 },
        5012: { times: [15], max: 2 },
        5013: { times: 20, max: 2 },
        5015: { times: [15], max: 2 },
        5016: { times: [15], max: 2 },
        3000: { times: [15], max: 2 },
        interval_check: { times: 10 },
        system_resume: { times: 10 },
        4002: { times: 10 },
    },
    retries_round_2: { default: { multiple: 15, max: 60 } },
    establish_timeout: 1500, // generous: only the tests about these timeouts shorten them
    timeout_authen: 1500,
    close_timeout: 100,
    reset_endpoint: 60_000,
};
// The ping timeout is generous here: only the tests about pings shorten it. A timeout of a few milliseconds
// turns any scheduling hiccup of a loaded machine into a reconnect and fails tests that are about something else.
const TIMING = { pingTimeoutMs: 2000, intervalCheckMs: 30, stableMs: 10_000, resumeGapMs: 500 };
const PING_FAST = { pingTimeoutMs: 60 };

/** Poll until `check()` is truthy or the time is up. */
async function until(check, what, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await check();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}
const quiet = (ms) => new Promise((r) => setTimeout(r, ms));

describe("socket supervisor", () => {
    let zalo;
    let api;
    let sup;
    let events;

    /** A logged-in fake, a supervisor on its listener, and a record of every event it emits. */
    async function rig({
        server = {},
        fake = {},
        settings = {},
        timing = {},
        probe = async () => true,
        extra = {},
    } = {}) {
        zalo = await startFakeZalo({ settings: { features: { socket: server } }, ...fake });
        api = await zalo.login();
        sup = new SocketSupervisor({
            listener: api.listener,
            settings: resolveSocketSettings({ ...FAST, ...settings }),
            timing: { ...TIMING, ...timing },
            probe,
            random: () => 0,
            ...extra,
        });
        events = [];
        for (const name of [
            "state",
            "connected",
            "disconnected",
            "retrying",
            "kicked",
            "kickout-info",
            "session-invalid",
            "maintenance",
            "resume",
        ]) {
            sup.on(name, (e) => events.push({ name, ...(e ?? {}) }));
        }
        return sup;
    }
    const named = (name) => events.filter((e) => e.name === name);
    const states = () => named("state").map((e) => e.state);

    beforeEach(() => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        zalo = api = sup = events = null;
    });

    afterEach(async () => {
        if (sup) {
            sup.dispose();
            if (api?.listener?.ws) {
                api.listener.on("error", () => {});
                api.listener.ws.terminate?.();
            }
        }
        if (zalo) await zalo.stop();
    });

    describe("connecting", () => {
        it("goes connecting, then connected when the key frame arrives, and pings at once", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            assert.deepEqual(states(), ["connecting", "connected"]);
            assert.equal(named("connected").length, 1);
            await until(() => zalo.sock.framesOf(2, 1).length >= 1, "the first ping");
            await until(() => sup.status().lastPongAt, "the echo");
            assert.equal(sup.status().retryAttempts, 0);
        });

        it("keeps the sendWs wrapper invisible: other frames still carry their request id", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            api.listener.requestOldMessages(0, null);
            const frame = await zalo.sock.waitFor((f) => f.cmd === 510);
            assert.match(frame.data.req_id, /^req_\d+$/);
        });

        it("stays connected while the server echoes every ping", async () => {
            await rig({ server: { ping_interval: 30 } });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            await quiet(400);
            assert.equal(zalo.sock.connections.length, 1, "a healthy socket was reconnected");
            assert.ok(zalo.sock.framesOf(2, 1).length >= 5);
            assert.equal(sup.state, "connected");
        });
    });

    describe("dead-socket detection", () => {
        it("asks again after a missed echo, and closes and retries under 5011 only when the asks run out", async () => {
            await rig({ server: { ping_interval: 30 }, timing: PING_FAST });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            await until(() => sup.status().lastPongAt, "the first echo");
            zalo.sock.setPong(false);
            const retry = await until(() => named("retrying")[0], "a retry");
            assert.equal(retry.key, 5011);
            assert.ok(zalo.sock.framesOf(2, 1).length >= 4, "the ping was not asked again before giving up");
            await until(() => zalo.sock.connections.length === 2, "the second connection");
            assert.equal(zalo.sock.connections[0].closeCode, 1000, "the dead socket was not closed normally");
        });

        it("does not take an echo of some other ping for the answer", async () => {
            await rig({ server: { ping_interval: 30 }, timing: PING_FAST });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            await until(() => sup.status().lastPongAt, "the first echo");
            zalo.sock.setPong(false);
            zalo.sock.respond(2, 1, (f) => ok({ eventId: f.data.eventId + 1 })); // an echo, but of another ping
            const retry = await until(() => named("retrying")[0], "a retry");
            assert.equal(retry.key, 5011);
        });

        it("reads the echo's id from the top of the frame as well as from its data", async () => {
            await rig({ server: { ping_interval: 30 }, timing: { pingTimeoutMs: 500 } });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            await until(() => sup.status().lastPongAt, "the first echo");
            zalo.sock.setPong(false);
            zalo.sock.respond(2, 1, (f) => [{ cmd: 2, sub: 1, body: {}, top: { eventId: f.data.eventId } }]);
            await quiet(400);
            assert.equal(zalo.sock.connections.length, 1, "a socket that does echo was reconnected");
            assert.equal(sup.state, "connected");
        });

        it("closes under 5016 when no echo has come for ping_max_timeout, even if no ping is pending", async () => {
            await rig({
                server: { ping_interval: 600_000 }, // zca-js sends no periodic ping inside this test
                settings: { ping_max_timeout: 120 },
                timing: { pingTimeoutMs: 60_000 },
            });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            await until(() => sup.status().lastPongAt, "the first echo");
            zalo.sock.setPong(false);
            const retry = await until(() => named("retrying")[0], "a retry");
            assert.equal(retry.key, 5016);
            await until(() => zalo.sock.connections.length === 2, "the second connection");
        });

        it("closes and retries under 5012 when the socket never opens", async () => {
            const open = new Set();
            const hung = net.createServer((s) => {
                open.add(s); // accepts the connection, never answers the upgrade
                s.on("error", () => {});
            });
            await new Promise((r) => hung.listen(0, "127.0.0.1", r));
            try {
                await rig({ settings: { establish_timeout: 150 } });
                const url = `ws://127.0.0.1:${hung.address().port}/`;
                api.listener.urls = [url];
                api.listener.wsURL = url;
                sup.start();
                const retry = await until(() => named("retrying")[0], "a retry", 4000);
                assert.equal(retry.key, 5012);
                assert.equal(zalo.sock.connections.length, 0, "the hung endpoint was not the fake");
            } finally {
                // Stop the supervisor first: it would otherwise keep dialing the hung server.
                await sup.stop();
                for (const s of open) s.destroy();
                await new Promise((r) => hung.close(r));
            }
        });

        it("closes and retries under 5015 when the key frame never comes", async () => {
            await rig({ fake: { autoAuth: false }, settings: { timeout_authen: 150 } });
            sup.start();
            const retry = await until(() => named("retrying")[0], "a retry", 4000);
            assert.equal(retry.key, 5015);
            await until(() => zalo.sock.connections.length >= 2, "a second connection");
        });
    });

    describe("the close-code policy", () => {
        it("a normal close nobody asked for waits for the interval check, which brings the socket back", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.drop(undefined, 1000);
            // The interval check may already be on its way back, so look for the state in the history, not at this instant.
            await until(() => states().includes("offline"), "offline");
            const retry = await until(() => named("retrying")[0], "the interval check's retry");
            assert.equal(retry.key, "interval_check");
            await until(() => zalo.sock.connections.length === 2, "the second connection");
        });

        it("an abrupt drop (1006) with a working network retries under 4001", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.terminate();
            const retry = await until(() => named("retrying")[0], "a retry");
            assert.equal(retry.key, 4001);
            assert.equal(retry.round, 1);
            await until(() => zalo.sock.connections.length === 2, "the second connection");
        });

        it("an abrupt drop with no network waits, and comes back through the interval check when the network does", async () => {
            let up = false;
            await rig({ probe: async () => up });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.terminate();
            await until(() => sup.state === "offline", "offline");
            await quiet(200);
            assert.equal(named("retrying").length, 0, "retried while the network was down");
            assert.equal(zalo.sock.connections.length, 1);
            up = true;
            const retry = await until(() => named("retrying")[0], "a retry once the network is back");
            assert.equal(retry.key, "interval_check");
            await until(() => zalo.sock.connections.length === 2, "the second connection");
        });

        it("a close in 1001-1015 retries under the name internal", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.drop(undefined, 1001);
            const retry = await until(() => named("retrying")[0], "a retry");
            assert.equal(retry.key, "internal");
        });

        it("Zalo's own close codes retry under their own key; a key the server never described waits the default delay", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.drop(undefined, 3000);
            const known = await until(() => named("retrying")[0], "a retry for 3000");
            assert.equal(known.key, 3000);
            assert.equal(known.delayMs, 15);
            await until(() => zalo.sock.connections.length === 2, "the second connection");
            await until(() => sup.state === "connected", "connected again");
            events.length = 0;
            zalo.sock.drop(undefined, 4500);
            const unknown = await until(() => named("retrying")[0], "a retry for 4500");
            assert.equal(unknown.key, 4500);
            assert.equal(
                unknown.delayMs,
                60_000,
                "an undescribed key must wait the last default delay, not retry at once",
            );
        });

        it("a socket the supervisor closed on purpose is retried under the key that asked, not read as 1000", async () => {
            await rig({ server: { ping_interval: 30 }, timing: PING_FAST });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            await until(() => sup.status().lastPongAt, "the first echo");
            zalo.sock.setPong(false);
            const retry = await until(() => named("retrying")[0], "a retry");
            assert.equal(retry.key, 5011);
            assert.ok(!states().includes("offline"), "a deliberate close was treated as an unrequested one");
        });
    });

    describe("retry and endpoint rotation", () => {
        it("rotates to the next endpoint when a rotating key's retries are spent, and falls into round 2 after", async () => {
            await rig({ extra: { endpoints: 2 } });
            const url = new URL(api.listener.urls[0]);
            api.listener.urls = [new URL("/a", url).toString(), new URL("/b", url).toString()];
            api.listener.wsURL = api.listener.urls[0];
            sup.start();
            const dropAndWait = async (n) => {
                await until(() => sup.state === "connected" && zalo.sock.connections.length === n, `connection ${n}`);
                zalo.sock.terminate();
            };
            await dropAndWait(1);
            await dropAndWait(2); // 4001 has one retry on the first endpoint; the second drop spends it
            await until(() => named("retrying").some((e) => e.rotate), "a rotation");
            await until(() => zalo.sock.connections.length === 3, "the third connection");
            assert.match(zalo.sock.connections[0].url, /^\/a/);
            assert.match(
                zalo.sock.connections[2].url,
                /^\/b/,
                "the third connection did not go to the second endpoint",
            );
            assert.equal(sup.status().endpointIndex, 1);
            await dropAndWait(3);
            await dropAndWait(4);
            await until(() => named("retrying").some((e) => e.round === 2), "round 2");
        });

        it("never rotates with a single endpoint", async () => {
            await rig();
            sup.start();
            for (let n = 1; n <= 3; n++) {
                await until(() => sup.state === "connected" && zalo.sock.connections.length === n, `connection ${n}`);
                zalo.sock.terminate();
            }
            await until(() => named("retrying").length >= 3, "three retries");
            assert.ok(named("retrying").every((e) => e.rotate === false));
            assert.equal(sup.status().endpointIndex, 0);
        });

        it("starts the counters over only after the connection has stayed up", async () => {
            await rig({ timing: { stableMs: 700 } });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.terminate();
            await until(() => zalo.sock.connections.length === 2 && sup.state === "connected", "the second connection");
            assert.deepEqual(
                sup.status().retry.round1,
                { 4001: 1 },
                "the counter should still be there right after reconnecting",
            );
            await until(() => Object.keys(sup.status().retry.round1).length === 0, "the counters to start over", 3000);
        });

        it("emits the retry it is about to wait for, with its key, delay and round", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.terminate();
            const r = await until(() => named("retrying")[0], "a retry");
            assert.deepEqual(
                { key: r.key, delayMs: r.delayMs, round: r.round, rotate: r.rotate, attempt: r.attempt },
                { key: 4001, delayMs: 15, round: 1, rotate: false, attempt: 1 },
            );
        });
    });

    describe("a kick is terminal", () => {
        it("the duplicate-session frame (cmd 3000) ends the supervisor and nothing reconnects", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.kick();
            await until(() => sup.state === "kicked", "kicked");
            assert.deepEqual(named("kicked"), [{ name: "kicked", via: "frame-3000" }]);
            await quiet(400);
            assert.equal(
                zalo.sock.connections.length,
                1,
                "a kicked socket was reconnected: two clients would evict each other forever",
            );
            assert.equal(named("retrying").length, 0);
            assert.equal(sup.status().kickedVia, "frame-3000");
            await until(() => zalo.sock.connections[0].closed, "the socket to close");
        });

        it("a frame carrying error_code 600 ends it the same way", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.push(999, 0, {}, { top: { error_code: 600 } });
            await until(() => sup.state === "kicked", "kicked");
            assert.equal(named("kicked")[0].via, "error-600");
            await quiet(200);
            assert.equal(zalo.sock.connections.length, 1);
        });

        it("ignores an error code that is not a kick", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.push(999, 0, {}, { top: { error_code: 211 } });
            zalo.sock.push(999, 0, {}, { top: { error_code: 0 } });
            await quiet(150);
            assert.equal(sup.state, "connected");
        });

        it("honors the server turning the kick policy off: the frame then reads as an ordinary close", async () => {
            await rig({ settings: { kickout_on_max: false } });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.kick();
            const retry = await until(() => named("retrying")[0], "an ordinary retry");
            assert.equal(retry.key, 3000);
            assert.equal(named("kicked").length, 0);
        });

        it("an HTTP 600 reported by the caller ends it too", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            const c = sup.reportServerError(600);
            assert.equal(c.kind, "kicked");
            assert.equal(sup.state, "kicked");
            assert.equal(named("kicked")[0].via, "http-600");
            await until(() => zalo.sock.connections[0].closed, "the socket to close");
        });

        it("takeover() is the only way back, and only from a kick", async () => {
            await rig();
            assert.equal(sup.takeover(), false, "takeover before any kick");
            sup.start();
            await until(() => sup.state === "connected", "connected");
            assert.equal(sup.takeover(), false, "takeover while connected");
            zalo.sock.kick();
            await until(() => sup.state === "kicked", "kicked");
            await until(() => zalo.sock.connections[0].closed, "the old socket to close");
            assert.equal(sup.takeover(), true);
            await until(() => zalo.sock.connections.length === 2 && sup.state === "connected", "a new connection");
            assert.equal(sup.status().kickedVia, null);
        });

        it("reports the reason for a kick when it can be fetched, and shrugs when it cannot", async () => {
            await rig({ extra: { kickoutInfo: async () => ({ reason: "another browser" }) } });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.kick();
            const info = await until(() => named("kickout-info")[0], "the reason");
            assert.deepEqual(info.info, { reason: "another browser" });
            await zalo.stop();
            zalo = null;

            const failing = [];
            await rig({
                extra: {
                    kickoutInfo: async () => {
                        throw new Error("no token");
                    },
                    log: (level, msg) => failing.push(`${level}: ${msg}`),
                },
            });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.kick();
            await until(() => sup.state === "kicked", "kicked");
            await until(
                () => failing.some((l) => /kickout reason unavailable: no token/.test(l)),
                "the shrug in the log",
            );
            assert.equal(named("kickout-info").length, 0);
        });
    });

    describe("errors reported from outside the socket", () => {
        it("a refused session parks the supervisor for the caller to log in again", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            const c = sup.reportServerError(102);
            assert.equal(c.kind, "session-invalid");
            assert.equal(sup.state, "session-invalid");
            assert.deepEqual(named("session-invalid"), [
                { name: "session-invalid", kind: "session-invalid", code: 102 },
            ]);
            await quiet(200);
            assert.equal(zalo.sock.connections.length, 1);
            assert.equal(named("retrying").length, 0);
        });

        it("a refused account is reported as such", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            sup.reportServerError(210);
            assert.equal(named("session-invalid")[0].kind, "invalid-account");
        });

        it("an unknown code changes nothing and is handed back", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            assert.deepEqual(sup.reportServerError(5), { code: 5, name: "UNKNOWN", kind: "unknown" });
            assert.equal(sup.state, "connected");
        });

        it("maintenance holds the supervisor, with no retry ladder, until the gate says Zalo is back", async () => {
            const answers = ["maintenance", "maintenance", "ok"];
            const asked = [];
            await rig({
                extra: {
                    maintenance: {
                        check: async () => ({ state: answers.shift(), code: null }),
                        sleep: async (ms) => void asked.push(ms),
                    },
                },
            });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            sup.reportServerError(70);
            await until(() => named("maintenance").some((e) => e.state === "over"), "the end of maintenance");
            assert.deepEqual(
                named("maintenance").map((e) => e.state),
                ["in-maintenance", "over"],
            );
            const names = events.map((e) => e.name + (e.name === "maintenance" ? `:${e.state}` : ""));
            const from = names.indexOf("maintenance:in-maintenance");
            const to = names.indexOf("maintenance:over");
            assert.ok(from !== -1 && to > from);
            assert.ok(!names.slice(from, to).includes("retrying"), "the retry ladder ran during maintenance");
            assert.deepEqual(asked, [60_000, 60_000]);
            await until(() => zalo.sock.connections.length === 2 && sup.state === "connected", "a new connection");
        });
    });

    describe("sleep and wake", () => {
        it("a clock that jumped while the socket was down retries at once under system_resume", async () => {
            let skew = 0;
            const clock = {
                now: () => Date.now() + skew,
                setTimeout: (...a) => setTimeout(...a),
                clearTimeout: (...a) => clearTimeout(...a),
                setInterval: (...a) => setInterval(...a),
                clearInterval: (...a) => clearInterval(...a),
            };
            await rig({ probe: async () => false, extra: { clock } });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.drop(undefined, 1000);
            await until(() => sup.state === "offline", "offline");
            skew = 60_000; // the machine slept for a minute
            await until(() => named("resume").length === 1, "the resume");
            const retry = await until(() => named("retrying")[0], "a retry");
            assert.equal(retry.key, "system_resume", "a wake-up must not wait for the network probe");
        });

        it("a clock that jumped while connected asks the socket whether it survived", async () => {
            let skew = 0;
            const clock = {
                now: () => Date.now() + skew,
                setTimeout: (...a) => setTimeout(...a),
                clearTimeout: (...a) => clearTimeout(...a),
                setInterval: (...a) => setInterval(...a),
                clearInterval: (...a) => clearInterval(...a),
            };
            await rig({ extra: { clock }, settings: { ping_max_timeout: 10 * 60_000 } });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            await until(() => zalo.sock.framesOf(2, 1).length >= 1, "the first ping");
            const before = zalo.sock.framesOf(2, 1).length;
            skew = 60_000;
            await until(() => zalo.sock.framesOf(2, 1).length > before, "a ping after the wake-up");
            assert.equal(sup.state, "connected");
        });
    });

    describe("stopping", () => {
        it("stop() closes the socket normally, resolves when it is gone, and nothing comes back", async () => {
            await rig();
            sup.start();
            await until(() => sup.state === "connected", "connected");
            await sup.stop();
            assert.equal(sup.state, "stopped");
            await until(() => zalo.sock.connections[0].closed, "the server to see the close");
            assert.equal(zalo.sock.connections[0].closeCode, 1000);
            await quiet(250);
            assert.equal(zalo.sock.connections.length, 1);
            assert.equal(named("retrying").length, 0);
            const d = named("disconnected")[0];
            assert.equal(d.requested, true);
            await sup.stop(); // a second stop is harmless
        });

        it("stop() before start() is harmless", async () => {
            await rig();
            await sup.stop();
            assert.equal(sup.state, "stopped");
            assert.equal(zalo.sock.connections.length, 0);
        });

        it("stop() during a retry wait cancels it", async () => {
            await rig({ settings: { retries: { 4001: { times: [400], max: 5 } } } });
            sup.start();
            await until(() => sup.state === "connected", "connected");
            zalo.sock.terminate();
            await until(() => named("retrying").length === 1, "a retry to be scheduled");
            await sup.stop();
            await quiet(600);
            assert.equal(zalo.sock.connections.length, 1, "a stopped supervisor reconnected");
        });

        it("dispose() puts the listener back as it found it", async () => {
            await rig();
            const wrapped = api.listener.sendWs;
            sup.dispose();
            assert.notEqual(api.listener.sendWs, wrapped);
            assert.equal(api.listener.listenerCount("cipher_key"), 0);
            assert.equal(api.listener.listenerCount("disconnected"), 0);
            assert.equal(api.listener.listenerCount("connected"), 0);
        });
    });
});

describe("createNetworkProbe", () => {
    it("is true for any answer at all: the question is whether the network is reachable", async () => {
        const calls = [];
        const probe = createNetworkProbe({}, async (url, init) => {
            calls.push({ url, method: init.method });
            return { status: 503 };
        });
        assert.equal(await probe(), true);
        assert.deepEqual(calls, [{ url: "https://www.google.com/generate_204", method: "GET" }]);
    });

    it("is false when the request itself fails", async () => {
        const probe = createNetworkProbe({}, async () => {
            throw new Error("offline");
        });
        assert.equal(await probe(), false);
    });

    it("asks the address in ZALO_NET_PROBE instead", async () => {
        let url;
        await createNetworkProbe(
            { ZALO_NET_PROBE: " https://probe.example.invalid/x " },
            async (u) => void (url = u),
        )();
        assert.equal(url, "https://probe.example.invalid/x");
    });

    it("assumes the network is up, asking nothing, when ZALO_NET_PROBE is off", async () => {
        let asked = 0;
        const probe = createNetworkProbe({ ZALO_NET_PROBE: "OFF" }, async () => void asked++);
        assert.equal(await probe(), true);
        assert.equal(asked, 0);
    });
});

describe("superviseListener", () => {
    it("reads the socket settings from the login and resolves them over the defaults", async () => {
        assertSandboxed(CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        const zalo = await startFakeZalo({
            settings: { features: { socket: { ping_max_timeout: 12345, retries: { 5011: { times: [7], max: 1 } } } } },
        });
        try {
            const api = await zalo.login();
            const sup = superviseListener(api, { probe: async () => true });
            assert.equal(sup.settings.ping_max_timeout, 12345);
            assert.deepEqual(sup.settings.retries[5011], { times: [7], max: 1 });
            assert.ok(sup.settings.retries.internal, "the defaults were lost");
            assert.equal(sup.endpoints, api.listener.urls.length);
            sup.dispose();
        } finally {
            await zalo.stop();
        }
    });
});
