/**
 * The narrow end-to-end-encryption device crypto and wire (src/zalo/e2ee): the key-stack socket command shapes, the
 * one-byte transport tag, and a full interop round-trip — a stand-in "phone" encrypts a pre-key (type-3) message
 * carrying a known PKCS#8 key to our generated bundle, and our code decrypts it to the exact bytes, consuming the
 * matched one-time pre-key. Every id and key here is a throwaway made in this file. Offline: the Signal library is pure
 * JS, no network.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
    CMD_GET_BUNDLE,
    CMD_GET_KEY_ID,
    CMD_GET_LIST_DEVICES,
    CMD_SUBMIT_BUNDLE,
    CMD_SUBMIT_PREKEYS,
    DEVICE_IDS,
    SignalProtocolStore,
    base64ToAb,
    bundleFromStore,
    concatTypeAndMessage,
    decodeBundleItem,
    decodeDeviceList,
    encodeGetBundle,
    encodeGetKeyId,
    encodeListDevices,
    encodeSubmitBundle,
    encodeSubmitPreKeys,
    generateDeviceIdentity,
    platformName,
    replyError,
    splitTypeAndMessage,
    PRE_KEY_TYPE,
    loadSignalLib,
} from "../../src/zalo/e2ee/index.js";
import { CloudKeyDecryptError, decryptCloudKeyReply, readPreKeyHeader } from "../../src/zalo/e2ee/cloud-key-decrypt.js";

// A throwaway account id and the account's throwaway cloud RSA key (PKCS#8 base64), the plaintext the phone sends.
const OWN_UID = "7000000000000000001";
const CLOUD_PKCS8 = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64");

/** A clean ArrayBuffer of a utf8 string (never a pooled Buffer's `.buffer`). */
function utf8Ab(text) {
    const b = Buffer.from(text, "utf8");
    const ab = new ArrayBuffer(b.length);
    new Uint8Array(ab).set(b);
    return ab;
}

describe("e2ee signal — sandbox", () => {
    it("runs inside the test sandbox", () => assertSandboxed(SANDBOX_CONFIG_DIR));
});

describe("device identity generation", () => {
    it("makes an identity, a registration id, a signed pre-key and a batch of one-time pre-keys", async () => {
        const { store, registrationId, signedPreKeyId, preKeyIds } = await generateDeviceIdentity({ preKeyCount: 4 });
        assert.equal(typeof registrationId, "number");
        assert.equal(signedPreKeyId, registrationId + 1);
        assert.equal(preKeyIds.length, 4);
        assert.equal(store.preKeyCount(), 4);
        const bundle = bundleFromStore(store);
        assert.equal(bundle.registrationId, registrationId);
        assert.ok(bundle.identityKey.length > 0);
        assert.ok(bundle.signedPreKey.signature.length > 0);
        assert.equal(bundle.preKeys.length, 4);
        // The published keys are base64 (33-byte curve public keys decode to 33 bytes).
        assert.equal(Buffer.from(bundle.identityKey, "base64").length, 33);
        assert.equal(Buffer.from(bundle.preKeys[0].publicKey, "base64").length, 33);
    });
});

describe("key-stack wire shapes", () => {
    const bundle = {
        registrationId: 1234,
        identityKey: "aWtleQ==",
        signedPreKey: { keyId: 1, publicKey: "c3BrZXk=", signature: "c2ln" },
        preKeys: [
            { keyId: 100, publicKey: "b3BrMA==" },
            { keyId: 101, publicKey: "b3BrMQ==" },
        ],
    };

    it("SUBMIT_BUNDLE (540) packs the bundle exactly as the client does", () => {
        const frame = encodeSubmitBundle({ bundle, deviceId: DEVICE_IDS.WEB, reqId: "r1" });
        assert.equal(frame.cmd, CMD_SUBMIT_BUNDLE);
        assert.equal(frame.subCmd, 0);
        assert.deepEqual(frame.data, {
            reqId: "r1",
            data: {
                delSS: 0,
                key: {
                    deviceId: 1,
                    preKey: {
                        iKey: { id: 1234, key: "aWtleQ==" },
                        signature: "c2ln",
                        spKey: { id: 1, key: "c3BrZXk=" },
                    },
                    opKeys: [
                        { id: 100, key: "b3BrMA==" },
                        { id: 101, key: "b3BrMQ==" },
                    ],
                },
            },
        });
    });

    it("SUBMIT_BUNDLE honors deleteExistingSessions as delSS=1", () => {
        const frame = encodeSubmitBundle({ bundle, deviceId: 2, reqId: "r2", deleteExistingSessions: true });
        assert.equal(frame.data.data.delSS, 1);
        assert.equal(frame.data.data.key.deviceId, 2);
    });

    it("SUBMIT_PREKEYS (542) carries the device id, registration id and op keys", () => {
        const frame = encodeSubmitPreKeys({
            preKeys: [{ keyId: 200, publicKey: "eA==" }],
            registrationId: 1234,
            deviceId: 1,
            reqId: "r3",
        });
        assert.equal(frame.cmd, CMD_SUBMIT_PREKEYS);
        assert.deepEqual(frame.data.data, { deviceId: 1, id: 1234, opKeys: [{ id: 200, key: "eA==" }] });
    });

    it("GET_BUNDLE (541) asks for one uid+device with the init flags", () => {
        const frame = encodeGetBundle({ uid: OWN_UID, deviceId: 1, reqId: "r4" });
        assert.equal(frame.cmd, CMD_GET_BUNDLE);
        assert.deepEqual(frame.data.data, {
            uids: [{ uid: OWN_UID, deviceId: 1 }],
            isReInit: 0,
            msgInfoNoti: 0,
            isAutoUpgrade: 0,
        });
    });

    it("GET_KEY_ID (564) names the platform slot", () => {
        const frame = encodeGetKeyId({ deviceId: 1, reqId: "r5" });
        assert.equal(frame.cmd, CMD_GET_KEY_ID);
        assert.deepEqual(frame.data.data, { platformType: 1 });
    });

    it("GET_LIST_USER_E2EE (563) asks for the full list", () => {
        const frame = encodeListDevices({ reqId: "r6" });
        assert.equal(frame.cmd, CMD_GET_LIST_DEVICES);
        assert.deepEqual(frame.data.data, { reqIid: 1 });
    });

    it("decodeBundleItem reads a peer bundle, with the one-time pre-key optional", () => {
        const item = decodeBundleItem({
            deviceId: 1,
            registrationId: 9,
            identityKey: "aWtleQ==",
            signedPreKey: { keyId: 1, publicKey: "c3BrZXk=", signature: "c2ln" },
            preKey: { keyId: 100, publicKey: "b3BrMA==" },
        });
        assert.equal(item.deviceId, 1);
        assert.equal(item.preKey.keyId, 100);
        const noOpk = decodeBundleItem({
            deviceId: 2,
            registrationId: 9,
            identityKey: "aWtleQ==",
            signedPreKey: { keyId: 1, publicKey: "c3BrZXk=", signature: "c2ln" },
        });
        assert.equal(noOpk.preKey, null);
    });

    it("decodeDeviceList finds the account's slots and platforms", () => {
        const reply = { reqId: "r6", data: { uids: [{ uid: OWN_UID, devices: [{ deviceId: 0 }, { deviceId: 2 }] }] } };
        const parsed = decodeDeviceList(reply, OWN_UID);
        assert.deepEqual(parsed.occupiedSlots, [0, 2]);
        assert.deepEqual(
            parsed.devices.map((d) => d.platform),
            ["MOBILE", "PC"],
        );
    });

    it("replyError reads the server error, treating 0 and absent as clean", () => {
        assert.equal(replyError({ data: { err: -205 } }), -205);
        assert.equal(replyError({ data: { err: 0 } }), null);
        assert.equal(replyError({ data: {} }), null);
        assert.equal(replyError(null), null);
    });

    it("platformName maps the slots", () => {
        assert.equal(platformName(0), "MOBILE");
        assert.equal(platformName(1), "WEB");
        assert.equal(platformName(2), "PC");
        assert.equal(platformName(9), "SLOT_9");
    });
});

describe("the one-byte transport tag", () => {
    it("concat then split returns the type and the message bytes", () => {
        const msg = Buffer.from([1, 2, 3, 4, 5]);
        const tagged = concatTypeAndMessage(PRE_KEY_TYPE, msg);
        const { type, message } = splitTypeAndMessage(tagged);
        assert.equal(type, PRE_KEY_TYPE);
        assert.deepEqual(Buffer.from(new Uint8Array(message)), msg);
    });

    it("rejects an empty or too-short payload", () => {
        assert.throws(() => splitTypeAndMessage(""), /not a tagged payload/);
        assert.throws(() => splitTypeAndMessage(Buffer.from([3]).toString("base64")), /too short/);
    });
});

describe("full interop round-trip (a stand-in phone encrypts the cloud key to our bundle)", () => {
    it("decrypts the exact PKCS#8 and consumes the matched one-time pre-key", async () => {
        const lib = await loadSignalLib();
        // Our device registers.
        const { store } = await generateDeviceIdentity({ preKeyCount: 3 });
        const bundle = bundleFromStore(store);
        // Persist + reload the store (JSON round-trip, as sealing to disk does), then decrypt from the reloaded one.
        const reloaded = SignalProtocolStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
        assert.equal(reloaded.preKeyCount(), 3);

        // The phone (own uid, device 0 sender) fetches our WEB-slot bundle and builds a session to us.
        const item = decodeBundleItem({
            deviceId: DEVICE_IDS.WEB,
            registrationId: bundle.registrationId,
            identityKey: bundle.identityKey,
            signedPreKey: bundle.signedPreKey,
            preKey: bundle.preKeys[0],
        });
        const phoneStore = new SignalProtocolStore();
        phoneStore.setIdentity(await lib.KeyHelper.generateIdentityKeyPair(), lib.KeyHelper.generateRegistrationId());
        const usAddr = new lib.SignalProtocolAddress(OWN_UID, DEVICE_IDS.WEB);
        await new lib.SessionBuilder(phoneStore, usAddr).processPreKey({
            registrationId: item.registrationId,
            identityKey: base64ToAb(item.identityKey),
            signedPreKey: {
                keyId: item.signedPreKey.keyId,
                publicKey: base64ToAb(item.signedPreKey.publicKey),
                signature: base64ToAb(item.signedPreKey.signature),
            },
            preKey: { keyId: item.preKey.keyId, publicKey: base64ToAb(item.preKey.publicKey) },
        });
        const ciphertext = await new lib.SessionCipher(phoneStore, usAddr).encrypt(utf8Ab(CLOUD_PKCS8));
        assert.equal(ciphertext.type, PRE_KEY_TYPE);
        const encryptedPrivateKey = concatTypeAndMessage(ciphertext.type, ciphertext.body);

        // Our side strips the tag and decrypts with the reloaded store.
        const { decryptCloudKeyReply } = await import("../../src/zalo/e2ee/cloud-key-decrypt.js");
        const opened = await decryptCloudKeyReply({
            store: reloaded,
            encryptedPrivateKey,
            ownUid: OWN_UID,
        });
        assert.equal(opened, CLOUD_PKCS8);
        // The one-time pre-key the phone used is gone from the store.
        assert.equal(reloaded.preKeyCount(), 2);
    });

    it("refuses a payload that is not a pre-key message", async () => {
        const { store } = await generateDeviceIdentity({ preKeyCount: 1 });
        const { decryptCloudKeyReply, CloudKeyDecryptError } = await import("../../src/zalo/e2ee/cloud-key-decrypt.js");
        // type 2 (whisper), not 3 (pre-key): no session can be built.
        const tagged = concatTypeAndMessage(2, Buffer.from([9, 9, 9]));
        await assert.rejects(
            decryptCloudKeyReply({ store, encryptedPrivateKey: tagged, ownUid: OWN_UID }),
            CloudKeyDecryptError,
        );
    });
});

describe("decrypting when the message names key ids we hold under other numbers", () => {
    /** The stand-in phone encrypts the cloud key to a bundle, optionally renumbering its ids. */
    async function phoneEncrypt(bundle, { signedId, preId } = {}) {
        const lib = await loadSignalLib();
        const phoneStore = new SignalProtocolStore();
        phoneStore.setIdentity(await lib.KeyHelper.generateIdentityKeyPair(), lib.KeyHelper.generateRegistrationId());
        const usAddr = new lib.SignalProtocolAddress(OWN_UID, DEVICE_IDS.WEB);
        await new lib.SessionBuilder(phoneStore, usAddr).processPreKey({
            registrationId: bundle.registrationId,
            identityKey: base64ToAb(bundle.identityKey),
            signedPreKey: {
                keyId: signedId ?? bundle.signedPreKey.keyId,
                publicKey: base64ToAb(bundle.signedPreKey.publicKey),
                signature: base64ToAb(bundle.signedPreKey.signature),
            },
            preKey: { keyId: preId ?? bundle.preKeys[1].keyId, publicKey: base64ToAb(bundle.preKeys[1].publicKey) },
        });
        const ct = await new lib.SessionCipher(phoneStore, usAddr).encrypt(utf8Ab(CLOUD_PKCS8));
        return concatTypeAndMessage(ct.type, ct.body);
    }

    it("a generated identity numbers its signed pre-key registrationId + 1", async () => {
        const { registrationId, signedPreKeyId, store } = await generateDeviceIdentity({ preKeyCount: 1 });
        assert.equal(signedPreKeyId, registrationId + 1);
        assert.deepEqual(store.signedPreKeyIds(), [registrationId + 1]);
    });

    it("reads the public header ids of a pre-key message", async () => {
        const { store } = await generateDeviceIdentity({ preKeyCount: 3 });
        const tagged = await phoneEncrypt(bundleFromStore(store), { signedId: 4242, preId: 777 });
        const header = readPreKeyHeader(splitTypeAndMessage(tagged).message);
        assert.equal(header.signedPreKeyId, 4242);
        assert.equal(header.preKeyId, 777);
        assert.equal(typeof header.registrationId, "number");
    });

    it("opens a message whose signed and one-time pre-key ids were renumbered, consuming the right key", async () => {
        const { store } = await generateDeviceIdentity({ preKeyCount: 3 });
        const bundle = bundleFromStore(store);
        const tagged = await phoneEncrypt(bundle, { signedId: 4242, preId: 777 });
        const opened = await decryptCloudKeyReply({ store, encryptedPrivateKey: tagged, ownUid: OWN_UID });
        assert.equal(opened, CLOUD_PKCS8);
        // Exactly the one-time pre-key the phone used (the bundle's second) is gone; the other two stay.
        assert.equal(store.preKeyCount(), 2);
        assert.ok(!store.preKeyIds().includes(bundle.preKeys[1].keyId));
    });

    it("fails on a bundle we never held, naming the ids involved and changing nothing", async () => {
        const { store } = await generateDeviceIdentity({ preKeyCount: 2 });
        const { store: foreign } = await generateDeviceIdentity({ preKeyCount: 2 });
        const tagged = await phoneEncrypt(bundleFromStore(foreign), { signedId: 4242, preId: 777 });
        await assert.rejects(
            decryptCloudKeyReply({ store, encryptedPrivateKey: tagged, ownUid: OWN_UID }),
            (e) =>
                e instanceof CloudKeyDecryptError &&
                /signed pre-key 4242/.test(e.message) &&
                /one-time pre-key 777/.test(e.message),
        );
        assert.equal(store.preKeyCount(), 2);
    });
});
