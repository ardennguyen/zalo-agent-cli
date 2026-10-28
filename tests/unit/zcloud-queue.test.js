/**
 * The zCloud queue applied to the local index, the way Zalo Web's walker applies it (bundle module `_EZi`,
 * `verifyFromId`, with `bWos` for the keys): adds are recorded, a remove entry deletes the messages it names, a
 * del_thread entry clears a conversation's older items, a reset_cloud entry empties the index but for the self chat.
 *
 * Every entry below is hand-written from those modules' reading of the live shape (`noiseId`, `action`,
 * `msgInfo{cliMsgId, glbMsgId, srcId, destId, destType, ts, extInfo.orgMsgs}`, `ts`); ids are throwaway constants.
 * No network, no socket.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { cloudPass, describeCloudPlan, readCloudPlan } from "../../src/commands/sync.js";
import {
    initDb,
    getCloudItems,
    getSyncState,
    removeCloudItemsExcept,
    setSyncState,
    upsertCloudItem,
} from "../../src/core/db.js";
import {
    applyQueuePage,
    cloudKeyOf,
    normalizeCloudItem,
    removalKeysOf,
    syncCloudIndex,
    threadClearOf,
} from "../../src/core/sync-v2/zcloud.js";

const OWN = "1001";
const PEER = "1002";
const OTHER = "1003";
const GROUP = "5001";
const T0 = 1_790_000_000_000;

const ROOT = mkdtempSync(join(tmpdir(), "zalo-zcloud-queue-"));
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

/** An `add` entry: a photo `from` sent to `to` (a user id, or a group when `group`). */
const add = (noiseId, cli, { from = PEER, to = OWN, group = false, ts = T0, over = {} } = {}) => ({
    noiseId,
    action: 1,
    msgInfo: {
        cliMsgId: cli,
        glbMsgId: `glb-${noiseId}`,
        msgType: "chat.photo",
        srcId: from,
        destId: to,
        destType: group ? 6 : 3,
        ts,
    },
    mediaInfo: { mediaSize: 10 },
    encryptInfo: { encryptKey: "opaque", keyVersion: 2, algoVersion: 1 },
    ts: ts + 5,
    ...over,
});

/** A `remove` entry for messages `[cliMsgId, from, to]`, as a recall or a delete arrives. */
const remove = (noiseId, victims, { group = false, ts = T0 + 1000 } = {}) => ({
    noiseId,
    action: 2,
    msgInfo: {
        cliMsgId: 9000 + victims.length,
        msgType: "chat.undo",
        srcId: OWN,
        destId: OWN,
        destType: 3,
        ts,
        extInfo: {
            orgMsgs: victims.map(([cli, from, to]) => ({
                type: group ? 3 : 1,
                uidFrom: from,
                uidTo: to,
                clientDelMsgId: cli,
            })),
        },
    },
    ts,
});

/** A `del_thread` entry for the conversation with `uidTo`, cut at `cliTs`. */
const delThread = (noiseId, uidTo, cliTs, { group = false } = {}) => ({
    noiseId,
    action: 3,
    cliTs,
    msgInfo: {
        cliMsgId: 8000,
        msgType: "chat.delete",
        srcId: OWN,
        destId: OWN,
        destType: 3,
        ts: cliTs,
        extInfo: { orgMsgs: [{ type: group ? 4 : 2, uidTo, uidFrom: OWN, clientDelMsgId: cliTs }] },
    },
    ts: cliTs,
});

const reset = (noiseId, ts) => ({
    noiseId,
    action: 5,
    msgInfo: { cliMsgId: 7000, msgType: "chat.reset", srcId: OWN, destId: OWN, destType: 3, ts },
    ts,
});

const ids = () =>
    getCloudItems()
        .map((r) => r.noiseId)
        .sort();
const walk = (pages, extra = {}) => {
    let i = 0;
    return syncCloudIndex({
        ownId: OWN,
        selfChatId: OWN,
        pageSize: 300,
        verify: async () => {
            const page = pages[Math.min(i, pages.length - 1)];
            i++;
            return { mediaItems: page, lastNoiseId: `c${i}`, hasMore: i < pages.length ? 1 : 0 };
        },
        ...extra,
    });
};

describe("zcloud queue — sandbox", () => {
    it("runs inside the test sandbox", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });
});

describe("the keys Zalo Web gives queue items", () => {
    it("is cliMsgId_conversation_sender, a DM's conversation being the other side", () => {
        assert.equal(cloudKeyOf(add("a", 11, { from: PEER, to: OWN }), OWN), "11_1002_1002", "incoming");
        assert.equal(cloudKeyOf(add("a", 12, { from: OWN, to: PEER }), OWN), "12_1002_1001", "outgoing");
        assert.equal(cloudKeyOf(add("a", 13, { from: OWN, to: OWN }), OWN), "13_1001_1001", "the self chat");
        assert.equal(cloudKeyOf(add("a", 14, { from: PEER, to: GROUP, group: true }), OWN), "14_5001_1002", "a group");
    });

    it("reads a sender of 0 as the account, and gives no key to an item with no client message id", () => {
        assert.equal(cloudKeyOf(add("a", 15, { from: "0", to: PEER }), OWN), "15_1002_1001");
        assert.equal(cloudKeyOf({ noiseId: "x", msgInfo: { srcId: PEER, destId: OWN } }, OWN), null);
        assert.equal(cloudKeyOf({ noiseId: "x" }, OWN), null);
    });

    it("names what a remove entry removes, with the same keys the adds got", () => {
        const dm = remove("r", [[12, OWN, PEER]]);
        assert.deepEqual(removalKeysOf(dm, OWN), ["12_1002_1001"]);
        const incoming = remove("r", [[11, PEER, OWN]]);
        assert.deepEqual(
            removalKeysOf(incoming, OWN),
            ["11_1002_1002"],
            "uidTo is the account: the conversation is the sender",
        );
        const group = remove("r", [[14, PEER, GROUP]], { group: true });
        assert.deepEqual(removalKeysOf(group, OWN), ["14_5001_1002"]);
        assert.deepEqual(removalKeysOf({ msgInfo: {} }, OWN), []);
    });

    it("reads which conversation a del_thread cleared and when", () => {
        assert.deepEqual(threadClearOf(delThread("d", PEER, T0 + 50)), { threadId: PEER, deletedAt: T0 + 50 });
        assert.deepEqual(threadClearOf(delThread("d", GROUP, T0 + 60, { group: true })), {
            threadId: GROUP,
            deletedAt: T0 + 60,
        });
        const leave = { action: 3, msgInfo: { msgType: "group.leave", destId: GROUP, ts: T0 + 70 }, ts: T0 + 71 };
        assert.deepEqual(threadClearOf(leave), { threadId: GROUP, deletedAt: T0 + 70 });
    });
});

describe("a remove entry deletes the media it names", () => {
    it("in the same page, and across pages, leaving the rest", async () => {
        await walk([
            [add("a", 11), add("b", 12, { from: OWN, to: PEER }), add("c", 13)],
            [remove("r1", [[11, PEER, OWN]])],
            [remove("r2", [[12, OWN, PEER]]), add("d", 14)],
        ]);
        assert.deepEqual(ids(), ["c", "d"]);
    });

    it("applies a page's removals after its adds, so an item added and recalled together is gone", async () => {
        const stats = await walk([[add("a", 11), remove("r", [[11, PEER, OWN]], { ts: T0 + 10 })]]);
        assert.deepEqual(ids(), []);
        assert.equal(stats.items, 1);
        assert.equal(stats.removed, 1);
    });

    it("removes a group's item by the group's key", async () => {
        await walk([
            [
                add("g1", 21, { from: PEER, to: GROUP, group: true }),
                add("g2", 22, { from: PEER, to: GROUP, group: true }),
            ],
            [remove("r", [[21, PEER, GROUP]], { group: true })],
        ]);
        assert.deepEqual(ids(), ["g2"]);
    });

    it("removes nothing it does not name, and a removal of an item never seen is not an error", async () => {
        const stats = await walk([[add("a", 11)], [remove("r", [[999, PEER, OWN]])]]);
        assert.deepEqual(ids(), ["a"]);
        assert.equal(stats.removed, 0);
        assert.equal(stats.failed, 0);
    });

    it("finds an item recorded before keys existed, once the walk has given it one", async () => {
        const legacy = add("old", 31);
        upsertCloudItem({ ...normalizeCloudItem(legacy, OWN), zKey: null });
        assert.equal(getCloudItems()[0].zKey, null, "the row starts without a key");
        await walk([[remove("r", [[31, PEER, OWN]])]]);
        assert.deepEqual(ids(), []);
    });
});

describe("a del_thread entry clears a conversation's older items", () => {
    it("deletes that conversation's items older than the cut, and only those", async () => {
        await walk([
            [
                add("old", 41, { ts: T0 }),
                add("new", 42, { ts: T0 + 500 }),
                add("elsewhere", 43, { from: OTHER, ts: T0 }),
            ],
            [delThread("d", PEER, T0 + 100)],
        ]);
        assert.deepEqual(ids(), ["elsewhere", "new"]);
    });

    it("clears a group the same way", async () => {
        await walk([
            [
                add("g-old", 51, { to: GROUP, group: true, ts: T0 }),
                add("g-new", 52, { to: GROUP, group: true, ts: T0 + 900 }),
            ],
            [delThread("d", GROUP, T0 + 500, { group: true })],
        ]);
        assert.deepEqual(ids(), ["g-new"]);
    });
});

describe("a reset_cloud entry empties the index but for the self chat", () => {
    it("deletes what earlier pages recorded, keeping the self chat", async () => {
        await walk([[add("peer", 61), add("self", 62, { from: OWN, to: OWN })], [reset("rst", T0 + 1000)]]);
        assert.deepEqual(ids(), ["self"]);
    });

    it("drops the entries older than the reset on its own page and keeps the newer ones", async () => {
        await walk([
            [
                add("before", 71, { ts: T0 }),
                add("self-before", 72, { from: OWN, to: OWN, ts: T0 }),
                reset("rst", T0 + 1000),
                add("after", 73, { ts: T0 + 2000 }),
            ],
        ]);
        assert.deepEqual(ids(), ["after", "self-before"]);
    });

    it("counts what it did", () => {
        initDbAndFill();
        const r = applyQueuePage([reset("rst", T0 + 1000)], { ownId: OWN, selfChatId: OWN });
        assert.equal(r.resets, 1);
        assert.deepEqual(ids(), ["self"]);
    });
});

function initDbAndFill() {
    upsertCloudItem(normalizeCloudItem(add("peer", 81), OWN));
    upsertCloudItem(normalizeCloudItem(add("self", 82, { from: OWN, to: OWN }), OWN));
}

describe("entries that change nothing", () => {
    it("counts temp and duplicate entries as skipped", async () => {
        const stats = await walk([[add("a", 91), { ...add("t", 92), action: 4 }, { ...add("d", 93), action: 6 }]]);
        assert.deepEqual(ids(), ["a"]);
        assert.deepEqual(stats.skipped, { temp: 1, duplicate: 1 });
    });

    it("takes an entry with no action as an add, as the older envelopes were", async () => {
        const e = add("a", 94);
        delete e.action;
        await walk([[e]]);
        assert.deepEqual(ids(), ["a"]);
    });
});

describe("resuming and the full walk", () => {
    it("tells onPage where to resume after every page, and that the last one was complete", async () => {
        const seen = [];
        await walk([[add("a", 1)], [add("b", 2)], [add("c", 3)]], { onPage: (p) => seen.push(p) });
        assert.deepEqual(
            seen.map((p) => [p.cursor, p.page, p.complete]),
            [
                ["c1", 1, false],
                ["c2", 2, false],
                ["c3", 3, true],
            ],
        );
    });

    it("starts from the saved place, and says so to the server", async () => {
        const asked = [];
        await syncCloudIndex({
            ownId: OWN,
            lastNoiseId: "saved-place",
            verify: async (p) => {
                asked.push(p.lastNoiseId);
                return { mediaItems: [], lastNoiseId: "saved-place", hasMore: 0 };
            },
        });
        assert.deepEqual(asked, ["saved-place"]);
    });

    it("a full walk starts from the top whatever place it was given, and sweeps what no page listed", async () => {
        upsertCloudItem({ ...normalizeCloudItem(add("stale", 101), OWN), seenAt: 1 });
        upsertCloudItem({ ...normalizeCloudItem(add("kept", 102), OWN), seenAt: 1 });
        upsertCloudItem(normalizeCloudItem(add("never-stamped", 104), OWN));
        const asked = [];
        const stats = await syncCloudIndex({
            ownId: OWN,
            full: true,
            lastNoiseId: "ignored",
            verify: async (p) => {
                asked.push(p.lastNoiseId);
                return { mediaItems: [add("kept", 102), add("fresh", 103)], lastNoiseId: "z", hasMore: 0 };
            },
        });
        assert.deepEqual(asked, [""]);
        assert.deepEqual(ids(), ["fresh", "kept"], "a row no walk ever stamped goes too");
        assert.equal(stats.swept, 2);
    });

    it("an incremental walk sweeps nothing", async () => {
        upsertCloudItem({ ...normalizeCloudItem(add("quiet", 111), OWN), seenAt: 1 });
        const stats = await walk([[add("new", 112)]]);
        assert.deepEqual(ids(), ["new", "quiet"]);
        assert.equal(stats.swept, 0);
    });

    it("a full walk that did not finish deletes nothing", async () => {
        upsertCloudItem({ ...normalizeCloudItem(add("precious", 121), OWN), seenAt: 1 });
        let calls = 0;
        const stats = await syncCloudIndex({
            ownId: OWN,
            full: true,
            verify: async () => {
                if (++calls === 2) throw new Error("connection lost");
                return { mediaItems: [add("a", 122)], lastNoiseId: "c1", hasMore: 1 };
            },
        });
        assert.equal(stats.complete, false);
        assert.equal(stats.swept, 0);
        assert.deepEqual(ids(), ["a", "precious"]);
    });

    it("a full walk stopped by the page cap deletes nothing either", async () => {
        upsertCloudItem({ ...normalizeCloudItem(add("precious", 131), OWN), seenAt: 1 });
        const stats = await syncCloudIndex({
            ownId: OWN,
            full: true,
            maxPages: 1,
            verify: async () => ({ mediaItems: [add("a", 132)], lastNoiseId: "c1", hasMore: 1 }),
        });
        assert.equal(stats.complete, false);
        assert.deepEqual(ids(), ["a", "precious"]);
    });
});

describe("what an item says about its key", () => {
    it("takes the blob's key and versions from the top-level encryptInfo, not from the metadata's", () => {
        const item = add("a", 1);
        item.mediaInfo.mediaExtInfo = {
            data: "opaque-metadata",
            encryptInfo: { encryptKey: "metadata-key", encryptVer: 1 },
        };
        const row = normalizeCloudItem(item, OWN);
        assert.equal(row.encryptKey, "opaque");
        assert.equal(row.keyVersion, 2);
        assert.equal(row.algoVersion, 1);
        assert.equal(
            JSON.parse(JSON.stringify(row.raw_data)).mediaInfo.mediaExtInfo.encryptInfo.encryptKey,
            "metadata-key",
        );
        const bare = add("b", 2);
        delete bare.encryptInfo;
        bare.mediaInfo.mediaExtInfo = item.mediaInfo.mediaExtInfo;
        assert.equal(
            normalizeCloudItem(bare, OWN).encryptKey,
            null,
            "the metadata's key is never taken for the blob's",
        );
    });

    it("stores the versions beside the opaque key, and the item verbatim", async () => {
        await walk([[add("a", 1)]]);
        const [row] = getCloudItems();
        assert.equal(row.keyVersion, 2);
        assert.equal(row.algoVersion, 1);
        assert.equal(row.zKey, "1_1002_1002");
        assert.equal(JSON.parse(row.raw_data).encryptInfo.encryptKey, "opaque", "nothing is decrypted or rewritten");
    });
});

describe("`sync-cloud` keeps its place", () => {
    const api = { getOwnId: () => OWN };
    /** A queue of `count` one-item pages that records where each request started. */
    const queue = (count, asked = []) => ({
        asked,
        verify: async (p) => {
            asked.push(p.lastNoiseId);
            const i = asked.length;
            return { mediaItems: [add(`n${i}`, i)], lastNoiseId: `c${i}`, hasMore: i < count ? 1 : 0 };
        },
    });

    it("saves the place after every page and keeps it when the walk is complete", async () => {
        const q = queue(3);
        const r = await cloudPass(api, { verify: q.verify, pages: 50 });
        assert.equal(r.stats.complete, true);
        assert.equal(getSyncState("cloudCursor"), "c3", "the next run starts after what this one read");
    });

    it("the next walk starts from the saved place, so it reads only what is new", async () => {
        setSyncState("cloudCursor", "c3");
        const q = queue(1);
        await cloudPass(api, { verify: q.verify, pages: 50 });
        assert.deepEqual(q.asked, ["c3"]);
    });

    it("a walk that dies after a page still moves the place forward", async () => {
        let calls = 0;
        await cloudPass(api, {
            pages: 50,
            verify: async () => {
                if (++calls === 3) throw new Error("connection lost");
                return { mediaItems: [add(`n${calls}`, calls)], lastNoiseId: `c${calls}`, hasMore: 1 };
            },
        });
        assert.equal(getSyncState("cloudCursor"), "c2");
    });

    it("--resume wins over the saved place, and --full ignores both and sweeps", async () => {
        setSyncState("cloudCursor", "saved");
        const a = queue(1);
        await cloudPass(api, { verify: a.verify, resume: "explicit", pages: 50 });
        assert.deepEqual(a.asked, ["explicit"]);
        upsertCloudItem({ ...normalizeCloudItem(add("stale", 500), OWN), seenAt: 1 });
        const b = queue(1);
        const r = await cloudPass(api, { verify: b.verify, resume: "explicit", full: true, pages: 50 });
        assert.deepEqual(b.asked, [""]);
        assert.equal(r.stats.swept, 1);
        assert.ok(!ids().includes("stale"));
    });
});

describe("the cloud_items writers", () => {
    it("a reset-style removal takes rows with no conversation too, and spares the named ones", () => {
        upsertCloudItem({ noiseId: "orphan", threadId: null });
        upsertCloudItem({ noiseId: "self", threadId: OWN });
        upsertCloudItem({ noiseId: "peer", threadId: PEER });
        removeCloudItemsExcept([OWN]);
        assert.deepEqual(ids(), ["self"]);
        removeCloudItemsExcept([]);
        assert.deepEqual(ids(), [], "with nothing to spare it empties the table");
    });

    it("an upsert that carries no key keeps the one the row has", () => {
        upsertCloudItem({ noiseId: "k", threadId: PEER, zKey: "1_1002_1002", keyVersion: 2 });
        upsertCloudItem({ noiseId: "k", threadId: PEER });
        const [row] = getCloudItems();
        assert.equal(row.zKey, "1_1002_1002");
        assert.equal(row.keyVersion, 2);
    });
});

describe("`sync-cloud` reads the plan first", () => {
    const api = { getOwnId: () => OWN };
    const FREE = { plan: -1, quota: 0, usage: 0, service_usage: { my_cloud: 0, message_backup: 0 } };
    const PAID = { plan: 0, quota: 107374182400, usage: 39192432681, service_usage: { cloud_media: 39146940745 } };
    /** A queue that counts the pages asked for. */
    const counted = () => {
        const q = { pages: 0 };
        q.verify = async () => {
            q.pages++;
            return { mediaItems: [add("n1", 1)], lastNoiseId: "c1", hasMore: 0 };
        };
        return q;
    };

    it("asks for no page when the account has no zCloud plan and nothing in the cloud", async () => {
        const q = counted();
        const r = await cloudPass(api, { verify: q.verify, usage: async () => FREE, pages: 50 });
        assert.equal(r.status, "skipped");
        assert.equal(r.plan.plan, "free");
        assert.equal(q.pages, 0, "the free account's queue was not walked");
    });

    it("still walks a free account when the person asks for --full or --resume", async () => {
        for (const extra of [{ full: true }, { resume: "c0" }]) {
            const q = counted();
            const r = await cloudPass(api, { verify: q.verify, usage: async () => FREE, pages: 50, ...extra });
            assert.equal(r.status, "ok", JSON.stringify(extra));
            assert.equal(q.pages, 1);
        }
    });

    it("walks an account that has a plan, and says which", async () => {
        const q = counted();
        const r = await cloudPass(api, { verify: q.verify, usage: async () => PAID, pages: 50 });
        assert.equal(r.status, "ok");
        assert.equal(r.plan.plan, "zcloud");
        assert.equal(r.plan.quotaBytes, 107374182400);
        assert.equal(q.pages, 1);
    });

    it("walks a free account that still has something in the cloud, and one in its grace period", async () => {
        for (const usage of [
            { plan: -1, quota: 0, usage: 5 },
            { plan: 100, quota: 0, usage: 0 },
            { plan: 69, quota: 0, usage: 0 },
        ]) {
            const q = counted();
            const r = await cloudPass(api, { verify: q.verify, usage: async () => usage, pages: 50 });
            assert.equal(r.status, "ok", JSON.stringify(usage));
            assert.equal(q.pages, 1);
        }
    });

    it("does not take a failed plan read for a verdict: the walk goes on, with no plan", async () => {
        const q = counted();
        const r = await cloudPass(api, {
            verify: q.verify,
            usage: async () => {
                throw new Error("no answer");
            },
            pages: 50,
        });
        assert.equal(r.status, "ok");
        assert.equal(r.plan, null);
        assert.equal(q.pages, 1);
    });

    it("reads the plan without the settings when the settings read fails", async () => {
        const plan = await readCloudPlan(api, {
            usage: async () => PAID,
            settings: async () => {
                throw new Error("nope");
            },
        });
        assert.equal(plan.plan, "zcloud");
        assert.equal(plan.optIn, null);
    });

    it("says what the plan is in one line", () => {
        assert.match(
            describeCloudPlan({ plan: "free", planCode: -1, usageBytes: 0, quotaBytes: 0 }),
            /no plan on this account \(free\)/,
        );
        assert.equal(
            describeCloudPlan({ plan: "zcloud", planCode: 0, usageBytes: 39192432681, quotaBytes: 107374182400 }),
            "zCloud: zcloud, 36.5 GB of 100.0 GB used.",
        );
    });
});
