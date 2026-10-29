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
// sandbox.js FIRST: it redirects HOME/USERPROFILE before
// credentials.js freezes CONFIG_DIR at module-eval time. This file
// reaches that module transitively, so without the redirect it binds
// to the real ~/.zalo-agent-cli/. Enforced by
// tests/cli/sandbox-discipline.test.js.
import "../helpers/sandbox.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeMessage, postMCPWebhook } from "../../src/commands/mcp.js";
import { MessageBuffer } from "../../src/mcp/message-buffer.js";
import { createHTTPServer } from "../../src/mcp/mcp-http-transport.js";

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

describe("postMCPWebhook", () => {
    it("is a no-op when webhookUrl is null or empty", async () => {
        let called = false;
        const ok = await postMCPWebhook(null, { msgId: "m1", text: "hi" }, { accountId: "101" }, async () => {
            called = true;
        });
        assert.equal(ok, false);
        assert.equal(called, false);
    });

    it("POSTs the normalized message with event and accountId", async () => {
        let captured = null;
        const msg = normalizeMessage(ev({ msgType: "webchat", content: "hello webhook" }));
        const ok = await postMCPWebhook("http://127.0.0.1:4999/hook", msg, { accountId: "101" }, async (url, opts) => {
            captured = { url, method: opts.method, body: JSON.parse(opts.body) };
            return { ok: true };
        });
        assert.equal(ok, true);
        assert.equal(captured.url, "http://127.0.0.1:4999/hook");
        assert.equal(captured.method, "POST");
        assert.equal(captured.body.event, "message");
        assert.equal(captured.body.accountId, "101");
        assert.equal(captured.body.text, "hello webhook");
        assert.equal(captured.body.threadId, "t1");
    });

    it("swallows fetch failures without throwing into the listener", async () => {
        const ok = await postMCPWebhook("http://127.0.0.1:4999/hook", { msgId: "m1" }, {}, async () => {
            throw new Error("connection refused");
        });
        assert.equal(ok, false);
    });

    it("attaches Authorization Bearer and X-Zalo-Signature HMAC-SHA256 when webhookSecret is provided", async () => {
        let capturedHeaders = null;
        const ok = await postMCPWebhook(
            "http://127.0.0.1:4999/hook",
            { msgId: "m1", text: "signed crm event" },
            { accountId: "101" },
            async (_url, opts) => {
                capturedHeaders = opts.headers;
                return { ok: true };
            },
            "crm-webhook-s3cret",
        );
        assert.equal(ok, true);
        assert.equal(capturedHeaders["Authorization"], "Bearer crm-webhook-s3cret");
        assert.match(capturedHeaders["X-Zalo-Signature"], /^sha256=[0-9a-f]{64}$/);
    });
});

describe("MessageBuffer.waitForMessage & GET /events/wait", () => {
    it("resolves immediately when a message after `since` is already buffered", async () => {
        const buf = new MessageBuffer();
        buf.push("t1", { msgId: "m1", threadId: "t1", text: "already here", timestamp: Date.now() });
        const got = await buf.waitForMessage({ since: 0, timeoutMs: 5000 });
        assert.equal(got.msgId, "m1");
        assert.equal(got._cursor, 1);
    });

    it("wakes a waiting caller as soon as push() arrives for the matching thread", async () => {
        const buf = new MessageBuffer();
        const waitPromise = buf.waitForMessage({ threadId: "t2", timeoutMs: 5000 });
        buf.push("t1", { msgId: "m1", threadId: "t1", text: "other thread", timestamp: Date.now() });
        buf.push("t2", { msgId: "m2", threadId: "t2", text: "target thread", timestamp: Date.now() });
        const got = await waitPromise;
        assert.equal(got.msgId, "m2");
        assert.equal(got.text, "target thread");
    });

    it("resolves null on timeout or abort and cleans up the waiter", async () => {
        const buf = new MessageBuffer();
        const timedOut = await buf.waitForMessage({ timeoutMs: 15 });
        assert.equal(timedOut, null);

        const ac = new AbortController();
        const abortedPromise = buf.waitForMessage({ timeoutMs: 5000, signal: ac.signal });
        ac.abort();
        assert.equal(await abortedPromise, null);
    });

    it("serves GET /events/wait with auth enforcement and instant wakeup on push", async () => {
        const buf = new MessageBuffer();
        const server = createHTTPServer(() => {}, { buffer: buf }, 0, "secret-token", "127.0.0.1");
        await new Promise((r) => server.once("listening", r));
        const { port } = server.address();
        try {
            // 1. Rejects unauthenticated requests when authToken is set
            const unauth = await fetch(`http://127.0.0.1:${port}/events/wait?timeout=1`);
            assert.equal(unauth.status, 401);

            // 2. Wakes up as soon as a message is pushed into the buffer
            const pendingFetch = fetch(`http://127.0.0.1:${port}/events/wait?timeout=5`, {
                headers: { Authorization: "Bearer secret-token" },
            });
            while (buf._waiters.size === 0) {
                await new Promise((r) => setTimeout(r, 10));
            }
            buf.push("t9", { msgId: "m9", threadId: "t9", text: "live push", timestamp: Date.now() });
            const res = await pendingFetch;
            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.status, "message");
            assert.equal(body.message.msgId, "m9");
            assert.equal(body.cursor, 1);
        } finally {
            server.close();
        }
    });
});
