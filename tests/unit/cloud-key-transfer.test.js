/**
 * Requesting the account's zCloud key from the phone (src/core/cloud-key-transfer.js): the request, the bounded wait
 * and the reply handling, run offline over injected transports. Every id and key is a throwaway made in this file.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { importCloudPrivateKey } from "../../src/zalo/zcloud-e2ee.js";
import {
    CloudKeyError,
    CloudKeyRefusedError,
    CloudKeyTimeoutError,
    CloudKeyUnsupportedError,
    cloudKeyRequest,
    isE2eeDeviceRegistered,
    matchesCloudKeySession,
    newCloudKeySession,
    readPcloudInfo,
    readPcloudReply,
    requestCloudKey,
    setupCloudKeyFromPhone,
} from "../../src/core/cloud-key-transfer.js";

/** A `pcloud_info` control for `session`, approving (action 1) or refusing (action 0). */
function pcloudInfo(session, { action, encryptedPrivateKey = "", keyVersion = 7, publicKey = "pub" } = {}) {
    return {
        actType: "personal_cloud",
        act: "pcloud_info",
        data: {
            session_id: session.sessionId,
            device_name: session.deviceName,
            user_action: action,
            key_version: keyVersion,
            public_key: publicKey,
            encrypted_private_key: encryptedPrivateKey,
        },
    };
}

describe("cloud-key transfer scaffolding", () => {
    it("builds a session and matches a reply on both ids", () => {
        const session = newCloudKeySession("cli-box");
        assert.equal(session.deviceName, "cli-box");
        assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
        assert.equal(matchesCloudKeySession(pcloudInfo(session, { action: 1 }), session), true);
        assert.equal(
            matchesCloudKeySession(pcloudInfo({ ...session, sessionId: "other" }, { action: 1 }), session),
            false,
        );
        assert.equal(
            matchesCloudKeySession(pcloudInfo({ ...session, deviceName: "other" }, { action: 1 }), session),
            false,
        );
        assert.equal(matchesCloudKeySession(null, session), false);
    });

    it("reads a pcloud_info control and ignores other controls", () => {
        const session = newCloudKeySession("cli-box");
        const info = readPcloudInfo(pcloudInfo(session, { action: 1, keyVersion: 9 }));
        assert.deepEqual(
            { userAction: info.userAction, keyVersion: info.keyVersion, publicKey: info.publicKey },
            { userAction: 1, keyVersion: 9, publicKey: "pub" },
        );
        assert.equal(readPcloudInfo({ actType: "personal_cloud", act: "pcloud_change_plan", data: {} }), null);
        assert.equal(readPcloudInfo({ actType: "hidden_chat", act: "reset" }), null);
        assert.equal(readPcloudInfo(null), null);
    });

    it("the request shape is for the key-transfer endpoint, not sent here", () => {
        const session = newCloudKeySession("cli-box");
        const req = cloudKeyRequest(session);
        assert.equal(req.path, "/personalcloud_key/req_cloud_key");
        assert.equal(req.sent, false);
        assert.deepEqual(req.params, { device_name: "cli-box", session_id: session.sessionId });
    });

    it("resolves with the key material when the phone approves", async () => {
        const session = newCloudKeySession("cli-box");
        let sent = 0;
        let prompted = 0;
        let handler;
        const p = requestCloudKey({
            session,
            sendRequest: async () => {
                sent += 1;
            },
            subscribe: (h) => {
                handler = h;
                return () => {};
            },
            unwrapPrivateKey: (enc) => `opened:${enc}`,
            onPrompt: () => {
                prompted += 1;
            },
            waitMs: 5_000,
        });
        await Promise.resolve();
        handler(pcloudInfo(session, { action: 1, encryptedPrivateKey: "CIPHER", keyVersion: 3 }));
        const res = await p;
        assert.deepEqual(res, { privateKeyPkcs8Base64: "opened:CIPHER", keyVersion: 3, publicKey: "pub" });
        assert.equal(sent, 1);
        assert.equal(prompted, 1);
    });

    it("readPcloudReply finds the key in the HTTP reply (direct and nested)", () => {
        assert.equal(readPcloudReply(null), null);
        assert.equal(readPcloudReply({ error_code: 0 }), null);
        const direct = readPcloudReply({ encrypted_private_key: "C", key_version: 5, public_key: "P" });
        assert.deepEqual(direct, { userAction: 1, keyVersion: 5, publicKey: "P", encryptedPrivateKey: "C" });
        const nested = readPcloudReply({
            data: { data: { user_action: 1, encrypted_private_key: "C2", key_version: 6 } },
        });
        assert.equal(nested.encryptedPrivateKey, "C2");
        assert.equal(nested.keyVersion, 6);
    });

    it("resolves from the request's own HTTP reply when it carries the key (no 601)", async () => {
        const session = newCloudKeySession("cli-box");
        const res = await requestCloudKey({
            session,
            // The server releases the key in the request's reply itself; no control is ever delivered.
            sendRequest: async () => ({
                data: { encrypted_private_key: "HTTPCIPHER", key_version: 9, public_key: "pub9" },
            }),
            subscribe: () => () => {},
            unwrapPrivateKey: (enc) => `opened:${enc}`,
            waitMs: 5_000,
        });
        assert.deepEqual(res, { privateKeyPkcs8Base64: "opened:HTTPCIPHER", keyVersion: 9, publicKey: "pub9" });
    });

    it("rejects with CloudKeyRefusedError when the phone refuses", async () => {
        const session = newCloudKeySession("cli-box");
        let handler;
        const p = requestCloudKey({
            session,
            sendRequest: async () => {},
            subscribe: (h) => {
                handler = h;
                return () => {};
            },
            unwrapPrivateKey: () => assert.fail("must not unwrap on a refusal"),
            waitMs: 5_000,
        });
        await Promise.resolve();
        handler(pcloudInfo(session, { action: 0 }));
        await assert.rejects(p, CloudKeyRefusedError);
    });

    it("times out after a bounded wait and re-sends the request maxRetry times", async () => {
        const session = newCloudKeySession("cli-box");
        let sent = 0;
        const p = requestCloudKey({
            session,
            sendRequest: async () => {
                sent += 1;
            },
            subscribe: () => () => {},
            unwrapPrivateKey: () => assert.fail("no reply, so no unwrap"),
            waitMs: 80,
            maxRetry: 3,
            retryGapMs: 5,
        });
        await assert.rejects(p, CloudKeyTimeoutError);
        assert.equal(sent, 3);
    });

    it("surfaces an unsupported unwrap after the phone approves", async () => {
        const session = newCloudKeySession("cli-box");
        let handler;
        const p = requestCloudKey({
            session,
            sendRequest: async () => {},
            subscribe: (h) => {
                handler = h;
                return () => {};
            },
            unwrapPrivateKey: () => {
                throw new CloudKeyUnsupportedError("needs an end-to-end-encryption device");
            },
            waitMs: 5_000,
        });
        await Promise.resolve();
        handler(pcloudInfo(session, { action: 1, encryptedPrivateKey: "CIPHER" }));
        await assert.rejects(p, CloudKeyUnsupportedError);
    });

    it("validates its dependencies", async () => {
        await assert.rejects(requestCloudKey({ session: newCloudKeySession("x") }), CloudKeyError);
    });

    it("decrypt round-trip: a working unwrap over a generated key pair yields a usable PKCS#8 key", async () => {
        // Stand in for the phone's reply: the account's throwaway cloud private key (PKCS#8 base64) sealed under a
        // symmetric session key, the way the end-to-end reply carries it. The scaffolding's unwrap boundary opens it,
        // and the key it returns must be a real RSA PKCS#8 key the rest of zcloud-e2ee.js accepts.
        const delivered = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const deliveredPkcs8 = delivered.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
        const sessionKey = randomBytes(32);
        const iv = randomBytes(12);
        const c = createCipheriv("aes-256-gcm", sessionKey, iv);
        const sealed = Buffer.concat([c.update(Buffer.from(deliveredPkcs8, "utf8")), c.final()]);
        const wrapped = Buffer.concat([iv, c.getAuthTag(), sealed]).toString("base64");

        const session = newCloudKeySession("cli-box");
        let handler;
        const p = requestCloudKey({
            session,
            sendRequest: async () => {},
            subscribe: (h) => {
                handler = h;
                return () => {};
            },
            unwrapPrivateKey: (enc) => {
                const buf = Buffer.from(String(enc), "base64");
                const d = createDecipheriv("aes-256-gcm", sessionKey, buf.subarray(0, 12));
                d.setAuthTag(buf.subarray(12, 28));
                return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
            },
            waitMs: 5_000,
        });
        await Promise.resolve();
        handler(pcloudInfo(session, { action: 1, encryptedPrivateKey: wrapped }));
        const res = await p;
        assert.equal(res.privateKeyPkcs8Base64, deliveredPkcs8);
        // The key the scaffolding handed back is a real RSA private key the download path can use.
        assert.equal(importCloudPrivateKey(res.privateKeyPkcs8Base64).asymmetricKeyType, "rsa");
    });
});

describe("cloud-key transfer: live entry is gated", () => {
    it("has no end-to-end-encryption device registered", () => {
        assert.equal(isE2eeDeviceRegistered(), false);
    });

    it("refuses with a clear unsupported error and does not tap the phone", async () => {
        await assert.rejects(setupCloudKeyFromPhone({ deviceName: "cli-box" }), (e) => {
            assert.ok(e instanceof CloudKeyUnsupportedError);
            assert.match(e.message, /end-to-end-encryption device/);
            assert.match(e.message, /--key-stdin|--key-prompt/);
            return true;
        });
    });

    it("keeps the test home sandboxed", () => {
        assertSandboxed(SANDBOX_CONFIG_DIR);
    });
});
