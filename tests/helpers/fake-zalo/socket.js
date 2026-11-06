/**
 * The fake Zalo chat socket: a real WebSocket server on 127.0.0.1, so the real
 * zca-js listener (and, later, our own socket layer) connects to it over a real
 * TCP connection, exactly as it would to Zalo.
 *
 * What it plays, all scripted by the test:
 *   - the handshake: a key frame (cmd 1, sub 1) right after the upgrade;
 *   - the ping: a client `2/1` is echoed at once, or not (`setPong(false)`),
 *     so a watchdog can be tested against a server that stops answering;
 *   - pushes: any frame, any time (`push`);
 *   - request/response: `respond(cmd, sub, fn)` answers a client frame;
 *   - ends: `kick` (the duplicate-session frame, cmd 3000), `drop` (a close
 *     with a code), `terminate` (an abrupt drop: the client sees 1006).
 *
 * Every frame this server sends is plain (`encrypt: 0`) unless the test asks
 * otherwise: `pushEncrypted` seals a body as encrypt 1, 2 or 3 under the
 * connection's cipher key, `authData` makes the key frame carry the handshake's
 * queue lists sealed under its own key, and `pushRaw`/`pushText` send bytes or a
 * text frame exactly as given. The header is the real 4 bytes. Every id in a
 * test is made up.
 */
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { decodeClientFrame, keyFrame, ok, serverFrame, serverFrameEncrypted } from "./frames.js";

/**
 * @typedef {object} FakeConnection
 * @property {number} id - 1 for the first connection, 2 for the next, ...
 * @property {object} ws - the server-side `ws` socket
 * @property {object} headers - the upgrade request's headers (lowercase names)
 * @property {string[]} rawHeaders - the same headers as sent: names in their own spelling and order, each name
 *   followed by its value
 * @property {string} url - the upgrade request's path and query
 * @property {number} openedAt - Date.now() at the upgrade
 * @property {boolean} closed
 * @property {number|null} closeCode - the code the connection closed with
 * @property {string} closeReason
 */

/**
 * @typedef {object} ReceivedFrame
 * @property {number} t - Date.now() when it arrived
 * @property {number} conn - the connection id
 * @property {number} cmd
 * @property {number} sub
 * @property {object|null} data - the client's parsed JSON body
 * @property {Buffer} raw - the frame's bytes as they came (not enumerable)
 */

/**
 * Start the fake socket.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.autoAuth] - send the key frame on every connection (default true)
 * @param {boolean} [opts.autoPong] - echo client pings `2/1` (default true)
 * @param {string} [opts.cipherKey] - the base64 key the key frame hands out (default 32 bytes of 9s)
 * @param {object|null} [opts.authData] - when set, the key frame carries this handshake data (`{qCmds, ctrl_qCmds,
 *   bk_cmds}`) sealed under its own key (encrypt 2); when null, the plain `ok({})` frame of before
 * @returns {Promise<{
 *   url: string,
 *   connections: FakeConnection[],
 *   received: ReceivedFrame[],
 *   cipherKey: string,
 *   push: (cmd: number, sub: number, body: object, o?: {conn?: FakeConnection, top?: object}) => boolean,
 *   pushEncrypted: (frame: {cmd: number, sub?: number, version?: number, body: object|string, encrypt?: number,
 *     zip?: "zlib"|"gzip", top?: object, key?: string}, o?: {conn?: FakeConnection}) => boolean,
 *   pushRaw: (bytes: Buffer, o?: {conn?: FakeConnection}) => boolean,
 *   pushText: (text: string, o?: {conn?: FakeConnection}) => boolean,
 *   setCipherKey: (key: string) => void,
 *   setAuthData: (data: object|null) => void,
 *   respond: (cmd: number, sub: number, fn: Function) => void,
 *   setPong: (on: boolean) => void,
 *   setAutoAuth: (on: boolean) => void,
 *   kick: (conn?: FakeConnection) => boolean,
 *   drop: (conn?: FakeConnection, code?: number, reason?: string) => void,
 *   terminate: (conn?: FakeConnection) => void,
 *   waitForConnection: (n?: number, timeoutMs?: number) => Promise<FakeConnection>,
 *   waitFor: (pred: (f: ReceivedFrame) => boolean, timeoutMs?: number) => Promise<ReceivedFrame>,
 *   waitForClose: (conn: FakeConnection, timeoutMs?: number) => Promise<FakeConnection>,
 *   framesOf: (cmd: number, sub?: number) => ReceivedFrame[],
 *   close: () => Promise<void>,
 * }>}
 */
export async function startFakeSocket({
    autoAuth = true,
    autoPong = true,
    cipherKey = Buffer.alloc(32, 9).toString("base64"),
    authData = null,
} = {}) {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(wss, "listening");
    const port = wss.address().port;

    /** @type {FakeConnection[]} */
    const connections = [];
    /** @type {ReceivedFrame[]} */
    const received = [];
    const responders = new Map();
    const watchers = new Set();
    const state = { pong: autoPong, auth: autoAuth, key: cipherKey, authData };

    const notify = () => {
        for (const w of [...watchers]) w();
    };
    const latest = () => connections.at(-1);

    /** Send bytes as one frame, binary unless told otherwise; false when the connection is gone. */
    function sendBytes(conn, bytes, binary = true) {
        if (!conn || conn.closed || conn.ws.readyState !== 1) return false;
        conn.ws.send(bytes, { binary });
        return true;
    }

    /** Send one plain server frame; false when the connection is gone. */
    function send(conn, cmd, sub, body, top) {
        return sendBytes(conn, serverFrame(cmd, sub, body, top));
    }

    wss.on("connection", (ws, req) => {
        const conn = {
            id: connections.length + 1,
            ws,
            headers: req.headers,
            rawHeaders: [...req.rawHeaders],
            url: req.url,
            openedAt: Date.now(),
            closed: false,
            closeCode: null,
            closeReason: "",
        };
        connections.push(conn);

        ws.on("message", (raw) => {
            let frame;
            try {
                frame = decodeClientFrame(Buffer.from(raw));
            } catch {
                return; // not one of ours: ignore, as a server would ignore noise
            }
            const entry = { t: Date.now(), conn: conn.id, cmd: frame.cmd, sub: frame.sub, data: frame.data };
            Object.defineProperty(entry, "raw", { value: Buffer.from(raw), enumerable: false });
            received.push(entry);
            if (frame.cmd === 2 && frame.sub === 1 && state.pong) {
                send(conn, 2, 1, ok({ eventId: frame.data?.eventId ?? 0 }));
            }
            const fn = responders.get(`${frame.cmd}/${frame.sub}`);
            if (fn) {
                const out = fn({ conn: conn.id, cmd: frame.cmd, sub: frame.sub, data: frame.data }, conn);
                // One body answers on the same cmd and sub; an array is a list
                // of {cmd, sub, body, delayMs} frames, for flows that answer in steps.
                if (Array.isArray(out)) {
                    for (const f of out) {
                        const emit = () => send(conn, f.cmd ?? frame.cmd, f.sub ?? frame.sub, f.body ?? {}, f.top);
                        if (f.delayMs) setTimeout(emit, f.delayMs);
                        else emit();
                    }
                } else if (out) {
                    send(conn, frame.cmd, frame.sub, out);
                }
            }
            notify();
        });

        ws.on("close", (code, reason) => {
            conn.closed = true;
            conn.closeCode = code;
            conn.closeReason = String(reason ?? "");
            notify();
        });

        if (state.auth) {
            if (state.authData) sendBytes(conn, keyFrame({ key: state.key, authData: state.authData }));
            else send(conn, 1, 1, ok({}), { key: state.key });
        }
        notify();
    });

    /** Resolve when `check()` returns a value, or reject after `timeoutMs`. */
    function until(check, what, timeoutMs) {
        return new Promise((resolve, reject) => {
            const hit = check();
            if (hit) return resolve(hit);
            const timer = setTimeout(() => {
                watchers.delete(poll);
                reject(new Error(`fake-zalo: timed out after ${timeoutMs} ms waiting for ${what}`));
            }, timeoutMs);
            const poll = () => {
                const got = check();
                if (!got) return;
                clearTimeout(timer);
                watchers.delete(poll);
                resolve(got);
            };
            watchers.add(poll);
        });
    }

    return {
        url: `ws://127.0.0.1:${port}/`,
        connections,
        received,
        get cipherKey() {
            return state.key;
        },
        push: (cmd, sub, body, { conn = latest(), top } = {}) => send(conn, cmd, sub, body, top),
        pushEncrypted: (frame, { conn = latest() } = {}) =>
            sendBytes(conn, serverFrameEncrypted({ key: state.key, ...frame })),
        pushRaw: (bytes, { conn = latest() } = {}) => sendBytes(conn, Buffer.from(bytes)),
        pushText: (text, { conn = latest() } = {}) => sendBytes(conn, String(text), false),
        setCipherKey: (key) => {
            state.key = key;
        },
        setAuthData: (data) => {
            state.authData = data;
        },
        respond: (cmd, sub, fn) => responders.set(`${cmd}/${sub}`, fn),
        setPong: (on) => {
            state.pong = on;
        },
        setAutoAuth: (on) => {
            state.auth = on;
        },
        kick: (conn = latest()) => send(conn, 3000, 0, ok({})),
        drop: (conn = latest(), code = 1001, reason = "") => conn?.ws.close(code, reason),
        terminate: (conn = latest()) => conn?.ws.terminate(),
        waitForConnection: (n = 1, timeoutMs = 3000) => until(() => connections[n - 1], `connection #${n}`, timeoutMs),
        waitFor: (pred, timeoutMs = 3000) => until(() => received.find(pred), "a matching client frame", timeoutMs),
        waitForClose: (conn, timeoutMs = 3000) =>
            until(() => conn.closed && conn, `connection #${conn.id} to close`, timeoutMs),
        framesOf: (cmd, sub) => received.filter((f) => f.cmd === cmd && (sub === undefined || f.sub === sub)),
        close: async () => {
            for (const c of connections) c.ws.terminate();
            await new Promise((resolve) => wss.close(resolve));
        },
    };
}
