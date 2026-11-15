/**
 * Known-answer vectors for the in-house Signal slice (src/zalo/e2ee/signal-protocol.js, curve.js) under Zalo's KDF
 * labels. They were captured from interop runs against an independent Signal implementation driven with the same
 * randomness: every message below came out byte-identical from both, and each side decrypted the other's. Every key
 * here is a throwaway derived from a seed string in this file (no real account, device or key).
 *
 * What would turn these red: a changed KDF label, HKDF/chain-key step, MAC layout, protobuf field order, X3DH
 * agreement order, ratchet step, or XEdDSA verification — each changes or breaks the bytes compared here.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    MessageCounterError,
    ZALO_KDF_LABELS,
    decryptPreKeyWhisperMessage,
    decryptWhisperMessage,
    encodeAddress,
    encryptMessage,
    processPreKeyBundle,
} from "../../src/zalo/e2ee/signal-protocol.js";
import { generateKeyPair, xeddsaSign, xeddsaVerify } from "../../src/zalo/e2ee/curve.js";
import { SignalProtocolStore } from "../../src/zalo/e2ee/signal-store.js";
import { concatTypeAndMessage } from "../../src/zalo/e2ee/transport-tag.js";
import { decryptCloudKeyReply } from "../../src/zalo/e2ee/cloud-key-decrypt.js";

const UID = "7000000000000000001";
const PEER = encodeAddress(UID, 0);
const b = (text) => new Uint8Array(Buffer.from(text, "base64"));
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const utf8 = (text) => new Uint8Array(Buffer.from(text, "utf8"));
const txt = (bytes) => Buffer.from(bytes).toString("utf8");

/** A deterministic byte stream: SHA-256 of `${label}:${counter}`, concatenated. */
function seeded(label) {
    let ctr = 0;
    let buf = Buffer.alloc(0);
    return (n) => {
        while (buf.length < n) buf = Buffer.concat([buf, createHash("sha256").update(`${label}:${ctr++}`).digest()]);
        const out = Uint8Array.from(buf.subarray(0, n));
        buf = buf.subarray(n);
        return out;
    };
}

/** One party's keys from a seed (identity, signed pre-key 5001, one-time pre-key 100), in a fresh store. */
function party(seed, signature) {
    const r = seeded(seed);
    const id = generateKeyPair(r(32));
    const spk = generateKeyPair(r(32));
    const opk = generateKeyPair(r(32));
    const registrationId = 1234 + (r(1)[0] & 0x3f);
    const sig = signature ?? xeddsaSign(id.privKey, spk.pubKey, seeded(`${seed}:z`));
    const store = new SignalProtocolStore();
    store.setIdentity(id, registrationId);
    store.addSignedPreKey(5001, spk, sig);
    store.addPreKey(100, opk);
    const bundle = {
        registrationId,
        identityKey: id.pubKey,
        signedPreKey: { keyId: 5001, publicKey: spk.pubKey, signature: sig },
        preKey: { keyId: 100, publicKey: opk.pubKey },
    };
    return { store, bundle, signature: sig };
}

const SIGNATURES = {
    ours: {
        key: "sigkey0",
        msg: "sigmsg0",
        z: "z0",
        sig: "beK7ONYttqhXcQ/vUFoAIRnjq82HZ2OwunyL0KDJg14HWNV3Wy2F7xGta8Tdyh7zqN+j7oLrOjEitmrOcaIxDw==",
    },
    // Signed by the other implementation: one records the Edwards sign bit in the signature's top bit, one does not.
    theirsTopBitSet: {
        key: "sigkey0",
        msg: "sigmsg0",
        sig: "IQIxtSa1Es0FzkGHEeKhA3ZVd7n03ETI3I+6YdIhDaGkrrqqP1vvx2TGZ6y8GoDbvfCDXEChBatZCUJS4a1ohQ==",
    },
    theirsTopBitClear: {
        key: "sigkey1",
        msg: "sigmsg1",
        sig: "JAcgR7UJYnLwtUBO4ieRXp32ItWAPriYI2+IAwyaNzwVsoYFd2Mq45FKrfsqLco6PdupLFwaUlNEI1sXKlD2Cw==",
    },
};

const INITIATOR = {
    us: "alice-1",
    phone: "bob-1",
    phoneSignature: "Xt5H4ChBYpBKw64tNU5ivBByQslipof4Fs6CFlSxR+kMpB3F0TyztYX8huMx/pEtAp0atexwuTREDhYZpsZ9Dg==",
    sessionRandom: "alice-1:session",
    recvRandom: "alice-1:recv",
    preKeyMessage:
        "MyjmCQhkMIknEiEFFCB+Fa+B4WedFEPQu+4/AmDbsYOkG97VVOwIM/85zgMaIQVjWGcRICmVBX8kKbMezKvM7hgpKryCA7oabX2ksfiIACJS" +
        "MwohBXsMUhKtcdIDJcgBE0Tv6z4fXa+JzVerHL5cMCx0t0NFEAAYACIgycwMVZIOWWfg0/vcqxTLNfk7ZzbXAtWFyjy26/d6aFCRsSWCWfuctQ==",
    replies: [
        "MwohBWS/be+VuZt0APuj5WG9rhfzHR7jjBo4QHYYQXgHQYVrEAAYACIQvUSpI+3NGhtZYBJzO6Yk2tz2X1r+7SK8",
        "MwohBWS/be+VuZt0APuj5WG9rhfzHR7jjBo4QHYYQXgHQYVrEAEYACIQBwhKpiFbeYkngqYixlOqFpUARzcgTwJO",
        "MwohBWS/be+VuZt0APuj5WG9rhfzHR7jjBo4QHYYQXgHQYVrEAIYACIQzwFIlQEdE1q2UPFh4sL4qbMZ2Tn0vYe6",
    ],
    replyPlaintexts: ["KEY-1", "KEY-2", "KEY-3"],
};

const RESPONDER = {
    withOneTimePreKey: {
        us: "us-opk",
        usSignature: "8UMG92KfPFe+A/ekrNoiID4dKPDXXXYhPxptZDb9KHixh76vb8AS9p4tBNdGZoeQSN4eQss2B27LRXKFhlPJAQ==",
        recvRandom: "us-opk:recv",
        preKeyMessage:
            "Myj3CQhkMIknEiEFsw1Ta3OT0xEuKB204W2MvWT91p2AkL5PCZk2ufm57HEaIQUsIb7aLBPXkJtpF09d9RHmrifjlDQgyv/6C7Cl4VFz" +
            "DyJCMwohBaHD9et1Sebey/qI/h8/lAUW0TlEM+ugTFkbIXpvihFPEAAYACIQpS/6Tzik8xOda36YUzYNk3z8XFbNgUfT",
        reply: "MwohBcnOEZ/yzRFdysDM6/mlWdqPRGz5VZ7HC26XOmy4oCdgEAAYACIQFo6iKKwx1jC5eQ9crD5Wr3WzGAZIOyfP",
        oneTimeLeft: 0,
    },
    withoutOneTimePreKey: {
        us: "us-noopk",
        usSignature: "Aow0tmQdL3Q1EgWg2JO3eicjuhFJx5YZCPpz9u+DVovDgY7txmWNpSci0S5l85sUVjlVRiVqm7CFbvFufv1aCg==",
        recvRandom: "us-noopk:recv",
        preKeyMessage:
            "Myj9CQgAMIknEiEFDbUyPU8yD+qsnIQv7HlVy3riiELhVIBnFQvxA+JX0noaIQXTlf2FMPavmO/ivaCDE3YFsqlh2Ef153lu076gYOiA" +
            "cSJCMwohBayZOCgz96uIDeVywa7hEq5L5TyBNe3JE8L8z76JrCBREAAYACIQ80FhJq4Us/X1zH/aP50n85Nmt8BW0WHa",
        reply: "MwohBYsVD9nTARe/NXWtO+IpEzZf89I8gYtKsmBKkyn7FDomEAAYACIQrQ4fqjnSs4K4xZx0+ap1RjL1OBHXQG/h",
        oneTimeLeft: 1,
    },
};

describe("e2ee signal vectors — sandbox", () => {
    it("runs inside the test sandbox", () => assertSandboxed(SANDBOX_CONFIG_DIR));
});

describe("Zalo's key-derivation labels", () => {
    it("replace the three standard labels", () => {
        assert.deepEqual(
            { ...ZALO_KDF_LABELS },
            { WhisperText: "ZaloText", WhisperRatchet: "ZaloRatchet", WhisperMessageKeys: "ZaloMessageKeys" },
        );
    });
});

describe("XEdDSA signatures", () => {
    const keyOf = (seed) => generateKeyPair(seeded(seed)(32));
    const msgOf = (seed) => seeded(seed)(33);

    it("signs deterministically for a given nonce input, and the signature verifies", () => {
        const v = SIGNATURES.ours;
        const k = keyOf(v.key);
        const sig = xeddsaSign(k.privKey, msgOf(v.msg), seeded(v.z));
        assert.equal(b64(sig), v.sig);
        assert.equal(sig[63] & 0x80, 0, "XEdDSA signatures keep the top bit clear");
        assert.ok(xeddsaVerify(k.pubKey, msgOf(v.msg), sig));
    });

    for (const name of ["theirsTopBitSet", "theirsTopBitClear"]) {
        it(`verifies another implementation's signature (${name}) and rejects it tampered or on another key`, () => {
            const v = SIGNATURES[name];
            const k = keyOf(v.key);
            const sig = b(v.sig);
            assert.equal(Boolean(sig[63] & 0x80), name === "theirsTopBitSet");
            assert.ok(xeddsaVerify(k.pubKey, msgOf(v.msg), sig));
            const flipped = Uint8Array.from(sig);
            flipped[63] ^= 0x80;
            assert.ok(!xeddsaVerify(k.pubKey, msgOf(v.msg), flipped), "the sign bit is part of the signature");
            const bent = Uint8Array.from(sig);
            bent[7] ^= 1;
            assert.ok(!xeddsaVerify(k.pubKey, msgOf(v.msg), bent));
            assert.ok(!xeddsaVerify(keyOf("another-key").pubKey, msgOf(v.msg), sig));
        });
    }

    it("rejects malformed keys and signatures instead of throwing", () => {
        const k = keyOf("sigkey0");
        assert.equal(xeddsaVerify(k.pubKey.subarray(1), new Uint8Array(1), new Uint8Array(64)), false);
        assert.equal(xeddsaVerify(k.pubKey, new Uint8Array(1), new Uint8Array(63)), false);
    });
});

describe("as the initiator (our device opens the session to the phone)", () => {
    async function opened() {
        const us = party(INITIATOR.us);
        const phone = party(INITIATOR.phone, b(INITIATOR.phoneSignature));
        await processPreKeyBundle(us.store, PEER, phone.bundle, { random: seeded(INITIATOR.sessionRandom) });
        return { us, phone };
    }

    it("produces the exact pre-key message for the init plaintext", async () => {
        const { us } = await opened();
        const out = await encryptMessage(us.store, PEER, utf8('{"subDevice":[]}'));
        assert.equal(out.type, 3);
        assert.equal(b64(out.body), INITIATOR.preKeyMessage);
    });

    it("decrypts the phone's type-2 replies on that session, out of order, and refuses a replay", async () => {
        const { us } = await opened();
        await encryptMessage(us.store, PEER, utf8('{"subDevice":[]}'));
        const r = INITIATOR.replies.map(b);
        const opts = { random: seeded(INITIATOR.recvRandom) };
        assert.equal(txt(await decryptWhisperMessage(us.store, PEER, r[2], opts)), "KEY-3");
        assert.equal(txt(await decryptWhisperMessage(us.store, PEER, r[0])), "KEY-1");
        assert.equal(txt(await decryptWhisperMessage(us.store, PEER, r[1])), "KEY-2");
        await assert.rejects(decryptWhisperMessage(us.store, PEER, r[1]), MessageCounterError);
        // After the reply our next message is a normal one on the ratcheted session.
        assert.equal((await encryptMessage(us.store, PEER, utf8("ACK"))).type, 2);
    });

    it("the live path: a type-2 cloud-key reply opens through decryptCloudKeyReply, after a store reload", async () => {
        const { us } = await opened();
        await encryptMessage(us.store, PEER, utf8('{"subDevice":[]}'));
        const reloaded = SignalProtocolStore.fromJSON(JSON.parse(JSON.stringify(us.store.toJSON())));
        const opened2 = await decryptCloudKeyReply({
            store: reloaded,
            encryptedPrivateKey: concatTypeAndMessage(2, b(INITIATOR.replies[0])),
            ownUid: UID,
        });
        assert.equal(opened2, INITIATOR.replyPlaintexts[0]);
    });

    it("a reply with a bent MAC fails and leaves the session as it was", async () => {
        const { us } = await opened();
        await encryptMessage(us.store, PEER, utf8('{"subDevice":[]}'));
        const before = await us.store.loadSession(PEER);
        const bent = b(INITIATOR.replies[0]);
        bent[bent.length - 1] ^= 1;
        await assert.rejects(decryptWhisperMessage(us.store, PEER, bent), /MAC/);
        assert.equal(await us.store.loadSession(PEER), before);
        assert.equal(txt(await decryptWhisperMessage(us.store, PEER, b(INITIATOR.replies[0]))), "KEY-1");
    });

    it("refuses a bundle whose signed pre-key signature does not verify", async () => {
        const us = party(INITIATOR.us);
        const sig = b(INITIATOR.phoneSignature);
        sig[10] ^= 0x40;
        const phone = party(INITIATOR.phone, sig);
        await assert.rejects(processPreKeyBundle(us.store, PEER, phone.bundle), /signature/);
        assert.equal(await us.store.loadSession(PEER), undefined);
    });
});

describe("as the responder (the phone opens the session with a pre-key message)", () => {
    for (const [name, v] of Object.entries(RESPONDER)) {
        it(`decrypts the phone's pre-key message and answers byte-exactly (${name})`, async () => {
            const us = party(v.us);
            assert.equal(b64(us.signature), v.usSignature);
            const plain = await decryptPreKeyWhisperMessage(us.store, PEER, b(v.preKeyMessage), {
                random: seeded(v.recvRandom),
            });
            assert.equal(txt(plain), "CLOUD-KEY-PKCS8");
            assert.equal(us.store.preKeyCount(), v.oneTimeLeft, "the one-time pre-key is consumed only when used");
            const reply = await encryptMessage(us.store, PEER, utf8("THANKS"));
            assert.equal(reply.type, 2);
            assert.equal(b64(reply.body), v.reply);
            await assert.rejects(
                decryptPreKeyWhisperMessage(us.store, PEER, b(v.preKeyMessage)),
                MessageCounterError,
                "a redelivered pre-key message is a duplicate",
            );
        });
    }

    it("the cloud-key path opens the tagged pre-key message", async () => {
        const v = RESPONDER.withOneTimePreKey;
        const us = party(v.us);
        const out = await decryptCloudKeyReply({
            store: us.store,
            encryptedPrivateKey: concatTypeAndMessage(3, b(v.preKeyMessage)),
            ownUid: UID,
        });
        assert.equal(out, "CLOUD-KEY-PKCS8");
        assert.equal(us.store.preKeyCount(), 0);
    });

    it("fails without the signed pre-key and changes nothing", async () => {
        const v = RESPONDER.withOneTimePreKey;
        const us = party(v.us);
        await us.store.removeSignedPreKey(5001);
        await assert.rejects(decryptPreKeyWhisperMessage(us.store, PEER, b(v.preKeyMessage)), /signed pre-key/);
        assert.equal(us.store.preKeyCount(), 1);
        assert.equal(await us.store.loadSession(PEER), undefined);
    });
});

describe("archived sessions", () => {
    it("a reply on an older session we opened still decrypts, and that session becomes the open one", async () => {
        const us = party("arch-us");
        const phone = party("arch-phone");
        const usAddr = encodeAddress(UID, 1);
        // Both sides are this implementation here; the cross-implementation version of this flow was part of the
        // interop run that produced the vectors above.
        await processPreKeyBundle(us.store, PEER, { ...phone.bundle, preKey: undefined });
        const first = await encryptMessage(us.store, PEER, utf8("first"));
        assert.equal(txt(await decryptPreKeyWhisperMessage(phone.store, usAddr, first.body)), "first");
        await processPreKeyBundle(us.store, PEER, { ...phone.bundle, preKey: undefined });
        const reply = await encryptMessage(phone.store, usAddr, utf8("on-old-session"));
        assert.equal(txt(await decryptWhisperMessage(us.store, PEER, reply.body)), "on-old-session");
        const record = JSON.parse(await us.store.loadSession(PEER));
        const sessions = Object.values(record.sessions);
        assert.equal(sessions.length, 2);
        assert.equal(sessions.filter((s) => s.indexInfo.closed === -1).length, 1);
    });
});
