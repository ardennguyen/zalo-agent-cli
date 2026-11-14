/**
 * The loader of the page's trusted-device module (src/zalo/trust-wasm.js).
 *
 * The module is Zalo's and is not shipped here, so the calls themselves run only when a copy is given
 * (`ZALO_TRUST_WASM=<path to libzproto_wasm_bg.<hash>.wasm>`, saved from the login page); without it those tests are
 * skipped and say so. What always runs is the part that finds the file the page names.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { TRUST_PLATFORM_WEB, loadTrustWasm, wasmUrlOf } from "../../src/zalo/trust-wasm.js";

const WASM_PATH = process.env.ZALO_TRUST_WASM;
const have = Boolean(WASM_PATH && existsSync(WASM_PATH));
const real = (name, fn) => it(name, { skip: have ? false : "set ZALO_TRUST_WASM to the page's wasm to run" }, fn);

describe("finding the module the login page names", () => {
    const URL = "https://stc-zlogin.zdn.vn/wasm/libzproto_wasm_bg.5cbb393d0d5445d22eb1c70924a16c48.wasm";

    it("reads the wasm URL out of the script text, wherever it sits", () => {
        assert.equal(wasmUrlOf(`var a=['x','${URL}','y'];`), URL);
        assert.equal(wasmUrlOf(`fetch("${URL}")`), URL);
    });

    it("answers null for a script that names none, or names another host or file", () => {
        assert.equal(wasmUrlOf("var a=1;"), null);
        assert.equal(wasmUrlOf(undefined), null);
        assert.equal(wasmUrlOf("https://evil.invalid/wasm/libzproto_wasm_bg.5cbb.wasm"), null, "only the login CDN");
        assert.equal(wasmUrlOf("https://stc-zlogin.zdn.vn/wasm/other.5cbb.wasm"), null, "only the trust module");
    });

    it("refuses bytes that are not a module", async () => {
        await assert.rejects(loadTrustWasm(new Uint8Array([1, 2, 3, 4])));
    });
});

describe("the trusted-device calls, on the real module", () => {
    const load = () => loadTrustWasm(readFileSync(WASM_PATH));

    real("makes a 33-byte public key, a 32-byte private key and a 32-byte linking secret", async () => {
        const trust = await load();
        const id = trust.generateIdentity();
        assert.equal(id.publicKey.length, 33);
        assert.equal(id.privateKey.length, 32);
        assert.equal(trust.generateLinkingSecret().length, 32);
        const other = trust.generateIdentity();
        assert.notDeepEqual([...id.privateKey], [...other.privateKey], "random each time");
    });

    real("makes the text of a linking QR, and again on a second call", async () => {
        const trust = await load();
        const id = trust.generateIdentity();
        const secret = trust.generateLinkingSecret();
        const args = { publicKey: id.publicKey, secret, qrToken: "fake-token-0123456789", timestamp: Date.now() };
        const first = trust.generateLinkingQr(args);
        assert.ok(first.length > 100 && first.length < 400, `a short text, got ${first.length}`);
        assert.equal(TRUST_PLATFORM_WEB, 1);
        assert.equal(typeof trust.generateLinkingQr(args), "string");
    });

    real("refuses a bad key with the module's own reason, and stays usable", async () => {
        const trust = await load();
        const id = trust.generateIdentity();
        const secret = trust.generateLinkingSecret();
        assert.throws(
            () => trust.generateLinkingQr({ publicKey: new Uint8Array(3), secret, qrToken: "x", timestamp: 1 }),
            (e) => e instanceof Error && e.code === "TrustInvalidKeyType" && /bad key type/.test(e.message),
        );
        assert.equal(
            typeof trust.generateLinkingQr({ publicKey: id.publicKey, secret, qrToken: "x", timestamp: 1 }),
            "string",
        );
    });

    real("refuses link data it cannot parse, and link data whose MAC is not its own", async () => {
        const trust = await load();
        const id = trust.generateIdentity();
        const secret = trust.generateLinkingSecret();
        const proofArgs = { publicKey: id.publicKey, privateKey: id.privateKey, secret };
        assert.throws(
            () =>
                trust.createLinkingProof({
                    ...proofArgs,
                    primaryLinkingData: new Uint8Array(195).fill(1),
                    linkingHmac: new Uint8Array(32).fill(2),
                }),
            (e) => e instanceof Error && e.code === "TrustInvalidDataEncoding" && /data encoding/.test(e.message),
        );
    });
});
