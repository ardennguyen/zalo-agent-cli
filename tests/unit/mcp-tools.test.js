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
import { createStageLock } from "../../src/core/daemon-channel.js";
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
});
