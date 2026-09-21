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
import {
    syncCloudIndex,
    listConversationMedia,
    normalizeCloudItem,
    MEDIA_TYPE,
} from "../../src/core/sync-v2/zcloud.js";

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

describe("listConversationMedia", () => {
    it("sends group_id for a normal conversation", async () => {
        const asked = [];
        await listConversationMedia({
            threadId: "g1",
            list: async (p) => {
                asked.push(p);
                return { items: [] };
            },
        });
        assert.equal(asked[0].group_id, "g1");
        assert.equal(asked[0].media_type, 0);
    });

    it("omits group_id for the self-chat", async () => {
        // "Cloud của tôi" goes to a different domain and takes no group id.
        const asked = [];
        await listConversationMedia({
            threadId: "me",
            isSelfChat: true,
            list: async (p) => {
                asked.push(p);
                return { items: [] };
            },
        });
        assert.equal(asked[0].group_id, undefined);
    });

    it("passes the media_type filter through", async () => {
        let seen;
        await listConversationMedia({
            threadId: "g1",
            mediaType: MEDIA_TYPE.video,
            list: async (p) => {
                seen = p;
                return { items: [] };
            },
        });
        assert.equal(seen.media_type, MEDIA_TYPE.video);
    });

    it("pages with last_id until a short page", async () => {
        const asked = [];
        let page = 0;
        const r = await listConversationMedia({
            threadId: "g1",
            limit: 2,
            list: async (p) => {
                asked.push(p.last_id ?? null);
                page++;
                if (page === 1) return { items: [{ id: "1" }, { id: "2" }], last_id: "2" };
                return { items: [{ id: "3" }] };
            },
        });
        assert.deepEqual(asked, [null, "2"]);
        assert.equal(r.items.length, 3);
        assert.equal(r.pages, 2);
    });

    it("stops when the cursor does not advance", async () => {
        let calls = 0;
        await listConversationMedia({
            threadId: "g1",
            limit: 1,
            maxPages: 99,
            list: async () => {
                calls++;
                return { items: [{ id: "stuck" }], last_id: "stuck" };
            },
        });
        assert.ok(calls <= 2, `a repeating cursor must not loop (made ${calls} calls)`);
    });

    it("records a failure instead of throwing", async () => {
        const r = await listConversationMedia({
            threadId: "g1",
            list: async () => {
                throw new Error("403");
            },
        });
        assert.equal(r.failed, 1);
        assert.equal(r.items.length, 0);
    });

    it("reads items from the several envelope shapes", async () => {
        for (const resp of [{ items: [{ id: "a" }] }, { data: { items: [{ id: "a" }] } }, [{ id: "a" }]]) {
            const r = await listConversationMedia({ threadId: "g1", limit: 50, list: async () => resp });
            assert.equal(r.items.length, 1, `shape ${JSON.stringify(resp).slice(0, 30)} not handled`);
        }
    });

    it("does nothing without an api or an injected caller", async () => {
        assert.deepEqual((await listConversationMedia({ threadId: "g1" })).items, []);
    });
});

describe("MEDIA_TYPE", () => {
    it("matches Zalo's media_type filter", () => {
        assert.deepEqual(MEDIA_TYPE, { all: 0, image: 1, video: 2, file: 3, link: 4 });
    });
});
