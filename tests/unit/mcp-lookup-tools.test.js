/**
 * The MCP tools that look something up: `zalo_get_group_members`,
 * `zalo_list_conversations` and `zalo_coverage`.
 *
 * The first two mirror `group members` and `conv recent` through the same
 * code (src/core/group-members.js, src/core/recent-conversations.js), whose
 * CLI output is pinned in conv-recent-group-members.test.js. `zalo_coverage`
 * reads the `sync_gaps` bookkeeping the daemon writes and dates its advice
 * with src/core/sync-v2/gap-advice.js, as `listen` does.
 *
 * The handlers run against fakes for the api and a real zalo.db in the sandbox.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import {
    initDb,
    insertMessage,
    upsertThread,
    upsertContact,
    recordSyncGap,
    resolveSyncGap,
} from "../../src/core/db.js";

/** Made-up ids. None of them belongs to anyone. */
const GROUP = "200000000000000092";
const A = "500000000000000092";
const B = "500000000000000093";
const C = "500000000000000094";

/** A fake member uid, built at run time so no id-length literal lands in this file. */
const member = (i) => `5${"0".repeat(14)}${String(i).padStart(3, "0")}`;

const ROOT = mkdtempSync(join(SANDBOX_HOME, "mcp-lookups-"));
const handles = [];
let n = 0;

before(() => assertSandboxed(CONFIG_DIR));
beforeEach(() => handles.push(initDb(join(ROOT, `lookups${n++}.sqlite`))));
after(() => {
    for (const h of handles) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
});

/** Records what registerTools() registers, standing in for McpServer. */
function fakeServer() {
    const tools = new Map();
    return {
        tools,
        registerTool(name, meta, handler) {
            tools.set(name, { meta, handler });
        },
        call(name, args) {
            return tools.get(name).handler(args);
        },
    };
}

/** Register the tools over `api` (and a thread index) and call one. */
async function call(name, args, api = {}, nameCache = { ready: true, get: () => null, search: () => [] }) {
    const server = fakeServer();
    const buffer = {
        read: () => ({ messages: [] }),
        getStats: () => [],
        getThreadType: () => "dm",
        readCursor: () => 0,
    };
    registerTools(server, api, buffer, {}, { limits: {} }, nameCache);
    return server.call(name, args);
}

const payloadOf = (r) => JSON.parse(r.content[0].text);

describe("zalo_get_group_members", () => {
    /**
     * An api whose getGroupInfo lists `uids` in memVerList and whose
     * getGroupMembersInfo answers from `profiles` (uid → name), recording both.
     */
    function groupApi({ uids, totalMember = uids.length, profiles = {}, found = true, namesFail = null }) {
        const infoCalls = [];
        const nameCalls = [];
        return {
            infoCalls,
            nameCalls,
            getGroupInfo: async (ids) => {
                infoCalls.push(ids);
                const entry = { groupId: GROUP, name: "Nhóm thử", memberIds: [], totalMember };
                entry.memVerList = uids.map((u, i) => `${u}_${i % 3}`);
                return { removedsGroup: [], unchangedsGroup: [], gridInfoMap: found ? { [GROUP]: entry } : {} };
            },
            getGroupMembersInfo: async (ids) => {
                nameCalls.push(ids);
                if (namesFail) throw namesFail;
                const out = {};
                // Keys come back with zca-js's "_0" suffix, as live answers do.
                for (const id of ids) if (profiles[id]) out[`${id}_0`] = { displayName: profiles[id] };
                return { profiles: out };
            },
        };
    }

    it("lists every member, named from the cache first and by Zalo for the rest", async () => {
        // A has spoken in a cached conversation; B and C never have.
        insertMessage({
            msgId: "7100000000092",
            threadId: GROUP,
            senderId: A,
            senderName: "Chị Lan",
            text: "hi",
            timestamp: 1700000000000,
            type: "text",
            raw_data: "{}",
            has_attachment: 0,
        });
        const api = groupApi({ uids: [A, B, C], profiles: { [B]: "Anh Minh", [C]: "Bích Ngọc" } });
        const out = payloadOf(await call("zalo_get_group_members", { groupId: GROUP }, api));

        assert.deepEqual(api.infoCalls, [[GROUP]], "getGroupInfo takes an array holding the one group");
        // Red if the cache is skipped (A would be asked for too), or the
        // lookup is made per member instead of batched.
        assert.deepEqual(api.nameCalls, [[B, C]]);
        // Red if a "_version" suffix survives in a uid, or "_0" in a name key.
        assert.deepEqual(out.members, [
            { uid: A, displayName: "Chị Lan" },
            { uid: B, displayName: "Anh Minh" },
            { uid: C, displayName: "Bích Ngọc" },
        ]);
        assert.equal(out.groupId, GROUP);
        assert.equal(out.name, "Nhóm thử");
        assert.equal(out.count, 3);
        assert.equal(out.warnings, undefined);
    });

    it("asks Zalo for no names when the cache has them all", async () => {
        upsertContact({ userId: A, name: "Chị Lan", phone: null });
        upsertContact({ userId: B, name: "Anh Minh", phone: null });
        const api = groupApi({ uids: [A, B] });
        const out = payloadOf(await call("zalo_get_group_members", { groupId: GROUP }, api));
        assert.deepEqual(api.nameCalls, [], "every name was local, so no second request");
        assert.deepEqual(
            out.members.map((m) => m.displayName),
            ["Chị Lan", "Anh Minh"],
        );
    });

    it("asks for names 50 at a time, one request after another", async () => {
        const uids = Array.from({ length: 120 }, (_, i) => member(i));
        const api = groupApi({ uids, profiles: Object.fromEntries(uids.map((u) => [u, `Thành viên ${u.slice(-3)}`])) });
        const out = payloadOf(await call("zalo_get_group_members", { groupId: GROUP }, api));
        // Red if the batch goes (one 120-id URL) or the size changes.
        assert.deepEqual(
            api.nameCalls.map((ids) => ids.length),
            [50, 50, 20],
        );
        assert.deepEqual(api.nameCalls.flat(), uids, "every member asked for once, in order");
        assert.equal(out.members[119].displayName, "Thành viên 119");
    });

    it("totalMember is Zalo's own count, which can exceed the members it listed", async () => {
        const api = groupApi({ uids: [A, B, C], totalMember: 5 });
        const out = payloadOf(await call("zalo_get_group_members", { groupId: GROUP }, api));
        assert.equal(out.totalMember, 5);
        assert.equal(out.count, 3);
    });

    it("a failed name lookup still lists the members, unnamed, and says so", async () => {
        const api = groupApi({ uids: [A, B], namesFail: new Error("HTTP 414") });
        const r = await call("zalo_get_group_members", { groupId: GROUP }, api);
        assert.equal(r.isError, undefined, "the member list does not depend on the names");
        const out = payloadOf(r);
        assert.deepEqual(out.members, [
            { uid: A, displayName: null },
            { uid: B, displayName: null },
        ]);
        assert.match(out.warnings[0], /did not name 2 member\(s\): HTTP 414/);
    });

    it("a group missing from Zalo's answer is an error, not an empty group", async () => {
        const api = groupApi({ uids: [], found: false });
        const r = await call("zalo_get_group_members", { groupId: GROUP }, api);
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /does not include group/);
        assert.deepEqual(api.nameCalls, []);
    });
});

describe("zalo_list_conversations", () => {
    const seed = () => {
        upsertThread({ threadId: "d1", type: "dm", name: "Chị Lan", lastUpdate: 1700000001000 });
        upsertThread({ threadId: "g1", type: "group", name: "Nhóm A", lastUpdate: 1700000002000 });
        upsertThread({ threadId: "d2", type: "dm", name: "Anh Minh", lastUpdate: 1700000004000 });
        upsertThread({ threadId: "g2", type: "group", name: "Nhóm B", lastUpdate: 1700000003000 });
    };

    it("lists cached conversations newest first, with type, name and last activity", async () => {
        seed();
        const out = payloadOf(await call("zalo_list_conversations", { type: "all", limit: 20 }));
        // Red if the order stops being lastUpdate descending.
        assert.deepEqual(
            out.conversations.map((c) => c.threadId),
            ["d2", "g2", "g1", "d1"],
        );
        assert.deepEqual(out.conversations[1], {
            threadId: "g2",
            type: "group",
            threadType: 1,
            name: "Nhóm B",
            lastActivity: 1700000003000,
            lastActivityAt: new Date(1700000003000).toISOString(),
            readState: null,
        });
        assert.equal(out.conversations[0].threadType, 0, "a DM is threadType 0, ready for zalo_send_message");
        assert.equal(out.total, 4);
        assert.equal(out.source, "cache");
    });

    it("limit is per type, as `conv recent -n` is", async () => {
        seed();
        const out = payloadOf(await call("zalo_list_conversations", { type: "all", limit: 1 }));
        // Red if limit becomes a global cap (one row).
        assert.deepEqual(
            out.conversations.map((c) => c.threadId),
            ["d2", "g2"],
        );
    });

    it("type 'group' returns the newest groups, not the groups among the newest threads", async () => {
        seed();
        const out = payloadOf(await call("zalo_list_conversations", { type: "group", limit: 1 }));
        assert.deepEqual(
            out.conversations.map((c) => c.threadId),
            ["g2"],
        );
    });

    it("a thread the cache has no name for takes the thread index's", async () => {
        upsertThread({ threadId: "d9", type: "dm", name: null, lastUpdate: 1700000009000 });
        const index = { ready: true, get: (id) => (id === "d9" ? { name: "Chú Tư" } : null), search: () => [] };
        const out = payloadOf(await call("zalo_list_conversations", { type: "all", limit: 20 }, {}, index));
        assert.equal(out.conversations[0].name, "Chú Tư");
    });

    it("an empty cache answers with no conversations and says why, without asking Zalo", async () => {
        const nothing = new Proxy(
            {},
            {
                get: (_t, prop) => () => {
                    throw new Error(`zalo_list_conversations must not call api.${String(prop)}`);
                },
            },
        );
        const r = await call("zalo_list_conversations", { type: "all", limit: 20 }, nothing);
        assert.equal(r.isError, undefined, r.content[0].text);
        const out = payloadOf(r);
        assert.deepEqual(out.conversations, []);
        assert.match(out.note, /zalo-agent sync/);
    });
});

describe("zalo_coverage", () => {
    // Two gaps on different UTC days, recorded newest first to show the
    // report orders them itself.
    const RECENT = { from: Date.UTC(2026, 8, 30, 8, 0), to: Date.UTC(2026, 8, 30, 9, 0) };
    const OLDER = { from: Date.UTC(2026, 8, 28, 23, 30), to: Date.UTC(2026, 8, 29, 1, 0) };

    it("lists the pending gaps oldest first, each with from, to, reason and span", async () => {
        recordSyncGap(RECENT.from, RECENT.to, "startup-gap");
        recordSyncGap(OLDER.from, OLDER.to, "reconnect-gap");
        const out = payloadOf(await call("zalo_coverage", {}));

        assert.equal(out.pendingCount, 2);
        assert.deepEqual(
            out.pending.map((g) => [g.reason, g.from, g.to, g.span]),
            [
                ["reconnect-gap", new Date(OLDER.from).toISOString(), new Date(OLDER.to).toISOString(), "1h 30m"],
                ["startup-gap", new Date(RECENT.from).toISOString(), new Date(RECENT.to).toISOString(), "1h 0m"],
            ],
        );
        assert.equal(out.pending[0].fromTs, OLDER.from);
        assert.equal(out.pending[1].command, "zalo-agent sync --from 2026-09-30");
    });

    it("names one sync run dated from the oldest gap's day, so it resolves them all", async () => {
        recordSyncGap(RECENT.from, RECENT.to, "startup-gap");
        recordSyncGap(OLDER.from, OLDER.to, "reconnect-gap");
        const out = payloadOf(await call("zalo_coverage", {}));
        // A restore resolves only the gaps lying wholly inside its window, so a
        // run dated from the newer gap would succeed and leave the older one
        // pending. Red if the command is dated from anything but 2026-09-28.
        assert.equal(out.command, "zalo-agent sync --from 2026-09-28");
        assert.match(out.hint, /zalo-agent sync --from 2026-09-28/);
        assert.match(out.hint, /ĐỒNG BỘ NGAY/, "says the phone will ask for a tap");
    });

    it("counts the gaps already resolved, and leaves them out of the pending list", async () => {
        const closed = recordSyncGap(OLDER.from, OLDER.to, "reconnect-gap");
        recordSyncGap(RECENT.from, RECENT.to, "startup-gap");
        resolveSyncGap(closed);
        const out = payloadOf(await call("zalo_coverage", {}));
        assert.equal(out.resolvedCount, 1);
        assert.equal(out.pendingCount, 1);
        assert.deepEqual(
            out.pending.map((g) => g.reason),
            ["startup-gap"],
        );
        assert.equal(out.command, "zalo-agent sync --from 2026-09-30");
    });

    it("with nothing pending: no gap, no command, and it says so", async () => {
        resolveSyncGap(recordSyncGap(OLDER.from, OLDER.to, "reconnect-gap"));
        const out = payloadOf(await call("zalo_coverage", {}));
        assert.equal(out.pendingCount, 0);
        assert.equal(out.resolvedCount, 1);
        assert.deepEqual(out.pending, []);
        assert.equal(out.command, null);
        assert.match(out.hint, /No coverage gap is pending/);
    });
});
