/**
 * `normalizeMessage` — the shape an MCP client actually sees.
 *
 * The MCP server used to classify messages by hand: `type` came out as Zalo's
 * raw `chat.photo`, which matched nothing else in the tool (its own media gate
 * tested for "image"/"video", so auto-download never fired), and `timestamp`
 * was the moment of processing rather than the message's own — which made
 * age-based buffer eviction meaningless. It now shares
 * `classifyLiveMessage` with the listener and the mobile sync, so one
 * vocabulary covers every path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeMessage } from "../../src/commands/mcp.js";

const ev = (data, over = {}) => ({
    threadId: "t1",
    type: 0,
    isSelf: false,
    data: { msgId: "m1", uidFrom: "u2", dName: "Chi Lan", ts: "1750000000000", ...data },
    ...over,
});

describe("normalizeMessage", () => {
    it("uses the shared type vocabulary, not zca-js's raw msgType", () => {
        const n = normalizeMessage(
            ev({ msgType: "chat.photo", content: { href: "https://photo-stal-3.zdn.vn/a.jpg" } }),
        );
        assert.equal(n.type, "photo", "`chat.photo` never matched anything downstream");
    });

    it("keeps the message's own timestamp, so buffer ageing is real", () => {
        const n = normalizeMessage(ev({ msgType: "webchat", content: "hi" }));
        assert.equal(n.timestamp, 1750000000000);
    });

    it("exposes a media attachment an agent can act on", () => {
        const n = normalizeMessage(
            ev({
                msgType: "chat.photo",
                content: { href: "https://photo-stal-3.zdn.vn/a.jpg", title: "a.jpg" },
            }),
        );
        assert.equal(n.attachment.url, "https://photo-stal-3.zdn.vn/a.jpg");
        assert.equal(n.attachment.description, "a.jpg");
        assert.equal(n.attachment.type, "photo");
    });

    it("leaves attachment null for plain text", () => {
        const n = normalizeMessage(ev({ msgType: "webchat", content: "xin chao" }));
        assert.equal(n.attachment, null);
        assert.equal(n.text, "xin chao");
        assert.equal(n.type, "text");
    });

    it("extracts readable text from a non-text payload", () => {
        const n = normalizeMessage(
            ev({ msgType: "chat.recommended", content: { title: "News", href: "https://example.com/x" } }),
        );
        assert.ok(n.text.includes("News"), "an agent reads this, so it cannot be [object Object]");
    });

    it("labels a group thread as a group", () => {
        const n = normalizeMessage(ev({ msgType: "webchat", content: "hi" }, { type: 1, threadId: "g1" }));
        assert.equal(n.threadType, "group");
        assert.equal(n.threadId, "g1");
    });

    it("reuses a classification the caller already computed", () => {
        // The message handler classifies once, for the write, and passes it in;
        // re-deriving it per message would parse the same payload twice.
        const n = normalizeMessage(ev({ msgType: "webchat", content: "hi" }), {
            type: "text",
            text: "from the caller",
            attachments: [],
            hasAttachment: false,
        });
        assert.equal(n.text, "from the caller");
    });

    it("survives a message with no content at all", () => {
        const n = normalizeMessage(ev({ msgType: undefined, content: null }));
        assert.equal(n.attachment, null);
        assert.ok(n.text, "a blank text is still a string, never undefined");
    });
});
