/**
 * src/zalo/listener/{models,group-events,friend-events}.js: the objects the listener emits, built from a wire
 * object (spec-listener 2.6), checked against expectations written out by hand.
 *
 * Fake ids only (tests/unit/no-real-ids.test.js).
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    GroupDeliveredMessage,
    GroupMessage,
    GroupSeenMessage,
    GroupTyping,
    Reaction,
    Undo,
    UserDeliveredMessage,
    UserMessage,
    UserSeenMessage,
    UserTyping,
    isRecall,
} from "../../src/zalo/listener/models.js";
import {
    GROUP_EVENT_TYPES,
    GROUP_EVENT_UNKNOWN,
    groupControlEvent,
    groupEventType,
    toGroupEvent,
} from "../../src/zalo/listener/group-events.js";
import {
    FRIEND_EVENT_TYPE,
    friendControlEvent,
    friendEventType,
    toFriendEvent,
} from "../../src/zalo/listener/friend-events.js";

const OWN = "1000000000000000001";
const PEER = "2000000000000000002";
const GROUP = "3000000000000000003";
const OTHER = "4000000000000000004";

const dmIn = (over = {}) => ({
    msgId: "7000000000001",
    cliMsgId: "1700000000001",
    msgType: "webchat",
    uidFrom: PEER,
    idTo: "0",
    dName: "Peer",
    ts: "1700000000000",
    content: "hello",
    ...over,
});
const groupIn = (over = {}) => ({ ...dmIn(), idTo: GROUP, mentions: [{ uid: OTHER, pos: 0, len: 4 }], ...over });
const recallContent = { globalMsgId: "7000000000002", cliMsgId: "1700000000002", deleteMsg: 1 };

/** The `data` each group act carries, shaped the way its `isSelf` rule reads it. */
function groupData(act, self) {
    const who = self ? OWN : OTHER;
    const base = { groupId: GROUP, groupName: "G", time: "1700000000006", sourceId: PEER, creatorId: PEER };
    if (["new_pin_topic", "unpin_topic", "update_pin_topic", "reorder_pin_topic"].includes(act)) {
        return { ...base, actorId: who, topic: { id: "1" } };
    }
    if (["update_board", "remove_board"].includes(act)) return { ...base, sourceId: who };
    if (["accept_remind", "reject_remind"].includes(act)) return { ...base, updateMembers: [PEER, who] };
    if (act === "remind_topic") return { ...base, creatorId: who };
    return {
        ...base,
        updateMembers: [
            { id: PEER, dName: "P" },
            { id: who, dName: "W" },
        ],
    };
}

const UNKNOWN_GROUP_ACTS = ["join_accept", "group_type", "new_group_invitation", "update_status"];

/** The `data` each friend act carries. */
function friendData(act, self) {
    if (["add", "remove", "block", "unblock", "block_call", "unblock_call"].includes(act)) return PEER;
    if (["req_v2", "reject", "undo_req"].includes(act)) {
        return self ? { fromUid: OWN, toUid: PEER, message: "hi" } : { fromUid: PEER, toUid: OWN, message: "hi" };
    }
    if (act === "seen_fr_req") return { uids: [PEER] };
    if (["pin_create", "pin_unpin"].includes(act)) {
        return { actorId: self ? OWN : PEER, conversationId: PEER, topic: { params: { title: "t" } } };
    }
    return { anything: [1, 2] };
}

const FRIEND_ACTS = [
    "add",
    "remove",
    "block",
    "unblock",
    "block_call",
    "unblock_call",
    "req_v2",
    "reject",
    "undo_req",
    "seen_fr_req",
    "pin_unpin",
    "pin_create",
    "something_new",
];

// ── Expectations ──────────────────────────────────────────────────────────────────────────────────────────────

describe("message objects", () => {
    it("UserMessage: a peer's message is the peer's thread and gets the own uid as idTo, in place", () => {
        const data = dmIn();
        const m = new UserMessage(OWN, data);
        assert.equal(m.data, data, "the wire object itself, not a copy");
        assert.deepEqual(
            { type: m.type, threadId: m.threadId, isSelf: m.isSelf, uidFrom: data.uidFrom, idTo: data.idTo },
            { type: 0, threadId: PEER, isSelf: false, uidFrom: PEER, idTo: OWN },
        );
    });

    it("UserMessage: an own message is the peer's thread and gets the own uid as uidFrom", () => {
        const data = dmIn({ uidFrom: "0", idTo: PEER });
        const m = new UserMessage(OWN, data);
        assert.deepEqual(
            { threadId: m.threadId, isSelf: m.isSelf, uidFrom: data.uidFrom, idTo: data.idTo },
            { threadId: PEER, isSelf: true, uidFrom: OWN, idTo: PEER },
        );
    });

    it("GroupMessage: the group is the thread; only uidFrom is rewritten", () => {
        const data = groupIn({ uidFrom: "0", quote: { ownerId: 42 } });
        const m = new GroupMessage(OWN, data);
        assert.deepEqual(
            { type: m.type, threadId: m.threadId, isSelf: m.isSelf, uidFrom: data.uidFrom, owner: data.quote.ownerId },
            { type: 1, threadId: GROUP, isSelf: true, uidFrom: OWN, owner: "42" },
        );
    });

    it("leaves a quote without an ownerId without one (never the text 'undefined')", () => {
        const data = dmIn({ quote: { msg: "q" } });
        new UserMessage(OWN, data);
        assert.equal("ownerId" in data.quote, false);
    });

    it("leaves the rest of a message's data as it came: the content, an attachment, a removal", () => {
        for (const over of [
            {},
            { msgType: "chat.photo", content: { href: "https://x/y.jpg" } },
            { msgType: "chat.delete", content: "" },
        ]) {
            const data = dmIn(over);
            const m = new UserMessage(OWN, data);
            assert.deepEqual(m.data, { ...dmIn(over), idTo: OWN }, JSON.stringify(over));
        }
        const g = new GroupMessage(OWN, groupIn());
        assert.deepEqual(g.data, groupIn(), "a member's group message is not rewritten at all");
    });

    it("Undo carries the thread type: 0 for a 1-1 recall, 1 for a group recall", () => {
        // Red without the type: normalizeUndo (src/commands/mcp.js) then calls a 1-1 recall a group recall.
        const dm = new Undo(OWN, dmIn({ content: recallContent }), false);
        const gr = new Undo(OWN, groupIn({ content: recallContent }), true);
        assert.deepEqual([dm.type, dm.threadId, dm.isGroup], [0, PEER, false]);
        assert.deepEqual([gr.type, gr.threadId, gr.isGroup], [1, GROUP, true]);
        const own = new Undo(OWN, dmIn({ uidFrom: "0", idTo: PEER, content: recallContent }), false);
        assert.deepEqual([own.threadId, own.isSelf, own.data.uidFrom], [PEER, true, OWN]);
    });

    it("Reaction: thread by the same rule as Undo, isGroup kept, no type", () => {
        const r = new Reaction(OWN, { uidFrom: "0", idTo: GROUP, content: {} }, true);
        assert.deepEqual([r.threadId, r.isSelf, r.isGroup, r.data.uidFrom], [GROUP, true, true, OWN]);
        const dm = new Reaction(OWN, { uidFrom: PEER, idTo: "0", content: '{"rIcon":""}' }, false);
        assert.deepEqual([dm.threadId, dm.isSelf, dm.isGroup, dm.data.idTo], [PEER, false, false, OWN]);
        assert.equal(dm.data.content, '{"rIcon":""}', "a string content is left as it came");
        // Red if Reaction grows a type without a decision.
        assert.equal("type" in r, false);
    });

    it("treats the own mark as '0' whether it was parsed as a string or a number", () => {
        const m = new UserMessage(OWN, dmIn({ uidFrom: 0, idTo: PEER }));
        assert.deepEqual([m.isSelf, m.threadId, m.data.uidFrom], [true, PEER, OWN]);
    });

    it("receipts: isSelf by uid compared as a string; a missing uid list is not this account's", () => {
        assert.equal(new GroupSeenMessage(OWN, { groupId: GROUP, seenUids: [OWN] }).isSelf, true);
        assert.equal(new GroupSeenMessage(OWN, { groupId: GROUP, seenUids: [PEER] }).isSelf, false);
        assert.equal(new GroupSeenMessage(OWN, { groupId: GROUP }).isSelf, false);
        assert.equal(new GroupDeliveredMessage("5", { groupId: GROUP, deliveredUids: [5] }).isSelf, true);
        assert.equal(new GroupDeliveredMessage(OWN, { groupId: GROUP }).isSelf, false);
        assert.equal(new UserDeliveredMessage({ deliveredUids: [PEER] }).threadId, PEER);
        assert.equal(new UserDeliveredMessage({}).threadId, undefined);
        assert.deepEqual(
            [new UserSeenMessage({ idTo: PEER }).threadId, new UserSeenMessage({ idTo: PEER }).type],
            [PEER, 0],
        );
        assert.deepEqual(
            [new GroupTyping({ uid: PEER, gid: GROUP }).threadId, new UserTyping({ uid: PEER }).threadId],
            [GROUP, PEER],
        );
    });

    it("isRecall: an object content with its own deleteMsg key", () => {
        assert.equal(isRecall({ content: { deleteMsg: 1 } }), true);
        assert.equal(isRecall({ content: { deleteMsg: 0 } }), true, "the key, not its value");
        assert.equal(isRecall({ content: '{"deleteMsg":1}' }), false, "a string is a message, not a recall");
        assert.equal(isRecall({ content: Object.create({ deleteMsg: 1 }) }), false, "inherited does not count");
        assert.equal(isRecall({ content: null }), false);
        assert.equal(isRecall({ content: [] }), false);
        assert.equal(isRecall({}), false);
    });
});

describe("group events", () => {
    it("keeps the 22 type names and calls every other act unknown, with the real act beside it", () => {
        assert.equal(GROUP_EVENT_TYPES.length, 22);
        for (const t of GROUP_EVENT_TYPES) assert.equal(groupEventType(t), t);
        const ev = toGroupEvent(OWN, "join_accept", { groupId: GROUP, updateMembers: [{ id: OWN }] });
        assert.deepEqual([ev.type, ev.act, ev.threadId, ev.isSelf], [GROUP_EVENT_UNKNOWN, "join_accept", GROUP, true]);
    });

    it("every act: the group is the thread, and the account is itself where its act's field names it", () => {
        for (const act of [...GROUP_EVENT_TYPES, ...UNKNOWN_GROUP_ACTS]) {
            for (const self of [false, true]) {
                const ev = toGroupEvent(OWN, act, groupData(act, self));
                const where = `${act}${self ? ", own" : ""}`;
                assert.equal(ev.threadId, GROUP, where);
                assert.equal(ev.type, GROUP_EVENT_TYPES.includes(act) ? act : GROUP_EVENT_UNKNOWN, where);
                // A join request is never the account's own doing: it asks to join a group it is not in.
                assert.equal(ev.isSelf, self && act !== "join_request", where);
            }
        }
    });

    it("decides isSelf from the field each kind of act names the account in", () => {
        assert.equal(toGroupEvent(OWN, "join_request", { groupId: GROUP, sourceId: OWN }).isSelf, false);
        assert.equal(toGroupEvent(OWN, "new_pin_topic", { groupId: GROUP, actorId: OWN }).isSelf, true);
        assert.equal(toGroupEvent(OWN, "update_board", { groupId: GROUP, sourceId: OWN }).isSelf, true);
        assert.equal(toGroupEvent(OWN, "accept_remind", { groupId: GROUP, updateMembers: [OWN] }).isSelf, true);
        assert.equal(toGroupEvent(OWN, "remind_topic", { groupId: GROUP, creatorId: OWN }).isSelf, true);
        assert.equal(toGroupEvent(OWN, "leave", { groupId: GROUP, sourceId: OWN }).isSelf, true);
        assert.equal(toGroupEvent(OWN, "leave", { groupId: GROUP, updateMembers: [{ id: PEER }] }).isSelf, false);
    });

    it("groupControlEvent: drops join_reject, parses string data", () => {
        assert.equal(groupControlEvent(OWN, { act: "join_reject", data: "{}" }), null);
        const ev = groupControlEvent(OWN, { act: "update", data: JSON.stringify({ groupId: GROUP, groupName: "N" }) });
        assert.deepEqual([ev.type, ev.threadId, ev.data.groupName], ["update", GROUP, "N"]);
        assert.throws(() => groupControlEvent(OWN, { act: "update", data: "{" }), SyntaxError);
    });
});

describe("friend events", () => {
    it("keeps the friend event type numbers, and maps each act to its number", () => {
        assert.deepEqual(
            { ...FRIEND_EVENT_TYPE },
            {
                ADD: 0,
                REMOVE: 1,
                REQUEST: 2,
                UNDO_REQUEST: 3,
                REJECT_REQUEST: 4,
                SEEN_FRIEND_REQUEST: 5,
                BLOCK: 6,
                UNBLOCK: 7,
                BLOCK_CALL: 8,
                UNBLOCK_CALL: 9,
                PIN_UNPIN: 10,
                PIN_CREATE: 11,
                UNKNOWN: 12,
            },
        );
        const expected = {
            add: 0,
            remove: 1,
            block: 6,
            unblock: 7,
            block_call: 8,
            unblock_call: 9,
            req_v2: 2,
            reject: 4,
            undo_req: 3,
            seen_fr_req: 5,
            pin_unpin: 10,
            pin_create: 11,
            something_new: 12,
            req: 12,
            "": 12,
        };
        for (const [act, type] of Object.entries(expected)) assert.equal(friendEventType(act), type, act);
        // Every act of FRIEND_ACTS has its own data shape above; red if one were dropped from the list.
        assert.deepEqual(
            FRIEND_ACTS.filter((a) => !(a in expected)),
            [],
        );
        for (const act of FRIEND_ACTS) assert.ok(friendData(act, false) !== undefined, act);
    });

    it("friendControlEvent: drops req, keeps a numeric uid string whole, parses topic.params", () => {
        assert.equal(friendControlEvent(OWN, { act: "req", data: "{}" }), null);
        // A uid past 2^53 sent as a JSON string: red if it is parsed to a (lossy) number.
        const add = friendControlEvent(OWN, { act: "add", data: PEER });
        assert.deepEqual([add.type, add.data, add.threadId, add.isSelf], [FRIEND_EVENT_TYPE.ADD, PEER, PEER, false]);
        const req = friendControlEvent(OWN, { act: "req_v2", data: JSON.stringify({ fromUid: PEER, toUid: OWN }) });
        assert.deepEqual([req.type, req.threadId, req.isSelf], [FRIEND_EVENT_TYPE.REQUEST, OWN, false]);
        const pin = friendControlEvent(OWN, {
            act: "pin_create",
            data: { actorId: OWN, conversationId: PEER, topic: { params: '{"title":"t"}' } },
        });
        assert.deepEqual(
            [pin.type, pin.threadId, pin.isSelf, pin.data.topic.params],
            [FRIEND_EVENT_TYPE.PIN_CREATE, PEER, true, { title: "t" }],
        );
    });

    it("is its own doing for block and unblock, not for add and remove", () => {
        assert.equal(toFriendEvent(OWN, "block", PEER).isSelf, true);
        assert.equal(toFriendEvent(OWN, "unblock_call", PEER).isSelf, true);
        assert.equal(toFriendEvent(OWN, "remove", PEER).isSelf, false);
        assert.deepEqual(toFriendEvent(OWN, "seen_fr_req", {}), { type: 5, data: {}, threadId: OWN, isSelf: true });
    });

    it("an unknown act becomes type 12 with the data as JSON text", () => {
        assert.deepEqual(toFriendEvent(OWN, "new_thing", { a: 1 }), {
            type: 12,
            data: '{"a":1}',
            threadId: "",
            isSelf: false,
        });
    });
});
