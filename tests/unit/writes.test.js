/**
 * src/zalo/writes.js — the web client's state-changing endpoints, checked at the wire, and the guards around them.
 *
 * Each case drives `callWrite` through zca-js's real `request()` into a stub (tests/helpers/web-call.js) and checks what
 * the stub received against what the web client's API module builds for the same call (module `fBUP`, 2026-10-23
 * bundle): the service-map host, the path, GET or POST, and the JSON encrypted into `params`. The expected values are
 * written out by hand from that module, not computed from the table under test. Nothing here talks to Zalo.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { IMEI, SERVICE_KEYS, harness, host, sent, sessionOk } from "../helpers/web-call.js";
import { READS } from "../../src/zalo/reads.js";
import { WRITES, WRITE_NAMES, buildWrite, callWrite, describeWrites } from "../../src/zalo/writes.js";
import { CallUsageError } from "../../src/zalo/web-call.js";

const MSGS_IN = [{ cliMsgIdUndo: "c1", globalMsgId: "g1", cliMsgId: "n1" }];
const MSGS_OUT = [{ cliMsgId: "n1", cliMsgIdUndo: "c1", globalMsgId: "g1" }];
const TOP = { color: -16777216, emoji: "", startTime: -1, duration: -1, repeat: 0 };
/** A body field the test cannot know (a client id made from the clock): it is checked by shape, then replaced. */
const ANY_CLIENT_ID = "<a client id>";

// [name, args, host key, path, method, what the web client encrypts]
const CASES = [
    [
        "multi-undo",
        { toId: "u1", msgs: MSGS_IN },
        "chat",
        "/api/message/multi_undo",
        "POST",
        { toid: "u1", msgs: MSGS_OUT },
    ],
    [
        "multi-undo-group",
        { groupId: "g555", msgs: MSGS_IN },
        "group",
        "/api/group/multi_undomsg",
        "POST",
        { grid: "555", msgs: MSGS_OUT },
    ],
    [
        "sync-action-media",
        { actions: [{ a: 1 }] },
        "sync_action",
        "/api/sync_action/media",
        "POST",
        { syncList: '[{"a":1}]', imei: IMEI },
    ],
    [
        "topic-response",
        { groupId: "g555", eventId: "e1", type: 1 },
        "group_board",
        "/api/board/topic/updateEventResponse",
        "POST",
        { grid: "555", type: 1, eventId: "e1", imei: IMEI },
    ],
    [
        "topic-create",
        { groupId: "555", type: 0 },
        "group_board",
        "/api/board/topic/createv2",
        "POST",
        { grid: "555", type: 0, ...TOP, params: {}, imei: IMEI },
    ],
    [
        "topic-create",
        {
            groupId: "g555",
            type: 2,
            params: { title: "t" },
            startTime: 1700,
            repeatRule: { freq: "weekly", byDay: ["we", "MO"] },
            onlyMe: true,
            pinAct: 1,
            src: 3,
        },
        "group_board",
        "/api/board/topic/createv2",
        "POST",
        {
            grid: "555",
            type: 2,
            color: -16777216,
            emoji: "",
            startTime: 1700,
            duration: -1,
            params: '{"title":"t","onlyMe":1}',
            repeat: 2,
            imei: IMEI,
            src: 3,
            pinAct: 1,
            repeatRule: '["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;"]',
            onlyMe: 1,
        },
    ],
    [
        "topic-update",
        { groupId: "555", type: 2, topicId: "t9" },
        "group_board",
        "/api/board/topic/updatev2",
        "POST",
        { grid: "555", type: 2, ...TOP, params: {}, imei: IMEI, topicId: "t9", pinAct: 2 },
    ],
    [
        "topic-update",
        { groupId: "555", type: 2, topicId: "t9", pinAct: 1, emoji: "x", color: 5 },
        "group_board",
        "/api/board/topic/updatev2",
        "POST",
        {
            grid: "555",
            type: 2,
            color: 5,
            emoji: "x",
            startTime: -1,
            duration: -1,
            params: {},
            repeat: 0,
            imei: IMEI,
            topicId: "t9",
            pinAct: 1,
        },
    ],
    [
        "topic-remove",
        { groupId: "g555", topicId: "t9" },
        "group_board",
        "/api/board/topic/remove",
        "POST",
        { grid: "555", topicId: "t9", imei: IMEI },
    ],
    [
        "pin",
        { groupId: "g555", topicId: "t9", type: 3 },
        "group_board",
        "/api/board/pinv2",
        "GET",
        { grid: "555", topicId: "t9", type: 3 },
    ],
    [
        "unpin",
        { groupId: "g555", topic: "t9", topicType: "poll", boardVersion: 4 },
        "group_board",
        "/api/board/unpinv2",
        "GET",
        { grid: "555", imei: IMEI, topic: { topicId: "t9", topicType: 3 }, boardVersion: 4 },
    ],
    [
        "pin-reorder",
        { groupId: "g555", topics: ["a", { id: "b", type: 3 }], boardVersion: 4 },
        "group_board",
        "/api/board/pin/update",
        "POST",
        {
            groupId: "555",
            topics: [
                { topicId: "a", topicType: 0 },
                { topicId: "b", topicType: 3 },
            ],
            boardVersion: 4,
        },
    ],
    [
        "unpin-many",
        { groupId: "g555", topics: ["a"], topicType: "text", boardVersion: 4 },
        "group_board",
        "/api/board/multi_unpin",
        "GET",
        { grid: "555", topics: [{ topicId: "a", topicType: 0 }], boardVersion: 4 },
    ],
    [
        "todo-create",
        { todo: { title: "buy" } },
        "boards",
        "/api/board/personal/todo/create",
        "POST",
        { title: "buy", src: -1, imei: IMEI },
    ],
    [
        "todo-update",
        { todo: { id: "t1", title: "buy more" } },
        "boards",
        "/api/board/personal/todo/update",
        "POST",
        { id: "t1", title: "buy more" },
    ],
    [
        "todo-status",
        { id: "t1", status: 2 },
        "boards",
        "/api/board/personal/todo/status",
        "GET",
        { id: "t1", status: 2, imei: IMEI },
    ],
    [
        "todo-ding",
        { taskIds: ["t1", "t2"] },
        "boards",
        "/api/board/personal/todo/ding",
        "GET",
        { taskIds: ["t1", "t2"] },
    ],
    ["todo-ding-ack", { taskIds: ["t1"] }, "boards", "/api/board/personal/todo/dingack", "GET", { taskIds: ["t1"] }],
    ["todo-delete", { id: "t1" }, "boards", "/api/board/personal/delete", "GET", { id: "t1" }],
    ["contact-tab-read", { ts: 1700 }, "friend", "/api/friend/read-contact-tab", "POST", { ts: 1700 }],
    [
        "recommend-remove",
        { userId: "u1", src: 2, type: 3 },
        "friend",
        "/api/friend/recommendsv2/remove",
        "POST",
        { uid: "u1", src: 2, type: 3 },
    ],
    [
        "recommend-seen",
        { userIds: ["u1"] },
        "friend",
        "/api/friend/recommendsv2/read-requests",
        "POST",
        { uids_seen: ["u1"] },
    ],
    ["oa-block", { oaId: "o1" }, "profile", "/api/social/oa/block", "POST", { oaid: "o1" }],
    ["oa-unblock", { oaId: "o1" }, "profile", "/api/social/oa/unblock", "POST", { oaid: "o1" }],
    [
        "recent-search-update",
        {
            listRecent: [
                { userId: "u1", type: 0, displayName: "x", last_update_time: 9 },
                { userId: "g5", isGroup: true },
            ],
            version: 7,
        },
        "recent_search",
        "/api/recentsearch/update",
        "POST",
        {
            list_recent: [
                { id: "u1", type: 0, last_update_time: 9 },
                { id: "5", type: 1 },
            ],
            version: 7,
            list_keyword: [],
            imei: IMEI,
        },
    ],
    [
        "voice-to-text",
        { url: "https://voice.test/a.aac" },
        "ai_features",
        "/api/aifeatures/voice2text",
        "POST",
        { url: "https://voice.test/a.aac" },
    ],
    [
        "gif-send",
        {
            toId: "u1",
            href: "https://g.test/o.gif",
            thumb: "https://g.test/n.gif",
            width: 480,
            height: 270,
            contentId: "c9",
        },
        "file",
        "/api/message/gif",
        "POST",
        {
            thumb: "https://g.test/n.gif",
            width: 480,
            height: 270,
            msg: "",
            type: 0,
            href: "https://g.test/o.gif",
            contentId: "c9",
            toid: "u1",
            clientId: ANY_CLIENT_ID,
        },
    ],
    [
        "gif-send-group",
        {
            groupId: "g555",
            href: "https://g.test/o.gif",
            thumb: "https://g.test/n.gif",
            width: "480",
            height: "270",
            contentId: "c9",
            src: 2,
        },
        "file",
        "/api/group/gif",
        "POST",
        {
            thumb: "https://g.test/n.gif",
            width: 480,
            height: 270,
            msg: "",
            type: 0,
            href: "https://g.test/o.gif",
            contentId: "c9",
            visibility: 0,
            src: 2,
            grid: "555",
            clientId: ANY_CLIENT_ID,
        },
    ],
    [
        "pin-reorder-1on1",
        { userId: "u1", topics: ["t1", { id: "t2", type: "message" }], topicType: "text", version: "77", lang: "en" },
        "friend_board",
        "/api/friendboard/reorder",
        "GET",
        {
            conversationId: "u1",
            topics: [
                { topicId: "t1", topicType: 0 },
                { topicId: "t2", topicType: 2 },
            ],
            version: 77,
            lang: "en",
            imei: IMEI,
        },
    ],
    [
        "blocksharing-update",
        { threadId: "g555", isGroup: true, enabled: true },
        "conversation",
        "/api/conv/blocksharing/updateConvers",
        "POST",
        { threadId: "555", isGroup: 1, isEnabled: 1, clientLang: "vi" },
    ],
    [
        "label-add",
        { text: "Work", color: "#0068FF", conversations: ["u1", "g555"] },
        "label",
        "/api/convlabel/manage/add",
        "POST",
        { labelInfo: '{"text":"Work","color":"#0068FF"}', add: ["u1", "g555"] },
    ],
    [
        "label-update",
        { id: "13", text: "Work 2", color: "#FF6905", offset: 4, add: ["u2"], remove: ["u1"] },
        "label",
        "/api/convlabel/manage/update",
        "POST",
        { labelInfo: '{"id":13,"text":"Work 2","color":"#FF6905","offset":4}', add: ["u2"], remove: ["u1"] },
    ],
    ["label-delete", { ids: ["13", 14] }, "label", "/api/convlabel/manage/delete", "POST", { labelIds: [13, 14] }],
    [
        "label-reorder",
        {
            order: [
                { id: "14", offset: "0" },
                { id: 13, offset: 1 },
            ],
        },
        "label",
        "/api/convlabel/manage/reorder",
        "POST",
        { lsLabelInfo: '[{"id":14,"offset":0},{"id":13,"offset":1}]' },
    ],
    [
        "group-kickout-multi",
        { groupIds: ["g555", "666"], userId: "u1", srcInteraction: 1 },
        "group",
        "/api/group/kickout/multi",
        "GET",
        { grids: ["555", "666"], member: "u1", srcInteraction: 1 },
    ],
];

describe("writes — sandbox", () => {
    it("runs inside the test sandbox", () => {
        assertSandboxed(CONFIG_DIR);
        assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    });
});

describe("each write goes out the way the web client's API module sends it", () => {
    for (const [name, args, key, path, method, body] of CASES) {
        it(`${name} ${JSON.stringify(args).slice(0, 70)}`, async () => {
            const h = harness();
            await callWrite(h.api, name, args);
            assert.equal(h.calls.length, 1);
            const [c] = h.calls;
            assert.equal(c.origin, host(key));
            assert.equal(c.path, path);
            assert.equal(c.method, method);
            assert.equal(c.query.zpw_ver, "694");
            const got = sent(c);
            if (body.clientId === ANY_CLIENT_ID) {
                assert.match(got.clientId, /^\d{13}$/, "a client id is the clock's milliseconds");
                got.clientId = ANY_CLIENT_ID;
            }
            assert.deepEqual(got, body);
        });
    }

    it("covers every write in the table (a new write needs a case)", () => {
        const covered = new Set(CASES.map((c) => c[0]));
        assert.deepEqual(
            WRITE_NAMES.filter((n) => !covered.has(n)),
            [],
        );
    });

    it("gives each message of a multi-recall a client id of its own when none is given, and keeps one that is", async () => {
        const h = harness();
        await callWrite(h.api, "multi-undo", {
            toId: "u1",
            msgs: [
                { cliMsgIdUndo: "c1", globalMsgId: "g1" },
                { cliMsgIdUndo: "c2", globalMsgId: "g2" },
                { cliMsgIdUndo: "c3", globalMsgId: "g3", cliMsgId: "mine" },
            ],
        });
        const { msgs } = sent(h.calls[0]);
        assert.match(msgs[0].cliMsgId, /^\d+$/);
        assert.notEqual(msgs[0].cliMsgId, msgs[1].cliMsgId);
        assert.equal(msgs[2].cliMsgId, "mine");
        assert.deepEqual(
            msgs.map((m) => m.cliMsgIdUndo),
            ["c1", "c2", "c3"],
        );
    });
});

describe("ids go out as strings", () => {
    it("whatever type they came in", async () => {
        const h = harness();
        await callWrite(h.api, "group-kickout-multi", { groupIds: [555, "g666"], userId: 12345, srcInteraction: "2" });
        assert.deepEqual(sent(h.calls[0]), { grids: ["555", "666"], member: "12345", srcInteraction: 2 });
        await callWrite(h.api, "recommend-remove", { userId: 777, src: "2", type: "3" });
        assert.deepEqual(sent(h.calls[1]), { uid: "777", src: 2, type: 3 });
    });
});

describe("the web client's enums, by name or number", () => {
    it("accepts a name wherever the client sends a number, in any case", async () => {
        const h = harness();
        await callWrite(h.api, "topic-response", { groupId: "555", eventId: "e1", type: "REJECT" });
        await callWrite(h.api, "pin", { groupId: "555", topicId: "t", type: "Poll" });
        await callWrite(h.api, "todo-status", { id: "t1", status: "done" });
        await callWrite(h.api, "group-kickout-multi", { groupIds: ["555"], userId: "u", srcInteraction: "mediaStore" });
        assert.equal(sent(h.calls[0]).type, 2);
        assert.equal(sent(h.calls[1]).type, 3);
        assert.equal(sent(h.calls[2]).status, 1);
        assert.equal(sent(h.calls[3]).srcInteraction, 1);
    });

    it("keeps a number, and refuses a name the enum does not have, naming the ones it has", async () => {
        const h = harness();
        await callWrite(h.api, "todo-status", { id: "t1", status: -1 });
        assert.equal(sent(h.calls[0]).status, -1);
        await assert.rejects(
            callWrite(h.api, "todo-status", { id: "t1", status: "maybe" }),
            /waiting, inProcess, done/,
        );
        assert.equal(h.calls.length, 1);
    });

    it("lists the names beside each enum argument", () => {
        const arg = describeWrites()
            .find((w) => w.name === "topic-response")
            .args.find((a) => a.name === "type");
        assert.deepEqual(arg.values, { none: 0, accept: 1, reject: 2 });
        assert.match(arg.desc, /accept=1/);
    });
});

describe("a repeat rule and a pin are sent the way the web client serializes them", () => {
    it("serializes a rule as a JSON array of one RRULE, the legacy repeat code beside it, weekdays in week order", async () => {
        const h = harness();
        for (const rule of [
            { freq: "DAILY" },
            { freq: "WEEKLY", byDay: ["SU", "TU"] },
            "monthly",
            { freq: "YEARLY" },
        ]) {
            await callWrite(h.api, "topic-create", { groupId: "555", type: 0, repeatRule: rule });
        }
        const bodies = h.calls.map(sent);
        assert.deepEqual(
            bodies.map((b) => b.repeatRule),
            [
                '["RRULE:FREQ=DAILY;INTERVAL=1;"]',
                '["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,SU;"]',
                '["RRULE:FREQ=MONTHLY;INTERVAL=1;"]',
                '["RRULE:FREQ=YEARLY;INTERVAL=1;"]',
            ],
        );
        assert.deepEqual(
            bodies.map((b) => b.repeat),
            [1, 2, 3, 4],
        );
    });

    it("sends the rule and only-me together (an empty rule, 0) and puts only-me in the params too", async () => {
        const h = harness();
        await callWrite(h.api, "topic-create", { groupId: "555", type: 0, onlyMe: true, params: { title: "t" } });
        await callWrite(h.api, "topic-create", { groupId: "555", type: 0, params: { title: "t" } });
        const [withMe, plain] = h.calls.map(sent);
        assert.equal(withMe.repeatRule, "");
        assert.equal(withMe.onlyMe, 1);
        assert.equal(withMe.params, '{"title":"t","onlyMe":1}');
        assert.equal("repeatRule" in plain, false, "neither field is sent unless one was asked for");
        assert.equal("onlyMe" in plain, false);
    });

    it("refuses a frequency or a weekday that is not one", async () => {
        const h = harness();
        await assert.rejects(
            callWrite(h.api, "topic-create", { groupId: "5", type: 0, repeatRule: "hourly" }),
            /not one of: DAILY/,
        );
        await assert.rejects(
            callWrite(h.api, "topic-create", { groupId: "5", type: 0, repeatRule: { freq: "WEEKLY", byDay: ["XX"] } }),
            /weekday "XX"/,
        );
        assert.equal(h.calls.length, 0);
    });
});

describe("a dry run sends nothing and shows what would go", () => {
    it("returns the request with its body decrypted, and makes no request", async () => {
        const h = harness();
        const out = await callWrite(h.api, "topic-remove", { groupId: "g555", topicId: "t9" }, { dryRun: true });
        assert.equal(h.calls.length, 0);
        assert.deepEqual(out, {
            dryRun: true,
            request: {
                method: "POST",
                host: "group_board",
                path: "/api/board/topic/remove",
                body: { grid: "555", topicId: "t9", imei: IMEI },
            },
        });
    });

    it("still refuses a missing argument", async () => {
        const h = harness();
        await assert.rejects(
            callWrite(h.api, "topic-remove", { groupId: "g555" }, { dryRun: true }),
            /needs "topicId"/,
        );
    });
});

describe("what a write returns and refuses", () => {
    it("returns the reply's data", async () => {
        const h = harness(() => sessionOk({ done: true }));
        assert.deepEqual(await callWrite(h.api, "todo-delete", { id: "t1" }), { done: true });
    });

    it("refuses an unknown write and a missing argument before sending anything", async () => {
        const h = harness();
        await assert.rejects(callWrite(h.api, "no-such-write"), CallUsageError);
        await assert.rejects(callWrite(h.api, "todo-delete", {}), /needs "id"/);
        await assert.rejects(callWrite(h.api, "multi-undo", { toId: "u1" }), /needs "msgs"/);
        assert.equal(h.calls.length, 0);
    });

    it("buildWrite shows the request without sending it", () => {
        const h = harness();
        const r = buildWrite(h.api, "pin", { groupId: "555", topicId: "t", type: 1 });
        assert.equal(r.method, "GET");
        assert.deepEqual(r.json, { grid: "555", topicId: "t", type: 1 });
        assert.equal(h.calls.length, 0);
    });
});

describe("the table", () => {
    it("says what each write touches, and marks the ones that remove things", () => {
        for (const [name, d] of Object.entries(WRITES)) {
            assert.ok(["private", "visible", "destructive"].includes(d.risk), `${name}: risk ${d.risk}`);
            assert.ok(d.what.length > 10, `${name} says what it is`);
            assert.ok(d.host === "auth" || SERVICE_KEYS.has(d.host), `${name}: host ${d.host}`);
            for (const a of d.args) assert.ok(a.desc.length > 3, `${name}.${a.name} is described`);
        }
        const destructive = WRITE_NAMES.filter((n) => WRITES[n].risk === "destructive");
        assert.deepEqual(destructive, ["group-kickout-multi", "label-delete", "todo-delete", "topic-remove"]);
    });

    it("claims a live success only for what was seen to work, and says why for the rest", () => {
        const verified = WRITE_NAMES.filter((n) => WRITES[n].verified);
        assert.deepEqual(verified, [
            "contact-tab-read",
            "gif-send",
            "gif-send-group",
            "group-kickout-multi",
            "label-add",
            "label-delete",
            "label-reorder",
            "label-update",
            "multi-undo",
            "multi-undo-group",
            "pin",
            "pin-reorder",
            "pin-reorder-1on1",
            "recent-search-update",
            "sync-action-media",
            "topic-create",
            "topic-remove",
            "topic-response",
            "topic-update",
            "unpin",
            "unpin-many",
            "voice-to-text",
        ]);
        for (const n of WRITE_NAMES.filter((x) => !WRITES[x].verified)) {
            assert.ok(WRITES[n].note?.length > 20, `${n} says why it is not verified`);
        }
    });

    it("has no write for an endpoint Zalo answers with 404 (profile/mode, closefr/update)", () => {
        const paths = Object.values(WRITES).map((d) => d.path);
        assert.ok(!paths.includes("/api/social/profile/mode"));
        assert.ok(!paths.includes("/api/friend/closefr/update"));
    });

    it("shares no name and no endpoint with the reads, so a read is never one of these", () => {
        for (const name of WRITE_NAMES) assert.equal(READS[name], undefined, `${name} is also a read`);
        const readEndpoints = new Set(Object.values(READS).map((d) => `${d.host}${d.path}`));
        for (const [name, d] of Object.entries(WRITES)) assert.ok(!readEndpoints.has(`${d.host}${d.path}`), name);
    });

    it("describes itself, with the risk, for a person or an agent", () => {
        const all = describeWrites();
        assert.equal(all.length, WRITE_NAMES.length);
        const rm = all.find((w) => w.name === "topic-remove");
        assert.equal(rm.risk, "destructive");
        assert.equal(rm.verified, true);
        assert.deepEqual(
            rm.args.map((a) => a.name),
            ["groupId", "topicId"],
        );
    });
});
