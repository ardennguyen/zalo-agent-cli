/**
 * The slice of the Signal protocol (X3DH + Double Ratchet, message version 3) that the end-to-end-encryption device
 * needs: generate its keys, build a session to a peer's published bundle as the initiator and encrypt on it, decrypt
 * a reply on that session (with the DH ratchet step a reply brings), and accept a pre-key message as the responder.
 *
 * It is the standard protocol with one difference, Zalo's Signal variant: every HKDF runs under its own info label
 * ({@link ZALO_KDF_LABELS}) in place of the standard one. With the standard labels every derived key differs and each
 * message fails its MAC check.
 *
 * Wire format (standard Signal v3): a WhisperMessage is a version byte 0x33, the protobuf {ratchetKey=1,
 * counter=2, previousCounter=3, ciphertext=4}, then the first 8 bytes of HMAC-SHA256(macKey, senderIdentity ||
 * receiverIdentity || 0x33 || protobuf). A PreKeyWhisperMessage is 0x33 then the protobuf {registrationId=5,
 * preKeyId=1, signedPreKeyId=6, baseKey=2, identityKey=3, message=4}. Message keys are AES-256-CBC (PKCS#7).
 *
 * State lives in a {@link import("./signal-store.js").SignalProtocolStore} (or anything with the same async methods),
 * which this module reads and writes through its methods only. Session records are JSON text in a stable layout (a
 * map of sessions keyed by base key, each with its root key, ratchet key pair and chains, every key as base64; record
 * version "v1"); it is the layout a store sealed before this module existed already holds, so such a store keeps
 * working. A decrypt works on copies and saves only when it succeeds: a failed attempt leaves the store untouched.
 *
 * Protocol layer: no `src/core`, no `src/utils`. Crypto: `node:crypto` and ./curve.js.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { calculateAgreement, generateKeyPair, systemRandom, u8, xeddsaSign, xeddsaVerify } from "./curve.js";

/**
 * The key-derivation labels of Zalo's 1-to-1 Signal variant, keyed by the standard label each one replaces.
 */
export const ZALO_KDF_LABELS = Object.freeze({
    WhisperText: "ZaloText",
    WhisperRatchet: "ZaloRatchet",
    WhisperMessageKeys: "ZaloMessageKeys",
});

/** The message version byte: current version 3 in the high nibble, minimum version 3 in the low one. */
export const VERSION_BYTE = 0x33;
/** The transport type of a normal message on an established session. */
export const WHISPER_MESSAGE_TYPE = 2;
/** The transport type of a message that also sets up the session (it carries the X3DH header). */
export const PREKEY_MESSAGE_TYPE = 3;
/** How far ahead of the chain a message counter may be (keys for the skipped ones are kept). */
export const MAX_MESSAGE_KEYS_AHEAD = 2000;

const RECORD_VERSION = "v1";
const ARCHIVED_SESSIONS_MAX = 40;
const OLD_RATCHETS_MAX = 10;
const CHAIN_SENDING = 1;
const CHAIN_RECEIVING = 2;
const BASE_KEY_OURS = 1;
const BASE_KEY_THEIRS = 2;
const ZERO_SALT = new Uint8Array(32);

/** Raised when a message repeats a counter whose key is already used (a replay or a duplicate delivery). */
export class MessageCounterError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "MessageCounterError";
    }
}

// ---- small helpers -----------------------------------------------------------------------------------------------

const b64 = (bytes) => Buffer.from(u8(bytes)).toString("base64");
const unb64 = (text) => new Uint8Array(Buffer.from(String(text), "base64"));
/** The record key of a session: its base key's bytes as a binary string. */
const binaryKey = (bytes) => Buffer.from(u8(bytes)).toString("latin1");

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of parts) {
        out.set(p, i);
        i += p.length;
    }
    return out;
}

function hmac(key, data) {
    return new Uint8Array(createHmac("sha256", key).update(data).digest());
}

/** HKDF-SHA256 to three 32-byte outputs, under Zalo's label for the given standard one. */
function hkdf3(input, salt, standardLabel) {
    const info = ZALO_KDF_LABELS[standardLabel];
    const out = new Uint8Array(hkdfSync("sha256", input, salt, info, 96));
    return [out.subarray(0, 32), out.subarray(32, 64), out.subarray(64, 96)];
}

/**
 * The encoded form of a peer address: `<name>.<deviceId>` (the key sessions and identities are stored under).
 *
 * @param {string} name - the account id
 * @param {number} deviceId - the platform slot
 * @returns {string}
 */
export function encodeAddress(name, deviceId) {
    return `${String(name)}.${Number(deviceId)}`;
}

// ---- protobuf (the two message types, hand-coded) ----------------------------------------------------------------

function pushVarint(out, n) {
    let v = Number(n) >>> 0;
    while (v > 0x7f) {
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    out.push(v);
}

function pushBytes(out, field, bytes) {
    pushVarint(out, (field << 3) | 2);
    pushVarint(out, bytes.length);
    for (const b of bytes) out.push(b);
}

function pushUint(out, field, n) {
    pushVarint(out, field << 3);
    pushVarint(out, n);
}

/** Read every field of a protobuf message: varints as numbers, length-delimited fields as bytes. */
function readFields(bytes) {
    const b = u8(bytes);
    const fields = new Map();
    let i = 0;
    const varint = () => {
        let v = 0;
        let mul = 1;
        for (let n = 0; n < 10; n++) {
            if (i >= b.length) throw new Error("truncated protobuf");
            const c = b[i++];
            v += (c & 0x7f) * mul;
            if (!(c & 0x80)) return v;
            mul *= 128;
        }
        throw new Error("malformed protobuf varint");
    };
    while (i < b.length) {
        const key = varint();
        const field = Math.floor(key / 8);
        const wire = key % 8;
        if (wire === 0) fields.set(field, varint());
        else if (wire === 2) {
            const len = varint();
            if (i + len > b.length) throw new Error("truncated protobuf");
            fields.set(field, b.subarray(i, i + len));
            i += len;
        } else if (wire === 1) i += 8;
        else if (wire === 5) i += 4;
        else throw new Error(`unsupported protobuf wire type ${wire}`);
    }
    return fields;
}

/**
 * Encode a WhisperMessage's protobuf body (no version byte, no MAC).
 *
 * @param {{ratchetKey: Uint8Array, counter: number, previousCounter: number, ciphertext: Uint8Array}} m
 * @returns {Uint8Array}
 */
export function encodeWhisperMessage(m) {
    const out = [];
    pushBytes(out, 1, u8(m.ratchetKey));
    pushUint(out, 2, m.counter);
    pushUint(out, 3, m.previousCounter);
    pushBytes(out, 4, u8(m.ciphertext));
    return Uint8Array.from(out);
}

/**
 * Decode a WhisperMessage's protobuf body.
 *
 * @param {Uint8Array} bytes
 * @returns {{ratchetKey: Uint8Array, counter: number, previousCounter: number, ciphertext: Uint8Array}}
 */
export function decodeWhisperMessage(bytes) {
    const f = readFields(bytes);
    const ratchetKey = f.get(1);
    const ciphertext = f.get(4);
    if (!(ratchetKey instanceof Uint8Array) || !(ciphertext instanceof Uint8Array)) {
        throw new Error("the message has no ratchet key or ciphertext");
    }
    return { ratchetKey, counter: Number(f.get(2) ?? 0), previousCounter: Number(f.get(3) ?? 0), ciphertext };
}

/**
 * Encode a PreKeyWhisperMessage's protobuf body (no version byte). Every field is written, a missing one-time
 * pre-key as id 0.
 *
 * @param {{registrationId: number, preKeyId?: number, signedPreKeyId: number, baseKey: Uint8Array,
 *   identityKey: Uint8Array, message: Uint8Array}} m
 * @returns {Uint8Array}
 */
export function encodePreKeyWhisperMessage(m) {
    const out = [];
    pushUint(out, 5, m.registrationId);
    pushUint(out, 1, m.preKeyId ?? 0);
    pushUint(out, 6, m.signedPreKeyId);
    pushBytes(out, 2, u8(m.baseKey));
    pushBytes(out, 3, u8(m.identityKey));
    pushBytes(out, 4, u8(m.message));
    return Uint8Array.from(out);
}

/**
 * Decode a PreKeyWhisperMessage's protobuf body.
 *
 * @param {Uint8Array} bytes
 * @returns {{registrationId?: number, preKeyId?: number, signedPreKeyId?: number, baseKey: Uint8Array,
 *   identityKey: Uint8Array, message: Uint8Array}}
 */
export function decodePreKeyWhisperMessage(bytes) {
    const f = readFields(bytes);
    const baseKey = f.get(2);
    const identityKey = f.get(3);
    const message = f.get(4);
    for (const v of [baseKey, identityKey, message]) {
        if (!(v instanceof Uint8Array))
            throw new Error("the pre-key message is missing its base key, identity or body");
    }
    const num = (k) => (typeof f.get(k) === "number" ? f.get(k) : undefined);
    return {
        registrationId: num(5),
        preKeyId: num(1),
        signedPreKeyId: num(6),
        baseKey,
        identityKey,
        message,
    };
}

function checkVersion(byte, what) {
    if ((byte & 0xf) > 3 || byte >> 4 < 3) throw new Error(`incompatible version byte ${byte} on the ${what}`);
}

// ---- key generation ----------------------------------------------------------------------------------------------

/**
 * A fresh identity key pair.
 *
 * @param {import("./curve.js").RandomSource} [random]
 * @returns {{pubKey: Uint8Array, privKey: Uint8Array}}
 */
export function generateIdentityKeyPair(random = systemRandom) {
    return generateKeyPair(undefined, random);
}

/**
 * A fresh 14-bit registration id.
 *
 * @param {import("./curve.js").RandomSource} [random]
 * @returns {number}
 */
export function generateRegistrationId(random = systemRandom) {
    const b = u8(random(2));
    return (b[0] | (b[1] << 8)) & 0x3fff;
}

/**
 * A signed pre-key: a fresh key pair whose serialized public key is XEdDSA-signed by the identity key.
 *
 * @param {{pubKey: ArrayBuffer|Uint8Array, privKey: ArrayBuffer|Uint8Array}} identityKeyPair
 * @param {number} keyId
 * @param {import("./curve.js").RandomSource} [random]
 * @returns {{keyId: number, keyPair: {pubKey: Uint8Array, privKey: Uint8Array}, signature: Uint8Array}}
 */
export function generateSignedPreKey(identityKeyPair, keyId, random = systemRandom) {
    if (!Number.isInteger(keyId) || keyId < 0) throw new TypeError(`invalid signed pre-key id: ${keyId}`);
    const keyPair = generateKeyPair(undefined, random);
    const signature = xeddsaSign(identityKeyPair.privKey, keyPair.pubKey, random);
    return { keyId, keyPair, signature };
}

/**
 * A one-time pre-key.
 *
 * @param {number} keyId
 * @param {import("./curve.js").RandomSource} [random]
 * @returns {{keyId: number, keyPair: {pubKey: Uint8Array, privKey: Uint8Array}}}
 */
export function generatePreKey(keyId, random = systemRandom) {
    if (!Number.isInteger(keyId) || keyId < 0) throw new TypeError(`invalid pre-key id: ${keyId}`);
    return { keyId, keyPair: generateKeyPair(undefined, random) };
}

// ---- session records ---------------------------------------------------------------------------------------------

/** Parse a stored record, or start an empty one. */
function parseRecord(serialized) {
    if (serialized === undefined || serialized === null) return { sessions: {}, version: RECORD_VERSION };
    const data = typeof serialized === "string" ? JSON.parse(serialized) : structuredClone(serialized);
    if (!data || typeof data.sessions !== "object" || data.sessions === null || Array.isArray(data.sessions)) {
        throw new Error("the stored session record is unreadable");
    }
    if (data.version === undefined && data.registrationId) {
        // A pre-v1 record kept the registration id on the record rather than on each session.
        for (const s of Object.values(data.sessions)) s.registrationId ??= data.registrationId;
    } else if (data.version !== undefined && data.version !== RECORD_VERSION) {
        throw new Error(`unknown session record version ${data.version}`);
    }
    return { sessions: data.sessions, version: RECORD_VERSION };
}

function serializeRecord(record) {
    return JSON.stringify({ sessions: record.sessions, version: record.version });
}

function getOpenSession(record) {
    let open;
    for (const s of Object.values(record.sessions)) {
        if (s.indexInfo.closed === -1) {
            if (open) throw new Error("the session record has more than one open session");
            open = s;
        }
    }
    return open;
}

/** Sessions oldest-closed first, the open one last (decrypt tries them from the end). */
function getSessions(record) {
    const closed = [];
    let open;
    for (const s of Object.values(record.sessions)) {
        if (s.indexInfo.closed === -1) open = s;
        else closed.push(s);
    }
    closed.sort((a, b) => a.indexInfo.closed - b.indexInfo.closed);
    if (open) closed.push(open);
    return closed;
}

/** The session a peer started with this base key (never one we started). */
function getSessionByBaseKey(record, baseKey) {
    const s = record.sessions[binaryKey(baseKey)];
    return s && s.indexInfo.baseKeyType !== BASE_KEY_OURS ? s : undefined;
}

function removeOldChains(session) {
    while (session.oldRatchetList.length > OLD_RATCHETS_MAX) {
        let index = 0;
        for (let i = 1; i < session.oldRatchetList.length; i++) {
            if (session.oldRatchetList[i].added < session.oldRatchetList[index].added) index = i;
        }
        delete session.chains[session.oldRatchetList[index].ephemeralKey];
        session.oldRatchetList.splice(index, 1);
    }
}

function removeOldSessions(record) {
    while (Object.keys(record.sessions).length > ARCHIVED_SESSIONS_MAX) {
        let oldestKey;
        let oldest;
        for (const [k, s] of Object.entries(record.sessions)) {
            if (s.indexInfo.closed > -1 && (!oldest || s.indexInfo.closed < oldest.indexInfo.closed)) {
                oldestKey = k;
                oldest = s;
            }
        }
        if (oldestKey === undefined) break;
        delete record.sessions[oldestKey];
    }
}

function updateSessionState(record, session) {
    removeOldChains(session);
    record.sessions[binaryKey(unb64(session.indexInfo.baseKey))] = session;
    removeOldSessions(record);
}

function archiveCurrentState(record) {
    const open = getOpenSession(record);
    if (open) {
        open.indexInfo.closed = Date.now();
        updateSessionState(record, open);
    }
}

// ---- the ratchet -------------------------------------------------------------------------------------------------

/** Advance a chain until it holds the key for `counter` (keeping the skipped keys). */
function fillMessageKeys(chain, counter) {
    if (chain.chainKey.counter >= counter) return;
    if (counter - chain.chainKey.counter > MAX_MESSAGE_KEYS_AHEAD) {
        throw new Error(`the message is over ${MAX_MESSAGE_KEYS_AHEAD} messages into the future`);
    }
    if (chain.chainKey.key === undefined) throw new Error("the chain is closed and cannot be extended");
    let ck = unb64(chain.chainKey.key);
    while (chain.chainKey.counter < counter) {
        const seed = hmac(ck, Uint8Array.of(1));
        ck = hmac(ck, Uint8Array.of(2));
        chain.chainKey.counter += 1;
        chain.messageKeys[chain.chainKey.counter] = b64(seed);
    }
    chain.chainKey.key = b64(ck);
}

/** A DH ratchet step: derive the next root key and a new chain against `remoteKey`. */
function calculateRatchet(session, remoteKey, sending) {
    const ratchet = session.currentRatchet;
    const shared = calculateAgreement(remoteKey, unb64(ratchet.ephemeralKeyPair.privKey));
    const [rootKey, chainKey] = hkdf3(shared, unb64(ratchet.rootKey), "WhisperRatchet");
    const chainId = sending ? ratchet.ephemeralKeyPair.pubKey : b64(remoteKey);
    session.chains[chainId] = {
        messageKeys: {},
        chainKey: { counter: -1, key: b64(chainKey) },
        chainType: sending ? CHAIN_SENDING : CHAIN_RECEIVING,
    };
    ratchet.rootKey = b64(rootKey);
}

/** On a new remote ratchet key: close the old receiving chain, open a receiving and a fresh sending chain. */
function maybeStepRatchet(session, remoteKey, previousCounter, random) {
    const remoteId = b64(remoteKey);
    if (session.chains[remoteId] !== undefined) return;
    const ratchet = session.currentRatchet;
    const previous = session.chains[ratchet.lastRemoteEphemeralKey];
    if (previous !== undefined) {
        fillMessageKeys(previous, previousCounter);
        delete previous.chainKey.key;
        session.oldRatchetList.push({ added: Date.now(), ephemeralKey: ratchet.lastRemoteEphemeralKey });
    }
    calculateRatchet(session, remoteKey, false);
    const ourOld = session.chains[ratchet.ephemeralKeyPair.pubKey];
    if (ourOld !== undefined) {
        ratchet.previousCounter = ourOld.chainKey.counter;
        delete session.chains[ratchet.ephemeralKeyPair.pubKey];
    }
    const next = generateKeyPair(undefined, random);
    ratchet.ephemeralKeyPair = { pubKey: b64(next.pubKey), privKey: b64(next.privKey) };
    calculateRatchet(session, remoteKey, true);
    ratchet.lastRemoteEphemeralKey = remoteId;
}

/** Decrypt a serialized WhisperMessage on one session (mutates that session). */
function decryptOnSession(session, messageBytes, ourIdentityPub, random) {
    const bytes = u8(messageBytes);
    if (bytes.length < 1 + 8) throw new Error("the message is too short");
    checkVersion(bytes[0], "message");
    const proto = bytes.subarray(1, bytes.length - 8);
    const mac = bytes.subarray(bytes.length - 8);
    const message = decodeWhisperMessage(proto);
    maybeStepRatchet(session, message.ratchetKey, message.previousCounter, random);
    const chain = session.chains[b64(message.ratchetKey)];
    if (!chain) throw new Error("no chain for the message's ratchet key");
    if (chain.chainType === CHAIN_SENDING) throw new Error("tried to decrypt on a sending chain");
    fillMessageKeys(chain, message.counter);
    const seed = chain.messageKeys[message.counter];
    if (seed === undefined) {
        throw new MessageCounterError("message key not found: the counter was repeated or already used");
    }
    delete chain.messageKeys[message.counter];
    const [cipherKey, macKey, ivBytes] = hkdf3(unb64(seed), ZERO_SALT, "WhisperMessageKeys");
    const macInput = concat(unb64(session.indexInfo.remoteIdentityKey), u8(ourIdentityPub), [VERSION_BYTE], proto);
    const want = hmac(macKey, macInput).subarray(0, 8);
    if (!timingSafeEqual(want, mac)) throw new Error("bad MAC");
    const decipher = createDecipheriv("aes-256-cbc", cipherKey, ivBytes.subarray(0, 16));
    const plaintext = Buffer.concat([decipher.update(message.ciphertext), decipher.final()]);
    delete session.pendingPreKey;
    return new Uint8Array(plaintext);
}

/** The X3DH master secret: 32 bytes of 0xFF, then the agreements in order. */
function masterSecret(agreements) {
    return concat(new Uint8Array(32).fill(0xff), ...agreements);
}

// ---- per-address serialization -----------------------------------------------------------------------------------

const locks = new Map();

/** Run jobs for one address one at a time (a session record is read, changed and written back). */
function withLock(address, job) {
    const prev = locks.get(address) ?? Promise.resolve();
    const run = prev.then(job, job);
    const tail = run.then(
        () => {},
        () => {},
    );
    locks.set(address, tail);
    tail.then(() => {
        if (locks.get(address) === tail) locks.delete(address);
    });
    return run;
}

async function requireIdentity(store) {
    const kp = await store.getIdentityKeyPair();
    if (!kp) throw new Error("the store has no identity key");
    return { pubKey: u8(kp.pubKey), privKey: u8(kp.privKey) };
}

// ---- the public operations ---------------------------------------------------------------------------------------

/**
 * Build a session to a peer from its published bundle, as the initiator (X3DH). The peer's signed pre-key signature
 * is verified first. The new session becomes the open one for the address (an earlier one is archived), and the next
 * {@link encryptMessage} on it produces a pre-key message.
 *
 * @param {object} store - the Signal store
 * @param {string} address - from {@link encodeAddress}
 * @param {{registrationId: number, identityKey: ArrayBuffer|Uint8Array, signedPreKey: {keyId: number,
 *   publicKey: ArrayBuffer|Uint8Array, signature: ArrayBuffer|Uint8Array}, preKey?: {keyId: number,
 *   publicKey: ArrayBuffer|Uint8Array}}} bundle
 * @param {{random?: import("./curve.js").RandomSource}} [opts]
 * @returns {Promise<void>}
 * @throws {Error} on an untrusted identity or a bad signature
 */
export function processPreKeyBundle(store, address, bundle, { random = systemRandom } = {}) {
    return withLock(address, async () => {
        const theirIdentity = u8(bundle.identityKey);
        const theirSigned = u8(bundle.signedPreKey.publicKey);
        if (!(await store.isTrustedIdentity(address, theirIdentity))) throw new Error("the identity key changed");
        if (!xeddsaVerify(theirIdentity, theirSigned, bundle.signedPreKey.signature)) {
            throw new Error("the signed pre-key's signature does not verify");
        }
        const ours = await requireIdentity(store);
        const baseKey = generateKeyPair(undefined, random);
        const theirOneTime = bundle.preKey ? u8(bundle.preKey.publicKey) : undefined;
        const agreements = [
            calculateAgreement(theirSigned, ours.privKey),
            calculateAgreement(theirIdentity, baseKey.privKey),
            calculateAgreement(theirSigned, baseKey.privKey),
        ];
        if (theirOneTime) agreements.push(calculateAgreement(theirOneTime, baseKey.privKey));
        const [rootKey] = hkdf3(masterSecret(agreements), ZERO_SALT, "WhisperText");
        const sending = generateKeyPair(undefined, random);
        const session = {
            indexInfo: { closed: -1, remoteIdentityKey: b64(theirIdentity), baseKey: b64(baseKey.pubKey) },
            registrationId: bundle.registrationId,
            currentRatchet: {
                rootKey: b64(rootKey),
                ephemeralKeyPair: { pubKey: b64(sending.pubKey), privKey: b64(sending.privKey) },
                lastRemoteEphemeralKey: b64(theirSigned),
                previousCounter: 0,
            },
            oldRatchetList: [],
            chains: {},
        };
        session.indexInfo.baseKeyType = BASE_KEY_OURS;
        calculateRatchet(session, theirSigned, true);
        session.pendingPreKey = { baseKey: b64(baseKey.pubKey), signedKeyId: bundle.signedPreKey.keyId };
        if (bundle.preKey) session.pendingPreKey.preKeyId = bundle.preKey.keyId;

        const record = parseRecord(await store.loadSession(address));
        archiveCurrentState(record);
        updateSessionState(record, session);
        await store.storeSession(address, serializeRecord(record));
        await store.saveIdentity(address, theirIdentity);
    });
}

/**
 * Encrypt on the open session with a peer. Until the peer has answered, the result is a pre-key message (type 3)
 * that carries the X3DH header; after that, a normal message (type 2).
 *
 * @param {object} store
 * @param {string} address
 * @param {ArrayBuffer|ArrayBufferView} plaintext
 * @returns {Promise<{type: number, body: Uint8Array, registrationId: number}>} body is the serialized message
 */
export function encryptMessage(store, address, plaintext) {
    return withLock(address, async () => {
        const ours = await requireIdentity(store);
        const ourRegistrationId = await store.getLocalRegistrationId();
        const serialized = await store.loadSession(address);
        if (serialized === undefined) throw new Error(`no session with ${address}`);
        const record = parseRecord(serialized);
        const session = getOpenSession(record);
        if (!session) throw new Error(`no open session with ${address}`);
        const ratchetPub = session.currentRatchet.ephemeralKeyPair.pubKey;
        const chain = session.chains[ratchetPub];
        if (!chain || chain.chainType !== CHAIN_SENDING) throw new Error("the session has no sending chain");
        fillMessageKeys(chain, chain.chainKey.counter + 1);
        const counter = chain.chainKey.counter;
        const seed = unb64(chain.messageKeys[counter]);
        delete chain.messageKeys[counter];
        const [cipherKey, macKey, ivBytes] = hkdf3(seed, ZERO_SALT, "WhisperMessageKeys");
        const cipher = createCipheriv("aes-256-cbc", cipherKey, ivBytes.subarray(0, 16));
        const ciphertext = Buffer.concat([cipher.update(u8(plaintext)), cipher.final()]);
        const proto = encodeWhisperMessage({
            ratchetKey: unb64(ratchetPub),
            counter,
            previousCounter: session.currentRatchet.previousCounter,
            ciphertext,
        });
        const remoteIdentity = unb64(session.indexInfo.remoteIdentityKey);
        const mac = hmac(macKey, concat(ours.pubKey, remoteIdentity, [VERSION_BYTE], proto)).subarray(0, 8);
        const whisper = concat([VERSION_BYTE], proto, mac);

        if (!(await store.isTrustedIdentity(address, remoteIdentity))) throw new Error("the identity key changed");
        await store.saveIdentity(address, remoteIdentity);
        updateSessionState(record, session);
        await store.storeSession(address, serializeRecord(record));

        const registrationId = session.registrationId;
        if (session.pendingPreKey === undefined) return { type: WHISPER_MESSAGE_TYPE, body: whisper, registrationId };
        const pending = session.pendingPreKey;
        const preKeyMessage = encodePreKeyWhisperMessage({
            registrationId: ourRegistrationId,
            preKeyId: pending.preKeyId,
            signedPreKeyId: pending.signedKeyId,
            baseKey: unb64(pending.baseKey),
            identityKey: ours.pubKey,
            message: whisper,
        });
        return { type: PREKEY_MESSAGE_TYPE, body: concat([VERSION_BYTE], preKeyMessage), registrationId };
    });
}

/**
 * Decrypt a normal (type-2) message from a peer. Every session held for the address is tried, the open one first and
 * then the archived ones newest first; the one that decrypts is kept (and becomes the open one).
 *
 * @param {object} store
 * @param {string} address
 * @param {ArrayBuffer|ArrayBufferView} message - the serialized WhisperMessage
 * @param {{random?: import("./curve.js").RandomSource}} [opts]
 * @returns {Promise<Uint8Array>} the plaintext
 * @throws {MessageCounterError|Error}
 */
export function decryptWhisperMessage(store, address, message, { random = systemRandom } = {}) {
    return withLock(address, async () => {
        const serialized = await store.loadSession(address);
        if (serialized === undefined) throw new Error(`no session with ${address}`);
        const record = parseRecord(serialized);
        const ours = await requireIdentity(store);
        const candidates = getSessions(record);
        const errors = [];
        let winner;
        let plaintext;
        for (let i = candidates.length - 1; i >= 0; i--) {
            const attempt = structuredClone(candidates[i]);
            try {
                plaintext = decryptOnSession(attempt, message, ours.pubKey, random);
                winner = attempt;
                break;
            } catch (e) {
                if (e instanceof MessageCounterError) throw e;
                errors.push(e);
            }
        }
        if (!winner) throw errors[0] ?? new Error(`no session with ${address}`);
        const remoteIdentity = unb64(winner.indexInfo.remoteIdentityKey);
        if (!(await store.isTrustedIdentity(address, remoteIdentity))) throw new Error("the identity key changed");
        if (winner.indexInfo.baseKey !== getOpenSession(record)?.indexInfo.baseKey) {
            archiveCurrentState(record);
            winner.indexInfo.closed = -1;
        }
        updateSessionState(record, winner);
        await store.storeSession(address, serializeRecord(record));
        await store.saveIdentity(address, remoteIdentity);
        return plaintext;
    });
}

/**
 * Decrypt a pre-key (type-3) message, as the responder: build the session its X3DH header describes from our signed
 * pre-key and, when named, one-time pre-key (unless a session with that base key already exists), then decrypt the
 * message it carries. On success the session is stored and the one-time pre-key used is removed from the store.
 *
 * @param {object} store
 * @param {string} address
 * @param {ArrayBuffer|ArrayBufferView} message - the serialized PreKeyWhisperMessage (version byte first)
 * @param {{random?: import("./curve.js").RandomSource}} [opts]
 * @returns {Promise<Uint8Array>} the plaintext
 */
export function decryptPreKeyWhisperMessage(store, address, message, { random = systemRandom } = {}) {
    return withLock(address, async () => {
        const bytes = u8(message);
        if (bytes.length < 2) throw new Error("the pre-key message is too short");
        checkVersion(bytes[0], "pre-key message");
        const m = decodePreKeyWhisperMessage(bytes.subarray(1));
        const serialized = await store.loadSession(address);
        if (serialized === undefined && m.registrationId === undefined) {
            throw new Error("the pre-key message has no registration id");
        }
        const record = parseRecord(serialized);
        if (!(await store.isTrustedIdentity(address, m.identityKey))) throw new Error("the identity key changed");
        const ours = await requireIdentity(store);

        let usedPreKeyId;
        if (!getSessionByBaseKey(record, m.baseKey)) {
            const signed = m.signedPreKeyId === undefined ? undefined : await store.loadSignedPreKey(m.signedPreKeyId);
            const open = getOpenSession(record);
            if (signed === undefined) {
                // Without the signed pre-key no session can be built; an open session may still be the right one.
                if (!open) throw new Error(`missing signed pre-key ${m.signedPreKeyId} for the pre-key message`);
            } else {
                const oneTime = m.preKeyId === undefined ? undefined : await store.loadPreKey(m.preKeyId);
                if (open) archiveCurrentState(record);
                const agreements = [
                    calculateAgreement(m.identityKey, u8(signed.privKey)),
                    calculateAgreement(m.baseKey, ours.privKey),
                    calculateAgreement(m.baseKey, u8(signed.privKey)),
                ];
                if (oneTime) agreements.push(calculateAgreement(m.baseKey, u8(oneTime.privKey)));
                const [rootKey] = hkdf3(masterSecret(agreements), ZERO_SALT, "WhisperText");
                updateSessionState(record, {
                    indexInfo: {
                        closed: -1,
                        remoteIdentityKey: b64(m.identityKey),
                        baseKey: b64(m.baseKey),
                        baseKeyType: BASE_KEY_THEIRS,
                    },
                    registrationId: m.registrationId,
                    currentRatchet: {
                        rootKey: b64(rootKey),
                        ephemeralKeyPair: { pubKey: b64(signed.pubKey), privKey: b64(signed.privKey) },
                        lastRemoteEphemeralKey: b64(m.baseKey),
                        previousCounter: 0,
                    },
                    oldRatchetList: [],
                    chains: {},
                });
                if (oneTime) usedPreKeyId = m.preKeyId;
            }
        }
        const session = getSessionByBaseKey(record, m.baseKey);
        if (!session) throw new Error("no session for the pre-key message's base key");
        const plaintext = decryptOnSession(session, m.message, ours.pubKey, random);
        updateSessionState(record, session);
        await store.storeSession(address, serializeRecord(record));
        await store.saveIdentity(address, m.identityKey);
        if (usedPreKeyId !== undefined) await store.removePreKey(usedPreKeyId);
        return plaintext;
    });
}
