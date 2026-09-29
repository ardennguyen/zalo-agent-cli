/**
 * `msg pin <msgId>` / `msg unpin <msgId>` -- the requests Zalo Web sends.
 *
 * zca-js has none of these endpoints, so they are custom calls on zca-js's own
 * session envelope. The shapes are the captured ones
 * (agent/work/zalo-web-capture-2026-09-29/live/group.A9_pin_message,
 * group.A9b_unpin_message, dm.D9_pin_message, dm.D9b_unpin_message;
 * comparison-vs-zca-js.md #17, §5.17):
 *
 *   group pin    POST {group_board}/api/board/topic/createv2
 *                {grid, type:2, color, emoji:"📌", startTime:-1, duration:-1,
 *                 params:'{client_msg_id, global_msg_id, senderUid, senderName, title, msg_type}',
 *                 repeat:0, src:-1, imei, pinAct:1}
 *   group unpin  GET  {group_board}/api/board/unpinv2 {grid, imei, topic:{topicId, topicType:2}, boardVersion}
 *   1-1 pin      GET  {friend_board}/api/friendboard/create
 *                {conversationId, topic:{color, duration, emoji, params, repeat, startTime, type, src, pinAct},
 *                 version, lang, imei}
 *   1-1 unpin    GET  {friend_board}/api/friendboard/multi_unpin
 *                {conversationId, topics:[{topicId, topicType:2}], version, lang, imei}
 *
 * What the capture does not show and the web bundle does: the group unpin's
 * topicId and boardVersion come from `GET /api/board/pin/list {groupId,
 * boardVersion:0, imei}` (the web's fetchTopics), which answers
 * `{items, boardVersion}`; a stale version is error 183, after which the web
 * refetches once and retries. The 1-1 version comes from friendboard/list,
 * which zca-js's getFriendBoardList already calls exactly as captured.
 *
 * Only text messages are pinned: text is the one kind the capture covers, and
 * each other kind carries its own params blob.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { seedAccount, seedThread, seedMessage, runOffline, requestsTo, OWN_UID } from "./support/offline-cli.js";

const GROUP = "200000000000000051";
const PEER = "300000000000000051";
const MEMBER = "500000000000000051";
const NOISED = "VNOISED0000000000000000000000055";
const RESOLVED = "500000000000000055";

const G1 = {
    msgId: "7100000000051",
    cliMsgId: "1700000000051",
    text: "offline pin group",
    senderName: "Offline Owner",
};
const G2 = {
    msgId: "7100000000052",
    cliMsgId: "1700000000052",
    text: "offline pin member",
    senderName: "Offline Member",
};
const D1 = { msgId: "7100000000053", cliMsgId: "1700000000053", text: "offline pin dm", senderName: "Offline Owner" };
const P1 = { msgId: "7100000000054", cliMsgId: "1700000000054", text: "[Hình ảnh]", senderName: "Offline Owner" };
const S1 = { msgId: "7100000000055", cliMsgId: "1700000000055", text: "offline pin restored", senderName: "" };

before(() => {
    assertSandboxed(CONFIG_DIR);
    seedAccount();
    seedThread(GROUP, "group");
    seedThread(PEER, "dm");
    seedMessage({ ...G1, threadId: GROUP, senderId: OWN_UID, timestamp: 1700000000551 });
    seedMessage({ ...G2, threadId: GROUP, senderId: MEMBER, timestamp: 1700000000552 });
    seedMessage({ ...D1, threadId: PEER, senderId: OWN_UID, timestamp: 1700000000553 });
    seedMessage({ ...P1, threadId: GROUP, senderId: OWN_UID, timestamp: 1700000000554, type: "photo" });
    seedMessage({ ...S1, threadId: GROUP, senderId: NOISED, timestamp: 1700000000555, src: "sync-v2" });
});

/** The `params` JSON string the web puts inside a text message's pin topic. */
function pinParams(m, senderUid) {
    return JSON.stringify({
        client_msg_id: m.cliMsgId,
        global_msg_id: m.msgId,
        senderUid,
        senderName: m.senderName,
        title: m.text,
        msg_type: 1,
    });
}

/** A pinned-message topic as a board list returns it. */
function pinnedTopic(id, m) {
    return { id, type: 2, params: pinParams(m, OWN_UID), createTime: 1700000900000 };
}

/** The single request to `suffix`. */
function only(r, suffix) {
    const hits = requestsTo(r.requests, suffix);
    assert.equal(hits.length, 1, `expected one ${suffix} request, got ${hits.length}\n${r.all}`);
    return hits[0];
}

describe("msg pin", () => {
    it("group: POST board/topic/createv2 with the captured fields, in the captured order", async () => {
        const r = await runOffline(["msg", "pin", G1.msgId]);
        const q = only(r, "/api/board/topic/createv2");
        assert.equal(q.method, "POST");
        assert.equal(q.service, "group_board");
        // Red on any drift from the captured request: a missing or renamed
        // field, a different topic type or pin action, the wrong message ids,
        // or params serialized in a different order.
        assert.equal(q.params.params, pinParams(G1, OWN_UID));
        assert.deepEqual(q.params, {
            grid: GROUP,
            type: 2,
            color: -14540254,
            emoji: "📌",
            startTime: -1,
            duration: -1,
            params: pinParams(G1, OWN_UID),
            repeat: 0,
            src: -1,
            imei: "offline-test-imei",
            pinAct: 1,
        });
        assert.deepEqual(Object.keys(q.params), [
            "grid",
            "type",
            "color",
            "emoji",
            "startTime",
            "duration",
            "params",
            "repeat",
            "src",
            "imei",
            "pinAct",
        ]);
    });

    it("group: someone else's message carries their uid and name", async () => {
        const r = await runOffline(["msg", "pin", G2.msgId]);
        assert.equal(only(r, "/api/board/topic/createv2").params.params, pinParams(G2, MEMBER));
    });

    it("group: a sync-restored row's noised sender is resolved first", async () => {
        const r = await runOffline(["msg", "pin", S1.msgId], {
            responses: { "/api/gid/decrypt": { [NOISED]: RESOLVED } },
        });
        assert.equal(requestsTo(r.requests, "/api/gid/decrypt").length, 1, r.all);
        assert.equal(only(r, "/api/board/topic/createv2").params.params, pinParams(S1, RESOLVED));
    });

    it("1-1: friendboard/list for the version, then GET friendboard/create", async () => {
        const r = await runOffline(["msg", "pin", D1.msgId], {
            responses: { "/api/friendboard/list": { data: [], version: 1790000000111 } },
        });
        const list = only(r, "/api/friendboard/list");
        const create = only(r, "/api/friendboard/create");
        assert.ok(r.requests.indexOf(list) < r.requests.indexOf(create), "the version must be read before the create");
        assert.equal(list.method, "GET");
        assert.deepEqual(list.params, { conversationId: PEER, version: 0, imei: "offline-test-imei" });
        assert.equal(create.method, "GET");
        assert.equal(create.service, "friend_board");
        assert.deepEqual(create.params, {
            conversationId: PEER,
            topic: {
                color: -14540254,
                duration: -1,
                emoji: "📌",
                params: pinParams(D1, OWN_UID),
                repeat: 0,
                startTime: -1,
                type: 2,
                src: -1,
                pinAct: 1,
            },
            version: 1790000000111,
            lang: "vi",
            imei: "offline-test-imei",
        });
        assert.deepEqual(Object.keys(create.params), ["conversationId", "topic", "version", "lang", "imei"]);
        assert.deepEqual(Object.keys(create.params.topic), [
            "color",
            "duration",
            "emoji",
            "params",
            "repeat",
            "startTime",
            "type",
            "src",
            "pinAct",
        ]);
    });

    it("refuses an uncached message and names what caches one", async () => {
        const r = await runOffline(["msg", "pin", "7100000000059"]);
        assert.deepEqual(r.requests, [], r.all);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /not in the local cache/);
        assert.match(r.all, /\blisten\b/);
        assert.match(r.all, /\bsync\b/);
    });

    it("refuses a non-text message rather than guess its params", async () => {
        const r = await runOffline(["msg", "pin", P1.msgId]);
        assert.deepEqual(r.requests, [], r.all);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /text/);
    });

    it("refuses when the named thread is not the message's thread", async () => {
        const r = await runOffline(["msg", "pin", G1.msgId, PEER]);
        assert.deepEqual(r.requests, [], r.all);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /belongs to thread/);
    });
});

describe("msg unpin", () => {
    const groupBoard = (version, ...topics) => ({ items: topics, boardVersion: version, pinLimit: 3 });
    const NOTE = { id: "910000077", type: 0, params: '{"title":"a pinned note"}' };

    it("group: pin/list for topicId and boardVersion, then GET board/unpinv2", async () => {
        const r = await runOffline(["msg", "unpin", G1.msgId], {
            responses: { "/api/board/pin/list": groupBoard(1790000000222, NOTE, pinnedTopic("910000078", G1)) },
        });
        const list = only(r, "/api/board/pin/list");
        const unpin = only(r, "/api/board/unpinv2");
        assert.equal(list.method, "GET");
        assert.deepEqual(list.params, { groupId: GROUP, boardVersion: 0, imei: "offline-test-imei" });
        assert.equal(unpin.method, "GET");
        assert.equal(unpin.service, "group_board");
        assert.deepEqual(unpin.params, {
            grid: GROUP,
            imei: "offline-test-imei",
            topic: { topicId: "910000078", topicType: 2 },
            boardVersion: 1790000000222,
        });
        assert.deepEqual(Object.keys(unpin.params), ["grid", "imei", "topic", "boardVersion"]);
    });

    it("group: a stale board version (183) is refetched and retried once, as the web does", async () => {
        const r = await runOffline(["msg", "unpin", G1.msgId], {
            responses: {
                "/api/board/pin/list": {
                    __sequence: [
                        groupBoard(1790000000222, pinnedTopic("910000078", G1)),
                        groupBoard(1790000000223, pinnedTopic("910000078", G1)),
                    ],
                },
                "/api/board/unpinv2": {
                    __sequence: [{ __error: { code: 183, message: "invalid board version" } }, ""],
                },
            },
        });
        const unpins = requestsTo(r.requests, "/api/board/unpinv2");
        assert.equal(requestsTo(r.requests, "/api/board/pin/list").length, 2, r.all);
        assert.equal(unpins.length, 2, r.all);
        assert.equal(unpins[1].params.boardVersion, 1790000000223, "the retry carries the refetched version");
        assert.equal(r.code, 0, r.all);
    });

    it("1-1: friendboard/list for topicId and version, then GET friendboard/multi_unpin", async () => {
        const r = await runOffline(["msg", "unpin", D1.msgId], {
            responses: {
                "/api/friendboard/list": { data: [pinnedTopic("920000088", D1)], version: 1790000000333 },
            },
        });
        const unpin = only(r, "/api/friendboard/multi_unpin");
        assert.equal(unpin.method, "GET");
        assert.equal(unpin.service, "friend_board");
        assert.deepEqual(unpin.params, {
            conversationId: PEER,
            topics: [{ topicId: "920000088", topicType: 2 }],
            version: 1790000000333,
            lang: "vi",
            imei: "offline-test-imei",
        });
        assert.deepEqual(Object.keys(unpin.params), ["conversationId", "topics", "version", "lang", "imei"]);
    });

    it("an uncached message can still be unpinned when its thread is named", async () => {
        const pinnedElsewhere = { ...G1, msgId: "7100000000099", cliMsgId: "1700000000099" };
        const r = await runOffline(["msg", "unpin", pinnedElsewhere.msgId, GROUP, "-t", "1"], {
            responses: { "/api/board/pin/list": groupBoard(1790000000444, pinnedTopic("910000099", pinnedElsewhere)) },
        });
        assert.deepEqual(only(r, "/api/board/unpinv2").params.topic, { topicId: "910000099", topicType: 2 });
    });

    it("refuses when the message is not pinned: nothing is unpinned", async () => {
        const r = await runOffline(["msg", "unpin", G2.msgId], {
            responses: { "/api/board/pin/list": groupBoard(1790000000222, pinnedTopic("910000078", G1)) },
        });
        assert.deepEqual(requestsTo(r.requests, "/api/board/unpinv2"), [], r.all);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /not pinned/);
    });

    it("refuses an uncached message with no thread named, before any request", async () => {
        const r = await runOffline(["msg", "unpin", "7100000000098"]);
        assert.deepEqual(r.requests, [], r.all);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /thread/i);
    });
});
