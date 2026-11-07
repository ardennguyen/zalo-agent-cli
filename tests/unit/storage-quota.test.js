/**
 * Storage quotas and retention (src/core/storage-quota.js): the quota clock (warn, over, grace_ending, purged, ok, and a
 * cleared clock), the purge (oldest media first, then oldest messages with their search entries, reactions and row
 * MACs), the retention floor that keeps sync and history from restoring a purged message, the age rules, dead webhook
 * deliveries, a tenant's shared limit, a dry run that changes nothing, `db purge` through a daemon's channel, and what MCP
 * clients see: `storage_quota` system events in zalo_get_messages / zalo_wait_for_message, and zalo_profile 'usage'.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CONFIG_DIR, getAccountDbPath, getAccountDir, resolveMediaRoot } from "../../src/core/credentials.js";
import {
    closeDb,
    ensureSearchIndex,
    getMessageById,
    getReactions,
    getRetentionFloor,
    initDb,
    insertMessage,
    insertMessageIfAbsent,
    setMessageLocalPath,
    upsertReaction,
    verifyMessageRows,
} from "../../src/core/db.js";
import { runReadOnlyQuery } from "../../src/core/db-tools.js";
import {
    describeStorage,
    measureUsage,
    quotaSystemEvent,
    readQuotaState,
    resolveQuota,
    resolveRetention,
    runStoragePass,
    stepQuota,
} from "../../src/core/storage-quota.js";
import { applyPolicy } from "../../src/core/policy-store.js";
import { writeStorageFile } from "../../src/core/keystore/config.js";
import { openOutbox, purgeDeadDeliveries } from "../../src/core/webhook-outbox.js";
import { callViaDaemon, startDaemonChannel } from "../../src/core/daemon-channel.js";
import { storeHistoryMessage } from "../../src/core/live-store.js";
import { describeAccountStatus } from "../../src/core/account-status.js";
import { MessageBuffer } from "../../src/mcp/message-buffer.js";
import { registerTools } from "../../src/mcp/mcp-tools.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8);
let n = 0;
const freshId = () => String(1000000000000000900n + BigInt(n++));

/** A cache with `rows` messages a day apart (the oldest first), `files` of them with a media file of `fileBytes`. */
function account({ rows = 40, files = 0, fileBytes = 40_000, textBytes = 50 } = {}) {
    const id = freshId();
    const dir = getAccountDir(id);
    mkdirSync(dir, { recursive: true });
    initDb(getAccountDbPath(id));
    const media = join(resolveMediaRoot(dir), "t1");
    mkdirSync(media, { recursive: true });
    for (let i = 0; i < rows; i++) {
        const ts = NOW - (rows - i) * DAY;
        insertMessage({
            msgId: `m${i}`,
            threadId: "t1",
            senderId: "1",
            text: `marker-${i} ${"x".repeat(textBytes)}`,
            timestamp: ts,
            type: "text",
        });
        upsertReaction({ msgId: `m${i}`, threadId: "t1", userId: "2", icon: "/-heart", rType: 0, timestamp: ts });
        if (i < files) {
            const f = join(media, `m${i}.bin`);
            writeFileSync(f, randomBytes(fileBytes));
            setMessageLocalPath(`m${i}`, f);
        }
    }
    ensureSearchIndex();
    return { id, dir, file: getAccountDbPath(id), media };
}

const noPolicy = (extra = {}) => ({ quota: {}, retention: {}, ...extra });

describe("storage quota: the clock", () => {
    before(() => assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR));
    const base = { limit: 1000, graceDays: 45, warnAt: 0.8 };

    it("ok, then warn once, then over once with the grace clock started", () => {
        let r = stepQuota({ ...base, prev: {}, used: 500, now: NOW });
        assert.equal(r.next.level, "ok");
        assert.deepEqual(r.events, []);
        r = stepQuota({ ...base, prev: r.next, used: 850, now: NOW });
        assert.deepEqual(r.events, [{ level: "warn" }]);
        r = stepQuota({ ...base, prev: r.next, used: 860, now: NOW });
        assert.deepEqual(r.events, [], "warned once");
        r = stepQuota({ ...base, prev: r.next, used: 1200, now: NOW });
        assert.deepEqual(r.events, [{ level: "over" }]);
        assert.equal(r.next.overSince, NOW);
        assert.equal(r.next.purgeAt, NOW + 45 * DAY);
        assert.equal(r.purgeDue, false, "caching goes on: no purge before the grace period ends");
    });

    it("grace_ending 7 days and 1 day before, each once, then the purge is due", () => {
        let prev = stepQuota({ ...base, prev: {}, used: 1200, now: NOW }).next;
        let r = stepQuota({ ...base, prev, used: 1200, now: NOW + 38 * DAY });
        assert.deepEqual(r.events, [{ level: "grace_ending", daysLeft: 7 }]);
        assert.equal(r.next.overSince, NOW, "the clock keeps its start");
        prev = r.next;
        r = stepQuota({ ...base, prev, used: 1200, now: NOW + 44 * DAY });
        assert.deepEqual(r.events, [{ level: "grace_ending", daysLeft: 1 }]);
        r = stepQuota({ ...base, prev: r.next, used: 1200, now: NOW + 45 * DAY });
        assert.equal(r.purgeDue, true);
    });

    it("back under the limit (a raised limit, a renewal) is `ok` and clears the clock", () => {
        const over = stepQuota({ ...base, prev: {}, used: 1200, now: NOW }).next;
        const r = stepQuota({ ...base, limit: 5000, prev: over, used: 1200, now: NOW + 10 * DAY });
        assert.deepEqual(r.events, [{ level: "ok" }]);
        assert.equal(r.next.overSince, null);
        const again = stepQuota({ ...base, prev: r.next, used: 1200, now: NOW + 11 * DAY });
        assert.equal(again.next.overSince, NOW + 11 * DAY, "a new episode starts a new clock");
    });
});

describe("storage quota: settings", () => {
    it("storage.json < environment < policy; `keep` keeps; quotas accept sizes", () => {
        const id = freshId();
        writeStorageFile({
            provider: "test",
            retention: { messages: "90d", media: "keep", outboxDead: "10d", purgeEvery: "2h" },
            quota: { account: { limit: "1GB" }, graceDays: 30 },
        });
        try {
            let r = resolveRetention(id, { env: {}, policy: null });
            assert.equal(r.messagesDays, 90);
            assert.equal(r.mediaDays, null);
            assert.equal(r.outboxDeadDays, 10);
            assert.equal(r.purgeEveryMs, 2 * 3_600_000);
            r = resolveRetention(id, { env: { [`ZALO_RETENTION_MESSAGES_${id}`]: "7d" }, policy: null });
            assert.equal(r.messagesDays, 7);
            r = resolveRetention(id, {
                env: { ZALO_RETENTION_MESSAGES: "7d" },
                policy: { retention: { messages: "keep" } },
            });
            assert.equal(r.messagesDays, null, "the policy wins over the environment");
            const q = resolveQuota(id, { policy: null });
            assert.equal(q.accountLimit, 1024 ** 3);
            assert.equal(q.graceDays, 30);
            assert.equal(
                resolveQuota(id, { policy: { quota: { account: { limit: "unlimited" } } } }).accountLimit,
                null,
            );
        } finally {
            writeStorageFile({ provider: "test" });
        }
    });
});

describe("storage quota: retention rules and the floor", () => {
    it("retention.messages removes old rows with their reactions, search entries and MACs, and sets the floor", () => {
        const a = account({ rows: 40, files: 5 });
        const policy = noPolicy({ retention: { messages: "30d" } });
        const r = runStoragePass({ ownId: a.id, now: NOW, policy });
        assert.equal(r.retention.messages.rows, 11, "the 11 messages 30 days old or older");
        assert.equal(r.retention.messages.mediaFiles, 5);
        assert.equal(getMessageById("m0"), null);
        assert.ok(getMessageById("m39"));
        assert.equal(getReactions({ msgId: "m0" }).length, 0);
        assert.equal(getRetentionFloor(), NOW - 30 * DAY);
        assert.ok(!existsSync(join(a.media, "m0.bin")), "the purged message's media file is gone");
        const v = verifyMessageRows();
        assert.equal(v.bad + v.missing + v.orphanMacs, 0, "the row MACs agree with the rows that are left");
        closeDb();
        const fts = runReadOnlyQuery(a.file, "SELECT count(*) AS n FROM messages_fts");
        assert.equal(fts.rows[0].n, 29, "no search entry outlives its message");
    });

    it("a purged message is never stored again: not by the listener's or sync's upsert, nor by a history fetch", () => {
        const a = account({ rows: 40 });
        runStoragePass({ ownId: a.id, now: NOW, policy: noPolicy({ retention: { messages: "30d" } }) });
        const old = {
            msgId: "m1",
            threadId: "t1",
            senderId: "1",
            text: "back",
            timestamp: NOW - 39 * DAY,
            type: "text",
        };
        assert.equal(insertMessage(old).changes, 0);
        assert.equal(insertMessageIfAbsent(old).changes, 0);
        const fetched = storeHistoryMessage(
            {
                type: 0,
                threadId: "t1",
                data: { msgId: "m2", uidFrom: "1", ts: String(NOW - 38 * DAY), content: "back" },
            },
            {},
        );
        assert.equal(fetched.stored, false);
        assert.equal(getMessageById("m1"), null);
        assert.equal(getMessageById("m2"), null);
        // Newer than the floor: stored as always.
        assert.equal(insertMessage({ ...old, msgId: "new1", timestamp: NOW }).changes, 1);
        closeDb();
        // The floor is kept in the database: a new process sees it.
        initDb(a.file);
        assert.equal(insertMessage({ ...old, msgId: "m3" }).changes, 0);
        closeDb();
    });

    it("retention.media removes old files only; their messages stay and are not fetched again", () => {
        const a = account({ rows: 20, files: 20 });
        const r = runStoragePass({ ownId: a.id, now: NOW, policy: noPolicy({ retention: { media: "10d" } }) });
        assert.equal(r.retention.media.files, 10);
        const m0 = getMessageById("m0");
        assert.ok(m0, "the message stays");
        assert.equal(m0.localPath, null);
        assert.ok(m0.mediaPrunedAt, "marked pruned, so no fetch brings it back");
        assert.ok(existsSync(join(a.media, "m19.bin")));
        closeDb();
    });

    it("a dry run counts and changes nothing", () => {
        const a = account({ rows: 40, files: 5 });
        const r = runStoragePass({
            ownId: a.id,
            now: NOW,
            dryRun: true,
            policy: noPolicy({ retention: { messages: "30d" } }),
        });
        assert.equal(r.retention.messages.rows, 11);
        assert.ok(getMessageById("m0"));
        assert.equal(getRetentionFloor(), 0);
        assert.equal(readQuotaState(a.dir).usage, null, "no state written");
        closeDb();
    });

    it("retention.outboxDead removes dead webhook deliveries past their days, nothing else", () => {
        const dir = getAccountDir(freshId());
        let t = NOW - 40 * DAY;
        const outbox = openOutbox(dir, { now: () => t });
        outbox.enqueue("a", "{}");
        outbox.enqueue("b", "{}");
        outbox.markDead([1], "test");
        t = NOW;
        outbox.markDead([2], "test");
        outbox.enqueue("c", "{}");
        outbox.close();
        assert.equal(purgeDeadDeliveries(dir, NOW - 30 * DAY), 1);
        const o = openOutbox(dir);
        assert.deepEqual(o.stats().dead, 1);
        assert.equal(o.stats().pending, 1);
        o.close();
        assert.equal(purgeDeadDeliveries(join(dir, "none"), NOW), 0, "no outbox, none made");
    });
});

describe("storage quota: over the limit", () => {
    it("inside the grace period: caching goes on, `over` is announced once, nothing is purged", () => {
        const a = account({ rows: 10, files: 5 });
        const used = runStoragePass({ ownId: a.id, now: NOW, dryRun: true, policy: noPolicy() }).usageBefore.total;
        const policy = noPolicy({ quota: { account: { limit: Math.floor(used / 2) }, graceDays: 45 } });
        const events = [];
        const r = runStoragePass({ ownId: a.id, now: NOW, policy, emit: (e) => events.push(e) });
        assert.deepEqual(
            events.map((e) => e.level),
            ["over"],
        );
        assert.equal(events[0].event, "storage_quota");
        assert.equal(events[0].scope, "account");
        assert.equal(r.quota.media.files + r.quota.messages.rows, 0);
        assert.equal(readQuotaState(a.dir).account.level, "over");
        assert.ok(
            insertMessage({ msgId: "x", threadId: "t1", senderId: "1", text: "y", timestamp: NOW, type: "text" })
                .changes,
        );
        const again = [];
        runStoragePass({ ownId: a.id, now: NOW + DAY, policy, emit: (e) => again.push(e) });
        assert.deepEqual(again, [], "announced once");
        closeDb();
    });

    it("after the grace period: oldest media first, then the oldest messages, until usage is under the limit", () => {
        const a = account({ rows: 300, files: 10, fileBytes: 30_000, textBytes: 2000 });
        const mediaBefore = measureUsage(a.id).media;
        const before = runStoragePass({ ownId: a.id, now: NOW, dryRun: true, policy: noPolicy() }).usageBefore;
        // Over by all the media and about a third of the database: both phases must run.
        const limit = before.total - mediaBefore - Math.floor(before.db / 3);
        const policy = noPolicy({ quota: { account: { limit }, graceDays: 0 } });
        const dry = runStoragePass({ ownId: a.id, now: NOW, dryRun: true, policy });
        assert.equal(dry.quota.media.files, 10);
        assert.ok(dry.quota.messages.rows > 0);
        assert.ok(getMessageById("m0"), "the dry run removed nothing");
        const events = [];
        const r = runStoragePass({ ownId: a.id, now: NOW, policy, emit: (e) => events.push(e) });
        assert.equal(r.quota.media.files, 10, "every media file went first");
        assert.ok(r.quota.messages.rows > 0, "then messages");
        assert.ok(r.usageAfter.total <= limit, `${r.usageAfter.total} <= ${limit}`);
        assert.equal(getMessageById("m0"), null, "the oldest went");
        assert.ok(getMessageById("m299"), "the newest stayed");
        assert.ok(getRetentionFloor() > 0);
        assert.deepEqual(
            events.map((e) => e.level),
            ["over", "purged", "ok"],
        );
        assert.ok(events[1].freedBytes > 0);
        assert.equal(readQuotaState(a.dir).account.overSince, null, "back under: the clock is cleared");
        const v = verifyMessageRows();
        assert.equal(v.bad + v.missing + v.orphanMacs, 0);
        closeDb();
    });

    it("a tenant's limit: this account gives up its share of the excess", () => {
        const other = freshId();
        mkdirSync(getAccountDir(other), { recursive: true });
        // The other account's daemon published its usage.
        writeFileSync(
            join(getAccountDir(other), "quota-state.json"),
            JSON.stringify({ usage: { total: 1_000_000 }, account: {}, tenants: {} }),
        );
        const a = account({ rows: 10, files: 10, fileBytes: 50_000 });
        const own = runStoragePass({ ownId: a.id, now: NOW, dryRun: true, policy: noPolicy() }).usageBefore.total;
        applyPolicy({
            target: { kind: "tenant", id: "t-share" },
            op: "put",
            policy: { quota: { tenant: { limit: own + 1_000_000 - 200_000, accounts: [a.id, other] } } },
            actor: "test",
        });
        applyPolicy({
            target: { kind: "account", id: a.id },
            op: "put",
            policy: { quota: { graceDays: 0 } },
            actor: "test",
        });
        const events = [];
        const r = runStoragePass({ ownId: a.id, now: NOW, emit: (e) => events.push(e) });
        assert.ok(events.some((e) => e.scope === "tenant" && e.tenantId === "t-share" && e.level === "over"));
        const share = Math.ceil((200_000 * own) / (own + 1_000_000));
        assert.ok(r.quota.media.bytes >= share, `freed ${r.quota.media.bytes} >= its share ${share}`);
        assert.ok(r.quota.media.files < 10, "only its share, not everything");
        assert.ok(describeStorage(a.id).quota.tenants.some((t) => t.id === "t-share"));
        closeDb();
    });
});

describe("storage quota: `db purge` beside a running daemon", () => {
    it("is run by the daemon over its channel (the account's one writer)", async () => {
        const a = account({ rows: 40 });
        const policy = noPolicy({ retention: { messages: "30d" } });
        const channel = await startDaemonChannel({
            getApi: () => null,
            accountDir: a.dir,
            onPurge: ({ dryRun }) => ({ report: runStoragePass({ ownId: a.id, now: NOW, dryRun, policy }) }),
        });
        try {
            const dry = await callViaDaemon(a.dir, "/purge", { dryRun: true });
            assert.equal(dry.ok, true);
            assert.equal(dry.report.retention.messages.rows, 11);
            assert.ok(getMessageById("m0"));
            const run = await callViaDaemon(a.dir, "/purge", { dryRun: false });
            assert.equal(run.report.retention.messages.rows, 11);
            assert.equal(getMessageById("m0"), null);
        } finally {
            channel.stop();
            closeDb();
        }
    });
});

describe("storage quota: where it is shown", () => {
    it("account status (and zalo_profile status, which returns the same report) carries this machine's storage", () => {
        const a = account({ rows: 5, files: 2 });
        runStoragePass({ ownId: a.id, now: NOW, policy: noPolicy({ quota: { account: { limit: "1GB" } } }) });
        closeDb();
        const storage = describeStorage(a.id);
        assert.ok(storage.usage.total > 0);
        assert.equal(storage.retention.messages, "keep");
        const lines = describeAccountStatus({ zbusiness: null, zcloud: null, problems: [], storage });
        assert.ok(
            lines.some((l) => /^This machine: .*retention: messages keep/.test(l)),
            lines.join(" | "),
        );
    });
});

describe("storage quota: MCP clients see it (not every client is an agent)", () => {
    /** The real tools over a real buffer, as `mcp start` wires them. */
    function mcp(ownId) {
        const tools = new Map();
        const server = { registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
        const buffer = new MessageBuffer(50);
        registerTools(
            server,
            { getOwnId: () => ownId },
            buffer,
            { isWatched: () => true },
            { limits: { maxMessagesPerPoll: 20 } },
            null,
            getAccountDir(ownId),
        );
        const call = async (name, args) => {
            const res = await tools.get(name).handler(args);
            assert.notEqual(res.isError, true, res.content[0].text);
            return JSON.parse(res.content[0].text);
        };
        return { buffer, call };
    }
    const event = {
        event: "storage_quota",
        accountId: "1",
        level: "over",
        scope: "account",
        usedBytes: 3 * 1024 * 1024,
        limitBytes: 2 * 1024 * 1024,
        overSince: "2026-11-08T00:00:00.000Z",
        purgeAt: "2026-12-23T00:00:00.000Z",
    };

    it("a storage_quota event is a system event in zalo_get_messages and zalo_wait_for_message, in order", async () => {
        const id = freshId();
        const { buffer, call } = mcp(id);
        buffer.push("t1", { msgId: "a", threadId: "t1", senderId: "1", text: "before", timestamp: Date.now() });
        buffer.pushSystem(quotaSystemEvent(event));
        buffer.push("t1", { msgId: "b", threadId: "t1", senderId: "1", text: "after", timestamp: Date.now() });
        const got = await call("zalo_get_messages", { since: 0, limit: 20 });
        assert.deepEqual(
            got.messages.map((m) => m.msgId ?? m.type),
            ["a", "storage_quota", "b"],
        );
        const sys = got.messages[1];
        assert.equal(sys.system, true);
        assert.equal(sys.threadId, null);
        assert.equal(sys.level, "over");
        assert.equal(sys.limitBytes, event.limitBytes);
        assert.match(sys.text, /over its limit .* purged at 2026-12-23/);
        const waited = await call("zalo_wait_for_message", { since: got.messages[0]._cursor, timeoutSec: 1 });
        assert.equal(waited.message.type, "storage_quota");
        // A read of one conversation does not get it, and no conversation list shows it.
        const one = await call("zalo_get_messages", { threadId: "t1", since: 0, limit: 20 });
        assert.deepEqual(
            one.messages.map((m) => m.msgId),
            ["a", "b"],
        );
        assert.deepEqual(
            buffer.getStats().map((t) => t.threadId),
            ["t1"],
        );
    });

    it("zalo_profile 'usage' reads the account's storage, as db usage prints it", async () => {
        const a = account({ rows: 5, files: 2 });
        const { call } = mcp(a.id);
        const r = await call("zalo_profile", { action: "usage" });
        closeDb();
        assert.equal(r.accountId, a.id);
        assert.ok(r.usage.db > 0 && r.usage.media >= 2 * 40_000, JSON.stringify(r.usage));
        assert.equal(r.usage.total, r.usage.db + r.usage.media + r.usage.outbox);
        assert.equal(r.retention.messages, "keep");
        assert.ok("accountLimit" in r.quota);
    });
});
