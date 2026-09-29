/**
 * A zca-js Listener stand-in that speaks the real socket framing, offline.
 *
 * zca-js reads a frame as a 4-byte header (version, cmd as uint16 LE, subCmd)
 * followed by a JSON body `{encrypt, data}`. `encrypt: 0` means `data` is plain
 * JSON text, which src/core/sync-v2/index.js `decodeFrame` accepts without a
 * cipher -- so a test drives the REAL raw tap and the REAL decoder with frames
 * it wrote itself, and never needs a key or a network.
 *
 * `sendWs(payload)` is recorded and answered by `respond(payload)`, the test's
 * fake server. Nothing here opens a socket; every id is made up.
 */
import { EventEmitter } from "node:events";

/**
 * One server frame, exactly as the socket delivers it.
 *
 * @param {number} cmd
 * @param {number} subCmd
 * @param {object} body - the decoded body, e.g. `{error_code: 0, data: {...}}`
 * @param {object} [top] - extra top-level fields (the AUTHEN frame carries `key`)
 * @returns {Buffer}
 */
export function serverFrame(cmd, subCmd, body, top = {}) {
    const json = Buffer.from(JSON.stringify({ ...top, encrypt: 0, data: JSON.stringify(body) }), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt8(1, 0);
    head.writeUInt16LE(cmd, 1);
    head.writeUInt8(subCmd, 3);
    return Buffer.concat([head, json]);
}

/** The raw `ws` object zca-js keeps on `listener.ws`: an EventEmitter of Buffers. */
class FakeWs extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
    }
}

/**
 * @param {object} [opts]
 * @param {(payload: object, listener: object) => (object|null|undefined)} [opts.respond] -
 *   the fake server: return a decoded body to answer a request on the same cmd
 *   and subCmd, or nothing to stay silent (the request then times out)
 * @returns {EventEmitter & {ws: FakeWs, cipherKey: string, sent: object[],
 *   sendWs: Function, reconnect: () => void, auth: (data: object) => void,
 *   push: (cmd: number, subCmd: number, body: object) => void}}
 */
export function fakeListener({ respond = () => null } = {}) {
    const listener = new EventEmitter();
    listener.ws = new FakeWs();
    listener.cipherKey = "unused-for-plain-frames";
    listener.sent = [];
    listener.respond = respond;

    listener.sendWs = (payload) => {
        listener.sent.push(structuredClone(payload));
        const ws = listener.ws;
        const body = listener.respond(payload, listener);
        if (body) queueMicrotask(() => ws.emit("message", serverFrame(payload.cmd, payload.subCmd, body)));
    };

    /** A socket drop and zca-js's retry: a NEW ws object, then `connected`. */
    listener.reconnect = () => {
        listener.ws.emit("close", 1006, "");
        listener.ws = new FakeWs();
        listener.emit("connected");
    };

    /** The AUTHEN handshake zca-js takes its cipher key from (cmd 1, sub 1). */
    listener.auth = (data) =>
        listener.ws.emit("message", serverFrame(1, 1, { error_code: 0, error_message: "", data }, { key: "k" }));

    /** Any server push on the current socket. */
    listener.push = (cmd, subCmd, body) => listener.ws.emit("message", serverFrame(cmd, subCmd, body));

    return listener;
}
