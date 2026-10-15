import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { readUserAliases, resolveCurrentUserNames, withCurrentSenderNames } from "../../src/core/current-user-names.js";
import { SyncV2 } from "../../src/core/sync-v2/index.js";
import { createSenderResolver } from "../../src/core/sync-v2/senders.js";
import { ThreadNameCache } from "../../src/mcp/thread-name-cache.js";
import { initDb, insertMessage, getMessages, upsertThread, getRecentThreads } from "../../src/core/db.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";

const NOISED = "VNOISED0000000000000000000000001";
before(() => assertSandboxed(CONFIG_DIR));

function apiNames() {
    const state = { alias: "My Alias", zaloName: "Current Profile" };
    return {
        state,
        getAliasList: async () => ({ items: state.alias ? [{ userId: "101", alias: state.alias }] : [] }),
        getUserInfo: async (ids) => ({
            changed_profiles: Object.fromEntries(
                ids.map((id) => [id, { zaloName: state.zaloName, displayName: "Server Display" }]),
            ),
        }),
        getAllFriends: async () => [
            { userId: "101", globalId: NOISED, zaloName: state.zaloName, displayName: "Server Display" },
        ],
        getAllGroups: async () => ({ gridVerMap: {} }),
    };
}

describe("current user labels", () => {
    it("prefers an explicit alias, then the Zalo profile, and observes rename/removal on the next read", async () => {
        const api = apiNames();
        assert.deepEqual((await resolveCurrentUserNames(api, ["101"])).get("101"), {
            name: "My Alias",
            source: "alias",
        });
        api.state.alias = "Renamed Alias";
        assert.equal((await resolveCurrentUserNames(api, ["101"])).get("101").name, "Renamed Alias");
        api.state.alias = "";
        assert.deepEqual((await resolveCurrentUserNames(api, ["101"])).get("101"), {
            name: "Current Profile",
            source: "zalo",
        });
        api.state.zaloName = "Renamed Profile";
        assert.equal((await resolveCurrentUserNames(api, ["101"])).get("101").name, "Renamed Profile");
    });

    it("keeps aliases scoped to the account and does not mutate historical message rows", async () => {
        const a = apiNames();
        const b = apiNames();
        b.state.alias = "Other Account Alias";
        const row = { senderId: "101", senderName: "Historical Name", threadId: "202" };
        const [first, second] = await Promise.all([withCurrentSenderNames(a, [row]), withCurrentSenderNames(b, [row])]);
        assert.equal(first[0].senderDisplayName, "My Alias");
        assert.equal(second[0].senderDisplayName, "Other Account Alias");
        assert.equal(first[0].senderName, "Historical Name");
        assert.equal(row.senderDisplayName, undefined);
        assert.equal(row.senderName, "Historical Name");
    });

    it("uses the peer UID for outgoing DM titles, never the sender's name", async () => {
        const rows = await withCurrentSenderNames(
            apiNames(),
            [{ senderId: "999", senderName: "Self", threadId: "101" }],
            ["101"],
        );
        assert.equal(rows[0].threadName, "My Alias");
        assert.equal(rows[0].senderDisplayName, "Current Profile");
        assert.equal(rows[0].senderName, "Self");
    });

    it("falls back to UID on profile failure, including after a previously successful read", async () => {
        const api = apiNames();
        await resolveCurrentUserNames(api, ["101"]);
        api.getAliasList = async () => {
            throw new Error("offline");
        };
        api.getUserInfo = async () => {
            throw new Error("offline");
        };
        const current = (await resolveCurrentUserNames(api, ["101"])).get("101");
        assert.deepEqual(current, { name: "101", source: "uid" });
    });

    it("still uses an alias when the profile endpoint fails", async () => {
        const api = apiNames();
        api.getUserInfo = async () => {
            throw new Error("offline");
        };
        assert.equal((await resolveCurrentUserNames(api, ["101"])).get("101").source, "alias");
    });

    it("keeps cached history readable when the live API proxy is temporarily unavailable", async () => {
        const api = new Proxy(
            {},
            {
                get() {
                    throw new Error("session is reconnecting");
                },
            },
        );
        const messages = await withCurrentSenderNames(api, [{ senderId: "101", senderName: "Historical Name" }]);
        assert.equal(messages[0].senderDisplayName, "101");
        assert.equal(messages[0].senderName, "Historical Name");
    });

    it("does not mistake an ambiguous displayName for a verified Zalo profile name", async () => {
        const names = await resolveCurrentUserNames(
            {
                getUserInfo: async () => ({
                    changed_profiles: {
                        101: { displayName: "Possibly An Old Alias" },
                    },
                }),
            },
            ["101"],
        );
        assert.deepEqual(names.get("101"), { name: "101", source: "uid" });
    });

    it("reads alias pages and deduplicates profile requests in batches of 100", async () => {
        const pages = [];
        const batches = [];
        const api = {
            getAliasList: async (count, page) => {
                pages.push([count, page]);
                return {
                    items:
                        page === 1
                            ? Array.from({ length: 100 }, (_, i) => ({ userId: String(i + 1), alias: `Alias ${i}` }))
                            : [{ userId: "101", alias: "Last Alias" }],
                };
            },
            getUserInfo: async (ids) => {
                batches.push(ids);
                return { unchanged_profiles: Object.fromEntries(ids.map((id) => [id, { zaloName: `Profile ${id}` }])) };
            },
        };
        const names = await resolveCurrentUserNames(api, [
            ...Array.from({ length: 101 }, (_, i) => String(i + 1)),
            "101",
        ]);
        assert.deepEqual(pages, [
            [100, 1],
            [100, 2],
        ]);
        assert.deepEqual(
            batches.map((b) => b.length),
            [100, 1],
        );
        assert.equal(names.get("101").name, "Last Alias");
    });

    it("discards a partial alias snapshot rather than declaring it complete", async () => {
        const aliases = await readUserAliases({
            getAliasList: async (_count, page) => {
                if (page === 2) throw new Error("failed page");
                return { items: Array.from({ length: 100 }, (_, i) => ({ userId: String(i + 1), alias: "Partial" })) };
            },
        });
        assert.equal(aliases.size, 0);
    });

    it("stops an alias endpoint that keeps repeating the same full page", async () => {
        let calls = 0;
        const aliases = await readUserAliases({
            getAliasList: async () => {
                calls++;
                return { items: Array.from({ length: 100 }, (_, i) => ({ userId: String(i + 1), alias: "Repeated" })) };
            },
        });
        assert.equal(calls, 2);
        assert.equal(aliases.size, 0);
    });

    it("does not send opaque unresolved sender IDs to getUserInfo", async () => {
        const rows = await withCurrentSenderNames({ getUserInfo: async () => assert.fail("not a numeric UID") }, [
            { senderId: NOISED, senderName: null },
        ]);
        assert.equal(rows[0].senderDisplayName, NOISED);
        assert.equal(rows[0].senderName, null);
    });
});

describe("current DM names and immutable message snapshots", () => {
    let db;
    let seq = 0;
    beforeEach(() => {
        db = initDb(join(SANDBOX_CONFIG_DIR, `current-${seq++}.sqlite`));
    });
    afterEach(() => db.close());

    it("refreshes cached DM titles during sync even without new messages and preserves activity ordering", async () => {
        const api = apiNames();
        const sync = new SyncV2(api, "example-account");
        upsertThread({ threadId: "101", type: "dm", name: "Old Alias", lastUpdate: 1000 });
        upsertThread({ threadId: "303", type: "group", name: "Group Name", lastUpdate: 2000 });
        upsertThread({ threadId: "404", type: "dm", name: "Old Nonfriend Name", lastUpdate: 500 });
        let map = await sync._buildThreadMap(() => {});
        sync._refreshThreadNames(map);
        await sync._refreshDmNames(map);
        assert.equal(getRecentThreads(10, "dm")[0].name, "My Alias");
        assert.equal(getRecentThreads(10, "dm")[1].name, "Current Profile");
        const sender = createSenderResolver(api, map).get(NOISED);
        assert.equal(sender.name, "Current Profile", "an alias is not the historical sender name");
        api.state.alias = "";
        api.state.zaloName = "New Profile";
        map = await sync._buildThreadMap(() => {});
        sync._refreshThreadNames(map);
        assert.equal(getRecentThreads(10, "dm")[0].name, "New Profile");
        assert.equal(getRecentThreads(10, "dm")[0].lastUpdate, 1000);
        assert.equal(getRecentThreads(10, "group")[0].name, "Group Name");
    });

    it("MCP history returns the current alias while SQLite and senderName retain the historical name", async () => {
        const api = apiNames();
        insertMessage({
            msgId: "history-1",
            threadId: "202",
            senderId: "101",
            senderName: "Historical Name",
            text: "Example",
            timestamp: 1000,
            type: "text",
            raw_data: {},
        });
        const handlers = new Map();
        registerTools({ registerTool: (n, _m, h) => handlers.set(n, h) }, api, {}, {}, {}, { get: () => null });
        const read = async () =>
            JSON.parse(
                (await handlers.get("zalo_get_history")({ threadId: "202", threadType: 1, limit: 10 })).content[0].text,
            ).messages[0];
        assert.equal((await read()).senderDisplayName, "My Alias");
        api.state.alias = "";
        api.state.zaloName = "Renamed Profile";
        const message = await read();
        assert.equal(message.senderDisplayName, "Renamed Profile");
        assert.equal(message.senderName, "Historical Name");
        assert.equal(getMessages("202", 10)[0].senderName, "Historical Name");
    });

    it("refreshes DM search labels after alias removal without renaming groups", async () => {
        const api = apiNames();
        const cache = new ThreadNameCache();
        await cache.init(api);
        cache.set("303", { type: "group", name: "Group Name" });
        assert.equal(cache.search("My Alias", "dm")[0].threadId, "101");
        api.state.alias = "";
        api.state.zaloName = "New Profile";
        await cache.refreshUsers(api);
        assert.equal(cache.search("My Alias", "dm").length, 0);
        assert.equal(cache.get("101").name, "New Profile");
        assert.equal(cache.get("303").name, "Group Name");
    });

    it("MCP buffered messages display current names without rewriting the buffer's historical name", async () => {
        const api = apiNames();
        const original = {
            msgId: "buffered-1",
            senderId: "101",
            senderName: "Historical Name",
            threadId: "202",
            timestamp: 1000,
        };
        const handlers = new Map();
        registerTools(
            { registerTool: (n, _m, h) => handlers.set(n, h) },
            api,
            {
                readCursor: () => 0,
                read: () => ({ messages: [original], cursor: 1 }),
                getThreadType: () => "group",
            },
            {},
            {},
            { get: () => null },
        );
        const response = await handlers.get("zalo_get_messages")({ since: 0, limit: 10 });
        const row = JSON.parse(response.content[0].text).messages[0];
        assert.equal(row.senderDisplayName, "My Alias");
        assert.equal(row.senderName, "Historical Name");
        assert.equal(original.senderDisplayName, undefined);
        assert.equal(original.senderName, "Historical Name");
    });

    it("MCP recent conversations resolve DM names by peer UID while preserving group titles and activity", async () => {
        const api = apiNames();
        upsertThread({ threadId: "101", type: "dm", name: "Old Alias", lastUpdate: 1000 });
        upsertThread({ threadId: "303", type: "group", name: "Group Name", lastUpdate: 2000 });
        const handlers = new Map();
        registerTools({ registerTool: (n, _m, h) => handlers.set(n, h) }, api, {}, {}, {}, { get: () => null });
        const read = async () =>
            JSON.parse((await handlers.get("zalo_list_conversations")({ type: "all", limit: 10 })).content[0].text)
                .conversations;
        let conversations = await read();
        assert.equal(conversations.find((c) => c.threadId === "101").name, "My Alias");
        assert.equal(conversations.find((c) => c.threadId === "303").name, "Group Name");
        api.state.alias = "";
        conversations = await read();
        assert.equal(conversations.find((c) => c.threadId === "101").name, "Current Profile");
        assert.equal(conversations.find((c) => c.threadId === "101").lastActivity, 1000);
        assert.equal(getRecentThreads(10, "dm")[0].name, "Old Alias", "a display read never writes the database");
    });
});
