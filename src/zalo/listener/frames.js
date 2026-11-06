/**
 * Chat socket frames: the 4-byte header, the outgoing encoder, and the payload decoder.
 *
 * Wire format (both directions): `[version u8][cmd u16 little-endian][subCmd u8]` followed by UTF-8 JSON.
 *
 * An inbound frame's JSON is an envelope, `{encrypt, data, key?, error_code?}`. `data` is a string whose encoding
 * `encrypt` names:
 *
 *   0  the JSON text itself
 *   1  base64 of a zlib- or gzip-compressed JSON text
 *   2  URI-encoded base64 of `iv (16 bytes) | additional data (16 bytes) | AES-GCM ciphertext | tag (16 bytes)`,
 *      whose plaintext is compressed JSON; the key is the session cipher key (base64, 16 or 32 bytes, as Web's
 *      WebCrypto import accepts any AES size)
 *   3  as 2, but the plaintext is the JSON text, not compressed
 *
 * The session cipher key arrives in the cmd 1 frame's top-level `key`, and that frame's own `data` is encrypted
 * under it. An outbound frame carries the JSON of `data` in the clear, or nothing after the header when there is no
 * data object.
 *
 * Ids: the decoder can quote bare integer ids by key before parsing (`idKeys`, see ../kernel/json-ids.js), the way
 * Web's chat and control handlers do. {@link idKeysForCmd} names the list for a cmd.
 *
 * Pure functions: no socket, no state, no output.
 */
import crypto from "node:crypto";
import zlib from "node:zlib";
import { CHAT_ID_KEYS, CTRL_ID_KEYS, preParse } from "../kernel/json-ids.js";

/** Bytes before the JSON body of every frame. */
export const HEADER_BYTES = 4;

/** The `encrypt` values of an inbound envelope. */
export const ENCRYPT = Object.freeze({ PLAIN: 0, ZIPPED: 1, SEALED_ZIPPED: 2, SEALED: 3 });

/** The handshake answer: carries the session cipher key and the queue lists. */
export const CMD_AUTH = 1;

/** Ping (subCmd 1) and its echo. */
export const CMD_PING = 2;

/**
 * Cmds the Web chat handler owns: pushes (501, 521, 502, 522, 504, 524, 570, 534), the Signal pushes it routes
 * through the same path (551, 552, 535, ...), the cloud pushes (620, 621, 623), 530, 533, the kick (3000), and the
 * two chat queue answers this client pulls (510, 511). Web adds the rest of its chat queues at run time from the
 * handshake's `qCmds`; {@link idKeysForCmd} does the same when given the handshake data.
 */
export const CHAT_CMDS = Object.freeze([
    501, 521, 502, 522, 504, 524, 570, 534, 551, 552, 535, 543, 544, 548, 549, 561, 580, 581, 582, 559, 546, 550, 553,
    554, 620, 621, 623, 530, 533, 3000, 510, 511,
]);

/**
 * Cmds the Web control handler owns: actions (602), reactions (612 push, 613 clear, 610 and 611 pages), controls (601
 * push, 603 page) and 600. Web adds its control queues at run time from the handshake's `ctrl_qCmds`.
 */
export const CTRL_CMDS = Object.freeze([602, 612, 613, 610, 611, 601, 603, 600]);

/** The cmds listed in a handshake queue list (`[{cmd, subCmd}]`), ignoring malformed entries. */
function queueCmds(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((q) => q && Number.isInteger(q.cmd)).map((q) => q.cmd);
}

/**
 * The id key list Web parses a cmd's payload with: the chat list for chat cmds, the control list for control cmds,
 * and null (a plain parse) for anything else, the handshake and the ping included.
 *
 * @param {number} cmd
 * @param {{qCmds?: Array<{cmd: number}>, ctrl_qCmds?: Array<{cmd: number}>}|null} [auth] - the decoded handshake
 *   data; its queue lists join the chat and control families, as they do in Web
 * @returns {readonly string[]|null}
 */
export function idKeysForCmd(cmd, auth = null) {
    if (CHAT_CMDS.includes(cmd) || queueCmds(auth?.qCmds).includes(cmd)) return CHAT_ID_KEYS;
    if (CTRL_CMDS.includes(cmd) || queueCmds(auth?.ctrl_qCmds).includes(cmd)) return CTRL_ID_KEYS;
    return null;
}

/**
 * Read a frame's header.
 *
 * @param {Uint8Array} buf - the whole frame
 * @returns {{version: number, cmd: number, subCmd: number}|null} null when the buffer is shorter than the header
 */
export function readHeader(buf) {
    if (!(buf instanceof Uint8Array) || buf.length < HEADER_BYTES) return null;
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.length);
    return { version: b[0], cmd: b.readUInt16LE(1), subCmd: b[3] };
}

/**
 * Read a whole inbound frame: the header, then the JSON envelope as it is (the envelope's `data` stays encoded).
 *
 * @param {Uint8Array} buf
 * @returns {{version: number, cmd: number, subCmd: number, envelope: object}|null} null for a buffer shorter than
 *   the header, a body that is not JSON, or a body that is not a JSON object
 */
export function parseFrame(buf) {
    const head = readHeader(buf);
    if (!head) return null;
    let envelope;
    try {
        envelope = JSON.parse(Buffer.from(buf.buffer, buf.byteOffset, buf.length).subarray(HEADER_BYTES).toString());
    } catch {
        return null;
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
    return { ...head, envelope };
}

const isUint = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;

/**
 * Build an outbound frame: the header, then the UTF-8 JSON of `data` when `data` is a plain object, and nothing
 * more otherwise (Web's `_send`).
 *
 * @param {{version?: number, cmd: number, subCmd: number, data?: object}} payload - `version` defaults to 1;
 *   `subCmd` has no default, because a wrong one is silently ignored by the server
 * @returns {Buffer}
 * @throws {TypeError} when `version` or `subCmd` is not an integer 0-255, or `cmd` not an integer 0-65535
 */
export function encodeFrame({ version = 1, cmd, subCmd, data } = {}) {
    if (!isUint(version, 0xff)) throw new TypeError("frame version must be an integer 0-255");
    if (!isUint(cmd, 0xffff)) throw new TypeError("frame cmd must be an integer 0-65535");
    if (!isUint(subCmd, 0xff)) throw new TypeError("frame subCmd must be an integer 0-255");
    const head = Buffer.alloc(HEADER_BYTES);
    head[0] = version;
    head.writeUInt16LE(cmd, 1);
    head[3] = subCmd;
    const plain = data !== null && typeof data === "object" && !Array.isArray(data);
    return plain ? Buffer.concat([head, Buffer.from(JSON.stringify(data), "utf8")]) : head;
}

/** AES-GCM by key size, as WebCrypto picks it from the raw key's length. */
const GCM_BY_KEY_BYTES = new Map([
    [16, "aes-128-gcm"],
    [24, "aes-192-gcm"],
    [32, "aes-256-gcm"],
]);

/** iv (16) + additional data (16) + tag (16): a sealed payload shorter than this holds nothing. */
const SEALED_MIN_BYTES = 48;

/** Open a sealed payload: `iv | aad | ciphertext | tag` under the base64 session key. */
function openSealed(raw, cipherKey) {
    if (!cipherKey || raw.length < SEALED_MIN_BYTES) throw new Error("missing cipher key or short frame");
    const key = Buffer.from(String(cipherKey), "base64");
    const algorithm = GCM_BY_KEY_BYTES.get(key.length);
    if (!algorithm) throw new Error(`cipher key has ${key.length} bytes; expected 16, 24 or 32`);
    const tagAt = raw.length - 16;
    const decipher = crypto.createDecipheriv(algorithm, key, raw.subarray(0, 16));
    decipher.setAAD(raw.subarray(16, 32));
    decipher.setAuthTag(raw.subarray(tagAt));
    return Buffer.concat([decipher.update(raw.subarray(32, tagAt)), decipher.final()]);
}

/** Inflate zlib or gzip (the format is read from the header), with raw deflate as the last resort. */
function inflate(bytes) {
    try {
        return zlib.unzipSync(bytes);
    } catch {
        return zlib.inflateRawSync(bytes);
    }
}

/**
 * Decode an inbound envelope's `data` into the payload object.
 *
 * Same call shape as the decoder in src/core/sync-v2/index.js, which re-exports this one: `decodeFrame(parsed,
 * cipherKey)` parses plainly; pass `{idKeys}` to keep the listed ids lossless (Web's per-handler preParse).
 *
 * @param {{encrypt: number, data: string}} parsed - the frame's JSON envelope
 * @param {string|null|undefined} cipherKey - the session key (base64); needed for encrypt 2 and 3 only
 * @param {{idKeys?: readonly string[]|null}} [opts]
 * @returns {any} the decoded payload, usually `{error_code, data}`
 * @throws {Error} on an unknown encrypt type, a `data` that is not a string, a missing key or a payload shorter than
 *   48 bytes for encrypt 2 and 3, a wrong key (the GCM tag does not verify), bad compression, or text that is not
 *   JSON
 */
export function decodeFrame(parsed, cipherKey, opts = {}) {
    const encrypt = parsed?.encrypt;
    if (!Object.values(ENCRYPT).includes(encrypt)) throw new Error(`unsupported frame encrypt type ${encrypt}`);
    if (typeof parsed.data !== "string") throw new Error(`frame data must be a string, got ${typeof parsed.data}`);
    let text;
    if (encrypt === ENCRYPT.PLAIN) {
        text = parsed.data;
    } else {
        const raw = Buffer.from(encrypt === ENCRYPT.ZIPPED ? parsed.data : decodeURIComponent(parsed.data), "base64");
        const plain = encrypt === ENCRYPT.ZIPPED ? raw : openSealed(raw, cipherKey);
        text = (encrypt === ENCRYPT.SEALED ? plain : inflate(plain)).toString("utf8");
    }
    const keys = opts?.idKeys;
    return JSON.parse(keys ? preParse(text, keys) : text);
}

/**
 * Read the handshake (cmd 1) envelope: take its cipher key, and decode its `data` under that same key.
 *
 * One deliberate leniency against Web: Web's `_processAuthData` requires the decoded payload's `error_code` to be
 * exactly 0 (else INVALID_AUTH_DATA, 5007). Here a payload that carries no `error_code` at all is accepted, and only
 * a present, non-zero one refuses the session. zca-js never decoded this payload, so a key frame without the field
 * has always opened a session for this client, and nothing reads the field but this check; refusing it would end
 * sessions that work today over a field no consumer uses. An explicit refusal (any non-zero code) is still final.
 * tests/unit/listener-frames.test.js pins both halves.
 *
 * @param {{key?: string, encrypt?: number, data?: string}} envelope
 * @returns {{key: string, auth: object|null}} `auth` is the decoded payload's `data` (`{qCmds, ctrl_qCmds,
 *   bk_cmds}`), or null when the envelope carries no data
 * @throws {Error} when the envelope has no key, or its data does not decode, or the decoded payload reports a
 *   non-zero `error_code` (Web refuses the session in all three cases)
 */
export function readAuthFrame(envelope) {
    const key = envelope?.key;
    if (typeof key !== "string" || key.length === 0) throw new Error("handshake frame carries no cipher key");
    if (typeof envelope.data !== "string" || envelope.data.length === 0) return { key, auth: null };
    const payload = decodeFrame(envelope, key);
    // Absent is accepted on purpose (see above); a present code must be 0, as in Web.
    if (payload?.error_code !== undefined && payload.error_code !== 0) {
        throw new Error(`handshake refused with error_code ${payload.error_code}`);
    }
    return { key, auth: payload?.data && typeof payload.data === "object" ? payload.data : null };
}
