/**
 * `msg react` must key the reaction on the message's real cliMsgId.
 *
 * Zalo's reaction payload names its target twice: `gMsgID` (the global msgId)
 * and `cMsgID` (the client id only the sender ever minted). Send the msgId in
 * both and Zalo answers "Successful." while the reaction never appears on
 * anyone's screen -- the command's own comment admitted as much. Without `-c`
 * `msg react` did exactly that, and `msg send --react` did it too whenever the
 * send came back without a cliMsgId (an install whose zca-js patch did not
 * apply). `msg undo` and `msg delete` already take the cliMsgId from the local
 * cache; `msg react` now does the same, and refuses rather than send a reaction
 * that cannot show.
 *
 * Every test drives the real CLI against an offline session
 * (./support/offline-session.js) and asserts the request zca-js actually put
 * on the wire, decrypted.
 *
 * Capture this is checked against: agent/work/zalo-web-capture-2026-09-29,
 * group.A5_default and dm.D5_reaction_heart (comparison-vs-zca-js.md #13, §5.13):
 * the web sends `cMsgID: <the target's cliMsgId>`, never its msgId.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { seedAccount, seedThread, seedMessage, runOffline, requestsTo, OWN_UID } from "./support/offline-cli.js";

const GROUP = "200000000000000011";
const PEER = "300000000000000011";
const GROUP_MSG = { msgId: "7100000000011", cliMsgId: "1700000000011" };
const DM_MSG = { msgId: "7100000000012", cliMsgId: "1700000000012" };
const UNCACHED_MSG = "7100000000019";

before(() => {
    assertSandboxed(CONFIG_DIR);
    seedAccount();
    seedThread(GROUP, "group");
    seedThread(PEER, "dm");
    seedMessage({
        ...GROUP_MSG,
        threadId: GROUP,
        senderId: "500000000000000011",
        text: "offline react group target",
        timestamp: 1700000000111,
    });
    seedMessage({
        ...DM_MSG,
        threadId: PEER,
        senderId: OWN_UID,
        text: "offline react dm target",
        timestamp: 1700000000112,
    });
});

/**
 * The one `rMsg` entry of the one reaction request.
 *
 * @param {object[]} reactions - requests to …/reaction
 * @returns {{gMsgID: number, cMsgID: number, msgType: number}}
 */
function reactedMessage(reactions) {
    assert.equal(reactions.length, 1, `expected exactly one reaction request, got ${reactions.length}`);
    const message = JSON.parse(reactions[0].params.react_list[0].message);
    assert.equal(message.rMsg.length, 1);
    return message.rMsg[0];
}

describe("msg react takes the cliMsgId from the local cache when -c is omitted", () => {
    it("group: cMsgID is the cached cliMsgId, gMsgID the msgId", async () => {
        const r = await runOffline(["msg", "react", GROUP_MSG.msgId, GROUP, "/-strong", "-t", "1"]);
        const reactions = requestsTo(r.requests, "/api/group/reaction");
        const rMsg = reactedMessage(reactions);
        // Red if cMsgID is anything but the cached client id -- in particular
        // the msgId, which is what the command used to send.
        assert.equal(rMsg.cMsgID, Number(GROUP_MSG.cliMsgId), r.all);
        assert.equal(String(rMsg.gMsgID), GROUP_MSG.msgId);
        assert.equal(reactions[0].params.grid, GROUP);
        assert.equal(reactions[0].service, "reaction");
    });

    it("DM: same lookup, sent to the 1-1 endpoint", async () => {
        const r = await runOffline(["msg", "react", DM_MSG.msgId, PEER, "/-heart"]);
        const reactions = requestsTo(r.requests, "/api/message/reaction");
        const rMsg = reactedMessage(reactions);
        assert.equal(rMsg.cMsgID, Number(DM_MSG.cliMsgId), r.all);
        assert.equal(reactions[0].params.toid, PEER);
    });

    it("an explicit -c still wins over the cache", async () => {
        const r = await runOffline([
            "msg",
            "react",
            GROUP_MSG.msgId,
            GROUP,
            "/-strong",
            "-t",
            "1",
            "-c",
            "1700000000999",
        ]);
        const rMsg = reactedMessage(requestsTo(r.requests, "/api/group/reaction"));
        assert.equal(rMsg.cMsgID, 1700000000999);
    });
});

describe("msg react refuses rather than send a reaction that cannot show", () => {
    it("an uncached message without -c: no request at all, and the way out is named", async () => {
        const r = await runOffline(["msg", "react", UNCACHED_MSG, GROUP, "/-strong", "-t", "1"]);
        // Red if any reaction goes out: without a real cliMsgId it would be
        // accepted by Zalo and never displayed.
        assert.deepEqual(requestsTo(r.requests, "/reaction"), [], r.all);
        assert.notEqual(r.code, 0, "a refusal must not report success");
        assert.match(r.all, /not in the local cache/);
        assert.match(r.all, /\blisten\b/, "names the listener as a way to cache it");
        assert.match(r.all, /\bsync\b/, "names sync as a way to cache it");
        assert.match(r.all, /(^|\s)-c\b|--cli-msg-id/, "names -c as the override");
    });

    it("a msgId cached under a different thread is not this thread's message", async () => {
        // msgIds are account-wide; a cached row from another conversation must
        // not lend its cliMsgId to a reaction aimed somewhere else.
        const r = await runOffline(["msg", "react", GROUP_MSG.msgId, PEER, "/-strong"]);
        assert.deepEqual(requestsTo(r.requests, "/reaction"), [], r.all);
        assert.match(r.all, /not in the local cache/);
    });
});

describe("msg send --react", () => {
    it("reacts with the clientId the send itself put on the wire", async () => {
        const r = await runOffline(["msg", "send", PEER, "offline auto-react target", "--react", "/-heart"]);
        const [sent] = requestsTo(r.requests, "/api/message/sms");
        assert.ok(sent, r.all);
        const rMsg = reactedMessage(requestsTo(r.requests, "/api/message/reaction"));
        assert.equal(rMsg.cMsgID, sent.params.clientId, "the reaction must name the message that was just sent");
    });

    it("skips the reaction when the send reports no cliMsgId, instead of keying it on the msgId", async () => {
        // An install where patches/zca-js+2.2.0.patch did not apply: upstream
        // zca-js returns only {msgId}. The message still goes out; the reaction
        // must not, because keyed on the msgId it would be invisible.
        const r = await runOffline(["msg", "send", PEER, "offline unpatched send", "--react", "/-heart"], {
            unpatched: true,
        });
        assert.equal(requestsTo(r.requests, "/api/message/sms").length, 1, "the message itself is still sent");
        assert.deepEqual(requestsTo(r.requests, "/reaction"), [], r.all);
        assert.match(r.all, /--react/, "says the reaction was skipped");
        assert.match(r.all, /msg react/, "and how to react once the id is known");
    });
});
