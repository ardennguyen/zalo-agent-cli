/**
 * `src/core/sync-v2/reactions.js` — retrieving the reaction backlog.
 *
 * Reactions were documented in this repo as unrecoverable, which conflated two
 * different things: the Sync2 transfer payload genuinely has no reaction field,
 * but the socket serves them on cmd 610 (1-1) and cmd 611 (group), and Zalo Web
 * asks for both on every connect. Measured live: one request pair returned 28
 * direct and 62 group reactions while the cache held one row.
 *
 * The listener is faked here — a started zca-js listener is just an EventEmitter
 * with `requestOldReactions`, `ws` and `cipherKey` — so the paging, the ordering
 * and the removal semantics are all reachable offline.
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb, getReactions, insertMessage, upsertThread } from "../../src/core/db.js";
import { drainReactions } from "../../src/core/sync-v2/reactions.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-react-drain-"));
const opened = [];
let n = 0;

beforeEach(() => {
    opened.push(initDb(join(ROOT, `db${n++}.sqlite`)));
    upsertThread({ threadId: "t1", type: "group", name: "g", lastUpdate: 1 });
    insertMessage({
        msgId: "m1",
        threadId: "t1",
        senderId: "u1",
        senderName: "",
        text: "hi",
        timestamp: 1,
        type: "text",
        raw_data: "{}",
    });
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

/** A reaction as the 610/611 path delivers it: content is a JSON STRING. */
const react = (icon, rType, msgId = "m1", userId = "u2") => ({
    threadId: "t1",
    data: {
        msgId: "notif",
        uidFrom: userId,
        ts: 1,
        content: JSON.stringify({ rMsg: [{ gMsgID: msgId }], rIcon: icon, rType }),
    },
});

/**
 * A started listener, faked. `pages` maps a thread type to the sequence of
 * answers it should give; each answer is `{objs, more}`.
 */
function fakeListener(pages) {
    const l = new EventEmitter();
    l.cipherKey = "irrelevant — the raw tap is fed directly";
    l.ws = new EventEmitter();
    const cursor = { 0: 0, 1: 0 };
    l.requests = [];
    l.requestOldReactions = (threadType, anchor) => {
        l.requests.push({ threadType, anchor });
        const seq = pages[threadType] || [];
        const page = seq[cursor[threadType]++];
        if (!page) return; // no answer — exercises the timeout
        // The envelope is what the raw tap reads; deliver it the way the real
        // socket does, as a frame the drain decodes. Here we shortcut by
        // emitting the already-decoded shape through a stubbed decode.
        setImmediate(() => {
            l.__envelope = { more: page.more || 0, lastActionId: page.lastActionId };
            l.emit("old_reactions", page.objs, threadType === 1);
        });
    };
    return l;
}

// The drain reads `more`/`lastActionId` off the raw socket because zca-js does
// not surface them. Feeding a real encrypted frame in a unit test would test
// the decoder, not the drain, so the tap is satisfied with a pre-decoded frame.
function tapPages(listener, pages) {
    const orig = listener.requestOldReactions;
    listener.requestOldReactions = (threadType, anchor) => {
        orig(threadType, anchor);
        const seq = pages[threadType] || [];
        const idx = listener.requests.filter((r) => r.threadType === threadType).length - 1;
        const page = seq[idx];
        if (!page) return;
        setImmediate(() => {
            const cmd = threadType === 1 ? 611 : 610;
            const head = Buffer.alloc(4);
            head.writeUInt8(1, 0);
            head.writeUInt16LE(cmd, 1);
            const body = Buffer.from(
                JSON.stringify({
                    encrypt: 0,
                    data: JSON.stringify({ data: { more: page.more || 0, lastActionId: page.lastActionId } }),
                }),
                "utf8",
            );
            listener.ws.emit("message", Buffer.concat([head, body]));
        });
    };
}

describe("drainReactions", () => {
    it("stores reactions whose content arrives as a JSON string", async () => {
        const pages = { 0: [{ objs: [react("/-heart", 5)], more: 0 }], 1: [{ objs: [], more: 0 }] };
        const l = fakeListener(pages);
        tapPages(l, pages);
        const stats = await drainReactions({ listener: l, timeoutMs: 400 });
        assert.equal(stats.received, 1);
        assert.equal(stats.stored, 1);
        const [got] = getReactions({ msgId: "m1" });
        assert.equal(got.icon, "/-heart");
    });

    it("asks for both thread types", async () => {
        const pages = { 0: [{ objs: [], more: 0 }], 1: [{ objs: [], more: 0 }] };
        const l = fakeListener(pages);
        tapPages(l, pages);
        await drainReactions({ listener: l, timeoutMs: 400 });
        assert.deepEqual(
            l.requests.map((r) => r.threadType),
            [0, 1],
        );
    });

    it("follows `more` to the next page, using the server's lastActionId as the anchor", async () => {
        // The very first live probe answered more:1 for groups, so a drain that
        // stops after one page silently loses the rest.
        const pages = {
            0: [{ objs: [], more: 0 }],
            1: [
                { objs: [react("/-heart", 5, "m1", "u2")], more: 1, lastActionId: "999" },
                { objs: [react(":>", 0, "m1", "u3")], more: 0 },
            ],
        };
        const l = fakeListener(pages);
        tapPages(l, pages);
        const stats = await drainReactions({ listener: l, timeoutMs: 400 });
        assert.equal(stats.pages, 3, "one DM page plus two group pages");
        assert.equal(stats.received, 2);
        const groupRequests = l.requests.filter((r) => r.threadType === 1);
        assert.equal(groupRequests[1].anchor, "999", "the second page must carry the server's cursor");
    });

    it("stops rather than looping when the server repeats its cursor", async () => {
        const pages = {
            0: [{ objs: [], more: 0 }],
            1: [
                { objs: [react("/-heart", 5)], more: 1, lastActionId: "555" },
                { objs: [react("/-heart", 5)], more: 1, lastActionId: "555" },
            ],
        };
        const l = fakeListener(pages);
        tapPages(l, pages);
        const stats = await drainReactions({ listener: l, timeoutMs: 400, maxPages: 5 });
        assert.ok(stats.pages <= 3, `a repeated cursor must not page forever (got ${stats.pages})`);
    });

    it("applies un-reacts in order by default, because the backlog is an action log", async () => {
        // Measured live: a message came back with four reaction events where
        // the app showed one. Replaying in order reproduces the one.
        const pages = {
            0: [{ objs: [], more: 0 }],
            1: [
                {
                    objs: [
                        react("/-strong", 3),
                        react("/-heart", 5),
                        react(":>", 0),
                        react("", -1), // the un-react
                        react("/-heart", 5),
                    ],
                    more: 0,
                },
            ],
        };
        const l = fakeListener(pages);
        tapPages(l, pages);
        await drainReactions({ listener: l, timeoutMs: 400 });
        const left = getReactions({ msgId: "m1" });
        assert.equal(left.length, 1, "three added, all cleared, one re-added");
        assert.equal(left[0].icon, "/-heart");
    });

    it("keeps everything a message ever had when removals are skipped", async () => {
        const pages = {
            0: [{ objs: [], more: 0 }],
            1: [{ objs: [react("/-strong", 3), react("/-heart", 5), react("", -1)], more: 0 }],
        };
        const l = fakeListener(pages);
        tapPages(l, pages);
        const stats = await drainReactions({ listener: l, timeoutMs: 400, applyRemovals: false });
        assert.equal(stats.skippedRemovals, 1);
        assert.equal(getReactions({ msgId: "m1" }).length, 2, "the union, which is NOT the app's state");
    });

    it("stores a reaction naming a message the cache does not hold", async () => {
        // Reactions reach further back than a windowed message sync, and the
        // reaction is still real.
        const pages = { 0: [{ objs: [react("/-heart", 5, "ancient")], more: 0 }], 1: [{ objs: [], more: 0 }] };
        const l = fakeListener(pages);
        tapPages(l, pages);
        await drainReactions({ listener: l, timeoutMs: 400 });
        assert.equal(getReactions({ msgId: "ancient" }).length, 1);
    });

    it("reports a thread type that never answers instead of hanging", async () => {
        const pages = { 0: [], 1: [{ objs: [], more: 0 }] };
        const l = fakeListener(pages);
        tapPages(l, pages);
        const seen = [];
        const stats = await drainReactions({
            listener: l,
            timeoutMs: 150,
            onProgress: (p) => seen.push(p.phase),
        });
        assert.ok(seen.includes("timeout"));
        assert.equal(stats.received, 0);
    });

    it("refuses to run without a listener", async () => {
        await assert.rejects(() => drainReactions({}), /needs a started listener/);
    });

    it("honours the page cap and says it truncated", async () => {
        const many = Array.from({ length: 6 }, (_, i) => ({
            objs: [react("/-heart", 5, "m1", `u${i}`)],
            more: 1,
            lastActionId: String(i + 1),
        }));
        const pages = { 0: [{ objs: [], more: 0 }], 1: many };
        const l = fakeListener(pages);
        tapPages(l, pages);
        const stats = await drainReactions({ listener: l, timeoutMs: 400, maxPages: 3 });
        assert.equal(stats.truncated, true);
        assert.ok(stats.pages <= 4);
    });
});
