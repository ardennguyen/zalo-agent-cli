/**
 * The socket host (src/core/socket-host.js): what a daemon does around its supervised socket.
 *
 * The supervisor is replaced by a scripted stand-in so each decision can be driven directly: a kick
 * ends the daemon and nothing retries; a refused session or a stuck socket asks for a new login, at
 * the pace of Zalo's own retry table; a login Zalo keeps refusing ends the daemon; a login that
 * fails for lack of a network is asked again; maintenance waits.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    EXIT_CODE,
    MAX_REFUSED_LOGINS,
    REVOKED_LOGIN,
    classifyLoginFailure,
    createSocketHost,
} from "../../src/core/socket-host.js";
import { UNIT_TEMPLATE } from "../../src/core/fleet-templates.js";

/** A supervisor that does what it is told and records what was done to it. */
class FakeSupervisor extends EventEmitter {
    constructor(api) {
        super();
        this.api = api;
        this.calls = [];
    }
    start() {
        this.calls.push("start");
    }
    async stop() {
        this.calls.push("stop");
    }
    dispose() {
        this.calls.push("dispose");
    }
}

const loginError = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });

describe("socket host", () => {
    let dir;
    let made; // every FakeSupervisor, in order
    let logs;
    let sleeps;
    let ended; // "kicked" | "revoked" | null
    let health;
    let stopping;

    beforeEach(() => {
        assertSandboxed(CONFIG_DIR);
        dir = mkdtempSync(join(tmpdir(), "zalo-host-"));
        made = [];
        logs = [];
        sleeps = [];
        ended = null;
        stopping = false;
        health = {
            states: [],
            noteSocketState(s) {
                this.states.push(s);
            },
        };
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** A host whose logins are scripted: each entry is an api object to return, or an Error to throw. */
    function host(script = [], extra = {}) {
        const queue = [...script];
        const h = createSocketHost({
            log: (level, message) => logs.push(`${level}: ${message}`),
            relogin: async () => {
                const next = queue.shift();
                if (next instanceof Error) throw next;
                return next ?? { id: "api-ok" };
            },
            onKicked: () => {
                ended = "kicked";
            },
            onRevoked: () => {
                ended = "revoked";
            },
            isStopping: () => stopping,
            health,
            supervise: (api) => {
                const s = new FakeSupervisor(api);
                made.push(s);
                return s;
            },
            sleep: async (ms) => void sleeps.push(ms),
            checkGate: async () => ({ state: "ok", code: null }),
            ...extra,
        });
        h.script = queue;
        return h;
    }
    const logged = (re) => logs.some((l) => re.test(l));

    describe("classifyLoginFailure", () => {
        it("reads a server code first, then the words, and calls everything else other", () => {
            assert.equal(classifyLoginFailure(loginError("x", 600)), "kicked");
            assert.equal(classifyLoginFailure(loginError("x", 70)), "maintenance");
            for (const code of [102, 210, 212]) assert.equal(classifyLoginFailure(loginError("x", code)), "refused");
            assert.equal(classifyLoginFailure(loginError("Đăng nhập thất bại")), "refused");
            assert.equal(classifyLoginFailure(loginError("Login failed: zpw_sek missing")), "refused");
            assert.equal(classifyLoginFailure(loginError("fetch failed")), "other");
            assert.equal(classifyLoginFailure(loginError("x", 5)), "other");
            assert.equal(classifyLoginFailure(null), "other");
        });

        it("keeps the words in step with autoLogin's own list", () => {
            assert.ok(REVOKED_LOGIN.test("Đăng nhập thất bại"));
            assert.ok(!REVOKED_LOGIN.test("getaddrinfo ENOTFOUND wpa.chat.zalo.me"));
        });
    });

    describe("starting and replacing", () => {
        it("starts a supervisor on the api it is given", () => {
            const h = host();
            const api = { id: 1 };
            const sup = h.start(api);
            assert.equal(sup.api, api);
            assert.deepEqual(sup.calls, ["start"]);
            assert.equal(h.current(), sup);
        });

        it("closes the old supervisor, then lets go of it, when a new api takes over", async () => {
            const h = host();
            const first = h.start({ id: 1 });
            h.start({ id: 2 });
            await new Promise((r) => setImmediate(r));
            assert.deepEqual(first.calls, ["start", "stop", "dispose"]);
            assert.equal(made.length, 2);
        });

        it("tells health about every supervisor state", () => {
            const h = host();
            const sup = h.start({});
            for (const state of ["connecting", "connected", "maintenance", "kicked"]) sup.emit("state", { state });
            assert.deepEqual(health.states, ["connecting", "connected", "maintenance", "kicked"]);
        });

        it("logs each retry the supervisor is about to wait for, in words", () => {
            const h = host();
            const sup = h.start({});
            sup.emit("retrying", { key: 4001, delayMs: 2300, round: 1, rotate: false, attempt: 1 });
            sup.emit("retrying", { key: "internal", delayMs: 61000, round: 2, rotate: true, attempt: 9 });
            assert.ok(logged(/warn: Reconnecting in 2\.3s \(reason 4001, attempt 1\)/));
            assert.ok(logged(/warn: Reconnecting in 61s \(reason internal, attempt 9, round 2, next endpoint\)/));
        });
    });

    describe("a kick", () => {
        it("ends the daemon once, and the host does nothing else", async () => {
            const h = host();
            const sup = h.start({});
            sup.emit("kicked", { via: "frame-3000" });
            assert.equal(ended, "kicked");
            assert.ok(logged(/error: Another Zalo session took this account \(frame-3000\)\. Not reconnecting/));
            await new Promise((r) => setImmediate(r));
            assert.equal(made.length, 1, "a kicked daemon started another supervisor");
            assert.deepEqual(sleeps, [], "a kicked daemon asked for a new login");
        });

        it("is ignored during a deliberate shutdown", () => {
            const h = host();
            const sup = h.start({});
            stopping = true;
            sup.emit("kicked", { via: "frame-3000" });
            assert.equal(ended, null);
        });

        it("passes along the reason Zalo gives", () => {
            const h = host();
            h.start({}).emit("kickout-info", { info: { reason: "another-device" } });
            assert.ok(logged(/info: Zalo says why: \{"reason":"another-device"\}/));
        });

        it("a login that Zalo answers with a kick ends the daemon too, without asking again", async () => {
            const h = host([loginError("kicked", 600)]);
            await h.reloginNow("test");
            assert.equal(ended, "kicked");
            assert.equal(sleeps.length, 1, "it waited once, then stopped asking");
        });
    });

    describe("logging in again", () => {
        it("a refused session logs in again, after the first delay of Zalo's table, and starts a new supervisor", async () => {
            const h = host();
            const old = h.start({ id: "old" });
            old.emit("session-invalid", { kind: "session-invalid", code: 102 });
            await until(() => made.length === 2);
            assert.equal(made[1].api.id, "api-ok");
            assert.equal(sleeps.length, 1);
            assert.ok(sleeps[0] >= 2000 && sleeps[0] <= 2400, `first delay ${sleeps[0]}`);
            assert.ok(logged(/Zalo refused this session \(session-invalid, code 102\)/));
            assert.ok(logged(/Logged in again\. Restarting the socket\./));
        });

        it("a socket that is stuck does the same", async () => {
            const h = host();
            h.start({}).emit("stuck", { attempts: 8 });
            await until(() => made.length === 2);
            assert.ok(logged(/No usable socket after 8 tries/));
        });

        it("asks again, slower each time, while the login fails for lack of a network, and never gives up on that", async () => {
            const h = host([
                loginError("fetch failed"),
                loginError("fetch failed"),
                loginError("fetch failed"),
                loginError("fetch failed"),
            ]);
            await h.reloginNow("test");
            assert.equal(ended, null, "a dead network ended the daemon");
            assert.equal(made.length, 1);
            assert.equal(sleeps.length, 5, "four failures and then the success");
            assert.ok(sleeps[1] > sleeps[0] - 1 && sleeps[2] >= sleeps[1] - 500, "the delays should climb the table");
            assert.ok(sleeps[1] >= 3000 && sleeps[2] >= 5000 && sleeps[3] >= 8000);
        });

        it(`ends the daemon when Zalo refuses the login ${MAX_REFUSED_LOGINS} times in a row`, async () => {
            const h = host([
                loginError("Đăng nhập thất bại"),
                loginError("Đăng nhập thất bại"),
                loginError("Đăng nhập thất bại"),
            ]);
            await h.reloginNow("test");
            assert.equal(ended, "revoked");
            assert.equal(made.length, 0, "a refused login still started a supervisor");
            assert.equal(h.script.length, 0, "it stopped asking after the third refusal");
        });

        it("counts only unbroken refusals: a network failure in between starts the count over", async () => {
            const h = host([
                loginError("Đăng nhập thất bại"),
                loginError("Đăng nhập thất bại"),
                loginError("fetch failed"),
                loginError("Đăng nhập thất bại"),
                loginError("Đăng nhập thất bại"),
            ]);
            await h.reloginNow("test");
            assert.equal(ended, null);
            assert.equal(made.length, 1);
        });

        it("reads Zalo's codes: 102, 210 and 212 are refusals", async () => {
            for (const code of [102, 210, 212]) {
                ended = null;
                const h = host([loginError("x", code), loginError("x", code), loginError("x", code)]);
                await h.reloginNow("test");
                assert.equal(ended, "revoked", `code ${code}`);
            }
        });

        it("waits for the maintenance gate instead of retrying while Zalo is in maintenance", async () => {
            const answers = [
                { state: "maintenance", code: 70 },
                { state: "maintenance", code: 70 },
                { state: "ok", code: 0 },
            ];
            const h = host([loginError("down for maintenance", 70)], { checkGate: async () => answers.shift() });
            await h.reloginNow("test");
            assert.deepEqual(health.states, ["maintenance"]);
            assert.equal(answers.length, 0, "the gate was not polled until it answered ok");
            assert.equal(made.length, 1);
            assert.ok(sleeps.includes(60_000), "the gate is asked every minute");
        });

        it("runs one login at a time", async () => {
            let running = 0;
            let peak = 0;
            const h = createSocketHost({
                log: () => {},
                relogin: async () => {
                    peak = Math.max(peak, ++running);
                    await new Promise((r) => setTimeout(r, 20));
                    running--;
                    return {};
                },
                onKicked: () => {},
                onRevoked: () => {},
                isStopping: () => false,
                supervise: (api) => new FakeSupervisor(api),
                sleep: async () => {},
            });
            await Promise.all([h.reloginNow("a"), h.reloginNow("b"), h.reloginNow("c")]);
            assert.equal(peak, 1);
        });

        it("does nothing once the daemon is stopping", async () => {
            let called = 0;
            stopping = true;
            const h = host([], { relogin: async () => void called++ });
            await h.reloginNow("test");
            assert.equal(called, 0);
        });

        it("stop() ends a wait for the next try, and no login follows", async () => {
            let called = 0;
            const never = (ms, signal) =>
                new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
            const h = host([], { relogin: async () => void called++, sleep: never });
            const pending = h.reloginNow("test");
            await new Promise((r) => setImmediate(r));
            await h.stop();
            await pending;
            assert.equal(called, 0);
        });

        it("stop() stops the running supervisor", async () => {
            const h = host();
            const sup = h.start({});
            await h.stop();
            assert.deepEqual(sup.calls, ["start", "stop"]);
        });
    });

    describe("the retry history", () => {
        it("is kept in the file it is given, across hosts", async () => {
            const file = join(dir, "sock-anomaly.json");
            const first = host([loginError("fetch failed")], { anomalyFile: file });
            await first.reloginNow("test");
            const saved = JSON.parse(readFileSync(file, "utf8"));
            assert.ok(
                saved.errors.some((e) => e.code === "internal"),
                "the retry was not recorded",
            );
            const before = saved.firstInstall;
            const second = host([], { anomalyFile: file });
            await second.reloginNow("test");
            assert.equal(JSON.parse(readFileSync(file, "utf8")).firstInstall, before, "the install time was lost");
        });
    });

    it("keeps the systemd unit from restarting a daemon that ended with either code", () => {
        assert.ok(
            UNIT_TEMPLATE.includes(`RestartPreventExitStatus=${EXIT_CODE.KICKED} ${EXIT_CODE.SESSION_REVOKED}`),
            "a kicked or refused daemon would be restarted into the same state",
        );
    });

    it("exports the exit codes a supervisor can rely on", () => {
        assert.equal(EXIT_CODE.KICKED, 3);
        assert.equal(EXIT_CODE.SESSION_REVOKED, 4);
    });
});

/** Poll until `check()` is truthy. */
async function until(check, ms = 2000) {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 2));
    }
}
