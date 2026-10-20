/**
 * src/core/daemon-log.js -- what daemon.log says while a sync stage runs.
 *
 * Run directly, `sync` prints every phase. Run by a daemon it printed nothing
 * to the daemon's log until the stage ended, so a 100,000-message restore that
 * died with close 1006 left no trace of what it had been doing. These drive
 * the loggers with a fake clock and fake timers, so no test waits.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    createSocketContext,
    createStageLogger,
    describeError,
    formatDuration,
    startEventLoopMonitor,
    summarizeResult,
} from "../../src/core/daemon-log.js";
import { createSyncRunners } from "../../src/core/daemon-sync.js";

/** A clock and an interval list the test advances by hand. */
function fakeTime(start = 1_000_000) {
    let t = start;
    const intervals = [];
    return {
        now: () => t,
        advance: (ms) => void (t += ms),
        timers: {
            setInterval: (fn, ms) => {
                const handle = { fn, ms, cleared: false, unref() {} };
                intervals.push(handle);
                return handle;
            },
            clearInterval: (h) => void (h.cleared = true),
        },
        intervals,
        /** Run every live interval once, as if its period had passed. */
        fire: () => intervals.filter((i) => !i.cleared).forEach((i) => i.fn()),
    };
}

describe("formatDuration / describeError / summarizeResult", () => {
    it("formats seconds, minutes and hours", () => {
        assert.equal(formatDuration(7000), "7s");
        assert.equal(formatDuration(245_000), "4m05s");
        assert.equal(formatDuration(3_723_000), "1h02m03s");
        assert.equal(formatDuration(-5), "0s");
    });

    it("keeps an error's type, code, cause chain and the top of its stack", () => {
        const root = new Error("socket hang up");
        const err = Object.assign(new Error("restore failed", { cause: root }), { code: 1006, name: "SyncError" });
        const text = describeError(err);
        assert.match(text, /^SyncError: restore failed \(code 1006\) <- socket hang up/);
        assert.match(text, /\[at /, "stack frames follow");
        assert.equal(describeError("plain"), "plain");
        assert.equal(describeError(undefined), "undefined");
    });

    it("summarizes only short scalar fields of a result", () => {
        assert.equal(
            summarizeResult({
                messagesSaved: 120,
                reason: "complete",
                threadsMapped: 3,
                big: { a: 1 },
                long: "x".repeat(200),
            }),
            "messagesSaved=120 reason=complete threadsMapped=3",
        );
        assert.equal(summarizeResult(undefined), "");
        assert.equal(summarizeResult("done"), "done");
    });
});

describe("createStageLogger", () => {
    function setup(extra = {}) {
        const time = fakeTime();
        const lines = [];
        const trace = createStageLogger({
            stage: "messages",
            log: (m) => lines.push(m),
            now: time.now,
            timers: time.timers,
            ...extra,
        });
        return { time, lines, trace };
    }

    it("logs the parameters, each phase with the time since the start, and the result", () => {
        const { time, lines, trace } = setup();
        trace.start({ days: 90, shardSize: 30, nothing: undefined, nested: { a: 1 } });
        time.advance(4_000);
        trace.event({ phase: "assets", detail: "loading decryption assets" });
        time.advance(125_000);
        trace.event({ phase: "progress", detail: "batch 3/50 — 2000 new message(s), 6000 total" });
        time.advance(1_000);
        trace.finish({ messagesSaved: 100000, reason: "complete" });
        assert.deepEqual(lines, [
            "[sync:messages] started (days=90 shardSize=30)",
            "[sync:messages] +4s assets: loading decryption assets",
            "[sync:messages] +2m09s progress: batch 3/50 — 2000 new message(s), 6000 total",
            "[sync:messages] finished in 2m10s: messagesSaved=100000 reason=complete",
        ]);
    });

    it("logs a failure with its code and cause, after the time it took", () => {
        const { time, lines, trace } = setup();
        trace.start();
        time.advance(61_000);
        trace.fail(Object.assign(new Error("the connection dropped after your phone confirmed"), { code: 1006 }));
        assert.match(
            lines.at(-1),
            /^\[sync:messages\] failed after 1m01s: the connection dropped after your phone confirmed \(code 1006\)/,
        );
    });

    it("counts live events and summarizes them instead of printing each one", () => {
        const { time, lines, trace } = setup({ liveFlushMs: 30_000 });
        trace.start();
        for (let i = 0; i < 500; i++) trace.event({ phase: "live", detail: `stored a live message in ${i}` });
        assert.equal(lines.length, 1, "no per-message lines");
        time.advance(31_000);
        trace.event({ phase: "live", detail: "one more" });
        assert.match(lines.at(-1), /stored 501 live event\(s\) while running/);
        trace.event({ phase: "live" });
        trace.finish({});
        assert.ok(
            lines.some((l) => /stored 1 live event\(s\)/.test(l)),
            "the remainder is flushed at the end",
        );
    });

    it("writes a periodic 'still running' line naming the last progress, and the worst stall", () => {
        const monitorMax = [7_500, 0];
        const { time, lines, trace } = setup({ monitor: { takeMax: () => monitorMax.shift() ?? 0 } });
        trace.start();
        trace.event({ phase: "messages", detail: "waiting up to 5 min for the phone" });
        time.advance(70_000);
        time.fire();
        assert.match(
            lines.at(-1),
            /still running: \+1m10s, last progress 1m10s ago \(messages: waiting up to 5 min for the phone\), worst event-loop stall 7\.5s/,
        );
        time.advance(60_000);
        time.fire();
        assert.doesNotMatch(lines.at(-1), /event-loop stall/, "a quiet interval adds nothing");
        trace.stop();
        assert.ok(
            time.intervals.every((i) => i.cleared),
            "the timer is cleared at the end",
        );
    });
});

describe("startEventLoopMonitor", () => {
    it("logs a stall at or above the threshold, with what the daemon was doing, and tracks the worst one", () => {
        const time = fakeTime();
        const lines = [];
        const mon = startEventLoopMonitor({
            log: (m) => lines.push(m),
            warnMs: 3000,
            context: () => "the messages stage was running",
            now: time.now,
            timers: time.timers,
        });
        time.advance(1000);
        mon.tick(); // on time: nothing
        time.advance(1000 + 6_200);
        mon.tick(); // 6.2s late
        time.advance(1000 + 1_000);
        mon.tick(); // 1s late: under the threshold
        assert.equal(lines.length, 1);
        assert.match(
            lines[0],
            /event loop was blocked for 6\.2s while the messages stage was running: socket pings and reads were not served/,
        );
        assert.equal(mon.takeMax(), 6200);
        assert.equal(mon.takeMax(), 0, "taking the maximum resets it");
        mon.stop();
        assert.ok(time.intervals[0].cleared);
    });
});

describe("createSocketContext", () => {
    it("says how long the socket was up, which stage was running and how bad the worst stall was", () => {
        const time = fakeTime();
        const ctx = createSocketContext({
            lock: { current: () => ({ stage: "messages", startedAt: time.now() - 300_000 }) },
            monitor: { takeMax: () => 4_000 },
            now: time.now,
        });
        assert.match(
            ctx.describe(),
            /^socket age unknown; stage in progress: messages for 5m00s; worst event-loop stall since the last check 4\.0s$/,
        );
        ctx.markUp();
        time.advance(2_220_000);
        assert.match(ctx.describe(), /^socket was up 37m00s; stage in progress: messages for 5m00s/);
    });

    it("is short when nothing is running", () => {
        const time = fakeTime();
        const ctx = createSocketContext({
            lock: { current: () => null },
            monitor: { takeMax: () => 0 },
            now: time.now,
        });
        ctx.markUp();
        time.advance(60_000);
        assert.equal(ctx.describe(), "socket was up 1m00s");
    });
});

describe("createSyncRunners logs every runner it hands out", () => {
    it("wraps a stage so the daemon log gets its start, its events and its end, whoever called it", async () => {
        const lines = [];
        const runners = createSyncRunners({
            getApi: () => ({}),
            accountName: "1",
            log: (m) => lines.push(m),
        });
        // `getApi()` gives no listener, so the runner refuses: the failure must be logged too.
        const seen = [];
        await assert.rejects(() => runners.reactions({ waitMs: 5 }, (e) => seen.push(e)), /no listener/);
        assert.match(lines[0], /^\[sync:reactions\] started \(waitMs=5\)$/);
        assert.match(
            lines.at(-1),
            /^\[sync:reactions\] failed after 0s: this daemon has no listener to run the reaction drain on/,
        );
    });
});
