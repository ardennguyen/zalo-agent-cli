/**
 * The MCP naming contract: one concept, one name, in every tool input and every reply.
 *
 * The vocabulary is in docs/agent-notes.md ("MCP naming vocabulary"). It exists because a Gemini-driven bot called
 * `zalo_react` with the wrong field names and `threadType`: the live buffer called a message's id `id`, history
 * called it `msgId`, a send reply `messageId`, `zalo_view_media` took `messageId` and `zalo_delete_message` took
 * `uidFrom` for what every message calls `senderId`. A model copies a name from one reply into the next call; when
 * the names differ it fails, and a weaker model cannot work out why.
 *
 * Adding a tool or a field that carries an id: pick the name from the table, or add the new name to ALLOWED here
 * and to the table in the notes, on purpose. Rename only in a major version; in a patch, add the canonical name
 * beside the old one in replies (never remove one), as `id`/`messageId`/`uid` were kept.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { normalizeMessage } from "../../src/commands/mcp.js";
import { tool } from "./support/mcp-send-harness.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

/** Every id-like input name a tool may take, and what it is. */
const ALLOWED = {
    threadId: "a conversation: a user id (DM) or a group id",
    threadIds: "several conversations",
    groupId: "a group's id (the threadId of a group), for tools that only work on groups",
    msgId: "one message",
    quoteMsgId: "the message being quoted",
    lastMsgId: "a server-side history cursor (a msgId)",
    cliMsgId: "the sender's own id for a message",
    userId: "a Zalo user",
    userIds: "several Zalo users",
    cardUserId: "the user whose contact card is shared",
    senderId: "a message's author (a userId)",
    noteId: "a group note",
    pollId: "a poll",
    optionIds: "poll options",
    reminderId: "a reminder",
    labelId: "a label",
    jobId: "a sync job",
    requestId: "a sync request key",
};

/** Names that mean one of the above under another spelling; an input must never use them. */
const BANNED = ["messageId", "uidFrom", "uid", "id", "chatId", "conversationId", "convId", "user_id", "thread_id"];

const { tools } = tool();
const inputs = (meta) =>
    Object.keys(z.toJSONSchema(meta.inputSchema, { io: "input", unrepresentable: "any" }).properties ?? {});

describe("tool inputs", () => {
    it("never use a banned synonym for an id", () => {
        const bad = [];
        for (const [name, { meta }] of tools) {
            for (const f of inputs(meta)) if (BANNED.includes(f)) bad.push(`${name}.${f}`);
        }
        assert.deepEqual(bad, [], "use the name from the vocabulary in docs/agent-notes.md");
    });

    it("name every id-like input from the vocabulary", () => {
        const unknown = [];
        for (const [name, { meta }] of tools) {
            for (const f of inputs(meta)) {
                if (/(Id|Ids)$/.test(f) && !(f in ALLOWED)) unknown.push(`${name}.${f}`);
            }
        }
        assert.deepEqual(
            unknown,
            [],
            "a new id name needs a row in the vocabulary (ALLOWED here, the table in the notes)",
        );
    });

    it("take a message id as msgId in every tool that takes one", () => {
        for (const name of [
            "zalo_react",
            "zalo_undo",
            "zalo_view_media",
            "zalo_forward_message",
            "zalo_delete_message",
        ]) {
            assert.ok(inputs(tools.get(name).meta).includes("msgId"), `${name} takes msgId`);
        }
    });

    it("name an author's user id senderId, as a message and the search filter do", () => {
        assert.ok(inputs(tools.get("zalo_delete_message").meta).includes("senderId"));
        assert.ok(inputs(tools.get("zalo_search_messages").meta).includes("senderId"));
    });
});

describe("replies", () => {
    it("a live message carries its id as msgId, and as id for the clients that read it", () => {
        const n = normalizeMessage({
            threadId: "t1",
            type: 0,
            data: { msgId: "m1", uidFrom: "u2", ts: "1", content: "hi", msgType: "webchat" },
        });
        assert.equal(n.msgId, "m1");
        assert.equal(n.id, "m1");
        assert.equal(n.senderId, "u2", "the author is senderId");
    });

    it("a send reply carries the id as msgId, and as messageId for the clients that read it", async () => {
        const { call } = tool();
        const { body } = await call({ threadId: "g1", text: "hi", format: "plain" });
        assert.equal(body.msgId, "m1");
        assert.equal(body.messageId, body.msgId);
        assert.equal(body.cliMsgId, "c1");
    });

    it("each part of a split send names its id the same way", async () => {
        const { call } = tool();
        const { body } = await call({ threadId: "g1", text: "word ".repeat(1500), format: "plain" });
        assert.ok(body.parts.length >= 2);
        for (const p of body.parts) {
            assert.ok(p.msgId);
            assert.equal(p.messageId, p.msgId);
        }
    });
});
