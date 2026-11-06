/**
 * A frozen clock and a seeded `Math.random`, so the two engines of a differential run see the same time and the
 * same "random" numbers: zca-js stamps clientIds and `zcid_ext` from them, and our session clock reads `Date.now`.
 *
 * Both stubs are process-wide while installed. Install them right around the call being compared and restore
 * them in a `finally`; node:test's own timers do not read `Date`, so a test's timeouts keep working.
 */

/**
 * Freeze the clock at `t0`: `Date.now()` and `new Date()` (no arguments) return it until it is moved by hand.
 * `x instanceof Date` keeps working for dates made before the stub.
 *
 * @param {number} t0 - milliseconds since the epoch
 * @returns {{now: () => number, set: (t: number) => void, advance: (ms: number) => number, restore: () => void}}
 */
export function freezeTime(t0) {
    const RealDate = globalThis.Date;
    let now = Number(t0);
    if (!Number.isFinite(now)) throw new Error(`freezeTime: not a time: ${t0}`);

    class FrozenDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(now);
            else super(...args);
        }

        static now() {
            return now;
        }

        static [Symbol.hasInstance](value) {
            return value instanceof RealDate;
        }
    }

    globalThis.Date = FrozenDate;
    let restored = false;
    return {
        now: () => now,
        set: (t) => {
            now = Number(t);
        },
        advance: (ms) => (now += Number(ms)),
        restore: () => {
            if (restored) return;
            restored = true;
            globalThis.Date = RealDate;
        },
    };
}

/**
 * Make `Math.random` a seeded generator (mulberry32): the same seed gives the same sequence.
 *
 * @param {number} seed - any integer
 * @returns {{reseed: (n: number) => void, restore: () => void}}
 */
export function seedRandom(seed) {
    const real = Math.random;
    let state = seed >>> 0;
    Math.random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let restored = false;
    return {
        reseed: (n) => {
            state = n >>> 0;
        },
        restore: () => {
            if (restored) return;
            restored = true;
            Math.random = real;
        },
    };
}
