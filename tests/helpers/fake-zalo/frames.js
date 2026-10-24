/**
 * Frame encoding for the fake Zalo socket.
 *
 * A frame is a 4-byte header (version, cmd as uint16 LE, subCmd) followed by a
 * JSON body. The header is plaintext in both directions. Client frames carry
 * the bare JSON payload; server frames carry `{encrypt, data}` where `data` is
 * the JSON text of the reply (`encrypt: 0`, so no cipher key is needed and the
 * real zca-js listener and the real sync decoder read them unchanged).
 */
import { serverFrame } from "../../unit/support/fake-socket.js";

export { serverFrame };

/**
 * Split a frame the client sent into its header and parsed body.
 *
 * @param {Buffer} buffer - one binary WebSocket message from the client
 * @returns {{version: number, cmd: number, sub: number, data: object|null}}
 *   `data` is null when the body is empty or is not JSON
 */
export function decodeClientFrame(buffer) {
    if (buffer.length < 4) throw new Error(`frame shorter than its header: ${buffer.length} bytes`);
    const version = buffer[0];
    const cmd = buffer.readUInt16LE(1);
    const sub = buffer[3];
    const text = buffer.subarray(4).toString("utf8");
    let data = null;
    if (text.length > 0) {
        try {
            data = JSON.parse(text);
        } catch {
            data = null;
        }
    }
    return { version, cmd, sub, data };
}

/**
 * The reply envelope Zalo uses for a successful command.
 *
 * @param {object} data - the reply's `data`
 * @returns {{error_code: number, error_message: string, data: object}}
 */
export function ok(data) {
    return { error_code: 0, error_message: "", data };
}

/**
 * Parse a frame the fake server sent, as a client sees it.
 *
 * @param {Buffer} buffer - one binary WebSocket message from the server
 * @returns {{version: number, cmd: number, sub: number, top: object, body: object|null}}
 *   `top` is the outer `{encrypt, data, ...}`; `body` is the parsed reply (null if `data` is not text)
 */
export function decodeServerFrame(buffer) {
    if (buffer.length < 4) throw new Error(`frame shorter than its header: ${buffer.length} bytes`);
    const top = JSON.parse(buffer.subarray(4).toString("utf8"));
    const body = typeof top.data === "string" ? JSON.parse(top.data) : null;
    return { version: buffer[0], cmd: buffer.readUInt16LE(1), sub: buffer[3], top, body };
}
