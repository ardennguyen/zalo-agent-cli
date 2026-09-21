/**
 * src/core/sync-v2 — the pure transport decoders used by the real mobile
 * restore (`sync-mobile --transfer`): `decodeFrame` (AES-128-GCM + zlib/gzip
 * inflate of a WS frame body) and `splitChunks` (the `[u32 LE len][payload]`
 * batch framing). These are reimplementations of Zalo's wire format, so they
 * are pinned here with synthetic frames — no live session or fixtures needed.
 *
 * See agent/work/transfer-sync-v2/FINDINGS.md for the format.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { decodeFrame, splitChunks, isSessionComplete, resolveWaitBudget } from "../../src/core/sync-v2/index.js";

/** Build a Zalo frame body `{encrypt, data}` the way the server would. */
function makeFrame(obj, encrypt, keyB64) {
    const json = Buffer.from(JSON.stringify(obj), "utf8");
    if (encrypt === 0) return { frame: { encrypt: 0, data: json.toString("utf8") } };
    const compressed = encrypt === 3 ? json : zlib.gzipSync(json);
    if (encrypt === 1) return { frame: { encrypt: 1, data: compressed.toString("base64") } };
    // encrypt 2 (gcm+compress) or 3 (gcm only)
    const key = Buffer.from(keyB64, "base64");
    const iv = crypto.randomBytes(16);
    const aad = crypto.randomBytes(16);
    const c = crypto.createCipheriv(key.length === 16 ? "aes-128-gcm" : "aes-256-gcm", key, iv);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(compressed), c.final()]);
    const tag = c.getAuthTag();
    return { frame: { encrypt, data: Buffer.concat([iv, aad, ct, tag]).toString("base64") } };
}

describe("sync-v2 decodeFrame", () => {
    before(() => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });

    const keyB64 = crypto.randomBytes(16).toString("base64"); // AES-128

    it("decodes encrypt:2 (AES-128-GCM + gzip)", () => {
        const payload = { data: { controls: [{ content: { act: "transfer_status", data: '{"status":4}' } }] } };
        const { frame } = makeFrame(payload, 2, keyB64);
        assert.deepEqual(decodeFrame(frame, keyB64), payload);
    });

    it("decodes encrypt:1 (gzip only, no key needed)", () => {
        const payload = { hello: "world", n: 7 };
        const { frame } = makeFrame(payload, 1, keyB64);
        assert.deepEqual(decodeFrame(frame, null), payload);
    });

    it("decodes encrypt:0 (plain JSON)", () => {
        const { frame } = makeFrame({ a: 1 }, 0, keyB64);
        assert.deepEqual(decodeFrame(frame, keyB64), { a: 1 });
    });

    it("decodes encrypt:3 (GCM, uncompressed)", () => {
        const { frame } = makeFrame({ x: "y" }, 3, keyB64);
        assert.deepEqual(decodeFrame(frame, keyB64), { x: "y" });
    });

    it("throws on a wrong key (GCM auth failure)", () => {
        const { frame } = makeFrame({ a: 1 }, 2, keyB64);
        const wrong = crypto.randomBytes(16).toString("base64");
        assert.throws(() => decodeFrame(frame, wrong));
    });

    it("throws on a missing key for an encrypted frame", () => {
        const { frame } = makeFrame({ a: 1 }, 2, keyB64);
        assert.throws(() => decodeFrame(frame, null));
    });
});

describe("sync-v2 splitChunks", () => {
    it("splits multiple length-prefixed chunks", () => {
        const a = Buffer.from("first-chunk");
        const b = Buffer.from("second");
        const buf = Buffer.concat([
            (() => {
                const h = Buffer.alloc(4);
                h.writeUInt32LE(a.length, 0);
                return h;
            })(),
            a,
            (() => {
                const h = Buffer.alloc(4);
                h.writeUInt32LE(b.length, 0);
                return h;
            })(),
            b,
        ]);
        const chunks = splitChunks(buf);
        assert.equal(chunks.length, 2);
        assert.equal(chunks[0].toString(), "first-chunk");
        assert.equal(chunks[1].toString(), "second");
    });

    it("handles a single chunk (the common case)", () => {
        const p = crypto.randomBytes(1542);
        const h = Buffer.alloc(4);
        h.writeUInt32LE(p.length, 0);
        const chunks = splitChunks(Buffer.concat([h, p]));
        assert.equal(chunks.length, 1);
        assert.ok(chunks[0].equals(p));
    });

    it("stops cleanly on a truncated trailing length prefix", () => {
        const p = Buffer.from("ok");
        const h = Buffer.alloc(4);
        h.writeUInt32LE(p.length, 0);
        const buf = Buffer.concat([h, p, Buffer.from([0x01, 0x02])]); // 2 dangling bytes
        const chunks = splitChunks(buf);
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].toString(), "ok");
    });

    it("drops a chunk whose declared length overruns the buffer", () => {
        const h = Buffer.alloc(4);
        h.writeUInt32LE(9999, 0);
        assert.equal(splitChunks(Buffer.concat([h, Buffer.from("short")])).length, 0);
    });
});

describe("isSessionComplete — when has the phone finished a round?", () => {
    const S = (want, covered, sawLast = false) => ({
        want: new Set(want),
        covered: new Set(covered),
        sawLast,
    });

    it("completes a message round once every partition is covered", () => {
        assert.equal(isSessionComplete(S(["oneone/a", "group/b"], ["oneone/a", "group/b"])), true);
    });

    it("does NOT complete while a partition is still outstanding", () => {
        assert.equal(isSessionComplete(S(["oneone/a", "group/b"], ["oneone/a"])), false);
    });

    it("completes on full coverage even when isLast never arrives", () => {
        // The captured Zalo Web run ends its last message session with
        // isLast=0 and disposes it anyway; waiting for isLast hangs the run.
        assert.equal(isSessionComplete(S(["oneone/a"], ["oneone/a"], false)), true);
    });

    it("completes on isLast even before full coverage", () => {
        assert.equal(isSessionComplete(S(["oneone/a", "group/b"], [], true)), true);
    });

    it("needs isLast for the conversation round, which has no partitions", () => {
        assert.equal(isSessionComplete(S([], [])), false);
        assert.equal(isSessionComplete(S([], [], true)), true);
    });

    it("tolerates extra coverage the request did not ask for", () => {
        assert.equal(isSessionComplete(S(["oneone/a"], ["oneone/a", "oneone/z"])), true);
    });

    it("is false for a missing or empty state", () => {
        assert.equal(isSessionComplete(null), false);
        assert.equal(isSessionComplete({}), false);
    });
});

describe("resolveWaitBudget — a missing budget must never mean 'do not wait'", () => {
    it("uses the requested budget when it is sane", () => {
        assert.equal(resolveWaitBudget(5000, 180000), 5000);
    });

    it("falls back when the budget is missing", () => {
        // The regression: waitDone(id) with no budget produced Date.now()+undefined
        // = NaN, so the wait loop exited immediately and a phone confirmation
        // that had three minutes to arrive was given none.
        assert.equal(resolveWaitBudget(undefined, 180000), 180000);
    });

    it("falls back on NaN, zero and negatives", () => {
        for (const bad of [NaN, 0, -1, Infinity, "600", null]) {
            assert.equal(resolveWaitBudget(bad, 180000), 180000, `budget ${String(bad)} should fall back`);
        }
    });

    it("never returns something non-positive, even with a broken fallback", () => {
        for (const bad of [undefined, NaN, 0, -5]) {
            const v = resolveWaitBudget(undefined, bad);
            assert.ok(Number.isFinite(v) && v > 0, `fallback ${String(bad)} produced ${v}`);
        }
    });

    it("a resolved budget always yields a future deadline", () => {
        const dl = Date.now() + resolveWaitBudget(undefined, undefined);
        assert.ok(Date.now() < dl, "deadline must be in the future or the loop never waits");
    });
});
