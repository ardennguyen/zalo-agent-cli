/**
 * The login cipher: what `getLoginInfo` and `getServerInfo` need before any session key exists.
 *
 * Wire facts (Zalo Web's `createZcid`, `encryptParam`, `decryptResp` and `getSignKey`; spec-kernel 11.2):
 *
 * - `zcid` = uppercase hex of AES-256-CBC (zero IV, PKCS#7) of `"<type>,<imei>,<firstLaunchTime>"`, keyed by the
 *   UTF-8 bytes of a fixed 32-character string (32 bytes, so AES-256; it is not hex-decoded).
 * - `zcid_ext` = 6 to 12 random lowercase hex characters.
 * - the answer key `enk` (32 characters): with `n` = uppercase MD5 hex of `zcid_ext`, take the characters at even
 *   positions of `n` (first 8), the even positions of `zcid` (first 12), and the odd positions of `zcid` in reverse
 *   order (first 12).
 * - the login data is sealed as base64 of AES-256-CBC (zero IV, PKCS#7) keyed by the UTF-8 bytes of `enk`;
 *   `enc_ver` is `"v2"`. The answer's `data` is sealed the same way (sometimes URL-escaped).
 * - `signkey` = MD5 hex of `"zsecure" + <kind> + <every param value, ordered by param name>`.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";

/** The fixed key `zcid` is sealed with (Zalo Web's param cipher key). */
const ZCID_KEY = "3FC4F0D2AB50057BCE0D90D9187A22B1";

/** `enc_ver` of every encrypted login call. */
export const ENC_VER = "v2";

const ZERO_IV = Buffer.alloc(16);

/** AES-CBC with a UTF-8 key of 16, 24 or 32 bytes. */
function algorithmFor(keyBytes) {
    if (keyBytes.length === 16) return "aes-128-cbc";
    if (keyBytes.length === 24) return "aes-192-cbc";
    if (keyBytes.length === 32) return "aes-256-cbc";
    throw new Error(`a login cipher key must be 16, 24 or 32 bytes, not ${keyBytes.length}`);
}

/** @param {string} key @param {string} text @returns {Buffer} */
function sealUtf8Key(key, text) {
    const k = Buffer.from(key, "utf8");
    const c = createCipheriv(algorithmFor(k), k, ZERO_IV);
    return Buffer.concat([c.update(text, "utf8"), c.final()]);
}

/** MD5 in lowercase hex. */
const md5 = (text) => createHash("md5").update(text, "utf8").digest("hex");

/**
 * The `zcid` of a login.
 *
 * @param {number|string} type - the API type (30 for Web)
 * @param {string} imei
 * @param {number} firstLaunchTime - milliseconds
 * @returns {string} uppercase hex
 */
export function makeZcid(type, imei, firstLaunchTime) {
    if (!type || !imei || !firstLaunchTime) throw new Error("makeZcid: type, imei and firstLaunchTime are needed");
    return sealUtf8Key(ZCID_KEY, `${type},${imei},${firstLaunchTime}`).toString("hex").toUpperCase();
}

/**
 * A fresh `zcid_ext`: 6 to 12 random lowercase hex characters.
 *
 * @returns {string}
 */
export function makeZcidExt() {
    const length = randomInt(6, 13);
    return randomBytes(Math.ceil(length / 2))
        .toString("hex")
        .slice(0, length);
}

/** The characters of `s` at even (0, 2, ...) and odd positions. */
function evenOdd(s) {
    const even = [];
    const odd = [];
    [...s].forEach((ch, i) => (i % 2 === 0 ? even : odd).push(ch));
    return { even, odd };
}

/**
 * The key the `getLoginInfo` answer is sealed with.
 *
 * @param {string} zcid
 * @param {string} zcidExt
 * @returns {string} 32 characters
 */
export function deriveEnk(zcid, zcidExt) {
    if (!zcid || !zcidExt) throw new Error("deriveEnk: zcid and zcid_ext are needed");
    const fromExt = evenOdd(md5(zcidExt).toUpperCase()).even;
    const fromZcid = evenOdd(zcid);
    return (
        fromExt.slice(0, 8).join("") +
        fromZcid.even.slice(0, 12).join("") +
        fromZcid.odd.reverse().slice(0, 12).join("")
    );
}

/**
 * Seal the login data with `enk`.
 *
 * @param {string} enk
 * @param {object|string} data - an object is JSON-encoded
 * @returns {string} base64
 */
export function sealLogin(enk, data) {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    return sealUtf8Key(enk, text).toString("base64");
}

/**
 * Open a `getLoginInfo` answer's `data`.
 *
 * @param {string} enk
 * @param {string} data - base64, URL-escaped or not
 * @returns {object|string|null} the parsed JSON; the text when it is not JSON; null when it does not open
 */
export function openLogin(enk, data) {
    let text;
    try {
        const k = Buffer.from(enk, "utf8");
        const d = createDecipheriv(algorithmFor(k), k, ZERO_IV);
        const raw = Buffer.from(decodeURIComponent(String(data)), "base64");
        text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([d.update(raw), d.final()]));
    } catch {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * The `signkey` of a login-host call.
 *
 * @param {"getserverinfo"|"getlogininfo"} kind
 * @param {Record<string, unknown>} params - every field sent at that point (`signkey` itself excluded)
 * @returns {string} MD5 lowercase hex
 */
export function signKey(kind, params) {
    let text = `zsecure${kind}`;
    for (const name of Object.keys(params).sort()) text += params[name];
    return md5(text);
}

/**
 * Everything one encrypted `getLoginInfo` needs.
 *
 * @param {object} p
 * @param {number} p.type
 * @param {string} p.imei
 * @param {number} p.firstLaunchTime
 * @param {string} [p.zcidExt] - injected by tests; random otherwise
 * @returns {{zcid: string, zcidExt: string, enk: string, params: () => {zcid: string, zcid_ext: string,
 *   enc_ver: string}, seal: (data: object|string) => string}}
 */
export function createLoginEncryptor({ type, imei, firstLaunchTime, zcidExt = makeZcidExt() }) {
    const zcid = makeZcid(type, imei, firstLaunchTime);
    const enk = deriveEnk(zcid, zcidExt);
    return {
        zcid,
        zcidExt,
        enk,
        params: () => ({ zcid, zcid_ext: zcidExt, enc_ver: ENC_VER }),
        seal: (data) => sealLogin(enk, data),
    };
}
