/**
 * The timers of a logged-in session (src/zalo/upkeep.js, plan items L2e and L9), run on a hand-driven clock:
 * the hourly settings refresh, and the keepalive that exists only when the server's settings ask for one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keepAliveSchedule, startUpkeep } from "../../src/zalo/upkeep.js";

/** A clock and a set of timers that advance only when told to. */
function fakeClock() {
    let t = 1_000_000;
    let nextId = 1;
    const timers = new Map();
    return {
        now: () => t,
        timers: {
            setInterval(fn, every) {
                const id = nextId++;
                timers.set(id, { fn, every, next: t + every });
                return { id, unref() {} };
            },
            clearInterval(h) {
                timers.delete(h?.id);
            },
        },
        live: () => timers.size,
        async advance(ms) {
            const end = t + ms;
            for (;;) {
                const due = [...timers.values()].filter((x) => x.next <= end).sort((a, b) => a.next - b.next)[0];
                if (!due) break;
                t = due.next;
                due.next += due.every;
                await due.fn();
                await Promise.resolve();
                await Promise.resolve();
            }
            t = end;
        },
    };
}

function session(settings) {
    const sent = [];
    const ctx = { settings, options: { polyfill: async (url) => void sent.push(url) } };
    return { ctx, sent };
}

describe("keepAliveSchedule", () => {
    it("is off unless the server asks, and then runs at the server's value (120 s when 0)", () => {
        assert.equal(keepAliveSchedule(undefined).on, false);
        assert.equal(
            keepAliveSchedule({ keepalive: { alway_keepalive: 0, keepalive_duration: 0, time_deactive: 0 } }).on,
            false,
        );
        assert.deepEqual(keepAliveSchedule({ keepalive: { alway_keepalive: 1, keepalive_duration: 0 } }), {
            on: true,
            everyMs: 120_000,
            idleMs: 300_000,
        });
        assert.deepEqual(keepAliveSchedule({ keepalive: { keepalive_duration: 45, time_deactive: 90 } }), {
            on: true,
            everyMs: 45_000,
            idleMs: 90_000,
        });
    });
});

describe("session upkeep", () => {
    it("adds no keepalive traffic when the settings do not ask for it, only the hourly refresh", async () => {
        const clock = fakeClock();
        const { ctx } = session({ keepalive: { alway_keepalive: 0, keepalive_duration: 0, time_deactive: 0 } });
        let keeps = 0;
        let refreshes = 0;
        const up = startUpkeep(ctx, {
            keepAlive: async () => void keeps++,
            refreshSettings: async () => void refreshes++,
            now: clock.now,
            timers: clock.timers,
        });
        assert.equal(clock.live(), 1, "only the refresh timer");
        await clock.advance(3 * 3_600_000 + 1000);
        assert.equal(keeps, 0);
        assert.equal(refreshes, 3);
        up.stop();
        assert.equal(clock.live(), 0);
    });

    it("keeps alive on the server's schedule, resets on other requests, stops when idle, restarts on a request", async () => {
        const clock = fakeClock();
        const { ctx } = session({ keepalive: { alway_keepalive: 1, keepalive_duration: 120, time_deactive: 300 } });
        let keeps = 0;
        const up = startUpkeep(ctx, {
            keepAlive: async () => {
                keeps++;
                await ctx.options.polyfill("https://chat.example/keepalive"); // our own call must not count as use
            },
            refreshSettings: async () => {},
            now: clock.now,
            timers: clock.timers,
        });
        await clock.advance(121_000);
        assert.equal(keeps, 1, "first keepalive after 120 s");
        await clock.advance(120_000);
        assert.equal(keeps, 2);
        await clock.advance(120_000); // 361 s since anything but keepalives: idle (300 s) has passed
        assert.equal(keeps, 2, "stopped: nothing but keepalives for longer than time_deactive");
        assert.equal(clock.live(), 1, "only the refresh timer is left");

        await ctx.options.polyfill("https://chat.example/api/x"); // a real request wakes it
        assert.equal(clock.live(), 2);
        await clock.advance(121_000);
        assert.equal(keeps, 3);
        up.stop();
        assert.equal(clock.live(), 0);
    });

    describe("the configuration version a keepalive answers (L2e)", () => {
        /** Run keepalives that answer the given versions in turn, and report how often the settings were asked for. */
        async function run(answers) {
            const clock = fakeClock();
            const { ctx } = session({
                keepalive: { alway_keepalive: 1, keepalive_duration: 120, time_deactive: 100_000 },
            });
            let refreshes = 0;
            let i = 0;
            const up = startUpkeep(ctx, {
                keepAlive: async () => answers[Math.min(i++, answers.length - 1)],
                refreshSettings: async () => void refreshes++,
                now: clock.now,
                timers: clock.timers,
            });
            await clock.advance(120_000 * answers.length + 1000);
            up.stop();
            return refreshes;
        }

        it("asks for the settings again, at once, when the version changes", async () => {
            assert.equal(await run([{ config_vesion: 2 }, { config_vesion: 3 }]), 1);
        });

        it("does not, while the version stays the same: the first answer is only the baseline", async () => {
            assert.equal(await run([{ config_vesion: 2 }, { config_vesion: 2 }, { config_vesion: 2 }]), 0);
        });

        it("asks once per change, not once per keepalive after it", async () => {
            assert.equal(await run([{ config_vesion: 2 }, { config_vesion: 3 }, { config_vesion: 3 }]), 1);
            assert.equal(await run([{ config_vesion: 2 }, { config_vesion: 3 }, { config_vesion: 4 }]), 2);
        });

        it("ignores an answer that carries no version, or none a number", async () => {
            assert.equal(await run([{ config_vesion: 2 }, {}, null, { config_vesion: "x" }, { config_vesion: 2 }]), 0);
        });
    });

    it("a real request resets the idle clock", async () => {
        const clock = fakeClock();
        const { ctx } = session({ keepalive: { alway_keepalive: 1, keepalive_duration: 100, time_deactive: 250 } });
        let keeps = 0;
        startUpkeep(ctx, {
            keepAlive: async () => void keeps++,
            refreshSettings: async () => {},
            now: clock.now,
            timers: clock.timers,
        });
        await clock.advance(200_000);
        await ctx.options.polyfill("https://chat.example/api/x");
        await clock.advance(200_000);
        assert.equal(keeps, 4, "kept going: the request at 200 s restarted the 250 s idle allowance");
    });

    it("swallows a failing keepalive and a failing refresh", async () => {
        const clock = fakeClock();
        const { ctx } = session({ keepalive: { alway_keepalive: 1, keepalive_duration: 10, time_deactive: 300 } });
        let tries = 0;
        startUpkeep(ctx, {
            keepAlive: async () => {
                tries++;
                throw new Error("offline");
            },
            refreshSettings: async () => {
                throw new Error("offline");
            },
            now: clock.now,
            timers: clock.timers,
        });
        await clock.advance(3_700_000);
        assert.ok(tries > 5, "kept trying");
    });

    it("re-reads the settings after a refresh: a keepalive switched on starts, one switched off stops", async () => {
        const clock = fakeClock();
        const { ctx } = session({ keepalive: { alway_keepalive: 0, keepalive_duration: 0 } });
        const up = startUpkeep(ctx, {
            keepAlive: async () => {},
            refreshSettings: async () => {
                ctx.settings = { keepalive: { alway_keepalive: 1, keepalive_duration: 60, time_deactive: 99_999 } };
            },
            now: clock.now,
            timers: clock.timers,
        });
        assert.equal(clock.live(), 1);
        await clock.advance(3_600_001);
        assert.equal(clock.live(), 2, "the keepalive timer started after the refresh");
        up.stop();
    });
});
