/**
 * `msg forward` must send the forward the way Zalo Web does: with a reference.
 *
 * Forwarded text used to go out as `msgInfo: {"message": …}` and
 * `decorLog: "null"`, so the copy arrived as plain text with no "forwarded"
 * badge. The code's comment claimed the reference id was opaque and not
 * derivable. It is derivable, and the web derives it:
 *
 *     id = md5(cliMsgId + senderUid + conversationKey)
 *
 * where senderUid is the sender's numeric uid (the own uid for one's own
 * message) and conversationKey is the web's conversation id: "g" + groupId for
 * a group, the peer's uid for a 1-1. Checked offline against the real capture
 * (agent/work/zalo-web-capture-2026-09-29/live/both.A16_forward_multi.json):
 * md5 of the captured source cliMsgId + the own uid + "g" + the group id
 * reproduces the captured reference id exactly (comparison-vs-zca-js.md §5.16).
 *
 * The expected ids below were computed from the fake ids here with that
 * derivation. The request SHAPE is the captured one, key order included,
 * because msgInfo, reference, data and decorLog are nested JSON strings and
 * the web's serialization is what the server has been seen to accept:
 *
 *   msgInfo   = {"message", "reference": "{\"type\":3,\"data\":\"{id,ts,logSrcType,fwLvl,rootMsgRef}\"}"}
 *   decorLog  = {"fw":{"pmsg":{"st","ts","id"},"rmsg":{"st","ts","id"},"fwLvl"}}
 *
 * `st` is the reference's logSrcType (the web maps st -> logSrcType), so it is
 * 2 for a group source and 1 for a 1-1 source. zca-js hardcodes 1, which is
 * why this goes through a custom call.
 *
 * NOT captured, derived from the web bundle and flagged for the live session:
 * a 1-1 SOURCE (conversationKey = peer uid, logSrcType 1), and `ts` = the
 * source message's server timestamp -- the web's own sends carry their local
 * send time there, which in the capture equals the cliMsgId.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { seedAccount, seedThread, seedMessage, runOffline, requestsTo, OWN_UID } from "./support/offline-cli.js";

const GROUP_SRC = "200000000000000021";
const GROUP_DST = "200000000000000022";
const PEER_SRC = "300000000000000021";
const PEER_DST = "300000000000000022";
const NOISED = "VNOISED0000000000000000000000021";
const RESOLVED = "500000000000000021";

const A = { msgId: "7100000000021", cliMsgId: "1700000000021", timestamp: 1700000000321, text: "offline forward A" };
const B = { msgId: "7100000000022", cliMsgId: "1700000000022", timestamp: 1700000000322, text: "offline forward B" };
const C = { msgId: "7100000000023", cliMsgId: "1700000000023", timestamp: 1700000000323, text: "offline forward C" };
const D = { msgId: "7100000000024", cliMsgId: "1700000000024", timestamp: 1700000000324, text: "offline forward D" };
const E = { msgId: "7100000000025", cliMsgId: null, timestamp: 1700000000325, text: "offline forward E" };
const F = { msgId: "7100000000026", cliMsgId: "1700000000026", timestamp: 1700000000326, text: "offline forward F" };

/** md5(cliMsgId + senderUid + conversationKey), precomputed for the ids above. */
const REF_ID = {
    A: "cbc0fcab6c526cd823ea6af4247458f2", // group source, own message: key "g" + GROUP_SRC
    B: "65699a67b33db1809f64f5ef9ab9875c", // 1-1 source, own message: key PEER_SRC
    C: "7a682633cbe9648ec4ca070a10236315", // 1-1 source, the peer's message: sender PEER_SRC
    D: "2fa3ad4f7ad737bfd228159b1a6c9326", // group source, sync row: noised sender resolved to RESOLVED
};

before(() => {
    assertSandboxed(CONFIG_DIR);
    seedAccount();
    for (const [id, type] of [
        [GROUP_SRC, "group"],
        [GROUP_DST, "group"],
        [PEER_SRC, "dm"],
        [PEER_DST, "dm"],
    ]) {
        seedThread(id, type);
    }
    seedMessage({ ...A, threadId: GROUP_SRC, senderId: OWN_UID });
    seedMessage({ ...B, threadId: PEER_SRC, senderId: OWN_UID });
    seedMessage({ ...C, threadId: PEER_SRC, senderId: PEER_SRC });
    seedMessage({ ...D, threadId: GROUP_SRC, senderId: NOISED, src: "sync-v2" });
    seedMessage({ ...E, threadId: GROUP_SRC, senderId: OWN_UID });
    seedMessage({ ...F, threadId: GROUP_SRC, senderId: "VNOISED0000000000000000000000026", src: "sync-v2" });
});

/**
 * The msgInfo / decorLog strings Zalo Web sends for a first-level forward.
 *
 * @param {string} text
 * @param {string} id - the reference id
 * @param {number} ts
 * @param {number} logSrcType - 2 group, 1 one-to-one
 */
function expectedForward(text, id, ts, logSrcType) {
    const data = JSON.stringify({ id, ts, logSrcType, fwLvl: 1, rootMsgRef: { id, ts, logSrcType } });
    return {
        msgInfo: JSON.stringify({ message: text, reference: JSON.stringify({ type: 3, data }) }),
        decorLog: JSON.stringify({
            fw: { pmsg: { st: logSrcType, ts, id }, rmsg: { st: logSrcType, ts, id }, fwLvl: 1 },
        }),
    };
}

/** The single mforward request of a run. */
function onlyForward(r, suffix) {
    const hits = requestsTo(r.requests, suffix);
    assert.equal(hits.length, 1, `expected one ${suffix} request, got ${hits.length}\n${r.all}`);
    return hits[0];
}

describe("msg forward sends the captured reference and decorLog", () => {
    it("group source -> group target: key order, nesting, st 2, no imei", async () => {
        const r = await runOffline(["msg", "forward", A.msgId, GROUP_DST, "-t", "1"]);
        const q = onlyForward(r, "/api/group/mforward");
        const want = expectedForward(A.text, REF_ID.A, A.timestamp, 2);

        assert.equal(q.method, "POST");
        assert.equal(q.service, "file");
        // Red if the reference is missing, derived from different inputs, or
        // serialized in a different order or nesting than the web's.
        assert.equal(q.params.msgInfo, want.msgInfo);
        assert.equal(q.params.decorLog, want.decorLog);
        assert.deepEqual(Object.keys(q.params), ["grids", "ttl", "msgType", "totalIds", "msgInfo", "decorLog"]);
        assert.equal(q.params.grids.length, 1);
        assert.deepEqual(Object.keys(q.params.grids[0]), ["clientId", "grid", "ttl"]);
        assert.equal(q.params.grids[0].grid, GROUP_DST);
        assert.match(q.params.grids[0].clientId, /^\d+$/, "the captured clientId is a digit string");
        assert.equal(q.params.msgType, "1");
        assert.equal(q.params.totalIds, 1);
    });

    it("group source -> 1-1 target: toIds and imei, same reference", async () => {
        const r = await runOffline(["msg", "forward", A.msgId, PEER_DST, "-t", "0"]);
        const q = onlyForward(r, "/api/message/mforward");
        const want = expectedForward(A.text, REF_ID.A, A.timestamp, 2);
        assert.equal(q.params.msgInfo, want.msgInfo);
        assert.equal(q.params.decorLog, want.decorLog);
        assert.deepEqual(Object.keys(q.params), ["toIds", "imei", "ttl", "msgType", "totalIds", "msgInfo", "decorLog"]);
        assert.deepEqual(Object.keys(q.params.toIds[0]), ["clientId", "toUid", "ttl"]);
        assert.equal(q.params.toIds[0].toUid, PEER_DST);
        assert.equal(q.params.imei, "offline-test-imei");
    });

    it("1-1 source: the peer uid is the conversation key, logSrcType and st are 1 (UNVERIFIED live)", async () => {
        const r = await runOffline(["msg", "forward", B.msgId, GROUP_DST, "-t", "1"]);
        const q = onlyForward(r, "/api/group/mforward");
        const want = expectedForward(B.text, REF_ID.B, B.timestamp, 1);
        assert.equal(q.params.msgInfo, want.msgInfo);
        assert.equal(q.params.decorLog, want.decorLog);
    });

    it("someone else's message: their uid, not ours, goes into the id", async () => {
        const r = await runOffline(["msg", "forward", C.msgId, GROUP_DST, "-t", "1"]);
        const q = onlyForward(r, "/api/group/mforward");
        assert.equal(q.params.msgInfo, expectedForward(C.text, REF_ID.C, C.timestamp, 1).msgInfo);
    });

    it("a sync-restored row: the noised sender is resolved before it goes into the id", async () => {
        const r = await runOffline(["msg", "forward", D.msgId, GROUP_DST, "-t", "1"], {
            responses: { "/api/gid/decrypt": { [NOISED]: RESOLVED } },
        });
        assert.equal(requestsTo(r.requests, "/api/gid/decrypt").length, 1, r.all);
        const q = onlyForward(r, "/api/group/mforward");
        assert.equal(q.params.msgInfo, expectedForward(D.text, REF_ID.D, D.timestamp, 2).msgInfo);
    });

    it("reports each forwarded msgId with the cliMsgId that went on the wire", async () => {
        const r = await runOffline(["--json", "msg", "forward", A.msgId, GROUP_DST, "-t", "1"]);
        const q = onlyForward(r, "/api/group/mforward");
        const out = JSON.parse(r.stdout);
        assert.equal(out.sent.length, 1, r.stdout);
        assert.equal(out.sent[0].cliMsgId, q.params.grids[0].clientId, "tier 4 recalls forwards by this pair");
        assert.match(out.sent[0].msgId, /^\d+$/);
    });
});

describe("msg forward refuses a forward it cannot reference correctly", () => {
    it("no cached cliMsgId: nothing is sent", async () => {
        const r = await runOffline(["msg", "forward", E.msgId, GROUP_DST, "-t", "1"]);
        assert.deepEqual(requestsTo(r.requests, "/mforward"), [], r.all);
        assert.notEqual(r.code, 0);
        assert.match(r.all, /cliMsgId/);
    });

    it("a noised sender that does not resolve: nothing is sent", async () => {
        const r = await runOffline(["msg", "forward", F.msgId, GROUP_DST, "-t", "1"]);
        assert.equal(requestsTo(r.requests, "/api/gid/decrypt").length, 1, "it must try to resolve first");
        assert.deepEqual(requestsTo(r.requests, "/mforward"), [], r.all);
        assert.notEqual(r.code, 0);
    });
});
