/**
 * A reply says what it replies to (bug-reports #8, 2026-11-03).
 *
 * A group message sent as a reply to a photo reached the agent with `replyTo: null` from zalo_wait_for_message, and
 * zalo_get_history showed no quote either, even after a full sync: `normalizeMessage` hard-coded `replyTo: null`
 * and the cache reader never looked at the quote both writers already keep in `raw_data`. The agent could not tell
 * what "look at this" pointed at.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { normalizeMessage } from "../../src/commands/mcp.js";
import { quotedReply, cachedReplyTo } from "../../src/core/cached-message.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

// The quote zca-js puts on a live message (TQuote).
const quote = (over = {}) => ({
    ownerId: "1000000000000000002",
    cliMsgId: 1750000000123,
    globalMsgId: 7300000000001,
    cliMsgType: 1,
    ts: 1_750_000_000_000,
    msg: "the original words",
    attach: "",
    fromD: "Chi Lan",
    ttl: 0,
    ...over,
});

const liveEvent = (data = {}) => ({
    threadId: "g1",
    type: 1,
    isSelf: false,
    data: { msgId: "7300000000009", uidFrom: "1000000000000000003", dName: "Ba", ts: 1_750_000_100_000, ...data },
});

describe("quotedReply", () => {
    it("names the quoted message, its author and its words", () => {
        assert.deepEqual(quotedReply(quote()), {
            msgId: "7300000000001",
            cliMsgId: "1750000000123",
            senderId: "1000000000000000002",
            senderName: "Chi Lan",
            text: "the original words",
            timestamp: 1_750_000_000_000,
            hasAttachment: false,
        });
    });

    it("says a quoted photo has an attachment", () => {
        const r = quotedReply(quote({ msg: "", attach: '{"href":"https://example.invalid/p.jpg"}' }));
        assert.equal(r.hasAttachment, true);
        assert.equal(r.text, "");
    });

    it("leaves out an author id that is not a user id (a synced row's noised id)", () => {
        assert.equal(quotedReply(quote({ ownerId: "n01se" })).senderId, null);
    });

    it("is null when there is no quote, or the quote names no message", () => {
        assert.equal(quotedReply(undefined), null);
        assert.equal(quotedReply(quote({ globalMsgId: 0, cliMsgId: 0 })), null);
    });
});

describe("live events carry the quote", () => {
    it("a reply's replyTo is the quoted message", () => {
        const m = normalizeMessage(liveEvent({ content: "look at this", quote: quote() }));
        assert.equal(m.replyTo?.msgId, "7300000000001");
        assert.equal(m.replyTo?.text, "the original words");
    });

    it("a message that quotes nothing has replyTo null", () => {
        assert.equal(normalizeMessage(liveEvent({ content: "hello" })).replyTo, null);
    });
});

describe("cached rows carry the quote", () => {
    it("from the payload the listener stored", () => {
        const row = { raw_data: JSON.stringify({ src: "listen", content: "look at this", quote: quote() }) };
        assert.equal(cachedReplyTo(row)?.msgId, "7300000000001");
    });

    it("from the payload a restore stored (nested under data, noised author)", () => {
        const row = { raw_data: JSON.stringify({ data: { src: "sync-v2", quote: quote({ ownerId: "n01se" }) } }) };
        const r = cachedReplyTo(row);
        assert.equal(r?.msgId, "7300000000001");
        assert.equal(r?.senderId, null);
    });

    it("null for a row without one, or with a bare-string payload", () => {
        assert.equal(cachedReplyTo({ raw_data: JSON.stringify({ content: "x" }) }), null);
        assert.equal(cachedReplyTo({ raw_data: "hi" }), null);
    });
});
