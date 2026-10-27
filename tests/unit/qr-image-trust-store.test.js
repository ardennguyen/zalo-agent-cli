/**
 * The two small pieces of the trusted-device login that touch no network: the second QR as a PNG
 * (src/zalo/qr-image.js) and the device identity kept between logins (src/zalo/trust-store.js).
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import qrcode from "qrcode-generator";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { errorLevelFor, qrPng } from "../../src/zalo/qr-image.js";
import { TRUST_FILE, createTrustStore } from "../../src/zalo/trust-store.js";

/** The pixels of a grayscale PNG this module wrote: {size, at(x, y) => 0..255}. */
function decodePng(png) {
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let offset = 8;
    let size = 0;
    const idat = [];
    const types = [];
    while (offset < png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.subarray(offset + 4, offset + 8).toString("ascii");
        const body = png.subarray(offset + 8, offset + 8 + length);
        types.push(type);
        if (type === "IHDR") {
            size = body.readUInt32BE(0);
            assert.equal(body.readUInt32BE(4), size, "square");
            assert.equal(body[8], 8, "8 bits");
            assert.equal(body[9], 0, "grayscale");
        }
        if (type === "IDAT") idat.push(body);
        offset += length + 12;
    }
    assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
    const raw = inflateSync(Buffer.concat(idat));
    assert.equal(raw.length, (size + 1) * size, "one filter byte and `size` pixels per row");
    return { size, at: (x, y) => raw[y * (size + 1) + 1 + x] };
}

describe("the second QR as a PNG", () => {
    const text = "Z1@5(8c_08:YO)#q]raNo~D2i~RR2W<mCLUBD}(ONGJ{G4qiX>pp]BQ}_j{gL(oygfDP,/qF.V##~Dlmu5>s}<OX;BY3ZciKw";

    it("draws exactly the modules a QR encoder makes for the text, in 8-pixel squares inside a 4-module quiet zone", () => {
        const { size, at } = decodePng(qrPng(text));
        const qr = qrcode(0, errorLevelFor(text));
        qr.addData(text, "Byte");
        qr.make();
        const modules = qr.getModuleCount();
        assert.equal(size, (modules + 8) * 8);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const my = Math.floor(y / 8) - 4;
                const mx = Math.floor(x / 8) - 4;
                const dark = my >= 0 && my < modules && mx >= 0 && mx < modules && qr.isDark(my, mx);
                assert.equal(at(x, y), dark ? 0 : 255, `pixel ${x},${y}`);
            }
        }
    });

    it("has a white quiet zone and a dark finder corner", () => {
        const { size, at } = decodePng(qrPng(text, { scale: 3 }));
        for (let i = 0; i < size; i++) assert.equal(at(i, 0), 255, "top row is margin");
        assert.equal(at(4 * 3, 4 * 3), 0, "the first module of the finder pattern is dark");
    });

    it("uses the page's error correction: H below 150 characters, M from 150 on", () => {
        assert.equal(errorLevelFor("x".repeat(149)), "H");
        assert.equal(errorLevelFor("x".repeat(150)), "M");
        assert.notDeepEqual(qrPng("x".repeat(149)), qrPng("x".repeat(150)));
    });

    it("scales: the same code at another scale has the same modules", () => {
        const small = decodePng(qrPng(text, { scale: 2 }));
        const big = decodePng(qrPng(text, { scale: 6 }));
        const modules = small.size / 2;
        assert.equal(big.size, modules * 6);
        for (let my = 0; my < modules; my++) {
            for (let mx = 0; mx < modules; mx++) assert.equal(big.at(mx * 6, my * 6), small.at(mx * 2, my * 2));
        }
    });
});

describe("the device identity store", () => {
    let dir;
    const dirOf = (uid) => join(dir, String(uid));
    const bytes = (...v) => new Uint8Array(v);
    const record = (extra = {}) => ({
        uid: "fake-uid-1",
        masterId: "fake-master-1",
        companionId: 4,
        linkId: "10000000000000000001",
        linkingTimestamp: 1700000000000,
        publicKey: bytes(1, 2, 3),
        privateKey: bytes(4, 5, 6),
        linkingSecret: bytes(7, 8, 9),
        primaryPublicIdentityKey: bytes(10, 11),
        devices: { masterId: "fake-master-1", companions: [] },
        ...extra,
    });

    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        mkdirSync(CONFIG_DIR, { recursive: true });
        dir = mkdtempSync(join(CONFIG_DIR, "trust-"));
    });

    after(() => rmSync(dir, { recursive: true, force: true }));

    it("keeps an identity and gives it back as bytes", () => {
        const store = createTrustStore(dirOf);
        assert.equal(store.save(record()), true);
        const got = store.load("fake-uid-1", "fake-master-1");
        assert.ok(got.publicKey instanceof Uint8Array);
        assert.deepEqual([...got.publicKey], [1, 2, 3]);
        assert.deepEqual([...got.privateKey], [4, 5, 6]);
        assert.deepEqual([...got.linkingSecret], [7, 8, 9]);
        assert.deepEqual([...got.primaryPublicIdentityKey], [10, 11]);
        assert.equal(got.linkId, "10000000000000000001", "a 64-bit id stays a string");
        assert.equal(got.companionId, 4);
        assert.equal(got.linkingTimestamp, 1700000000000);
        assert.deepEqual(got.devices, { masterId: "fake-master-1", companions: [] });
    });

    it("lives in the account's directory, as a secret: readable by its owner only", () => {
        const store = createTrustStore(dirOf);
        store.save(record({ uid: "fake-uid-2" }));
        const file = join(dirOf("fake-uid-2"), TRUST_FILE);
        assert.ok(readFileSync(file, "utf8").includes('"version":1'));
        if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0, "no group or other access");
    });

    it("gives nothing for another master (the phone side was reset), another account, or no file", () => {
        const store = createTrustStore(dirOf);
        store.save(record({ uid: "fake-uid-3", masterId: "fake-master-3" }));
        assert.equal(store.load("fake-uid-3", "another-master"), null);
        assert.notEqual(store.load("fake-uid-3", "fake-master-3"), null);
        assert.notEqual(store.load("fake-uid-3"), null, "without a master to check, the saved one");
        assert.equal(store.load("fake-uid-never"), null);
        // a file copied under another account's name is not that account's identity
        mkdirSync(dirOf("fake-uid-4"), { recursive: true });
        writeFileSync(join(dirOf("fake-uid-4"), TRUST_FILE), readFileSync(join(dirOf("fake-uid-3"), TRUST_FILE)));
        assert.equal(store.load("fake-uid-4"), null);
    });

    it("treats a damaged or unknown-version file as no identity, never as a crash", () => {
        const store = createTrustStore(dirOf);
        mkdirSync(dirOf("fake-uid-5"), { recursive: true });
        writeFileSync(join(dirOf("fake-uid-5"), TRUST_FILE), "{not json");
        assert.equal(store.load("fake-uid-5"), null);
        writeFileSync(join(dirOf("fake-uid-5"), TRUST_FILE), JSON.stringify({ version: 2, uid: "fake-uid-5" }));
        assert.equal(store.load("fake-uid-5"), null);
    });

    it("forgets an identity, and says whether there was one", () => {
        const store = createTrustStore(dirOf);
        store.save(record({ uid: "fake-uid-6" }));
        assert.equal(store.clear("fake-uid-6"), true);
        assert.equal(store.load("fake-uid-6"), null);
        assert.equal(store.clear("fake-uid-6"), false);
    });

    it("reports a failed write instead of throwing", () => {
        const store = createTrustStore(() => join(dir, "fake-uid-1", TRUST_FILE, "not-a-directory"));
        assert.equal(store.save(record({ uid: "fake-uid-7" })), false);
    });
});
