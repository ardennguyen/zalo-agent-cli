/**
 * A recall reaches the agent (bug-reports #3, 2026-10-20).
 *
 * The `undo` handler in `mcp start` updated the cache and stopped: nothing was pushed to the buffer, so a waiter on
 * zalo_wait_for_message never woke for a recall and zalo_get_messages never listed one. An agent that had read a
 * message could not learn it was gone. The recall is now normalized like a message (`type: "undo"`, `msgId` = the
 * recalled message) and buffered, with its own webhook event name.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { normalizeUndo, normalizeMessage, buildMCPWebhookPayload } from "../../src/commands/mcp.js";
import { MessageBuffer } from "../../src/mcp/message-buffer.js";
import { createSession } from "../../src/zalo/kernel/session.js";
import { loadJar } from "../../src/zalo/kernel/cookies.js";
import { createListener } from "../../src/zalo/listener/listener.js";
import { API_TYPE, DEFAULT_API_VERSION } from "../../src/zalo/profile.js";
import { startFakeSocket } from "../helpers/fake-zalo/socket.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

// The shape the listener emits: the target is inside content, the event's own msgId is the notification.
const undoEvent = (content = {}, over = {}) => ({
    threadId: "t1",
    type: 1,
    isSelf: false,
    data: {
        msgId: "999999",
        cliMsgId: "888888",
        msgType: "chat.undo",
        uidFrom: "u9",
        dName: "Nine",
        ts: 1_750_000_009_000,
        // Ids past MAX_SAFE_INTEGER are strings on the wire; a number literal here would round.
        content: { globalMsgId: "1000000000000000001", cliMsgId: 2, deleteMsg: 3, srcId: 4, destId: 5, ...content },
    },
    ...over,
});

describe("normalizeUndo", () => {
    it("names the RECALLED message as msgId, not the notification", () => {
        const e = normalizeUndo(undoEvent());
        assert.equal(e.msgId, "1000000000000000001");
        assert.notEqual(e.msgId, "999999");
        assert.equal(e.cliMsgId, "2");
        assert.equal(e.type, "undo");
        assert.equal(e.text, "");
        assert.equal(e.attachment, null);
    });

    it("carries the same fields as a message, with the same words", () => {
        const msg = normalizeMessage({
            threadId: "t1",
            type: 1,
            data: { msgId: "m1", ts: "1", content: "hi", msgType: "webchat", uidFrom: "u9", dName: "Nine" },
        });
        const undo = normalizeUndo(undoEvent());
        // A message carries its own cliMsgId too since 3.0.0 (a phone reply names what it quotes by it).
        assert.deepEqual(Object.keys(undo).sort(), Object.keys(msg).sort());
        assert.equal(undo.threadId, "t1");
        assert.equal(undo.threadType, "group");
        assert.equal(undo.senderId, "u9");
        assert.equal(undo.senderName, "Nine");
        assert.equal(undo.timestamp, 1_750_000_009_000);
        assert.equal(normalizeUndo(undoEvent({}, { type: 0 })).threadType, "dm");
    });

    it("keeps only the client id when Zalo sends globalMsgId 0, as it does for a fresh message", () => {
        const e = normalizeUndo(undoEvent({ globalMsgId: 0, cliMsgId: 4242 }));
        assert.equal(e.msgId, null);
        assert.equal(e.cliMsgId, "4242");
    });

    it("returns null for a recall that names no message at all", () => {
        assert.equal(normalizeUndo(undoEvent({ globalMsgId: 0, cliMsgId: 0 })), null);
        assert.equal(normalizeUndo({ threadId: "t1", type: 0, data: {} }), null);
    });
});

describe("a recall off the socket (design 6.2: the real Undo, not a hand-built one)", () => {
    it("a DM recall from a sealed 501 frame normalizes as threadType dm, with the recalled id kept whole", async () => {
        // The frame as the server sends it: JSON text with bare integer ids (globalMsgId past 2^53), sealed as
        // encrypt 2 under the session key, through the listener the engine builds. The tests above build the event
        // by hand WITH a `type`; the previous engine's Undo had none, so every live DM recall came out as "group". Red if the
        // listener's Undo loses its type (threadType "group"), or if the id is parsed lossily (msgId rounded).
        const OWN = "1000000000000000009";
        const PEER = "2000000000000000002";
        const text =
            '{"error_code":0,"error_message":"","data":{"msgs":[{"actionId":"7000000000000000007",' +
            '"msgId":"5000000000000000005","cliMsgId":"1750000009001","msgType":"chat.undo",' +
            `"uidFrom":"${PEER}","idTo":"0","dName":"Fake Peer","ts":"1750000009000","status":1,` +
            '"content":{"globalMsgId":1000000000000000001,"cliMsgId":2,"deleteMsg":1,' +
            `"srcId":${PEER},"destId":${OWN}},"notify":"1","ttl":0,"uin":"0","cmd":501,"st":3,"at":5}]}}`;
        const sock = await startFakeSocket();
        const ctx = createSession({ apiType: API_TYPE, apiVersion: DEFAULT_API_VERSION, selfListen: true });
        ctx.cookie = loadJar([{ key: "zpw_sek", value: "fake-sek", domain: "chat.zalo.me", path: "/" }]);
        ctx.userAgent = "Mozilla/5.0 (offline test)";
        ctx.uid = OWN;
        ctx.settings = { features: { socket: { ping_interval: 60000 } } };
        const listener = createListener(ctx, [sock.url]);
        listener.on("error", () => {});
        try {
            const key = once(listener, "cipher_key");
            listener.start();
            await key;
            const got = once(listener, "undo");
            assert.ok(sock.pushEncrypted({ cmd: 501, encrypt: 2, body: text }));
            const [undo] = await got;
            const e = normalizeUndo(undo);
            assert.equal(undo.type, 0);
            assert.equal(e.threadType, "dm");
            assert.equal(e.threadId, PEER);
            assert.equal(e.msgId, "1000000000000000001");
            assert.equal(e.cliMsgId, "2");
            assert.equal(e.senderId, PEER);
        } finally {
            listener.stop();
            await sock.close();
        }
    });
});

describe("a recall in the buffer", () => {
    it("wakes a long-poll waiter and is read back in order with messages", async () => {
        const buffer = new MessageBuffer(10, 60_000);
        const woke = buffer.waitForMessage({ threadId: "t1", timeoutMs: 2000 });
        // Eviction is by the event's own timestamp, as for a message, so a recall from 2025 would be stale already.
        const fresh = { ...undoEvent(), data: { ...undoEvent().data, ts: Date.now() } };
        buffer.push("t1", normalizeUndo(fresh));
        const got = await woke;
        assert.ok(got, "the waiter woke for the recall");
        assert.equal(got.type, "undo");
        assert.equal(got.msgId, "1000000000000000001");
        // And it is listed in order with messages, with a cursor an agent can mark read.
        const { messages } = buffer.read("t1", 0, 10);
        assert.deepEqual(
            messages.map((m) => m.type),
            ["undo"],
        );
        assert.ok(Number.isFinite(messages[0]._cursor));
    });

    it("goes out on the webhook as event undo, while a message stays event message", () => {
        assert.equal(buildMCPWebhookPayload(normalizeUndo(undoEvent()), { accountId: "a" }).event, "undo");
        const msg = normalizeMessage({
            threadId: "t1",
            type: 0,
            data: { msgId: "m1", ts: "1", content: "hi", msgType: "webchat" },
        });
        assert.equal(buildMCPWebhookPayload(msg).event, "message");
    });
});

describe("the mcp start undo handler", () => {
    // A structural guard, not a behavioral one: the handler lives inside the command's closure, so the behavior
    // above is tested on the parts and this test keeps the wiring from being removed again.
    it("pushes the recall to the buffer, after the cache write and never for the owner's own recall", () => {
        const src = readFileSync(resolve(import.meta.dirname, "../../src/commands/mcp.js"), "utf8");
        const start = src.indexOf('api.listener.on("undo"');
        assert.ok(start > 0, "the undo handler exists");
        const body = src.slice(start, src.indexOf("});", start));
        const order = ["storeLiveUndo(", "isSelf", "normalizeUndo(", "shouldWatch(", "buffer.push("];
        let at = -1;
        for (const step of order) {
            const i = body.indexOf(step, at + 1);
            assert.ok(i > at, `${step} comes after the previous step in the undo handler`);
            at = i;
        }
    });
});
