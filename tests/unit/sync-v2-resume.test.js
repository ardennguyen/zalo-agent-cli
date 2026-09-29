/**
 * The drop/resume bookkeeping of the message rounds, and the words a failed
 * restore ends with.
 *
 * Why this matters more than a normal retry path: the transfer-sync-v2 restore
 * is the only thing that repairs a coverage gap, and every attempt spends a
 * real person's phone confirmation. A run that drops its socket mid-flight used
 * to return nothing and make them tap again for the whole window. So two things
 * have to stay exactly right, and neither is reachable from a live run:
 *
 *   1. a shard the phone already served is never re-requested, and a shard that
 *      was in flight when the wire died always is;
 *   2. "the socket died" and "the phone never answered" never come out reading
 *      the same, because they call for opposite things from the user.
 *
 * See agent/work/transfer-sync-v2/FINDINGS.md for the measured protocol.
 */
import { SANDBOX_CONFIG_DIR, assertSandboxed } from "../helpers/sandbox.js";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DIR } from "../../src/core/credentials.js";
import { createShardSchedule, describeRestoreOutcome } from "../../src/core/sync-v2/index.js";

before(() => {
    assertSandboxed(CONFIG_DIR, SANDBOX_CONFIG_DIR);
});

describe("createShardSchedule — what goes out, and when", () => {
    it("hands out one wave at a time, in order", () => {
        const s = createShardSchedule(10, { waveSize: 4 });
        assert.deepEqual(s.nextWave(), [0, 1, 2, 3]);
        assert.equal(s.remaining(), 10);
        assert.equal(s.done(), false);
    });

    it("does not advance until the wave it handed out is settled", () => {
        const s = createShardSchedule(6, { waveSize: 2 });
        assert.deepEqual(s.nextWave(), [0, 1]);
        assert.deepEqual(s.nextWave(), [0, 1], "asking again re-offers the same work");
        s.settle(0);
        s.settle(1);
        assert.deepEqual(s.nextWave(), [2, 3]);
    });

    it("re-offers exactly the shards that never came back", () => {
        const s = createShardSchedule(5, { waveSize: 4, maxResumes: 1 });
        // Shards 0 and 1 served; 2 and 3 were in flight when the socket died.
        s.settle(0);
        s.settle(1);
        assert.equal(s.useResume(), true);
        assert.deepEqual(s.pending(), [2, 3, 4]);
        assert.deepEqual(s.nextWave(), [2, 3, 4], "the served pair is not asked for again");
    });

    it("settling out of order still removes the right shard", () => {
        const s = createShardSchedule(4, { waveSize: 4 });
        s.settle(2);
        assert.deepEqual(s.pending(), [0, 1, 3]);
        assert.equal(s.settle(2), false, "settling twice is a no-op, not a double removal");
        assert.deepEqual(s.pending(), [0, 1, 3]);
    });

    it("counts a refused shard as settled — the phone already answered it", () => {
        // A `transfer_error` shard must not be retried: the phone said no, and
        // asking again just spends another session on the same refusal.
        const s = createShardSchedule(3, { waveSize: 3, maxResumes: 1 });
        s.settle(1);
        s.useResume();
        assert.deepEqual(s.pending(), [0, 2]);
    });

    it("is done only when every shard is settled", () => {
        const s = createShardSchedule(2, { waveSize: 2 });
        assert.equal(s.done(), false);
        s.settle(0);
        assert.equal(s.done(), false);
        s.settle(1);
        assert.equal(s.done(), true);
        assert.deepEqual(s.nextWave(), []);
    });

    it("handles a run with no shards at all", () => {
        const s = createShardSchedule(0, { waveSize: 4 });
        assert.equal(s.done(), true);
        assert.equal(s.remaining(), 0);
    });
});

describe("createShardSchedule — reconnect allowance", () => {
    it("allows no resume at all when the caller cannot reconnect", () => {
        const s = createShardSchedule(4, { waveSize: 2, maxResumes: 0 });
        assert.equal(s.useResume(), false);
        assert.equal(s.resumes(), 0);
    });

    it("spends its allowance once and then refuses, so a dying wire cannot loop", () => {
        const s = createShardSchedule(4, { waveSize: 2, maxResumes: 1 });
        assert.equal(s.useResume(), true);
        assert.equal(s.resumes(), 1);
        assert.equal(s.useResume(), false, "a second drop ends the run");
        assert.equal(s.resumes(), 1, "a refused resume is not counted");
    });

    it("honors a larger allowance when one is given", () => {
        const s = createShardSchedule(4, { waveSize: 2, maxResumes: 3 });
        assert.deepEqual([s.useResume(), s.useResume(), s.useResume(), s.useResume()], [true, true, true, false]);
        assert.equal(s.resumes(), 3);
    });

    it("treats a missing or nonsensical allowance as none", () => {
        for (const bad of [undefined, NaN, -1, null]) {
            assert.equal(createShardSchedule(2, { maxResumes: bad }).useResume(), false, `maxResumes=${bad}`);
        }
    });
});

describe("createShardSchedule — a full drop-and-resume run", () => {
    it("serves every shard exactly once across a reconnect", () => {
        const s = createShardSchedule(6, { waveSize: 2, maxResumes: 1 });
        const served = [];

        // Wave 1 lands.
        for (const i of s.nextWave()) {
            served.push(i);
            s.settle(i);
        }
        // Wave 2: the first shard lands, then the socket dies mid-wave.
        const wave2 = s.nextWave();
        served.push(wave2[0]);
        s.settle(wave2[0]);
        assert.equal(s.useResume(), true);

        // Everything still owed goes out again after the reconnect.
        while (!s.done()) {
            for (const i of s.nextWave()) {
                served.push(i);
                s.settle(i);
            }
        }
        assert.deepEqual(
            served.slice().sort((a, b) => a - b),
            [0, 1, 2, 3, 4, 5],
        );
        assert.equal(new Set(served).size, served.length, "no shard was requested twice");
    });
});

describe("describeRestoreOutcome", () => {
    const base = { socketDied: false, timedOut: false, confirmed: false, messagesSaved: 0, finished: 0, total: 2 };

    it("reports a clean run as complete", () => {
        const r = describeRestoreOutcome({ ...base, messagesSaved: 100, finished: 2, total: 2 });
        assert.deepEqual(r, { reason: "complete", error: null });
    });

    it("separates a lost socket from a phone that never answered", () => {
        const dropped = describeRestoreOutcome({ ...base, socketDied: true, confirmed: true, waitMs: 180000 });
        const silent = describeRestoreOutcome({ ...base, timedOut: true, confirmed: false, waitMs: 180000 });

        assert.equal(dropped.reason, "socket-lost");
        assert.equal(silent.reason, "timeout");
        assert.notEqual(dropped.error, silent.error);
        assert.match(dropped.error, /connection dropped/);
        assert.match(silent.error, /did not answer/);
    });

    it("warns that a spent confirmation will have to be spent again", () => {
        const r = describeRestoreOutcome({ ...base, socketDied: true, confirmed: true });
        assert.match(r.error, /already confirmed/);
        assert.match(r.error, /prompt it again/);
    });

    it("says plainly when the drop cost the user nothing", () => {
        const r = describeRestoreOutcome({ ...base, socketDied: true, confirmed: false });
        assert.match(r.error, /never prompted/);
        assert.doesNotMatch(r.error, /prompt it again/);
    });

    it("names the reconnects it already spent", () => {
        const r = describeRestoreOutcome({ ...base, socketDied: true, resumes: 1 });
        assert.match(r.error, /dropped again after 1 reconnect/);
    });

    it("a confirmed phone that served nothing does not read like a lost connection", () => {
        const r = describeRestoreOutcome({ ...base, timedOut: true, confirmed: true, waitMs: 180000 });
        assert.match(r.error, /confirmed but served no messages/);
        assert.match(r.error, /connection stayed up/);
        assert.doesNotMatch(r.error, /dropped/);
    });

    it("quotes the budget the user actually waited", () => {
        assert.match(describeRestoreOutcome({ ...base, timedOut: true, waitMs: 180000 }).error, /180s/);
        assert.match(describeRestoreOutcome({ ...base, timedOut: true, waitMs: 45000 }).error, /45s/);
    });

    it("keeps what arrived: a drop after some messages is partial, not a failure", () => {
        const r = describeRestoreOutcome({ ...base, socketDied: true, messagesSaved: 800, finished: 1, total: 2 });
        assert.equal(r.error, null, "a run that saved messages must not throw them away");
        assert.equal(r.reason, "socket-lost");
    });

    it("distinguishes a partial timeout from a partial drop", () => {
        const t = describeRestoreOutcome({ ...base, timedOut: true, messagesSaved: 800, finished: 1, total: 2 });
        assert.deepEqual(t, { reason: "partial", error: null });
    });
});
