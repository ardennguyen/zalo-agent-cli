/**
 * `zalo_send_message` of a text Zalo would refuse as one message: it goes out as several, the way Zalo Web sends it.
 *
 * Measured live (2026-10-29): plain text past 3000 UTF-16 units is refused with 114 ("Tham số không hợp lệ"), and a
 * styled message past roughly 3.1 KB of text plus style JSON with 112 ("Lỗi không xác định"). An agent's Markdown
 * answer is a styled message, and a Chinese character is three bytes, so those are the replies that failed.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { tool } from "./support/mcp-send-harness.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

const bytes = (s) => Buffer.byteLength(s, "utf8");
const textOf = (c) => (typeof c === "string" ? c : c.msg);
const stylesOf = (c) => (typeof c === "string" ? [] : (c.styles ?? []));
const costOf = (c) => bytes(textOf(c)) + (stylesOf(c).length ? bytes(JSON.stringify(stylesOf(c))) : 0);

describe("zalo_send_message of a long text", () => {
    it("a Markdown reply of 1200 Chinese characters (it failed with 112 as one message) goes out in parts that fit", async () => {
        const { sent, call } = tool();
        const text = `**重点**：${"这是一个用来检查切分的句子，请忽略它。".repeat(70)}`;
        const { body } = await call({ threadId: "g1", text });
        // Red if the text goes out whole: one send, 3600+ bytes with a style — what Zalo refuses.
        assert.ok(sent.length >= 2);
        for (const s of sent) assert.ok(costOf(s.content) <= 3000, `part costs ${costOf(s.content)}`);
        assert.equal(body.success, true);
        assert.equal(body.splitInto, sent.length);
        assert.deepEqual(
            body.parts.map((p) => p.msgId),
            sent.map((_, i) => `m${i + 1}`),
        );
        assert.equal(body.msgId, "m1", "msgId and cliMsgId are the first part's");
        assert.equal(body.cliMsgId, "c1");
        // Bold stays on the first part only, where the word is.
        assert.equal(stylesOf(sent[0].content)[0].st, "b");
        assert.equal(sent.slice(1).filter((s) => stylesOf(s.content).length > 0).length, 0);
    });

    it("plain text past 3000 characters (it failed with 114) goes out in parts, each as a plain string", async () => {
        const { sent, call } = tool();
        const text = "word ".repeat(1500);
        const { body } = await call({ threadId: "g1", text, format: "plain" });
        assert.ok(sent.length >= 3);
        for (const s of sent) {
            assert.equal(typeof s.content, "string");
            assert.ok(bytes(s.content) <= 3000);
        }
        assert.equal(body.splitInto, sent.length);
    });

    it("a text that fits is one send, and its reply has no split fields", async () => {
        const { sent, call } = tool();
        const { body } = await call({ threadId: "g1", text: "Chào bạn", format: "plain" });
        assert.equal(sent.length, 1);
        assert.equal(body.splitInto, undefined);
        assert.equal(body.parts, undefined);
    });

    it("urgency belongs to the first part only", async () => {
        const { sent, call } = tool();
        await call({ threadId: "g1", text: "word ".repeat(1500), format: "plain", urgency: "urgent" });
        assert.ok(sent.length >= 2);
        assert.deepEqual(sent[0].content.urgency, 2);
        for (const s of sent.slice(1))
            assert.equal(typeof s.content === "string" ? undefined : s.content.urgency, undefined);
    });

    it("a part Zalo refuses stops the rest and says how many had already gone out", async () => {
        const { sent, call } = tool({ failOn: 3 });
        const { isError, text } = await call({ threadId: "g1", text: "word ".repeat(3000), format: "plain" });
        assert.equal(sent.length, 3, "nothing is sent after the refusal");
        assert.equal(isError, true);
        assert.match(text, /part 3 of \d+ failed; the 2 earlier part\(s\) were already delivered/);
    });
});
