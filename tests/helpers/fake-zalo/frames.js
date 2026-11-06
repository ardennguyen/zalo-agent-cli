/**
 * Frame encoding for the fake Zalo socket.
 *
 * A frame is a 4-byte header (version, cmd as uint16 LE, subCmd) followed by a
 * JSON body. The header is plaintext in both directions. Client frames carry
 * the bare JSON payload; server frames carry `{encrypt, data}` where `data` is
 * the JSON text of the reply (`encrypt: 0`, so no cipher key is needed and the
 * real zca-js listener and the real sync decoder read them unchanged).
 *
 * {@link serverFrameEncrypted} and {@link keyFrame} build the other three
 * kinds (`encrypt` 1, 2, 3) the way the server seals them, for the listener's
 * decoder and the differential harness (tests/helpers/wire-diff).
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { deflateSync, gzipSync } from "node:zlib";
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

/**
 * Seal a frame body the way the server does for `encrypt` 1, 2 and 3, or leave it as JSON text for 0.
 *
 *   0  the JSON text itself
 *   1  base64 of the zipped JSON
 *   2  URL-encoded base64 of AES-GCM over the zipped JSON
 *   3  URL-encoded base64 of AES-GCM over the JSON, not zipped
 *
 * The AES-GCM layout is the one the client reads: bytes 0-16 are the iv, bytes 16-32 the additional data, then
 * the ciphertext and its 16-byte tag. A 16-byte key is AES-128, a 32-byte key AES-256.
 *
 * @param {object} p
 * @param {object|string} p.body - the reply envelope (`{error_code, error_message, data}`), or JSON text as is
 * @param {0|1|2|3} [p.encrypt]
 * @param {string} [p.key] - base64 cipher key (the key frame's); required for 2 and 3
 * @param {"zlib"|"gzip"} [p.zip] - the compression of 1 and 2 (default zlib)
 * @param {Buffer} [p.iv] - 16 bytes; random by default
 * @param {Buffer} [p.aad] - 16 bytes; random by default
 * @returns {string} the frame's `data`
 */
export function sealFrameData({ body, encrypt = 0, key, zip = "zlib", iv, aad }) {
    const json = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    if (encrypt === 0) return json.toString("utf8");
    const zipped = zip === "gzip" ? gzipSync(json) : deflateSync(json);
    if (encrypt === 1) return zipped.toString("base64");
    if (encrypt !== 2 && encrypt !== 3) throw new Error(`fake-zalo: no such encrypt type: ${encrypt}`);
    if (!key) throw new Error("fake-zalo: encrypt 2 and 3 need the cipher key");
    const k = Buffer.from(key, "base64");
    if (k.length !== 16 && k.length !== 32)
        throw new Error(`fake-zalo: a cipher key is 16 or 32 bytes, not ${k.length}`);
    const ivBytes = iv ?? randomBytes(16);
    const aadBytes = aad ?? randomBytes(16);
    if (ivBytes.length !== 16 || aadBytes.length !== 16) throw new Error("fake-zalo: iv and aad are 16 bytes each");
    const cipher = createCipheriv(k.length === 16 ? "aes-128-gcm" : "aes-256-gcm", k, ivBytes);
    cipher.setAAD(aadBytes);
    const plain = encrypt === 2 ? zipped : json;
    const sealed = Buffer.concat([ivBytes, aadBytes, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return encodeURIComponent(sealed.toString("base64"));
}

/**
 * One server frame with its body sealed as {@link sealFrameData} does: the 4-byte header, then
 * `{...top, encrypt, data}` as JSON.
 *
 * @param {object} p
 * @param {number} p.cmd
 * @param {number} [p.sub]
 * @param {number} [p.version] - default 1
 * @param {object|string} p.body - see {@link sealFrameData}
 * @param {0|1|2|3} [p.encrypt]
 * @param {string} [p.key]
 * @param {"zlib"|"gzip"} [p.zip]
 * @param {object} [p.top] - more top-level fields (`key`, `error_code`)
 * @param {Buffer} [p.iv]
 * @param {Buffer} [p.aad]
 * @returns {Buffer}
 */
export function serverFrameEncrypted({ cmd, sub = 0, version = 1, body, encrypt = 0, key, zip, top = {}, iv, aad }) {
    const data = sealFrameData({ body, encrypt, key, zip, iv, aad });
    const json = Buffer.from(JSON.stringify({ ...top, encrypt, data }), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt8(version, 0);
    head.writeUInt16LE(cmd, 1);
    head.writeUInt8(sub, 3);
    return Buffer.concat([head, json]);
}

/** The queues a handshake lists when a test names none: none of each kind. */
export const EMPTY_AUTH_DATA = Object.freeze({ qCmds: [], ctrl_qCmds: [], bk_cmds: [] });

/**
 * The key frame (cmd 1, sub 1): the cipher key at the top level, and the handshake's queue lists in `data`,
 * sealed with that same key (encrypt 2), as the server sends it.
 *
 * @param {object} p
 * @param {string} p.key - base64, 16 or 32 bytes
 * @param {object} [p.authData] - the handshake's `data` (`{qCmds, ctrl_qCmds, bk_cmds}`); empty lists by default
 * @param {0|1|2|3} [p.encrypt] - default 2
 * @param {"zlib"|"gzip"} [p.zip]
 * @returns {Buffer}
 */
export function keyFrame({ key, authData = EMPTY_AUTH_DATA, encrypt = 2, zip }) {
    return serverFrameEncrypted({ cmd: 1, sub: 1, body: ok(authData), encrypt, key, zip, top: { key } });
}
