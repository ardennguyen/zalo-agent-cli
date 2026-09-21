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
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    initDb,
    getMessages,
    findMessageByClientId,
    getLinkMessages,
    markMessageRecalled,
    getReactions,
    insertMessage,
    upsertThread,
    getOrphanThreads,
    forgetThread,
    getSyncState,
    clearSyncState,
    setMessageLocalPath,
    getBoardItems,
    getRecentThreads,
    getThreadNames,
} from "../../src/core/db.js";
import {
    storeLiveMessage,
    storeLiveReaction,
    storeLiveUndo,
    storeLiveDelete,
    isRemovalMessage,
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

    it("does NOT copy the live status field into the Sync2 msgStatus column", () => {
        // These are two different enums. The live `status` is undocumented
        // (zca-js declares only `status: number`) and arrived as 1 -- which the
        // column defines as "failed" -- on the owner's own successfully-sent
        // messages. Delivery state comes from the mobile sync and from the
        // delivered/seen receipt events, which storeReceipts applies.
        storeLiveMessage(liveMsg({}, { msgType: "webchat", content: "hi", status: 5 }));
        assert.equal(getMessages("t1")[0].msgStatus, null);
    });

    it("refuses an event with no msgId rather than writing a junk row", () => {
        const r = storeLiveMessage(liveMsg({}, { msgId: undefined, content: "x" }));
        assert.equal(r.stored, false);
        assert.equal(getMessages("t1").length, 0);
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

describe("conversation naming", () => {
    const nameOf = (id) => getRecentThreads(50).find((t) => t.threadId === id)?.name;

    it("does not rename a group after whoever spoke in it last", () => {
        // A group has exactly ONE name, and no message carries it: `dName` is
        // the sender's display name. Letting it through renamed a synced group
        // to a member's name on its next message.
        upsertThread({ threadId: "g5", type: "group", name: "Team Marketing", lastUpdate: 1 });
        storeLiveMessage(liveMsg({ threadId: "g5", type: 1 }, { dName: "Alice", content: "hi team" }));
        assert.equal(nameOf("g5"), "Team Marketing");
    });

    it("leaves a group it has never seen unnamed rather than inventing one", () => {
        storeLiveMessage(liveMsg({ threadId: "g6", type: 1 }, { dName: "Alice", content: "hi" }));
        assert.equal(nameOf("g6"), "", "a sender's name is not the group's name");
    });

    it("names a 1-1 from the contact's own message — there the two coincide", () => {
        storeLiveMessage(liveMsg({ threadId: "u9", type: 0 }, { uidFrom: "u9", dName: "Chi Lan", content: "hi" }));
        assert.equal(nameOf("u9"), "Chi Lan");
    });

    it("does not name a 1-1 from a message we sent — that carries OUR name", () => {
        storeLiveMessage(liveMsg({ threadId: "u9", type: 0 }, { uidFrom: "me", dName: "Me", content: "hi" }));
        assert.equal(nameOf("u9"), "");
    });

    it("keeps a deliberate alias instead of the contact's current display name", () => {
        upsertThread({ threadId: "u9", type: "dm", name: "Ke toan cong ty", lastUpdate: 1 });
        storeLiveMessage(liveMsg({ threadId: "u9", type: 0 }, { uidFrom: "u9", dName: "Chi Lan", content: "hi" }));
        assert.equal(nameOf("u9"), "Ke toan cong ty");
    });

    it("accepts an authoritative name from a caller that has one", () => {
        // The MCP server holds a real group/friend index, so its name wins.
        upsertThread({ threadId: "g7", type: "group", name: "stale", lastUpdate: 1 });
        storeLiveMessage(liveMsg({ threadId: "g7", type: 1 }, { dName: "Alice", content: "x" }), {
            threadName: "Bao Tri He Thong",
        });
        assert.equal(nameOf("g7"), "Bao Tri He Thong");
    });

    it("hands every caller the same folder name for a conversation", () => {
        upsertThread({ threadId: "g8", type: "group", name: "Team Marketing", lastUpdate: 1 });
        storeLiveMessage(liveMsg({ threadId: "g8", type: 1 }, { dName: "Alice", content: "x" }));
        assert.equal(getThreadNames().get("g8").name, "Team Marketing");
    });

    it("falls back to the thread id when nothing has named the conversation", () => {
        storeLiveMessage(liveMsg({ threadId: "g9", type: 1 }, { dName: "Alice", content: "x" }));
        assert.equal(getThreadNames().get("g9").name, "g9");
    });
});

describe("board-stale flag lifecycle", () => {
    it("can be cleared, so the next sync-boards pass means something", () => {
        noteBoardChange({ threadId: "g1", type: "new_pin_topic" });
        assert.ok(getSyncState("boardStale:g1"), "set by the live event");
        clearSyncState("boardStale:g1");
        assert.equal(getSyncState("boardStale:g1"), null, "a flag never cleared is a flag always true");
    });

    it("clearing one thread's flag leaves the others alone", () => {
        noteBoardChange({ threadId: "g1", type: "unpin_topic" });
        noteBoardChange({ threadId: "g2", type: "update_board" });
        clearSyncState("boardStale:g1");
        assert.equal(getSyncState("boardStale:g1"), null);
        assert.ok(getSyncState("boardStale:g2"));
    });
});

/**
 * Removal, both kinds.
 *
 * Zalo delivers them on two different channels and names the target in two
 * different places. The previous implementation read the target from the top
 * level of the undo payload, where zca-js puts the NOTIFICATION's own id
 * (models/Undo.d.ts: TUndo has no globalMsgId, TUndoContent does), so every
 * live recall updated zero rows while reporting success -- and a delete-for-me
 * was inserted as a brand-new message row. These pin the real shapes.
 */
describe("removal — recall for everyone", () => {
    const victim = () =>
        storeLiveMessage(liveMsg({}, { msgId: "m1", cliMsgId: 4242, msgType: "webchat", content: "secret" }));

    // The shape zca-js actually emits: target inside content.
    const undoEvent = (over = {}) => ({
        threadId: "t1",
        isSelf: true,
        isGroup: false,
        data: {
            msgId: "999999",
            cliMsgId: "888888",
            msgType: "chat.undo",
            uidFrom: "u9",
            ts: 1_750_000_009_000,
            content: { globalMsgId: 1, cliMsgId: 2, deleteMsg: 3, srcId: 4, destId: 5, ...over },
        },
    });

    it("tombstones the message named by content.globalMsgId", () => {
        victim();
        const r = storeLiveUndo(undoEvent({ globalMsgId: "m1" }));
        assert.equal(r.stored, true);
        assert.equal(r.msgId, "m1");
        const [row] = getMessages("t1");
        assert.equal(row.type, "deleted");
        assert.equal(row.text, "[deleted]");
    });

    it("does NOT tombstone the notification's own id", () => {
        victim();
        storeLiveUndo(undoEvent({ globalMsgId: "m1" }));
        assert.equal(getMessages("t1").length, 1, "no row is created for the notification itself");
        assert.equal(getMessages("t1")[0].msgId, "m1");
    });

    it("reports failure when it changed nothing, instead of claiming success", () => {
        const r = storeLiveUndo(undoEvent({ globalMsgId: "never-seen" }));
        assert.equal(r.stored, false, "a recall for an uncached message is not a success");
        assert.match(r.reason, /no cached message/);
    });

    it("falls back to content.cliMsgId when no global id is given", () => {
        victim();
        const r = storeLiveUndo(undoEvent({ globalMsgId: 0, cliMsgId: 4242 }));
        assert.equal(r.stored, true);
        assert.equal(r.msgId, "m1");
    });

    it("keeps cliMsgId, which msg delete / msg undo / conv delete still need", () => {
        victim();
        storeLiveUndo(undoEvent({ globalMsgId: "m1" }));
        const raw = JSON.parse(getMessages("t1")[0].raw_data);
        assert.equal(raw.cliMsgId, "4242", "replacing raw_data wholesale made a recalled message undeletable");
    });

    it("records what was removed and why, like the phone's params.original_type", () => {
        storeLiveMessage(
            liveMsg({}, { msgId: "m2", msgType: "chat.photo", content: { href: "https://photo-stal-3.zdn.vn/a.jpg" } }),
        );
        storeLiveUndo(undoEvent({ globalMsgId: "m2" }));
        const raw = JSON.parse(getMessages("t1").find((r) => r.msgId === "m2").raw_data);
        assert.equal(raw.originalType, "photo");
        assert.equal(raw.removedAs, "recall");
        assert.ok(raw.removedAt > 0);
    });
});

describe("removal — delete for me only", () => {
    // Real captured shape: content is an ARRAY, which is why zca-js routes it
    // to the message channel rather than to undo.
    const deleteEvent = (entry) => ({
        threadId: "t1",
        type: 0,
        isSelf: true,
        data: {
            msgId: "770001",
            cliMsgId: "770002",
            msgType: "chat.delete",
            uidFrom: "u9",
            ts: 1_750_000_010_000,
            content: [{ type: 1, actionType: 0, uidFrom: "u9", uidTo: "t1", destId: "t1", ...entry }],
        },
    });

    it("is recognised as a removal, not a message", () => {
        assert.equal(isRemovalMessage({ msgType: "chat.delete" }), true);
        assert.equal(isRemovalMessage({ msgType: "chat.undo" }), true);
        assert.equal(isRemovalMessage({ msgType: "webchat" }), false);
    });

    it("applies to the target named by globalDelMsgId", () => {
        storeLiveMessage(liveMsg({}, { msgId: "m1", cliMsgId: 11, msgType: "webchat", content: "bye" }));
        const r = storeLiveDelete(deleteEvent({ globalDelMsgId: "m1", clientDelMsgId: 11 }));
        assert.equal(r.stored, true);
        assert.equal(getMessages("t1")[0].type, "deleted");
    });

    it("resolves by clientDelMsgId when globalDelMsgId is 0 — both shapes were captured live", () => {
        storeLiveMessage(liveMsg({}, { msgId: "m1", cliMsgId: 1790008960580, msgType: "webchat", content: "bye" }));
        const r = storeLiveDelete(deleteEvent({ globalDelMsgId: 0, clientDelMsgId: 1790008960580 }));
        assert.equal(r.stored, true);
        assert.equal(r.msgId, "m1");
    });

    it("creates no phantom row for the deletion notification itself", () => {
        storeLiveMessage(liveMsg({}, { msgId: "m1", cliMsgId: 11, msgType: "webchat", content: "bye" }));
        storeLiveMessage(deleteEvent({ globalDelMsgId: "m1", clientDelMsgId: 11 }));
        const rows = getMessages("t1");
        assert.equal(rows.length, 1, "the delete frame must not become a message row");
        assert.equal(rows[0].msgId, "m1");
        assert.equal(rows[0].type, "deleted");
    });

    it("routes through storeLiveMessage without ever inserting", () => {
        storeLiveMessage(liveMsg({}, { msgId: "m1", cliMsgId: 11, msgType: "webchat", content: "bye" }));
        const out = storeLiveMessage(deleteEvent({ globalDelMsgId: "m1", clientDelMsgId: 11 }));
        assert.equal(out.removal.stored, true);
        assert.equal(out.info, null, "there is no message to classify");
    });

    it("is distinguished from a recall in the stored row", () => {
        storeLiveMessage(liveMsg({}, { msgId: "m1", cliMsgId: 11, msgType: "webchat", content: "bye" }));
        storeLiveDelete(deleteEvent({ globalDelMsgId: "m1", clientDelMsgId: 11 }));
        // The phone ships one representation for both (msgType 36), so the
        // distinction only survives if we record it.
        assert.equal(JSON.parse(getMessages("t1")[0].raw_data).removedAs, "delete-for-me");
    });

    it("says so when the frame carries no usable target", () => {
        const r = storeLiveDelete({ threadId: "t1", data: { msgType: "chat.delete", content: [] } });
        assert.equal(r.stored, false);
    });
});

describe("removal — the media goes with the message", () => {
    it("takes the row out of the download queue instead of fetching a withdrawn photo", () => {
        storeLiveMessage(
            liveMsg({}, { msgId: "m1", msgType: "chat.photo", content: { href: "https://photo-stal-3.zdn.vn/a.jpg" } }),
        );
        assert.equal(getMessages("t1")[0].has_attachment, 1);
        markMessageRecalled("m1");
        const row = getMessages("t1")[0];
        assert.equal(row.has_attachment, 0, "otherwise sync-media downloads the media of a recalled message");
        assert.equal(row.localPath, null);
        assert.ok(row.mediaPrunedAt > 0, "mediaPrunedAt is the existing do-not-refetch marker");
    });

    it("deletes an already-downloaded file", () => {
        const file = join(ROOT, "victim.jpg");
        writeFileSync(file, "bytes");
        storeLiveMessage(
            liveMsg({}, { msgId: "m1", msgType: "chat.photo", content: { href: "https://photo-stal-3.zdn.vn/a.jpg" } }),
        );
        setMessageLocalPath("m1", file);
        const r = markMessageRecalled("m1");
        assert.equal(r.localPath, file, "the caller is told which file to remove");
        assert.equal(existsSync(file), true, "db layer does not touch the filesystem itself");
        // live-store is what removes it
        writeFileSync(file, "bytes");
        storeLiveMessage(
            liveMsg(
                {},
                {
                    msgId: "m2",
                    cliMsgId: 77,
                    msgType: "chat.photo",
                    content: { href: "https://photo-stal-3.zdn.vn/b.jpg" },
                },
            ),
        );
        setMessageLocalPath("m2", file);
        const out = storeLiveDelete({
            threadId: "t1",
            data: { msgType: "chat.delete", ts: 1, content: [{ globalDelMsgId: "m2" }] },
        });
        assert.equal(out.mediaRemoved, true);
        assert.equal(existsSync(file), false, "keeping the file retains exactly what was withdrawn");
    });

    it("reports missing rather than throwing for an unknown message", () => {
        const r = markMessageRecalled("nope");
        assert.equal(r.changes, 0);
        assert.equal(r.missing, true);
    });
});

describe("cache robustness against legacy rows", () => {
    it("finds a message by client id without tripping on non-JSON raw_data", () => {
        // An older writer stored the bare content string in raw_data on six
        // figures of rows; an unguarded json_extract over the table throws
        // SQLITE_ERROR "malformed JSON" and takes the whole query with it.
        insertMessage({
            msgId: "legacy",
            threadId: "t1",
            senderId: "u",
            senderName: "",
            text: "hello",
            timestamp: 1,
            type: "text",
            raw_data: "hello",
        });
        storeLiveMessage(liveMsg({}, { msgId: "m1", cliMsgId: 55, msgType: "webchat", content: "x" }));
        const found = findMessageByClientId(55);
        assert.equal(found?.msgId, "m1");
    });

    it("getLinkMessages survives a cache holding non-JSON raw_data", () => {
        insertMessage({
            msgId: "legacy",
            threadId: "t1",
            senderId: "u",
            senderName: "",
            text: "hello",
            timestamp: 1,
            type: "text",
            raw_data: "hello",
        });
        storeLiveMessage(
            liveMsg({}, { msgId: "m1", msgType: "chat.recommended", content: { href: "https://e.com/x", title: "T" } }),
        );
        assert.doesNotThrow(() => getLinkMessages({ threadId: "t1" }));
    });

    it("normalizes legacy row types on open, so a removal query is not short", () => {
        insertMessage({
            msgId: "old1",
            threadId: "t1",
            senderId: "u",
            senderName: "",
            text: "[deleted]",
            timestamp: 1,
            type: "chat.undo",
            raw_data: "{}",
        });
        insertMessage({
            msgId: "old2",
            threadId: "t1",
            senderId: "u",
            senderName: "",
            text: "hi",
            timestamp: 2,
            type: "webchat",
            raw_data: "{}",
        });
        const path = join(ROOT, `legacy${n++}.sqlite`);
        // re-open the SAME file to trigger the migration
        const h = opened[opened.length - 1];
        h.close();
        opened.push(initDb(h.name));
        const types = getMessages("t1", 50).reduce((a, r) => ((a[r.type] = (a[r.type] || 0) + 1), a), {});
        assert.equal(types["chat.undo"], undefined, "a legacy removal row must be findable as 'deleted'");
        assert.equal(types["webchat"], undefined);
        assert.ok(types.deleted >= 1);
        assert.ok(path);
    });
});

describe("msgStatus is not written from the live status field", () => {
    it("leaves msgStatus NULL for a live message", () => {
        // The live `status` field is an undocumented enum, not Sync2's
        // MessageStatus: the owner's own successfully-sent messages arrived
        // carrying 1, which this column defines as "failed".
        storeLiveMessage(liveMsg({}, { msgType: "webchat", content: "hi", status: 1 }));
        assert.equal(getMessages("t1")[0].msgStatus, null);
    });

    it("still takes a real receipt", () => {
        storeLiveMessage(liveMsg({}, { msgType: "webchat", content: "hi", status: 1 }));
        storeReceipts([{ data: { msgId: "m1" } }], 4);
        assert.equal(getMessages("t1")[0].msgStatus, 4);
    });

    it("keeps NULL as NULL across a re-insert rather than collapsing it to 0", () => {
        storeLiveMessage(liveMsg({}, { msgType: "webchat", content: "hi" }));
        storeLiveMessage(liveMsg({}, { msgType: "webchat", content: "hi again" }));
        assert.equal(getMessages("t1")[0].msgStatus, null, "unknown is not the same as status 0");
    });
});

/**
 * Reactions, with the shape Zalo actually sends.
 *
 * The reacted-to message is named in `content.rMsg[]` (`gMsgID` / `cMsgID`),
 * not by the event's own `msgId` — which identifies the reaction
 * notification. Reading the latter filed six live reactions under six
 * notification ids, so `getReactions({msgId})` for the real message returned
 * nothing. These pin the captured shape.
 */
describe("storeLiveReaction", () => {
    const reactEvent = (over = {}, content = {}) => ({
        threadId: "t1",
        isSelf: true,
        isGroup: true,
        data: {
            actionId: "1721009213808",
            msgId: "8289917724705", // the NOTIFICATION's id
            cliMsgId: "1790013228896",
            msgType: "chat.reaction",
            uidFrom: "u2",
            idTo: "t1",
            ts: "1790013230126",
            content: {
                rMsg: [{ gMsgID: "m1", cMsgID: 1790008981269, msgType: 1 }],
                rIcon: "/-strong",
                rType: 3,
                source: 6,
                ...content,
            },
            ...over,
        },
    });

    const target = () =>
        storeLiveMessage(liveMsg({}, { msgId: "m1", cliMsgId: 1790008981269, msgType: "webchat", content: "hi" }));

    it("stores the reaction against the message reacted to, not the notification", () => {
        target();
        const r = storeLiveReaction(reactEvent());
        assert.equal(r.stored, true);
        const [got] = getReactions({ msgId: "m1" });
        assert.ok(got, "the reaction has to be findable by the message it is on");
        assert.equal(got.icon, "/-strong");
        assert.equal(got.userId, "u2");
        assert.equal(getReactions({ msgId: "8289917724705" }).length, 0, "nothing under the notification id");
    });

    it("keeps EVERY icon one person puts on a message — Zalo accumulates", () => {
        // Confirmed against the app: three icons sent to one message show as
        // three. A (msgId, userId) key kept only the last and dropped two.
        target();
        storeLiveReaction(reactEvent({}, { rIcon: "/-strong", rType: 3 }));
        storeLiveReaction(reactEvent({ msgId: "notif2" }, { rIcon: "/-heart", rType: 5 }));
        storeLiveReaction(reactEvent({ msgId: "notif3" }, { rIcon: ":>", rType: 0 }));
        const all = getReactions({ msgId: "m1" });
        assert.equal(all.length, 3);
        assert.deepEqual(all.map((r) => r.icon).sort(), ["/-heart", "/-strong", ":>"]);
    });

    it("is idempotent — the same icon twice is still one row", () => {
        target();
        storeLiveReaction(reactEvent({}, { rIcon: "/-heart", rType: 5 }));
        storeLiveReaction(reactEvent({ msgId: "notif2" }, { rIcon: "/-heart", rType: 5 }));
        assert.equal(getReactions({ msgId: "m1" }).length, 1);
    });

    it("keeps two people's identical icons apart", () => {
        target();
        storeLiveReaction(reactEvent({ uidFrom: "u2" }, { rIcon: "/-heart", rType: 5 }));
        storeLiveReaction(reactEvent({ uidFrom: "u3", msgId: "notif2" }, { rIcon: "/-heart", rType: 5 }));
        assert.equal(getReactions({ msgId: "m1" }).length, 2);
    });

    it("preserves rType 0, which is a real type (HAHA)", () => {
        target();
        storeLiveReaction(reactEvent({}, { rIcon: ":>", rType: 0 }));
        assert.equal(getReactions({ msgId: "m1" })[0].rType, 0, "`|| null` threw a real value away");
    });

    it("clears every icon on the message when un-reacted — the captured shape is rIcon '' with rType -1", () => {
        // Zalo's removal is all-or-nothing: the app has no way to drop one of
        // several icons, and the frame carries rType -1 as a SENTINEL. Matching
        // it as a type deleted nothing and left three stale reactions behind.
        target();
        storeLiveReaction(reactEvent({}, { rIcon: "/-strong", rType: 3 }));
        storeLiveReaction(reactEvent({ msgId: "n2" }, { rIcon: "/-heart", rType: 5 }));
        storeLiveReaction(reactEvent({ msgId: "n3" }, { rIcon: ":>", rType: 0 }));
        assert.equal(getReactions({ msgId: "m1" }).length, 3);
        storeLiveReaction(reactEvent({ msgId: "n4" }, { rIcon: "", rType: -1 }));
        assert.equal(getReactions({ msgId: "m1" }).length, 0);
    });

    it("clears them whatever rType a removal carries", () => {
        target();
        storeLiveReaction(reactEvent({}, { rIcon: "/-strong", rType: 3 }));
        storeLiveReaction(reactEvent({ msgId: "n2" }, { rIcon: "", rType: null }));
        assert.equal(getReactions({ msgId: "m1" }).length, 0);
    });

    it("a removal touches only that person, on only that message", () => {
        target();
        storeLiveMessage(liveMsg({}, { msgId: "m2", msgType: "webchat", content: "other" }));
        storeLiveReaction(reactEvent({ uidFrom: "u2" }, { rIcon: "/-heart", rType: 5 }));
        storeLiveReaction(reactEvent({ uidFrom: "u3", msgId: "n2" }, { rIcon: "/-heart", rType: 5 }));
        storeLiveReaction(
            reactEvent({ uidFrom: "u2", msgId: "n3" }, { rIcon: "/-heart", rType: 5, rMsg: [{ gMsgID: "m2" }] }),
        );
        storeLiveReaction(reactEvent({ uidFrom: "u2", msgId: "n4" }, { rIcon: "", rType: -1 }));
        const left = getReactions({ msgId: "m1" });
        assert.equal(left.length, 1, "u3's reaction survives");
        assert.equal(left[0].userId, "u3");
        assert.equal(getReactions({ msgId: "m2" }).length, 1, "u2's reaction on another message survives");
    });

    it("resolves by cMsgID when gMsgID is absent", () => {
        target();
        const r = storeLiveReaction(reactEvent({}, { rMsg: [{ gMsgID: 0, cMsgID: 1790008981269 }] }));
        assert.equal(r.stored, true);
        assert.equal(getReactions({ msgId: "m1" }).length, 1);
    });

    it("handles a reaction naming several messages", () => {
        target();
        storeLiveMessage(liveMsg({}, { msgId: "m2", msgType: "webchat", content: "hi2" }));
        const r = storeLiveReaction(reactEvent({}, { rMsg: [{ gMsgID: "m1" }, { gMsgID: "m2" }] }));
        assert.equal(r.count, 2);
        assert.equal(getReactions({ threadId: "t1" }).length, 2);
    });

    it("reports a reaction that names no message instead of writing a junk row", () => {
        const r = storeLiveReaction(reactEvent({}, { rMsg: [] }));
        assert.equal(r.stored, false);
        assert.equal(getReactions({ threadId: "t1" }).length, 0);
    });

    it("stores a reaction for a message this cache never saw, keyed by its real id", () => {
        // Zalo can name a message older than anything cached; the reaction is
        // still real and the id is still the right key.
        const r = storeLiveReaction(reactEvent({}, { rMsg: [{ gMsgID: "ancient" }] }));
        assert.equal(r.stored, true);
        assert.equal(getReactions({ msgId: "ancient" }).length, 1);
    });
});
