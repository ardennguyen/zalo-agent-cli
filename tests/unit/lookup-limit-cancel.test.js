/**
 * A restore that meets Zalo's lookup limit (code 221), and a restore that is cancelled while it waits.
 *
 * Seen live: every arriving batch asked getUserInfo, Zalo answered 221, and each batch retried after 2, 5 and 15 s,
 * some 22 s a batch over 67 batches, keeping the limit hot; and a cancel of that stage was not honored for minutes,
 * so no new sync could start. These pin: one lookup round, then none for the rest of the restore, the names it could
 * not ask for queued and filled in later; and a cancel that ends each wait at once and frees the stage.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { getAccountDir } from "../../src/core/credentials.js";
import { createSenderResolver } from "../../src/core/sync-v2/senders.js";
import { fillDeferredNames, queueDeferredNames, readDeferredNames } from "../../src/core/sync-v2/deferred-names.js";
import { configureUserInfo, resetLookupCoolDown, runPacedBatches } from "../../src/zalo/custom/user-info.js";
import { getMessageById, initDb, insertMessage } from "../../src/core/db.js";
import { waitForDaemonSocket } from "../../src/core/daemon-sync.js";
import { createStageLock } from "../../src/core/daemon-channel.js";

const zaloError = (code, message) => Object.assign(new Error(message), { code });
const noised = (n) => `VNOISED${String(n).padStart(25, "0")}`;

before(() => assertSandboxed(SANDBOX_CONFIG_DIR));
beforeEach(() => {
    resetLookupCoolDown();
    configureUserInfo({ gapMs: 0 });
});

/** A resolver whose name lookups go through the real paced batches, which Zalo answers with 221. */
function limitedResolver(calls, { signal } = {}) {
    return createSenderResolver({}, new Map(), {
        sleep: async () => {},
        signal,
        resolveUsers: async (_api, ids, log) => {
            const r = await runPacedBatches(ids, {
                batchSize: 100,
                log,
                call: async (batch) => {
                    calls.push(batch);
                    throw zaloError(221, "Vượt quá số request cho phép");
                },
            });
            return new Map(r.results.flat());
        },
    });
}

describe("a 221 from the lookups during a restore", () => {
    it("one lookup round, then none for later batches; the names are deferred, said once", async () => {
        const calls = [];
        const logs = [];
        configureUserInfo({ gapMs: 0 });
        const resolver = createSenderResolver({}, new Map(), {
            sleep: async () => {},
            log: (m) => logs.push(m),
            resolveUsers: async (_api, ids, log) => {
                await runPacedBatches(ids, {
                    batchSize: 100,
                    log,
                    call: async (batch) => {
                        calls.push(batch);
                        throw zaloError(221, "Vượt quá số request cho phép");
                    },
                });
                return new Map();
            },
        });
        // 67 batches, as in the live restore.
        for (let b = 0; b < 67; b++)
            await resolver.prepare([{ senderId: noised(b * 2) }, { senderId: noised(b * 2 + 1) }]);
        assert.equal(calls.length, 1, "asked once: no retry of that batch, no lookup for the 66 after it");
        assert.equal(logs.filter((m) => m.startsWith("names deferred: Zalo is limiting lookups")).length, 1);
        const deferred = resolver.deferred();
        assert.equal(deferred.opaque.length, 134, "every sender it did not ask for is queued for the fill-in");
        assert.deepEqual(resolver.get(noised(3)), { id: noised(3), name: "" }, "kept as it came, not guessed");
    });

    it("a resolved sender whose name did not come is deferred by its user id", async () => {
        const resolver = createSenderResolver({}, new Map(), {
            sleep: async () => {},
            resolveUsers: async (_api, ids, log) => {
                // The id resolved (gid/decrypt answered), the name lookup was refused.
                await runPacedBatches(["5001"], {
                    batchSize: 100,
                    log,
                    call: async () => {
                        throw zaloError(221, "Vượt quá số request cho phép");
                    },
                });
                return new Map(ids.map((id) => [id, { id: "5001", name: "" }]));
            },
        });
        await resolver.prepare([{ senderId: noised(1) }]);
        assert.deepEqual(resolver.get(noised(1)), { id: "5001", name: "" });
        assert.deepEqual(resolver.deferred(), { opaque: [], uids: ["5001"] });
    });

    it("the queued names are filled in once lookups rest no more; nothing is asked while they do", async () => {
        const ownId = "1000000000000000801";
        const dir = getAccountDir(ownId);
        mkdirSync(dir, { recursive: true });
        initDb(`${dir}/zalo.db`);
        insertMessage({
            msgId: "880001",
            threadId: "g1",
            senderId: noised(7),
            senderName: "",
            text: "a",
            timestamp: 1,
        });
        insertMessage({ msgId: "880002", threadId: "g1", senderId: "5002", senderName: "", text: "b", timestamp: 2 });
        queueDeferredNames(dir, { opaque: [noised(7)], uids: ["5002"] });
        // Resting: nothing asked, nothing changed.
        await runPacedBatches(["x"], {
            batchSize: 1,
            call: async () => {
                throw zaloError(221, "x");
            },
        });
        let asked = 0;
        const resolveUsers = async (_api, ids) => (
            asked++,
            new Map(ids.map((id) => [id, { id: "5007", name: "Seven" }]))
        );
        const lookupNames = async (uids) => (asked++, new Map(uids.map((u) => [u, `Name ${u}`])));
        const resting = await fillDeferredNames({}, dir, { resolveUsers, lookupNames });
        assert.deepEqual([resting.skipped, asked], [true, 0]);
        assert.equal(getMessageById("880001").senderId, noised(7));
        // Rested: filled in, and the queue is empty.
        resetLookupCoolDown();
        const filled = await fillDeferredNames({}, dir, { resolveUsers, lookupNames });
        assert.equal(filled.left, 0);
        assert.equal(getMessageById("880001").senderId, "5007");
        assert.equal(getMessageById("880001").senderName, "Seven");
        assert.equal(getMessageById("880002").senderName, "Name 5002");
        assert.deepEqual(readDeferredNames(dir), { opaque: [], uids: [] });
    });
});

describe("a cancel ends the stage's waits at once", () => {
    it("the sender lookup's retry waits: a cancel stops them before the next try", async () => {
        const ctl = new AbortController();
        let calls = 0;
        const resolver = createSenderResolver({}, new Map(), {
            signal: ctl.signal,
            resolveUsers: async () => {
                calls++;
                ctl.abort();
                throw new Error("profile service unavailable");
            },
        });
        const started = Date.now();
        await resolver.prepare([{ senderId: noised(1) }]);
        assert.equal(calls, 1, "no retry after the cancel");
        assert.ok(Date.now() - started < 400, "no 0.5 s / 1.5 s retry pause");
        // And no later batch asks.
        await resolver.prepare([{ senderId: noised(2) }]);
        assert.equal(calls, 1);
        assert.deepEqual(resolver.deferred().opaque.sort(), [noised(1), noised(2)].sort());
    });

    it("the lookups of a batch: a cancel stops them between requests", async () => {
        const ctl = new AbortController();
        const calls = [];
        const resolver = limitedResolver(calls, { signal: ctl.signal });
        ctl.abort();
        await resolver.prepare([{ senderId: noised(9) }]);
        assert.equal(calls.length, 0);
    });

    it("the wait for the daemon to reconnect ends on a cancel, and the stage lock is free for the next job", async () => {
        const lock = createStageLock();
        const release = lock.tryAcquire("messages");
        const ctl = new AbortController();
        const started = Date.now();
        setTimeout(() => ctl.abort(), 50);
        const stage = waitForDaemonSocket({
            getApi: () => ({ listener: { ws: null } }),
            lostWs: null,
            lostApi: null,
            timeoutMs: 120_000,
            pollMs: 20,
            signal: ctl.signal,
        }).finally(release);
        const guard = new Promise((r) => setTimeout(() => r("still waiting"), 3000));
        assert.equal(await Promise.race([stage, guard]), null);
        assert.ok(Date.now() - started < 1000, "within a second");
        assert.ok(lock.tryAcquire("messages"), "a following job starts");
    });
});
