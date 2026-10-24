/**
 * The 532 queue acks (src/core/queue-verify.js, plan item Y10, decision D7), on a hand-driven clock and a recording
 * listener: when an ack goes out, what it carries, what the server's answers mean, and that nothing is acknowledged
 * that was not handed over as stored.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CMD_VERIFY, VERIFY_DEFAULTS, createQueueVerifier, idsOf } from "../../src/core/queue-verify.js";

/** A scheduler that fires only when told. */
function fakeTimers() {
    let nextId = 1;
    const live = new Map();
    return {
        timers: {
            setTimeout(fn, ms) {
                const id = nextId++;
                live.set(id, { fn, ms });
                return { id, unref() {} };
            },
            clearTimeout(h) {
                live.delete(h?.id);
            },
        },
        live: () => [...live.values()],
        fireAll() {
            const due = [...live.entries()];
            for (const [id, { fn }] of due) {
                live.delete(id);
                fn();
            }
        },
        fireWhere(pred) {
            for (const [id, t] of [...live.entries()]) {
                if (pred(t)) {
                    live.delete(id);
                    t.fn();
                }
            }
        },
    };
}

function rig(over = {}) {
    const clock = fakeTimers();
    const sent = [];
    const logs = [];
    let n = 0;
    const listener = { ws: { readyState: 1 }, sendWs: (frame, requireId) => sent.push({ frame, requireId }) };
    const verifier = createQueueVerifier({
        getListener: () => listener,
        timers: clock.timers,
        log: (m) => logs.push(m),
        nextReqId: () => `req_${++n}`,
        ...over,
    });
    return { verifier, clock, sent, logs, listener };
}

describe("idsOf", () => {
    it("reads the ids of one queue as strings, whether they are plain or wrapped in objects", () => {
        const status = { "511_1": { ids: ["10", 11, { actionId: "12" }, { id: 13 }, null, ""], lastId: "x" } };
        assert.deepEqual(idsOf(status, "511_1"), ["10", "11", "12", "13"]);
    });

    it("is empty for a queue that is not there or has no list", () => {
        assert.deepEqual(idsOf({}, "511_1"), []);
        assert.deepEqual(idsOf({ "511_1": {} }, "511_1"), []);
        assert.deepEqual(idsOf(undefined, "511_1"), []);
    });
});

describe("the queue verifier: when an ack goes out", () => {
    it("sends nothing until something is stored", () => {
        const { verifier, sent, clock } = rig();
        assert.equal(verifier.flush(), 0);
        assert.deepEqual(sent, []);
        assert.deepEqual(clock.live(), []);
    });

    it("waits the interval (30 s by default) after the first stored id, then sends one 532", () => {
        const { verifier, sent, clock } = rig();
        verifier.confirm("511_1", ["a1", "a2"]);
        assert.equal(sent.length, 0, "not at once");
        assert.equal(clock.live().length, 1);
        assert.equal(clock.live()[0].ms, VERIFY_DEFAULTS.intervalMs);
        clock.fireWhere((t) => t.ms === VERIFY_DEFAULTS.intervalMs);
        assert.equal(sent.length, 1);
        const { frame, requireId } = sent[0];
        assert.equal(requireId, false, "the Web shape: no zca-js req_id");
        assert.equal(frame.cmd, CMD_VERIFY);
        assert.equal(frame.subCmd, 0);
        assert.deepEqual(frame.data, {
            queueName: "511_1",
            ids: [{ actionId: "a1" }, { actionId: "a2" }],
            nretry: 0,
            reqId: "req_1",
        });
    });

    it("sends at once when max_msg_verify + 2 ids are pending", () => {
        const { verifier, sent } = rig();
        verifier.confirm("510_1", ["1", "2", "3", "4", "5", "6"]);
        verifier.confirm("511_1", ["7", "8", "9", "10", "11"]);
        assert.equal(sent.length, 0, "11 pending is below 12");
        verifier.confirm("511_1", ["12"]);
        assert.equal(sent.length, 2, "one frame per queue");
        assert.deepEqual(sent.map((s) => s.frame.data.queueName).sort(), ["510_1", "511_1"]);
    });

    it("follows the server's own max_msg_verify and interval_verify when it gives them", () => {
        const { verifier, sent, clock } = rig({ settings: () => ({ max_msg_verify: 1, interval_verify: 5000 }) });
        verifier.confirm("511_1", ["1"]);
        assert.equal(clock.live()[0].ms, 5000);
        verifier.confirm("511_1", ["2"]);
        assert.equal(sent.length, 0, "two ids are below 1 + 2");
        verifier.confirm("511_1", ["3"]);
        assert.equal(sent.length, 1, "three ids is the threshold");
    });

    it("counts an id once however often it is confirmed", () => {
        const { verifier, sent, clock } = rig();
        verifier.confirm("511_1", ["1", "1", "1"]);
        verifier.confirm("511_1", ["1"]);
        clock.fireAll();
        assert.equal(sent[0].frame.data.ids.length, 1);
    });

    it("puts at most 50 ids in a frame", () => {
        const { verifier, sent } = rig({ settings: () => ({ max_msg_verify: 500 }) });
        verifier.confirm(
            "511_1",
            Array.from({ length: 120 }, (_, i) => String(i)),
        );
        assert.equal(verifier.flush(), 3);
        assert.deepEqual(
            sent.map((s) => s.frame.data.ids.length),
            [50, 50, 20],
        );
    });

    it("holds the ids when the socket is closed, and sends them when it is next tried", () => {
        const { verifier, sent, clock, listener } = rig();
        verifier.confirm("511_1", ["1"]);
        listener.ws.readyState = 3;
        clock.fireAll();
        assert.equal(sent.length, 0);
        assert.equal(verifier.stats().pending, 1);
        listener.ws.readyState = 1;
        clock.fireAll();
        assert.equal(sent.length, 1);
    });

    it("ignores an empty list and a missing queue name", () => {
        const { verifier, clock } = rig();
        verifier.confirm("511_1", []);
        verifier.confirm("", ["1"]);
        verifier.confirm("511_1", undefined);
        assert.deepEqual(clock.live(), []);
        assert.equal(verifier.stats().pending, 0);
    });

    it("keeps at most 5000 ids, dropping the oldest", () => {
        const { verifier, listener } = rig({ settings: () => ({ max_msg_verify: 1e9 }) });
        listener.ws.readyState = 3;
        verifier.confirm(
            "511_1",
            Array.from({ length: VERIFY_DEFAULTS.maxPending + 10 }, (_, i) => String(i)),
        );
        assert.equal(verifier.stats().pending, VERIFY_DEFAULTS.maxPending);
    });
});

describe("the queue verifier: the server's answers", () => {
    const sendOne = () => {
        const r = rig();
        r.verifier.confirm("511_1", ["1", "2"]);
        r.clock.fireAll();
        return r;
    };

    it("error 0 is done", () => {
        const { verifier } = sendOne();
        assert.equal(verifier.handleReply({ data: { reqId: "req_1", error: 0 } }), true);
        assert.deepEqual(verifier.stats(), { pending: 0, inFlight: 0, sent: 1, acked: 2, missed: 0, stopped: false });
    });

    it("error 1 says some items never arrived: counted, logged, and not an error", () => {
        const { verifier, logs } = sendOne();
        verifier.handleReply({ data: { reqId: "req_1", error: 1 } });
        assert.equal(verifier.stats().missed, 1);
        assert.ok(logs.some((l) => /never reached this client/.test(l)));
    });

    it("error -1 stops verifying for the rest of the connection, until reset", () => {
        const { verifier, sent, clock } = sendOne();
        verifier.handleReply({ data: { reqId: "req_1", error: -1 } });
        assert.equal(verifier.stats().stopped, true);
        verifier.confirm("511_1", ["3"]);
        clock.fireAll();
        assert.equal(sent.length, 1, "nothing more goes out");
        verifier.reset();
        assert.equal(verifier.stats().stopped, false);
        verifier.confirm("511_1", ["3"]);
        clock.fireAll();
        assert.equal(sent.length, 2);
    });

    it("an answer to something else is not ours", () => {
        const { verifier } = sendOne();
        assert.equal(verifier.handleReply({ data: { reqId: "req_99", error: 0 } }), false);
        assert.equal(verifier.handleReply({ data: {} }), false);
        assert.equal(verifier.handleReply(null), false);
        assert.equal(verifier.stats().inFlight, 1);
    });

    it("an ack that gets no answer is sent again with nretry 1 and 2, then dropped", () => {
        const { verifier, sent, clock, logs } = rig();
        verifier.confirm("511_1", ["1"]);
        clock.fireAll(); // the interval: first send
        assert.equal(sent.length, 1);
        clock.fireWhere((t) => t.ms === VERIFY_DEFAULTS.replyTimeoutMs);
        clock.fireWhere((t) => t.ms === VERIFY_DEFAULTS.replyTimeoutMs);
        clock.fireWhere((t) => t.ms === VERIFY_DEFAULTS.replyTimeoutMs);
        assert.deepEqual(
            sent.map((s) => s.frame.data.nretry),
            [0, 1, 2],
        );
        assert.deepEqual(
            sent.map((s) => s.frame.data.reqId),
            ["req_1", "req_2", "req_3"],
            "each try has its own reqId",
        );
        assert.ok(logs.some((l) => /no answer after 3 tries/.test(l)));
        assert.equal(verifier.stats().inFlight, 0);
    });

    it("an answer stops the retries", () => {
        const { verifier, sent, clock } = rig();
        verifier.confirm("511_1", ["1"]);
        clock.fireAll();
        verifier.handleReply({ data: { reqId: "req_1", error: 0 } });
        clock.fireWhere((t) => t.ms === VERIFY_DEFAULTS.replyTimeoutMs);
        assert.equal(sent.length, 1);
    });
});

describe("the queue verifier: a connection ends", () => {
    it("reset forgets what was pending and what was in flight", () => {
        const { verifier, clock, sent } = rig();
        verifier.confirm("511_1", ["1"]);
        verifier.reset();
        assert.deepEqual(clock.live(), []);
        assert.equal(verifier.stats().pending, 0);
        clock.fireAll();
        assert.equal(sent.length, 0);
    });

    it("stop ends it for good", () => {
        const { verifier, clock } = rig();
        verifier.stop();
        verifier.confirm("511_1", ["1"]);
        assert.deepEqual(clock.live(), []);
        assert.equal(verifier.stats().stopped, true);
    });
});
