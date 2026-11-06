/**
 * src/zalo/listener/{models,group-events,friend-events}.js: the objects the listener emits, built from one wire
 * object by zca-js's code and by ours, for every row of spec-listener 2.6.
 *
 * Two parts:
 *  1. The differential (deleted at the cut-over, design section 3.3): zca-js's class or initializer and ours get a
 *     deep clone of the same input; `type`, `threadId`, `isSelf`, `isGroup` and the rewritten `data` must match. A
 *     difference we intend is declared per case, and a declared difference that is not there fails the case, so the
 *     declaration cannot go stale. The only declared difference for well-formed input is `Undo.type`.
 *  2. Our own expectations, written out by hand, which stay after zca-js is gone.
 *
 * Fake ids only (tests/unit/no-real-ids.test.js).
 */
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

const require = createRequire(import.meta.url);
const zca = require("zca-js");
const zcaUtils = require(join(dirname(require.resolve("zca-js")), "utils.cjs"));

const clone = (v) => structuredClone(v);

/** The fields the engine reads from an event object, as a plain object (absent fields left out). */
function view(obj) {
    const out = {};
    for (const k of ["type", "act", "threadId", "isSelf", "isGroup", "data"]) if (k in obj) out[k] = obj[k];
    return out;
}

/**
 * Build with zca-js and with ours from clones of one input and compare. `allow` declares intended differences as
 * `{field: {zca, own}}`; each must be present exactly as declared.
 */
function same(input, buildZca, buildOwn, allow = {}) {
    const z = view(buildZca(clone(input)));
    const o = view(buildOwn(clone(input)));
    for (const [field, { zca: zv, own: ov }] of Object.entries(allow)) {
        assert.deepEqual(z[field], zv, `declared difference on ${field}: zca-js side`);
        assert.deepEqual(o[field], ov, `declared difference on ${field}: our side`);
        delete z[field];
        delete o[field];
    }
    assert.deepEqual(o, z);
    return o;
}

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

describe("message objects against zca-js (deleted at the cut-over)", () => {
    const rows = [
        ["UserMessage from the peer", dmIn(), UserMessage, zca.UserMessage],
        ["UserMessage sent by this account", dmIn({ uidFrom: "0", idTo: PEER }), UserMessage, zca.UserMessage],
        [
            "UserMessage with a numeric quote owner",
            dmIn({ quote: { ownerId: 12345, msg: "q" } }),
            UserMessage,
            zca.UserMessage,
        ],
        ["UserMessage with a string quote owner", dmIn({ quote: { ownerId: PEER } }), UserMessage, zca.UserMessage],
        [
            "UserMessage with an attachment",
            dmIn({ msgType: "chat.photo", content: { href: "https://x/y.jpg" } }),
            UserMessage,
            zca.UserMessage,
        ],
        [
            "UserMessage removal (chat.delete)",
            dmIn({ msgType: "chat.delete", content: "" }),
            UserMessage,
            zca.UserMessage,
        ],
        ["GroupMessage from a member", groupIn(), GroupMessage, zca.GroupMessage],
        ["GroupMessage sent by this account", groupIn({ uidFrom: "0" }), GroupMessage, zca.GroupMessage],
        [
            "GroupMessage quoting this account",
            groupIn({ quote: { ownerId: 7, msg: "q" } }),
            GroupMessage,
            zca.GroupMessage,
        ],
    ];
    for (const [name, input, Own, Zca] of rows) {
        it(name, () => {
            same(
                input,
                (d) => new Zca(OWN, d),
                (d) => new Own(OWN, d),
            );
        });
    }

    for (const [name, input, isGroup] of [
        ["Undo of a peer's 1-1 message", dmIn({ content: recallContent }), false],
        ["Undo of this account's 1-1 message", dmIn({ uidFrom: "0", idTo: PEER, content: recallContent }), false],
        ["Undo in a group", groupIn({ content: recallContent }), true],
        ["Undo by this account in a group", groupIn({ uidFrom: "0", content: recallContent }), true],
    ]) {
        it(`${name}: same except Undo.type`, () => {
            same(
                input,
                (d) => new zca.Undo(OWN, d, isGroup),
                (d) => new Undo(OWN, d, isGroup),
                { type: { zca: undefined, own: isGroup ? 1 : 0 } },
            );
        });
    }

    const react = (over = {}) => ({
        actionId: "8000000000001",
        msgId: "8000000000002",
        cliMsgId: "1700000000003",
        uidFrom: PEER,
        idTo: "0",
        dName: "Peer",
        ts: "1700000000004",
        content: {
            rMsg: [{ gMsgID: "7000000000001", cMsgID: "1700000000001", msgType: 1 }],
            rIcon: "/-heart",
            rType: 5,
        },
        ...over,
    });
    for (const [name, input, isGroup] of [
        ["Reaction from the peer", react(), false],
        ["Reaction by this account in a 1-1", react({ uidFrom: "0", idTo: PEER }), false],
        ["Reaction in a group", react({ idTo: GROUP }), true],
        ["Reaction by this account in a group", react({ uidFrom: "0", idTo: GROUP }), true],
        ["Reaction removal (empty icon), content still a string", react({ content: '{"rIcon":"","rType":-1}' }), false],
    ]) {
        it(name, () => {
            // Reaction carries no `type` on either side. Red if ours grows one without a decision.
            const o = same(
                input,
                (d) => new zca.Reaction(OWN, d, isGroup),
                (d) => new Reaction(OWN, d, isGroup),
            );
            assert.equal("type" in new Reaction(OWN, clone(input), isGroup), false);
            assert.ok(o.isGroup === isGroup);
        });
    }

    for (const [name, input, Own, Zca, withUid] of [
        ["UserTyping", { uid: PEER, ts: "1700000000005", isPC: 0 }, UserTyping, zca.UserTyping, false],
        ["GroupTyping", { uid: PEER, gid: GROUP, ts: "1700000000005", isPC: 1 }, GroupTyping, zca.GroupTyping, false],
        [
            "UserSeenMessage",
            { idTo: PEER, msgId: "7000000000001", realMsgId: "0" },
            UserSeenMessage,
            zca.UserSeenMessage,
            false,
        ],
        [
            "GroupSeenMessage, seen by others",
            { msgId: "7000000000001", groupId: GROUP, seenUids: [PEER, OTHER] },
            GroupSeenMessage,
            zca.GroupSeenMessage,
            true,
        ],
        [
            "GroupSeenMessage, seen by this account",
            { msgId: "7000000000001", groupId: GROUP, seenUids: [PEER, OWN] },
            GroupSeenMessage,
            zca.GroupSeenMessage,
            true,
        ],
        [
            "UserDeliveredMessage",
            { msgId: "7000000000001", seen: 0, deliveredUids: [PEER], seenUids: [], realMsgId: "0", mSTs: 1 },
            UserDeliveredMessage,
            zca.UserDeliveredMessage,
            false,
        ],
        [
            "GroupDeliveredMessage, to others",
            { msgId: "7000000000001", groupId: GROUP, deliveredUids: [PEER], seenUids: [] },
            GroupDeliveredMessage,
            zca.GroupDeliveredMessage,
            true,
        ],
        [
            "GroupDeliveredMessage, to this account",
            { msgId: "7000000000001", groupId: GROUP, deliveredUids: [OWN], seenUids: [] },
            GroupDeliveredMessage,
            zca.GroupDeliveredMessage,
            true,
        ],
    ]) {
        it(name, () => {
            same(
                input,
                (d) => (withUid ? new Zca(OWN, d) : new Zca(d)),
                (d) => (withUid ? new Own(OWN, d) : new Own(d)),
            );
        });
    }
});

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

describe("group_event against zca-js (deleted at the cut-over)", () => {
    for (const act of [...GROUP_EVENT_TYPES, ...UNKNOWN_GROUP_ACTS]) {
        for (const self of [false, true]) {
            it(`${act}${self ? ", own" : ""}`, () => {
                same(
                    groupData(act, self),
                    (d) => zca.initializeGroupEvent(OWN, d, zcaUtils.getGroupEventType(act), act),
                    (d) => toGroupEvent(OWN, act, d),
                );
            });
        }
    }

    it("reads threadId from group_id when the data has it", () => {
        const o = same(
            { group_id: GROUP, updateMembers: [] },
            (d) => zca.initializeGroupEvent(OWN, d, zcaUtils.getGroupEventType("leave"), "leave"),
            (d) => toGroupEvent(OWN, "leave", d),
        );
        assert.equal(o.threadId, GROUP);
    });

    it("maps every act to the same type name", () => {
        for (const act of [...GROUP_EVENT_TYPES, ...UNKNOWN_GROUP_ACTS, "", "JOIN"]) {
            assert.equal(groupEventType(act), zcaUtils.getGroupEventType(act), act);
        }
    });
});

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

describe("friend_event against zca-js (deleted at the cut-over)", () => {
    for (const act of FRIEND_ACTS) {
        for (const self of [false, true]) {
            it(`${act}${self ? ", own" : ""}`, () => {
                same(
                    friendData(act, self),
                    (d) => zca.initializeFriendEvent(OWN, d, zcaUtils.getFriendEventType(act)),
                    (d) => toFriendEvent(OWN, act, d),
                );
            });
        }
    }

    it("maps every act to the same type number", () => {
        for (const act of [...FRIEND_ACTS, "req", ""])
            assert.equal(friendEventType(act), zcaUtils.getFriendEventType(act), act);
        assert.deepEqual(
            { ...FRIEND_EVENT_TYPE },
            Object.fromEntries(Object.entries(zca.FriendEventType).filter(([k]) => isNaN(k))),
        );
    });
});

// ── Our own expectations (stay after the cut-over) ────────────────────────────────────────────────────────────

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

    it("leaves a quote without an ownerId without one (zca-js wrote the text 'undefined')", () => {
        const data = dmIn({ quote: { msg: "q" } });
        new UserMessage(OWN, data);
        assert.equal("ownerId" in data.quote, false);
        // The asserted difference, while zca-js is here to compare with.
        const z = dmIn({ quote: { msg: "q" } });
        new zca.UserMessage(OWN, z);
        assert.equal(z.quote.ownerId, "undefined");
    });

    it("Undo carries the thread type: 0 for a 1-1 recall, 1 for a group recall", () => {
        // Red on zca-js's class, which has no type: normalizeUndo (src/commands/mcp.js) then calls a 1-1 recall
        // a group recall.
        const dm = new Undo(OWN, dmIn({ content: recallContent }), false);
        const gr = new Undo(OWN, groupIn({ content: recallContent }), true);
        assert.deepEqual([dm.type, dm.threadId, dm.isGroup], [0, PEER, false]);
        assert.deepEqual([gr.type, gr.threadId, gr.isGroup], [1, GROUP, true]);
        const own = new Undo(OWN, dmIn({ uidFrom: "0", idTo: PEER, content: recallContent }), false);
        assert.deepEqual([own.threadId, own.isSelf, own.data.uidFrom], [PEER, true, OWN]);
    });

    it("Reaction: thread by the same rule as Undo, isGroup kept", () => {
        const r = new Reaction(OWN, { uidFrom: "0", idTo: GROUP, content: {} }, true);
        assert.deepEqual([r.threadId, r.isSelf, r.isGroup, r.data.uidFrom], [GROUP, true, true, OWN]);
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
