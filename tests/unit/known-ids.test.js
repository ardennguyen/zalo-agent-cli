/**
 * Ids per account (src/core/known-ids.js): a tool or command that takes a person or a conversation refuses an id this
 * account has never seen with UNKNOWN_TO_ACCOUNT, before any request; an id the account handed out (a phone lookup, a
 * member list) is known from then on; `allowUnknown` / `--allow-unknown` skips the check.
 *
 * The MCP tools run against a recording fake session and a real zalo.db in the sandbox: a refusal is asserted by the
 * session never seeing the tool's own request, a pass by seeing it.
 */
import { SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, getAccountDir } from "../../src/core/credentials.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";
import { initDb, insertMessage, upsertThread, upsertContact } from "../../src/core/db.js";
import {
    KNOWN_IDS_FILE,
    LIST_REFRESH_MS,
    UNKNOWN_TO_ACCOUNT,
    _resetKnownIdLists,
    KNOWN_MEMBERS_FILE,
    findUnknownIds,
    isRecordedKnown,
    mentionUids,
    recordKnownIds,
    unknownIdRefusal,
} from "../../src/core/known-ids.js";
import { rememberFriends } from "../../src/core/typing.js";
import { CLI_ID_GUARDS, enforceKnownIds, installKnownIdGuards } from "../../src/commands/known-id-guards.js";
import { ID_GUARDS } from "../../src/mcp/known-id-guard.js";
import { getGroupInfoWatched } from "../../src/core/group-exit.js";
import { storeGroupEvent } from "../../src/core/live-store.js";

/** Made-up ids. None of them belongs to anyone. */
const OWN = "7000000000000000001";
const FRIEND = "7000000000000000002";
const GROUP = "7000000000000000003";
const SENDER = "7000000000000000004"; // spoke in GROUP, never a friend
const CONTACT = "7000000000000000005"; // in the contact table only
const DM_STRANGER = "7000000000000000006"; // a stored DM conversation, not a friend
const STRANGER = "7000000000000000007"; // found by phone on this account
const FOREIGN = "7000000000000000099"; // another account's id for someone: unknown here
const FOREIGN_GROUP = "7000000000000000098";

const ROOT = mkdtempSync(join(SANDBOX_HOME, "known-ids-"));
const handles = [];
let n = 0;
let accountDir;

before(() => assertSandboxed(CONFIG_DIR));
beforeEach(() => {
    _resetKnownIdLists();
    rememberFriends(null);
    accountDir = mkdtempSync(join(ROOT, "acct-"));
    handles.push(initDb(join(ROOT, `known${n++}.sqlite`)));
    upsertThread({ threadId: GROUP, type: "group", name: "Nhóm thử", lastUpdate: 1700000000000 });
    upsertThread({ threadId: DM_STRANGER, type: "dm", name: "Khách", lastUpdate: 1700000000000 });
    insertMessage({
        msgId: "7100000000001",
        threadId: GROUP,
        senderId: SENDER,
        senderName: "Người gửi",
        text: "hi",
        timestamp: 1700000000000,
        type: "text",
    });
    upsertContact({ userId: CONTACT, name: "Danh bạ", phone: null });
});
after(() => {
    for (const h of handles) {
        try {
            h.close();
        } catch {
            /* already closed */
        }
    }
});

/**
 * A session that records every method called. The friend list holds FRIEND, the group list GROUP; a phone lookup finds
 * STRANGER. Every other method answers `{}`.
 */
function fakeApi({ friends = [FRIEND], groups = [GROUP], failLists = false, extra = {} } = {}) {
    const calls = [];
    const own = {
        getOwnId: () => OWN,
        getContext: () => ({ loginInfo: {} }),
        getAllFriends: async () => {
            if (failLists) throw new Error("network down");
            return friends.map((userId) => ({ userId, displayName: "Bạn", zaloName: "Bạn" }));
        },
        getAllGroups: async () => {
            if (failLists) throw new Error("network down");
            return { gridVerMap: Object.fromEntries(groups.map((g) => [g, "1"])) };
        },
        findUser: async () => ({ uid: STRANGER, displayName: "Người lạ", zaloName: "Người lạ" }),
        ...extra,
    };
    const api = new Proxy(own, {
        get(target, prop) {
            if (typeof prop !== "string" || prop === "then") return undefined;
            if (prop in target) {
                const v = target[prop];
                return typeof v === "function"
                    ? (...args) => {
                          calls.push(prop);
                          return v(...args);
                      }
                    : v;
            }
            return async () => {
                calls.push(prop);
                return {};
            };
        },
    });
    return { api, calls };
}

/** Records what registerTools() registers, standing in for McpServer. */
function fakeServer() {
    const tools = new Map();
    return {
        tools,
        registerTool(name, meta, handler) {
            tools.set(name, { meta, handler });
        },
        call(name, args) {
            return tools.get(name).handler(args, {});
        },
    };
}

function serve(api) {
    const server = fakeServer();
    const buffer = {
        read: () => ({ messages: [], cursor: 0, hasMore: false }),
        getStats: () => [],
        getThreadType: () => "dm",
        readCursor: () => 0,
    };
    const nameCache = { ready: true, get: () => null, search: () => [], getName: () => null };
    registerTools(server, api, buffer, {}, { limits: {} }, nameCache, accountDir);
    return server;
}

const isUnknownRefusal = (r) => {
    if (!r?.isError) return false;
    try {
        return JSON.parse(r.content[0].text).code === UNKNOWN_TO_ACCOUNT;
    } catch {
        return false;
    }
};
/** Calls other than the list reads the guard itself makes. */
const toolCalls = (calls) =>
    calls.filter((c) => !["getAllFriends", "getAllGroups", "getOwnId", "getContext"].includes(c));

describe("findUnknownIds: what this account knows", () => {
    it("knows its friends, groups, stored conversations, senders, contacts and its own id", async () => {
        const { api } = fakeApi();
        const targets = [
            { id: FRIEND, as: "user" },
            { id: GROUP, as: "group" },
            { id: DM_STRANGER, as: "thread" },
            { id: SENDER, as: "user" },
            { id: CONTACT, as: "user" },
            { id: OWN, as: "thread" },
            { id: "me", as: "thread" },
            { id: "-1", as: "user" },
        ];
        assert.deepEqual(await findUnknownIds(targets, { api, ownId: OWN, accountDir }), []);
    });

    it("reports an id from another account, as the kind it was asked as", async () => {
        const { api } = fakeApi();
        const unknown = await findUnknownIds(
            [
                { id: FOREIGN, as: "user", field: "userId" },
                { id: FOREIGN_GROUP, as: "group", field: "groupId" },
            ],
            { api, ownId: OWN, accountDir },
        );
        assert.deepEqual(
            unknown.map((t) => [t.id, t.as, t.field]),
            [
                [FOREIGN, "user", "userId"],
                [FOREIGN_GROUP, "group", "groupId"],
            ],
        );
    });

    it("a group id is not taken for a person's, nor a friend's id for a group", async () => {
        const { api } = fakeApi({ groups: [GROUP, FOREIGN_GROUP] });
        const unknown = await findUnknownIds([{ id: FRIEND, as: "group" }], { api, ownId: OWN, accountDir });
        // FRIEND has no conversation row and is not in the group list.
        assert.deepEqual(
            unknown.map((t) => t.id),
            [FRIEND],
        );
    });

    it("reads the lists on a miss at most once per LIST_REFRESH_MS", async () => {
        const { api, calls } = fakeApi();
        for (let i = 0; i < 3; i++)
            assert.equal((await findUnknownIds([{ id: FOREIGN, as: "user" }], { api, ownId: OWN })).length, 1);
        assert.equal(calls.filter((c) => c === "getAllFriends").length, 1);
        assert.ok(LIST_REFRESH_MS >= 60_000);
    });

    it("refuses nothing when the account's lists cannot be read", async () => {
        const { api } = fakeApi({ failLists: true });
        assert.deepEqual(await findUnknownIds([{ id: FOREIGN, as: "thread" }], { api, ownId: OWN, accountDir }), []);
    });

    it("an id this account handed out is known from then on, kept as a hash", async () => {
        const { api } = fakeApi();
        assert.equal((await findUnknownIds([{ id: STRANGER, as: "user" }], { api, ownId: OWN, accountDir })).length, 1);
        assert.equal(recordKnownIds(accountDir, OWN, [STRANGER, null, "not-an-id"]), 1);
        assert.equal(isRecordedKnown(accountDir, OWN, STRANGER), true);
        assert.deepEqual(await findUnknownIds([{ id: STRANGER, as: "user" }], { api, ownId: OWN, accountDir }), []);
        // Another account's record does not make it known here.
        assert.equal(isRecordedKnown(accountDir, "7000000000000000050", STRANGER), false);
        assert.ok(!readFileSync(join(accountDir, KNOWN_IDS_FILE), "utf8").includes(STRANGER));
    });

    it("finds the @[uid] mentions of a text, not @All", () => {
        assert.deepEqual(mentionUids(`hi @[${FRIEND}] and @[-1] and @[${FOREIGN}] @[${FRIEND}]`), [FRIEND, FOREIGN]);
    });

    it("the refusal says ids differ per account, how to find the person, and the override", () => {
        const mcp = unknownIdRefusal([{ id: FOREIGN, as: "user", field: "threadId" }]);
        assert.equal(mcp.code, UNKNOWN_TO_ACCOUNT);
        assert.match(mcp.message, /^UNKNOWN_TO_ACCOUNT: user id \d+ \(threadId\) is unknown to this Zalo account/);
        assert.match(mcp.message, /different user id on each account/);
        assert.match(mcp.message, /zalo_lookup_user/);
        assert.match(mcp.message, /allowUnknown: true/);
        const cli = unknownIdRefusal([{ id: FOREIGN_GROUP, as: "group" }], { surface: "cli" });
        assert.match(cli.message, /not one of its groups/);
        assert.match(cli.message, /--allow-unknown/);
    });
});

describe("MCP tools refuse an id unknown to the account, before any request", () => {
    /** [tool, arguments naming a foreign id, a method the tool would call] */
    const CASES = [
        ["zalo_send_message", { threadId: FOREIGN, text: "chào" }],
        ["zalo_send_message", { threadId: FRIEND, cardUserId: FOREIGN }],
        ["zalo_send_message", { threadId: GROUP, threadType: "group", text: `@[${FOREIGN}] xem nhé` }],
        ["zalo_send_message", { threadId: FOREIGN_GROUP, threadType: "group", text: "chào" }],
        ["zalo_forward_message", { msgId: "7100000000001", threadId: FOREIGN }],
        ["zalo_react", { msgId: "7100000000001", threadId: FOREIGN, reaction: "like" }],
        ["zalo_get_history", { threadId: FOREIGN }],
        ["zalo_get_messages", { threadId: FOREIGN, since: 0 }],
        ["zalo_wait_for_message", { threadId: FOREIGN, timeoutSec: 1 }],
        ["zalo_lookup_user", { userId: FOREIGN }],
        ["zalo_get_group_members", { groupId: FOREIGN_GROUP }],
        ["zalo_friend", { action: "remove", userId: FOREIGN, confirm: true }],
        ["zalo_friend", { action: "send", userId: FOREIGN }],
        ["zalo_friend", { action: "block", userId: FOREIGN, confirm: true }],
        ["zalo_friend", { action: "alias", userId: FOREIGN, alias: "X" }],
        ["zalo_friend", { action: "last_online", userId: FOREIGN }],
        ["zalo_friend", { action: "qr", userIds: [FRIEND, FOREIGN] }],
        ["zalo_search_messages", { query: "hi", threadId: FOREIGN }],
        ["zalo_search_messages", { query: "hi", senderId: FOREIGN }],
        ["zalo_view_media", { msgId: "7100000000001", threadId: FOREIGN }],
        ["zalo_conversation", { action: "pin", threadId: FOREIGN }],
        ["zalo_conversation", { action: "typing", threadId: FOREIGN_GROUP, threadType: "group" }],
        ["zalo_conversation", { action: "hide", threadIds: [FRIEND, FOREIGN] }],
        ["zalo_conversation", { action: "delete", threadId: FOREIGN, confirm: true }],
        ["zalo_group", { action: "rename", groupId: FOREIGN_GROUP, name: "X" }],
        ["zalo_group", { action: "info", groupId: FOREIGN_GROUP }],
        ["zalo_group", { action: "add_members", groupId: GROUP, userIds: [FOREIGN] }],
        ["zalo_group", { action: "invite_to", userId: FRIEND, groupIds: [FOREIGN_GROUP] }],
        ["zalo_group", { action: "create", name: "X", userIds: [FRIEND, FOREIGN] }],
    ];
    for (const [tool, args] of CASES) {
        it(`${tool} ${JSON.stringify(args).replaceAll(/\d{10,}/g, "<id>")}`, async () => {
            const { api, calls } = fakeApi();
            const r = await serve(api).call(tool, args);
            assert.ok(isUnknownRefusal(r), `not refused: ${JSON.stringify(r)}`);
            const body = JSON.parse(r.content[0].text);
            assert.ok(body.unknownIds.some((u) => u.id.startsWith("70000000000000000")));
            assert.match(r.content[1].text, /^Error: UNKNOWN_TO_ACCOUNT: /);
            assert.deepEqual(toolCalls(calls), [], "a request went out");
        });
    }

    it("every guarded tool takes allowUnknown in its schema", () => {
        const { api } = fakeApi();
        const server = serve(api);
        for (const tool of Object.keys(ID_GUARDS)) {
            const schema = server.tools.get(tool).meta.inputSchema;
            const shape = schema.shape ?? schema._def?.schema?.shape ?? schema._def?.schema?._def?.schema?.shape;
            assert.ok(shape?.allowUnknown, `${tool} has no allowUnknown`);
        }
    });
});

describe("MCP tools go ahead with this account's own ids", () => {
    it("sends to a friend, a stored conversation and a group, mentioning a sender seen there", async () => {
        for (const args of [
            { threadId: FRIEND, text: "chào" },
            { threadId: DM_STRANGER, text: "chào" },
            { threadId: GROUP, threadType: "group", text: `@[${SENDER}] chào` },
        ]) {
            const { api, calls } = fakeApi();
            const r = await serve(api).call("zalo_send_message", args);
            assert.ok(!isUnknownRefusal(r), JSON.stringify(r));
            assert.ok(calls.includes("sendMessage"), `no send: ${calls.join(",")}`);
        }
    });

    it("looks up by phone, then sends to the stranger it found", async () => {
        const { api, calls } = fakeApi();
        const server = serve(api);
        const found = JSON.parse((await server.call("zalo_lookup_user", { phone: "0901234567" })).content[0].text);
        assert.equal(found.userId, STRANGER);
        const r = await server.call("zalo_send_message", { threadId: STRANGER, text: "chào anh" });
        assert.ok(!isUnknownRefusal(r), JSON.stringify(r));
        assert.ok(calls.includes("sendMessage"));
        // A fresh server (another process) knows it too: the record is on disk.
        _resetKnownIdLists();
        const again = fakeApi();
        await serve(again.api).call("zalo_send_message", { threadId: STRANGER, text: "chào" });
        assert.ok(again.calls.includes("sendMessage"));
    });

    it("a group's members are known after zalo_get_group_members", async () => {
        const member = "7000000000000000011";
        const { api, calls } = fakeApi({
            extra: {
                getGroupInfo: async () => ({
                    gridInfoMap: { [GROUP]: { memVerList: [`${member}_0`], totalMember: 1, name: "Nhóm thử" } },
                }),
                getGroupMembersInfo: async () => ({ profiles: {} }),
            },
        });
        const server = serve(api);
        assert.ok(isUnknownRefusal(await server.call("zalo_friend", { action: "status", userId: member })));
        const members = await server.call("zalo_get_group_members", { groupId: GROUP });
        assert.ok(!members.isError, JSON.stringify(members));
        const r = await server.call("zalo_friend", { action: "status", userId: member });
        assert.ok(!isUnknownRefusal(r), JSON.stringify(r));
        assert.ok(calls.includes("getFriendRequestStatus"));
    });

    it("allowUnknown: true sends to an id the account has never seen", async () => {
        const { api, calls } = fakeApi();
        const r = await serve(api).call("zalo_send_message", { threadId: FOREIGN, text: "chào", allowUnknown: true });
        assert.ok(!isUnknownRefusal(r), JSON.stringify(r));
        assert.ok(calls.includes("sendMessage"));
    });

    it("accept and reject are not checked: they answer a request Zalo delivered to this account", async () => {
        const { api, calls } = fakeApi();
        const r = await serve(api).call("zalo_friend", { action: "accept", userId: FOREIGN });
        assert.ok(!isUnknownRefusal(r));
        assert.ok(calls.includes("acceptFriendRequest"));
    });
});

describe("CLI commands refuse an id unknown to the account", () => {
    /** A stand-in for a parsed commander command: its arguments and options. */
    const command = (path, args, opts = {}, typeSource = "default") => ({
        zaloKnownIds: CLI_ID_GUARDS[path],
        processedArgs: args,
        opts: () => opts,
        getOptionValueSource: () => typeSource,
    });

    it("every command in the table exists and gets --allow-unknown", async () => {
        const { Command } = await import("commander");
        const program = new Command();
        for (const path of Object.keys(CLI_ID_GUARDS)) {
            const [g, s] = path.split(" ");
            const group = program.commands.find((c) => c.name() === g) ?? program.command(g);
            group.command(s);
        }
        installKnownIdGuards(program);
        const send = program.commands.find((c) => c.name() === "msg").commands.find((c) => c.name() === "send");
        assert.ok(send.options.some((o) => o.long === "--allow-unknown"));
        assert.equal(typeof send.zaloKnownIds, "function");
    });

    it("names the ids of msg send: the thread, @[uid] mentions and --mention specs", () => {
        const ids = CLI_ID_GUARDS["msg send"](
            command("msg send", [GROUP, `hi @[${SENDER}]`], { mention: [`0:${FOREIGN}:3`, "0:-1:3"] }),
            [GROUP, `hi @[${SENDER}]`],
        );
        assert.deepEqual(
            ids.map((t) => [t.id, t.as]),
            [
                [GROUP, "thread"],
                [SENDER, "user"],
                [FOREIGN, "user"],
            ],
        );
    });

    it("refuses msg send to a foreign id, lets a friend through, and --allow-unknown skips the check", async () => {
        const { api } = fakeApi();
        const ctx = { api, ownId: OWN, accountDir };
        // enforceKnownIds reads the active account; the table's targets are what it checks.
        const refused = await findUnknownIds(
            CLI_ID_GUARDS["msg send"](command("msg send", [FOREIGN, "hi"]), [FOREIGN, "hi"]),
            ctx,
        );
        assert.equal(refused.length, 1);
        const ok = await findUnknownIds(
            CLI_ID_GUARDS["msg send"](command("msg send", [FRIEND, "hi"]), [FRIEND, "hi"]),
            ctx,
        );
        assert.deepEqual(ok, []);
        assert.equal(
            await enforceKnownIds(command("msg send", [FOREIGN, "hi"], { allowUnknown: true }), { api }),
            true,
        );
    });

    it("friend and group commands name a person or a group", () => {
        assert.deepEqual(
            CLI_ID_GUARDS["friend qr"](command("friend qr", [[FRIEND, FOREIGN]]), [[FRIEND, FOREIGN]]).map((t) => t.as),
            ["user", "user"],
        );
        assert.equal(CLI_ID_GUARDS["group members"](command("group members", [GROUP]), [GROUP])[0].as, "group");
        assert.equal(
            CLI_ID_GUARDS["msg history"](command("msg history", [GROUP], { type: "1" }, "cli"), [GROUP])[0].as,
            "group",
        );
    });
});

describe("a group's members are this account's to name, though they never wrote", () => {
    /** A made-up member id per test: the records in an account folder outlive a test. */
    let m = 20;
    const nextMember = () => `70000000000000000${m++}`;

    it("a member listed by any group read is known from then on (a silent member was refused before)", async () => {
        const member = nextMember();
        const ctx = { api: fakeApi().api, ownId: OWN, accountDir: getAccountDir(OWN) };
        assert.equal((await findUnknownIds([{ id: member, as: "user" }], ctx)).length, 1);
        const api = {
            getGroupInfo: async () => ({
                gridInfoMap: {
                    [GROUP]: { name: "Nhóm thử", totalMember: 2, memVerList: [`${member}_3`, `${OWN}_0`] },
                },
            }),
        };
        // The read every group command, the MCP group tools and a sync's group pass make.
        await getGroupInfoWatched(api, OWN, [GROUP]);
        assert.deepEqual(await findUnknownIds([{ id: member, as: "user" }], ctx), []);
        // Kept as a hash, not as the id.
        assert.ok(!readFileSync(join(getAccountDir(OWN), KNOWN_MEMBERS_FILE), "utf8").includes(member));
    });

    it("a member a group event names (added, joined) is known from then on", async () => {
        const member = nextMember();
        const ctx = { api: fakeApi().api, ownId: OWN, accountDir: getAccountDir(OWN) };
        assert.equal((await findUnknownIds([{ id: member, as: "user" }], ctx)).length, 1);
        storeGroupEvent(
            {
                type: "join",
                threadId: GROUP,
                data: { updateMembers: [{ id: member, dName: "Mới" }], sourceId: FRIEND },
            },
            { ownId: OWN },
        );
        assert.deepEqual(await findUnknownIds([{ id: member, as: "user" }], ctx), []);
    });

    /** A session whose GROUP lists `members` of `total`. */
    const groupApi = (members, total = members.length) =>
        fakeApi({
            extra: {
                getGroupInfo: async () => ({
                    gridInfoMap: {
                        [GROUP]: { name: "Nhóm thử", totalMember: total, memVerList: members.map((u) => `${u}_0`) },
                    },
                }),
            },
        });
    const removal = (userId) => ({ action: "remove_member", groupId: GROUP, userId, confirm: true });

    it("a member a group action names is proved by that group's own member list", async () => {
        const member = nextMember();
        const { api, calls } = groupApi([member, OWN]);
        const r = await serve(api).call("zalo_group", removal(member));
        assert.ok(!isUnknownRefusal(r), JSON.stringify(r));
        assert.ok(calls.includes("removeUserFromGroup"), `not removed: ${calls.join(",")}`);
    });

    it("an id missing from a complete member list is refused; a list Zalo answers short refuses nothing", async () => {
        const full = groupApi([FRIEND, OWN]);
        const refused = await serve(full.api).call("zalo_group", removal(FOREIGN));
        assert.ok(isUnknownRefusal(refused), JSON.stringify(refused));
        assert.ok(!full.calls.includes("removeUserFromGroup"));
        _resetKnownIdLists();
        const short = groupApi([FRIEND, OWN], 500);
        const r = await serve(short.api).call("zalo_group", removal(FOREIGN));
        assert.ok(!isUnknownRefusal(r), JSON.stringify(r));
        assert.ok(short.calls.includes("removeUserFromGroup"));
    });
});

describe("search, conversation, group and media inputs go ahead with this account's own ids", () => {
    const passes = async (tool, args, method) => {
        const { api, calls } = fakeApi();
        const r = await serve(api).call(tool, args);
        assert.ok(!isUnknownRefusal(r), `${tool}: ${JSON.stringify(r)}`);
        if (method) assert.ok(calls.includes(method), `${tool}: no ${method} in ${calls.join(",")}`);
        return r;
    };

    it("searches a known conversation for a known sender", async () => {
        const r = await passes("zalo_search_messages", { query: "hi", threadId: GROUP, senderId: SENDER });
        assert.equal(JSON.parse(r.content[0].text).messages.length, 1);
    });

    it("acts on a known conversation and a known group", async () => {
        await passes(
            "zalo_conversation",
            { action: "typing", threadId: GROUP, threadType: "group" },
            "sendTypingEvent",
        );
        await passes("zalo_group", { action: "rename", groupId: GROUP, name: "Mới" }, "changeGroupName");
    });

    it("lists and local-only actions are not checked, nor a join request or an invitation Zalo delivered", async () => {
        await passes("zalo_conversation", { action: "pinned" }, "getPinConversations");
        await passes("zalo_group", { action: "approve", groupId: GROUP, userIds: [FOREIGN] });
        await passes("zalo_group", { action: "join_invite", groupId: FOREIGN_GROUP });
    });
});

describe("CLI: the search, conversation and group commands name their ids", () => {
    const command = (path, args, opts = {}) => ({
        zaloKnownIds: CLI_ID_GUARDS[path],
        processedArgs: args,
        opts: () => opts,
        getOptionValueSource: () => "default",
    });
    const ids = (path, args, opts) => CLI_ID_GUARDS[path](command(path, args, opts), args);

    it("msg search --thread and --from, not --from me", () => {
        assert.deepEqual(
            ids("msg search", ["hi"], { thread: GROUP, from: SENDER }).map((t) => [t.id, t.as]),
            [
                [GROUP, "thread"],
                [SENDER, "user"],
            ],
        );
        assert.deepEqual(ids("msg search", ["hi"], { from: "me" }), []);
    });

    it("conv and group commands; a member a group command names carries its group", () => {
        assert.deepEqual(
            ids("conv hide", [[FRIEND, GROUP]]).map((t) => t.id),
            [FRIEND, GROUP],
        );
        assert.deepEqual(
            ids("group remove-member", [GROUP, [SENDER]]).map((t) => [t.id, t.as, t.group]),
            [
                [GROUP, "group", undefined],
                [SENDER, "user", GROUP],
            ],
        );
        assert.deepEqual(
            ids("group leave", [GROUP], { newOwner: SENDER }).map((t) => [t.id, t.group]),
            [
                [GROUP, undefined],
                [SENDER, GROUP],
            ],
        );
        assert.deepEqual(
            ids("group approve", [GROUP, [FOREIGN]]).map((t) => t.id),
            [GROUP],
        );
    });

    it("refuses a foreign group to conv pin and lets the account's own through", async () => {
        const { api } = fakeApi();
        const ctx = { api, ownId: OWN, accountDir };
        assert.equal((await findUnknownIds(ids("conv pin", [FOREIGN_GROUP]), ctx)).length, 1);
        assert.deepEqual(await findUnknownIds(ids("conv pin", [GROUP]), ctx), []);
    });
});
