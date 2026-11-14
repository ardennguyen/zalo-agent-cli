/**
 * Our listener fed a script (agent/docs/zca-replace/design.md 3.2 and 3.3): one login, our listener dialing a fake
 * socket with the official pulls `login.js` installs. `play(script)` sends the frames in order, each after the
 * previous frame's events have settled, and returns what the listener emitted and sent and how it upgraded.
 *
 * Records keep the listener's side under `own` (`events.own`, `ownSent`, `headers.own`), as tests/unit/wire-*.test.js
 * read them.
 *
 * A test that uses it must import tests/helpers/sandbox.js first. Every id here is fake.
 */
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { createApi as engineCreateApi } from "../../../src/zalo/api.js";
import { installOfficialPulls } from "../../../src/zalo/pulls.js";
import { installFakeZalo } from "../../unit/fake-zalo-session.js";
import { startFakeSocket } from "../fake-zalo/socket.js";
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
 * Wait until a frame's effects have landed on the listener, or `maxMs` has passed.
 *
 * With `from` (the count before a push) it first waits until the count has grown at all, for at most `growMs`: a
 * sealed frame is opened on the threadpool (crypto.subtle, inflate), so on a loaded machine its first event can
 * take longer than one quiet interval, and a count that has not moved yet does not mean the frame is done. A frame
 * the listener ignores costs `growMs`. Then it waits until the count stayed the same for `quietMs` and `balanced()`
 * holds.
 *
 * Measured with `performance.now()`, so a test that froze `Date` does not stop it.
 *
 * @param {() => number} count - grows with every event and frame
 * @param {object} opts
 * @param {number} opts.quietMs
 * @param {number} opts.maxMs
 * @param {number|null} [opts.from] - the count before the push; null when nothing was pushed
 * @param {number} [opts.growMs] - how long to wait for the first change after a push
 * @param {() => boolean} [opts.balanced] - true when everything waited for has caught up
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
 * Open our listener on one login and its own fake socket.
 *
 * @param {object} [opts]
 * @param {object} [opts.socket] - options of `startFakeSocket` (`cipherKey`, `authData`, ...)
 * @param {object} [opts.fake] - options of `installFakeZalo`
 * @param {object} [opts.zaloOptions]
 * @param {number} [opts.quietMs] - how long nothing must happen for a frame's events to count as settled
 * @param {number} [opts.sealedQuietMs] - the same after a frame sealed as encrypt 1-3 (inflated or decrypted
 *   off the main thread, so its events can come later)
 * @param {number} [opts.growMs] - how long to wait, after a push, for anything to happen at all
 * @param {Function} [opts.createApi] - instead of the engine's (src/zalo/api.js)
 * @returns {Promise<{
 *   own: object, socket: object,
 *   start: () => Promise<void>,
 *   play: (script: ScriptFrame[]) => Promise<object>,
 *   snapshot: () => object,
 *   settle: () => Promise<void>,
 *   close: () => Promise<void>,
 * }>}
 *   `own` is the session object (its `listener` is what is recorded). `start()` starts the listener and waits for
 *   the connection and the handshake. `play` and `snapshot` return `{own: events, ownSent: frames, headers: {own}}`:
 *   every event since the listener was opened, every frame it sent, and its first connection's upgrade,
 *   normalized.
 */
export async function openListenerWire({
    socket = {},
    fake: fakeOptions = {},
    zaloOptions = {},
    quietMs = 25,
    sealedQuietMs = 100,
    growMs = 250,
    createApi = engineCreateApi,
} = {}) {
    const sock = await startFakeSocket(socket);
    const fake = installFakeZalo({ ...fakeOptions, wsUrls: [sock.url] });
    let api = null;
    let recorder = null;
    const close = async () => {
        const listener = api?.listener;
        if (listener) {
            // Teardown only: stopping a socket that is still opening reports an error nobody waits for.
            listener.on("error", () => {});
            recorder?.stop();
            try {
                listener.stop();
            } catch {
                /* already stopped */
            }
        }
        fake.uninstall();
        await sock.close();
    };

    try {
        const { ctx, serviceMap } = await loginOnce(zaloOptions);
        api = await createApi(ctx, serviceMap, [sock.url], {});
        installOfficialPulls(api.listener);
        recorder = recordEvents(api.listener);
    } catch (e) {
        await close();
        throw e;
    }

    const count = () => recorder.count() + sock.received.length;
    const wait = (opts = {}) => settle(count, { quietMs, maxMs: 2000, growMs, ...opts });
    const snapshot = () => ({
        own: recorder.events.slice(),
        ownSent: sock.received.map(normalizeFrame),
        headers: { own: sock.connections[0] ? normalizeUpgrade(sock.connections[0]) : null },
    });

    return {
        own: api,
        socket: sock,
        async start() {
            const connected = once(api.listener, "connected");
            api.listener.start();
            await Promise.all([connected, sock.waitForConnection()]);
            await wait();
        },
        async play(script) {
            for (const frame of script) {
                const from = count();
                if (!pushStep(sock, frame)) throw new Error("wire-diff: the socket was not open to play a frame on");
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
