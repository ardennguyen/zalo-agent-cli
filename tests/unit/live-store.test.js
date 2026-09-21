/**
 * src/core/live-store.js — the one place live socket events become rows.
 *
 * `listen` and a running mobile sync both funnel through this, because Zalo Web
 * does not freeze while a sync runs: messages keep arriving on the same socket
 * and keep being stored. A sync that ignored them left a hole exactly where it
 * promised completeness.
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    initDb,
    getMessages,
    getReactions,
    insertMessage,
    upsertThread,
    getOrphanThreads,
    forgetThread,
    getSyncState,
    getBoardItems,
} from "../../src/core/db.js";
import {
    storeLiveMessage,
    storeLiveReaction,
    storeLiveUndo,
    attachLiveStore,
    storeGroupEvent,
    noteBoardChange,
    storeReceipts,
} from "../../src/core/live-store.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-live-test-"));
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

const liveMsg = (over = {}, data = {}) => ({
    threadId: "t1",
    type: 0,
    isSelf: false,
    data: { msgId: "m1", cliMsgId: 7, uidFrom: "u9", dName: "Someone", ts: 1_750_000_000_000, ...data },
    ...over,
});

describe("storeLiveMessage", () => {
    it("stores a text message in the shared vocabulary", () => {
        const r = storeLiveMessage(liveMsg({}, { msgType: "webchat", content: "hello" }));
        assert.equal(r.stored, true);
        const [row] = getMessages("t1");
        assert.equal(row.type, "text");
        assert.equal(row.text, "hello");
        assert.equal(row.has_attachment, 0);
    });

    it("stores a photo as `photo`, not as zca-js's `chat.photo`", () => {
        storeLiveMessage(
            liveMsg({}, { msgType: "chat.photo", content: { href: "https://photo-stal-3.zdn.vn/a/b.jpg" } }),
        );
        const [row] = getMessages("t1");
        assert.equal(row.type, "photo");
        assert.equal(row.has_attachment, 1, "otherwise sync-media can never see it");
    });

    it("records msgStatus so delivery state survives", () => {
        storeLiveMessage(liveMsg({}, { msgType: "webchat", content: "hi", status: 5 }));
        assert.equal(getMessages("t1")[0].msgStatus, 5);
    });

    it("refuses an event with no msgId rather than writing a junk row", () => {
        const r = storeLiveMessage(liveMsg({}, { msgId: undefined, content: "x" }));
        assert.equal(r.stored, false);
        assert.equal(getMessages("t1").length, 0);
    });
});

describe("storeLiveReaction", () => {
    it("stores a reaction — the sync payload has none, so this is the only source", () => {
        const r = storeLiveReaction({ threadId: "t1", data: { msgId: "m1", uidFrom: "u2", rIcon: "/-heart", ts: 5 } });
        assert.equal(r.stored, true);
        const [got] = getReactions({ msgId: "m1" });
        assert.equal(got.icon, "/-heart");
        assert.equal(got.userId, "u2");
    });

    it("replaces rather than duplicating when someone reacts again", () => {
        const base = { threadId: "t1", data: { msgId: "m1", uidFrom: "u2", ts: 1 } };
        storeLiveReaction({ ...base, data: { ...base.data, rIcon: ":>" } });
        storeLiveReaction({ ...base, data: { ...base.data, rIcon: "/-heart" } });
        const all = getReactions({ msgId: "m1" });
        assert.equal(all.length, 1);
        assert.equal(all[0].icon, "/-heart");
    });

    it("an empty icon removes the reaction", () => {
        storeLiveReaction({ threadId: "t1", data: { msgId: "m1", uidFrom: "u2", rIcon: ":>" } });
        storeLiveReaction({ threadId: "t1", data: { msgId: "m1", uidFrom: "u2", rIcon: "" } });
        assert.equal(getReactions({ msgId: "m1" }).length, 0);
    });

    it("keeps different people's reactions separate", () => {
        storeLiveReaction({ threadId: "t1", data: { msgId: "m1", uidFrom: "a", rIcon: ":>" } });
        storeLiveReaction({ threadId: "t1", data: { msgId: "m1", uidFrom: "b", rIcon: "/-heart" } });
        assert.equal(getReactions({ msgId: "m1" }).length, 2);
    });

    it("refuses an event missing msgId or userId", () => {
        assert.equal(storeLiveReaction({ data: { uidFrom: "u" } }).stored, false);
        assert.equal(storeLiveReaction({ data: { msgId: "m" } }).stored, false);
    });
});

describe("storeLiveUndo", () => {
    const seed = () =>
        insertMessage({
            msgId: "orig",
            threadId: "t1",
            senderId: "u1",
            senderName: "",
            text: "something private",
            timestamp: 1,
            type: "text",
        });

    it("marks the recalled message instead of leaving its text readable", () => {
        // A recall withdraws a message for everyone; a cache that keeps the
        // text is retaining something the sender took back.
        seed();
        const r = storeLiveUndo({ threadId: "t1", data: { globalMsgId: "orig", ts: 99 } });
        assert.equal(r.stored, true);
        const [row] = getMessages("t1");
        assert.equal(row.type, "deleted");
        assert.notEqual(row.text, "something private");
    });

    it("keeps the row so the conversation still shows something was said", () => {
        seed();
        storeLiveUndo({ threadId: "t1", data: { globalMsgId: "orig" } });
        assert.equal(getMessages("t1").length, 1, "the row must not be deleted outright");
    });

    it("accepts msgId as well as globalMsgId", () => {
        seed();
        assert.equal(storeLiveUndo({ data: { msgId: "orig" } }).stored, true);
    });

    it("refuses an undo with no target", () => {
        assert.equal(storeLiveUndo({ data: {} }).stored, false);
    });
});

describe("attachLiveStore", () => {
    /** Minimal EventEmitter-shaped stub of api.listener. */
    const fakeListener = () => {
        const handlers = {};
        return {
            handlers,
            on(ev, fn) {
                if (!handlers[ev]) handlers[ev] = [];
                handlers[ev].push(fn);
            },
            removeListener(ev, fn) {
                handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn);
            },
            fire(ev, payload) {
                for (const f of handlers[ev] || []) f(payload);
            },
        };
    };

    it("stores messages arriving while a sync holds the socket", () => {
        const l = fakeListener();
        attachLiveStore(l);
        l.fire("message", liveMsg({}, { msgType: "webchat", content: "during the sync" }));
        assert.equal(getMessages("t1")[0].text, "during the sync");
    });

    it("subscribes to messages, reactions and recalls", () => {
        const l = fakeListener();
        attachLiveStore(l);
        for (const ev of ["message", "reaction", "undo"]) {
            assert.equal((l.handlers[ev] || []).length, 1, `${ev} not subscribed`);
        }
    });

    it("detaches cleanly so a finished sync stops writing", () => {
        const l = fakeListener();
        const detach = attachLiveStore(l);
        detach();
        l.fire("message", liveMsg({}, { msgType: "webchat", content: "after detach" }));
        assert.equal(getMessages("t1").length, 0);
    });

    it("reports what it stored", () => {
        const l = fakeListener();
        const seen = [];
        attachLiveStore(l, (what) => seen.push(what));
        l.fire("message", liveMsg({}, { msgType: "webchat", content: "x" }));
        assert.deepEqual(seen, ["message"]);
    });
});

describe("storeGroupEvent — leaving a conversation", () => {
    it("flags the thread when we leave", () => {
        upsertThread({ threadId: "g1", type: "group", name: "Old Group", lastUpdate: 1 });
        const r = storeGroupEvent({ type: "leave", threadId: "g1", isSelf: true });
        assert.equal(r.gone, true);
        assert.equal(getOrphanThreads().length, 1);
    });

    it("ignores someone ELSE leaving", () => {
        upsertThread({ threadId: "g1", type: "group", name: "Still Ours", lastUpdate: 1 });
        assert.equal(storeGroupEvent({ type: "leave", threadId: "g1", isSelf: false }).gone, false);
        assert.equal(getOrphanThreads().length, 0);
    });

    it("ignores events that do not mean we are out", () => {
        upsertThread({ threadId: "g1", type: "group", name: "G", lastUpdate: 1 });
        for (const t of ["update", "new_link", "add_admin", "new_pin_topic"]) {
            assert.equal(storeGroupEvent({ type: t, threadId: "g1", isSelf: true }).gone, false, t);
        }
        assert.equal(getOrphanThreads().length, 0);
    });

    it("deletes nothing — being removed is not permission to destroy the copy", () => {
        upsertThread({ threadId: "g1", type: "group", name: "G", lastUpdate: 1 });
        insertMessage({
            msgId: "keep",
            threadId: "g1",
            senderId: "u",
            senderName: "",
            text: "still here",
            timestamp: 1,
            type: "text",
        });
        storeGroupEvent({ type: "remove_member", threadId: "g1", isSelf: true });
        assert.equal(getMessages("g1").length, 1, "history must survive until explicitly forgotten");
    });
});

describe("forgetThread / getOrphanThreads", () => {
    const seed = (threadId) => {
        upsertThread({ threadId, type: "group", name: threadId, lastUpdate: 1 });
        insertMessage({
            msgId: `${threadId}-m`,
            threadId,
            senderId: "u",
            senderName: "",
            text: "hello",
            timestamp: 1,
            type: "text",
        });
    };

    it("finds threads absent from the live conversation list", () => {
        seed("g1");
        seed("g2");
        const orphans = getOrphanThreads(["g1"]);
        assert.equal(orphans.length, 1);
        assert.equal(orphans[0].threadId, "g2");
    });

    it("counts what each orphan is holding", () => {
        seed("g1");
        const [o] = getOrphanThreads([]);
        assert.equal(o.messages, 1);
        assert.equal(o.files, 0);
    });

    it("without a live list, only explicitly-flagged threads count", () => {
        seed("g1");
        assert.equal(getOrphanThreads().length, 0, "an unflagged thread is not assumed gone");
        storeGroupEvent({ type: "leave", threadId: "g1", isSelf: true });
        assert.equal(getOrphanThreads().length, 1);
    });

    it("forgetThread removes every trace of one conversation", () => {
        seed("g1");
        seed("g2");
        const counts = forgetThread("g1");
        assert.equal(counts.messages, 1);
        assert.equal(counts.threads, 1);
        assert.equal(getMessages("g1").length, 0);
        assert.equal(getMessages("g2").length, 1, "other conversations are untouched");
    });

    it("forgetThread on an unknown thread is a no-op, not an error", () => {
        const counts = forgetThread("nope");
        assert.equal(counts.messages, 0);
        assert.equal(counts.threads, 0);
    });
});

describe("board changes and delivery receipts — the rest of the live path", () => {
    it("flags a thread stale on pin, unpin, board and reminder events", () => {
        for (const t of ["new_pin_topic", "unpin_topic", "update_board", "remove_topic", "remind_topic"]) {
            const r = noteBoardChange({ type: t, threadId: `g-${t}` });
            assert.equal(r.stale, true, t);
            assert.ok(getSyncState(`boardStale:g-${t}`), `${t} should record the flag`);
        }
    });

    it("applies to 1-1 conversations as much as to groups", () => {
        // Pin/unpin/reminder are not group-specific.
        assert.equal(noteBoardChange({ type: "new_pin_topic", threadId: "u1" }).stale, true);
        assert.ok(getSyncState("boardStale:u1"));
    });

    it("ignores group events that do not touch a board", () => {
        for (const t of ["join", "update_avatar", "add_admin", "new_link"]) {
            assert.equal(noteBoardChange({ type: t, threadId: "g1" }).stale, false, t);
        }
    });

    it("writes no board row from a delta it cannot fully populate", () => {
        // The event carries a change, not the item's shape; inventing a row
        // would be worse than refetching one.
        noteBoardChange({ type: "new_pin_topic", threadId: "g1" });
        assert.equal(getBoardItems("g1").length, 0);
    });

    it("advances msgStatus on a delivery receipt", () => {
        insertMessage({
            msgId: "m1",
            threadId: "t1",
            senderId: "u",
            senderName: "",
            text: "x",
            timestamp: 1,
            type: "text",
            msgStatus: 3,
        });
        assert.equal(storeReceipts({ data: { msgId: "m1" } }, 4).updated, 1);
        assert.equal(getMessages("t1")[0].msgStatus, 4);
    });

    it("never walks delivery state backwards", () => {
        // A late "delivered" must not undo a "seen" that already landed.
        insertMessage({
            msgId: "m1",
            threadId: "t1",
            senderId: "u",
            senderName: "",
            text: "x",
            timestamp: 1,
            type: "text",
            msgStatus: 5,
        });
        storeReceipts({ data: { msgId: "m1" } }, 4);
        assert.equal(getMessages("t1")[0].msgStatus, 5, "seen must survive a later delivered");
    });

    it("handles a batch of receipts", () => {
        for (const id of ["a", "b", "c"]) {
            insertMessage({
                msgId: id,
                threadId: "t1",
                senderId: "u",
                senderName: "",
                text: "x",
                timestamp: 1,
                type: "text",
                msgStatus: 3,
            });
        }
        const r = storeReceipts([{ data: { msgId: "a" } }, { data: { msgId: "b" } }], 5);
        assert.equal(r.updated, 2);
    });

    it("shrugs off a receipt for a message it does not have", () => {
        assert.equal(storeReceipts({ data: { msgId: "unknown" } }, 5).updated, 0);
    });
});
