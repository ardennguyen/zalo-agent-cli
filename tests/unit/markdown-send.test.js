/**
 * Markdown through the senders: what `zalo_send_message` hands to zca-js, and the format setting.
 *
 * Zalo showed `**bold**` and `- item` exactly as typed, because a message is plain text plus style ranges and
 * the MCP tool sent plain text. An agent writes Markdown, so the tool now converts it by default.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import Database from "better-sqlite3";
import { initDb } from "../../src/core/db.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { resolveSendFormat } from "../../src/utils/markdown.js";
import { runCli, stripAnsi } from "../helpers/cli.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    // A cache with one contact, so an @[uid] token expands to a name LONGER than the token.
    const dbPath = join(SANDBOX_CONFIG_DIR, "markdown-send.db");
    initDb(dbPath);
    const direct = new Database(dbPath);
    direct.prepare("INSERT INTO contacts (userId, name, phone) VALUES ('123', 'Trần Bích Ngọc', '')").run();
    direct.close();
});

let savedFormat;
beforeEach(() => {
    savedFormat = process.env.ZALO_SEND_FORMAT;
    delete process.env.ZALO_SEND_FORMAT;
});
afterEach(() => {
    if (savedFormat === undefined) delete process.env.ZALO_SEND_FORMAT;
    else process.env.ZALO_SEND_FORMAT = savedFormat;
});

/** Register the real tools against a fake api that records every send. */
function tool(names = {}) {
    const sent = [];
    const tools = new Map();
    const server = { registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
    const api = {
        sendMessage: async (content, threadId, type) => {
            sent.push({ content, threadId, type });
            return { message: { msgId: "m1", cliMsgId: "c1" } };
        },
    };
    registerTools(
        server,
        api,
        {
            read: () => ({ messages: [], cursor: 0 }),
            getStats: () => [],
            getThreadType: () => "dm",
            markRead: () => 0,
            readCursor: () => 0,
        },
        { isWatched: () => true },
        { limits: { maxMessagesPerPoll: 20 } },
        { ready: true, get: (id) => (names[id] ? { name: names[id], type: "user" } : null), search: () => [] },
        undefined,
    );
    const call = async (args) =>
        JSON.parse((await tools.get("zalo_send_message").handler({ threadType: 1, ...args })).content[0].text);
    return { sent, call, tools };
}

describe("zalo_send_message", () => {
    it("converts Markdown to text plus Zalo style ranges, by default", async () => {
        const { sent, call } = tool();
        const r = await call({ threadId: "g1", text: "**Tóm tắt**\n\n- Đã xử lý *3* đơn\n- Còn 2 đơn" });
        assert.equal(r.success, true);
        assert.equal(sent.length, 1);
        const { content } = sent[0];
        assert.equal(content.msg, "Tóm tắt\n\nĐã xử lý 3 đơn\nCòn 2 đơn");
        assert.deepEqual(
            content.styles.map((s) => [s.st, content.msg.slice(s.start, s.start + s.len)]),
            [
                ["b", "Tóm tắt"],
                ["i", "3"],
                ["lst_1", "Đã xử lý 3 đơn"],
                ["lst_1", "Còn 2 đơn"],
            ],
        );
        assert.equal(r.formatted, 4, "the reply says how many ranges it sent");
        assert.equal(r.text, content.msg, "and what text went out, since it differs from what was written");
    });

    it("text that is not Markdown is sent as the plain string it always was, with no extras in the reply", async () => {
        const { sent, call } = tool();
        const r = await call({ threadId: "g1", text: "Chào bạn, 2 * 3 * 4 = 24 và snake_case_ok" });
        assert.equal(sent[0].content, "Chào bạn, 2 * 3 * 4 = 24 và snake_case_ok");
        assert.equal(r.formatted, undefined);
        assert.equal(r.text, undefined);
    });

    it("format: plain sends Markdown exactly as written", async () => {
        const { sent, call } = tool();
        const r = await call({ threadId: "g1", text: "**not bold** - not a bullet", format: "plain" });
        assert.equal(sent[0].content, "**not bold** - not a bullet");
        assert.equal(r.formatted, undefined);
    });

    it("ZALO_SEND_FORMAT=plain changes the default, and an explicit format still wins", async () => {
        process.env.ZALO_SEND_FORMAT = "plain";
        const { sent, call } = tool();
        await call({ threadId: "g1", text: "**a**" });
        assert.equal(sent[0].content, "**a**");
        await call({ threadId: "g1", text: "**a**", format: "markdown" });
        assert.equal(sent[1].content.msg, "a");
    });

    it("styles follow the text across @[uid] mentions, and the mention offsets are right", async () => {
        const { sent, call } = tool({ 123: "Trần Bích Ngọc" });
        await call({ threadId: "g1", text: "**Chào @[123]** nhé\n- việc của @[123]" });
        const { content } = sent[0];
        assert.equal(content.msg, "Chào @Trần Bích Ngọc nhé\nviệc của @Trần Bích Ngọc");
        const bold = content.styles.find((s) => s.st === "b");
        assert.equal(content.msg.slice(bold.start, bold.start + bold.len), "Chào @Trần Bích Ngọc");
        const list = content.styles.find((s) => s.st === "lst_1");
        assert.equal(content.msg.slice(list.start, list.start + list.len), "việc của @Trần Bích Ngọc");
        assert.equal(content.mentions.length, 2);
        for (const m of content.mentions) assert.equal(content.msg.slice(m.pos, m.pos + m.len), "@Trần Bích Ngọc");
    });

    it("Markdown in a file's caption is converted too", async () => {
        const dir = mkdtempSync(join(tmpdir(), "zalo-md-"));
        try {
            const file = join(dir, "a.txt");
            writeFileSync(file, "x");
            const { sent, call } = tool();
            await call({ threadId: "g1", text: "**Report** attached", filePath: file });
            assert.equal(sent[0].content.msg, "Report attached");
            assert.deepEqual(sent[0].content.styles, [{ start: 0, len: 6, st: "b" }]);
            assert.deepEqual(sent[0].content.attachments, [file]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a quote-reply keeps working alongside styles (the content is one object)", async () => {
        const { sent, call } = tool();
        await call({ threadId: "g1", text: "- point", urgency: "important" });
        const { content } = sent[0];
        assert.equal(content.msg, "point");
        assert.equal(content.styles[0].st, "lst_1");
        assert.ok(content.urgency);
    });

    it("declares format, and refuses a value that is not one", () => {
        const { tools } = tool();
        const schema = tools.get("zalo_send_message").meta.inputSchema;
        assert.equal(schema.safeParse({ threadId: "g", text: "x", format: "markdown" }).success, true);
        assert.equal(schema.safeParse({ threadId: "g", text: "x", format: "plain" }).success, true);
        assert.equal(schema.safeParse({ threadId: "g", text: "x", format: "html" }).success, false);
        assert.match(tools.get("zalo_send_message").meta.inputSchema.shape.format.description, /markdown.*default/i);
    });
});

describe("resolveSendFormat", () => {
    it("an explicit choice beats the environment, which beats the surface's own default", () => {
        assert.equal(
            resolveSendFormat({ explicit: "plain", fallback: "markdown", env: { ZALO_SEND_FORMAT: "markdown" } }),
            "plain",
        );
        assert.equal(resolveSendFormat({ fallback: "plain", env: { ZALO_SEND_FORMAT: "markdown" } }), "markdown");
        assert.equal(resolveSendFormat({ fallback: "markdown", env: { ZALO_SEND_FORMAT: " PLAIN " } }), "plain");
        assert.equal(resolveSendFormat({ fallback: "plain", env: {} }), "plain");
        assert.equal(resolveSendFormat({ fallback: "markdown", env: {} }), "markdown");
    });

    it("an unusable value is ignored, not obeyed", () => {
        assert.equal(
            resolveSendFormat({ explicit: "html", fallback: "markdown", env: { ZALO_SEND_FORMAT: "rich" } }),
            "markdown",
        );
    });
});

describe("msg send --markdown", () => {
    it("is documented, with ZALO_SEND_FORMAT", async () => {
        const r = await runCli(["msg", "send", "--help"], { timeout: 60_000 });
        const text = stripAnsi(r.all);
        assert.match(text, /--markdown/);
        assert.match(text, /ZALO_SEND_FORMAT=markdown/);
        assert.match(text, /--md /, "the older --md is still there");
    });
});
