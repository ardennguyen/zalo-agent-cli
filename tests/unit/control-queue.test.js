/**
 * The 601 control frames and their queues (src/core/control-queue.js, plan item X4): which controls this client has
 * a handler for, which it does not, and the cursors of the control queues. The daemon's use of both is tested with
 * the self-heal in self-heal.test.js.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONTROL_QUEUES, controlCursorsOf, readControls } from "../../src/core/control-queue.js";

const control = (actionId, act_type, act, data = {}) => ({
    actionId,
    controlId: actionId,
    content: { act, act_type, data },
});

describe("readControls", () => {
    it("sorts the controls of a frame by what they are, keeping their action ids", () => {
        const out = readControls({
            controls: [
                control("11", "transfer_sync2", "transfer_status"),
                control("12", "mark_unread", "mark_unread"),
                control("13", "group", "join"),
                control("14", "fr", "req"),
                control("15", "file_done", "file_done"),
            ],
        });
        assert.deepEqual(
            out.map((c) => [c.actionId, c.kind, c.handler, c.handled]),
            [
                ["11", "sync", "sync-v2", true],
                ["12", "read-state", "read-state", true],
                ["13", "group-event", "zca-js", true],
                ["14", "friend-event", "zca-js", true],
                ["15", "upload", "zca-js", true],
            ],
        );
    });

    it("names a control nobody handles instead of dropping it", () => {
        const [c] = readControls({ controls: [control("21", "board_update", "topic_changed")] });
        assert.equal(c.handled, false);
        assert.equal(c.kind, "unknown");
        assert.equal(c.handler, null);
        assert.equal(c.actType, "board_update");
        assert.equal(c.act, "topic_changed");
    });

    it("tolerates frames without controls and controls without content", () => {
        assert.deepEqual(readControls(null), []);
        assert.deepEqual(readControls({}), []);
        assert.deepEqual(readControls({ controls: "no" }), []);
        assert.deepEqual(readControls({ controls: [null, {}, { content: "x" }] }), []);
    });

    it("reads a missing action id as null", () => {
        assert.equal(
            readControls({ controls: [{ content: { act: "mark_unread", act_type: "mark_unread" } }] })[0].actionId,
            null,
        );
    });
});

describe("controlCursorsOf", () => {
    it("reads the three control queues' lastId, in the queues' order", () => {
        const data = {
            queueStatus: {
                "604_0": { ids: [], lastId: "300" },
                "603_1": { ids: [], lastId: "100" },
                "603_0": { ids: [], lastId: "200" },
                "511_1": { ids: [], lastId: "999" },
            },
        };
        assert.deepEqual(controlCursorsOf(data), [
            { queueName: "603_1", id: "100" },
            { queueName: "603_0", id: "200" },
            { queueName: "604_0", id: "300" },
        ]);
        assert.deepEqual(CONTROL_QUEUES, ["603_1", "603_0", "604_0"]);
    });

    it("skips a queue with no usable cursor: absent, zero, or not a number", () => {
        const data = { queueStatus: { "603_1": { lastId: "0" }, "603_0": { lastId: "abc" }, "604_0": {} } };
        assert.deepEqual(controlCursorsOf(data), []);
        assert.deepEqual(controlCursorsOf({}), []);
        assert.deepEqual(controlCursorsOf(undefined), []);
    });

    it("accepts a numeric lastId and returns it as a string", () => {
        assert.deepEqual(controlCursorsOf({ queueStatus: { "603_1": { lastId: 77 } } }), [
            { queueName: "603_1", id: "77" },
        ]);
    });
});
