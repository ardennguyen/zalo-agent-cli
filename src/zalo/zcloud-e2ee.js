/**
 * zCloud blobs and the cloud key: how a cloud item is opened, the parts of it that are well defined (plan items
 * ZP-10 and Z9, decision D8). Nothing here was seen working live.
 *
 * OPENING AN ITEM (ZP-10). A client asks `downloadurls/pc/v1` for the item's signed URL (zcloud.js
 * `fetchCloudDownloadUrl`), then builds the address to fetch:
 *
 *   <downloadUrl>?zcloudurl=true                                    an item of a cloud-type conversation
 *   <downloadUrl>?zcloudurl=true&pcloudsession=<encryptKey>&algoversion=<algoVersion>   any other item
 *
 * The address is cut at `pcloudsession` and what follows stays local: the request that is sent
 * is `<downloadUrl>?zcloudurl=true&` (or `...=true` with no key), with one header, `cloud-viewer-key`, the
 * account's viewer key, and no cookie. The answer is the blob, encrypted when the item has a key; it is opened locally
 * with the key unwrapped from `pcloudsession`. An earlier try that fetched the bare `<downloadUrl>` with the viewer key
 * answered 404 (`docs/agent-notes.md`); the `zcloudurl=true` query is the one difference found. An item of My Cloud
 * (the chat with oneself) is first fetched by its chat message's own media URL, and
 * by the cloud URL only when that fails (paid plans only).
 *
 * THE KEY (Z9, D8). An item's `encryptInfo.encryptKey` (and the file-name metadata's
 * `mediaInfo.mediaExtInfo.encryptInfo.encryptKey`) is an AES key wrapped with the account's cloud RSA key: RSA-OAEP
 * with SHA-256, 2048 bits, the private half kept as PKCS#8. Unwrapped, it is the AES key (32 bytes), the IV (12) and,
 * for a whole-file ("linear", `algoversion` 1) blob or the metadata, the GCM tag (16), packed in that order. The data is
 * AES-256-GCM. A block-by-block blob (`algoversion` 2) is AES-256-CTR in 4096-byte blocks: the packed key is the AES key
 * and a 16-byte IV (no tag), and every block starts the counter afresh from that IV.
 *
 * Where the private key comes from is the part this client cannot do: a client asks
 * `{zcloud}/personalcloud_key/req_cloud_key` (`{device_name, session_id}`), the phone shows a prompt, and on approval
 * the key arrives on the chat socket (a `personal_cloud` control) as a Signal message addressed to the account's own
 * end-to-end session, opened with the device's registered Signal identity. Zalo does not derive
 * the key from a PIN: no PIN, passcode or Google step for zCloud exists. So the key is something a person
 * hands this process at run time (`cloud get --key-stdin`), never something it stores: nothing here writes a key to
 * disk or to a log, and a key object lives only as long as the call that was given it.
 */
import { createDecipheriv, createPrivateKey, constants, privateDecrypt } from "node:crypto";

/** The query key that marks a zCloud download address (`zcloudurl`), and its value. */
export const ZCLOUD_URL_PARAM = "zcloudurl";
/** The query keys of the wrapped key and its algorithm version, read locally, never sent. */
export const PCLOUD_SESSION_PARAM = "pcloudsession";
export const ALGO_VERSION_PARAM = "algoversion";
/** `algoversion` values: one GCM pass over the whole blob, or block by block. */
export const ALGO_LINEAR = "1";
export const ALGO_BLOCK = "2";

/** AES key and GCM IV lengths of the packed key (`decryptCloudInfo`'s defaults). */
const KEY_LENGTH = 32;
const GCM_IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Raised for a key that does not open, a blob that does not decrypt, or a version not built. */
export class CloudKeyError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "CloudKeyError";
    }
}

/**
 * The request sent for one cloud item.
 *
 * @param {object} args
 * @param {string} args.downloadUrl - the signed URL from `downloadurls/pc/v1`
 * @param {{encryptKey?: string, algoVersion?: string|number}|null} [args.encryptInfo] - the item's top-level one
 * @param {string} args.viewerKey - the account's zCloud viewer key
 * @param {boolean} [args.cloudConversation=false] - an item of a cloud-type conversation: no key, never encrypted
 * @returns {{url: string, headers: Record<string, string>, encrypted: boolean, wrappedKey: string|null,
 *   algoVersion: string|null}}
 */
export function cloudBlobRequest({ downloadUrl, encryptInfo = null, viewerKey, cloudConversation = false }) {
    if (!downloadUrl) throw new CloudKeyError("no download URL for the item (NOT_FOUND_DOWNLOAD_URL)");
    if (!viewerKey) throw new CloudKeyError("no zCloud viewer key (NOT_FOUND_DOWNLOAD_HEADER)");
    const base = `${downloadUrl}?${ZCLOUD_URL_PARAM}=true`;
    const wrappedKey = !cloudConversation && encryptInfo?.encryptKey ? String(encryptInfo.encryptKey) : null;
    const algo = encryptInfo?.algoVersion;
    return {
        // The full address ends `&pcloudsession=…` and is cut there, so the wire keeps the `&`.
        url: wrappedKey ? `${base}&` : base,
        headers: { "cloud-viewer-key": viewerKey },
        encrypted: Boolean(wrappedKey),
        wrappedKey,
        algoVersion: wrappedKey && algo !== undefined && algo !== null && algo !== "" ? String(algo) : null,
    };
}

/**
 * The account's cloud RSA private key, from its base64 PKCS#8 form (`pcloudKey`). Held in memory only.
 *
 * @param {string} pkcs8Base64 - surrounding whitespace and PEM armor are tolerated
 * @returns {import("node:crypto").KeyObject}
 * @throws {CloudKeyError} for anything that is not an RSA private key
 */
export function importCloudPrivateKey(pkcs8Base64) {
    const text = String(pkcs8Base64 ?? "")
        .replace(/-----(BEGIN|END) [A-Z ]+-----/g, "")
        .replace(/\s+/g, "");
    if (!text) throw new CloudKeyError("no cloud key was given");
    const der = Buffer.from(text, "base64");
    // The phone hands the key over as PKCS#1 (an RSAPrivateKey); a key typed or piped in may be PKCS#8. As a last resort,
    // rebuild PKCS#8 around the body that follows the 7-byte RSAPrivateKey header (sequence + version), which is how the
    // key is re-wrapped when the header is not a well-formed one.
    const attempts = [
        () => createPrivateKey({ key: der, format: "der", type: "pkcs8" }),
        () => createPrivateKey({ key: der, format: "der", type: "pkcs1" }),
        () => createPrivateKey({ key: rsaBodyToPkcs8(der.subarray(7)), format: "der", type: "pkcs8" }),
    ];
    let key = null;
    for (const attempt of attempts) {
        try {
            key = attempt();
            break;
        } catch {
            /* next shape */
        }
    }
    if (!key) throw new CloudKeyError("the cloud key is not an RSA private key (PKCS#8 or PKCS#1) in base64");
    if (key.asymmetricKeyType !== "rsa") throw new CloudKeyError("the cloud key is not an RSA key");
    return key;
}

/** A DER length: short form below 128, else 0x8n followed by n big-endian bytes. */
function derLength(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** DER tag + length + content. */
function derTlv(tag, content) {
    return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/**
 * Wrap the fields of an RSAPrivateKey that follow its version (modulus onward) as PKCS#8:
 * SEQUENCE { INTEGER 0, AlgorithmIdentifier rsaEncryption NULL, OCTET STRING { SEQUENCE { INTEGER 0, …body } } }.
 *
 * @param {Buffer} body
 * @returns {Buffer}
 */
function rsaBodyToPkcs8(body) {
    const version = Buffer.from([0x02, 0x01, 0x00]);
    const rsaAlgorithm = Buffer.from([
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
    ]);
    const rsaPrivateKey = derTlv(0x30, Buffer.concat([version, body]));
    return derTlv(0x30, Buffer.concat([version, rsaAlgorithm, derTlv(0x04, rsaPrivateKey)]));
}

/**
 * Unwrap an item's key: RSA-OAEP with SHA-256, with `pcloudKey`.
 *
 * @param {string} wrappedBase64 - `encryptKey`
 * @param {import("node:crypto").KeyObject} privateKey
 * @returns {Buffer} the packed AES key, IV and (linear) tag
 * @throws {CloudKeyError} when this key does not open it (another account's key, or a rotated one)
 */
export function unwrapCloudKey(wrappedBase64, privateKey) {
    try {
        return privateDecrypt(
            { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
            Buffer.from(String(wrappedBase64), "base64"),
        );
    } catch {
        throw new CloudKeyError("the cloud key does not open this item's key (another account's, or rotated)");
    }
}

/**
 * Split a packed key into the AES key, the IV and the tag that follows them.
 *
 * @param {Buffer} packed
 * @param {{keyLength?: number, ivLength?: number}} [lengths]
 * @returns {{key: Buffer, iv: Buffer, tag: Buffer}}
 */
export function splitPackedKey(packed, { keyLength = KEY_LENGTH, ivLength = GCM_IV_LENGTH } = {}) {
    return {
        key: packed.subarray(0, keyLength),
        iv: packed.subarray(keyLength, keyLength + ivLength),
        tag: packed.subarray(keyLength + ivLength),
    };
}

/** Block size and IV length of the block-by-block version (`algoversion` 2). */
export const BLOCK_SIZE = 4096;
export const CTR_IV_LENGTH = 16;

/**
 * AES-256-CTR, block by block: every 4096-byte block (and the shorter last one) is decrypted on its own, each starting
 * the counter afresh from the same IV. The packed key is the AES key and the 16-byte IV, with no tag.
 *
 * @param {Buffer} packed
 * @param {Buffer|Uint8Array} data
 * @returns {Buffer}
 */
export function openBlocks(packed, data) {
    const { key, iv } = splitPackedKey(packed, { ivLength: CTR_IV_LENGTH });
    if (packed.length !== KEY_LENGTH + CTR_IV_LENGTH) {
        throw new CloudKeyError("the item's key is not a block-by-block key (AES key and 16-byte IV)");
    }
    const input = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const out = Buffer.allocUnsafe(input.length);
    for (let at = 0; at < input.length; at += BLOCK_SIZE) {
        const block = input.subarray(at, Math.min(at + BLOCK_SIZE, input.length));
        const d = createDecipheriv("aes-256-ctr", key, iv);
        Buffer.concat([d.update(block), d.final()]).copy(out, at);
    }
    return out;
}

/** AES-256-GCM over `data` with a packed key. */
function openGcm(packed, data) {
    const { key, iv, tag } = splitPackedKey(packed);
    if (key.length !== KEY_LENGTH || iv.length !== GCM_IV_LENGTH || tag.length !== TAG_LENGTH) {
        throw new CloudKeyError("the item's key is not a 32-byte key, a 12-byte IV and a 16-byte tag");
    }
    try {
        const d = createDecipheriv("aes-256-gcm", key, iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(data), d.final()]);
    } catch {
        throw new CloudKeyError("the data does not decrypt with the item's key (it fails its GCM tag)");
    }
}

/**
 * An item's file-name and thumbnail metadata (`mediaInfo.mediaExtInfo.data`), decrypted.
 *
 * @param {string} dataBase64
 * @param {string} wrappedKeyBase64 - `mediaInfo.mediaExtInfo.encryptInfo.encryptKey`
 * @param {import("node:crypto").KeyObject} privateKey
 * @returns {object|string} the JSON it holds (`{name, ext, title, fileExt, thumbUrl, …}`), or its text
 */
export function decryptCloudInfo(dataBase64, wrappedKeyBase64, privateKey) {
    const text = openGcm(unwrapCloudKey(wrappedKeyBase64, privateKey), Buffer.from(String(dataBase64), "base64"));
    const utf8 = text.toString("utf8");
    try {
        return JSON.parse(utf8);
    } catch {
        return utf8;
    }
}

/**
 * Open a downloaded blob: the linear version (one GCM pass, `algoversion` 1) or the block-by-block one (`algoversion` 2).
 *
 * @param {Buffer} bytes - the body the download answered
 * @param {string} wrappedKeyBase64 - the item's `encryptInfo.encryptKey`
 * @param {string|number|null} algoVersion - the item's `encryptInfo.algoVersion`; absent counts as linear
 * @param {import("node:crypto").KeyObject} privateKey
 * @returns {Buffer} the file
 * @throws {CloudKeyError} for a key that does not open, or bytes that do not decrypt
 */
export function decryptCloudBlob(bytes, wrappedKeyBase64, algoVersion, privateKey) {
    const v =
        algoVersion === undefined || algoVersion === null || algoVersion === "" ? ALGO_LINEAR : String(algoVersion);
    if (v === ALGO_BLOCK) return openBlocks(unwrapCloudKey(wrappedKeyBase64, privateKey), bytes);
    if (v !== ALGO_LINEAR) throw new CloudKeyError(`unknown algoversion ${v}`);
    return openGcm(unwrapCloudKey(wrappedKeyBase64, privateKey), bytes);
}

/**
 * The key request that starts a key transfer from the phone, built and never sent
 * here: answering it needs a registered Signal identity this client does not have, and sending it shows a prompt on
 * the owner's phone.
 *
 * @param {{deviceName: string, sessionId: string}} args
 * @returns {{host: "zcloud", path: string, method: "GET", params: {device_name: string, session_id: string},
 *   sent: false}}
 */
export function cloudKeyRequestShape({ deviceName, sessionId }) {
    return {
        host: "zcloud",
        path: "/personalcloud_key/req_cloud_key",
        method: "GET",
        params: { device_name: String(deviceName), session_id: String(sessionId) },
        sent: false,
    };
}
