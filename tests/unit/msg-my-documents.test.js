/**
 * `me` as the thread argument of `msg` commands means My Documents.
 *
 * Zalo rejects `msg send <ownUid>` ("Tham số không hợp lệ"): the self-chat is
 * not the own uid but a thread of its own, which zca-js already keeps as
 * `ctx.loginInfo.send2me_id` (captures self.S0/S1; FINDINGS §16;
 * comparison-vs-zca-js.md §3(f)). Sending there is an ordinary 1-1 send with
 * `toid` set to that id -- the replay of `sendMessage(text, send2me, 0)` is
 * identical to the captured request.
 *
 * So `me` resolves to send2me_id as a 1-1, and so does the own uid, which can
 * never name a conversation Zalo accepts. When the session carries no
 * send2me_id the command fails before sending anything.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    seedAccount,
    seedThread,
    seedMessage,
    runOffline,
    requestsTo,
    OWN_UID,
    SEND2ME_ID,
} from "./support/offline-cli.js";

const GROUP = "200000000000000041";
const SELF_MSG = { msgId: "7100000000041", cliMsgId: "1700000000041" };
const GROUP_MSG = { msgId: "7100000000042", cliMsgId: "1700000000042" };

before(() => {
    assertSandboxed(CONFIG_DIR);
    seedAccount();
    seedThread(SEND2ME_ID, "dm");
    seedThread(GROUP, "group");
    seedMessage({
        ...SELF_MSG,
        threadId: SEND2ME_ID,
        senderId: OWN_UID,
        text: "offline note to self",
        timestamp: 1700000000441,
    });
    seedMessage({
        ...GROUP_MSG,
        threadId: GROUP,
        senderId: OWN_UID,
        text: "offline group line",
        timestamp: 1700000000442,
    });
});

/** The single request to `suffix`. */
function only(r, suffix) {
    const hits = requestsTo(r.requests, suffix);
    assert.equal(hits.length, 1, `expected one ${suffix} request, got ${hits.length}\n${r.all}`);
    return hits[0];
}

describe("msg send me", () => {
    it("sends to send2me_id over the 1-1 endpoint", async () => {
        const r = await runOffline(["msg", "send", "me", "offline note"]);
        const q = only(r, "/api/message/sms");
        // Red if the literal "me" (or anything but send2me_id) goes out as toid.
        assert.equal(q.params.toid, SEND2ME_ID);
        assert.equal(q.params.message, "offline note");
    });

    it("the own uid means the same thread, and the command says so", async () => {
        const r = await runOffline(["msg", "send", OWN_UID, "offline note via uid"]);
        assert.equal(only(r, "/api/message/sms").params.toid, SEND2ME_ID);
        assert.match(r.all, /My Documents/);
    });

    it("refuses `me` with -t 1: My Documents is not a group", async () => {
        const r = await runOffline(["msg", "send", "me", "offline", "-t", "1"]);
        assert.deepEqual(r.requests, [], r.all);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /My Documents/);
    });

    it("fails before sending when the session reports no send2me_id", async () => {
        for (const target of ["me", OWN_UID]) {
            const r = await runOffline(["msg", "send", target, "offline"], { send2me: null });
            assert.deepEqual(r.requests, [], `${target}: nothing may be sent\n${r.all}`);
            assert.notEqual(r.code, 0);
            assert.match(r.all, /send2me_id/);
        }
    });
});

describe("other msg commands take `me` too", () => {
    it("msg forward <msgId> me forwards into My Documents", async () => {
        const r = await runOffline(["msg", "forward", GROUP_MSG.msgId, "me"]);
        const q = only(r, "/api/message/mforward");
        assert.equal(q.params.toIds[0].toUid, SEND2ME_ID);
    });

    it("msg react <msgId> me finds the cached self-chat message", async () => {
        const r = await runOffline(["msg", "react", SELF_MSG.msgId, "me", "/-heart"]);
        const q = only(r, "/api/message/reaction");
        assert.equal(q.params.toid, SEND2ME_ID);
        assert.equal(JSON.parse(q.params.react_list[0].message).rMsg[0].cMsgID, Number(SELF_MSG.cliMsgId));
    });
});
