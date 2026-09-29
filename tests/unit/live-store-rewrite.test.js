/**
 * What the listener's writer does to a message it already holds.
 *
 * storeLiveMessage is an upsert (db.js insertMessage, ON CONFLICT(msgId) DO
 * UPDATE): a later frame for the same msgId replaces most of the row, while a
 * few fields are protected. msg history's write-back is deliberately NOT this
 * -- it inserts only rows it does not have (storeHistoryMessage) -- and these
 * tests pin the listener's side so that adding one cannot quietly change the
 * other. Each assertion is current behavior, pinned so a change is deliberate.
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    initDb,
    getMessageById,
    setMessageLocalPath,
    setMessageStatus,
    markMessageRecalled,
} from "../../src/core/db.js";
import { storeLiveMessage } from "../../src/core/live-store.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-live-rewrite-"));
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

const PHOTO = { msgType: "chat.photo", content: { href: "https://photo.zalo.invalid/p.jpg" } };

const frame = (data = {}) => ({
    threadId: "t1",
    type: 0,
    isSelf: false,
    data: { msgId: "m1", cliMsgId: "7", uidFrom: "u9", dName: "Someone", ts: 1_750_000_000_000, ...data },
});

describe("storeLiveMessage on a message it already holds (the listener's contract)", () => {
    it("replaces text, type, raw_data, timestamp and has_attachment", () => {
        storeLiveMessage(frame({ ...PHOTO, st: 3, at: 9, cmd: 501 }));
        storeLiveMessage(frame({ msgType: "webchat", content: "second copy", ts: 1_750_000_009_999 }));

        const row = getMessageById("m1");
        assert.equal(row.text, "second copy");
        assert.equal(row.type, "text");
        assert.equal(row.has_attachment, 0);
        assert.equal(row.timestamp, 1_750_000_009_999);
        const raw = JSON.parse(row.raw_data);
        assert.equal(raw.content, "second copy");
        assert.equal(raw.at, undefined, "the later frame's raw_data replaced the earlier one's st/at/cmd");
    });

    it("keeps localPath and msgStatus, which later events put on the row", () => {
        storeLiveMessage(frame(PHOTO));
        setMessageLocalPath("m1", "/media/t1/p.jpg");
        setMessageStatus("m1", 3);
        storeLiveMessage(frame(PHOTO));

        const row = getMessageById("m1");
        assert.equal(row.localPath, "/media/t1/p.jpg");
        assert.equal(row.msgStatus, 3);
    });

    it("keeps the sender and thread it first stored", () => {
        storeLiveMessage(frame({ msgType: "webchat", content: "a" }));
        storeLiveMessage(frame({ msgType: "webchat", content: "b", uidFrom: "u8", dName: "Other" }));

        const row = getMessageById("m1");
        assert.equal(row.senderId, "u9");
        assert.equal(row.senderName, "Someone");
        assert.equal(row.threadId, "t1");
    });

    it("does not bring a tombstone back, though its timestamp still moves", () => {
        storeLiveMessage(frame({ msgType: "webchat", content: "said" }));
        markMessageRecalled("m1", 1_750_000_000_500, { reason: "recall" });
        const tomb = getMessageById("m1");
        storeLiveMessage(frame({ msgType: "webchat", content: "said again", ts: 1_750_000_001_000 }));

        const row = getMessageById("m1");
        assert.equal(row.type, "deleted");
        assert.equal(row.text, tomb.text);
        assert.equal(row.raw_data, tomb.raw_data);
        assert.equal(row.has_attachment, tomb.has_attachment);
        // The one column a re-store rewrites even on a tombstone.
        assert.equal(row.timestamp, 1_750_000_001_000);
    });
});
