/**
 * The wire harness: one login against the fake Zalo, our engine on its context, one call at a time, and everything
 * it sent and returned recorded, so a case can be checked against its reviewed golden record
 * (agent/docs/zca-replace/design.md 3.1 and 3.3).
 *
 * ```js
 * import "../helpers/sandbox.js";
 * import { openWire, expectGolden } from "../helpers/wire-diff/index.js";
 *
 * const wire = await openWire();
 * const rec = await wire.run("getGroupInfo", ["1000000000000000001"], { reply: { gridInfoMap: {} } });
 * await expectGolden("groups", "getGroupInfo", rec.own); // our record against its reviewed entry
 * wire.close();
 * ```
 *
 * A record keeps its side under `own` (`rec.own.requests`, `rec.own.result`, `rec.own.error`): the side our engine
 * played when the harness also ran another engine, and still the one `expectGolden` reads.
 *
 * A test that uses it reaches `src/core/credentials.js` (through tests/unit/fake-zalo-session.js) and must import
 * tests/helpers/sandbox.js first. Every id here is fake.
 */
import { FAKE, installFakeZalo } from "../../unit/fake-zalo-session.js";
import { createApi as engineCreateApi } from "../../../src/zalo/api.js";
import { freezeTime, seedRandom } from "./clock.js";
import { normalizeError, normalizeRequest, normalizeResult, normalizeValue } from "./normalize.js";
import { loginOnce } from "./session.js";

export { expectGolden } from "./golden.js";
export { freezeTime, seedRandom } from "./clock.js";
export { openListenerWire } from "./listener-wire.js";
export { recordEvents } from "./events.js";
export { loginOnce };
export { FAKE };

/** The frozen time every run starts from (2023-11-14T22:13:20Z): 13 digits, no id. */
export const T0 = 1700000000000;

/** The seed of `Math.random` at the start of every run. */
export const SEED = 20261106;

/**
 * The time zone of every run: values formatted from local time (`changeGroupAvatar`'s clientId) then come out the
 * same on every machine, and golden files hold them.
 */
export const TZ = "Asia/Ho_Chi_Minh";

/**
 * Install one run's canned answers on the fake: `replies` first (by path suffix), then `error` or `reply` for
 * every other API request.
 *
 * @param {ReturnType<typeof installFakeZalo>} fake
 * @param {{reply?: unknown, replies?: Record<string, object|object[]>, error?: object}} fixture
 */
function installAnswers(fake, { reply, replies = {}, error } = {}) {
    for (const [suffix, answer] of Object.entries(replies)) {
        if (Array.isArray(answer)) fake.routeSequence(suffix, answer);
        else fake.routeAnswer(suffix, answer);
    }
    if (error) fake.routeAnswer("", error);
    else if (reply !== undefined) fake.routeAnswer("", { data: reply });
}

/**
 * Open the wire harness: install the fake Zalo, log in once, and build the engine on that ctx.
 *
 * @param {object} [opts]
 * @param {object} [opts.fake] - options of `installFakeZalo` (`settings`, `omit`, ...)
 * @param {object} [opts.zaloOptions] - see tests/helpers/wire-diff/session.js `loginOnce`
 * @param {number} [opts.t0] - the frozen time of each run
 * @param {number} [opts.seed] - the `Math.random` seed of each run
 * @param {string} [opts.tz] - the time zone of each run (`process.env.TZ`, put back afterwards)
 * @param {Function} [opts.createApi] - instead of the engine's (src/zalo/api.js): `(ctx, serviceMap, wsUrls, opts)`
 * @returns {Promise<{
 *   own: object, ctx: object, fake: ReturnType<typeof installFakeZalo>,
 *   run: (name: string, args?: unknown[]|(() => unknown[]),
 *     fixture?: {reply?: unknown, replies?: Record<string, object|object[]>, error?: object,
 *       during?: (clock: ReturnType<typeof freezeTime>) => unknown}) => Promise<object>,
 *   close: () => void,
 * }>}
 *   `run` calls `api[name](...args)` on a freshly built engine (so a clientId source starts over) with the clock
 *   frozen at `t0` in zone `tz`, `Math.random` reseeded and the answers reinstalled. It returns
 *   `{name, args, own: {requests, result, error}}`: the requests the engine made
 *   (tests/helpers/wire-diff/normalize.js), the value it returned, or the `{message, code}` it threw. Pass `args`
 *   as a function when the call may change them (it gets a fresh array). The answers replace any route a test set
 *   on `fake` before.
 *
 *   The clock is installed before the engine is built, and the engine gets it as `{now: clock.now}` (the `s.now()`
 *   injection of design 1.2), so a clock the engine captures while being built is the frozen one too. Time stands
 *   still for the whole call: a method that waits until `s.now()` has moved (an upload's replay-last-chunk delay, a
 *   settle timeout) moves on only when the test moves the clock. `fixture.during` is called with the run's clock
 *   (`advance(ms)`, `set(t)`, `now()`) once the call has started, and the call's result is awaited after it
 *   returns; node:test's timers and `setTimeout` keep real time, so `during` can wait for a request with them. A
 *   `during` that throws fails the run.
 */
export async function openWire({
    fake: fakeOptions = {},
    zaloOptions = {},
    t0 = T0,
    seed = SEED,
    tz = TZ,
    createApi = engineCreateApi,
} = {}) {
    const fake = installFakeZalo(fakeOptions);
    try {
        const { ctx, serviceMap, wsUrls } = await loginOnce(zaloOptions);
        // `now` is the session clock injection of design 1.2 (`s.now()`). The engine built here, outside any run,
        // keeps the real clock: it backs `wire.own`.
        const build = (clock) => createApi(ctx, serviceMap, wsUrls, clock ? { now: clock.now } : {});
        let api = await build();

        async function run(name, args = [], fixture = {}) {
            const callArgs = () => (typeof args === "function" ? args() : args);
            const out = { name, args: normalizeValue(callArgs()) };
            fake.clearRoutes();
            installAnswers(fake, fixture);
            const from = fake.requests.length;
            // The clock, Math.random and the zone go in BEFORE the engine is built: an engine that binds `Date.now`
            // or seeds its clientId source while it is being built must see t0, not the real time.
            const zone = process.env.TZ;
            process.env.TZ = tz;
            const clock = freezeTime(t0);
            const random = seedRandom(seed);
            let result;
            let error = null;
            let harnessError = null;
            try {
                try {
                    api = await build(clock);
                } catch (e) {
                    // An engine that cannot be built is not an outcome to record: the run fails.
                    harnessError = e;
                    throw e;
                }
                const fn = api[name];
                if (typeof fn !== "function") throw new Error(`the engine has no method ${name}`);
                const call = Promise.resolve(fn.apply(api, callArgs()));
                if (typeof fixture.during === "function") {
                    // Handled here so a call that fails while `during` still waits is not an unhandled rejection;
                    // `await call` below still sees the failure.
                    call.catch(() => {});
                    try {
                        await fixture.during(clock);
                    } catch (e) {
                        harnessError = e;
                        throw e;
                    }
                }
                result = await call;
            } catch (e) {
                if (!harnessError) error = normalizeError(e);
            } finally {
                random.restore();
                clock.restore();
                if (zone === undefined) delete process.env.TZ;
                else process.env.TZ = zone;
            }
            // A failing build or `during` is the harness's or the test's problem, not something the call did.
            if (harnessError) throw harnessError;
            out.own = {
                requests: fake.requests.slice(from).map((r) => normalizeRequest(r, fake)),
                result: error ? undefined : normalizeResult(result),
                error,
            };
            fake.clearRoutes();
            return out;
        }

        return {
            get own() {
                return api;
            },
            ctx,
            fake,
            run,
            close: () => fake.uninstall(),
        };
    } catch (e) {
        fake.uninstall();
        throw e;
    }
}
