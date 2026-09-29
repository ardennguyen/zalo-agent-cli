/**
 * `msg history` writes what it fetched into zalo.db -- insert-if-absent.
 *
 * Arden's rule (2026-09-30): msg history may cache fetched history if Zalo
 * Web does, and it does. Zalo Web writes getrecentv2/getoldv2 rows into the
 * same local message table as live messages, through the same writer
 * (ZStorage.setMessage -> Core.Message.insertMulti), but only rows it does not
 * already hold, and with replace:false -- a stored row is never overwritten
 * (findMsgsAddDb / addMessageAndUpdateConvDb in its bundle).
 *
 * So both fetch paths -- the cloud-message store and the socket scan -- go
 * through one write-back that inserts a row only when its msgId is new. A row
 * the listener stored keeps everything the listener and later events put on
 * it: localPath, the receipt's msgStatus, the st/at/cmd a seen receipt needs.
 *
 * Each test runs the real command on a real zca-js session whose transport is
 * ./fake-zalo-session.js and reads zalo.db afterwards.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    initDb,
    getMessageById,
    setMessageLocalPath,
    setMessageStatus,
    upsertThread,
    markThreadGone,
} from "../../src/core/db.js";
import { storeLiveMessage } from "../../src/core/live-store.js";
import { registerMsgCommands } from "../../src/commands/msg.js";
import { FAKE, installFakeZalo, loginFake, runCommand, serveOldMessages } from "./fake-zalo-session.js";

const GID = "7000000000000000001";
const PEER = "3000000000000000003";
const MEMBER = "2000000000000000002";
const DB_PATH = join(CONFIG_DIR, "accounts", FAKE.ownId, "zalo.db");

let seq = 0;
/** A msgId no other test in this file uses. */
const freshId = () => String(8300000000000 + 100 * ++seq);

/** getrecentv2's `data`: a JSON string, as captured. */
const cloudPage = (groupMsgs, extra = {}) =>
    JSON.stringify({ error: 0, lastMsgId: "0", hasMore: 0, isOld: 0, groupMsgs, ...extra });

/** A message row as Zalo sends it (socket frame / cloud row share this shape). */
function wire(msgId, threadId, over = {}) {
    const n = Number(msgId.slice(-6));
    return {
        msgId,
        cliMsgId: String(1790000000000 + n),
        msgType: "webchat",
        uidFrom: MEMBER,
        idTo: threadId,
        dName: "Member",
        ts: String(1790000000000 + n * 10),
        content: `text ${msgId}`,
        ...over,
    };
}

/**
 * Store a message the way `listen` does, then enrich it the way the media
 * downloader and a seen receipt do. Returns the stored row.
 */
function listenerStoredPhoto(msgId, threadId, type) {
    initDb(DB_PATH);
    const frame = {
        threadId,
        type,
        isSelf: false,
        data: wire(msgId, threadId, {
            msgType: "chat.photo",
            content: { href: "https://photo.zalo.invalid/p.jpg", thumb: "https://photo.zalo.invalid/t.jpg" },
            // What a seen receipt needs and nothing but the socket frame carries.
            st: 3,
            at: 9,
            cmd: type === 1 ? 521 : 501,
        }),
    };
    assert.equal(storeLiveMessage(frame).stored, true);
    setMessageLocalPath(msgId, join(CONFIG_DIR, "accounts", FAKE.ownId, "media", threadId, "p.jpg"));
    setMessageStatus(msgId, 3);
    const row = getMessageById(msgId);
    assert.ok(row.localPath && row.msgStatus === 3 && JSON.parse(row.raw_data).at === 9, "seed incomplete");
    return row;
}

/** The same msgId as Zalo might return it on a later fetch: different text, time and no st/at/cmd. */
const refetched = (msgId, threadId) =>
    wire(msgId, threadId, {
        msgType: "webchat",
        content: "a different copy of the same message",
        dName: "Member (renamed)",
        ts: "1799999999999",
    });

/** `obj` without the named keys. */
const omit = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

/** Read a row back through the db module, reopening the file msg history used. */
function stored(msgId) {
    initDb(DB_PATH);
    return getMessageById(msgId);
}

describe("msg history writes fetched history insert-if-absent", () => {
    let fake;
    let api;

    before(async () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
        process.env.ZALO_JSON_MODE = "1";
        fake = installFakeZalo();
        api = await loginFake();
    });

    after(() => fake.uninstall());

    beforeEach(() => {
        fake.requests.length = 0;
        fake.clearRoutes();
    });

    const history = (...args) => runCommand(registerMsgCommands, ["--json", "msg", "history", ...args]);

    it("(a) -t 1 --no-cache writes the store's rows it did not have, normalized as the listener does", async () => {
        const textId = freshId();
        const photoId = freshId();
        const photo = {
            msgType: "chat.photo",
            content: { href: "https://photo.zalo.invalid/new.jpg", thumb: "https://photo.zalo.invalid/new-t.jpg" },
        };
        fake.route("/api/cm/getrecentv2", () => cloudPage([wire(textId, GID), wire(photoId, GID, photo)]));

        const r = await history(GID, "-t", "1", "-n", "5", "--no-cache");
        assert.equal(r.exitCode, 0, `${r.stdout} ${r.stderr}`);

        const text = stored(textId);
        assert.ok(text, "the store's text row was not written");
        assert.equal(text.threadId, GID);
        assert.equal(text.senderId, MEMBER);
        assert.equal(text.senderName, "Member");
        assert.equal(text.text, `text ${textId}`);
        assert.equal(text.type, "text");
        assert.equal(text.timestamp, Number(wire(textId, GID).ts));
        const pic = stored(photoId);
        assert.ok(pic, "the store's photo row was not written");
        assert.equal(pic.type, "photo", "shared vocabulary, not zca-js's chat.photo");
        assert.equal(pic.has_attachment, 1, "otherwise sync-media can never fetch it");

        // Identical to the row the listener writes for the same frame, apart
        // from the id and the provenance tag.
        const liveId = freshId();
        storeLiveMessage({ threadId: GID, type: 1, data: { ...wire(photoId, GID, photo), msgId: liveId } });
        const live = stored(liveId);
        assert.deepEqual(omit(pic, "msgId", "raw_data"), omit(live, "msgId", "raw_data"));
        const rawHistory = JSON.parse(pic.raw_data);
        const rawLive = JSON.parse(live.raw_data);
        assert.deepEqual(omit(rawHistory, "src"), omit(rawLive, "src"));
        assert.equal(rawLive.src, "listen");
        assert.equal(rawHistory.src, "history");
    });

    it("(b) leaves a listener-stored row exactly as it was when the store returns it again", async () => {
        const keptId = freshId();
        const newId = freshId();
        const before = listenerStoredPhoto(keptId, GID, 1);
        fake.route("/api/cm/getrecentv2", () => cloudPage([refetched(keptId, GID), wire(newId, GID)]));

        const r = await history(GID, "-t", "1", "-n", "5", "--no-cache");
        assert.equal(r.exitCode, 0, `${r.stdout} ${r.stderr}`);

        assert.ok(stored(newId), "the write-back did not run at all, so this proves nothing");
        assert.deepEqual(stored(keptId), before, "a history fetch modified a row the listener stored");
    });

    for (const path of ["dm", "group whose store is empty"]) {
        it(`(c) the socket fallback follows the same rule -- ${path}`, async () => {
            const isGroup = path !== "dm";
            const threadId = isGroup ? GID : PEER;
            const type = isGroup ? 1 : 0;
            const keptId = freshId();
            const newId = freshId();
            const before = listenerStoredPhoto(keptId, threadId, type);
            if (isGroup) fake.route("/api/cm/getrecentv2", () => cloudPage([]));
            const frame = (data) => ({ threadId, type, data });
            const socket = serveOldMessages(api, [
                [
                    frame(refetched(keptId, threadId)),
                    frame(wire(newId, threadId)),
                    // A "delete for me" for the kept row: history must not apply it.
                    frame(
                        wire(freshId(), threadId, {
                            msgType: "chat.delete",
                            content: [{ globalDelMsgId: keptId, clientDelMsgId: wire(keptId, threadId).cliMsgId }],
                        }),
                    ),
                ],
            ]);
            try {
                const r = await history(threadId, "-t", String(type), "-n", "10", "--no-cache", "--timeout", "2000");
                assert.equal(r.exitCode, 0, `${r.stdout} ${r.stderr}`);
            } finally {
                socket.restore();
            }

            assert.ok(socket.requests.length >= 1, "the socket scan never ran");
            assert.ok(stored(newId), "the socket scan's new row was not written");
            assert.deepEqual(stored(keptId), before, "the socket scan modified or removed a row the listener stored");
        });
    }

    it("skips rows older than the conversation's delete marker, keeps newer ones", async () => {
        const deletedGroup = "7000000000000000009"; // its own thread: the marker must not leak
        const olderId = freshId();
        const newerId = freshId();
        const leftAt = Number(wire(olderId, deletedGroup).ts) + 5;
        initDb(DB_PATH);
        upsertThread({ threadId: deletedGroup, type: "group", name: "Deleted", lastUpdate: leftAt });
        markThreadGone(deletedGroup, leftAt); // what conv delete records
        fake.route("/api/cm/getrecentv2", () => cloudPage([wire(olderId, deletedGroup), wire(newerId, deletedGroup)]));

        const r = await history(deletedGroup, "-t", "1", "-n", "5", "--no-cache");
        assert.equal(r.exitCode, 0, `${r.stdout} ${r.stderr}`);

        assert.ok(stored(newerId), "a message newer than the delete was not written");
        assert.equal(stored(olderId), null, "a message from before conv delete was written back");
    });
});
