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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { createStageLock } from "../../src/core/daemon-channel.js";
import { MessageBuffer } from "../../src/mcp/message-buffer.js";
import { initDb, insertMessage, upsertThread, upsertContact } from "../../src/core/db.js";

/** The exact tool surface. Changing this list is a deliberate act — see AGENTS.md §10. */
const EXPECTED_TOOLS = [
    "zalo_get_messages",
    "zalo_send_message",
    "zalo_list_threads",
    "zalo_search_threads",
    "zalo_mark_read",
    "zalo_get_history",
    "zalo_view_media",
    "zalo_react",
    "zalo_undo",
    "zalo_get_group_members",
    "zalo_list_conversations",
    "zalo_coverage",
    "zalo_sync",
    "zalo_sync_status",
    "zalo_search_messages",
    "zalo_lookup_user",
    "zalo_forward_message",
    "zalo_delete_message",
    "zalo_reminder",
    "zalo_note",
    "zalo_poll",
    "zalo_wait_for_message",
    "zalo_label",
    "zalo_friend",
    "zalo_group",
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
            readCursor: () => 0,
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
    registerTools(server, d.api, d.buffer, d.filter, d.config, d.nameCache, d.accountDir, d.stageLock);
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
        // Deliberately NOT defaulted. A zod .default(0) is indistinguishable
        // from the caller choosing DM, so the handler could never tell "not
        // given" from "explicitly a DM" -- which is how group sends went out
        // as type 0. Absent here means the handler resolves it from the cache.
        assert.equal(
            s.parse({ threadId: "t1", text: "hi" }).threadType,
            undefined,
            "omitted threadType must stay undefined so the handler can infer it",
        );
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

    it("zalo_send_message takes urgency only as normal, important or urgent", () => {
        const s = schemaOf("zalo_send_message");
        assert.equal(s.parse({ threadId: "t1", text: "hi" }).urgency, undefined, "omitted means an ordinary message");
        assert.equal(s.parse({ threadId: "t1", text: "hi", urgency: "urgent" }).urgency, "urgent");
        assert.throws(() => s.parse({ threadId: "t1", text: "hi", urgency: "critical" }));
        // Red if the enum is loosened to a string: an unknown name would reach
        // the mapping, and a prototype key there is truthy.
        assert.throws(() => s.parse({ threadId: "t1", text: "hi", urgency: "constructor" }));
    });

    it("zalo_react and zalo_undo need a msgId and a thread, and leave threadType and cliMsgId to be resolved", () => {
        for (const [name, extra] of [
            ["zalo_react", { reaction: "/-strong" }],
            ["zalo_undo", {}],
        ]) {
            const s = schemaOf(name);
            const parsed = s.parse({ msgId: "m1", threadId: "t1", ...extra });
            // Omitted must stay undefined: a default would be indistinguishable
            // from the caller choosing it, as zalo_send_message's threadType was.
            assert.equal(parsed.threadType, undefined, `${name}: threadType is inferred from the cache`);
            assert.equal(parsed.cliMsgId, undefined, `${name}: cliMsgId is looked up in the cache`);
            assert.throws(() => s.parse({ threadId: "t1", ...extra }), `${name} without msgId`);
            assert.throws(() => s.parse({ msgId: "m1", ...extra }), `${name} without threadId`);
            assert.throws(() => s.parse({ msgId: "m1", threadId: "t1", cliMsgId: "", ...extra }));
        }
        assert.throws(() => schemaOf("zalo_react").parse({ msgId: "m1", threadId: "t1" }), "a reaction needs a code");
        assert.throws(() => schemaOf("zalo_react").parse({ msgId: "m1", threadId: "t1", reaction: "" }));
    });

    it("zalo_list_conversations defaults to 20 of each type, and caps the limit", () => {
        const s = schemaOf("zalo_list_conversations");
        assert.deepEqual(s.parse({}), { type: "all", limit: 20 });
        assert.throws(() => s.parse({ limit: 0 }));
        assert.throws(() => s.parse({ limit: 201 }));
        assert.throws(() => s.parse({ type: "channel" }));
    });

    it("zalo_get_group_members requires a group id; zalo_coverage takes nothing", () => {
        assert.throws(() => schemaOf("zalo_get_group_members").parse({}));
        assert.throws(() => schemaOf("zalo_get_group_members").parse({ groupId: "" }));
        assert.deepEqual(schemaOf("zalo_coverage").parse({}), {});
    });
});

describe("MCP handlers", () => {
    it("zalo_send_message returns {success, messageId, threadType} on the happy path", async () => {
        const { server } = register();
        const r = await server.call("zalo_send_message", { threadId: "t1", text: "hi", threadType: 0 });
        assert.equal(r.isError, undefined);
        assert.deepEqual(payloadOf(r), { success: true, messageId: "m1", threadType: 0 });
    });

    it("an explicit threadType is obeyed, not second-guessed by the cache", async () => {
        const { server } = register();
        const r = await server.call("zalo_send_message", { threadId: "t1", text: "hi", threadType: 1 });
        assert.equal(payloadOf(r).threadType, 1);
    });

    it("omitting threadType no longer silently means DM", async () => {
        // The zod schema used to carry .default(0), which is indistinguishable
        // from the caller choosing DM. A group send then went out as type 0:
        // success is reported, the self-echo returns on cmd 501 instead of 521,
        // mentions are dropped, and the MCP server -- which is the db writer --
        // corrupts the cache that quoting and history read back.
        const { server } = register();
        const r = await server.call("zalo_send_message", { threadId: "t1", text: "hi" });
        assert.equal(r.isError, undefined);
        assert.ok("threadType" in payloadOf(r), "the resolved type must be visible to the caller");
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
                readCursor: () => 0,
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
                readCursor: () => 0,
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

    it("zalo_mark_read reports how many messages it newly marked read, and the cursor now in force", async () => {
        // Nothing is discarded any more (triage M7), so it no longer claims to.
        const { server } = register({
            buffer: {
                markRead: (c) => c * 2,
                readCursor: () => 3,
                getStats: () => [],
                getThreadType: () => "dm",
                read: () => ({}),
            },
        });
        assert.deepEqual(payloadOf(await server.call("zalo_mark_read", { cursor: 3 })), {
            success: true,
            marked: 6,
            readCursor: 3,
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

// Triage M7: one bot's zalo_mark_read used to delete the messages from the
// shared buffer, emptying every other bot's inbox. The handlers are called
// directly (no zod parse), so each call passes since/limit explicitly.
describe("several bots share one listener's buffer", () => {
    const withTwoMessages = () => {
        const buffer = new MessageBuffer();
        buffer.push("t1", { id: "a", threadId: "t1", text: "a", timestamp: Date.now() });
        buffer.push("t1", { id: "b", threadId: "t1", text: "b", timestamp: Date.now() });
        return register({ buffer }).server;
    };
    const get = async (server, consumer) =>
        payloadOf(await server.call("zalo_get_messages", { since: 0, limit: 20, consumer }));

    it("one bot's zalo_mark_read leaves another bot's inbox intact", async () => {
        const server = withTwoMessages();
        const first = await get(server, "bot-1");
        assert.equal(first.messages.length, 2);
        await server.call("zalo_mark_read", { cursor: first.cursor, consumer: "bot-1" });

        assert.equal((await get(server, "bot-1")).messages.length, 0);
        // Red if zalo_mark_read goes back to deleting for everyone.
        assert.equal((await get(server, "bot-2")).messages.length, 2);
    });

    it("a single bot that names no consumer works as before", async () => {
        const server = withTwoMessages();
        const first = await get(server, undefined);
        assert.equal(first.messages.length, 2);
        const marked = payloadOf(await server.call("zalo_mark_read", { cursor: first.cursor }));
        assert.equal(marked.marked, 2);
        assert.equal((await get(server, undefined)).messages.length, 0);
    });

    it("an explicit since is honored as given, even below the read cursor", async () => {
        const server = withTwoMessages();
        const first = await get(server, "bot-1");
        await server.call("zalo_mark_read", { cursor: first.cursor, consumer: "bot-1" });
        const again = payloadOf(await server.call("zalo_get_messages", { since: 1, limit: 20, consumer: "bot-1" }));
        assert.deepEqual(
            again.messages.map((m) => m.id),
            ["b"],
        );
    });

    it("unread counts in zalo_list_threads follow the consumer", async () => {
        const server = withTwoMessages();
        const first = await get(server, "bot-1");
        await server.call("zalo_mark_read", { cursor: first.cursor, consumer: "bot-1" });
        const unread = async (consumer) =>
            payloadOf(await server.call("zalo_list_threads", { type: "all", consumer })).threads[0]?.unread ?? 0;
        assert.equal(await unread("bot-1"), 0);
        assert.equal(await unread("bot-2"), 2);
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
        // An empty answer says why, so an agent does not read it as "no history".
        assert.equal(out.filtered, false);
        assert.match(out.note, /only since this login/);
    });

    // The fallback shares `listen`'s one stage-at-a-time lock (triage M6): a
    // scan beside a running sync stage lost the socket once.
    it("zalo_get_history refuses, rather than scan beside a running sync stage", async () => {
        const stageLock = createStageLock();
        const release = stageLock.tryAcquire("messages");
        let asked = false;
        const api = {
            listener: {
                on: () => {},
                removeListener: () => {},
                requestOldMessages: () => (asked = true),
            },
        };
        const { server } = register({ api, stageLock });
        const res = await server.call("zalo_get_history", { threadId: "nope", limit: 50 });
        release();
        // Red if the lock is ignored and the socket is asked anyway.
        assert.equal(res.isError, true);
        assert.match(res.content[0].text, /messages stage is running/);
        assert.equal(asked, false, "the socket was not touched");
    });

    it("zalo_get_history takes the lock for the fetch and gives it back", async () => {
        const stageLock = createStageLock();
        let heldDuringFetch = null;
        const api = emptyServerApi();
        const ask = api.listener.requestOldMessages;
        api.listener.requestOldMessages = (...a) => {
            heldDuringFetch = stageLock.current()?.stage ?? null;
            return ask(...a);
        };
        const { server } = register({ api, stageLock });
        await server.call("zalo_get_history", { threadId: "nope", limit: 50 });
        assert.equal(heldDuringFetch, "history");
        assert.equal(stageLock.current(), null, "released afterwards");
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
/**
 * `zalo_send_message`'s composed sends — @-mentions and quote-replies.
 *
 * The CLI's `msg send` gained both while the MCP tool could still only put a
 * bare string on the wire, so an agent — which is the primary way this tool
 * is driven — could not tag anyone or reply to a specific message. Both are
 * built from `src/utils/mentions.js` and `src/utils/quote.js`, the same pure
 * helpers the CLI uses and which have their own unit tests; what is covered
 * here is the *wiring*: what reaches `api.sendMessage`, and what a failure
 * reports back instead of throwing.
 */
describe("zalo_send_message composes mentions and quotes", () => {
    const THREAD_USER = 0;
    const THREAD_GROUP = 1;

    const ROOT = mkdtempSync(join(tmpdir(), "zalo-mcp-send-"));
    const handles = [];
    let n = 0;

    beforeEach(() => {
        handles.push(initDb(join(ROOT, `send${n++}.sqlite`)));
        upsertThread({ threadId: "g1", type: "group", name: "Việc riêng", lastUpdate: 9 });
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

    /** Cache one message row, defaulting the fields a quote needs. */
    const cacheMsg = (r) =>
        insertMessage({
            msgId: r.msgId,
            threadId: r.threadId ?? "g1",
            senderId: r.senderId ?? "789",
            senderName: r.senderName ?? null,
            text: r.text ?? "hi",
            timestamp: r.ts ?? 1_750_000_000_000,
            type: r.type ?? "text",
            raw_data: r.raw ?? JSON.stringify({ content: r.text ?? "hi", cliMsgId: "c1", property: { a: 1 } }),
            has_attachment: 0,
        });

    /** An api that records what it was asked to send. */
    function recordingApi() {
        const calls = [];
        return {
            calls,
            sendMessage: async (content, threadId, type) => {
                calls.push({ content, threadId, type });
                return { message: { msgId: "sent1" } };
            },
            // Present but never expected to fire — see the no-network test.
            getGroupMembersInfo: async () => {
                throw new Error("zalo_send_message must not hit the network to name a mention");
            },
        };
    }

    const send = async (args, api) => {
        const { server } = register({ api });
        return server.call("zalo_send_message", { threadType: THREAD_GROUP, ...args });
    };

    it("leaves a plain send as a bare string, not an object", async () => {
        const api = recordingApi();
        const r = await send({ threadId: "g1", text: "chào cả nhà" }, api);
        assert.strictEqual(api.calls[0].content, "chào cả nhà", "wrapping a plain send would change the wire format");
        // threadType is echoed back because it is now INFERRED from the cache
        // when the caller omits it; without it in the reply there is no way to
        // see what the server decided.
        assert.deepEqual(payloadOf(r), { success: true, messageId: "sent1", threadType: THREAD_GROUP });
    });

    it("expands `@[uid]` from a contact and puts the mention on the wire", async () => {
        upsertContact({ userId: "789", name: "Bích Ngọc", phone: null });
        const api = recordingApi();
        const r = await send({ threadId: "g1", text: "@[789] xem giúp nhé" }, api);

        const { msg, mentions } = api.calls[0].content;
        assert.equal(msg, "@Bích Ngọc xem giúp nhé");
        assert.deepEqual(mentions, [{ pos: 0, uid: "789", len: 10 }]);
        assert.equal(payloadOf(r).text, "@Bích Ngọc xem giúp nhé", "the agent wrote a token and needs the result");
    });

    it("names a uid from a past message when contacts has nothing", async () => {
        cacheMsg({ msgId: "m1", senderId: "456", senderName: "Chi Lan" });
        const api = recordingApi();
        await send({ threadId: "g1", text: "hỏi @[456] xem" }, api);
        assert.equal(api.calls[0].content.msg, "hỏi @Chi Lan xem");
    });

    it("measures mention offsets in UTF-16 units, so accents do not shift the tag", async () => {
        upsertContact({ userId: "789", name: "Trần Bích Ngọc", phone: null });
        const api = recordingApi();
        await send({ threadId: "g1", text: "Em ko biết mở ch ạ @[789]" }, api);

        const { msg, mentions } = api.calls[0].content;
        const { pos, len } = mentions[0];
        assert.equal(
            msg.slice(pos, pos + len),
            "@Trần Bích Ngọc",
            "a byte-counted offset paints the highlight over the wrong span",
        );
    });

    it("turns `@[-1]` into @All without reporting it unresolved", async () => {
        const api = recordingApi();
        const r = await send({ threadId: "g1", text: "@[-1] họp lúc 3h" }, api);
        assert.equal(api.calls[0].content.msg, "@All họp lúc 3h");
        assert.deepEqual(api.calls[0].content.mentions, [{ pos: 0, uid: "-1", len: 4 }]);
        assert.equal(payloadOf(r).unresolvedMentions, undefined, "@All has no name to look up");
    });

    it("falls back to the bare uid for an unknown mention and says so", async () => {
        const api = recordingApi();
        const r = await send({ threadId: "g1", text: "@[999] ping" }, api);

        assert.equal(api.calls[0].content.msg, "@999 ping", "the uid is what Zalo notifies on");
        assert.deepEqual(api.calls[0].content.mentions, [{ pos: 0, uid: "999", len: 4 }]);
        assert.deepEqual(payloadOf(r).unresolvedMentions, ["999"], "silently sending @999 would look like a bug");
    });

    it("never calls the network to resolve a name — the MCP send stays local", async () => {
        const api = recordingApi();
        // recordingApi().getGroupMembersInfo throws; the send must still succeed,
        // which it only can if nothing reached for it. The CLI's batched
        // getGroupMembersInfo fallback is deliberately not wired up here.
        const r = await send({ threadId: "g1", text: "@[999] ping" }, api);
        assert.equal(r.isError, undefined);
        assert.equal(api.calls.length, 1);
    });

    it("warns when mentions are used in a DM, where Zalo drops them", async () => {
        upsertContact({ userId: "789", name: "Bích Ngọc", phone: null });
        const api = recordingApi();
        const r = await send({ threadId: "u1", text: "@[789] hi", threadType: THREAD_USER }, api);

        const out = payloadOf(r);
        assert.equal(out.success, true, "a DM mention is a warning, not a failure");
        assert.equal(out.warnings.length, 1);
        assert.match(out.warnings[0], /only apply to group messages/i);
    });

    it("leaves brackets that are not a uid alone", async () => {
        const api = recordingApi();
        await send({ threadId: "g1", text: "@[TODO] chốt sau" }, api);
        assert.strictEqual(api.calls[0].content, "@[TODO] chốt sau", "no uid, no mention, no object wrapper");
    });

    it("builds a quote payload from the cached row", async () => {
        cacheMsg({ msgId: "m1", text: "bao giờ giao?", senderId: "456" });
        const api = recordingApi();
        const r = await send({ threadId: "g1", text: "chiều mai nhé", quoteMsgId: "m1" }, api);

        const { msg, quote } = api.calls[0].content;
        assert.equal(msg, "chiều mai nhé");
        assert.equal(quote.content, "bao giờ giao?");
        assert.equal(quote.msgId, "m1");
        assert.equal(quote.cliMsgId, "c1", "client-generated; it exists nowhere but raw_data");
        assert.equal(quote.uidFrom, "456");
        assert.equal(quote.msgType, "webchat");
        assert.deepEqual(quote.propertyExt, { a: 1 });
        assert.equal(payloadOf(r).success, true);
    });

    it("quotes and mentions compose in one send", async () => {
        cacheMsg({ msgId: "m1", text: "ai làm việc này?", senderId: "456" });
        upsertContact({ userId: "789", name: "Bích Ngọc", phone: null });
        const api = recordingApi();
        await send({ threadId: "g1", text: "@[789] nhé", quoteMsgId: "m1" }, api);

        const { msg, mentions, quote } = api.calls[0].content;
        assert.equal(msg, "@Bích Ngọc nhé");
        assert.equal(mentions.length, 1);
        assert.equal(quote.msgId, "m1");
    });

    it("reports an uncached quote target as an MCP error and sends nothing", async () => {
        const api = recordingApi();
        const r = await send({ threadId: "g1", text: "ok", quoteMsgId: "gone" }, api);

        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /not in the local cache/i);
        assert.match(r.content[0].text, /msg history/, "the error names the fix");
        assert.equal(api.calls.length, 0, "a half-built quote must not go out as a plain message");
    });

    it("refuses to quote a non-text message instead of raising a ZaloApiError", async () => {
        // A sync-restored photo caches the placeholder "[Hình ảnh]" as its text,
        // so the guard has to be the row's type, not the shape of its content.
        cacheMsg({ msgId: "m1", type: "photo", text: "[Hình ảnh]" });
        const api = recordingApi();
        const r = await send({ threadId: "g1", text: "đẹp quá", quoteMsgId: "m1" }, api);

        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /only supports quote-replies to text messages/i);
        assert.equal(api.calls.length, 0);
    });

    it("refuses a quote target from a different thread", async () => {
        cacheMsg({ msgId: "m1", threadId: "g2" });
        const api = recordingApi();
        const r = await send({ threadId: "g1", text: "ok", quoteMsgId: "m1" }, api);

        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /belongs to thread g2/);
        assert.equal(api.calls.length, 0);
    });

    it("refuses rather than sending a quote whose noised sender Zalo rejects", async () => {
        // transfer-sync-v2 restores rows with a noised sender id rather than
        // the numeric uid the live listener records. The first version of this
        // test asserted the send went through with a warning; measured
        // 2026-09-28, Zalo rejects it with code 114. So the tool now resolves
        // the id, and when it cannot, it must not send at all.
        cacheMsg({ msgId: "m1", senderId: "VNOISED0000000000000000000000091" });
        const api = recordingApi();
        const r = await send({ threadId: "g1", text: "ok", quoteMsgId: "m1" }, api);

        assert.equal(r.isError, true, "a send the server will reject is not a success");
        assert.match(r.content[0].text, /msg history/i, "the error has to name the way out");
        assert.equal(api.calls.length, 0, "nothing should reach sendMessage");
    });

    it("reports a missing cliMsgId rather than sending a quote Zalo will reject", async () => {
        cacheMsg({ msgId: "m1", raw: JSON.stringify({ content: "hi" }) });
        const api = recordingApi();
        const r = await send({ threadId: "g1", text: "ok", quoteMsgId: "m1" }, api);

        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /cliMsgId was never cached/i);
        assert.equal(api.calls.length, 0);
    });

    it("sends a link preview card when `link` is provided", async () => {
        let seen;
        const { server } = register({
            api: {
                sendLink: async (opts, tid, type) => {
                    seen = { opts, tid, type };
                    return { msgId: "link1", cliMsgId: "cl1" };
                },
            },
        });
        const r = await server.call("zalo_send_message", {
            threadId: "g1",
            link: "https://example.com/doc",
            text: "Xem tài liệu",
        });
        assert.equal(r.isError, undefined);
        assert.deepEqual(seen, {
            opts: { link: "https://example.com/doc", msg: "Xem tài liệu" },
            tid: "g1",
            type: 1,
        });
        assert.equal(payloadOf(r).kind, "link");
        assert.equal(payloadOf(r).messageId, "link1");
    });

    it("sends a contact card when `cardUserId` is provided", async () => {
        let seen;
        const { server } = register({
            api: {
                sendCard: async (opts, tid, type) => {
                    seen = { opts, tid, type };
                    return { msgId: "card1" };
                },
            },
        });
        const r = await server.call("zalo_send_message", {
            threadId: "g1",
            cardUserId: "u99",
        });
        assert.equal(r.isError, undefined);
        assert.deepEqual(seen, { opts: { userId: "u99" }, tid: "g1", type: 1 });
        assert.equal(payloadOf(r).kind, "card");
        assert.equal(payloadOf(r).cardUserId, "u99");
    });

    it("sends file attachments when `filePath` or `files` is provided, and reports attachment msgIds", async () => {
        const fileA = join(ROOT, "report.html");
        const fileB = join(ROOT, "diagram.png");
        writeFileSync(fileA, "<h1>Report</h1>");
        writeFileSync(fileB, "PNG");

        let seen;
        const { server } = register({
            api: {
                sendMessage: async (content, tid, type) => {
                    seen = { content, tid, type };
                    return {
                        message: null,
                        attachment: [
                            { msgId: "att1", cliMsgId: "c_att1" },
                            { msgId: "att2", cliMsgId: "c_att2" },
                        ],
                    };
                },
            },
        });
        const r = await server.call("zalo_send_message", {
            threadId: "g1",
            filePath: fileA,
            files: [fileB],
            text: "Báo cáo đính kèm",
        });
        assert.equal(r.isError, undefined);
        assert.deepEqual(seen, {
            content: { msg: "Báo cáo đính kèm", attachments: [fileA, fileB] },
            tid: "g1",
            type: 1,
        });
        const out = payloadOf(r);
        assert.equal(out.kind, "attachment");
        assert.deepEqual(out.files, [fileA, fileB]);
        assert.deepEqual(out.sent, [
            { msgId: "att1", cliMsgId: "c_att1" },
            { msgId: "att2", cliMsgId: "c_att2" },
        ]);
        assert.equal(out.messageId, "att1");
        assert.equal(out.cliMsgId, "c_att1");
    });

    it("refuses a missing attachment file before calling the API", async () => {
        let called = false;
        const { server } = register({
            api: {
                sendMessage: async () => {
                    called = true;
                    return { msgId: "x" };
                },
            },
        });
        const missingPath = join(ROOT, "does-not-exist.pdf");
        const r = await server.call("zalo_send_message", {
            threadId: "g1",
            filePath: missingPath,
        });
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /File not found/);
        assert.equal(called, false);
    });
});

describe("Tier 1 & Tier 2 MCP tools", () => {
    const ROOT = mkdtempSync(join(tmpdir(), "zalo-mcp-tier12-"));
    const handles = [];
    let n = 0;

    beforeEach(() => {
        handles.push(initDb(join(ROOT, `t${n++}.sqlite`)));
        upsertThread({ threadId: "g1", type: "group", name: "Nhóm Dự Án", lastUpdate: 100 });
        upsertThread({ threadId: "u2", type: "dm", name: "Anh Minh", lastUpdate: 100 });
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
            /* ignore */
        }
    });

    it("zalo_search_messages searches local SQLite messages with filters and zero network calls", async () => {
        insertMessage({
            msgId: "m1",
            threadId: "g1",
            senderId: "u2",
            senderName: "Anh Minh",
            text: "Báo cáo doanh thu quý 3",
            timestamp: 1000,
            type: "text",
            raw_data: JSON.stringify({ cliMsgId: "c1", content: "Báo cáo doanh thu quý 3" }),
        });
        insertMessage({
            msgId: "m2",
            threadId: "u2",
            senderId: "u3",
            senderName: "Chị Lan",
            text: "Báo cáo nhân sự",
            timestamp: 2000,
            type: "text",
            raw_data: JSON.stringify({ cliMsgId: "c2", content: "Báo cáo nhân sự" }),
        });

        const { server } = register();
        const all = payloadOf(await server.call("zalo_search_messages", { query: "Báo cáo", limit: 10 }));
        assert.equal(all.count, 2);
        assert.deepEqual(
            all.messages.map((m) => m.msgId),
            ["m2", "m1"],
            "newest first",
        );

        const filtered = payloadOf(
            await server.call("zalo_search_messages", { query: "Báo cáo", threadId: "g1", limit: 10 }),
        );
        assert.equal(filtered.count, 1);
        assert.equal(filtered.messages[0].msgId, "m1");
        assert.equal(filtered.messages[0].threadName, "Nhóm Dự Án");
        assert.equal(filtered.messages[0].cliMsgId, "c1");
    });

    it("zalo_search_messages ignores accents by default, takes them on request, and pages with a cursor", async () => {
        const base = { threadId: "g1", senderId: "u2", senderName: "Anh Minh", type: "text" };
        insertMessage({ ...base, msgId: "s1", text: "Được rồi, hẹn gặp lại", timestamp: 5000 });
        insertMessage({ ...base, msgId: "s2", text: "duoc nhe", timestamp: 6000 });
        insertMessage({ ...base, msgId: "s3", text: "Không được đâu", timestamp: 7000 });
        insertMessage({ ...base, msgId: "s4", text: "báo cáo được duyệt.xlsx", timestamp: 8000, type: "file" });

        const { server } = register();
        const fold = payloadOf(await server.call("zalo_search_messages", { query: "duoc", limit: 2 }));
        assert.equal(fold.accents, "fold");
        assert.deepEqual(
            fold.messages.map((m) => m.msgId),
            ["s4", "s3"],
        );
        assert.equal(fold.hasMore, true);
        assert.ok(fold.nextCursor, "a cursor for the next page");
        assert.deepEqual(fold.counts, { text: 3, file: 1 });
        assert.match(fold.coverage.note, /local cache only/);
        assert.equal(
            fold.messages[0].snippet.text.slice(fold.messages[0].snippet.matchStart, fold.messages[0].snippet.matchEnd),
            "được",
        );

        const next = payloadOf(
            await server.call("zalo_search_messages", { query: "duoc", limit: 2, cursor: fold.nextCursor }),
        );
        assert.deepEqual(
            next.messages.map((m) => m.msgId),
            ["s2", "s1"],
        );
        assert.equal(next.hasMore, false);
        assert.equal(next.nextCursor, null);
        assert.equal(next.counts, undefined, "the tabs' numbers come with the first page only");

        const exact = payloadOf(await server.call("zalo_search_messages", { query: "duoc", accents: "exact" }));
        assert.deepEqual(
            exact.messages.map((m) => m.msgId),
            ["s2"],
            "accents typed, accents matched",
        );
        const accented = payloadOf(await server.call("zalo_search_messages", { query: "được", accents: "exact" }));
        assert.deepEqual(accented.messages.map((m) => m.msgId).sort(), ["s1", "s3", "s4"]);
    });

    it("zalo_search_messages filters by type and period, shows context, and refuses a bad cursor", async () => {
        const now = Date.now();
        const base = { threadId: "g1", senderId: "u2", senderName: "Anh Minh", type: "text" };
        insertMessage({ ...base, msgId: "k1", text: "trước đó", timestamp: now - 1000 });
        insertMessage({ ...base, msgId: "k2", text: "họp lúc ba giờ", timestamp: now - 900 });
        insertMessage({ ...base, msgId: "k3", text: "sau đó", timestamp: now - 800 });
        insertMessage({ ...base, msgId: "k4", text: "họp.pdf", timestamp: now - 700, type: "file" });
        insertMessage({ ...base, msgId: "old", text: "họp cũ", timestamp: now - 40 * 86_400_000 });

        const { server } = register();
        const files = payloadOf(await server.call("zalo_search_messages", { query: "hop", types: ["file"] }));
        assert.deepEqual(
            files.messages.map((m) => m.msgId),
            ["k4"],
        );

        const recent = payloadOf(await server.call("zalo_search_messages", { query: "hop", last: "7d" }));
        assert.deepEqual(
            recent.messages.map((m) => m.msgId),
            ["k4", "k2"],
            "the message from 40 days ago is outside the last week",
        );

        const around = payloadOf(await server.call("zalo_search_messages", { query: "ba gio", context: 1 }));
        assert.deepEqual(
            around.messages[0].context.before.map((m) => m.msgId),
            ["k1"],
        );
        assert.deepEqual(
            around.messages[0].context.after.map((m) => m.msgId),
            ["k3"],
        );
        const plain = payloadOf(await server.call("zalo_search_messages", { query: "ba gio" }));
        assert.equal(plain.messages[0].context, undefined);

        const bad = await server.call("zalo_search_messages", { query: "hop", cursor: "garbage" });
        assert.equal(bad.isError, true);
        const schema = server.tools.get("zalo_search_messages").meta.inputSchema;
        assert.throws(() => schema.parse({ query: "x", last: "soon" }), "a period is a number and a unit");
        assert.throws(() => schema.parse({ query: "x", context: 11 }));
        assert.throws(() => schema.parse({ query: "x", accents: "loose" }));
    });

    it("zalo_lookup_user supports self, phone, username, and userId modes", async () => {
        const { server } = register({
            api: {
                getOwnId: () => "u_self",
                fetchAccountInfo: async () => ({ profile: { userId: "u_self", displayName: "Tôi" } }),
                findUser: async (p) => ({ uid: "u_phone", display_name: `Phone ${p}` }),
                findUserByUsername: async (u) => ({ uid: "u_name", display_name: `User ${u}` }),
                getUserInfo: async (id) => ({ changed_profiles: { [id]: { displayName: "Profile Name" } } }),
            },
        });

        const schema = server.tools.get("zalo_lookup_user").meta.inputSchema;
        assert.throws(() => schema.parse({}), "must require one lookup mode");
        assert.throws(() => schema.parse({ self: true, phone: "0901234567" }), "must reject multiple modes");

        const selfOut = payloadOf(await server.call("zalo_lookup_user", { self: true }));
        assert.equal(selfOut.mode, "self");
        assert.equal(selfOut.ownId, "u_self");
        assert.equal(selfOut.displayName, "Tôi");

        const phoneOut = payloadOf(await server.call("zalo_lookup_user", { phone: "0901234567" }));
        assert.equal(phoneOut.mode, "phone");
        assert.equal(phoneOut.userId, "u_phone");

        const userOut = payloadOf(await server.call("zalo_lookup_user", { username: "arden" }));
        assert.equal(userOut.mode, "username");
        assert.equal(userOut.userId, "u_name");

        const idOut = payloadOf(await server.call("zalo_lookup_user", { userId: "u2" }));
        assert.equal(idOut.mode, "userId");
        assert.equal(idOut.displayName, "Profile Name");
    });

    it("zalo_delete_message resolves cliMsgId and uidFrom from local cache and passes onlyMe=!everyone", async () => {
        insertMessage({
            msgId: "m_del",
            threadId: "g1",
            senderId: "u2",
            senderName: "Anh Minh",
            text: "xoá tin này",
            timestamp: 1500,
            type: "text",
            raw_data: JSON.stringify({ cliMsgId: "cli_del", uidFrom: "u2", content: "xoá tin này" }),
        });

        let seen;
        const { server } = register({
            api: {
                deleteMessage: async (dest, onlyMe) => {
                    seen = { dest, onlyMe };
                    return { status: 0 };
                },
            },
        });

        const out = payloadOf(
            await server.call("zalo_delete_message", { msgId: "m_del", threadId: "g1", everyone: true }),
        );
        assert.equal(out.success, true);
        assert.equal(out.cliMsgId, "cli_del");
        assert.equal(seen.onlyMe, false, "everyone: true means onlyMe: false");
        assert.deepEqual(seen.dest, {
            data: { cliMsgId: "cli_del", msgId: "m_del", uidFrom: "u2" },
            threadId: "g1",
            type: 1,
        });
    });

    it("zalo_forward_message forwards a cached link or card to the target thread", async () => {
        insertMessage({
            msgId: "m_link",
            threadId: "g1",
            senderId: "u2",
            senderName: "Anh Minh",
            text: "https://example.com",
            timestamp: 1600,
            type: "link",
            raw_data: JSON.stringify({ cliMsgId: "cli_l", content: { href: "https://example.com" } }),
        });

        let seen;
        const { server } = register({
            api: {
                sendLink: async (opts, tid, type) => {
                    seen = { opts, tid, type };
                    return { msgId: "fwd_1" };
                },
            },
        });

        const out = payloadOf(await server.call("zalo_forward_message", { msgId: "m_link", threadId: "u2" }));
        assert.equal(out.success, true);
        assert.equal(out.kind, "link");
        assert.deepEqual(seen, {
            opts: { link: "https://example.com" },
            tid: "u2",
            type: 0,
        });
    });

    it("zalo_reminder dispatches create, list, info, responses, edit, and remove", async () => {
        const calls = [];
        const { server } = register({
            api: {
                createReminder: async (opts, tid, type) => {
                    calls.push(["create", opts, tid, type]);
                    return { reminderId: "r1" };
                },
                getListReminder: async (opts, tid, type) => {
                    calls.push(["list", opts, tid, type]);
                    return [{ id: "r1", params: { title: "Họp" } }];
                },
                getReminder: async (id) => ({ id, params: { title: "Họp" } }),
                getReminderResponses: async (id) => ({ id, acceptMember: ["u2"], rejectMember: [] }),
                editReminder: async (opts, tid, type) => {
                    calls.push(["edit", opts, tid, type]);
                    return { id: opts.topicId };
                },
                removeReminder: async (id, tid, type) => {
                    calls.push(["remove", id, tid, type]);
                    return { ok: true };
                },
            },
        });

        const created = payloadOf(
            await server.call("zalo_reminder", {
                action: "create",
                threadId: "g1",
                title: "Họp nhóm",
                time: "2026-10-20 09:00",
                repeat: "weekly",
            }),
        );
        assert.equal(created.success, true);
        assert.equal(created.reminderId, "r1");
        assert.equal(created.repeat, "weekly");
        assert.equal(calls[0][3], 1, "group threadType inferred from cache");

        const listed = payloadOf(
            await server.call("zalo_reminder", { action: "list", threadId: "g1", page: 1, count: 20 }),
        );
        assert.equal(listed.count, 1);

        const info = payloadOf(await server.call("zalo_reminder", { action: "info", reminderId: "r1" }));
        assert.equal(info.reminder.id, "r1");

        const resp = payloadOf(await server.call("zalo_reminder", { action: "responses", reminderId: "r1" }));
        assert.deepEqual(resp.responses.acceptMember, ["u2"]);

        const edited = payloadOf(
            await server.call("zalo_reminder", {
                action: "edit",
                reminderId: "r1",
                threadId: "g1",
                title: "Họp nhóm chiều",
            }),
        );
        assert.equal(edited.success, true);

        const removed = payloadOf(
            await server.call("zalo_reminder", { action: "remove", reminderId: "r1", threadId: "g1" }),
        );
        assert.equal(removed.success, true);
    });

    it("zalo_note dispatches create, edit, and list", async () => {
        const calls = [];
        const { server } = register({
            api: {
                createNote: async (opts, gid) => {
                    calls.push(["create", opts, gid]);
                    return { id: "n1" };
                },
                editNote: async (opts, gid) => {
                    calls.push(["edit", opts, gid]);
                    return { id: opts.topicId };
                },
                getListBoard: async (opts, gid) => {
                    calls.push(["list", opts, gid]);
                    return { items: [{ id: "n1" }] };
                },
            },
        });

        const created = payloadOf(
            await server.call("zalo_note", { action: "create", groupId: "g1", title: "Nội quy", pin: true }),
        );
        assert.equal(created.success, true);
        assert.equal(created.pinned, true);
        assert.deepEqual(calls[0], ["create", { title: "Nội quy", pinAct: true }, "g1"]);

        const edited = payloadOf(
            await server.call("zalo_note", {
                action: "edit",
                groupId: "g1",
                noteId: "n1",
                title: "Nội quy mới",
                pin: false,
            }),
        );
        assert.equal(edited.success, true);

        const listed = payloadOf(await server.call("zalo_note", { action: "list", groupId: "g1", page: 1, count: 20 }));
        assert.equal(listed.count, 1);
    });

    it("zalo_poll dispatches create, info, vote, unvote, add_options, lock, and share", async () => {
        const calls = [];
        const { server } = register({
            api: {
                createPoll: async (opts, gid) => {
                    calls.push(["create", opts, gid]);
                    return { poll_id: 42 };
                },
                getPollDetail: async (pid) => ({ poll_id: pid, question: "Trưa ăn gì?" }),
                votePoll: async (pid, oids) => {
                    calls.push(["vote", pid, oids]);
                    return { options: [] };
                },
                addPollOptions: async (payload) => {
                    calls.push(["add_options", payload]);
                    return { options: [] };
                },
                lockPoll: async (pid) => {
                    calls.push(["lock", pid]);
                    return { ok: true };
                },
                sharePoll: async (pid) => {
                    calls.push(["share", pid]);
                    return { ok: true };
                },
            },
        });

        const created = payloadOf(
            await server.call("zalo_poll", {
                action: "create",
                groupId: "g1",
                question: "Trưa ăn gì?",
                options: ["Phở", "Bún chả"],
                multi: true,
                allowAddOptions: false,
                anonymous: false,
                hidePreview: false,
            }),
        );
        assert.equal(created.success, true);
        assert.equal(created.pollId, 42);

        const info = payloadOf(await server.call("zalo_poll", { action: "info", pollId: 42 }));
        assert.equal(info.poll.question, "Trưa ăn gì?");

        const voted = payloadOf(await server.call("zalo_poll", { action: "vote", pollId: "42", optionIds: [1, 2] }));
        assert.equal(voted.success, true);
        assert.deepEqual(calls[1], ["vote", 42, [1, 2]]);

        const unvoted = payloadOf(await server.call("zalo_poll", { action: "unvote", pollId: 42 }));
        assert.equal(unvoted.success, true);
        assert.deepEqual(calls[2], ["vote", 42, []]);

        const added = payloadOf(
            await server.call("zalo_poll", {
                action: "add_options",
                pollId: 42,
                options: ["Cơm tấm"],
                voteNewOptions: true,
            }),
        );
        assert.equal(added.added, 1);
        assert.deepEqual(calls[3], [
            "add_options",
            { pollId: 42, options: [{ content: "Cơm tấm", voted: true }], votedOptionIds: [] },
        ]);

        const locked = payloadOf(await server.call("zalo_poll", { action: "lock", pollId: 42 }));
        assert.equal(locked.success, true);

        const shared = payloadOf(await server.call("zalo_poll", { action: "share", pollId: 42 }));
        assert.equal(shared.success, true);
    });

    it("zalo_wait_for_message returns buffered message with threadName or times out cleanly", async () => {
        const buf = new MessageBuffer();
        buf.push("g1", { id: "m100", threadId: "g1", text: "Ping assistant", timestamp: Date.now() });
        const { server } = register({
            buffer: buf,
            nameCache: {
                ready: true,
                get: (tid) => (tid === "g1" ? { name: "ACME Team", type: "group" } : null),
                search: () => [],
            },
        });

        const hit = payloadOf(await server.call("zalo_wait_for_message", { since: 0, timeoutSec: 2 }));
        assert.equal(hit.status, "message");
        assert.equal(hit.cursor, 1);
        assert.equal(hit.message.id, "m100");
        assert.equal(hit.message.threadName, "ACME Team");

        const miss = payloadOf(await server.call("zalo_wait_for_message", { since: 1, timeoutSec: 1 }));
        assert.equal(miss.status, "timeout");
        assert.equal(miss.message, null);
        assert.equal(miss.cursor, 1);
    });

    it("zalo_label lists, assigns by labelText, unassigns by labelId, and updates raw labelData", async () => {
        let store = {
            version: 5,
            lastUpdateTime: 1700000000000,
            labelData: [
                { id: 1, text: "Nội bộ", textKey: "noi_bo", conversations: ["g1"], color: "#ff0000" },
                { id: 2, text: "Khách hàng", textKey: "khach_hang", conversations: [], color: "#00ff00" },
                { id: 3, text: "Đối tác", textKey: "doi_tac", conversations: [], color: "#0000ff" },
            ],
        };
        const { server } = register({
            api: {
                getLabels: async () => structuredClone(store),
                updateLabels: async ({ labelData, version }) => {
                    store = {
                        version: version + 1,
                        lastUpdateTime: Date.now(),
                        labelData: structuredClone(labelData),
                    };
                    return structuredClone(store);
                },
            },
        });

        const listed = payloadOf(await server.call("zalo_label", { action: "list" }));
        assert.equal(listed.version, 5);
        assert.equal(listed.labelData.length, 3);

        const assigned = payloadOf(
            await server.call("zalo_label", {
                action: "assign",
                labelText: "khách hàng",
                threadId: "g2",
                threadIds: ["g3"],
            }),
        );
        assert.equal(assigned.success, true);
        assert.equal(assigned.labelId, 2);
        assert.deepEqual(assigned.conversations, ["g2", "g3"]);
        assert.equal(assigned.version, 6);

        const unassigned = payloadOf(
            await server.call("zalo_label", {
                action: "unassign",
                labelId: 2,
                threadId: "g2",
            }),
        );
        assert.equal(unassigned.success, true);
        assert.deepEqual(unassigned.conversations, ["g3"]);
        assert.equal(unassigned.version, 7);

        const rawUpdated = payloadOf(
            await server.call("zalo_label", {
                action: "update",
                labelData: store.labelData,
                version: store.version,
            }),
        );
        assert.equal(rawUpdated.success, true);
        assert.equal(rawUpdated.version, 8);
    });
});

describe("zalo_friend", () => {
    const U = "9100000000000000001";
    /** A fake api that records every friend call, with per-test answers. */
    function friendApi(answers = {}) {
        const calls = [];
        const rec =
            (name, fallback) =>
            async (...args) => {
                calls.push([name, ...args]);
                const a = answers[name];
                if (a instanceof Error) throw a;
                return typeof a === "function" ? a(...args) : (a ?? fallback);
            };
        return {
            calls,
            api: {
                getFriendRequestStatus: rec("getFriendRequestStatus", {
                    is_friend: 0,
                    is_requested: 0,
                    is_requesting: 0,
                }),
                getSentFriendRequest: rec("getSentFriendRequest", {}),
                getFriendRecommendations: rec("getFriendRecommendations", { recommItems: [] }),
                sendFriendRequest: rec("sendFriendRequest", ""),
                acceptFriendRequest: rec("acceptFriendRequest", ""),
                rejectFriendRequest: rec("rejectFriendRequest", ""),
                undoFriendRequest: rec("undoFriendRequest", ""),
                getAllFriends: rec("getAllFriends", []),
            },
        };
    }
    const call = (fa, args) => register({ api: fa.api }).server.call("zalo_friend", args);

    it("takes exactly the eight actions, and a bounded limit", () => {
        const { server } = register();
        const schema = server.tools.get("zalo_friend").meta.inputSchema;
        for (const action of [
            "status",
            "sent_requests",
            "received_requests",
            "send",
            "accept",
            "reject",
            "undo",
            "list",
        ]) {
            assert.doesNotThrow(() => schema.parse({ action }), action);
        }
        assert.throws(() => schema.parse({ action: "block" }), "an action outside the list is refused");
        assert.throws(() => schema.parse({ action: "list", limit: 0 }));
        assert.throws(() => schema.parse({ action: "list", limit: 1001 }));
    });

    it("status asks Zalo about that user and returns the three flags as booleans", async () => {
        const fa = friendApi({ getFriendRequestStatus: { is_friend: 0, is_requested: 1, is_requesting: 0 } });
        const out = payloadOf(await call(fa, { action: "status", userId: U }));
        assert.deepEqual(fa.calls, [["getFriendRequestStatus", U]]);
        assert.deepEqual(out, {
            action: "status",
            userId: U,
            is_friend: false,
            is_requested: true,
            is_requesting: false,
        });
    });

    it("sent_requests lists what Zalo has, and treats its 'none' answer (112) as an empty list", async () => {
        const sent = {
            [U]: { userId: U, displayName: "A", fReqInfo: { message: "hi", time: 1790000000 } },
        };
        const out = payloadOf(await call(friendApi({ getSentFriendRequest: sent }), { action: "sent_requests" }));
        assert.equal(out.count, 1);
        assert.deepEqual(out.requests[0], {
            userId: U,
            displayName: "A",
            message: "hi",
            requestedAt: new Date(1790000000 * 1000).toISOString(),
        });
        // Red if Zalo's "no requests" error is surfaced as a failure instead of an empty list.
        const none = await call(friendApi({ getSentFriendRequest: new Error("Zalo error (112)") }), {
            action: "sent_requests",
        });
        assert.deepEqual(payloadOf(none), { action: "sent_requests", count: 0, requests: [] });
        const broken = await call(friendApi({ getSentFriendRequest: new Error("boom (500)") }), {
            action: "sent_requests",
        });
        assert.equal(broken.isError, true);
    });

    it("received_requests keeps only requests sent to us (type 2), newest first, and drops suggestions", async () => {
        const item = (id, type, time, extra = {}) => ({
            dataInfo: { userId: id, displayName: `N${id}`, recommType: type, recommTime: time, ...extra },
        });
        const fa = friendApi({
            getFriendRecommendations: {
                recommItems: [
                    item("1", 1, 3000), // a suggestion
                    item("2", 2, 1000, { recommInfo: { message: "old" } }),
                    item("3", 2, 2000, { recommInfo: { message: "new" }, isSeenFriendReq: true }),
                ],
            },
        });
        const out = payloadOf(await call(fa, { action: "received_requests" }));
        // Red if suggestions leak in, or the order is the feed's rather than newest-first.
        assert.deepEqual(
            out.requests.map((r) => [r.userId, r.message, r.seen]),
            [
                ["3", "new", true],
                ["2", "old", false],
            ],
        );
        assert.equal(out.count, 2);
    });

    it("send passes (message, userId) in zca-js's order, defaults the message to empty, and reports success", async () => {
        const fa = friendApi();
        assert.deepEqual(payloadOf(await call(fa, { action: "send", userId: U, message: "Chào bạn" })), {
            action: "send",
            success: true,
            userId: U,
        });
        await call(fa, { action: "send", userId: U });
        assert.deepEqual(fa.calls, [
            ["sendFriendRequest", "Chào bạn", U],
            ["sendFriendRequest", "", U],
        ]);
    });

    it("send explains Zalo's refusals in the CLI's words, and passes an unknown failure through", async () => {
        const refused = await call(friendApi({ sendFriendRequest: new Error("Zalo error (225)") }), {
            action: "send",
            userId: U,
        });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text, /Already friends with 9100000000000000001/);
        const unknown = await call(friendApi({ sendFriendRequest: new Error("weird (999)") }), {
            action: "send",
            userId: U,
        });
        assert.match(unknown.content[0].text, /weird \(999\)/);
    });

    it("accept, reject and undo each call their own Zalo method with the user id", async () => {
        const fa = friendApi();
        for (const action of ["accept", "reject", "undo"]) {
            const out = payloadOf(await call(fa, { action, userId: U }));
            assert.deepEqual(out, { action, success: true, userId: U });
        }
        // Red if an action is wired to the wrong method (undo must not reject, accept must not send).
        assert.deepEqual(fa.calls, [
            ["acceptFriendRequest", U],
            ["rejectFriendRequest", U],
            ["undoFriendRequest", U],
        ]);
    });

    it("list returns friends most recently active first, capped, and says how many there are in all", async () => {
        const friends = [
            { userId: "1", displayName: "old", lastActionTime: 100 },
            { userId: "2", zaloName: "newest", lastActionTime: 300 },
            { userId: "3", displayName: "mid", lastActionTime: 200 },
        ];
        const out = payloadOf(await call(friendApi({ getAllFriends: friends }), { action: "list", limit: 2 }));
        assert.deepEqual(
            out.friends.map((f) => f.userId),
            ["2", "3"],
        );
        assert.deepEqual([out.total, out.count, out.truncated], [3, 2, true]);
        assert.equal(out.friends[0].displayName, "newest", "falls back to the Zalo name");
        const all = payloadOf(await call(friendApi({ getAllFriends: friends }), { action: "list" }));
        assert.deepEqual([all.count, all.truncated], [3, false]);
    });

    it("refuses a missing or non-numeric userId without touching Zalo, and needs none for the lists", async () => {
        const fa = friendApi();
        for (const action of ["status", "send", "accept", "reject", "undo"]) {
            const missing = await call(fa, { action });
            assert.equal(missing.isError, true);
            assert.match(missing.content[0].text, /userId is required/);
            const bad = await call(fa, { action, userId: "1,2; drop" });
            assert.match(bad.content[0].text, /numeric Zalo id/);
        }
        assert.deepEqual(fa.calls, [], "no refused call reaches Zalo");
        for (const action of ["list", "sent_requests", "received_requests"]) {
            assert.notEqual((await call(fa, { action })).isError, true, action);
        }
    });
});

describe("zalo_group", () => {
    const G = "7000000000000000001";
    const U1 = "9100000000000000001";
    const U2 = "9100000000000000002";
    /** A fake api that records every group call, with per-test answers. */
    function groupApi(answers = {}) {
        const calls = [];
        const rec =
            (name, fallback) =>
            async (...args) => {
                calls.push([name, ...args]);
                const a = answers[name];
                if (a instanceof Error) throw a;
                return typeof a === "function" ? a(...args) : (a ?? fallback);
            };
        return {
            calls,
            api: {
                getGroupInfo: rec("getGroupInfo", { gridInfoMap: {} }),
                createGroup: rec("createGroup", { groupId: G, sucessMembers: [], errorMembers: [] }),
                addUserToGroup: rec("addUserToGroup", { errorMembers: [], error_data: {} }),
                removeUserFromGroup: rec("removeUserFromGroup", { errorMembers: [] }),
                leaveGroup: rec("leaveGroup", { memberError: [] }),
            },
        };
    }
    const call = (ga, args, config) =>
        register({ api: ga.api, ...(config && { config }) }).server.call("zalo_group", args);

    it("takes exactly the five actions", () => {
        const schema = register().server.tools.get("zalo_group").meta.inputSchema;
        for (const action of ["leave", "info", "create", "add_members", "remove_member"]) {
            assert.doesNotThrow(() => schema.parse({ action }), action);
        }
        assert.throws(() => schema.parse({ action: "rename" }), "an action outside the list is refused");
        assert.throws(() => schema.parse({ action: "create", userIds: [] }), "an empty member list is refused");
    });

    it("leave passes (groupId, silent) to Zalo: loud by default, quiet only when asked", async () => {
        const ga = groupApi();
        assert.deepEqual(payloadOf(await call(ga, { action: "leave", groupId: G, confirm: true })), {
            action: "leave",
            success: true,
            groupId: G,
            silent: false,
        });
        const quiet = payloadOf(await call(ga, { action: "leave", groupId: G, silent: true, confirm: true }));
        assert.equal(quiet.silent, true);
        // Red if the flag is dropped on the way to zca-js, or defaults to silent.
        assert.deepEqual(ga.calls, [
            ["leaveGroup", G, false],
            ["leaveGroup", G, true],
        ]);
    });

    it("leave explains Zalo's 'not in the group' codes (167 seen live, 166 documented) and passes other failures through", async () => {
        const gone = await call(groupApi({ leaveGroup: new Error("Zalo error (166)") }), {
            action: "leave",
            confirm: true,
            groupId: G,
        });
        assert.equal(gone.isError, true);
        assert.match(gone.content[0].text, /not in group 7000000000000000001/);
        for (const code of [167, 166]) {
            const e = Object.assign(new Error("Không thể rời nhóm"), { code });
            const r = await call(groupApi({ leaveGroup: e }), { action: "leave", groupId: G, confirm: true });
            assert.match(r.content[0].text, /not in group/, `code ${code} read from error.code`);
        }
        const other = await call(groupApi({ leaveGroup: new Error("boom (500)") }), {
            action: "leave",
            groupId: G,
            confirm: true,
        });
        assert.match(other.content[0].text, /boom \(500\)/);
    });

    it("info asks for the group as an array and returns its details, not its members", async () => {
        const ga = groupApi({
            getGroupInfo: {
                gridInfoMap: {
                    [G]: {
                        groupId: G,
                        name: "Team",
                        creatorId: U1,
                        adminIds: [U1],
                        totalMember: 2,
                        memVerList: [`${U1}_0`],
                    },
                },
            },
        });
        const out = payloadOf(await call(ga, { action: "info", groupId: G }));
        assert.deepEqual(ga.calls, [["getGroupInfo", [G]]]);
        assert.equal(out.name, "Team");
        assert.equal(out.creatorId, U1);
        assert.equal(out.totalMember, 2);
        assert.ok(!("memVerList" in out));
        const missing = await call(groupApi(), { action: "info", groupId: G });
        assert.equal(missing.isError, true);
        assert.match(missing.content[0].text, /does not include group/);
    });

    it("create sends { name, members } and reports who was added and who was refused", async () => {
        const ga = groupApi({ createGroup: { groupId: G, sucessMembers: [U1], errorMembers: [U2] } });
        const out = payloadOf(await call(ga, { action: "create", name: "  Team  ", userIds: [U1, U2, U1] }));
        // The name is trimmed and a repeated id is sent once.
        assert.deepEqual(ga.calls, [["createGroup", { name: "Team", members: [U1, U2] }]]);
        assert.deepEqual(out, { action: "create", groupId: G, name: "Team", added: [U1], failed: [U2] });
        const none = await call(groupApi({ createGroup: {} }), { action: "create", name: "X", userIds: [U1] });
        assert.equal(none.isError, true, "no group id back is a failure, not a success");
    });

    it("add_members passes (userIds, groupId) in zca-js's order and splits the outcome", async () => {
        const ga = groupApi({ addUserToGroup: { errorMembers: [U2], error_data: { 270: [U2] } } });
        const out = payloadOf(await call(ga, { action: "add_members", groupId: G, userIds: [U1, U2] }));
        assert.deepEqual(ga.calls, [["addUserToGroup", [U1, U2], G]]);
        assert.deepEqual(out, {
            action: "add_members",
            groupId: G,
            added: [U1],
            failed: [U2],
            errorData: { 270: [U2] },
        });
        // Zalo's reply is a success even when it took nobody; the tool must not say so.
        const all = await call(groupApi({ addUserToGroup: { errorMembers: [U1], error_data: { 270: [U1] } } }), {
            action: "add_members",
            groupId: G,
            userIds: [U1],
        });
        assert.equal(all.isError, true);
        assert.match(all.content[0].text, /did not add any of the 1 member/);
    });

    it("remove_member passes ([userId], groupId), and a refused member is an error", async () => {
        const ga = groupApi();
        assert.deepEqual(
            payloadOf(await call(ga, { action: "remove_member", groupId: G, userId: U1, confirm: true })),
            {
                action: "remove_member",
                success: true,
                groupId: G,
                userId: U1,
            },
        );
        assert.deepEqual(ga.calls, [["removeUserFromGroup", [U1], G]]);
        const refused = await call(groupApi({ removeUserFromGroup: { errorMembers: [U1] } }), {
            action: "remove_member",
            confirm: true,
            groupId: G,
            userId: U1,
        });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text, /did not remove 9100000000000000001/);
    });

    it("remove_member explains Zalo's code 165 (a user who is not in the group), measured live", async () => {
        const e = Object.assign(new Error("Nhóm không có thành viên."), { code: 165 });
        const r = await call(groupApi({ removeUserFromGroup: e }), {
            action: "remove_member",
            groupId: G,
            userId: U1,
            confirm: true,
        });
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /9100000000000000001 is not in group 7000000000000000001/);
    });

    it("refuses missing or malformed ids and names without touching Zalo", async () => {
        const ga = groupApi();
        const text = async (args) => {
            const r = await call(ga, args);
            assert.equal(r.isError, true, JSON.stringify(args));
            return r.content[0].text;
        };
        for (const action of ["leave", "info", "add_members", "remove_member"]) {
            assert.match(await text({ action }), /groupId is required/);
            assert.match(await text({ action, groupId: "abc" }), /numeric Zalo group id/);
        }
        assert.match(await text({ action: "add_members", groupId: G }), /userIds is required/);
        assert.match(await text({ action: "add_members", groupId: G, userIds: [U1, "x;y"] }), /numeric Zalo ids/);
        assert.match(await text({ action: "create", userIds: [U1] }), /name is required/);
        assert.match(await text({ action: "create", name: "   ", userIds: [U1] }), /name is required/);
        assert.match(await text({ action: "create", name: "T" }), /userIds is required/);
        assert.match(await text({ action: "remove_member", groupId: G }), /userId is required/);
        assert.match(await text({ action: "remove_member", groupId: G, userId: "1 2" }), /numeric Zalo id/);
        assert.deepEqual(ga.calls, [], "no refused call reaches Zalo");
    });
});

describe("zalo_group confirm guard", () => {
    const G = "7000000000000000001";
    const U1 = "9100000000000000001";
    const calls = [];
    const api = {
        leaveGroup: async (...a) => (calls.push(["leaveGroup", ...a]), { memberError: [] }),
        removeUserFromGroup: async (...a) => (calls.push(["removeUserFromGroup", ...a]), { errorMembers: [] }),
        createGroup: async (...a) => (calls.push(["createGroup", ...a]), { groupId: G, errorMembers: [] }),
        addUserToGroup: async (...a) => (calls.push(["addUserToGroup", ...a]), { errorMembers: [] }),
        getGroupInfo: async (...a) => (calls.push(["getGroupInfo", ...a]), { gridInfoMap: { [G]: { name: "T" } } }),
    };
    const run = (args, config) => register({ api, ...(config && { config }) }).server.call("zalo_group", args);
    const LEAVE = { action: "leave", groupId: G };
    const REMOVE = { action: "remove_member", groupId: G, userId: U1 };

    /** Run `fn` with ZALO_MCP_GROUP_CONFIRM set (or removed), then put the environment back. */
    async function withEnv(value, fn) {
        const saved = process.env.ZALO_MCP_GROUP_CONFIRM;
        if (value === undefined) delete process.env.ZALO_MCP_GROUP_CONFIRM;
        else process.env.ZALO_MCP_GROUP_CONFIRM = value;
        try {
            return await fn();
        } finally {
            if (saved === undefined) delete process.env.ZALO_MCP_GROUP_CONFIRM;
            else process.env.ZALO_MCP_GROUP_CONFIRM = saved;
        }
    }
    beforeEach(() => {
        calls.length = 0;
    });

    it("refuses leave and remove_member without confirm: true, says how to retry, and never reaches Zalo", async () => {
        await withEnv(undefined, async () => {
            for (const args of [LEAVE, REMOVE, { ...LEAVE, confirm: false }, { ...REMOVE, confirm: false }]) {
                const r = await run(args);
                assert.equal(r.isError, true, JSON.stringify(args));
                assert.match(r.content[0].text, /Repeat the call with confirm: true/);
            }
            assert.match((await run(LEAVE)).content[0].text, /leave group 7000000000000000001/);
            assert.match(
                (await run(REMOVE)).content[0].text,
                /remove 9100000000000000001 from group 7000000000000000001/,
            );
            // Red if the guard runs after the Zalo call, or is skipped.
            assert.deepEqual(calls, []);
        });
    });

    it("goes ahead with confirm: true, with no other step (nothing waits for a person)", async () => {
        await withEnv(undefined, async () => {
            assert.equal(payloadOf(await run({ ...LEAVE, confirm: true })).success, true);
            assert.equal(payloadOf(await run({ ...REMOVE, confirm: true })).success, true);
            assert.deepEqual(calls, [
                ["leaveGroup", G, false],
                ["removeUserFromGroup", [U1], G],
            ]);
        });
    });

    it("guards only the irreversible actions: info, create and add_members need no confirm", async () => {
        await withEnv(undefined, async () => {
            for (const args of [
                { action: "info", groupId: G },
                { action: "create", name: "T", userIds: [U1] },
                { action: "add_members", groupId: G, userIds: [U1] },
            ]) {
                assert.notEqual((await run(args)).isError, true, args.action);
            }
        });
    });

    it("groupConfirm: false in the config switches the check off, for a backend that never sends confirm", async () => {
        await withEnv(undefined, async () => {
            assert.equal(payloadOf(await run(LEAVE, { groupConfirm: false })).success, true);
            assert.equal(payloadOf(await run(REMOVE, { groupConfirm: false })).success, true);
            // Only an explicit false turns it off; any other value keeps it on.
            assert.equal((await run(LEAVE, { groupConfirm: "no" })).isError, true);
            assert.equal((await run(LEAVE, {})).isError, true);
        });
    });

    it("ZALO_MCP_GROUP_CONFIRM switches the check off or on, and wins over the config", async () => {
        for (const off of ["0", "false", "OFF", " no "]) {
            await withEnv(off, async () => {
                assert.equal(payloadOf(await run(LEAVE)).success, true, `env=${off}`);
            });
        }
        await withEnv("1", async () => {
            assert.equal((await run(LEAVE, { groupConfirm: false })).isError, true, "env on beats config off");
        });
        await withEnv("0", async () => {
            assert.equal(payloadOf(await run(LEAVE, { groupConfirm: true })).success, true, "env off beats config on");
        });
        await withEnv("maybe", async () => {
            assert.equal((await run(LEAVE)).isError, true, "an unrecognized value leaves the check on");
        });
    });

    it("a bad id is reported as a bad id, before the confirm question", async () => {
        await withEnv(undefined, async () => {
            assert.match((await run({ action: "leave", groupId: "abc" })).content[0].text, /numeric Zalo group id/);
            assert.match((await run({ action: "remove_member", groupId: G })).content[0].text, /userId is required/);
        });
    });

    it("the default config ships the check on", async () => {
        const { getDefaultConfig } = await import("../../src/mcp/mcp-config.js");
        assert.equal(getDefaultConfig().groupConfirm, true);
    });
});
