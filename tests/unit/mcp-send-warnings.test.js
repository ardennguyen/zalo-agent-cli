/**
 * `zalo_send_message` tells the agent when its text has a backslash and an n where a line break was meant, and
 * never changes the text.
 *
 * A model that double-escapes its arguments sends `Hello\n\nWorld` as a backslash and an n, and Zalo shows them as
 * typed (seen on a phone: a reply with the characters between two paragraphs). Turning them into line breaks would
 * corrupt a code sample or a Windows path, so the text goes out exactly as written and the reply carries a warning
 * the agent can read.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { hasLiteralNewline, LITERAL_NEWLINE_WARNING } from "../../src/utils/literal-newline.js";
import { tool } from "./support/mcp-send-harness.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

// String.raw keeps the backslash and the n as two characters, which is the whole point of these tests.
const SLASH_N = String.raw`Dạ em vẫn khỏe 😂\n\nNãy thấy mấy tin test`;

describe("hasLiteralNewline", () => {
    it("is true for a backslash-n and no real line break", () => {
        assert.equal(hasLiteralNewline(SLASH_N), true);
        assert.equal(hasLiteralNewline(String.raw`one line with \n in it`), true);
    });

    it("is false for real line breaks, with or without a backslash-n in them", () => {
        assert.equal(hasLiteralNewline("a\n\nb"), false);
        assert.equal(hasLiteralNewline("a\r\nb"), false);
        assert.equal(
            hasLiteralNewline(String.raw`printf("a\n");` + "\nnext line"),
            false,
            "a code sample keeps its backslash-n",
        );
    });

    it("is false for text with no backslash-n, a lone backslash, and a non-string", () => {
        assert.equal(hasLiteralNewline("plain text"), false);
        assert.equal(hasLiteralNewline(String.raw`C:\folder\file`), false);
        assert.equal(hasLiteralNewline(undefined), false);
    });
});

describe("zalo_send_message with a backslash-n in the text", () => {
    it("sends the text exactly as written and warns in the reply", async () => {
        const { sent, call } = tool();
        const { body } = await call({ threadId: "g1", text: SLASH_N, format: "plain" });
        // Red if the text is rewritten (the sent string would then hold real newlines) or the warning is missing.
        assert.equal(sent.length, 1);
        assert.equal(sent[0].content, SLASH_N, "not a character changed");
        assert.ok(!sent[0].content.includes("\n"));
        assert.deepEqual(body.warnings, [LITERAL_NEWLINE_WARNING]);
        assert.equal(body.success, true);
    });

    it("names the way out: real newlines, and recalling the message with the ids in the reply", () => {
        assert.match(LITERAL_NEWLINE_WARNING, /real newlines/);
        assert.match(LITERAL_NEWLINE_WARNING, /zalo_undo/);
        assert.match(LITERAL_NEWLINE_WARNING, /msgId and cliMsgId/);
    });

    it("does not warn about a text with real line breaks", async () => {
        const { call } = tool();
        const { body } = await call({
            threadId: "g1",
            text: "Dạ em vẫn khỏe 😂\n\nNãy thấy mấy tin test",
            format: "plain",
        });
        assert.equal(body.warnings, undefined);
    });

    it("warns under Markdown too, and the Markdown is still converted", async () => {
        const { sent, call } = tool();
        const { body } = await call({ threadId: "g1", text: String.raw`**Xong** rồi\n\nTiếp theo` });
        assert.deepEqual(body.warnings, [LITERAL_NEWLINE_WARNING]);
        assert.equal(sent[0].content.msg, String.raw`Xong rồi\n\nTiếp theo`);
    });
});
