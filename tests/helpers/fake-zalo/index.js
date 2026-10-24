/**
 * Fake Zalo: an offline Zalo for tests, over real transports.
 *
 *   HTTP       globalThis.fetch is replaced (tests/unit/fake-zalo-session.js),
 *              so login, server info and every API call are answered locally,
 *              with each request recorded and its encrypted params decoded.
 *   WebSocket  a real server on 127.0.0.1 (./socket.js): the login hands out
 *              its URL, and the listener connects to it over TCP.
 *
 * A test that imports this reaches `src/core/credentials.js`, so it must import
 * `tests/helpers/sandbox.js` FIRST (see that file). Every id here is made up.
 *
 * ```js
 * const zalo = await startFakeZalo({ settings: { features: { socket: { ping_interval: 50 } } } });
 * installQueuePulls(zalo.sock);
 * const api = await zalo.login();
 * api.listener.start();
 * await zalo.sock.waitForConnection();
 * // ... drive the scenario ...
 * await zalo.stop();
 * ```
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { addAccount } from "../../../src/core/accounts.js";
import { CONFIG_DIR } from "../../../src/core/credentials.js";
import { clearSession, loginWithCredentials } from "../../../src/core/zalo-client.js";
import { FAKE, FAKE_CREDENTIALS, installFakeZalo } from "../../unit/fake-zalo-session.js";
import { decodeServerFrame } from "./frames.js";
import { startFakeSocket } from "./socket.js";

export { FAKE, FAKE_CREDENTIALS };
export { decodeClientFrame, decodeServerFrame, ok, serverFrame } from "./frames.js";
export {
    installQueuePulls,
    installTransferSync,
    queueStatus,
    controlBody,
    transferStatus,
    uploadBatch,
} from "./sync.js";

/**
 * Start the fake Zalo.
 *
 * @param {object} [opts]
 * @param {object} [opts.settings] - merged over the server settings (see installFakeZalo), e.g.
 *   `{features: {socket: {ping_interval: 50, retries: {...}, close_and_retry_codes: [...]}}}`
 * @param {{error_code: number, error_message?: string}} [opts.loginError] - make getLoginInfo fail
 * @param {string[]} [opts.omit] - service keys to leave out of the login's service map
 * @param {boolean} [opts.autoAuth] - the socket sends its key frame on connect (default true)
 * @param {boolean} [opts.autoPong] - the socket echoes client pings (default true)
 * @returns {Promise<{
 *   http: ReturnType<typeof installFakeZalo>,
 *   sock: Awaited<ReturnType<typeof startFakeSocket>>,
 *   login: () => Promise<object>,
 *   serverFrames: (listener: object) => {frames: object[], waitFor: Function},
 *   stop: () => Promise<void>,
 * }>}
 */
export async function startFakeZalo({ settings = {}, loginError = null, omit = [], autoAuth, autoPong } = {}) {
    const sock = await startFakeSocket({ autoAuth, autoPong });
    const http = installFakeZalo({ omit, wsUrls: [sock.url], settings, loginError });

    return {
        http,
        sock,

        /**
         * Log the fake account in through the real `loginWithCredentials`. Unlike
         * `loginFake()`, `listener.start()` is NOT disabled: it dials the fake socket.
         *
         * @returns {Promise<object>} the zca-js API
         */
        async login() {
            addAccount(FAKE.ownId, "Offline test account");
            mkdirSync(join(CONFIG_DIR, "accounts", FAKE.ownId), { recursive: true });
            const { api } = await loginWithCredentials(structuredClone(FAKE_CREDENTIALS));
            return api;
        },

        /**
         * Record the frames the fake server sends to this listener, decoded, from now on.
         * Call after the listener has connected (`listener.ws` exists).
         *
         * @param {object} listener - `api.listener`
         * @returns {{frames: object[], waitFor: (pred: (f: object) => boolean, timeoutMs?: number) => Promise<object>}}
         */
        serverFrames(listener) {
            const frames = [];
            const waiters = new Set();
            listener.ws.on("message", (raw) => {
                try {
                    frames.push({ t: Date.now(), ...decodeServerFrame(Buffer.from(raw)) });
                } catch {
                    return;
                }
                for (const w of [...waiters]) w();
            });
            return {
                frames,
                waitFor: (pred, timeoutMs = 3000) =>
                    new Promise((resolve, reject) => {
                        const hit = frames.find(pred);
                        if (hit) return resolve(hit);
                        const timer = setTimeout(() => {
                            waiters.delete(check);
                            reject(new Error(`fake-zalo: timed out after ${timeoutMs} ms waiting for a server frame`));
                        }, timeoutMs);
                        const check = () => {
                            const found = frames.find(pred);
                            if (!found) return;
                            clearTimeout(timer);
                            waiters.delete(check);
                            resolve(found);
                        };
                        waiters.add(check);
                    }),
            };
        },

        /** Stop the socket, restore `fetch` and clear the session. */
        async stop() {
            clearSession();
            http.uninstall();
            await sock.close();
        },
    };
}
