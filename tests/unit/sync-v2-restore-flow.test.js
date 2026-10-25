/**
 * The whole restore (`SyncV2.restore()`), from the first request to the last released session, against the fake
 * phone: acks, release reasons, counters, leftovers, downloads, a decline. The decryption is a stand-in (see
 * tests/helpers/fake-zalo/phone.js); everything else is the real code on the real zca-js listener and a real
 * zalo.db.
 */
import { assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import {
    countSyncRanges,
    getMessageById,
    getSyncRanges,
    getSyncState,
    initDb,
    markSyncRangesPending,
    setSyncRangeStatus,
} from "../../src/core/db.js";
import { SyncV2 } from "../../src/core/sync-v2/index.js";
import { FAKE, installQueuePulls, startFakeZalo } from "../helpers/fake-zalo/index.js";
import { fakeCodecs, installFakePhone } from "../helpers/fake-zalo/phone.js";

const T = Date.UTC(2026, 9, 1);
const CONVS = [
    {
        id: "CONVA",
        kind: "oneone",
        lastTs: T + 2000,
        messages: [
            { id: "1001", text: "hello a1", ts: T + 1000 },
            { id: "1002", text: "hello a2", ts: T + 2000 },
        ],
    },
    { id: "CONVB", kind: "group", lastTs: T + 3000, messages: [{ id: "2001", text: "hello b1", ts: T + 3000 }] },
];

describe("a restore against the fake phone", () => {
    let zalo = null;
    let api = null;
    let n = 0;

    before(() => assertSandboxed(CONFIG_DIR));

    afterEach(async () => {
        if (api?.listener?.ws) {
            api.listener.on("error", () => {});
            api.listener.stop();
        }
        if (zalo) await zalo.stop();
        zalo = api = null;
    });

    /** Connect, run the restore, and report everything that happened. */
    async function run(phoneOpts = {}, { before: prepare, account, ...restoreOpts } = {}) {
        zalo = await startFakeZalo();
        installQueuePulls(zalo.sock);
        const phone = installFakePhone(zalo, { conversations: CONVS, ...phoneOpts });
        api = await zalo.login();
        // A fresh account directory (and so a fresh zalo.db and session file) for every test.
        const sync = new SyncV2(api, account ?? `${FAKE.ownId}${++n}`);
        prepare?.(sync);
        const connected = once(api.listener, "connected");
        api.listener.start();
        await connected;
        const events = [];
        let result = null;
        let error = null;
        try {
            result = await sync.restore({
                codecs: fakeCodecs(),
                keepAlive: false,
                settleMs: 0,
                pollMs: 20,
                waitMs: 30_000,
                onStatus: (e) => events.push(e),
                ...restoreOpts,
            });
        } catch (e) {
            error = e;
        }
        return {
            result,
            error,
            events,
            phone,
            sync,
            sessionsFile: join(sync.accountDir, "sync", "open-sessions.json"),
        };
    }

    it("restores every conversation, with one ack-paced request per session and a release for each", async () => {
        const { result, error, phone, sessionsFile } = await run();
        assert.equal(error, null);
        assert.equal(result.reason, "complete");
        assert.equal(result.conversations, 2);
        assert.equal(result.messagesSaved, 3);
        for (const id of ["1001", "1002", "2001"]) assert.ok(getMessageById(id), `message ${id} was stored`);

        assert.deepEqual(
            phone.requests.map((r) => [r.type, r.priority, r.ussidx]),
            [
                ["conversation", 0, 0],
                ["message", 2, 1],
            ],
            "the conversation round, then one shard; ussidx counts the run's sessions from 0",
        );
        const ids = phone.requests.map((r) => r.reqId);
        assert.equal(new Set(ids).size, ids.length, "every request has its own reqId");
        assert.ok(ids.every((id) => /^req_\d+$/.test(id)));

        assert.deepEqual(
            phone.releases.map((r) => r.reason),
            [1, 1],
            "both sessions are released as finished",
        );
        assert.deepEqual(
            new Set(phone.releases.map((r) => r.syncId)),
            new Set(phone.requests.map((r) => r.syncId)),
            "every session that was requested was released, once",
        );
        assert.equal(JSON.parse(readFileSync(sessionsFile, "utf8")).length, 0, "no session is left written down");
    });

    it("releases the conversation session as soon as it has the list, before asking for any message", async () => {
        const { phone } = await run();
        assert.deepEqual(
            phone.order.map((o) => o.cmd),
            [590, 591, 590, 591],
            "590 conversation, 591 for it, 590 messages, 591 for it",
        );
    });

    it("sends each request only after the one before it was acknowledged", async () => {
        const { phone } = await run({ ackDelayMs: 150 }, { shardSize: 1 });
        const messages = phone.asked("message");
        assert.equal(messages.length, 2, "one shard per conversation");
        assert.ok(
            messages[1].receivedAt - messages[0].receivedAt >= 120,
            `the second request came ${messages[1].receivedAt - messages[0].receivedAt} ms after the first, which took 150 ms to answer`,
        );
    });

    it("records success when the window was settled", async () => {
        await run();
        assert.ok(getSyncState("lastSyncOkAt"));
    });

    it("a phone that says no ends the run with its own reason, releases as failed, and records nothing", async () => {
        const { error, phone } = await run({ outcome: "decline" });
        assert.ok(error);
        assert.equal(error.reason, "phone-rejected");
        assert.deepEqual(
            phone.releases.map((r) => r.reason),
            [2],
        );
        assert.equal(getSyncState("lastSyncOkAt"), null);
    });

    it("releases, with reason 3, the sessions an earlier run left open, before it asks for anything", async () => {
        const { phone } = await run(
            {},
            {
                before: (sync) => {
                    const file = join(sync.accountDir, "sync", "open-sessions.json");
                    mkdirSync(dirname(file), { recursive: true });
                    writeFileSync(file, JSON.stringify([{ syncId: "left-over-1", toDevice: 0 }]));
                },
            },
        );
        assert.deepEqual(
            phone.order.slice(0, 2).map((o) => o.cmd),
            [591, 590],
        );
        assert.deepEqual(phone.releases[0], { syncId: "left-over-1", reason: 3, reqId: phone.releases[0].reqId });
    });

    it("stops with Zalo's own words when it refuses the request as unsupported (error 211), without retrying", async () => {
        const { error, phone } = await run({ ackError: () => 211 });
        assert.ok(error);
        assert.equal(error.reason, "client-not-supported");
        assert.match(error.message, /not supported/);
        assert.equal(phone.requests.length, 1, "one request: 211 is not retried");
        assert.deepEqual(
            phone.releases.map((r) => r.reason),
            [2],
            "the session the refused request opened is still released, as failed",
        );
    });

    it("a batch that cannot be downloaded fails its scope instead of vanishing, and a 404 is not retried", async () => {
        let convSync = null;
        const { events, result, phone } = await run({
            downloadStatus: (path, p) => {
                convSync ??= p.requests[0]?.syncId;
                return path.startsWith(`/${convSync}/`) ? null : 404;
            },
        });
        assert.equal(result.messagesSaved, 0);
        assert.ok(
            events.some((e) => e.phase === "warn" && /could not download a batch \(not-found/.test(e.detail)),
            "the failure is said, not swallowed",
        );
        const messageUrls = phone.downloads.filter((p) => !p.startsWith(`/${convSync}/`));
        assert.equal(
            new Set(messageUrls).size,
            messageUrls.length,
            "each batch URL was asked for once: a 404 is final",
        );
    });

    it("a conversation list that cannot be downloaded ends the run: a list with a hole in it is not a list", async () => {
        const { error } = await run({ downloadStatus: () => 404 });
        assert.ok(error);
        assert.equal(error.reason, "download-failed");
        assert.match(error.message, /conversation list could not be downloaded/);
    });

    it("keeps what a partly failed shard did serve, and says how many partitions the phone could not", async () => {
        const { result, events } = await run({ failPartition: (p) => p.endsWith("/CONVB") });
        assert.equal(result.messagesSaved, 2, "CONVA's messages arrived");
        assert.ok(getMessageById("1001"));
        assert.equal(getMessageById("2001"), null);
        assert.ok(events.some((e) => e.phase === "warn" && /could not serve 1 partition/.test(e.detail)));
    });

    it("writes no session file entries when the run needs none (an empty list)", async () => {
        const { result, sessionsFile } = await run({ conversations: [] });
        assert.equal(result.reason, "empty-window");
        assert.ok(!existsSync(sessionsFile) || JSON.parse(readFileSync(sessionsFile, "utf8")).length === 0);
    });

    describe("what earlier runs settled (Y5)", () => {
        const account = () => `${FAKE.ownId}${++n}`;
        const messageQueries = (phone) => phone.asked("message").flatMap((r) => r.queries);

        it("a second run does not ask again for conversations the first one settled", async () => {
            const who = account();
            await run({}, { account: who });
            await zalo.stop();
            zalo = null;
            const second = await run({}, { account: who });
            assert.equal(second.error, null);
            assert.equal(second.result.reason, "complete");
            assert.equal(second.phone.asked("message").length, 0, "no message request: everything was settled");
            assert.equal(second.phone.asked("conversation").length, 1, "the conversation list is still asked for");
            assert.equal(second.result.ranges.skipped, 2);
            assert.ok(second.events.some((e) => /already settled/.test(e.detail ?? "")));
        });

        it("a conversation that moved on is asked for only from where the last run stopped (incremental)", async () => {
            const who = account();
            await run({}, { account: who });
            await zalo.stop();
            zalo = null;
            const moved = CONVS.map((c) => (c.id === "CONVA" ? { ...c, lastTs: T + 9000 } : c));
            const second = await run({ conversations: moved }, { account: who });
            const queries = messageQueries(second.phone);
            assert.deepEqual(
                queries.map((q) => [q.partition, q.from, q.to]),
                [["oneone/CONVA", T + 2000, T + 9000]],
                "only CONVA, and only from the end of what was settled",
            );
            assert.equal(second.result.ranges.incremental, 1);
            const done = Object.fromEntries(getSyncRanges("done").map((r) => [r.partition, r]));
            assert.equal(done["oneone/CONVA"].fromTs, 0, "the covered window still starts where the first run's did");
            assert.equal(done["oneone/CONVA"].toTs, T + 9000);
        });

        it("--full-resync forgets what was settled and asks for everything in full", async () => {
            const who = account();
            await run({}, { account: who });
            await zalo.stop();
            zalo = null;
            const second = await run({}, { account: who, fullResync: true });
            assert.deepEqual(
                messageQueries(second.phone).map((q) => [q.partition, q.from]),
                [
                    ["oneone/CONVA", 0],
                    ["group/CONVB", 0],
                ],
            );
            assert.equal(second.result.ranges.skipped, 0);
        });

        it("asks once more for a conversation the phone could not serve, and keeps what that brings", async () => {
            const { result, phone } = await run({
                failPartition: (p, attempt) => p.endsWith("/CONVB") && attempt === 1,
            });
            assert.equal(result.reason, "complete", "the retry recovered it, so the run settled its window");
            assert.equal(result.messagesSaved, 3);
            assert.ok(getMessageById("2001"), "the message of CONVB arrived on the second ask");
            assert.deepEqual(
                phone.asked("message").map((r) => r.queries.map((q) => q.partition)),
                [["oneone/CONVA", "group/CONVB"], ["group/CONVB"]],
                "one retry, for the failed conversation only",
            );
            assert.equal(result.ranges.retried, 1);
            assert.equal(result.ranges.recovered, 1);
            assert.deepEqual(countSyncRanges(), { pending: 0, failed: 0, done: 2 });
        });

        it("a conversation that fails the retry too stays failed, the run is partial, and no success is recorded", async () => {
            const { result, phone } = await run({ failPartition: (p) => p.endsWith("/CONVB") });
            assert.equal(result.reason, "partial");
            assert.equal(phone.asked("message").length, 2, "the first ask and exactly one retry");
            assert.equal(result.ranges.failed, 1);
            assert.equal(result.ranges.done, 1);
            assert.equal(getSyncState("lastSyncOkAt"), null, "a partial run is not a success");
            const failed = getSyncRanges("failed");
            assert.deepEqual(
                failed.map((r) => r.partition),
                ["group/CONVB"],
            );
            assert.match(failed[0].reason, /^error:/);
        });

        it("the next run asks only for the conversation that failed", async () => {
            const who = account();
            await run({ failPartition: (p) => p.endsWith("/CONVB") }, { account: who });
            await zalo.stop();
            zalo = null;
            const second = await run({}, { account: who });
            assert.equal(second.result.reason, "complete");
            assert.deepEqual(
                messageQueries(second.phone).map((q) => q.partition),
                ["group/CONVB"],
            );
            assert.ok(getMessageById("2001"));
            assert.deepEqual(countSyncRanges(), { pending: 0, failed: 0, done: 2 });
            assert.ok(getSyncState("lastSyncOkAt"), "now the window is settled");
        });

        it("a batch that cannot be downloaded marks its conversation failed, with the download's reason", async () => {
            let convSync = null;
            await run({
                downloadStatus: (path, p) => {
                    convSync ??= p.requests[0]?.syncId;
                    return path.startsWith("/" + convSync + "/") ? null : 404;
                },
            });
            const failed = getSyncRanges("failed");
            assert.ok(failed.length > 0);
            assert.ok(failed.every((r) => r.reason === "download:not-found"));
        });

        it("resumes a killed run: what it settled is skipped, what it left pending is asked for", async () => {
            const { phone } = await run(
                {},
                {
                    before: (sync) => {
                        initDb(join(sync.accountDir, "zalo.db"));
                        setSyncRangeStatus("oneone/CONVA", "done", { fromTs: 0, toTs: T + 2000 });
                        markSyncRangesPending([{ partition: "group/CONVB", fromTs: 0, toTs: T + 3000 }]);
                    },
                },
            );
            assert.deepEqual(
                messageQueries(phone).map((q) => q.partition),
                ["group/CONVB"],
            );
        });

        it("forgets an unfinished range for a conversation that is gone", async () => {
            await run(
                {},
                {
                    before: (sync) => {
                        initDb(join(sync.accountDir, "zalo.db"));
                        markSyncRangesPending([{ partition: "group/GONE", fromTs: 0, toTs: 5 }]);
                    },
                },
            );
            assert.ok(!getSyncRanges().some((r) => r.partition === "group/GONE"));
        });

        it("a phone that said no leaves no range behind: the run never got as far as asking for any", async () => {
            const { error } = await run({ outcome: "decline" });
            assert.ok(error);
            assert.deepEqual(countSyncRanges(), { pending: 0, failed: 0, done: 0 });
        });
    });
});
