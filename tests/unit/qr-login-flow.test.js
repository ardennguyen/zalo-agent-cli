/**
 * What a QR login does when a code expires (src/core/qr-login-flow.js).
 *
 * Live, 2026-11-06: the page never said the login had ended, and an expired code was replaced on its own without end.
 * Zalo Web shows "QR code expired" and waits for a click; with someone at the terminal we do the same, for a while,
 * and with nobody to ask (an agent, a background login) we replace a few codes and then stop.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { QR_EVENT } from "../../src/zalo/enums.js";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { QrLoginTimedOut, onceEnter, runQrLogin } from "../../src/core/qr-login-flow.js";

const freePort = () =>
    new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });

/**
 * A stand-in for `loginWithQR`: shows a code, and `then(ctl)` drives the rest. `retry` shows a new code, `abort`
 * rejects, as both QR flows do.
 */
const fakeLogin = (then) => (_proxy, onEvent) =>
    new Promise((resolve, reject) => {
        const ctl = { codes: 0, resolve, reject };
        ctl.actions = {
            retry: () => ctl.show(),
            abort: () => reject(new Error("The QR login was aborted")),
        };
        ctl.show = () => {
            ctl.codes++;
            onEvent({ type: QR_EVENT.QR_GENERATED, data: { image: "" }, actions: ctl.actions });
        };
        ctl.expire = () => onEvent({ type: QR_EVENT.QR_EXPIRED, data: null, actions: ctl.actions });
        ctl.scan = (data) => onEvent({ type: QR_EVENT.QR_SCANNED, data, actions: ctl.actions });
        ctl.show();
        then(ctl);
    });

describe("a QR login and its expired codes", () => {
    let realFetch;
    let log;

    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        realFetch = globalThis.fetch;
        globalThis.fetch = (url, ...rest) =>
            String(url).includes("ipify") ? Promise.reject(new Error("offline")) : realFetch(url, ...rest);
        process.env.ZALO_JSON_MODE = "1";
        log = console.log;
        console.log = () => {};
    });

    after(() => {
        console.log = log;
        globalThis.fetch = realFetch;
        delete process.env.ZALO_JSON_MODE;
    });

    it("with nobody to ask, replaces a few codes and then stops with a plain reason", async () => {
        let ctl;
        const err = await runQrLogin({
            jsonMode: true,
            interactive: false,
            qrPort: await freePort(),
            maxCodes: 3,
            login: fakeLogin((c) => {
                ctl = c;
                // every code runs out at once; a code that is not replaced runs out no more
                let seen = 0;
                const tick = () => {
                    if (c.codes === seen) return;
                    seen = c.codes;
                    c.expire();
                    setImmediate(tick);
                };
                setImmediate(tick);
            }),
        }).catch((e) => e);
        assert.ok(err instanceof QrLoginTimedOut, String(err));
        assert.match(err.message, /expired 3 times without a scan/);
        assert.equal(ctl.codes, 3, "no more codes than the cap");
        await err.finish("failed", err.message);
    });

    it("with someone at the terminal, waits for Enter instead of replacing the code on its own", async () => {
        let ctl;
        let enter = null;
        let released = 0;
        const done = runQrLogin({
            interactive: true,
            qrPort: await freePort(),
            waitForEnter: (fn) => {
                enter = fn;
                return () => released++;
            },
            login: fakeLogin((c) => {
                ctl = c;
                setImmediate(() => c.expire());
            }),
        });
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(ctl.codes, 1, "the expired code is not replaced by itself");
        assert.equal(typeof enter, "function");
        enter();
        enter();
        assert.equal(ctl.codes, 2, "Enter replaces it, once");
        assert.equal(released, 1, "and stops listening to the terminal");
        ctl.resolve({ ownId: "1000000000000000001" });
        const ok = await done;
        assert.equal(ok.ownId, "1000000000000000001");
        await ok.finish("done");
    });

    it("ends the login when nobody asks for a new code in time", async () => {
        const err = await runQrLogin({
            interactive: true,
            qrPort: await freePort(),
            askWindowMs: 40,
            waitForEnter: () => () => {},
            login: fakeLogin((c) => setImmediate(() => c.expire())),
        }).catch((e) => e);
        assert.ok(err instanceof QrLoginTimedOut, String(err));
        assert.match(err.message, /no new one was asked for/);
        await err.finish("failed", err.message);
    });

    it("says who scanned the code, with the name and avatar the phone sent", async () => {
        const lines = [];
        console.log = (line) => lines.push(String(line));
        try {
            const ok = await runQrLogin({
                jsonMode: true,
                interactive: false,
                qrPort: await freePort(),
                login: fakeLogin((c) =>
                    setImmediate(() => {
                        c.scan({ display_name: "Fake Scanner", avatar: "https://avatar.invalid/fake.jpg" });
                        c.scan({});
                        c.resolve({ ownId: "1000000000000000001" });
                    }),
                ),
            });
            await ok.finish("done");
        } finally {
            console.log = () => {};
        }
        const events = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
        // Red if the scanned event is dropped, or the name is read from a field the scan does not carry.
        assert.deepEqual(
            events.filter((e) => e.event === "qr_scanned"),
            [
                { event: "qr_scanned", name: "Fake Scanner", avatar: "https://avatar.invalid/fake.jpg" },
                { event: "qr_scanned", name: "unknown", avatar: null },
            ],
        );
    });

    it("hands a failure through with a way to tell the page", async () => {
        const err = await runQrLogin({
            jsonMode: true,
            interactive: false,
            qrPort: await freePort(),
            login: fakeLogin((c) => setImmediate(() => c.reject(new Error("Login declined")))),
        }).catch((e) => e);
        assert.equal(err.message, "Login declined");
        assert.equal(typeof err.finish, "function");
        await err.finish("failed", err.message);
    });
});

describe("onceEnter", () => {
    it("answers one Enter and lets go of the terminal", async () => {
        const { PassThrough } = await import("node:stream");
        const stdin = new PassThrough();
        let calls = 0;
        onceEnter(() => calls++, stdin);
        stdin.write("\n");
        stdin.write("\n");
        await new Promise((r) => setImmediate(r));
        assert.equal(calls, 1);
        assert.equal(stdin.listenerCount("data"), 0);
    });

    it("can be called off before anyone presses it", () => {
        const listeners = [];
        const fake = {
            on: (_e, fn) => listeners.push(fn),
            removeListener: (_e, fn) => listeners.splice(listeners.indexOf(fn), 1),
            resume: () => {},
            pause: () => {},
        };
        const cancel = onceEnter(() => assert.fail("not pressed"), fake);
        cancel();
        assert.equal(listeners.length, 0);
    });
});
