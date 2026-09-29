/**
 * storeHistoryMessage -- the one writer msg history's fetches go through.
 *
 * Insert-if-absent, as Zalo Web writes the history it fetches (findMsgsAddDb,
 * then ZStorage.setMessage with replace:false): a msgId already in zalo.db is
 * left exactly as it is, every column; a new one is written with the
 * listener's normalization, so the two are indistinguishable but for the
 * provenance tag. Zalo Web's two other guards are mirrored where our schema
 * has the data: removal and empty rows are never written, and nothing older
 * than a conversation's delete marker (threads.leftAt, which conv delete sets)
 * comes back.
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    initDb,
    getMessageById,
    getMessages,
    setMessageLocalPath,
    setMessageStatus,
    markMessageRecalled,
    upsertThread,
    markThreadGone,
    getRecentThreads,
    getThreadType,
} from "../../src/core/db.js";
import { storeLiveMessage, storeHistoryMessage } from "../../src/core/live-store.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-history-write-"));
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

const TS = 1_790_000_000_000;
const PHOTO = { msgType: "chat.photo", content: { href: "https://photo.zalo.invalid/p.jpg" } };

/** A frame as msg history hands it over: the listener's own shape. */
const frame = (data = {}, over = {}) => ({
    threadId: "g1",
    type: 1,
    data: { msgId: "m1", cliMsgId: "7", uidFrom: "u9", dName: "Someone", ts: String(TS), ...data },
    ...over,
});

const thread = (id) => getRecentThreads(100).find((t) => t.threadId === id) || null;

/** `obj` without the named keys. */
const omit = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

describe("storeHistoryMessage", () => {
    it("writes a message it does not hold exactly as the listener would, tagged as history", () => {
        assert.equal(storeHistoryMessage(frame({ ...PHOTO, msgId: "h1" })).stored, true);
        storeLiveMessage(frame({ ...PHOTO, msgId: "l1" }));

        const h = getMessageById("h1");
        const l = getMessageById("l1");
        assert.deepEqual(omit(h, "msgId", "raw_data"), omit(l, "msgId", "raw_data"));
        const rawH = JSON.parse(h.raw_data);
        const rawL = JSON.parse(l.raw_data);
        assert.deepEqual(omit(rawH, "src"), omit(rawL, "src"));
        assert.deepEqual([rawH.src, rawL.src], ["history", "listen"]);
    });

    it("leaves a stored row alone, every column, whatever the fetch says", () => {
        storeLiveMessage(frame({ ...PHOTO, st: 3, at: 9, cmd: 521 }));
        setMessageLocalPath("m1", "/media/g1/p.jpg");
        setMessageStatus("m1", 3);
        const before = getMessageById("m1");

        const r = storeHistoryMessage(
            frame({ msgType: "webchat", content: "a different copy", dName: "Renamed", ts: String(TS + 99_999) }),
        );

        assert.equal(r.stored, false);
        assert.deepEqual(getMessageById("m1"), before);
    });

    it("leaves a tombstone alone too -- even its timestamp, which the listener would move", () => {
        storeLiveMessage(frame({ msgType: "webchat", content: "said" }));
        markMessageRecalled("m1", TS + 500, { reason: "recall" });
        const tomb = getMessageById("m1");

        storeHistoryMessage(frame({ msgType: "webchat", content: "said", ts: String(TS + 1_000) }));

        assert.deepEqual(getMessageById("m1"), tomb);
    });

    it("never applies a removal from history, and never stores one as a message", () => {
        storeLiveMessage(frame({ msgType: "webchat", content: "keep me" }));
        const before = getMessageById("m1");

        const del = frame({
            msgId: "d1",
            msgType: "chat.delete",
            content: [{ globalDelMsgId: "m1", clientDelMsgId: "7" }],
        });
        const undo = frame({ msgId: "u1", msgType: "chat.undo", content: { globalMsgId: "m1", cliMsgId: "7" } });

        assert.equal(storeHistoryMessage(del).stored, false);
        assert.equal(storeHistoryMessage(undo).stored, false);
        assert.deepEqual(getMessageById("m1"), before, "a history frame removed a stored message");
        assert.equal(getMessageById("d1"), null);
        assert.equal(getMessageById("u1"), null);
    });

    it("skips rows with no content and rows with no timestamp", () => {
        assert.equal(storeHistoryMessage(frame({ msgId: "e1", msgType: "webchat", content: "" })).stored, false);
        assert.equal(
            storeHistoryMessage(frame({ msgId: "e2", msgType: "webchat", content: "x", ts: undefined })).stored,
            false,
        );
        assert.deepEqual(getMessages("g1"), []);
    });

    it("skips rows from before the conversation's delete marker, keeps later ones", () => {
        upsertThread({ threadId: "g1", type: "group", name: "Group", lastUpdate: TS });
        markThreadGone("g1", TS + 1_000);

        storeHistoryMessage(frame({ msgId: "old", msgType: "webchat", content: "before", ts: String(TS + 999) }));
        storeHistoryMessage(frame({ msgId: "same", msgType: "webchat", content: "at", ts: String(TS + 1_000) }));
        storeHistoryMessage(frame({ msgId: "new", msgType: "webchat", content: "after", ts: String(TS + 1_001) }));

        assert.equal(getMessageById("old"), null);
        assert.equal(getMessageById("same"), null);
        assert.ok(getMessageById("new"));
    });

    it("touches the thread row only when it writes a message, and then as the listener does", () => {
        storeHistoryMessage(frame({ msgId: "e1", msgType: "webchat", content: "" }, { threadId: "g2" }));
        assert.equal(getThreadType("g2"), null, "a skipped row created a thread");

        upsertThread({ threadId: "g1", type: "group", name: "Real Name", lastUpdate: TS + 5_000 });
        storeLiveMessage(frame({ msgType: "webchat", content: "held" }));
        const heldThread = thread("g1");
        // Already stored; its newer time would move lastUpdate if the thread were touched.
        storeHistoryMessage(frame({ msgType: "webchat", content: "held", ts: String(TS + 9_999) }));
        assert.deepEqual(thread("g1"), heldThread, "a skipped row updated its thread");

        storeHistoryMessage(frame({ msgId: "m2", msgType: "webchat", content: "older", ts: String(TS + 1) }));
        const t = thread("g1");
        assert.equal(t.name, "Real Name", "a member's name must not rename the group");
        assert.equal(t.lastUpdate, TS + 5_000, "an older message must not move lastUpdate back");

        storeHistoryMessage(frame({ msgId: "m3", msgType: "webchat", content: "first seen" }, { threadId: "g3" }));
        assert.equal(getThreadType("g3"), "group");
    });
});
