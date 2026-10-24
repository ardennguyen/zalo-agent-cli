/**
 * The retry engine (src/zalo/retry.js): the arithmetic of "when do I try again".
 *
 * Everything is deterministic: a fixed random number, a fixed clock, and an
 * anomaly history built by hand. What each test says is the behavior of the
 * official client the engine follows, not a re-reading of the engine's own code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_SOCKET_SETTINGS,
    createAnomalyHistory,
    createRetryEngine,
    fibo,
    resolveSocketSettings,
} from "../../src/zalo/retry.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);

/** An engine with no spreading: random 0, and a history so young it counts for nothing. */
function plain(over = {}, opts = {}) {
    const settings = resolveSocketSettings(over);
    return createRetryEngine({ settings, random: () => 0, anomaly: createAnomalyHistory({ now: () => T0 }), ...opts });
}
const delays = (engine, key, n) => Array.from({ length: n }, () => engine.next(key).delayMs);

describe("fibo", () => {
    it("is 1, 2, 3, 5, 8, 13 (the official cache starts 1, 2)", () => {
        assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(fibo), [1, 2, 3, 5, 8, 13, 21]);
    });
    it("treats anything below 1 as 1", () => {
        assert.equal(fibo(0), 1);
        assert.equal(fibo(-3), 1);
    });
});

describe("resolveSocketSettings", () => {
    it("is the defaults when the server says nothing", () => {
        assert.deepEqual(resolveSocketSettings(), DEFAULT_SOCKET_SETTINGS);
        assert.deepEqual(resolveSocketSettings({}), DEFAULT_SOCKET_SETTINGS);
        assert.deepEqual(resolveSocketSettings(null), DEFAULT_SOCKET_SETTINGS);
    });

    it("lets the server's plain values win and ignores null and undefined", () => {
        const s = resolveSocketSettings({ ping_interval: 90000, establish_timeout: null, timeout_authen: undefined });
        assert.equal(s.ping_interval, 90000);
        assert.equal(s.establish_timeout, DEFAULT_SOCKET_SETTINGS.establish_timeout);
        assert.equal(s.timeout_authen, DEFAULT_SOCKET_SETTINGS.timeout_authen);
    });

    it("merges the retry tables entry by entry, so one described key does not make the rest unknown", () => {
        const s = resolveSocketSettings({
            retries: { 5011: { times: [100], max: 2 } },
            retries_round_2: { default: { multiple: 1, max: 5 } },
        });
        assert.deepEqual(s.retries[5011], { times: [100], max: 2 });
        assert.deepEqual(s.retries.internal, DEFAULT_SOCKET_SETTINGS.retries.internal);
        assert.deepEqual(s.retries_round_2.default, { multiple: 1, max: 5 });
        assert.deepEqual(s.retries_round_2.internal, DEFAULT_SOCKET_SETTINGS.retries_round_2.internal);
    });

    it("does not let the caller change the defaults through the result", () => {
        const s = resolveSocketSettings();
        s.retries.internal.times.push(1);
        s.close_and_retry_codes.push(1);
        assert.equal(DEFAULT_SOCKET_SETTINGS.retries.internal.times.length, 4);
        assert.ok(!DEFAULT_SOCKET_SETTINGS.close_and_retry_codes.includes(1));
    });
});

describe("round 1", () => {
    it("takes the key's delays in order, staying on the last one, until max", () => {
        const e = plain();
        assert.deepEqual(delays(e, "internal", 8), [2000, 3000, 5000, 8000, 8000, 8000, 8000, 8000]);
    });

    it("takes a single number as every delay", () => {
        const e = plain();
        assert.deepEqual(delays(e, 5012, 5), [3000, 3000, 3000, 3000, 3000]);
    });

    it("counts each key on its own", () => {
        const e = plain();
        assert.equal(e.next("internal").delayMs, 2000);
        assert.equal(e.next("internal").delayMs, 3000);
        assert.equal(e.next(4001).delayMs, 2000, "another key starts at its own first delay");
        assert.equal(e.next("internal").delayMs, 5000);
    });

    it("never runs out for a key with no max", () => {
        const e = plain();
        for (let i = 0; i < 50; i++)
            assert.deepEqual(e.next("no_network"), {
                delayMs: i < 2 ? [3000, 5000][i] : 8000,
                round: 1,
                rotate: false,
                base: i < 2 ? [3000, 5000][i] : 8000,
            });
    });

    it("gives a key the server never described the last default delay, uncounted, and never throws", () => {
        const e = plain();
        for (const key of [9999, "no-such-key", 3003, 4999]) {
            assert.deepEqual(delays(e, key, 3), [60000, 60000, 60000], `key ${key}`);
        }
        assert.deepEqual(e.snapshot().round1, {}, "an undescribed key was counted");
    });

    it("treats the key 3003, listed as retryable but absent from the table, as undescribed (the zca-js TypeError)", () => {
        const s = resolveSocketSettings();
        assert.ok(s.close_and_retry_codes.includes(3003));
        assert.equal(s.retries[3003], undefined);
        assert.equal(
            createRetryEngine({ settings: s, random: () => 0, anomaly: createAnomalyHistory({ now: () => T0 }) }).next(
                3003,
            ).delayMs,
            60000,
        );
    });
});

describe("endpoint rotation", () => {
    it("switches endpoint when a rotating key's retries are spent, and starts the key over", () => {
        const e = plain({}, { endpoints: 2 });
        assert.deepEqual(delays(e, 5012, 5), [3000, 3000, 3000, 3000, 3000]);
        const sixth = e.next(5012);
        assert.deepEqual(sixth, { delayMs: 3000, round: 1, rotate: true, base: 3000 });
        assert.equal(e.rotateCount(), 1);
        assert.deepEqual(delays(e, 5012, 4), [3000, 3000, 3000, 3000], "the new endpoint gets its own five");
    });

    it("goes to round 2 once there is no endpoint left to rotate to", () => {
        const e = plain({}, { endpoints: 2 });
        delays(e, 5012, 6); // five, then the rotation and its first retry
        delays(e, 5012, 4); // the rest of the new endpoint's five
        const next = e.next(5012);
        assert.equal(next.round, 2);
        assert.equal(next.rotate, false);
        assert.equal(next.base, 3000, "round 2 for 5012 is fibo(1) * 3000");
    });

    it("never rotates with one endpoint, and never rotates a key the server did not list", () => {
        const one = plain({}, { endpoints: 1 });
        delays(one, 5012, 5);
        assert.equal(one.next(5012).round, 2);
        const many = plain({}, { endpoints: 5 });
        delays(many, "internal", 8);
        const after = many.next("internal");
        assert.equal(after.rotate, false);
        assert.equal(after.round, 2);
    });

    it("can go back to the first endpoint", () => {
        const e = plain({}, { endpoints: 2 });
        delays(e, 5012, 6);
        assert.equal(e.rotateCount(), 1);
        e.resetRotation();
        assert.equal(e.rotateCount(), 0);
    });
});

describe("round 2", () => {
    it("is Fibonacci times the key's multiple, capped at its max, and has no end", () => {
        const e = plain();
        delays(e, "internal", 8); // round 1 is spent
        const second = delays(e, "internal", 12);
        assert.deepEqual(second, [2000, 4000, 6000, 10000, 16000, 26000, 42000, 60000, 60000, 60000, 60000, 60000]);
    });

    it("uses the default entry for a key without its own", () => {
        const e = plain({ retries: { 7777: { times: [10], max: 1 } } });
        e.next(7777);
        const second = delays(e, 7777, 4);
        assert.deepEqual(second, [3000, 6000, 9000, 15000], "default multiple is 3000");
    });
});

describe("spreading", () => {
    it("multiplies the delay by 1 + noise, noise being retry_noise_factor times the random number", () => {
        const e = createRetryEngine({
            settings: resolveSocketSettings({ retry_noise_factor: 0.5 }),
            random: () => 1,
            anomaly: createAnomalyHistory({ now: () => T0 }),
        });
        assert.equal(e.next("internal").delayMs, 2000 * 1.5);
    });

    it("falls back to the default noise factor when the server's is not a positive number", () => {
        for (const bad of [0, -1, "x"]) {
            const e = createRetryEngine({
                settings: resolveSocketSettings({ retry_noise_factor: bad }),
                random: () => 1,
                anomaly: createAnomalyHistory({ now: () => T0 }),
            });
            assert.equal(e.next("internal").delayMs, 2000 * 1.2, `factor ${bad}`);
        }
    });

    it("adds the anomaly: about double for an error this installation has never seen", () => {
        const old = createAnomalyHistory({ state: { firstInstall: T0 - 8 * DAY, errors: [] }, now: () => T0 });
        const e = createRetryEngine({ settings: resolveSocketSettings(), random: () => 0, anomaly: old });
        assert.equal(e.next("internal").delayMs, 2000 * 2);
    });

    it("records each retry in the history", () => {
        const history = createAnomalyHistory({ now: () => T0 });
        const e = createRetryEngine({ settings: resolveSocketSettings(), random: () => 0, anomaly: history });
        e.next(4001);
        assert.deepEqual(history.state().errors, [{ code: 4001, time: T0 }]);
    });
});

describe("resetting", () => {
    it("starts the named keys over in both rounds and leaves the others alone", () => {
        const e = plain();
        delays(e, "internal", 10); // into round 2
        delays(e, 4001, 2);
        e.resetKeys(["internal"]);
        assert.equal(e.next("internal").delayMs, 2000);
        assert.equal(e.next(4001).delayMs, 5000, "4001 kept its place");
    });

    it("starts everything over", () => {
        const e = plain();
        delays(e, "internal", 10);
        delays(e, 4001, 2);
        e.resetAll();
        assert.deepEqual(e.snapshot(), { round1: {}, round2: {}, rotated: 0 });
    });
});

describe("the anomaly history", () => {
    const at = (t, state) => createAnomalyHistory({ state, now: () => t });

    it("counts for nothing in the first week after install", () => {
        const h = at(T0, { firstInstall: T0 - 6 * DAY, errors: [] });
        assert.equal(h.computeAbnormalRate("internal"), 0);
    });

    it("is exp(-kalpha * n) after that, n being the EARLIER days the code was seen in", () => {
        const errors = [
            { code: 4001, time: T0 - 1 * DAY },
            { code: 4001, time: T0 - 2 * DAY },
            { code: 4001, time: T0 - 2 * DAY + 3600_000 }, // same day as the one above: counts again, as the official client counts entries
            { code: 5011, time: T0 - 1 * DAY },
            { code: 4001, time: T0 - 1000 }, // today: not counted
        ];
        const h = createAnomalyHistory({ state: { firstInstall: T0 - 30 * DAY, errors }, kalpha: 0.5, now: () => T0 });
        assert.equal(h.computeAbnormalRate(4001), Math.exp(-0.5 * 3));
        assert.equal(h.computeAbnormalRate(5011), Math.exp(-0.5 * 1));
        assert.equal(h.computeAbnormalRate(9), 1, "a code never seen is as unusual as it gets");
    });

    it("records the same code at most once an hour, but code 0 always", () => {
        let t = T0;
        const h = createAnomalyHistory({ now: () => t });
        assert.equal(h.addError(4001), true);
        t += 59 * 60_000;
        assert.equal(h.addError(4001), false);
        t += 2 * 60_000;
        assert.equal(h.addError(4001), true);
        assert.equal(h.addError(0), true);
        assert.equal(h.addError(0), true);
        assert.equal(h.state().errors.length, 4);
    });

    it("refuses what is not a code, keeps the last 100, and drops what is over a week old on load", () => {
        const h = createAnomalyHistory({
            state: {
                firstInstall: T0 - 30 * DAY,
                errors: [
                    { code: 1, time: T0 - 8 * DAY },
                    { code: 2, time: T0 - 1 * DAY },
                ],
            },
            now: () => T0,
        });
        assert.deepEqual(h.state().errors, [{ code: 2, time: T0 - 1 * DAY }]);
        assert.equal(h.addError({}), false);
        assert.equal(h.addError(undefined), false);
        let t = T0;
        const many = createAnomalyHistory({ now: () => t });
        for (let i = 0; i < 130; i++) {
            t += 3_700_000; // past the hourly de-duplication for every code
            many.addError(i);
        }
        assert.equal(many.state().errors.length, 100);
        assert.equal(many.state().errors[0].code, 30, "the oldest 30 were dropped");
    });

    it("hands the whole state to save() after every change", () => {
        const saved = [];
        const h = createAnomalyHistory({ now: () => T0, save: (s) => saved.push(s) });
        h.addError(4001);
        assert.equal(saved.length, 1);
        assert.deepEqual(saved[0].errors, [{ code: 4001, time: T0 }]);
        assert.equal(saved[0].firstInstall, T0);
        saved[0].errors.push("tampered");
        assert.equal(h.state().errors.length, 1, "save() was handed the live state, not a copy");
    });
});
