/**
 * Opening a zCloud item as Zalo Web does (src/zalo/zcloud-e2ee.js, `fetchCloudBlob` in src/zalo/zcloud.js): the
 * download address and header, and the cloud key's crypto (RSA-OAEP SHA-256 unwrap, AES-256-GCM with a packed
 * key | IV | tag). Read from the Web bundle of 2026-11-06; nothing here was seen working live (ZP-10, D8).
 *
 * The key pair is made fresh per run and the items are encrypted here the way the Web's `encryptCloudInfo` does, so
 * the assertions are about the scheme, not about any real item. Every id and key is a throwaway.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { constants, createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes } from "node:crypto";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    CloudKeyError,
    cloudBlobRequest,
    cloudKeyRequestShape,
    decryptCloudBlob,
    decryptCloudInfo,
    importCloudPrivateKey,
    unwrapCloudKey,
} from "../../src/zalo/zcloud-e2ee.js";
import * as zcloud from "../../src/zalo/zcloud.js";
import { encryptZCloud, decryptZCloud } from "../../src/zalo/kernel/zcloud-cipher.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const OTHER = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "der", type: "pkcs8" });

/** Encrypt as the Web's `encryptCloudInfo`: a fresh AES-256-GCM key, the packed key wrapped with RSA-OAEP SHA-256. */
function seal(plainBytes) {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update(plainBytes), c.final()]);
    const packed = Buffer.concat([key, iv, c.getAuthTag()]);
    const wrapped = publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        packed,
    );
    return { data, wrapped: wrapped.toString("base64") };
}

describe("zcloud-e2ee: sandbox", () => {
    it("runs inside the test sandbox", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });
});

describe("the download address the Web's download layer sends", () => {
    it("adds ?zcloudurl=true and the `&` the cut leaves for a keyed item, and only the viewer-key header", () => {
        const r = cloudBlobRequest({
            downloadUrl: "https://cdn.zalo.invalid/blob/1",
            encryptInfo: { encryptKey: "wrapped==", algoVersion: 1 },
            viewerKey: "vk-test",
        });
        // Red if the bare URL (the one that answered 404 live) were fetched again, or the wrapped key left the process.
        assert.equal(r.url, "https://cdn.zalo.invalid/blob/1?zcloudurl=true&");
        assert.deepEqual(r.headers, { "cloud-viewer-key": "vk-test" });
        assert.doesNotMatch(r.url, /pcloudsession|wrapped/);
        assert.deepEqual([r.encrypted, r.wrappedKey, r.algoVersion], [true, "wrapped==", "1"]);
    });

    it("an item of a cloud-type conversation, or one without a key, is fetched plain", () => {
        const csc = cloudBlobRequest({
            downloadUrl: "https://cdn.zalo.invalid/b",
            encryptInfo: { encryptKey: "k" },
            viewerKey: "v",
            cloudConversation: true,
        });
        assert.equal(csc.url, "https://cdn.zalo.invalid/b?zcloudurl=true");
        assert.equal(csc.encrypted, false);
        assert.equal(cloudBlobRequest({ downloadUrl: "https://x.invalid/b", viewerKey: "v" }).encrypted, false);
    });

    it("names the Web's own errors for a missing URL or header", () => {
        assert.throws(() => cloudBlobRequest({ viewerKey: "v" }), /NOT_FOUND_DOWNLOAD_URL/);
        assert.throws(() => cloudBlobRequest({ downloadUrl: "https://x.invalid" }), /NOT_FOUND_DOWNLOAD_HEADER/);
    });
});

describe("the cloud key: RSA-OAEP SHA-256, then AES-256-GCM", () => {
    it("opens an item's file-name metadata (decryptCloudInfo)", () => {
        const { data, wrapped } = seal(Buffer.from(JSON.stringify({ name: "report.pdf", ext: "pdf" })));
        const meta = decryptCloudInfo(data.toString("base64"), wrapped, importCloudPrivateKey(PKCS8));
        assert.deepEqual(meta, { name: "report.pdf", ext: "pdf" });
    });

    it("opens a linear blob (algoversion 1, or none) to its exact bytes", () => {
        const file = randomBytes(5000);
        const { data, wrapped } = seal(file);
        const key = importCloudPrivateKey(PKCS8);
        assert.ok(decryptCloudBlob(data, wrapped, "1", key).equals(file));
        assert.ok(decryptCloudBlob(data, wrapped, null, key).equals(file));
    });

    it("takes the key as base64 PKCS#8 with or without PEM armor and whitespace", () => {
        const pem = `-----BEGIN PRIVATE KEY-----\n${PKCS8.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
        assert.equal(importCloudPrivateKey(pem).asymmetricKeyType, "rsa");
    });

    it("refuses another account's key, a tampered blob, a non-key and the block version, with words, not a crash", () => {
        const { data, wrapped } = seal(Buffer.from("x"));
        assert.throws(() => unwrapCloudKey(wrapped, importCloudPrivateKey(OTHER.toString("base64"))), CloudKeyError);
        const bad = Buffer.from(data);
        bad[0] ^= 1;
        assert.throws(() => decryptCloudBlob(bad, wrapped, 1, importCloudPrivateKey(PKCS8)), /GCM tag/);
        assert.throws(() => importCloudPrivateKey("not a key"), /PKCS#8/);
        assert.throws(() => importCloudPrivateKey(""), /no cloud key/);
        assert.throws(() => decryptCloudBlob(data, wrapped, 2, importCloudPrivateKey(PKCS8)), /block by block/);
    });

    it("builds the key request the Web sends, and marks it never sent", () => {
        assert.deepEqual(cloudKeyRequestShape({ deviceName: "cli", sessionId: "s1" }), {
            host: "zcloud",
            path: "/personalcloud_key/req_cloud_key",
            method: "GET",
            params: { device_name: "cli", session_id: "s1" },
            sent: false,
        });
    });
});

describe("fetchCloudBlob: the whole open, offline", () => {
    const ENK = Buffer.alloc(32, 0x5a).toString("base64");
    const OWN = "1000000000000000001";
    let calls;
    let api;

    beforeEach(() => {
        zcloud.configureZCloudRetry({ delaysMs: [0, 0, 0, 0] });
        zcloud.configureZCloudDownloads({ windowMs: 0, cacheMs: 0 });
        calls = [];
        const ctx = {
            secretKey: Buffer.alloc(16, 0x11).toString("base64"),
            imei: "test-imei",
            userAgent: "offline-test",
            uid: OWN,
            API_VERSION: 694,
            API_TYPE: 30,
            loginInfo: { zcloud: { viewer_key: "vk-login", enk: ENK } },
            options: {
                async polyfill(url) {
                    const u = new URL(url);
                    calls.push(u.pathname);
                    const ids = JSON.parse(decryptZCloud(u.searchParams.get("params"), ENK)).list_noise_ids;
                    const payload = {
                        download_urls: Object.fromEntries(ids.map((id) => [id, `https://cdn.invalid/${id}`])),
                    };
                    const body = {
                        error_code: 0,
                        error_message: "",
                        data: encryptZCloud(JSON.stringify(payload), ENK),
                    };
                    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
                },
            },
        };
        api = { zpwServiceMap: { zcloud: ["https://zcld.invalid"] }, getContext: () => ctx, getOwnId: () => OWN };
    });

    it("asks for the URL, then GETs it as the Web does, and returns the encrypted bytes untouched", async () => {
        const { data, wrapped } = seal(Buffer.from("the file"));
        const seen = [];
        const blob = await zcloud.fetchCloudBlob(
            api,
            { noiseId: "nz-1", encryptInfo: { encryptKey: wrapped, algoVersion: 1 } },
            {
                fetch: async (url, init) => {
                    seen.push({ url, init });
                    return {
                        ok: true,
                        status: 200,
                        headers: { get: () => "application/octet-stream" },
                        arrayBuffer: async () => data,
                    };
                },
            },
        );
        assert.deepEqual(calls, ["/cloudmedia/downloadurls/pc/v1"]);
        assert.equal(seen[0].url, "https://cdn.invalid/nz-1?zcloudurl=true&");
        assert.deepEqual(seen[0].init.headers, { "cloud-viewer-key": "vk-login" });
        assert.equal(blob.encrypted, true);
        assert.ok(blob.bytes.equals(data));
        assert.equal(
            decryptCloudBlob(blob.bytes, blob.wrappedKey, blob.algoVersion, importCloudPrivateKey(PKCS8)).toString(),
            "the file",
        );
    });

    it("an HTTP failure is a zCloud error carrying the status", async () => {
        const fail = { fetch: async () => ({ ok: false, status: 404, headers: { get: () => null } }) };
        await assert.rejects(zcloud.fetchCloudBlob(api, { noiseId: "nz-2" }, fail), (e) => {
            assert.equal(e.name, "ZCloudError");
            assert.equal(e.code, 404);
            assert.equal(e.http, true);
            return true;
        });
    });
});
