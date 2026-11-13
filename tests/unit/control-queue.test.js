/**
 * The 601 control frames and their queues (src/zalo/queues/control-queue.js, plan item X4): which controls this client has
 * a handler for, which it does not, and the cursors of the control queues. The daemon's use of both is tested with
 * the self-heal in self-heal.test.js.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONTROL_QUEUES, controlCursorsOf, readControls } from "../../src/zalo/queues/control-queue.js";

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
                control("16", "video_done", "video_done"),
                control("17", "photo_success", "photo"),
            ],
        });
        assert.deepEqual(
            out.map((c) => [c.actionId, c.kind, c.handler, c.handled]),
            [
                ["11", "sync", "sync-v2", true],
                ["12", "read-state", "read-state", true],
                // The listener (src/zalo/listener/dispatch.js) handles these now; the video and photo forms of an
                // upload settlement are its too (design 1.4). Red if one of them were left nameless.
                ["13", "group-event", "listener", true],
                ["14", "friend-event", "listener", true],
                ["15", "upload", "listener", true],
                ["16", "upload", "listener", true],
                ["17", "upload", "listener", true],
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

    it("hands the conversation and quick-message controls seen live to control-events", () => {
        const out = readControls({
            controls: [
                control("31", "mute", "set"),
                control("32", "mute", "unset"),
                control("33", "label_convers", "update"),
                control("34", "archived_chat", "update"),
                control("35", "quick_message", "create"),
                control("36", "conv_settings", "update_ttl"),
            ],
        });
        assert.deepEqual(
            out.map((c) => [c.kind, c.handler, c.handled, c.ignored]),
            [
                ["mute", "control-events", true, null],
                ["mute", "control-events", true, null],
                ["labels", "control-events", true, null],
                ["archived", "control-events", true, null],
                ["quick-message", "control-events", true, null],
                ["auto-delete", "control-events", true, null],
            ],
        );
    });

    it("knows the controls Zalo uses only for its own UI, with no handler and a reason", () => {
        const out = readControls({
            controls: [
                control("41", "media_send2me", "remove_media"),
                control("42", "photo", "renew_link"),
                control("43", "file", "renew_link"),
                control("44", "emoji_status", "add"),
                control("45", "emoji_status", "delete"),
                control("46", "contact_tab", "clicked"),
                control("47", "transfer_msg", "transfer_after_login"),
            ],
        });
        for (const c of out) {
            assert.equal(c.handled, true, `${c.actType}/${c.act} is known`);
            assert.equal(c.handler, null, `${c.actType}/${c.act} has nothing to run`);
            assert.ok(typeof c.ignored === "string" && c.ignored.length > 20, `${c.actType}/${c.act} says why`);
        }
        assert.deepEqual(
            out.map((c) => c.kind),
            ["self-chat-media", "renew-link", "renew-link", "emoji-status", "emoji-status", "ui", "sync"],
        );
    });

    it("matches act_type/act before act_type: a sibling act of a pair entry stays unknown", () => {
        const [ttl, blockSharing, photoOther] = readControls({
            controls: [
                control("51", "conv_settings", "update_ttl"),
                control("52", "conv_settings", "update_block_sharing"),
                control("53", "photo", "something_else"),
            ],
        });
        assert.equal(ttl.handled, true);
        assert.equal(blockSharing.handled, false, "only update_ttl of conv_settings is handled");
        assert.equal(photoOther.handled, false, "only renew_link of photo is known");
        assert.equal(ttl.ignored, null);
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
