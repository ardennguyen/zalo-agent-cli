/**
 * `src/mcp/mcp-tools.js` — the MCP tool registration contract.
 *
 * This is the machine-checkable twin of the MCP tool list, the same way
 * `tests/cli/surface.test.js` is for the CLI surface. It exists because the
 * list has drifted before: the docs claimed 4 tools while the code
 * registered 7 (AGENTS.md §10). `zalo-mcp`, the sibling deployment wrapper,
 * exposes exactly whatever this module registers, so a silent addition or
 * rename here changes a published tool surface.
 *
 * `registerTools` only needs an object with `registerTool()`, so the whole
 * module is reachable offline with fakes — no session, no socket, no server.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { initDb, insertMessage, upsertThread } from "../../src/core/db.js";

/** The exact tool surface. Changing this list is a deliberate act — see AGENTS.md §10. */
const EXPECTED_TOOLS = [
    "zalo_get_messages",
    "zalo_send_message",
    "zalo_list_threads",
    "zalo_search_threads",
    "zalo_mark_read",
    "zalo_get_history",
    "zalo_view_media",
];

/** Records what registerTools() registers, standing in for McpServer. */
function fakeServer() {
    const tools = new Map();
    return {
        tools,
        registerTool(name, meta, handler) {
            if (tools.has(name)) throw new Error(`duplicate tool registration: ${name}`);
            tools.set(name, { meta, handler });
        },
        /** Invoke a registered handler with already-validated args. */
        call(name, args) {
            return tools.get(name).handler(args);
        },
    };
}

/** Minimal fakes for the collaborators registerTools() closes over. */
function deps(overrides = {}) {
    return {
        api: { sendMessage: async () => ({ message: { msgId: "m1" } }) },
        buffer: {
            read: () => ({ messages: [], cursor: 0 }),
            getStats: () => [],
            getThreadType: () => "dm",
            markRead: () => 0,
        },
        filter: { isWatched: () => true },
        config: { limits: { maxMessagesPerPoll: 20 } },
        nameCache: { ready: true, get: () => null, search: () => [] },
        accountDir: undefined,
        ...overrides,
    };
}

function register(overrides) {
    const server = fakeServer();
    const d = deps(overrides);
    registerTools(server, d.api, d.buffer, d.filter, d.config, d.nameCache, d.accountDir);
    return { server, ...d };
}

/** Parse the JSON payload back out of an MCP content envelope. */
function payloadOf(result) {
    return JSON.parse(result.content[0].text);
}

describe("MCP tool surface", () => {
    let server;
    beforeEach(() => ({ server } = register()));

    it(`registers exactly ${EXPECTED_TOOLS.length} tools`, () => {
        assert.equal(server.tools.size, EXPECTED_TOOLS.length);
    });

    it("registers exactly the documented tool names, and no others", () => {
        assert.deepEqual([...server.tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
    });

    for (const name of EXPECTED_TOOLS) {
        it(`${name} carries a title, a description and an input schema`, () => {
            const { meta } = server.tools.get(name);
            assert.ok(meta.title, "a client renders the title in its tool picker");
            assert.ok(meta.description?.length > 20, "the description is what an agent selects on");
            assert.ok(meta.inputSchema, "missing inputSchema means unvalidated agent input");
            assert.equal(typeof server.tools.get(name).handler, "function");
        });
    }

    it("every tool name is namespaced under zalo_", () => {
        for (const name of server.tools.keys()) assert.match(name, /^zalo_[a-z_]+$/);
    });
});

describe("MCP input schemas", () => {
    let server;
    beforeEach(() => ({ server } = register()));

    const schemaOf = (name) => server.tools.get(name).meta.inputSchema;

    it("zalo_send_message requires a non-empty text and a thread id", () => {
        const s = schemaOf("zalo_send_message");
        assert.throws(() => s.parse({ threadId: "t1", text: "" }));
        assert.throws(() => s.parse({ text: "hi" }));
        assert.equal(s.parse({ threadId: "t1", text: "hi" }).threadType, 0, "defaults to DM");
    });

    it("zalo_send_message rejects a threadType outside 0..1", () => {
        const s = schemaOf("zalo_send_message");
        assert.throws(() => s.parse({ threadId: "t1", text: "hi", threadType: 2 }));
        assert.equal(s.parse({ threadId: "t1", text: "hi", threadType: 1 }).threadType, 1);
    });

    it("zalo_get_messages applies the configured poll limit as its default", () => {
        const { server: s7 } = register({ config: { limits: { maxMessagesPerPoll: 7 } } });
        const parsed = s7.tools.get("zalo_get_messages").meta.inputSchema.parse({});
        assert.equal(parsed.limit, 7);
        assert.equal(parsed.since, 0);
    });

    it("zalo_get_messages caps limit at 100 so an agent cannot drain the buffer", () => {
        assert.throws(() => schemaOf("zalo_get_messages").parse({ limit: 101 }));
    });

    it("zalo_list_threads and zalo_search_threads share the same type enum", () => {
        for (const name of ["zalo_list_threads", "zalo_search_threads"]) {
            const extra = name === "zalo_search_threads" ? { query: "x" } : {};
            assert.equal(schemaOf(name).parse(extra).type, "all");
            assert.throws(() => schemaOf(name).parse({ ...extra, type: "channel" }));
        }
    });

    it("zalo_mark_read requires an explicit cursor — there is no implicit 'all'", () => {
        assert.throws(() => schemaOf("zalo_mark_read").parse({}));
        assert.throws(() => schemaOf("zalo_mark_read").parse({ cursor: -1 }));
        assert.equal(schemaOf("zalo_mark_read").parse({ cursor: 0 }).cursor, 0);
    });
});

describe("MCP handlers", () => {
    it("zalo_send_message returns {success, messageId} on the happy path", async () => {
        const { server } = register();
        const r = await server.call("zalo_send_message", { threadId: "t1", text: "hi", threadType: 0 });
        assert.equal(r.isError, undefined);
        assert.deepEqual(payloadOf(r), { success: true, messageId: "m1" });
    });

    it("zalo_send_message coerces threadType to a number before calling the API", async () => {
        let seen;
        const { server } = register({
            api: {
                sendMessage: async (_text, _tid, type) => {
                    seen = type;
                    return { msgId: "m2" };
                },
            },
        });
        await server.call("zalo_send_message", { threadId: "t1", text: "hi", threadType: "1" });
        assert.strictEqual(seen, 1, "a string threadType would silently address the wrong thread kind");
    });

    it("zalo_send_message reports an API failure as an MCP error, not a throw", async () => {
        const { server } = register({
            api: {
                sendMessage: async () => {
                    throw new Error("Đăng nhập thất bại");
                },
            },
        });
        const r = await server.call("zalo_send_message", { threadId: "t1", text: "hi", threadType: 0 });
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /Đăng nhập thất bại/);
    });

    it("zalo_list_threads filters by thread type", async () => {
        const stats = [
            { threadId: "g1", unread: 2 },
            { threadId: "d1", unread: 1 },
        ];
        const { server } = register({
            buffer: {
                getStats: () => stats,
                getThreadType: (id) => (id.startsWith("g") ? "group" : "dm"),
                read: () => ({}),
                markRead: () => 0,
            },
        });

        const all = payloadOf(await server.call("zalo_list_threads", { type: "all" }));
        assert.equal(all.total, 2);

        const groups = payloadOf(await server.call("zalo_list_threads", { type: "group" }));
        assert.equal(groups.total, 1);
        assert.equal(groups.threads[0].threadId, "g1");
    });

    it("zalo_list_threads enriches entries from the name cache when it has them", async () => {
        const { server } = register({
            buffer: {
                getStats: () => [{ threadId: "g1", unread: 0 }],
                getThreadType: () => "group",
                read: () => ({}),
                markRead: () => 0,
            },
            nameCache: { ready: true, get: () => ({ name: "Việc riêng - AI test", memberCount: 3 }), search: () => [] },
        });
        const { threads } = payloadOf(await server.call("zalo_list_threads", { type: "all" }));
        assert.equal(threads[0].name, "Việc riêng - AI test");
        assert.equal(threads[0].memberCount, 3);
    });

    it("zalo_search_threads refuses politely while the name cache is still warming", async () => {
        const { server } = register({ nameCache: { ready: false, get: () => null, search: () => [] } });
        const r = await server.call("zalo_search_threads", { query: "test", type: "all", limit: 10 });
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /not initialized/i);
    });

    it("zalo_search_threads passes query, type and limit straight through", async () => {
        let seen;
        const { server } = register({
            nameCache: {
                ready: true,
                get: () => null,
                search: (...args) => {
                    seen = args;
                    return [{ threadId: "g1", name: "hit" }];
                },
            },
        });
        const out = payloadOf(await server.call("zalo_search_threads", { query: "viec", type: "group", limit: 5 }));
        assert.deepEqual(seen, ["viec", "group", 5]);
        assert.equal(out.total, 1);
    });

    it("zalo_mark_read reports how many messages it discarded", async () => {
        const { server } = register({
            buffer: { markRead: (c) => c * 2, getStats: () => [], getThreadType: () => "dm", read: () => ({}) },
        });
        assert.deepEqual(payloadOf(await server.call("zalo_mark_read", { cursor: 3 })), {
            success: true,
            discarded: 6,
        });
    });

    it("a handler failure never escapes as a rejected promise", async () => {
        const { server } = register({
            buffer: {
                getStats: () => {
                    throw new Error("buffer exploded");
                },
                getThreadType: () => "dm",
                read: () => ({}),
                markRead: () => 0,
            },
        });
        const r = await server.call("zalo_list_threads", { type: "all" });
        assert.equal(r.isError, true, "a throw would take the whole MCP server down");
    });
});

/**
 * The cache-backed half of the tool surface.
 *
 * `zalo_get_history` used to ask Zalo over the socket, which current accounts
 * answer with an empty set, while the CLI read the same history straight out
 * of zalo.db. These lock in the cache-first behavior that closed that gap.
 */
describe("MCP tools read the local cache", () => {
    const ROOT = mkdtempSync(join(tmpdir(), "zalo-mcp-tools-"));
    const handles = [];
    let n = 0;

    beforeEach(() => {
        handles.push(initDb(join(ROOT, `db${n++}.sqlite`)));
    });

    after(() => {
        for (const h of handles) {
            try {
                h.close();
            } catch {
                /* already closed */
            }
        }
        try {
            rmSync(ROOT, { recursive: true, force: true });
        } catch {
            /* a lingering WAL handle is not worth failing the run over */
        }
    });

    const cache = (rows) => {
        upsertThread({ threadId: "t1", type: "dm", name: "Chi Lan", lastUpdate: 9 });
        for (const r of rows) {
            insertMessage({
                msgId: r.msgId,
                threadId: "t1",
                senderId: "u2",
                senderName: "Chi Lan",
                text: r.text ?? "hi",
                timestamp: r.ts,
                type: r.type ?? "text",
                raw_data: r.raw ?? "hi",
                has_attachment: r.attach ? 1 : 0,
                localPath: r.localPath,
            });
        }
    };

    /** An api whose history request answers immediately, so no test waits 10s. */
    const emptyServerApi = () => {
        let handler = null;
        return {
            listener: {
                on: (_e, h) => (handler = h),
                removeListener: () => {},
                requestOldMessages: () => handler?.([]),
            },
        };
    };

    it("zalo_get_history answers from the cache, oldest first", async () => {
        cache([
            { msgId: "m2", ts: 200, text: "second" },
            { msgId: "m1", ts: 100, text: "first" },
        ]);
        const { server } = register({ api: emptyServerApi() });
        const out = payloadOf(await server.call("zalo_get_history", { threadId: "t1", limit: 50 }));
        assert.equal(out.source, "cache");
        assert.deepEqual(
            out.messages.map((m) => m.text),
            ["first", "second"],
        );
        assert.equal(out.cursor, 100, "the oldest timestamp, to page further back");
    });

    it("zalo_get_history pages backwards with `before`", async () => {
        cache([
            { msgId: "m1", ts: 100 },
            { msgId: "m2", ts: 200 },
            { msgId: "m3", ts: 300 },
        ]);
        const { server } = register({ api: emptyServerApi() });
        const out = payloadOf(await server.call("zalo_get_history", { threadId: "t1", limit: 50, before: 200 }));
        assert.deepEqual(
            out.messages.map((m) => m.msgId),
            ["m1"],
        );
    });

    it("zalo_get_history surfaces cached delivery state and media paths", async () => {
        cache([{ msgId: "m1", ts: 100, type: "photo", attach: true, localPath: "/tmp/a.jpg" }]);
        const { server } = register({ api: emptyServerApi() });
        const [msg] = payloadOf(await server.call("zalo_get_history", { threadId: "t1", limit: 50 })).messages;
        assert.equal(msg.type, "photo");
        assert.equal(msg.localPath, "/tmp/a.jpg");
        assert.equal(msg.hasAttachment, true);
    });

    it("zalo_get_history falls back to the server when the cache is empty", async () => {
        const { server } = register({ api: emptyServerApi() });
        const out = payloadOf(await server.call("zalo_get_history", { threadId: "nope", limit: 50 }));
        assert.equal(out.source, "server");
        assert.equal(out.count, 0);
    });

    it("zalo_get_history takes a `before` cursor only as a positive timestamp", () => {
        const { server } = register();
        const s = server.tools.get("zalo_get_history").meta.inputSchema;
        assert.throws(() => s.parse({ threadId: "t1", before: -1 }));
        assert.equal(s.parse({ threadId: "t1", before: 1_750_000_000_000 }).before, 1_750_000_000_000);
    });

    it("zalo_view_media returns the path the cache recorded, without refetching", async () => {
        cache([{ msgId: "m1", ts: 100, type: "photo", attach: true, localPath: "/tmp/a.jpg" }]);
        const { server } = register({ api: emptyServerApi() });
        const out = payloadOf(await server.call("zalo_view_media", { messageId: "m1", open: false }));
        assert.equal(out.success, true);
        assert.equal(out.path, "/tmp/a.jpg");
        assert.equal(out.mediaType, "photo");
    });

    it("zalo_view_media says so when the message carries no media", async () => {
        cache([{ msgId: "m1", ts: 100 }]);
        const { server } = register({ api: emptyServerApi() });
        const out = await server.call("zalo_view_media", { messageId: "m1", open: false });
        assert.equal(out.isError, true);
        assert.match(out.content[0].text, /no media attachment/i);
    });

    it("zalo_view_media reports an unknown message rather than throwing", async () => {
        cache([{ msgId: "m1", ts: 100 }]);
        const { server } = register({ api: emptyServerApi() });
        const out = await server.call("zalo_view_media", { messageId: "gone", open: false });
        assert.equal(out.isError, true);
        assert.match(out.content[0].text, /not found/i);
    });
});
