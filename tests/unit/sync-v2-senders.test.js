import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { SENDER_RETRY_DELAYS_MS, createSenderResolver } from "../../src/core/sync-v2/senders.js";
import { initDb, insertMessage, getMessages } from "../../src/core/db.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";

const FRIEND = "VNOISED0000000000000000000000001";
const MEMBER = "VNOISED0000000000000000000000002";
const GROUP = "VNOISED0000000000000000000000003";
const UNKNOWN = "VNOISED0000000000000000000000004";

before(() => assertSandboxed(CONFIG_DIR));

/** No waiting between attempts; records the pauses a resolver asked for. */
const quick = () => {
    const pauses = [];
    return { pauses, sleep: async (ms) => void pauses.push(ms) };
};

describe("sync sender identity resolution", () => {
    it("uses only user mappings, batches unknown group senders, and caches results across chunks", async () => {
        const calls = [];
        const map = new Map([
            [FRIEND, { id: "101", name: "Example Friend", type: "dm" }],
            [GROUP, { id: "303", name: "Example Group", type: "group" }],
        ]);
        const resolver = createSenderResolver({}, map, {
            ...quick(),
            resolveUsers: async (_api, ids) => {
                calls.push(ids);
                return new Map([[MEMBER, { id: "202", name: "Example Member" }]]);
            },
        });
        await resolver.prepare([FRIEND, MEMBER, MEMBER, GROUP, UNKNOWN].map((senderId) => ({ senderId })));
        // what resolved is not asked for again; what did not is asked for twice more (Y9)
        assert.deepEqual(calls, [
            [MEMBER, GROUP, UNKNOWN],
            [GROUP, UNKNOWN],
            [GROUP, UNKNOWN],
        ]);
        assert.deepEqual(resolver.get(FRIEND), { id: "101", name: "Example Friend" });
        assert.deepEqual(resolver.get(MEMBER), { id: "202", name: "Example Member" });
        assert.deepEqual(resolver.get(GROUP), { id: GROUP, name: "" }, "a group name is never a person's name");
        assert.deepEqual(resolver.get(UNKNOWN), { id: UNKNOWN, name: "" });
        await resolver.prepare([{ senderId: MEMBER }, { senderId: UNKNOWN }]);
        assert.equal(calls.length, 3, "an id asked for in this restore is not asked for again in a later chunk");
    });

    it("uses user mappings added by conversation resolution after construction", async () => {
        const map = new Map();
        const resolver = createSenderResolver({}, map, {
            resolveUsers: async () => assert.fail("the conversation already resolved this user"),
        });
        map.set(MEMBER, { id: "202", name: "Example Member", type: "dm" });
        await resolver.prepare([{ senderId: MEMBER }]);
        assert.deepEqual(resolver.get(MEMBER), { id: "202", name: "Example Member" });
    });

    it("preserves missing and numeric IDs without guessing the sender from the conversation", async () => {
        const resolver = createSenderResolver({}, new Map(), {
            resolveUsers: async () => assert.fail("there are no global IDs to resolve"),
        });
        await resolver.prepare([{ senderId: "101" }, {}, { senderId: "0" }]);
        assert.deepEqual(resolver.get("101"), { id: "101", name: "" });
        assert.deepEqual(resolver.get(undefined), { id: "", name: "" });
        assert.deepEqual(resolver.get("0"), { id: "0", name: "" });
    });

    it("keeps unresolved IDs on lookup failure, after three tries and without retrying every message", async () => {
        let calls = 0;
        const resolver = createSenderResolver({}, new Map(), {
            ...quick(),
            resolveUsers: async () => {
                calls++;
                throw new Error("profile service unavailable");
            },
        });
        await resolver.prepare([{ senderId: MEMBER }]);
        await resolver.prepare([{ senderId: MEMBER }]);
        assert.equal(calls, 3, "the first try and two retries, once per restore");
        assert.deepEqual(resolver.get(MEMBER), { id: MEMBER, name: "" });
    });

    it("asks again after 0.5 s and 1.5 s, and stops as soon as the sender resolves (Y9)", async () => {
        const wait = quick();
        let calls = 0;
        const resolver = createSenderResolver({}, new Map(), {
            ...wait,
            resolveUsers: async () => {
                calls++;
                if (calls < 2) throw new Error("profile service unavailable");
                return new Map([[MEMBER, { id: "202", name: "Example Member" }]]);
            },
        });
        await resolver.prepare([{ senderId: MEMBER }]);
        assert.equal(calls, 2);
        assert.deepEqual(wait.pauses, [500], "one pause, before the second try");
        assert.deepEqual(resolver.get(MEMBER), { id: "202", name: "Example Member" });
        assert.deepEqual(SENDER_RETRY_DELAYS_MS, [500, 1500]);
    });

    it("pauses 0.5 s, then 1.5 s, when nothing ever resolves", async () => {
        const wait = quick();
        const resolver = createSenderResolver({}, new Map(), {
            ...wait,
            resolveUsers: async () => new Map(),
        });
        await resolver.prepare([{ senderId: MEMBER }]);
        assert.deepEqual(wait.pauses, [500, 1500]);
    });

    it("rejects a purported resolution that is not a canonical user ID", async () => {
        const resolver = createSenderResolver({}, new Map(), {
            ...quick(),
            resolveUsers: async () => new Map([[MEMBER, { id: UNKNOWN, name: "Wrong Identity" }]]),
        });
        await resolver.prepare([{ senderId: MEMBER }]);
        assert.deepEqual(resolver.get(MEMBER), { id: MEMBER, name: "" });
    });
});

describe("re-sync identity enrichment in SQLite and MCP", () => {
    let db;
    let seq = 0;
    beforeEach(() => {
        db = initDb(join(SANDBOX_CONFIG_DIR, `senders-${seq++}.sqlite`));
    });
    afterEach(() => db.close());

    const row = (extra = {}) => ({
        msgId: "message-1",
        threadId: "group-1",
        senderId: MEMBER,
        senderName: "",
        text: "Example message",
        timestamp: 1000,
        type: "text",
        raw_data: {},
        ...extra,
    });

    it("repairs an existing synced sender and returns its UID and name through MCP history", async () => {
        insertMessage(row());
        const resolver = createSenderResolver({}, new Map(), {
            resolveUsers: async () => new Map([[MEMBER, { id: "202", name: "Example Member" }]]),
        });
        await resolver.prepare([{ senderId: MEMBER }]);
        const sender = resolver.get(MEMBER);
        insertMessage(row({ senderId: sender.id, senderName: sender.name }));
        const handlers = new Map();
        registerTools(
            { registerTool: (name, _meta, handler) => handlers.set(name, handler) },
            {},
            { getThreadType: () => "group" },
            {},
            { limits: { maxMessagesPerPoll: 20 } },
            { get: () => "Example Group" },
        );
        const response = await handlers.get("zalo_get_history")({ threadId: "group-1", limit: 10, threadType: 1 });
        const history = JSON.parse(response.content[0].text);
        assert.equal(history.source, "cache");
        assert.equal(history.messages.length, 1);
        assert.equal(history.messages[0].senderId, "202");
        assert.equal(history.messages[0].senderName, "Example Member");
    });

    it("fills a missing name for the same canonical user", () => {
        insertMessage(row({ senderId: "202", senderName: null }));
        insertMessage(row({ senderId: "202", senderName: "Example Member" }));
        assert.equal(getMessages("group-1", 10)[0].senderName, "Example Member");
    });

    it("does not regress a live identity, overwrite its name, or accept a conflicting numeric sender", () => {
        insertMessage(row({ senderId: "202", senderName: "Live Name" }));
        insertMessage(row());
        insertMessage(row({ senderId: "202", senderName: "Older Name" }));
        insertMessage(row({ senderId: "999", senderName: "Wrong Identity" }));
        const stored = getMessages("group-1", 10)[0];
        assert.equal(stored.senderId, "202");
        assert.equal(stored.senderName, "Live Name");
    });

    it("does not attach a conflicting sender's name to a canonical UID with no name", () => {
        insertMessage(row({ senderId: "202" }));
        insertMessage(row({ senderId: "999", senderName: "Wrong Identity" }));
        assert.equal(getMessages("group-1", 10)[0].senderName, "");
    });

    it("preserves a recall tombstone, attachment path and read state while repairing identity", () => {
        insertMessage(
            row({ type: "deleted", text: "", raw_data: { removedAs: "recall" }, localPath: "image.jpg", msgStatus: 5 }),
        );
        insertMessage(row({ senderId: "202", senderName: "Example Member", msgStatus: 1 }));
        const stored = getMessages("group-1", 10)[0];
        assert.equal(stored.senderId, "202");
        assert.equal(stored.senderName, "Example Member");
        assert.equal(stored.type, "deleted");
        assert.equal(stored.text, "");
        assert.equal(stored.localPath, "image.jpg");
        assert.equal(stored.msgStatus, 5);
        assert.equal(JSON.parse(stored.raw_data).removedAs, "recall");
    });
});
