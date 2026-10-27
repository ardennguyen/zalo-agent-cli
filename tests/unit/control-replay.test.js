/**
 * The control events a daemon missed while it was away are replayed on connect (src/core/control-replay.js).
 *
 * The control queues (`603_0`, `603_1`) hold what Zalo pushed as `601` frames while the client was offline. Each page
 * served from the saved cursor is handed to the listener as if it had arrived as a push, so the same handlers see it;
 * nothing is asked without a saved cursor, and nothing is acknowledged. These tests drive the real socket tap, the real
 * frame decoder and the real self-heal through ./support/fake-socket.js. Every id is made up.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { initDb, setSyncState } from "../../src/core/db.js";
import { createSocketTap, readFrame } from "../../src/core/socket-tap.js";
import { createSelfHeal, cursorKey } from "../../src/core/self-heal.js";
import { controlQueuesFrom } from "../../src/core/offline-queue.js";
import { CMD_CONTROL_PUSH, replayAsPush, replayControlQueues } from "../../src/core/control-replay.js";
import { createVoiceText } from "../../src/core/voice-text.js";
import { once } from "node:events";
import { fakeListener, serverFrame } from "./support/fake-socket.js";
import { ok, startFakeZalo } from "../helpers/fake-zalo/index.js";

const ROOT = mkdtempSync(join(tmpdir(), "zalo-control-replay-"));
let dbSeq = 0;
const OWN = "900001";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CTRL_Q = [
    { cmd: 603, subCmd: 1, queueName: "603_1" },
    { cmd: 610, subCmd: 1, queueName: "610_1" },
    { cmd: 603, subCmd: 0, queueName: "603_0" },
];

/** One control as the server sends it. */
const control = (actionId, actType, act, data) => ({
    actionId: String(actionId),
    controlId: `c${actionId}`,
    content: { act_type: actType, act, data: JSON.stringify(data ?? {}) },
});

/** One control-queue answer in the envelope of a 601 push, plus the paging fields. */
function ctrlPage(queueName, controls, { more = 0, lastActionId, evict = 0, reqId } = {}) {
    const last = lastActionId ?? controls.at(-1)?.actionId ?? "0";
    return {
        error_code: 0,
        error_message: "",
        data: {
            lastActionId: String(last),
            more,
            controls,
            queueStatus: { [queueName]: { ids: controls.map((c) => c.actionId), lastId: String(last), evict } },
            reqId,
        },
    };
}

/** A fake server answering each control queue from a script of pages, echoing reqId. */
function scripted(pages = {}) {
    const left = Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, [...v]]));
    return (payload) => {
        if (payload.cmd !== 603) return null;
        const key = `${payload.cmd}_${payload.subCmd}`;
        const next = left[key]?.shift();
        if (next === null) return null; // scripted silence
        const body = next ?? ctrlPage(key, [], { lastActionId: payload.data.lastId });
        body.data.reqId = payload.data.reqId;
        return body;
    };
}

const asks = (listener) => listener.sent.filter((p) => p.cmd === 603);

describe("control replay — sandbox", () => {
    it("runs inside the test sandbox", () => assertSandboxed(CONFIG_DIR));
});

describe("the control queues a handshake names", () => {
    it("takes the 603 queues in the handshake's order, and nothing else", () => {
        assert.deepEqual(controlQueuesFrom(CTRL_Q), [
            { cmd: 603, subCmd: 1, queueName: "603_1" },
            { cmd: 603, subCmd: 0, queueName: "603_0" },
        ]);
    });

    it("gives none without a handshake that lists them: the server does not serve this client a control queue", () => {
        for (const junk of [undefined, null, [], "x", [{ cmd: 610, subCmd: 1 }], [null, 3]]) {
            assert.deepEqual(controlQueuesFrom(junk), []);
        }
    });
});

describe("handing a page on as a push", () => {
    it("rewrites the command to a 601 push on a copy, leaving the original bytes and the body as they were", () => {
        const listener = fakeListener();
        const raw = serverFrame(603, 1, ctrlPage("603_1", [control(5, "mark_unread", "add")]));
        const before = Buffer.from(raw);
        const seen = [];
        listener.ws.on("message", (b) => seen.push(b));
        assert.equal(replayAsPush(listener, raw), true);
        assert.deepEqual(raw, before, "the original is untouched");
        assert.equal(seen.length, 1);
        assert.equal(seen[0].readUInt16LE(1), CMD_CONTROL_PUSH);
        assert.equal(seen[0][3], 0);
        assert.deepEqual(seen[0].subarray(4), raw.subarray(4), "the body is the same bytes");
    });

    it("hands back false when there is no socket or no frame", () => {
        assert.equal(replayAsPush(null, Buffer.alloc(8)), false);
        assert.equal(replayAsPush({ ws: {} }, Buffer.alloc(8)), false);
        assert.equal(replayAsPush(fakeListener(), Buffer.alloc(2)), false);
        assert.equal(replayAsPush(fakeListener(), "not a buffer"), false);
    });
});

describe("replaying a control queue", () => {
    it("asks from the saved cursor, pages while the answer says more, and replays each page in order as a 601", async () => {
        const listener = fakeListener({
            respond: scripted({
                "603_1": [
                    ctrlPage(
                        "603_1",
                        [control(101, "mark_unread", "add"), control(102, "voice2text", "convert_finish")],
                        {
                            more: 1,
                            lastActionId: 102,
                        },
                    ),
                    ctrlPage("603_1", [control(103, "group", "update")], { lastActionId: 103 }),
                ],
            }),
        });
        const tap = createSocketTap();
        tap.attach(listener);
        const replayed = [];
        tap.on(601, (frame) => replayed.push(frame.data.controls.map((c) => `${c.content.act_type}/${c.content.act}`)));
        const [r] = await replayControlQueues({
            listener,
            tap,
            queues: [{ cmd: 603, subCmd: 1, queueName: "603_1" }],
            cursorOf: () => ({ id: "100" }),
            timeoutMs: 200,
            maxPages: 5,
        });
        assert.deepEqual(
            asks(listener).map((p) => [p.subCmd, p.data.first, p.data.lastId, p.data.preIds]),
            [
                [1, true, "100", []],
                [1, false, "102", []],
            ],
            "the cursor of the first page, then the answer's own lastActionId",
        );
        assert.deepEqual(replayed, [["mark_unread/add", "voice2text/convert_finish"], ["group/update"]]);
        assert.equal(r.replayed, 3);
        assert.equal(r.complete, true);
        assert.equal(r.reason, "drained");
    });

    it("never asks without a saved cursor: a first pull would replay every event the server still holds", async () => {
        const listener = fakeListener({ respond: scripted() });
        const tap = createSocketTap();
        tap.attach(listener);
        const [r] = await replayControlQueues({
            listener,
            tap,
            queues: [{ cmd: 603, subCmd: 0, queueName: "603_0" }],
            cursorOf: () => null,
        });
        assert.equal(asks(listener).length, 0);
        assert.equal(r.reason, "no-cursor");
        assert.equal(r.replayed, 0);
    });

    it("says so when the server dropped entries or the pages never ended, and replays nothing of a silent queue", async () => {
        const listener = fakeListener({
            respond: scripted({
                "603_1": [ctrlPage("603_1", [control(11, "fr", "add")], { evict: 1 })],
                "603_0": [null],
            }),
        });
        const tap = createSocketTap();
        tap.attach(listener);
        const replayed = [];
        tap.on(601, () => replayed.push(1));
        const out = await replayControlQueues({
            listener,
            tap,
            queues: [
                { cmd: 603, subCmd: 1, queueName: "603_1" },
                { cmd: 603, subCmd: 0, queueName: "603_0" },
            ],
            cursorOf: () => ({ id: "10" }),
            timeoutMs: 80,
            maxPages: 3,
        });
        assert.equal(out[0].evicted, true);
        assert.equal(out[0].complete, true);
        assert.equal(out[1].reason, "timeout");
        assert.equal(out[1].replayed, 0);
        assert.equal(replayed.length, 1, "only the answered page was replayed");
    });
});

describe("self-heal replays the control queues after the message queues", () => {
    before(() => assertSandboxed(CONFIG_DIR));
    beforeEach(() => {
        initDb(join(ROOT, `db${dbSeq++}.sqlite`));
    });

    /** A daemon's wiring: the tap and the self-heal, exactly as listen and mcp attach them. */
    function daemon({ respond, enabled = true } = {}) {
        const listener = fakeListener({ respond });
        const tap = createSocketTap();
        const logs = [];
        const api = { listener, getOwnId: () => OWN };
        const heal = createSelfHeal({
            getApi: () => api,
            tap,
            enabled,
            log: (line) => logs.push(line),
            timeoutMs: 150,
            maxPages: 4,
        });
        tap.attach(listener);
        heal.attach(listener);
        listener.emit("connected");
        return { listener, tap, heal, logs };
    }
    const QCMDS = [
        { cmd: 510, subCmd: 1, queueName: "510_1" },
        { cmd: 511, subCmd: 1, queueName: "511_1" },
    ];
    const seed = (queueName, id) => setSyncState(cursorKey(queueName), JSON.stringify({ id, ts: 1 }));
    async function connect(d, auth) {
        d.listener.auth(auth);
        await sleep(0);
        await d.heal.settled();
    }

    it("replays what the server held after the saved cursor, through the handlers of a live push, and moves the cursor", async () => {
        seed("510_1", "500");
        seed("603_1", "100");
        const d = daemon({
            respond: scripted({
                "603_1": [
                    ctrlPage("603_1", [
                        control(110, "voice2text", "convert_finish", { req_id: "r1", text: "xin chào", has_more: 0 }),
                        control(111, "zz_new", "thing"),
                    ]),
                ],
            }),
        });
        const voice = createVoiceText({ file: join(ROOT, "voice.json") });
        const live = [];
        d.tap.on(601, (frame) => {
            live.push(frame.data.controls.length);
            voice.observe(601, frame.data);
        });
        await connect(d, { qCmds: QCMDS, ctrl_qCmds: CTRL_Q });
        const asked = asks(d.listener);
        assert.equal(asked.length, 1, "only 603_1 has a cursor; 603_0 has none and is not asked");
        assert.equal(asked[0].data.lastId, "100");
        assert.deepEqual(live, [2]);
        assert.equal(d.heal.cursor("603_1").id, "111", "the replayed page moved the cursor, as a live push would");
        assert.ok(d.logs.some((l) => /603_1: replayed 2 control\(s\) after 100/.test(l)));
        assert.ok(d.logs.some((l) => /603_0: no saved control cursor yet/.test(l)));
        assert.ok(
            d.logs.some((l) => /no handler for: act_type "zz_new"/.test(l)),
            "an unhandled control is still named",
        );
    });

    it("sends no control pull when the handshake lists no control queue, and none under --no-self-heal", async () => {
        seed("603_1", "100");
        const a = daemon({ respond: scripted() });
        await connect(a, { qCmds: QCMDS });
        assert.equal(asks(a.listener).length, 0);
        const b = daemon({ respond: scripted(), enabled: false });
        b.listener.auth({ qCmds: QCMDS, ctrl_qCmds: CTRL_Q });
        await sleep(20);
        assert.equal(asks(b.listener).length, 0);
    });

    it("names a queue the server dropped entries from, and takes a cursor the server resets", async () => {
        seed("603_1", "100");
        seed("603_0", "50");
        const d = daemon({
            respond: scripted({
                "603_1": [ctrlPage("603_1", [control(120, "group", "update")], { evict: 1 })],
                "603_0": [
                    { error_code: 0, error_message: "", data: { resetLastActionId: "900", more: 0, controls: [] } },
                ],
            }),
        });
        await connect(d, { qCmds: QCMDS, ctrl_qCmds: CTRL_Q });
        assert.ok(d.logs.some((l) => /603_1: Zalo dropped control events/.test(l)));
        assert.equal(d.heal.cursor("603_0").id, "900", "the server's own reset is followed");
    });

    it("hands a replayed frame to the tap as a plain 601 that a decoder can read", () => {
        const listener = fakeListener();
        const raw = serverFrame(603, 1, ctrlPage("603_1", [control(5, "mark_unread", "add")]));
        const seen = [];
        listener.ws.on("message", (b) => seen.push(readFrame(b)));
        replayAsPush(listener, raw);
        assert.equal(seen[0].cmd, 601);
        assert.equal(seen[0].data.controls[0].content.act_type, "mark_unread");
    });
});

describe("on the real zca-js listener", () => {
    it("a replayed group control becomes the same group_event a live push makes", async () => {
        assertSandboxed(CONFIG_DIR);
        const zalo = await startFakeZalo();
        let api = null;
        try {
            zalo.sock.respond(603, 1, (frame) =>
                ok({
                    controls: [
                        {
                            actionId: "7",
                            controlId: "c7",
                            content: {
                                act_type: "group",
                                act: "join_request",
                                data: JSON.stringify({ groupId: "5001" }),
                            },
                        },
                    ],
                    queueStatus: { "603_1": { ids: ["7"], lastId: "7", evict: 0 } },
                    more: 0,
                    lastActionId: "7",
                    reqId: frame.data.reqId,
                }),
            );
            api = await zalo.login();
            const events = [];
            api.listener.on("group_event", (e) => events.push(e));
            const connected = once(api.listener, "connected");
            api.listener.start();
            await connected;
            const tap = createSocketTap();
            tap.attach(api.listener);
            const [r] = await replayControlQueues({
                listener: api.listener,
                tap,
                queues: [{ cmd: 603, subCmd: 1, queueName: "603_1" }],
                cursorOf: () => ({ id: "1" }),
                timeoutMs: 3000,
                maxPages: 2,
            });
            assert.equal(r.replayed, 1);
            for (let i = 0; i < 100 && events.length === 0; i++) await sleep(20);
            assert.equal(events.length, 1, "zca-js emitted the event from the replayed frame");
            assert.equal(events[0].act, "join_request");
            assert.equal(events[0].threadId, "5001");
        } finally {
            if (api?.listener?.ws) {
                api.listener.on("error", () => {});
                api.listener.stop();
            }
            await zalo.stop();
        }
    });
});
