/**
 * Two listeners fed one script (agent/docs/zca-replace/design.md 3.2): one login, zca-js's listener dialing fake
 * socket A and ours dialing fake socket B, each with the official pulls `login.js` installs. `play(script)` sends
 * the same frames to both sockets in the same order, each after the previous frame's events have settled, and
 * returns what each listener emitted and sent and how it upgraded.
 *
 * A test that uses it must import tests/helpers/sandbox.js first. Every id here is fake.
 */
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { installOfficialPulls } from "../../../src/zalo/pulls.js";
import { installFakeZalo } from "../../unit/fake-zalo-session.js";
import { startFakeSocket } from "../fake-zalo/socket.js";
import { resolveCreateApi } from "./engines.js";
import { recordEvents } from "./events.js";
import { loginOnce } from "./session.js";
import { normalizeFrame, normalizeUpgrade } from "./normalize.js";

/**
 * One step of a script: a frame `{cmd, sub?, version?, encrypt?, zip?, top?, body}` sealed under the socket's key,
 * `{raw: Buffer}` sent as it is, or `{text: string}` sent as a text frame.
 *
 * @typedef {{cmd?: number, sub?: number, version?: number, encrypt?: 0|1|2|3, zip?: "zlib"|"gzip", top?: object,
 *   body?: object|string, raw?: Buffer, text?: string}} ScriptFrame
 */

/**
 * Send one script frame on a fake socket.
 *
 * @param {Awaited<ReturnType<typeof startFakeSocket>>} sock
 * @param {ScriptFrame} frame
 * @returns {boolean}
 */
function pushStep(sock, frame) {
    if (frame.raw) return sock.pushRaw(frame.raw);
    if (typeof frame.text === "string") return sock.pushText(frame.text);
    return sock.pushEncrypted(frame);
}

/**
 * Wait until a frame's effects have landed on both listeners, or `maxMs` has passed.
 *
 * With `from` (the count before a push) it first waits until the count has grown at all, for at most `growMs`: a
 * sealed frame is opened on the threadpool (crypto.subtle, inflate), so on a loaded machine its first event can
 * take longer than one quiet interval, and a count that has not moved yet does not mean the frame is done. A frame
 * both listeners ignore costs `growMs`. Then it waits until the count stayed the same for `quietMs` and
 * `balanced()` holds (both listeners emitted as many events), so one side that is still decoding is waited for.
 * An imbalance that lasts (a real difference) ends at `maxMs`, and the comparison reports it.
 *
 * Measured with `performance.now()`, so a test that froze `Date` does not stop it.
 *
 * @param {() => number} count - grows with every event and frame
 * @param {object} opts
 * @param {number} opts.quietMs
 * @param {number} opts.maxMs
 * @param {number|null} [opts.from] - the count before the push; null when nothing was pushed
 * @param {number} [opts.growMs] - how long to wait for the first change after a push
 * @param {() => boolean} [opts.balanced] - true when both sides have caught up with each other
 * @returns {Promise<void>}
 */
export async function settle(count, { quietMs, maxMs, from = null, growMs = 250, balanced = () => true }) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const started = performance.now();
    const until = started + maxMs;
    if (from !== null) {
        const growUntil = Math.min(until, started + growMs);
        while (count() === from && performance.now() < growUntil) await sleep(5);
    }
    let seen = count();
    while (performance.now() < until) {
        await sleep(quietMs);
        const now = count();
        if (now === seen && balanced()) return;
        seen = now;
    }
}

/**
 * Open two listeners on one login, each on its own fake socket.
 *
 * @param {object} [opts]
 * @param {object} [opts.socket] - options of `startFakeSocket` for both sockets (`cipherKey`, `authData`, ...)
 * @param {object} [opts.fake] - options of `installFakeZalo`
 * @param {object} [opts.zaloOptions]
 * @param {"own"|"zca"} [opts.ownEngine] - what plays the "own" side; "zca" for the harness's self-test
 * @param {"own"|"zca"} [opts.zcaEngine]
 * @param {number} [opts.quietMs] - how long nothing must happen for a frame's events to count as settled
 * @param {number} [opts.sealedQuietMs] - the same after a frame sealed as encrypt 1-3 (inflated or decrypted
 *   off the main thread, so its events can come later)
 * @param {number} [opts.growMs] - how long to wait, after a push, for anything to happen at all
 * @param {Function} [opts.createApi]
 * @returns {Promise<{
 *   zca: object, own: object, sockets: {zca: object, own: object},
 *   start: () => Promise<void>,
 *   play: (script: ScriptFrame[]) => Promise<object>,
 *   snapshot: () => object,
 *   settle: () => Promise<void>,
 *   close: () => Promise<void>,
 * }>}
 *   `zca`/`own` are the two session objects (their `listener` is what is compared). `start()` starts both
 *   listeners and waits for both connections and the handshake. `play` and `snapshot` return
 *   `{zca: events, own: events, zcaSent: frames, ownSent: frames, headers: {zca, own}}`: every event since the
 *   pair was opened, every frame each client sent, and each first connection's upgrade, normalized.
 */
export async function openListenerPair({
    socket = {},
    fake: fakeOptions = {},
    zaloOptions = {},
    ownEngine = "own",
    zcaEngine = "zca",
    quietMs = 25,
    sealedQuietMs = 100,
    growMs = 250,
    createApi,
} = {}) {
    const resolved = createApi ? { createApi } : await resolveCreateApi();
    const sockets = { zca: await startFakeSocket(socket), own: await startFakeSocket(socket) };
    const fake = installFakeZalo({ ...fakeOptions, wsUrls: [sockets.zca.url] });
    const apis = {};
    const recorders = {};
    const close = async () => {
        for (const side of ["zca", "own"]) {
            const listener = apis[side]?.listener;
            if (!listener) continue;
            // Teardown only: stopping a socket that is still opening reports an error nobody waits for.
            listener.on("error", () => {});
            recorders[side]?.stop();
            try {
                listener.stop();
            } catch {
                /* already stopped */
            }
        }
        fake.uninstall();
        await sockets.zca.close();
        await sockets.own.close();
    };

    try {
        const { ctx, serviceMap } = await loginOnce(zaloOptions);
        apis.zca = await resolved.createApi(ctx, serviceMap, [sockets.zca.url], { engine: zcaEngine });
        apis.own = await resolved.createApi(ctx, serviceMap, [sockets.own.url], { engine: ownEngine });
        for (const side of ["zca", "own"]) {
            installOfficialPulls(apis[side].listener);
            recorders[side] = recordEvents(apis[side].listener);
        }
    } catch (e) {
        await close();
        throw e;
    }

    const count = () =>
        recorders.zca.count() + recorders.own.count() + sockets.zca.received.length + sockets.own.received.length;
    const balanced = () => recorders.zca.count() === recorders.own.count();
    const wait = (opts = {}) => settle(count, { quietMs, maxMs: 2000, balanced, growMs, ...opts });
    const snapshot = () => ({
        zca: recorders.zca.events.slice(),
        own: recorders.own.events.slice(),
        zcaSent: sockets.zca.received.map(normalizeFrame),
        ownSent: sockets.own.received.map(normalizeFrame),
        headers: {
            zca: sockets.zca.connections[0] ? normalizeUpgrade(sockets.zca.connections[0]) : null,
            own: sockets.own.connections[0] ? normalizeUpgrade(sockets.own.connections[0]) : null,
        },
    });

    return {
        zca: apis.zca,
        own: apis.own,
        sockets,
        async start() {
            const connected = ["zca", "own"].map((side) => once(apis[side].listener, "connected"));
            apis.zca.listener.start();
            apis.own.listener.start();
            await Promise.all([...connected, sockets.zca.waitForConnection(), sockets.own.waitForConnection()]);
            await wait();
        },
        async play(script) {
            for (const frame of script) {
                const from = count();
                const sent = [pushStep(sockets.zca, frame), pushStep(sockets.own, frame)];
                if (!sent[0] || !sent[1]) throw new Error("wire-diff: a socket was not open to play a frame on");
                const sealed = !frame.raw && typeof frame.text !== "string" && frame.encrypt >= 1;
                await wait({ from, quietMs: sealed ? Math.max(quietMs, sealedQuietMs) : quietMs });
            }
            return snapshot();
        },
        snapshot,
        settle: () => wait(),
        close,
    };
}
