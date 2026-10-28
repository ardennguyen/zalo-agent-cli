/**
 * src/core/sync-v2/zcloud.js — the cloud index and the media store.
 *
 * Network callers are injected, so what is under test is the part that can be
 * verified offline: pagination and its termination conditions, normalization
 * of Zalo's several envelope shapes, and persistence.
 *
 * These endpoints are reconstructed from Zalo Web's bundle and have not been
 * exercised against a live account, so a green run here means "the client
 * behaves as specified", not "Zalo accepts it".
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb, getCloudItems, getCloudItemByMsgId } from "../../src/core/db.js";
import { syncCloudIndex, normalizeCloudItem } from "../../src/core/sync-v2/zcloud.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-zcloud-test-"));
const opened = [];
let n = 0;

beforeEach(() => {
    opened.push(initDb(join(ROOT, `db${n++}.sqlite`)));
});

after(() => {
    for (const h of opened) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch {
        /* a lingering WAL handle is not worth failing the run over */
    }
});

const cloudItem = (over = {}) => ({
    noiseId: "nz-1",
    encryptInfo: { cloudUrl: "https://cloud.zalo/x/1", encryptKey: "k1" },
    mediaInfo: { checksum: "abc", mediaSize: 1024, mediaType: 1 },
    msgInfo: { msgId: "m1", msgType: 3, toUid: "t1", ts: 1_750_000_000_000 },
    ...over,
});

describe("normalizeCloudItem", () => {
    it("flattens the nested envelope", () => {
        const r = normalizeCloudItem(cloudItem());
        assert.equal(r.noiseId, "nz-1");
        assert.equal(r.cloudUrl, "https://cloud.zalo/x/1");
        assert.equal(r.encryptKey, "k1");
        assert.equal(r.checksum, "abc");
        assert.equal(r.mediaSize, 1024);
        assert.equal(r.msgId, "m1");
        assert.equal(r.threadId, "t1");
        assert.equal(r.timestamp, 1_750_000_000_000);
    });

    it("accepts zKey or id as the key", () => {
        assert.equal(normalizeCloudItem({ zKey: "z9" }).noiseId, "z9");
        assert.equal(normalizeCloudItem({ id: "i9" }).noiseId, "i9");
    });

    it("accepts a flat item with no nesting", () => {
        const r = normalizeCloudItem({ noiseId: "n2", cloudUrl: "https://c/2", msgId: "m2", checksum: "c2" });
        assert.equal(r.cloudUrl, "https://c/2");
        assert.equal(r.msgId, "m2");
    });

    it("rejects an item with no key", () => {
        assert.equal(normalizeCloudItem({ encryptInfo: {} }), null);
        assert.equal(normalizeCloudItem(null), null);
    });
});

describe("syncCloudIndex", () => {
    it("stores what the queue reports", async () => {
        const stats = await syncCloudIndex({
            verify: async () => ({ items: [cloudItem(), cloudItem({ noiseId: "nz-2" })] }),
            pageSize: 300,
        });
        assert.equal(stats.items, 2);
        assert.equal(stats.pages, 1);
        assert.equal(getCloudItems().length, 2);
    });

    it("looks an item up by the message it backs", async () => {
        await syncCloudIndex({ verify: async () => ({ items: [cloudItem()] }) });
        const found = getCloudItemByMsgId("m1");
        assert.equal(found.noiseId, "nz-1");
        assert.equal(found.encryptKey, "k1");
    });

    it("pages by lastNoiseId until the cursor stops moving", async () => {
        const asked = [];
        let page = 0;
        const stats = await syncCloudIndex({
            pageSize: 2,
            verify: async (p) => {
                asked.push(p.lastNoiseId);
                page++;
                if (page === 1) {
                    return { items: [cloudItem({ noiseId: "a" }), cloudItem({ noiseId: "b" })], lastNoiseId: "b" };
                }
                return { items: [cloudItem({ noiseId: "c" })], lastNoiseId: "c" };
            },
        });
        assert.deepEqual(asked, ["", "b"]);
        assert.equal(stats.items, 3);
        assert.equal(stats.lastNoiseId, "c");
    });

    it("resumes from a supplied cursor", async () => {
        let seen = null;
        await syncCloudIndex({
            lastNoiseId: "resume-here",
            verify: async (p) => {
                seen = p.lastNoiseId;
                return { items: [] };
            },
        });
        assert.equal(seen, "resume-here");
    });

    it("stops rather than looping when the cursor repeats", async () => {
        let calls = 0;
        await syncCloudIndex({
            pageSize: 1,
            maxPages: 99,
            verify: async () => {
                calls++;
                return { items: [cloudItem({ noiseId: "same" })], lastNoiseId: "same" };
            },
        });
        assert.ok(calls <= 2, `a repeating cursor must not loop (made ${calls} calls)`);
    });

    it("respects maxPages", async () => {
        let calls = 0;
        await syncCloudIndex({
            pageSize: 1,
            maxPages: 3,
            verify: async () => {
                calls++;
                return { items: [cloudItem({ noiseId: `n${calls}` })], lastNoiseId: `n${calls}` };
            },
        });
        assert.equal(calls, 3);
    });

    it("records a failure instead of throwing", async () => {
        const stats = await syncCloudIndex({
            verify: async () => {
                throw new Error("cloud disabled");
            },
        });
        assert.equal(stats.failed, 1);
        assert.match(stats.failures[0].reason, /cloud disabled/);
        assert.equal(stats.items, 0);
    });

    it("does nothing without an api or an injected caller", async () => {
        assert.deepEqual((await syncCloudIndex({})).items, 0);
    });

    it("re-running updates rather than duplicating", async () => {
        const verify = async () => ({ items: [cloudItem()] });
        await syncCloudIndex({ verify });
        await syncCloudIndex({ verify });
        assert.equal(getCloudItems().length, 1);
    });

    it("keeps a known encryptKey when a later page omits it", async () => {
        await syncCloudIndex({ verify: async () => ({ items: [cloudItem()] }) });
        await syncCloudIndex({
            verify: async () => ({ items: [cloudItem({ encryptInfo: { cloudUrl: "https://cloud.zalo/x/1b" } })] }),
        });
        const [row] = getCloudItems();
        assert.equal(row.encryptKey, "k1", "a refreshed URL must not erase the key");
        assert.equal(row.cloudUrl, "https://cloud.zalo/x/1b");
    });
});
