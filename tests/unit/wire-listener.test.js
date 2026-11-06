/**
 * The listener, zca-js against ours (agent/docs/zca-replace/design.md 3.2): one login, zca-js's listener on fake socket
 * A and ours on fake socket B, the same frames played to both, and every event, every frame each sent and each
 * upgrade compared. The differences are not hidden: each is a row of tests/helpers/wire-diff/allow/listener.js (with
 * the Web behavior it follows) and must be present, and our side of every script is also pinned by a golden entry
 * (tests/helpers/wire-diff/golden/listener.js), which keeps guarding the wire after zca-js leaves (design 3.3).
 *
 * One script per spec-listener item (5-11), plus the 534 re-push. Every id is fake.
 */
import "../helpers/sandbox.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { openListenerPair } from "../helpers/wire-diff/listener-pair.js";
import { assertSameListener } from "../helpers/wire-diff/compare.js";
import { ALLOW } from "../helpers/wire-diff/allow.js";
import { expectGolden } from "../helpers/wire-diff/golden.js";
import { FAKE } from "./fake-zalo-session.js";

// Fake ids (tests/unit/no-real-ids.test.js): past 2^53 where an id would be.
const PEER = "2000000000000000002";
const PEER2 = "2000000000000000004";
const GROUP = "3000000000000000003";
const OWN = FAKE.ownId;

const ok = (data) => ({ error_code: 0, error_message: "", data });

/** A 1-1 message as a 501 push carries it. */
const dm = (n, extra = {}) => ({
    actionId: `700000000000000000${n}`,
    msgId: `500000000000000000${n}`,
    cliMsgId: `170000000000${n}`,
    msgType: "webchat",
    uidFrom: PEER,
    idTo: "0",
    dName: "Fake Peer",
    ts: "1700000000000",
    status: 1,
    content: `hello ${n}`,
    notify: "1",
    ttl: 0,
    cmd: 501,
    st: 3,
    at: 5,
    ...extra,
});

/** A group message as a 521 push carries it. */
const gm = (n, extra = {}) => dm(n, { idTo: GROUP, cmd: 521, ...extra });

/** A control (`controls[]` entry) of a 601 push. */
const control = (n, act_type, act, data, extra = {}) => ({
    actionId: `800000000000000000${n}`,
    controlId: `800000000000000000${n}`,
    content: { act_type, act, data, ...extra },
});

/** A reaction as 612 and 610/611 carry it; `content` is JSON text on the wire. */
const react = (n, extra = {}, content = {}) => ({
    actionId: `900000000000000000${n}`,
    msgId: `910000000000000000${n}`,
    cliMsgId: `171000000000${n}`,
    msgType: "chat.reaction",
    uidFrom: PEER,
    idTo: "0",
    dName: "Fake Peer",
    ts: "1700000000500",
    ttl: 0,
    content: JSON.stringify({
        rMsg: [{ gMsgID: `500000000000000000${n}`, cMsgID: `170000000000${n}`, msgType: 1 }],
        rIcon: "/-heart",
        rType: 5,
        source: 6,
        ...content,
    }),
    ...extra,
});

/** The scripts, by name: each is played in order on one pair, and compared on what it added. */
const SCRIPTS = {
    // spec-listener 5: messages (501, 521), in every encoding, with a big quote owner, an attachment and a removal.
    messages: [
        {
            cmd: 501,
            encrypt: 2,
            body: ok({
                msgs: [
                    dm(1),
                    dm(2, { uidFrom: "0", idTo: PEER, dName: "Me" }),
                    dm(3, {
                        quote: { ownerId: PEER2, globalMsgId: "5000000000000000001", cliMsgId: "1", msg: "q" },
                    }),
                    dm(4, {
                        msgType: "chat.photo",
                        content: { title: "", href: "https://f.invalid/p.jpg", thumb: "https://f.invalid/t.jpg" },
                    }),
                    dm(5, { msgType: "chat.delete", content: { deleteMsg: undefined, action: "delete" } }),
                ],
            }),
        },
        {
            cmd: 521,
            encrypt: 1,
            zip: "gzip",
            body: ok({
                groupMsgs: [
                    gm(6, { mentions: [{ uid: PEER2, pos: 0, len: 4, type: 0 }], content: "@Two hi" }),
                    gm(7, { uidFrom: "0", dName: "Me" }),
                ],
            }),
        },
        { cmd: 501, encrypt: 3, body: ok({ msgs: [dm(8)] }) },
        { cmd: 501, encrypt: 0, body: ok({ msgs: [dm(9)] }) },
        { text: "a text frame is ignored by both" },
    ],
    // spec-listener 5 and 3 (Push messages): Web reads every list of every chat push.
    "mixed-pushes": [
        {
            cmd: 501,
            encrypt: 2,
            body: ok({ msgs: [dm(1)], groupMsgs: [gm(2)], pageMsgs: [dm(3, { uidFrom: PEER2 })] }),
        },
        { cmd: 504, encrypt: 2, body: ok({ msgs: [dm(4)], groupMsgs: [gm(5)], delivereds: [], seens: [] }) },
        // 524: the group form of the mixed offline push, read the same way.
        { cmd: 524, encrypt: 2, body: ok({ msgs: [], groupMsgs: [gm(6)], delivereds: [], groupSeens: [] }) },
    ],
    // spec-listener 3 (Push messages): 534, the server's re-push of a message it never saw confirmed, in the
    // envelope of 501/521. The engine's self-heal stores it from the raw tap; the listener announces it as well.
    repush: [{ cmd: 534, encrypt: 2, body: ok({ msgs: [dm(1)], groupMsgs: [gm(2)] }) }],
    // spec-listener 6: recalls, 1-1 and group.
    undo: [
        {
            cmd: 501,
            encrypt: 2,
            body: ok({
                msgs: [
                    dm(1, {
                        msgType: "chat.undo",
                        content: { globalMsgId: "5000000000000000009", cliMsgId: "1", deleteMsg: 1 },
                    }),
                ],
            }),
        },
        {
            cmd: 521,
            encrypt: 2,
            body: ok({
                groupMsgs: [
                    gm(2, {
                        uidFrom: "0",
                        msgType: "chat.undo",
                        content: { globalMsgId: "5000000000000000008", cliMsgId: "2", deleteMsg: 1 },
                    }),
                ],
            }),
        },
    ],
    // spec-listener 7: the Signal pushes. zca-js 2.2.0 reads none of them.
    e2ee: [
        {
            cmd: 551,
            encrypt: 2,
            body: ok({ msgs: [dm(1), dm(2, { msgType: "chat.e2ee.text", content: "fake-ciphertext" })] }),
        },
        // 552: the group form; 535: the Signal queue's missed-message push. Both take the same path as 551.
        {
            cmd: 552,
            encrypt: 2,
            body: ok({ groupMsgs: [gm(3), gm(4, { msgType: "chat.e2ee.text", content: "fake-ciphertext" })] }),
        },
        {
            cmd: 535,
            encrypt: 2,
            body: ok({ msgs: [dm(5, { msgType: "chat.e2ee.text", content: "fake-ciphertext" })] }),
        },
    ],
    // spec-listener 8: live reactions (one malformed, then the rest), the two backlog pages, reactions in a 601.
    reactions: [
        {
            cmd: 612,
            encrypt: 2,
            body: ok({
                reacts: [react(1), react(2, {}, { rIcon: "", rType: -1 }), react(3, { content: "{not json" })],
                reactGroups: [react(4, { idTo: GROUP })],
            }),
        },
        {
            cmd: 610,
            sub: 1,
            encrypt: 2,
            body: ok({ reacts: [react(5)], more: 0, lastActionId: "9000000000000000005" }),
        },
        {
            cmd: 611,
            sub: 1,
            encrypt: 2,
            body: ok({ reactGroups: [react(6, { idTo: GROUP })], more: 1, lastActionId: "9000000000000000006" }),
        },
        { cmd: 601, encrypt: 2, body: ok({ controls: [], reactGroups: [react(7, { idTo: GROUP })] }) },
    ],
    // spec-listener 9: controls.
    controls: [
        {
            cmd: 601,
            encrypt: 2,
            body: ok({
                controls: [
                    control(1, "file_done", "file_done", { url: "https://f.invalid/f.bin" }, { fileId: "6000000001" }),
                    control(2, "group", "join_reject", JSON.stringify({ groupId: GROUP, updateMembers: [] })),
                    control(
                        3,
                        "group",
                        "update",
                        JSON.stringify({ groupId: GROUP, groupName: "Fake group", sourceId: PEER, updateMembers: [] }),
                    ),
                    control(
                        4,
                        "group",
                        "join",
                        JSON.stringify({ groupId: GROUP, sourceId: PEER, updateMembers: [{ id: OWN, dName: "Me" }] }),
                    ),
                    control(
                        5,
                        "group",
                        "update_board",
                        JSON.stringify({ groupId: GROUP, sourceId: OWN, groupTopic: { type: 0 } }),
                    ),
                    control(6, "group", "join_accept", JSON.stringify({ groupId: GROUP, sourceId: PEER })),
                    control(7, "fr", "req", JSON.stringify({ fromUid: PEER, toUid: OWN, message: "hi" })),
                    control(8, "fr", "req_v2", JSON.stringify({ fromUid: PEER, toUid: OWN, message: "hi" })),
                    control(9, "fr", "add", PEER2),
                    control(
                        10,
                        "fr",
                        "pin_create",
                        JSON.stringify({
                            actorId: OWN,
                            conversationId: PEER,
                            topic: { type: 2, params: JSON.stringify({ title: "pinned" }) },
                        }),
                    ),
                    control(11, "fr", "some_new_act", JSON.stringify({ x: 1 })),
                    control(12, "mark_unread", "mark_unread", JSON.stringify({ convers: [] })),
                ],
            }),
        },
    ],
    // spec-listener 10: typing and receipts.
    "typing-receipts": [
        {
            cmd: 602,
            encrypt: 2,
            body: ok({
                actions: [
                    { act_type: "typing", act: "typing", data: `"uid":"${PEER}","ts":"1700000000000","isPC":0` },
                    {
                        act_type: "typing",
                        act: "gtyping",
                        data: `"uid":"${PEER}","gid":"${GROUP}","ts":"1700000000001","isPC":1`,
                    },
                ],
            }),
        },
        {
            cmd: 502,
            encrypt: 2,
            body: ok({
                delivereds: [{ msgId: "5000000000000000001", seen: 0, deliveredUids: [PEER], seenUids: [], mSTs: "1" }],
                seens: [{ idTo: PEER, msgId: "5000000000000000001", realMsgId: "0" }],
            }),
        },
        {
            cmd: 522,
            encrypt: 2,
            body: ok({
                delivereds: [
                    { msgId: "5000000000000000002", groupId: GROUP, seen: 0, deliveredUids: [PEER], seenUids: [] },
                ],
                groupSeens: [{ msgId: "5000000000000000002", groupId: GROUP, seenUids: [PEER, OWN] }],
            }),
        },
    ],
    // spec-listener 11: the old-message answers.
    "old-messages": [
        { cmd: 510, sub: 1, encrypt: 2, body: ok({ msgs: [dm(1), dm(2, { content: { deleteMsg: 1 } })], more: 0 }) },
        { cmd: 511, sub: 1, encrypt: 2, body: ok({ groupMsgs: [gm(3)], more: 0 }) },
    ],
    // spec-listener 3 (Big ids): a small integer under a listed key; spec-listener 3 (Frame top level).
    "ids-and-errors": [
        {
            cmd: 501,
            encrypt: 0,
            // JSON text as the server writes it: a small msgId (a listed key, unlisted cliMsgId beside it) and a quote
            // owner past 2^53, both bare integers.
            body:
                '{"error_code":0,"data":{"msgs":[{"msgId":5,"cliMsgId":6,"uidFrom":"0","idTo":' +
                `"${PEER}","ts":"1","msgType":"webchat","content":"small ids",` +
                `"quote":{"ownerId":${PEER2},"globalMsgId":"5000000000000000001","cliMsgId":7,"msg":"q"}}]}}`,
        },
        { cmd: 501, encrypt: 0, top: { error_code: 102 }, body: ok({ msgs: [dm(1)] }) },
    ],
};

/**
 * Sent frames as a golden entry keeps them: the bytes as the header in hex and the body as its text. Byte for byte
 * the same claim, but the hex of a JSON body is one long digit run that tests/unit/no-real-ids.test.js would read as
 * an id.
 *
 * @param {Array<{bytes: string|null}>} frames - normalized frames (tests/helpers/wire-diff/normalize.js)
 * @returns {object[]}
 */
function goldenSent(frames) {
    return frames.map(({ bytes, ...rest }) => {
        if (typeof bytes !== "string") return { ...rest, bytes };
        const raw = Buffer.from(bytes, "hex");
        return { ...rest, head: raw.subarray(0, 4).toString("hex"), body: raw.subarray(4).toString("utf8") };
    });
}

describe("listener: zca-js against ours, one script per spec-listener item", () => {
    let lp;
    const played = {};
    const sent = {};

    before(async () => {
        lp = await openListenerPair();
        await lp.start();
        // Both clients send the official pulls the same way.
        lp.zca.listener.requestOldMessages(0, null);
        lp.own.listener.requestOldMessages(0, null);
        await lp.settle();
        sent.pull = lp.snapshot();
        for (const [name, script] of Object.entries(SCRIPTS)) {
            const before = lp.snapshot();
            const after = await lp.play(script);
            played[name] = {
                zca: after.zca.slice(before.zca.length),
                own: after.own.slice(before.own.length),
                zcaSent: after.zcaSent.slice(before.zcaSent.length),
                ownSent: after.ownSent.slice(before.ownSent.length),
                headers: after.headers,
            };
        }
    });

    after(async () => {
        await lp?.close();
    });

    it("upgrades and handshakes as declared, and sends the same pull", async () => {
        const rec = { ...sent.pull, zca: sent.pull.zca, own: sent.pull.own };
        assertSameListener(rec, ALLOW.listener, { name: "handshake" });
        // The client version in the URL is masked: a protocol-version bump is not a listener change.
        const upgrade = { ...rec.headers.own, url: rec.headers.own.url.replace(/zpw_ver=\d+/, "zpw_ver=<ver>") };
        await expectGolden("listener", "handshake", {
            requests: [],
            result: { events: rec.own, sent: goldenSent(rec.ownSent), upgrade },
        });
    });

    for (const name of Object.keys(SCRIPTS)) {
        it(`${name}: the same events and frames, apart from the declared differences`, async () => {
            const p = played[name];
            // Red if a script played nothing at all (a frame not delivered would make both sides empty and equal).
            assert.ok(p.zca.length + p.own.length > 0, `${name}: no events on either side`);
            // The upgrade is compared once, in the handshake case.
            assertSameListener({ ...p, headers: { zca: null, own: null } }, ALLOW.listener, { name });
            await expectGolden("listener", name, {
                requests: [],
                result: { events: p.own, sent: goldenSent(p.ownSent) },
            });
        });
    }
});
