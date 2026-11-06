/**
 * The differential harness: one login against the fake Zalo, two engines on its context, the same call through
 * each, and everything each sent and returned recorded side by side (agent/docs/zca-replace/design.md 3.1).
 *
 * ```js
 * import "../helpers/sandbox.js";
 * import { openPair, assertSameWire, expectGolden, ALLOW } from "../helpers/wire-diff/index.js";
 *
 * const pair = await openPair();
 * const rec = await pair.run("getGroupInfo", ["1000000000000000001"], { reply: { gridInfoMap: {} } });
 * assertSameWire(rec, ALLOW.groups);         // 1. zca against own
 * await expectGolden("groups", "getGroupInfo", rec.own); // 2. own against its reviewed record
 * pair.close();
 * ```
 *
 * A test that uses it reaches `src/core/credentials.js` (through tests/unit/fake-zalo-session.js) and must import
 * tests/helpers/sandbox.js first. Every id here is fake.
 */
import { FAKE, installFakeZalo } from "../../unit/fake-zalo-session.js";
import { freezeTime, seedRandom } from "./clock.js";
import { resolveCreateApi } from "./engines.js";
import { normalizeError, normalizeRequest, normalizeResult, normalizeValue } from "./normalize.js";
import { loginOnce } from "./session.js";

export { ALLOW, GLOBAL } from "./allow.js";
export { assertSameListener, assertSameWire, diffListener, diffRecords } from "./compare.js";
export { expectGolden } from "./golden.js";
export { freezeTime, seedRandom } from "./clock.js";
export { openListenerPair } from "./listener-pair.js";
export { recordEvents } from "./events.js";
export { loginOnce };
export { FAKE };

/** The frozen time every run starts from (2023-11-14T22:13:20Z): 13 digits, no id. */
export const T0 = 1700000000000;

/** The seed of `Math.random` at the start of every run. */
export const SEED = 20261106;

/**
 * The time zone of every run: values formatted from local time (zca-js's `changeGroupAvatar` clientId) then
 * come out the same on every machine, and golden files hold them.
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
 * Open a differential pair: install the fake Zalo, log in once, and build both engines on that one ctx.
 *
 * @param {object} [opts]
 * @param {object} [opts.fake] - options of `installFakeZalo` (`settings`, `omit`, ...)
 * @param {object} [opts.zaloOptions] - see tests/helpers/wire-diff/session.js `loginOnce`
 * @param {"own"|"zca"} [opts.ownEngine] - what plays the "own" side; "zca" for the harness's self-test
 * @param {"own"|"zca"} [opts.zcaEngine] - what plays the "zca" side
 * @param {number} [opts.t0] - the frozen time of each run
 * @param {number} [opts.seed] - the `Math.random` seed of each run
 * @param {string} [opts.tz] - the time zone of each run (`process.env.TZ`, put back afterwards)
 * @param {Function} [opts.createApi] - instead of {@link resolveCreateApi}'s
 * @returns {Promise<{
 *   own: object, zca: object, ctx: object, fake: ReturnType<typeof installFakeZalo>, standIn: boolean,
 *   run: (name: string, args?: unknown[]|((side: "zca"|"own") => unknown[]),
 *     fixture?: {reply?: unknown, replies?: Record<string, object|object[]>, error?: object,
 *       during?: (clock: ReturnType<typeof freezeTime>, side: "zca"|"own") => unknown}) => Promise<object>,
 *   close: () => void,
 * }>}
 *   `run` calls `api[name](...args)` on each engine in turn (zca first), each time on a freshly built engine
 *   (so a clientId source starts over) with the clock frozen at `t0` in zone `tz`, `Math.random` reseeded and the answers
 *   reinstalled. It returns `{name, args, zca, own}`, each side `{requests, result, error}`: the requests that
 *   side made (tests/helpers/wire-diff/normalize.js), the value it returned, or the `{message, code}` it threw.
 *   Pass `args` as a function when an engine may change them (it gets a fresh array per side). The answers
 *   replace any route a test set on `fake` before.
 *
 *   The clock is installed before each side's engine is built, and that engine gets it as `{now: clock.now}`
 *   (the `s.now()` injection of design 1.2), so a clock the engine captures while being built is the frozen
 *   one too. Time stands still for the whole call: a method that waits until `s.now()` has moved (an upload's
 *   replay-last-chunk delay, a settle timeout) moves on only when the test moves the clock. `fixture.during`
 *   is called with the run's clock (`advance(ms)`, `set(t)`, `now()`) and the side once the call has started,
 *   and the call's result is awaited after it returns; node:test's timers and `setTimeout` keep real time, so
 *   `during` can wait for a request with them. A `during` that throws fails the run.
 */
export async function openPair({
    fake: fakeOptions = {},
    zaloOptions = {},
    ownEngine = "own",
    zcaEngine = "zca",
    t0 = T0,
    seed = SEED,
    tz = TZ,
    createApi,
} = {}) {
    const resolved = createApi ? { createApi, standIn: false } : await resolveCreateApi();
    const fake = installFakeZalo(fakeOptions);
    try {
        const { ctx, serviceMap, wsUrls } = await loginOnce(zaloOptions);
        const engines = { zca: zcaEngine, own: ownEngine };
        // `now` is the session clock injection of design 1.2 (`s.now()`); zca-js ignores it and reads the stubbed
        // `Date.now`. The engines built here, outside any run, keep the real clock: they back `pair.own`/`pair.zca`.
        const build = (side, clock) =>
            resolved.createApi(
                ctx,
                serviceMap,
                wsUrls,
                clock ? { engine: engines[side], now: clock.now } : { engine: engines[side] },
            );
        const apis = { zca: await build("zca"), own: await build("own") };

        async function run(name, args = [], fixture = {}) {
            const out = { name, args: normalizeValue(typeof args === "function" ? args("zca") : args) };
            for (const side of ["zca", "own"]) {
                fake.clearRoutes();
                installAnswers(fake, fixture);
                const from = fake.requests.length;
                // The clock, Math.random and the zone go in BEFORE the engine is built: an engine that binds
                // `Date.now` or seeds its clientId source while it is being built must see t0, not the real time.
                const zone = process.env.TZ;
                process.env.TZ = tz;
                const clock = freezeTime(t0);
                const random = seedRandom(seed);
                let result;
                let error = null;
                let harnessError = null;
                try {
                    try {
                        apis[side] = await build(side, clock);
                    } catch (e) {
                        // An engine that cannot be built is not a difference to record: the run fails.
                        harnessError = e;
                        throw e;
                    }
                    const fn = apis[side][name];
                    if (typeof fn !== "function") throw new Error(`the ${side} engine has no method ${name}`);
                    const callArgs = typeof args === "function" ? args(side) : args;
                    const call = Promise.resolve(fn.apply(apis[side], callArgs));
                    if (typeof fixture.during === "function") {
                        // Handled here so a call that fails while `during` still waits is not an unhandled rejection;
                        // `await call` below still sees the failure.
                        call.catch(() => {});
                        try {
                            await fixture.during(clock, side);
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
                out[side] = {
                    requests: fake.requests.slice(from).map((r) => normalizeRequest(r, fake)),
                    result: error ? undefined : normalizeResult(result),
                    error,
                };
            }
            fake.clearRoutes();
            return out;
        }

        return {
            get own() {
                return apis.own;
            },
            get zca() {
                return apis.zca;
            },
            ctx,
            fake,
            standIn: resolved.standIn,
            run,
            close: () => fake.uninstall(),
        };
    } catch (e) {
        fake.uninstall();
        throw e;
    }
}
