/**
 * The sealed per-account files for the end-to-end-encryption device (src/core/e2ee-device.js) and the cloud key
 * (src/core/cloud-key-store.js), and the device-backed receive + seal in cloud-key-transfer.js. The files must hold no
 * plaintext key and open only through the account's data key; the status never returns a key byte. Every id and key here
 * is a throwaway. Runs in the test sandbox (a default key provider is installed there).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSealed } from "../../src/core/keystore/index.js";
import {
    createE2eeDevice,
    e2eeDeviceFile,
    e2eeDeviceStatus,
    forgetE2eeDevice,
    hasE2eeDevice,
    loadE2eeDevice,
    markE2eeDeviceSubmitted,
    replenishPreKeys,
} from "../../src/core/e2ee-device.js";
import {
    cloudKeyFile,
    cloudKeyStatus,
    forgetCloudKey,
    hasCloudKey,
    loadCloudKey,
    saveCloudKey,
} from "../../src/core/cloud-key-store.js";
import { receiveCloudKeyFromPhone, isE2eeDeviceRegistered } from "../../src/core/cloud-key-transfer.js";
import {
    DEVICE_IDS,
    SignalProtocolStore,
    base64ToAb,
    bundleFromStore,
    concatTypeAndMessage,
    decodeBundleItem,
    encodeAddress,
    encryptMessage,
    generateIdentityKeyPair,
    generateRegistrationId,
    processPreKeyBundle,
} from "../../src/zalo/e2ee/index.js";
import { generateKeyPairSync } from "node:crypto";

let n = 0;
/** A fresh throwaway account id per test (past MAX_SAFE_INTEGER, like the keystore tests' fakes). */
const freshId = () => String(1000000000000000900n + BigInt(n++));

// Every test in this file runs in the sandbox: a failing hook fails them all.
before(() => assertSandboxed(SANDBOX_CONFIG_DIR));

describe("the sealed device identity", () => {
    it("seals the identity to disk with no plaintext key and reloads it", async () => {
        const ownId = freshId();
        assert.equal(hasE2eeDevice(ownId), false);
        assert.equal(isE2eeDeviceRegistered(ownId), false);
        const { record, bundle } = await createE2eeDevice(ownId, { preKeyCount: 3 });
        assert.equal(hasE2eeDevice(ownId), true);
        assert.equal(isE2eeDeviceRegistered(ownId), true);
        assert.equal(record.deviceId, DEVICE_IDS.WEB);
        assert.equal(bundle.preKeys.length, 3);

        // The file on disk is sealed and does not leak the bundle's public key bytes or the registration id.
        const raw = readFileSync(e2eeDeviceFile(ownId));
        assert.equal(isSealed(raw), true);
        const text = raw.toString("latin1");
        assert.equal(text.includes(bundle.identityKey), false);
        assert.equal(text.includes(String(record.registrationId)), false);

        // Reloaded, it still holds the keys the bundle was built from.
        const loaded = loadE2eeDevice(ownId);
        assert.equal(loaded.registrationId, record.registrationId);
        assert.equal(loaded.store.preKeyCount(), 3);
        assert.deepEqual(bundleFromStore(loaded.store).identityKey, bundle.identityKey);
    });

    it("status reports metadata only, and submitted/forget work", async () => {
        const ownId = freshId();
        await createE2eeDevice(ownId, { preKeyCount: 2 });
        let st = e2eeDeviceStatus(ownId);
        assert.equal(st.registered, true);
        assert.equal(st.platform, "WEB");
        assert.equal(st.preKeyCount, 2);
        assert.equal(st.submittedAt, null);
        // Status is metadata only — no key or store material is exposed.
        assert.deepEqual(Object.keys(st).sort(), [
            "createdAt",
            "deviceId",
            "file",
            "locked",
            "platform",
            "preKeyCount",
            "registered",
            "registrationId",
            "submittedAt",
        ]);

        markE2eeDeviceSubmitted(ownId, () => 123456);
        st = e2eeDeviceStatus(ownId);
        assert.equal(st.submittedAt, 123456);

        assert.equal(forgetE2eeDevice(ownId), true);
        assert.equal(hasE2eeDevice(ownId), false);
        assert.equal(e2eeDeviceStatus(ownId).registered, false);
    });

    it("replenishes one-time pre-keys without reusing ids", async () => {
        const ownId = freshId();
        await createE2eeDevice(ownId, { preKeyCount: 2 });
        const before = loadE2eeDevice(ownId).store.preKeyIds();
        const { ids } = await replenishPreKeys(ownId, { count: 3 });
        assert.equal(ids.length, 3);
        assert.equal(
            ids.some((id) => before.includes(id)),
            false,
        );
        assert.equal(loadE2eeDevice(ownId).store.preKeyCount(), 5);
    });
});

describe("the sealed cloud key", () => {
    const PKCS8 = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ format: "der", type: "pkcs8" })
        .toString("base64");

    it("seals the key with no plaintext on disk, loads it back, and status never shows it", () => {
        const ownId = freshId();
        assert.equal(hasCloudKey(ownId), false);
        saveCloudKey(ownId, { privateKeyPkcs8Base64: PKCS8, keyVersion: 7, publicKey: "pub" });
        assert.equal(hasCloudKey(ownId), true);

        const raw = readFileSync(cloudKeyFile(ownId));
        assert.equal(isSealed(raw), true);
        assert.equal(raw.toString("latin1").includes(PKCS8), false);

        const loaded = loadCloudKey(ownId);
        assert.equal(loaded.privateKeyPkcs8Base64, PKCS8);
        assert.equal(loaded.keyVersion, 7);

        const st = cloudKeyStatus(ownId);
        assert.equal(st.stored, true);
        assert.equal(st.keyVersion, 7);
        assert.equal(JSON.stringify(st).includes(PKCS8), false);

        assert.equal(forgetCloudKey(ownId), true);
        assert.equal(hasCloudKey(ownId), false);
        assert.equal(cloudKeyStatus(ownId).stored, false);
    });
});

describe("device-backed receive seals the cloud key", () => {
    it("decrypts the phone's reply with the sealed device and stores the key", async () => {
        const ownId = freshId();
        const { bundle } = await createE2eeDevice(ownId, { preKeyCount: 2 });

        // A stand-in phone encrypts a known cloud key to our published bundle.
        const cloudPkcs8 = generateKeyPairSync("rsa", { modulusLength: 2048 })
            .privateKey.export({ format: "der", type: "pkcs8" })
            .toString("base64");
        const item = decodeBundleItem({
            deviceId: DEVICE_IDS.WEB,
            registrationId: bundle.registrationId,
            identityKey: bundle.identityKey,
            signedPreKey: bundle.signedPreKey,
            preKey: bundle.preKeys[0],
        });
        const phoneStore = new SignalProtocolStore();
        phoneStore.setIdentity(generateIdentityKeyPair(), generateRegistrationId());
        const usAddr = encodeAddress(ownId, DEVICE_IDS.WEB);
        await processPreKeyBundle(phoneStore, usAddr, {
            registrationId: item.registrationId,
            identityKey: base64ToAb(item.identityKey),
            signedPreKey: {
                keyId: item.signedPreKey.keyId,
                publicKey: base64ToAb(item.signedPreKey.publicKey),
                signature: base64ToAb(item.signedPreKey.signature),
            },
            preKey: { keyId: item.preKey.keyId, publicKey: base64ToAb(item.preKey.publicKey) },
        });
        const kb = Buffer.from(cloudPkcs8, "utf8");
        const ab = new ArrayBuffer(kb.length);
        new Uint8Array(ab).set(kb);
        const ct = await encryptMessage(phoneStore, usAddr, ab);
        const encryptedPrivateKey = concatTypeAndMessage(ct.type, ct.body);

        // The live transports, faked: the request captures the session, then the matching reply is delivered.
        let handler;
        const result = await receiveCloudKeyFromPhone({
            ownId,
            deviceName: "cli-box",
            sendRequest: (session) => {
                queueMicrotask(() =>
                    handler({
                        actType: "personal_cloud",
                        act: "pcloud_info",
                        data: {
                            session_id: session.sessionId,
                            device_name: session.deviceName,
                            user_action: 1,
                            key_version: 7,
                            public_key: "pub",
                            encrypted_private_key: encryptedPrivateKey,
                        },
                    }),
                );
            },
            subscribe: (h) => {
                handler = h;
                return () => {};
            },
            waitMs: 5_000,
        });

        assert.equal(result.stored, true);
        assert.equal(result.keyVersion, 7);
        // The decrypted key was sealed and matches, and the one-time pre-key was consumed and persisted.
        assert.equal(loadCloudKey(ownId).privateKeyPkcs8Base64, cloudPkcs8);
        assert.equal(loadE2eeDevice(ownId).store.preKeyCount(), 1);
    });
});
