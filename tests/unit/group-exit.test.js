/**
 * A group stops being ours (src/core/group-exit.js): the account left it, was removed or blocked from it, or it was
 * disbanded. Zalo Web and PC delete the group's local history at once in all four cases; `groups.onLeave: "keep"`
 * keeps it, flagged gone, with sends refused. Either way a delete marker keeps a restore, a history fetch or a cloud
 * pull from bringing older messages back, and only a `join` naming us (or a newer chat message) ends the exit.
 *
 * Every id here is fake.
 */
import { SANDBOX_CONFIG_DIR, SANDBOX_HOME, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    initDb,
    insertMessage,
    upsertThread,
    upsertReaction,
    upsertBoardItem,
    upsertCloudItem,
    getGroupGone,
    getThreadDeleteMarker,
    searchMessages,
} from "../../src/core/db.js";
import { storeGroupEvent, storeHistoryMessage } from "../../src/core/live-store.js";
import {
    applyGroupExit,
    getGroupInfoWatched,
    goneFromGroupInfo,
    noteGroupInfo,
    purgeGroupHistory,
    resolveGroupOnLeave,
    sendRefusal,
    setGroupGoneSink,
} from "../../src/core/group-exit.js";
import { recentConversations } from "../../src/core/recent-conversations.js";
import { applyPolicy } from "../../src/core/policy-store.js";
import { runStoragePass } from "../../src/core/storage-quota.js";
import { enforceCliGuard } from "../../src/core/confirm-guard.js";
import { ROW_MAC_TABLE } from "../../src/core/row-mac.js";
import { ZaloApiError } from "../../src/zalo/errors.js";
import { registerGroupCommands } from "../../src/commands/group.js";
import { registerMsgCommands } from "../../src/commands/msg.js";
import { ThreadNameCache } from "../../src/mcp/thread-name-cache.js";
import { FAKE, installFakeZalo, loginFake, runCommand } from "./fake-zalo-session.js";

const ACCOUNT_DIR = join(CONFIG_DIR, "accounts", FAKE.ownId);
const DB_PATH = join(ACCOUNT_DIR, "zalo.db");
const MEDIA = join(ACCOUNT_DIR, "media");
const OTHER = "2000000000000000002";
const GID = "7000000000000000071";
const OTHER_GID = "7000000000000000072";
const OLD = 1_700_000_000_000;
const LEFT_AT = OLD + 60_000;

let fake;
let h;
let events = [];

/** A group event as the listener hands it over. */
function groupEvent(type, threadId, { members = [FAKE.ownId], time = LEFT_AT, isSelf = true } = {}) {
    return {
        type,
        threadId,
        isSelf,
        data: { groupId: threadId, sourceId: OTHER, updateMembers: members.map((id) => ({ id })), time: String(time) },
    };
}

/**
 * A cached group: `n` messages (the first holding a downloaded file), a reaction, a pinned board item, a cloud index
 * row. Returns the media path.
 */
function seedGroup(threadId, { n = 3, file = null } = {}) {
    upsertThread({ threadId, type: "group", name: `group ${threadId.slice(-2)}`, lastUpdate: OLD + n });
    const path = file ?? join(MEDIA, threadId, `${threadId}-m0.jpg`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "sealed bytes");
    for (let i = 0; i < n; i++) {
        insertMessage({
            msgId: `${threadId}-m${i}`,
            threadId,
            senderId: OTHER,
            senderName: "",
            text: `needle text ${i}`,
            timestamp: OLD + i,
            type: i === 0 ? "photo" : "text",
            raw_data: { src: "listen" },
            localPath: i === 0 ? path : null,
            has_attachment: i === 0,
        });
    }
    upsertReaction({ msgId: `${threadId}-m1`, threadId, userId: OTHER, icon: "/-heart", rType: 0, timestamp: OLD });
    upsertBoardItem({ threadId, threadType: "group", boardType: 2, itemId: "1", title: "pin", createTime: OLD });
    upsertCloudItem({ noiseId: `${threadId}-n1`, threadId, msgId: `${threadId}-m0`, timestamp: OLD });
    return path;
}

const count = (sql, ...p) => h.prepare(sql).get(...p).n;
const rowsOf = (id) => count("SELECT COUNT(*) AS n FROM messages WHERE threadId = ?", id);

before(async () => {
    assertSandboxed(CONFIG_DIR);
    assert.equal(CONFIG_DIR, SANDBOX_CONFIG_DIR);
    assert.ok(DB_PATH.startsWith(SANDBOX_HOME));
    delete process.env.ZALO_JSON_MODE;
    fake = installFakeZalo();
    await loginFake();
});

after(() => {
    setGroupGoneSink(null);
    fake?.uninstall();
});

beforeEach(() => {
    h = initDb(DB_PATH);
    h.exec(
        "DELETE FROM messages; DELETE FROM threads; DELETE FROM reactions; DELETE FROM board_items; " +
            "DELETE FROM cloud_items; DELETE FROM conv_state;",
    );
    rmSync(MEDIA, { recursive: true, force: true });
    delete process.env.ZALO_GROUPS_ON_LEAVE;
    applyPolicy({ target: { kind: "account", id: FAKE.ownId }, op: "put", policy: {}, actor: "test" });
    events = [];
    setGroupGoneSink((e) => events.push(e));
});

/** What a purge must leave of a group: nothing but the thread row with its markers. */
function assertPurged(threadId, file) {
    assert.equal(rowsOf(threadId), 0, "messages");
    assert.equal(count("SELECT COUNT(*) AS n FROM reactions WHERE threadId = ?", threadId), 0, "reactions");
    assert.equal(count("SELECT COUNT(*) AS n FROM board_items WHERE threadId = ?", threadId), 0, "pins");
    assert.equal(count("SELECT COUNT(*) AS n FROM cloud_items WHERE threadId = ?", threadId), 0, "cloud index");
    assert.equal(
        count(`SELECT COUNT(*) AS n FROM ${ROW_MAC_TABLE} WHERE msgId LIKE ?`, `${threadId}-%`),
        0,
        "row MACs go with the rows",
    );
    assert.equal(searchMessages({ query: "needle", threadId }).length, 0, "search finds nothing");
    assert.equal(existsSync(file), false, "the downloaded file is deleted");
    assert.ok(getThreadDeleteMarker(threadId) >= LEFT_AT, "the delete marker stays");
}

describe("each exit kind purges the group's history by default", () => {
    for (const [type, reason] of [
        ["leave", "leave"],
        ["remove_member", "removed"],
        ["block_member", "blocked"],
    ]) {
        it(`${type} (our own) -> ${reason}, purged`, async () => {
            const file = seedGroup(GID);
            assert.ok(rowsOf(GID) > 0 && existsSync(file));
            assert.equal(searchMessages({ query: "needle", threadId: GID }).length, 3, "searchable before");
            assert.ok(count(`SELECT COUNT(*) AS n FROM ${ROW_MAC_TABLE} WHERE msgId LIKE ?`, `${GID}-%`) > 0);
            const g = storeGroupEvent(groupEvent(type, GID), { ownId: FAKE.ownId });
            assert.equal(g.gone, true);
            assert.equal(g.reason, reason);
            const e = await applyGroupExit({ ownId: FAKE.ownId, threadId: GID, reason: g.reason, at: g.at });
            assert.equal(e.event, "group_gone");
            assert.equal(e.mode, "purge");
            assert.equal(e.reason, reason);
            assert.equal(e.purged.messages, 3);
            assert.equal(e.purged.files, 1);
            assertPurged(GID, file);
            assert.equal(getGroupGone(GID).goneReason, reason);
            assert.deepEqual(
                events.map((x) => x.threadId),
                [GID],
                "one group_gone to the sink",
            );
        });
    }

    it("disbanded (removedsGroup in the group fetch) -> disbanded, purged", async () => {
        const file = seedGroup(GID);
        const out = await noteGroupInfo({
            ownId: FAKE.ownId,
            result: { removedsGroup: [GID], gridInfoMap: {} },
            groupIds: [GID],
        });
        assert.equal(out.length, 1);
        assert.equal(out[0].reason, "disbanded");
        assertPurged(GID, file);
    });

    it("removing someone ELSE purges nothing", async () => {
        seedGroup(GID);
        const g = storeGroupEvent(groupEvent("remove_member", GID, { members: [OTHER] }), { ownId: FAKE.ownId });
        assert.equal(g.gone, false);
        assert.equal(rowsOf(GID), 3);
        assert.equal(getGroupGone(GID), null);
    });
});

describe("disband detection from group info", () => {
    it("removedsGroup names the group: disbanded; a group answered normally is not", () => {
        assert.deepEqual(goneFromGroupInfo({ result: { removedsGroup: [GID] }, groupIds: [GID, OTHER_GID] }), [
            { threadId: GID, reason: "disbanded" },
        ]);
        assert.deepEqual(goneFromGroupInfo({ result: { gridInfoMap: { [GID]: {} } }, groupIds: [GID] }), []);
    });

    it("error 161 on a group asked alone: disbanded, purged, and the error is passed on", async () => {
        const file = seedGroup(GID);
        const api = {
            getGroupInfo: async () => {
                throw new ZaloApiError("Group does not exist", 161);
            },
        };
        await assert.rejects(getGroupInfoWatched(api, FAKE.ownId, [GID]), /does not exist/);
        assert.equal(getGroupGone(GID).goneReason, "disbanded");
        assertPurged(GID, file);
    });

    it("a batch error names no group, and an unrelated code marks nothing", () => {
        assert.deepEqual(goneFromGroupInfo({ error: new ZaloApiError("x", 161), groupIds: [GID, OTHER_GID] }), []);
        assert.deepEqual(goneFromGroupInfo({ error: new ZaloApiError("x", 500), groupIds: [GID] }), []);
    });

    it("the thread-name cache drops a group its init finds disbanded", async () => {
        seedGroup(GID);
        const cache = new ThreadNameCache();
        await cache.init(
            {
                getAllGroups: async () => ({ gridVerMap: { [GID]: "1", [OTHER_GID]: "1" } }),
                getGroupInfo: async () => ({ removedsGroup: [GID], gridInfoMap: { [OTHER_GID]: { name: "live" } } }),
                getAllFriends: async () => [],
                getAliasList: async () => ({ items: [] }),
            },
            { ownId: FAKE.ownId },
        );
        assert.equal(cache.get(GID), null);
        assert.equal(cache.get(OTHER_GID)?.name, "live");
        assert.equal(rowsOf(GID), 0);
    });

    it("a disband the start-up cache finds before the event route is up is emitted once the route is set", async () => {
        // `mcp start` builds the cache before it installs its sink (webhook, live buffer): the event must wait.
        setGroupGoneSink(null);
        seedGroup(GID);
        const cache = new ThreadNameCache();
        await cache.init(
            {
                getAllGroups: async () => ({ gridVerMap: { [GID]: "1" } }),
                getGroupInfo: async () => ({ removedsGroup: [GID], gridInfoMap: {} }),
                getAllFriends: async () => [],
                getAliasList: async () => ({ items: [] }),
            },
            { ownId: FAKE.ownId },
        );
        assert.equal(rowsOf(GID), 0, "purged at once");
        assert.deepEqual(events, [], "no route yet");
        const late = [];
        setGroupGoneSink((e) => late.push(e));
        assert.deepEqual(
            late.map((e) => [e.event, e.threadId, e.reason, e.source]),
            [["group_gone", GID, "disbanded", "group-info"]],
        );
        setGroupGoneSink((e) => late.push(e));
        assert.equal(late.length, 1, "delivered once, not again to the next sink");
    });
});

describe('groups.onLeave "keep"', () => {
    it("keeps the history, flags the group in lists and search, and refuses sends", async () => {
        process.env.ZALO_GROUPS_ON_LEAVE = "keep";
        const file = seedGroup(GID);
        const g = storeGroupEvent(groupEvent("leave", GID), { ownId: FAKE.ownId });
        const e = await applyGroupExit({ ownId: FAKE.ownId, threadId: GID, reason: g.reason, at: g.at });
        assert.equal(e.mode, "keep");
        assert.equal(e.purged, null);
        assert.equal(rowsOf(GID), 3, "readable");
        assert.ok(existsSync(file));

        const row = recentConversations(10, "group").find((t) => String(t.threadId) === GID);
        assert.equal(row?.gone, true);
        assert.equal(row?.leftAt, LEFT_AT);
        assert.equal(row?.goneReason, "leave");

        const cache = new ThreadNameCache();
        cache.applyGone();
        assert.equal(cache.search("group", "group")[0]?.gone, true);

        assert.match(sendRefusal(GID), /is gone: this account left it/);
        assert.equal(sendRefusal(OTHER_GID), null);
    });

    it("`msg send` to a kept gone group is refused before anything is sent", async () => {
        process.env.ZALO_GROUPS_ON_LEAVE = "keep";
        seedGroup(GID);
        await applyGroupExit({ ownId: FAKE.ownId, threadId: GID, reason: "removed", at: LEFT_AT });
        const before = fake.requests.length;
        const r = await runCommand(registerMsgCommands, ["msg", "send", GID, "hello", "-t", "1"]);
        assert.equal(r.exitCode, 1, r.stdout + r.stderr);
        assert.match(r.stdout + r.stderr, /is gone: this account was removed from it/);
        assert.equal(fake.requests.length, before, "no request went out");
    });

    it("a purged group is left out of the lists", async () => {
        seedGroup(GID);
        await applyGroupExit({ ownId: FAKE.ownId, threadId: GID, reason: "leave", at: LEFT_AT });
        assert.equal(
            recentConversations(10, "group").some((t) => String(t.threadId) === GID),
            false,
        );
    });
});

describe("the delete marker blocks re-insertion", () => {
    it("a phone restore, a history fetch and a cloud pull bring nothing older back; newer still lands", async () => {
        seedGroup(GID);
        await applyGroupExit({ ownId: FAKE.ownId, threadId: GID, reason: "leave", at: LEFT_AT });
        // transfer-sync-v2 writes through insertMessage.
        const restored = insertMessage({
            msgId: `${GID}-m1`,
            threadId: GID,
            senderId: OTHER,
            text: "old",
            timestamp: OLD + 1,
            type: "text",
            raw_data: { src: "sync-v2" },
        });
        assert.equal(restored.changes, 0);
        assert.equal(restored.belowDeleteMarker, true);
        // msg history / group history / the offline catch-up write through storeHistoryMessage.
        const fetched = storeHistoryMessage({
            threadId: GID,
            type: 1,
            data: {
                msgId: "9100000000000000001",
                uidFrom: OTHER,
                content: "old",
                ts: String(OLD + 2),
                msgType: "webchat",
            },
        });
        assert.equal(fetched.stored, false);
        assert.equal(upsertCloudItem({ noiseId: "n-old", threadId: GID, timestamp: OLD }).changes, 0);
        assert.equal(rowsOf(GID), 0);

        const newer = insertMessage({
            msgId: "9100000000000000002",
            threadId: GID,
            senderId: OTHER,
            text: "after a rejoin",
            timestamp: LEFT_AT + 1000,
            type: "text",
            raw_data: { src: "listen" },
        });
        assert.equal(newer.changes, 1);
    });
});

describe("while gone, only a join naming us brings the group back", () => {
    it("later events of the group are ignored; a join naming us clears leftAt", () => {
        process.env.ZALO_GROUPS_ON_LEAVE = "keep";
        seedGroup(GID);
        storeGroupEvent(groupEvent("leave", GID), { ownId: FAKE.ownId });
        for (const ev of [
            groupEvent("update", GID, { members: [], time: LEFT_AT + 1000, isSelf: false }),
            groupEvent("join", GID, { members: [OTHER], time: LEFT_AT + 2000, isSelf: false }),
            groupEvent("leave", GID, { members: [OTHER], time: LEFT_AT + 3000, isSelf: false }),
            groupEvent("add_admin", GID, { members: [OTHER], time: LEFT_AT + 4000, isSelf: false }),
        ]) {
            const r = storeGroupEvent(ev, { ownId: FAKE.ownId });
            assert.equal(r.ignored, true, ev.type);
            assert.equal(getGroupGone(GID)?.leftAt, LEFT_AT, `${ev.type} does not clear leftAt`);
        }
        // A join dated before the exit does not undo it either.
        assert.equal(
            storeGroupEvent(groupEvent("join", GID, { time: LEFT_AT - 1 }), { ownId: FAKE.ownId }).ignored,
            true,
        );
        const back = storeGroupEvent(groupEvent("join", GID, { time: LEFT_AT + 5000 }), { ownId: FAKE.ownId });
        assert.equal(back.back, true);
        assert.equal(getGroupGone(GID), null);
        assert.equal(h.prepare("SELECT leftAt, goneReason FROM threads WHERE threadId = ?").get(GID).leftAt, null);
        assert.ok(getThreadDeleteMarker(GID) >= LEFT_AT, "the delete marker outlives the rejoin");
    });

    it("a replayed leave of an already gone group is not a second exit", () => {
        seedGroup(GID);
        storeGroupEvent(groupEvent("leave", GID), { ownId: FAKE.ownId });
        const again = storeGroupEvent(groupEvent("leave", GID, { time: LEFT_AT + 10 }), { ownId: FAKE.ownId });
        assert.equal(again.gone, false);
        assert.equal(again.ignored, true);
    });
});

describe("our own leave and disperse from the CLI, with no listener running", () => {
    beforeEach(() => {
        fake.clearRoutes();
        fake.route("/api/group/leave", () => ({ memberError: [] }));
        fake.route("/api/group/disperse", () => ({}));
    });

    /** Register the group commands with the guard hook src/index.js installs. */
    const withGuard = (program) => {
        registerGroupCommands(program);
        program.hook("preAction", (_p, cmd) => enforceCliGuard(cmd, { json: false }));
    };

    it("`group leave` without --yes exits 2 and purges nothing", async () => {
        seedGroup(GID);
        const r = await runCommand(withGuard, ["group", "leave", GID]);
        assert.equal(r.exitCode, 2, r.stdout + r.stderr);
        assert.equal(fake.calls("/api/group/leave").length, 0);
        assert.equal(rowsOf(GID), 3);
    });

    it("`group leave --yes` purges the group's local history", async () => {
        const file = seedGroup(GID);
        const r = await runCommand(withGuard, ["group", "leave", GID, "--yes"]);
        assert.equal(r.exitCode, null, r.stdout + r.stderr);
        assert.equal(fake.calls("/api/group/leave").length, 1);
        assert.match(r.stdout + r.stderr, /local history purged: 3 message\(s\), 1 media file\(s\)/);
        h = initDb(DB_PATH);
        assertPurged(GID, file);
        assert.equal(getGroupGone(GID).goneReason, "leave");
    });

    it("`group disperse --yes` records a disband and purges", async () => {
        const file = seedGroup(GID);
        const r = await runCommand(withGuard, ["group", "disperse", GID, "--yes"]);
        assert.equal(r.exitCode, null, r.stdout + r.stderr);
        h = initDb(DB_PATH);
        assertPurged(GID, file);
        assert.equal(getGroupGone(GID).goneReason, "disbanded");
    });
});

describe("the purge is bounded and hands the event loop back", () => {
    it("chunks of rows, a pause between them, and a timer served mid-purge", async () => {
        upsertThread({ threadId: GID, type: "group", name: "big", lastUpdate: OLD });
        h.transaction(() => {
            for (let i = 0; i < 1200; i++) {
                insertMessage({
                    msgId: `${GID}-b${i}`,
                    threadId: GID,
                    senderId: OTHER,
                    text: `row ${i}`,
                    timestamp: OLD + i,
                    type: "text",
                    raw_data: { src: "listen" },
                });
            }
        })();
        let pauses = 0;
        let timerRan = false;
        setTimeout(() => (timerRan = true), 0);
        let timerRanBeforeEnd = false;
        const out = await purgeGroupHistory(GID, {
            chunk: 100,
            sliceMs: 0,
            pause: async () => {
                pauses++;
                await new Promise((r) => setTimeout(r, 0));
                if (timerRan && rowsOf(GID) > 0) timerRanBeforeEnd = true;
            },
        });
        assert.equal(out.messages, 1200);
        assert.ok(pauses >= 12, `a pause per chunk (got ${pauses})`);
        assert.ok(timerRanBeforeEnd, "a timer ran while rows were still left");
        assert.equal(rowsOf(GID), 0);
    });
});

describe("media another conversation points at survives", () => {
    it("a file shared with another thread is kept, the group's own file is deleted", async () => {
        const shared = join(MEDIA, "shared", "forwarded.jpg");
        seedGroup(GID, { file: shared });
        seedGroup(OTHER_GID, { file: shared });
        const e = await applyGroupExit({ ownId: FAKE.ownId, threadId: GID, reason: "leave", at: LEFT_AT });
        assert.equal(e.purged.filesShared, 1);
        assert.equal(e.purged.files, 0);
        assert.ok(existsSync(shared), "still held by the other group");
        assert.equal(rowsOf(OTHER_GID), 3);
    });
});

describe("groups.onLeave is a live policy key", () => {
    const setMode = (mode) =>
        applyPolicy({
            target: { kind: "account", id: FAKE.ownId },
            op: "patch",
            policy: { groups: { onLeave: mode } },
            actor: "test",
        });

    it("resolves policy over env over storage.json over the default", () => {
        assert.equal(resolveGroupOnLeave(FAKE.ownId, { policy: null, file: {} }).mode, "purge");
        assert.equal(
            resolveGroupOnLeave(FAKE.ownId, { policy: null, file: { groups: { onLeave: "keep" } } }).mode,
            "keep",
        );
        assert.equal(
            resolveGroupOnLeave(FAKE.ownId, {
                policy: null,
                env: { ZALO_GROUPS_ON_LEAVE: "purge" },
                file: { groups: { onLeave: "keep" } },
            }).mode,
            "purge",
        );
        assert.equal(
            resolveGroupOnLeave(FAKE.ownId, {
                policy: { groups: { onLeave: "keep" } },
                env: { [`ZALO_GROUPS_ON_LEAVE_${FAKE.ownId}`]: "purge" },
            }).source,
            "policy:groups.onLeave",
        );
    });

    it("keep -> purge: the groups kept so far are purged on the next pass", async () => {
        const r1 = setMode("keep");
        assert.match(r1.notes?.[0] ?? "", /does not come back/);
        const file = seedGroup(GID);
        await applyGroupExit({ ownId: FAKE.ownId, threadId: GID, reason: "removed", at: LEFT_AT });
        assert.equal(rowsOf(GID), 3, "kept");

        const r2 = setMode("purge");
        assert.match(r2.notes?.[0] ?? "", /next quota\/retention pass/);
        const report = runStoragePass({ ownId: FAKE.ownId });
        assert.equal(report.goneGroups.groups, 1);
        assert.equal(report.goneGroups.messages, 3);
        assertPurged(GID, file);
        assert.equal(getGroupGone(GID).goneReason, "removed", "still marked gone, now purged");
    });

    it("purge -> keep: only later exits are kept; purged history does not come back", async () => {
        setMode("purge");
        seedGroup(GID);
        await applyGroupExit({ ownId: FAKE.ownId, threadId: GID, reason: "leave", at: LEFT_AT });
        assert.equal(rowsOf(GID), 0);

        setMode("keep");
        seedGroup(OTHER_GID);
        const e = await applyGroupExit({ ownId: FAKE.ownId, threadId: OTHER_GID, reason: "blocked", at: LEFT_AT });
        assert.equal(e.mode, "keep");
        assert.equal(rowsOf(OTHER_GID), 3);
        assert.equal(runStoragePass({ ownId: FAKE.ownId }).goneGroups.groups, 0, "keep: the pass purges nothing");
        assert.equal(rowsOf(GID), 0, "the purged group stays empty");
    });
});
